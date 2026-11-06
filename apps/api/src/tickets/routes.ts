import { Router, type Response } from 'express';
import { query } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';

export const ticketsRouter = Router();
ticketsRouter.use(requireAuth);

ticketsRouter.get('/', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const params: unknown[] = [workspaceId];
  let where = 'WHERE workspace_id = $1';
  if (status) {
    params.push(status);
    where += ` AND status = $${params.length}`;
  }
  const { rows } = await query(
    workspaceId,
    `SELECT id, conversation_id, customer_id, reason, assignee_id, status, created_at
     FROM tickets ${where} ORDER BY created_at DESC LIMIT 200`,
    params,
  );
  res.json({ tickets: rows });
});

ticketsRouter.post('/', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { conversationId, customerId, reason, assigneeId } = (req.body ?? {}) as {
    conversationId?: string;
    customerId?: string;
    reason?: string;
    assigneeId?: string;
  };
  const { rows } = await query(
    workspaceId,
    `INSERT INTO tickets (workspace_id, conversation_id, customer_id, reason, assignee_id, status)
     VALUES ($1, $2, $3, $4, $5, 'open') RETURNING id, conversation_id, customer_id, reason, assignee_id, status, created_at`,
    [workspaceId, conversationId ?? null, customerId ?? null, reason ?? null, assigneeId ?? null],
  );
  res.status(201).json({ ticket: rows[0] });
});

/** PATCH /api/tickets/:id {status, assigneeId} */
ticketsRouter.patch('/:id', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { status, assigneeId } = (req.body ?? {}) as { status?: string; assigneeId?: string };
  if (status && !['open', 'in_progress', 'resolved', 'closed'].includes(status)) {
    res.status(400).json({ error: 'status must be open, in_progress, resolved or closed' });
    return;
  }
  const { rows } = await query(
    workspaceId,
    `UPDATE tickets SET status = COALESCE($1, status), assignee_id = COALESCE($2, assignee_id), updated_at = now()
     WHERE workspace_id = $3 AND id = $4 RETURNING id, conversation_id, customer_id, reason, assignee_id, status`,
    [status ?? null, assigneeId ?? null, workspaceId, req.params.id],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Ticket not found' });
    return;
  }
  res.json({ ticket: rows[0] });
});
