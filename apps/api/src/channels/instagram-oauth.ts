import { Router, type Response } from 'express';
import { fetchWithTimeout } from '../ai-agent/http';
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
  graphBase,
  loginUrl,
  OAUTH_GRAPH_TIMEOUT_MS,
  signSession,
  signStateToken,
  verifySession,
  webRedirect,
  type FbPickPage,
  type VerifiedState,
} from './meta-oauth';

/**
 * "Connect Instagram" — connects the Instagram Business/Creator account
 * linked to a Facebook Page, through the same Meta app as Facebook
 * Login. No Page ID or token is typed by hand.
 *
 * Flow: Channels page → GET /login (Meta dialog, Instagram scopes) →
 * Meta calls the SHARED callback (/api/channels/facebook/callback — the
 * one redirect URI registered in the Meta app; the state JWT carries
 * channel='instagram') → code is exchanged for a long-lived user token
 * → /me/accounts lists the user's Pages → each Page is checked for a
 * linked Instagram account (GET /{page-id}?fields=instagram_business_account)
 * → exactly 1 linked account: the channel is created immediately;
 * >1 linked: the user picks one on the Channels page (POST /connect);
 * none linked: redirect with reason=ig_not_linked (and the Page name
 * when there is exactly one Page).
 *
 * The connected channel is ONE row: platform 'instagram',
 * external_id = Instagram user ID, display_name = Instagram username,
 * token_encrypted = the Page access token (Instagram DMs are sent
 * through the Page), picture_url = Instagram profile picture,
 * source_id = the Facebook Page ID. Incoming Instagram DMs resolve
 * through the existing findChannelByExternalId('instagram', igUserId)
 * webhook lookup.
 *
 * NOTE (Meta-side setup): the instagram_basic + instagram_manage_messages
 * scopes are granted through Facebook Login for Business. Publishing
 * needs instagram_content_publish too (added 2026-11-08) — a channel
 * connected before that scope was added carries only the old scopes
 * (stored in channels.scopes, migration 34) and the publisher fails
 * honestly with a "reconnect Instagram" message until the owner
 * reconnects. In Development mode the app admin can grant them for
 * their own account; public shops need App Review (advanced access)
 * later.
 */
export const instagramOAuthRouter = Router();

const SCOPES = ['pages_show_list', 'pages_read_engagement', 'instagram_basic', 'instagram_manage_messages', 'instagram_manage_comments', 'instagram_content_publish'];

/** One Page enriched with its linked Instagram account (null = none linked). */
export interface IgPickPage extends FbPickPage {
  instagram: { id: string; username: string; picture: string } | null;
}

interface IgSession {
  workspaceId: string;
  pages: IgPickPage[];
  userToken: string | null;
  connectedByUserId: string | null;
}

/**
 * The Instagram account linked to a Page (null when none is linked or
 * the lookup fails — a per-page failure must not fail the whole flow).
 * Uses the Page access token, which is the token Instagram messaging
 * needs anyway.
 */
async function fetchPageInstagram(
  pageToken: string,
  pageId: string,
): Promise<{ id: string; username: string; picture: string } | null> {
  try {
    const url = new URL(`${graphBase()}/${encodeURIComponent(pageId)}`);
    url.searchParams.set('fields', 'instagram_business_account{id,username,profile_picture_url}');
    const res = await fetchWithTimeout(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${pageToken}` },
    }, OAUTH_GRAPH_TIMEOUT_MS);
    const data = (await res.json().catch(() => null)) as {
      instagram_business_account?: { id?: string; username?: string; profile_picture_url?: string };
    } | null;
    const ig = data?.instagram_business_account;
    if (!res.ok || typeof ig?.id !== 'string' || typeof ig?.username !== 'string') return null;
    return { id: ig.id, username: ig.username, picture: ig.profile_picture_url ?? '' };
  } catch {
    return null;
  }
}

/**
 * VERIFY the linked Instagram account by reading its own profile
 * (GET /{ig-user-id}?fields=id,username,profile_picture_url) with the
 * Page token. The Page → instagram_business_account lookup alone only
 * proves a link exists; this proves the token can actually read the
 * account — a connect that cannot read the profile is not a working
 * connect, so a failure here redirects with reason=ig_verify_failed
 * instead of storing a dead channel. Never throws (null on failure).
 */
export async function fetchInstagramProfile(
  pageToken: string,
  igUserId: string,
): Promise<{ id: string; username: string; picture: string } | null> {
  try {
    const url = new URL(`${graphBase()}/${encodeURIComponent(igUserId)}`);
    url.searchParams.set('fields', 'id,username,profile_picture_url');
    const res = await fetchWithTimeout(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${pageToken}` },
    }, OAUTH_GRAPH_TIMEOUT_MS);
    const data = (await res.json().catch(() => null)) as {
      id?: string;
      username?: string;
      profile_picture_url?: string;
    } | null;
    if (!res.ok || typeof data?.id !== 'string' || typeof data?.username !== 'string') return null;
    return { id: data.id, username: data.username, picture: data.profile_picture_url ?? '' };
  } catch {
    return null;
  }
}

