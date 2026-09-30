import { randomBytes } from "node:crypto";
import http from "node:http";
import { normalizeModel } from "../catalog.mjs";
import { debug } from "../log.mjs";
import { statusText } from "../status.mjs";

/**
 * OpenCode v2 needs no proxy: a plugin loaded into OpenCode's own server switches the session
 * model (`ctx.session.switchModel`) from the `prompt` hook, which runs once per human prompt
 * before the turn starts. The plugin asks this process over a loopback "bridge" so routing,
 * history and explain records stay in the one place every other CLI uses.
 */

// Commands that talk to a model and accept --standalone. Other subcommands run untouched.
const ROUTED = new Set(["run", "mini"]);
const OTHER = new Set(["upgrade", "update", "uninstall", "acp", "api", "debug", "auth", "mcp", "plugin", "models", "stats", "session", "service", "reload", "pair", "serve", "help"]);

/**
 * Arguments and environment for the real OpenCode. The plugin reaches the model-calling
 * process only when that process is our own child: the shared background service was started
 * with someone else's environment, hence --standalone. `OPENCODE_CONFIG_CONTENT` has the
 * highest config precedence and adds to (never replaces) the user's plugins.
 * @returns {{ args: string[], env: object, routed: boolean, reason?: string }}
 */
export function opencodeLaunch({ userArgs, env, pluginDir, bridgeUrl }) {
  const plain = (reason) => ({ args: [...userArgs], env, routed: false, reason });
  const sub = userArgs[0];
  if (OTHER.has(sub) || userArgs.includes("--help") || userArgs.includes("-h")) return plain();
  if (userArgs.some((a) => a === "--server" || a.startsWith("--server="))) {
    return plain("--server connects to a server started elsewhere, which cannot load the routing plugin");
  }

  let content = {};
  if (env.OPENCODE_CONFIG_CONTENT) {
    try {
      content = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    } catch {
      return plain("OPENCODE_CONFIG_CONTENT is not plain JSON, so the routing plugin cannot be added to it");
    }
  }
  const plugins = Array.isArray(content.plugins) ? content.plugins : [];
  const childEnv = {
    ...env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...content, plugins: [...plugins, pluginDir] }),
    KRUN_ROUTER_BRIDGE: bridgeUrl,
  };
  if (userArgs.includes("--standalone")) return { args: [...userArgs], env: childEnv, routed: true };
  const args = ROUTED.has(sub) ? [sub, "--standalone", ...userArgs.slice(1)] : ["--standalone", ...userArgs];
  return { args, env: childEnv, routed: true };
}

/** OpenCode `Model.Info` (as the plugin forwards it) → the router's model shape. */
export function toCandidate(m) {
  return normalizeModel({
    id: m.id,
    provider: m.providerID,
    displayName: m.name,
    contextWindow: m.contextWindow,
    capabilities: { tools: m.tools, vision: m.vision },
  });
}

/**
 * Per-session routing state behind the bridge. A model that differs from the one we last set
 * was picked by the human (/models, or a command with its own model): routing pauses for that
 * session until `/krun-auto`.
 */
export function createOpencodeRouting({ router, history }) {
  const sessions = new Map(); // sessionID → { set, paused, decision, manual }
  return {
    async route({ sessionID, prompt, current, models = [], vision = false }) {
      const s = sessions.get(sessionID) ?? {};
      sessions.set(sessionID, s);
      if (!s.paused && s.set && s.set !== current.id) {
        s.paused = true;
        s.manual = { at: Date.now(), model: current.id, conversation: sessionID };
        history.recordManual(s.manual);
      }
      if (s.paused) return { model: null };
      try {
        const decision = await router.route({
          prompt,
          currentModel: current.id,
          availableModels: models.map(toCandidate),
          // ponytail: context size unknown here, so it never excludes a model; add via ctx.session.context if small-window models misfire
          requirements: { tools: true, vision },
          context: {},
        });
        decision.conversation = sessionID;
        history.record(decision);
        s.decision = decision;
        s.set = decision.model ?? current.id;
        debug(`[${sessionID}] ${current.id} -> ${s.set} (${decision.reason})`);
        return { model: s.set !== current.id ? s.set : null };
      } catch (err) {
        debug(`routing error, keeping ${current.id}: ${err?.message}`);
        return { model: null };
      }
    },
    resume(sessionID) {
      sessions.delete(sessionID);
    },
    /** `[Krun] → model …` for this session, for the TUI toast. */
    status(sessionID) {
      const s = sessions.get(sessionID);
      return statusText(s ? { decisions: s.decision ? [s.decision] : [], manual: s.manual } : null);
    },
  };
}

/**
 * Loopback JSON server for the plugin. The random path segment keeps other local processes
 * from driving it by accident. `handlers[name](body)` → JSON reply.
 */
export async function startBridge(handlers) {
  const token = randomBytes(16).toString("hex");
  const server = http.createServer(async (req, res) => {
    const [, t, name] = req.url.split("/");
    const handler = t === token && req.method === "POST" ? handlers[name] : undefined;
    if (!handler) return res.writeHead(404).end();
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const out = await handler(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out ?? {}));
    } catch (err) {
      res.writeHead(500).end(String(err?.message ?? err));
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}/${token}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
