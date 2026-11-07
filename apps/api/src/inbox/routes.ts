import { Router, type Response } from 'express';
import { query, queryOne } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';
import { deliverOutgoingMessage } from '../channels/meta-send';

export const inboxRouter = Router();
inboxRouter.use(requireAuth);

interface ConversationRow {
  id: string;
  status: string;
  mode: string;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  customer_picture_url: string | null;
  assignee_id: string | null;
  updated_at: string;
  last_message: string | null;
  channel?: string | null;
  channel_name?: string | null;
}

/**
 * GET /api/inbox?q=&status= — unified inbox.
 * Search matches customer name/phone, order id, or message text.
 */
inboxRouter.get('/', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const q = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim() : null;
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const params: unknown[] = [workspaceId];
  let where = 'WHERE c.workspace_id = $1';
  if (status) {
    params.push(status);
    where += ` AND c.status = $${params.length}`;
  }
  if (q) {
    const like = `%${q}%`;
    params.push(like, like, like, like);
    const n = params.length;
    where += ` AND (cu.name ILIKE $${n - 3} OR cu.phone ILIKE $${n - 2}
      OR EXISTS (SELECT 1 FROM messages m WHERE m.workspace_id = $1 AND m.conversation_id = c.id AND m.body ILIKE $${n - 1})
      OR EXISTS (SELECT 1 FROM orders o WHERE o.workspace_id = $1 AND o.conversation_id = c.id AND CAST(o.id AS TEXT) ILIKE $${n}))`;
  }
  const { rows } = await query<ConversationRow>(
    workspaceId,
    `SELECT c.id, c.status, c.mode, c.customer_id, cu.name AS customer_name, cu.phone AS customer_phone,
            cu.picture_url AS customer_picture_url,
            c.assignee_id, c.updated_at, ch.platform AS channel, ch.display_name AS channel_name,
            (SELECT m.body FROM messages m WHERE m.workspace_id = $1 AND m.conversation_id = c.id
             ORDER BY m.created_at DESC LIMIT 1) AS last_message
     FROM conversations c
     LEFT JOIN customers cu ON cu.id = c.customer_id AND cu.workspace_id = $1
     LEFT JOIN channels ch ON ch.id = c.channel_id AND ch.workspace_id = $1
     ${where}
     ORDER BY c.updated_at DESC LIMIT 100`,
    params,
  );
  res.json({ conversations: rows });
});

/** GET /api/inbox/:id — conversation + messages + customer profile + open orders. */
inboxRouter.get('/:id', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const conversation = await queryOne<ConversationRow>(
    workspaceId,
    `SELECT c.id, c.status, c.mode, c.customer_id, cu.name AS customer_name, cu.phone AS customer_phone,
            cu.picture_url AS customer_picture_url,
            c.assignee_id, c.updated_at, ch.platform AS channel, ch.display_name AS channel_name, NULL::text AS last_message
     FROM conversations c
     LEFT JOIN customers cu ON cu.id = c.customer_id AND cu.workspace_id = $1
     LEFT JOIN channels ch ON ch.id = c.channel_id AND ch.workspace_id = $1
     WHERE c.workspace_id = $1 AND c.id = $2`,
    [workspaceId, req.params.id],
  );
  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  const { rows: messages } = await query(
    workspaceId,
    `SELECT id, direction, type, body, platform_message_id, delivery_status, delivery_error, created_at FROM messages
     WHERE workspace_id = $1 AND conversation_id = $2 ORDER BY created_at ASC LIMIT 200`,
    [workspaceId, req.params.id],
  );
  const customer = conversation.customer_id
    ? await queryOne(
        workspaceId,
        'SELECT id, name, phone, address, picture_url, channel_identities FROM customers WHERE workspace_id = $1 AND id = $2',
        [workspaceId, conversation.customer_id],
      )
    : null;
  const { rows: orders } = await query(
    workspaceId,
    `SELECT id, status, payment_status, total_paisa, source, created_at FROM orders
     WHERE workspace_id = $1 AND conversation_id = $2 AND status <> 'delivered' ORDER BY created_at DESC`,
    [workspaceId, req.params.id],
  );
  res.json({ conversation, customer, messages, openOrders: orders });
});

