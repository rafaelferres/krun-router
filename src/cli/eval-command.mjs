// Offline-labelled routing evaluation against the real Krun API. Each case is a prompt plus
// the model tiers (small/medium/large) that would be acceptable; each provider family maps
// tiers to real candidate models (eval/families.json). Krun classifies each case ONCE (the
// request does not depend on the family), then the production policy (src/policy.mjs) runs
// offline for every family, mode and confidence floor, so numbers compare policies, not luck.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TIERS, normalizeModel, tierOf } from "../catalog.mjs";
import { MODES, ROUTING_TIMEOUT_MS } from "../config.mjs";
import { createKrunClient } from "../krun-client.mjs";
import { ESCALATE_AT, applyPolicy } from "../policy.mjs";
import { ROOT } from "../launch.mjs";

export const EVAL_HELP = `Usage: krun-router eval [--set <name>] [--family <name>] [--variant <name>]
                        [--current <tier>] [--limit <n>] [--json] [--out <file>] [--yes]

Classifies the labelled cases in eval/*.jsonl with the real Krun API, then applies the routing
policy offline for every provider family (eval/families.json), mode and confidence floor.
Reports accuracy (chosen tier acceptable), waste (bigger than needed), risk (smaller than
needed), relative cost and latency; the escalation set reports how often "the user rejects
the previous attempt" is detected. One /v1/decide call per case and variant; more than 100
calls need --yes.

  --set       routing | holdout | escalation (repeatable; default: all)
  --family    claude | codex | kimi (repeatable; default: all)
  --variant   kinds | kinds+signals (repeatable; default: kinds)
  --current   tier of the model the conversation is on (default: large)
  --limit     only the first n cases of each set
  --json      print the full report (including every case) as JSON
  --out       also write the JSON report to a file
`;

export const FLOORS = [0, 0.05, 0.1, 0.2, 0.3];
const SETS = ["routing", "holdout", "escalation"];
const EVAL_TIMEOUT_MS = 15000; // longer than production, so slow answers are measured, not lost

/** What Krun is sent besides the prompt: the prompt-free conversation facts, or none. */
export const VARIANTS = {
  kinds: { context: () => ({}) },
  "kinds+signals": { context: (c) => c.context ?? {} },
};

export function loadEval(dir = join(ROOT, "eval")) {
  const read = (name) => {
    const file = join(dir, `${name}.jsonl`);
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => ({ ...JSON.parse(l), set: name })) : [];
  };
  const { _note, ...families } = JSON.parse(readFileSync(join(dir, "families.json"), "utf8"));
  return { sets: Object.fromEntries(SETS.map((s) => [s, read(s)])), families };
}

/** Classifies every case once, `concurrency` requests at a time. */
export async function classify({ cases, variant, apiKey, apiUrl, fetchImpl = fetch, concurrency = 2, backoffMs = 2000 }) {
  const krun = createKrunClient({ apiKey, apiUrl, timeoutMs: EVAL_TIMEOUT_MS, fetchImpl });
  const results = new Array(cases.length);
  let next = 0;
  const worker = async () => {
    while (next < cases.length) {
      const i = next++;
      const c = cases[i];
      // Eval-only retry on rate limits (production never retries): 2s, 4s, 8s, 16s, 32s.
      let r = await krun.decide(c.prompt, variant.context(c));
      let retries = 0;
      while (/^HTTP 429/.test(r.error ?? "") && retries < 5) {
        await new Promise((ok) => setTimeout(ok, backoffMs * 2 ** retries++));
        r = await krun.decide(c.prompt, variant.context(c));
      }
      results[i] = { case: c, ok: r.ok, error: r.error ?? null, latencyMs: r.latencyMs, retries, answer: r.answer ?? null };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, worker));
  return results;
}

const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : 0);
const percentile = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))] : null);
const rank = (t) => TIERS.indexOf(t);

