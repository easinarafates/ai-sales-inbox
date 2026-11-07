/**
 * Real Meta message send (Messenger + Instagram) — the outgoing leg of the
 * Inbox. Incoming messages arrive via the webhook; this module is how a
 * reply (AI auto-reply or a team member's manual reply) actually reaches
 * the customer.
 *
 * Messenger: POST /{page-id}/messages with the Page access token as Bearer,
 *   body {recipient:{id: <PSID>}, message:{text}}.
 * Instagram: POST /{ig-user-id}/messages with the Page access token as
 *   Bearer, body {recipient:{id: <IG SID>}, message:{text}}.
 * (Both are Graph v21.0 — GRAPH_BASE is imported from meta-oauth.ts so the
 * version stays in one place. META_GRAPH_BASE_URL overrides the base for
 * offline testing only; production always uses graph.facebook.com.)
 *
 * Honesty rules:
 * - A reply counts as sent ONLY when Graph returns a message_id.
 * - A failed send is recorded on the message row (delivery_status='failed'
 *   + delivery_error) and never pretends to be delivered; the AI path must
 *   not charge for it (see ai-agent/agent.ts).
 * - Meta only allows standard replies within 24h of the customer's last
 *   message (Graph error 551). That surfaces as windowExpired — callers
 *   must tell the team the customer has to message again first. No message
 *   tags are used.
 * - WhatsApp / TikTok are NOT sent here (different APIs); they fail
 *   with a clear error instead of silently "sending".
 * - facebook_comment channels ARE sent here: a reply to a Page-post
 *   comment is POST /{comment-id}/comments with the Page token (see
 *   sendFacebookCommentReply). It needs the pages_manage_engagement
 *   permission; without it Graph answers 200 and the reply is honestly
 *   marked failed, never pretended sent.
 * - Tokens are never put in a URL or a log line (Bearer header only).
 */
import { fetchWithTimeout } from '../ai-agent/http';
import { GRAPH_BASE } from './meta-oauth';
import { decryptToken } from '../db/crypto';
import { query, queryOne } from '../db/pool';

export interface MetaSendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
  /** Graph error code (e.g. 551 = 24h window closed, 190 = bad token). */
  code?: number;
  /** True when Graph error 551 says the 24-hour reply window has closed. */
  windowExpired?: boolean;
}

function sendGraphBase(): string {
  const override = (process.env.META_GRAPH_BASE_URL ?? '').replace(/\/$/, '');
  return override || GRAPH_BASE;
}

/** Graph base for other modules (post analysis). Same override rule. */
export function graphBaseUrl(): string {
  return sendGraphBase();
}

/**
 * Reply to one Facebook Page-post comment as the Page:
 * POST /{comment-id}/comments {message}. Needs pages_manage_engagement.
 * Never throws — every failure is returned as { ok: false, ... }.
 * Graph answers {id: "<the reply comment's id>"} on success.
 */
export async function sendFacebookCommentReply(input: {
  commentId: string;
  pageToken: string;
  text: string;
}): Promise<MetaSendResult> {
  const url = `${sendGraphBase()}/${encodeURIComponent(input.commentId)}/comments`;
  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.pageToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: input.text }),
      },
      15000,
    );
    const data = (await res.json().catch(() => null)) as {
      id?: string;
      error?: { message?: string; code?: number };
    } | null;
    if (res.ok && typeof data?.id === 'string') {
      return { ok: true, messageId: data.id };
    }
    const code = data?.error?.code;
    const message = data?.error?.message ?? `Meta Graph comment reply failed (HTTP ${res.status})`;
    return { ok: false, error: message, code };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * One generic JSON POST to Graph. Never throws — every failure is
 * returned as { ok: false, error, code } with Meta's own message.
 */
async function graphPostJson(
  url: string,
  pageToken: string,
  body: Record<string, unknown>,
  timeoutMs = 30000,
): Promise<{ ok: boolean; data: unknown; error?: string; code?: number }> {
  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${pageToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );
    const data = (await res.json().catch(() => null)) as {
      id?: string;
      post_id?: string;
      success?: boolean;
      error?: { message?: string; code?: number };
    } | null;
    if (!res.ok) {
      return {
        ok: false,
        data,
        error: data?.error?.message ?? `Meta Graph request failed (HTTP ${res.status})`,
        code: data?.error?.code,
      };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, data: null, error: (err as Error).message };
  }
}

