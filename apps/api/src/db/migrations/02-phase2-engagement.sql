-- Phase 2 engagement tables (Module B).
-- Plain Postgres; safe to run more than once (CREATE TABLE IF NOT EXISTS /
-- ALTER TABLE ... ADD COLUMN IF NOT EXISTS). Run before the Phase 2 API
-- starts: psql "$DATABASE_URL" -f apps/api/src/db/migrations/02-phase2-engagement.sql

-- knowledge_versions: every earlier body of a knowledge item, so a change
-- made through "AI-কে শেখানো" (preview -> apply) can be rolled back.
CREATE TABLE IF NOT EXISTS knowledge_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  knowledge_id UUID NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_knowledge_versions_knowledge_id
  ON knowledge_versions (knowledge_id);

-- post_publish_logs: one row per platform per publish attempt, so a failed
-- scheduled post can show the user why it failed.
CREATE TABLE IF NOT EXISTS post_publish_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  scheduled_post_id UUID NOT NULL,
  platform TEXT NOT NULL,
  attempt INT NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_post_publish_logs_post_id
  ON post_publish_logs (scheduled_post_id);

-- unanswered_questions.taught: true once the owner has taught an answer
-- for the question (POST /api/unanswered/:id/teach).
ALTER TABLE unanswered_questions
  ADD COLUMN IF NOT EXISTS taught BOOLEAN NOT NULL DEFAULT FALSE;

-- leads.call_at: the time the customer asked to be called
-- (PDF section 4: "শুক্রবার বিকেল পাঁচটায় কল দিন" বললে সেই সময় লিডে বসা).
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS call_at TIMESTAMPTZ;
