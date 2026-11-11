-- 45-owner-panel-manage.sql — Owner Panel user + subscription management (2026-11-11).
--
-- Feature 5: the platform owner can block / restrict / delete user
-- accounts and approve / cancel subscriptions from /owner.
--
-- users.account_status — 'active' | 'blocked' | 'restricted' | 'deleted'
--   * blocked: cannot log in at all (auth/routes.ts login returns 403
--     with "আপনার অ্যাকাউন্টটি ব্লক করা হয়েছে").
--   * restricted: CAN log in, but AI replies and post scheduling are
--     disabled (read-only). Enforced per-workspace via
--     workspaces.restricted (see below) — checkAiReplyAllowance refuses
--     the reply and the schedule-post endpoints refuse the post.
--   * deleted: SOFT delete — the row stays (data recoverable), login
--     is refused, deleted_at records when it happened. Nothing is hard
--     deleted by the Owner Panel.
-- workspaces.restricted — enforcement flag for restrict. It lives on
--   the workspace because AI replies and scheduling are workspace-level
--   (the webhook has no per-user context): restricting one account
--   restricts that account's whole shop. Cleared on unrestrict, unless
--   another user of the same workspace is still restricted.
-- owner_audit_log — every owner management action (who, when, target,
--   action) so nothing happens silently.
--
-- LIMIT (honest): JWTs are stateless — blocking/deleting does NOT
-- revoke tokens already issued (their jti values are not stored
-- anywhere to revoke). A blocked user's existing session keeps working
-- until the token expires (30 days) or they log out (logout revokes
-- that token via revoked_tokens, migration 38). Login is refused
-- immediately, which is the part that matters for a blocked account.
--
-- Idempotent: safe to re-run (same pattern as migrations 35–40).
-- NOTE: like migrations 41/42, this file is NOT embedded in
-- apps/api/src/db/migrate-prod.ts — PGlite loads every *.sql file in
-- this folder on API start, but production (Neon) needs this file
-- applied (psql / coordinator step) before the next API deploy, or
-- login will 500 on the missing account_status column.
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS restricted BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS owner_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID,
  actor_email TEXT NOT NULL,
  target_user_id UUID,
  target_email TEXT,
  target_workspace_id UUID,
  action TEXT NOT NULL, -- block | unblock | restrict | unrestrict | delete | approve_subscription | cancel_subscription | approve_topup | reject_topup
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_owner_audit_log_created ON owner_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_owner_audit_log_target ON owner_audit_log(target_user_id, created_at DESC);
