import { fetchWithTimeout } from '../ai-agent/http';
import { config } from '../config';
import { decryptToken, encryptToken } from '../db/crypto';
import { query, queryOne } from '../db/pool';

/**
 * YouTube Data API v3 client (read + upload + comments).
 *
 * Auth: the workspace's connected 'youtube' channel row (Google OAuth).
 * Access tokens live ~1h; the stored refresh token (migration 33) renews
 * them here — getYoutubeAccessToken() refreshes automatically when the
 * stored token is expired (or within 60s of expiring) and saves the new
 * one, so publishing never dies silently after an hour. A channel
 * connected with the OLD read-only scopes cannot upload: hasUploadScope()
 * reads the granted scopes stored at connect time (migration 34) and the
 * publisher fails honestly telling the owner to reconnect (Channels →
 * YouTube → connect again, which re-consents with the upload scope).
 *
 * Quota (honest accounting): the YouTube Data API default is 10,000
 * units/day per Google Cloud project (resets midnight Pacific). A video
 * upload historically cost ~1,600 units (~6 uploads/day); Google's Dec
 * 2025 revision moved videos.insert into its own bucket (100 calls/day,
 * 1 unit each) — the code still caps at 6 uploads/day per workspace and
 * reports units on the old 1,600-unit math, i.e. the conservative side.
 * Either way the API itself is the authority: a 403 quotaExceeded from
 * Google fails the publish honestly (never a fake success) and the
 * reason is stored in post_publish_logs. getYoutubeQuota() counts this
 * workspace's successful YouTube publishes since Dhaka midnight and is
 * surfaced by GET /api/youtube/status.
 *
 * Uploads use the resumable protocol (init → PUT bytes in 8 MB chunks):
 * a video file can be far bigger than the 25 MB web-upload limit, and a
 * dropped chunk resumes instead of restarting. The publisher downloads
 * the scheduled video (Vercel Blob URL or local /api/uploads file) into
 * memory first — on Vercel that bounds practical videos to a few hundred
 * MB; a download failure fails honestly.
 *
 * Comments: commentThreads.list (readonly scope is enough) + replies via
 * comments.insert (needs youtube.force-ssl — granted at the same
 * re-consent as the upload scope).
 */

export const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.force-ssl',
] as const;

export const YOUTUBE_UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
export const YOUTUBE_QUOTA_DAILY_UNITS = 10000;
export const YOUTUBE_UPLOAD_COST_UNITS = 1600;
export const YOUTUBE_MAX_UPLOADS_PER_DAY = Math.floor(YOUTUBE_QUOTA_DAILY_UNITS / YOUTUBE_UPLOAD_COST_UNITS); // 6

export interface YoutubeChannelRow {
  id: string;
  external_id: string;
  display_name: string | null;
  token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  token_expires_at: string | null;
  scopes: string | null;
  picture_url: string | null;
}

export async function getYoutubeChannel(workspaceId: string): Promise<YoutubeChannelRow | null> {
  return queryOne<YoutubeChannelRow>(
    workspaceId,
    `SELECT id, external_id, display_name, token_encrypted, refresh_token_encrypted,
            token_expires_at, scopes, picture_url
     FROM channels
     WHERE workspace_id = $1 AND platform = 'youtube' AND status = 'connected'
     ORDER BY created_at DESC LIMIT 1`,
    [workspaceId],
  );
}

/** True when the stored granted scopes include youtube.upload. NULL scopes (pre-migration-34 rows) = read-only. */
export function hasUploadScope(channel: YoutubeChannelRow | null): boolean {
  if (!channel?.scopes) return false;
  return channel.scopes.split(/[\s,]+/).includes(YOUTUBE_UPLOAD_SCOPE);
}

function decrypt(channel: YoutubeChannelRow, field: 'token_encrypted' | 'refresh_token_encrypted'): string | null {
  const value = channel[field];
  if (!value) return null;
  try {
    return decryptToken(value);
  } catch {
    return null;
  }
}

interface GoogleRefreshResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

