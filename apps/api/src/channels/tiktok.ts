import { fetchWithTimeout } from '../ai-agent/http';
import { config } from '../config';
import { decryptToken, encryptToken } from '../db/crypto';
import { query, queryOne } from '../db/pool';

/**
 * TikTok API client — three SEPARATE TikTok surfaces, do not conflate them:
 *
 * 1) Login Kit (open.tiktokapis.com, user OAuth token from the connect):
 *    - Display API: GET profile (already in tiktok-oauth.ts) + POST
 *      /v2/video/list/ (own videos) — scope video.list.
 *    - Comment API: GET /v2/video/comment/list/?video_id=… — scope
 *      comment.list; reply POST /v2/video/comment/reply/ — the reply
 *      needs TikTok's approval of the comment scopes and fails honestly
 *      (scope_not_authorized) until then.
 *    - Content Posting API: POST /v2/post/publish/creator_info/query/
 *      (privacy levels) → POST /v2/post/publish/video/init/ (FILE_UPLOAD
 *      or PULL_FROM_URL) → PUT the bytes → POST
 *      /v2/post/publish/status/fetch/ until PUBLISH_COMPLETE. Direct Post
 *      needs scope video.publish; the inbox-draft variant
 *      (/v2/post/publish/inbox/video/init/) needs video.upload instead.
 *      Posts stay PRIVATE until the TikTok app passes audit — the
 *      publisher keeps the existing TIKTOK_SCHEDULING_AUDITED gate.
 *    - Tokens live ~24h; refresh tokens ~365 days. refreshTikTokAccessToken()
 *      renews from the stored refresh token (migration 33).
 *
 * 2) Business Messaging API (business-api.tiktok.com/open_api/v1.3 — a
 *    SEPARATE TikTok for Business product, NOT Login Kit):
 *    - GET /business/message/conversation/list/ + content/list/ (read
 *      DM threads), POST /business/message/send/ (reply), POST
 *      /business/message/media/upload/ (image). Header `Access-Token`
 *      (a Business access token, NOT the Login Kit token) + business_id
 *      (the Business Account id, NOT the Login Kit open_id).
 *    - Reply-only: the customer must message first (48h window, ~10
 *      replies); unavailable for accounts registered in the US / EEA /
 *      Switzerland / UK. Needs its own TikTok for Business approval.
 *    - Without TIKTOK_BUSINESS_ACCESS_TOKEN + TIKTOK_BUSINESS_ID in env,
 *      every DM send fails honestly with a Bengali "not set up" reason —
 *      never a fake send.
 *
 * 3) The Research API (/v2/research/video/comment/list/) is NOT used:
 *    it needs research.data.basic and an approved non-commercial research
 *    project — the wrong tool for a shop reading its own videos' comments.
 *
 * Every function returns { ok:false, error, reason } on failure — the
 * caller (publisher / routes / DM sender) logs TikTok's own message and
 * the post/message ends 'failed', never 'published'/'sent'.
 */

export const TIKTOK_LOGIN_SCOPES = [
  'user.info.basic',
  'video.list',
  'video.publish',
  'video.upload',
  'comment.list',
] as const;

export interface TikTokChannelRow {
  id: string;
  external_id: string;
  display_name: string | null;
  token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  token_expires_at: string | null;
  scopes: string | null;
}

export async function getTikTokChannel(workspaceId: string): Promise<TikTokChannelRow | null> {
  return queryOne<TikTokChannelRow>(
    workspaceId,
    `SELECT id, external_id, display_name, token_encrypted, refresh_token_encrypted,
            token_expires_at, scopes
     FROM channels
     WHERE workspace_id = $1 AND platform = 'tiktok' AND status = 'connected'
     ORDER BY created_at DESC LIMIT 1`,
    [workspaceId],
  );
}

function decrypt(channel: TikTokChannelRow, field: 'token_encrypted' | 'refresh_token_encrypted'): string | null {
  const value = channel[field];
  if (!value) return null;
  try {
    return decryptToken(value);
  } catch {
    return null;
  }
}

interface TikTokTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_expires_in?: number;
}

