import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTO_MODEL,
  addAutoModel,
  codexLaunch,
  configuredModel,
  conversationKey,
  createCodexAdapter,
  freshPrompt,
  modelsFromCodexCatalog,
  normalizeForModel,
  parseRequest,
  removeAutoFromCache,
  topLevelTomlString,
  usesOtherProvider,
} from "../src/adapters/codex.mjs";
import { createRouter } from "../src/router.mjs";
import { createKrunClient } from "../src/krun-client.mjs";
import { startProxy } from "../src/proxy.mjs";
import { KIND, json, krunHandler, mockServer } from "./helpers.mjs";

// Shaped like Codex's /models response and ~/.codex/models_cache.json (trimmed).
const level = (effort) => ({ effort, description: effort });
const CATALOG = {
  models: [
    { slug: "gpt-big", display_name: "Big", description: "Hardest work", visibility: "list", supported_in_api: true, priority: 1, context_window: 272000, input_modalities: ["text", "image"], use_responses_lite: true, default_reasoning_level: "medium", supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max"].map(level) },
    { slug: "gpt-small", display_name: "Small", visibility: "list", supported_in_api: true, priority: 3, context_window: 272000, input_modalities: ["text"], use_responses_lite: true, default_reasoning_level: "low", supported_reasoning_levels: ["low", "medium", "high"].map(level) },
    { slug: "gpt-classic", display_name: "Classic", visibility: "list", supported_in_api: true, priority: 4, context_window: 272000, input_modalities: ["text", "image"], use_responses_lite: false, default_reasoning_level: "medium", supported_reasoning_levels: ["low", "medium"].map(level) },
    { slug: "gpt-hidden", visibility: "hide", supported_in_api: true, priority: 2 },
  ],
};
const MODELS = modelsFromCodexCatalog(CATALOG);

const TOOLS_ITEM = { type: "additional_tools", role: "developer", tools: [{ type: "function", name: "exec" }] };
const META = (turn) => ({ "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread-main", turn_id: turn, agent_name: "/root" }) });
const userTurn = (text, turn = "turn-1", extra = {}) => ({
  model: AUTO_MODEL,
  stream: true,
  reasoning: { effort: "xhigh" },
  prompt_cache_key: "thread-main",
  client_metadata: META(turn),
  input: [
    TOOLS_ITEM,
    { type: "message", role: "developer", content: [{ type: "input_text", text: "You are Codex" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text }] },
  ],
  ...extra,
});
const withToolOutput = (body) => ({
  ...body,
  input: [...body.input, { type: "custom_tool_call", name: "exec", call_id: "c1" }, { type: "custom_tool_call_output", call_id: "c1", output: "ok" }],
});

// ------------------------------------------------------------------ parsing

test("codex: catalog is dynamic and exact, hidden models excluded", () => {
  assert.deepEqual(MODELS.map((m) => m.id), ["gpt-big", "gpt-small", "gpt-classic"]);
  assert.equal(MODELS[1].capabilities.vision, false);
  assert.equal(MODELS[0].contextWindow, 272000);
  assert.deepEqual(MODELS[2].capabilities.features, []);
  assert.deepEqual(modelsFromCodexCatalog({ models: [] }), []);
});

test("codex: detects a fresh user turn (tools as an additional_tools item)", () => {
  assert.equal(freshPrompt(userTurn("add a test")), "add a test");
  assert.equal(freshPrompt({ input: userTurn("x").input.slice(1) }), null, "no tools: auxiliary request");
});

test("codex: tool outputs are continuations, not new turns", () => {
  assert.equal(freshPrompt(withToolOutput(userTurn("add a test"))), null);
});

test("codex: title generation and explain are not routed", () => {
  assert.equal(freshPrompt(userTurn("Generate a concise, single-line task title for this")), null);
  assert.equal(parseRequest(userTurn("$krun-explain")).skipRouting, true);
});

