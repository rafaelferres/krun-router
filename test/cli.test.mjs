import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHistory, HISTORY_LIMIT, pruneStale, readHistory, statusText } from "../src/status.mjs";
import { formatExplanation } from "../src/explain.mjs";
import { loadConfig } from "../src/config.mjs";
import { parseCmdShim, run } from "../src/launch.mjs";
import { redact } from "../src/log.mjs";
import { mockServer, json } from "./helpers.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const tmp = (p) => mkdtempSync(join(tmpdir(), p));

const decision = (over = {}) => ({
  at: Date.now(),
  prompt: "refactor the auth module",
  currentModel: "model-a",
  candidates: ["model-a", "model-b", "model-x"],
  rejected: [],
  requirements: { tools: true, vision: false },
  context: { tokens: 18400 },
  model: "model-x",
  reason: "krun: architecture → large",
  fallback: false,
  mode: "balanced",
  kind: "architecture",
  tier: "large",
  confidence: 0.91,
  escalate: 0.07,
  probabilities: { architecture: 0.77, refactor: 0.19 },
  abstain: true,
  krun: { request: { context: "refactor the auth module" }, response: {}, requestId: "req_1", latencyMs: 312, error: null },
  ...over,
});

// ------------------------------------------------------------------ history / status

test("history is bounded per session and mirrored to a private file", async () => {
  const dir = tmp("krun-hist-");
  const h = createHistory({ sessionId: "claude-1", cli: "claude", dir });
  for (let i = 0; i < HISTORY_LIMIT + 7; i++) h.record(decision({ prompt: `p${i}` }));
  await h.flush();
  const saved = readHistory("claude-1", dir);
  assert.equal(saved.decisions.length, HISTORY_LIMIT);
  assert.equal(saved.decisions.at(-1).prompt, `p${HISTORY_LIMIT + 6}`);
  if (process.platform !== "win32") assert.equal(statSync(h.file).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(saved).match(/authorization|Bearer/i));
});

test("stale history files are cleaned, fresh ones kept", async () => {
  const dir = tmp("krun-stale-");
  writeFileSync(join(dir, "old.json"), "{}");
  writeFileSync(join(dir, "old.json.1.tmp"), "{}");
  writeFileSync(join(dir, "new.json"), "{}");
  writeFileSync(join(dir, "router.log"), "keep");
  const old = new Date(Date.now() - 10 * 24 * 3600 * 1000);
  utimesSync(join(dir, "old.json"), old, old);
  utimesSync(join(dir, "old.json.1.tmp"), old, old);
  assert.equal(await pruneStale(dir), 2);
  assert.equal(existsSync(join(dir, "old.json")), false);
  assert.equal(existsSync(join(dir, "new.json")), true);
  assert.equal(existsSync(join(dir, "router.log")), true);
});

test("status line: routed model with confidence, fallback reason, manual pause", () => {
  assert.equal(statusText({ decisions: [decision()] }), "[Krun] → model-x (0.91)");
  assert.equal(statusText({ decisions: [decision({ fallback: true, reason: "krun abstained", model: "model-a" })] }), "[Krun] → model-a · kept: krun abstained");
  assert.equal(statusText({ decisions: [decision()], manual: { at: Date.now() + 1, model: "claude-big" } }), "[Krun] paused · manual model claude-big");
  assert.equal(statusText(null), "[Krun] waiting for first prompt");
});

// ------------------------------------------------------------------ explain

test("explanation renders the recorded exchange", () => {
  const out = formatExplanation({ decisions: [decision()] });
  for (const s of ["Krun Router", "Selected", "model-x", "0.91", "architecture", "large", "0.07", "balanced", "model-b", "~18,400", "312 ms", "manual override", "capability pass", "fallback        no"]) {
    assert.ok(out.includes(s), `missing ${s}`);
  }
  const widths = new Set(out.split("\n").map((l) => [...l].length));
  assert.equal(widths.size, 1, "box lines have equal width");
  assert.match(formatExplanation({ decisions: [], manual: { at: 1, model: "gpt-x" } }), /paused because gpt-x/);
});

