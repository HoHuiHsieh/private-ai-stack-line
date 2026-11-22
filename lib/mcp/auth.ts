import { createPublicKey, verify, type JsonWebKey } from "node:crypto";

/**
 * Bearer-token verification for the MCP endpoint.
 *
 * Tokens are Keycloak-issued RS256 access tokens. The signing key is looked up
 * in the realm JWKS (cached), and iss / exp / (optional) aud are checked.
 *
 * Config (env files, not compose):
 *   MCP_JWT_ISSUER    expected `iss` claim, e.g. https://auth.<host>/realms/<realm>
 *   MCP_JWKS_URL      reachable from this container, e.g. http://keycloak:8080/realms/<realm>/protocol/openid-connect/certs
 *   MCP_JWT_AUDIENCE  optional; if set, the token's `aud` must include it
 */

export type AuthResult =
  | { ok: true; claims: Record<string, unknown> }
  | { ok: false; status: 401 | 500 | 503; message: string };

type Jwk = JsonWebKey & { kid?: string };

const JWKS_TTL_MS = 5 * 60 * 1000;
const CLOCK_SKEW_S = 60;

let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;

class TokenError extends Error {}

async function fetchJwks(url: string): Promise<Jwk[]> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`JWKS fetch failed with status ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = body.keys ?? [];
  jwksCache = { keys, fetchedAt: Date.now() };
  return keys;
}

async function findKey(url: string, kid: string | undefined): Promise<Jwk | undefined> {
  const fresh = jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS;
  if (fresh) {
    const hit = jwksCache!.keys.find((k) => k.kid === kid);
    if (hit) return hit;
  }
  // Unknown kid or stale cache: refresh once (handles key rotation).
  const keys = await fetchJwks(url);
  return keys.find((k) => k.kid === kid);
}

function decodeSegment(segment: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new TokenError("Malformed token");
  }
}

export async function verifyJwt(
  token: string,
  issuer: string,
  jwksUrl: string,
  audience: string | undefined,
): Promise<Record<string, unknown>> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new TokenError("Malformed token");
  const [headerB64, payloadB64, signatureB64] = parts;

  const header = decodeSegment(headerB64);
  const claims = decodeSegment(payloadB64);
  if (header.alg !== "RS256") throw new TokenError("Unsupported signing algorithm");

  const jwk = await findKey(jwksUrl, typeof header.kid === "string" ? header.kid : undefined);
  if (!jwk) throw new TokenError("Unknown signing key");

  let valid: boolean;
  try {
    const key = createPublicKey({ key: jwk, format: "jwk" });
    valid = verify(
      "RSA-SHA256",
      Buffer.from(`${headerB64}.${payloadB64}`),
      key,
      Buffer.from(signatureB64, "base64url"),
    );
  } catch {
    throw new TokenError("Invalid signing key or signature");
  }
  if (!valid) throw new TokenError("Bad signature");

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S <= now) {
    throw new TokenError("Token expired");
  }
  if (typeof claims.nbf === "number" && claims.nbf > now + CLOCK_SKEW_S) {
    throw new TokenError("Token not yet valid");
  }
  if (claims.iss !== issuer) throw new TokenError("Wrong issuer");
  if (audience) {
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(audience)) throw new TokenError("Wrong audience");
  }
  return claims;
}

export async function authenticate(req: Request): Promise<AuthResult> {
  const issuer = process.env.MCP_JWT_ISSUER;
  const jwksUrl = process.env.MCP_JWKS_URL;
  if (!issuer || !jwksUrl) {
    // Fail closed: never serve MCP without a configured verifier.
    return { ok: false, status: 500, message: "MCP authentication is not configured" };
  }

  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!match) return { ok: false, status: 401, message: "Missing bearer token" };

  try {
    const claims = await verifyJwt(match[1], issuer, jwksUrl, process.env.MCP_JWT_AUDIENCE || undefined);
    return { ok: true, claims };
  } catch (err) {
    if (err instanceof TokenError) return { ok: false, status: 401, message: err.message };
    // Network / JWKS problems are not the caller's fault.
    return { ok: false, status: 503, message: "Could not verify token" };
  }
}
