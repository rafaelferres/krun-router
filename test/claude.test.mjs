import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTO_MODEL,
  baselineModel,
  claudeLaunch,
  conversationKey,
  createClaudeAdapter,
  foldSystemMessages,
  freshPrompt,
  modelsFromClaudeCatalog,
  normalizeForModel,
  parseRequest,
  restoreSavedModel,
  sanitizeSchema,
} from "../src/adapters/claude.mjs";
import { createRouter } from "../src/router.mjs";
import { createKrunClient } from "../src/krun-client.mjs";
import { startProxy } from "../src/proxy.mjs";
import { LOG_FILE, flushLog, setDebug } from "../src/log.mjs";
import { KIND, json, krunHandler, mockServer } from "./helpers.mjs";

// Shaped like ~/.claude/cache/model-catalog/*-cc.json (trimmed).
const CATALOG = {
  catalog: {
    config: {
      models: [
        { id: "claude-big", name: "Big", description: "Hard work", section: "main", capabilities: { mm_images: true }, thinking: { type: "effort", effort_options: [{ id: "low" }, { id: "high" }, { id: "max" }] } },
        { id: "claude-mid", name: "Mid", section: "main", capabilities: { mm_images: true }, thinking: { type: "effort", effort_options: [{ id: "low" }, { id: "medium" }, { id: "high" }] } },
        { id: "claude-small", name: "Small", section: "main", capabilities: { mm_images: true }, thinking: { type: "none" } },
        { id: "claude-old", name: "Old", section: "overflow", thinking: { type: "effort", effort_options: [{ id: "low" }] } },
      ],
    },
  },
};
const MODELS = modelsFromClaudeCatalog(CATALOG);

const TOOLS = [{ name: "Bash", input_schema: { type: "object" } }];
const userTurn = (text, extra = {}) => ({
  model: AUTO_MODEL,
  tools: TOOLS,
  thinking: { type: "adaptive" },
  output_config: { effort: "max" },
  context_management: { edits: [{ type: "clear_thinking_20251015" }] },
  messages: [{ role: "user", content: [{ type: "text", text: "<system-reminder>ctx</system-reminder>" }, { type: "text", text }] }],
  ...extra,
});
const withToolResult = (body) => ({
  ...body,
  messages: [
    ...body.messages,
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
  ],
});

// ------------------------------------------------------------------ parsing

test("claude: catalog is read from Claude Code's cache, main section only", () => {
  assert.deepEqual(MODELS.map((m) => m.id), ["claude-big", "claude-mid", "claude-small"]);
  assert.equal(MODELS[2].capabilities.reasoning, false);
  assert.deepEqual(MODELS[0].capabilities.efforts, ["low", "high", "max"]);
  assert.equal(MODELS[0].capabilities.vision, true);
});

test("claude: detects a fresh user turn and strips system reminders", () => {
  assert.equal(freshPrompt(userTurn("fix the bug")), "fix the bug");
  assert.equal(freshPrompt({ tools: TOOLS, messages: [{ role: "user", content: "plain string" }] }), "plain string");
});

test("claude: trailing system-role hook messages do not hide the fresh turn", () => {
  const body = userTurn("fix the bug");
  body.messages.push({ role: "system", content: [{ type: "text", text: "SessionStart hook output" }] });
  assert.equal(freshPrompt(body), "fix the bug");
});

test("claude: tool results and auxiliary calls are not new turns", () => {
  assert.equal(freshPrompt(withToolResult(userTurn("fix the bug"))), null);
  assert.equal(freshPrompt({ ...userTurn("title this"), tools: [] }), null, "no tools: auxiliary call");
  assert.equal(freshPrompt({ tools: TOOLS, messages: [{ role: "user", content: [{ type: "text", text: "<system-reminder>only</system-reminder>" }] }] }), null);
  assert.equal(freshPrompt(userTurn("[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]\n\nFIRST: ...")), null);
  assert.equal(freshPrompt(userTurn("The user stepped away and is coming back. Recap in under 40 words.")), null);
});

test("claude: local slash-command records are stripped from the prompt", () => {
  const caveat =
    "<local-command-caveat>The command below was run directly in Claude Code.</local-command-caveat>\n\n<command-name>/clear</command-name>\n <command-message>clear</command-message>\n <command-args></command-args>\n\n<local-command-stdout></local-command-stdout>";
  assert.equal(freshPrompt(userTurn(`${caveat}\n\nfix the failing test`)), "fix the failing test");
  assert.equal(freshPrompt(userTurn(caveat)), null, "a command record alone is not a turn");
});

