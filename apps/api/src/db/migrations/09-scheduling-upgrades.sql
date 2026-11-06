-- Scheduling upgrades (Worker C) — media types for scheduled posts.
-- Plain Postgres; idempotent (ADD COLUMN IF NOT EXISTS / CREATE INDEX
-- IF NOT EXISTS). PGlite local mode loads every file in this folder
-- automatically on API start; real Postgres:
--   psql "$DATABASE_URL" -f apps/api/src/db/migrations/09-scheduling-upgrades.sql
--
-- media_type: 'image' | 'video' | 'text' (validated in the API; no
-- CHECK constraint here so the migration stays re-runnable on PGlite).
-- Posts created before this migration keep working: they default to
-- 'text', and the backfill below marks posts that already have media
-- as 'image' (video is distinguished by file extension / upload mime
-- type when the post is created or edited).
ALTER TABLE scheduled_posts
  ADD COLUMN IF NOT EXISTS media_type TEXT NOT NULL DEFAULT 'text';

UPDATE scheduled_posts
  SET media_type = 'image'
  WHERE media_type = 'text'
    AND media_urls IS NOT NULL
    AND jsonb_array_length(media_urls) > 0;

-- Index for the per-day slot count (max 15 scheduled posts / day):
-- count queries filter workspace_id + status + scheduled_at.
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_workspace_day
  ON scheduled_posts (workspace_id, status, scheduled_at);
