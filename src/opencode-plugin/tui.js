// krun-router TUI plugin for OpenCode v2: a toast with each new routing decision
// (`[Krun] → model …`). OpenCode's TUI loads it because the server reports our plugin
// directory with a `tui` entrypoint. Plain JS: footer slots need Solid JSX, a toast does not.

const BRIDGE = process.env.KRUN_ROUTER_BRIDGE;

async function status(sessionID) {
  try {
    const res = await fetch(`${BRIDGE}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionID }),
      signal: AbortSignal.timeout(2000),
    });
    return res.ok ? (await res.json()).text : null;
  } catch {
    return null; // display only: never affects the session
  }
}

export default {
  id: "krun-router",
  setup(ctx) {
    if (!BRIDGE) return;
    const shown = new Map(); // sessionID → last text; a toast only when the decision changes
    return ctx.data.on("session.step.started", async (event) => {
      const sessionID = event.data?.sessionID;
      const text = sessionID && (await status(sessionID));
      if (!text || shown.get(sessionID) === text || text.startsWith("[Krun] waiting")) return;
      shown.set(sessionID, text);
      ctx.ui.toast.show({ message: text, variant: "info", sessionID });
    });
  },
};
