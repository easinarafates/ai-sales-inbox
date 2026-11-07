import { Router, type Request, type Response } from 'express';
import { getWorkspaceId, requireAuth } from '../auth/auth';
import { config } from '../config';
import type { AuthRequest } from '../types';
import {
  createOAuthChannel,
  exchangeCodeForToken,
  exchangeForLongLived,
  fetchMeId,
  fetchMeName,
  fetchPages,
  loginUrl,
  signSession,
  signStateToken,
  verifySession,
  verifyState,
  webRedirect,
  type FbPickPage,
  type VerifiedState,
} from './meta-oauth';
import { completeInstagramOAuth } from './instagram-oauth';
import { completeWhatsappOAuth } from './whatsapp-oauth';

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
 * findChannelByExternalId('messenger', pageId) webhook lookup. A
 * companion 'facebook_comment' row for the same Page (same token) is
 * created alongside it by createOAuthChannel, so Page-post comments
 * reach the webhook too — it is the same Page's comment leg, not a
 * second channel, and does not count toward the channel limit.
 *
 * This callback is the SHARED Meta OAuth callback: all three logins
 * (Facebook, Instagram, WhatsApp) use the same registered redirect URI,
 * and the `channel` carried in the state JWT decides which completer
 * runs (see ./meta-oauth.ts).
 *
 * No Meta app yet (META_APP_ID / META_APP_SECRET unset) → /login answers
 * 503 with a plain message and the callback redirects with reason=config.
 * Nothing here crashes when the app is missing.
 *
 * The error redirects carry the Facebook account's name
 * (?facebook=error&reason=no_pages&account=<name>) so the Channels page
 * can tell the user WHICH account was used — the usual cause of
 * no_pages is logging in with an account that owns no Page.
 */
export const facebookOAuthRouter = Router();

// pages_manage_engagement: replying to Page-post comments as the Page
// (POST /{comment-id}/comments) and liking Page posts/comments as the
// Page (POST /{object-id}/likes). Needs App Review for public shops —
// the app admin can grant it in dev/Live mode for his own Pages.
// NOTE (2026-11-07): pages_manage_engagement was requested here overnight
// for comment replies, but the Facebook Login dialog then fails with
// "Feature Unavailable". It was reverted to the 4 scopes that worked when
// Halal Chic connected (2026-11-07 01:38). It is re-added now because
// liking (and comment replies) as the Page are impossible without it —
// and so is pages_manage_posts below. If the Login dialog shows
// "Feature Unavailable" again, grant the permission instead in Facebook
// Settings → Business integrations → "AI Sales Inbox" (the same place the
// 4 permissions were ticked on 2026-11-07), or revert this scope and
// redeploy. Tokens granted before a scope was added do NOT carry it:
// the Page must be reconnected once (Login with Facebook) after deploy.
// pages_manage_posts: publishing Page posts as the Page (POST
// /{page-id}/feed, /photos, /videos) — the Schedule page's real publish.
const SCOPES = ['pages_show_list', 'pages_messaging', 'pages_manage_metadata', 'pages_read_engagement', 'pages_manage_posts', 'pages_manage_engagement'];

/** Complete the Facebook flow after the code exchange. */
export async function completeFacebookOAuth(
  verified: VerifiedState,
  code: string,
  res: Response,
): Promise<void> {
  const shortToken = await exchangeCodeForToken(code);
  const longToken = await exchangeForLongLived(shortToken);
  const account = await fetchMeName(longToken);
  // The connecting user's long-lived token + app-scoped ID are stored
  // on the channel row (migration 20) so the profile fetch can retry
  // with the USER token when the Page token cannot load a sender.
  // The token is never logged and never leaves the server except to
  // Meta; the pick-session JWT carries it for 10 minutes, like the
  // Page tokens it already carries.
  const connectedByUserId = await fetchMeId(longToken);
  const pages = await fetchPages(longToken);
  if (pages.length === 0) {
    return webRedirect(res, 'facebook', {
      facebook: 'error',
      reason: 'no_pages',
      ...(account ? { account } : {}),
    });
  }
  if (pages.length === 1) {
    const result = await createOAuthChannel(verified.workspaceId, {
      platform: 'messenger',
      externalId: pages[0].id,
      displayName: pages[0].name,
      token: pages[0].token,
      pictureUrl: pages[0].picture,
      userToken: longToken,
      connectedByUserId: connectedByUserId || null,
      duplicateMessage: 'This Facebook Page is already connected to this workspace.',
    });
    if (!result.ok) {
      return webRedirect(res, 'facebook', {
        facebook: 'error',
        reason: result.reason,
        ...(account ? { account } : {}),
      });
    }
    return webRedirect(res, 'facebook', { facebook: 'connected', name: pages[0].name });
  }
  const session = signSession('facebook_pages', {
    workspaceId: verified.workspaceId,
    pages,
    userToken: longToken,
    connectedByUserId: connectedByUserId || null,
  });
  return webRedirect(res, 'facebook', {
    facebook: 'pick',
    session,
    ...(account ? { account } : {}),
  });
}

