/**
 * Direct driver for the OAuth reconnect fix: calls createOAuthChannel
 * in-process against a fresh PGlite DB and prints a JSON summary.
 *
 * Run via scripts/verify-oauth-reconnect.mjs (which sets the env and
 * starts a stub Graph server for the subscribe calls). Never prints
 * tokens: the summary reports only whether the decrypted token equals
 * the expected value, never the token itself.
 */
import { query } from '../apps/api/src/db/pool';
import { createOAuthChannel } from '../apps/api/src/channels/meta-oauth';
import { decryptToken } from '../apps/api/src/db/crypto';

const WS_NAME = 'Reconnect Test Shop';
const PAGE_ID = 'page-reconnect-1';
const PAGE_ID_2 = 'page-reconnect-2';

async function countRows(workspaceId: string, platform: string, externalId: string): Promise<number> {
  const { rows } = await query<{ n: string }>(
    workspaceId,
    'SELECT count(*) AS n FROM channels WHERE workspace_id = $1 AND platform = $2 AND external_id = $3',
    [workspaceId, platform, externalId],
  );
  return Number(rows[0]?.n ?? 0);
}

async function rowTokens(workspaceId: string, platform: string, externalId: string) {
  const { rows } = await query<{
    id: string;
    token_encrypted: string | null;
    user_token_encrypted: string | null;
    connected_by_user_id: string | null;
    status: string;
    token_expires_at: string | null;
    display_name: string | null;
  }>(
    workspaceId,
    `SELECT id, token_encrypted, user_token_encrypted, connected_by_user_id, status, token_expires_at, display_name
     FROM channels WHERE workspace_id = $1 AND platform = $2 AND external_id = $3`,
    [workspaceId, platform, externalId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    token: r.token_encrypted ? decryptToken(r.token_encrypted) : null,
    userToken: r.user_token_encrypted ? decryptToken(r.user_token_encrypted) : null,
    connectedBy: r.connected_by_user_id,
    status: r.status,
    expiresAt: r.token_expires_at,
    displayName: r.display_name,
  };
}

async function main() {
  const out: Record<string, unknown> = {};
  const fail = (msg: string): never => {
    console.log(JSON.stringify({ ...out, ok: false, error: msg }));
    process.exit(1);
  };

  // Fresh workspace (trial plan: 1 channel — the limit matters below).
  const { rows: wsRows } = await query<{ id: string }>(
    'bootstrap',
    `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
    [WS_NAME],
  );
  // NOTE: query() requires a workspaceId string but does not validate it
  // against the workspaces table; 'bootstrap' is only the scoping arg
  // for this pre-workspace insert (same as signup/login lookups).
  const workspaceId = wsRows[0].id as string;
  out.workspaceId = workspaceId;

  // 1. First connect (messenger) with page token v1 + user token v1.
  const first = await createOAuthChannel(workspaceId, {
    platform: 'messenger',
    externalId: PAGE_ID,
    displayName: 'Halal Chic',
    token: 'tok-page-v1',
    pictureUrl: 'https://example.com/pic1.jpg',
    duplicateMessage: 'This Facebook Page is already connected to this workspace.',
    userToken: 'tok-user-v1',
    connectedByUserId: 'fb-user-1',
  });
  out.firstOk = first.ok;
  if (!first.ok) fail(`first connect failed: ${JSON.stringify(first)}`);
  const firstRow = await rowTokens(workspaceId, 'messenger', PAGE_ID);
  out.firstTokenIsV1 = firstRow?.token === 'tok-page-v1';
  out.firstUserTokenIsV1 = firstRow?.userToken === 'tok-user-v1';
  out.firstStatusConnected = firstRow?.status === 'connected';
  out.firstMessengerRows = await countRows(workspaceId, 'messenger', PAGE_ID);
  out.firstCommentRows = await countRows(workspaceId, 'facebook_comment', PAGE_ID);
  const firstCompanion = await rowTokens(workspaceId, 'facebook_comment', PAGE_ID);
  out.firstCompanionTokenIsV1 = firstCompanion?.token === 'tok-page-v1';
  out.firstCompanionUserTokenIsV1 = firstCompanion?.userToken === 'tok-user-v1';
  const firstId = firstRow?.id;
  const firstExpires = firstRow?.expiresAt;

  // 2. Reconnect the SAME page with new tokens (the reported bug: this
  // used to return {ok:false, reason:'duplicate'} and throw the fresh
  // user token away). Trial plan already has 1/1 channels, so this also
  // proves the limit check is skipped on the update path.
  const second = await createOAuthChannel(workspaceId, {
    platform: 'messenger',
    externalId: PAGE_ID,
    displayName: 'Halal Chic',
    token: 'tok-page-v2',
    pictureUrl: 'https://example.com/pic2.jpg',
    duplicateMessage: 'This Facebook Page is already connected to this workspace.',
    userToken: 'tok-user-v2',
    connectedByUserId: 'fb-user-2',
  });
  out.secondOk = second.ok;
  out.secondReason = second.ok ? null : (second as { reason: string }).reason;
  if (!second.ok) fail(`reconnect failed: ${JSON.stringify(second)}`);
  const secondRow = await rowTokens(workspaceId, 'messenger', PAGE_ID);
  out.secondSameRowId = secondRow?.id === firstId;
  out.secondTokenIsV2 = secondRow?.token === 'tok-page-v2';
  out.secondUserTokenIsV2 = secondRow?.userToken === 'tok-user-v2';
  out.secondConnectedByIsV2 = secondRow?.connectedBy === 'fb-user-2';
  out.secondStatusConnected = secondRow?.status === 'connected';
  out.secondMessengerRows = await countRows(workspaceId, 'messenger', PAGE_ID);
  out.secondCommentRows = await countRows(workspaceId, 'facebook_comment', PAGE_ID);
  const secondCompanion = await rowTokens(workspaceId, 'facebook_comment', PAGE_ID);
  out.secondCompanionTokenIsV2 = secondCompanion?.token === 'tok-page-v2';
  out.secondCompanionUserTokenIsV2 = secondCompanion?.userToken === 'tok-user-v2';
  out.expiresRefreshed = !!secondRow?.expiresAt && !!firstExpires && secondRow.expiresAt >= firstExpires;

  // 3. Reconnect AGAIN with a new page token but NO user token: the page
  // token must refresh while the stored user token is kept (COALESCE).
  const third = await createOAuthChannel(workspaceId, {
    platform: 'messenger',
    externalId: PAGE_ID,
    displayName: 'Halal Chic',
    token: 'tok-page-v3',
    duplicateMessage: 'This Facebook Page is already connected to this workspace.',
  });
  out.thirdOk = third.ok;
  if (!third.ok) fail(`third connect failed: ${JSON.stringify(third)}`);
  const thirdRow = await rowTokens(workspaceId, 'messenger', PAGE_ID);
  out.thirdTokenIsV3 = thirdRow?.token === 'tok-page-v3';
  out.thirdUserTokenKeptV2 = thirdRow?.userToken === 'tok-user-v2';
  out.thirdConnectedByKept = thirdRow?.connectedBy === 'fb-user-2';
  out.thirdMessengerRows = await countRows(workspaceId, 'messenger', PAGE_ID);

  // 4. A genuinely NEW page on the same trial workspace must still hit
  // the channel limit (1 channel) — the limit check still works.
  const fourth = await createOAuthChannel(workspaceId, {
    platform: 'messenger',
    externalId: PAGE_ID_2,
    displayName: 'Other Page',
    token: 'tok-page-other',
    duplicateMessage: 'This Facebook Page is already connected to this workspace.',
  });
  out.fourthOk = fourth.ok;
  out.fourthReason = fourth.ok ? null : (fourth as { reason: string }).reason;
  out.fourthLimitStillEnforced = !fourth.ok && (fourth as { reason: string }).reason === 'limit';

  console.log(JSON.stringify({ ...out, ok: true }));
  process.exit(0);
}

main().catch((err) => {
  console.log(JSON.stringify({ ok: false, error: (err as Error).message }));
  process.exit(1);
});
