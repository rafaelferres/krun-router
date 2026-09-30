import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync as mkdirP, mkdtempSync as mkdtempP, writeFileSync as writeP } from "node:fs";
import { tmpdir as tmpdirP } from "node:os";
import { join as joinP } from "node:path";
import { statuslineHint } from "../src/cli/kimi-command.mjs";
import { createHistory as createHistoryP } from "../src/status.mjs";
import {
  AUTO_MODEL,
  createKimiAdapter,
  fetchKimiModels,
  freshPrompt,
  kimiCredentials,
  kimiLaunchEnv,
  modelsFromKimiList,
  normalizeForModel,
  parseRequest,
} from "../src/adapters/kimi.mjs";
import { createRouter } from "../src/router.mjs";
import { createKrunClient } from "../src/krun-client.mjs";
import { startProxy } from "../src/proxy.mjs";
import { KIND, json, krunHandler, mockServer } from "./helpers.mjs";

const LIST = {
  data: [
    { id: "kimi-k2.5", context_length: 262144, supports_reasoning: true, supports_image_in: true },
    { id: "kimi-k2-turbo", context_length: 131072, supports_thinking_type: "no" },
    { id: "kimi-k2-thinking", context_length: 262144, supports_thinking_type: "only" },
    { id: "kimi-anthropic-only", protocol: "anthropic" },
  ],
};
const TOOLS = [{ type: "function", function: { name: "Shell", parameters: {} } }];
const userTurn = (text) => ({ model: AUTO_MODEL, tools: TOOLS, stream: true, messages: [{ role: "system", content: "sys" }, { role: "user", content: text }] });
const withToolCall = (body) => ({
  ...body,
  messages: [...body.messages, { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "Shell", arguments: "{}" } }] }, { role: "tool", tool_call_id: "c1", content: "ok" }],
});

test("kimi: catalog keeps chat models with exact ids and capabilities", () => {
  const models = modelsFromKimiList(LIST);
  assert.deepEqual(models.map((m) => m.id), ["kimi-k2.5", "kimi-k2-turbo", "kimi-k2-thinking"]);
  assert.equal(models[0].capabilities.vision, true);
  assert.equal(models[0].contextWindow, 262144);
  assert.equal(models[1].capabilities.reasoning, false);
  assert.deepEqual(models[2].capabilities.features, ["always_thinking"]);
});

test("kimi: fresh turns, tool continuations and compaction", () => {
  assert.equal(freshPrompt(userTurn("fix the bug")), "fix the bug");
  assert.equal(freshPrompt(userTurn([{ type: "text", text: "<system-reminder>x</system-reminder>look" }])), "look");
  assert.equal(freshPrompt(withToolCall(userTurn("fix the bug"))), null);
  // Real Kimi Code 2.1.1 -p request: reminder-only user messages follow the prompt.
  const reminded = userTurn("reply with just: ok");
  reminded.messages.push({ role: "user", content: "<system-reminder>\nToday's date is 2026-09-30.\n</system-reminder>" });
  reminded.messages.push({ role: "user", content: "<system-reminder>\nAuto permission mode is active.\n</system-reminder>" });
  assert.equal(freshPrompt(reminded), "reply with just: ok");
  const afterTool = withToolCall(userTurn("x"));
  afterTool.messages.push({ role: "user", content: "<system-reminder>date changed</system-reminder>" });
  assert.equal(freshPrompt(afterTool), null, "a reminder after a tool result is still a continuation");
  assert.equal(freshPrompt(userTurn("You are about to run out of context. Create a handoff summary...")), null);
  const t = parseRequest(userTurn("<krun-explain>\nrun it"), 400);
  assert.equal(t.skipRouting, true);
  assert.equal(t.requirements.contextTokens, 100);
  assert.equal(parseRequest(userTurn("x")).conversationKey, parseRequest(withToolCall(userTurn("x"))).conversationKey);
});

test("kimi: thinking is dropped for models that cannot honor it", () => {
  const [big, turbo, thinker] = modelsFromKimiList(LIST);
  assert.equal(normalizeForModel({ thinking: { type: "enabled" } }, turbo.id, turbo).thinking, undefined);
  assert.deepEqual(normalizeForModel({ thinking: { type: "enabled" } }, big.id, big).thinking, { type: "enabled" });
  assert.equal(normalizeForModel({ thinking: { type: "disabled" } }, thinker.id, thinker).thinking, undefined);
});

test("kimi: launch env defines the Krun Router model in memory only", () => {
  const env = kimiLaunchEnv({ env: { PATH: "p" }, proxyUrl: "http://127.0.0.1:9", apiKey: "sk-moon", models: modelsFromKimiList(LIST) });
  assert.equal(env.KIMI_MODEL_NAME, AUTO_MODEL);
  assert.equal(env.KIMI_MODEL_DISPLAY_NAME, "Krun Router");
  assert.equal(env.KIMI_MODEL_BASE_URL, "http://127.0.0.1:9");
  assert.equal(env.KIMI_MODEL_API_KEY, "sk-moon");
  assert.equal(env.KIMI_MODEL_CAPABILITIES, "thinking,image_in");
  assert.equal(env.KIMI_MODEL_MAX_CONTEXT_SIZE, "262144");
  assert.equal(env.PATH, "p");
});

