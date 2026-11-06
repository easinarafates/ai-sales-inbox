-- Owner Panel (platform super-admin) — migration 11.
-- Idempotent: CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS only.
-- PGlite local mode loads it automatically on API start; real Postgres:
--   psql "$DATABASE_URL" -f apps/api/src/db/migrations/11-owner-panel.sql
--
-- Honesty notes:
-- - Deposits are REQUESTS with manual approval (same pattern as shop wallet
--   top-ups). No live payment gateway is called and no real card is charged.
-- - Cards on file store ONLY brand + last 4 digits. Full card numbers and
--   CVV are NEVER stored (a request containing them is rejected with 400).
-- - Bank account numbers are encrypted (AES-256-GCM, TOKEN_ENCRYPTION_KEY)
--   and only the last 4 digits are ever shown or returned by the API.
-- - API costs come ONLY from ai_usage_ledger.provider_cost_paisa (written by
--   the agent per reply, migration 10). Nothing is invented.
-- - Owner-wallet auto-deduction: each AI reply's provider cost is deducted
--   from the owner wallet by a sweep over ai_usage_ledger rows not yet marked
--   owner_deducted. The shop's own wallet charge (cost_paisa) is untouched —
--   the two wallets are separate.
-- - Revenue = subscription_charge rows in wallet_transactions (real money
--   shops paid from their wallets), never the plan price list.

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_owner BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS suspended BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ai_usage_ledger ADD COLUMN IF NOT EXISTS owner_deducted BOOLEAN NOT NULL DEFAULT FALSE;

-- Owner wallet: exactly one row (seeded below). balance = the platform
-- owner's own money for paying AI provider costs.
CREATE TABLE IF NOT EXISTS owner_wallet (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  balance_paisa BIGINT NOT NULL DEFAULT 0,
  low_balance_threshold_paisa BIGINT NOT NULL DEFAULT 100000,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO owner_wallet (balance_paisa, low_balance_threshold_paisa)
SELECT 0, 100000 WHERE NOT EXISTS (SELECT 1 FROM owner_wallet);

-- Owner wallet ledger: every movement of owner money.
-- type: deposit | ai_cost | expense | adjustment. amount_paisa is signed
-- (+ in, - out). provider + reference link an ai_cost row to its ledger row.
CREATE TABLE IF NOT EXISTS owner_wallet_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  amount_paisa BIGINT NOT NULL,
  provider TEXT,
  reference TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Bank / mobile-money accounts that receive subscription money.
CREATE TABLE IF NOT EXISTS owner_bank_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_name TEXT NOT NULL,
  account_holder TEXT NOT NULL,
  account_number_encrypted TEXT NOT NULL,
  account_number_last4 TEXT NOT NULL,
  branch TEXT,
  type TEXT NOT NULL DEFAULT 'bank', -- bank | bkash | nagad
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Card on file: brand + last 4 digits ONLY. No full number, no CVV, ever.
CREATE TABLE IF NOT EXISTS owner_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand TEXT NOT NULL,
  last4 TEXT NOT NULL,
  exp_month INT,
  exp_year INT,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Deposit requests (manual approval, like shop top-ups).
CREATE TABLE IF NOT EXISTS owner_deposits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  amount_paisa BIGINT NOT NULL,
  method TEXT NOT NULL, -- card | bkash | nagad | bank
  transaction_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  card_id UUID REFERENCES owner_cards(id),
  requested_by UUID,
  reviewed_by UUID,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Business expenses (owner's own bookkeeping; NOT auto-deducted from the
-- wallet — the wallet only moves on deposits and AI-cost auto-deduction).
CREATE TABLE IF NOT EXISTS owner_expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_date DATE NOT NULL,
  category TEXT NOT NULL, -- hosting | domain | ai | ads | other
  amount_paisa BIGINT NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_owner_ledger_pending ON ai_usage_ledger(owner_deducted, created_at) WHERE owner_deducted = FALSE;
CREATE INDEX IF NOT EXISTS idx_owner_deposits_status ON owner_deposits(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_owner_expenses_date ON owner_expenses(expense_date);
CREATE INDEX IF NOT EXISTS idx_owner_wallet_tx_created ON owner_wallet_transactions(created_at DESC);
