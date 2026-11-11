/**
 * Explicit Gemini prompt-cache lifecycle for one workspace (migration 39).
 *
 * The sales agent's prompt has a STABLE prefix — the system prompt plus
 * the shop context (knowledge + delivery charges + products, ~3,517
 * tokens measured 2026-11-11) — that is identical for every reply of a
 * shop, and a VARIABLE suffix (this customer, history, new messages).
 * Caching the stable prefix as a Gemini cachedContent (TTL 24h) prices
 * those tokens at the cached-input rate ($0.03/1M instead of $0.30/1M
 * for gemini-3.5-flash-lite), saving ~11.6 paisa per cached reply.
 *
 * VOLUME GATE — explicit caching MUST be volume-gated, or it LOSES
 * money (break-even math, official Standard-tier pricing
 * ai.google.dev/gemini-api/docs/pricing, gemini-3.5-flash-lite):
 *   storage: 3,517 tokens x $1.00/1M tokens/hour x 24h
 *          = 0.003517 x $24 = $0.084/day ≈ 1,029 paisa/day
 *   saving:  3,517 cached tokens x ($0.30 - $0.03)/1M x 12,200 paisa/$
 *          ≈ 11.6 paisa per cached reply
 *   break-even: 1,029 / 11.6 ≈ 89 replies/day per shop.
 * The current busiest shop does ~46/day — below break-even — so a
 * cache is created ONLY when the workspace had >= 4 AI replies in the
 * last 60 minutes (a shop replying at that rate is on pace for ~96/day,
 * past break-even). Caches idle > 2 hours are deleted on load, so a
 * shop that goes quiet stops paying storage. The gate is deliberately
 * conservative: an explicit cache that never pays for itself is worse
 * than no cache at all.
 *
 * FREE-TIER REALITY (probed live 2026-11-11 against this key): explicit
 * cache creation currently FAILS with HTTP 429
 * "TotalCachedContentStorageTokensPerModelFreeTier limit exceeded ...
 * limit=0" — context caching is NOT available on the free tier. So
 * every creation failure is treated as "caching unavailable" and the
 * reply falls back to a normal no-cache call — a customer reply NEVER
 * fails because of caching. Creation retries are throttled in-memory
 * (at most one failed attempt per hour per workspace) so a failing
 * call is not added to every reply. IMPLICIT caching still works
 * best-effort on this key (usageMetadata.cachedContentTokenCount is
 * read from every reply) — that is free and needs no cache object.
 *
 * SAFETY: every function here catches its own failures and reports
 * "unavailable" (null) — nothing in this module ever throws into the
 * reply path. No prompt text and no API key is ever logged.
 */
import { createHash } from 'node:crypto';
import { config } from '../config';
import { query, queryOne } from '../db/pool';
import { fetchWithTimeout } from './http';

const GEMINI_MODEL = 'gemini-3.5-flash-lite';
const CACHE_TTL = '86400s'; // 24 hours
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Minimum stable-prefix size worth caching (Gemini minimum is 1024). */
const MIN_CACHEABLE_TOKENS = 1024;
/** Create an explicit cache only at this reply pace (see header math). */
const VOLUME_GATE_REPLIES_PER_HOUR = 4;
/** Delete a cache that has not been used for this long (stops storage cost). */
const IDLE_DELETE_MS = 2 * 60 * 60 * 1000;
/** At most one FAILED creation attempt per hour per workspace. */
const CREATE_RETRY_COOLDOWN_MS = 60 * 60 * 1000;

export interface WorkspacePromptCache {
  cacheName: string;
  contextHash: string;
  tokenCount: number;
  expiresAt: Date;
}

interface CacheRow {
  cache_name: string;
  context_hash: string;
  token_count: number;
  expires_at: string;
  last_used_at: string;
}

/** SHA-256 of the stable context — a price/product/knowledge change changes the hash. */
export function hashStableContext(stableText: string): string {
  return createHash('sha256').update(stableText, 'utf8').digest('hex');
}

// --- In-memory throttle: last failed creation attempt per workspace. ---
const lastFailedCreateAt = new Map<string, number>();

function geminiBase(): string {
  return 'https://generativelanguage.googleapis.com/v1beta';
}

function apiKey(): string {
  return encodeURIComponent(config.geminiApiKey);
}

