import { Router, type Response } from 'express';
import { pool, query, queryOne } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';

/** Customers (Phase 2): search, full profile, and merging duplicate profiles. */
export const customersRouter = Router();
customersRouter.use(requireAuth);

interface CustomerRow {
  id: string;
  name: string | null;
  phone: string | null;
  address: string | null;
  channel_identities: unknown;
  created_at: string;
  updated_at: string;
}

/** GET /api/customers?q= — search by name or phone (empty q lists all). */
customersRouter.get('/customers', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!q) {
    const { rows } = await query<CustomerRow>(
      workspaceId,
      'SELECT id, name, phone, address, channel_identities, created_at, updated_at FROM customers WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 200',
      [workspaceId],
    );
    res.json({ customers: rows });
    return;
  }
  const like = `%${q}%`;
  const { rows } = await query<CustomerRow>(
    workspaceId,
    `SELECT id, name, phone, address, channel_identities, created_at, updated_at FROM customers
     WHERE workspace_id = $1 AND (name ILIKE $2 OR phone ILIKE $2)
     ORDER BY created_at DESC LIMIT 200`,
    [workspaceId, like],
  );
  res.json({ customers: rows });
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GET /api/customers/:id — profile + identities, conversations, orders, notes. */
customersRouter.get('/customers/:id', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  // A non-UUID id (e.g. /customers/merge hitting this route) must be a 400,
  // never a DB error — an invalid uuid used to crash the whole API process.
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: 'Customer id is not valid' });
    return;
  }
  const customer = await queryOne<CustomerRow>(
    workspaceId,
    'SELECT id, name, phone, address, channel_identities, created_at, updated_at FROM customers WHERE workspace_id = $1 AND id = $2',
    [workspaceId, req.params.id],
  );
  if (!customer) {
    res.status(404).json({ error: 'Customer not found' });
    return;
  }
  const { rows: conversations } = await query(
    workspaceId,
    `SELECT id, channel_id, status, mode, created_at, updated_at FROM conversations
     WHERE workspace_id = $1 AND customer_id = $2 ORDER BY updated_at DESC LIMIT 100`,
    [workspaceId, req.params.id],
  );
  const { rows: orders } = await query(
    workspaceId,
    `SELECT id, conversation_id, source, status, payment_status, total_paisa, created_at FROM orders
     WHERE workspace_id = $1 AND customer_id = $2 ORDER BY created_at DESC LIMIT 100`,
    [workspaceId, req.params.id],
  );
  const { rows: notes } = await query(
    workspaceId,
    `SELECT id, conversation_id, author_id, body, created_at FROM notes
     WHERE workspace_id = $1 AND customer_id = $2 ORDER BY created_at DESC LIMIT 100`,
    [workspaceId, req.params.id],
  );
  res.json({
    customer,
    identities: customer.channel_identities,
    conversations,
    orders,
    notes,
  });
});

interface Identity {
  platform: string;
  senderId: string;
  name?: string | null;
}

/**
 * POST /api/customers/merge {keepCustomerId, mergeCustomerId}
 * One transaction: re-point conversations, orders, tickets, leads (and
 * notes) to the kept customer, merge channel identities deduped by
 * platform+senderId, fill in missing name/phone/address, delete the merged row.
 */
customersRouter.post('/customers/merge', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { keepCustomerId, mergeCustomerId } = (req.body ?? {}) as {
    keepCustomerId?: string;
    mergeCustomerId?: string;
  };
  if (!keepCustomerId || !mergeCustomerId) {
    res.status(400).json({ error: 'keepCustomerId and mergeCustomerId are required' });
    return;
  }
  if (keepCustomerId === mergeCustomerId) {
    res.status(400).json({ error: 'keepCustomerId and mergeCustomerId must be different' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const keepRes = await client.query(
      'SELECT id, name, phone, address, channel_identities FROM customers WHERE workspace_id = $1 AND id = $2',
      [workspaceId, keepCustomerId],
    );
    const mergeRes = await client.query(
      'SELECT id, name, phone, address, channel_identities FROM customers WHERE workspace_id = $1 AND id = $2',
      [workspaceId, mergeCustomerId],
    );
    if (keepRes.rowCount === 0 || mergeRes.rowCount === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Customer not found in this workspace' });
      return;
    }
    const keep = keepRes.rows[0] as { id: string; name: string | null; phone: string | null; address: string | null; channel_identities: Identity[] };
    const merge = mergeRes.rows[0] as { id: string; name: string | null; phone: string | null; address: string | null; channel_identities: Identity[] };

    // Merge identities, deduped by platform+senderId (kept customer's win ties).
    const seen = new Set<string>();
    const mergedIdentities: Identity[] = [];
    for (const ident of [...(keep.channel_identities ?? []), ...(merge.channel_identities ?? [])]) {
      const key = `${ident.platform}:${ident.senderId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      mergedIdentities.push(ident);
    }

    // One open chat per customer per channel (migration 16): if both
    // customers have an OPEN conversation on the same channel, re-pointing
    // the merged one's would violate the unique index. Close the merged
    // customer's colliding open chats first (their messages stay in
    // history as a done chat); the kept customer's open chat stays open.
    await client.query(
      `UPDATE conversations c SET status = 'done'
       WHERE c.workspace_id = $1 AND c.customer_id = $2 AND c.status = 'open'
         AND EXISTS (
           SELECT 1 FROM conversations k
           WHERE k.workspace_id = $1 AND k.customer_id = $3 AND k.status = 'open'
             AND k.channel_id IS NOT DISTINCT FROM c.channel_id
         )`,
      [workspaceId, mergeCustomerId, keepCustomerId],
    );

    for (const table of ['conversations', 'orders', 'tickets', 'leads', 'notes']) {
      await client.query(
        `UPDATE ${table} SET customer_id = $1 WHERE workspace_id = $2 AND customer_id = $3`,
        [keepCustomerId, workspaceId, mergeCustomerId],
      );
    }
    await client.query(
      `UPDATE customers
       SET channel_identities = $1::jsonb,
           name = COALESCE(name, $2), phone = COALESCE(phone, $3), address = COALESCE(address, $4),
           updated_at = now()
       WHERE workspace_id = $5 AND id = $6`,
      [JSON.stringify(mergedIdentities), merge.name, merge.phone, merge.address, workspaceId, keepCustomerId],
    );
    await client.query('DELETE FROM customers WHERE workspace_id = $1 AND id = $2', [workspaceId, mergeCustomerId]);
    await client.query('COMMIT');
    const customer = await queryOne<CustomerRow>(
      workspaceId,
      'SELECT id, name, phone, address, channel_identities, created_at, updated_at FROM customers WHERE workspace_id = $1 AND id = $2',
      [workspaceId, keepCustomerId],
    );
    res.json({ customer });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('[customers/merge]', err);
    res.status(500).json({ error: 'Customer merge failed' });
  } finally {
    client.release();
  }
});
