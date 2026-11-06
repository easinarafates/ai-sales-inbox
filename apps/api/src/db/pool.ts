import { Pool, type QueryResultRow } from 'pg';
import { config } from '../config';
import { createPglitePool, isPgliteMode } from './pglite';

/**
 * Database pool.
 *
 * Normal mode: real Postgres via `pg` Pool (DATABASE_URL=postgres://...).
 * Local mode: embedded PGlite when DATABASE_URL starts with `pglite://`
 * (or USE_PGLITE=true) — no Docker/Postgres needed. The PGlite adapter
 * exposes the same query()/connect()/on()/end() surface the code uses.
 */
const realPool = isPgliteMode() ? null : new Pool({ connectionString: config.databaseUrl });
const pglitePool = isPgliteMode() ? createPglitePool() : null;

export const pool = (realPool ?? pglitePool) as unknown as Pool;

if (realPool) {
  realPool.on('error', (err) => {
    // Never crash the process on an idle-client error; log and continue.
    console.error('[db] idle client error:', err.message);
  });
}

/**
 * Workspace-scoped query helper.
 *
 * EVERY query in the API goes through this helper and MUST:
 *  1. pass a non-empty workspaceId (throws otherwise — no unscoped queries), and
 *  2. filter by workspace_id in the SQL itself (WHERE workspace_id = $1, ...).
 *
 * The helper cannot inject the filter generically (SQL varies), so it enforces
 * rule (1) at runtime and every call site is responsible for rule (2).
 * Use `pool.query` directly ONLY for pre-workspace flows (signup/login lookups
 * by email) — never for tenant data.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  workspaceId: string,
  text: string,
  params: unknown[] = [],
): Promise<{ rows: T[]; rowCount: number }> {
  if (!workspaceId || typeof workspaceId !== 'string') {
    throw new Error('query() requires a workspaceId — unscoped queries are forbidden');
  }
  const result = await pool.query<T>(text, params as never[]);
  return { rows: result.rows, rowCount: result.rowCount ?? 0 };
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  workspaceId: string,
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const { rows } = await query<T>(workspaceId, text, params);
  return rows[0] ?? null;
}