async function createInstagramChannel(
  workspaceId: string,
  page: IgPickPage,
  userToken: string | null,
  connectedByUserId: string | null,
): Promise<ReturnType<typeof createOAuthChannel>> {
  const ig = page.instagram as { id: string; username: string; picture: string };
  return createOAuthChannel(workspaceId, {
    platform: 'instagram',
    externalId: ig.id,
    displayName: ig.username,
    token: page.token,
    pictureUrl: ig.picture,
    sourceId: page.id,
    userToken,
    connectedByUserId,
    scopes: SCOPES.join(','),
    duplicateMessage: 'This Instagram account is already connected to this workspace.',
  });
}

/** Complete the Instagram flow after the code exchange (shared callback). */
export async function completeInstagramOAuth(
  verified: VerifiedState,
  code: string,
  res: Response,
): Promise<void> {
  const shortToken = await exchangeCodeForToken(code);
  const longToken = await exchangeForLongLived(shortToken);
  const account = await fetchMeName(longToken);
  // Store the connecting user's token + app-scoped ID on the channel
  // row (migration 20) — the profile fetch retries with the USER token
  // when the Page token cannot load a sender (see meta-profile.ts).
  const connectedByUserId = await fetchMeId(longToken);
  const pages = await fetchPages(longToken);
  if (pages.length === 0) {
    return webRedirect(res, 'instagram', {
      instagram: 'error',
      reason: 'no_pages',
      ...(account ? { account } : {}),
    });
  }
  // Per-page Instagram lookups are independent — run them in parallel
  // instead of sequentially (same timeout-class hardening as WhatsApp:
  // a slow Graph call on one Page must not stall the whole callback).
  const enriched: IgPickPage[] = await Promise.all(
    pages.map(async (p) => ({ ...p, instagram: await fetchPageInstagram(p.token, p.id) })),
  );
  const linked = enriched.filter((p) => p.instagram !== null);
  if (linked.length === 0) {
    return webRedirect(res, 'instagram', {
      instagram: 'error',
      reason: 'ig_not_linked',
      ...(account ? { account } : {}),
      ...(pages.length === 1 ? { page: pages[0].name } : {}),
    });
  }
  if (linked.length === 1) {
    // Verify the profile is actually readable before storing the channel.
    const verifiedProfile = await fetchInstagramProfile(linked[0].token, (linked[0].instagram as { id: string }).id);
    if (!verifiedProfile) {
      return webRedirect(res, 'instagram', {
        instagram: 'error',
        reason: 'ig_verify_failed',
        ...(account ? { account } : {}),
      });
    }
    const result = await createInstagramChannel(verified.workspaceId, linked[0], longToken, connectedByUserId || null);
    if (!result.ok) {
      return webRedirect(res, 'instagram', {
        instagram: 'error',
        reason: result.reason,
        ...(account ? { account } : {}),
      });
    }
    return webRedirect(res, 'instagram', {
      instagram: 'connected',
      name: (linked[0].instagram as { username: string }).username,
    });
  }
  const session = signSession('instagram_pages', {
    workspaceId: verified.workspaceId,
    pages: enriched,
    userToken: longToken,
    connectedByUserId: connectedByUserId || null,
  });
  return webRedirect(res, 'instagram', {
    instagram: 'pick',
    session,
    ...(account ? { account } : {}),
  });
}

