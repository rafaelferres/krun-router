import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import { startProxy, usageOf } from "../src/proxy.mjs";
import { createHistory } from "../src/status.mjs";
import { computeStats, formatStats, priceFor, readLedger } from "../src/stats.mjs";
import { statsCommand } from "../src/cli/stats-command.mjs";
import { mockServer } from "./helpers.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "krun-stats-"));
const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

test("usageOf normalizes Anthropic, OpenAI Responses and chat completions (input excludes cache)", () => {
  assert.deepEqual(usageOf({ type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 500, cache_creation_input_tokens: 40, output_tokens: 1 } } }), {
    input: 10, output: 1, cacheRead: 500, cacheWrite: 40,
  });
  assert.deepEqual(usageOf({ type: "response.completed", response: { usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 800 }, output_tokens: 50 } } }), {
    input: 200, output: 50, cacheRead: 800, cacheWrite: 0,
  });
  assert.deepEqual(usageOf({ choices: [{ delta: {}, usage: { prompt_tokens: 300, completion_tokens: 20, cached_tokens: 100 } }] }), {
    input: 200, output: 20, cacheRead: 100, cacheWrite: 0,
  });
  assert.equal(usageOf({ type: "response.created", response: { usage: null } }), null);
  assert.equal(usageOf({ type: "ping" }), null);
});

/** Proxy with an adapter that only attaches onUsage; returns what the client and the tap saw. */
async function throughProxy(respond) {
  const upstream = await mockServer((_req, res) => respond(res));
  const seen = [];
  const proxy = await startProxy({
    upstreamFor: () => upstream.url,
    wantsBody: () => true,
    transformRequest: () => ({ onUsage: (u) => seen.push(u) }),
  });
  const body = await new Promise((resolve, reject) => {
    const req = http.request(`${proxy.url}/v1/messages`, { method: "POST" }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.end("{}");
  });
  await new Promise((r) => setTimeout(r, 20)); // the tap reports on the upstream 'end'
  await proxy.close();
  await upstream.close();
  return { body, seen };
}

test("proxy: usage is read from a gzipped Anthropic stream without altering what the client gets", async () => {
  const text = sse([
    { type: "message_start", message: { usage: { input_tokens: 12, cache_read_input_tokens: 900, cache_creation_input_tokens: 30, output_tokens: 1 } } },
    { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
    { type: "message_delta", usage: { output_tokens: 77 } },
    { type: "message_stop" },
  ]);
  const gz = zlib.gzipSync(text);
  const r = await throughProxy((res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "gzip" });
    // split mid-event so the line buffer is exercised
    res.write(gz.subarray(0, 20));
    setTimeout(() => res.end(gz.subarray(20)), 5);
  });
  assert.deepEqual(r.body, gz, "bytes reach the client unchanged");
  assert.deepEqual(r.seen, [{ input: 12, output: 77, cacheRead: 900, cacheWrite: 30 }]);
});

test("proxy: usage from an OpenAI Responses stream and from a plain JSON body; none on errors", async () => {
  const responses = await throughProxy((res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse([{ type: "response.created", response: { usage: null } }, { type: "response.completed", response: { usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 60 }, output_tokens: 9 } } }]));
  });
  assert.deepEqual(responses.seen, [{ input: 40, output: 9, cacheRead: 60, cacheWrite: 0 }]);

  const chat = await throughProxy((res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 2 } })));
  assert.deepEqual(chat.seen, [{ input: 5, output: 2, cacheRead: 0, cacheWrite: 0 }]);

  const failed = await throughProxy((res) => res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ usage: { prompt_tokens: 5 } })));
  assert.deepEqual(failed.seen, []);
});

test("ledger: decisions and usage are appended without prompts; usage is summed into the decision", async () => {
  const dir = tmp();
  const ledger = join(dir, "cfg", "usage.jsonl");
  const h = createHistory({ sessionId: "s1", cli: "claude", dir, ledger });
  h.record({ at: 1, prompt: "SECRET PROMPT", conversation: "c1", model: "m-small", currentModel: "m-big", reason: "krun", fallback: false, confidence: 0.8, krun: { latencyMs: 300, error: null } });
  h.recordUsage({ conversation: "c1", model: "m-small", input: 10, output: 5, cacheRead: 100, cacheWrite: 0 });
  h.recordUsage({ conversation: "c1", model: "m-small", input: 1, output: 1 });
  h.recordManual({ at: 2, model: "m-big", conversation: "c2" });
  await h.flush();
  const text = readFileSync(ledger, "utf8");
  assert.ok(!text.includes("SECRET PROMPT"), "no prompt in the ledger");
  const events = readLedger(ledger);
  assert.deepEqual(events.map((e) => e.type), ["decision", "usage", "usage", "manual"]);
  assert.equal(events[0].previous, "m-big");
  assert.equal(events[0].latencyMs, 300);
  assert.deepEqual(h.data.decisions[0].usage, { requests: 2, input: 11, output: 6, cacheRead: 100, cacheWrite: 0 });
  assert.equal(readLedger(ledger, { cli: "codex" }).length, 0);
  assert.equal(readLedger(ledger, { days: 1, now: Date.now() + 5 * 86_400_000 }).length, 0, "old events are filtered by --days");
});

