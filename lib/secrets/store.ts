import { query } from "../db/pool";
import { decryptSecret, encryptSecret } from "./crypto";

/**
 * Secrets table in the pgvector database (the agent database).
 *
 * Two scopes share the table:
 *  - private: owned by one user (the token's `sub`), identified by (owner, service, name).
 *  - public:  owned by PUBLIC_OWNER, readable by every user as a fallback.
 *
 * Reads (`getSecret`, `getSecretMeta`) check the caller's private secret first, then the
 * public one. Writes and deletes only touch the caller's private secret, except
 * `setPublicSecret`, which is for trusted server-side code and is not exposed to tools.
 * No caller can read another user's private secret, because every private lookup filters
 * on the owner. Values are encrypted with SECRETS_ENCRYPTION_KEY (see crypto.ts).
 *
 * Callers must never return a value to a model or log it. `getSecretMeta` is the
 * safe way to report status.
 *
 * Creator: `created_by` is the account that first created the row. Updates change `updated_by`
 * and the value, never `created_by`. Public secrets are created only by an admin (the API
 * route enforces this).
 */

/**
 * Owner value for public secrets. It is the empty string, which `ownerOf` never returns
 * (it rejects a missing or empty `sub`), so a user can never collide with it.
 */
export const PUBLIC_OWNER = "";

export type SecretMeta = {
  service: string;
  name: string;
  scope: "private" | "public";
  updatedAt: string;
  updatedBy: string;
  /** Account that created the secret. Set once on insert. */
  createdBy: string;
};

let tableReady: Promise<void> | null = null;

/** Creates the table on first use. Safe to call repeatedly. No migration from older layouts. */
export function ensureSecretsTable(): Promise<void> {
  if (!tableReady) {
    tableReady = query(
      `CREATE TABLE IF NOT EXISTS service_secrets (
         owner      text        NOT NULL,
         service    text        NOT NULL,
         name       text        NOT NULL,
         ciphertext text        NOT NULL,
         updated_by text        NOT NULL,
         created_by text        NOT NULL,
         updated_at timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (owner, service, name)
       );`,
    ).then(
      () => undefined,
      (err) => {
        tableReady = null; // retry on the next call
        throw err;
      },
    );
  }
  return tableReady;
}

export async function setSecret(
  owner: string,
  service: string,
  name: string,
  value: string,
  createdBy: string = owner,
): Promise<void> {
  await ensureSecretsTable();
  await query(
    `INSERT INTO service_secrets (owner, service, name, ciphertext, updated_by, created_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5, now())
     ON CONFLICT (owner, service, name)
     DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [owner, service, name, encryptSecret(value), createdBy],
  );
}

/**
 * Stores a public secret that every user can read when they have no private one. The caller must be an admin
 * (enforced in app/api/secrets/route.ts). `updatedBy` is the admin acting; it becomes the creator on insert.
 */
export async function setPublicSecret(service: string, name: string, value: string, updatedBy: string): Promise<void> {
  await ensureSecretsTable();
  await query(
    `INSERT INTO service_secrets (owner, service, name, ciphertext, updated_by, created_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5, now())
     ON CONFLICT (owner, service, name)
     DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [PUBLIC_OWNER, service, name, encryptSecret(value), updatedBy],
  );
}

/**
 * Writes a public secret only if none exists yet. Returns true when this call wrote it.
 * For one-time claims, such as recording which account owns a bot. Never overwrites.
 */
export async function claimPublicSecret(service: string, name: string, value: string, updatedBy: string): Promise<boolean> {
  await ensureSecretsTable();
  const res = await query(
    `INSERT INTO service_secrets (owner, service, name, ciphertext, updated_by, created_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5, now())
     ON CONFLICT (owner, service, name) DO NOTHING`,
    [PUBLIC_OWNER, service, name, encryptSecret(value), updatedBy],
  );
  return res.rowCount === 1;
}

type Found = {
  scope: "private" | "public";
  ciphertext: string;
  updated_at: Date;
  updated_by: string;
  created_by: string;
};

/** The owner's private row if it exists, otherwise the public row, otherwise null. */
async function findSecret(owner: string, service: string, name: string): Promise<Found | null> {
  await ensureSecretsTable();
  const res = await query<{ owner: string; ciphertext: string; updated_at: Date; updated_by: string; created_by: string }>(
    `SELECT owner, ciphertext, updated_at, updated_by, created_by FROM service_secrets
     WHERE service = $1 AND name = $2 AND owner IN ($3, $4)
     ORDER BY (owner = $3) DESC
     LIMIT 1`,
    [service, name, owner, PUBLIC_OWNER],
  );
  const row = res.rows[0];
  if (!row) return null;
  const scope = row.owner === PUBLIC_OWNER ? "public" : "private";
  return {
    scope,
    ciphertext: row.ciphertext,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
    created_by: row.created_by,
  };
}

/** The decrypted private value, else the public value, or null if neither is set. */
export async function getSecret(owner: string, service: string, name: string): Promise<string | null> {
  const found = await findSecret(owner, service, name);
  return found ? decryptSecret(found.ciphertext) : null;
}

/** Status only: never includes the value. Reports which scope the value would come from. */
export async function getSecretMeta(owner: string, service: string, name: string): Promise<SecretMeta | null> {
  const found = await findSecret(owner, service, name);
  if (!found) return null;
  return {
    service,
    name,
    scope: found.scope,
    updatedAt: found.updated_at.toISOString(),
    updatedBy: found.updated_by,
    createdBy: found.created_by,
  };
}

/** Deletes the owner's secret. Returns true if a row was removed. */
export async function deleteSecret(owner: string, service: string, name: string): Promise<boolean> {
  await ensureSecretsTable();
  const res = await query("DELETE FROM service_secrets WHERE owner = $1 AND service = $2 AND name = $3", [owner, service, name]);
  return (res.rowCount ?? 0) > 0;
}

/** Metadata for the caller's private secrets and all public ones. Never includes values. */
export async function listSecrets(owner: string): Promise<SecretMeta[]> {
  await ensureSecretsTable();
  const res = await query<{
    owner: string;
    service: string;
    name: string;
    updated_at: Date;
    updated_by: string;
    created_by: string;
  }>(
    `SELECT owner, service, name, updated_at, updated_by, created_by FROM service_secrets
     WHERE owner IN ($1, $2)
     ORDER BY service, name`,
    [owner, PUBLIC_OWNER],
  );
  return res.rows.map((row) => ({
    service: row.service,
    name: row.name,
    scope: row.owner === PUBLIC_OWNER ? "public" : "private",
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by,
    createdBy: row.created_by,
  }));
}
