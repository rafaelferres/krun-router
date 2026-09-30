import { readFileSync } from "node:fs";
import { table } from "./cli/output.mjs";

/**
 * USD per million tokens: [input, output, cache read, cache write]. Anthropic list prices from
 * the Claude API reference (2026-09-25); cache write is 1.25x input (5-minute TTL). Other
 * providers are not built in because their prices were not verifiable here: add them (or
 * override these) in ~/.krun-router/prices.json, same shape. Everything is an estimate.
 */
export const PRICES = {
  "claude-fable-5-1": [10, 50, 0.25, 12.5],
  "claude-fable-5": [10, 50, 1, 12.5],
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-opus-5": [5, 25, 0.5, 6.25],
  "claude-opus-4-8": [5, 25, 0.5, 6.25],
  "claude-opus-4-7": [5, 25, 0.5, 6.25],
  "claude-opus-4-6": [5, 25, 0.5, 6.25],
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5],
  "claude-sonnet-5": [2, 10, 0.2, 2.5],
  "claude-sonnet-4-6": [3, 15, 0.3, 3.75],
  "claude-haiku-4-5": [1, 5, 0.1, 1.25],
};

/** Exact id, else the longest known prefix (`claude-haiku-4-5-20251001` → `claude-haiku-4-5`). */
export function priceFor(model, prices = PRICES) {
  if (!model) return null;
  if (prices[model]) return prices[model];
  const key = Object.keys(prices)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return key ? prices[key] : null;
}

export const costOf = (u, p) => (u.input * p[0] + u.output * p[1] + u.cacheRead * p[2] + u.cacheWrite * p[3]) / 1e6;

/** Ledger lines → events, newest filter applied. Unreadable lines are skipped. */
export function readLedger(file, { days, cli, now = Date.now() } = {}) {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const since = days ? now - days * 86_400_000 : 0;
  const out = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e.at >= since && (!cli || e.cli === cli)) out.push(e);
    } catch {
      // a torn last line from a crashed writer
    }
  }
  return out;
}

export function loadPrices(file) {
  try {
    return { ...PRICES, ...JSON.parse(readFileSync(file, "utf8")) };
  } catch {
    return PRICES;
  }
}

/** Why a turn ran where it did, from the recorded policy reason. */
export function outcome(d) {
  const r = d.reason ?? "";
  if (r === "only one compatible model") return "only one model";
  if (r.startsWith("krun abstained") || r.startsWith("low confidence")) return "kept: low confidence";
  if (/timeout/.test(r)) return "kept: timeout";
  if (r.startsWith("krun unavailable")) return "kept: krun unavailable";
  if (r.startsWith("follow-up")) return "kept: follow-up";
  if (r.startsWith("switching cost")) return "kept: switching cost";
  if (r.startsWith("krun chose unavailable") || r.startsWith("unknown task kind")) return "kept: invalid answer";
  if (r.startsWith("krun")) return d.model === d.previous ? "routed: same model" : "routed: switched";
  return "kept: other";
}

const percentile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);

/**
 * Totals from ledger events. Savings compare each request with the same tokens on the
 * conversation's baseline (the model its first routed turn started from). When a request ran on
 * another model, the tokens it wrote to cache are priced as cache reads on the baseline, which
 * would have kept its prefix warm: the estimate leans toward the baseline, so savings are not
 * overstated. Output length is assumed equal across models. Requests with an unpriced model are
 * left out of cost and savings (counted in `unpriced`).
 */
