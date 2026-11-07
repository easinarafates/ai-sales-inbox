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

export type OAuthChannel = 'facebook' | 'instagram' | 'whatsapp';

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
 */
export function loginUrl(scopes: string[], state: string, opts?: { reauthenticate?: boolean }): string {
  const url = new URL(DIALOG_BASE);
  url.searchParams.set('client_id', config.meta.appId);
  url.searchParams.set('redirect_uri', config.meta.oauthRedirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', scopes.join(','));
  url.searchParams.set('response_type', 'code');
  if (opts?.reauthenticate) url.searchParams.set('auth_type', 'reauthenticate');
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
export async function graphFetch(path: string, init: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetchWithTimeout(`${GRAPH_BASE}${path}`, init);
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
    const res = await fetchWithTimeout(`${GRAPH_BASE}/me?fields=name`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${longLivedToken}` },
    });
    const data = (await res.json().catch(() => null)) as { name?: string } | null;
    if (!res.ok || typeof data?.name !== 'string') return '';
    return data.name;
  } catch {
    return '';
  }
}

export async function fetchPages(longLivedToken: string): Promise<FbPickPage[]> {
  const url = new URL(`${GRAPH_BASE}/me/accounts`);
  url.searchParams.set('fields', 'id,name,category,picture{url},access_token');
  const res = await fetchWithTimeout(url.toString(), {
    method: 'GET',
    headers: { Authorization: `Bearer ${longLivedToken}` },
  });
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
 * messaging_postbacks, feed) — both layers have to include a field for
 * Meta to deliver that event.
 */
export const SUBSCRIBED_FIELDS = 'messages,messaging_postbacks,feed';

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
export async function subscribePageToApp(pageId: string, pageToken: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${GRAPH_BASE}/${encodeURIComponent(pageId)}/subscribed_apps`, {
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
 * Shared by all three OAuth connects: duplicate check (same platform +
 * external_id in this workspace), subscription channel limit, then the
 * INSERT with the token encrypted. The token is stored encrypted and is
 * never returned by any list endpoint. After a Messenger/Instagram
 * channel is created, the Page is subscribed to the app (best-effort —
 * a subscribe failure never fails the connect). A Messenger connect
 * also creates a companion 'facebook_comment' row for the same Page
 * (same token) so Page-post comments reach the webhook — it is the
 * same Page's comment leg, not a second channel, so it does not count
 * toward the subscription channel limit.
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
  },
): Promise<CreateResult> {
  const dupe = await query(
    workspaceId,
    'SELECT id FROM channels WHERE workspace_id = $1 AND platform = $2 AND external_id = $3',
    [workspaceId, input.platform, input.externalId],
  );
  if (dupe.rows.length > 0) {
    return { ok: false, reason: 'duplicate', message: input.duplicateMessage };
  }
  const limit = await checkChannelLimit(workspaceId);
  if (!limit.canAdd) {
    return { ok: false, reason: 'limit', message: limit.message };
  }
  const expiresAt = new Date(Date.now() + PAGE_TOKEN_TTL_MS).toISOString();
  const { rows } = await query<ChannelRow>(
    workspaceId,
    `INSERT INTO channels (workspace_id, platform, external_id, display_name, token_encrypted, status, token_expires_at, picture_url, source_id)
     VALUES ($1, $2, $3, $4, $5, 'connected', $6, $7, $8)
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
    ],
  );
  if (rows.length === 0) {
    return { ok: false, reason: 'duplicate', message: input.duplicateMessage };
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
          `INSERT INTO channels (workspace_id, platform, external_id, display_name, token_encrypted, status, token_expires_at, picture_url, source_id)
           VALUES ($1, 'facebook_comment', $2, $3, $4, 'connected', $5, $6, $7)`,
          [
            workspaceId,
            input.externalId,
            input.displayName,
            encryptToken(input.token),
            expiresAt,
            input.pictureUrl || null,
            input.sourceId || null,
          ],
        );
      }
    } catch (err) {
      console.error('[meta-oauth] companion facebook_comment channel failed:', (err as Error).message);
    }
  }
  return { ok: true, channel: rows[0] };
}
