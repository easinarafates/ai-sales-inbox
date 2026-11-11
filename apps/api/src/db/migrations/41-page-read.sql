-- 41-page-read.sql — Page Read (Feature 2): AI learns the whole Facebook page (2026-11-11).
--
-- The Halal Chic Page has OLD products sold long ago that are NOT in the
-- website's product list. When a customer sends a screenshot of an old
-- product, the AI does not recognise it. "পেজ পড়ুন" (Read Page) fetches
-- the Page's post history via the Graph API with the stored Page token,
-- extracts candidate products with Gemini Lite, and stores them here as
-- PENDING items. Nothing goes live in the AI's knowledge until the owner
-- reviews and confirms each item (POST /api/knowledge/page-read/:id/confirm
-- copies it into knowledge_items with the old-product wording and marks
-- this row 'confirmed'). Rejected rows stay as 'rejected' so a re-read
-- does not surface the same product again.
--
-- Idempotent: safe to re-run (same pattern as migrations 35–40).
-- NOTE: on real Postgres (Neon) this file must be applied with psql OR
-- embedded in apps/api/src/db/migrate-prod.ts (migration 41) before the
-- next API deploy — the Vercel bundle does not include .sql files.
-- Local PGlite applies it from disk automatically on boot.
CREATE TABLE IF NOT EXISTS page_read_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  name TEXT NOT NULL,
  price_paisa INT, -- NULL = the post stated no price; NEVER invent one
  description TEXT,
  photo_url TEXT,
  source_post_id TEXT,
  source_post_url TEXT,
  post_created_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | rejected
  knowledge_id UUID, -- knowledge_items row created on confirm
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_page_read_products_workspace_status
  ON page_read_products (workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_page_read_products_source_post
  ON page_read_products (workspace_id, source_post_id);
