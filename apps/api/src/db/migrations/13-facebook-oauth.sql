-- 13-facebook-oauth.sql — "Login with Facebook" (Channels page).
--
-- Page tokens derived from a long-lived user token last ~60 days, so the
-- channel row needs to remember (approximately) when its token runs out,
-- and the page picker needs the Page picture URL. Both are filled in by
-- the Facebook OAuth callback (apps/api/src/channels/facebook-oauth.ts);
-- older rows simply have NULLs.
-- Idempotent: safe to re-run on every start (same pattern as the other
-- migrations). Loads on local PGlite (auto-run on boot) and on Neon
-- Postgres with psql.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS picture_url TEXT;
