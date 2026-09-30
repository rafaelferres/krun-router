// Opt-in checks against the real Krun API: `npm run test:live` with KRUN_API_KEY set.
// Not part of `npm test`; skipped when no key is available. One /v1/decide call is made.
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../src/config.mjs";
import { TASK_KINDS, createKrunClient } from "../../src/krun-client.mjs";

const config = loadConfig();
const skip = config.apiKey ? false : "KRUN_API_KEY (or saved credentials) not configured";

test("live: the configured key authenticates against GET /v1/models", { skip }, async () => {
  const res = await fetch(`${config.apiUrl}/v1/models`, { headers: { authorization: `Bearer ${config.apiKey}` } });
  assert.equal(res.status, 200);
});

test("live: /v1/decide classifies a turn's task kind and rejection signal", { skip }, async () => {
  const r = await createKrunClient({ apiKey: config.apiKey, apiUrl: config.apiUrl, timeoutMs: 10000 }).decide(
    "Investigate a race condition between the queue consumer and the worker pool.",
  );
  assert.equal(r.ok, true, r.error);
  assert.ok(r.answer.kind in TASK_KINDS);
  assert.equal(typeof r.answer.confidence, "number");
  assert.equal(typeof r.answer.escalate, "number");
  console.log(`kind=${r.answer.kind} confidence=${r.answer.confidence.toFixed(2)} escalate=${r.answer.escalate.toFixed(2)} latency=${r.latencyMs}ms`);
});