/** Scores one tier per result against the labels. */
function score(results, tiers, cost) {
  let correct = 0, waste = 0, risk = 0, spent = 0, maxSpend = 0;
  results.forEach((r, i) => {
    const t = tiers[i];
    const accept = r.case.accept;
    if (accept.includes(t)) correct++;
    else if (rank(t) > Math.max(...accept.map(rank))) waste++;
    else risk++;
    spent += cost[t];
    maxSpend += cost.large;
  });
  const n = results.length;
  return { accuracy: pct(correct, n), waste: pct(waste, n), risk: pct(risk, n), relativeCost: pct(spent, maxSpend) };
}

/** The production policy for one result, with an optional confidence floor override. */
function policyTier(r, { models, current, mode, floor }) {
  const a = r.answer && floor !== undefined ? { ...r.answer, confidence: r.answer.confidence >= floor ? 1 : -1 } : r.answer;
  const d = applyPolicy({ answer: a, error: r.error, candidates: models, currentModel: current.id, mode });
  return tierOf(models.find((m) => m.id === d.model) ?? current);
}

export function summarize(results, family, { current: currentTier = "large" } = {}) {
  const models = family.models.map(normalizeModel);
  const current = models.find((m) => tierOf(m) === currentTier) ?? models[0];
  const ok = results.filter((r) => r.ok);
  const lat = ok.map((r) => r.latencyMs);
  const policies = {
    [`always ${currentTier}`]: results.map(() => currentTier),
    "always small": results.map(() => "small"),
    ...Object.fromEntries(MODES.map((mode) => [`krun ${mode}`, results.map((r) => policyTier(r, { models, current, mode }))])),
    ...Object.fromEntries(FLOORS.map((floor) => [`balanced, floor ${floor}`, results.map((r) => policyTier(r, { models, current, mode: "balanced", floor }))])),
  };
  return {
    cases: results.length,
    errors: results.length - ok.length,
    rateLimitRetries: results.reduce((n, r) => n + (r.retries ?? 0), 0),
    timeouts: results.filter((r) => /timeout/.test(r.error ?? "")).length,
    overDeadline: ok.filter((r) => r.latencyMs > ROUTING_TIMEOUT_MS).length, // would have failed open in production
    latencyMs: { p50: percentile(lat, 0.5), p95: percentile(lat, 0.95) },
    policies: Object.fromEntries(Object.entries(policies).map(([name, tiers]) => [name, score(results, tiers, family.cost)])),
  };
}

/** Escalation detection: accuracy of `escalate >= threshold` per mode. */
export function summarizeEscalation(results) {
  const ok = results.filter((r) => r.ok);
  return Object.fromEntries(
    MODES.map((mode) => {
      const hit = (r) => r.answer.escalate >= ESCALATE_AT[mode];
      const pos = ok.filter((r) => r.case.rejects), neg = ok.filter((r) => !r.case.rejects);
      return [mode, { threshold: ESCALATE_AT[mode], accuracy: pct(ok.filter((r) => hit(r) === r.case.rejects).length, ok.length), detected: pct(pos.filter(hit).length, pos.length), falseAlarms: pct(neg.filter(hit).length, neg.length) }];
    }),
  );
}

function formatSummary(label, s) {
  const head = `${label}: ${s.cases} cases, ${s.errors} errors (${s.timeouts} timeouts, ${s.overDeadline} over the ${ROUTING_TIMEOUT_MS} ms deadline) · latency p50 ${s.latencyMs.p50} ms, p95 ${s.latencyMs.p95} ms`;
  const rows = Object.entries(s.policies).map(
    ([name, p]) => `  ${name.padEnd(20)} accuracy ${String(p.accuracy).padStart(5)}%  waste ${String(p.waste).padStart(5)}%  risk ${String(p.risk).padStart(5)}%  cost ${String(p.relativeCost).padStart(5)}%`,
  );
  return [head, ...rows].join("\n");
}

