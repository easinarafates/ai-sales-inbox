-- 22-wallet-tx-description.sql — human-readable note on each wallet row.
-- The Billing page shows this description (e.g. the ৳50 free credit on
-- signup). When it is empty the page falls back to a translated type label.
-- Idempotent: safe to run more than once.
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS description TEXT;