test("codex: conversation and turn ids come from Codex turn metadata", () => {
  const t = parseRequest(userTurn("x", "turn-9"));
  assert.equal(t.turnId, "turn-9");
  const sub = userTurn("x", "turn-1", { client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread-sub", turn_id: "t" }) } });
  assert.notEqual(conversationKey(userTurn("x")), conversationKey(sub), "sub-agent thread has its own state");
  assert.equal(conversationKey(userTurn("x")), conversationKey(withToolOutput(userTurn("x"))));
});

test("codex: responses-lite requests only offer lite-capable models", () => {
  const t = parseRequest(userTurn("x"), 100, { "x-openai-internal-codex-responses-lite": "1" });
  assert.deepEqual(t.requirements.features, ["codex-responses-lite"]);
  assert.deepEqual(parseRequest(userTurn("x"), 100, {}).requirements.features, []);
});

// ------------------------------------------------------------------ normalization

test("codex: unsupported reasoning effort becomes the nearest supported lower level", () => {
  const raw = CATALOG.models[1];
  assert.equal(normalizeForModel(userTurn("x"), "gpt-small", raw).reasoning.effort, "high");
  assert.equal(normalizeForModel(userTurn("x", "t", { reasoning: { effort: "medium" } }), "gpt-small", raw).reasoning.effort, "medium");
  assert.equal(normalizeForModel(userTurn("x", "t", { reasoning: { effort: "minimal" } }), "gpt-small", raw).reasoning.effort, "low", "no lower level: model default");
  assert.equal(normalizeForModel(userTurn("x"), "gpt-big", CATALOG.models[0]).reasoning.effort, "xhigh");
});

test("codex: injected status messages are removed before forwarding", () => {
  const body = userTurn("x");
  body.input.splice(3, 0, { type: "message", role: "assistant", content: [{ type: "output_text", text: "[Krun] → gpt-big (0.90)" }] });
  normalizeForModel(body, "gpt-big", CATALOG.models[0]);
  assert.ok(!JSON.stringify(body.input).includes("[Krun]"));
});

test("codex: Krun Router row is added to the picker, cloned from the baseline model", () => {
  const catalog = addAutoModel(structuredClone(CATALOG), "gpt-small");
  const row = catalog.models[0];
  assert.equal(row.slug, AUTO_MODEL);
  assert.equal(row.display_name, "Krun Router");
  assert.equal(row.default_reasoning_level, "low", "cloned from gpt-small");
  assert.ok(row.priority < 1);
  assert.equal(addAutoModel(catalog, "gpt-small").models.filter((m) => m.slug === AUTO_MODEL).length, 1);
});

test("codex: the Krun Router row is removed from Codex's model cache on exit", () => {
  const home = mkdtempSync(join(tmpdir(), "krun-codex-home-"));
  writeFileSync(join(home, "models_cache.json"), JSON.stringify(addAutoModel(structuredClone(CATALOG), "gpt-big")));
  assert.equal(removeAutoFromCache(home), true);
  assert.ok(!readFileSync(join(home, "models_cache.json"), "utf8").includes(AUTO_MODEL));
  assert.equal(removeAutoFromCache(home), false);
});

// ------------------------------------------------------------------ launch

test("codex: user arguments are forwarded verbatim after temporary provider overrides", () => {
  const userArgs = ["exec", "--skip-git-repo-check", "fix it & \"quote\" it", "resume", "--last"];
  const args = codexLaunch({ userArgs, proxyUrl: "http://127.0.0.1:9" });
  assert.deepEqual(args.slice(-userArgs.length), userArgs);
  assert.ok(args.includes('model_providers.krun.base_url="http://127.0.0.1:9"'));
  assert.ok(args.includes(`model="${AUTO_MODEL}"`));
  assert.ok(!codexLaunch({ userArgs: ["-m", "gpt-big"], proxyUrl: "u" }).includes(`model="${AUTO_MODEL}"`), "explicit model wins");
  assert.ok(!codexLaunch({ userArgs: ["-c", 'model="gpt-big"'], proxyUrl: "u" }).includes(`model="${AUTO_MODEL}"`));
});

test("codex: configured model and provider are read from args and config.toml", () => {
  const home = mkdtempSync(join(tmpdir(), "krun-codex-home-"));
  writeFileSync(join(home, "config.toml"), 'model = "gpt-small"\nmodel_provider = "azure"\n[profiles.x]\nmodel = "other"\n');
  assert.equal(configuredModel([], home), "gpt-small");
  assert.equal(configuredModel(["--model", "gpt-big"], home), "gpt-big");
  assert.equal(usesOtherProvider([], home), true);
  assert.equal(usesOtherProvider(["-c", 'model_provider="openai"'], home), false);
  assert.equal(usesOtherProvider(["--oss"], mkdtempSync(join(tmpdir(), "e-"))), true);
  assert.equal(topLevelTomlString('[a]\nmodel = "x"', "model"), undefined);
});

// ------------------------------------------------------------------ proxy integration

const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

async function harness({ pick = () => KIND.small, showStatus = true } = {}) {
  const upstream = await mockServer((req, res) => {
    if (req.method === "GET") return json(res, 200, structuredClone(CATALOG), { etag: "abc" });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse([{ type: "response.created", response: { model: req.body.model } }, { type: "response.completed", response: { model: req.body.model } }]));
  });
  const krun = await mockServer(krunHandler(pick));
  const router = createRouter({ krun: createKrunClient({ apiKey: "k", apiUrl: krun.url, timeoutMs: 500 }) });
  const adapter = createCodexAdapter({ router, chatgptUpstream: upstream.url, apiUpstream: upstream.url, loadCatalog: async () => CATALOG, showStatus });
  const proxy = await startProxy(adapter);
  const send = (body, headers = {}) =>
    fetch(`${proxy.url}/responses`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }).then((r) => r.text());
  return { upstream, krun, proxy, send, close: () => Promise.all([proxy.close(), upstream.close(), krun.close()]) };
}