/** Refresh the access token with the stored refresh token; saves the new token + expiry. Null on any failure. */
export async function refreshYoutubeAccessToken(
  workspaceId: string,
  channel: YoutubeChannelRow,
): Promise<string | null> {
  const refreshToken = decrypt(channel, 'refresh_token_encrypted');
  if (!refreshToken) return null;
  try {
    const res = await fetchWithTimeout(config.google.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.google.clientId,
        client_secret: config.google.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });
    const data = (await res.json().catch(() => null)) as GoogleRefreshResponse | null;
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

export type YoutubeTokenResult =
  | { ok: true; accessToken: string; channel: YoutubeChannelRow }
  | { ok: false; error: string; reason: 'not_connected' | 'no_token' | 'refresh_failed' | 'no_upload_scope' };

/**
 * A usable YouTube access token for the workspace: the stored one when it
 * is still valid, otherwise a refresh. When `needUpload` is true the
 * channel must also carry the youtube.upload scope (else no_upload_scope
 * + a Bengali reconnect message — a read-only token cannot upload).
 */
export async function getYoutubeAccessToken(
  workspaceId: string,
  needUpload = false,
): Promise<YoutubeTokenResult> {
  const channel = await getYoutubeChannel(workspaceId);
  if (!channel) {
    return {
      ok: false,
      reason: 'not_connected',
      error: 'YouTube চ্যানেল যুক্ত নেই — Channels পেজ থেকে YouTube যুক্ত করুন (no YouTube channel connected)',
    };
  }
  if (needUpload && !hasUploadScope(channel)) {
    return {
      ok: false,
      reason: 'no_upload_scope',
      error:
        'এই YouTube চ্যানেলটি শুধু পড়ার অনুমতি (read-only) নিয়ে যুক্ত হয়েছে — ভিডিও আপলোড করতে Channels পেজ থেকে YouTube আবার যুক্ত (reconnect) করুন, যাতে upload অনুমতি আসে (channel was connected with read-only scopes — reconnect YouTube to grant the upload scope)',
    };
  }
  const stored = decrypt(channel, 'token_encrypted');
  const expiresAt = channel.token_expires_at ? new Date(channel.token_expires_at).getTime() : 0;
  if (stored && expiresAt > Date.now() + 60 * 1000) {
    return { ok: true, accessToken: stored, channel };
  }
  // Expired (or no expiry recorded) — refresh. If the stored token is
  // still within its hour and no expiry was recorded, the refresh below
  // still runs only when the stored token is missing; prefer the stored
  // token then and let a 401 from YouTube surface honestly.
  if (stored && !channel.token_expires_at) {
    return { ok: true, accessToken: stored, channel };
  }
  const fresh = await refreshYoutubeAccessToken(workspaceId, channel);
  if (!fresh) {
    return {
      ok: false,
      reason: 'refresh_failed',
      error:
        'YouTube টোকেন নবায়ন করা যায়নি — Channels পেজ থেকে YouTube আবার যুক্ত করুন (YouTube token refresh failed — reconnect YouTube)',
    };
  }
  return { ok: true, accessToken: fresh, channel };
}

function apiUrl(path: string): string {
  return `${config.google.apiBaseUrl.replace(/\/$/, '')}${path}`;
}

interface GoogleApiError {
  error?: { code?: number; message?: string; errors?: { reason?: string }[] };
}

/** Pull the human reason out of a Google API error body (quotaExceeded etc.). */
export function googleErrorReason(status: number, body: GoogleApiError | null): string {
  const reason = body?.error?.errors?.[0]?.reason ?? '';
  const message = body?.error?.message ?? '';
  if (reason === 'quotaExceeded' || /quota/i.test(message)) return 'quotaExceeded';
  if (status === 401 || status === 403) return reason || 'forbidden';
  return message || `Google API error ${status}`;
}

async function youtubeGet<T>(accessToken: string, path: string, params: Record<string, string>): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string; reason: string }> {
  const url = new URL(apiUrl(path));
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  try {
    const res = await fetchWithTimeout(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = (await res.json().catch(() => null)) as T & GoogleApiError;
    if (!res.ok) {
      const reason = googleErrorReason(res.status, data as GoogleApiError);
      return { ok: false, status: res.status, error: (data as GoogleApiError)?.error?.message ?? `YouTube API error ${res.status}`, reason };
    }
    return { ok: true, data: data as T };
  } catch (err) {
    return { ok: false, status: 0, error: (err as Error).message, reason: 'network' };
  }
}

export interface YoutubeVideo {
  id: string;
  title: string;
  description: string;
  publishedAt: string | null;
  thumbnail: string | null;
}

/** Live list of the channel's own videos (uploads playlist — 1 quota unit per page). */
export async function fetchYoutubeVideos(
  accessToken: string,
): Promise<{ ok: true; videos: YoutubeVideo[] } | { ok: false; error: string; reason: string }> {
  const ch = await youtubeGet<{ items?: { contentDetails?: { relatedPlaylists?: { uploads?: string } } }[] }>(
    accessToken,
    '/youtube/v3/channels',
    { part: 'contentDetails', mine: 'true' },
  );
  if (!ch.ok) return { ok: false, error: ch.error, reason: ch.reason };
  const uploads = ch.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) return { ok: false, error: 'uploads playlist not found for this channel', reason: 'not_found' };
  const pl = await youtubeGet<{
    items?: { snippet?: { resourceId?: { videoId?: string }; title?: string; description?: string; publishedAt?: string; thumbnails?: { default?: { url?: string }; medium?: { url?: string } } } }[];
  }>(accessToken, '/youtube/v3/playlistItems', {
    part: 'snippet',
    playlistId: uploads,
    maxResults: '25',
  });
  if (!pl.ok) return { ok: false, error: pl.error, reason: pl.reason };
  const videos: YoutubeVideo[] = (pl.data.items ?? []).map((item) => ({
    id: item.snippet?.resourceId?.videoId ?? '',
    title: item.snippet?.title ?? '',
    description: item.snippet?.description ?? '',
    publishedAt: item.snippet?.publishedAt ?? null,
    thumbnail: item.snippet?.thumbnails?.medium?.url ?? item.snippet?.thumbnails?.default?.url ?? null,
  })).filter((v) => v.id);
  return { ok: true, videos };
}

