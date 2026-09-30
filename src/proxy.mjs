import http from "node:http";
import https from "node:https";
import { StringDecoder } from "node:string_decoder";
import zlib from "node:zlib";
import { debug, isDebug } from "./log.mjs";

/** Decompresses a (small) response body for inspection. */
export function decode(buf, encoding) {
  try {
    if (encoding === "br") return zlib.brotliDecompressSync(buf).toString("utf8");
    if (encoding === "gzip") return zlib.gunzipSync(buf).toString("utf8");
    if (encoding === "deflate") return zlib.inflateSync(buf).toString("utf8");
  } catch {
    return `<${encoding} body>`;
  }
  return buf.toString("utf8");
}

/**
 * Token usage in one response event or body, normalized so `input` excludes cached tokens:
 * Anthropic `usage` (message_start / message_delta / body), OpenAI Responses
 * (`response.completed`, input includes cached), chat completions (Kimi; usage may sit on the
 * final choice). Null when the object carries none.
 */
export function usageOf(ev) {
  const u = ev?.message?.usage ?? ev?.response?.usage ?? ev?.usage ?? ev?.choices?.[0]?.usage;
  if (!u || typeof u !== "object") return null;
  const n = (v) => (Number.isFinite(v) ? v : 0);
  if ("prompt_tokens" in u) {
    const cached = n(u.cached_tokens ?? u.prompt_tokens_details?.cached_tokens);
    return { input: n(u.prompt_tokens) - cached, output: n(u.completion_tokens), cacheRead: cached, cacheWrite: 0 };
  }
  if (u.input_tokens_details) {
    const cached = n(u.input_tokens_details.cached_tokens);
    return { input: n(u.input_tokens) - cached, output: n(u.output_tokens), cacheRead: cached, cacheWrite: 0 };
  }
  return { input: n(u.input_tokens), output: n(u.output_tokens), cacheRead: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens) };
}

const DECOMPRESS = { gzip: zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress, zstd: zlib.createZstdDecompress };
const MAX_JSON_BODY = 4 * 1024 * 1024;

/**
 * Reads token usage from a response while it streams to the client, without changing it.
 * Values in a stream are cumulative (Anthropic's message_delta repeats totals), so fields merge
 * by maximum. Unknown encodings and oversized JSON bodies are simply not measured.
 */
export function tapUsage(up, onUsage) {
  const encoding = up.headers["content-encoding"];
  if (encoding && !DECOMPRESS[encoding]) return;
  const src = encoding ? up.pipe(DECOMPRESS[encoding]()) : up;
  const sse = /event-stream/.test(up.headers["content-type"] ?? "");
  const text = new StringDecoder("utf8");
  let buf = "";
  let total = null;
  const take = (json) => {
    let u;
    try {
      u = usageOf(JSON.parse(json));
    } catch {
      return;
    }
    if (u) total = total ? Object.fromEntries(Object.keys(u).map((k) => [k, Math.max(total[k], u[k])])) : u;
  };
  const lines = (final) => {
    const parts = buf.split("\n");
    buf = final ? "" : parts.pop();
    for (const l of parts) if (l.startsWith("data:")) take(l.slice(5));
  };
  let tooBig = false;
  src.on("data", (c) => {
    if (tooBig) return;
    buf += text.write(c);
    if (sse) lines(false);
    else if (buf.length > MAX_JSON_BODY) (tooBig = true), (buf = "");
  });
  src.on("end", () => {
    if (!tooBig) buf += text.end();
    if (sse) lines(true);
    else if (!tooBig) take(buf);
    if (total) onUsage(total);
  });
  src.on("error", () => {});
}

const agents = {
  "http:": new http.Agent({ keepAlive: true }),
  "https:": new https.Agent({ keepAlive: true }),
};
const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "upgrade", "te", "trailer"];