interface CachedContentResponse {
  name?: string;
  expireTime?: string;
}

/** Best-effort DELETE of a Gemini cachedContent — never throws. */
async function deleteGeminiCache(cacheName: string): Promise<void> {
  if (!config.geminiApiKey) return;
  try {
    const res = await fetchWithTimeout(
      `${geminiBase()}/${cacheName}?key=${apiKey()}`,
      { method: 'DELETE' },
      15000,
    );
    if (!res.ok) {
      // A 404 means it is already gone (expired/deleted) — fine either way.
      console.error(`[ai-cache] delete ${cacheName} returned ${res.status} (best-effort, ignored)`);
    }
  } catch (err) {
    console.error(`[ai-cache] delete ${cacheName} failed (best-effort, ignored):`, (err as Error).message);
  }
}

async function deleteCacheRow(workspaceId: string): Promise<void> {
  await query(workspaceId, 'DELETE FROM ai_prompt_caches WHERE workspace_id = $1', [workspaceId]).catch((err) =>
    console.error('[ai-cache] delete cache row failed:', (err as Error).message),
  );
}

/**
 * Invalidate a workspace's prompt cache: delete the Gemini cachedContent
 * (best-effort — a 404/expired cache is already gone) AND the DB row.
 * Call from EVERY write path that changes cached content (products,
 * stock, knowledge, delivery charges) so a price change is visible in
 * the very next reply. Never throws.
 */
export async function invalidateWorkspacePromptCache(workspaceId: string): Promise<void> {
  let row: CacheRow | null = null;
  try {
    row = await queryOne<CacheRow>(
      workspaceId,
      'SELECT cache_name FROM ai_prompt_caches WHERE workspace_id = $1',
      [workspaceId],
    );
  } catch {
    // Table missing (migration 39 not applied yet) — nothing to invalidate.
    return;
  }
  if (row?.cache_name) await deleteGeminiCache(row.cache_name);
  await deleteCacheRow(workspaceId);
}

/** Exact token count of the stable prefix (system prompt + stable turn). */
async function countStableTokens(systemInstruction: string, stableText: string): Promise<number | null> {
  try {
    // NOTE: the v1beta countTokens method does NOT accept systemInstruction
    // (HTTP 400 "Unknown name systemInstruction") — it only counts
    // `contents`. Tokenisation is per-text, so counting the system prompt
    // + stable text as two parts of one user turn gives the same total
    // as the real split call (systemInstruction + stable user turn).
    const res = await fetchWithTimeout(
      `${geminiBase()}/models/${GEMINI_MODEL}:countTokens?key=${apiKey()}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: systemInstruction }, { text: stableText }] }],
        }),
      },
      15000,
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`[ai-cache] countTokens failed (${res.status}): ${detail.slice(0, 200)}`);
      return null;
    }
    const data = (await res.json()) as { totalTokens?: number };
    return typeof data.totalTokens === 'number' ? data.totalTokens : null;
  } catch (err) {
    console.error('[ai-cache] countTokens failed:', (err as Error).message);
    return null;
  }
}

/** Create the explicit cache on Gemini. Returns its name, or null on any failure. */
async function createGeminiCache(
  systemInstruction: string,
  stableText: string,
): Promise<{ name: string; expireTime: string } | null> {
  try {
    const res = await fetchWithTimeout(
      `${geminiBase()}/cachedContents?key=${apiKey()}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: `models/${GEMINI_MODEL}`,
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents: [{ role: 'user', parts: [{ text: stableText }] }],
          ttl: CACHE_TTL,
        }),
      },
      20000,
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // Free tier: 429 "limit=0" — explicit caching is unavailable on
      // this key. Any failure here means "unavailable", never an error
      // in the reply path (the caller falls back to no-cache).
      console.error(`[ai-cache] create failed (${res.status}): ${detail.slice(0, 200)}`);
      return null;
    }
    const data = (await res.json()) as CachedContentResponse;
    if (!data.name) return null;
    return { name: data.name, expireTime: data.expireTime ?? new Date(Date.now() + CACHE_TTL_MS).toISOString() };
  } catch (err) {
    console.error('[ai-cache] create failed:', (err as Error).message);
    return null;
  }
}

