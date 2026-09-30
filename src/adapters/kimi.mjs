// Everything that depends on Kimi Code's wire format lives in this module. Kimi Code talks to
// Moonshot with OpenAI chat completions (provider type "kimi"); that shape is what is parsed here.
import { createHash } from "node:crypto";
import { normalizeModel } from "../catalog.mjs";
import { debug, dump } from "../log.mjs";

/** Model id of the "Krun Router" entry. Requests carrying anything else are the user's choice. */
export const AUTO_MODEL = "krun-router";
export const DEFAULT_UPSTREAM = "https://api.moonshot.ai/v1";
export const EXPLAIN_MARKER = "<krun-explain>";
// Kimi Code's compaction request (agent-core-v2 compaction-instruction.md): pinned, never routed.
const COMPACTION = /^You are about to run out of context\./;

// ---------------------------------------------------------------- model catalog

/**
 * Candidates from the provider's own GET /models. Only models spoken over chat completions are
 * kept: Kimi Code's managed /models can mark models as `anthropic` or `response` protocol,
 * which this proxy does not translate. Fields a server does not send stay unknown.
 */
export function modelsFromKimiList(json) {
  return (json?.data ?? [])
    .filter((m) => typeof m?.id === "string" && (m.protocol === undefined || m.protocol === "openai" || m.protocol === "chat"))
    .map((m) => {
      const thinking = m.supports_thinking_type; // "only" | "no" | "both"
      const reasoning = thinking ? thinking !== "no" : typeof m.supports_reasoning === "boolean" ? m.supports_reasoning : undefined;
      return normalizeModel({
        id: m.id,
        provider: "moonshot",
        displayName: m.display_name ?? m.id,
        contextWindow: Number(m.context_length) || undefined,
        capabilities: {
          reasoning,
          vision: typeof m.supports_image_in === "boolean" ? m.supports_image_in : undefined,
          tools: typeof m.supports_tool_use === "boolean" ? m.supports_tool_use : undefined,
          features: thinking === "only" ? ["always_thinking"] : undefined,
        },
      });
    });
}

export async function fetchKimiModels(upstream, apiKey, { timeoutMs = 5000, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${upstream.replace(/\/$/, "")}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`GET /models: HTTP ${res.status}`);
  return modelsFromKimiList(await res.json());
}

export function baselineModel(models, preferred) {
  if (preferred && preferred !== AUTO_MODEL && models.some((m) => m.id === preferred)) return preferred;
  return models[0]?.id ?? null;
}

// ---------------------------------------------------------------- request parsing

const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((p) => p?.type === "text").map((p) => p.text).join("\n")
      : "";

