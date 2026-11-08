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
 * "Connect YouTube" — Google OAuth (YouTube Data API v3).
 *
 * Scopes (all requested at connect; Google re-consents on reconnect):
 *  - youtube.readonly — read the channel + videos + comments.
 *  - youtube.upload — upload videos (needed for scheduled YouTube posts).
 *  - youtube.force-ssl — reply to comments.
 * A channel connected BEFORE the upload scope was added carries only
 * readonly: the stored scopes (migration 34) say so, the publisher
 * refuses the upload honestly, and reconnecting (Channels → YouTube →
 * connect again — prompt=consent is always set, so Google asks again)
 * upgrades the stored token to the new scopes. Uploading from an
 * unverified Google OAuth app is restricted by Google until the app is
 * verified — see docs/youtube-tiktok-setup.md.
 *
 * Flow: Channels page → GET /login (Google authorize URL) → user signs
 * in with Google and approves → Google calls GET /callback?code &state
 * → code is exchanged for an access + refresh token
 * (oauth2.googleapis.com/token) → the channel is VERIFIED by reading
 * it (GET /youtube/v3/channels?part=snippet&mine=true) → the channel
 * is stored. A "connected" row only ever appears after that real
 * channel read. This is a proper Google OAuth flow — not the browser
 * Google sign-in that was blocked before.
 *
 * The connected channel is ONE row: platform 'youtube',
 * external_id = YouTube channel id, display_name = channel title,
 * token_encrypted = access token (lives ~1h),
 * refresh_token_encrypted = refresh token (migration 33 — needed so
 * the channel can be refreshed instead of silently dying after an
 * hour), picture_url = channel thumbnail, scopes = granted scopes
 * (migration 34).
 *
 * Setup the owner must do first (no code can do this for him):
 *  - Google Cloud console → create an OAuth client (Web application),
 *    enable the YouTube Data API v3, and add GOOGLE_OAUTH_REDIRECT_URI
 *    to its Authorized redirect URIs.
 *  - Put GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in env (Vercel env on
 *    production). Until then /login answers 503 with a Bengali message
 *    saying exactly that — never a fake connect button.
 *
 * No test upload or message is ever sent. Tokens are never logged or
 * returned.
 */
export const youtubeOAuthRouter = Router();

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.force-ssl',
];

function authorizeUrl(state: string): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', config.google.clientId);
  url.searchParams.set('redirect_uri', config.google.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);
  return url.toString();
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

async function exchangeCode(code: string): Promise<GoogleTokenResponse> {
  const res = await fetchWithTimeout(config.google.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: config.google.redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  });
  const data = (await res.json().catch(() => null)) as GoogleTokenResponse | null;
  if (!res.ok || typeof data?.access_token !== 'string' || !data.access_token) {
    throw new Error('Google did not return an access token');
  }
  return data;
}

/** VERIFY by reading the channel (GET /youtube/v3/channels?mine=true). Null on any failure. */
export async function fetchYoutubeChannel(
  accessToken: string,
): Promise<{ id: string; title: string; thumbnail: string } | null> {
  try {
    const url = new URL(`${config.google.apiBaseUrl.replace(/\/$/, '')}/youtube/v3/channels`);
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('mine', 'true');
    const res = await fetchWithTimeout(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = (await res.json().catch(() => null)) as {
      items?: { id?: string; snippet?: { title?: string; thumbnails?: { default?: { url?: string } } } }[];
    } | null;
    const item = data?.items?.[0];
    if (!res.ok || typeof item?.id !== 'string') return null;
    return {
      id: item.id,
      title: item.snippet?.title ?? item.id,
      thumbnail: item.snippet?.thumbnails?.default?.url ?? '',
    };
  } catch {
    return null;
  }
}

/**
 * GET /api/channels/youtube/login — returns the Google authorize URL.
 * 503 (Bengali) while the Google OAuth client is not configured.
 */
youtubeOAuthRouter.get('/login', requireAuth, (req: AuthRequest, res: Response) => {
  if (!config.google.clientId || !config.google.clientSecret) {
    res.status(503).json({
      error: 'YouTube এখনো সেটআপ হয়নি — Google OAuth-এর Client ID আর Client Secret দিতে হবে। Google Cloud Console-এ গিয়ে OAuth ক্লায়েন্ট বানিয়ে YouTube Data API v3 চালু করুন, তারপর ID/Secret দিন।',
      reason: 'config',
    });
    return;
  }
  const state = signSession('youtube_oauth', { workspaceId: getWorkspaceId(req), userId: req.userId as string });
  res.json({ url: authorizeUrl(state) });
});

/**
 * GET /api/channels/youtube/callback — public (Google calls it).
 * Always ends in a redirect back to the web app Channels page with
 * ?youtube=connected | error.
 */
youtubeOAuthRouter.get('/callback', async (req: Request, res: Response) => {
  const q = req.query as Record<string, string | undefined>;
  if (q.error) {
    return webRedirect(res, 'youtube', { youtube: 'error', reason: 'cancelled' });
  }
  const session = q.state ? verifySession(q.state, 'youtube_oauth') : null;
  if (!session || !q.code) return webRedirect(res, 'youtube', { youtube: 'error', reason: 'bad_state' });
  const workspaceId = session.workspaceId as string;
  if (!config.google.clientId || !config.google.clientSecret) {
    return webRedirect(res, 'youtube', { youtube: 'error', reason: 'config' });
  }
  try {
    const tokens = await exchangeCode(q.code);
    const channel = await fetchYoutubeChannel(tokens.access_token as string);
    if (!channel) {
      return webRedirect(res, 'youtube', { youtube: 'error', reason: 'verify_failed' });
    }
    const expiresAt =
      typeof tokens.expires_in === 'number'
        ? new Date(Date.now() + Math.max(0, tokens.expires_in - 60) * 1000).toISOString()
        : null;
    const result = await createOAuthChannel(workspaceId, {
      platform: 'youtube',
      externalId: channel.id,
      displayName: channel.title,
      token: tokens.access_token as string,
      pictureUrl: channel.thumbnail || null,
      refreshToken: tokens.refresh_token ?? null,
      expiresAt,
      scopes: SCOPES.join(' '),
      duplicateMessage: 'This YouTube channel is already connected to this workspace.',
    });
    if (!result.ok) {
      return webRedirect(res, 'youtube', { youtube: 'error', reason: result.reason });
    }
    return webRedirect(res, 'youtube', { youtube: 'connected', name: channel.title });
  } catch (err) {
    console.error('[youtube-oauth] callback failed:', (err as Error).message);
    return webRedirect(res, 'youtube', { youtube: 'error', reason: 'exchange_failed' });
  }
});