function verifyIgSession(token: string): IgSession | null {
  const p = verifySession(token, 'instagram_pages');
  if (!p || typeof p.workspaceId !== 'string' || !Array.isArray(p.pages)) return null;
  const pages = p.pages as IgPickPage[];
  if (
    !pages.every(
      (pg) =>
        typeof pg?.id === 'string' &&
        typeof pg?.token === 'string' &&
        (pg.instagram === null ||
          (typeof pg.instagram?.id === 'string' && typeof pg.instagram?.username === 'string')),
    )
  ) {
    return null;
  }
  return {
    workspaceId: p.workspaceId as string,
    pages,
    userToken: typeof p.userToken === 'string' ? (p.userToken as string) : null,
    connectedByUserId: typeof p.connectedByUserId === 'string' ? (p.connectedByUserId as string) : null,
  };
}

/**
 * GET /api/channels/instagram/login — returns the Meta dialog URL.
 * 503 while no Meta app is configured (META_APP_ID unset).
 * ?reauthenticate=1 forces Facebook to ask for credentials again so the
 * user can log in with a DIFFERENT Facebook account (see loginUrl).
 */
instagramOAuthRouter.get('/login', requireAuth, (req: AuthRequest, res: Response) => {
  if (!config.meta.appId) {
    res.status(503).json({
      error: 'Instagram login is not configured yet — the Meta app (META_APP_ID) has not been set up. The platform owner needs to connect a Meta app first.',
    });
    return;
  }
  const state = signStateToken(req.userId as string, getWorkspaceId(req), 'instagram');
  res.json({ url: loginUrl(SCOPES, state, { reauthenticate: req.query.reauthenticate === '1' }) });
});

/**
 * GET /api/channels/instagram/pages?session=... — the picker list.
 * Tokens are stripped: each Page carries id/name/category/picture plus
 * its linked Instagram account (or null) — never a token.
 */
instagramOAuthRouter.get('/pages', requireAuth, (req: AuthRequest, res: Response) => {
  const session = verifyIgSession(String(req.query.session ?? ''));
  if (!session || session.workspaceId !== getWorkspaceId(req)) {
    res.status(401).json({ error: 'Invalid or expired Instagram session — please log in again.' });
    return;
  }
  res.json({
    pages: session.pages.map(({ id, name, category, picture, instagram }) => ({
      id,
      name,
      category,
      picture,
      instagram: instagram ? { id: instagram.id, username: instagram.username, picture: instagram.picture } : null,
    })),
  });
});

/** POST /api/channels/instagram/connect — connect the picked Page's Instagram account. */
instagramOAuthRouter.post('/connect', requireAuth, async (req: AuthRequest, res: Response) => {
  const { session, pageId } = (req.body ?? {}) as { session?: string; pageId?: string };
  const verified = session ? verifyIgSession(session) : null;
  if (!verified || verified.workspaceId !== getWorkspaceId(req)) {
    res.status(401).json({ error: 'Invalid or expired Instagram session — please log in again.' });
    return;
  }
  const page = verified.pages.find((p) => p.id === pageId);
  if (!page) {
    res.status(400).json({ error: 'Unknown page — please log in again.' });
    return;
  }
  if (!page.instagram) {
    res.status(400).json({
      error: `The Facebook Page "${page.name}" has no Instagram account linked. Link an Instagram Business or Creator account to that Page in Meta Business Suite, then try again.`,
      reason: 'ig_not_linked',
    });
    return;
  }
  const result = await createInstagramChannel(
    verified.workspaceId,
    page,
    verified.userToken,
    verified.connectedByUserId,
  );
  if (!result.ok) {
    res.status(result.reason === 'limit' ? 402 : 409).json({ error: result.message });
    return;
  }
  res.status(201).json({ channel: result.channel });
});
