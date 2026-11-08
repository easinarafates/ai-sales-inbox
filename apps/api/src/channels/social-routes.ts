import { Router, type Response } from 'express';
import { config } from '../config';
import { queryOne } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';
import { enqueueMessage } from '../queue/client';
import {
  fetchYoutubeComments,
  fetchYoutubeVideos,
  getYoutubeAccessToken,
  getYoutubeChannel,
  getYoutubeQuota,
  hasUploadScope,
  replyYoutubeComment,
} from './youtube';
import {
  getInstagramChannel,
  hasInstagramPublishScope,
} from './instagram-post';
import {
  fetchTikTokCommentReplies,
  fetchTikTokComments,
  fetchTikTokDMThread,
  fetchTikTokVideos,
  getTikTokAccessToken,
  getTikTokBusinessConfig,
  getTikTokChannel,
  listTikTokDMConversations,
  replyTikTokComment,
} from './tiktok';
import {
  findOrCreateConversation,
  findOrCreateCustomer,
  isTikTokDMApproved,
  recordWebhookEvent,
  saveIncomingMessage,
} from '../webhooks/tiktok-dm';

/**
 * YouTube + TikTok live API routes (mounted at /api).
 *
 * Everything here reads LIVE from YouTube / TikTok with the workspace's
 * stored OAuth token (refreshed automatically when expired) — nothing
 * is faked. A channel that is not connected (or an app that is not
 * configured) answers 503 with a Bengali message saying what is
 * missing, so the UI shows "not connected" honestly instead of empty
 * lists. Tokens are never returned.
 *
 *  YouTube:
 *   GET  /youtube/status    — connected? upload scope? today's quota
 *   GET  /youtube/videos    — the channel's own videos (live)
 *   GET  /youtube/comments?videoId= — live comments (all channel threads when no videoId)
 *   POST /youtube/comments/:commentId/reply {text} — reply (needs youtube.force-ssl)
 *  Instagram:
 *   GET  /instagram/status  — connected? publish scope (instagram_content_publish)? needs reconnect?
 *  TikTok:
 *   GET  /tiktok/status     — connected? configured? audited? DM approved? Business Messaging?
 *   GET  /tiktok/videos     — the account's videos, Display API (live)
 *   GET  /tiktok/comments?videoId= — live comments (scope comment.list)
 *   GET  /tiktok/comments/:commentId/replies?videoId= — replies under one comment
 *   POST /tiktok/comments/reply {videoId, commentId, text} — reply (best-effort: needs TikTok's comment-scope approval)
 *   GET  /tiktok/dm/conversations — live Business Messaging threads
 *   GET  /tiktok/dm/conversations/:id — live messages of one thread
 *   POST /tiktok/dm/sync   — import Business Messaging threads into the Inbox (deduped, AI-enqueued)
 */
export const socialApiRouter = Router();
socialApiRouter.use(requireAuth);

function notConnected(res: Response, error: string): void {
  res.status(503).json({ error, reason: 'not_connected' });
}

// ---------------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------------

socialApiRouter.get('/youtube/status', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const channel = await getYoutubeChannel(workspaceId);
  const quota = await getYoutubeQuota(workspaceId);
  res.json({
    configured: !!config.google.clientId && !!config.google.clientSecret,
    connected: !!channel,
    channelId: channel?.external_id ?? null,
    channelName: channel?.display_name ?? null,
    channelPicture: channel?.picture_url ?? null,
    scopes: channel?.scopes ?? null,
    hasUploadScope: hasUploadScope(channel),
    needsReconnectForUpload:
      !!channel && !hasUploadScope(channel),
    quota: {
      dailyLimitUnits: quota.dailyLimitUnits,
      uploadCostUnits: quota.uploadCostUnits,
      uploadsToday: quota.uploadsToday,
      unitsUsed: quota.unitsUsed,
      unitsRemaining: quota.unitsRemaining,
      maxUploadsPerDay: quota.maxUploadsPerDay,
    },
    note: 'YouTube Data API কোটা: প্রতিদিন ১০,০০০ ইউনিট; একটি ভিডিও আপলোড ~১,৬০০ ইউনিট (দিনে সর্বোচ্চ ৬টি)। কোটা শেষ হলে প্রকাশ ব্যর্থ হবে — ভুয়া সফল দেখানো হবে না।',
  });
});

