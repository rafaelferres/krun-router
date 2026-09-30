#!/usr/bin/env node
// Status line for Claude Code (https://code.claude.com/docs/en/statusline) and Kimi Code
// (tui.toml [status_line].command). Both pipe session JSON on stdin. Outside a routed session
// (no KRUN_ROUTER_SESSION) it shows the CLI's own model, so an opt-in line stays truthful.
import { basename } from "node:path";
import { readHistory, statusText } from "../src/status.mjs";

let input = {};
try {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  input = JSON.parse(Buffer.concat(chunks).toString() || "{}");
} catch {
  // a malformed payload still gets a status line
}
const dir = basename(input.workspace?.current_dir ?? input.cwd ?? "");
const session = process.env.KRUN_ROUTER_SESSION;
const own = typeof input.model === "string" ? input.model : (input.model?.display_name ?? "");
const text = session ? statusText(readHistory(session)) : own;
process.stdout.write(`${[text, dir].filter(Boolean).join(" · ")}\n`);
