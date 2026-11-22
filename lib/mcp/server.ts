/**
 * Minimal MCP server core: JSON-RPC 2.0 dispatch over Streamable HTTP.
 * Responses are application/json, or text/event-stream for tools/call when the
 * client accepts it (needed for server→client requests such as elicitation).
 *
 * Each MCP server is an McpServerDef (name, version, tools, resources).
 * Route handlers under app/api/mcp/<name>/ pass their definition to http.ts.
 */

export const PROTOCOL_VERSION = "2025-06-18";

/** Server→client messages sent over an open SSE response (see stream.ts). */
export type McpChannel = {
  /** Ask the client something (e.g. elicitation/create) and wait for its result. */
  request(method: string, params: unknown): Promise<unknown>;
  /** Fire-and-forget notification to the client. */
  notify(method: string, params: unknown): void;
};

export type McpContext = {
  /** Verified Keycloak token claims. */
  claims: Record<string, unknown>;
  /** Headers of the incoming MCP request (e.g. Open WebUI's chat/message ids). */
  headers: Headers;
  /** Present only when the client accepted an SSE response for this call. */
  channel?: McpChannel;
};

/** A plain string becomes one text block. Use the object form for structuredContent. */
export type ToolResult = string | { text: string; structuredContent?: unknown; isError?: boolean };

export type McpTool = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description?: string; items?: { type: string } }>;
    required?: string[];
    additionalProperties: false;
  };
  /** MCP Apps: the widget resource (ui://...) that renders this tool's result. */
  _meta?: { ui?: { resourceUri: string } };
  handler: (args: Record<string, unknown>, ctx: McpContext) => Promise<ToolResult>;
};

export type McpResource = {
  uri: string;
  name: string;
  mimeType: string;
  text: string;
};

export type McpServerDef = {
  name: string;
  version: string;
  tools: McpTool[];
  resources?: McpResource[];
};

type JsonRpcId = string | number | null;

type JsonRpcMessage = {
  jsonrpc?: unknown;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
};

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string } };

export const RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

function rpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function rpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** True for a client's answer to a server→client request (has result or error, no method). */
export function isClientResponse(
  msg: unknown,
): msg is { jsonrpc: "2.0"; id: unknown; result?: unknown; error?: { message?: string } } {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return false;
  const m = msg as Record<string, unknown>;
  return m.jsonrpc === "2.0" && !("method" in m) && ("result" in m || "error" in m);
}

function normalizeToolResult(out: ToolResult) {
  const r = typeof out === "string" ? { text: out } : out;
  return {
    content: [{ type: "text", text: r.text }],
    ...(r.structuredContent !== undefined ? { structuredContent: r.structuredContent } : {}),
    isError: r.isError ?? false,
  };
}

/**
 * Handle one JSON-RPC message for the given server. Returns undefined for
 * notifications (no `id`), which per spec get no response body.
 */
export async function handleMessage(
  raw: unknown,
  ctx: McpContext,
  server: McpServerDef,
): Promise<JsonRpcResponse | undefined> {
  const msg = raw as JsonRpcMessage;
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(null, RPC_ERRORS.invalidRequest, "Invalid JSON-RPC request");
  }

  const isNotification = !("id" in msg) || msg.id === undefined;
  if (isNotification) {
    // e.g. notifications/initialized: acknowledge, nothing to return.
    return undefined;
  }

  const id = msg.id as JsonRpcId;
  const params = asRecord(msg.params);

  try {
    switch (msg.method) {
      case "initialize":
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
          serverInfo: { name: server.name, version: server.version },
        });

      case "ping":
        return rpcResult(id, {});

      case "tools/list":
        return rpcResult(id, {
          tools: server.tools.map(({ name, description, inputSchema, _meta }) => ({
            name,
            description,
            inputSchema,
            ...(_meta ? { _meta } : {}),
          })),
        });

      case "tools/call": {
        const name = params.name;
        if (typeof name !== "string") return rpcError(id, RPC_ERRORS.invalidParams, '"name" is required');
        const tool = server.tools.find((t) => t.name === name);
        if (!tool) return rpcError(id, RPC_ERRORS.invalidParams, `Unknown tool "${name}"`);

        try {
          const out = await tool.handler(asRecord(params.arguments), ctx);
          return rpcResult(id, normalizeToolResult(out));
        } catch (err) {
          // Tool failures are reported in-band so the model can see and recover from them.
          const message = err instanceof Error ? err.message : "Tool failed";
          return rpcResult(id, { content: [{ type: "text", text: message }], isError: true });
        }
      }

      case "resources/list":
        return rpcResult(id, {
          resources: (server.resources ?? []).map(({ uri, name, mimeType }) => ({ uri, name, mimeType })),
        });

      case "resources/read": {
        const uri = params.uri;
        if (typeof uri !== "string") return rpcError(id, RPC_ERRORS.invalidParams, '"uri" is required');
        const resource = server.resources?.find((r) => r.uri === uri);
        if (!resource) return rpcError(id, RPC_ERRORS.invalidParams, `Unknown resource "${uri}"`);
        return rpcResult(id, {
          contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: resource.text }],
        });
      }

      default:
        return rpcError(id, RPC_ERRORS.methodNotFound, `Method not found: ${msg.method}`);
    }
  } catch {
    return rpcError(id, RPC_ERRORS.internal, "Internal error");
  }
}