// ---------------------------------------------------------------------------
// Instagram
// ---------------------------------------------------------------------------

socialApiRouter.get('/instagram/status', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const channel = await getInstagramChannel(workspaceId);
  res.json({
    connected: !!channel,
    channelId: channel?.external_id ?? null,
    channelName: channel?.display_name ?? null,
    scopes: channel?.scopes ?? null,
    hasPublishScope: hasInstagramPublishScope(channel),
    needsReconnectForPublish: !!channel && !hasInstagramPublishScope(channel),
    note: 'Instagram পোস্ট প্রকাশের জন্য instagram_content_publish অনুমতি লাগে — অনুমতি ছাড়া যুক্ত অ্যাকাউন্টে পোস্ট ব্যর্থ হবে, Channels পেজ থেকে Instagram আবার যুক্ত (reconnect) করতে হবে।',
  });
});

socialApiRouter.get('/youtube/videos', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const token = await getYoutubeAccessToken(workspaceId);
  if (!token.ok) {
    notConnected(res, token.error);
    return;
  }
  const result = await fetchYoutubeVideos(token.accessToken);
  if (!result.ok) {
    res.status(502).json({ error: `YouTube থেকে ভিডিও আনা যায়নি: ${result.error}`, reason: result.reason });
    return;
  }
  res.json({ videos: result.videos, channelId: token.channel.external_id, channelName: token.channel.display_name });
});

socialApiRouter.get('/youtube/comments', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const videoId = typeof req.query.videoId === 'string' && req.query.videoId ? req.query.videoId : undefined;
  const token = await getYoutubeAccessToken(workspaceId);
  if (!token.ok) {
    notConnected(res, token.error);
    return;
  }
  const result = await fetchYoutubeComments(token.accessToken, {
    videoId,
    channelId: videoId ? undefined : token.channel.external_id,
  });
  if (!result.ok) {
    res.status(502).json({ error: `YouTube থেকে কমেন্ট আনা যায়নি: ${result.error}`, reason: result.reason });
    return;
  }
  res.json({ comments: result.comments, channelId: token.channel.external_id });
});

socialApiRouter.post('/youtube/comments/:commentId/reply', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { text } = (req.body ?? {}) as { text?: string };
  if (!text || !text.trim()) {
    res.status(400).json({ error: 'text is required' });
    return;
  }
  const token = await getYoutubeAccessToken(workspaceId);
  if (!token.ok) {
    notConnected(res, token.error);
    return;
  }
  const result = await replyYoutubeComment(token.accessToken, req.params.commentId, text.trim());
  if (!result.ok) {
    res.status(502).json({
      error: `YouTube-এ উত্তর পাঠানো যায়নি: ${result.error}`,
      reason: result.reason,
      ...(result.reason === 'forbidden'
        ? { note: 'উত্তর দিতে youtube.force-ssl অনুমতি লাগে — Channels পেজ থেকে YouTube আবার যুক্ত (reconnect) করুন।' }
        : {}),
    });
    return;
  }
  res.json({ replied: true, replyId: result.replyId });
});

// ---------------------------------------------------------------------------
// TikTok
// ---------------------------------------------------------------------------

socialApiRouter.get('/tiktok/status', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const channel = await getTikTokChannel(workspaceId);
  const business = getTikTokBusinessConfig();
  res.json({
    configured: !!config.tiktok.clientKey && !!config.tiktok.clientSecret,
    connected: !!channel,
    channelId: channel?.external_id ?? null,
    channelName: channel?.display_name ?? null,
    channelPicture: null,
    scopes: channel?.scopes ?? null,
    audited: config.tiktokSchedulingAudited,
    dmApproved: config.tiktokDmApproved,
    businessMessagingConfigured: business.configured,
    businessMessagingNote:
      'DM পাঠাতে/পড়তে TikTok for Business-এর আলাদা Business Messaging অনুমোদন লাগে (Login Kit দিয়ে DM হয় না)।',
  });
});

