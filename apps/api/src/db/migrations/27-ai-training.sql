-- Migration 27: AI training behaviours (2026-11-08, user-dictated).
-- 1) messages.media_url / media_type: a customer photo or voice note
--    saved from the Messenger webhook (downloaded with the Page token,
--    re-uploaded to Vercel Blob) so the AI can analyse it later. The
--    webhook intake stores the Blob URL here; the agent reads it back.
--    media_type: 'image' | 'audio' (voice note) | 'video' | null.
-- 2) conversations.gibberish_warned: the gibberish guard replies ONCE
--    per episode ("আমি আপনার কথাটি বুঝতে পারিনি...") and then ignores
--    further gibberish silently (no AI call, no token). The flag is set
--    when that one reply goes out and cleared when the customer writes
--    something meaningful again.
-- 3) notifications: owner notifications the header bell actually shows.
--    Created when a customer is escalated to Waiting for anger or an
--    off-topic question ("কাস্টমার রেগে গিয়েছে, আপনি একে সামলান").
--    is_read flips when the owner opens it from the bell.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_url TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_type TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS gibberish_warned BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  type TEXT NOT NULL, -- angry_customer | off_topic
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  conversation_id UUID,
  customer_id UUID,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_workspace_unread
  ON notifications (workspace_id, is_read, created_at DESC);
