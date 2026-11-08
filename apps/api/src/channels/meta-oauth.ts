import type { Response } from 'express';
import jwt from 'jsonwebtoken';
import { fetchWithTimeout } from '../ai-agent/http';
import { signToken } from '../auth/auth';
import { config } from '../config';
import { encryptToken } from '../db/crypto';
import { query } from '../db/pool';
import { checkChannelLimit } from '../subscriptions/service';

/**
 * Shared plumbing for Meta OAuth channel connects (Facebook / Instagram /
 * WhatsApp). All three logins use the SAME Meta app and the SAME
 * registered redirect URI (the Facebook callback — Meta only calls back
 * to URIs registered in the app, so the three /login endpoints each
 * request their own scopes but all point at
 * /api/channels/facebook/callback). The callback reads the `channel`
 * carried in the state JWT and dispatches to the right completer.
 *
 * Security notes (same as the original Facebook flow):
 * - The OAuth `state` token is a short-lived (10 min) JWT signed with
 *   the same secret as auth tokens, but it carries
 *   purpose='facebook_oauth' and requireAuth rejects purpose tokens —
 *   a leaked `state` value can never be used to call the API.
 * - Page-pick / account-pick `session` JWTs (10 min) carry the tokens
 *   needed to finish the connect. They have no userId, so requireAuth
 *   rejects them too; the list endpoints strip the tokens out before
 *   responding, and /connect re-checks the workspace.
 * - Tokens are NEVER put in a URL or a log line: token exchange uses
 *   POST bodies and Graph reads use an Authorization header.
 */

export const GRAPH_VERSION = 'v21.0';
export const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
/**
 * Per-call timeout for OAuth Graph calls (code exchange, /me, page/WABA
 * lookups). A single hanging Graph call must fail fast with an honest
 * error instead of letting Vercel kill the whole OAuth callback with a
 * 504 (the default Hobby function limit is 10s and the old code gave
 * every call up to 20s — the WhatsApp callback timed out live twice on
 * 2026-11-09 because its sequential Graph calls ran past that ceiling).
 * 15s per call: the callback does at most 3 calls and the picker lookup
 * at most 2 rounds, so the worst case stays well under the 60s function
 * limit (vercel.json maxDuration) while a genuinely slow Meta endpoint
 * still gets a chance to answer instead of being cut off.
 */
export const OAUTH_GRAPH_TIMEOUT_MS = 15000;
/**
 * Graph base for Meta calls. META_GRAPH_BASE_URL overrides it for
 * offline testing only (same rule as meta-send.ts's sendGraphBase);
 * production always uses graph.facebook.com.
 */
export function graphBase(): string {
  const override = (process.env.META_GRAPH_BASE_URL ?? '').replace(/\/$/, '');
  return override || GRAPH_BASE;
}
export const DIALOG_BASE = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;
export const STATE_TTL = '10m';
export const SESSION_TTL = '10m';
/**
 * Page tokens derived from a long-lived user token last ~60 days. Meta
 * does not return the Page token's own expiry in /me/accounts, so we
 * store now + 59 days (approximate) and the UI can warn a day early.
 * The same approximation is used for WhatsApp user tokens, which also
 * live ~60 days after the fb_exchange_token grant.
 */
export const PAGE_TOKEN_TTL_MS = 59 * 24 * 60 * 60 * 1000;

export type OAuthChannel = 'facebook' | 'instagram' | 'whatsapp' | 'tiktok' | 'youtube';

/** One Page as returned by /me/accounts (token included server-side). */
export interface FbPickPage {
  id: string;
  name: string;
  category: string;
  picture: string;
  token: string;
}

interface FbAccount {
  id: string;
  name?: string;
  category?: string;
  picture?: { data?: { url?: string } };
  access_token?: string;
}

export interface ChannelRow {
  id: string;
  platform: string;
  external_id: string;
  display_name: string | null;
  status: string;
  token_expires_at: string | null;
  picture_url: string | null;
  /** Parent object the channel came from (Page ID / WABA ID) — migration 14. */
  source_id: string | null;
  created_at: string;
}

export interface VerifiedState {
  userId: string;
  workspaceId: string;
  channel: OAuthChannel;
}

/** Redirect back to the web app Channels page: ?<channel>=connected|pick|error&... */
export function webRedirect(res: Response, channel: OAuthChannel, params: Record<string, string>): void {
  const url = new URL('/channels', config.webAppUrl);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  res.redirect(url.toString());
}