export interface PageChannelRow {
  id: string;
  platform: string;
  external_id: string;
  token_encrypted: string | null;
}

/**
 * The workspace's connected Facebook Page channel (platform
 * 'messenger', status 'connected', with a stored Page token), most
 * recent first. Null when no Page is connected — callers must fail
 * honestly instead of pretending a publish/like happened.
 */
export async function getWorkspacePageChannel(workspaceId: string): Promise<PageChannelRow | null> {
  const channel = await queryOne<PageChannelRow>(
    workspaceId,
    `SELECT id, platform, external_id, token_encrypted FROM channels
     WHERE workspace_id = $1 AND platform = 'messenger' AND status = 'connected'
       AND token_encrypted IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`,
    [workspaceId],
  );
  return channel;
}

/** Decrypt a channel's stored Page token; null when it cannot be read. */
export function decryptPageToken(channel: PageChannelRow): string | null {
  if (!channel.token_encrypted) return null;
  try {
    return decryptToken(channel.token_encrypted);
  } catch {
    return null;
  }
}

export interface PagePostInput {
  /** Facebook Page ID. */
  pageId: string;
  /** Page access token (Bearer). */
  pageToken: string;
  caption: string | null;
  mediaUrls: string[];
  mediaType: string | null;
}

export interface PagePostResult extends MetaSendResult {
  /** Graph's real post/photo/video id — never a stub id. */
  platformPostId?: string;
}

/**
 * Publish one post to a Facebook Page for real (Graph v21.0, Page token).
 * Needs pages_manage_posts on the token.
 *
 * - text (or no media) → POST /{page-id}/feed {message}
 * - one image → POST /{page-id}/photos {url, caption}
 * - several images → each uploaded unpublished, then one feed post with
 *   attached_media (so the Page shows one post, not one per photo)
 * - video → POST /{page-id}/videos {file_url, description} (Graph
 *   processes the video after accepting it; the returned id is the video)
 * Media URLs must be publicly reachable (Vercel Blob URLs are; local
 * /api/uploads URLs are NOT — they need an auth token).
 * A post counts as published ONLY when Graph returns an id.
 */
export async function sendPagePost(input: PagePostInput): Promise<PagePostResult> {
  const caption = (input.caption ?? '').trim();
  const urls = input.mediaUrls ?? [];
  const mediaType = input.mediaType ?? (urls.length > 0 ? 'image' : 'text');
  const base = sendGraphBase();
  const pageId = encodeURIComponent(input.pageId);

  const idOf = (data: unknown): string | null => {
    const d = data as { id?: string; post_id?: string } | null;
    return typeof d?.post_id === 'string' ? d.post_id : typeof d?.id === 'string' ? d.id : null;
  };

  if (mediaType === 'text' || urls.length === 0) {
    const r = await graphPostJson(`${base}/${pageId}/feed`, input.pageToken, { message: caption });
    if (!r.ok) return { ok: false, error: r.error, code: r.code };
    const id = idOf(r.data);
    if (!id) return { ok: false, error: 'Facebook did not return a post id' };
    return { ok: true, messageId: id, platformPostId: id };
  }

  if (mediaType === 'image' && urls.length === 1) {
    const r = await graphPostJson(`${base}/${pageId}/photos`, input.pageToken, {
      url: urls[0],
      caption,
    });
    if (!r.ok) return { ok: false, error: r.error, code: r.code };
    const id = idOf(r.data);
    if (!id) return { ok: false, error: 'Facebook did not return a photo id' };
    return { ok: true, messageId: id, platformPostId: id };
  }

  if (mediaType === 'image') {
    const fbids: string[] = [];
    for (const u of urls) {
      const r = await graphPostJson(`${base}/${pageId}/photos`, input.pageToken, {
        url: u,
        published: false,
      });
      if (!r.ok) return { ok: false, error: r.error, code: r.code };
      const d = r.data as { id?: string } | null;
      if (typeof d?.id !== 'string') return { ok: false, error: 'Facebook did not return a photo id' };
      fbids.push(d.id);
    }
    const r = await graphPostJson(`${base}/${pageId}/feed`, input.pageToken, {
      message: caption,
      attached_media: fbids.map((id) => ({ media_fbid: id })),
    });
    if (!r.ok) return { ok: false, error: r.error, code: r.code };
    const id = idOf(r.data);
    if (!id) return { ok: false, error: 'Facebook did not return a post id' };
    return { ok: true, messageId: id, platformPostId: id };
  }

  if (mediaType === 'video') {
    const r = await graphPostJson(
      `${base}/${pageId}/videos`,
      input.pageToken,
      { file_url: urls[0], description: caption },
      60000,
    );
    if (!r.ok) return { ok: false, error: r.error, code: r.code };
    const id = idOf(r.data);
    if (!id) return { ok: false, error: 'Facebook did not return a video id' };
    return { ok: true, messageId: id, platformPostId: id };
  }

  return { ok: false, error: `Unsupported media type: ${mediaType}` };
}

