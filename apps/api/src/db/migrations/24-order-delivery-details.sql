-- 24-order-delivery-details.sql — A-to-Z order details: who ordered, when,
-- phone + delivery address.
--
-- Problem (2026-11-07): the orders table had NO phone/address snapshot, and
-- the create_order AI tool accepted only {items} — so the AI could not pass
-- or store the phone/address even when it asked for them, and in a live test
-- it falsely claimed it already had them and created the order anyway. The
-- Orders page could therefore show only an id, a total and a status — never
-- who ordered, when they could be reached, or where to deliver.
--
-- Fix: snapshot the delivery contact onto the order itself at creation time
-- (customer_name, customer_phone, delivery_address). The snapshot is what
-- the customer gave WHEN they ordered — the live customer row can change
-- later, but the order keeps its own copy, so the dashboard always shows
-- the A-to-Z details of that order. The create_order tool and
-- POST /api/orders now refuse to create an order when the phone or the
-- delivery address is missing (they must ask the customer first), so new
-- orders always carry them.
--
-- Older orders (created before this migration) have NULLs here, and the
-- Orders pages show an honest 'দেওয়া হয়নি' / 'Not provided' for those —
-- never invented data.
-- Idempotent: safe to run more than once.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_name TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_phone TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_address TEXT;