test("claude: main agent and sub-agent get different conversation keys, stable across a turn", () => {
  const main = userTurn("main task");
  const sub = userTurn("sub-agent: search the repo");
  assert.notEqual(conversationKey(main), conversationKey(sub));
  assert.equal(conversationKey(main), conversationKey(withToolResult(main)));
  assert.equal(conversationKey(main), conversationKey({ ...main, metadata: { user_id: "{}" } }));
});

test("claude: requirements detect images and tools", () => {
  const body = userTurn("what is this");
  body.messages[0].content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: "x" } });
  const t = parseRequest(body, 4000);
  assert.equal(t.requirements.vision, true);
  assert.equal(t.requirements.tools, true);
  assert.equal(t.requirements.contextTokens, 1000);
  assert.equal(parseRequest(userTurn("<krun-explain> report")).skipRouting, true);
});

test("claude: baseline resolves configured aliases against the catalog", () => {
  assert.equal(baselineModel(MODELS, "mid"), "claude-mid");
  assert.equal(baselineModel(MODELS, "big[1m]"), "claude-big");
  assert.equal(baselineModel(MODELS, undefined), "claude-big");
  assert.equal(baselineModel([], undefined), "claude-sonnet-4-6");
});

// ------------------------------------------------------------------ normalization

test("claude: routing to a model without thinking strips thinking, effort and thinking edits", () => {
  const body = normalizeForModel(userTurn("x"), "claude-small", MODELS[2]);
  assert.equal(body.model, "claude-small");
  assert.equal(body.thinking, undefined);
  assert.equal(body.context_management, undefined);
  assert.equal(body.output_config, undefined);
});

test("claude: unsupported effort becomes the nearest lower supported level", () => {
  assert.equal(normalizeForModel(userTurn("x"), "claude-mid", MODELS[1]).output_config.effort, "high");
  const low = normalizeForModel(userTurn("x", { output_config: { effort: "low" } }), "claude-mid", MODELS[1]);
  assert.equal(low.output_config.effort, "low");
  const kept = normalizeForModel(userTurn("x"), "claude-big", MODELS[0]);
  assert.deepEqual(kept.thinking, { type: "adaptive" });
  assert.equal(kept.output_config.effort, "max");
});

test("claude: system-role messages fold into user messages for models without the role", () => {
  const body = { messages: [{ role: "user", content: "hi" }, { role: "system", content: [{ type: "text", text: "hook" }] }] };
  assert.equal(foldSystemMessages(body), true);
  assert.deepEqual(body.messages[1], { role: "user", content: [{ type: "text", text: "<system-reminder>\nhook\n</system-reminder>" }] });
});

test("claude: legacy boolean exclusiveMinimum in MCP schemas is converted", () => {
  const schema = { properties: { n: { type: "number", minimum: 1, exclusiveMinimum: true }, m: { exclusiveMaximum: false } } };
  assert.equal(sanitizeSchema(schema), true);
  assert.deepEqual(schema.properties, { n: { type: "number", exclusiveMinimum: 1 }, m: {} });
  assert.equal(sanitizeSchema({ type: "object" }), false);
});

// ------------------------------------------------------------------ launch

