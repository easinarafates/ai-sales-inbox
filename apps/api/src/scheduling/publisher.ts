import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { pool, query, queryOne } from '../db/pool';
import { fetchWithTimeout } from '../ai-agent/http';
import {
  decryptPageToken,
  getWorkspacePageChannel,
  sendPagePost,
} from '../channels/meta-send';
import {
  getYoutubeAccessToken,
  getYoutubeQuota,
  uploadYoutubeVideo,
  YOUTUBE_MAX_UPLOADS_PER_DAY,
} from '../channels/youtube';
import {
  fetchTikTokPublishStatus,
  getTikTokAccessToken,
  initTikTokVideoPublish,
  uploadTikTokChunk,
} from '../channels/tiktok';

/**
 * Scheduled-post publisher (Module B, Phase 2).
 *
 * REAL publishing to Facebook (2026-11-07): the Facebook leg sends for
 * real via sendPagePost (Graph v21.0, the workspace's stored Page token)
 * — POST /{page-id}/feed for text, /photos for images, /videos for
 * video. A post counts as published ONLY when Graph returns a real post
 * id, stored as platform_post_id (never a stub id). A Graph failure is
 * logged in post_publish_logs with Meta's own message and the post ends
 * 'failed' after 3 attempts — the Schedule page shows that reason.
 * Publishing needs pages_manage_posts on the Page token: tokens granted
 * before that scope was added (login scopes, facebook-oauth.ts) do NOT
 * carry it, so the Page must be reconnected once (Login with Facebook).
 *
 * TikTok gate (PDF section 6): the TikTok Content Posting API shows posts
 * as private until the app passes audit. Until then
 * TIKTOK_SCHEDULING_AUDITED must be 'true', otherwise TikTok posts are
 * recorded as failed ('TikTok audit pending') and skipped — never published.
 * When audited, the TikTok leg uploads for real (Content Posting API:
 * creator_info/query → video/init FILE_UPLOAD → chunk PUTs → status/fetch
 * until PUBLISH_COMPLETE); only PUBLISH_COMPLETE counts as published, and
 * the publish_id is stored in scheduled_posts.publish_ref so a later
 * sweep resumes polling the SAME publish instead of uploading twice.
 * Instagram / Messenger / WhatsApp are not post platforms for this app:
 * Instagram publishing (media containers) is not built yet and Messenger /
 * WhatsApp are messaging channels — they are logged as failed with a
 * plain reason instead of pretending to publish.
 *
 * YouTube leg: resumable upload via the YouTube Data API v3
 * (videos.insert, part=snippet,status). A post counts as published ONLY
 * when YouTube returns a real video id. publishAt: when the scheduled
 * time is still in the future the video goes up private + publishAt and
 * YouTube releases it then; a due post uploads public. Quota is checked
 * first (6 uploads/day/workspace on the conservative 1,600-unit math —
 * see channels/youtube.ts); a 403 quotaExceeded fails honestly.
 */

export interface ScheduledPostRow {
  id: string;
  caption: string | null;
  media_urls: string[] | null;
  /** 'image' | 'video' | 'text' — migration 09 (Worker C). */
  media_type: string | null;
  platforms: string[];
  scheduled_at: string | null;
  status: string;
  platform_post_id: string | null;
  /** In-flight platform publish id (TikTok publish_id, migration 34) — response-only, not set by the UI. */
  publish_ref: string | null;
  created_at: string;
  updated_at: string;
  /** Latest failed publish reason (from post_publish_logs) — response-only, not a DB column. */
  lastError?: string | null;
}

const POST_COLUMNS =
  'id, caption, media_urls, media_type, platforms, scheduled_at, status, platform_post_id, publish_ref, created_at, updated_at';

const MAX_ATTEMPTS = 3;
const TIKTOK_CHUNK = 8 * 1024 * 1024; // 8 MB chunks for the TikTok FILE_UPLOAD PUTs

