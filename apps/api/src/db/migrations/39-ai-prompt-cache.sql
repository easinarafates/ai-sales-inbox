-- 39-ai-prompt-cache.sql — Gemini 24h prompt caching (2026-11-11).
--
-- The sales agent's prompt has a STABLE prefix (system prompt + shop
-- context: knowledge + delivery charges + products, ~3,517 tokens) that
-- is identical for every reply of a shop, and a VARIABLE suffix (this
-- customer, history, new messages). The stable prefix can live in a
-- Gemini explicit cachedContent (TTL 24h), priced at the cached-input
-- rate ($0.03/1M instead of $0.30/1M for gemini-3.5-flash-lite).
--
--   * ai_usage_ledger.cached_input_tokens: tokens of a reply served
--     from a prompt cache (explicit or implicit), so provider_cost_paisa
--     can be computed with the discounted cached rate (pricing.ts).
--   * ai_prompt_caches: one explicit-cache record per workspace —
--     the Gemini cache name, the SHA-256 of the cached stable context
--     (a price/product/knowledge change changes the hash, so the next
--     reply drops the stale cache and recreates it), its token count,
--     expiry, and last use (caches idle > 2h are deleted on load, so a
--     quiet shop stops paying the $1.00/1M-tokens/hour storage cost).
--
-- Break-even (see ai-agent/gemini-cache.ts): storage for a 3,517-token
-- prefix costs ~1,029 paisa/day; each cached reply saves ~11.6 paisa —
-- so explicit caching only pays past ~89 replies/day per shop. Cache
-- creation is therefore volume-gated in code (>= 4 AI replies in the
-- last 60 minutes); the table alone never creates a cache.
--
-- Idempotent: safe to re-run (same pattern as migrations 35–38).
-- The embedded copy in apps/api/src/db/migrate-prod.ts MUST match this
-- file exactly (see scripts/check-migration-39-embedded.mjs).
ALTER TABLE ai_usage_ledger ADD COLUMN IF NOT EXISTS cached_input_tokens INT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS ai_prompt_caches (
  workspace_id UUID PRIMARY KEY,
  cache_name TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  token_count INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_prompt_caches_expires ON ai_prompt_caches(expires_at);