/** POST /api/inbox/:id/reply {body} — team member sends an outgoing message.
 * The reply is saved first and then delivered for real via the Meta Graph
 * API (Messenger / Instagram). A failed delivery returns 502 with the
 * reason — the saved row carries delivery_status='failed' and never
 * pretends it was delivered. */
inboxRouter.post('/:id/reply', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { body } = (req.body ?? {}) as { body?: string };
  if (!body || !body.trim()) {
    res.status(400).json({ error: 'body is required' });
    return;
  }
  const conversation = await queryOne<{ id: string }>(
    workspaceId,
    'SELECT id FROM conversations WHERE workspace_id = $1 AND id = $2',
    [workspaceId, req.params.id],
  );
  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  const delivery = await deliverOutgoingMessage(workspaceId, req.params.id, body.trim());
  const { rows } = await query(
    workspaceId,
    `SELECT id, direction, type, body, platform_message_id, delivery_status, delivery_error, created_at FROM messages
     WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, delivery.messageId],
  );
  const message = rows[0] ?? null;
  if (!delivery.sent) {
    res.status(502).json({
      error: delivery.windowExpired
        ? 'Message could not be delivered: the 24-hour reply window has closed for this customer. They must message again before you can reply.'
        : `Message could not be delivered: ${delivery.error ?? 'unknown error'}`,
      reason: delivery.error ?? 'send_failed',
      windowExpired: delivery.windowExpired ?? false,
      message,
    });
    return;
  }
  res.status(201).json({ message, delivered: true, platformMessageId: delivery.platformMessageId });
});

/** POST /api/inbox/:id/assign {userId} */
inboxRouter.post('/:id/assign', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { userId } = (req.body ?? {}) as { userId?: string };
  if (!userId) {
    res.status(400).json({ error: 'userId is required' });
    return;
  }
  const member = await queryOne(
    workspaceId,
    'SELECT id FROM members WHERE workspace_id = $1 AND user_id = $2',
    [workspaceId, userId],
  );
  if (!member) {
    res.status(400).json({ error: 'userId is not a member of this workspace' });
    return;
  }
  const { rows } = await query(
    workspaceId,
    'UPDATE conversations SET assignee_id = $1, updated_at = now() WHERE workspace_id = $2 AND id = $3 RETURNING id, assignee_id',
    [userId, workspaceId, req.params.id],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  res.json({ conversation: rows[0] });
});

/** POST /api/inbox/:id/done — mark the chat done. */
inboxRouter.post('/:id/done', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rows } = await query(
    workspaceId,
    "UPDATE conversations SET status = 'done', updated_at = now() WHERE workspace_id = $1 AND id = $2 RETURNING id, status",
    [workspaceId, req.params.id],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  res.json({ conversation: rows[0] });
});

async function setMode(workspaceId: string, conversationId: string, mode: 'ai' | 'human', res: Response): Promise<void> {
  const { rows } = await query(
    workspaceId,
    'UPDATE conversations SET mode = $1, updated_at = now() WHERE workspace_id = $2 AND id = $3 RETURNING id, mode',
    [mode, workspaceId, conversationId],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  res.json({ conversation: rows[0] });
}

/**
 * POST /api/inbox/:id/dot — a '.' from the owner toggles ai <-> human mode.
 * POST /api/inbox/:id/takeover — human takes over (mode=human).
 * POST /api/inbox/:id/return — hand back to the AI (mode=ai).
 */
inboxRouter.post('/:id/dot', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const current = await queryOne<{ mode: string }>(
    workspaceId,
    'SELECT mode FROM conversations WHERE workspace_id = $1 AND id = $2',
    [workspaceId, req.params.id],
  );
  if (!current) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  await setMode(workspaceId, req.params.id, current.mode === 'ai' ? 'human' : 'ai', res);
});

inboxRouter.post('/:id/takeover', async (req: AuthRequest, res: Response) => {
  await setMode(getWorkspaceId(req), req.params.id, 'human', res);
});

inboxRouter.post('/:id/return', async (req: AuthRequest, res: Response) => {
  await setMode(getWorkspaceId(req), req.params.id, 'ai', res);
});
