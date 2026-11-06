import { Router, type Response } from 'express';
import { config } from '../config';
import { encryptToken } from '../db/crypto';
import { query } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';
import { checkChannelLimit } from '../subscriptions/service';

export const channelsRouter = Router();
channelsRouter.use(requireAuth);

const PLATFORMS = ['messenger', 'facebook_comment', 'instagram', 'webchat', 'whatsapp', 'tiktok', 'tiktok_dm'] as const;
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
  const approved = isApproved(platform);
  const status = approved ? 'connected' : 'pending_approval';
  if (approved) {
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