test("stats: outcomes, latency, and savings priced against each conversation's starting model", () => {
  const prices = { big: [10, 50, 1, 12.5], small: [1, 5, 0.1, 1.25] };
  const d = (conversation, previous, model, reason, latencyMs = 100) => ({ type: "decision", at: 1, conversation, previous, model, reason, latencyMs });
  const events = [
    d("c1", "big", "small", "krun"),
    d("c1", "small", "small", "krun", 200),
    d("c2", "big", "big", "krun abstained", 300),
    d("c3", "big", "big", "krun unavailable: timeout after 5000ms", 5000),
    d("c4", "big", "big", "only one compatible model", null),
    { type: "manual", at: 1, conversation: "c5", model: "big" },
    // c1 switched to small: its cache write is priced as a cache read on big
    { type: "usage", conversation: "c1", model: "small", input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 1_000_000 },
    { type: "usage", conversation: "c2", model: "big", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
    { type: "usage", conversation: "c9", model: "mystery", input: 5, output: 5, cacheRead: 0, cacheWrite: 0 },
    { type: "usage", conversation: "c5", model: "anything", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.5 },
  ];
  const s = computeStats(events, prices);
  assert.deepEqual(s.turns, {
    "routed: switched": 1,
    "routed: same model": 1,
    "kept: low confidence": 1,
    "kept: timeout": 1,
    "only one model": 1,
    "manual model": 1,
  });
  assert.equal(s.krun.calls, 4);
  assert.equal(s.krun.p50, 300);
  assert.equal(s.krun.p95, 5000);
  assert.equal(s.krun.timeoutRate, 0.25);
  // small: 1M*1 + 0.1M*5 + 1M*1.25 = 2.75; big baseline: 1M*10 + 0.1M*50 + 1M*1 (read) = 16
  // c2 on big: 10 both ways; c5 reported cost 0.5 both ways (baseline = itself)
  assert.equal(Math.round(s.cost.actual * 100) / 100, 13.25);
  assert.equal(Math.round(s.cost.baseline * 100) / 100, 26.5);
  assert.equal(Math.round(s.cost.savings * 100) / 100, 13.25);
  assert.equal(s.cost.unpriced, 1);
  assert.equal(s.models.mystery.priced, false);
  const text = formatStats(s, { days: 7 });
  for (const t of ["last 7 days", "routed: switched", "p95 5000 ms", "no price", "saved $13.25"]) assert.ok(text.includes(t), t);
});

test("stats: prices match dated ids by prefix; statsCommand reads the ledger and prices.json", async () => {
  assert.deepEqual(priceFor("claude-haiku-4-5-20251001"), priceFor("claude-haiku-4-5"));
  assert.equal(priceFor("gpt-6-sol"), null);
  const dir = tmp();
  writeFileSync(join(dir, "usage.jsonl"), `${JSON.stringify({ type: "usage", at: Date.now(), cli: "codex", model: "gpt-6-sol", conversation: "x", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })}\n{torn`);
  writeFileSync(join(dir, "prices.json"), JSON.stringify({ "gpt-6-sol": [2, 8, 0.2, 2] }));
  let out = "";
  const code = await statsCommand(["--json", "--cli", "codex"], { config: { paths: { dir } }, stdout: { write: (s) => (out += s) }, stderr: { write() {} } });
  assert.equal(code, 0);
  assert.equal(JSON.parse(out).models["gpt-6-sol"].cost, 2);
  let err = "";
  assert.equal(await statsCommand(["--days", "x"], { config: { paths: { dir } }, stdout: { write() {} }, stderr: { write: (s) => (err += s) } }), 1);
  assert.match(err, /whole number/);
});

test("claude adapter: usage is tagged with the routed model and conversation; count_tokens is not spend", async () => {
  const { createClaudeAdapter, AUTO_MODEL } = await import("../src/adapters/claude.mjs");
  const { createRouter } = await import("../src/router.mjs");
  const { fakeKrun, model, tier } = await import("./helpers.mjs");
  const catalog = [model("big", {}, { tier: "large" }), model("small", {}, { tier: "small" })];
  const router = createRouter({ krun: fakeKrun(() => tier("small")) });
  const seen = [];
  const adapter = createClaudeAdapter({ router, preferredModel: "big", loadCatalog: async () => catalog, loadContextWindows: async () => new Map(), onUsage: (u) => seen.push(u) });
  const body = { model: AUTO_MODEL, tools: [{ name: "Bash", input_schema: { type: "object" } }], messages: [{ role: "user", content: "hi" }] };
  const plan = await adapter.transformRequest({ url: "/v1/messages", headers: {} }, Buffer.from(JSON.stringify(body)));
  plan.onUsage({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
  assert.equal(seen[0].model, "small");
  assert.ok(seen[0].conversation);
  const count = await adapter.transformRequest({ url: "/v1/messages/count_tokens", headers: {} }, Buffer.from(JSON.stringify(body)));
  assert.equal(count.onUsage, undefined);
  const manual = await adapter.transformRequest({ url: "/v1/messages", headers: {} }, Buffer.from(JSON.stringify({ ...body, model: "big" })));
  manual.onUsage({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 });
  assert.equal(seen[1].model, "big", "manual turns are measured too");
});
