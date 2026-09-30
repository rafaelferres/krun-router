// krun-router plugin for OpenCode v2. Loaded by `krun-router opencode` through
// OPENCODE_CONFIG_CONTENT; it runs inside OpenCode's server and asks the krun-router
// process (KRUN_ROUTER_BRIDGE) which model the next human turn should use.
// Self-contained on purpose: OpenCode imports it in its own runtime, not ours.

const BRIDGE = process.env.KRUN_ROUTER_BRIDGE;

async function call(name, body) {
  try {
    const res = await fetch(`${BRIDGE}/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000), // above the 5000 ms routing deadline
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null; // fail open: the turn runs on the current model
  }
}

// Client-style APIs answer `{ location, data }`; handle both shapes.
const unwrap = (r) => (r && typeof r === "object" && "data" in r ? r.data : r);
const isImage = (f) => /^data:image\//.test(f?.uri ?? "") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f?.uri ?? "");

export default {
  id: "krun-router",
  async setup(ctx) {
    if (!BRIDGE) return;

    await ctx.session.hook("prompt", async (event) => {
      const text = event.prompt?.text?.trim();
      if (!text) return;
      const session = unwrap(await ctx.session.get({ sessionID: event.sessionID }));
      if (session?.parentID) return; // sub-agent: keeps the model its agent or parent chose
      const fallback = unwrap(await ctx.model.default());
      const current = session?.model ?? (fallback && { providerID: fallback.providerID, id: fallback.id });
      if (!current) return;
      // Same provider only: the wire format and credentials of the turn stay valid.
      const models = (unwrap(await ctx.model.list()) ?? [])
        .filter((m) => m.providerID === current.providerID && m.enabled !== false && m.status !== "deprecated")
        .map((m) => ({
          id: m.id,
          providerID: m.providerID,
          name: m.name,
          contextWindow: m.limit?.context,
          tools: m.capabilities?.tools,
          vision: m.capabilities?.input?.includes("image"),
        }));
      const r = await call("route", {
        sessionID: event.sessionID,
        prompt: text,
        current: { providerID: current.providerID, id: current.id },
        models,
        vision: (event.prompt.files ?? []).some(isImage),
      });
      if (r?.model) await ctx.session.switchModel({ sessionID: event.sessionID, model: { providerID: current.providerID, id: r.model } });
    });

    // Spend per model call, for `krun-router stats`: step events carry the tokens, the model
    // comes from the matching step.started. OpenCode's `input` already excludes cached tokens.
    const stepModel = new Map(); // assistantMessageID → model id
    (async () => {
      for await (const e of ctx.event.subscribe()) {
        const d = e?.data ?? {};
        if (e?.type === "session.step.started") stepModel.set(d.assistantMessageID, d.model?.id);
        else if ((e?.type === "session.step.ended" || e?.type === "session.step.failed") && d.tokens) {
          const t = d.tokens;
          call("usage", {
            sessionID: d.sessionID,
            model: stepModel.get(d.assistantMessageID),
            input: t.input,
            output: (t.output ?? 0) + (t.reasoning ?? 0),
            cacheRead: t.cache?.read,
            cacheWrite: t.cache?.write,
            cost: typeof d.cost === "number" ? d.cost : undefined,
          });
          stepModel.delete(d.assistantMessageID);
        }
      }
    })().catch(() => {}); // usage is diagnostic; never affects the session

    const say = (sessionID, text) => ctx.session.synthetic({ sessionID, text, resume: false });
    await ctx.command.transform((editor) => {
      editor.add({
        name: "krun-explain",
        description: "Why Krun Router picked the model for the last prompt",
        execute: async ({ sessionID }) => say(sessionID, (await call("explain", {}))?.text ?? "Krun Router is not reachable."),
      });
      editor.add({
        name: "krun-auto",
        description: "Resume Krun Router after choosing a model manually",
        execute: async ({ sessionID }) => {
          await call("resume", { sessionID });
          await say(sessionID, "Krun Router: routing resumes with your next prompt.");
        },
      });
    });
  },
};
