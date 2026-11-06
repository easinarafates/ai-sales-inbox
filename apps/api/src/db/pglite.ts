/**
 * PGlite (embedded Postgres) adapter — local runs WITHOUT Docker.
 *
 * When DATABASE_URL starts with `pglite://` (or USE_PGLITE=true), the API
 * talks to an in-process Postgres (PGlite) stored in a local data folder
 * instead of a real Postgres server. It speaks real Postgres SQL, so the
 * same queries, transactions, JSONB operators and ON CONFLICT dedup all work.
 *
 * Two narrow stubs, both ONLY in this local mode (schema.sql is untouched):
 *  - `pgcrypto` extension: not shipped with PGlite. It is stripped on load;
 *    `gen_random_uuid()` is core Postgres since PG13, so UUID defaults work.
 *  - `pgvector` extension: not shipped with PGlite (no `vector` type).
 *    `embedding vector(768)` is loaded as `embedding text` instead. Image /
 *    knowledge embeddings are Phase-2 work anyway; nothing in Phase 1 reads
 *    the embedding column.
 *
 * The data folder persists between runs (delete it to reset the database).
 * Only ONE process may open the same data folder at a time.
 */
import fs from 'node:fs';
import path from 'node:path';

export function isPgliteMode(): boolean {
  const url = process.env.DATABASE_URL ?? '';
  return process.env.USE_PGLITE === 'true' || url.startsWith('pglite://');
}

export function pgliteDataDir(): string {
  const url = process.env.DATABASE_URL ?? '';
  if (url.startsWith('pglite://')) {
    const p = url.slice('pglite://'.length).trim() || './.pglite-data';
    return path.resolve(process.cwd(), p);
  }
  return path.resolve(process.cwd(), process.env.PGLITE_DATA_DIR ?? './.pglite-data');
}

function findSchemaPath(): string {
  const candidates = [
    process.env.SCHEMA_PATH ?? '',
    path.resolve(__dirname, '../../../schema.sql'),
    path.resolve(process.cwd(), 'schema.sql'),
    path.resolve(process.cwd(), '../../schema.sql'),
    path.resolve(process.cwd(), '../schema.sql'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(`schema.sql not found (tried: ${candidates.join(', ')})`);
}

function transformSchemaForPglite(sql: string): string {
  return sql
    .replace(
      /CREATE EXTENSION IF NOT EXISTS pgcrypto;/g,
      '-- [PGlite] pgcrypto not available; gen_random_uuid() is core Postgres since PG13',
    )
    .replace(
      /CREATE EXTENSION IF NOT EXISTS vector;/g,
      '-- [PGlite] pgvector not available; embedding stored as TEXT (stub, Phase 1 does not read it)',
    )
    .replace(/embedding vector\(768\)/g, 'embedding text');
}

interface PGliteQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

interface PGliteClient {
  query: (text: string, params?: unknown[]) => Promise<PGliteQueryResult>;
  release: () => void;
}

/**
 * Minimal pg.Pool-compatible surface used by this codebase:
 * query(), connect() (with BEGIN/COMMIT transactions), on(), end().
 * Transactions are serialised with a small mutex because PGlite is a single
 * in-process connection — two concurrent transactions would interleave.
 */
export class PGlitePool {
  private db: {
    query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number; affectedRows?: number }>;
    exec: (sql: string) => Promise<unknown>;
    waitReady?: Promise<void>;
    close: () => Promise<void>;
  } | null = null;
  private ready: Promise<void> | null = null;
  private schemaLoaded = false;
  private lock: Promise<void> = Promise.resolve();

  private async getDb(): Promise<NonNullable<PGlitePool['db']>> {
    if (this.db) return this.db;
    if (!this.ready) {
      this.ready = (async () => {
        // Dynamic import: @electric-sql/pglite is ESM, the API is CommonJS.
        const { PGlite } = (await import('@electric-sql/pglite')) as typeof import('@electric-sql/pglite');
        const dataDir = pgliteDataDir();
        console.log(`[db] PGlite mode — data folder: ${dataDir}`);
        const db = new PGlite(dataDir) as unknown as NonNullable<PGlitePool['db']>;
        if (db.waitReady) await db.waitReady;
        this.db = db;
        await this.ensureSchema(db);
      })();
    }
    await this.ready;
    return this.db as unknown as NonNullable<PGlitePool['db']>;
  }

  private async ensureSchema(db: NonNullable<PGlitePool['db']>): Promise<void> {
    if (this.schemaLoaded) return;
    const check = await db.query("SELECT to_regclass('public.workspaces') AS t");
    if (!check.rows[0]?.t) {
      const schemaPath = findSchemaPath();
      const raw = fs.readFileSync(schemaPath, 'utf8');
      await db.exec(transformSchemaForPglite(raw));
      const count = await db.query(
        "SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
      );
      console.log(
        `[db] PGlite: schema.sql loaded from ${schemaPath} (${Number((count.rows[0] as { n: string }).n)} tables; pgvector embedding stored as TEXT — stub)`,
      );
    }
    // Migration for local DBs created before the provider column existed.
    await db.query(
      "ALTER TABLE ai_usage_ledger ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'gemini'",
    );
    // Phase 2/3 migrations (idempotent: CREATE TABLE IF NOT EXISTS /
    // ADD COLUMN IF NOT EXISTS). Run on every start so local DBs created
    // before Phase 2 get the new tables/columns. Real Postgres: run the
    // same files with psql (see RUNNING.md).
    const migrationDirs = [
      path.resolve(path.dirname(findSchemaPath()), 'apps/api/src/db/migrations'),
      path.resolve(__dirname, 'migrations'),
    ];
    for (const dir of migrationDirs) {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
      for (const f of files) {
        const sql = fs.readFileSync(path.join(dir, f), 'utf8');
        await db.exec(transformSchemaForPglite(sql));
      }
      if (files.length > 0) {
        console.log(`[db] PGlite: applied ${files.length} migration(s) from ${dir}`);
      }
      break;
    }
    this.schemaLoaded = true;
  }

  async query(text: string, params: unknown[] = []): Promise<PGliteQueryResult> {
    const db = await this.getDb();
    const res = await db.query(text, params as never[]);
    return { rows: res.rows, rowCount: res.rowCount ?? res.affectedRows ?? res.rows.length };
  }

  async connect(): Promise<PGliteClient> {
    // Serialise transactions: only one checked-out client at a time.
    let releaseLock!: () => void;
    const willLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const previous = this.lock;
    this.lock = previous.then(() => willLock);
    await previous;
    const db = await this.getDb();
    let released = false;
    return {
      query: async (text: string, params: unknown[] = []) => {
        const res = await db.query(text, params as never[]);
        return { rows: res.rows, rowCount: res.rowCount ?? res.affectedRows ?? res.rows.length };
      },
      release: () => {
        if (!released) {
          released = true;
          releaseLock();
        }
      },
    };
  }

  // pg.Pool surface used by callers — no-op here.
  on(_event: string, _listener: (...args: unknown[]) => void): void {
    /* PGlite is in-process; nothing to listen for. */
  }

  async end(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
      this.ready = null;
      this.schemaLoaded = false;
    }
  }
}

export function createPglitePool(): PGlitePool {
  return new PGlitePool();
}
