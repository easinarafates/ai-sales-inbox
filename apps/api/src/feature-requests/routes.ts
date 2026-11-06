/**
 * Feature requests (Phase 3, PDF §4 ঞ) — in-app form for owners to ask for
 * new features. Full paths, mounted at /api.
 */
import { Router, type Response } from 'express';
import { query } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';

export const featureRequestsRouter = Router();
featureRequestsRouter.use(requireAuth);

const COLUMNS = 'id, title, details, status, created_at';

/** GET /api/feature-requests — newest first. */
featureRequestsRouter.get('/feature-requests', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rows } = await query(
    workspaceId,
    `SELECT ${COLUMNS} FROM feature_requests WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [workspaceId],
  );
  res.json({ featureRequests: rows });
});

/** POST /api/feature-requests {title, details} → status 'open'. */
featureRequestsRouter.post('/feature-requests', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { title, details } = (req.body ?? {}) as { title?: string; details?: string };
  if (!title || !title.trim()) {
    res.status(400).json({ error: 'title is required' });
    return;
  }
  const { rows } = await query(
    workspaceId,
    `INSERT INTO feature_requests (workspace_id, title, details, status)
     VALUES ($1, $2, $3, 'open') RETURNING ${COLUMNS}`,
    [workspaceId, title.trim(), details ?? null],
  );
  res.status(201).json({ featureRequest: rows[0] });
});

/** PATCH /api/feature-requests/:id {status} */
featureRequestsRouter.patch('/feature-requests/:id', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { status } = (req.body ?? {}) as { status?: string };
  if (!status || !['open', 'in_progress', 'done', 'rejected'].includes(status)) {
    res.status(400).json({ error: 'status must be open, in_progress, done or rejected' });
    return;
  }
  const { rows } = await query(
    workspaceId,
    `UPDATE feature_requests SET status = $1, updated_at = now()
     WHERE workspace_id = $2 AND id = $3 RETURNING ${COLUMNS}`,
    [status, workspaceId, req.params.id],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Feature request not found' });
    return;
  }
  res.json({ featureRequest: rows[0] });
});