/** Refresh the Login Kit access token; saves the new tokens. Null on any failure. */
export async function refreshTikTokAccessToken(
  workspaceId: string,
  channel: TikTokChannelRow,
): Promise<string | null> {
  const refreshToken = decrypt(channel, 'refresh_token_encrypted');
  if (!refreshToken) return null;
  try {
    const res = await fetchWithTimeout(`${config.tiktok.apiBaseUrl.replace(/\/$/, '')}/v2/oauth/token/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: config.tiktok.clientKey,
        client_secret: config.tiktok.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }).toString(),
    });
    const data = (await res.json().catch(() => null)) as TikTokTokenResponse | null;
    if (!res.ok || typeof data?.access_token !== 'string' || !data.access_token) return null;
    const expiresAt =
      typeof data.expires_in === 'number'
        ? new Date(Date.now() + Math.max(0, data.expires_in - 60) * 1000).toISOString()
        : null;
    await query(
      workspaceId,
      `UPDATE channels SET token_encrypted = $1,
         refresh_token_encrypted = COALESCE($2, refresh_token_encrypted),
         token_expires_at = COALESCE($3, token_expires_at), updated_at = now()
       WHERE workspace_id = $4 AND id = $5`,
      [
        encryptToken(data.access_token),
        data.refresh_token ? encryptToken(data.refresh_token) : null,
        expiresAt,
        workspaceId,
        channel.id,
      ],
    );
    return data.access_token;
  } catch {
    return null;
  }
}

export type TikTokTokenResult =
  | { ok: true; accessToken: string; channel: TikTokChannelRow }
  | { ok: false; error: string; reason: 'not_connected' | 'no_token' | 'refresh_failed' };

/** A usable TikTok Login Kit access token (refreshes when expired). */
export async function getTikTokAccessToken(workspaceId: string): Promise<TikTokTokenResult> {
  const channel = await getTikTokChannel(workspaceId);
  if (!channel) {
    return {
      ok: false,
      reason: 'not_connected',
      error: 'TikTok অ্যাকাউন্ট যুক্ত নেই — Channels পেজ থেকে TikTok যুক্ত করুন (no TikTok account connected)',
    };
  }
  const stored = decrypt(channel, 'token_encrypted');
  const expiresAt = channel.token_expires_at ? new Date(channel.token_expires_at).getTime() : 0;
  if (stored && expiresAt > Date.now() + 60 * 1000) return { ok: true, accessToken: stored, channel };
  if (stored && !channel.token_expires_at) return { ok: true, accessToken: stored, channel };
  const fresh = await refreshTikTokAccessToken(workspaceId, channel);
  if (!fresh) {
    return {
      ok: false,
      reason: 'refresh_failed',
      error:
        'TikTok টোকেন নবায়ন করা যায়নি — Channels পেজ থেকে TikTok আবার যুক্ত করুন (TikTok token refresh failed — reconnect TikTok)',
    };
  }
  return { ok: true, accessToken: fresh, channel };
}

function apiUrl(path: string): string {
  return `${config.tiktok.apiBaseUrl.replace(/\/$/, '')}${path}`;
}

interface TikTokEnvelope {
  error?: { code?: string; message?: string; log_id?: string };
  data?: Record<string, unknown>;
}

/** TikTok wraps errors as { error: { code, message } }; code 'ok' = success. */
export function tiktokErrorReason(body: TikTokEnvelope | null, status: number): string {
  const code = body?.error?.code ?? '';
  if (!code) return status === 401 || status === 403 ? 'unauthorized' : `http_${status}`;
  return code;
}

type TikTokResult<T> = { ok: true; data: T } | { ok: false; error: string; reason: string };

async function tiktokGet<T>(
  accessToken: string,
  path: string,
  params: Record<string, string>,
): Promise<TikTokResult<T>> {
  const url = new URL(apiUrl(path));
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  try {
    const res = await fetchWithTimeout(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const body = (await res.json().catch(() => null)) as TikTokEnvelope | null;
    if (!res.ok || body?.error?.code) {
      return { ok: false, error: body?.error?.message ?? `TikTok API error ${res.status}`, reason: tiktokErrorReason(body, res.status) };
    }
    return { ok: true, data: (body?.data ?? {}) as T };
  } catch (err) {
    return { ok: false, error: (err as Error).message, reason: 'network' };
  }
}

async function tiktokPost<T>(
  accessToken: string,
  path: string,
  body: Record<string, unknown>,
): Promise<TikTokResult<T>> {
  try {
    const res = await fetchWithTimeout(apiUrl(path), {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as TikTokEnvelope | null;
    if (!res.ok || data?.error?.code) {
      return { ok: false, error: data?.error?.message ?? `TikTok API error ${res.status}`, reason: tiktokErrorReason(data, res.status) };
    }
    return { ok: true, data: (data?.data ?? {}) as T };
  } catch (err) {
    return { ok: false, error: (err as Error).message, reason: 'network' };
  }
}

// ---------------------------------------------------------------------------
// Display API — list the account's own videos
// ---------------------------------------------------------------------------

export interface TikTokVideo {
  id: string;
  title: string;
  coverImageUrl: string | null;
  shareUrl: string | null;
  createTime: number | null;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  shareCount: number | null;
}

/** Live list of the account's videos (POST /v2/video/list/, max 20/page). */
export async function fetchTikTokVideos(
  accessToken: string,
  cursor = 0,
): Promise<TikTokResult<{ videos: TikTokVideo[]; hasMore: boolean; cursor: number }>> {
  const res = await tiktokPost<{
    videos?: {
      id?: string;
      title?: string;
      cover_image_url?: string;
      share_url?: string;
      create_time?: number;
      view_count?: number;
      like_count?: number;
      comment_count?: number;
      share_count?: number;
    }[];
    has_more?: boolean;
    cursor?: number;
  }>(accessToken, '/v2/video/list/', {
    max_count: 20,
    cursor,
    fields: ['id', 'title', 'cover_image_url', 'share_url', 'create_time', 'view_count', 'like_count', 'comment_count', 'share_count'].join(','),
  });
  if (!res.ok) return res;
  return {
    ok: true,
    data: {
      videos: (res.data.videos ?? []).map((v) => ({
        id: String(v.id ?? ''),
        title: v.title ?? '',
        coverImageUrl: v.cover_image_url ?? null,
        shareUrl: v.share_url ?? null,
        createTime: typeof v.create_time === 'number' ? v.create_time : null,
        viewCount: typeof v.view_count === 'number' ? v.view_count : null,
        likeCount: typeof v.like_count === 'number' ? v.like_count : null,
        commentCount: typeof v.comment_count === 'number' ? v.comment_count : null,
        shareCount: typeof v.share_count === 'number' ? v.share_count : null,
      })).filter((v) => v.id),
      hasMore: res.data.has_more === true,
      cursor: typeof res.data.cursor === 'number' ? res.data.cursor : 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Comment API — read + reply on the account's own videos
// ---------------------------------------------------------------------------

export interface TikTokComment {
  commentId: string;
  videoId: string;
  author: string;
  authorAvatar: string | null;
  text: string;
  createdAt: string | null;
  likeCount: number;
  replyCount: number;
}

/**
 * Live comments on one video (GET /v2/video/comment/list/, scope
 * comment.list). The response carries no commenter name/avatar — only
 * ids + text + counts — so author shows as the TikTok user id; the
 * webhook intake (webhooks/routes.ts) is where a name arrives with the
 * comment event. Replies are NOT inlined: replyCount tells the UI a
 * thread exists; fetchTikTokCommentReplies(commentId) reads it.
 */
export async function fetchTikTokComments(
  accessToken: string,
  videoId: string,
  cursor = 0,
): Promise<TikTokResult<{ comments: TikTokComment[]; hasMore: boolean; cursor: number }>> {
  const res = await tiktokGet<{
    comments?: {
      id?: string;
      video_id?: string;
      text?: string;
      like_count?: number;
      reply_count?: number;
      create_time?: number;
      user?: { open_id?: string; nickname?: string; avatar_url?: string };
    }[];
    has_more?: boolean;
    cursor?: number;
  }>(accessToken, '/v2/video/comment/list/', {
    video_id: videoId,
    cursor: String(cursor),
    max_count: '20',
    fields: ['id', 'video_id', 'text', 'like_count', 'reply_count', 'create_time'].join(','),
  });
  if (!res.ok) return res;
  return {
    ok: true,
    data: {
      comments: (res.data.comments ?? []).map((c) => ({
        commentId: String(c.id ?? ''),
        videoId: String(c.video_id ?? videoId),
        author: c.user?.nickname ?? c.user?.open_id ?? 'TikTok user',
        authorAvatar: c.user?.avatar_url ?? null,
        text: c.text ?? '',
        createdAt: typeof c.create_time === 'number' ? new Date(c.create_time * 1000).toISOString() : null,
        likeCount: Number(c.like_count ?? 0),
        replyCount: Number(c.reply_count ?? 0),
      })).filter((c) => c.commentId && c.text),
      hasMore: res.data.has_more === true,
      cursor: typeof res.data.cursor === 'number' ? res.data.cursor : 0,
    },
  };
}

/** Replies under one comment (same endpoint, comment_id instead of video_id). */
export async function fetchTikTokCommentReplies(
  accessToken: string,
  commentId: string,
  cursor = 0,
): Promise<TikTokResult<{ comments: TikTokComment[]; hasMore: boolean; cursor: number }>> {
  const res = await tiktokGet<{
    comments?: {
      id?: string;
      video_id?: string;
      text?: string;
      like_count?: number;
      reply_count?: number;
      create_time?: number;
    }[];
    has_more?: boolean;
    cursor?: number;
  }>(accessToken, '/v2/video/comment/list/', {
    comment_id: commentId,
    cursor: String(cursor),
    max_count: '20',
    fields: ['id', 'video_id', 'text', 'like_count', 'reply_count', 'create_time'].join(','),
  });
  if (!res.ok) return res;
  return {
    ok: true,
    data: {
      comments: (res.data.comments ?? []).map((c) => ({
        commentId: String(c.id ?? ''),
        videoId: String(c.video_id ?? ''),
        author: 'TikTok user',
        authorAvatar: null,
        text: c.text ?? '',
        createdAt: typeof c.create_time === 'number' ? new Date(c.create_time * 1000).toISOString() : null,
        likeCount: Number(c.like_count ?? 0),
        replyCount: Number(c.reply_count ?? 0),
      })).filter((c) => c.commentId && c.text),
      hasMore: res.data.has_more === true,
      cursor: typeof res.data.cursor === 'number' ? res.data.cursor : 0,
    },
  };
}

/**
 * Reply to a TikTok comment (POST /v2/video/comment/reply/). Best-effort
 * by design: TikTok approves the comment scopes per app, and an
 * unapproved app gets scope_not_authorized — the failure is returned
 * honestly (never a fake reply) and the caller surfaces it.
 */
export async function replyTikTokComment(
  accessToken: string,
  videoId: string,
  commentId: string,
  text: string,
): Promise<TikTokResult<{ replyId: string }>> {
  const res = await tiktokPost<{ comment_id?: string; id?: string }>(accessToken, '/v2/video/comment/reply/', {
    video_id: videoId,
    comment_id: commentId,
    text,
  });
  if (!res.ok) return res;
  const replyId = String(res.data.comment_id ?? res.data.id ?? '');
  if (!replyId) return { ok: false, error: 'TikTok accepted the reply but returned no comment id', reason: 'no_reply_id' };
  return { ok: true, data: { replyId } };
}

// ---------------------------------------------------------------------------
// Content Posting API — direct video post (async: init → upload → poll)
// ---------------------------------------------------------------------------

export interface TikTokPublishInit {
  publishId: string;
  uploadUrl: string | null;
}

/**
 * Start a Direct Post video publish. source FILE_UPLOAD (we PUT the bytes
 * to upload_url) — PULL_FROM_URL needs a TikTok-verified domain, which
 * this app does not have. creator_info/query runs first so a wrong
 * privacy level fails fast with TikTok's own message.
 */
export async function initTikTokVideoPublish(
  accessToken: string,
  opts: { title: string; videoSize: number; chunkSize: number; totalChunkCount: number; privacyLevel?: string },
): Promise<TikTokResult<TikTokPublishInit>> {
  const info = await tiktokPost<{ privacy_level_options?: string[] }>(accessToken, '/v2/post/publish/creator_info/query/', {});
  if (!info.ok) return info;
  const privacy = opts.privacyLevel ?? 'SELF_ONLY';
  const allowed = info.data.privacy_level_options ?? [];
  if (allowed.length > 0 && !allowed.includes(privacy)) {
    return { ok: false, error: `TikTok does not allow privacy level ${privacy} for this account (allowed: ${allowed.join(', ')})`, reason: 'privacy_not_allowed' };
  }
  const init = await tiktokPost<{
    publish_id?: string;
    upload_url?: string;
  }>(accessToken, '/v2/post/publish/video/init/', {
    post_info: {
      title: opts.title.slice(0, 220),
      privacy_level: privacy,
      disable_duet: false,
      disable_comment: false,
      disable_stitch: false,
      video_cover_timestamp_ms: 1000,
    },
    source_info: {
      source: 'FILE_UPLOAD',
      video_size: opts.videoSize,
      chunk_size: opts.chunkSize,
      total_chunk_count: opts.totalChunkCount,
    },
  });
  if (!init.ok) return init;
  const publishId = String(init.data.publish_id ?? '');
  if (!publishId) return { ok: false, error: 'TikTok accepted the publish init but returned no publish_id', reason: 'no_publish_id' };
  return { ok: true, data: { publishId, uploadUrl: init.data.upload_url ?? null } };
}

/** PUT one chunk of the video to TikTok's upload_url (Content-Range). */
export async function uploadTikTokChunk(
  uploadUrl: string,
  chunk: Buffer,
  start: number,
  total: number,
): Promise<TikTokResult<null>> {
  try {
    const res = await fetchWithTimeout(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': String(chunk.length),
        'Content-Range': `bytes ${start}-${start + chunk.length - 1}/${total}`,
        'Content-Type': 'video/mp4',
      },
      body: chunk,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `TikTok chunk upload failed (${res.status}) ${text.slice(0, 200)}`, reason: `http_${res.status}` };
    }
    return { ok: true, data: null };
  } catch (err) {
    return { ok: false, error: (err as Error).message, reason: 'network' };
  }
}

export type TikTokPublishStatus = 'PROCESSING' | 'PUBLISH_COMPLETE' | 'FAILED' | 'UNKNOWN';

/** Poll one publish_id (POST /v2/post/publish/status/fetch/). */
export async function fetchTikTokPublishStatus(
  accessToken: string,
  publishId: string,
): Promise<TikTokResult<{ status: TikTokPublishStatus; failReason: string | null; publicVideoId: string | null }>> {
  const res = await tiktokPost<{
    status?: string;
    fail_reason?: string;
    public_video_id?: string;
  }>(accessToken, '/v2/post/publish/status/fetch/', { publish_id: publishId });
  if (!res.ok) return res;
  const raw = String(res.data.status ?? '');
  const status: TikTokPublishStatus =
    raw === 'PUBLISH_COMPLETE' ? 'PUBLISH_COMPLETE' : raw === 'FAILED' ? 'FAILED' : raw ? 'PROCESSING' : 'UNKNOWN';
  return {
    ok: true,
    data: {
      status,
      failReason: res.data.fail_reason ?? null,
      publicVideoId: res.data.public_video_id ? String(res.data.public_video_id) : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Business Messaging API (TikTok for Business) — DM read + reply
// ---------------------------------------------------------------------------

export interface TikTokBusinessConfig {
  configured: boolean;
  businessId: string;
  accessToken: string;
  baseUrl: string;
}

export function getTikTokBusinessConfig(): TikTokBusinessConfig {
  const businessId = config.tiktok.business.businessId;
  const accessToken = config.tiktok.business.accessToken;
  return {
    configured: Boolean(businessId && accessToken),
    businessId,
    accessToken,
    baseUrl: config.tiktok.business.baseUrl.replace(/\/$/, ''),
  };
}

interface BusinessEnvelope {
  code?: number;
  message?: string;
  data?: Record<string, unknown>;
}

async function businessCall<T>(
  cfg: TikTokBusinessConfig,
  path: string,
  opts: { method?: 'GET' | 'POST'; query?: Record<string, string>; body?: Record<string, unknown> },
): Promise<TikTokResult<T>> {
  const url = new URL(`${cfg.baseUrl}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  try {
    const res = await fetchWithTimeout(url.toString(), {
      method: opts.method ?? 'GET',
      headers: {
        'Access-Token': cfg.accessToken,
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = (await res.json().catch(() => null)) as BusinessEnvelope | null;
    if (!res.ok || (typeof data?.code === 'number' && data.code !== 0)) {
      return {
        ok: false,
        error: data?.message ?? `TikTok Business Messaging error ${res.status}`,
        reason: typeof data?.code === 'number' ? `code_${data.code}` : `http_${res.status}`,
      };
    }
    return { ok: true, data: (data?.data ?? {}) as T };
  } catch (err) {
    return { ok: false, error: (err as Error).message, reason: 'network' };
  }
}

export interface TikTokDMConversation {
  conversationId: string;
  updateTime: string | null;
}

export interface TikTokDMMessage {
  messageId: string;
  text: string;
  createdAt: string | null;
  isOwn: boolean;
  senderId: string | null;
  senderName: string | null;
  senderAvatar: string | null;
}

/** Live DM conversation list (SINGLE + STRANGER). */
export async function listTikTokDMConversations(
  cfg: TikTokBusinessConfig,
): Promise<TikTokResult<{ conversations: TikTokDMConversation[] }>> {
  const seen = new Set<string>();
  const out: TikTokDMConversation[] = [];
  for (const conversationType of ['SINGLE', 'STRANGER']) {
    const res = await businessCall<{ conversations?: { conversation_id?: string; update_time?: number }[] }>(cfg, '/business/message/conversation/list/', {
      query: { business_id: cfg.businessId, conversation_type: conversationType, limit: '50' },
    });
    if (!res.ok) return res;
    for (const c of res.data.conversations ?? []) {
      const id = String(c.conversation_id ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({
        conversationId: id,
        updateTime: typeof c.update_time === 'number' ? new Date((c.update_time < 1e12 ? c.update_time * 1000 : c.update_time)).toISOString() : null,
      });
    }
  }
  return { ok: true, data: { conversations: out } };
}

export interface TikTokDMThread {
  participants: { id: string; displayName: string | null; avatarUrl: string | null; role: string | null }[];
  messages: TikTokDMMessage[];
}

/** Live messages of one DM conversation. */
export async function fetchTikTokDMThread(
  cfg: TikTokBusinessConfig,
  conversationId: string,
): Promise<TikTokResult<TikTokDMThread>> {
  const res = await businessCall<{
    participants?: { id?: string; display_name?: string; profile_image?: string; role?: string }[];
    messages?: {
      message_id?: string;
      timestamp?: number;
      text?: { body?: string };
      from_user?: { role?: string; id?: string };
      sender?: string;
    }[];
  }>(cfg, '/business/message/content/list/', {
    query: { business_id: cfg.businessId, conversation_id: conversationId },
  });
  if (!res.ok) return res;
  const participants = (res.data.participants ?? []).map((p) => ({
    id: String(p.id ?? ''),
    displayName: p.display_name ?? null,
    avatarUrl: p.profile_image ?? null,
    role: p.role ?? null,
  }));
  const messages: TikTokDMMessage[] = (res.data.messages ?? []).map((m) => {
    const isOwn = m.from_user?.role === 'BUSINESS_ACCOUNT' || m.from_user?.id === cfg.businessId || m.sender === cfg.businessId;
    const sender = participants.find((p) => p.id === (m.from_user?.id ?? m.sender ?? ''));
    return {
      messageId: String(m.message_id ?? ''),
      text: m.text?.body ?? '',
      createdAt: typeof m.timestamp === 'number' ? new Date((m.timestamp < 1e12 ? m.timestamp * 1000 : m.timestamp)).toISOString() : null,
      isOwn,
      senderId: m.from_user?.id ?? m.sender ?? null,
      senderName: sender?.displayName ?? null,
      senderAvatar: sender?.avatarUrl ?? null,
    };
  }).filter((m) => m.messageId && m.text);
  messages.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  return { ok: true, data: { participants, messages } };
}

/**
 * Find the Business Messaging conversation_id for one customer (their
 * TikTok user id): list conversations, read each thread's participants,
 * match the peer. Slow (one call per thread) but it is the only mapping
 * TikTok offers — the webhook stores message ids, not conversation ids.
 */
export async function resolveTikTokDMConversationId(
  cfg: TikTokBusinessConfig,
  peerUserId: string,
): Promise<TikTokResult<{ conversationId: string }>> {
  const list = await listTikTokDMConversations(cfg);
  if (!list.ok) return list;
  for (const conv of list.data.conversations) {
    const thread = await fetchTikTokDMThread(cfg, conv.conversationId);
    if (!thread.ok) continue;
    if (thread.data.participants.some((p) => p.id === peerUserId && p.role !== 'BUSINESS_ACCOUNT')) {
      return { ok: true, data: { conversationId: conv.conversationId } };
    }
  }
  return { ok: false, error: `TikTok-এ এই কাস্টমারের সাথে কোনো DM কথোপকথন পাওয়া যায়নি — কাস্টমারকে প্রথমে মেসেজ পাঠাতে হবে (no TikTok DM conversation found for this customer — they must message first)`, reason: 'no_conversation' };
}

/** Send a text DM reply (POST /business/message/send/). Returns TikTok's real message id. */
export async function sendTikTokBusinessDM(
  cfg: TikTokBusinessConfig,
  conversationId: string,
  text: string,
): Promise<TikTokResult<{ messageId: string }>> {
  const res = await businessCall<{ message?: { message_id?: string } }>(cfg, '/business/message/send/', {
    method: 'POST',
    body: {
      business_id: cfg.businessId,
      recipient_type: 'CONVERSATION',
      recipient: conversationId,
      message_type: 'TEXT',
      text: { body: text },
    },
  });
  if (!res.ok) return res;
  const messageId = String(res.data.message?.message_id ?? '');
  if (!messageId) return { ok: false, error: 'TikTok accepted the DM but returned no message id', reason: 'no_message_id' };
  return { ok: true, data: { messageId } };
}

/** Upload an image for a DM (POST /business/message/media/upload/, multipart). */
export async function uploadTikTokDMImage(
  cfg: TikTokBusinessConfig,
  image: Buffer,
  fileName = 'inbox.jpg',
): Promise<TikTokResult<{ mediaId: string }>> {
  try {
    const form = new FormData();
    form.append('business_id', cfg.businessId);
    form.append('file', new Blob([new Uint8Array(image)], { type: 'image/jpeg' }), fileName);
    form.append('media_type', 'IMAGE');
    const res = await fetchWithTimeout(`${cfg.baseUrl}/business/message/media/upload/`, {
      method: 'POST',
      headers: { 'Access-Token': cfg.accessToken },
      body: form,
    });
    const data = (await res.json().catch(() => null)) as BusinessEnvelope | null;
    if (!res.ok || (typeof data?.code === 'number' && data.code !== 0)) {
      return { ok: false, error: data?.message ?? `TikTok image upload failed (${res.status})`, reason: `code_${data?.code ?? res.status}` };
    }
    const mediaId = String((data?.data as { media_id?: string } | undefined)?.media_id ?? '');
    if (!mediaId) return { ok: false, error: 'TikTok accepted the image but returned no media_id', reason: 'no_media_id' };
    return { ok: true, data: { mediaId } };
  } catch (err) {
    return { ok: false, error: (err as Error).message, reason: 'network' };
  }
}

/** Send an image DM reply (upload first, then send with message_type IMAGE). */
export async function sendTikTokBusinessDMImage(
  cfg: TikTokBusinessConfig,
  conversationId: string,
  image: Buffer,
): Promise<TikTokResult<{ messageId: string }>> {
  const uploaded = await uploadTikTokDMImage(cfg, image);
  if (!uploaded.ok) return uploaded;
  const res = await businessCall<{ message?: { message_id?: string } }>(cfg, '/business/message/send/', {
    method: 'POST',
    body: {
      business_id: cfg.businessId,
      recipient_type: 'CONVERSATION',
      recipient: conversationId,
      message_type: 'IMAGE',
      image: { media_id: uploaded.data.mediaId },
    },
  });
  if (!res.ok) return res;
  const messageId = String(res.data.message?.message_id ?? '');
  if (!messageId) return { ok: false, error: 'TikTok accepted the DM but returned no message id', reason: 'no_message_id' };
  return { ok: true, data: { messageId } };
}
