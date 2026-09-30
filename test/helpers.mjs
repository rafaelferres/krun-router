import http from "node:http";
import { normalizeModel } from "../src/catalog.mjs";

/** An HTTP server on a random loopback port that records requests and answers via `handler`. */
export async function mockServer(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    const entry = { method: req.method, url: req.url, headers: req.headers, body };
    requests.push(entry);
    await handler(entry, res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    }),
  };
}

export const json = (res, status, body, headers = {}) =>
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));

/** A task kind per tier (see TASK_KINDS in src/krun-client.mjs). */
export const KIND = { small: "small_edit", medium: "bugfix", large: "architecture" };

/** A Krun /v1/decide mock. `pick(body)` returns the task kind Krun classifies the turn as. */
export function krunHandler(pick, { confidence = 0.8, escalate = 0 } = {}) {
  return (req, res) => {
    const ids = Object.keys(req.body?.questions?.kind?.options ?? {});
    const kind = pick(req.body);
    const probabilities = Object.fromEntries(ids.map((id) => [id, id === kind ? 0.9 : 0.1 / Math.max(1, ids.length - 1)]));
    json(res, 200, {
      model: "krun-one",
      answers: {
        kind: { type: "choice", choice: null, confidence, probabilities, abstain: true, abstention_status: "advisory" },
        escalate: { type: "noul", noul: escalate },
      },
      usage: { input_tokens: 12 },
    }, { "x-request-id": "req_test" });
  };
}

/** A fake Krun client that records calls. */
export function fakeKrun(answerFor) {
  const calls = [];
  return {
    calls,
    async decide(prompt) {
      calls.push({ prompt });
      const answer = answerFor(prompt);
      return answer
        ? { ok: true, request: { context: prompt }, answer, latencyMs: 1, requestId: "req_fake" }
        : { ok: false, request: { context: prompt }, error: "down", latencyMs: 1 };
    },
  };
}

export const model = (id, capabilities = {}, extra = {}) =>
  normalizeModel({ id, provider: "test", displayName: id, capabilities: { tools: true, ...capabilities }, ...extra });

/** A parsed Krun answer classifying the turn as a task of `tier` (or an explicit kind). */
export const tier = (t, { confidence = 0.8, escalate = 0, kind = KIND[t] } = {}) => ({ kind, confidence, probabilities: { [kind]: 0.9 }, escalate, abstain: true });