export interface YoutubeComment {
  commentId: string;
  videoId: string;
  videoTitle: string | null;
  author: string;
  authorAvatar: string | null;
  text: string;
  publishedAt: string | null;
  likeCount: number;
  replyCount: number;
  replies: { commentId: string; author: string; text: string; publishedAt: string | null }[];
}

/**
 * Live comments on the channel's videos (commentThreads.list). With a
 * videoId: that video's threads; without: all threads on the channel.
 * Read-only scope is enough. Returns top-level comments with their
 * replies inlined (part=snippet,replies).
 */
export async function fetchYoutubeComments(
  accessToken: string,
  opts: { videoId?: string; channelId?: string },
): Promise<{ ok: true; comments: YoutubeComment[] } | { ok: false; error: string; reason: string }> {
  const params: Record<string, string> = { part: 'snippet,replies', maxResults: '25', order: 'time' };
  if (opts.videoId) params.videoId = opts.videoId;
  else if (opts.channelId) params.allThreadsRelatedToChannelId = opts.channelId;
  else return { ok: false, error: 'videoId or channelId is required', reason: 'bad_request' };
  const res = await youtubeGet<{
    items?: {
      id?: string;
      snippet?: {
        videoId?: string;
        topLevelComment?: {
          id?: string;
          snippet?: {
            authorDisplayName?: string;
            authorProfileImageUrl?: string;
            textDisplay?: string;
            publishedAt?: string;
            likeCount?: number;
          };
        };
        totalReplyCount?: number;
      };
      replies?: {
        comments?: {
          id?: string;
          snippet?: { authorDisplayName?: string; textDisplay?: string; publishedAt?: string };
        }[];
      };
    }[];
  }>(accessToken, '/youtube/v3/commentThreads', params);
  if (!res.ok) return { ok: false, error: res.error, reason: res.reason };
  const comments: YoutubeComment[] = (res.data.items ?? []).map((item) => {
    const top = item.snippet?.topLevelComment?.snippet;
    return {
      commentId: item.snippet?.topLevelComment?.id ?? item.id ?? '',
      videoId: item.snippet?.videoId ?? opts.videoId ?? '',
      videoTitle: null,
      author: top?.authorDisplayName ?? 'YouTube user',
      authorAvatar: top?.authorProfileImageUrl ?? null,
      text: top?.textDisplay ?? '',
      publishedAt: top?.publishedAt ?? null,
      likeCount: Number(top?.likeCount ?? 0),
      replyCount: Number(item.snippet?.totalReplyCount ?? 0),
      replies: (item.replies?.comments ?? []).map((r) => ({
        commentId: r.id ?? '',
        author: r.snippet?.authorDisplayName ?? 'YouTube user',
        text: r.snippet?.textDisplay ?? '',
        publishedAt: r.snippet?.publishedAt ?? null,
      })),
    };
  }).filter((c) => c.commentId && c.text);
  return { ok: true, comments };
}

/** Reply to a YouTube comment (comments.insert — needs youtube.force-ssl). Returns the real reply id. */
export async function replyYoutubeComment(
  accessToken: string,
  parentCommentId: string,
  text: string,
): Promise<{ ok: true; replyId: string } | { ok: false; error: string; reason: string }> {
  try {
    const res = await fetchWithTimeout(`${apiUrl('/youtube/v3/comments')}?part=snippet`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ snippet: { parentId: parentCommentId, textOriginal: text } }),
    });
    const data = (await res.json().catch(() => null)) as { id?: string } & GoogleApiError;
    if (!res.ok || typeof data?.id !== 'string') {
      const reason = googleErrorReason(res.status, data);
      return { ok: false, error: data?.error?.message ?? `YouTube reply failed (${res.status})`, reason };
    }
    return { ok: true, replyId: data.id };
  } catch (err) {
    return { ok: false, error: (err as Error).message, reason: 'network' };
  }
}

export interface YoutubeUploadInput {
  accessToken: string;
  /** Raw video bytes (downloaded by the caller from the Blob/local URL). */
  video: Buffer;
  mimeType: string;
  title: string;
  description: string;
  /** Future ISO time → private + publishAt (YouTube releases it then). Null → public now. */
  publishAt: string | null;
}