const stripReminders = (content) => textOf(content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();

/**
 * Text of a new human turn, or null (tool continuation, compaction). Kimi Code appends
 * reminder-only user messages (date, permission mode) after the prompt; those are skipped.
 */
export function freshPrompt(body) {
  for (const m of [...(body?.messages ?? [])].reverse()) {
    if (m?.role === "system") continue;
    if (m?.role !== "user") return null; // "tool" / "assistant" = continuation of the current turn
    const text = stripReminders(m.content);
    if (!text) continue;
    return COMPACTION.test(text) ? null : text;
  }
  return null;
}

/** Stable per-conversation key: the first non-system message differs per agent and sub-agent. */
export function conversationKey(body) {
  const first = body?.messages?.find((m) => m?.role !== "system");
  return createHash("sha1").update(textOf(first?.content)).digest("hex").slice(0, 12);
}

const hasImage = (messages) =>
  (messages ?? []).some((m) => Array.isArray(m?.content) && m.content.some((p) => p?.type === "image_url"));

export function parseRequest(body, bytes = 0) {
  const prompt = freshPrompt(body);
  const tokens = Math.round(bytes / 4);
  return {
    auto: body?.model === AUTO_MODEL,
    requestedModel: body?.model,
    prompt,
    skipRouting: Boolean(prompt?.includes(EXPLAIN_MARKER)),
    conversationKey: conversationKey(body),
    turnId: prompt ? createHash("sha1").update(`${body.messages.length}|${prompt}`).digest("hex").slice(0, 12) : null,
    requirements: { tools: Array.isArray(body?.tools) && body.tools.length > 0, vision: hasImage(body?.messages), contextTokens: tokens },
    context: { tokens, messages: body?.messages?.length ?? 0, turns: (body?.messages ?? []).filter((m) => m?.role === "user").length },
  };
}

/** Points the body at `model`; drops the `thinking` switch a model cannot honor. */
export function normalizeForModel(body, model, info) {
  body.model = model;
  const c = info?.capabilities;
  if (c?.reasoning === false) delete body.thinking;
  // An always-thinking model rejects an explicit "disabled".
  if (c?.features?.includes("always_thinking") && body.thinking?.type === "disabled") delete body.thinking;
  return body;
}

// ---------------------------------------------------------------- proxy adapter

export function createKimiAdapter({ router, upstream = DEFAULT_UPSTREAM, models, preferredModel, dumpDir = null, onUsage = () => {} }) {
  const baseline = baselineModel(models, preferredModel);
  return {
    upstreamFor: () => upstream,
    wantsBody: (req) => req.method === "POST" && /^\/chat\/completions(?:\?|$)/.test(req.url ?? ""),
    async transformRequest(_req, buf) {
      if (dumpDir) dump(dumpDir, "kimi-request", buf);
      const body = JSON.parse(buf.toString("utf8"));
      const turn = parseRequest(body, buf.length);
      // ponytail: no stream_options.include_usage added; Moonshot reports usage on the final chunk. Add it if a provider needs it.
      const usage = (model) => (u) => onUsage({ ...u, model, conversation: turn.conversationKey });
      if (!turn.auto) {
        await router.resolveTurn(turn); // records a manual choice for explain
        return { onUsage: usage(turn.requestedModel) };
      }
      turn.availableModels = models;
      turn.baselineModel = baseline;
      const { model } = await router.resolveTurn(turn);
      debug(`kimi: ${turn.prompt ? "turn" : "continuation"} -> ${model}`);
      normalizeForModel(body, model, models.find((m) => m.id === model));
      return { body: Buffer.from(JSON.stringify(body)), onUsage: usage(model) };
    },
  };
}

// ---------------------------------------------------------------- launch

/**
 * Kimi Code builds an in-memory provider + model from KIMI_MODEL_* and makes it the default
 * (node-sdk config/env-model.ts), so "Krun Router" appears in /model with nothing written to
 * config.toml. The API key travels to the proxy as the bearer token and is forwarded untouched.
 */
export function kimiLaunchEnv({ env, proxyUrl, apiKey, models }) {
  const caps = [];
  if (models.some((m) => m.capabilities.reasoning !== false)) caps.push("thinking");
  if (models.some((m) => m.capabilities.vision)) caps.push("image_in");
  // The largest window: turns too big for a smaller model are kept off it by the capability check.
  const context = Math.max(0, ...models.map((m) => m.contextWindow ?? 0));
  return {
    ...env,
    KIMI_MODEL_NAME: AUTO_MODEL,
    KIMI_MODEL_DISPLAY_NAME: "Krun Router",
    KIMI_MODEL_PROVIDER_TYPE: "kimi",
    KIMI_MODEL_BASE_URL: proxyUrl,
    KIMI_MODEL_API_KEY: apiKey,
    KIMI_MODEL_CAPABILITIES: caps.join(",") || "thinking",
    ...(context ? { KIMI_MODEL_MAX_CONTEXT_SIZE: String(context) } : {}),
  };
}

/** The user's Moonshot API key and base URL, from Kimi Code's own env model or MOONSHOT_*. */
export function kimiCredentials(env) {
  const own = env.KIMI_MODEL_NAME ? env : {};
  const type = (own.KIMI_MODEL_PROVIDER_TYPE ?? "kimi").toLowerCase();
  return {
    apiKey: own.KIMI_MODEL_API_KEY || env.MOONSHOT_API_KEY || null,
    upstream: own.KIMI_MODEL_BASE_URL || env.MOONSHOT_BASE_URL || DEFAULT_UPSTREAM,
    preferredModel: own.KIMI_MODEL_NAME || null,
    // ponytail: only chat-completions providers are proxied; anthropic/openai env models start plain.
    supported: type === "kimi",
  };
}
