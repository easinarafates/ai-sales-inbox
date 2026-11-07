/**
 * Page post analysis (overnight area 6): read the connected Facebook
 * Page's real posts from Graph and summarise them — never invent posts,
 * numbers, or comments.
 *
 * GET /api/analytics/page-posts?channelId=&limit=
 *   → { page, channelId, posts, totals, topPostId, topComments,
 *       suggestions, fetchedAt }
 *
 * posts: the Page's recent posts (default 10), each with real Graph
 *   counts — likes, comments, shares — plus how many of its comments
 *   already sit in this workspace's Inbox (commentsInInbox) and how many
 *   are still unanswered there (unansweredInInbox). Sorted by engagement
 *   (likes + comments + shares) descending.
 * topComments: the first few real comments on the top 3 posts
 *   (commenter + one line of text each), fetched from Graph.
 * suggestions: short rules derived ONLY from the numbers above
 *   (top post, unanswered comments, zero-engagement posts) — no advice
 *   is invented from data we do not have.
 *
 * Honesty rules:
 * - No Page connected → 200 with posts: [] and a plain Bengali message.
 * - Page has no posts / Graph returns nothing → same honest empty state.
 * - Graph denies access (e.g. missing pages_read_engagement, expired
 *   token) → 502 with Graph's code + message; nothing is faked.
 * - Needs pages_read_engagement on the Page token. The stored Page
 *   token is decrypted in memory only and sent as a Bearer header —
 *   never in a URL or a log line. META_GRAPH_BASE_URL overrides the
 *   Graph base for offline testing only (see meta-send.ts).
 */
import { Router, type Response } from 'express';
import { query, queryOne } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';
import { decryptToken } from '../db/crypto';
import { fetchWithTimeout } from '../ai-agent/http';
import { decryptPageToken, getWorkspacePageChannel, graphBaseUrl, likeGraphObject } from '../channels/meta-send';

export const pagePostsAnalysisRouter = Router();
pagePostsAnalysisRouter.use(requireAuth);

interface ChannelRow {
  id: string;
  external_id: string;
  display_name: string | null;
  token_encrypted: string | null;
}

interface GraphPost {
  id: string;
  message?: string;
  created_time?: string;
  permalink_url?: string;
  likes?: { summary?: { total_count?: number } };
  comments?: { summary?: { total_count?: number } };
  shares?: { count?: number };
}

interface GraphComment {
  from?: { name?: string };
  message?: string;
  created_time?: string;
}

interface PostSummary {
  id: string;
  message: string;
  createdTime: string | null;
  permalinkUrl: string | null;
  likes: number;
  comments: number;
  shares: number;
  engagement: number;
  commentsInInbox: number;
  unansweredInInbox: number;
}

function graphErrorMessage(data: unknown, status: number): { code?: number; detail: string } {
  const err = (data as { error?: { message?: string; code?: number } } | null)?.error;
  return {
    code: err?.code,
    detail: err?.message ?? `Meta Graph request failed (HTTP ${status})`,
  };
}

