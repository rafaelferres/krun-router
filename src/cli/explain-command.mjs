// Prints the routing decision recorded for a session. Reads local history only; it never
// asks Krun again, so what it shows is exactly the exchange that chose the model.
import { formatExplanation, formatHistory } from "../explain.mjs";
import { latestHistory, readHistory } from "../status.mjs";

export const EXPLAIN_HELP = `Usage: krun-router explain [session-id] [--history] [--json]
Alias: krun-explain

Shows why the most recent prompt was routed to its model, from the locally recorded
decision (no new Krun request). Inside a routed CLI the current session is used;
otherwise the most recently active session.

  --history   one line per recent decision
  --json      the full recorded exchange
`;

export async function explainCommand(args, { env, stdout }) {
  if (args.includes("--help") || args.includes("-h")) return stdout.write(EXPLAIN_HELP), 0;
  const id = args.find((a) => !a.startsWith("-")) ?? env.KRUN_ROUTER_SESSION;
  const history = id ? readHistory(id) : latestHistory();
  if (args.includes("--json")) stdout.write(`${JSON.stringify(history, null, 2)}\n`);
  else if (args.includes("--history")) stdout.write(`${formatHistory(history)}\n`);
  else stdout.write(`${formatExplanation(history)}\n`);
  return 0;
}