function verifyFbSession(token: string): {
  workspaceId: string;
  pages: FbPickPage[];
  userToken: string | null;
  connectedByUserId: string | null;
} | null {
  const p = verifySession(token, 'facebook_pages');
  if (!p || typeof p.workspaceId !== 'string' || !Array.isArray(p.pages)) return null;
  if (!p.pages.every((pg) => typeof (pg as FbPickPage)?.id === 'string' && typeof (pg as FbPickPage)?.token === 'string')) {
    return null;
  }
  return {
    workspaceId: p.workspaceId as string,
    pages: p.pages as unknown as FbPickPage[],
    userToken: typeof p.userToken === 'string' ? (p.userToken as string) : null,
    connectedByUserId: typeof p.connectedByUserId === 'string' ? (p.connectedByUserId as string) : null,
  };
}

/**
 * GET /api/channels/facebook/login — returns the Meta dialog URL.
 * 503 while no Meta app is configured (META_APP_ID unset).
 * ?reauthenticate=1 forces Facebook to ask for credentials again so the
 * user can log in with a DIFFERENT Facebook account (see loginUrl).
 */
facebookOAuthRouter.get('/login', requireAuth, (req: AuthRequest, res: Response) => {
  if (!config.meta.appId) {
    res.status(503).json({
      error: 'Facebook login is not configured yet — the Meta app (META_APP_ID) has not been set up. The platform owner needs to connect a Meta app first.',
    });
    return;
  }
  const state = signStateToken(req.userId as string, getWorkspaceId(req), 'facebook');
  res.json({ url: loginUrl(SCOPES, state, { reauthenticate: req.query.reauthenticate === '1' }) });
});

/**
 * GET /api/channels/facebook/callback — public (Meta calls it).
 * Shared callback for Facebook / Instagram / WhatsApp (see ./meta-oauth.ts).
 * Always ends in a redirect back to the web app Channels page with
 * ?<channel>=connected | pick | error.
 */
facebookOAuthRouter.get('/callback', async (req: Request, res: Response) => {
  const q = req.query as Record<string, string | undefined>;
  if (q.error) return webRedirect(res, 'facebook', { facebook: 'error', reason: 'cancelled' });
  const verified = q.state ? verifyState(q.state) : null;
  if (!verified || !q.code) return webRedirect(res, 'facebook', { facebook: 'error', reason: 'bad_state' });
  if (!config.meta.appId || !config.meta.appSecret) {
    return webRedirect(res, 'facebook', { facebook: 'error', reason: 'config' });
  }
  try {
    if (verified.channel === 'instagram') return completeInstagramOAuth(verified, q.code, res);
    if (verified.channel === 'whatsapp') return completeWhatsappOAuth(verified, q.code, res);
    return completeFacebookOAuth(verified, q.code, res);
  } catch (err) {
    console.error('[meta-oauth] callback failed:', (err as Error).message);
    return webRedirect(res, verified.channel, { [verified.channel]: 'error', reason: 'exchange_failed' });
  }
});

/**
 * GET /api/channels/facebook/pages?session=... — the picker list.
 * Tokens are stripped: the response carries id/name/category/picture only.
 */
facebookOAuthRouter.get('/pages', requireAuth, (req: AuthRequest, res: Response) => {
  const session = verifyFbSession(String(req.query.session ?? ''));
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
  const verified = session ? verifyFbSession(session) : null;
  if (!verified || verified.workspaceId !== getWorkspaceId(req)) {
    res.status(401).json({ error: 'Invalid or expired Facebook session — please log in with Facebook again.' });
    return;
  }
  const page = verified.pages.find((p) => p.id === pageId);
  if (!page) {
    res.status(400).json({ error: 'Unknown page — please log in with Facebook again.' });
    return;
  }
  const result = await createOAuthChannel(verified.workspaceId, {
    platform: 'messenger',
    externalId: page.id,
    displayName: page.name,
    token: page.token,
    pictureUrl: page.picture,
    userToken: verified.userToken,
    connectedByUserId: verified.connectedByUserId,
    duplicateMessage: 'This Facebook Page is already connected to this workspace.',
  });
  if (!result.ok) {
    res.status(result.reason === 'limit' ? 402 : 409).json({ error: result.message });
    return;
  }
  res.status(201).json({ channel: result.channel });
});
