/**
 * The provider-neutral model shape every adapter produces:
 *
 *   { id, provider, displayName, description, contextWindow,
 *     capabilities: { reasoning, vision, tools, efforts, features } }
 *
 * `undefined` means "unknown" and never excludes a model; only an explicit `false` does.
 */
export function normalizeModel(m) {
  return {
    id: String(m.id),
    ...(m.tier ? { tier: m.tier } : {}),
    provider: m.provider ?? "unknown",
    displayName: m.displayName ?? m.id,
    description: m.description ?? "",
    contextWindow: Number.isFinite(m.contextWindow) ? m.contextWindow : undefined,
    capabilities: {
      reasoning: m.capabilities?.reasoning,
      vision: m.capabilities?.vision,
      tools: m.capabilities?.tools,
      efforts: Array.isArray(m.capabilities?.efforts) ? m.capabilities.efforts : undefined,
      features: Array.isArray(m.capabilities?.features) ? m.capabilities.features : undefined,
    },
  };
}

export const TIERS = ["small", "medium", "large"];

// ponytail: name patterns cover today's Claude, OpenAI/Codex, Kimi and common open models;
// an unknown name is "medium" (never the cheapest or priciest guess). Add patterns as families appear.
const TIER_PATTERNS = [
  [/\b(haiku|mini|nano|flash|lite|luna|turbo|small|highspeed)\b/i, "small"],
  [/\b(opus|fable|astra|thinking|ultra|large|pro)\b/i, "large"],
];

/** small | medium | large: an explicit `tier` wins, else the model's name. */
export function tierOf(m) {
  if (TIERS.includes(m?.tier)) return m.tier;
  const name = `${m?.id ?? ""} ${m?.displayName ?? ""}`;
  return TIER_PATTERNS.find(([re]) => re.test(name))?.[1] ?? "medium";
}
