-- 23-customer-gender.sql — gender-aware addressing ("স্যার" / "ম্যাডাম")
-- + a manual name override that the Meta refresh must never overwrite.
-- Meta gives no gender for Page-scoped customers (and no photo), so the
-- gender is inferred from the customer's NAME (see
-- apps/api/src/customers/gender.ts) and stored here.
--   'male'    → the AI addresses the customer as "স্যার" throughout a reply
--   'female'  → the AI addresses the customer as "ম্যাডাম" throughout
--   'unknown' → neutral "আপনি" only — never স্যার/ম্যাডাম when unsure
-- The value is only ever auto-filled when it is 'unknown'; a gender the
-- shop owner sets by hand in the Inbox (PATCH /api/customers/:id) is
-- never overwritten by the name inference.
--
-- name_manually_set — the owner's manual name correction. The customer's
-- ORIGINAL name stays exactly as it is on Facebook (English stays
-- English, Bengali stays Bengali — never translated or transliterated),
-- but when the owner corrects it by hand in the Inbox, this flag is set
-- and the automatic profile refresh (channels/meta-profile.ts) must NEVER
-- overwrite the name with the Facebook-returned name again.
-- Idempotent: safe to run more than once.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS gender TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS name_manually_set BOOLEAN NOT NULL DEFAULT FALSE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_gender_check') THEN
    ALTER TABLE customers ADD CONSTRAINT customers_gender_check CHECK (gender IN ('male', 'female', 'unknown'));
  END IF;
END $$;
