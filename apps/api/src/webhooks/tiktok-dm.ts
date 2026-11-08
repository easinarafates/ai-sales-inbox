/**
 * TikTok DM webhook (TikTok DM / image-search / Chrome-extension module).
 *
 * Mirrors the TikTok COMMENTS handler in webhooks/routes.ts and the
 * WhatsApp handler there:
 *  - GET  /api/webhooks/tiktok-dm — TikTok verification handshake
 *    (hub.mode=subscribe + verify token → hub.challenge). The token is
 *    TIKTOK_DM_VERIFY_TOKEN, falling back to META_VERIFY_TOKEN.
 *  - POST /api/webhooks/tiktok-dm — inbound TikTok DM receiver.
 *
 * APPROVAL GATE (same pattern as WhatsApp / TikTok comments):
 * TIKTOK_DM_APPROVED must be 'true' or the POST is rejected with 403 and
 * NOTHING is stored, queued, or answered. Until TikTok approves DM
 * (Messaging API) access, the channel saves as pending_approval (see
 * channels/routes.ts — 'tiktok_dm' registration, applied by the
 * integrator; integration-notes.md) and DMs never send or receive.
 *
 * A DM is routed into the unified inbox as a `tiktok_dm` conversation:
 * customer identity platform 'tiktok_dm', conversation + inbound message
 * saved, then enqueued for the AI agent exactly like a Messenger message.
 * Duplicates are blocked via webhook_events UNIQUE
 * (workspace_id, platform, platform_event_id) — the same message id twice
 * is stored once and never answered twice.
 *
 * Outbound DMs: sendTikTokDM() below calls the REAL TikTok for Business
 * "Business Messaging" API (business-api.tiktok.com/open_api/v1.3) —
 * a separate product from Login Kit with its own Business Account
 * authorization (business_id + Access-Token) and its own approval.
 * Without approval / credentials it fails honestly; it never claims a
 * DM was sent. Reply-only: the customer must message first (48h window).
 *
 * This router is mounted by the integrator — see integration-notes.md in
 * this folder for the exact lines (apps/api/src/index.ts).
 */
import { Router, type Response } from 'express';
import { config } from '../config';
import { pool, query, queryOne } from '../db/pool';
import type { AuthRequest } from '../types';
import { enqueueMessage } from '../queue/client';
import {
  getTikTokBusinessConfig,
  resolveTikTokDMConversationId,
  sendTikTokBusinessDM,
  sendTikTokBusinessDMImage,
} from '../channels/tiktok';

export const tiktokDmRouter = Router();

/** True only when TikTok has approved DM access (env TIKTOK_DM_APPROVED=true). */
export function isTikTokDMApproved(): boolean {
  return config.tiktokDmApproved === true;
}

// ---------------------------------------------------------------------------
// Shared helpers (same shapes as webhooks/routes.ts, workspace-scoped)
// ---------------------------------------------------------------------------

interface CustomerRow {
  id: string;
  name: string | null;
  phone: string | null;
  channel_identities: unknown;
}

/** Find a customer by a channel identity, or create one. Identity shape: {platform, senderId, name?}. */
export async function findOrCreateCustomer(
  workspaceId: string,
  platform: string,
  senderId: string,
  name?: string,
): Promise<CustomerRow> {
  const identity = JSON.stringify([{ platform, senderId, name: name ?? null }]);
  const lookup = () =>
    queryOne<CustomerRow>(
      workspaceId,
      `SELECT id, name, phone, channel_identities FROM customers
       WHERE workspace_id = $1 AND channel_identities @> $2::jsonb LIMIT 1`,
      [workspaceId, JSON.stringify([{ platform, senderId }])],
    );
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await lookup();
    if (existing) return existing;
    // Race guard: unique index on customers.primary_identity
    // (migration 16) — a concurrent duplicate INSERT loses with
    // ON CONFLICT DO NOTHING and the next pass re-reads the winner.
    const { rows } = await query<CustomerRow>(
      workspaceId,
      'INSERT INTO customers (workspace_id, name, channel_identities) VALUES ($1, $2, $3::jsonb) ON CONFLICT DO NOTHING RETURNING id, name, phone, channel_identities',
      [workspaceId, name ?? null, identity],
    );
    if (rows[0]) return rows[0];
  }
  const found = await lookup();
  if (found) return found;
  throw new Error('findOrCreateCustomer: could not create or find a customer');
}

