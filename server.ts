/**
 * LINE service: the LINE bot bridge, its MCP server, and the internal chat-event relay.
 * Serves on port 3000 (internal; nginx does not route to it, ngrok does for the webhook).
 *
 *   POST /api/line/webhook                  LINE Messaging API webhook (signature checked inside)
 *   POST /api/mcp/line                      LINE MCP server (Streamable HTTP, Keycloak bearer token)
 *   GET  /api/mcp/line/protected-resource   OAuth protected-resource metadata
 *   GET  /healthz                           liveness
 *
 * Internal API for agent-service (header x-internal-token must equal INTERNAL_API_TOKEN):
 *   POST /internal/chat-event               { chatId, messageId, event } -> forwards to Open WebUI
 *
 * Plain Node http. Each request is converted to the Web Request/Response types the lib/ code uses.
 */
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { handleMcpPost, methodNotAllowed } from "./lib/mcp/http";
import { lineServer } from "./lib/mcp/servers/line";
import { handleLineEvent, type LineEvent } from "./lib/line/bridge";
import { getLineConfig, getOpenWebUIConnection } from "./lib/line/config";
import { verifyLineSignature } from "./lib/line/signature";

const PORT = Number(process.env.PORT) || 3000;
const MCP_PATH = `/api/mcp/${lineServer.name}`;
const EVENT_TIMEOUT_MS = 10_000;
const MAX_JSON_BYTES = 256 * 1024;


function toRequest(req: http.IncomingMessage, url: URL): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
    duplex: "half",
  } as RequestInit);
}

/** Copies a Web Response to the Node response, streaming the body so SSE works. */
async function send(res: http.ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  res.on("close", () => {
    reader.cancel().catch(() => {});
  });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}

// ---- webhook -------------------------------------------------------------------------------------

async function webhook(req: Request): Promise<Response> {
  let cfg;
  try {
    cfg = await getLineConfig();
  } catch (err) {
    console.error("LINE webhook: not ready:", err instanceof Error ? err.message : "unknown error");
    return Response.json({ error: "LINE is not configured" }, { status: 503 });
  }

  // Verify against the exact bytes LINE sent, before parsing.
  const raw = await req.text();
  if (!verifyLineSignature(raw, req.headers.get("x-line-signature"), cfg.channelSecret)) {
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  let body: { events?: LineEvent[] };
  try {
    body = JSON.parse(raw) as { events?: LineEvent[] };
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // LINE expects a fast 200. Events run after the response is sent, because the reply token
  // is valid for about a minute and the webhook caller should not wait on the bot.
  const events = Array.isArray(body.events) ? body.events : [];
  if (events.length > 0) {
    setImmediate(() => {
      void (async () => {
        for (const event of events) {
          try {
            await handleLineEvent(event);
          } catch (err) {
            console.error("LINE event failed:", err instanceof Error ? err.message : "unknown error");
          }
        }
      })();
    });
  }
  return new Response(null, { status: 200 });
}

// ---- internal API --------------------------------------------------------------------------------

function internalAuthorized(req: Request): boolean {
  const expected = process.env.INTERNAL_API_TOKEN;
  const given = req.headers.get("x-internal-token");
  if (!expected || !given) return false; // fail closed when the token is not configured
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > MAX_JSON_BYTES) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The model the chat was using, so the saved message matches the chat's model. */
/** Sends the answer to a LINE conversation, marked with the clock emoji like the chat version. */
async function chatEvent(body: Record<string, unknown>): Promise<Response> {
  const chatId = typeof body.chatId === "string" ? body.chatId : "";
  const messageId = typeof body.messageId === "string" ? body.messageId : "";
  const event = body.event;
  if (!chatId || !messageId || !event || typeof event !== "object") {
    return Response.json({ error: "chatId, messageId and event are required" }, { status: 422 });
  }
  const conn = await getOpenWebUIConnection();
  if (!conn) return new Response(null, { status: 204 }); // not configured: events are skipped, as before

  const url = `${conn.baseUrl}/api/v1/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/event`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${conn.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(event),
      cache: "no-store",
      signal: AbortSignal.timeout(EVENT_TIMEOUT_MS),
    });
    if (!res.ok) return Response.json({ error: `Open WebUI returned HTTP ${res.status}` }, { status: 502 });
    return new Response(null, { status: 204 });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "event failed" }, { status: 502 });
  }
}

// ---- routing -------------------------------------------------------------------------------------

function protectedResource(): Response {
  const base = process.env.APP_PUBLIC_URL?.replace(/\/$/, "");
  const issuer = process.env.OIDC_ISSUER;
  if (!base || !issuer) {
    return Response.json({ error: "protected resource metadata is not configured" }, { status: 500 });
  }
  return Response.json(
    {
      resource: `${base}${MCP_PATH}`,
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
      resource_name: "LINE MCP",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

async function route(req: Request, url: URL): Promise<Response> {
  const path = url.pathname;
  if (path === "/healthz") return new Response("ok", { headers: { "Content-Type": "text/plain" } });

  if (path === "/api/line/webhook") return req.method === "POST" ? webhook(req) : methodNotAllowed();
  if (path === `${MCP_PATH}/protected-resource`) return req.method === "GET" ? protectedResource() : methodNotAllowed();
  if (path === MCP_PATH) return req.method === "POST" ? handleMcpPost(req, lineServer) : methodNotAllowed();

  if (path.startsWith("/internal/")) {
    if (!internalAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (req.method === "POST" && path === "/internal/chat-event") return chatEvent(await readJson(req));
    return Response.json({ error: "not found" }, { status: 404 });
  }

  return Response.json({ error: "not found" }, { status: 404 });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    await send(res, await route(toRequest(req, url), url));
  } catch (err) {
    console.error("line request failed:", err instanceof Error ? err.message : "unknown error");
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "internal error" }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`line service listening on ${PORT}`);
});
