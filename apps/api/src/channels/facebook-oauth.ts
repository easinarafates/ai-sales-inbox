import { Router, type Request, type Response } from 'express';
import jwt from 'jsonwebtoken';
import { fetchWithTimeout } from '../ai-agent/http';
import { getWorkspaceId, requireAuth, signToken } from '../auth/auth';
import { config } from '../config';
import { encryptToken } from '../db/crypto';
import { query } from '../db/pool';
import { checkChannelLimit } from '../subscriptions/service';
import type { AuthRequest } from '../types';

/**
 * "Login with Facebook" — connects a Facebook Page to a workspace without
 * typing a Page ID + token by hand.
 *
 * Flow: Channels page → GET /login (returns the Meta dialog URL) →
 * user approves on facebook.com → Meta calls GET /callback?code&state →
 * code is exchanged for a long-lived user token → /me/accounts lists the
 * user's Pages → 1 page: the channel is created immediately; >1 pages:
 * the user picks one on the Channels page (POST /connect).
 *
 * The connected channel is ONE row: platform 'messenger',
 * external_id = Page ID, token_encrypted = Page access token — so
 * incoming Messenger messages keep resolving through the existing
 * findChannelByExternalId('messenger', pageId) webhook lookup.
 *
 * No Meta app yet (META_APP_ID / META_APP_SECRET unset) → /login answers
 * 503 with a plain message and the callback redirects with reason=config.
 * Nothing here crashes when the app is missing.
 *
 * Security notes:
 * - The OAuth `state` token is a short-lived (10 min) JWT signed with the
 *   same secret as auth tokens, but it carries purpose='facebook_oauth'
 *   and requireAuth rejects purpose tokens — a leaked `state` value can
 *   never be used to call the API.
 * - The page-pick `session` JWT (10 min) carries the Page tokens. It has
 *   no userId, so requireAuth rejects it too; /pages strips the tokens
 *   out before responding, and /connect re-checks the workspace.
 * - Page tokens are NEVER put in a URL or a log line: token exchange
 *   uses POST bodies and /me/accounts uses an Authorization header.
 */
export const facebookOAuthRouter = Router();

const GRAPH_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const DIALOG_BASE = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;
const SCOPES = ['pages_show_list', 'pages_messaging', 'pages_manage_metadata', 'pages_read_engagement'];
const STATE_TTL = '10m';
const SESSION_TTL = '10m';
/**
 * Page tokens derived from a long-lived user token last ~60 days. Meta
 * does not return the Page token's own expiry in /me/accounts, so we
 * store now + 59 days (approximate) and the UI can warn a day early.
 */
const PAGE_TOKEN_TTL_MS = 59 * 24 * 60 * 60 * 1000;

interface FbAccount {
  id: string;
  name?: string;
  category?: string;
  picture?: { data?: { url?: string } };
  access_token?: string;
}

/** One Page as stored inside the page-pick session JWT (token included). */
interface FbPickPage {
  id: string;
  name: string;
  category: string;
  picture: string;
  token: string;
}

interface FbSessionPayload {
  purpose: 'facebook_pages';
  workspaceId: string;
  pages: FbPickPage[];
}

interface ChannelRow {
  id: string;
  platform: string;
  external_id: string;
  display_name: string | null;
  status: string;
  token_expires_at: string | null;
  picture_url: string | null;
  created_at: string;
}

function webRedirect(res: Response, params: Record<string, string>): void {
  const url = new URL('/channels', config.webAppUrl);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  res.redirect(url.toString());
}

function verifyState(token: string): { userId: string; workspaceId: string } | null {
  try {
    const p = jwt.verify(token, config.jwtSecret) as { userId?: string; workspaceId?: string; purpose?: string };
    if (p.purpose !== 'facebook_oauth' || !p.userId || !p.workspaceId) return null;
    return { userId: p.userId, workspaceId: p.workspaceId };
  } catch {
    return null;
  }
}

function verifySession(token: string): FbSessionPayload | null {
  try {
    const p = jwt.verify(token, config.jwtSecret) as Partial<FbSessionPayload>;
    if (p.purpose !== 'facebook_pages' || typeof p.workspaceId !== 'string' || !Array.isArray(p.pages)) return null;
    if (!p.pages.every((pg) => typeof pg?.id === 'string' && typeof pg?.token === 'string')) return null;
    return p as FbSessionPayload;
  } catch {
    return null;
  }
}

/** Meta Graph call. Tokens are sent in a POST body / Bearer header, never in a URL. */
async function graphFetch(path: string, init: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetchWithTimeout(`${GRAPH_BASE}${path}`, init);
  const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (!res.ok) {
    throw new Error(`Meta Graph ${path} failed (${res.status})${data?.error?.message ? `: ${data.error.message}` : ''}`);
  }
  return (data ?? {}) as Record<string, unknown>;
}

function formBody(params: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  };
}

