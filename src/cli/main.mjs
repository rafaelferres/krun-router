import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.mjs";
import { ROOT } from "../launch.mjs";
import { CONFIG_HELP, configCommand } from "./config-command.mjs";
import { DOCTOR_HELP, doctorCommand } from "./doctor-command.mjs";
import { CLAUDE_HELP, claudeCommand } from "./claude-command.mjs";
import { CODEX_HELP, codexCommand } from "./codex-command.mjs";
import { EXPLAIN_HELP, explainCommand } from "./explain-command.mjs";
import { OPENCODE_HELP, opencodeCommand } from "./opencode-command.mjs";
import { KIMI_HELP, kimiCommand } from "./kimi-command.mjs";
import { STATS_HELP, statsCommand } from "./stats-command.mjs";
import { EVAL_HELP, evalCommand } from "./eval-command.mjs";

export const version = () => JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

export const ROOT_HELP = `krun-router

Automatic per-turn model routing for Claude Code, Codex, OpenCode and Kimi Code, powered by Krun.

Usage:
  krun-router config
  krun-router doctor
  krun-router claude [args...]
  krun-router codex [args...]
  krun-router opencode [args...]
  krun-router kimi [args...]
  krun-router explain [session]
  krun-router stats [--days N] [--cli <name>] [--json]
  krun-router eval [options]

Commands:
  config    Configure Krun Router
  doctor    Check configuration and integrations
  claude    Launch Claude Code with routing
  codex     Launch Codex with routing
  opencode  Launch OpenCode with routing
  kimi      Launch Kimi Code with routing
  explain   Explain the latest routing decision
  stats     Routing, token and cost statistics
  eval      Measure routing quality on labelled cases (uses the Krun API)

Options (before the command):
  --debug                  Write routing metadata to the debug log
  --no-status              Do not show the routed model in the CLI
  -v, --version            Print the version
  -h, --help               Show this help

Arguments after \`claude\`, \`codex\`, \`opencode\` or \`kimi\` go to that CLI unchanged (\`krun-router claude --help\`
shows Claude Code's help). Wrapper help: \`krun-router help <command>\`.
`;

const COMMANDS = {
  config: { run: configCommand, help: CONFIG_HELP },
  doctor: { run: doctorCommand, help: DOCTOR_HELP },
  claude: { run: claudeCommand, help: CLAUDE_HELP },
  codex: { run: codexCommand, help: CODEX_HELP },
  opencode: { run: opencodeCommand, help: OPENCODE_HELP },
  kimi: { run: kimiCommand, help: KIMI_HELP },
  explain: { run: explainCommand, help: EXPLAIN_HELP },
  stats: { run: statsCommand, help: STATS_HELP },
  eval: { run: evalCommand, help: EVAL_HELP },
};

const GLOBAL_FLAGS = {
  "--debug": { key: "debug", fixed: true },
  "--no-debug": { key: "debug", fixed: false },
  "--status": { key: "status", fixed: true },
  "--no-status": { key: "status", fixed: false },
};

/** Global options, parsed only before the command so the command's own arguments are never touched. */
export function parseGlobal(argv) {
  const flags = {};
  let i = 0;
  for (; i < argv.length; i++) {
    const [name, inline] = argv[i].split(/=(.*)/s, 2);
    const spec = GLOBAL_FLAGS[name];
    if (!spec) break;
    if (!spec.value) {
      flags[spec.key] = spec.fixed;
      continue;
    }
    const raw = inline ?? argv[++i];
    const v = spec.parse(raw);
    if (v === undefined) return { error: `invalid value for ${name}: ${raw ?? "(missing)"}` };
    flags[spec.key] = v;
  }
  return { flags, rest: argv.slice(i) };
}

/**
 * The whole CLI. Every binary (krun-router and the krun-claude / krun-codex / krun-explain
 * aliases) calls this, so each command has exactly one implementation. Returns an exit code.
 */
export async function main(argv, io = {}) {
  const ctx = {
    env: io.env ?? process.env,
    home: io.home ?? homedir(),
    stdin: io.stdin ?? process.stdin,
    stdout: io.stdout ?? process.stdout,
    stderr: io.stderr ?? process.stderr,
  };
  const parsed = parseGlobal(argv);
  if (parsed.error) return ctx.stderr.write(`krun-router: ${parsed.error}\n`), 2;
  const [cmd, ...args] = parsed.rest;

  if (cmd === undefined || cmd === "--help" || cmd === "-h") return ctx.stdout.write(ROOT_HELP), 0;
  if (cmd === "--version" || cmd === "-v") return ctx.stdout.write(`krun-router ${version()}\n`), 0;
  if (cmd === "help") {
    const topic = COMMANDS[args[0]];
    ctx.stdout.write(topic ? topic.help : ROOT_HELP);
    return topic || !args[0] ? 0 : 1;
  }
  const command = COMMANDS[cmd];
  if (!command) {
    ctx.stderr.write(`krun-router: unknown command "${cmd}"\n\n${ROOT_HELP}`);
    return 2;
  }
  ctx.config = loadConfig({ env: ctx.env, home: ctx.home, flags: parsed.flags });
  return command.run(args, ctx);
}
