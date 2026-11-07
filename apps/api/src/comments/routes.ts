import { Router, type Response } from 'express';
import { query, queryOne } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';
import { deliverOutgoingMessage, getWorkspacePageChannel, decryptPageToken, likeGraphObject } from '../channels/meta-send';
import { recordAttributionForPlatformPost } from '../analytics/attribution';

/**
 * Comments (Phase 2): product carousel for a post, and replying to a comment
 * from the inbox. Mounted by the coordinator at /api.
 */
export const commentsRouter = Router();
commentsRouter.use(requireAuth);

interface CommentRow {
  id: string;
  platform_post_id: string | null;
  platform_comment_id: string | null;
  body: string | null;
  replied: boolean;
  status: string;
  reply_text: string | null;
  created_at: string;
  updated_at: string;
}

const COMMENT_COLUMNS =
  'id, platform_post_id, platform_comment_id, body, replied, status, reply_text, created_at, updated_at';

const MODERATION_STATUSES = ['to_check', 'answered', 'hidden', 'removed', 'done'] as const;

/** GET /api/comments?status=&platformPostId= — moderation list (Worker B). */
commentsRouter.get('/comments', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const platformPostId = typeof req.query.platformPostId === 'string' ? req.query.platformPostId : null;
  if (status && !(MODERATION_STATUSES as readonly string[]).includes(status)) {
    res.status(400).json({ error: `status must be one of: ${MODERATION_STATUSES.join(', ')}` });
    return;
  }
  const { rows } = await query<CommentRow>(
    workspaceId,
    `SELECT ${COMMENT_COLUMNS} FROM comments
     WHERE workspace_id = $1
       AND ($2::text IS NULL OR status = $2)
       AND ($3::text IS NULL OR platform_post_id = $3)
     ORDER BY created_at DESC LIMIT 200`,
    [workspaceId, status, platformPostId],
  );
  res.json({ comments: rows });
});

/** POST /api/comments {platformPostId?, platformCommentId?, body} — log a comment by hand. */
commentsRouter.post('/comments', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { platformPostId, platformCommentId, body } = (req.body ?? {}) as {
    platformPostId?: string;
    platformCommentId?: string;
    body?: string;
  };
  if (!body?.trim()) {
    res.status(400).json({ error: 'body is required' });
    return;
  }
  const { rows } = await query<CommentRow>(
    workspaceId,
    `INSERT INTO comments (workspace_id, platform_post_id, platform_comment_id, body, status)
     VALUES ($1, $2, $3, $4, 'to_check') RETURNING ${COMMENT_COLUMNS}`,
    [workspaceId, platformPostId ?? null, platformCommentId ?? null, body.trim()],
  );
  res.status(201).json({ comment: rows[0] });
});

/**
 * POST /api/comments/:id/answer {text} — answer without needing a linked
 * chat. When a linked conversation exists, the reply is delivered for
 * real via deliverOutgoingMessage (a Facebook comment reply on
 * facebook_comment conversations, a Messenger/IG DM otherwise); a failed
 * delivery returns 502 and the comment is NOT marked answered, so the
 * inbox never pretends a reply went out. Hand-logged comments with no
 * linked Facebook comment are saved in the inbox only (delivered: false
 * says so honestly).
 */
