import { config } from '../config';
import { pool, query, queryOne } from '../db/pool';
import {
  decryptPageToken,
  getWorkspacePageChannel,
  sendPagePost,
} from '../channels/meta-send';

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
 * Instagram / Messenger / WhatsApp are not post platforms for this app:
 * Instagram publishing (media containers) is not built yet and Messenger /
 * WhatsApp are messaging channels — they are logged as failed with a
 * plain reason instead of pretending to publish.
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
  created_at: string;
  updated_at: string;
  /** Latest failed publish reason (from post_publish_logs) — response-only, not a DB column. */
  lastError?: string | null;
}

const POST_COLUMNS =
  'id, caption, media_urls, media_type, platforms, scheduled_at, status, platform_post_id, created_at, updated_at';

const MAX_ATTEMPTS = 3;

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
 * - TikTok without a passed audit -> failure logged, platform skipped.
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

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let attemptFailed = false;

    for (const platform of platforms) {
      // TikTok audit gate — never publish before the audit passes.
      if (platform === 'tiktok' && !config.tiktokSchedulingAudited) {
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