/**
 * Load the workspace's explicit cache, creating it when the volume gate
 * passes. Returns null when caching is unavailable for ANY reason
 * (volume gate, too short to cache, throttled recent failure, Gemini
 * error, free-tier 429, missing table) — the caller then replies
 * uncached. Never throws.
 *
 * Load path:
 *  1. Throttled recent failure → null (no API call at all).
 *  2. Existing row: hash mismatch → delete + recreate; expired or idle
 *     > 2h → delete + recreate; else touch last_used_at and return it.
 *  3. No row: volume gate (>= 4 AI replies in the last 60 min) →
 *     countTokens (>= 1024) → create on Gemini → store the row.
 */
export async function getOrCreateWorkspaceCache(
  workspaceId: string,
  systemInstruction: string,
  stableText: string,
  contextHash: string,
): Promise<WorkspacePromptCache | null> {
  if (!config.geminiApiKey) return null;
  const now = Date.now();
  const failedAt = lastFailedCreateAt.get(workspaceId);
  if (failedAt !== undefined && now - failedAt < CREATE_RETRY_COOLDOWN_MS) {
    return null;
  }

  // 2. Existing row?
  let row: CacheRow | null = null;
  try {
    row = await queryOne<CacheRow>(
      workspaceId,
      'SELECT cache_name, context_hash, token_count, expires_at, last_used_at FROM ai_prompt_caches WHERE workspace_id = $1',
      [workspaceId],
    );
  } catch {
    // Table missing (migration 39 not applied yet) — caching unavailable.
    return null;
  }
  if (row) {
    const expiresAt = new Date(row.expires_at).getTime();
    const lastUsedAt = new Date(row.last_used_at).getTime();
    const stale =
      row.context_hash !== contextHash || expiresAt <= now + 5 * 60 * 1000 || now - lastUsedAt > IDLE_DELETE_MS;
    if (!stale) {
      await query(
        workspaceId,
        'UPDATE ai_prompt_caches SET last_used_at = now() WHERE workspace_id = $1',
        [workspaceId],
      ).catch(() => undefined);
      return {
        cacheName: row.cache_name,
        contextHash: row.context_hash,
        tokenCount: Number(row.token_count),
        expiresAt: new Date(row.expires_at),
      };
    }
    // Stale content, expired, or idle too long — drop it and recreate below.
    await deleteGeminiCache(row.cache_name);
    await deleteCacheRow(workspaceId);
  }

  // 3. Volume gate: only create when the shop is replying fast enough
  //    for the 24h storage cost to pay for itself (see header math).
  let recentReplies = 0;
  try {
    const counted = await queryOne<{ n: string }>(
      workspaceId,
      `SELECT COUNT(*)::text AS n FROM ai_usage_ledger
        WHERE workspace_id = $1 AND created_at >= now() - interval '60 minutes'`,
      [workspaceId],
    );
    recentReplies = Number(counted?.n ?? 0);
  } catch {
    return null;
  }
  if (recentReplies < VOLUME_GATE_REPLIES_PER_HOUR) return null;

  // 4. Too short to cache (Gemini minimum is 1024 tokens).
  const tokenCount = await countStableTokens(systemInstruction, stableText);
  if (tokenCount === null || tokenCount < MIN_CACHEABLE_TOKENS) return null;

  // 5. Create on Gemini. A failure (e.g. free-tier 429) throttles
  //    further attempts for an hour — never retry on every reply.
  const created = await createGeminiCache(systemInstruction, stableText);
  if (!created) {
    lastFailedCreateAt.set(workspaceId, now);
    return null;
  }
  try {
    await query(
      workspaceId,
      `INSERT INTO ai_prompt_caches (workspace_id, cache_name, context_hash, token_count, expires_at, last_used_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (workspace_id) DO UPDATE
         SET cache_name = EXCLUDED.cache_name, context_hash = EXCLUDED.context_hash,
             token_count = EXCLUDED.token_count, expires_at = EXCLUDED.expires_at, last_used_at = now()`,
      [workspaceId, created.name, contextHash, tokenCount, created.expireTime],
    );
  } catch (err) {
    // Row not stored — the Gemini cache still exists but is untracked;
    // it expires on its own in 24h. Return it anyway for this reply.
    console.error('[ai-cache] storing cache row failed:', (err as Error).message);
  }
  return {
    cacheName: created.name,
    contextHash,
    tokenCount,
    expiresAt: new Date(created.expireTime),
  };
}
