import { randomUUID } from 'node:crypto';
import { config } from '../config';
import { pool, query, queryOne } from '../db/pool';

/**
 * Scheduled-post publisher (Module B, Phase 2).
 *
 * STUB — real publishing is NOT wired yet: sending a post to Facebook /
 * Instagram needs a live Meta Graph API call with an approved page token,
 * and Meta approval is still pending (see RUNNING.md). What this module
 * does today is the full scheduling machinery around that send: due-post
 * pickup, per-platform attempts, publish logs, 3-attempt retry, and the
 * TikTok audit gate. When the real send is wired, replace ONLY the
 * `stubSend` block below; the status/log/retry flow stays the same.
 *
 * TikTok gate (PDF section 6): the TikTok Content Posting API shows posts
 * as private until the app passes audit. Until then
 * TIKTOK_SCHEDULING_AUDITED must be 'true', otherwise TikTok posts are
 * recorded as failed ('TikTok audit pending') and skipped — never published.
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
 * - TikTok without a passed audit -> failure logged, platform skipped.
 * - Any other platform -> STUB send: a log line + platform_post_id
 *   `stub-<uuid>` (clearly not a real platform id).
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
  // Video posts need a playable video attached — the local (stub) flow
  // marks them published and returns the post row, whose media_urls
  // carry the playable URL for the UI (<video controls>). Real Meta
  // publishing is unchanged: nothing here reaches any platform.
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

      try {
        // STUB SEND — replace with the real Meta Graph API call once the
        // page token + approval exist. Nothing here reaches any platform.
        // Video posts are handled the same way in this local flow: the
        // returned row keeps media_type 'video' + media_urls, so the UI
        // can play the video from its servable URL.
        const stubId = `stub-${randomUUID()}`;
        console.log(
          `[publisher:stub] post ${postId} -> ${platform} (attempt ${attempt}): ${post.media_type ?? 'text'} caption ${(post.caption ?? '').slice(0, 80)}`,
        );
        await logAttempt(workspaceId, postId, platform, attempt, 'published', null);
        platformPostId = stubId;
        publishedAny = true;
      } catch (err) {
        attemptFailed = true;
        await logAttempt(
          workspaceId,
          postId,
          platform,
          attempt,
          'failed',
          (err as Error).message,
        );
      }
    }

    // Published on at least one platform (a gated TikTok alongside a live
    // Facebook/Instagram post does not fail the whole post; the TikTok
    // failure stays visible in post_publish_logs).
    if (publishedAny) {
      const done = await setStatus(workspaceId, postId, 'published', platformPostId);
      return done ?? post;
    }
    if (!attemptFailed) break; // nothing failed and nothing published — nothing left to retry
    if (attempt === MAX_ATTEMPTS) break;
    // Small pause before the next attempt; the stub never throws, so in
    // practice this path only runs for the audit gate / real-send errors.
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const failed = await setStatus(workspaceId, postId, 'failed', platformPostId);
  return failed ?? post;
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
    const { rows: due } = await query<{ id: string }>(
      workspaceId,
      `SELECT id FROM scheduled_posts
       WHERE workspace_id = $1 AND status = 'scheduled' AND scheduled_at <= now()
       ORDER BY scheduled_at ASC`,
      [workspaceId],
    );
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
  }
  return { processed, published, failed };
}
