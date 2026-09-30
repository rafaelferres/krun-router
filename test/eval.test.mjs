import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VARIANTS, classify, evalCommand, loadEval, summarize, summarizeEscalation } from "../src/cli/eval-command.mjs";
import { TASK_KINDS } from "../src/krun-client.mjs";
import { json, mockServer } from "./helpers.mjs";

const FAMILY = {
  cost: { small: 1, medium: 3, large: 5 },
  models: [
    { tier: "large", id: "big", displayName: "Big", capabilities: { tools: true } },
    { tier: "medium", id: "mid", displayName: "Mid", capabilities: { tools: true } },
    { tier: "small", id: "tiny", displayName: "Tiny", capabilities: { tools: true } },
  ],
};

const sink = () => ({ text: "", write(s) { this.text += s; } });

/** Krun mock: "hard" → architecture, "?" → a low-confidence question, "wrong" → rejection, else a small edit. */
const krunMock = () =>
  mockServer((req, res) => {
    const ctx = req.body.context;
    const kind = ctx.includes("hard") ? "architecture" : ctx.includes("?") ? "question" : "small_edit";
    json(res, 200, {
      answers: {
        kind: { type: "choice", choice: null, confidence: ctx.includes("?") ? 0.04 : 0.8, probabilities: { [kind]: 0.9 }, abstain: true, abstention_status: "advisory" },
        escalate: { type: "noul", noul: ctx.includes("wrong") ? 0.85 : 0.1 },
      },
    });
  });

function dataset(files) {
  const dir = mkdtempSync(join(tmpdir(), "krun-eval-"));
  for (const [name, cases] of Object.entries(files)) writeFileSync(join(dir, `${name}.jsonl`), cases.map((c) => JSON.stringify(c)).join("\n"));
  writeFileSync(join(dir, "families.json"), JSON.stringify({ _note: "x", test: FAMILY }));
  return dir;
}

test("eval: the shipped datasets are well formed", () => {
  const { sets, families } = loadEval();
  assert.ok(sets.routing.length >= 50 && sets.holdout.length >= 10 && sets.escalation.length >= 10);
  const all = [...sets.routing, ...sets.holdout, ...sets.escalation];
  assert.equal(new Set(all.map((c) => c.id)).size, all.length, "unique ids");
  for (const c of [...sets.routing, ...sets.holdout]) {
    assert.ok(c.prompt && c.accept.length, c.id);
    for (const t of c.accept) assert.ok(["small", "medium", "large"].includes(t), c.id);
  }
  for (const c of sets.escalation) assert.equal(typeof c.rejects, "boolean", c.id);
  for (const [name, f] of Object.entries(families)) {
    for (const tier of ["small", "medium", "large"]) assert.ok(f.models.some((m) => m.tier === tier), `${name} has a ${tier} model`);
    for (const tier of ["small", "medium", "large"]) assert.ok(f.cost[tier] > 0, `${name} costs ${tier}`);
  }
});

test("eval: the production policy is scored offline per mode and confidence floor", () => {
  const r = (accept, kind, confidence = 0.8) => ({ case: { accept }, ok: true, latencyMs: 10, answer: { kind, confidence, escalate: 0, probabilities: {} } });
  const results = [
    r(["small"], "small_edit"), // right
    r(["small"], "architecture"), // waste
    r(["large"], "small_edit"), // risk
    r(["small"], "question", 0.04), // low confidence: kept on large below a floor
    { case: { accept: ["large"] }, ok: false, error: "timeout after 15000ms", latencyMs: 15000, answer: null }, // fails open to current
  ];
  const s = summarize(results, FAMILY, { current: "large" });
  assert.deepEqual([s.errors, s.timeouts], [1, 1]);
  assert.equal(s.policies["krun balanced"].accuracy, 60); // right + low-confidence question + timeout→large
  assert.equal(s.policies["krun balanced"].waste, 20);
  assert.equal(s.policies["krun balanced"].risk, 20);
  assert.equal(s.policies["balanced, floor 0.05"].accuracy, 40, "0.04 < 0.05 keeps the large model for a small question");
  assert.equal(s.policies["krun economy"].accuracy, 60);
  assert.equal(s.policies["krun quality"].accuracy, 20, "quality lifts small work to medium; the floor keeps large");
  assert.equal(s.policies["always large"].relativeCost, 100);
});

