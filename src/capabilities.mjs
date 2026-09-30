/**
 * Local hard constraints. Krun expresses a preference; this decides what can run at all.
 * A capability the catalog does not report is treated as available, because excluding a
 * model on missing metadata would silently shrink the choice set.
 *
 * requirements: { vision?, tools?, reasoning?, contextTokens?, features? }
 *
 * `features` are opaque provider-specific request traits (e.g. a wire-format variant) that
 * an adapter detected in the request; a model must list each one in `capabilities.features`.
 */
export function incompatibility(model, req = {}) {
  const c = model.capabilities ?? {};
  const missing = c.features && req.features?.find((f) => !c.features.includes(f));
  if (missing) return `does not support ${missing}`;
  if (req.vision && c.vision === false) return "no vision input";
  if (req.tools && c.tools === false) return "no tool calling";
  if (req.reasoning && c.reasoning === false) return "no reasoning";
  if (req.contextTokens && model.contextWindow && req.contextTokens > model.contextWindow) {
    return `context ~${req.contextTokens} tokens exceeds ${model.contextWindow}`;
  }
  return null;
}

export function partitionCompatible(models, req) {
  const compatible = [];
  const rejected = [];
  for (const m of models) {
    const reason = incompatibility(m, req);
    if (reason) rejected.push({ id: m.id, reason });
    else compatible.push(m);
  }
  return { compatible, rejected };
}
