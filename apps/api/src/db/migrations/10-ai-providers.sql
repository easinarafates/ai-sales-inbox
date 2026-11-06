-- Multi-provider AI support (Groq / OpenAI ChatGPT / Gemini / Claude).
-- Idempotent. PGlite local mode loads every file in this folder
-- automatically on API start; real Postgres: psql "$DATABASE_URL" -f
-- apps/api/src/db/migrations/10-ai-providers.sql
--
-- Honesty notes:
-- - ai_provider/ai_model are NULL by default: the workspace follows the
--   system env default (AI_PROVIDER / provider models) until the owner
--   picks a provider explicitly on the AI Providers settings page.
-- - A provider with no API key is never "live": the settings API reports
--   it as key_missing and the agent falls back to Groq (free) instead of
--   pretending the chosen provider answered.
-- - ai_usage_ledger keeps cost_paisa as the wallet deduction (unchanged:
--   0 inside the plan, flat 10 paisa overage). provider_cost_paisa is the
--   provider's real token cost (Groq always 0; paid providers = tokens x
--   the rates in apps/api/src/ai-agent/pricing.ts). fallback_from records
--   which provider the workspace chose when Groq served the reply instead.

-- Per-workspace AI provider choice (NULL = system default).
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS ai_provider TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS ai_model TEXT;

-- Ledger: which model answered, what it really cost, and fallback source.
ALTER TABLE ai_usage_ledger ADD COLUMN IF NOT EXISTS model TEXT NOT NULL DEFAULT '';
ALTER TABLE ai_usage_ledger ADD COLUMN IF NOT EXISTS provider_cost_paisa BIGINT NOT NULL DEFAULT 0;
ALTER TABLE ai_usage_ledger ADD COLUMN IF NOT EXISTS fallback_from TEXT;
