-- Migration 26: Steadfast shipment tracking state.
-- last_notified_status: the Steadfast status the customer was already
--   messaged about (one notification attempt per status change — a failed
--   send, e.g. Meta's 24h window expired, is not retried every 5 minutes).
-- last_checked_at: when Steadfast was last asked for this shipment's status.
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS last_notified_status TEXT;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ;
