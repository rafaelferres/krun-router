import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/router.mjs";
import { applyPolicy } from "../src/policy.mjs";
import { partitionCompatible } from "../src/capabilities.mjs";
import { createSessionStore } from "../src/sessions.mjs";
import { buildDecideRequest, createKrunClient, parseAnswer, signalsLine, MAX_CONTEXT_CHARS, TASK_KINDS } from "../src/krun-client.mjs";
import { switchCostExceedsSaving } from "../src/policy.mjs";
import { tierOf } from "../src/catalog.mjs";
import { tier, fakeKrun, json, krunHandler, mockServer, model } from "./helpers.mjs";

const MODELS = [
  model("small-1", { reasoning: false }, { contextWindow: 200000, tier: "small" }),
  model("mid-2", { reasoning: true }, { tier: "medium" }),
  model("big-3", { reasoning: true, vision: true }, { tier: "large" }),
];

const turn = (over = {}) => ({
  conversationKey: "main",
  auto: true,
  requestedModel: "krun-router",
  prompt: "refactor the parser",
  turnId: "t1",
  skipRouting: false,
  baselineModel: "mid-2",
  availableModels: MODELS,
  requirements: { tools: true },
  context: { tokens: 1000 },
  ...over,
});

// ------------------------------------------------------------------ router.route

test("the classified task kind's tier picks the model", async () => {
  const krun = fakeKrun(() => tier("large"));
  const d = await createRouter({ krun }).route({ prompt: "p", currentModel: "mid-2", availableModels: MODELS });
  assert.equal(d.model, "big-3");
  assert.equal(d.reason, "krun: architecture → large");
  assert.deepEqual([d.fallback, d.kind, d.tier, d.confidence, d.mode], [false, "architecture", "large", 0.8, "balanced"]);
  assert.deepEqual(d.candidates, ["small-1", "mid-2", "big-3"]);
  assert.deepEqual(krun.calls, [{ prompt: "p" }], "Krun gets the prompt only, never the model list");
});

test("a follow-up with no task of its own keeps the current model", async () => {
  const d = await createRouter({ krun: fakeKrun(() => tier(null, { kind: "continuation" })) }).route({ prompt: "go ahead", currentModel: "mid-2", availableModels: MODELS });
  assert.deepEqual([d.model, d.fallback, d.reason], ["mid-2", true, "follow-up (continuation)"]);
});

test("low confidence keeps the current model in quality mode only", async () => {
  const low = () => tier("small", { confidence: 0.1 });
  const quality = await createRouter({ krun: fakeKrun(low), mode: "quality" }).route({ prompt: "p", currentModel: "big-3", availableModels: MODELS });
  assert.deepEqual([quality.model, quality.reason], ["big-3", "low confidence (small_edit)"]);
  const balanced = await createRouter({ krun: fakeKrun(low) }).route({ prompt: "p", currentModel: "big-3", availableModels: MODELS });
  assert.equal(balanced.model, "small-1");
});

test("an unknown task kind keeps the current model", async () => {
  const d = await createRouter({ krun: fakeKrun(() => tier(null, { kind: "retired-kind" })) }).route({ prompt: "p", currentModel: "mid-2", availableModels: MODELS });
  assert.deepEqual([d.model, d.fallback], ["mid-2", true]);
  assert.match(d.reason, /unknown task kind retired-kind/);
});

test("incompatible models are never offered and never chosen", async () => {
  const krun = fakeKrun(() => tier("small"));
  const router = createRouter({ krun });
  const d = await router.route({
    prompt: "look at this screenshot",
    currentModel: "small-1",
    availableModels: [model("small-1", { vision: false }, { tier: "small" }), ...MODELS.slice(1)],
    requirements: { vision: true },
  });
  assert.deepEqual(d.candidates, ["mid-2", "big-3"]);
  assert.equal(d.model, "mid-2", "nearest tier to small among the compatible ones");
  assert.deepEqual(d.rejected, [{ id: "small-1", reason: "no vision input" }]);
  assert.notEqual(d.model, "small-1");
});

