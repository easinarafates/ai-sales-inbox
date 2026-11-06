import { Router, type Response } from 'express';
import { config } from '../config';
import { pool, query, queryOne } from '../db/pool';
import type { AuthRequest } from '../types';
import { enqueueMessage } from '../queue/client';
import { recordAttributionForPlatformPost } from '../analytics/attribution';

export const webhooksRouter = Router();

// ---------------------------------------------------------------------------
// Shared helpers (used by Meta + webchat)
// ---------------------------------------------------------------------------

interface CustomerRow {
  id: string;
  name: string | null;
  phone: string | null;
  channel_identities: unknown;
}

/** Find a customer by a channel identity, or create one. Identity shape: {platform, senderId, name?}. */
async function findOrCreateCustomer(
  workspaceId: string,
  platform: string,
  senderId: string,
  name?: string,
): Promise<CustomerRow> {
  const identity = JSON.stringify([{ platform, senderId, name: name ?? null }]);
  // Match if any stored identity has this platform+senderId.
  const existing = await queryOne<CustomerRow>(
    workspaceId,
    `SELECT id, name, phone, channel_identities FROM customers
     WHERE workspace_id = $1 AND channel_identities @> $2::jsonb LIMIT 1`,
    [workspaceId, JSON.stringify([{ platform, senderId }])],
  );
  if (existing) return existing;
  const { rows } = await query<CustomerRow>(
    workspaceId,
    'INSERT INTO customers (workspace_id, name, channel_identities) VALUES ($1, $2, $3::jsonb) RETURNING id, name, phone, channel_identities',
    [workspaceId, name ?? null, identity],
  );
  return rows[0];
}

async function findOrCreateConversation(
  workspaceId: string,
  channelId: string | null,
  customerId: string,
): Promise<string> {
  const existing = await queryOne<{ id: string }>(
    workspaceId,
    `SELECT id FROM conversations WHERE workspace_id = $1 AND customer_id = $2
     AND status = 'open' ORDER BY updated_at DESC LIMIT 1`,
    [workspaceId, customerId],
  );
  if (existing) return existing.id;
  const { rows } = await query<{ id: string }>(
    workspaceId,
    `INSERT INTO conversations (workspace_id, channel_id, customer_id, status, mode)
     VALUES ($1, $2, $3, 'open', 'ai') RETURNING id`,
    [workspaceId, channelId, customerId],
  );
  return rows[0].id;
}

async function saveIncomingMessage(
  workspaceId: string,
  conversationId: string,
  body: string,
  platformMessageId?: string,
): Promise<void> {
  await query(
    workspaceId,
    `INSERT INTO messages (workspace_id, conversation_id, direction, type, body, platform_message_id)
     VALUES ($1, $2, 'in', 'text', $3, $4)`,
    [workspaceId, conversationId, body, platformMessageId ?? null],
  );
  await query(
    workspaceId,
    'UPDATE conversations SET updated_at = now() WHERE workspace_id = $1 AND id = $2',
    [workspaceId, conversationId],
  );
}

/**
 * Dedup via webhook_events UNIQUE (workspace_id, platform, platform_event_id).
 * Returns true if this is a new event, false if it was already processed.
 */
async function recordWebhookEvent(
  workspaceId: string,
  platform: string,
  platformEventId: string,
  payload: unknown,
): Promise<boolean> {
  const { rowCount } = await query(
    workspaceId,
    `INSERT INTO webhook_events (workspace_id, platform, platform_event_id, payload)
     VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (workspace_id, platform, platform_event_id) DO NOTHING`,
    [workspaceId, platform, platformEventId, JSON.stringify(payload ?? {})],
  );
  return rowCount > 0;
}

