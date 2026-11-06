-- 15-message-delivery.sql — delivery tracking for outgoing messages.
-- messages.delivery_status:
--   'sent'   — Meta Graph API accepted the message (platform_message_id set).
--   'failed' — Graph rejected it (or no token / no recipient / unsupported
--               platform). delivery_error holds the human-readable reason.
--   'local'  — saved only, never sent to Meta: the webchat widget reads it
--               from the DB, and a labelled demo-mode reply is never sent
--               to a real customer.
--   'pending' — saved, send in flight (transient; a crash leaves it here).
-- messages.delivery_error: the Graph / human-readable reason when failed.
-- Incoming ('in') rows leave both columns NULL (not applicable).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivery_status TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivery_error TEXT;
