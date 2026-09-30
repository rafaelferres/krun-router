import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpencodeRouting, opencodeLaunch, startBridge } from "../src/adapters/opencode.mjs";
import { createRouter } from "../src/router.mjs";
import { createKrunClient } from "../src/krun-client.mjs";
import { createHistory } from "../src/status.mjs";
import { KIND, krunHandler, mockServer } from "./helpers.mjs";

const launch = (userArgs, env = {}) => opencodeLaunch({ userArgs, env, pluginDir: "/p", bridgeUrl: "http://b/t" });

test("opencode: --standalone is added where OpenCode accepts it; user arguments stay verbatim", () => {
  assert.deepEqual(launch([]).args, ["--standalone"]);
  assert.deepEqual(launch(["--continue", "./dir"]).args, ["--standalone", "--continue", "./dir"]);
  assert.deepEqual(launch(["run", "--model", "a/b", "fix & ship"]).args, ["run", "--standalone", "--model", "a/b", "fix & ship"]);
  assert.deepEqual(launch(["--standalone", "-c"]).args, ["--standalone", "-c"]);
  const l = launch([]);
  assert.equal(l.routed, true);
  assert.deepEqual(JSON.parse(l.env.OPENCODE_CONFIG_CONTENT), { plugins: ["/p"] });
  assert.equal(l.env.KRUN_ROUTER_BRIDGE, "http://b/t");
});

test("opencode: management commands, --server and unreadable config content start without routing", () => {
  for (const args of [["auth", "login"], ["models"], ["--help"]]) {
    const l = launch(args, { X: "1" });
    assert.deepEqual([l.args, l.routed, l.env.OPENCODE_CONFIG_CONTENT], [args, false, undefined]);
  }
  assert.match(launch(["--server", "http://x"]).reason, /--server/);
  assert.match(launch([], { OPENCODE_CONFIG_CONTENT: "{ // jsonc" }).reason, /not plain JSON/);
});

test("opencode: the user's own OPENCODE_CONFIG_CONTENT is kept and our plugin is appended", () => {
  const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "a/b", plugins: ["mine"] }) };
  assert.deepEqual(JSON.parse(launch([], env).env.OPENCODE_CONFIG_CONTENT), { model: "a/b", plugins: ["mine", "/p"] });
});

// ------------------------------------------------------------------ plugin ↔ bridge ↔ router

const MODELS = [
  { id: "big", providerID: "anthropic", name: "Big", enabled: true, status: "active", limit: { context: 200000 }, capabilities: { tools: true, input: ["text", "image"] } },
  { id: "small", providerID: "anthropic", name: "Small", enabled: true, status: "active", limit: { context: 200000 }, capabilities: { tools: true, input: ["text"] } },
  { id: "old", providerID: "anthropic", name: "Old", enabled: true, status: "deprecated", limit: { context: 1 }, capabilities: { tools: true, input: ["text"] } },
  { id: "gpt", providerID: "openai", name: "GPT", enabled: true, status: "active", limit: { context: 1 }, capabilities: { tools: true, input: ["text"] } },
];

/** A fake OpenCode plugin context: one session whose model the plugin may switch. */
function fakeOpencode() {
  const hooks = {};
  const commands = {};
  const sessions = { s1: { id: "s1", model: { providerID: "anthropic", id: "big" } }, sub: { id: "sub", parentID: "s1", model: { providerID: "anthropic", id: "big" } } };
  const said = [];
  const ctx = {
    session: {
      hook: async (name, cb) => void (hooks[name] = cb),
      get: async ({ sessionID }) => ({ location: {}, data: sessions[sessionID] }),
      switchModel: async ({ sessionID, model }) => void (sessions[sessionID].model = model),
      synthetic: async ({ text }) => void said.push(text),
    },
    model: { list: async () => ({ location: {}, data: MODELS }), default: async () => ({ location: {}, data: MODELS[0] }) },
    command: { transform: async (cb) => cb({ add: (c) => (commands[c.name] = c) }) },
  };
  const prompt = (sessionID, text) => hooks.prompt({ sessionID, messageID: "m", prompt: { text }, delivery: "steer" });
  return { ctx, sessions, commands, said, prompt };
}