test("fallback never lands on a model known to be incompatible", async () => {
  const router = createRouter({ krun: fakeKrun(() => null) });
  const d = await router.route({ prompt: "p", currentModel: "small-1", availableModels: MODELS, requirements: { contextTokens: 500000 } });
  assert.equal(d.fallback, true);
  assert.equal(d.model, "mid-2", "small-1 cannot hold 500k tokens");
});

test("candidate catalog is dynamic: each route sees exactly the models passed in", async () => {
  const router = createRouter({ krun: fakeKrun(() => tier("small")) });
  const a = await router.route({ prompt: "p", currentModel: "a", availableModels: [model("a"), model("b")] });
  const x = await router.route({ prompt: "p", currentModel: "x", availableModels: [model("x"), model("y"), model("z")] });
  assert.deepEqual([a.candidates, x.candidates], [["a", "b"], ["x", "y", "z"]]);
});

test("allowlist restricts candidates", async () => {
  const krun = fakeKrun(() => tier("large"));
  const d = await createRouter({ krun, allowlist: ["small-1", "mid-2"] }).route({ prompt: "p", currentModel: "mid-2", availableModels: MODELS });
  assert.deepEqual(d.candidates, ["small-1", "mid-2"]);
  assert.equal(d.model, "mid-2", "no large model allowed: the nearest tier runs");
});

test("a single compatible model is used without asking Krun", async () => {
  const krun = fakeKrun(() => tier("small"));
  const d = await createRouter({ krun }).route({ prompt: "p", currentModel: "a", availableModels: [model("a")] });
  assert.equal(krun.calls.length, 0);
  assert.equal(d.model, "a");
});

// ------------------------------------------------------------------ router.resolveTurn

test("a fresh turn routes once and tool-loop continuations stay pinned", async () => {
  const krun = fakeKrun(() => tier("large"));
  const router = createRouter({ krun });
  assert.equal((await router.resolveTurn(turn())).model, "big-3");
  for (let i = 0; i < 5; i++) {
    const r = await router.resolveTurn(turn({ prompt: null, turnId: null }));
    assert.equal(r.model, "big-3");
    assert.equal(r.decision, null);
  }
  assert.equal(krun.calls.length, 1);
});

test("the next fresh turn routes again", async () => {
  let pick = "large";
  const krun = fakeKrun(() => tier(pick));
  const router = createRouter({ krun });
  await router.resolveTurn(turn());
  pick = "small";
  const r = await router.resolveTurn(turn({ prompt: "rename a variable", turnId: "t2" }));
  assert.equal(r.model, "small-1");
  assert.equal(r.decision.currentModel, "big-3", "the previous turn's model is the current one");
  assert.equal(krun.calls.length, 2);
});

test("routing is called at most once per fresh turn, even for retries and concurrent duplicates", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const calls = [];
  const krun = {
    async decide(prompt) {
      calls.push(prompt);
      await gate;
      return { ok: true, request: {}, answer: tier("large"), latencyMs: 1 };
    },
  };
  const router = createRouter({ krun });
  const a = router.resolveTurn(turn());
  const b = router.resolveTurn(turn()); // same opening request, sent again while routing
  release();
  assert.deepEqual([(await a).model, (await b).model], ["big-3", "big-3"]);
  await router.resolveTurn(turn()); // retried after completion
  assert.equal(calls.length, 1);
});

test("main agent and sub-agent routing state do not leak", async () => {
  const krun = fakeKrun((p) => tier(p.includes("sub") ? "small" : "large"));
  const router = createRouter({ krun });
  await router.resolveTurn(turn({ conversationKey: "main", prompt: "main task" }));
  await router.resolveTurn(turn({ conversationKey: "sub-a", prompt: "sub task", turnId: "s1" }));
  assert.equal((await router.resolveTurn(turn({ conversationKey: "main", prompt: null }))).model, "big-3");
  assert.equal((await router.resolveTurn(turn({ conversationKey: "sub-a", prompt: null }))).model, "small-1");
  // a brand-new sub-agent starts from the baseline, not from the main agent's model
  const fresh = await createRouter({ krun: fakeKrun(() => null) }).resolveTurn(turn({ conversationKey: "sub-b", prompt: "x" }));
  assert.equal(fresh.model, "mid-2");
});

