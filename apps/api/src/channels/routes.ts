import { Router, type Response } from 'express';
import { config } from '../config';
import { decryptToken, encryptToken } from '../db/crypto';
import { query, queryOne } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';
import { checkChannelLimit } from '../subscriptions/service';
import { SUBSCRIBED_FIELDS, subscribePageToApp } from './meta-oauth';

export const channelsRouter = Router();
channelsRouter.use(requireAuth);

const PLATFORMS = ['messenger', 'facebook_comment', 'instagram', 'webchat', 'whatsapp', 'tiktok', 'tiktok_dm', 'youtube'] as const;
type Platform = (typeof PLATFORMS)[number];

/**
 * Phase 2 platforms that need platform approval before they can go live
 * (WhatsApp Cloud API / TikTok API access). Approval flags live in config
 * (env WHATSAPP_APPROVED / TIKTOK_COMMENTS_APPROVED).
 */
const APPROVAL_GATED: Record<string, boolean> = {
  whatsapp: config.whatsappApproved,
  tiktok: config.tiktokCommentsApproved,
  tiktok_dm: config.tiktokDmApproved,
};

function isApproved(platform: string): boolean {
  // Phase 1 platforms are not gated.
  return APPROVAL_GATED[platform] ?? true;
}

/** GET /api/channels/setup-status — which connects are actually configured.
 * Lets the Channels page show "needs setup" honestly (with the Bengali
 * explanation) instead of a fake connect button: Meta app present?
 * WhatsApp Embedded Signup config id present? TikTok / Google keys present?
 * No secret is ever returned — booleans only. */
channelsRouter.get('/setup-status', async (_req: AuthRequest, res: Response) => {
  res.json({
    metaConfigured: !!config.meta.appId,
    whatsappConfigIdConfigured: !!config.whatsapp.configId,
    tiktokConfigured: !!config.tiktok.clientKey && !!config.tiktok.clientSecret,
    youtubeConfigured: !!config.google.clientId && !!config.google.clientSecret,
  });
});

/** POST /api/channels — connect a page/account. Token is stored encrypted. */
channelsRouter.post('/', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { platform, externalId, displayName, token } = (req.body ?? {}) as {
    platform?: string;
    externalId?: string;
    displayName?: string;
    token?: string;
  };
  if (!platform || !(PLATFORMS as readonly string[]).includes(platform)) {
    res.status(400).json({ error: `platform must be one of: ${PLATFORMS.join(', ')}` });
    return;
  }
  if (!externalId) {
    res.status(400).json({ error: 'externalId is required (page ID / Instagram ID / webchat site ID)' });
    return;
  }
  const tokenEncrypted = token ? encryptToken(token) : null;
  const dupe = await query(
    workspaceId,
    'SELECT id FROM channels WHERE workspace_id = $1 AND platform = $2 AND external_id = $3',
    [workspaceId, platform as Platform, externalId],
  );
  if (dupe.rows.length > 0) {
    res.status(409).json({ error: 'Channel already connected for this workspace' });
    return;
  }
  // Subscription limit: only `connected` channels count (pending_approval
  // ones are not live yet), so trial workspaces can still add gated channels.
  // NOTE (integration fix): the check must run ONLY when this channel will
  // actually be connected. A pending_approval channel (WhatsApp/TikTok
  // without approval) consumes no slot — enforcing the limit before the
  // approval decision broke the e2e verifier (Messenger already uses the
  // trial's 1 slot, yet WhatsApp/TikTok must still save as pending).
  // facebook_comment is the same exception: it is the comment leg of an
  // already-connected Facebook Page (same Page, same token), not a new
  // channel, so it never consumes a subscription slot either.
  const approved = isApproved(platform);
  const status = approved ? 'connected' : 'pending_approval';
  if (approved && platform !== 'facebook_comment') {
    const channelLimit = await checkChannelLimit(workspaceId);
    if (!channelLimit.canAdd) {
      res.status(402).json({ error: channelLimit.message });
      return;
    }
  }
  // Approval-gated Phase 2 platforms: without approval the channel is saved
  // as pending_approval and can never send/receive until approval lands.
  const { rows } = await query<{ id: string; platform: string; external_id: string; display_name: string | null; status: string }>(
    workspaceId,
    `INSERT INTO channels (workspace_id, platform, external_id, display_name, token_encrypted, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, platform, external_id, display_name, status`,
    [workspaceId, platform as Platform, externalId, displayName ?? null, tokenEncrypted, status],
  );
  if (rows.length === 0) {
    res.status(409).json({ error: 'Channel already connected for this workspace' });
    return;
  }
  if (!approved) {
    res.status(201).json({
      channel: rows[0],
      status: 'pending_approval',
      approvalRequired: true,
      message: 'এই চ্যানেলের জন্য প্ল্যাটফর্মের অনুমোদন লাগবে। অনুমোদন পেলে চ্যানেলটি চালু হবে।',
    });
    return;
  }
  res.status(201).json({ channel: rows[0] });
});

/** GET /api/channels — never returns tokens (encrypted or otherwise). */
channelsRouter.get('/', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rows } = await query(
    workspaceId,
    'SELECT id, platform, external_id, display_name, status, token_expires_at, picture_url, source_id, created_at FROM channels WHERE workspace_id = $1 ORDER BY created_at DESC',
    [workspaceId],
  );
  res.json({ channels: rows });
});

/**
 * POST /api/channels/:id/resubscribe — re-subscribe a Page to the app
 * with the current SUBSCRIBED_FIELDS. Needed when the field list grows
 * (e.g. message_echoes was added after the Page first connected):
 * Meta only delivers a field the Page is subscribed to, and the app
 * only receives it when the Webhooks product also lists it. Returns
 * subscribed=false (never throws) when Graph refuses — the channel
 * still works for the fields it already had.
 */
channelsRouter.post('/:id/resubscribe', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const channel = await queryOne(
    workspaceId,
    'SELECT id, platform, external_id, source_id, token_encrypted FROM channels WHERE workspace_id = $1 AND id = $2',
    [workspaceId, req.params.id],
  );
  if (!channel) {
    res.status(404).json({ error: 'Channel not found' });
    return;
  }
  if (channel.platform !== 'messenger' && channel.platform !== 'instagram') {
    res.status(400).json({ error: 'Only Messenger/Instagram pages can be re-subscribed' });
    return;
  }
  if (!channel.token_encrypted) {
    res.status(400).json({ error: 'No Page token stored for this channel' });
    return;
  }
  // Messenger: the Page is external_id. Instagram: the Page is
  // source_id (external_id is the IG user ID).
  const pageId = channel.platform === 'messenger' ? channel.external_id : (channel.source_id ?? '');
  if (!pageId) {
    res.status(400).json({ error: 'No Page ID stored for this channel' });
    return;
  }
  let pageToken: string;
  try {
    pageToken = decryptToken(channel.token_encrypted as string);
  } catch {
    res.status(400).json({ error: 'Stored Page token could not be read' });
    return;
  }
  const subscribed = await subscribePageToApp(pageId as string, pageToken);
  res.json({ channelId: channel.id, subscribed, fields: SUBSCRIBED_FIELDS });
});
