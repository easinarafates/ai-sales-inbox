-- 42-owner-ai-chat.sql — Owner AI chat history ("AI Sales Manager", 2026-11-11).
--
-- The shop owner chats with the AI about the shop's REAL numbers
-- (orders/replies/cost today). Each turn is stored per workspace so the
-- page loads past messages on open. One row per message (user or
-- assistant); the API pairs them by created_at order.
--
-- Idempotent: safe to re-run (same pattern as migrations 35–40).
-- NOTE: the embedded copy in apps/api/src/db/migrate-prod.ts must be
-- added by the coordinator before deploy (migrate-prod.ts is owned by
-- another worker) — PGlite applies this file automatically on boot.
CREATE TABLE IF NOT EXISTS owner_ai_chats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  user_id UUID,
  role TEXT NOT NULL, -- 'user' | 'assistant'
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_owner_ai_chats_workspace_created
  ON owner_ai_chats (workspace_id, created_at);
