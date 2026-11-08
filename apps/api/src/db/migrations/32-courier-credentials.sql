-- Migration 32: courier API credentials store (2026-11-08, customer details + courier keys).
--
-- The shop owner enters Steadfast / Pathao merchant API keys on the Courier
-- page instead of handing them to a developer for .env. One row per
-- (workspace, provider); the credentials JSON is encrypted with the same
-- AES-256-GCM helper as channel tokens (apps/api/src/db/crypto.ts) and is
-- NEVER returned in plain text — the API only returns masked hasSet flags.
--
-- - courier_credentials: workspace_id, provider ('steadfast' | 'pathao'),
--   credentials_encrypted (the whole credentials object, encrypted),
--   verified_at (set only after a successful READ-ONLY check: Steadfast
--   GET /get_balance, Pathao issue-token + GET /aladdin/api/v1/stores —
--   never a test booking; Steadfast has no sandbox), updated_at.
-- - DB credentials take precedence over env vars; env stays as fallback so
--   shops that already set STEADFAST_API_KEY / PATHAO_* keep working.
-- - RedX / Sundarban are NOT in this table: the user will use only
--   Steadfast + Pathao. They stay honestly "not connected" in the UI.

CREATE TABLE IF NOT EXISTS courier_credentials (
  workspace_id UUID NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('steadfast', 'pathao')),
  credentials_encrypted TEXT NOT NULL,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_courier_credentials_workspace
  ON courier_credentials (workspace_id);
