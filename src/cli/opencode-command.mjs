import { join } from "node:path";
import { ROOT, createRouting, resolveBinary, run } from "../launch.mjs";
import { LOG_FILE } from "../log.mjs";
import { formatExplanation } from "../explain.mjs";
import { readHistory } from "../status.mjs";
import { createOpencodeRouting, opencodeLaunch, startBridge } from "../adapters/opencode.mjs";

export const OPENCODE_HELP = `Usage: krun-router opencode [opencode arguments...]
Alias: krun-opencode [opencode arguments...]

Launches your installed OpenCode (v2) with per-turn routing between the models of the
provider you selected. Every argument after \`opencode\` is passed to OpenCode unchanged.
Routing needs OpenCode's private server (--standalone, added for you); with --server, or
without a Krun API key, OpenCode starts without routing.

Inside OpenCode: a toast shows each new routing decision; /krun-explain shows the last one; choosing a model in /models pauses
routing for that session and /krun-auto resumes it.
`;

/** Runs OpenCode with routing. `args` reach the real `opencode` untouched, plus --standalone. */
export async function opencodeCommand(args, { config, env, stderr }) {
  const opencode = resolveBinary("opencode", { env });
  if (!opencode) {
    stderr.write(
      "[krun] OpenCode is not installed or `opencode` is not on your PATH.\n" +
        "[krun] krun-router opencode runs your real OpenCode; install it first: https://opencode.ai/docs\n",
    );
    return 1;
  }
  if (!config.apiKey) {
    stderr.write("[krun] no Krun API key configured: starting OpenCode without routing.\n[krun] run `krun-router config` to enable it.\n");
    return run(opencode, args, env);
  }

  const { sessionId, history, router } = createRouting({ cli: "opencode", config });
  const routing = createOpencodeRouting({ router, history });
  const bridge = await startBridge({
    route: (body) => routing.route(body),
    resume: ({ sessionID }) => routing.resume(sessionID),
    status: ({ sessionID }) => ({ text: routing.status(sessionID) }),
    usage: ({ sessionID, model, ...tokens }) => history.recordUsage({ ...tokens, model, conversation: sessionID }),
    explain: async () => {
      await history.flush();
      return { text: formatExplanation(readHistory(sessionId)) };
    },
  });

  const launch = opencodeLaunch({
    userArgs: args,
    env: { ...env, KRUN_ROUTER_SESSION: sessionId },
    pluginDir: join(ROOT, "src", "opencode-plugin"),
    bridgeUrl: bridge.url,
  });
  if (launch.reason) stderr.write(`[krun] starting OpenCode without routing: ${launch.reason}.\n`);
  if (config.debug) stderr.write(`[krun] routing log: ${LOG_FILE}\n`);

  const code = await run(opencode, launch.args, launch.env);
  await bridge.close();
  await history.flush();
  return code;
}
