import { Router, type Response } from 'express';
import { query } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';

/** Saved replies (Worker B): CRUD + list for one-tap sending in the inbox. */
export const savedRepliesRouter = Router();
savedRepliesRouter.use(requireAuth);

const COLUMNS = 'id, title, body, channel, created_at, updated_at';

/** GET /api/saved-replies?channel= */
savedRepliesRouter.get('/saved-replies', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const channel = typeof req.query.channel === 'string' ? req.query.channel : null;
  const { rows } = await query(
    workspaceId,
    `SELECT ${COLUMNS} FROM saved_replies
     WHERE workspace_id = $1 AND ($2::text IS NULL OR channel = $2 OR channel IS NULL)
     ORDER BY created_at DESC LIMIT 200`,
    [workspaceId, channel],
  );
  res.json({ savedReplies: rows });
});

/** POST /api/saved-replies {title, body, channel?} */
savedRepliesRouter.post('/saved-replies', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { title, body, channel } = (req.body ?? {}) as { title?: string; body?: string; channel?: string };
  if (!title?.trim() || !body?.trim()) {
    res.status(400).json({ error: 'title and body are required' });
    return;
  }
  const { rows } = await query(
    workspaceId,
    `INSERT INTO saved_replies (workspace_id, title, body, channel)
     VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
    [workspaceId, title.trim(), body.trim(), channel?.trim() || null],
  );
  res.status(201).json({ savedReply: rows[0] });
});

/** PATCH /api/saved-replies/:id {title?, body?, channel?} */
savedRepliesRouter.patch('/saved-replies/:id', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { title, body, channel } = (req.body ?? {}) as { title?: string; body?: string; channel?: string | null };
  const sets: string[] = [];
  const params: unknown[] = [workspaceId];
  const add = (clause: string, value: unknown): void => {
    params.push(value);
    sets.push(`${clause} = $${params.length}`);
  };
  if (title !== undefined) add('title', title?.trim() || null);
  if (body !== undefined) add('body', body?.trim() || null);
  if (channel !== undefined) add('channel', channel?.trim() || null);
  if (sets.length === 0) {
    res.status(400).json({ error: 'Nothing to update' });
    return;
  }
  params.push(req.params.id);
  const { rows } = await query(
    workspaceId,
    `UPDATE saved_replies SET ${sets.join(', ')}, updated_at = now()
     WHERE workspace_id = $1 AND id = $${params.length} RETURNING ${COLUMNS}`,
    params,
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Saved reply not found' });
    return;
  }
  res.json({ savedReply: rows[0] });
});

/** DELETE /api/saved-replies/:id */
savedRepliesRouter.delete('/saved-replies/:id', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rowCount } = await query(
    workspaceId,
    'DELETE FROM saved_replies WHERE workspace_id = $1 AND id = $2',
    [workspaceId, req.params.id],
  );
  if (rowCount === 0) {
    res.status(404).json({ error: 'Saved reply not found' });
    return;
  }
  res.json({ deleted: true });
});
