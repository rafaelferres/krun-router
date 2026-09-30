// Everything that depends on the Codex CLI's wire format, config or local files lives here.
// Codex's Responses traffic and model catalog are not a public contract; keep changes local.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeModel } from "../catalog.mjs";
import { bufferResponse } from "../proxy.mjs";
import { debug, dump } from "../log.mjs";
import { statusText } from "../status.mjs";

export const AUTO_MODEL = "krun-router";
export const PROVIDER_ID = "krun";
export const CHATGPT_UPSTREAM = "https://chatgpt.com/backend-api/codex";
export const API_UPSTREAM = "https://api.openai.com/v1";
const STATUS_ID_PREFIX = "krun-status-";
// Codex composes a lighter Responses variant for models flagged `use_responses_lite` and
// marks it with this header; models without the flag reject such requests.
const RESPONSES_LITE = "codex-responses-lite";
const RESPONSES_LITE_HEADER = "x-openai-internal-codex-responses-lite";
const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export const codexHome = (env = process.env) => env.CODEX_HOME || join(homedir(), ".codex");

// ---------------------------------------------------------------- model catalog

/** Exact models from Codex's /models catalog (same shape as ~/.codex/models_cache.json). */
export function modelsFromCodexCatalog(json) {
  const list = Array.isArray(json?.models) ? json.models : [];
  return list
    .filter((m) => m?.slug && m.slug !== AUTO_MODEL && m.visibility === "list" && m.supported_in_api !== false)
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    .map((m) => {
      const efforts = (m.supported_reasoning_levels ?? []).map((l) => l.effort).filter(Boolean);
      return normalizeModel({
        id: m.slug,
        provider: "openai",
        displayName: m.display_name ?? m.slug,
        description: m.description ?? "",
        contextWindow: m.context_window,
        capabilities: {
          reasoning: Array.isArray(m.supported_reasoning_levels) ? efforts.length > 0 : undefined,
          vision: Array.isArray(m.input_modalities) ? m.input_modalities.includes("image") : undefined,
          tools: true,
          efforts: efforts.length ? efforts : undefined,
          features: m.use_responses_lite ? [RESPONSES_LITE] : [],
        },
      });
    });
}

/**
 * Codex caches the /models response it received through the proxy, "Krun Router" row
 * included. Plain `codex` has no proxy to resolve that row, so it is removed on exit.
 */
export function removeAutoFromCache(home = codexHome()) {
  const file = join(home, "models_cache.json");
  try {
    const json = JSON.parse(readFileSync(file, "utf8"));
    if (!json.models?.some((m) => m.slug === AUTO_MODEL)) return false;
    json.models = json.models.filter((m) => m.slug !== AUTO_MODEL);
    writeFileSync(file, JSON.stringify(json));
    return true;
  } catch {
    return false;
  }
}