test("claude: all user arguments are forwarded verbatim; ours go before a `--`", () => {
  const userArgs = ["-p", "a prompt with spaces & \"quotes\"", "--resume", "abc", "--allowedTools", "Bash(git *)"];
  const { args, env } = claudeLaunch({ userArgs, env: {}, proxyUrl: "http://127.0.0.1:1", skillsDir: "/s", settingsFile: "/f.json" });
  assert.deepEqual(args.slice(0, userArgs.length), userArgs);
  assert.deepEqual(args.slice(userArgs.length), ["--add-dir", "/s", "--settings", "/f.json"]);
  assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:1");
  assert.equal(env.ANTHROPIC_MODEL, AUTO_MODEL);
  assert.equal(env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME, "Krun Router");
  assert.equal(env.ENABLE_TOOL_SEARCH, "true", "the proxy must not turn MCP tool search off");
  assert.equal(claudeLaunch({ userArgs: [], env: { ENABLE_TOOL_SEARCH: "false" }, proxyUrl: "u" }).env.ENABLE_TOOL_SEARCH, "false", "user setting wins");
  assert.equal(claudeLaunch({ userArgs: [], env: { ANTHROPIC_BASE_URL: "https://gw.test" }, proxyUrl: "u" }).env.ENABLE_TOOL_SEARCH, undefined, "own gateway: left alone");

  const sep = claudeLaunch({ userArgs: ["--model", "opus", "--", "-weird prompt"], env: {}, proxyUrl: "u", skillsDir: "/s" });
  assert.deepEqual(sep.args, ["--model", "opus", "--add-dir", "/s", "--", "-weird prompt"]);
  assert.equal(sep.env.ANTHROPIC_MODEL, undefined, "an explicit --model is the user's choice");

  assert.deepEqual(claudeLaunch({ userArgs: ["mcp", "list"], env: {}, proxyUrl: "u", skillsDir: "/s" }).args, ["mcp", "list"]);
  assert.equal(claudeLaunch({ userArgs: [], env: { ANTHROPIC_MODEL: "sonnet" }, proxyUrl: "u" }).env.ANTHROPIC_MODEL, "sonnet");
});

test("claude: a saved krun-router default is restored on exit, anything else is left alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "krun-settings-"));
  const file = join(dir, "settings.json");
  writeFileSync(file, JSON.stringify({ model: AUTO_MODEL, theme: "dark" }));
  assert.equal(restoreSavedModel("opus", file), true);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { model: "opus", theme: "dark" });
  writeFileSync(file, JSON.stringify({ model: "sonnet" }));
  assert.equal(restoreSavedModel("opus", file), false);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).model, "sonnet");
});

// ------------------------------------------------------------------ proxy integration

async function harness({ pick = () => KIND.small, catalog = MODELS, windows = new Map() } = {}) {
  const upstream = await mockServer((req, res) => {
    if (req.body?.messages?.some((m) => m.role === "system") && req.body.model === "claude-legacy") {
      return json(res, 400, { type: "error", error: { type: "invalid_request_error", message: "role 'system' is not supported on this model" } });
    }
    json(res, 200, { id: "msg", type: "message", model: req.body?.model, content: [] });
  });
  const krun = await mockServer(krunHandler(pick));
  const decisions = [];
  const router = createRouter({ krun: createKrunClient({ apiKey: "krun_test_x", apiUrl: krun.url, timeoutMs: 500 }), onDecision: (d) => decisions.push(d) });
  const adapter = createClaudeAdapter({ router, upstream: upstream.url, loadCatalog: async () => catalog, loadContextWindows: async () => windows });
  const proxy = await startProxy(adapter);
  const send = (body, headers = {}) =>
    fetch(`${proxy.url}/v1/messages?beta=true`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }).then((r) => r.json());
  return {
    upstream, krun, decisions, proxy, send,
    close: async () => Promise.all([proxy.close(), upstream.close(), krun.close()]),
  };
}

const AUTH = { authorization: "Bearer sk-ant-oat01-SECRET-TOKEN", "x-api-key": "sk-ant-api-SECRET", "anthropic-beta": "oauth-2025-04-20", cookie: "session=SECRET" };

test("claude proxy: a routed turn runs the classified tier's model and stays pinned through the tool loop", async () => {
  const h = await harness({ pick: () => KIND.small });
  try {
    const first = userTurn("rename variable x to y");
    assert.equal((await h.send(first)).model, "claude-small");
    assert.equal((await h.send(withToolResult(first))).model, "claude-small");
    assert.equal((await h.send(withToolResult(withToolResult(first)))).model, "claude-small");
    assert.equal(h.krun.requests.length, 1, "Krun is asked once per fresh turn");
    assert.equal(h.krun.requests[0].body.context, "rename variable x to y");
    const sent = h.upstream.requests[0].body;
    assert.equal(sent.thinking, undefined, "capability normalization applied on the wire");
    assert.equal(sent.output_config, undefined);
  } finally {
    await h.close();
  }
});

test("claude proxy: provider auth headers pass through untouched and never reach Krun", async () => {
  const h = await harness();
  try {
    await h.send(userTurn("hello"), AUTH);
    const up = h.upstream.requests[0].headers;
    for (const [k, v] of Object.entries(AUTH)) assert.equal(up[k], v);
    const toKrun = JSON.stringify(h.krun.requests[0]);
    for (const v of Object.values(AUTH)) assert.ok(!toKrun.includes(v), "no provider credential is sent to Krun");
    assert.equal(h.krun.requests[0].headers.authorization, "Bearer krun_test_x");
  } finally {
    await h.close();
  }
});

