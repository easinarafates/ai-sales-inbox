/**
 * Post + lost-sales analytics (Phase 3, PDF §4 ঝ).
 * Full paths, mounted at /api. This file is the posts/lost-sales part only —
 * the existing analytics/routes.ts (another module) is NOT touched.
 *
 * Attribution (FIXED — migration 05-post-attribution.sql):
 * comments carry platform_post_id, and every comment that becomes a
 * conversation now records a row in post_attributions
 * (post_id = scheduled post, conversation_id, order_id once an order is
 * created from that conversation). See analytics/attribution.ts.
 *   - comments per post: real, grouped by platform_post_id (as before).
 *   - chats per post: DISTINCT conversations in post_attributions.
 *   - orders per post: DISTINCT orders linked to the post, counted EITHER
 *     through post_attributions.order_id OR through
 *     orders.conversation_id (an order from an attributed conversation
 *     counts even if its order_id was never stamped — e.g. it was created
 *     before this migration existed).
 * Nothing is ever guessed: a post with no attribution rows honestly
 * shows chats = 0 and orders = 0.
 */
import { Router, type Response } from 'express';
import { query } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';

export const postsAnalyticsRouter = Router();
postsAnalyticsRouter.use(requireAuth);

interface ScheduledPostRow {
  id: string;
  caption: string | null;
  platforms: string[] | null;
  platform_post_id: string | null;
  status: string;
  scheduled_at: string | null;
}

/**
 * GET /api/analytics/posts →
 * { posts: [{ postId, caption, platforms, status, scheduledAt,
 *             comments, chats, orders }] }
 * comments/chats/orders are REAL counts from the database; unattributed
 * posts show 0 (never invented).
 */
postsAnalyticsRouter.get('/analytics/posts', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rows: posts } = await query<ScheduledPostRow>(
    workspaceId,
    `SELECT id, caption, platforms, platform_post_id, status, scheduled_at
     FROM scheduled_posts WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [workspaceId],
  );
  // Real comment counts, grouped by the platform post id.
  const { rows: commentCounts } = await query<{ platform_post_id: string | null; n: string }>(
    workspaceId,
    `SELECT platform_post_id, count(*) AS n FROM comments
     WHERE workspace_id = $1 AND platform_post_id IS NOT NULL
     GROUP BY platform_post_id`,
    [workspaceId],
  );
  const commentsByPost = new Map<string, number>();
  for (const c of commentCounts) {
    if (c.platform_post_id) commentsByPost.set(c.platform_post_id, Number(c.n));
  }
  // Real chat counts: distinct attributed conversations per scheduled post.
  const { rows: chatCounts } = await query<{ post_id: string; n: string }>(
    workspaceId,
    `SELECT post_id, count(DISTINCT conversation_id) AS n FROM post_attributions
     WHERE workspace_id = $1 GROUP BY post_id`,
    [workspaceId],
  );
  const chatsByPost = new Map<string, number>();
  for (const c of chatCounts) chatsByPost.set(c.post_id, Number(c.n));
  // Real order counts: distinct orders linked to the post, either through
  // post_attributions.order_id or through the order's conversation
  // (orders.conversation_id = an attributed conversation).
  const { rows: orderCounts } = await query<{ post_id: string; n: string }>(
    workspaceId,
    `SELECT pa.post_id, count(DISTINCT o.id) AS n
     FROM post_attributions pa
     JOIN orders o ON o.workspace_id = pa.workspace_id
       AND (o.id = pa.order_id OR o.conversation_id = pa.conversation_id)
     WHERE pa.workspace_id = $1
     GROUP BY pa.post_id`,
    [workspaceId],
  );
  const ordersByPost = new Map<string, number>();
  for (const o of orderCounts) ordersByPost.set(o.post_id, Number(o.n));
  res.json({
    posts: posts.map((p) => ({
      postId: p.id,
      caption: p.caption,
      platforms: p.platforms ?? [],
      status: p.status,
      scheduledAt: p.scheduled_at,
      comments: p.platform_post_id ? (commentsByPost.get(p.platform_post_id) ?? 0) : 0,
      chats: chatsByPost.get(p.id) ?? 0,
      orders: ordersByPost.get(p.id) ?? 0,
    })),
  });
});

/**
 * GET /api/analytics/lost-sales →
 * { reasons: [{ reason, count }], total } — reasons grouped from
 * tickets.reason + unanswered_questions.question. Empty when nothing is
 * recorded yet, with a Bengali note.
 */
postsAnalyticsRouter.get('/analytics/lost-sales', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rows: ticketReasons } = await query<{ reason: string; n: string }>(
    workspaceId,
    `SELECT reason, count(*) AS n FROM tickets
     WHERE workspace_id = $1 AND reason IS NOT NULL AND reason <> ''
     GROUP BY reason`,
    [workspaceId],
  );
  const { rows: unanswered } = await query<{ question: string; count: number }>(
    workspaceId,
    'SELECT question, count FROM unanswered_questions WHERE workspace_id = $1',
    [workspaceId],
  );
  const byReason = new Map<string, number>();
  for (const r of ticketReasons) {
    byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + Number(r.n));
  }
  for (const u of unanswered) {
    byReason.set(u.question, (byReason.get(u.question) ?? 0) + Number(u.count));
  }
  const reasons = [...byReason.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
  const total = reasons.reduce((sum, r) => sum + r.count, 0);
  res.json({
    reasons,
    total,
    ...(reasons.length === 0
      ? { message: 'এখনো সেল হারানোর কারণ জমা হয়নি।' }
      : {}),
  });
});
