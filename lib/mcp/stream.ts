import { randomUUID } from "node:crypto";
import type { JsonRpcResponse, McpChannel } from "./server";

/**
 * SSE responses for tools/call, so a tool can send server→client requests
 * (elicitation/create) and notifications while the call is open.
 *
 * The client's answer to a request arrives as a separate POST, so the pending
 * request lives in this process's memory. That is correct only with a single
 * agent-service replica (or sticky routing). Keep replicas at 1 if you use it.
 */

const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

type Pending = {
  sub: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
};

const pending = new Map<string, Pending>();

function settle(id: string): Pending | undefined {
  const p = pending.get(id);
  if (p) {
    clearTimeout(p.timer);
    pending.delete(id);
  }
  return p;
}

/**
 * Deliver the client's answer to a waiting server→client request.
 * Only the same token subject that the request was sent to may answer it.
 */
export function deliverClientResponse(
  message: { id: unknown; result?: unknown; error?: { message?: string } },
  sub: string,
): boolean {
  if (typeof message.id !== "string") return false;
  const p = pending.get(message.id);
  if (!p || p.sub !== sub) return false;
  settle(message.id);
  if (message.error) p.reject(new Error(message.error.message ?? "client returned an error"));
  else p.resolve(message.result);
  return true;
}

/** Run one tools/call as an SSE stream: notifications and requests, then the final response. */
export function sseResponse(
  sub: string,
  run: (channel: McpChannel) => Promise<JsonRpcResponse | undefined>,
): Response {
  const encoder = new TextEncoder();
  const open = new Set<string>();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;

  const write = (message: unknown) => {
    if (closed) return;
    controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`));
  };

  const rejectOpen = (reason: string) => {
    for (const id of open) settle(id)?.reject(new Error(reason));
    open.clear();
  };

  const channel: McpChannel = {
    notify: (method, params) => write({ jsonrpc: "2.0", method, params }),
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const id = `srv-${randomUUID()}`;
        const timer = setTimeout(() => {
          open.delete(id);
          settle(id)?.reject(new Error("client did not respond in time"));
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, { sub, timer, resolve, reject });
        open.add(id);
        write({ jsonrpc: "2.0", id, method, params });
      }),
  };

  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      run(channel)
        .catch(() => undefined)
        .then((final) => {
          if (final) write(final);
        })
        .finally(() => {
          closed = true;
          rejectOpen("tool call finished");
          try {
            controller.close();
          } catch {
            // already closed by cancel()
          }
        });
    },
    cancel() {
      closed = true;
      rejectOpen("client disconnected");
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