test("krun-explain uses the recorded decision and never queries Krun", async () => {
  const krun = await mockServer((_req, res) => json(res, 200, {}));
  const sessionId = `test-explain-${process.pid}`;
  const h = createHistory({ sessionId, cli: "test" }); // default temp dir, like a real session
  h.record(decision());
  await h.flush();
  try {
    const out = execFileSync(process.execPath, [join(ROOT, "bin", "krun-explain.mjs")], {
      env: { ...process.env, KRUN_ROUTER_SESSION: sessionId, KRUN_API_URL: krun.url, KRUN_API_KEY: "k" },
      encoding: "utf8",
    });
    assert.match(out, /model-x/);
    assert.match(out, /architecture/);
    assert.equal(krun.requests.length, 0, "no new routing request");
    const asJson = JSON.parse(execFileSync(process.execPath, [join(ROOT, "bin", "krun-explain.mjs"), sessionId, "--json"], { encoding: "utf8" }));
    assert.equal(asJson.decisions[0].krun.requestId, "req_1");
  } finally {
    rmSync(h.file, { force: true });
    await krun.close();
  }
});

// ------------------------------------------------------------------ config

test("legacy ~/.krun-router.env still works; invalid values fall through; defaults apply", () => {
  const home = tmp("krun-home-");
  writeFileSync(join(home, ".krun-router.env"), "KRUN_API_KEY=krun_live_home\nKRUN_DEBUG=1\nKRUN_NO_STATUS=1\nDATABASE_URL=postgres://secret\n");
  const c = loadConfig({ env: {}, home });
  assert.deepEqual([c.apiKey, c.debug, c.status], ["krun_live_home", true, false]);
  assert.deepEqual([c.sources.apiKey, c.sources.debug], ["legacy", "legacy"]);
  assert.equal(loadConfig({ env: { KRUN_API_KEY: "krun_live_env" }, home }).apiKey, "krun_live_env");
  const d = loadConfig({ env: {}, home: tmp("e-") });
  assert.deepEqual([d.apiKey, d.apiUrl, d.routingTimeoutMs, d.debug, d.status], [null, "https://api.krun.ai", 5000, false, true]);
  assert.equal(loadConfig({ env: { KRUN_DEBUG: "nope" }, home }).debug, true, "invalid env value falls through");
  assert.deepEqual(loadConfig({ env: { KRUN_MODELS: "a, b" }, home }).models, ["a", "b"]);
});

test("log redaction removes credentials", () => {
  const line = 'authorization: Bearer abc.def x-api-key="sk-ant-api03-zzzzzzzz" krun_live_123 cookie=sess eyJhbGc.eyJzdWI.sig';
  const out = redact(line);
  for (const s of ["abc.def", "sk-ant-api03", "krun_live_123", "sess", "eyJhbGc"]) assert.ok(!out.includes(s), s);
});

// ------------------------------------------------------------------ launch

test("npm .cmd shims are resolved to their real target", () => {
  const claude = parseCmdShim('"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*', "C:\\npm");
  assert.match(claude.file, /claude\.exe$/);
  assert.deepEqual(claude.prefix, []);
  const codex = parseCmdShim('"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*', "C:\\npm");
  assert.equal(codex.file, process.execPath);
  assert.match(codex.prefix[0], /codex\.js$/);
  assert.equal(parseCmdShim("@echo off", "C:\\npm"), null);
});

test("all CLI arguments reach the child process unchanged", async () => {
  const dir = tmp("krun-args-");
  const echo = join(dir, "echo.mjs");
  const out = join(dir, "out.json");
  writeFileSync(echo, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));`);
  const args = ["-p", "spaces and \"quotes\"", "a&b|c", "%PATH%", "--flag=value", "", "ünïcødé", "--", "-x"];
  const code = await run({ file: process.execPath, prefix: [echo], shell: false }, args, process.env);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), args);
});