test("a concrete manual model bypasses Krun and always wins", async () => {
  const krun = fakeKrun(() => tier("large"));
  const manual = [];
  const router = createRouter({ krun, onManual: (m) => manual.push(m) });
  const r = await router.resolveTurn(turn({ auto: false, requestedModel: "small-1" }));
  assert.equal(r.model, "small-1");
  assert.equal(krun.calls.length, 0);
  assert.equal(manual[0].model, "small-1");
});

test("selecting Krun Router again resumes routing", async () => {
  const krun = fakeKrun(() => tier("large"));
  const router = createRouter({ krun });
  await router.resolveTurn(turn({ auto: false, requestedModel: "small-1", turnId: "t1" }));
  const r = await router.resolveTurn(turn({ prompt: "now route me", turnId: "t2" }));
  assert.equal(r.model, "big-3");
  assert.equal(krun.calls.length, 1);
});

test("explain requests and non-turn requests never route", async () => {
  const krun = fakeKrun(() => tier("large"));
  const router = createRouter({ krun });
  assert.equal((await router.resolveTurn(turn({ skipRouting: true }))).model, "mid-2");
  assert.equal((await router.resolveTurn(turn({ prompt: null }))).model, "mid-2");
  assert.equal(krun.calls.length, 0);
});

test("a throwing Krun client fails open to the current model", async () => {
  const router = createRouter({ krun: { decide: async () => { throw new Error("boom"); } } });
  assert.equal((await router.resolveTurn(turn())).model, "mid-2");
});

// ------------------------------------------------------------------ policy

test("policy is deterministic and total", () => {
  const candidates = MODELS;
  assert.deepEqual(applyPolicy({ answer: tier("large"), candidates, currentModel: "mid-2" }), { model: "big-3", reason: "krun: architecture → large", fallback: false, tier: "large" });
  assert.equal(applyPolicy({ answer: null, error: "timeout", candidates, currentModel: "mid-2" }).reason, "krun unavailable: timeout");
  assert.equal(applyPolicy({ answer: null, candidates: [], currentModel: null }).model, null);
  assert.equal(applyPolicy({ answer: null, candidates, rejected: [{ id: "x" }], currentModel: "x" }).model, "small-1");
  for (const [kind, [, t]] of Object.entries(TASK_KINDS)) {
    const d = applyPolicy({ answer: tier(null, { kind }), candidates, currentModel: "mid-2" });
    assert.equal(tierOf(MODELS.find((m) => m.id === d.model)), t ?? "medium", kind);
  }
});

test("modes shift tiers: economy takes medium work to small, quality takes small work to medium", () => {
  const at = (t, mode) => applyPolicy({ answer: tier(t), candidates: MODELS, currentModel: "mid-2", mode }).model;
  assert.deepEqual([at("small", "economy"), at("medium", "economy"), at("large", "economy")], ["small-1", "small-1", "big-3"]);
  assert.deepEqual([at("small", "quality"), at("medium", "quality"), at("large", "quality")], ["mid-2", "mid-2", "big-3"]);
});

test("a rejected previous attempt moves one tier above the current model", () => {
  const answer = (escalate) => tier("small", { escalate, kind: "bugfix" });
  const up = applyPolicy({ answer: answer(0.9), candidates: MODELS, currentModel: "mid-2" });
  assert.deepEqual([up.model, up.reason], ["big-3", "krun: bugfix, previous attempt rejected → large"]);
  assert.equal(applyPolicy({ answer: answer(0.5), candidates: MODELS, currentModel: "mid-2" }).model, "mid-2", "below the threshold: the kind's tier");
  assert.equal(applyPolicy({ answer: answer(0.85), candidates: MODELS, currentModel: "mid-2", mode: "economy" }).model, "small-1", "economy escalates only when very sure (and shifts medium work down)");
});

