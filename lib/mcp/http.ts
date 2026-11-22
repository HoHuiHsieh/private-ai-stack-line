import { authenticate } from "./auth";
import { handleMessage, isClientResponse, RPC_ERRORS, type JsonRpcResponse, type McpContext, type McpServerDef } from "./server";
import { deliverClientResponse, sseResponse } from "./stream";

/**
 * Shared HTTP layer for MCP route handlers. Each route calls handleMcpPost
 * with its own McpServerDef and re-exports GET / DELETE from here.
 */

function jsonError(status: number, message: string, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Cache-Control", "no-store");
  return Response.json({ error: message }, { status, headers });
}

/**
 * WWW-Authenticate for 401s. resource_metadata points MCP clients (e.g. Open WebUI)
 * at the protected-resource document, which names Keycloak as the authorization server.
 */
function challengeHeader(server: McpServerDef, invalidToken: boolean): string {
  const base = process.env.APP_PUBLIC_URL?.replace(/\/$/, "");
  const params: string[] = [];
  if (base) params.push(`resource_metadata="${base}/api/mcp/${server.name}/protected-resource"`);
  if (invalidToken) params.push('error="invalid_token"');
  return params.length ? `Bearer ${params.join(", ")}` : "Bearer";
}

export async function handleMcpPost(req: Request, server: McpServerDef): Promise<Response> {
  const auth = await authenticate(req);
  if (!auth.ok) {
    const headers =
      auth.status === 401
        ? { "WWW-Authenticate": challengeHeader(server, auth.message !== "Missing bearer token") }
        : undefined;
    return jsonError(auth.status, auth.message, headers);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    const parseError: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: null,
      error: { code: RPC_ERRORS.parse, message: "Parse error" },
    };
    return Response.json(parseError, { status: 400 });
  }

  const sub = String(auth.claims.sub ?? "");

  // The client answering a server→client request (e.g. elicitation/create).
  if (isClientResponse(body)) {
    const delivered = deliverClientResponse(body, sub);
    return new Response(null, { status: delivered ? 202 : 404 });
  }

  const ctx: McpContext = { claims: auth.claims, headers: req.headers };

  // tools/call with an SSE-capable client: stream so the tool can ask the user.
  const acceptsStream = (req.headers.get("accept") ?? "").includes("text/event-stream");
  if (
    acceptsStream &&
    !Array.isArray(body) &&
    body !== null &&
    typeof body === "object" &&
    (body as { method?: unknown }).method === "tools/call"
  ) {
    return sseResponse(sub, (channel) => handleMessage(body, { ...ctx, channel }, server));
  }

  // Batch request: answer each entry; notifications produce no entry.
  if (Array.isArray(body)) {
    if (body.length === 0) {
      return Response.json(
        { jsonrpc: "2.0", id: null, error: { code: RPC_ERRORS.invalidRequest, message: "Empty batch" } },
        { status: 400 },
      );
    }
    const results = (await Promise.all(body.map((m) => handleMessage(m, ctx, server)))).filter(
      (r): r is JsonRpcResponse => r !== undefined,
    );
    return results.length === 0 ? new Response(null, { status: 202 }) : Response.json(results);
  }

  const result = await handleMessage(body, ctx, server);
  if (result === undefined) return new Response(null, { status: 202 });
  return Response.json(result);
}

// No server-initiated SSE stream is opened, so GET and DELETE are not supported
// (Streamable HTTP allows 405 for GET).
export function methodNotAllowed(): Response {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
