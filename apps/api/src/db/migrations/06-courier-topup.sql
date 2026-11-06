-- Courier booking + payment top-up (Module: courier/topup).
-- Plain Postgres, idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
-- Applied on real Postgres as-is:
--   psql "$DATABASE_URL" -f apps/api/src/db/migrations/06-courier-topup.sql
-- PGlite local mode loads every *.sql file in this folder on API start.
-- Every table is workspace-scoped: all queries filter by workspace_id.
--
-- NOTE: the `shipments` table ALREADY exists in schema.sql (courier,
-- tracking_code, status). It is NOT recreated here — this migration only
-- adds the columns the courier module needs:
--   * provider_booking_id — the courier's own booking reference (NULL until
--     a real provider books the parcel; NEVER invented/faked).
--   * tracking_number    — the courier's tracking number (NULL until a real
--     provider issues one; `tracking_code` is kept for the AI agent's
--     track_parcel tool, which reads it).

ALTER TABLE shipments ADD COLUMN IF NOT EXISTS provider_booking_id TEXT;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS tracking_number TEXT;

CREATE INDEX IF NOT EXISTS idx_shipments_workspace ON shipments(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shipments_tracking ON shipments(workspace_id, tracking_number);
CREATE INDEX IF NOT EXISTS idx_shipments_order ON shipments(workspace_id, order_id);

-- topup_requests: manual wallet top-up requests (bKash / Nagad / bank /
-- manual). NO payment gateway is involved: the payer sends money by hand
-- (e.g. bKash Send Money) and submits the transaction id; a workspace
-- member reviews it and approves/rejects. Approving credits the wallet
-- and writes a wallet_transactions row — in one transaction.
CREATE TABLE IF NOT EXISTS topup_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  amount_paisa BIGINT NOT NULL,
  method TEXT NOT NULL, -- bkash | nagad | bank | manual
  transaction_id TEXT NOT NULL, -- payer's transaction id (for manual verification)
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  reason TEXT, -- rejection reason (when status = 'rejected')
  requested_by UUID,
  reviewed_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_topup_requests_workspace ON topup_requests(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_topup_requests_status ON topup_requests(workspace_id, status);