test("the cheapest model of a tier runs (quality: the priciest); a missing tier uses the nearest, larger first", () => {
  const claude = ["claude-haiku-4-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"].map((id) => model(id));
  const large = (mode) => applyPolicy({ answer: tier("large"), candidates: claude, currentModel: "claude-sonnet-5-5", mode }).model;
  assert.deepEqual([large("balanced"), large("quality")], ["claude-opus-5-5", "claude-fable-5-1"]);
  const noMedium = [model("s", {}, { tier: "small" }), model("l", {}, { tier: "large" })];
  assert.equal(applyPolicy({ answer: tier("medium"), candidates: noMedium, currentModel: "s" }).model, "l");
});

test("switching cost: no downgrade that rewrites a warm cache for less than it saves", () => {
  const [haiku, opus] = [model("claude-haiku-4-5"), model("claude-opus-5-5")];
  const warm = (tokens) => ({ tokens, turns: 5 });
  assert.equal(switchCostExceedsSaving(warm(150000), opus, haiku, "small"), true, "trivial turn on a large warm context: stay");
  assert.equal(switchCostExceedsSaving(warm(4000), opus, haiku, "small"), false, "small context: switch");
  assert.equal(switchCostExceedsSaving({ tokens: 150000, turns: 1 }, opus, haiku, "small"), false, "first turn: no warm cache");
  assert.equal(switchCostExceedsSaving(warm(150000), model("x"), model("y"), "small"), true, "unpriced and large: stay");
  const d = applyPolicy({ answer: tier("small"), candidates: [haiku, opus], currentModel: "claude-opus-5-5", context: warm(150000) });
  assert.deepEqual([d.model, d.fallback, d.reason], ["claude-opus-5-5", true, "switching cost (small_edit → small)"]);
  const upgrade = applyPolicy({ answer: tier("large"), candidates: [haiku, opus], currentModel: "claude-haiku-4-5", context: warm(150000) });
  assert.equal(upgrade.model, "claude-opus-5-5", "upgrades are never blocked");
});

// ------------------------------------------------------------------ capabilities

test("unknown capabilities never exclude a model; explicit false does", () => {
  const { compatible, rejected } = partitionCompatible(
    [model("unknown"), model("no-vision", { vision: false }), model("tiny", {}, { contextWindow: 1000 }), model("no-tools", { tools: false })],
    { vision: true, tools: true, contextTokens: 5000 },
  );
  assert.deepEqual(compatible.map((m) => m.id), ["unknown"]);
  assert.deepEqual(rejected.map((r) => r.id), ["no-vision", "tiny", "no-tools"]);
});

test("provider request features must be supported", () => {
  const { compatible } = partitionCompatible(
    [model("lite", { features: ["x-lite"] }), model("full", { features: [] }), model("unknown")],
    { features: ["x-lite"] },
  );
  assert.deepEqual(compatible.map((m) => m.id), ["lite", "unknown"]);
});

// ------------------------------------------------------------------ sessions

test("session state is bounded (least recently used evicted)", () => {
  const s = createSessionStore(3);
  for (const k of ["a", "b", "c"]) s.get(k).model = k;
  s.get("a"); // touch
  s.get("d");
  assert.equal(s.size, 3);
  assert.equal(s.get("a").model, "a");
  assert.equal(s.get("b").model, null, "b was least recently used and evicted");
});

// ------------------------------------------------------------------ krun client

test("decide request: task kind + escalation questions, prompt only, no model ids", () => {
  const req = buildDecideRequest("x".repeat(MAX_CONTEXT_CHARS + 50));
  assert.equal(req.context.length, MAX_CONTEXT_CHARS);
  assert.deepEqual(Object.keys(req.questions), ["kind", "escalate"]);
  assert.equal(req.questions.kind.type, "choice");
  assert.deepEqual(Object.keys(req.questions.kind.options), Object.keys(TASK_KINDS));
  assert.equal(req.questions.escalate.type, "noul");
  assert.equal(buildDecideRequest("p", { turns: 3, lastToolFailed: true }).context, "Conversation: turn 3 of the conversation; the last tool call failed.\n\np");
  assert.equal(signalsLine({ turns: 1 }), null);
});

