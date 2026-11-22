import { LINE_API_BASE } from "./config";

/**
 * Thin client for the LINE Messaging API. Errors carry the HTTP status and LINE's
 * message only, never request headers, so the access token cannot leak into logs.
 */

export class LineApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 10_000;
// Content downloads can be large, so they get a longer timeout and a separate host.
const LINE_DATA_BASE = "https://api-data.line.me";
const CONTENT_TIMEOUT_MS = 60_000;

async function lineRequest<T>(
  token: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T | undefined> {
  const res = await fetch(`${LINE_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const err = (await res.json()) as { message?: string };
      if (err.message) detail = err.message;
    } catch {
      // Non-JSON error body: keep the status text.
    }
    throw new LineApiError(res.status, `LINE API ${method} ${path} failed: HTTP ${res.status} ${detail}`);
  }
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : undefined;
}

/** Outgoing message shapes. The bridge currently replies with text only. */
export type LineMessage =
  | { type: "text"; text: string }
  | { type: "image"; originalContentUrl: string; previewImageUrl: string }
  | { type: "audio"; originalContentUrl: string; duration: number };

export type LineContent = { data: Buffer; contentType: string };

/**
 * Downloads the binary content of an image, audio, or video message. The webhook only carries
 * the message id. Refuses anything larger than maxBytes, checking Content-Length first, then the body.
 */
export async function getMessageContent(token: string, messageId: string, maxBytes: number): Promise<LineContent> {
  const path = `/v2/bot/message/${encodeURIComponent(messageId)}/content`;
  const res = await fetch(`${LINE_DATA_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(CONTENT_TIMEOUT_MS),
  });
  if (!res.ok) throw new LineApiError(res.status, `LINE API GET ${path} failed: HTTP ${res.status}`);

  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new LineContentTooLargeError();

  const data = Buffer.from(await res.arrayBuffer());
  if (data.byteLength > maxBytes) throw new LineContentTooLargeError();
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  return { data, contentType };
}

export class LineContentTooLargeError extends Error {
  constructor() {
    super("LINE content exceeds the size limit");
  }
}

/** Reply with the event's replyToken (valid for about one minute, single use). */
export function replyMessage(token: string, replyToken: string, messages: LineMessage[]): Promise<unknown> {
  return lineRequest(token, "POST", "/v2/bot/message/reply", { replyToken, messages });
}

/** Push to a user id. Used when the reply token has expired. */
export function pushMessage(token: string, to: string, messages: LineMessage[]): Promise<unknown> {
  return lineRequest(token, "POST", "/v2/bot/message/push", { to, messages });
}

export type BotInfo = {
  userId: string;
  basicId: string;
  premiumId?: string;
  displayName: string;
  pictureUrl?: string;
  chatMode: string;
  markAsReadMode: string;
};

export function getBotInfo(token: string): Promise<BotInfo | undefined> {
  return lineRequest<BotInfo>(token, "GET", "/v2/bot/info");
}

export type WebhookEndpoint = { endpoint: string; active: boolean };

export function getWebhookEndpoint(token: string): Promise<WebhookEndpoint | undefined> {
  return lineRequest<WebhookEndpoint>(token, "GET", "/v2/bot/channel/webhook/endpoint");
}

export type WebhookTestResult = { success: boolean; timestamp: string; statusCode: number; reason: string; detail: string };

/** Asks LINE to send a test event to the configured webhook URL. */
export function testWebhookEndpoint(token: string): Promise<WebhookTestResult | undefined> {
  return lineRequest<WebhookTestResult>(token, "POST", "/v2/bot/channel/webhook/test", {});
}