export async function readCodexCache(home = codexHome()) {
  try {
    return JSON.parse(await readFile(join(home, "models_cache.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Adds the "Krun Router" row to Codex's model picker, cloned from the baseline model's entry. */
export function addAutoModel(catalog, baselineSlug) {
  if (!Array.isArray(catalog?.models) || catalog.models.some((m) => m.slug === AUTO_MODEL)) return catalog;
  const listed = catalog.models.filter((m) => m.visibility === "list");
  const template = catalog.models.find((m) => m.slug === baselineSlug) ?? listed[0] ?? catalog.models[0];
  if (!template) return catalog;
  catalog.models.unshift({
    ...template,
    slug: AUTO_MODEL,
    display_name: "Krun Router",
    description: "Krun picks the right model for each turn.",
    visibility: "list",
    supported_in_api: true,
    priority: Math.min(...catalog.models.map((m) => m.priority ?? 0)) - 1,
    upgrade: null,
  });
  return catalog;
}

export function baselineModel(models, preferred) {
  if (preferred && preferred !== AUTO_MODEL) return preferred;
  return models[0]?.id ?? null;
}

// ---------------------------------------------------------------- request parsing

const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((p) => p?.type === "input_text" || p?.type === "text" || p?.type === "output_text").map((p) => p.text).join("\n")
      : "";

const cleanPrompt = (text) =>
  text
    .replace(/<(environment_context|user_instructions|system[-_]reminder|current_datetime|INSTRUCTIONS)>[\s\S]*?<\/\1>/gi, "")
    .replace(/^# AGENTS\.md instructions for .*$/gim, "")
    .trim();

export const isStatusItem = (item) =>
  (typeof item?.id === "string" && item.id.startsWith(STATUS_ID_PREFIX)) ||
  (item?.role === "assistant" && /^\[Krun\] /.test(textOf(item.content)));

const isAuxiliary = (prompt) => /^Generate a concise, single-line task title\b/i.test(prompt);

// Current Codex sends its tool list as an `additional_tools` input item rather than `tools`.
const hasTools = (body) =>
  (Array.isArray(body?.tools) && body.tools.length > 0) ||
  (Array.isArray(body?.input) && body.input.some((i) => i?.type === "additional_tools"));

/** Codex's per-request turn metadata: { thread_id, turn_id, agent_name, ... }, or {}. */
export function turnMetadata(body) {
  try {
    return JSON.parse(body?.client_metadata?.["x-codex-turn-metadata"] ?? "{}") ?? {};
  } catch {
    return {};
  }
}

/**
 * User text that opens a new Codex turn, or null. Walking back from the end: a tool output
 * means the model is mid-turn; a user message with real text is a new turn; user messages
 * that only carry injected context are skipped.
 */
export function freshPrompt(body) {
  if (!Array.isArray(body?.input) || !hasTools(body)) return null;
  for (let i = body.input.length - 1; i >= 0; i--) {
    const item = body.input[i];
    if (isStatusItem(item)) continue;
    if (typeof item?.type === "string" && item.type.endsWith("_output")) return null;
    if (item?.role !== "user") return null;
    const text = cleanPrompt(textOf(item.content));
    if (text) return isAuxiliary(text) ? null : text;
  }
  return null;
}

/**
 * One key per Codex thread: the thread id from turn metadata, else prompt_cache_key (also per
 * thread). Sub-agents run in their own threads, so they never share the main agent's state.
 */
export function conversationKey(body) {
  const stable =
    turnMetadata(body).thread_id ??
    body?.prompt_cache_key ??
    `${body?.instructions ?? ""}|${textOf(body?.input?.find((i) => i?.role === "user")?.content)}`;
  return createHash("sha1").update(String(stable)).digest("hex").slice(0, 12);
}

const hasImage = (input) =>
  Array.isArray(input) && input.some((i) => Array.isArray(i?.content) && i.content.some((p) => p?.type === "input_image"));

const isExplain = (prompt) => Boolean(prompt && (prompt.includes("<krun-explain>") || /(^|\s)\$krun-explain\b/.test(prompt)));

export function parseRequest(body, bytes = 0, headers = {}) {
  const prompt = freshPrompt(body);
  return {
    auto: body?.model === AUTO_MODEL,
    requestedModel: body?.model,
    prompt,
    skipRouting: isExplain(prompt),
    conversationKey: conversationKey(body),
    turnId: prompt
      ? (turnMetadata(body).turn_id ?? createHash("sha1").update(`${body.input.length}|${prompt}`).digest("hex").slice(0, 12))
      : null,
    requirements: {
      tools: hasTools(body),
      vision: hasImage(body?.input),
      contextTokens: Math.round(bytes / 4),
      features: headers[RESPONSES_LITE_HEADER] ? [RESPONSES_LITE] : [],
    },
    context: { tokens: Math.round(bytes / 4), items: body?.input?.length ?? 0, turns: (body?.input ?? []).filter((i) => i?.role === "user").length },
  };
}

// ---------------------------------------------------------------- request rewriting

/**
 * Points the request at `model`. The "Krun Router" row is cloned from one model, so Codex may
 * ask for a reasoning effort the routed model does not offer; that becomes the nearest lower
 * level the routed model supports, else its own default, instead of an API error.
 */
export function normalizeForModel(body, model, raw) {
  body.model = model;
  if (Array.isArray(body.input)) body.input = body.input.filter((i) => !isStatusItem(i));
  const efforts = raw?.supported_reasoning_levels?.map((l) => l.effort);
  const effort = body.reasoning?.effort;
  if (effort && efforts?.length && !efforts.includes(effort)) {
    const lower = EFFORT_ORDER.filter((e) => efforts.includes(e) && EFFORT_ORDER.indexOf(e) <= EFFORT_ORDER.indexOf(effort));
    body.reasoning.effort = lower.at(-1) ?? raw.default_reasoning_level ?? efforts[0];
  }
  return body;
}

/** Server-sent events that show `[Krun] → model` once, as a commentary message, at the top of a routed turn. */
export function statusEvents(text) {
  const id = `${STATUS_ID_PREFIX}${randomUUID()}`;
  const item = { type: "message", role: "assistant", id, phase: "commentary", content: [{ type: "output_text", text }] };
  return [
    { type: "response.output_item.added", item: { ...item, content: [] } },
    { type: "response.output_text.delta", item_id: id, delta: text },
    { type: "response.output_item.done", item },
  ]
    .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");
}

/** Streams an SSE response, inserting `extra` right after the first event. */
function injectAfterFirstEvent(up, res, extra) {
  const headers = { ...up.headers };
  delete headers["content-length"];
  res.writeHead(up.statusCode, headers);
  let pending = "";
  let done = false;
  up.on("data", (chunk) => {
    if (done) return void res.write(chunk);
    pending += chunk.toString("utf8");
    const end = pending.indexOf("\n\n");
    if (end < 0) return;
    const first = pending.slice(0, end + 2);
    res.write(first);
    if (/^(event|data):/m.test(first)) res.write(extra);
    res.write(pending.slice(end + 2));
    pending = "";
    done = true;
  });
  up.on("end", () => res.end(pending));
  up.on("error", () => res.destroy());
}

// ---------------------------------------------------------------- proxy adapter

export function createCodexAdapter({
  router,
  chatgptUpstream = CHATGPT_UPSTREAM,
  apiUpstream = API_UPSTREAM,
  preferredModel,
  loadCatalog = () => readCodexCache(),
  showStatus = true,
  dumpDir = null,
  onUsage = () => {},
}) {
  let raw = new Map(); // slug → Codex's own catalog entry
  let models = [];
  const ingest = (json) => {
    const next = modelsFromCodexCatalog(json);
    if (!next.length) return;
    models = next;
    raw = new Map(json.models.map((m) => [m.slug, m]));
    debug(`codex catalog: ${models.map((m) => m.id).join(", ")}`);
  };
  // Cold start from Codex's own cache; replaced as soon as Codex fetches /models through us.
  const warm = Promise.resolve()
    .then(loadCatalog)
    .then((json) => json && !models.length && ingest(json))
    .catch(() => {});

  return {
    upstreamFor: (req) => (req.headers["chatgpt-account-id"] ? chatgptUpstream : apiUpstream),
    wantsBody: (req) =>
      (req.method === "POST" && /\/responses(?:\/compact)?(?:\?|$)/.test(req.url ?? "")) ||
      (req.method === "GET" && /\/models(?:\?|$)/.test(req.url ?? "")),
    async transformRequest(req, buf) {
      if (req.method === "GET") {
        return {
          // A 304 would leave Codex on its cached list, which has no Krun Router row.
          headers: { "accept-encoding": undefined, "if-none-match": undefined },
          onResponse: (up, res) => {
            bufferResponse(up, res, (data) => {
              if (up.statusCode !== 200) return null;
              const json = JSON.parse(data.toString("utf8"));
              ingest(json);
              return Buffer.from(JSON.stringify(addAutoModel(json, baselineModel(models, preferredModel))));
            });
            return true;
          },
        };
      }
      if (dumpDir) dump(dumpDir, "codex-request", buf);
      const body = JSON.parse(buf.toString("utf8"));
      const turn = parseRequest(body, buf.length, req.headers);
      const usage = (model) => (u) => onUsage({ ...u, model, conversation: turn.conversationKey });
      if (!turn.auto) {
        await router.resolveTurn(turn); // records a manual choice for status/explain
        return { onUsage: usage(turn.requestedModel) };
      }
      await warm;
      turn.availableModels = models;
      turn.baselineModel = baselineModel(models, preferredModel);
      if (/\/responses\/compact/.test(req.url)) turn.prompt = null; // compaction is not a turn
      const { model, decision } = await router.resolveTurn(turn);
      normalizeForModel(body, model ?? turn.baselineModel, raw.get(model));
      const plan = { body: Buffer.from(JSON.stringify(body)), onUsage: usage(model ?? turn.baselineModel) };
      if (decision && showStatus && body.stream !== false) {
        const text = statusText({ decisions: [decision] });
        plan.headers = { "accept-encoding": undefined }; // plain SSE so the status event can be inserted
        plan.onResponse = (up, res) => {
          if (up.statusCode < 200 || up.statusCode >= 300 || up.headers["content-encoding"]) return false;
          injectAfterFirstEvent(up, res, statusEvents(text));
          return true;
        };
      }
      return plan;
    },
  };
}

// ---------------------------------------------------------------- launch

const readConfigToml = (home) => {
  try {
    return readFileSync(join(home, "config.toml"), "utf8");
  } catch {
    return "";
  }
};

/** A top-level `key = "value"` from config.toml (before the first [table]). No TOML dependency needed. */
export function topLevelTomlString(toml, key) {
  const head = toml.split(/^\s*\[/m)[0];
  return new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, "m").exec(head)?.[1];
}

const configOverride = (args, key) => {
  for (let i = 0; i < args.length; i++) {
    const v = args[i] === "-c" || args[i] === "--config" ? args[i + 1] : args[i].startsWith("--config=") ? args[i].slice(9) : null;
    const m = v && new RegExp(`^${key}\\s*=\\s*["']?([^"']+)["']?$`).exec(v);
    if (m) return m[1];
  }
  return undefined;
};

export function explicitModel(args) {
  const i = args.findIndex((a) => a === "-m" || a === "--model" || a.startsWith("--model="));
  if (i >= 0) return args[i].includes("=") ? args[i].split("=")[1] : args[i + 1];
  return configOverride(args, "model");
}

/** The model Codex would use without us. */
export function configuredModel(args, home = codexHome()) {
  return explicitModel(args) ?? topLevelTomlString(readConfigToml(home), "model");
}

/**
 * Routing only applies to Codex's built-in OpenAI provider. A user on another provider
 * (Azure, a local model, --oss) keeps their setup untouched.
 */
export function usesOtherProvider(args, home = codexHome()) {
  if (args.includes("--oss")) return true;
  const provider = configOverride(args, "model_provider") ?? topLevelTomlString(readConfigToml(home), "model_provider");
  return Boolean(provider && provider !== "openai");
}

/**
 * Codex arguments: a temporary provider pointing at the proxy, passed as `-c` overrides so
 * they apply to every subcommand (exec, resume, review…) and are never written to config.
 * User arguments follow verbatim.
 */
export function codexLaunch({ userArgs, proxyUrl }) {
  const flags = [
    `model_provider="${PROVIDER_ID}"`,
    `model_providers.${PROVIDER_ID}.name="Krun Router"`,
    `model_providers.${PROVIDER_ID}.base_url="${proxyUrl}"`,
    `model_providers.${PROVIDER_ID}.wire_api="responses"`,
    `model_providers.${PROVIDER_ID}.requires_openai_auth=true`,
    // The proxy speaks HTTP/SSE; websockets would bypass per-turn routing.
    `model_providers.${PROVIDER_ID}.supports_websockets=false`,
  ];
  if (!explicitModel(userArgs)) flags.push(`model="${AUTO_MODEL}"`);
  return [...flags.flatMap((f) => ["-c", f]), ...userArgs];
}