test("claude proxy: auth headers are never logged, even in debug mode", async () => {
  setDebug(true);
  const h = await harness();
  try {
    await h.send(userTurn("hello"), AUTH);
    await h.send({ ...userTurn("manual"), model: "claude-mid" }, AUTH);
    await flushLog();
    const log = readFileSync(LOG_FILE, "utf8");
    assert.ok(log.length > 0);
    for (const v of Object.values(AUTH)) assert.ok(!log.includes(v), `log must not contain ${v.slice(0, 12)}…`);
    assert.ok(!log.includes("SECRET"));
  } finally {
    setDebug(false);
    await h.close();
  }
});

test("claude proxy: a concrete user-selected model passes through byte-for-byte and bypasses Krun", async () => {
  const h = await harness({ pick: () => KIND.small });
  try {
    const body = { ...userTurn("do it"), model: "claude-big" };
    await h.send(body);
    assert.equal(h.krun.requests.length, 0);
    assert.deepEqual(h.upstream.requests[0].body, body, "request unchanged");
    // Selecting Krun Router again resumes routing.
    assert.equal((await h.send(userTurn("now route"))).model, "claude-small");
    assert.equal(h.krun.requests.length, 1);
  } finally {
    await h.close();
  }
});

test("claude proxy: Krun unavailable keeps the baseline and the request still succeeds", async () => {
  const upstream = await mockServer((req, res) => json(res, 200, { model: req.body.model }));
  const router = createRouter({ krun: createKrunClient({ apiKey: "k", apiUrl: "http://127.0.0.1:1", timeoutMs: 200 }) });
  const proxy = await startProxy(createClaudeAdapter({ router, upstream: upstream.url, loadCatalog: async () => MODELS, loadContextWindows: async () => new Map() }));
  try {
    const r = await fetch(`${proxy.url}/v1/messages`, { method: "POST", body: JSON.stringify(userTurn("x")) }).then((x) => x.json());
    assert.equal(r.model, "claude-big");
  } finally {
    await Promise.all([proxy.close(), upstream.close()]);
  }
});

test("claude proxy: models too small for the context are filtered before Krun sees them", async () => {
  const h = await harness({ pick: () => KIND.small, windows: new Map([["claude-small", 10], ["claude-big", 1000000]]) });
  try {
    await h.send(userTurn("x".repeat(400)));
    assert.deepEqual(h.decisions[0].candidates, ["claude-big", "claude-mid"]);
    assert.notEqual(h.decisions[0].model, "claude-small");
    assert.match(h.decisions[0].rejected[0].reason, /exceeds 10/);
  } finally {
    await h.close();
  }
});

test("claude proxy: models that reject system-role messages are learned and folded", async () => {
  const legacy = [{ ...MODELS[0], id: "claude-legacy", capabilities: { ...MODELS[0].capabilities } }, MODELS[1]];
  const h = await harness({ pick: () => KIND.medium, catalog: legacy });
  try {
    const body = userTurn("go");
    body.messages.push({ role: "system", content: "hook output" });
    const first = await fetch(`${h.proxy.url}/v1/messages`, { method: "POST", body: JSON.stringify(body) });
    assert.equal(first.status, 400, "the provider's error still reaches Claude Code");
    await first.text();
    const retry = await h.send(withToolResult({ ...body }));
    assert.equal(retry.model, "claude-legacy");
    assert.ok(!h.upstream.requests[1].body.messages.some((m) => m.role === "system"));
  } finally {
    await h.close();
  }
});

test("claude proxy: HEAD probe is answered locally and count_tokens never routes", async () => {
  const h = await harness();
  try {
    assert.equal((await fetch(h.proxy.url, { method: "HEAD" })).status, 200);
    await fetch(`${h.proxy.url}/v1/messages/count_tokens`, { method: "POST", body: JSON.stringify(userTurn("count me")) }).then((r) => r.text());
    assert.equal(h.krun.requests.length, 0);
    assert.equal(h.upstream.requests[0].body.model, "claude-big");
  } finally {
    await h.close();
  }
});