/**
 * Like one Facebook object (a Page post or a comment) as the Page:
 * POST /{object-id}/likes with the Page token. Needs
 * pages_manage_engagement on the token. Graph answers {success: true};
 * an already-liked object is reported as ok with alreadyLiked=true
 * instead of an error.
 */
export async function likeGraphObject(input: {
  objectId: string;
  pageToken: string;
}): Promise<{ ok: boolean; alreadyLiked?: boolean; error?: string; code?: number }> {
  const r = await graphPostJson(
    `${sendGraphBase()}/${encodeURIComponent(input.objectId)}/likes`,
    input.pageToken,
    {},
  );
  if (r.ok) return { ok: true };
  if (r.error && /already/i.test(r.error)) return { ok: true, alreadyLiked: true };
  return { ok: false, error: r.error, code: r.code };
}

export interface MarkSeenResult {
  ok: boolean;
  error?: string;
  /** Graph error code (e.g. 190 = bad token). */
  code?: number;
}

/**
 * Mark one incoming Messenger/Instagram message as SEEN — a real Graph
 * read receipt: POST /{node-id}/messages
 * {recipient:{id}, sender_action:'mark_seen'} with the Page token.
 * Graph answers 200 {recipient_id} on success.
 *
 * This is what the customer sees as the "Seen" tick under their message.
 * Never throws — every failure is returned as { ok: false, ... }.
 * Callers must fire-and-forget it (see webhooks/routes.ts): a failed
 * read receipt must never block the message save or the AI reply.
 */
export async function sendMarkSeen(input: {
  platform: 'messenger' | 'instagram';
  /** Messenger: Page ID. Instagram: IG user ID (channel external_id). */
  nodeId: string;
  /** Page access token (Bearer). */
  pageToken: string;
  /** Messenger: customer PSID. Instagram: IG-scoped user ID. */
  recipientId: string;
}): Promise<MarkSeenResult> {
  const r = await graphPostJson(
    `${sendGraphBase()}/${encodeURIComponent(input.nodeId)}/messages`,
    input.pageToken,
    { recipient: { id: input.recipientId }, sender_action: 'mark_seen' },
    10000,
  );
  if (r.ok) return { ok: true };
  return { ok: false, error: r.error, code: r.code };
}

/**
 * Send one text message via the Meta Graph API. Never throws — every
 * failure is returned as { ok: false, error, code?, windowExpired? }.
 */