async function graphGet(
  path: string,
  pageToken: string,
): Promise<{ ok: boolean; data: unknown; code?: number; detail?: string }> {
  let res: Awaited<ReturnType<typeof fetchWithTimeout>>;
  try {
    res = await fetchWithTimeout(`${graphBaseUrl()}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${pageToken}` },
    }, 15000);
  } catch (err) {
    return { ok: false, data: null, detail: (err as Error).message.includes('timed out') ? 'Graph request timed out' : (err as Error).message };
  }
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const { code, detail } = graphErrorMessage(data, res.status);
    return { ok: false, data: null, code, detail };
  }
  return { ok: true, data };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function buildSuggestions(
  posts: PostSummary[],
  totals: { comments: number },
): { en: string; bn: string }[] {
  const out: { en: string; bn: string }[] = [];
  if (posts.length === 0) return out;
  const top = posts[0];
  out.push({
    en: `Top post: “${truncate(top.message || '(no caption)', 60)}” — ${top.engagement} engagements (${top.likes} likes, ${top.comments} comments, ${top.shares} shares).`,
    bn: `সেরা পোস্ট: “${truncate(top.message || '(ক্যাপশন নেই)', 60)}” — ${top.engagement}টি এনগেজমেন্ট (${top.likes} লাইক, ${top.comments} কমেন্ট, ${top.shares} শেয়ার)।`,
  });
  const mostCommented = [...posts].sort((a, b) => b.comments - a.comments)[0];
  if (mostCommented && mostCommented.unansweredInInbox > 0) {
    out.push({
      en: `The most-commented post still has ${mostCommented.unansweredInInbox} unanswered comment(s) in the Inbox — reply to them first, buyers are waiting.`,
      bn: `সবচেয়ে বেশি কমেন্ট পাওয়া পোস্টে এখনো ${mostCommented.unansweredInInbox}টি কমেন্টের উত্তর দেওয়া হয়নি — আগে সেগুলোর উত্তর দিন, ক্রেতারা অপেক্ষা করছে।`,
    });
  }
  const zeroEngagement = posts.filter((p) => p.engagement === 0).length;
  if (zeroEngagement > 0) {
    out.push({
      en: `${zeroEngagement} post(s) got no reactions or comments — try a question or an offer in the next caption.`,
      bn: `${zeroEngagement}টি পোস্টে কোনো রিঅ্যাকশন বা কমেন্ট আসেনি — পরের পোস্টের ক্যাপশনে প্রশ্ন বা অফার দিন।`,
    });
  } else if (totals.comments === 0) {
    out.push({
      en: 'No post got a comment yet — ask buyers a question in the next post so they reply.',
      bn: 'এখনো কোনো পোস্টে কমেন্ট আসেনি — পরের পোস্টে ক্রেতাদের প্রশ্ন করুন, তাহলে উত্তর আসবে।',
    });
  }
  if (top.comments > top.likes && top.comments > 0) {
    out.push({
      en: 'Buyers are asking questions on the top post — fast replies turn comments into orders.',
      bn: 'সেরা পোস্টে ক্রেতারা প্রশ্ন করছে — দ্রুত উত্তর দিলে কমেন্ট অর্ডারে বদলায়।',
    });
  }
  return out.slice(0, 3);
}

/**
 * GET /api/analytics/page-posts — real post analysis for the connected
 * Facebook Page (or ?channelId= for one of several Pages).
 */