/**
 * The Meta dialog URL for one channel's login (its own scopes).
 *
 * By default Facebook silently re-uses the account currently signed in
 * on facebook.com — the dialog never appears, no Page picker is shown,
 * and the user cannot choose a different Facebook account. That is the
 * exact complaint ("login returns immediately, no page picker").
 * `reauthenticate: true` adds `auth_type=reauthenticate`, which forces
 * Facebook to ask for credentials again — on that screen the user can
 * log in with a DIFFERENT account (or the same one). No code on our
 * side can pick the Facebook account for the user; this is the only
 * server-side lever Facebook Login offers, and the user must still type
 * the other account's credentials on facebook.com.
 * The Channels page passes reauthenticate only from its explicit
 * "Use a different Facebook account" action, so a normal connect stays
 * one click and does not ask for a password every time.
 *
 * `configId` is the WhatsApp Embedded Signup config id: without it the
 * dialog is a plain Facebook Login and Meta never creates/lists a
 * WhatsApp Business account (see config.whatsapp.configId).
 */
export function loginUrl(scopes: string[], state: string, opts?: { reauthenticate?: boolean; configId?: string }): string {
  const url = new URL(DIALOG_BASE);
  url.searchParams.set('client_id', config.meta.appId);
  url.searchParams.set('redirect_uri', config.meta.oauthRedirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', scopes.join(','));
  url.searchParams.set('response_type', 'code');
  if (opts?.reauthenticate) url.searchParams.set('auth_type', 'reauthenticate');
  if (opts?.configId) url.searchParams.set('config_id', opts.configId);
  return url.toString();
}

export function signStateToken(userId: string, workspaceId: string, channel: OAuthChannel): string {
  return signToken({ userId, workspaceId, purpose: 'facebook_oauth', channel }, STATE_TTL);
}

export function verifyState(token: string): VerifiedState | null {
  try {
    const p = jwt.verify(token, config.jwtSecret) as {
      userId?: string;
      workspaceId?: string;
      purpose?: string;
      channel?: string;
    };
    if (p.purpose !== 'facebook_oauth' || !p.userId || !p.workspaceId) return null;
    const channel: OAuthChannel =
      p.channel === 'instagram' || p.channel === 'whatsapp' ? p.channel : 'facebook';
    return { userId: p.userId, workspaceId: p.workspaceId, channel };
  } catch {
    return null;
  }
}

/** Sign a short-lived picker-session JWT (pages / WABA accounts + tokens). */
export function signSession(purpose: string, data: Record<string, unknown>): string {
  return jwt.sign({ purpose, ...data }, config.jwtSecret, { expiresIn: SESSION_TTL });
}

/** Verify a picker-session JWT's purpose; callers validate the shape. */
export function verifySession(token: string, purpose: string): Record<string, unknown> | null {
  try {
    const p = jwt.verify(token, config.jwtSecret) as Record<string, unknown>;
    if (p.purpose !== purpose || typeof p.workspaceId !== 'string') return null;
    return p;
  } catch {
    return null;
  }
}

/** Meta Graph call. Tokens are sent in a POST body / Bearer header, never in a URL. */
export async function graphFetch(path: string, init: RequestInit, timeoutMs: number = OAUTH_GRAPH_TIMEOUT_MS): Promise<Record<string, unknown>> {
  const res = await fetchWithTimeout(`${graphBase()}${path}`, init, timeoutMs);
  const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (!res.ok) {
    throw new Error(`Meta Graph ${path} failed (${res.status})${data?.error?.message ? `: ${data.error.message}` : ''}`);
  }
  return (data ?? {}) as Record<string, unknown>;
}

export function formBody(params: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  };
}

export async function exchangeCodeForToken(code: string): Promise<string> {
  const data = await graphFetch('/oauth/access_token', formBody({
    client_id: config.meta.appId,
    redirect_uri: config.meta.oauthRedirectUri,
    client_secret: config.meta.appSecret,
    code,
  }));
  if (typeof data.access_token !== 'string' || !data.access_token) {
    throw new Error('Meta did not return an access token');
  }
  return data.access_token;
}

export async function exchangeForLongLived(shortToken: string): Promise<string> {
  const data = await graphFetch('/oauth/access_token', formBody({
    grant_type: 'fb_exchange_token',
    client_id: config.meta.appId,
    client_secret: config.meta.appSecret,
    fb_exchange_token: shortToken,
  }));
  if (typeof data.access_token !== 'string' || !data.access_token) {
    throw new Error('Meta did not return a long-lived token');
  }
  return data.access_token;
}

/**
 * The Facebook user's display name (/me?fields=name). Used in error
 * redirects so the Channels page can say WHICH account was used — e.g.
 * when it has no Page. Never throws: on any failure it returns '' and
 * the flow continues without the name.
 */
