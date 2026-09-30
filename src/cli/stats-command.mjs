// Summarizes the local, prompt-free usage ledger that routed sessions append to.
import { join } from "node:path";
import { usageLedger } from "../launch.mjs";
import { computeStats, formatStats, loadPrices, readLedger } from "../stats.mjs";

export const STATS_HELP = `Usage: krun-router stats [--days N] [--cli claude|codex|opencode|kimi] [--json]

Turns routed vs kept (and why), Krun latency (p50/p95) and timeout rate, tokens per model,
and estimated cost and savings. Read from ~/.krun-router/usage.jsonl, which routed sessions
append to (no prompts are stored there).

How cost and savings are estimated:
  - Token counts are what the provider reported for each request (OpenCode: what OpenCode
    recorded, with its own cost when it reports one).
  - Prices are list prices per million tokens for Claude models; other models show tokens
    only unless you add prices to ~/.krun-router/prices.json:
      { "model-id": [input, output, cacheRead, cacheWrite] }
  - Savings compare every request with the same tokens on the model its conversation started
    on. Tokens a switched model had to write to its cache are priced as cache reads on that
    starting model, which would still have had them cached, so the estimate leans against
    routing. Output length is assumed the same on either model.
`;

const flag = (args, name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

export async function statsCommand(args, { config, stdout, stderr }) {
  if (args.includes("--help") || args.includes("-h")) return stdout.write(STATS_HELP), 0;
  const days = flag(args, "--days");
  if (days !== undefined && !/^\d+$/.test(days)) return stderr.write("--days must be a whole number\n"), 1;
  const cli = flag(args, "--cli");
  const events = readLedger(usageLedger(config), { days: days && Number(days), cli });
  const stats = computeStats(events, loadPrices(join(config.paths.dir, "prices.json")));
  stdout.write(args.includes("--json") ? `${JSON.stringify(stats, null, 2)}\n` : formatStats(stats, { days: days && Number(days), cli }));
  return 0;
}