test("parseAnswer: the most probable kind, escalation probability; malformed answers rejected", () => {
  const kind = (probabilities, extra = {}) => ({ answers: { kind: { type: "choice", choice: null, confidence: 0.5, probabilities, abstain: true, abstention_status: "advisory" }, ...extra } });
  assert.equal(parseAnswer(null), null);
  assert.equal(parseAnswer({ answers: { kind: { type: "noul", noul: 1 } } }), null);
  assert.equal(parseAnswer(kind({ nonsense: 1 })), null, "unknown kind");
  const a = parseAnswer(kind({ bugfix: 0.7, feature: 0.3 }, { escalate: { type: "noul", noul: 0.9 } }));
  assert.deepEqual([a.kind, a.confidence, a.escalate], ["bugfix", 0.5, 0.9]);
  assert.equal(parseAnswer(kind({ bugfix: 1 })).escalate, 0);
});

test("Krun client: valid response, sent with bearer auth to /v1/decide", async () => {
  const krun = await mockServer(krunHandler(() => "feature"));
  try {
    const r = await createKrunClient({ apiKey: "krun_test_k", apiUrl: krun.url }).decide("hello");
    assert.equal(r.ok, true);
    assert.equal(r.answer.kind, "feature");
    assert.equal(r.requestId, "req_test");
    assert.equal(krun.requests[0].url, "/v1/decide");
    assert.equal(krun.requests[0].headers.authorization, "Bearer krun_test_k");
    assert.deepEqual(Object.keys(krun.requests[0].body), ["context", "questions"]);
  } finally {
    await krun.close();
  }
});

test("Krun timeout fails open within the deadline", async () => {
  const krun = await mockServer((_req, res) => setTimeout(() => json(res, 200, {}), 1000));
  try {
    const started = Date.now();
    const client = createKrunClient({ apiKey: "k", apiUrl: krun.url, timeoutMs: 100 });
    const d = await createRouter({ krun: client }).route({ prompt: "p", currentModel: "mid-2", availableModels: MODELS });
    assert.ok(Date.now() - started < 800, "did not wait for the slow server");
    assert.equal(d.model, "mid-2");
    assert.match(d.krun.error, /timeout after 100ms/);
  } finally {
    await krun.close();
  }
});

test("missing API key fails open without any network call", async () => {
  const krun = await mockServer((_req, res) => json(res, 500, {}));
  try {
    const d = await createRouter({ krun: createKrunClient({ apiKey: null, apiUrl: krun.url }) }).route({ prompt: "p", currentModel: "mid-2", availableModels: MODELS });
    assert.equal(d.model, "mid-2");
    assert.match(d.reason, /missing KRUN_API_KEY/);
    assert.equal(krun.requests.length, 0);
  } finally {
    await krun.close();
  }
});

test("invalid or error responses fail open", async () => {
  for (const [status, body] of [[200, { answers: {} }], [200, "not json"], [401, { error: { code: "UNAUTHORIZED", message: "no" } }], [503, {}]]) {
    const krun = await mockServer((_req, res) => (typeof body === "string" ? res.writeHead(status).end(body) : json(res, status, body)));
    try {
      const d = await createRouter({ krun: createKrunClient({ apiKey: "k", apiUrl: krun.url }) }).route({ prompt: "p", currentModel: "mid-2", availableModels: MODELS });
      assert.equal(d.model, "mid-2");
      assert.equal(d.fallback, true);
    } finally {
      await krun.close();
    }
  }
});

test("network errors fail open", async () => {
  const d = await createRouter({ krun: createKrunClient({ apiKey: "k", apiUrl: "http://127.0.0.1:1" }) }).route({ prompt: "p", currentModel: "mid-2", availableModels: MODELS });
  assert.equal(d.model, "mid-2");
  assert.match(d.krun.error, /network error|timeout/);
});