test("opencode plugin: routes each human prompt within the provider, pauses on a manual pick, resumes on /krun-auto", async () => {
  let pick = () => KIND.small;
  const krun = await mockServer((req, res) => krunHandler(() => pick())(req, res));
  const history = createHistory({ sessionId: "oc-test", cli: "opencode", dir: mkdtempSync(join(tmpdir(), "krun-oc-")) });
  const router = createRouter({ krun: createKrunClient({ apiKey: "k", apiUrl: krun.url }) });
  const routing = createOpencodeRouting({ router, history });
  const bridge = await startBridge({
    route: (b) => routing.route(b),
    resume: ({ sessionID }) => routing.resume(sessionID),
    explain: () => ({ text: "why: small" }),
  });
  process.env.KRUN_ROUTER_BRIDGE = bridge.url;
  try {
    const { default: plugin } = await import(`../src/opencode-plugin/server.js?${Date.now()}`);
    const oc = fakeOpencode();
    await plugin.setup(oc.ctx);

    await oc.prompt("s1", "rename a variable");
    assert.deepEqual(oc.sessions.s1.model, { providerID: "anthropic", id: "small" });
    assert.deepEqual(history.data.decisions[0].candidates.sort(), ["big", "small"], "same provider, not deprecated");
    assert.ok(routing.status("s1").startsWith("[Krun] → small"), routing.status("s1"));
    assert.equal(routing.status("other"), "[Krun] waiting for first prompt");

    pick = () => KIND.large; // "big" is the largest model this provider offers
    await oc.prompt("s1", "design the storage layer");
    assert.equal(oc.sessions.s1.model.id, "big", "every fresh prompt routes again");

    oc.sessions.s1.model = { providerID: "anthropic", id: "small" }; // the human picks a model in /models
    await oc.prompt("s1", "next");
    assert.equal(oc.sessions.s1.model.id, "small", "manual choice wins");
    assert.equal(krun.requests.length, 2, "paused: Krun not asked");
    assert.equal(history.data.manual.model, "small");
    assert.equal(routing.status("s1"), "[Krun] paused · manual model small");

    await oc.commands["krun-auto"].execute({ sessionID: "s1" });
    await oc.prompt("s1", "and now?");
    assert.equal(oc.sessions.s1.model.id, "big");
    assert.equal(krun.requests.length, 3);

    await oc.prompt("sub", "sub-agent work");
    assert.equal(krun.requests.length, 3, "sub-agent sessions keep their model");

    await oc.commands["krun-explain"].execute({ sessionID: "s1" });
    assert.ok(oc.said.includes("why: small"));
    assert.equal(history.data.decisions.length, 3);
  } finally {
    delete process.env.KRUN_ROUTER_BRIDGE;
    await bridge.close();
    await krun.close();
  }
});

test("opencode plugin: an unreachable krun-router keeps the current model", async () => {
  process.env.KRUN_ROUTER_BRIDGE = "http://127.0.0.1:1/x";
  try {
    const { default: plugin } = await import(`../src/opencode-plugin/server.js?down${Date.now()}`);
    const oc = fakeOpencode();
    await plugin.setup(oc.ctx);
    await oc.prompt("s1", "hello");
    assert.equal(oc.sessions.s1.model.id, "big");
  } finally {
    delete process.env.KRUN_ROUTER_BRIDGE;
  }
});

test("opencode bridge rejects requests without its token", async () => {
  const bridge = await startBridge({ route: () => ({ model: "x" }) });
  try {
    const base = bridge.url.replace(/\/[^/]+$/, "");
    assert.equal((await fetch(`${base}/wrong/route`, { method: "POST", body: "{}" })).status, 404);
    assert.deepEqual(await (await fetch(`${bridge.url}/route`, { method: "POST", body: "{}" })).json(), { model: "x" });
  } finally {
    await bridge.close();
  }
});

test("opencode TUI plugin: a toast for each new decision, none for repeats or before routing", async () => {
  const texts = ["[Krun] waiting for first prompt", "[Krun] → small (0.90)", "[Krun] → small (0.90)", "[Krun] → big (0.80)"];
  const bridge = await startBridge({ status: () => ({ text: texts.shift() }) });
  process.env.KRUN_ROUTER_BRIDGE = bridge.url;
  try {
    const { default: plugin } = await import(`../src/opencode-plugin/tui.js?${Date.now()}`);
    let handler;
    const toasts = [];
    const ctx = {
      data: { on: (type, h) => (assert.equal(type, "session.step.started"), (handler = h), () => {}) },
      ui: { toast: { show: (o) => toasts.push(o) } },
    };
    plugin.setup(ctx);
    for (let i = 0; i < 4; i++) await handler({ data: { sessionID: "s1" } });
    assert.deepEqual(toasts.map((t) => t.message), ["[Krun] → small (0.90)", "[Krun] → big (0.80)"]);
    assert.equal(toasts[0].sessionID, "s1");
  } finally {
    delete process.env.KRUN_ROUTER_BRIDGE;
    await bridge.close();
  }
});
