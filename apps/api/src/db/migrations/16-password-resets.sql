-- 16-password-resets.sql — token-based "forgot password" flow.
--
-- There was NO password-reset flow at all: a user who forgot their
-- password (or typed the wrong one of two near-identical accounts —
-- easinarafates6609@gmail.com vs easinarafates6609@gamil.com) had no
-- way back in. This table stores ONE row per reset request:
--   token_hash — SHA-256 of the random token (the token itself is NEVER
--                stored, so a DB read cannot reset anyone's password).
--   expires_at — 1 hour after the request.
--   used_at    — set when the reset succeeds; a token works exactly once.
-- Old unused tokens for the same user are marked used when a new one is
-- requested, so only the latest link works.
-- Idempotent: safe to re-run on every start (same pattern as the other
-- migrations). Loads on local PGlite (auto-run on boot) and on Neon
-- Postgres with psql (load-neon-http.js).
-- NOTE: there is still no email sender in the codebase, so the reset
-- LINK cannot be emailed yet — see POST /api/auth/forgot-password in
-- apps/api/src/auth/routes.ts. The endpoints + UI below are complete
-- and tested; wiring a mailer (Resend free tier / Gmail SMTP) is the
-- remaining step before the live "Forgot password" link can deliver.
CREATE TABLE IF NOT EXISTS password_resets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user_id ON password_resets(user_id);
CREATE INDEX IF NOT EXISTS idx_password_resets_token_hash ON password_resets(token_hash);