socialApiRouter.get('/tiktok/videos', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const token = await getTikTokAccessToken(workspaceId);
  if (!token.ok) {
    notConnected(res, token.error);
    return;
  }
  const result = await fetchTikTokVideos(token.accessToken);
  if (!result.ok) {
    res.status(502).json({ error: `TikTok থেকে ভিডিও আনা যায়নি: ${result.error}`, reason: result.reason });
    return;
  }
  res.json({ videos: result.data.videos, hasMore: result.data.hasMore, cursor: result.data.cursor });
});

socialApiRouter.get('/tiktok/comments', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const videoId = typeof req.query.videoId === 'string' ? req.query.videoId : '';
  if (!videoId) {
    res.status(400).json({ error: 'videoId is required — প্রথমে ভিডিও বেছে নিন (pick a video first)' });
    return;
  }
  const token = await getTikTokAccessToken(workspaceId);
  if (!token.ok) {
    notConnected(res, token.error);
    return;
  }
  const result = await fetchTikTokComments(token.accessToken, videoId);
  if (!result.ok) {
    res.status(502).json({ error: `TikTok থেকে কমেন্ট আনা যায়নি: ${result.error}`, reason: result.reason });
    return;
  }
  res.json({ comments: result.data.comments, hasMore: result.data.hasMore, cursor: result.data.cursor });
});

socialApiRouter.get('/tiktok/comments/:commentId/replies', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const token = await getTikTokAccessToken(workspaceId);
  if (!token.ok) {
    notConnected(res, token.error);
    return;
  }
  const result = await fetchTikTokCommentReplies(token.accessToken, req.params.commentId);
  if (!result.ok) {
    res.status(502).json({ error: `TikTok থেকে উত্তর আনা যায়নি: ${result.error}`, reason: result.reason });
    return;
  }
  res.json({ comments: result.data.comments, hasMore: result.data.hasMore, cursor: result.data.cursor });
});

socialApiRouter.post('/tiktok/comments/reply', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { videoId, commentId, text } = (req.body ?? {}) as { videoId?: string; commentId?: string; text?: string };
  if (!videoId || !commentId || !text?.trim()) {
    res.status(400).json({ error: 'videoId, commentId and text are required' });
    return;
  }
  const token = await getTikTokAccessToken(workspaceId);
  if (!token.ok) {
    notConnected(res, token.error);
    return;
  }
  const result = await replyTikTokComment(token.accessToken, videoId, commentId, text.trim());
  if (!result.ok) {
    res.status(502).json({
      error: `TikTok-এ উত্তর পাঠানো যায়নি: ${result.error}`,
      reason: result.reason,
      note: 'কমেন্টের উত্তর দিতে TikTok-এর comment স্কোপের অনুমোদন লাগে — অনুমোদন না হওয়া পর্যন্ত কমেন্ট পড়া যাবে, উত্তর দেওয়া যাবে না।',
    });
    return;
  }
  res.json({ replied: true, replyId: result.data.replyId });
});

// ---------------------------------------------------------------------------
// TikTok DMs (Business Messaging API — live read + import into the Inbox)
// ---------------------------------------------------------------------------

socialApiRouter.get('/tiktok/dm/conversations', async (req: AuthRequest, res: Response) => {
  const business = getTikTokBusinessConfig();
  if (!business.configured) {
    res.status(503).json({
      error: 'TikTok Business Messaging সেটআপ হয়নি — TIKTOK_BUSINESS_ACCESS_TOKEN আর TIKTOK_BUSINESS_ID দিতে হবে (TikTok for Business-এ আলাদা আবেদন করে পাওয়া যায়)',
      reason: 'not_configured',
    });
    return;
  }
  const result = await listTikTokDMConversations(business);
  if (!result.ok) {
    res.status(502).json({ error: `TikTok DM তালিকা আনা যায়নি: ${result.error}`, reason: result.reason });
    return;
  }
  res.json({ conversations: result.data.conversations });
});

