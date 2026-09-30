import { spawn } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createKrunClient } from "./krun-client.mjs";
import { createRouter } from "./router.mjs";
import { createHistory, pruneStale } from "./status.mjs";
import { setDebug } from "./log.mjs";

/** Package root (holds bin/, skills/ and package.json). */
export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * npm installs CLIs on Windows as `.cmd` shims. Running a shim needs a shell, and a shell
 * re-parses arguments (quotes, `&`, `%`), which would corrupt what the user typed. The shim's
 * real target is read out of it instead, so arguments are passed as an array, untouched.
 */
export function parseCmdShim(text, dir) {
  const targets = [...text.matchAll(/"%~?dp0%?\\([^"]+)"/g)].map((m) => join(dir, m[1]));
  const target = targets.at(-1);
  if (!target) return null;
  if (/\.exe$/i.test(target)) return { file: target, prefix: [] };
  if (/\.[cm]?js$/i.test(target)) return { file: process.execPath, prefix: [target] };
  return null;
}

export function resolveBinary(name, { env = process.env, platform = process.platform } = {}) {
  const win = platform === "win32";
  for (const raw of (env.PATH ?? env.Path ?? "").split(win ? ";" : delimiter)) {
    const dir = raw.replace(/^"|"$/g, "");
    if (!dir) continue;
    for (const ext of win ? [".exe", ".cmd", ".bat"] : [""]) {
      const file = join(dir, `${name}${ext}`);
      try {
        accessSync(file, win ? constants.F_OK : constants.X_OK);
      } catch {
        continue;
      }
      if (!/\.(cmd|bat)$/i.test(file)) return { file, prefix: [], shell: false };
      try {
        const shim = parseCmdShim(readFileSync(file, "utf8"), dirname(file));
        if (shim) return { ...shim, shell: false };
      } catch {
        // unreadable shim: fall back to running it through the shell
      }
      return { file, prefix: [], shell: true };
    }
  }
  return null;
}

const quoteForCmd = (a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);

/** Runs the real CLI with inherited stdio; resolves with its exit code. */
export function run(cmd, args, env) {
  const all = [...cmd.prefix, ...args];
  return new Promise((resolve) => {
    const child = spawn(cmd.file, cmd.shell ? all.map(quoteForCmd) : all, { stdio: "inherit", env, shell: cmd.shell });
    // Ctrl+C reaches the child directly (same console); the wrapper must outlive it to clean up.
    const ignore = () => {};
    process.on("SIGINT", ignore);
    child.on("error", (err) => {
      process.stderr.write(`[krun] could not start ${cmd.file}: ${err.message}\n`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      process.off("SIGINT", ignore);
      resolve(signal ? 1 : (code ?? 0));
    });
  });
}

/** Prompt-free usage/decision log read by `krun-router stats`. */
export const usageLedger = (config) => join(config.paths.dir, "usage.jsonl");

/** Router, Krun client and decision history for one CLI session. */
export function createRouting({ cli, config }) {
  setDebug(config.debug);
  pruneStale().catch(() => {});
  const sessionId = `${cli}-${process.pid}-${Date.now().toString(36)}`;
  const history = createHistory({ sessionId, cli, ledger: usageLedger(config) });
  const krun = createKrunClient({ apiKey: config.apiKey, apiUrl: config.apiUrl, timeoutMs: config.routingTimeoutMs });
  krun.warm();
  const router = createRouter({
    krun,
    allowlist: config.models,
    mode: config.mode,
    onDecision: (d) => history.record(d),
    onManual: (m) => history.recordManual(m),
  });
  return { sessionId, history, router };
}