export function computeStats(events, prices = PRICES) {
  const decisions = events.filter((e) => e.type === "decision");
  const baseline = new Map();
  for (const d of decisions) if (!baseline.has(d.conversation)) baseline.set(d.conversation, d.previous ?? d.model);

  const turns = {};
  for (const d of decisions) turns[outcome(d)] = (turns[outcome(d)] ?? 0) + 1;
  const manual = events.filter((e) => e.type === "manual").length;
  if (manual) turns["manual model"] = manual;

  const called = decisions.filter((d) => d.latencyMs != null);
  const lat = called.map((d) => d.latencyMs).sort((a, b) => a - b);
  const krun = {
    calls: called.length,
    p50: percentile(lat, 0.5),
    p95: percentile(lat, 0.95),
    timeoutRate: called.length ? called.filter((d) => /timeout/.test(d.reason ?? "")).length / called.length : null,
  };

  const models = {};
  let actual = 0;
  let base = 0;
  let unpriced = 0;
  for (const u of events.filter((e) => e.type === "usage")) {
    const id = u.model ?? "unknown";
    const m = (models[id] ??= { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, priced: true });
    m.requests++;
    for (const k of ["input", "output", "cacheRead", "cacheWrite"]) m[k] += u[k] ?? 0;
    const p = priceFor(u.model, prices);
    const cost = Number.isFinite(u.cost) ? u.cost : p ? costOf(u, p) : null;
    if (cost == null) {
      m.priced = false;
      unpriced++;
      continue;
    }
    m.cost += cost;
    const b = baseline.get(u.conversation) ?? u.model;
    const bp = b === u.model ? null : priceFor(b, prices);
    if (b !== u.model && !bp) {
      unpriced++;
      continue;
    }
    actual += cost;
    base += b === u.model ? cost : costOf({ ...u, cacheRead: u.cacheRead + u.cacheWrite, cacheWrite: 0 }, bp);
  }

  return { turns, krun, models, cost: { actual, baseline: base, savings: base - actual, unpriced } };
}

const usd = (n) => `$${n.toFixed(n >= 100 ? 0 : 2)}`;
const int = (n) => Math.round(n).toLocaleString("en-US");

/** Columns sized to their content. */
const grid = (rows) => rows.length && table(rows, rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)) + 2));

export function formatStats(s, { days, cli } = {}) {
  const scope = `${days ? `last ${days} days` : "all recorded history"}${cli ? `, ${cli} only` : ""}`;
  const total = Object.values(s.turns).reduce((a, b) => a + b, 0);
  if (!total && !Object.keys(s.models).length) return `Krun Router stats (${scope})\n\nNothing recorded yet. Stats start with the next routed session.\n`;
  const out = [`Krun Router stats (${scope})`, ""];
  out.push(`Turns (${total})`);
  out.push(grid(Object.entries(s.turns).sort((a, b) => b[1] - a[1]).map(([k, n]) => [`  ${k}`, String(n), `${Math.round((n / total) * 100)}%`])));
  out.push("");
  const k = s.krun;
  out.push(
    `Krun: ${k.calls} calls` +
      (k.calls ? `, p50 ${k.p50} ms, p95 ${k.p95} ms, timeouts ${Math.round(k.timeoutRate * 100)}%` : ""),
  );
  out.push("");
  out.push("Tokens and estimated cost by model");
  out.push(
    grid([
      ["  model", "requests", "input", "output", "cache read", "cache write", "cost"],
      ...Object.entries(s.models)
        .sort((a, b) => b[1].cost - a[1].cost)
        .map(([id, m]) => [`  ${id}`, int(m.requests), int(m.input), int(m.output), int(m.cacheRead), int(m.cacheWrite), m.priced ? usd(m.cost) : "no price"]),
    ]),
  );
  out.push("");
  const c = s.cost;
  out.push(`Estimated cost ${usd(c.actual)}, vs ${usd(c.baseline)} on each conversation's starting model: ${c.savings >= 0 ? "saved" : "extra"} ${usd(Math.abs(c.savings))}`);
  if (c.unpriced) out.push(`(${c.unpriced} requests left out: model without a price; add it to ~/.krun-router/prices.json)`);
  out.push("Estimates only; see `krun-router stats --help` for the method.");
  return `${out.join("\n")}\n`;
}
