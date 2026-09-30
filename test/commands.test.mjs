import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { main, parseGlobal } from "../src/cli/main.mjs";
import { doctorCommand } from "../src/cli/doctor-command.mjs";
import { loadConfig } from "../src/config.mjs";
import { maskKey } from "../src/credentials.mjs";
import { createKrunClient } from "../src/krun-client.mjs";
import { normalizeModel } from "../src/catalog.mjs";
import { json, mockServer } from "./helpers.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const KEY = "krun_live_SUPERSECRETkeyFk2";
const tmp = (p = "krun-cli-") => mkdtempSync(join(tmpdir(), p));

function sink() {
  let text = "";
  return { write: (c) => ((text += c), true), get text() { return text; } };
}

/** Runs the CLI in-process against a temporary HOME. Never touches the real ~/.krun-router. */
async function cli(argv, { home = tmp(), env = {}, input = "" } = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await main(argv, { home, env, stdin: Readable.from([input]), stdout, stderr });
  return { code, out: stdout.text, err: stderr.text, home };
}

const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));

// ------------------------------------------------------------------ root

test("root: no arguments and --help print concise help", async () => {
  for (const argv of [[], ["--help"], ["-h"]]) {
    const r = await cli(argv);
    assert.equal(r.code, 0);
    assert.match(r.out, /^krun-router\n\nAutomatic per-turn model routing for Claude Code, Codex, OpenCode and Kimi Code, powered by Krun\./);
    for (const c of ["config", "doctor", "claude", "codex", "explain"]) assert.match(r.out, new RegExp(`\\n  ${c} `));
  }
  assert.equal((await cli(["nope"])).code, 2);
});

test("root: --version prints the package.json version", async () => {
  assert.equal((await cli(["--version"])).out, `krun-router ${PKG.version}\n`);
  assert.equal((await cli(["-v"])).out, `krun-router ${PKG.version}\n`);
});

test("root: every command has wrapper help", async () => {
  for (const c of ["config", "doctor", "claude", "codex", "explain"]) {
    const r = await cli(["help", c]);
    assert.equal(r.code, 0);
    assert.match(r.out, /Usage/);
  }
  assert.match((await cli(["config", "--help"])).out, /config set <key>/);
  assert.match((await cli(["doctor", "--help"])).out, /Usage: krun-router doctor/);
  assert.match((await cli(["explain", "--help"])).out, /Usage: krun-router explain/);
});

test("root: global flags are parsed only before the command", () => {
  assert.deepEqual(parseGlobal(["--no-status", "--debug", "claude", "--debug"]), {
    flags: { status: false, debug: true },
    rest: ["claude", "--debug"],
  });
  // The API URL and routing deadline have no flags: they end global parsing like any unknown word.
  assert.deepEqual(parseGlobal(["--api-url", "http://x.test", "claude"]).flags, {});
  assert.deepEqual(parseGlobal(["--routing-timeout=1", "claude"]).flags, {});
});

// ------------------------------------------------------------------ config wizard

test("config wizard writes config.json and a separate credentials.json", async () => {
  const r = await cli(["config"], { input: `${KEY}\nquality\ny\n` });
  assert.equal(r.code, 0, r.err);
  const dir = join(r.home, ".krun-router");
  assert.deepEqual(readJson(join(dir, "config.json")), { mode: "quality", debug: true });
  assert.deepEqual(readJson(join(dir, "credentials.json")), { apiKey: KEY });
  assert.ok(!readFileSync(join(dir, "config.json"), "utf8").includes(KEY), "API key is not in config.json");
  assert.ok(!r.out.includes(KEY), "the key is never printed");
  assert.match(r.out, /Configuration saved to:/);
});

test("config wizard: blank answers keep defaults, invalid answers are re-asked", async () => {
  const r = await cli(["config"], { input: `${KEY}\nfast\n\nmaybe\n\n` });
  assert.equal(r.code, 0);
  assert.match(r.out, /Mode must be one of: economy, balanced, quality/);
  assert.match(r.out, /answer y or n/);
  assert.doesNotMatch(r.out, /API URL|Routing timeout/, "fixed values are not asked");
  assert.deepEqual(readJson(join(r.home, ".krun-router", "config.json")), { mode: "balanced", debug: false });
});

