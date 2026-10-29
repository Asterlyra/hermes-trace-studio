import { createServer } from "node:http";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DATABASE_PATH,
  getEvents,
  getRawEvents,
  getTrace,
  getTraceBundle,
  listTraces,
} from "./store.mjs";
import { hermesRuntime } from "./hermes/index.mjs";

const HOST = process.env.HERMES_TRACE_HOST || "127.0.0.1";
const PORT = Number(process.env.HERMES_TRACE_PORT || 4318);
const sseClients = new Map();

function allowedOrigin(origin) {
  if (!origin) return "*";
  try {
    const url = new URL(origin);
    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return origin;
  } catch {
    // Invalid origins are rejected below.
  }
  return null;
}

function corsHeaders(request) {
  const origin = allowedOrigin(request.headers.origin);
  return {
    "Access-Control-Allow-Origin": origin || "null",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-Hermes-Trace-Token",
    Vary: "Origin",
  };
}

function json(request, response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...corsHeaders(request),
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

async function readJson(request, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("请求内容过大。");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("请求 JSON 格式无效。");
  }
}

function notify(traceId) {
  const payload = `event: trace\ndata: ${JSON.stringify({ traceId, at: new Date().toISOString() })}\n\n`;
  for (const key of [traceId, "*"]) {
    for (const response of sseClients.get(key) || []) response.write(payload);
  }
}

hermesRuntime.setNotify(notify);

function openEventStream(request, response, traceId) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...corsHeaders(request),
  });
  response.write(`event: ready\ndata: ${JSON.stringify({ traceId })}\n\n`);
  const clients = sseClients.get(traceId) || new Set();
  clients.add(response);
  sseClients.set(traceId, clients);
  const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
  request.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(response);
    if (!clients.size) sseClients.delete(traceId);
  });
}

function hermesTrace(traceId) {
  const trace = getTrace(traceId);
  return trace?.source?.startsWith("hermes-") ? trace : null;
}

async function validateTurnInput(body) {
  const prompt = String(body.prompt || "").trim();
  if (!prompt) throw new Error("请输入要发送给 Hermes 的请求。");
  if (prompt.length > 200_000) throw new Error("请求内容超过 200,000 字符。");
  const cwd = resolve(String(body.cwd || process.cwd()));
  const info = await stat(cwd);
  if (!info.isDirectory()) throw new Error("工作目录不是有效文件夹。");
  const reasoningEffort = String(body.reasoningEffort || "").trim();
  if (reasoningEffort && !["none", "low", "medium", "high", "xhigh"].includes(reasoningEffort)) {
    throw new Error("Hermes reasoning effort 无效。");
  }
  return {
    prompt,
    cwd,
    model: body.model ? String(body.model).trim() : "",
    provider: body.provider ? String(body.provider).trim() : "",
    profile: body.profile ? String(body.profile).trim() : "",
    reasoningEffort,
    fast: body.fast == null ? null : Boolean(body.fast),
  };
}

