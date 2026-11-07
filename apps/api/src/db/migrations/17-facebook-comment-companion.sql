-- 17-facebook-comment-companion.sql — backfill the comment leg of every
-- connected Facebook Page.
--
-- The Meta webhook delivers Page-post comments only when a
-- 'facebook_comment' channel row exists for the Page, but Facebook OAuth
-- used to create only the 'messenger' row — so comments from already
-- connected Pages (e.g. Halal Chic) were silently dropped by the webhook.
-- New connects create the companion row in code (meta-oauth.ts
-- createOAuthChannel); this migration covers Pages connected before that.
-- Idempotent: INSERT ... WHERE NOT EXISTS, so re-running it changes nothing.
-- The companion row shares the Page token and does NOT count toward the
-- subscription channel limit (countChannels excludes facebook_comment).
INSERT INTO channels
  (workspace_id, platform, external_id, display_name, token_encrypted, status, token_expires_at, picture_url, source_id)
SELECT
  c.workspace_id, 'facebook_comment', c.external_id, c.display_name, c.token_encrypted,
  'connected', c.token_expires_at, c.picture_url, c.source_id
FROM channels c
WHERE c.platform = 'messenger'
  AND c.status = 'connected'
  AND c.token_encrypted IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM channels c2
    WHERE c2.workspace_id = c.workspace_id
      AND c2.platform = 'facebook_comment'
      AND c2.external_id = c.external_id
  );