test("eval: escalation detection per mode threshold", () => {
  const r = (rejects, escalate) => ({ case: { rejects }, ok: true, answer: { escalate } });
  const e = summarizeEscalation([r(true, 0.85), r(true, 0.5), r(false, 0.75), r(false, 0.1)]);
  assert.deepEqual(e.balanced, { threshold: 0.8, accuracy: 75, detected: 50, falseAlarms: 0 });
  assert.deepEqual(e.quality, { threshold: 0.7, accuracy: 50, detected: 50, falseAlarms: 50 });
});

test("eval: classification is sent once per case; the signals variant adds conversation facts", async () => {
  const krun = await krunMock();
  try {
    const c = { id: "a", prompt: "rename x", accept: ["small"], context: { turns: 4, lastToolFailed: true } };
    const [plain] = await classify({ cases: [c], variant: VARIANTS.kinds, apiKey: "k", apiUrl: krun.url });
    await classify({ cases: [c], variant: VARIANTS["kinds+signals"], apiKey: "k", apiUrl: krun.url });
    assert.equal(plain.answer.kind, "small_edit");
    assert.equal(krun.requests[0].body.context, "rename x");
    assert.match(krun.requests[1].body.context, /^Conversation: turn 4 of the conversation; the last tool call failed\./);
    assert.deepEqual(Object.keys(krun.requests[0].body.questions.kind.options), Object.keys(TASK_KINDS));
  } finally {
    await krun.close();
  }
});

test("eval: rate-limited calls are retried with backoff (eval only)", async () => {
  let n = 0;
  const krun = await mockServer((req, res) => {
    if (n++ < 2) return json(res, 429, { error: { code: "RATE_LIMITED" } });
    json(res, 200, { answers: { kind: { type: "choice", confidence: 0.8, probabilities: { bugfix: 0.9 }, abstain: true } } });
  });
  try {
    const [r] = await classify({ cases: [{ id: "a", prompt: "x", accept: ["medium"] }], variant: VARIANTS.kinds, apiKey: "k", apiUrl: krun.url, backoffMs: 1 });
    assert.deepEqual([r.ok, r.retries, r.answer.kind], [true, 2, "bugfix"]);
  } finally {
    await krun.close();
  }
});

test("eval command: call budget guard, report file, no key", async () => {
  const krun = await krunMock();
  const dir = dataset({
    routing: [
      { id: "1", prompt: "fix typo", accept: ["small"] },
      { id: "2", prompt: "hard race condition", accept: ["large"] },
      { id: "3", prompt: "which port?", accept: ["small"] },
    ],
    escalation: [
      { id: "e1", prompt: "that's wrong", rejects: true },
      { id: "e2", prompt: "thanks", rejects: false },
    ],
  });
  const ctx = (apiKey = "k") => ({ config: { apiKey, apiUrl: krun.url }, stdout: sink(), stderr: sink() });
  try {
    const noKey = ctx(null);
    assert.equal(await evalCommand([], noKey, { dir }), 1);
    assert.match(noKey.stderr.text, /no Krun API key/);

    const out = join(dir, "report.json");
    const c = ctx();
    assert.equal(await evalCommand(["--out", out], c, { dir }), 0);
    assert.match(c.stderr.text, /5 \/v1\/decide calls/);
    assert.match(c.stdout.text, /kinds · routing · test: 3 cases, 0 errors/);
    assert.match(c.stdout.text, /balanced \(≥0\.8\) accuracy 100%/);
    const report = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(report.runs[0].summary.policies["krun balanced"].accuracy, 100);
    assert.equal(krun.requests.length, 5);

    const big = dataset({ routing: Array.from({ length: 101 }, (_, i) => ({ id: String(i), prompt: "x", accept: ["small"] })) });
    const guarded = ctx();
    assert.equal(await evalCommand([], guarded, { dir: big }), 1);
    assert.match(guarded.stderr.text, /pass --yes/);
    assert.equal(krun.requests.length, 5, "nothing sent without --yes");
    assert.equal(await evalCommand(["--variant", "nope"], ctx(), { dir }), 2);
    assert.equal(await evalCommand(["--set", "nope"], ctx(), { dir }), 2);
  } finally {
    await krun.close();
  }
});