/** Download the post's video bytes (Blob URL or local /api/uploads file). Videos can exceed the 25 MB web-upload limit — the file is downloaded in full, so on Vercel very large videos (hundreds of MB) can fail with an honest error. */
async function fetchVideoBytes(
  post: ScheduledPostRow,
): Promise<{ ok: true; bytes: Buffer; mimeType: string } | { ok: false; error: string }> {
  const url = post.media_urls?.[0];
  if (!url) return { ok: false, error: 'ভিডিও পোস্টে ভিডিও লাগবে — মিডিয়া ছাড়া প্রকাশ করা যায় না' };
  const lower = url.split('?')[0].toLowerCase();
  const mimeType = lower.endsWith('.webm')
    ? 'video/webm'
    : lower.endsWith('.mov')
      ? 'video/quicktime'
      : 'video/mp4';
  try {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      const res = await fetchWithTimeout(url, { method: 'GET' }, 120000);
      if (!res.ok) return { ok: false, error: `ভিডিও ফাইল ডাউনলোড করা যায়নি (${res.status}) — মিডিয়া লিংকটি যাচাই করুন` };
      return { ok: true, bytes: Buffer.from(await res.arrayBuffer()), mimeType };
    }
    if (url.startsWith('/api/uploads/')) {
      const file = path.basename(url.split('?')[0]);
      if (!file || file.includes('..')) return { ok: false, error: 'ভিডিও ফাইলের নাম সঠিক নয়' };
      const full = path.join(path.resolve(process.cwd(), 'uploads'), file);
      if (!fs.existsSync(full)) return { ok: false, error: 'ভিডিও ফাইলটি সার্ভারে পাওয়া যায়নি — আবার আপলোড করুন' };
      return { ok: true, bytes: fs.readFileSync(full), mimeType };
    }
    return { ok: false, error: 'ভিডিও লিংকটি http(s) বা /api/uploads হতে হবে' };
  } catch (err) {
    return { ok: false, error: `ভিডিও ফাইল ডাউনলোড করা যায়নি: ${(err as Error).message}` };
  }
}

async function setPublishRef(workspaceId: string, postId: string, publishRef: string): Promise<void> {
  await query(
    workspaceId,
    'UPDATE scheduled_posts SET publish_ref = $1, updated_at = now() WHERE workspace_id = $2 AND id = $3',
    [publishRef, workspaceId, postId],
  );
}

