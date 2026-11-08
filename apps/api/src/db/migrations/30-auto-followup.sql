-- Migration 30: auto re-engagement follow-up (2026-11-08).
--
-- A customer who messaged (showed interest, e.g. asked about a product)
-- but did NOT order gets ONE follow-up after a configurable delay
-- (default 2 days, 1-3). Rules, enforced here and in
-- apps/api/src/followups/auto.ts:
--  - at most ONCE per customer per interest episode (the unique index on
--    (workspace_id, customer_id, episode_key) — the episode is the last
--    incoming message at scheduling time; a new message starts a new
--    episode, so a re-engaged customer can get one more later, never two
--    for the same silence);
--  - NEVER for angry/waiting customers, the owner, or customers who
--    already ordered (checked at schedule AND at send time);
--  - the follow-up is sent by the system via the cron sweep, not by the
--    AI chat.
--
-- META 24H RULE (honest): Messenger/Instagram only allow sending within
-- 24 hours of the customer's last message (error 551 after that). A
-- 2-day delay means the window is normally EXPIRED by send time, so the
-- row is marked 'window_expired' and NO message is sent or faked — the
-- owner sees it in the follow-up report and can message by hand. No
-- message tag is used (a re-engagement nudge does not qualify for one).
-- Webchat has no 24h window (saving IS the delivery), so those send.

CREATE TABLE IF NOT EXISTS auto_followups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  -- The interest episode: the id of the customer's last incoming message
  -- when this follow-up was scheduled. A new incoming message = a new
  -- episode = a new follow-up may be scheduled (once) for it.
  episode_key TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  scheduled_for TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most once per customer per interest episode.
CREATE UNIQUE INDEX IF NOT EXISTS idx_auto_followups_episode
  ON auto_followups (workspace_id, customer_id, episode_key);
CREATE INDEX IF NOT EXISTS idx_auto_followups_due
  ON auto_followups (workspace_id, status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_auto_followups_customer
  ON auto_followups (workspace_id, customer_id);

-- Per-workspace settings: enabled + delay in days (1-3, default 2).
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS auto_followup_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS auto_followup_delay_days INTEGER NOT NULL DEFAULT 2;
