// PostgreSQL access. One pool per process (kept on globalThis so Next.js dev reloads do not leak pools).
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

const g = globalThis as unknown as { __smPool?: Pool };

export function pool(): Pool {
  if (!g.__smPool) {
    const connectionString = process.env.POSTGRES_URL;
    if (!connectionString) throw new Error('POSTGRES_URL is not set (copy .env.example to .env)');
    g.__smPool = new Pool({ connectionString, max: Number(process.env.PG_POOL_MAX ?? 10) });
    g.__smPool.on('error', (err) => console.error('[pg] idle client error', err.message));
  }
  return g.__smPool;
}

export async function q<R extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<R[]> {
  const res = await pool().query<R>(text, params);
  return res.rows;
}

export async function one<R extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<R | null> {
  const rows = await q<R>(text, params);
  return rows[0] ?? null;
}

/** Run fn inside BEGIN/COMMIT on a single connection; ROLLBACK if it throws. */
export async function withTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already broken */ }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (g.__smPool) {
    const p = g.__smPool;
    g.__smPool = undefined;
    await p.end();
  }
}

/** numeric columns come back from pg as strings: convert for the UI/API. */
export const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
export const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
