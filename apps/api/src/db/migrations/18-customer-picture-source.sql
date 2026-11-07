-- 18-customer-picture-source.sql — manual customer photos survive Meta refreshes.
--
-- A shop owner can now upload a photo for a customer from the Inbox
-- (POST /api/customers/:id/photo). Meta does not return a profile photo
-- for some senders (e.g. phone-number-registered accounts — see
-- apps/api/src/channels/meta-profile.ts), so the manual photo is the
-- workaround. This marker records WHERE the stored picture came from so
-- the Meta profile refresh never overwrites or clears a manual photo:
--   'meta'   — the URL came from the Meta Graph profile fetch.
--   'manual' — the shop owner uploaded it; enrichCustomerProfileIfNeeded
--              skips the picture fill entirely for these customers.
--   NULL     — no photo yet (or a legacy row); Meta may fill it later.
-- Backfill: every photo already stored came from Meta.
-- Idempotent: safe to re-run on every start (same pattern as the other
-- migrations). Loads on local PGlite (auto-run on boot) and on Neon
-- Postgres with the HTTPS loader before the next deploy.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS picture_source TEXT;
UPDATE customers SET picture_source = 'meta' WHERE picture_url IS NOT NULL AND picture_source IS NULL;
