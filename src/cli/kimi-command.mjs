import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT, createRouting, resolveBinary, run } from "../launch.mjs";
import { startProxy } from "../proxy.mjs";
import { LOG_FILE } from "../log.mjs";
import { createKimiAdapter, fetchKimiModels, kimiCredentials, kimiLaunchEnv } from "../adapters/kimi.mjs";

export const KIMI_HELP = `Usage: krun-router kimi [kimi arguments...]
Alias: krun-kimi [kimi arguments...]

Launches your installed Kimi Code CLI with per-turn routing. Every argument after
\`kimi\` is passed to Kimi Code unchanged. Routing needs a Moonshot API key in
MOONSHOT_API_KEY (or Kimi Code's own KIMI_MODEL_NAME + KIMI_MODEL_API_KEY); the
Kimi Code subscription login is not routed. Without a key Kimi Code starts as usual.
`;

/** `kimi` on PATH, or where the official installer puts it (~/.kimi-code/bin). */
export function findKimi(env, home, resolve = resolveBinary) {
  const onPath = resolve("kimi", { env });
  if (onPath) return onPath;
  for (const name of ["kimi.exe", "kimi"]) {
    const file = join(home, ".kimi-code", "bin", name);
    if (existsSync(file)) return { file, prefix: [], shell: false };
  }
  return null;
}

/**
 * Makes `/krun-explain` available. Installed into Kimi Code's user skills directory rather
 * than passed with --skills-dir, which would replace (hide) the user's own skills.
 */
function installSkill(home) {
  const target = join(home, ".kimi-code", "skills", "krun-explain", "SKILL.md");
  const command = `"${process.execPath}" "${join(ROOT, "bin", "krun-explain.mjs")}"`;
  const text = readFileSync(join(ROOT, "skills", "kimi", "krun-explain", "SKILL.md"), "utf8").replace("{{KRUN_EXPLAIN}}", command);
  try {
    if (readFileSync(target, "utf8") === text) return;
  } catch {
    // not installed yet
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
}

/**
 * Kimi Code reads its status line only from ~/.kimi-code/tui.toml, which we never write. Returns
 * the one-line opt-in once (a marker in our own config dir), or null when set up or already shown.
 */
export function statuslineHint(home, configDir) {
  try {
    if (readFileSync(join(home, ".kimi-code", "tui.toml"), "utf8").includes("krun-statusline")) return null;
  } catch {
    // no tui.toml yet
  }
  const marker = join(configDir, "kimi-statusline-hint");
  if (existsSync(marker)) return null;
  mkdirSync(configDir, { recursive: true });
  writeFileSync(marker, "");
  const command = `"${process.execPath}" "${join(ROOT, "bin", "krun-statusline.mjs")}"`;
  return (
    "[krun] Tip: to see the routed model in Kimi Code's footer, add to ~/.kimi-code/tui.toml:\n" +
    `[krun]   [status_line]\n[krun]   command = '${command}'\n`
  );
}

/** Runs Kimi Code with routing. `args` reach the real `kimi` untouched. */
export async function kimiCommand(args, { config, env, stderr, home }) {
  const kimi = findKimi(env, home);
  if (!kimi) {
    stderr.write(
      "[krun] Kimi Code is not installed or `kimi` is not on your PATH.\n" +
        "[krun] krun-router kimi runs your real Kimi Code CLI; install it first: https://moonshotai.github.io/kimi-code/\n",
    );
    return 1;
  }
  const plain = (why) => (stderr.write(`[krun] ${why}: starting Kimi Code without routing.\n`), run(kimi, args, env));
  if (!config.apiKey) return plain("no Krun API key configured (run `krun-router config`)");
  const cred = kimiCredentials(env);
  if (!cred.supported) return plain("KIMI_MODEL_PROVIDER_TYPE is not \"kimi\"");
  if (!cred.apiKey) return plain("no Moonshot API key (set MOONSHOT_API_KEY; subscription login is not routed)");

  let models;
  try {
    models = await fetchKimiModels(cred.upstream, cred.apiKey);
  } catch (err) {
    return plain(`could not list models from ${cred.upstream} (${err.message})`);
  }
  if (!models.length) return plain(`no chat models listed by ${cred.upstream}`);

  try {
    installSkill(home);
  } catch (err) {
    stderr.write(`[krun] could not install the /krun-explain skill: ${err.message}\n`);
  }

  const { sessionId, history, router } = createRouting({ cli: "kimi", config });
  const adapter = createKimiAdapter({ router, upstream: cred.upstream, models, preferredModel: cred.preferredModel, dumpDir: config.dumpDir, onUsage: history.recordUsage });
  const proxy = await startProxy(adapter);
  if (config.debug) stderr.write(`[krun] routing log: ${LOG_FILE}\n`);

  const hint = statuslineHint(home, config.paths.dir);
  if (hint) stderr.write(hint);
  const childEnv = kimiLaunchEnv({ env: { ...env, KRUN_ROUTER_SESSION: sessionId }, proxyUrl: proxy.url, apiKey: cred.apiKey, models });
  const code = await run(kimi, args, childEnv);
  await history.flush();
  return code;
}