export async function sendMetaTextMessage(input: {
  platform: 'messenger' | 'instagram';
  /** Messenger: Page ID. Instagram: IG user ID (channel external_id). */
  nodeId: string;
  /** Page access token (Bearer). */
  pageToken: string;
  /** Messenger: customer PSID. Instagram: IG-scoped user ID. */
  recipientId: string;
  text: string;
}): Promise<MetaSendResult> {
  const url = `${sendGraphBase()}/${encodeURIComponent(input.nodeId)}/messages`;
  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.pageToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          recipient: { id: input.recipientId },
          message: { text: input.text },
        }),
      },
      15000,
    );
    const data = (await res.json().catch(() => null)) as {
      message_id?: string;
      recipient_id?: string;
      error?: { message?: string; code?: number };
    } | null;
    if (res.ok && typeof data?.message_id === 'string') {
      return { ok: true, messageId: data.message_id };
    }
    const code = data?.error?.code;
    const message = data?.error?.message ?? `Meta Graph send failed (HTTP ${res.status})`;
    return { ok: false, error: message, code, windowExpired: code === 551 };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Send one image message via the Meta Graph API. Never throws — every
 * failure is returned as { ok: false, error, code?, windowExpired? }.
 * The Send API has no caption field for image attachments: the caller
 * sends the image, then a separate text message with the name + price
 * (see deliverOutgoingImageMessage's callers) — in the chat they appear
 * as consecutive bubbles, photo with the details right below it.
 */
export async function sendMetaImageMessage(input: {
  platform: 'messenger' | 'instagram';
  /** Messenger: Page ID. Instagram: IG user ID (channel external_id). */
  nodeId: string;
  /** Page access token (Bearer). */
  pageToken: string;
  /** Messenger: customer PSID. Instagram: IG-scoped user ID. */
  recipientId: string;
  /** Publicly reachable image URL (Vercel Blob URLs are). */
  imageUrl: string;
}): Promise<MetaSendResult> {
  const url = `${sendGraphBase()}/${encodeURIComponent(input.nodeId)}/messages`;
  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.pageToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          recipient: { id: input.recipientId },
          message: {
            attachment: {
              type: 'image',
              payload: { url: input.imageUrl, is_reusable: true },
            },
          },
        }),
      },
      15000,
    );
    const data = (await res.json().catch(() => null)) as {
      message_id?: string;
      recipient_id?: string;
      error?: { message?: string; code?: number };
    } | null;
    if (res.ok && typeof data?.message_id === 'string') {
      return { ok: true, messageId: data.message_id };
    }
    const code = data?.error?.code;
    const message = data?.error?.message ?? `Meta Graph image send failed (HTTP ${res.status})`;
    return { ok: false, error: message, code, windowExpired: code === 551 };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export type DeliveryStatus = 'sent' | 'failed' | 'local' | 'pending';

export interface DeliveryResult {
  /** True only when the message was actually delivered (or is webchat/demo-local). */
  sent: boolean;
  delivery: DeliveryStatus;
  /** The DB messages row id. */
  messageId?: string;
  /** Meta's message_id, when Graph accepted the message. */
  platformMessageId?: string;
  error?: string;
  code?: number;
  windowExpired?: boolean;
}

interface ChannelRow {
  id: string;
  platform: string;
  external_id: string;
  token_encrypted: string | null;
  source_id: string | null;
}

function recipientForPlatform(identities: unknown, platform: string): string | null {
  if (!Array.isArray(identities)) return null;
  for (const entry of identities as Record<string, unknown>[]) {
    if (entry && entry.platform === platform && typeof entry.senderId === 'string') {
      return entry.senderId;
    }
  }
  return null;
}

/**
 * Save an outgoing message and deliver it for real.
 *
 * The row is INSERTed first (delivery_status='pending') so the Inbox
 * always shows the reply attempt honestly; the row is then updated to
 * 'sent' (+ platform_message_id) or 'failed' (+ delivery_error).
 *
 * - liveSend: false (demo mode) — the labelled demo reply is saved only
 *   (delivery_status='local') and never sent to a real customer.
 * - webchat — saving IS the delivery (the website widget reads it from
 *   the DB), so it counts as sent with delivery_status='local'.
 * - messenger / instagram — real Graph send with the channel's stored
 *   (encrypted) Page token and the customer's PSID / IG SID.
 * - facebook_comment — real Graph comment reply (POST
 *   /{comment-id}/comments) with the channel's stored Page token. The
 *   comment replied to is the conversation's latest inbound message
 *   (its platform_message_id is the comment id the webhook saved).
 *   This is also how the AI auto-reply reaches a commenter — agent.ts
 *   already calls this helper, so no agent change was needed.
 * - anything else (whatsapp, tiktok, no channel, no token, no
 *   recipient) — saved as 'failed' with a clear reason.
 *
 * Callers must verify the conversation exists first (the INSERT has a
 * foreign key to conversations). Never throws for a delivery failure.
 */
