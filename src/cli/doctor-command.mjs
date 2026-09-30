import { accessSync, constants, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveBinary } from "../launch.mjs";
import { modelsFromClaudeCatalog, readCatalogCache } from "../adapters/claude.mjs";
import { modelsFromCodexCatalog, readCodexCache } from "../adapters/codex.mjs";
import { MARK } from "./output.mjs";
import { findKimi } from "./kimi-command.mjs";

export const DOCTOR_HELP = `Usage: krun-router doctor

Checks configuration, Krun API reachability and authentication (GET /v1/models, no
inference), the Claude Code, Codex, OpenCode and Kimi Code executables, their model catalogs and the config
directory. Exits with status 1 when a check fails; warnings do not fail.
`;

/** Error codes Krun documents are safe to show; response bodies otherwise are not printed. */
async function errorCode(res) {
  try {
    const code = (await res.json())?.error?.code;
    return typeof code === "string" && /^[A-Z_]{2,40}$/.test(code) ? ` ${code}` : "";
  } catch {
    return "";
  }
}

export async function doctorCommand(args, ctx, { fetchImpl = fetch, resolve = resolveBinary, timeoutMs = 5000 } = {}) {
  if (args.includes("--help") || args.includes("-h")) return ctx.stdout.write(DOCTOR_HELP), 0;
  const { config: c, stdout: out, env, home } = ctx;
  const results = [];
  const report = (level, text, hint) => {
    results.push(level);
    out.write(`${MARK[level]} ${text}\n${hint ? `  ${hint}\n` : ""}`);
  };
  out.write("Krun Router doctor\n\n");

  // Configuration
  if (c.errors.length) for (const e of c.errors) report("error", `Configuration unreadable: ${e}`, "Fix or remove the file, or run: krun-router config");
  else if (c.hasSavedConfig) report("ok", "Configuration found");
  else if (c.hasLegacy) report("warn", "Using legacy ~/.krun-router.env", "Run `krun-router config` to move to ~/.krun-router/");
  else report("warn", "No saved configuration (environment and defaults only)", "Run: krun-router config");

  if (c.apiKey) report("ok", `API key configured (${c.sources.apiKey})`);
  else report("error", "No Krun API key configured; routing is off", "Run: krun-router config set api-key <key>");

  // Krun API (fixed URL, see config.mjs).
  let reachable = false;
  try {
    const res = await fetchImpl(`${c.apiUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    await res.arrayBuffer().catch(() => {});
    reachable = true;
    report("ok", `${c.apiUrl} reachable`);
  } catch (err) {
    const why = err?.name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : "network error";
    report("error", `${c.apiUrl} unreachable (${why})`, "Check your connection");
  }

  if (!c.apiKey) report("warn", "Krun authentication not checked (no API key)");
  else if (!reachable) report("warn", "Krun authentication not checked (API unreachable)");
  else {
    try {
      const res = await fetchImpl(`${c.apiUrl}/v1/models`, {
        headers: { authorization: `Bearer ${c.apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const code = res.ok ? "" : await errorCode(res);
      if (res.ok) {
        await res.arrayBuffer().catch(() => {});
        report("ok", "Krun authentication valid");
      } else if (res.status === 401) report("error", `Krun API key is invalid (HTTP 401${code})`, "Run: krun-router config set api-key <key>");
      else if (res.status === 403) report("error", `Krun API key is not allowed to use this API (HTTP 403${code})`, "Check the key's project and permissions in your Krun account");
      else if (res.status === 429) report("warn", `Krun rate limit reached (HTTP 429${code})`, "The key was accepted; routing falls back to the current model while throttled");
      else if (res.status >= 500) report("warn", `Krun API error (HTTP ${res.status}${code})`, "Routing fails open (keeps the current model) until the service recovers");
      else report("error", `Unexpected response from Krun (HTTP ${res.status}${code})`, "Run krun-router doctor again later; report it if it persists");
    } catch (err) {
      report("error", `Krun authentication check failed (${err?.name === "TimeoutError" ? "timeout" : "network error"})`);
    }
  }

  // Coding CLIs: each is optional as long as one is present.
  const clis = [
    ["Claude Code", "Claude", resolve("claude", { env })],
    ["Codex", "Codex", resolve("codex", { env })],
    ["OpenCode", "OpenCode", resolve("opencode", { env })],
    ["Kimi Code", "Kimi", findKimi(env, home, resolve)],
  ];
  const found = clis.filter(([, , bin]) => bin).map(([, short]) => short);
  for (const [name, short, bin] of clis) {
    if (bin) report("ok", `${name} detected`);
    else if (found.length) report("warn", `${name} not found`, `${short} routing will be unavailable; ${found.join(", ")} routing can still be used.`);
    else report("error", `${name} not found`);
  }
  if (!found.length) out.write("  Install Claude Code, Codex, OpenCode or Kimi Code first\n");
  const [claude, codex] = clis.map(([, , bin]) => bin);
  if (clis[3][2] && !env.MOONSHOT_API_KEY && !(env.KIMI_MODEL_NAME && env.KIMI_MODEL_API_KEY)) {
    report("warn", "No Moonshot API key: Kimi Code starts without routing", "Set MOONSHOT_API_KEY (the Kimi Code subscription login is not routed)");
  }

  if (claude) {
    const n = modelsFromClaudeCatalog(await readCatalogCache(join(home, ".claude", "cache", "model-catalog"))).length;
    if (n) report("ok", `Claude model catalog available (${n} models)`);
    else report("warn", "Claude model catalog not cached yet", "Run Claude Code once; until then routing keeps your configured model");
  }
  if (codex) {
    const n = modelsFromCodexCatalog(await readCodexCache(env.CODEX_HOME || join(home, ".codex"))).length;
    if (n) report("ok", `Codex model catalog available (${n} models)`);
    else report("warn", "Codex model catalog not cached yet", "It is fetched through krun-codex on first launch");
  }

  // Config directory (or the nearest existing parent, if it does not exist yet)
  let dir = c.paths.dir;
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  try {
    accessSync(dir, constants.W_OK);
    report("ok", "Config directory writable");
  } catch {
    report("error", `Config directory not writable: ${dir}`);
  }

  const errors = results.filter((r) => r === "error").length;
  const warnings = results.filter((r) => r === "warn").length;
  out.write(`\n${errors ? `Not ready: ${errors} problem${errors > 1 ? "s" : ""} to fix.` : warnings ? "Ready (with warnings)." : "Ready."}\n`);
  return errors ? 1 : 0;
}
