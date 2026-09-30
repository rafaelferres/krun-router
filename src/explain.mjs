import { tierOf } from "./catalog.mjs";
import { latestDecision } from "./status.mjs";

const INNER = 44;
const LABEL = 16;

const fit = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
const line = (text = "") => `│ ${fit(text, INNER)} │`;
const kv = (k, v) => line(`${k.length >= LABEL ? `${k} ` : k.padEnd(LABEL)}${v}`);
/** Label left, value right-aligned: long model ids never run into their numbers. */
const lr = (k, v) => line(`${fit(k, INNER - v.length - 1)} ${v}`);
const yn = (v) => (v ? "yes" : "no");
const num = (v) => (Number.isFinite(v) ? v.toFixed(2) : "n/a");

/**
 * Renders a recorded decision. Pure formatting of what was stored at decision time; it never
 * talks to Krun, so the explanation is exactly the exchange that chose the model.
 */
export function formatExplanation(history) {
  const d = latestDecision(history);
  const manual = history?.manual;
  if (manual && (!d || manual.at >= d.at)) {
    return `Krun Router: routing is paused because ${manual.model} was selected manually.\nSelect "Krun Router" in the model picker to resume.`;
  }
  if (!d) return "Krun Router: no routing decision has been recorded for this session yet.";

  const candidates = d.candidates.map((id) => lr(id === d.model ? `${id} *` : id, tierOf({ id })));
  const req = d.requirements ?? {};
  return [
    `┌─ Krun Router ${"─".repeat(INNER - 12)}┐`,
    line(),
    kv("Prompt", (d.prompt ?? "").replace(/\s+/g, " ")),
    kv("Selected", d.model ?? "n/a"),
    kv("Previous", d.currentModel ?? "n/a"),
    kv("Task kind", d.kind ?? "n/a"),
    kv("Confidence", d.confidence != null ? num(d.confidence) : "n/a"),
    kv("Tier", d.tier ?? "n/a"),
    kv("Rejects prev.", d.escalate != null ? num(d.escalate) : "n/a"),
    kv("Mode", d.mode ?? "balanced"),
    kv("Latency", d.krun ? `${d.krun.latencyMs} ms` : "not asked"),
    kv("Request id", d.krun?.requestId ?? "n/a"),
    line(),
    line("Candidates"),
    ...candidates,
    ...(d.rejected?.length ? [line(), line("Rejected (capabilities)"), ...d.rejected.map((r) => line(`${r.id}: ${r.reason}`))] : []),
    line(),
    line("Context"),
    kv("tokens", d.context?.tokens != null ? `~${d.context.tokens.toLocaleString("en-US")}` : "n/a"),
    kv("new turn", "yes"),
    kv("tools", yn(req.tools)),
    kv("vision", yn(req.vision)),
    line(),
    line("Policy"),
    kv("manual override", "no"),
    kv("capability pass", yn(!d.rejected?.some((r) => r.id === d.model))),
    kv("fallback", d.fallback ? `yes (${d.reason})` : "no"),
    ...(d.krun?.error ? [kv("krun error", d.krun.error)] : []),
    `└${"─".repeat(INNER + 2)}┘`,
  ].join("\n");
}

/** One line per recorded decision, oldest first. */
export function formatHistory(history) {
  const ds = history?.decisions ?? [];
  if (!ds.length) return "Krun Router: no routing decisions recorded.";
  return ds
    .map((d) => {
      const t = new Date(d.at).toISOString().slice(11, 19);
      const conf = d.confidence != null ? ` ${num(d.confidence)}` : "";
      return `${t}  ${d.model}${conf}  ${d.fallback ? `[${d.reason}] ` : ""}${(d.prompt ?? "").replace(/\s+/g, " ").slice(0, 60)}`;
    })
    .join("\n");
}
