import { API_URL, ROUTING_TIMEOUT_MS } from "./config.mjs";

// Limit from the /v1/decide contract (https://api.krun.ai/openapi.json).
export const MAX_CONTEXT_CHARS = 8000;

/**
 * Krun classifies what KIND of task the turn is (it is an intent model, and that is what it
 * does well); the policy maps kind → tier → model. Asking Krun to pick among model ids
 * directly measured worse than "always the smallest model" (eval/baseline-report.json).
 * tier null = a follow-up with no task of its own: keep the current model.
 */
export const TASK_KINDS = {
  question: ["Answer a question or explain a concept or snippet; no code changes", "small"],
  command: ["Run a command, script, formatter, build, test run or git operation", "small"],
  small_edit: ["A small mechanical edit: fix a typo, add a comment, docstring or log line, change a constant or config value, bump a dependency version", "small"],
  mechanical_change: ["A mechanical change repeated across files: rename a symbol everywhere, update imports, convert syntax (callbacks to async/await) with no design decisions", "small"],
  search: ["Search the codebase and report findings: find usages, TODOs, dead code or hardcoded secrets", "small"],
  bugfix: ["Fix a specific bug or failing test whose cause is visible or localized", "medium"],
  feature: ["Implement a well-scoped feature, option, flag or endpoint, with tests", "medium"],
  explain_codebase: ["Explain or trace how a part of this codebase works across files", "medium"],
  optimize: ["Investigate and improve performance, bundle size, queries or resource usage", "medium"],
  design_build: ["Design and build a substantial new system or feature with real design decisions (sync, conflict resolution, distributed state, new architecture)", "large"],
  refactor: ["Restructure a large part of the codebase: migrate to a new language, framework or architecture across many modules", "large"],
  architecture: ["Architecture or system design decisions and trade-offs", "large"],
  hard_debugging: ["Find the unknown root cause of an elusive bug: race conditions, deadlocks, memory leaks, intermittent or environment-dependent failures", "large"],
  security_review: ["Security review or threat analysis of authentication, authorization, crypto or permission logic", "large"],
  continuation: ["A short follow-up with no task of its own: yes, continue, do it, go ahead, thanks", null],
};

/** Second question, same call: does the user reject the previous attempt? (escalation) */
const ESCALATE = {
  type: "noul",
  instructions: "Is the user reporting that the assistant's previous attempt did not work, is still failing, is wrong, broke something, or is not what they asked for?",
  criteria: {
    true: "The user complains about or rejects what the assistant just did: it did not work, still fails, gives the same error, is wrong, broke something, or is not what they asked for.",
    false: "A new request or follow-up task, thanks, approval, a question, or a first report of a problem the assistant has not tried to fix yet.",
  },
};

/** One short line of prompt-free conversation facts, or null. */
export function signalsLine(context = {}) {
  const facts = [];
  if (context.turns > 1) facts.push(`turn ${context.turns} of the conversation`);
  if (context.lastToolFailed) facts.push("the last tool call failed");
  return facts.length ? `Conversation: ${facts.join("; ")}.` : null;
}

/**
 * The context is the fresh user request plus at most one line of conversation facts: no
 * history, no model list, no credentials, no account metadata.
 */
export function buildDecideRequest(prompt, context = {}) {
  const signals = signalsLine(context);
  return {
    context: `${signals ? `${signals}\n\n` : ""}${prompt}`.slice(0, MAX_CONTEXT_CHARS),
    questions: {
      kind: { type: "choice", options: Object.fromEntries(Object.entries(TASK_KINDS).map(([id, [text]]) => [id, text])) },
      escalate: ESCALATE,
    },
  };
}

/**
 * The classified task kind (Krun's most probable one; its abstention flag is "advisory" for
 * this question and is ignored in favour of `confidence`), or null when the response does not
 * match the contract.
 */
export function parseAnswer(response) {
  const a = response?.answers?.kind;
  if (!a || a.type !== "choice" || typeof a.confidence !== "number") return null;
  if (!a.probabilities || typeof a.probabilities !== "object") return null;
  const kind = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1])[0]?.[0];
  if (!(kind in TASK_KINDS)) return null;
  const e = response.answers.escalate?.noul;
  return {
    kind,
    confidence: a.confidence,
    probabilities: a.probabilities,
    escalate: typeof e === "number" ? e : 0,
    abstain: a.abstain ?? null,
    abstentionStatus: a.abstention_status ?? null,
  };
}

/**
 * Never throws. Every failure comes back as `{ ok: false, error }` so the caller can fail
 * open. The deadline covers the whole exchange (connect, response and body) and there are
 * no retries: a routing answer that arrives late is worth less than an immediate turn.
 */
// apiUrl is injectable for tests only; users cannot change it (see config.mjs).
export function createKrunClient({ apiKey, apiUrl = API_URL, timeoutMs = ROUTING_TIMEOUT_MS, fetchImpl = fetch }) {
  return {
    /**
     * Opens the TLS connection ahead of the first turn: a cold handshake alone costs a large
     * part of the routing deadline. fetch keeps the connection pooled. No credentials sent.
     */
    warm() {
      return fetchImpl(`${apiUrl}/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.arrayBuffer()).catch(() => {});
    },
    async decide(prompt, context) {
      const request = buildDecideRequest(prompt, context);
      const started = performance.now();
      const done = (fields) => ({ request, latencyMs: Math.round(performance.now() - started), ...fields });
      if (!apiKey) return done({ ok: false, error: "missing KRUN_API_KEY" });
      try {
        const res = await fetchImpl(`${apiUrl}/v1/decide`, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const requestId = res.headers.get("x-request-id");
        const response = await res.json().catch(() => null);
        if (!res.ok) {
          const code = response?.error?.code ? ` ${response.error.code}` : "";
          return done({ ok: false, requestId, response, error: `HTTP ${res.status}${code}` });
        }
        const answer = parseAnswer(response);
        if (!answer) return done({ ok: false, requestId, response, error: "invalid response" });
        return done({ ok: true, requestId, response, answer });
      } catch (err) {
        const timeout = err?.name === "TimeoutError" || err?.name === "AbortError";
        return done({ ok: false, error: timeout ? `timeout after ${timeoutMs}ms` : `network error: ${err?.message}` });
      }
    },
  };
}