export type YoutubeUploadResult =
  | { ok: true; videoId: string }
  | { ok: false; error: string; reason: string; quotaExceeded: boolean };

const UPLOAD_CHUNK = 8 * 1024 * 1024; // 8 MB chunks

/**
 * Upload a video with the resumable protocol. Returns ONLY a real
 * YouTube video id on success; every failure (incl. quota) returns
 * ok:false with Google's own message — never a stub id.
 */
export async function uploadYoutubeVideo(input: YoutubeUploadInput): Promise<YoutubeUploadResult> {
  const metadata = {
    snippet: {
      title: input.title.slice(0, 100) || 'Untitled video',
      description: input.description ?? '',
      categoryId: '22', // People & Blogs (neutral default; no product claim)
    },
    status: {
      privacyStatus: input.publishAt ? 'private' : 'public',
      ...(input.publishAt ? { publishAt: input.publishAt } : {}),
      selfDeclaredMadeForKids: false,
    },
  };
  let sessionUrl: string;
  try {
    const init = await fetchWithTimeout(
      `${config.google.uploadBaseUrl.replace(/\/$/, '')}/youtube/v3/videos?uploadType=resumable&part=snippet,status`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Length': String(input.video.length),
          'X-Upload-Content-Type': input.mimeType || 'video/mp4',
        },
        body: JSON.stringify(metadata),
      },
    );
    const location = init.headers.get('location');
    if (!init.ok || !location) {
      const body = (await init.json().catch(() => null)) as GoogleApiError | null;
      const reason = googleErrorReason(init.status, body);
      return {
        ok: false,
        error: body?.error?.message ?? `YouTube upload init failed (${init.status})`,
        reason,
        quotaExceeded: reason === 'quotaExceeded',
      };
    }
    sessionUrl = location;
  } catch (err) {
    return { ok: false, error: (err as Error).message, reason: 'network', quotaExceeded: false };
  }

  // PUT the bytes in chunks. A 308 Resume Incomplete carries the Range
  // YouTube already has; the final chunk returns 200 + the video id.
  let offset = 0;
  const total = input.video.length;
  try {
    while (offset < total) {
      const end = Math.min(offset + UPLOAD_CHUNK, total);
      const chunk = input.video.subarray(offset, end);
      const res = await fetchWithTimeout(sessionUrl, {
        method: 'PUT',
        headers: {
          'Content-Length': String(chunk.length),
          'Content-Range': `bytes ${offset}-${end - 1}/${total}`,
        },
        body: chunk,
      });
      if (res.status === 308) {
        const range = res.headers.get('range'); // e.g. "bytes=0-8388607"
        const match = range ? /bytes=0-(\d+)/.exec(range) : null;
        offset = match ? Number(match[1]) + 1 : end;
        continue;
      }
      const data = (await res.json().catch(() => null)) as { id?: string } & GoogleApiError;
      if (!res.ok || typeof data?.id !== 'string') {
        const reason = googleErrorReason(res.status, data);
        return {
          ok: false,
          error: data?.error?.message ?? `YouTube upload failed (${res.status})`,
          reason,
          quotaExceeded: reason === 'quotaExceeded',
        };
      }
      return { ok: true, videoId: data.id };
    }
    return { ok: false, error: 'YouTube upload ended without a video id', reason: 'no_video_id', quotaExceeded: false };
  } catch (err) {
    return { ok: false, error: (err as Error).message, reason: 'network', quotaExceeded: false };
  }
}

/** Today's YouTube upload quota use for one workspace (Dhaka day, from real publish logs). */
export async function getYoutubeQuota(workspaceId: string): Promise<{
  dailyLimitUnits: number;
  uploadCostUnits: number;
  uploadsToday: number;
  unitsUsed: number;
  unitsRemaining: number;
  maxUploadsPerDay: number;
}> {
  const { rows } = await query<{ n: string }>(
    workspaceId,
    `SELECT count(*) AS n FROM post_publish_logs
     WHERE workspace_id = $1 AND platform = 'youtube' AND status = 'published'
       AND created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Dhaka') AT TIME ZONE 'Asia/Dhaka')`,
    [workspaceId],
  );
  const uploadsToday = Number(rows[0]?.n ?? 0);
  const unitsUsed = uploadsToday * YOUTUBE_UPLOAD_COST_UNITS;
  return {
    dailyLimitUnits: YOUTUBE_QUOTA_DAILY_UNITS,
    uploadCostUnits: YOUTUBE_UPLOAD_COST_UNITS,
    uploadsToday,
    unitsUsed,
    unitsRemaining: Math.max(0, YOUTUBE_QUOTA_DAILY_UNITS - unitsUsed),
    maxUploadsPerDay: YOUTUBE_MAX_UPLOADS_PER_DAY,
  };
}
