import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * LINE signs each webhook body: base64(HMAC-SHA256(channelSecret, rawBody)) in X-Line-Signature.
 * Must be checked against the exact raw bytes, before any JSON parsing.
 */
export function verifyLineSignature(rawBody: string, signature: string | null, channelSecret: string): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", channelSecret).update(rawBody, "utf8").digest();
  const received = Buffer.from(signature, "base64");
  return received.length === expected.length && timingSafeEqual(received, expected);
}