test("codex proxy: routes once, pins through tool outputs, shows status once", async () => {
  const h = await harness({ pick: () => KIND.small });
  try {
    const first = await h.send(userTurn("rename a file"), { "chatgpt-account-id": "acct" });
    assert.match(first, /\[Krun\] → gpt-small \(0\.80\)/);
    assert.ok(first.indexOf("response.created") < first.indexOf("[Krun]"), "status follows the first event");
    const next = await h.send(withToolOutput(userTurn("rename a file")), { "chatgpt-account-id": "acct" });
    assert.ok(!next.includes("[Krun]"), "no status on continuations");
    assert.deepEqual(h.upstream.requests.map((r) => r.body.model), ["gpt-small", "gpt-small"]);
    assert.equal(h.upstream.requests[0].body.reasoning.effort, "high", "xhigh normalized for gpt-small");
    assert.equal(h.krun.requests.length, 1);
  } finally {
    await h.close();
  }
});

test("codex proxy: auth headers pass through untouched", async () => {
  const h = await harness();
  try {
    const auth = { authorization: "Bearer eyJhbGciOi.SECRET.sig", "chatgpt-account-id": "acct-123", "openai-beta": "responses=experimental" };
    await h.send(userTurn("x"), auth);
    for (const [k, v] of Object.entries(auth)) assert.equal(h.upstream.requests[0].headers[k], v);
    assert.ok(!JSON.stringify(h.krun.requests).includes("SECRET"));
  } finally {
    await h.close();
  }
});

test("codex proxy: a concrete model passes through unchanged and bypasses Krun", async () => {
  const h = await harness();
  try {
    const body = { ...userTurn("x"), model: "gpt-big" };
    await h.send(body);
    assert.equal(h.krun.requests.length, 0);
    assert.deepEqual(h.upstream.requests[0].body, body);
  } finally {
    await h.close();
  }
});

test("codex proxy: /models gets the Krun Router row and a full (non-304) response", async () => {
  const h = await harness();
  try {
    const catalog = await fetch(`${h.proxy.url}/models?client_version=1`, { headers: { "if-none-match": "abc" } }).then((r) => r.json());
    assert.equal(catalog.models[0].slug, AUTO_MODEL);
    assert.equal(h.upstream.requests[0].headers["if-none-match"], undefined);
  } finally {
    await h.close();
  }
});

test("codex proxy: lite requests never route to a non-lite model", async () => {
  const h = await harness({ pick: () => KIND.medium }); // gpt-classic is the only medium model, but not lite
  try {
    await h.send(userTurn("x"), { "x-openai-internal-codex-responses-lite": "true" });
    assert.notEqual(h.upstream.requests[0].body.model, "gpt-classic");
  } finally {
    await h.close();
  }
});