async function findChannelByExternalId(
  platform: string,
  externalId: string,
): Promise<{ id: string; workspace_id: string } | null> {
  const { rows } = await pool.query(
    'SELECT id, workspace_id FROM channels WHERE platform = $1 AND external_id = $2 ORDER BY created_at DESC LIMIT 1',
    [platform, externalId],
  );
  return (rows[0] as { id: string; workspace_id: string } | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// Meta webhooks (Messenger / Instagram / Facebook comments)
// ---------------------------------------------------------------------------

/** GET /api/webhooks/meta — Meta verification handshake. */
webhooksRouter.get('/meta', (req: AuthRequest, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === config.meta.verifyToken) {
    res.status(200).send(String(challenge ?? ''));
    return;
  }
  res.sendStatus(403);
});

/** POST /api/webhooks/meta — inbound Messenger/Instagram/comment events. */
webhooksRouter.post('/meta', async (req: AuthRequest, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const entries = Array.isArray(body.entry) ? (body.entry as Record<string, unknown>[]) : [];

  for (const entry of entries) {
    // 1) Messenger / Instagram DMs: entry.messaging[]
    const messaging = Array.isArray(entry.messaging) ? (entry.messaging as Record<string, unknown>[]) : [];
    for (const event of messaging) {
      const sender = event.sender as { id?: string } | undefined;
      const recipient = event.recipient as { id?: string } | undefined;
      const message = event.message as { mid?: string; text?: string } | undefined;
      if (!sender?.id || !message?.text) continue;
      const platform = (body.object as string) === 'instagram' ? 'instagram' : 'messenger';
      // The channel is the page/account that received the message.
      const channel = await findChannelByExternalId(platform, recipient?.id ?? '');
      if (!channel) continue; // Unknown page — not connected to any workspace.
      const eventId = message.mid ?? `${sender.id}-${Date.now()}`;
      if (!(await recordWebhookEvent(channel.workspace_id, platform, eventId, event))) continue; // duplicate
      const customer = await findOrCreateCustomer(channel.workspace_id, platform, sender.id);
      const conversationId = await findOrCreateConversation(channel.workspace_id, channel.id, customer.id);
      await saveIncomingMessage(channel.workspace_id, conversationId, message.text, message.mid);
      await enqueueMessage(channel.workspace_id, conversationId, message.text).catch((err) =>
        console.error('[webhook/meta] enqueue failed:', (err as Error).message),
      );
    }

    // 2) Facebook comments: entry.changes[] with field=feed, value.item=comment
    const changes = Array.isArray(entry.changes) ? (entry.changes as Record<string, unknown>[]) : [];
    for (const change of changes) {
      if (change.field !== 'feed') continue;
      const value = (change.value ?? {}) as Record<string, unknown>;
      if (value.item !== 'comment' || typeof value.message !== 'string') continue;
      const commentId = String(value.comment_id ?? value.id ?? '');
      const senderId = String((value.from as { id?: string } | undefined)?.id ?? 'unknown');
      const pageId = String(entry.id ?? '');
      const channel = await findChannelByExternalId('facebook_comment', pageId);
      if (!channel || !commentId) continue;
      if (!(await recordWebhookEvent(channel.workspace_id, 'facebook_comment', commentId, value))) continue;
      await query(
        channel.workspace_id,
        `INSERT INTO comments (workspace_id, platform_post_id, platform_comment_id, body, replied)
         VALUES ($1, $2, $3, $4, FALSE)`,
        [channel.workspace_id, String(value.post_id ?? ''), commentId, value.message],
      );
      const customer = await findOrCreateCustomer(
        channel.workspace_id,
        'facebook_comment',
        senderId,
        (value.from as { name?: string } | undefined)?.name,
      );
      const conversationId = await findOrCreateConversation(channel.workspace_id, channel.id, customer.id);
      await saveIncomingMessage(channel.workspace_id, conversationId, value.message, commentId);
      // Post attribution (05-post-attribution.sql): link this conversation
      // to the scheduled post the comment belongs to, so per-post
      // analytics can count chats/orders. Best-effort — a failure here
      // must never break the webhook.
      await recordAttributionForPlatformPost(
        { query: (text: string, params?: unknown[]) => query(channel.workspace_id, text, params ?? []) },
        channel.workspace_id,
        String(value.post_id ?? ''),
        conversationId,
        'comment',
      ).catch((err) => console.error('[webhook/meta] post attribution failed:', (err as Error).message));
      await enqueueMessage(channel.workspace_id, conversationId, value.message).catch((err) =>
        console.error('[webhook/meta] enqueue failed:', (err as Error).message),
      );
    }
  }

  // Always 200 — Meta retries on anything else, and duplicates are deduped above.
  res.sendStatus(200);
});

// ---------------------------------------------------------------------------
// Website live chat
// ---------------------------------------------------------------------------

/**
 * POST /api/webhooks/webchat — { externalId, senderId, name?, text }
 * externalId identifies the connected webchat channel (site). If WEBCHAT_SECRET
 * is configured, callers must send it as header x-webchat-secret.
 */
webhooksRouter.post('/webchat', async (req: AuthRequest, res: Response) => {
  const { externalId, senderId, name, text } = (req.body ?? {}) as {
    externalId?: string;
    senderId?: string;
    name?: string;
    text?: string;
  };
  if (!externalId || !senderId || !text) {
    res.status(400).json({ error: 'externalId, senderId and text are required' });
    return;
  }
  if (config.webchatSecret && req.headers['x-webchat-secret'] !== config.webchatSecret) {
    res.status(403).json({ error: 'Invalid webchat secret' });
    return;
  }
  const channel = await findChannelByExternalId('webchat', externalId);
  if (!channel) {
    res.status(404).json({ error: 'Webchat channel not connected' });
    return;
  }
  const eventId = `webchat-${senderId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await recordWebhookEvent(channel.workspace_id, 'webchat', eventId, req.body);
  const customer = await findOrCreateCustomer(channel.workspace_id, 'webchat', senderId, name);
  const conversationId = await findOrCreateConversation(channel.workspace_id, channel.id, customer.id);
  await saveIncomingMessage(channel.workspace_id, conversationId, text);
  await enqueueMessage(channel.workspace_id, conversationId, text).catch((err) =>
    console.error('[webhook/webchat] enqueue failed:', (err as Error).message),
  );
  res.status(200).json({ conversationId });
});

// ---------------------------------------------------------------------------
// WhatsApp Cloud API (Phase 2 — needs WhatsApp approval)
// ---------------------------------------------------------------------------

/**
 * GET /api/webhooks/whatsapp — WhatsApp verification handshake.
 * Token from WHATSAPP_VERIFY_TOKEN, falling back to META_VERIFY_TOKEN.
 */
webhooksRouter.get('/whatsapp', (req: AuthRequest, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const verifyToken = config.whatsappVerifyToken || config.meta.verifyToken;
  if (mode === 'subscribe' && token === verifyToken) {
    res.status(200).send(String(challenge ?? ''));
    return;
  }
  res.sendStatus(403);
});

/**
 * POST /api/webhooks/whatsapp — WhatsApp Cloud API shape:
 * body.entry[].changes[].value.messages[] with from + text.body;
 * value.metadata.phone_number_id identifies the channel by external_id.
 */
webhooksRouter.post('/whatsapp', async (req: AuthRequest, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const entries = Array.isArray(body.entry) ? (body.entry as Record<string, unknown>[]) : [];

  for (const entry of entries) {
    const changes = Array.isArray(entry.changes) ? (entry.changes as Record<string, unknown>[]) : [];
    for (const change of changes) {
      const value = (change.value ?? {}) as Record<string, unknown>;
      const metadata = (value.metadata ?? {}) as Record<string, unknown>;
      const phoneNumberId = String(metadata.phone_number_id ?? '');
      const messages = Array.isArray(value.messages) ? (value.messages as Record<string, unknown>[]) : [];
      if (!phoneNumberId || messages.length === 0) continue;
      const channel = await findChannelByExternalId('whatsapp', phoneNumberId);
      if (!channel) continue; // Unknown number — not connected to any workspace.
      for (const msg of messages) {
        const from = String(msg.from ?? '');
        const text = (msg.text as { body?: string } | undefined)?.body ?? (typeof msg.text === 'string' ? msg.text : '');
        if (!from || !text) continue;
        const eventId = String(msg.id ?? `wa-${from}-${Date.now()}`);
        if (!(await recordWebhookEvent(channel.workspace_id, 'whatsapp', eventId, msg))) continue; // duplicate
        const customer = await findOrCreateCustomer(
          channel.workspace_id,
          'whatsapp',
          from,
          (value.contacts as { profile?: { name?: string } }[] | undefined)?.[0]?.profile?.name,
        );
        const conversationId = await findOrCreateConversation(channel.workspace_id, channel.id, customer.id);
        await saveIncomingMessage(channel.workspace_id, conversationId, text, eventId);
        await enqueueMessage(channel.workspace_id, conversationId, text).catch((err) =>
          console.error('[webhook/whatsapp] enqueue failed:', (err as Error).message),
        );
      }
    }
  }

  // Always 200 — WhatsApp retries on anything else, duplicates are deduped above.
  res.sendStatus(200);
});

// ---------------------------------------------------------------------------
// TikTok comments (Phase 2 — needs TikTok approval; DM only after approval)
// ---------------------------------------------------------------------------

interface TikTokCommentInput {
  postId: string;
  commentId: string;
  userId: string;
  userName?: string;
  text: string;
}

/** Collect TikTok comments from a flat body or a TikTok-style entry payload. */
function parseTikTokComments(body: Record<string, unknown>): TikTokCommentInput[] {
  const out: TikTokCommentInput[] = [];
  const push = (raw: Record<string, unknown>): void => {
    const postId = String(raw.postId ?? raw.post_id ?? raw.video_id ?? '');
    const commentId = String(raw.commentId ?? raw.comment_id ?? raw.id ?? '');
    const userId = String(raw.userId ?? raw.user_id ?? (raw.user as { id?: string } | undefined)?.id ?? 'unknown');
    const userName = (raw.userName as string | undefined) ?? (raw.user_name as string | undefined) ?? (raw.user as { name?: string; nickname?: string } | undefined)?.name ?? (raw.user as { nickname?: string } | undefined)?.nickname;
    const text = String(raw.text ?? raw.comment ?? raw.message ?? '');
    if (commentId && text) out.push({ postId, commentId, userId, userName, text });
  };
  // Flat shape: { postId, commentId, userId, userName, text }
  if (body.commentId ?? body.comment_id) push(body);
  // TikTok-style: entry[].changes[].value (comment fields) or entry[].comments[]
  const entries = Array.isArray(body.entry) ? (body.entry as Record<string, unknown>[]) : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry.changes) ? (entry.changes as Record<string, unknown>[]) : [];
    for (const change of changes) push((change.value ?? {}) as Record<string, unknown>);
    const comments = Array.isArray(entry.comments) ? (entry.comments as Record<string, unknown>[]) : [];
    for (const c of comments) push(c);
  }
  // data[] shape
  const data = Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : [];
  for (const d of data) push(d);
  return out;
}

/** Find the TikTok channel + workspace for a comment (via the linked scheduled post, if any). */
async function findTikTokChannel(postId: string): Promise<{ id: string; workspace_id: string } | null> {
  if (postId) {
    const { rows } = await pool.query(
      `SELECT sp.workspace_id FROM scheduled_posts sp
       WHERE sp.platform_post_id = $1 ORDER BY sp.created_at DESC LIMIT 1`,
      [postId],
    );
    const workspaceId = (rows[0] as { workspace_id?: string } | undefined)?.workspace_id;
    if (workspaceId) {
      const ch = await pool.query(
        "SELECT id, workspace_id FROM channels WHERE platform = 'tiktok' AND workspace_id = $1 ORDER BY created_at DESC LIMIT 1",
        [workspaceId],
      );
      if (ch.rows.length > 0) return ch.rows[0] as { id: string; workspace_id: string };
      // Post is known but no TikTok channel is connected for that workspace.
      return null;
    }
  }
  // No linked post: fall back to any connected TikTok channel (single-workspace setups).
  const { rows } = await pool.query(
    "SELECT id, workspace_id FROM channels WHERE platform = 'tiktok' ORDER BY created_at DESC LIMIT 1",
  );
  return (rows[0] as { id: string; workspace_id: string } | undefined) ?? null;
}

/** POST /api/webhooks/tiktok — comment webhook (flat or TikTok-style entry format). */
webhooksRouter.post('/tiktok', async (req: AuthRequest, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const comments = parseTikTokComments(body);
  if (comments.length === 0) {
    res.status(400).json({ error: 'No TikTok comment found in payload (need commentId and text)' });
    return;
  }
  let accepted = 0;
  for (const comment of comments) {
    const channel = await findTikTokChannel(comment.postId);
    if (!channel) continue; // Unknown post / no TikTok channel connected.
    if (!(await recordWebhookEvent(channel.workspace_id, 'tiktok', comment.commentId, comment))) continue; // duplicate
    await query(
      channel.workspace_id,
      `INSERT INTO comments (workspace_id, platform_post_id, platform_comment_id, body, replied)
       VALUES ($1, $2, $3, $4, FALSE)`,
      [channel.workspace_id, comment.postId || null, comment.commentId, comment.text],
    );
    const customer = await findOrCreateCustomer(channel.workspace_id, 'tiktok', comment.userId, comment.userName);
    const conversationId = await findOrCreateConversation(channel.workspace_id, channel.id, customer.id);
    await saveIncomingMessage(channel.workspace_id, conversationId, comment.text, comment.commentId);
    // Post attribution (05-post-attribution.sql) — same as Facebook
    // comments above; best-effort, never breaks the webhook.
    await recordAttributionForPlatformPost(
      { query: (text: string, params?: unknown[]) => query(channel.workspace_id, text, params ?? []) },
      channel.workspace_id,
      comment.postId || null,
      conversationId,
      'comment',
    ).catch((err) => console.error('[webhook/tiktok] post attribution failed:', (err as Error).message));
    await enqueueMessage(channel.workspace_id, conversationId, comment.text).catch((err) =>
      console.error('[webhook/tiktok] enqueue failed:', (err as Error).message),
    );
    accepted += 1;
  }
  res.status(200).json({ accepted });
});
