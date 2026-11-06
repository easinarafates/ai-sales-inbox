-- New AiPraktor-style features (Worker B) — idempotent.
-- PGlite local mode loads every file in this folder automatically on API
-- start; real Postgres: psql "$DATABASE_URL" -f apps/api/src/db/migrations/08-new-features.sql
--
-- Honesty notes:
-- - Photo recognition needs an embeddings service (EMBEDDING_PROVIDER);
--   without one the API honestly returns available:false — nothing here
--   fakes a match.
-- - Voice notes have no real transcription service (no money): a note
--   without a transcript is stored as "transcript pending", never invented.
-- - Team invites send NO email: the invite link is shown to share by hand.
-- - The video "guide" is written step-by-step guides in code, not videos.

-- 3. Human handover with timer (conversations already have mode ai|human).
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS handover_until TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS handover_started_at TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS handed_to TEXT NOT NULL DEFAULT 'ai';

-- 6. Follow-ups hot/warm split.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS warmth TEXT NOT NULL DEFAULT 'warm';
ALTER TABLE followups ADD COLUMN IF NOT EXISTS warmth TEXT NOT NULL DEFAULT 'warm';

-- 5. Comments moderation status.
ALTER TABLE comments ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'to_check';
ALTER TABLE comments ADD COLUMN IF NOT EXISTS reply_text TEXT;

-- 4. Saved replies (one-tap answers for the inbox).
CREATE TABLE IF NOT EXISTS saved_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  channel TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_saved_replies_workspace ON saved_replies(workspace_id, created_at DESC);

-- 2. Voice-note orders.
CREATE TABLE IF NOT EXISTS voice_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  conversation_id UUID REFERENCES conversations(id),
  transcript TEXT,
  duration_sec INT,
  audio_ref TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  extracted JSONB,
  order_id UUID REFERENCES orders(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_voice_notes_workspace ON voice_notes(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_voice_notes_conversation ON voice_notes(conversation_id);

-- 7. Agent Desk: versioned plain-words instructions for the AI.
CREATE TABLE IF NOT EXISTS agent_desk_instructions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  version INT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_desk_workspace ON agent_desk_instructions(workspace_id, version DESC);

-- 8. Team invites (no email is sent — the link is shared by hand).
CREATE TABLE IF NOT EXISTS team_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  invited_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_team_invites_workspace ON team_invites(workspace_id, created_at DESC);

-- 9. Website chat: one public key per workspace (never an auth token).
CREATE TABLE IF NOT EXISTS website_chat_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL UNIQUE,
  public_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 11. Setup wizard progress (7 steps) + go-live test code.
CREATE TABLE IF NOT EXISTS setup_progress (
  workspace_id UUID PRIMARY KEY,
  completed_steps TEXT[] NOT NULL DEFAULT '{}',
  test_code TEXT,
  test_code_verified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
