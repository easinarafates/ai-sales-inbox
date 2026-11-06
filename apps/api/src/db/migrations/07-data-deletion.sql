-- Data-deletion requests (Meta data-deletion callback) — see
-- apps/api/src/webhooks/meta.ts and meta-approval/data-deletion.md.
--
-- Meta calls POST /api/meta/data-deletion with a signed_request when a
-- user removes the app (Facebook Settings → Apps and Websites → Remove).
-- The endpoint verifies the signature, deletes that Facebook user's data,
-- and records the request here so the status URL in the response
-- (GET /api/meta/data-deletion/status?confirmation_code=...) can answer
-- what happened. The table stores NO personal data — only the Facebook
-- user id (needed to prove the request was handled) and counts.
--
-- Plain Postgres; idempotent (CREATE TABLE IF NOT EXISTS).
-- PGlite local mode loads every file in this folder automatically on API
-- start; real Postgres: psql "$DATABASE_URL" -f apps/api/src/db/migrations/07-data-deletion.sql
CREATE TABLE IF NOT EXISTS data_deletion_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  confirmation_code TEXT NOT NULL UNIQUE,
  facebook_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed', -- 'completed' | 'not_found'
  customers_deleted INT NOT NULL DEFAULT 0,
  conversations_deleted INT NOT NULL DEFAULT 0,
  messages_deleted INT NOT NULL DEFAULT 0,
  orders_anonymised INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_data_deletion_requests_code
  ON data_deletion_requests(confirmation_code);
CREATE INDEX IF NOT EXISTS idx_data_deletion_requests_fb_user
  ON data_deletion_requests(facebook_user_id);