test("config wizard: an existing key is kept on Enter and legacy values are offered as defaults", async () => {
  const home = tmp();
  writeFileSync(join(home, ".krun-router.env"), `KRUN_API_KEY=${KEY}\nKRUN_DEBUG=1\n`);
  const r = await cli(["config"], { home, input: "\n\n" });
  assert.match(r.out, /Existing legacy configuration detected/);
  assert.match(r.out, /krun_live_••••••••Fk2/);
  assert.ok(!r.out.includes(KEY));
  assert.equal(readJson(join(home, ".krun-router", "credentials.json")).apiKey, KEY);
  assert.equal(readJson(join(home, ".krun-router", "config.json")).debug, true);
  assert.ok(existsSync(join(home, ".krun-router.env")), "legacy file is never deleted");
});

// ------------------------------------------------------------------ precedence

test("config precedence: flags > environment > saved files > legacy file > defaults", async () => {
  const home = tmp();
  writeFileSync(join(home, ".krun-router.env"), "KRUN_DEBUG=1\nKRUN_API_KEY=krun_live_legacy000\n");
  assert.equal(loadConfig({ env: {}, home }).apiKey, "krun_live_legacy000");
  await cli(["config", "set", "api-key", "krun_live_saved0000"], { home });
  let c = loadConfig({ env: {}, home });
  assert.deepEqual([c.apiKey, c.sources.apiKey, c.debug, c.sources.debug], ["krun_live_saved0000", "credentials", true, "legacy"]);
  assert.deepEqual([c.status, c.sources.status], [true, "default"]);
  c = loadConfig({ env: { KRUN_API_KEY: "krun_live_env00000", KRUN_NO_STATUS: "1" }, home });
  assert.deepEqual([c.apiKey, c.status], ["krun_live_env00000", false]);
  c = loadConfig({ env: { KRUN_NO_STATUS: "1" }, home, flags: { status: true } });
  assert.deepEqual([c.status, c.sources.status], [true, "flag"]);
});

test("the API URL and routing deadline are fixed at every level", () => {
  const home = tmp();
  writeFileSync(join(home, ".krun-router.env"), "KRUN_API_URL=http://legacy.test\nKRUN_ROUTING_TIMEOUT_MS=100\n");
  mkdirSync(join(home, ".krun-router"));
  writeFileSync(join(home, ".krun-router", "config.json"), JSON.stringify({ apiUrl: "http://saved.test", routingTimeoutMs: 200 }));
  const c = loadConfig({
    env: { KRUN_API_URL: "http://env.test", KRUN_ROUTING_TIMEOUT_MS: "300" },
    home,
    flags: { apiUrl: "http://flag.test", routingTimeoutMs: 400 },
  });
  assert.deepEqual([c.apiUrl, c.routingTimeoutMs], ["https://api.krun.ai", 5000]);
});

test("environment overrides saved configuration, and config set says so", async () => {
  const home = tmp();
  const r = await cli(["config", "set", "debug", "on"], { home, env: { KRUN_DEBUG: "0" } });
  assert.match(r.out, /KRUN_DEBUG in your environment overrides the saved value/);
  assert.equal(loadConfig({ env: { KRUN_DEBUG: "0" }, home }).debug, false);
  assert.equal(loadConfig({ env: {}, home }).debug, true);
});

test("a project .env is ignored (it could redirect prompts to another server)", () => {
  const home = tmp();
  const cwd = tmp();
  writeFileSync(join(cwd, ".env"), "KRUN_API_URL=http://evil.test\n");
  const prev = process.cwd();
  process.chdir(cwd);
  try {
    assert.equal(loadConfig({ env: {}, home }).apiUrl, "https://api.krun.ai");
  } finally {
    process.chdir(prev);
  }
});

// ------------------------------------------------------------------ show / set / reset