export async function deliverOutgoingMessage(
  workspaceId: string,
  conversationId: string,
  text: string,
  opts: { liveSend?: boolean } = {},
): Promise<DeliveryResult> {
  const trimmed = text.trim();
  const { rows } = await query<{ id: string }>(
    workspaceId,
    `INSERT INTO messages (workspace_id, conversation_id, direction, type, body, delivery_status)
     VALUES ($1, $2, 'out', 'text', $3, 'pending') RETURNING id`,
    [workspaceId, conversationId, trimmed],
  );
  const messageId = rows[0]?.id ?? '';
  const mark = async (delivery: DeliveryStatus, platformMessageId?: string, error?: string): Promise<void> => {
    await query(
      workspaceId,
      `UPDATE messages SET delivery_status = $1,
        platform_message_id = COALESCE($2, platform_message_id),
        delivery_error = $3 WHERE workspace_id = $4 AND id = $5`,
      [delivery, platformMessageId ?? null, error ? error.slice(0, 500) : null, workspaceId, messageId],
    ).catch((err) => console.error('[meta-send] delivery mark failed:', (err as Error).message));
  };
  const fail = async (error: string, extra: Partial<DeliveryResult> = {}): Promise<DeliveryResult> => {
    await mark('failed', undefined, error);
    return { sent: false, delivery: 'failed', messageId, error, ...extra };
  };

  // Demo-mode replies are labelled "[ডেমো AI]" — never send one to a real
  // customer. Saved only, honestly marked 'local'.
  if (opts.liveSend === false) {
    await mark('local');
    return { sent: true, delivery: 'local', messageId };
  }

  const conversation = await queryOne<{ channel_id: string | null; customer_id: string | null }>(
    workspaceId,
    'SELECT channel_id, customer_id FROM conversations WHERE workspace_id = $1 AND id = $2',
    [workspaceId, conversationId],
  );
  if (!conversation) return fail('conversation_not_found');
  if (!conversation.channel_id) return fail('no_channel_connected');
  const channel = await queryOne<ChannelRow>(
    workspaceId,
    'SELECT id, platform, external_id, token_encrypted, source_id FROM channels WHERE workspace_id = $1 AND id = $2',
    [workspaceId, conversation.channel_id],
  );
  if (!channel) return fail('no_channel_connected');

  // Website live chat is delivered by saving — the widget reads it from the DB.
  if (channel.platform === 'webchat') {
    await mark('local');
    return { sent: true, delivery: 'local', messageId };
  }
  // Facebook comment reply: POST /{comment-id}/comments as the Page.
  // The comment id is the conversation's latest inbound message —
  // the webhook saved the comment with platform_message_id = comment id.
  if (channel.platform === 'facebook_comment') {
    if (!channel.token_encrypted) {
      return fail('no_page_token');
    }
    const latest = await queryOne<{ platform_message_id: string | null }>(
      workspaceId,
      `SELECT platform_message_id FROM messages
       WHERE workspace_id = $1 AND conversation_id = $2 AND direction = 'in'
         AND platform_message_id IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
      [workspaceId, conversationId],
    );
    if (!latest?.platform_message_id) {
      return fail('no_comment_to_reply_to');
    }
    let pageToken: string;
    try {
      pageToken = decryptToken(channel.token_encrypted);
    } catch {
      return fail('token_decrypt_failed');
    }
    const result = await sendFacebookCommentReply({
      commentId: latest.platform_message_id,
      pageToken,
      text: trimmed,
    });
    if (!result.ok) {
      return fail(result.error ?? 'meta_comment_reply_failed', { code: result.code });
    }
    await mark('sent', result.messageId);
    return { sent: true, delivery: 'sent', messageId, platformMessageId: result.messageId };
  }
  if (channel.platform !== 'messenger' && channel.platform !== 'instagram') {
    return fail(`send_not_supported_for_${channel.platform}`);
  }
  if (!channel.token_encrypted) {
    return fail('no_page_token');
  }
  const customer = conversation.customer_id
    ? await queryOne<{ channel_identities: unknown }>(
        workspaceId,
        'SELECT channel_identities FROM customers WHERE workspace_id = $1 AND id = $2',
        [workspaceId, conversation.customer_id],
      )
    : null;
  const recipientId = recipientForPlatform(customer?.channel_identities, channel.platform);
  if (!recipientId) return fail('no_recipient');
  let pageToken: string;
  try {
    pageToken = decryptToken(channel.token_encrypted);
  } catch {
    return fail('token_decrypt_failed');
  }
  const result = await sendMetaTextMessage({
    platform: channel.platform,
    nodeId: channel.external_id,
    pageToken,
    recipientId,
    text: trimmed,
  });
  if (!result.ok) {
    return fail(result.error ?? 'meta_send_failed', {
      code: result.code,
      windowExpired: result.windowExpired,
    });
  }
  await mark('sent', result.messageId);
  return { sent: true, delivery: 'sent', messageId, platformMessageId: result.messageId };
}

/**
 * Save an outgoing IMAGE message and deliver it for real — the photo leg
 * of product cards. Mirrors deliverOutgoingMessage, with two differences:
 *
 * - The row is type='image' and its body IS the image URL, so the Inbox
 *   thread can render it as a photo (web renders type='image' rows as
 *   <img>). The name + price travel as a separate text message right
 *   after (the Send API has no image caption) — callers send the pair.
 * - facebook_comment cannot receive an image (a comment reply is text
 *   only — the Graph comment endpoint takes no image URL), so it fails
 *   honestly with send_not_supported_for_facebook_comment and the caller
 *   falls back to a text reply. Never throws for a delivery failure.
 */
export async function deliverOutgoingImageMessage(
  workspaceId: string,
  conversationId: string,
  imageUrl: string,
  opts: { liveSend?: boolean } = {},
): Promise<DeliveryResult> {
  const url = imageUrl.trim();
  const { rows } = await query<{ id: string }>(
    workspaceId,
    `INSERT INTO messages (workspace_id, conversation_id, direction, type, body, delivery_status)
     VALUES ($1, $2, 'out', 'image', $3, 'pending') RETURNING id`,
    [workspaceId, conversationId, url],
  );
  const messageId = rows[0]?.id ?? '';
  const mark = async (delivery: DeliveryStatus, platformMessageId?: string, error?: string): Promise<void> => {
    await query(
      workspaceId,
      `UPDATE messages SET delivery_status = $1,
        platform_message_id = COALESCE($2, platform_message_id),
        delivery_error = $3 WHERE workspace_id = $4 AND id = $5`,
      [delivery, platformMessageId ?? null, error ? error.slice(0, 500) : null, workspaceId, messageId],
    ).catch((err) => console.error('[meta-send] image delivery mark failed:', (err as Error).message));
  };
  const fail = async (error: string, extra: Partial<DeliveryResult> = {}): Promise<DeliveryResult> => {
    await mark('failed', undefined, error);
    return { sent: false, delivery: 'failed', messageId, error, ...extra };
  };

  if (opts.liveSend === false) {
    await mark('local');
    return { sent: true, delivery: 'local', messageId };
  }

  const conversation = await queryOne<{ channel_id: string | null; customer_id: string | null }>(
    workspaceId,
    'SELECT channel_id, customer_id FROM conversations WHERE workspace_id = $1 AND id = $2',
    [workspaceId, conversationId],
  );
  if (!conversation) return fail('conversation_not_found');
  if (!conversation.channel_id) return fail('no_channel_connected');
  const channel = await queryOne<ChannelRow>(
    workspaceId,
    'SELECT id, platform, external_id, token_encrypted, source_id FROM channels WHERE workspace_id = $1 AND id = $2',
    [workspaceId, conversation.channel_id],
  );
  if (!channel) return fail('no_channel_connected');

  if (channel.platform === 'webchat') {
    await mark('local');
    return { sent: true, delivery: 'local', messageId };
  }
  if (channel.platform === 'facebook_comment') {
    return fail('image_send_not_supported_for_facebook_comment');
  }
  if (channel.platform !== 'messenger' && channel.platform !== 'instagram') {
    return fail(`send_not_supported_for_${channel.platform}`);
  }
  if (!channel.token_encrypted) {
    return fail('no_page_token');
  }
  const customer = conversation.customer_id
    ? await queryOne<{ channel_identities: unknown }>(
        workspaceId,
        'SELECT channel_identities FROM customers WHERE workspace_id = $1 AND id = $2',
        [workspaceId, conversation.customer_id],
      )
    : null;
  const recipientId = recipientForPlatform(customer?.channel_identities, channel.platform);
  if (!recipientId) return fail('no_recipient');
  let pageToken: string;
  try {
    pageToken = decryptToken(channel.token_encrypted);
  } catch {
    return fail('token_decrypt_failed');
  }
  const result = await sendMetaImageMessage({
    platform: channel.platform,
    nodeId: channel.external_id,
    pageToken,
    recipientId,
    imageUrl: url,
  });
  if (!result.ok) {
    return fail(result.error ?? 'meta_image_send_failed', {
      code: result.code,
      windowExpired: result.windowExpired,
    });
  }
  await mark('sent', result.messageId);
  return { sent: true, delivery: 'sent', messageId, platformMessageId: result.messageId };
}
