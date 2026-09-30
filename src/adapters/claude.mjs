// Everything that depends on Claude Code's wire format or local files lives in this module.
// Claude Code's request shape is not a public contract; when it moves, only this file should.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeModel } from "../catalog.mjs";
import { debug, dump } from "../log.mjs";
import { bufferResponse, decode } from "../proxy.mjs";

/** Sentinel id for the "Krun Router" picker row. Anything else is the user's own choice. */
export const AUTO_MODEL = "krun-router";
export const DEFAULT_UPSTREAM = "https://api.anthropic.com";
export const EXPLAIN_MARKER = "<krun-explain>";
// ponytail: only used when neither Claude Code's catalog cache nor a configured model exists.
export const COLD_START_MODEL = "claude-sonnet-4-6";
const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];
const SUBCOMMANDS = new Set([
  "agents", "attach", "auth", "auto-mode", "doctor", "gateway", "import", "install", "logs", "mcp",
  "plugin", "plugins", "project", "respawn", "rm", "setup-token", "stop", "kill", "ultrareview", "update", "upgrade",
]);

// ---------------------------------------------------------------- model catalog

/**
 * Claude Code caches the account's model catalog (the list its own /model picker shows) under
 * ~/.claude/cache/model-catalog/<account>-<org>-cc.json. It carries exact ids, names,
 * descriptions, vision support and per-model effort levels, which is everything routing needs.
 * Older versions live in an "overflow" section; only the "main" section is offered to Krun,
 * mirroring what Claude Code itself presents as current.
 */
export function modelsFromClaudeCatalog(json) {
  const all = json?.catalog?.config?.models;
  if (!Array.isArray(all)) return [];
  const main = all.filter((m) => m.section === "main");
  return (main.length ? main : all)
    .filter((m) => typeof m.id === "string")
    .map((m) => {
      const thinking = m.thinking?.type;
      const efforts = (m.thinking?.effort_options ?? []).map((o) => o.id).filter(Boolean);
      return normalizeModel({
        id: m.id,
        provider: "anthropic",
        displayName: m.name ?? m.id,
        description: m.description ?? "",
        capabilities: {
          reasoning: thinking ? thinking !== "none" : undefined,
          vision: typeof m.capabilities?.mm_images === "boolean" ? m.capabilities.mm_images : undefined,
          tools: true,
          efforts: efforts.length ? efforts : thinking === "none" ? [] : undefined,
        },
      });
    });
}

export const CATALOG_DIR = join(homedir(), ".claude", "cache", "model-catalog");

/** Newest Claude Code catalog cache for the CLI surface ("-cc.json"), or null. */
export async function readCatalogCache(dir = CATALOG_DIR) {
  try {
    const files = (await readdir(dir)).filter((n) => n.endsWith("-cc.json"));
    const withTime = await Promise.all(files.map(async (n) => ({ n, t: (await stat(join(dir, n))).mtimeMs })));
    const newest = withTime.sort((a, b) => b.t - a.t)[0];
    return newest ? JSON.parse(await readFile(join(dir, newest.n), "utf8")) : null;
  } catch {
    return null;
  }
}

/** Resolves a configured model (exact id or alias such as "opus" / "opus[1m]") against the catalog. */
export function baselineModel(models, preferred) {
  const want = preferred?.replace(/\[.*\]$/, "").toLowerCase();
  if (want && want !== AUTO_MODEL) {
    const hit = models.find((m) => m.id === want) ?? models.find((m) => m.id.includes(want));
    if (hit) return hit.id;
    if (want.startsWith("claude-")) return want;
  }
  return models[0]?.id ?? COLD_START_MODEL;
}

// ---------------------------------------------------------------- request parsing

const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((b) => b?.type === "text").map((b) => b.text).join("\n")
      : "";

/**
 * Text of a genuinely new human turn, or null.
 *
 * A turn spans many requests while the model works through tools; those continuations end
 * in a `tool_result`. Requests without tools are Claude Code's own auxiliary calls (titles,
 * summaries, compaction). Neither is a new turn. Injected `<system-reminder>` blocks and
 * trailing `system`-role messages (hook output) are skipped: they are not what the human asked.
 * So are records of local slash commands (`/clear`, …) and Claude Code's own side requests
 * that carry tools (next-prompt suggestion, away recap).
 */
export function freshPrompt(body) {
  if (!Array.isArray(body?.tools) || body.tools.length === 0) return null;
  const last = body.messages?.findLast((m) => m?.role !== "system");
  if (!last || last.role !== "user") return null;
  if (Array.isArray(last.content) && last.content.some((b) => b?.type === "tool_result")) return null;
  const text = textOf(last.content).replace(INJECTED, "").trim();
  if (!text || AUXILIARY.some((re) => re.test(text))) return null;
  return text;
}