test("config show masks the API key and shows sources", async () => {
  const home = tmp();
  await cli(["config", "set", "api-key", KEY], { home });
  const r = await cli(["config", "show"], { home });
  assert.ok(!r.out.includes(KEY));
  assert.match(r.out, /API key\s+krun_live_••••••••Fk2\s+credentials/);
  assert.match(r.out, /API URL\s+https:\/\/api\.krun\.ai\s+fixed/);
  assert.match(r.out, /Routing timeout\s+5000 ms\s+fixed/);
  assert.equal(maskKey("short"), "••••••••");
  assert.equal(maskKey("krun_live_abc"), "••••••••");
  assert.equal(maskKey(null), "not set");
});

test("config set validates values and never echoes the key", async () => {
  const home = tmp();
  const bad = [
    [["routing-timeout", "1500"], /unknown key/],
    [["debug", "maybe"], /true\/false/],
    [["status", ""], /true\/false/],
    [["api-url", "http://x.test"], /unknown key/],
    [["api-key", "   "], /must not be blank/],
    [["colour", "red"], /unknown key/],
  ];
  for (const [args, msg] of bad) {
    const r = await cli(["config", "set", ...args], { home });
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.err, msg);
  }
  for (const v of ["on", "off", "yes", "no", "true", "false"]) assert.equal((await cli(["config", "set", "debug", v], { home })).code, 0);
  const k = await cli(["config", "set", "api-key", KEY], { home });
  assert.equal(k.out, "API key updated.\n");
  const prompted = await cli(["config", "set", "api-key"], { home, input: "krun_live_fromprompt1\n" });
  assert.ok(!prompted.out.includes("krun_live_fromprompt1"));
  assert.equal(loadConfig({ env: {}, home }).apiKey, "krun_live_fromprompt1");
  assert.equal((await cli(["config", "set", "status", "off"], { home })).out, "status set to off.\n");
  assert.equal(loadConfig({ env: {}, home }).status, false);
});

test("config reset refuses without confirmation", async () => {
  const home = tmp();
  await cli(["config", "set", "api-key", KEY], { home });
  for (const input of ["", "n\n", "whatever\n"]) {
    const r = await cli(["config", "reset"], { home, input });
    assert.equal(r.code, 1);
    assert.match(r.err, /Cancelled/);
    assert.ok(existsSync(join(home, ".krun-router", "credentials.json")));
  }
});

test("config reset with confirmation or --yes removes only this project's files", async () => {
  const home = tmp();
  writeFileSync(join(home, ".krun-router.env"), "KRUN_DEBUG=1\n");
  await cli(["config", "set", "api-key", KEY], { home });
  await cli(["config", "set", "debug", "on"], { home });
  const r = await cli(["config", "reset"], { home, input: "y\n" });
  assert.equal(r.code, 0);
  assert.equal(existsSync(join(home, ".krun-router")), false);
  assert.ok(existsSync(join(home, ".krun-router.env")), "legacy file untouched");
  assert.match(r.out, /left untouched/);

  await cli(["config", "set", "api-key", KEY], { home });
  writeFileSync(join(home, ".krun-router", "notes.txt"), "user file");
  const y = await cli(["config", "reset", "--yes"], { home });
  assert.equal(y.code, 0);
  assert.equal(existsSync(join(home, ".krun-router", "credentials.json")), false);
  assert.ok(existsSync(join(home, ".krun-router", "notes.txt")), "unrelated files are kept");
  assert.equal((await cli(["config", "reset", "--yes"], { home: tmp() })).out, "No saved configuration to remove.\n");
});

test("config and credentials files are private", async () => {
  const home = tmp();
  await cli(["config"], { home, input: `${KEY}\n\n\n\n` });
  const dir = join(home, ".krun-router");
  if (process.platform === "win32") {
    const acl = execFileSync("icacls", [join(dir, "credentials.json")], { encoding: "utf8" });
    assert.ok(!acl.includes("(I)"), `no inherited ACL entries:\n${acl}`);
    assert.ok(!/Everyone|BUILTIN\\Users/i.test(acl));
  } else {
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, "credentials.json")).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "config.json")).mode & 0o777, 0o600);
  }
});

