import { randomBytes } from 'node:crypto';
import { Router, type Response } from 'express';
import { query } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';

/**
 * Team invites (Worker B).
 * NO real email is sent (no money for an email service): creating an invite
 * stores it with a token and the UI shows the invite link to share by hand,
 * labelled honestly as "invite created — share this link".
 */
export const teamRouter = Router();
teamRouter.use(requireAuth);

const COLUMNS = 'id, email, role, token, status, created_at, updated_at';

function webBase(req: AuthRequest): string {
  return (process.env.WEB_URL ?? process.env.WEB_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
}

function inviteLink(req: AuthRequest, token: string): string {
  return `${webBase(req)}/signup?invite=${token}`;
}

/** GET /api/team/invites — invites + current members. */
teamRouter.get('/team/invites', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rows: invites } = await query(
    workspaceId,
    `SELECT ${COLUMNS} FROM team_invites WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [workspaceId],
  );
  const { rows: members } = await query(
    workspaceId,
    `SELECT m.id, m.user_id, m.role, u.email, u.name, m.created_at
     FROM members m LEFT JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = $1 ORDER BY m.created_at ASC`,
    [workspaceId],
  );
  res.json({
    invites: invites.map((i) => ({ ...i, inviteLink: inviteLink(req, i.token as string) })),
    members,
  });
});

/** POST /api/team/invites {email, role?} — create an invite (no email sent). */
teamRouter.post('/team/invites', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { email, role } = (req.body ?? {}) as { email?: string; role?: string };
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    res.status(400).json({ error: 'A valid email is required' });
    return;
  }
  const existing = await query(
    workspaceId,
    `SELECT id FROM team_invites WHERE workspace_id = $1 AND email = $2 AND status = 'pending'`,
    [workspaceId, email.trim().toLowerCase()],
  );
  if (existing.rowCount > 0) {
    res.status(400).json({ error: 'A pending invite already exists for this email' });
    return;
  }
  const token = randomBytes(24).toString('hex');
  const { rows } = await query(
    workspaceId,
    `INSERT INTO team_invites (workspace_id, email, role, token, invited_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUMNS}`,
    [workspaceId, email.trim().toLowerCase(), role?.trim() || 'member', token, req.userId ?? null],
  );
  const invite = rows[0];
  res.status(201).json({
    invite: { ...invite, inviteLink: inviteLink(req, token) },
    note: 'Invite created — no email was sent. Share this link with the person yourself.',
  });
});

/** POST /api/team/invites/:id/revoke */
teamRouter.post('/team/invites/:id/revoke', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rows } = await query(
    workspaceId,
    `UPDATE team_invites SET status = 'revoked', updated_at = now()
     WHERE workspace_id = $1 AND id = $2 AND status = 'pending' RETURNING ${COLUMNS}`,
    [workspaceId, req.params.id],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Pending invite not found' });
    return;
  }
  res.json({ invite: rows[0] });
});
