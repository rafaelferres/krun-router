// The single place that produces effective configuration. Everything else consumes the
// object returned by loadConfig() instead of reading KRUN_* variables itself.
import { readFileSync, rmSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { writePrivateFile } from "./credentials.mjs";

// Fixed on purpose: not configurable by flag, environment or file, so nothing can redirect
// prompts to another server or shorten the routing deadline.
export const API_URL = "https://api.krun.ai";
export const ROUTING_TIMEOUT_MS = 5000;

export const DEFAULTS = { debug: false, status: true, mode: "balanced" };

export const MODES = ["economy", "balanced", "quality"];
export const parseMode = (v) => (MODES.includes(String(v ?? "").trim().toLowerCase()) ? String(v).trim().toLowerCase() : undefined);

export function configPaths(home = homedir()) {
  const dir = join(home, ".krun-router");
  return {
    dir,
    config: join(dir, "config.json"),
    credentials: join(dir, "credentials.json"),
    legacy: join(home, ".krun-router.env"),
  };
}

// ------------------------------------------------------------------ value parsing

export function parseBool(v) {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").trim().toLowerCase();
  if (["1", "true", "on", "yes", "y"].includes(s)) return true;
  if (["0", "false", "off", "no", "n"].includes(s)) return false;
  return undefined;
}

// ------------------------------------------------------------------ sources

/** { data, error }: a missing file is not an error, an unreadable or invalid one is. */
function readJson(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    return { data: null, error: err.code === "ENOENT" ? null : `${file}: ${err.code ?? err.message}` };
  }
  try {
    const data = JSON.parse(text);
    return data && typeof data === "object" && !Array.isArray(data) ? { data, error: null } : { data: null, error: `${file}: not a JSON object` };
  } catch {
    return { data: null, error: `${file}: invalid JSON` };
  }
}

/** KRUN_* keys from the legacy ~/.krun-router.env. Other keys in it are ignored. */
function readLegacy(file) {
  try {
    return Object.fromEntries(Object.entries(parseEnv(readFileSync(file, "utf8"))).filter(([k]) => k.startsWith("KRUN_")));
  } catch {
    return null;
  }
}

/**
 * Effective configuration. Precedence per value:
 *   CLI flags → environment → ~/.krun-router/{config,credentials}.json → legacy ~/.krun-router.env → defaults
 * A value that fails validation at one level is ignored and the next level is used.
 * The API URL and routing deadline are constants (API_URL, ROUTING_TIMEOUT_MS).
 *
 * A project-local .env is deliberately NOT read: a cloned repository could otherwise inject
 * settings such as KRUN_DUMP_DIR.
 */
export function loadConfig({ env = process.env, home = homedir(), flags = {} } = {}) {
  const paths = configPaths(home);
  const cfg = readJson(paths.config);
  const cred = readJson(paths.credentials);
  const legacy = readLegacy(paths.legacy);
  const file = cfg.data ?? {};
  const lg = legacy ?? {};
  const envVal = (k) => (env[k] === undefined || env[k] === "" ? undefined : env[k]);
  const sources = {};

  const resolve = (name, parse, levels, fallback) => {
    for (const [source, raw] of levels) {
      if (raw === undefined || raw === null || raw === "") continue;
      const v = parse(raw);
      if (v !== undefined) {
        sources[name] = source;
        return v;
      }
    }
    sources[name] = "default";
    return fallback;
  };
  const text = (v) => (String(v).trim() ? String(v).trim() : undefined);
  const inverted = (v) => (parseBool(v) === undefined ? undefined : !parseBool(v));

  const apiKey = resolve("apiKey", text, [["env", envVal("KRUN_API_KEY")], ["credentials", cred.data?.apiKey], ["legacy", lg.KRUN_API_KEY]], null);
  const debug = resolve("debug", parseBool, [["flag", flags.debug], ["env", envVal("KRUN_DEBUG")], ["config", file.debug], ["legacy", lg.KRUN_DEBUG]], DEFAULTS.debug);
  const mode = resolve("mode", parseMode, [["env", envVal("KRUN_MODE")], ["config", file.mode], ["legacy", lg.KRUN_MODE]], DEFAULTS.mode);
  const status = resolve(
    "status",
    (v) => (typeof v === "boolean" ? v : inverted(v)),
    // KRUN_NO_STATUS is inverted; the config file stores `status` directly.
    [["flag", flags.status], ["env", envVal("KRUN_NO_STATUS")], ["config", parseBool(file.status)], ["legacy", lg.KRUN_NO_STATUS]],
    DEFAULTS.status,
  );

  return {
    apiKey,
    apiUrl: API_URL,
    routingTimeoutMs: ROUTING_TIMEOUT_MS,
    debug,
    status,
    mode,
    // Advanced, environment-only settings (documented in the README).
    models: String(envVal("KRUN_MODELS") ?? lg.KRUN_MODELS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    dumpDir: envVal("KRUN_DUMP_DIR") ?? lg.KRUN_DUMP_DIR ?? null,
    sources,
    paths,
    hasSavedConfig: Boolean(cfg.data || cred.data),
    hasLegacy: legacy !== null,
    errors: [cfg.error, cred.error].filter(Boolean),
  };
}

// ------------------------------------------------------------------ saving

/** Merges `values` into config.json (never the API key, which lives in credentials.json). */
export function saveConfig(values, home = homedir()) {
  const { config } = configPaths(home);
  const current = readJson(config).data ?? {};
  const next = { ...current, ...values };
  delete next.apiKey;
  delete next.apiUrl; // no longer configurable; dropped from files written by older versions
  delete next.routingTimeoutMs;
  writePrivateFile(config, `${JSON.stringify(next, null, 2)}\n`);
  return config;
}

export function saveApiKey(apiKey, home = homedir()) {
  const { credentials } = configPaths(home);
  writePrivateFile(credentials, `${JSON.stringify({ apiKey }, null, 2)}\n`);
  return credentials;
}

/** Removes this project's saved files only; the legacy env file and environment are untouched. */
export function resetConfig(home = homedir()) {
  const { dir, config, credentials } = configPaths(home);
  const removed = [];
  for (const f of [config, credentials]) {
    try {
      readFileSync(f);
      rmSync(f, { force: true });
      removed.push(f);
    } catch {
      // not present
    }
  }
  try {
    rmdirSync(dir); // only succeeds when empty: never removes files we did not create
  } catch {
    // not empty or not present
  }
  return removed;
}