/**
 * A loopback HTTP proxy that knows nothing about providers. The adapter decides:
 *
 *   upstreamFor(req)            → base URL the request is forwarded to
 *   localReply?(req)            → { status, headers, body } to answer without forwarding
 *   wantsBody(req)              → buffer this request and pass it to transformRequest
 *   transformRequest(req, buf)  → { body?, headers?, onResponse?, onUsage? } (may be async)
 *
 * Requests the adapter does not want are streamed straight through without buffering.
 * Headers, including authorization, are forwarded untouched apart from `host` and
 * hop-by-hop fields, and are never logged. A transform that throws is ignored and the
 * original request goes out: the proxy fails open.
 */
export async function startProxy(adapter, { host = "127.0.0.1", port = 0 } = {}) {
  const server = http.createServer(async (req, res) => {
    const local = adapter.localReply?.(req);
    if (local) return res.writeHead(local.status, local.headers ?? {}).end(local.body ?? "");

    let plan = {};
    let body = null;
    if (adapter.wantsBody(req)) {
      const chunks = [];
      try {
        for await (const c of req) chunks.push(c);
      } catch {
        return res.destroy();
      }
      body = Buffer.concat(chunks);
      try {
        plan = (await adapter.transformRequest(req, body)) ?? {};
      } catch (err) {
        debug(`transform failed, forwarding unchanged: ${err?.message}`);
        plan = {};
      }
    }
    forward(req, res, adapter.upstreamFor(req), plan.body ?? body, plan);
  });
  server.on("clientError", (_err, socket) => socket.destroy());
  await new Promise((resolve) => server.listen(port, host, resolve));
  return {
    port: server.address().port,
    url: `http://${host}:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function forward(req, res, base, body, plan) {
  const target = new URL(base);
  const headers = { ...req.headers, host: target.host };
  for (const h of HOP_BY_HOP) delete headers[h];
  if (body) {
    delete headers["transfer-encoding"];
    headers["content-length"] = String(body.length);
  }
  Object.assign(headers, plan.headers);
  for (const [k, v] of Object.entries(headers)) if (v === undefined) delete headers[k];

  const transport = target.protocol === "http:" ? http : https;
  const upstream = transport.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname.replace(/\/$/, "")}${req.url}`,
      method: req.method,
      headers,
      agent: agents[target.protocol],
    },
    (up) => {
      debug(`${req.method} ${req.url.split("?")[0]} -> ${up.statusCode}`);
      // Upstream rejections are the first sign of a provider format change; keep their text.
      if (up.statusCode >= 400 && isDebug()) {
        const chunks = [];
        up.on("data", (c) => chunks.push(c));
        up.on("end", () => debug(`upstream ${up.statusCode}: ${decode(Buffer.concat(chunks), up.headers["content-encoding"]).slice(0, 2000)}`));
      }
      if (plan.onUsage && up.statusCode >= 200 && up.statusCode < 300) tapUsage(up, plan.onUsage);
      if (plan.onResponse?.(up, res)) return;
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    debug(`upstream error: ${err.message}`);
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "proxy_error", message: `krun-router: upstream unreachable (${err.message})` } }));
  });
  res.on("close", () => {
    if (!res.writableFinished) upstream.destroy();
  });
  if (body) upstream.end(body);
  else req.pipe(upstream);
}

/** Buffers an upstream response so an adapter can rewrite it (small JSON bodies only). */
export function bufferResponse(up, res, rewrite) {
  const chunks = [];
  up.on("data", (c) => chunks.push(c));
  up.on("end", () => {
    let data = Buffer.concat(chunks);
    const headers = { ...up.headers };
    try {
      const out = rewrite(data);
      if (out) {
        data = out;
        headers["content-length"] = String(data.length);
        delete headers["transfer-encoding"];
      }
    } catch (err) {
      debug(`response rewrite failed, passing through: ${err?.message}`);
    }
    res.writeHead(up.statusCode, headers);
    res.end(data);
  });
  up.on("error", () => res.destroy());
}