pagePostsAnalysisRouter.get('/analytics/page-posts', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const channelId = typeof req.query.channelId === 'string' ? req.query.channelId : null;
  const limitRaw = Number(req.query.limit ?? 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(25, Math.max(1, Math.floor(limitRaw))) : 10;

  const channels = await query<ChannelRow>(
    workspaceId,
    `SELECT id, external_id, display_name, token_encrypted FROM channels
     WHERE workspace_id = $1 AND platform = 'messenger' AND token_encrypted IS NOT NULL
       AND ($2::text IS NULL OR id::text = $2)
     ORDER BY created_at DESC`,
    [workspaceId, channelId],
  );
  if (channelId && channels.rows.length === 0) {
    res.status(404).json({ error: 'Channel not found (needs a connected Facebook Page with a stored token)' });
    return;
  }
  const channel = channels.rows[0];
  if (!channel) {
    res.json({
      page: null,
      channelId: null,
      posts: [],
      totals: { posts: 0, likes: 0, comments: 0, shares: 0, engagement: 0 },
      topPostId: null,
      topComments: [],
      suggestions: [],
      fetchedAt: new Date().toISOString(),
      message: 'এখনো কোনো Facebook Page যুক্ত হয়নি। Channels পেজ থেকে Login with Facebook দিয়ে পেজ যুক্ত করুন।',
    });
    return;
  }
  let pageToken: string;
  try {
    pageToken = decryptToken(channel.token_encrypted as string);
  } catch {
    res.status(502).json({ error: 'stored_page_token_invalid', detail: 'The stored Page token could not be read — reconnect the Page.' });
    return;
  }

  const fields = 'id,message,created_time,permalink_url,likes.summary(true).limit(0),comments.summary(true).limit(0),shares';
  const postsPath = `/${encodeURIComponent(channel.external_id)}/posts?${new URLSearchParams({ fields, limit: String(limit) })}`;
  const fetched = await graphGet(postsPath, pageToken);
  if (!fetched.ok) {
    res.status(502).json({
      error: 'facebook_graph_error',
      message: fetched.detail ?? 'Could not read the Page posts from Facebook.',
      code: fetched.code ?? null,
      detail: fetched.detail ?? 'Could not read the Page posts from Facebook.',
    });
    return;
  }
  const graphPosts = (((fetched.data as { data?: GraphPost[] } | null)?.data ?? []) as GraphPost[]);

  // Real local counts: comments already in this workspace's Inbox,
  // grouped by platform post id (same source as /api/analytics/posts).
  const { rows: inboxCounts } = await query<{ platform_post_id: string | null; n: string; unanswered: string }>(
    workspaceId,
    `SELECT platform_post_id, count(*)::text AS n,
            count(*) FILTER (WHERE replied = FALSE)::text AS unanswered
     FROM comments WHERE workspace_id = $1 AND platform_post_id IS NOT NULL
     GROUP BY platform_post_id`,
    [workspaceId],
  );
  const inboxByPost = new Map<string, { n: number; unanswered: number }>();
  for (const c of inboxCounts) {
    if (c.platform_post_id) inboxByPost.set(c.platform_post_id, { n: Number(c.n), unanswered: Number(c.unanswered) });
  }

  const posts: PostSummary[] = graphPosts.map((p) => {
    const likes = p.likes?.summary?.total_count ?? 0;
    const comments = p.comments?.summary?.total_count ?? 0;
    const shares = p.shares?.count ?? 0;
    const local = inboxByPost.get(p.id) ?? { n: 0, unanswered: 0 };
    return {
      id: p.id,
      message: p.message ?? '',
      createdTime: p.created_time ?? null,
      permalinkUrl: p.permalink_url ?? null,
      likes,
      comments,
      shares,
      engagement: likes + comments + shares,
      commentsInInbox: local.n,
      unansweredInInbox: local.unanswered,
    };
  });
  posts.sort((a, b) => b.engagement - a.engagement);
  const totals = posts.reduce(
    (t, p) => ({
      posts: t.posts + 1,
      likes: t.likes + p.likes,
      comments: t.comments + p.comments,
      shares: t.shares + p.shares,
      engagement: t.engagement + p.engagement,
    }),
    { posts: 0, likes: 0, comments: 0, shares: 0, engagement: 0 },
  );

  // Top comments, one line each, from the top 3 posts by engagement.
  const topComments: { postId: string; author: string; text: string; createdTime: string | null }[] = [];
  for (const post of posts.slice(0, 3)) {
    if (post.comments === 0) continue;
    const commentsPath = `/${encodeURIComponent(post.id)}/comments?${new URLSearchParams({
      fields: 'from,message,created_time',
      limit: '5',
    })}`;
    const got = await graphGet(commentsPath, pageToken);
    if (!got.ok) continue; // Best-effort: a failed comments fetch never breaks the summary.
    const list = (((got.data as { data?: GraphComment[] } | null)?.data ?? []) as GraphComment[]);
    for (const c of list) {
      if (!c.message) continue;
      topComments.push({
        postId: post.id,
        author: c.from?.name ?? 'Unknown',
        text: truncate(c.message, 200),
        createdTime: c.created_time ?? null,
      });
    }
  }

  res.json({
    page: { id: channel.external_id, name: channel.display_name ?? channel.external_id },
    channelId: channel.id,
    posts,
    totals,
    topPostId: posts[0]?.id ?? null,
    topComments,
    suggestions: buildSuggestions(posts, totals),
    fetchedAt: new Date().toISOString(),
    ...(posts.length === 0
      ? { message: 'এই পেজে এখনো কোনো পোস্ট পাওয়া যায়নি।' }
      : {}),
  });
});

/**
 * POST /api/analytics/page-posts/:postId/like — like a Page post as the
 * Page (POST /{post-id}/likes with the workspace's Page token). Needs
 * pages_manage_engagement on the token (granted at Login with Facebook
 * after the scope was added — a token from before must have the Page
 * reconnected once). A failed like returns 502 with Graph's own message
 * and never pretends the like went through.
 */
pagePostsAnalysisRouter.post('/analytics/page-posts/:postId/like', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const postId = decodeURIComponent(req.params.postId);
  const channel = await getWorkspacePageChannel(workspaceId);
  if (!channel) {
    res.status(502).json({ error: 'কোনো Facebook Page যুক্ত নেই — Channels পেজ থেকে পেজ যুক্ত করুন (no Facebook Page connected)' });
    return;
  }
  const pageToken = decryptPageToken(channel);
  if (!pageToken) {
    res.status(502).json({ error: 'stored_page_token_invalid', detail: 'The stored Page token could not be read — reconnect the Page.' });
    return;
  }
  const result = await likeGraphObject({ objectId: postId, pageToken });
  if (!result.ok) {
    res.status(502).json({ error: `Like failed: ${result.error ?? 'unknown error'}`, code: result.code ?? null });
    return;
  }
  res.json({ liked: true, alreadyLiked: result.alreadyLiked ?? false, postId });
});
