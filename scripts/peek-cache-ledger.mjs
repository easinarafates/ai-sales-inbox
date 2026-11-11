#!/usr/bin/env node
/**
 * Ledger peek for scripts/verify-ai-prompt-cache.mjs — NOT a test of its
 * own. Opens the local PGlite data folder (while the API is STOPPED —
 * PGlite allows only one process per folder) and prints the workspace's
 * ai_usage_ledger rows (latest first) plus ai_prompt_caches rows, with
 * the expected cached-aware provider cost recomputed per row.
 *
 * Usage: node scripts/peek-cache-ledger.mjs <dataDir> <workspaceId>
 *   dataDir is relative to apps/api (same as the API's DATABASE_URL).
 * Prints one JSON line on stdout.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire('/home/hatch/workspace/ai-sales-inbox/apps/api/package.json');
const { PGlite } = require('@electric-sql/pglite');

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [,, dataDirArg, workspaceId] = process.argv;
if (!dataDirArg || !workspaceId) {
  console.error('usage: node scripts/peek-cache-ledger.mjs <dataDir> <workspaceId>');
  process.exit(1);
}
const dataDir = path.resolve(ROOT, 'apps/api', dataDirArg);

// Cached-aware cost, same formula as apps/api/src/ai-agent/pricing.ts
// (gemini-3.5-flash-lite: input $0.30, cached $0.03, output $2.50 per
// 1M tokens; USD→paisa 12200). Recomputed here so the verifier can
// prove the ledger's provider_cost_paisa used the cached rate.
function expectedCost(provider, model, inputTokens, outputTokens, cachedInputTokens) {
  if (provider === 'groq' || provider === 'demo') return 0;
  if (model !== 'gemini-3.5-flash-lite') return null;
  const cached = Math.max(0, Math.min(cachedInputTokens, inputTokens));
  const usd =
    ((inputTokens - cached) / 1_000_000) * 0.3 +
    (cached / 1_000_000) * 0.03 +
    (outputTokens / 1_000_000) * 2.5;
  return Math.round(usd * 12200);
}

const db = new PGlite(dataDir);
await db.waitReady;
try {
  const ledger = await db.query(
    `SELECT input_tokens, output_tokens, cached_input_tokens, cost_paisa, provider, model, provider_cost_paisa, fallback_from, included_in_plan, created_at
     FROM ai_usage_ledger WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [workspaceId],
  );
  const rows = ledger.rows.map((r) => ({
    input_tokens: Number(r.input_tokens),
    output_tokens: Number(r.output_tokens),
    cached_input_tokens: Number(r.cached_input_tokens),
    cost_paisa: Number(r.cost_paisa),
    provider: r.provider,
    model: r.model,
    provider_cost_paisa: Number(r.provider_cost_paisa),
    fallback_from: r.fallback_from,
    included_in_plan: r.included_in_plan,
    expected_provider_cost_paisa: expectedCost(
      r.provider, r.model,
      Number(r.input_tokens), Number(r.output_tokens), Number(r.cached_input_tokens),
    ),
    created_at: r.created_at,
  }));
  const caches = await db.query(
    'SELECT workspace_id, cache_name, context_hash, token_count, expires_at, last_used_at FROM ai_prompt_caches WHERE workspace_id = $1',
    [workspaceId],
  );
  console.log(JSON.stringify({ rows, cacheRows: caches.rows }));
} finally {
  await db.close();
}
