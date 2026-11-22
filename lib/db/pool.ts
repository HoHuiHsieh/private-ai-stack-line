import { Pool, type PoolClient, type QueryResultRow } from "pg";

/**
 * Shared PostgreSQL (pgvector) connection pool for agent-service.
 *
 * Env (names only, set in .env / .env.dev):
 *   AGENT_DATABASE_URL  postgres://<user>:<password>@pgvector:5432/<AGENT_DB>
 *   PG_POOL_MAX         optional, max connections per process (default 10)
 *
 * One pool per process, cached on globalThis so Next.js dev hot reloads
 * do not open a new pool on every edit.
 */

const globalForPg = globalThis as unknown as { __agentPgPool?: Pool };

export function getPool(): Pool {
  if (!globalForPg.__agentPgPool) {
    const connectionString = process.env.AGENT_DATABASE_URL;
    if (!connectionString) throw new Error("AGENT_DATABASE_URL is not set");

    const pool = new Pool({
      connectionString,
      max: Number(process.env.PG_POOL_MAX) || 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    // An idle client can drop (e.g. Postgres restart). Log it instead of crashing the process.
    pool.on("error", (err) => console.error("pg pool: idle client error:", err.message));
    globalForPg.__agentPgPool = pool;
  }
  return globalForPg.__agentPgPool;
}

/** Run one statement on a pooled connection. Parameters use $1, $2, ... */
export function query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
  return getPool().query<T>(text, values);
}

/** Borrow a client for several statements; it is always released afterwards. */
export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/** BEGIN / COMMIT, or ROLLBACK if fn throws. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  });
}

/** Format numbers as a pgvector literal, e.g. [0.1,0.2,0.3]. Use with $1::vector. */
export function toVectorLiteral(values: number[]): string {
  if (!values.every((v) => Number.isFinite(v))) throw new Error("vector values must be finite numbers");
  return `[${values.join(",")}]`;
}

/** Check that the database is reachable and the pgvector extension is installed. */
export async function checkPgvector(): Promise<{ ok: true; version: string } | { ok: false; reason: string }> {
  try {
    const res = await query<{ extversion: string }>("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
    if (res.rows.length === 0) return { ok: false, reason: "pgvector extension is not installed" };
    return { ok: true, version: res.rows[0].extversion };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "database unreachable" };
  }
}