export async function findOrCreateConversation(
  workspaceId: string,
  channelId: string | null,
  customerId: string,
): Promise<string> {
  // One customer + one channel = one chat (same fix as
  // webhooks/routes.ts): scoped by channel_id, reopens done/snoozed
  // chats, and retries on a lost race (migration 16 unique index).
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
    // A 'waiting' chat stays waiting until the OWNER clears it — a new
    // message must not silently reopen it and restart the AI.
    if (latest?.status === 'waiting') return latest.id;
    if (latest) {
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
  }
  const fallback = await lookupLatest();
  if (fallback) return fallback.id;
  throw new Error('findOrCreateConversation: could not create or find a conversation');
}

export async function saveIncomingMessage(
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
export async function recordWebhookEvent(
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
  // Only a CONNECTED channel may receive webhooks (same reason as
  // webhooks/routes.ts: a disconnected duplicate must not win).
  const { rows } = await pool.query(
    "SELECT id, workspace_id FROM channels WHERE platform = $1 AND external_id = $2 AND status = 'connected' ORDER BY created_at DESC LIMIT 1",
    [platform, externalId],
  );
  return (rows[0] as { id: string; workspace_id: string } | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// Payload parsing — flat, TikTok-style entry, and data[] shapes
// ---------------------------------------------------------------------------

export interface TikTokDMInput {
  messageId: string;
  senderId: string;
  senderName?: string;
  text: string;
  /** The business / recipient TikTok account id (identifies the channel). */
  recipientId: string;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Collect TikTok DMs from a flat body, a Meta-style entry payload, or data[]. */
export function parseTikTokDMs(body: Record<string, unknown>): TikTokDMInput[] {
  const out: TikTokDMInput[] = [];
  const push = (raw: Record<string, unknown>): void => {
    const messageObj = raw.message as { mid?: string; text?: string } | string | undefined;
    const messageId = String(
      raw.messageId ?? raw.message_id ?? raw.mid ??
        (typeof messageObj === 'object' ? messageObj?.mid : undefined) ??
        raw.id ?? '',
    );
    const senderId = String(
      raw.senderId ?? raw.sender_id ?? raw.userId ?? raw.user_id ??
        (raw.sender as { id?: string } | undefined)?.id ??
        (raw.user as { id?: string } | undefined)?.id ?? 'unknown',
    );
    const senderName =
      (raw.senderName as string | undefined) ?? (raw.sender_name as string | undefined) ??
      (raw.userName as string | undefined) ?? (raw.user_name as string | undefined) ??
      (raw.sender as { name?: string; nickname?: string } | undefined)?.name ??
      (raw.user as { name?: string; nickname?: string } | undefined)?.nickname;
    const text = String(
      raw.text ??
        (typeof messageObj === 'string' ? messageObj : messageObj?.text) ??
        raw.body ?? '',
    );
    const recipientId = String(
      raw.recipientId ?? raw.recipient_id ?? raw.accountId ?? raw.account_id ??
        raw.businessAccountId ?? raw.business_account_id ??
        (raw.recipient as { id?: string } | undefined)?.id ?? '',
    );
    if (messageId && text) out.push({ messageId, senderId, senderName, text, recipientId });
  };
  // Flat shape: { messageId, senderId, senderName, text, recipientId }
  if (body.messageId ?? body.message_id ?? body.mid) push(body);
  // Meta-style: entry[].messaging[] (sender/recipient/message{mid,text})
  const entries = Array.isArray(body.entry) ? (body.entry as Record<string, unknown>[]) : [];
  for (const entry of entries) {
    const messaging = Array.isArray(entry.messaging) ? (entry.messaging as Record<string, unknown>[]) : [];
    for (const m of messaging) push(m);
    const messages = Array.isArray(entry.messages) ? (entry.messages as Record<string, unknown>[]) : [];
    for (const m of messages) push(m);
  }
  // data[] shape
  const data = Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : [];
  for (const d of data) push(d);
  return out;
}

/**
 * Find the TikTok DM channel + workspace for a DM.
 * 1) A 'tiktok_dm' channel whose external_id is the recipient account.
 * 2) Any connected 'tiktok_dm' channel (single-workspace setups).
 * 3) The workspace's 'tiktok' channel — a DM belongs to the same TikTok
 *    account as its comments channel, so this keeps DMs working when only
 *    the comments channel was connected first.
 */
export async function findTikTokDMChannel(
  recipientId: string,
): Promise<{ id: string; workspace_id: string } | null> {
  if (recipientId) {
    const byRecipient = await findChannelByExternalId('tiktok_dm', recipientId);
    if (byRecipient) return byRecipient;
  }
  const { rows } = await pool.query(
    "SELECT id, workspace_id FROM channels WHERE platform = 'tiktok_dm' ORDER BY created_at DESC LIMIT 1",
  );
  if (rows.length > 0) return rows[0] as { id: string; workspace_id: string };
  const comments = await pool.query(
    "SELECT id, workspace_id FROM channels WHERE platform = 'tiktok' ORDER BY created_at DESC LIMIT 1",
  );
  return (comments.rows[0] as { id: string; workspace_id: string } | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// Verification handshake + DM receiver
// ---------------------------------------------------------------------------

/** GET /api/webhooks/tiktok-dm — TikTok verification handshake. */
tiktokDmRouter.get('/tiktok-dm', (req: AuthRequest, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const verifyToken = config.tiktokDmVerifyToken || config.meta.verifyToken;
  if (mode === 'subscribe' && token === verifyToken) {
    res.status(200).send(String(challenge ?? ''));
    return;
  }
  res.sendStatus(403);
});

/** POST /api/webhooks/tiktok-dm — inbound TikTok DM (flat or TikTok-style entry format). */
tiktokDmRouter.post('/tiktok-dm', async (req: AuthRequest, res: Response) => {
  // Approval gate: without TikTok DM approval nothing is received, stored,
  // or answered. (The channel itself saves as pending_approval.)
  if (!isTikTokDMApproved()) {
    res.status(403).json({
      error: 'TikTok DM is not approved yet (TIKTOK_DM_APPROVED is not true). DM ignored — nothing was stored.',
      approvalRequired: true,
    });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const dms = parseTikTokDMs(body);
  if (dms.length === 0) {
    res.status(400).json({ error: 'No TikTok DM found in payload (need messageId and text)' });
    return;
  }
  let accepted = 0;
  for (const dm of dms) {
    const channel = await findTikTokDMChannel(dm.recipientId);
    if (!channel) continue; // Unknown account / no TikTok channel connected.
    if (!(await recordWebhookEvent(channel.workspace_id, 'tiktok_dm', dm.messageId, dm))) continue; // duplicate
    const customer = await findOrCreateCustomer(channel.workspace_id, 'tiktok_dm', dm.senderId, dm.senderName);
    const conversationId = await findOrCreateConversation(channel.workspace_id, channel.id, customer.id);
    await saveIncomingMessage(channel.workspace_id, conversationId, dm.text, dm.messageId);
    await enqueueMessage(channel.workspace_id, conversationId, dm.text).catch((err) =>
      console.error('[webhook/tiktok-dm] enqueue failed:', (err as Error).message),
    );
    accepted += 1;
  }
  res.status(200).json({ accepted });
});

// ---------------------------------------------------------------------------
// Outbound DM — REAL TikTok Business Messaging API client
// ---------------------------------------------------------------------------

export interface SendTikTokDMResult {
  /** True only when TikTok's Business Messaging API accepted the message (real message id returned). */
  sent: boolean;
  /** Always false now — the stub is gone; a failed send returns sent:false with TikTok's own error. */
  stub: boolean;
  reason?: 'not_approved' | 'not_configured' | 'no_conversation' | 'send_failed';
  messageId?: string;
  error?: string;
}

/**
 * Send a TikTok DM for real (TikTok for Business — Business Messaging
 * API, business-api.tiktok.com/open_api/v1.3/business/message/send/).
 *
 * Gates, in order (each fails honestly, never a fake send):
 *  1) TIKTOK_DM_APPROVED must be 'true' (TikTok's approval for the
 *     messaging product — the same gate as the inbound webhook).
 *  2) TIKTOK_BUSINESS_ACCESS_TOKEN + TIKTOK_BUSINESS_ID must be set —
 *     the Login Kit token can NEVER send a DM (different product, and
 *     the Login Kit open_id is not a business_id).
 *  3) The customer must have messaged first: the Business Messaging
 *     conversation is resolved from their TikTok user id (list +
 *     content/list); reply-only, 48h window, ~10 replies. No
 *     conversation → no send (TikTok forbids business-initiated DMs).
 *
 * On success TikTok returns a real message id. On failure the result
 * carries TikTok's own error message, and deliverOutgoingMessage marks
 * the message row 'failed' with it — the owner sees why, and the AI is
 * never charged for a failed send.
 */
export async function sendTikTokDM(
  workspaceId: string,
  recipientId: string,
  text: string,
): Promise<SendTikTokDMResult> {
  if (!isTikTokDMApproved()) {
    return {
      sent: false,
      stub: false,
      reason: 'not_approved',
      error: 'TikTok DM এখনো অনুমোদিত হয়নি — TikTok Business Messaging অনুমোদনের জন্য আবেদন করতে হবে (TikTok DM is not approved yet)',
    };
  }
  const cfg = getTikTokBusinessConfig();
  if (!cfg.configured) {
    return {
      sent: false,
      stub: false,
      reason: 'not_configured',
      error:
        'TikTok Business Messaging সেটআপ হয়নি — TIKTOK_BUSINESS_ACCESS_TOKEN আর TIKTOK_BUSINESS_ID দিতে হবে (TikTok for Business-এ আলাদা আবেদন করে পাওয়া যায়; Login Kit টোকেন দিয়ে DM পাঠানো যায় না)',
    };
  }
  const resolved = await resolveTikTokDMConversationId(cfg, recipientId);
  if (!resolved.ok) {
    return { sent: false, stub: false, reason: 'no_conversation', error: resolved.error };
  }
  const result = await sendTikTokBusinessDM(cfg, resolved.data.conversationId, text);
  if (!result.ok) {
    console.error('[tiktok-dm] Business Messaging send failed:', result.error);
    return { sent: false, stub: false, reason: 'send_failed', error: result.error };
  }
  return { sent: true, stub: false, messageId: result.data.messageId };
}

/**
 * Send a TikTok DM image for real (media/upload/ then send with
 * message_type IMAGE). Same gates as sendTikTokDM. Used by
 * deliverOutgoingImageMessage (product photos) on tiktok_dm chats.
 */
export async function sendTikTokDMImage(
  workspaceId: string,
  recipientId: string,
  image: Buffer,
): Promise<SendTikTokDMResult> {
  if (!isTikTokDMApproved()) {
    return { sent: false, stub: false, reason: 'not_approved', error: 'TikTok DM এখনো অনুমোদিত হয়নি (TikTok DM is not approved yet)' };
  }
  const cfg = getTikTokBusinessConfig();
  if (!cfg.configured) {
    return {
      sent: false,
      stub: false,
      reason: 'not_configured',
      error: 'TikTok Business Messaging সেটআপ হয়নি — TIKTOK_BUSINESS_ACCESS_TOKEN আর TIKTOK_BUSINESS_ID দিতে হবে',
    };
  }
  const resolved = await resolveTikTokDMConversationId(cfg, recipientId);
  if (!resolved.ok) {
    return { sent: false, stub: false, reason: 'no_conversation', error: resolved.error };
  }
  const result = await sendTikTokBusinessDMImage(cfg, resolved.data.conversationId, image);
  if (!result.ok) {
    console.error('[tiktok-dm] Business Messaging image send failed:', result.error);
    return { sent: false, stub: false, reason: 'send_failed', error: result.error };
  }
  return { sent: true, stub: false, messageId: result.data.messageId };
}