async function handler(request, response) {
  const url = new URL(request.url || "/", `http://${request.headers.host || `${HOST}:${PORT}`}`);
  if (!allowedOrigin(request.headers.origin)) {
    return json(request, response, 403, { error: "只允许本机页面访问 Hermes Trace API。" });
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204, corsHeaders(request));
    return response.end();
  }

  if (request.method === "GET" && url.pathname === "/health") {
    return json(request, response, 200, {
      ok: true,
      service: "hermes-trace-studio",
      hermes: hermesRuntime.status(),
    });
  }

  if (request.method === "GET" && url.pathname === "/api/settings") {
    return json(request, response, 200, {
      hermes: hermesRuntime.status(),
      defaultCwd: process.cwd(),
      databasePath: DATABASE_PATH,
      localOnly: true,
    });
  }

  if (request.method === "GET" && url.pathname === "/api/hermes/status") {
    return json(request, response, 200, { hermes: hermesRuntime.status() });
  }

  if (request.method === "POST" && url.pathname === "/api/hermes/connect") {
    return json(request, response, 200, { hermes: await hermesRuntime.connect() });
  }

  if (request.method === "GET" && url.pathname === "/api/traces") {
    return json(request, response, 200, { traces: listTraces(url.searchParams.get("limit") || 100) });
  }

  if (request.method === "GET" && url.pathname === "/api/hermes/sessions") {
    return json(request, response, 200, {
      sessions: hermesRuntime.listSessions(
        url.searchParams.get("limit") || 100,
        url.searchParams.get("profile") || undefined,
      ),
    });
  }

  if (request.method === "GET" && url.pathname === "/api/stream") {
    return openEventStream(request, response, url.searchParams.get("traceId") || "*");
  }

  const traceMatch = url.pathname.match(/^\/api\/traces\/([^/]+)$/);
  if (request.method === "GET" && traceMatch) {
    const traceId = decodeURIComponent(traceMatch[1]);
    const trace = hermesTrace(traceId);
    if (!trace) return json(request, response, 404, { error: "Hermes Trace 不存在。" });
    return json(request, response, 200, { trace, events: getEvents(traceId) });
  }

  const rawMatch = url.pathname.match(/^\/api\/traces\/([^/]+)\/raw$/);
  if (request.method === "GET" && rawMatch) {
    const traceId = decodeURIComponent(rawMatch[1]);
    if (!hermesTrace(traceId)) return json(request, response, 404, { error: "Hermes Trace 不存在。" });
    return json(request, response, 200, { rawEvents: getRawEvents(traceId) });
  }

  const exportMatch = url.pathname.match(/^\/api\/traces\/([^/]+)\/export$/);
  if (request.method === "GET" && exportMatch) {
    const traceId = decodeURIComponent(exportMatch[1]);
    if (!hermesTrace(traceId)) return json(request, response, 404, { error: "Hermes Trace 不存在。" });
    const bundle = getTraceBundle(traceId);
    return json(request, response, 200, bundle, {
      "Content-Disposition": `attachment; filename="hermes-trace-${traceId}.json"`,
    });
  }

  if (request.method === "POST" && url.pathname === "/api/hermes/turns") {
    const options = await validateTurnInput(await readJson(request));
    const trace = await hermesRuntime.startTurn(options);
    notify(trace.id);
    return json(request, response, 202, { trace });
  }

  const actionMatch = url.pathname.match(/^\/api\/hermes\/turns\/([^/]+)\/actions$/);
  if (request.method === "POST" && actionMatch) {
    const traceId = decodeURIComponent(actionMatch[1]);
    if (!hermesTrace(traceId)) return json(request, response, 404, { error: "Hermes Trace 不存在。" });
    const result = await hermesRuntime.control(traceId, await readJson(request));
    notify(traceId);
    return json(request, response, 200, { ok: true, result });
  }

  if (request.method === "POST" && url.pathname === "/api/hermes/imports") {
    const body = await readJson(request);
    const sessionId = String(body.sessionId || "").trim();
    if (!sessionId) throw new Error("请选择 Hermes Session。");
    const traceIds = await hermesRuntime.importSession(sessionId, body.profile || undefined);
    return json(request, response, 201, { traceIds });
  }

  if (request.method === "POST" && url.pathname === "/api/hermes/observer/events") {
    const token = String(request.headers["x-hermes-trace-token"] || "");
    if (!hermesRuntime.observerTokenMatches(token)) {
      return json(request, response, 401, { error: "Observer Token 无效。" });
    }
    const result = await hermesRuntime.ingestObserver(await readJson(request, 8_000_000));
    return json(request, response, 202, result);
  }

  return json(request, response, 404, { error: "接口不存在。" });
}

const server = createServer((request, response) => {
  void handler(request, response).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    json(request, response, 400, { error: message });
  });
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`Hermes Trace API: http://${HOST}:${PORT}\n`);
});

function shutdown() {
  hermesRuntime.shutdown();
  for (const clients of sseClients.values()) {
    for (const response of clients) response.end();
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
