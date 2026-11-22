import type { McpContext, McpResource, McpTool } from "./server";

/**
 * Helpers for native MCP UI in Open WebUI:
 *   - MCP Apps: a sandboxed HTML widget rendered in the message (widgetResource + withWidget)
 *   - Elicitation: a form or URL modal the user answers (elicitForm / elicitUrl)
 *
 * Elicitation needs the call to run as SSE (the client sends Accept: text/event-stream,
 * which Open WebUI does). Without it, helpers return { action: "unsupported" }.
 * See lib/mcp/stream.ts for the single-replica limit.
 */

/** MIME type Open WebUI renders as an MCP App widget. */
export const MCP_APP_MIME = "text/html;profile=mcp-app";

/** A widget resource. The uri must use the ui:// scheme. */
export function widgetResource(uri: string, name: string, html: string): McpResource {
  if (!uri.startsWith("ui://")) throw new Error('widget uri must start with "ui://"');
  return { uri, name, mimeType: MCP_APP_MIME, text: html };
}

/** Attach a widget to a tool. Its result is rendered by the widget resource. */
export function withWidget(tool: McpTool, resourceUri: string): McpTool {
  return { ...tool, _meta: { ui: { resourceUri } } };
}

export type ElicitSchema = {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
};

export type ElicitOutcome =
  | { action: "accept"; content: Record<string, unknown> }
  | { action: "decline" }
  | { action: "cancel" }
  | { action: "unsupported" };

function normalize(raw: unknown): ElicitOutcome {
  const r = (raw ?? {}) as { action?: string; content?: Record<string, unknown> };
  if (r.action === "accept") return { action: "accept", content: r.content ?? {} };
  if (r.action === "decline") return { action: "decline" };
  return { action: "cancel" };
}

/** Pop up a form modal and wait for the user's answer. */
export async function elicitForm(
  ctx: McpContext,
  message: string,
  requestedSchema: ElicitSchema,
): Promise<ElicitOutcome> {
  if (!ctx.channel) return { action: "unsupported" };
  try {
    return normalize(await ctx.channel.request("elicitation/create", { mode: "form", message, requestedSchema }));
  } catch {
    return { action: "cancel" }; // timed out or the client disconnected
  }
}

/** Show a modal asking the user to open an external URL (OAuth, approval page). */
export async function elicitUrl(
  ctx: McpContext,
  message: string,
  url: string,
  elicitationId: string,
): Promise<ElicitOutcome> {
  if (!ctx.channel) return { action: "unsupported" };
  try {
    return normalize(
      await ctx.channel.request("elicitation/create", { mode: "url", message, url, elicitationId }),
    );
  } catch {
    return { action: "cancel" };
  }
}

/**
 * Tell the client a URL elicitation finished. Only delivered while the tool
 * call's stream is still open, so use it inside the tool, not after it returns.
 */
export function elicitationComplete(ctx: McpContext, elicitationId: string): void {
  ctx.channel?.notify("notifications/elicitation/complete", { elicitationId });
}
