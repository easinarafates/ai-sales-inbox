/**
 * GET /api/notifications — the owner's notification list for the header
 * bell (newest first, unread count included).
 * POST /api/notifications/:id/read — mark one read.
 * POST /api/notifications/read-all — mark all read.
 *
 * Workspace-scoped (requireAuth + getWorkspaceId), like the Inbox.
 * A notification links to its conversation: the bell opens
 * /inbox?conversation=<conversationId> and marks it read.
 */
import { Router, type Response } from 'express';
import { query } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string;
  conversation_id: string | null;
  customer_id: string | null;
  order_id: string | null;
  customer_name: string | null;
  is_read: boolean;
  created_at: string;
}

notificationsRouter.get('/', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const limit = Math.max(1, Math.min(50, Number(req.query.limit ?? 20) || 20));
  const { rows } = await query<NotificationRow>(
    workspaceId,
    `SELECT n.id, n.type, n.title, n.body, n.conversation_id, n.customer_id, n.order_id,
            cu.name AS customer_name, n.is_read, n.created_at
     FROM notifications n
     LEFT JOIN customers cu ON cu.id = n.customer_id AND cu.workspace_id = $1
     WHERE n.workspace_id = $1
     ORDER BY n.created_at DESC LIMIT $2`,
    [workspaceId, limit],
  );
  const unread = rows.filter((r) => !r.is_read).length;
  res.json({ notifications: rows, unreadCount: unread });
});

notificationsRouter.post('/:id/read', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const id = String(req.params.id ?? '');
  await query(
    workspaceId,
    'UPDATE notifications SET is_read = TRUE, updated_at = now() WHERE workspace_id = $1 AND id = $2',
    [workspaceId, id],
  );
  res.json({ ok: true });
});

notificationsRouter.post('/read-all', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  await query(
    workspaceId,
    'UPDATE notifications SET is_read = TRUE, updated_at = now() WHERE workspace_id = $1 AND is_read = FALSE',
    [workspaceId],
  );
  res.json({ ok: true });
});