commentsRouter.post('/comments/:id/answer', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { text } = (req.body ?? {}) as { text?: string };
  if (!text || !text.trim()) {
    res.status(400).json({ error: 'text is required' });
    return;
  }
  const comment = await queryOne<CommentRow>(
    workspaceId,
    `SELECT ${COMMENT_COLUMNS} FROM comments WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, req.params.id],
  );
  if (!comment) {
    res.status(404).json({ error: 'Comment not found' });
    return;
  }
  const msg = comment.platform_comment_id
    ? await queryOne<{ conversation_id: string }>(
        workspaceId,
        `SELECT conversation_id FROM messages
         WHERE workspace_id = $1 AND platform_message_id = $2
         ORDER BY created_at DESC LIMIT 1`,
        [workspaceId, comment.platform_comment_id],
      )
    : null;
  if (msg) {
    const delivery = await deliverOutgoingMessage(workspaceId, msg.conversation_id, text.trim());
    if (!delivery.sent) {
      res.status(502).json({
        error: `Reply could not be delivered: ${delivery.error ?? 'unknown error'}`,
        reason: delivery.error ?? 'send_failed',
        comment,
        conversationId: msg.conversation_id,
      });
      return;
    }
    const { rows } = await query<CommentRow>(
      workspaceId,
      `UPDATE comments SET replied = TRUE, status = 'answered', reply_text = $1, updated_at = now()
       WHERE workspace_id = $2 AND id = $3 RETURNING ${COMMENT_COLUMNS}`,
      [text.trim(), workspaceId, req.params.id],
    );
    res.json({
      comment: rows[0],
      conversationId: msg.conversation_id,
      delivered: true,
      platformMessageId: delivery.platformMessageId ?? null,
    });
    return;
  }
  const { rows } = await query<CommentRow>(
    workspaceId,
    `UPDATE comments SET replied = TRUE, status = 'answered', reply_text = $1, updated_at = now()
     WHERE workspace_id = $2 AND id = $3 RETURNING ${COMMENT_COLUMNS}`,
    [text.trim(), workspaceId, req.params.id],
  );
  res.json({
    comment: rows[0],
    conversationId: null,
    delivered: false,
    deliveryNote: 'এই কমেন্টের সাথে Facebook-এ কোনো কমেন্ট যুক্ত নেই — উত্তরটি শুধু ইনবক্সে সংরক্ষণ করা হয়েছে।',
  });
});

/**
 * POST /api/comments/:id/like — like the Facebook comment as the Page.
 * POST /{platform_comment_id}/likes with the workspace's Page token.
 * Needs pages_manage_engagement on the token (granted at Login with
 * Facebook after the scope was added — a token from before must have
 * the Page reconnected once). A failed like returns 502 with Graph's
 * own message; the comment is never marked liked when Graph refused.
 */
commentsRouter.post('/comments/:id/like', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const comment = await queryOne<CommentRow>(
    workspaceId,
    `SELECT ${COMMENT_COLUMNS} FROM comments WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, req.params.id],
  );
  if (!comment) {
    res.status(404).json({ error: 'Comment not found' });
    return;
  }
  if (!comment.platform_comment_id) {
    res.status(400).json({ error: 'এই কমেন্টের সাথে Facebook-এ কোনো কমেন্ট যুক্ত নেই — লাইক দেওয়া যাবে না (no Facebook comment linked)' });
    return;
  }
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
  const result = await likeGraphObject({ objectId: comment.platform_comment_id, pageToken });
  if (!result.ok) {
    res.status(502).json({ error: `Like failed: ${result.error ?? 'unknown error'}`, code: result.code ?? null });
    return;
  }
  res.json({ liked: true, alreadyLiked: result.alreadyLiked ?? false, comment });
});

/** POST /api/comments/:id/hide — hide the comment (status 'hidden'). */
commentsRouter.post('/comments/:id/hide', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rows } = await query<CommentRow>(
    workspaceId,
    `UPDATE comments SET status = 'hidden', updated_at = now()
     WHERE workspace_id = $1 AND id = $2 RETURNING ${COMMENT_COLUMNS}`,
    [workspaceId, req.params.id],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Comment not found' });
    return;
  }
  res.json({ comment: rows[0] });
});

/** POST /api/comments/:id/mark-done — moderation done (status 'done'). */
commentsRouter.post('/comments/:id/mark-done', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rows } = await query<CommentRow>(
    workspaceId,
    `UPDATE comments SET status = 'done', updated_at = now()
     WHERE workspace_id = $1 AND id = $2 RETURNING ${COMMENT_COLUMNS}`,
    [workspaceId, req.params.id],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Comment not found' });
    return;
  }
  res.json({ comment: rows[0] });
});

/** DELETE /api/comments/:id — delete the comment. */
commentsRouter.delete('/comments/:id', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rowCount } = await query(
    workspaceId,
    'DELETE FROM comments WHERE workspace_id = $1 AND id = $2',
    [workspaceId, req.params.id],
  );
  if (rowCount === 0) {
    res.status(404).json({ error: 'Comment not found' });
    return;
  }
  res.json({ deleted: true });
});

/**
 * GET /api/comments/:postId/carousel — products linked to this post via
 * post_products + scheduled_posts (platform_post_id = :postId).
 */