async function logAttempt(
  workspaceId: string,
  scheduledPostId: string,
  platform: string,
  attempt: number,
  status: string,
  error: string | null,
): Promise<void> {
  await query(
    workspaceId,
    `INSERT INTO post_publish_logs (workspace_id, scheduled_post_id, platform, attempt, status, error)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [workspaceId, scheduledPostId, platform, attempt, status, error],
  );
}

async function setStatus(
  workspaceId: string,
  postId: string,
  status: string,
  platformPostId?: string | null,
): Promise<ScheduledPostRow | null> {
  return queryOne<ScheduledPostRow>(
    workspaceId,
    `UPDATE scheduled_posts SET status = $1, platform_post_id = COALESCE($2, platform_post_id), updated_at = now()
     WHERE workspace_id = $3 AND id = $4 RETURNING ${POST_COLUMNS}`,
    [status, platformPostId ?? null, workspaceId, postId],
  );
}

/**
 * Publish one scheduled post now. Per platform:
 * - facebook -> REAL Graph publish via sendPagePost (needs the workspace's
 *   connected Page + pages_manage_posts on its token). Only a Graph
 *   post id counts as published.
 * - youtube -> REAL resumable upload via the YouTube Data API
 *   (videos.insert). Only a real YouTube video id counts as published;
 *   quota exhaustion / missing upload scope fail honestly.
 * - tiktok -> REAL Content Posting API upload when audited (init +
 *   chunk PUTs + status poll until PUBLISH_COMPLETE). Without a passed
 *   audit -> failure logged, platform skipped. A still-processing
 *   publish goes back to 'scheduled' with its publish_id kept (never
 *   'failed', never a second upload).
 * - instagram / messenger / whatsapp / anything else -> failure logged
 *   with a plain reason (not built / not a post platform); never faked.
 * Retries a failed publish up to 3 attempts total, then status 'failed'.
 * Returns the updated post row.
 */
export async function publishScheduledPost(
  workspaceId: string,
  postId: string,
): Promise<ScheduledPostRow> {
  const post = await queryOne<ScheduledPostRow>(
    workspaceId,
    `SELECT ${POST_COLUMNS} FROM scheduled_posts WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, postId],
  );
  if (!post) throw new Error('Scheduled post not found');
  if (post.status === 'published') return post;
  if (post.status === 'cancelled') throw new Error('বাতিল করা পোস্ট প্রকাশ করা যায় না');
  // Video posts need a playable video attached — the returned row keeps
  // media_type 'video' + media_urls, so the UI can play the video from
  // its servable URL as well.
  if (post.media_type === 'video' && (!post.media_urls || post.media_urls.length === 0)) {
    throw new Error('ভিডিও পোস্টে ভিডিও লাগবে — মিডিয়া ছাড়া প্রকাশ করা যায় না');
  }

  const platforms = post.platforms ?? [];
  if (platforms.length === 0) {
    await logAttempt(workspaceId, postId, 'none', 1, 'failed', 'কোনো প্ল্যাটফর্ম বেছে নেওয়া হয়নি');
    const failed = await setStatus(workspaceId, postId, 'failed');
    return failed ?? post;
  }

  await setStatus(workspaceId, postId, 'publishing');

  let platformPostId: string | null = post.platform_post_id;
  let publishedAny = false;
  // TikTok publish is async: a publish still PROCESSING after polling is
  // NOT a failure — the post goes back to 'scheduled' with its publish_id
  // kept, so the next sweep resumes polling the same publish.
  let processingAny = false;
  let tiktokPublishId: string | null = post.publish_ref;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let attemptFailed = false;

    for (const platform of platforms) {
      // YouTube — real resumable upload (videos.insert). Only a real
      // YouTube video id counts as published.
      if (platform === 'youtube') {
        if (post.media_type !== 'video') {
          if (attempt === 1) {
            await logAttempt(
              workspaceId,
              postId,
              platform,
              attempt,
              'failed',
              'YouTube-এ শুধু ভিডিও পোস্ট করা যায় — এই পোস্টে ভিডিও নেই (YouTube needs a video)',
            );
          }
          attemptFailed = true;
          continue;
        }
        const quota = await getYoutubeQuota(workspaceId);
        if (quota.uploadsToday >= YOUTUBE_MAX_UPLOADS_PER_DAY) {
          if (attempt === 1) {
            await logAttempt(
              workspaceId,
              postId,
              platform,
              attempt,
              'failed',
              `YouTube কোটা শেষ — আজ ইতিমধ্যে ${quota.uploadsToday}টি ভিডিও আপলোড হয়েছে (দৈনিক সর্বোচ্চ ${YOUTUBE_MAX_UPLOADS_PER_DAY}টি, ১০,০০০ ইউনিট)। আগামীকাল আবার চেষ্টা করা হবে (YouTube daily upload quota exhausted)`,
            );
          }
          attemptFailed = true;
          continue;
        }
        const token = await getYoutubeAccessToken(workspaceId, true);
        if (!token.ok) {
          if (attempt === 1) {
            await logAttempt(workspaceId, postId, platform, attempt, 'failed', token.error);
          }
          attemptFailed = true;
          continue;
        }
        const video = await fetchVideoBytes(post);
        if (!video.ok) {
          if (attempt === 1) {
            await logAttempt(workspaceId, postId, platform, attempt, 'failed', video.error);
          }
          attemptFailed = true;
          continue;
        }
        // Still in the future → private + publishAt (YouTube releases
        // it then); a due post uploads public now.
        const publishAt =
          post.scheduled_at && new Date(post.scheduled_at).getTime() > Date.now() + 60 * 1000
            ? new Date(post.scheduled_at).toISOString()
            : null;
        const title = (post.caption ?? '').split('\n')[0].trim().slice(0, 100) || 'Untitled video';
        const result = await uploadYoutubeVideo({
          accessToken: token.accessToken,
          video: video.bytes,
          mimeType: video.mimeType,
          title,
          description: post.caption ?? '',
          publishAt,
        });
        if (result.ok) {
          console.log(
            `[publisher] post ${postId} -> youtube (attempt ${attempt}): published as ${result.videoId}`,
          );
          await logAttempt(workspaceId, postId, platform, attempt, 'published', null);
          platformPostId = result.videoId;
          publishedAny = true;
        } else {
          attemptFailed = true;
          await logAttempt(
            workspaceId,
            postId,
            platform,
            attempt,
            'failed',
            result.quotaExceeded
              ? `YouTube কোটা শেষ — ${result.error} (আগামীকাল আবার চেষ্টা করা হবে)`
              : result.error,
          );
        }
        continue;
      }

      // TikTok — real Content Posting API upload (async). Audit gate
      // first: never publish before the audit passes.
      if (platform === 'tiktok') {
        if (!config.tiktokSchedulingAudited) {
          if (attempt === 1) {
            await logAttempt(
              workspaceId,
              postId,
              platform,
              attempt,
              'failed',
              'TikTok audit pending — TikTok Content Posting API অডিট না হওয়া পর্যন্ত পোস্ট শুধু প্রাইভেট দেখাবে',
            );
          }
          attemptFailed = true;
          continue;
        }
        if (post.media_type !== 'video') {
          if (attempt === 1) {
            await logAttempt(
              workspaceId,
              postId,
              platform,
              attempt,
              'failed',
              'TikTok-এ শুধু ভিডিও পোস্ট করা যায় — এই পোস্টে ভিডিও নেই (TikTok needs a video)',
            );
          }
          attemptFailed = true;
          continue;
        }
        const token = await getTikTokAccessToken(workspaceId);
        if (!token.ok) {
          if (attempt === 1) {
            await logAttempt(workspaceId, postId, platform, attempt, 'failed', token.error);
          }
          attemptFailed = true;
          continue;
        }
        // Fresh publish: init + chunk upload. A resumed publish
        // (publish_ref already stored) skips straight to polling.
        if (!tiktokPublishId) {
          const video = await fetchVideoBytes(post);
          if (!video.ok) {
            if (attempt === 1) {
              await logAttempt(workspaceId, postId, platform, attempt, 'failed', video.error);
            }
            attemptFailed = true;
            continue;
          }
          const chunkSize = TIKTOK_CHUNK;
          const totalChunks = Math.max(1, Math.ceil(video.bytes.length / chunkSize));
          const init = await initTikTokVideoPublish(token.accessToken, {
            title: post.caption ?? '',
            videoSize: video.bytes.length,
            chunkSize,
            totalChunkCount: totalChunks,
            privacyLevel: 'PUBLIC_TO_EVERYONE',
          });
          if (!init.ok) {
            attemptFailed = true;
            await logAttempt(workspaceId, postId, platform, attempt, 'failed', init.error);
            continue;
          }
          tiktokPublishId = init.data.publishId;
          await setPublishRef(workspaceId, postId, tiktokPublishId);
          if (!init.data.uploadUrl) {
            attemptFailed = true;
            await logAttempt(
              workspaceId,
              postId,
              platform,
              attempt,
              'failed',
              'TikTok আপলোড URL দেয়নি — আবার চেষ্টা করা হবে (TikTok returned no upload URL)',
            );
            continue;
          }
          let uploadFailed: string | null = null;
          for (let i = 0; i < totalChunks; i++) {
            const start = i * chunkSize;
            const chunk = video.bytes.subarray(start, Math.min(start + chunkSize, video.bytes.length));
            const up = await uploadTikTokChunk(init.data.uploadUrl, chunk, start, video.bytes.length);
            if (!up.ok) {
              uploadFailed = up.error;
              break;
            }
          }
          if (uploadFailed) {
            attemptFailed = true;
            await logAttempt(workspaceId, postId, platform, attempt, 'failed', uploadFailed);
            continue;
          }
        }
        // Poll the SAME publish_id until PUBLISH_COMPLETE / FAILED
        // (up to ~30s here; a still-processing publish resumes on the
        // next sweep via publish_ref — never a second upload).
        let finalStatus: string | null = null;
        let failReason: string | null = null;
        let publicVideoId: string | null = null;
        for (let poll = 0; poll < 10; poll++) {
          const st = await fetchTikTokPublishStatus(token.accessToken, tiktokPublishId);
          if (!st.ok) {
            failReason = st.error;
            break;
          }
          if (st.data.status === 'PUBLISH_COMPLETE') {
            finalStatus = 'PUBLISH_COMPLETE';
            publicVideoId = st.data.publicVideoId;
            break;
          }
          if (st.data.status === 'FAILED') {
            finalStatus = 'FAILED';
            failReason = st.data.failReason;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
        if (finalStatus === 'PUBLISH_COMPLETE') {
          console.log(
            `[publisher] post ${postId} -> tiktok (attempt ${attempt}): published as ${publicVideoId ?? tiktokPublishId}`,
          );
          await logAttempt(workspaceId, postId, platform, attempt, 'published', null);
          platformPostId = publicVideoId ?? tiktokPublishId;
          publishedAny = true;
        } else if (finalStatus === 'FAILED') {
          attemptFailed = true;
          await logAttempt(
            workspaceId,
            postId,
            platform,
            attempt,
            'failed',
            `TikTok প্রকাশ ব্যর্থ: ${failReason ?? 'অজানা কারণ'} (TikTok publish failed)`,
          );
        } else if (failReason) {
          attemptFailed = true;
          await logAttempt(workspaceId, postId, platform, attempt, 'failed', failReason);
        } else {
          processingAny = true;
          await logAttempt(
            workspaceId,
            postId,
            platform,
            attempt,
            'processing',
            'TikTok এখনো ভিডিওটি প্রসেস করছে — পরের সুইপে আবার যাচাই করা হবে (TikTok still processing — will re-check on the next sweep)',
          );
        }
        continue;
      }

      // Facebook — the real publish. Logged once for setup failures
      // (no Page / bad token), every attempt for real Graph failures.
      if (platform === 'facebook') {
        const channel = await getWorkspacePageChannel(workspaceId);
        if (!channel) {
          if (attempt === 1) {
            await logAttempt(
              workspaceId,
              postId,
              platform,
              attempt,
              'failed',
              'কোনো Facebook Page যুক্ত নেই — Channels পেজ থেকে Login with Facebook দিয়ে পেজ যুক্ত করুন (no Facebook Page connected)',
            );
          }
          attemptFailed = true;
          continue;
        }
        const pageToken = decryptPageToken(channel);
        if (!pageToken) {
          if (attempt === 1) {
            await logAttempt(
              workspaceId,
              postId,
              platform,
              attempt,
              'failed',
              'পেজের টোকেন পড়া যায়নি — পেজটি আবার যুক্ত করুন (stored Page token could not be read — reconnect the Page)',
            );
          }
          attemptFailed = true;
          continue;
        }
        const result = await sendPagePost({
          pageId: channel.external_id,
          pageToken,
          caption: post.caption,
          mediaUrls: post.media_urls ?? [],
          mediaType: post.media_type,
        });
        if (result.ok && result.platformPostId) {
          console.log(
            `[publisher] post ${postId} -> facebook (attempt ${attempt}): published as ${result.platformPostId}`,
          );
          await logAttempt(workspaceId, postId, platform, attempt, 'published', null);
          platformPostId = result.platformPostId;
          publishedAny = true;
        } else {
          attemptFailed = true;
          await logAttempt(
            workspaceId,
            postId,
            platform,
            attempt,
            'failed',
            result.error ?? 'Facebook publishing failed',
          );
        }
        continue;
      }

      // Anything else is not published by this app — say so plainly.
      if (attempt === 1) {
        const reason =
          platform === 'instagram'
            ? 'Instagram-এ পোস্ট প্রকাশ এখনো যুক্ত হয়নি — আপাতত Instagram অ্যাপ থেকে পোস্ট করুন (Instagram publishing is not connected yet)'
            : platform === 'messenger' || platform === 'whatsapp'
              ? `${platform} মেসেজের চ্যানেল, পোস্টের প্ল্যাটফর্ম নয় (not a post platform)`
              : `এই প্ল্যাটফর্মে প্রকাশ এখনো যুক্ত হয়নি (publishing not supported for ${platform})`;
        await logAttempt(workspaceId, postId, platform, attempt, 'failed', reason);
      }
      attemptFailed = true;
    }

    // Published on at least one platform (a gated TikTok alongside a live
    // Facebook post does not fail the whole post; the other platform's
    // failure stays visible in post_publish_logs).
    if (publishedAny) {
      const done = await setStatus(workspaceId, postId, 'published', platformPostId);
      return done ?? post;
    }
    if (!attemptFailed) break; // nothing failed and nothing published — nothing left to retry
    if (attempt === MAX_ATTEMPTS) break;
    // Small pause before the next attempt (only reached for real-send errors).
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // TikTok still processing (and nothing else published): back to
  // 'scheduled' with publish_ref kept, so the next sweep (GitHub cron
  // or the Schedule page's lazy sweep) resumes polling the same
  // publish — it must NOT end 'failed', or the next run would start a
  // second upload of the same video.
  if (processingAny && !publishedAny) {
    const waiting = await setStatus(workspaceId, postId, 'scheduled', platformPostId);
    return waiting ?? post;
  }

  const failed = await setStatus(workspaceId, postId, 'failed', platformPostId);
  return failed ?? post;
}

/**
 * Pick up every due scheduled post (status 'scheduled', scheduled_at <= now)
 * in ONE workspace and publish it. Used by the lazy sweep on the Schedule
 * page load (see scheduling/routes.ts) — Vercel has no always-on worker,
 * so this is the belt-and-braces next to the GitHub Actions cron sweep.
 * Never throws for one bad post — it is logged and the sweep continues.
 */
export async function processDueScheduledPostsForWorkspace(workspaceId: string): Promise<{
  processed: number;
  published: number;
  failed: number;
}> {
  const { rows: due } = await query<{ id: string }>(
    workspaceId,
    `SELECT id FROM scheduled_posts
     WHERE workspace_id = $1 AND status = 'scheduled' AND scheduled_at <= now()
     ORDER BY scheduled_at ASC`,
    [workspaceId],
  );
  let processed = 0;
  let published = 0;
  let failed = 0;
  for (const { id } of due) {
    processed++;
    try {
      const post = await publishScheduledPost(workspaceId, id);
      if (post.status === 'published') published++;
      else failed++;
    } catch (err) {
      failed++;
      console.error(`[publisher] post ${id} failed:`, (err as Error).message);
    }
  }
  return { processed, published, failed };
}

/**
 * Pick up every due scheduled post (status 'scheduled', scheduled_at <= now)
 * across all workspaces and publish it. Used by the scheduled-posts worker
 * and as a polling fallback when Redis is down. Never throws for one bad
 * post — it is logged and the sweep continues.
 */
export async function processDueScheduledPosts(): Promise<{
  processed: number;
  published: number;
  failed: number;
}> {
  const { rows: workspaces } = await pool.query<{ workspace_id: string }>(
    `SELECT DISTINCT workspace_id FROM scheduled_posts
     WHERE status = 'scheduled' AND scheduled_at <= now()`,
  );
  let processed = 0;
  let published = 0;
  let failed = 0;
  for (const { workspace_id: workspaceId } of workspaces) {
    const r = await processDueScheduledPostsForWorkspace(workspaceId);
    processed += r.processed;
    published += r.published;
    failed += r.failed;
  }
  return { processed, published, failed };
}
