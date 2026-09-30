import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT, createRouting, resolveBinary, run } from "../launch.mjs";
import { startProxy } from "../proxy.mjs";
import { LOG_FILE } from "../log.mjs";
import {
  API_UPSTREAM,
  codexHome,
  codexLaunch,
  configuredModel,
  createCodexAdapter,
  readCodexCache,
  removeAutoFromCache,
  usesOtherProvider,
} from "../adapters/codex.mjs";

export const CODEX_HELP = `Usage: krun-router codex [codex arguments...]
Alias: krun-codex [codex arguments...]

Launches your installed Codex CLI with per-turn routing. Every argument after
\`codex\` is passed to Codex unchanged, including --help, which therefore shows
Codex's own help. Without a Krun API key, or when Codex is configured for a
non-OpenAI provider, Codex starts without routing.
`;

/** Makes `$krun-explain` available in Codex, pointing at this installation. */
function installSkill(home) {
  const target = join(home, ".agents", "skills", "krun-explain", "SKILL.md");
  const command = `"${process.execPath}" "${join(ROOT, "bin", "krun-explain.mjs")}"`;
  const text = readFileSync(join(ROOT, "skills", "codex", "krun-explain", "SKILL.md"), "utf8").replace("{{KRUN_EXPLAIN}}", command);
  try {
    if (readFileSync(target, "utf8") === text) return;
  } catch {
    // not installed yet
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
}

/** Runs Codex with routing. `args` reach the real `codex` untouched, after temporary -c overrides. */
export async function codexCommand(args, { config, env, stderr, home }) {
  const codex = resolveBinary("codex", { env });
  if (!codex) {
    stderr.write(
      "[krun] OpenAI Codex is not installed or `codex` is not on your PATH.\n" +
        "[krun] krun-router codex runs your real Codex CLI; install it first: https://developers.openai.com/codex/cli\n",
    );
    return 1;
  }
  const cHome = codexHome(env);
  if (!config.apiKey || usesOtherProvider(args, cHome)) {
    stderr.write(
      config.apiKey
        ? "[krun] Codex is configured for a non-OpenAI provider: starting it without routing.\n"
        : "[krun] no Krun API key configured: starting Codex without routing.\n[krun] run `krun-router config` to enable it.\n",
    );
    return run(codex, args, env);
  }

  try {
    installSkill(home);
  } catch (err) {
    stderr.write(`[krun] could not install the $krun-explain skill: ${err.message}\n`);
  }

  const { sessionId, history, router } = createRouting({ cli: "codex", config });
  const adapter = createCodexAdapter({
    router,
    apiUpstream: env.OPENAI_BASE_URL || API_UPSTREAM,
    preferredModel: configuredModel(args, cHome),
    loadCatalog: () => readCodexCache(cHome),
    showStatus: config.status,
    dumpDir: config.dumpDir,
    onUsage: history.recordUsage,
  });
  const proxy = await startProxy(adapter);
  if (config.debug) stderr.write(`[krun] routing log: ${LOG_FILE}\n`);

  const code = await run(codex, codexLaunch({ userArgs: args, proxyUrl: proxy.url }), { ...env, KRUN_ROUTER_SESSION: sessionId });
  removeAutoFromCache(cHome);
  await history.flush();
  return code;
}