async function exchangeCodeForToken(code: string): Promise<string> {
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

async function exchangeForLongLived(shortToken: string): Promise<string> {
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

async function fetchPages(longLivedToken: string): Promise<FbPickPage[]> {
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

type CreateResult =
  | { ok: true; channel: ChannelRow }
  | { ok: false; reason: 'duplicate' | 'limit'; message: string };

/** Shared by the auto-connect (1 page) and the picker (POST /connect) paths. */
async function createMessengerChannel(
  workspaceId: string,
  page: { id: string; name: string; picture: string; token: string },
): Promise<CreateResult> {
  const dupe = await query(
    workspaceId,
    'SELECT id FROM channels WHERE workspace_id = $1 AND platform = $2 AND external_id = $3',
    [workspaceId, 'messenger', page.id],
  );
  if (dupe.rows.length > 0) {
    return { ok: false, reason: 'duplicate', message: 'This Facebook Page is already connected to this workspace.' };
  }
  const limit = await checkChannelLimit(workspaceId);
  if (!limit.canAdd) {
    return { ok: false, reason: 'limit', message: limit.message };
  }
  const expiresAt = new Date(Date.now() + PAGE_TOKEN_TTL_MS).toISOString();
  const { rows } = await query<ChannelRow>(
    workspaceId,
    `INSERT INTO channels (workspace_id, platform, external_id, display_name, token_encrypted, status, token_expires_at, picture_url)
     VALUES ($1, 'messenger', $2, $3, $4, 'connected', $5, $6)
     RETURNING id, platform, external_id, display_name, status, token_expires_at, picture_url, created_at`,
    [workspaceId, page.id, page.name, encryptToken(page.token), expiresAt, page.picture || null],
  );
  if (rows.length === 0) {
    return { ok: false, reason: 'duplicate', message: 'This Facebook Page is already connected to this workspace.' };
  }
  return { ok: true, channel: rows[0] };
}

/**
 * GET /api/channels/facebook/login — returns the Meta dialog URL.
 * 503 while no Meta app is configured (META_APP_ID unset).
 */
facebookOAuthRouter.get('/login', requireAuth, (req: AuthRequest, res: Response) => {
  if (!config.meta.appId) {
    res.status(503).json({
      error: 'Facebook login is not configured yet — the Meta app (META_APP_ID) has not been set up. The platform owner needs to connect a Meta app first.',
    });
    return;
  }
  const state = signToken(
    { userId: req.userId as string, workspaceId: getWorkspaceId(req), purpose: 'facebook_oauth' },
    STATE_TTL,
  );
  const url = new URL(DIALOG_BASE);
  url.searchParams.set('client_id', config.meta.appId);
  url.searchParams.set('redirect_uri', config.meta.oauthRedirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', SCOPES.join(','));
  url.searchParams.set('response_type', 'code');
  res.json({ url: url.toString() });
});

/**
 * GET /api/channels/facebook/callback — public (Meta calls it).
 * Always ends in a redirect back to the web app Channels page with
 * ?facebook=connected | pick | error.
 */
facebookOAuthRouter.get('/callback', async (req: Request, res: Response) => {
  const q = req.query as Record<string, string | undefined>;
  if (q.error) return webRedirect(res, { facebook: 'error', reason: 'cancelled' });
  const verified = q.state ? verifyState(q.state) : null;
  if (!verified || !q.code) return webRedirect(res, { facebook: 'error', reason: 'bad_state' });
  if (!config.meta.appId || !config.meta.appSecret) {
    return webRedirect(res, { facebook: 'error', reason: 'config' });
  }
  try {
    const shortToken = await exchangeCodeForToken(q.code);
    const longToken = await exchangeForLongLived(shortToken);
    const pages = await fetchPages(longToken);
    if (pages.length === 0) return webRedirect(res, { facebook: 'error', reason: 'no_pages' });
    if (pages.length === 1) {
      const result = await createMessengerChannel(verified.workspaceId, pages[0]);
      if (!result.ok) return webRedirect(res, { facebook: 'error', reason: result.reason });
      return webRedirect(res, { facebook: 'connected', name: pages[0].name });
    }
    const session = jwt.sign(
      { purpose: 'facebook_pages', workspaceId: verified.workspaceId, pages } as FbSessionPayload,
      config.jwtSecret,
      { expiresIn: SESSION_TTL },
    );
    return webRedirect(res, { facebook: 'pick', session });
  } catch (err) {
    console.error('[facebook-oauth] callback failed:', (err as Error).message);
    return webRedirect(res, { facebook: 'error', reason: 'exchange_failed' });
  }
});

/**
 * GET /api/channels/facebook/pages?session=... — the picker list.
 * Tokens are stripped: the response carries id/name/category/picture only.
 */
facebookOAuthRouter.get('/pages', requireAuth, (req: AuthRequest, res: Response) => {
  const session = verifySession(String(req.query.session ?? ''));
  if (!session || session.workspaceId !== getWorkspaceId(req)) {
    res.status(401).json({ error: 'Invalid or expired Facebook session — please log in with Facebook again.' });
    return;
  }
  res.json({
    pages: session.pages.map(({ id, name, category, picture }) => ({ id, name, category, picture })),
  });
});

/** POST /api/channels/facebook/connect — connect the picked Page. */
facebookOAuthRouter.post('/connect', requireAuth, async (req: AuthRequest, res: Response) => {
  const { session, pageId } = (req.body ?? {}) as { session?: string; pageId?: string };
  const verified = session ? verifySession(session) : null;
  if (!verified || verified.workspaceId !== getWorkspaceId(req)) {
    res.status(401).json({ error: 'Invalid or expired Facebook session — please log in with Facebook again.' });
    return;
  }
  const page = verified.pages.find((p) => p.id === pageId);
  if (!page) {
    res.status(400).json({ error: 'Unknown page — please log in with Facebook again.' });
    return;
  }
  const result = await createMessengerChannel(verified.workspaceId, page);
  if (!result.ok) {
    res.status(result.reason === 'limit' ? 402 : 409).json({ error: result.message });
    return;
  }
  res.status(201).json({ channel: result.channel });
});