commentsRouter.get('/comments/:postId/carousel', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const postId = req.params.postId;
  const { rows } = await query<{ id: string; name: string; price_paisa: number; stock: number; description: string | null }>(
    workspaceId,
    `SELECT p.id, p.name, p.price_paisa, p.stock, p.description
     FROM scheduled_posts sp
     JOIN post_products pp ON pp.scheduled_post_id = sp.id AND pp.workspace_id = $1
     JOIN products p ON p.id = pp.product_id AND p.workspace_id = $1
     WHERE sp.workspace_id = $1 AND sp.platform_post_id = $2
     ORDER BY p.name ASC`,
    [workspaceId, postId],
  );
  const cards = rows.map((p) => ({
    productId: p.id,
    name: p.name,
    pricePaisa: Number(p.price_paisa),
    stock: Number(p.stock),
    description: p.description,
  }));
  if (cards.length === 0) {
    res.json({ postId, cards, message: 'এই পোস্টের সাথে কোনো প্রোডাক্ট যুক্ত নেই।' });
    return;
  }
  res.json({ postId, cards });
});

/**
 * POST /api/comments/:id/reply {text} — reply to the comment for real.
 * The reply is delivered via deliverOutgoingMessage (a Facebook comment
 * reply on facebook_comment conversations); a failed delivery returns
 * 502 and the comment is NOT marked answered, so the inbox never
 * pretends a reply went out.
 * The comment's conversation is found via the inbound message saved with
 * platform_message_id = the comment's platform_comment_id (see webhooks).
 */
commentsRouter.post('/comments/:id/reply', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { text } = (req.body ?? {}) as { text?: string };
  if (!text || !text.trim()) {
    res.status(400).json({ error: 'text is required' });
    return;
  }
  const comment = await queryOne<CommentRow>(
    workspaceId,
    `SELECT ${COMMENT_COLUMNS} FROM comments WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, req.params.id],
  );
  if (!comment) {
    res.status(404).json({ error: 'Comment not found' });
    return;
  }
  // The webhook saved the incoming comment as a message whose
  // platform_message_id is the platform comment id.
  const msg = comment.platform_comment_id
    ? await queryOne<{ conversation_id: string }>(
        workspaceId,
        `SELECT conversation_id FROM messages
         WHERE workspace_id = $1 AND platform_message_id = $2
         ORDER BY created_at DESC LIMIT 1`,
        [workspaceId, comment.platform_comment_id],
      )
    : null;
  if (!msg) {
    res.status(404).json({ error: 'এই কমেন্টের সাথে কোনো চ্যাট পাওয়া যায়নি।' });
    return;
  }
  const conversationId = msg.conversation_id;
  // Post attribution safety net (05-post-attribution.sql): if this
  // comment's conversation was never attributed when the comment arrived
  // (e.g. it arrived before attribution existed), link it now from the
  // comment's platform_post_id. Idempotent — harmless if already recorded.
  await recordAttributionForPlatformPost(
    { query: (text: string, params?: unknown[]) => query(workspaceId, text, params ?? []) },
    workspaceId,
    comment.platform_post_id,
    conversationId,
    'comment',
  ).catch((err) => console.error('[comments/reply] post attribution failed:', (err as Error).message));
  // Deliver for real first — only mark answered when Graph accepted it.
  const delivery = await deliverOutgoingMessage(workspaceId, conversationId, text.trim());
  if (!delivery.sent) {
    res.status(502).json({
      error: `Reply could not be delivered: ${delivery.error ?? 'unknown error'}`,
      reason: delivery.error ?? 'send_failed',
      comment,
      conversationId,
    });
    return;
  }
  await query(
    workspaceId,
    `UPDATE comments SET replied = TRUE, status = 'answered', reply_text = $1, updated_at = now()
     WHERE workspace_id = $2 AND id = $3`,
    [text.trim(), workspaceId, req.params.id],
  );
  await query(
    workspaceId,
    'UPDATE conversations SET updated_at = now() WHERE workspace_id = $1 AND id = $2',
    [workspaceId, conversationId],
  );
  const updated = await queryOne<CommentRow>(
    workspaceId,
    `SELECT ${COMMENT_COLUMNS} FROM comments WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, req.params.id],
  );
  res.json({
    comment: updated ?? comment,
    conversationId,
    delivered: true,
    platformMessageId: delivery.platformMessageId ?? null,
  });
});