socialApiRouter.get('/tiktok/dm/conversations/:id', async (req: AuthRequest, res: Response) => {
  const business = getTikTokBusinessConfig();
  if (!business.configured) {
    res.status(503).json({
      error: 'TikTok Business Messaging সেটআপ হয়নি — TIKTOK_BUSINESS_ACCESS_TOKEN আর TIKTOK_BUSINESS_ID দিতে হবে',
      reason: 'not_configured',
    });
    return;
  }
  const result = await fetchTikTokDMThread(business, req.params.id);
  if (!result.ok) {
    res.status(502).json({ error: `TikTok DM পড়া যায়নি: ${result.error}`, reason: result.reason });
    return;
  }
  res.json({ conversationId: req.params.id, participants: result.data.participants, messages: result.data.messages });
});

/**
 * POST /api/tiktok/dm/sync — pull live Business Messaging threads into
 * the Inbox (same intake as the webhook: one customer = one chat,
 * deduped by message id, AI-enqueued). Use it when the TikTok webhook
 * is not registered yet, or to backfill threads. Same approval gate as
 * the webhook: without TIKTOK_DM_APPROVED nothing is imported.
 */
socialApiRouter.post('/tiktok/dm/sync', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  if (!isTikTokDMApproved()) {
    res.status(403).json({
      error: 'TikTok DM এখনো অনুমোদিত হয়নি (TIKTOK_DM_APPROVED is not true) — DM আমদানি করা যাবে না।',
      approvalRequired: true,
    });
    return;
  }
  const business = getTikTokBusinessConfig();
  if (!business.configured) {
    res.status(503).json({
      error: 'TikTok Business Messaging সেটআপ হয়নি — TIKTOK_BUSINESS_ACCESS_TOKEN আর TIKTOK_BUSINESS_ID দিতে হবে',
      reason: 'not_configured',
    });
    return;
  }
  const channel = await queryOne<{ id: string }>(
    workspaceId,
    `SELECT id FROM channels WHERE workspace_id = $1 AND platform IN ('tiktok_dm', 'tiktok') AND status = 'connected'
     ORDER BY CASE platform WHEN 'tiktok_dm' THEN 0 ELSE 1 END, created_at DESC LIMIT 1`,
    [workspaceId],
  );
  if (!channel) {
    res.status(503).json({
      error: 'TikTok চ্যানেল যুক্ত নেই — Channels পেজ থেকে TikTok যুক্ত করুন (no TikTok channel connected)',
      reason: 'not_connected',
    });
    return;
  }
  const list = await listTikTokDMConversations(business);
  if (!list.ok) {
    res.status(502).json({ error: `TikTok DM তালিকা আনা যায়নি: ${list.error}`, reason: list.reason });
    return;
  }
  let imported = 0;
  let conversations = 0;
  for (const conv of list.data.conversations) {
    const thread = await fetchTikTokDMThread(business, conv.conversationId);
    if (!thread.ok) continue;
    conversations++;
    for (const msg of thread.data.messages) {
      if (msg.isOwn || !msg.senderId) continue;
      const eventId = `bm:${conv.conversationId}:${msg.messageId}`;
      if (!(await recordWebhookEvent(workspaceId, 'tiktok_dm', eventId, msg))) continue;
      const customer = await findOrCreateCustomer(workspaceId, 'tiktok_dm', msg.senderId, msg.senderName ?? undefined);
      const conversationId = await findOrCreateConversation(workspaceId, channel.id, customer.id);
      await saveIncomingMessage(workspaceId, conversationId, msg.text, msg.messageId);
      await enqueueMessage(workspaceId, conversationId, msg.text).catch((err) =>
        console.error('[tiktok/dm-sync] enqueue failed:', (err as Error).message),
      );
      imported++;
    }
  }
  res.json({ imported, conversations: list.data.conversations.length, threadsRead: conversations });
});
