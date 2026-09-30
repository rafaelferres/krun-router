import { readFileSync, readdirSync, statSync } from "node:fs";
import { appendFile, mkdir, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { STATE_DIR } from "./log.mjs";

export const HISTORY_DIR = STATE_DIR;
export const HISTORY_LIMIT = 20;
export const STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

const fileFor = (dir, sessionId) => join(dir, `${String(sessionId).replace(/[^\w.-]/g, "")}.json`);

/**
 * Routing decisions for one CLI session, kept in memory and mirrored to a private temp file
 * so `krun-explain` and the status line can read the original exchange later without asking
 * Krun again. Writes are asynchronous and serialized; the proxy never waits on them.
 * Files hold prompts, so the directory is 0700 and files 0600 (POSIX; Windows temp dirs are
 * already per-user).
 */
export function createHistory({ sessionId, cli, dir = HISTORY_DIR, limit = HISTORY_LIMIT, ledger = null }) {
  const data = { sessionId, cli, manual: null, decisions: [] };
  const file = fileFor(dir, sessionId);
  let writing = Promise.resolve();
  // `krun-router stats` input: one JSON line per event, never a prompt. Outlives the 20-decision
  // session file. ponytail: grows forever (~200 bytes a request); rotate if it ever matters.
  let appending = Promise.resolve();
  const append = (event) => {
    if (!ledger) return;
    const line = `${JSON.stringify({ ...event, at: event.at ?? Date.now(), cli, session: sessionId })}\n`;
    appending = appending
      .then(() => mkdir(dirname(ledger), { recursive: true, mode: 0o700 }))
      .then(() => appendFile(ledger, line, { mode: 0o600 }))
      .catch(() => {});
  };
  const flush = () => {
    const text = JSON.stringify(data);
    const tmp = `${file}.${process.pid}.tmp`;
    writing = writing
      .then(() => mkdir(dir, { recursive: true, mode: 0o700 }))
      .then(() => writeFile(tmp, text, { mode: 0o600 }))
      .then(() => rename(tmp, file)) // readers never see a half-written file
      .catch(() => {}); // history is diagnostic and must never affect a request
    return writing;
  };
  return {
    data,
    file,
    record(decision) {
      data.decisions.push(decision);
      if (data.decisions.length > limit) data.decisions.splice(0, data.decisions.length - limit);
      data.manual = null;
      flush();
      append({
        type: "decision",
        at: decision.at,
        conversation: decision.conversation,
        model: decision.model,
        previous: decision.currentModel,
        reason: decision.reason,
        fallback: decision.fallback,
        confidence: decision.confidence ?? null,
        kind: decision.kind ?? null,
        tier: decision.tier ?? null,
        latencyMs: decision.krun?.latencyMs ?? null,
        krunError: decision.krun?.error ?? null,
      });
    },
    recordManual(info) {
      data.manual = info;
      flush();
      append({ type: "manual", at: info.at, conversation: info.conversation, model: info.model });
    },
    /** Tokens one provider response used; also summed into that conversation's latest decision. */
    recordUsage({ conversation, model, input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost }) {
      const usage = { input, output, cacheRead, cacheWrite };
      append({ type: "usage", conversation, model, ...usage, ...(Number.isFinite(cost) ? { cost } : {}) });
      const d = data.decisions.findLast((x) => x.conversation === conversation);
      if (!d) return;
      d.usage ??= { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      d.usage.requests++;
      for (const k of Object.keys(usage)) d.usage[k] += usage[k];
      flush();
    },
    flush: () => Promise.all([writing, appending]),
  };
}

export function readHistory(sessionId, dir = HISTORY_DIR) {
  if (!sessionId) return null;
  try {
    return JSON.parse(readFileSync(fileFor(dir, sessionId), "utf8"));
  } catch {
    return null;
  }
}

/** The most recently updated session, for `krun-explain` run outside a routed CLI. */
export function latestHistory(dir = HISTORY_DIR) {
  try {
    const newest = readdirSync(dir)
      .filter((n) => n.endsWith(".json"))
      .map((n) => ({ n, t: statSync(join(dir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0];
    return newest ? JSON.parse(readFileSync(join(dir, newest.n), "utf8")) : null;
  } catch {
    return null;
  }
}

/** Deletes session files untouched for `maxAgeMs`. Called once at launch, off the hot path. */
export async function pruneStale(dir = HISTORY_DIR, maxAgeMs = STALE_AFTER_MS, now = Date.now()) {
  let removed = 0;
  let names = [];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  for (const n of names) {
    if (!/\.(json|tmp)$/.test(n)) continue;
    const f = join(dir, n);
    try {
      if (now - (await stat(f)).mtimeMs > maxAgeMs) {
        await unlink(f);
        removed++;
      }
    } catch {
      // removed or replaced by another session meanwhile
    }
  }
  return removed;
}

export const latestDecision = (history) => history?.decisions?.at(-1) ?? null;

/** One short line: `[Krun] → model (0.91)`. Confidence only when Krun actually decided. */
export function statusText(history) {
  const d = latestDecision(history);
  const manual = history?.manual;
  if (manual && (!d || manual.at >= d.at)) return `[Krun] paused · manual model ${manual.model}`;
  if (!d) return "[Krun] waiting for first prompt";
  const conf = !d.fallback && d.confidence != null ? ` (${d.confidence.toFixed(2)})` : "";
  const why = d.fallback ? ` · kept: ${d.reason}` : "";
  return `[Krun] → ${d.model}${conf}${why}`;
}
