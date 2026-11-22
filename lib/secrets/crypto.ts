import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Encrypts secrets at rest (AES-256-GCM) before they are written to Postgres.
 *
 * Env (name only, set in .env / .env.dev):
 *   SECRETS_ENCRYPTION_KEY  32+ random characters. Losing or changing this key makes stored
 *                           secrets unreadable. It is separate from SESSION_SECRET so that
 *                           rotating session cookies does not destroy stored secrets.
 */

const ALG = "aes-256-gcm";

function key(): Buffer {
  const secret = process.env.SECRETS_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) {
    throw new Error("SECRETS_ENCRYPTION_KEY must be set (32+ characters)");
  }
  return createHash("sha256").update(secret).digest();
}

/** Returns base64url(iv | authTag | ciphertext). */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, key(), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
}

/** Throws if the value was tampered with or the key does not match. */
export function decryptSecret(token: string): string {
  const buf = Buffer.from(token, "base64url");
  if (buf.length < 28) throw new Error("encrypted value is malformed");
  const decipher = createDecipheriv(ALG, key(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}