test("kimi: credentials come from Kimi's env model or MOONSHOT_*", () => {
  assert.deepEqual(kimiCredentials({ MOONSHOT_API_KEY: "a" }), { apiKey: "a", upstream: "https://api.moonshot.ai/v1", preferredModel: null, supported: true });
  const own = kimiCredentials({ KIMI_MODEL_NAME: "kimi-k2.5", KIMI_MODEL_API_KEY: "b", KIMI_MODEL_BASE_URL: "https://gw.test/v1" });
  assert.deepEqual([own.apiKey, own.upstream, own.preferredModel], ["b", "https://gw.test/v1", "kimi-k2.5"]);
  assert.equal(kimiCredentials({ KIMI_MODEL_NAME: "x", KIMI_MODEL_PROVIDER_TYPE: "anthropic" }).supported, false);
  assert.equal(kimiCredentials({}).apiKey, null);
});

async function harness(pick = () => KIND.small) {
  const upstream = await mockServer((req, res) => {
    if (req.method === "GET") return json(res, 200, LIST);
    res.writeHead(200, { "content-type": "text/event-stream" }).end(`data: {"model":"${req.body.model}"}\n\ndata: [DONE]\n\n`);
  });
  const krun = await mockServer(krunHandler(pick));
  const models = await fetchKimiModels(upstream.url, "sk-moon");
  const router = createRouter({ krun: createKrunClient({ apiKey: "k", apiUrl: krun.url, timeoutMs: 500 }) });
  const proxy = await startProxy(createKimiAdapter({ router, upstream: upstream.url, models }));
  const send = (body) =>
    fetch(`${proxy.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk-moon" },
      body: JSON.stringify(body),
    }).then((r) => r.text());
  return { upstream, krun, send, close: () => Promise.all([proxy.close(), upstream.close(), krun.close()]) };
}

test("kimi proxy: routes once per turn, pins through tool calls, forwards auth untouched", async () => {
  const h = await harness();
  try {
    const out = await h.send({ ...userTurn("rename a file"), thinking: { type: "enabled" } });
    assert.match(out, /kimi-k2-turbo/);
    await h.send(withToolCall(userTurn("rename a file")));
    const chats = h.upstream.requests.filter((r) => r.method === "POST");
    assert.deepEqual(chats.map((r) => r.body.model), ["kimi-k2-turbo", "kimi-k2-turbo"]);
    assert.equal(chats[0].body.thinking, undefined, "turbo has no thinking");
    assert.equal(chats[0].headers.authorization, "Bearer sk-moon");
    assert.equal(h.krun.requests.length, 1);
    assert.ok(!JSON.stringify(h.krun.requests).includes("sk-moon"));
  } finally {
    await h.close();
  }
});

test("kimi proxy: a concrete model passes through and bypasses Krun", async () => {
  const h = await harness();
  try {
    const body = { ...userTurn("x"), model: "kimi-k2.5" };
    await h.send(body);
    assert.equal(h.krun.requests.length, 0);
    assert.deepEqual(h.upstream.requests.find((r) => r.method === "POST").body, body);
  } finally {
    await h.close();
  }
});

test("kimi: the tui.toml status line opt-in is suggested once and never written", () => {
  const home = mkdtempP(joinP(tmpdirP(), "krun-kimi-home-"));
  const cfg = joinP(home, ".krun-router");
  const hint = statuslineHint(home, cfg);
  assert.ok(hint.includes("[status_line]"), hint);
  assert.ok(hint.includes("krun-statusline.mjs"), hint);
  assert.equal(statuslineHint(home, cfg), null, "only once");
  const other = mkdtempP(joinP(tmpdirP(), "krun-kimi-home-"));
  mkdirP(joinP(other, ".kimi-code"));
  writeP(joinP(other, ".kimi-code", "tui.toml"), "[status_line]\ncommand = 'krun-statusline'\n");
  assert.equal(statuslineHint(other, joinP(other, ".krun-router")), null, "already set up");
});

test("krun-statusline: routed model inside a session, the CLI's own model outside one", async () => {
  const bin = joinP(import.meta.dirname, "..", "bin", "krun-statusline.mjs");
  const run = (env, payload) => execFileSync(process.execPath, [bin], { input: JSON.stringify(payload), env: { ...process.env, KRUN_ROUTER_SESSION: "", ...env }, encoding: "utf8" }).trim();
  assert.equal(run({}, { model: "kimi-k2", cwd: "/w/app" }), "kimi-k2 · app", "Kimi payload, not routed");
  const sessionId = `test-kimi-status-${process.pid}`;
  const h = createHistoryP({ sessionId, cli: "kimi" });
  h.record({ at: Date.now(), model: "kimi-k2-turbo", fallback: false, confidence: 0.8, reason: "krun" });
  await h.flush();
  assert.equal(run({ KRUN_ROUTER_SESSION: sessionId }, { model: "Krun Router", cwd: "/w/app" }), "[Krun] → kimi-k2-turbo (0.80) · app");
});
