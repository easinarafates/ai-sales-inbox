import { Router, type Response } from 'express';
import { waitUntil } from '@vercel/functions';
import { config } from '../config';
import { pool, query, queryOne } from '../db/pool';
import type { AuthRequest } from '../types';
import { enqueueMessage } from '../queue/client';
import { recordAttributionForPlatformPost } from '../analytics/attribution';
import { enrichCustomerProfileIfNeeded } from '../channels/meta-profile';
import { inferGenderFromName } from '../customers/gender';
import { decryptToken } from '../db/crypto';
import { sendMarkSeen } from '../channels/meta-send';
import {
  applyDotCommand,
  getWorkspaceOwnerPsid,
  parseDotCommand,
  sendModeConfirmation,
} from '../inbox/dot-commands';

export const webhooksRouter = Router();

// ---------------------------------------------------------------------------
// Shared helpers (used by Meta + webchat)
// ---------------------------------------------------------------------------

interface CustomerRow {
  id: string;
  name: string | null;
  phone: string | null;
  gender: string | null;
  name_manually_set: boolean | null;
  picture_url: string | null;
  picture_source: string | null;
  channel_identities: unknown;
}

/**
 * Find a customer by a channel identity, or create one. Identity shape: {platform, senderId, name?}.
 *
 * Gender is inferred from the name at creation (migration 23) — the only
 * signal Meta gives us (no gender field, no photo). An existing customer's
 * gender is NEVER overwritten here: if the owner set it by hand in the
 * Inbox, that value stands, and a customer created before this feature
 * keeps 'unknown' until the one-off backfill fills it. When the name
 * arrives later (Meta profile enrich), the enrich step fills the gender
 * from the new name — see channels/meta-profile.ts.
 */
async function findOrCreateCustomer(
  workspaceId: string,
  platform: string,
  senderId: string,
  name?: string,
): Promise<CustomerRow> {
  const identity = JSON.stringify([{ platform, senderId, name: name ?? null }]);
  // Match if any stored identity has this platform+senderId.
  const lookup = () =>
    queryOne<CustomerRow>(
      workspaceId,
      `SELECT id, name, phone, gender, name_manually_set, picture_url, picture_source, channel_identities FROM customers
       WHERE workspace_id = $1 AND channel_identities @> $2::jsonb LIMIT 1`,
      [workspaceId, JSON.stringify([{ platform, senderId }])],
    );
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await lookup();
    if (existing) return existing;
    // Race guard: the unique index on customers.primary_identity
    // (migration 16) makes a concurrent duplicate INSERT lose with
    // ON CONFLICT DO NOTHING, and the next loop pass re-reads the
    // winner instead of returning a second row for the same PSID.
    const { rows } = await query<CustomerRow>(
      workspaceId,
      'INSERT INTO customers (workspace_id, name, gender, channel_identities) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT DO NOTHING RETURNING id, name, phone, gender, name_manually_set, picture_url, picture_source, channel_identities',
      [workspaceId, name ?? null, inferGenderFromName(name ?? null), identity],
    );
    if (rows[0]) return rows[0];
  }
  const found = await lookup();
  if (found) return found;
  throw new Error('findOrCreateCustomer: could not create or find a customer');
}