export async function fetchMeName(longLivedToken: string): Promise<string> {
  try {
    const res = await fetchWithTimeout(`${graphBase()}/me?fields=name`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${longLivedToken}` },
    }, OAUTH_GRAPH_TIMEOUT_MS);
    const data = (await res.json().catch(() => null)) as { name?: string } | null;
    if (!res.ok || typeof data?.name !== 'string') return '';
    return data.name;
  } catch {
    return '';
  }
}

/**
 * The connecting Facebook user's app-scoped ID (/me?fields=id). Stored
 * on the channel row as connected_by_user_id (migration 20) for future
 * matching. Never throws: on any failure it returns '' and the flow
 * continues without the ID (the user token is still stored).
 */
export async function fetchMeId(longLivedToken: string): Promise<string> {
  try {
    const res = await fetchWithTimeout(`${graphBase()}/me?fields=id`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${longLivedToken}` },
    }, OAUTH_GRAPH_TIMEOUT_MS);
    const data = (await res.json().catch(() => null)) as { id?: string } | null;
    if (!res.ok || typeof data?.id !== 'string') return '';
    return data.id;
  } catch {
    return '';
  }
}

export async function fetchPages(longLivedToken: string): Promise<FbPickPage[]> {
  const url = new URL(`${graphBase()}/me/accounts`);
  url.searchParams.set('fields', 'id,name,category,picture{url},access_token');
  const res = await fetchWithTimeout(url.toString(), {
    method: 'GET',
    headers: { Authorization: `Bearer ${longLivedToken}` },
  }, OAUTH_GRAPH_TIMEOUT_MS);
  const data = (await res.json().catch(() => null)) as { data?: FbAccount[]; error?: { message?: string } } | null;
  if (!res.ok) {
    throw new Error(`Meta Graph /me/accounts failed (${res.status})${data?.error?.message ? `: ${data.error.message}` : ''}`);
  }
  return (data?.data ?? [])
    .filter((p) => typeof p?.id === 'string' && typeof p?.access_token === 'string')
    .map((p) => ({
      id: p.id,
      name: p.name ?? p.id,
      category: p.category ?? '',
      picture: p.picture?.data?.url ?? '',
      token: p.access_token as string,
    }));
}

export type CreateResult =
  | { ok: true; channel: ChannelRow }
  | { ok: false; reason: 'duplicate' | 'limit'; message: string };

/**
 * Fields the app receives for a subscribed Page. Must match the fields
 * configured on the Meta app's Webhooks product (messages,
 * messaging_postbacks, feed, message_echoes) — both layers have to
 * include a field for Meta to deliver that event.
 *
 * message_echoes matters for the AI ON/OFF dot commands: when the owner
 * replies AS the Page from Page Inbox, Meta delivers the message only
 * as an echo, so without this field a '.' typed as the Page never
 * reaches the webhook. Existing Pages subscribed before this field was
 * added must be re-subscribed (POST /api/channels/:id/resubscribe), and
 * the Webhooks product in the Meta app dashboard must also tick
 * message_echoes — the API subscribe alone is not enough.
 */
export const SUBSCRIBED_FIELDS = 'messages,messaging_postbacks,feed,message_echoes';

/**
 * Subscribe a Facebook Page to the app so Meta delivers the Page's
 * Messenger / Instagram events to our webhook (POST /api/webhooks/meta).
 * Without this call a Page can be connected and still never send us a
 * message — Meta only pushes events for Pages subscribed to the app.
 *
 * Best-effort by design: a failure is logged and the caller still
 * succeeds. The Page can be (re)subscribed later, and a slow or failing
 * Graph call must never block a user from connecting.
 * (WhatsApp is NOT subscribed here — its Cloud API webhook is separate
 * and a WhatsApp channel token is a user token, not a Page token.)
 */
/**
 * Graph base for subscription calls. META_GRAPH_BASE_URL overrides it
 * for offline testing only (same rule as meta-send.ts's sendGraphBase);
 * production always uses graph.facebook.com.
 */
function subscribeGraphBase(): string {
  const override = (process.env.META_GRAPH_BASE_URL ?? '').replace(/\/$/, '');
  return override || GRAPH_BASE;
}

