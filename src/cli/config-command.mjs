import { MODES, loadConfig, parseBool, parseMode, resetConfig, saveApiKey, saveConfig } from "../config.mjs";
import { maskKey } from "../credentials.mjs";
import { createPrompter, table } from "./output.mjs";

export const CONFIG_HELP = `Usage:
  krun-router config                     Interactive setup
  krun-router config show                Show effective configuration and where each value comes from
  krun-router config set <key> [value]   Set one value
  krun-router config reset [--yes]       Remove saved configuration and credentials

Keys for \`config set\`:
  api-key           Krun API key (prompted without echo when the value is omitted)
  mode              economy | balanced | quality (how readily smaller models are chosen)
  debug             true/false, on/off, yes/no
  status            Show the routed model in Claude Code / Codex (true/false)

The API URL (https://api.krun.ai) and the routing deadline (5000 ms) are fixed.

Files: ~/.krun-router/config.json and ~/.krun-router/credentials.json (owner-only permissions).
`;

const ENV_FOR = { apiKey: "KRUN_API_KEY", mode: "KRUN_MODE", debug: "KRUN_DEBUG", status: "KRUN_NO_STATUS" };
const onOff = (v) => (v ? "on" : "off");

export async function configCommand(args, ctx) {
  const [sub, ...rest] = args;
  if (sub === "--help" || sub === "-h" || sub === "help") return ctx.stdout.write(CONFIG_HELP), 0;
  if (sub === undefined) return wizard(ctx);
  if (sub === "show") return show(ctx);
  if (sub === "set") return set(rest, ctx);
  if (sub === "reset") return reset(rest, ctx);
  ctx.stderr.write(`krun-router config: unknown subcommand "${sub}"\n\n${CONFIG_HELP}`);
  return 1;
}

function overrideNote(ctx, name) {
  const cfg = loadConfig({ env: ctx.env, home: ctx.home });
  return cfg.sources[name] === "env" ? `Note: ${ENV_FOR[name]} in your environment overrides the saved value.\n` : "";
}

// ------------------------------------------------------------------ wizard

async function wizard(ctx) {
  const { config: cfg, stdout: out } = ctx;
  const p = createPrompter(ctx.stdin, out);
  try {
    out.write("Krun Router setup\n\n");
    if (cfg.hasLegacy && Object.values(cfg.sources).includes("legacy")) {
      out.write("Existing legacy configuration detected (~/.krun-router.env).\nCurrent values will be used as defaults.\n\n");
    }

    const keyHint = cfg.apiKey ? ` [${maskKey(cfg.apiKey)}, Enter to keep]` : "";
    const enteredKey = await p.askSecret(`Krun API key${keyHint}:\n> `);
    const apiKey = enteredKey || cfg.apiKey;

    const mode = await askValid(p, out, `
Routing mode (${MODES.join(" / ")}) [${cfg.mode}]:
> `, parseMode, cfg.mode, `Mode must be one of: ${MODES.join(", ")}.`);
    const debug = await askValid(p, out, `\nEnable debug logging? [${cfg.debug ? "Y/n" : "y/N"}]:\n> `, parseBool, cfg.debug, "Please answer y or n.");

    saveConfig({ mode, debug }, ctx.home);
    if (apiKey) saveApiKey(apiKey, ctx.home);
    out.write(`\nConfiguration saved to:\n${cfg.paths.dir}\n`);
    if (!apiKey) out.write("\nNo API key saved: routing stays off until you run `krun-router config set api-key`.\n");
    for (const name of ["apiKey", "mode", "debug"]) out.write(overrideNote(ctx, name));
    out.write("\nNext: krun-router doctor\n");
    return 0;
  } finally {
    p.close();
  }
}

/** Re-asks until valid; blank or end of input keeps the current value. */
async function askValid(p, out, question, parse, current, message) {
  for (;;) {
    const answer = await p.ask(question);
    if (!answer) return current;
    const v = parse(answer);
    if (v !== undefined) return v;
    out.write(`${message}\n`);
  }
}

// ------------------------------------------------------------------ show

function show({ config: c, stdout: out }) {
  const src = (name) => c.sources[name];
  out.write("Krun Router configuration\n\n");
  out.write(
    `${table([
      ["API URL", c.apiUrl, "fixed"],
      ["API key", maskKey(c.apiKey), src("apiKey")],
      ["Routing timeout", `${c.routingTimeoutMs} ms`, "fixed"],
      ["Mode", c.mode, src("mode")],
      ["Debug", onOff(c.debug), src("debug")],
      ["Status output", onOff(c.status), src("status")],
    ])}\n\nConfig directory  ${c.paths.dir}\n`,
  );
  if (c.models.length) out.write(`Model allowlist   ${c.models.join(", ")} (KRUN_MODELS)\n`);
  for (const e of c.errors) out.write(`\n! ${e} (ignored)\n`);
  return 0;
}

// ------------------------------------------------------------------ set

const SETTERS = {
  mode: { field: "mode", parse: parseMode, error: `mode must be one of: ${MODES.join(", ")}` },
  debug: { field: "debug", parse: parseBool, error: "debug must be true/false, on/off or yes/no" },
  status: { field: "status", parse: parseBool, error: "status must be true/false, on/off or yes/no" },
};

async function set([key, ...values], ctx) {
  const { stdout: out, stderr: err } = ctx;
  if (key === "api-key") {
    let value = values.join(" ").trim();
    if (!values.length) {
      const p = createPrompter(ctx.stdin, out);
      try {
        value = (await p.askSecret("Krun API key:\n> ")) ?? "";
      } finally {
        p.close();
      }
    }
    if (!value) return err.write("api-key must not be blank\n"), 1;
    saveApiKey(value, ctx.home);
    out.write(`API key updated.\n${overrideNote(ctx, "apiKey")}`);
    return 0;
  }
  const setter = SETTERS[key];
  if (!setter) {
    err.write(`krun-router config set: unknown key "${key ?? ""}". Keys: api-key, ${Object.keys(SETTERS).join(", ")}\n`);
    return 1;
  }
  const value = setter.parse(values.join(" "));
  if (value === undefined) return err.write(`${setter.error}\n`), 1;
  saveConfig({ [setter.field]: value }, ctx.home);
  const shown = typeof value === "boolean" ? onOff(value) : value;
  out.write(`${key} set to ${shown}.\n${overrideNote(ctx, setter.field)}`);
  return 0;
}

// ------------------------------------------------------------------ reset

async function reset(args, ctx) {
  const { config: c, stdout: out, stderr: err } = ctx;
  if (!args.includes("--yes") && !args.includes("-y")) {
    const p = createPrompter(ctx.stdin, out);
    let answer;
    try {
      answer = await p.ask("Remove saved Krun Router configuration? [y/N] ");
    } finally {
      p.close();
    }
    if (parseBool(answer) !== true) {
      err.write(`${answer === null ? "\n" : ""}Cancelled. Nothing was removed. (Use --yes to skip this prompt.)\n`);
      return 1;
    }
  }
  const removed = resetConfig(ctx.home);
  out.write(removed.length ? `Removed saved configuration from ${c.paths.dir}\n` : "No saved configuration to remove.\n");
  if (c.hasLegacy) out.write(`Note: the legacy file ${c.paths.legacy} was left untouched.\n`);
  return 0;
}