// ------------------------------------------------------------------ doctor

const present = () => ({ file: "x", prefix: [], shell: false });
const missing = () => null;

async function doctor({ status = 200, target, resolve = present, key = KEY, home = tmp() } = {}) {
  const krun = await mockServer((req, res) => {
    if (req.url === "/health") return json(res, 200, { status: "ok" });
    json(res, status, status === 200 ? { data: [] } : { error: { code: status === 401 ? "UNAUTHORIZED" : "X", message: `secret body ${KEY}` } });
  });
  try {
    const env = key ? { KRUN_API_KEY: key } : {};
    const config = loadConfig({ env, home });
    // The URL is fixed, so the test redirects it to the mock at the fetch layer.
    const fetchImpl = (url, opts) => fetch(String(url).replace(config.apiUrl, target ?? krun.url), opts);
    const stdout = sink();
    const code = await doctorCommand([], { config, env, home, stdout }, { resolve, fetchImpl, timeoutMs: 1000 });
    return { code, out: stdout.text, requests: krun.requests };
  } finally {
    await krun.close();
  }
}

test("doctor with a valid mock API is ready and validates auth without inference", async () => {
  const r = await doctor();
  assert.match(r.out, /✓ .* reachable/);
  assert.match(r.out, /✓ Krun authentication valid/);
  assert.match(r.out, /✓ Claude Code detected/);
  assert.match(r.out, /✓ Codex detected/);
  assert.equal(r.code, 0);
  assert.deepEqual(r.requests.map((q) => `${q.method} ${q.url}`), ["GET /health", "GET /v1/models"]);
  assert.equal(r.requests[1].headers.authorization, `Bearer ${KEY}`);
  assert.ok(!r.out.includes(KEY));
});

test("doctor with 401 reports an invalid key, actionable and without the body", async () => {
  const r = await doctor({ status: 401 });
  assert.equal(r.code, 1);
  assert.match(r.out, /✗ Krun API key is invalid \(HTTP 401 UNAUTHORIZED\)\n  Run: krun-router config set api-key <key>/);
  assert.ok(!r.out.includes("secret body"));
  assert.ok(!r.out.includes(KEY));
});

test("doctor classifies 403, 429 and 5xx", async () => {
  assert.match((await doctor({ status: 403 })).out, /✗ .*HTTP 403/);
  const limited = await doctor({ status: 429 });
  assert.match(limited.out, /! Krun rate limit reached/);
  assert.equal(limited.code, 0, "429 is a warning");
  const down = await doctor({ status: 503 });
  assert.match(down.out, /! Krun API error \(HTTP 503/);
  assert.equal(down.code, 0);
});

test("doctor with a network failure reports the API unreachable", async () => {
  const r = await doctor({ target: "http://127.0.0.1:1" });
  assert.equal(r.code, 1);
  assert.match(r.out, /✗ https:\/\/api\.krun\.ai unreachable/);
  assert.match(r.out, /! Krun authentication not checked \(API unreachable\)/);
});

test("doctor: a missing coding CLI is only a warning while another is present", async () => {
  const noClaude = await doctor({ resolve: (n) => (n === "claude" ? null : present()) });
  assert.match(noClaude.out, /! Claude Code not found\n  Claude routing will be unavailable; Codex, OpenCode, Kimi routing can still be used\./);
  assert.equal(noClaude.code, 0);
  const onlyCodex = await doctor({ resolve: (n) => (n === "codex" ? present() : null) });
  assert.match(onlyCodex.out, /! OpenCode not found\n  OpenCode routing will be unavailable; Codex routing can still be used\./);
  assert.match(onlyCodex.out, /! Kimi Code not found/);
  assert.equal(onlyCodex.code, 0);
  const neither = await doctor({ resolve: missing });
  assert.equal(neither.code, 1);
});

test("doctor without an API key is an actionable error", async () => {
  const r = await doctor({ key: null });
  assert.equal(r.code, 1);
  assert.match(r.out, /✗ No Krun API key configured; routing is off\n  Run: krun-router config set api-key <key>/);
});

test("doctor reads model catalogs from the (temporary) home", async () => {
  const home = tmp();
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "models_cache.json"), JSON.stringify({ models: [{ slug: "m1", visibility: "list" }, { slug: "m2", visibility: "list" }] }));
  const r = await doctor({ home });
  assert.match(r.out, /✓ Codex model catalog available \(2 models\)/);
  assert.match(r.out, /! Claude model catalog not cached yet/);
});

