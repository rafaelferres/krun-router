import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, createRouting, resolveBinary, run } from "../launch.mjs";
import { startProxy } from "../proxy.mjs";
import { LOG_FILE, STATE_DIR } from "../log.mjs";
import {
  DEFAULT_UPSTREAM,
  claudeLaunch,
  configuredModel,
  createClaudeAdapter,
  restoreSavedModel,
  savedModel,
  userHasStatusLine,
} from "../adapters/claude.mjs";

export const CLAUDE_HELP = `Usage: krun-router claude [claude arguments...]
Alias: krun-claude [claude arguments...]

Launches your installed Claude Code with per-turn routing. Every argument after
\`claude\` is passed to Claude Code unchanged, including --help, which therefore
shows Claude Code's own help. Without a Krun API key Claude Code starts without routing.
`;

/** Runs Claude Code with routing. `args` reach the real `claude` untouched. */
export async function claudeCommand(args, { config, env, stderr, cwd = process.cwd() }) {
  const claude = resolveBinary("claude", { env });
  if (!claude) {
    stderr.write(
      "[krun] Claude Code is not installed or `claude` is not on your PATH.\n" +
        "[krun] krun-router claude runs your real Claude Code; install it first: https://code.claude.com/docs/en/setup\n",
    );
    return 1;
  }
  if (!config.apiKey) {
    stderr.write("[krun] no Krun API key configured: starting Claude Code without routing.\n[krun] run `krun-router config` to enable it.\n");
    return run(claude, args, env);
  }

  const { sessionId, history, router } = createRouting({ cli: "claude", config });
  const savedBefore = savedModel();
  const adapter = createClaudeAdapter({
    router,
    // A gateway the user already routes Claude Code through stays their upstream.
    upstream: env.ANTHROPIC_BASE_URL || DEFAULT_UPSTREAM,
    preferredModel: configuredModel(args, env),
    dumpDir: config.dumpDir,
    onUsage: history.recordUsage,
  });
  const proxy = await startProxy(adapter);

  // Claude Code's UI names the row the user picked, not the model a turn ran on, so the routed
  // model is shown in the status line, unless the user has a status line of their own.
  let settingsFile;
  if (config.status && !userHasStatusLine(cwd)) {
    const script = join(ROOT, "bin", "krun-statusline.mjs").replace(/\\/g, "/");
    const command = `"${process.execPath.replace(/\\/g, "/")}" "${script}"`;
    settingsFile = join(STATE_DIR, `claude-settings-${process.pid}.json`);
    try {
      mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(settingsFile, JSON.stringify({ statusLine: { type: "command", command, padding: 0 } }), { mode: 0o600 });
    } catch {
      settingsFile = undefined;
    }
  }

  const launch = claudeLaunch({
    userArgs: args,
    env: { ...env, KRUN_ROUTER_SESSION: sessionId },
    proxyUrl: proxy.url,
    skillsDir: join(ROOT, "skills", "claude"),
    settingsFile,
  });
  if (config.debug) stderr.write(`[krun] routing log: ${LOG_FILE}\n`);

  const code = await run(claude, launch.args, launch.env);
  restoreSavedModel(savedBefore);
  if (settingsFile) rmSync(settingsFile, { force: true });
  await history.flush();
  return code;
}
