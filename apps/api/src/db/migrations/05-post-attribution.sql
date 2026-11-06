-- Post attribution (post <-> conversation <-> order link) — fixes the
-- post-to-order analytics gap (GET /api/analytics/posts used to return
-- chats = 0 and orders = 0 for every post).
--
-- WHY A SEPARATE LINK TABLE (instead of a post_id column on
-- conversations):
--   * One conversation can come from comments on SEVERAL posts: the
--     webhook reuses a customer's open conversation
--     (findOrCreateConversation), so a single post_id column on
--     conversations could only remember the FIRST post.
--   * One post produces MANY conversations (many commenters).
--   * So the link is many-to-many, which needs its own table.
--   * order_id is NULL until an order is created from that conversation
--     (see linkOrderToAttribution in apps/api/src/analytics/attribution.ts);
--     the analytics endpoint ALSO counts orders through the conversation
--     (orders.conversation_id) as a fallback, so orders are never lost
--     if the order link was written before this migration existed.
--
-- Plain Postgres; idempotent (CREATE TABLE IF NOT EXISTS / CREATE INDEX
-- IF NOT EXISTS). PGlite local mode applies every file in this folder
-- automatically on API start (see apps/api/src/db/pglite.ts); real
-- Postgres: psql "$DATABASE_URL" -f apps/api/src/db/migrations/05-post-attribution.sql
-- Every query on this table filters by workspace_id.

CREATE TABLE IF NOT EXISTS post_attributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  post_id UUID NOT NULL REFERENCES scheduled_posts(id),
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  order_id UUID REFERENCES orders(id),
  source TEXT NOT NULL DEFAULT 'comment', -- 'comment' | 'tiktok_comment'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, post_id, conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_post_attributions_post_id
  ON post_attributions (workspace_id, post_id);
CREATE INDEX IF NOT EXISTS idx_post_attributions_conversation_id
  ON post_attributions (workspace_id, conversation_id);
CREATE INDEX IF NOT EXISTS idx_post_attributions_order_id
  ON post_attributions (workspace_id, order_id);