// ------------------------------------------------------------------ secrets

test("secrets never appear in command output, errors or the Krun exchange record", async () => {
  const home = tmp();
  await cli(["config", "set", "api-key", KEY], { home });
  for (const argv of [["config", "show"], ["--debug", "config", "show"], ["config", "set", "debug", "nope"], ["config", "set", "api-url", KEY]]) {
    const r = await cli(argv, { home });
    assert.ok(!r.out.includes(KEY) && !r.err.includes(KEY), argv.join(" "));
  }
  const exchange = await createKrunClient({ apiKey: KEY, apiUrl: "http://127.0.0.1:1", timeoutMs: 200 }).decide("p", ["a", "b"].map((id) => normalizeModel({ id })));
  assert.ok(!JSON.stringify(exchange).includes(KEY), "recorded exchanges (used by explain) hold no credentials");
});

// ------------------------------------------------------------------ package, aliases, forwarding

test("package.json exposes krun-router and its aliases", () => {
  assert.equal(PKG.name, "krun-router");
  assert.equal(PKG.author, "Rafael Ferres");
  assert.match(PKG.repository.url, /github\.com\/rafaelferres\/krun-router/);
  assert.deepEqual(PKG.bin, {
    "krun-router": "bin/krun-router.mjs",
    "krun-claude": "bin/krun-claude.mjs",
    "krun-codex": "bin/krun-codex.mjs",
    "krun-explain": "bin/krun-explain.mjs",
    "krun-opencode": "bin/krun-opencode.mjs",
    "krun-kimi": "bin/krun-kimi.mjs",
  });
  for (const file of Object.values(PKG.bin)) {
    const text = readFileSync(join(ROOT, file), "utf8");
    assert.ok(text.startsWith("#!/usr/bin/env node\n"), file);
    assert.match(text, /from "\.\.\/src\/cli\/main\.mjs"/, `${file} delegates to the one CLI implementation`);
  }
  assert.match(readFileSync(join(ROOT, "bin/krun-claude.mjs"), "utf8"), /main\(\["claude", \.\.\.process\.argv\.slice\(2\)\]\)/);
  assert.match(readFileSync(join(ROOT, "bin/krun-codex.mjs"), "utf8"), /main\(\["codex", \.\.\.process\.argv\.slice\(2\)\]\)/);
  assert.match(readFileSync(join(ROOT, "bin/krun-explain.mjs"), "utf8"), /main\(\["explain", \.\.\.process\.argv\.slice\(2\)\]\)/);
  assert.deepEqual([...PKG.files].sort(), ["LICENSE", "README.md", "bin/", "eval/escalation.jsonl", "eval/families.json", "eval/holdout.jsonl", "eval/routing.jsonl", "skills/", "src/"]);
});

/** A fake `claude`/`codex` on PATH that records the arguments and routing env it was given. */
function fakeCli(name) {
  const dir = tmp("krun-fake-");
  const out = join(dir, "out.json");
  const body = `require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), base: process.env.ANTHROPIC_BASE_URL || null, session: process.env.KRUN_ROUTER_SESSION || null }));`;
  if (process.platform === "win32") {
    writeFileSync(join(dir, `fake-${name}.js`), body);
    writeFileSync(join(dir, `${name}.cmd`), `@ECHO off\r\n"%dp0%\\fake-${name}.js" %*\r\n`);
  } else {
    writeFileSync(join(dir, name), `#!/usr/bin/env node\n${body}`);
    chmodSync(join(dir, name), 0o755);
  }
  return { dir, read: () => readJson(out) };
}

