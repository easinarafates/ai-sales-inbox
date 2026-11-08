-- Migration 31: order cancellation requests (2026-11-08, user report).
--
-- The user reported orders cannot be cancelled properly, and the AI must
-- NEVER cancel an order on its own. The flow is:
--   1. Customer asks to cancel → the AI (or the request_order_cancellation
--      tool) creates a PENDING cancel request — the order is NOT cancelled.
--   2. The owner gets a notification (bell + order view) — "[Customer]
--      (order ASI-XXXX) wants to cancel the order".
--   3. The owner APPROVES (order → cancelled, customer is told) or
--      DECLINES (order stays as-is, the owner handles it manually).
--
-- - order_cancel_requests: one row per request. A partial unique index
--   (workspace_id, order_id) WHERE status = 'pending' means at most ONE
--   pending request per order — a customer asking twice does not create
--   two requests, and the owner never sees a duplicate.
-- - notifications.order_id: the cancel-request notification carries the
--   order so the bell / order view can link straight to it (the angry
--   and off-topic notifications have no order, so the column is NULL
--   for them).

CREATE TABLE IF NOT EXISTS order_cancel_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  customer_id UUID,
  conversation_id UUID,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'declined')),
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cancel_requests_one_pending
  ON order_cancel_requests (workspace_id, order_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_cancel_requests_workspace_status
  ON order_cancel_requests (workspace_id, status, created_at DESC);

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS order_id UUID;
CREATE INDEX IF NOT EXISTS idx_notifications_workspace_order
  ON notifications (workspace_id, order_id) WHERE order_id IS NOT NULL;