export async function subscribePageToApp(pageId: string, pageToken: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${subscribeGraphBase()}/${encodeURIComponent(pageId)}/subscribed_apps`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pageToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ subscribed_fields: SUBSCRIBED_FIELDS }).toString(),
    }, 10000);
    const data = (await res.json().catch(() => null)) as {
      success?: boolean;
      error?: { message?: string };
    } | null;
    if (res.ok && data?.success === true) return true;
    console.error(
      '[meta-oauth] subscribe page to app failed for page',
      pageId,
      data?.error?.message ? `: ${data.error.message}` : ` (HTTP ${res.status})`,
    );
    return false;
  } catch (err) {
    console.error('[meta-oauth] subscribe page to app failed for page', pageId, ':', (err as Error).message);
    return false;
  }
}

/**
 * Shared by all three OAuth connects. A connect of a Page/account that
 * is ALREADY connected in this workspace is a RECONNECT: the existing
 * row is UPDATED (fresh Page token, fresh user token when provided,
 * fresh expiry, status back to 'connected') instead of erroring — a
 * reconnect adds no new channel, so the subscription channel-limit
 * check is skipped on that path and must never 402 it. Only a genuinely
 * new (workspace, platform, external_id) goes through the limit check
 * and the INSERT. The token is stored encrypted and is never returned
 * by any list endpoint. After a Messenger/Instagram channel is created
 * (or refreshed), the Page is subscribed to the app (best-effort —
 * a subscribe failure never fails the connect). A Messenger connect
 * also creates a companion 'facebook_comment' row for the same Page
 * (same token) so Page-post comments reach the webhook — it is the
 * same Page's comment leg, not a second channel, so it does not count
 * toward the subscription channel limit; on a reconnect the companion
 * row's tokens are refreshed the same way.
 */
export async function createOAuthChannel(
  workspaceId: string,
  input: {
    platform: string;
    externalId: string;
    displayName: string;
    token: string;
    pictureUrl?: string | null;
    sourceId?: string | null;
    duplicateMessage: string;
    /**
     * The connecting Facebook user's long-lived access token + app-scoped
     * user ID (migration 20). Stored encrypted on the channel row so the
     * profile fetch can retry with the USER token when the Page token
     * cannot load a sender (phone-registered accounts: Graph 400 #100/33
     * on every PSID route). Absent for flows that have no user token
     * (e.g. WhatsApp stores its user token as the channel token itself).
     */
    userToken?: string | null;
    connectedByUserId?: string | null;
    /**
     * Refresh token (migration 33, encrypted) — TikTok (~24h access
     * tokens) and YouTube (~1h) only. A reconnect without one keeps the
     * stored value (COALESCE), so a re-login that returns no refresh
     * token never wipes the good one.
     */
    refreshToken?: string | null;
    /**
     * Granted OAuth scopes (migration 34) — space/comma-joined, as
     * granted at connect time. Lets the API tell honestly whether a
     * channel can upload/post (YouTube youtube.upload, TikTok
     * video.publish) or only read — a reconnect replaces the value.
     */
    scopes?: string | null;
    /** Absolute token expiry (ISO). Defaults to now + 59 days (Meta). */
    expiresAt?: string | null;
  },
): Promise<CreateResult> {
  const expiresAt = input.expiresAt ?? new Date(Date.now() + PAGE_TOKEN_TTL_MS).toISOString();
  const refreshTokenEncrypted = input.refreshToken ? encryptToken(input.refreshToken) : null;
  const userTokenEncrypted = input.userToken ? encryptToken(input.userToken) : null;
  const connectedByUserId = input.connectedByUserId || null;
  const dupe = await query(
    workspaceId,
    'SELECT id FROM channels WHERE workspace_id = $1 AND platform = $2 AND external_id = $3',
    [workspaceId, input.platform, input.externalId],
  );
  let rows: ChannelRow[];
  if (dupe.rows.length > 0) {
    // Reconnect: refresh the tokens on the existing row instead of
    // erroring. A missing user token / connected-by ID on the new input
    // keeps the stored value (COALESCE) — flows without a user token
    // (e.g. WhatsApp, whose channel token IS the user token) must not
    // wipe the stored one.
    const updated = await query<ChannelRow>(
      workspaceId,
      `UPDATE channels
       SET token_encrypted = $1, user_token_encrypted = COALESCE($2, user_token_encrypted),
           connected_by_user_id = COALESCE($3, connected_by_user_id),
           display_name = $4, picture_url = COALESCE($5, picture_url),
           source_id = COALESCE($6, source_id), token_expires_at = $7, status = 'connected',
           refresh_token_encrypted = COALESCE($11, refresh_token_encrypted),
           scopes = COALESCE($12, scopes)
       WHERE workspace_id = $8 AND platform = $9 AND external_id = $10
       RETURNING id, platform, external_id, display_name, status, token_expires_at, picture_url, source_id, created_at`,
      [
        encryptToken(input.token),
        userTokenEncrypted,
        connectedByUserId,
        input.displayName,
        input.pictureUrl || null,
        input.sourceId || null,
        expiresAt,
        workspaceId,
        input.platform,
        input.externalId,
        refreshTokenEncrypted,
        input.scopes ?? null,
      ],
    );
    rows = updated.rows;
    if (rows.length === 0) {
      return { ok: false, reason: 'duplicate', message: input.duplicateMessage };
    }
  } else {
    const limit = await checkChannelLimit(workspaceId);
    if (!limit.canAdd) {
      return { ok: false, reason: 'limit', message: limit.message };
    }
    const inserted = await query<ChannelRow>(
      workspaceId,
      `INSERT INTO channels (workspace_id, platform, external_id, display_name, token_encrypted, status, token_expires_at, picture_url, source_id, user_token_encrypted, connected_by_user_id, refresh_token_encrypted, scopes)
     VALUES ($1, $2, $3, $4, $5, 'connected', $6, $7, $8, $9, $10, $11, $12)
     RETURNING id, platform, external_id, display_name, status, token_expires_at, picture_url, source_id, created_at`,
      [
        workspaceId,
        input.platform,
        input.externalId,
        input.displayName,
        encryptToken(input.token),
        expiresAt,
        input.pictureUrl || null,
        input.sourceId || null,
        userTokenEncrypted,
        connectedByUserId,
        refreshTokenEncrypted,
        input.scopes ?? null,
      ],
    );
    rows = inserted.rows;
    if (rows.length === 0) {
      return { ok: false, reason: 'duplicate', message: input.duplicateMessage };
    }
  }
  // Subscribe the Page to the app so Meta delivers its events to our
  // webhook. Messenger: the Page is externalId. Instagram: the Page is
  // sourceId (externalId is the IG user ID). WhatsApp: no Page — skip.
  // Best-effort: subscribePageToApp never throws; a failure only logs.
  if (input.platform === 'messenger' || input.platform === 'instagram') {
    const pageId = input.platform === 'messenger' ? input.externalId : (input.sourceId ?? '');
    if (pageId) {
      await subscribePageToApp(pageId, input.token);
    }
  }
  // Companion comment channel: the Meta webhook delivers Page-post
  // comments only when a 'facebook_comment' channel row exists for the
  // Page (webhooks/routes.ts looks it up by Page ID). A Messenger
  // connect is one Facebook Page, so its comment leg is a second row
  // with the same Page token — NOT a second billable channel
  // (countChannels excludes facebook_comment). Best-effort and
  // idempotent: a failure here never fails the connect, and a
  // reconnect never duplicates the row. Older Pages connected before
  // this existed are backfilled by migration 17.
  if (input.platform === 'messenger') {
    try {
      const existing = await query(
        workspaceId,
        "SELECT id FROM channels WHERE workspace_id = $1 AND platform = 'facebook_comment' AND external_id = $2",
        [workspaceId, input.externalId],
      );
      if (existing.rows.length === 0) {
        await query(
          workspaceId,
          `INSERT INTO channels (workspace_id, platform, external_id, display_name, token_encrypted, status, token_expires_at, picture_url, source_id, user_token_encrypted, connected_by_user_id)
           VALUES ($1, 'facebook_comment', $2, $3, $4, 'connected', $5, $6, $7, $8, $9)`,
          [
            workspaceId,
            input.externalId,
            input.displayName,
            encryptToken(input.token),
            expiresAt,
            input.pictureUrl || null,
            input.sourceId || null,
            userTokenEncrypted,
            connectedByUserId,
          ],
        );
      } else {
        // Reconnect: refresh the companion row's tokens the same way.
        await query(
          workspaceId,
          `UPDATE channels
           SET token_encrypted = $1, user_token_encrypted = COALESCE($2, user_token_encrypted),
               connected_by_user_id = COALESCE($3, connected_by_user_id),
               display_name = $4, picture_url = COALESCE($5, picture_url),
               source_id = COALESCE($6, source_id), token_expires_at = $7, status = 'connected'
           WHERE workspace_id = $8 AND platform = 'facebook_comment' AND external_id = $9`,
          [
            encryptToken(input.token),
            userTokenEncrypted,
            connectedByUserId,
            input.displayName,
            input.pictureUrl || null,
            input.sourceId || null,
            expiresAt,
            workspaceId,
            input.externalId,
          ],
        );
      }
    } catch (err) {
      console.error('[meta-oauth] companion facebook_comment channel failed:', (err as Error).message);
    }
  }
  return { ok: true, channel: rows[0] };
}
