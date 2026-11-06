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
 * Outbound DMs: sendTikTokDM() below is STUB-LOGGED ONLY until approval
 * (same as the other channels). It never claims a DM was sent. A real
 * TikTok Messaging API client plugs in here after approval.
 *
 * This router is mounted by the integrator — see integration-notes.md in
 * this folder for the exact lines (apps/api/src/index.ts).
 */
import { Router, type Response } from 'express';
import { config } from '../config';
import { pool, query, queryOne } from '../db/pool';
import type { AuthRequest } from '../types';
import { enqueueMessage } from '../queue/client';

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
async function findOrCreateCustomer(
  workspaceId: string,
  platform: string,
  senderId: string,
  name?: string,
): Promise<CustomerRow> {
  const identity = JSON.stringify([{ platform, senderId, name: name ?? null }]);
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
// Outbound DM — STUB-LOGGED ONLY until approval (same as other channels)
// ---------------------------------------------------------------------------

export interface SendTikTokDMResult {
  /** Always false until a real TikTok Messaging API client is wired in. */
  sent: boolean;
  /** True while this is a stub — the DM was only written to the log. */
  stub: boolean;
  reason: 'not_approved' | 'no_live_client';
}

/**
 * Send a TikTok DM. STUB ONLY: it logs the intent and returns
 * { sent: false, stub: true } — it NEVER claims a DM was sent, and it
 * never sends anything while TIKTOK_DM_APPROVED is false. After TikTok
 * approves DM access, a real TikTok Messaging API client plugs in here
 * (same pattern as the Meta send step) and `sent` becomes real.
 */
export async function sendTikTokDM(
  workspaceId: string,
  recipientId: string,
  text: string,
): Promise<SendTikTokDMResult> {
  if (!isTikTokDMApproved()) {
    console.log(
      `[tiktok-dm] STUB — TikTok DM not approved, DM NOT sent (workspace ${workspaceId}, to ${recipientId}): ${asString(text).slice(0, 80)}`,
    );
    return { sent: false, stub: true, reason: 'not_approved' };
  }
  console.log(
    `[tiktok-dm] STUB — no live TikTok Messaging API client yet, DM NOT sent (workspace ${workspaceId}, to ${recipientId}): ${asString(text).slice(0, 80)}`,
  );
  return { sent: false, stub: true, reason: 'no_live_client' };
}