function runBin(bin, args, { pathDir, home = tmp(), key = null }) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, KRUN_API_URL: "http://127.0.0.1:1", KRUN_NO_STATUS: "1" };
  for (const k of Object.keys(env)) if (k.toLowerCase() === "path" || k === "KRUN_API_KEY") delete env[k];
  // POSIX shebangs need `node` on PATH; the fake CLI directory comes first.
  env.PATH = process.platform === "win32" ? pathDir : `${pathDir}:${dirname(process.execPath)}`;
  if (key) env.KRUN_API_KEY = key;
  return spawnSync(process.execPath, [join(ROOT, "bin", bin), ...args], { env, encoding: "utf8", timeout: 20000 });
}

const TRICKY = ["--resume", "abc", "-p", "a prompt with spaces & \"quotes\"", "%PATH%", "--flag=value", "", "ünïcødé", "--help"];

test("Claude: arguments are forwarded unchanged, identically via krun-router claude and krun-claude", () => {
  const fake = fakeCli("claude");
  const a = runBin("krun-router.mjs", ["claude", ...TRICKY], { pathDir: fake.dir });
  assert.equal(a.status, 0, a.stderr);
  const viaRouter = fake.read();
  runBin("krun-claude.mjs", TRICKY, { pathDir: fake.dir });
  const viaAlias = fake.read();
  assert.deepEqual(viaRouter.argv, TRICKY, "no key: exactly the user's arguments");
  assert.deepEqual(viaAlias.argv, viaRouter.argv);

  runBin("krun-claude.mjs", TRICKY, { pathDir: fake.dir, key: "krun_live_testkey123" });
  const routed = fake.read();
  assert.deepEqual(routed.argv.slice(0, TRICKY.length), TRICKY, "with routing: user arguments first and unchanged");
  assert.equal(routed.argv[TRICKY.length], "--add-dir");
  assert.match(routed.base, /^http:\/\/127\.0\.0\.1:\d+$/, "Claude Code is pointed at the local proxy");
  assert.match(routed.session, /^claude-/);
});

test("Codex: arguments are forwarded unchanged, identically via krun-router codex and krun-codex", () => {
  const fake = fakeCli("codex");
  const args = ["exec", "fix the tests", ...TRICKY];
  runBin("krun-router.mjs", ["codex", ...args], { pathDir: fake.dir });
  const viaRouter = fake.read();
  runBin("krun-codex.mjs", args, { pathDir: fake.dir });
  assert.deepEqual(viaRouter.argv, args);
  assert.deepEqual(fake.read().argv, args);

  const home = tmp();
  runBin("krun-codex.mjs", args, { pathDir: fake.dir, key: "krun_live_testkey123", home });
  const routed = fake.read();
  assert.deepEqual(routed.argv.slice(-args.length), args, "with routing: user arguments last and unchanged");
  assert.ok(routed.argv.some((a) => a.startsWith("model_providers.krun.base_url=")));
  assert.ok(existsSync(join(home, ".agents", "skills", "krun-explain", "SKILL.md")), "skill installed into the (temporary) home");
});

test("krun-explain and krun-router explain are the same implementation", () => {
  const empty = tmp();
  const a = runBin("krun-explain.mjs", ["--help"], { pathDir: empty });
  const b = runBin("krun-router.mjs", ["explain", "--help"], { pathDir: empty });
  assert.equal(a.stdout, b.stdout);
  assert.match(a.stdout, /Usage: krun-router explain/);
  const c = runBin("krun-explain.mjs", ["no-such-session"], { pathDir: empty });
  const d = runBin("krun-router.mjs", ["explain", "no-such-session"], { pathDir: empty });
  assert.equal(c.stdout, d.stdout);
});

test("launchers report a missing CLI instead of crashing", () => {
  const r = runBin("krun-router.mjs", ["codex"], { pathDir: tmp() });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Codex is not installed/);
});
