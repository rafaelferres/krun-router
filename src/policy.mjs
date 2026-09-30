import { TIERS, tierOf } from "./catalog.mjs";
import { TASK_KINDS } from "./krun-client.mjs";
import { PRICES, priceFor } from "./stats.mjs";

/**
 * Turns Krun's task classification into the model that runs. Pure, deterministic and total.
 *
 *   no answer (timeout, error, bad response)       → keep current
 *   confidence below the mode's floor              → keep current
 *   follow-up with no task of its own              → keep current
 *   otherwise the kind's tier (shifted by mode), one tier above the current model when the
 *   user rejects the previous attempt, then the cheapest compatible model at that tier
 *   (nearest tier if none; "quality" takes the priciest in the tier)
 *   a downgrade whose prompt-cache rewrite costs more than it saves this turn → keep current
 *
 * "Keep current" never lands on a model known to be incompatible with the request: if the
 * current model was rejected by the capability check, the first compatible candidate runs.
 *
 * @returns {{ model: string|null, reason: string, fallback: boolean, tier?: string }}
 */
// Floors and thresholds per mode, picked from `krun-router eval` (eval/phase2-report.json).
// economy/balanced act on every classification (a floor only moved choices back to the current
// model); quality keeps the current model below 0.2, which removed the remaining risk.
export const MIN_CONFIDENCE = { economy: 0, balanced: 0, quality: 0.2 };
export const ESCALATE_AT = { economy: 0.9, balanced: 0.8, quality: 0.7 };
const SHIFT = { economy: { medium: "small" }, balanced: {}, quality: { small: "medium" } };

export function applyPolicy({ answer, error, candidates, rejected = [], currentModel, mode = "balanced", context = {} }) {
  const keep = (reason) => {
    const currentRejected = rejected.some((r) => r.id === currentModel);
    const model = currentModel && !currentRejected ? currentModel : (candidates[0]?.id ?? currentModel ?? null);
    return { model, reason, fallback: true };
  };
  if (!answer) return keep(error ? `krun unavailable: ${error}` : "krun unavailable");
  if (!(answer.confidence >= MIN_CONFIDENCE[mode])) return keep(`low confidence (${answer.kind})`);
  let tier = TASK_KINDS[answer.kind]?.[1];
  if (tier === undefined) return keep(`unknown task kind ${answer.kind}`);
  if (tier === null) return keep(`follow-up (${answer.kind})`);
  tier = SHIFT[mode][tier] ?? tier;

  const current = candidates.find((m) => m.id === currentModel);
  const rank = (m) => TIERS.indexOf(tierOf(m));
  let reason = `krun: ${answer.kind} → ${tier}`;
  if (current && answer.escalate >= ESCALATE_AT[mode] && rank(current) >= TIERS.indexOf(tier)) {
    tier = TIERS[Math.min(TIERS.length - 1, rank(current) + 1)];
    reason = `krun: ${answer.kind}, previous attempt rejected → ${tier}`;
  }

  const target = pickAtTier(candidates, tier, mode);
  if (!target) return keep("no compatible candidates");
  if (current && target.id !== current.id && cheaper(target, current) && switchCostExceedsSaving(context, current, target, tier)) {
    return { ...keep(`switching cost (${answer.kind} → ${tier})`), tier };
  }
  return { model: target.id, reason, fallback: false, tier };
}

const inputPrice = (m) => priceFor(m.id, PRICES)?.[0] ?? null;

/** The model at `tier` (nearest tier if none, preferring the larger), cheapest first. */
function pickAtTier(candidates, tier, mode) {
  const want = TIERS.indexOf(tier);
  const distance = (m) => Math.abs(TIERS.indexOf(tierOf(m)) - want) * 2 - (TIERS.indexOf(tierOf(m)) > want ? 1 : 0);
  const best = Math.min(...candidates.map(distance));
  const pool = candidates.filter((m) => distance(m) === best);
  // Unpriced models keep catalog order; priced ones sort by input price.
  const sorted = [...pool].sort((a, b) => (inputPrice(a) ?? 0) - (inputPrice(b) ?? 0));
  return mode === "quality" ? sorted.at(-1) : sorted[0];
}

function cheaper(a, b) {
  const ra = TIERS.indexOf(tierOf(a)), rb = TIERS.indexOf(tierOf(b));
  if (ra !== rb) return ra < rb;
  const pa = inputPrice(a), pb = inputPrice(b);
  return pa != null && pb != null && pa < pb;
}

// ponytail: expected requests per turn by tier and ~1k output tokens per request are rough
// averages; per-conversation measurements from the usage ledger would make this exact.
const EXPECTED_REQUESTS = { small: 2, medium: 6, large: 10 };
const OUTPUT_PER_REQUEST = 1000;
const UNPRICED_DOWNGRADE_MAX_TOKENS = 100000;

/**
 * Downgrades only. Staying reads the warm prompt cache on the current model; switching writes
 * the whole prefix to the new model's cache once, then reads it. Without earlier turns there is
 * no warm cache to lose. Prices are [input, output, cacheRead, cacheWrite] per million tokens.
 */
export function switchCostExceedsSaving(context, current, target, tier) {
  const tokens = context?.tokens;
  if (!tokens || !(context.turns > 1)) return false;
  const pc = priceFor(current.id, PRICES), pt = priceFor(target.id, PRICES);
  if (!pc || !pt) return tokens > UNPRICED_DOWNGRADE_MAX_TOKENS;
  const r = EXPECTED_REQUESTS[tier], o = OUTPUT_PER_REQUEST;
  const stay = r * (tokens * pc[2] + o * pc[1]);
  const move = tokens * pt[3] + (r - 1) * tokens * pt[2] + r * o * pt[1];
  return move >= stay;
}
