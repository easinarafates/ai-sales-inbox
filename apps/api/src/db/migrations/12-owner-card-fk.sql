-- 12-owner-card-fk.sql — Owner Panel: allow deleting a card on file once
-- no PENDING deposit references it.
--
-- Migration 11 created owner_deposits.card_id as a plain REFERENCES
-- (ON DELETE NO ACTION), so even an APPROVED or REJECTED deposit blocked
-- the delete with error 23503 — and because the route had no error
-- handling, the request hung forever instead of answering. With
-- ON DELETE SET NULL the deposit record keeps its amount/method and only
-- the card link is cleared. The route's own 409 check still blocks a
-- delete while a PENDING deposit references the card.
-- Idempotent: safe to re-run on every start (same pattern as the other
-- migrations).
ALTER TABLE owner_deposits DROP CONSTRAINT IF EXISTS owner_deposits_card_id_fkey;
ALTER TABLE owner_deposits
  ADD CONSTRAINT owner_deposits_card_id_fkey
  FOREIGN KEY (card_id) REFERENCES owner_cards(id) ON DELETE SET NULL;
