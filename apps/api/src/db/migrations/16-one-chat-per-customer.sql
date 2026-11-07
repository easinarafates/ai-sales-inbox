-- 16-one-chat-per-customer.sql — one customer = one chat, per channel.
--
-- Bugs fixed (area 3, 2026-11-07):
--  1. Race: findOrCreateCustomer / findOrCreateConversation were
--     check-then-INSERT with no unique constraint, so two webhooks
--     arriving at once (Meta retry, or two quick messages from the
--     same customer) both saw "none" and both INSERTed — duplicate
--     customers for the same PSID and duplicate open conversations.
--  2. Done/snoozed chats never reopened: the lookup only matched
--     status = 'open', so after a chat was marked done the customer's
--     next message spawned a brand-new conversation instead of
--     reopening the old one.
--
-- Guards added here (code in apps/api/src/webhooks/routes.ts and
-- tiktok-dm.ts re-checks + reopens + retries on conflict):
--  * customers.primary_identity — generated from the FIRST stored
--    channel identity ("<platform>:<senderId>"), with a unique index
--    per workspace. Two rows for the same PSID can no longer be
--    inserted; the loser re-reads the winner.
--  * Partial unique index on conversations (workspace, channel,
--    customer) WHERE status = 'open' — at most ONE open conversation
--    per customer per channel. COALESCE covers the NULL-channel rows
--    the follow-ups engine creates.
--
-- Pre-steps, so this file loads cleanly on a DB that already has
-- duplicates from the old race:
--  * Duplicate OPEN conversations are closed first (the earliest one
--    per customer+channel stays open; the later ones become 'done'.
--    Their messages are untouched and stay visible in the inbox).
--  * Duplicate CUSTOMER rows cannot be merged safely here (orders /
--    leads / conversations reference customer_id), so the customers
--    index is created only when no duplicates exist. If the NOTICE
--    below fires on Neon, merge the dupes first via
--    POST /api/customers/merge (or the Customers page) and re-run
--    the CREATE UNIQUE INDEX statement at the bottom by hand.
--    The webhook code still works without the index — the re-check
--    loop closes most of the race window — but the DB guard is what
--    makes it airtight, so do not leave the NOTICE unhandled.
-- Idempotent: IF NOT EXISTS throughout. Do NOT load into Neon from
-- here — the coordinator loads it (see the area-3 report).

-- 1) Close duplicate open conversations (keep the earliest per customer+channel).
UPDATE conversations c
SET status = 'done'
WHERE c.status = 'open'
  AND EXISTS (
    SELECT 1 FROM conversations c2
    WHERE c2.workspace_id = c.workspace_id
      AND c2.customer_id = c.customer_id
      AND c2.channel_id IS NOT DISTINCT FROM c.channel_id
      AND c2.status = 'open'
      AND c2.created_at < c.created_at
  );

-- 2) At most one OPEN conversation per customer per channel.
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_one_open_per_customer_channel
  ON conversations (workspace_id, COALESCE(channel_id, '00000000-0000-0000-0000-000000000000'::uuid), customer_id)
  WHERE status = 'open';

-- 3) Primary channel identity per customer (first stored identity).
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS primary_identity TEXT GENERATED ALWAYS AS (
    CASE WHEN (channel_identities -> 0 ->> 'platform') IS NULL THEN NULL
    ELSE (channel_identities -> 0 ->> 'platform') || ':' || (channel_identities -> 0 ->> 'senderId')
    END
  ) STORED;

-- 4) One customer row per identity per workspace — only if no
--    duplicates already exist (see header note).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM customers
    WHERE primary_identity IS NOT NULL
    GROUP BY workspace_id, primary_identity
    HAVING COUNT(*) > 1
  ) THEN
    RAISE NOTICE 'migration 16: duplicate customer rows exist — SKIPPING idx_customers_one_primary_identity. Merge the duplicates first (POST /api/customers/merge), then run: CREATE UNIQUE INDEX idx_customers_one_primary_identity ON customers (workspace_id, primary_identity) WHERE primary_identity IS NOT NULL;';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_one_primary_identity
      ON customers (workspace_id, primary_identity)
      WHERE primary_identity IS NOT NULL;
  END IF;
END $$;
