import { Router, type Request, type Response } from 'express';
import { fetchWithTimeout } from '../ai-agent/http';
import { getWorkspaceId, requireAuth } from '../auth/auth';
import { config } from '../config';
import type { AuthRequest } from '../types';
import {
  createOAuthChannel,
  signSession,
  verifySession,
  webRedirect,
} from './meta-oauth';

/**
 * "Connect TikTok" — TikTok Login Kit (TikTok for Developers).
 *
 * Flow: Channels page → GET /login (TikTok authorize URL, scope
 * user.info.basic — only what is needed to read the profile) → user
 * approves on tiktok.com → TikTok calls GET /callback?code&state →
 * code is exchanged for an access + refresh token (open.tiktokapis.com
 * /v2/oauth/token/) → the profile is VERIFIED by reading it
 * (GET /v2/user/info/) → the channel is stored. A "connected" row
 * only ever appears after that real profile read.
 *
 * The connected channel is ONE row: platform 'tiktok',
 * external_id = TikTok open_id, display_name = TikTok display name,
 * token_encrypted = access token (lives ~24h),
 * refresh_token_encrypted = refresh token (migration 33 — needed so
 * the channel can be refreshed instead of silently dying after a day),
 * picture_url = avatar. Incoming TikTok DMs resolve through the
 * existing findChannelByExternalId('tiktok', ...) webhook lookup.
 *
 * Setup the owner must do first (no code can do this for him):
 *  - Create an app at developers.tiktok.com, add the Login Kit product.
 *  - Put TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET in env (Vercel env on
 *    production) and register TIKTOK_OAUTH_REDIRECT_URI as a Redirect URI
 *    in the TikTok app. Until then /login answers 503 with a Bengali
 *    message saying exactly that — never a fake connect button.
 *  - user.info.basic is the basic profile scope. If TikTok asks the app
 *    to be reviewed for it, the flow is still built and the user must
 *    submit the app for review in the TikTok developer portal.
 *
 * No test message is ever sent. Tokens are never logged or returned.
 */
export const tiktokOAuthRouter = Router();

const SCOPES = ['user.info.basic'];

function authorizeUrl(state: string): string {
  const url = new URL(`${config.tiktok.authBaseUrl.replace(/\/$/, '')}/v2/auth/authorize/`);
  url.searchParams.set('client_key', config.tiktok.clientKey);
  url.searchParams.set('scope', SCOPES.join(','));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', config.tiktok.redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

interface TikTokTokenResponse {
  access_token?: string;
  refresh_token?: string;
  open_id?: string;
  expires_in?: number;
  scope?: string;
}

async function exchangeCode(code: string): Promise<TikTokTokenResponse> {
  const res = await fetchWithTimeout(`${config.tiktok.apiBaseUrl.replace(/\/$/, '')}/v2/oauth/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: config.tiktok.clientKey,
      client_secret: config.tiktok.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: config.tiktok.redirectUri,
    }).toString(),
  });
  const data = (await res.json().catch(() => null)) as TikTokTokenResponse | null;
  if (!res.ok || typeof data?.access_token !== 'string' || !data.access_token) {
    throw new Error('TikTok did not return an access token');
  }
  return data;
}

/** VERIFY by reading the TikTok profile (GET /v2/user/info/). Null on any failure. */
export async function fetchTikTokProfile(
  accessToken: string,
): Promise<{ openId: string; displayName: string; avatarUrl: string } | null> {
  try {
    const url = new URL(`${config.tiktok.apiBaseUrl.replace(/\/$/, '')}/v2/user/info/`);
    url.searchParams.set('fields', 'open_id,display_name,avatar_url');
    const res = await fetchWithTimeout(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = (await res.json().catch(() => null)) as {
      data?: { user?: { open_id?: string; display_name?: string; avatar_url?: string } };
    } | null;
    const user = data?.data?.user;
    if (!res.ok || typeof user?.open_id !== 'string') return null;
    return { openId: user.open_id, displayName: user.display_name ?? user.open_id, avatarUrl: user.avatar_url ?? '' };
  } catch {
    return null;
  }
}

/**
 * GET /api/channels/tiktok/login — returns the TikTok authorize URL.
 * 503 (Bengali) while the TikTok app is not configured.
 */
tiktokOAuthRouter.get('/login', requireAuth, (req: AuthRequest, res: Response) => {
  if (!config.tiktok.clientKey || !config.tiktok.clientSecret) {
    res.status(503).json({
      error: 'TikTok এখনো সেটআপ হয়নি — TikTok ডেভেলপার অ্যাপের Client Key আর Client Secret দিতে হবে। developers.tiktok.com-এ গিয়ে অ্যাপ বানিয়ে Login Kit চালু করুন, তারপর Key/Secret দিন।',
      reason: 'config',
    });
    return;
  }
  const state = signSession('tiktok_oauth', { workspaceId: getWorkspaceId(req), userId: req.userId as string });
  res.json({ url: authorizeUrl(state) });
});

/**
 * GET /api/channels/tiktok/callback — public (TikTok calls it).
 * Always ends in a redirect back to the web app Channels page with
 * ?tiktok=connected | error.
 */
tiktokOAuthRouter.get('/callback', async (req: Request, res: Response) => {
  const q = req.query as Record<string, string | undefined>;
  if (q.error) {
    return webRedirect(res, 'tiktok', { tiktok: 'error', reason: 'cancelled' });
  }
  const session = q.state ? verifySession(q.state, 'tiktok_oauth') : null;
  if (!session || !q.code) return webRedirect(res, 'tiktok', { tiktok: 'error', reason: 'bad_state' });
  const workspaceId = session.workspaceId as string;
  if (!config.tiktok.clientKey || !config.tiktok.clientSecret) {
    return webRedirect(res, 'tiktok', { tiktok: 'error', reason: 'config' });
  }
  try {
    const tokens = await exchangeCode(q.code);
    const profile = await fetchTikTokProfile(tokens.access_token as string);
    if (!profile) {
      return webRedirect(res, 'tiktok', { tiktok: 'error', reason: 'verify_failed' });
    }
    if (tokens.open_id && tokens.open_id !== profile.openId) {
      return webRedirect(res, 'tiktok', { tiktok: 'error', reason: 'verify_failed' });
    }
    const expiresAt =
      typeof tokens.expires_in === 'number'
        ? new Date(Date.now() + Math.max(0, tokens.expires_in - 60) * 1000).toISOString()
        : null;
    const result = await createOAuthChannel(workspaceId, {
      platform: 'tiktok',
      externalId: profile.openId,
      displayName: profile.displayName,
      token: tokens.access_token as string,
      pictureUrl: profile.avatarUrl || null,
      refreshToken: tokens.refresh_token ?? null,
      expiresAt,
      duplicateMessage: 'This TikTok account is already connected to this workspace.',
    });
    if (!result.ok) {
      return webRedirect(res, 'tiktok', { tiktok: 'error', reason: result.reason });
    }
    return webRedirect(res, 'tiktok', { tiktok: 'connected', name: profile.displayName });
  } catch (err) {
    console.error('[tiktok-oauth] callback failed:', (err as Error).message);
    return webRedirect(res, 'tiktok', { tiktok: 'error', reason: 'exchange_failed' });
  }
});