function parseArgs(args) {
  const o = { sets: [], families: [], variants: [], current: "large", limit: Infinity, json: false, out: null, yes: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--set") o.sets.push(args[++i]);
    else if (a === "--family") o.families.push(args[++i]);
    else if (a === "--variant") o.variants.push(args[++i]);
    else if (a === "--current") o.current = args[++i];
    else if (a === "--limit") o.limit = Number(args[++i]);
    else if (a === "--out") o.out = args[++i];
    else if (a === "--json") o.json = true;
    else if (a === "--yes" || a === "-y") o.yes = true;
    else return { error: `unknown argument: ${a}` };
  }
  return o;
}

export async function evalCommand(args, ctx, { dir, fetchImpl = fetch, backoffMs } = {}) {
  const { config, stdout, stderr } = ctx;
  if (args.includes("--help") || args.includes("-h")) return stdout.write(EVAL_HELP), 0;
  const o = parseArgs(args);
  if (o.error) return stderr.write(`krun-router eval: ${o.error}\n`), 2;
  const { sets, families } = loadEval(dir);
  const setNames = o.sets.length ? o.sets : SETS.filter((s) => sets[s].length);
  const familyNames = o.families.length ? o.families : Object.keys(families);
  const variantNames = o.variants.length ? o.variants : ["kinds"];
  for (const s of setNames) if (!SETS.includes(s)) return stderr.write(`krun-router eval: unknown set "${s}" (${SETS.join(", ")})\n`), 2;
  for (const f of familyNames) if (!families[f]) return stderr.write(`krun-router eval: unknown family "${f}" (${Object.keys(families).join(", ")})\n`), 2;
  for (const v of variantNames) if (!VARIANTS[v]) return stderr.write(`krun-router eval: unknown variant "${v}" (${Object.keys(VARIANTS).join(", ")})\n`), 2;
  if (!TIERS.includes(o.current)) return stderr.write(`krun-router eval: --current must be one of ${TIERS.join(", ")}\n`), 2;
  if (!config.apiKey) return stderr.write("krun-router eval: no Krun API key configured (krun-router config set api-key)\n"), 1;

  const picked = Object.fromEntries(setNames.map((s) => [s, sets[s].slice(0, o.limit)]));
  const perVariant = Object.values(picked).reduce((n, cs) => n + cs.length, 0);
  const calls = perVariant * variantNames.length;
  stderr.write(`${calls} /v1/decide calls (${perVariant} cases × ${variantNames.length} variants)\n`);
  if (calls > 100 && !o.yes) return stderr.write("More than 100 calls: pass --yes to run.\n"), 1;

  const report = { at: new Date().toISOString(), current: o.current, runs: [] };
  for (const v of variantNames) {
    for (const [set, cases] of Object.entries(picked)) {
      if (!cases.length) continue;
      const results = await classify({ cases, variant: VARIANTS[v], apiKey: config.apiKey, apiUrl: config.apiUrl, fetchImpl, ...(backoffMs ? { backoffMs } : {}) });
      const lean = results.map((r) => ({ id: r.case.id, ok: r.ok, error: r.error, latencyMs: r.latencyMs, kind: r.answer?.kind ?? null, confidence: r.answer?.confidence ?? null, escalate: r.answer?.escalate ?? null }));
      if (set === "escalation") {
        const escalation = summarizeEscalation(results);
        report.runs.push({ variant: v, set, escalation, results: lean });
        if (!o.json) stdout.write(`${v} · escalation: ${Object.entries(escalation).map(([m, e]) => `${m} (≥${e.threshold}) accuracy ${e.accuracy}%, detected ${e.detected}%, false alarms ${e.falseAlarms}%`).join(" · ")}\n\n`);
        continue;
      }
      for (const f of familyNames) {
        const summary = summarize(results, families[f], { current: o.current });
        report.runs.push({ variant: v, set, family: f, summary, results: lean });
        if (!o.json) stdout.write(`${formatSummary(`${v} · ${set} · ${f}`, summary)}\n\n`);
      }
    }
  }
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (o.json) stdout.write(text);
  if (o.out) writeFileSync(o.out, text);
  return 0;
}