const INJECTED =
  /<(system-reminder|local-command-caveat|command-name|command-message|command-args|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g;
// ponytail: prefix match on Claude Code's current wording; a reworded prompt just routes once more.
const AUXILIARY = [/^\[SUGGESTION MODE:/, /^The user stepped away and is coming back\./];

/**
 * Stable per-conversation key. The first user message is fixed once a conversation starts and
 * differs between the main agent and each sub-agent, so each gets its own routing state.
 * Volatile fields (cache_control placement, metadata, the growing tail) are deliberately not
 * used. `claude -p` omits session metadata on its first request, so it cannot be part of it.
 */
export function conversationKey(body) {
  return createHash("sha1").update(textOf(body?.messages?.[0]?.content)).digest("hex").slice(0, 12);
}

function hasImage(node) {
  if (Array.isArray(node)) return node.some(hasImage);
  if (!node || typeof node !== "object") return false;
  if (node.type === "image") return true;
  return Array.isArray(node.content) && hasImage(node.content);
}

/** Normalized routing input for one Claude Code request. */
export function parseRequest(body, bytes = 0) {
  const prompt = freshPrompt(body);
  return {
    auto: body?.model === AUTO_MODEL,
    requestedModel: body?.model,
    prompt,
    skipRouting: Boolean(prompt?.includes(EXPLAIN_MARKER)),
    conversationKey: conversationKey(body),
    turnId: prompt ? createHash("sha1").update(`${body.messages.length}|${prompt}`).digest("hex").slice(0, 12) : null,
    requirements: {
      tools: Array.isArray(body?.tools) && body.tools.length > 0,
      vision: hasImage(body?.messages),
      contextTokens: Math.round(bytes / 4),
    },
    context: { tokens: Math.round(bytes / 4), messages: body?.messages?.length ?? 0, turns: humanTurns(body?.messages) },
  };
}

/** Human turns so far (user messages that are not tool results): the policy's warm-cache signal. */
export function humanTurns(messages = []) {
  return messages.filter((m) => m?.role === "user" && !(Array.isArray(m.content) && m.content.some((b) => b?.type === "tool_result"))).length;
}

// ---------------------------------------------------------------- request rewriting

/**
 * Points a request at `model` and removes what that model cannot accept. Claude Code builds
 * the body for the model it believes it is using, so routing an effort-capable request to a
 * model without thinking would otherwise be a hard 400.
 */
export function normalizeForModel(body, model, info) {
  body.model = model;
  const caps = info?.capabilities;
  if (!caps) return body;
  if (caps.reasoning === false) {
    delete body.thinking;
    // A context-management edit that prunes thinking blocks is rejected once thinking is gone.
    const edits = body.context_management?.edits;
    if (Array.isArray(edits)) {
      body.context_management.edits = edits.filter((e) => !/thinking/i.test(e?.type ?? ""));
      if (!body.context_management.edits.length) delete body.context_management;
    }
  }
  const effort = body.output_config?.effort;
  if (effort && caps.efforts && !caps.efforts.includes(effort)) {
    const supported = EFFORT_ORDER.filter((e) => caps.efforts.includes(e));
    const lower = supported.filter((e) => EFFORT_ORDER.indexOf(e) <= EFFORT_ORDER.indexOf(effort));
    const next = lower.at(-1) ?? supported[0];
    if (next) body.output_config.effort = next;
    else delete body.output_config.effort;
    if (!Object.keys(body.output_config).length) delete body.output_config;
  }
  return body;
}

/**
 * Claude Code sends hook output as mid-conversation `system`-role messages, which older
 * models reject ("role 'system' is not supported on this model"). For those, each becomes
 * a user message wrapped in <system-reminder>, which is how Claude Code itself delivers such
 * context to models without the role.
 */
export function foldSystemMessages(body) {
  if (!Array.isArray(body.messages)) return false;
  let changed = false;
  const wrap = (t) => `<system-reminder>\n${t}\n</system-reminder>`;
  for (const m of body.messages) {
    if (m?.role !== "system") continue;
    m.role = "user";
    m.content = typeof m.content === "string"
      ? wrap(m.content)
      : (m.content ?? []).map((b) => (b?.type === "text" ? { ...b, text: wrap(b.text) } : b));
    changed = true;
  }
  return changed;
}

/**
 * With ANTHROPIC_BASE_URL set, Claude Code skips converting draft-04 style MCP tool schemas,
 * and the API rejects boolean `exclusiveMinimum`/`exclusiveMaximum`. Returns whether anything changed.
 */
export function sanitizeSchema(node) {
  if (Array.isArray(node)) return node.map(sanitizeSchema).some(Boolean);
  if (!node || typeof node !== "object") return false;
  let changed = false;
  for (const [key, bound] of [["exclusiveMinimum", "minimum"], ["exclusiveMaximum", "maximum"]]) {
    if (typeof node[key] === "boolean") {
      if (node[key] && typeof node[bound] === "number") {
        node[key] = node[bound];
        delete node[bound];
      } else delete node[key];
      changed = true;
    }
  }
  for (const v of Object.values(node)) changed = sanitizeSchema(v) || changed;
  return changed;
}

// ---------------------------------------------------------------- proxy adapter

const CATALOG_TTL_MS = 5 * 60 * 1000;
// Headers needed to list models with the user's own credentials, against their own provider.
const MODEL_LIST_HEADERS = ["authorization", "x-api-key", "anthropic-version", "anthropic-beta", "user-agent", "x-app"];

/**
 * Context windows (`max_input_tokens`) from the provider's own /v1/models, fetched once with
 * the credentials of a request Claude Code already sent. Nothing leaves for anyone but the
 * provider. Returns id → tokens; empty on any failure.
 */
export async function fetchContextWindows(upstream, headers, timeoutMs, fetchImpl = fetch) {
  try {
    const h = Object.fromEntries(MODEL_LIST_HEADERS.filter((k) => headers[k]).map((k) => [k, headers[k]]));
    const res = await fetchImpl(`${upstream.replace(/\/$/, "")}/v1/models?limit=1000`, { headers: h, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return new Map();
    const { data } = await res.json();
    return new Map((data ?? []).filter((m) => Number.isFinite(m?.max_input_tokens)).map((m) => [m.id, m.max_input_tokens]));
  } catch {
    return new Map();
  }
}

export function createClaudeAdapter({
  router,
  upstream = DEFAULT_UPSTREAM,
  preferredModel,
  loadCatalog = async () => modelsFromClaudeCatalog(await readCatalogCache()),
  loadContextWindows = (headers) => fetchContextWindows(upstream, headers, 800),
  dumpDir = null,
  onUsage = () => {},
}) {
  let catalog = null;
  let loadedAt = 0;
  let loading = null;
  let windows = new Map(); // id → max input tokens
  let windowsTriedAt = 0;
  const noSystemRole = new Set(); // learned from provider rejections
  const loadWindows = (headers) => {
    windowsTriedAt = Date.now();
    return loadContextWindows(headers)
      .then((w) => {
        if (w.size) windows = w;
        debug(`claude context windows: ${[...w].map(([id, n]) => `${id}=${n}`).join(", ") || "unavailable"}`);
      })
      .catch(() => {});
  };
  const refresh = () =>
    (loading ??= loadCatalog()
      .then((models) => {
        if (models?.length) catalog = models;
        loadedAt = Date.now();
        debug(`claude catalog: ${(catalog ?? []).map((m) => m.id).join(", ") || "none"}`);
      })
      .catch(() => {})
      .finally(() => (loading = null)));
  refresh();
  const models = async (headers) => {
    // Waited for once, bounded by its own short deadline; a failed fetch retries in the
    // background at most every CATALOG_TTL_MS instead of delaying later turns.
    if (!windowsTriedAt) await Promise.all([loadWindows(headers), catalog ? null : refresh()]);
    else if (!windows.size && Date.now() - windowsTriedAt > CATALOG_TTL_MS) loadWindows(headers);
    if (!catalog) await refresh(); // first turn only; later refreshes happen in the background
    else if (Date.now() - loadedAt > CATALOG_TTL_MS) refresh();
    return (catalog ?? []).map((m) => (windows.has(m.id) ? { ...m, contextWindow: windows.get(m.id) } : m));
  };
  const lacksSystemRole = (id, info) => noSystemRole.has(id) || info?.capabilities?.reasoning === false;

  return {
    upstreamFor: () => upstream,
    // Claude Code probes the base URL before its first request.
    localReply: (req) => (req.method === "HEAD" ? { status: 200 } : null),
    wantsBody: (req) => req.method === "POST" && /^\/v1\/messages(?:\/count_tokens)?(?:\?|$)/.test(req.url ?? ""),
    async transformRequest(req, buf) {
      if (dumpDir) dump(dumpDir, "claude-request", buf);
      const body = JSON.parse(buf.toString("utf8"));
      let changed = Array.isArray(body.tools) && body.tools.map((t) => sanitizeSchema(t?.input_schema)).some(Boolean);
      const turn = parseRequest(body, buf.length);
      // count_tokens answers with an input count, not spend.
      const usage = (model) =>
        req.url.startsWith("/v1/messages/count_tokens") ? undefined : (u) => onUsage({ ...u, model, conversation: turn.conversationKey });
      if (!turn.auto) {
        await router.resolveTurn(turn); // records a manual choice for status/explain
        return { ...(changed ? { body: Buffer.from(JSON.stringify(body)) } : {}), onUsage: usage(turn.requestedModel) };
      }
      const available = await models(req.headers);
      turn.availableModels = available;
      turn.baselineModel = baselineModel(available, preferredModel);
      // Token counting is not a turn: it follows the pinned model and never routes.
      if (req.url.startsWith("/v1/messages/count_tokens")) turn.prompt = null;
      const { model } = await router.resolveTurn(turn);
      const info = available.find((m) => m.id === model);
      normalizeForModel(body, model, info);
      if (lacksSystemRole(model, info)) foldSystemMessages(body);
      return {
        body: Buffer.from(JSON.stringify(body)),
        onUsage: usage(model),
        // Learn models that reject system-role messages, so the next request is folded up front.
        onResponse: (up, res) => {
          if (up.statusCode !== 400) return false;
          bufferResponse(up, res, (data) => {
            if (/role 'system' is not supported/i.test(decode(data, up.headers["content-encoding"]))) noSystemRole.add(model);
            return null;
          });
          return true;
        },
      };
    },
  };
}

// ---------------------------------------------------------------- launch

export const USER_SETTINGS = join(homedir(), ".claude", "settings.json");

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/** The model the user would get without us: --model, ANTHROPIC_MODEL, then saved settings. */
export function configuredModel(args, env, settingsFile = USER_SETTINGS) {
  const i = args.findIndex((a) => a === "--model" || a.startsWith("--model="));
  if (i >= 0) return args[i].includes("=") ? args[i].split("=")[1] : args[i + 1];
  if (env.ANTHROPIC_MODEL && env.ANTHROPIC_MODEL !== AUTO_MODEL) return env.ANTHROPIC_MODEL;
  const saved = readJson(settingsFile)?.model;
  return saved && saved !== AUTO_MODEL ? saved : undefined;
}

/** Whether the user already has a status line; theirs wins over ours. */
export function userHasStatusLine(cwd, home = homedir()) {
  return [
    join(cwd, ".claude", "settings.local.json"),
    join(cwd, ".claude", "settings.json"),
    join(home, ".claude", "settings.json"),
  ].some((f) => readJson(f)?.statusLine);
}

/**
 * Arguments and environment for the real Claude Code. User arguments are forwarded verbatim;
 * ours are appended (before a `--` separator if present) and skipped for subcommands.
 * ANTHROPIC_MODEL is per-process, so starting on "Krun Router" changes nothing permanent.
 */
export function claudeLaunch({ userArgs, env, proxyUrl, skillsDir, settingsFile }) {
  const childEnv = {
    ...env,
    ANTHROPIC_BASE_URL: proxyUrl,
    ANTHROPIC_CUSTOM_MODEL_OPTION: AUTO_MODEL,
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "Krun Router",
    ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: "Krun picks the right model for each turn",
    // Declared so Claude Code keeps composing thinking/effort; the proxy strips what the
    // routed model cannot accept.
    ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES: "thinking,adaptive_thinking,interleaved_thinking,effort,max_effort",
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
  };
  // Claude Code turns tool search off for a non-Anthropic ANTHROPIC_BASE_URL (our proxy) and
  // then sends every MCP tool inline: hundreds of thousands of tokens per request. The proxy
  // forwards to Anthropic, so keep it on unless the user has their own gateway or setting.
  if (!env.ANTHROPIC_BASE_URL && env.ENABLE_TOOL_SEARCH === undefined) childEnv.ENABLE_TOOL_SEARCH = "true";
  const explicitModel = userArgs.some((a) => a === "--model" || a.startsWith("--model="));
  if (!env.ANTHROPIC_MODEL && !explicitModel) childEnv.ANTHROPIC_MODEL = AUTO_MODEL;

  if (SUBCOMMANDS.has(userArgs[0])) return { args: [...userArgs], env: childEnv };
  const extra = [];
  if (skillsDir) extra.push("--add-dir", skillsDir);
  if (settingsFile) extra.push("--settings", settingsFile);
  const sep = userArgs.indexOf("--");
  const args = sep >= 0 ? [...userArgs.slice(0, sep), ...extra, ...userArgs.slice(sep)] : [...userArgs, ...extra];
  return { args, env: childEnv };
}

/**
 * Picking a /model row with Enter saves it as the default for new sessions. A saved
 * "krun-router" would break plain `claude`, which has no proxy, so it is put back on exit.
 */
export function restoreSavedModel(previous, file = USER_SETTINGS) {
  const settings = readJson(file);
  if (!settings || settings.model !== AUTO_MODEL) return false;
  if (previous === undefined) delete settings.model;
  else settings.model = previous;
  try {
    writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

export const savedModel = (file = USER_SETTINGS) => {
  const m = readJson(file)?.model;
  return m === AUTO_MODEL ? undefined : m;
};
