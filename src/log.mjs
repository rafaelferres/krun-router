import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const STATE_DIR = join(tmpdir(), "krun-router");
export const LOG_FILE = join(STATE_DIR, "router.log");

const SECRET_PATTERNS = [
  /\b(authorization|x-api-key|cookie|chatgpt-account-id)(["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^"',\s}]+/gi,
  /\bBearer\s+[\w.~+/=-]+/gi,
  /\b(?:sk-[\w-]{8,}|krun_(?:live|test)_[\w-]+|sess-[\w-]{8,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)/g,
];

/** Last line of defence: nothing logged should contain credentials, even by accident. */
export function redact(text) {
  return SECRET_PATTERNS.reduce(
    // Patterns without groups pass the match offset (a number) as the second argument.
    (out, re) => out.replace(re, (m, name, sep) => (typeof name === "string" ? `${name}${sep}[redacted]` : "[redacted]")),
    String(text),
  );
}

let enabled = false;
let queue = Promise.resolve();

export function setDebug(on) {
  enabled = Boolean(on);
}

export const isDebug = () => enabled;

/**
 * The coding agent owns the terminal and redraws over stray output, so debug lines go to a
 * file. Writes are queued and never awaited by callers: logging must not add latency.
 */
export function debug(line) {
  if (!enabled) return;
  const text = `${new Date().toISOString()} ${redact(line)}\n`;
  queue = queue
    .then(() => mkdir(STATE_DIR, { recursive: true, mode: 0o700 }))
    .then(() => appendFile(LOG_FILE, text, { mode: 0o600 }))
    .catch(() => {});
}

/** Waits for queued log writes; used by tests. */
export const flushLog = () => queue;

/** Writes a request body (never headers) for diagnosis. Only called when KRUN_DUMP_DIR is set. */
export function dump(dir, label, body) {
  const file = join(dir, `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  mkdir(dir, { recursive: true, mode: 0o700 })
    .then(() => writeFile(file, body, { mode: 0o600 }))
    .catch(() => {});
}