async function findOrCreateConversation(
  workspaceId: string,
  channelId: string | null,
  customerId: string,
): Promise<string> {
  // One customer + one channel = one chat. Scoped by channel_id, so a
  // Messenger chat and an Instagram chat for the same person stay
  // separate (replies must go out on the platform they came in on).
  const lookupLatest = () =>
    queryOne<{ id: string; status: string }>(
      workspaceId,
      `SELECT id, status FROM conversations
       WHERE workspace_id = $1 AND customer_id = $2 AND channel_id IS NOT DISTINCT FROM $3
       ORDER BY updated_at DESC LIMIT 1`,
      [workspaceId, customerId, channelId],
    );
  for (let attempt = 0; attempt < 3; attempt++) {
    const latest = await lookupLatest();
    if (latest?.status === 'open') return latest.id;
    // A 'waiting' chat stays waiting until the OWNER clears it
    // (reopen / done in the Inbox) — a new message from the customer
    // must not silently reopen it and restart the AI.
    if (latest?.status === 'waiting') return latest.id;
    if (latest) {
      // A new message REOPENS a done/snoozed chat instead of spawning
      // a second chat for the same customer. The NOT EXISTS guard +
      // the partial unique index (migration 16) keep two open chats
      // from ever existing; a lost race just re-reads the winner.
      try {
        const { rows } = await query<{ id: string }>(
          workspaceId,
          `UPDATE conversations SET status = 'open', snooze_until = NULL, updated_at = now()
           WHERE workspace_id = $1 AND id = $2 AND status <> 'open' AND status <> 'waiting'
             AND NOT EXISTS (
               SELECT 1 FROM conversations
               WHERE workspace_id = $1 AND customer_id = $3
                 AND channel_id IS NOT DISTINCT FROM $4 AND status = 'open'
             )
           RETURNING id`,
          [workspaceId, latest.id, customerId, channelId],
        );
        if (rows[0]) return rows[0].id;
      } catch (err) {
        // 23505 = a concurrent insert reopened/created the open chat
        // first; anything else is a real error and must surface.
        const code = (err as { code?: string }).code ?? '';
        const msg = (err as Error).message ?? '';
        if (code !== '23505' && !msg.includes('duplicate key')) throw err;
      }
      continue;
    }
    const { rows } = await query<{ id: string }>(
      workspaceId,
      `INSERT INTO conversations (workspace_id, channel_id, customer_id, status, mode)
       VALUES ($1, $2, $3, 'open', 'ai') ON CONFLICT DO NOTHING RETURNING id`,
      [workspaceId, channelId, customerId],
    );
    if (rows[0]) return rows[0].id;
    // Lost the race to a concurrent insert — loop re-reads the winner.
  }
  const fallback = await lookupLatest();
  if (fallback) return fallback.id;
  throw new Error('findOrCreateConversation: could not create or find a conversation');
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
): Promise<{ id: string; workspace_id: string; token_encrypted: string | null; user_token_encrypted: string | null; external_id: string; source_id: string | null } | null> {
  const { rows } = await pool.query(
    'SELECT id, workspace_id, token_encrypted, user_token_encrypted, external_id, source_id FROM channels WHERE platform = $1 AND external_id = $2 ORDER BY created_at DESC LIMIT 1',
    [platform, externalId],
  );
  return (rows[0] as { id: string; workspace_id: string; token_encrypted: string | null; user_token_encrypted: string | null; external_id: string; source_id: string | null } | undefined) ?? null;
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
      const message = event.message as { mid?: string; text?: string; is_echo?: boolean; app_id?: string } | undefined;
      const platform = (body.object as string) === 'instagram' ? 'instagram' : 'messenger';

      // --- Message echoes: the owner replying AS the Page ---
      // Meta delivers a human's Page-Inbox reply as a message echo:
      // sender = the Page, recipient = the customer, and (for the
      // legacy shape) event.message_echoes instead of event.message.
      // An echo WITH an app_id came from an app (including our own
      // sends) — only an echo WITHOUT app_id is a human owner typing
      // in Page Inbox, so only those may toggle the AI.
      const echoRaw = (event as Record<string, unknown>).message_echoes as
        | { mid?: string; text?: string; app_id?: string }
        | undefined;
      const echo = echoRaw ?? (message?.is_echo ? message : undefined);
      if (echo && typeof echo.text === 'string') {
        const pageId = sender?.id ?? '';
        const customerPsid = recipient?.id ?? '';
        if (!pageId || !customerPsid) continue;
        const cmd = parseDotCommand(echo.text);
        if (!cmd) continue; // ordinary echoes are not our business
        if (echo.app_id) continue; // an app sent it — never a human owner
        const channel = await findChannelByExternalId(platform, pageId);
        if (!channel) continue; // Unknown page — not connected to any workspace.
        const echoMid = echo.mid ?? `echo-${customerPsid}-${Date.now()}`;
        if (!(await recordWebhookEvent(channel.workspace_id, platform, echoMid, event))) continue; // duplicate
        const customer = await findOrCreateCustomer(channel.workspace_id, platform, customerPsid);
        const conversationId = await findOrCreateConversation(channel.workspace_id, channel.id, customer.id);
        const newMode = await applyDotCommand(channel.workspace_id, conversationId, cmd);
        if (newMode) await sendModeConfirmation(channel.workspace_id, conversationId, newMode);
        continue;
      }

      if (!sender?.id || !message?.text) continue;
      // The channel is the page/account that received the message.
      const channel = await findChannelByExternalId(platform, recipient?.id ?? '');
      if (!channel) continue; // Unknown page — not connected to any workspace.
      const eventId = message.mid ?? `${sender.id}-${Date.now()}`;
      if (!(await recordWebhookEvent(channel.workspace_id, platform, eventId, event))) continue; // duplicate

      // --- Seen FIRST: the customer sees the Page read their message ---
      // A real Graph read receipt (POST /{page-id}/messages
      // {recipient, sender_action:'mark_seen'}), fired immediately —
      // before the dot-command check, the profile enrich, the save, and
      // the AI debounce — so the Seen tick shows within ~a second of the
      // customer sending, while the AI is still thinking. Fire-and-forget
      // via waitUntil (keeps the serverless function alive for it on
      // Vercel; a no-op locally): a failed receipt is logged and never
      // blocks the message or the reply.
      if (channel.token_encrypted) {
        let pageToken: string | null = null;
        try {
          pageToken = decryptToken(channel.token_encrypted);
        } catch {
          pageToken = null;
        }
        if (pageToken) {
          waitUntil(
            sendMarkSeen({
              platform: platform as 'messenger' | 'instagram',
              nodeId: channel.external_id,
              pageToken,
              recipientId: sender.id,
            })
              .then((r) => {
                if (!r.ok) console.error('[webhook/meta] mark_seen failed:', r.error ?? 'unknown');
              })
              .catch((err) => console.error('[webhook/meta] mark_seen failed:', (err as Error).message)),
          );
        }
      }

      // --- Dot commands from a personal account ---
      // Only the sender the workspace marked as its owner may toggle
      // the AI this way. A random customer typing '.' is ignored
      // silently: the message is saved so the owner can see it, but it
      // is never enqueued for an AI reply and never toggles anything —
      // the customer is never told the command exists.
      const dotCmd = parseDotCommand(message.text);
      if (dotCmd) {
        const ownerPsid = await getWorkspaceOwnerPsid(channel.workspace_id);
        const customer = await findOrCreateCustomer(channel.workspace_id, platform, sender.id);
        const conversationId = await findOrCreateConversation(channel.workspace_id, channel.id, customer.id);
        if (ownerPsid && ownerPsid === sender.id) {
          const newMode = await applyDotCommand(channel.workspace_id, conversationId, dotCmd);
          if (newMode) await sendModeConfirmation(channel.workspace_id, conversationId, newMode);
        } else {
          await saveIncomingMessage(channel.workspace_id, conversationId, message.text, message.mid);
        }
        continue;
      }

      const customer = await findOrCreateCustomer(channel.workspace_id, platform, sender.id);
      const conversationId = await findOrCreateConversation(channel.workspace_id, channel.id, customer.id);
      await saveIncomingMessage(channel.workspace_id, conversationId, message.text, message.mid);
      await enqueueMessage(channel.workspace_id, conversationId, message.text).catch((err) =>
        console.error('[webhook/meta] enqueue failed:', (err as Error).message),
      );
      // --- Profile enrich AFTER save/enqueue (fire-and-forget) ---
      // It used to run awaited BEFORE the save (~1-2s of Graph calls on
      // every message whose photo is missing — the direct PSID read
      // 400s for this sender, then the conversations fallback runs).
      // The reply does not need the name/photo, so it must never sit on
      // the reply's critical path: it now runs in the background via
      // waitUntil (the function stays alive for it on Vercel), and the
      // Inbox picks the name/photo up on its next refresh. A failed
      // enrich is logged and never blocks anything.
      if (channel.token_encrypted || channel.user_token_encrypted) {
        // Capture the sender id here: inside the async closure below TS
        // can no longer narrow sender.id to string (the guard above did).
        const senderId = sender.id;
        waitUntil(
          (async () => {
            let pageToken: string | null = null;
            try {
              pageToken = channel.token_encrypted ? decryptToken(channel.token_encrypted) : null;
            } catch {
              pageToken = null;
            }
            let userToken: string | null = null;
            try {
              userToken = channel.user_token_encrypted ? decryptToken(channel.user_token_encrypted) : null;
            } catch {
              userToken = null;
            }
            await enrichCustomerProfileIfNeeded({
              workspaceId: channel.workspace_id,
              platform: platform as 'messenger' | 'instagram',
              senderId,
              customerId: customer.id,
              customerName: customer.name,
              customerNameManuallySet: customer.name_manually_set,
              customerGender: customer.gender,
              customerPictureUrl: customer.picture_url,
              // A manual photo (picture_source='manual') is never touched
              // by the Meta refresh — see meta-profile.ts.
              customerPictureSource: customer.picture_source,
              pageToken,
              userToken,
              // Messenger: external_id IS the Page ID. Instagram: the Page ID
              // lives in source_id (external_id is the IG user ID). The Page
              // ID powers the conversations-endpoint profile fallback.
              pageId: platform === 'instagram' ? (channel.source_id ?? null) : (channel.external_id ?? recipient?.id ?? null),
            });
          })().catch((err) => console.error('[webhook/meta] profile enrich failed:', (err as Error).message)),
        );
      }
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
