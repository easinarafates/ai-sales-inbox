/**
 * Offer broadcasts (Phase 3, PDF §4 ঙ) — full paths, mounted at /api.
 *
 * Meta 24-hour messaging window (hard rule): a broadcast may ONLY go to
 * customers who sent an inbound message in the last 24 hours. The send
 * endpoint enforces this in SQL (messages.direction='in' AND
 * created_at >= now() - interval '24 hours'). Customers outside the window
 * are counted as `skipped` and are never messaged.
 *
 * Real Meta sending is a STUB: recipients are logged and marked 'sent' in
 * our tables only. Sending via the Meta Graph API needs Meta approval and
 * is NOT done here.
 */
import { Router, type Response } from 'express';
import { pool, query, queryOne } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';

export const broadcastsRouter = Router();
broadcastsRouter.use(requireAuth);

interface BroadcastRow {
  id: string;
  title: string;
  message: string;
  offer_text: string | null;
  coupon_code: string | null;
  status: string;
  sent_at: string | null;
  created_at: string;
}

/** GET /api/broadcasts — newest first. */
broadcastsRouter.get('/broadcasts', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rows } = await query<BroadcastRow>(
    workspaceId,
    'SELECT id, title, message, offer_text, coupon_code, status, sent_at, created_at FROM broadcasts WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 200',
    [workspaceId],
  );
  res.json({ broadcasts: rows });
});

/** POST /api/broadcasts {title, message, offerText?, couponCode?} → draft. */
broadcastsRouter.post('/broadcasts', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { title, message, offerText, couponCode } = (req.body ?? {}) as {
    title?: string;
    message?: string;
    offerText?: string;
    couponCode?: string;
  };
  if (!title || !title.trim() || !message || !message.trim()) {
    res.status(400).json({ error: 'title and message are required' });
    return;
  }
  const { rows } = await query<BroadcastRow>(
    workspaceId,
    `INSERT INTO broadcasts (workspace_id, title, message, offer_text, coupon_code, status)
     VALUES ($1, $2, $3, $4, $5, 'draft')
     RETURNING id, title, message, offer_text, coupon_code, status, sent_at, created_at`,
    [workspaceId, title.trim(), message.trim(), offerText ?? null, couponCode ?? null],
  );
  res.status(201).json({ broadcast: rows[0] });
});

/**
 * POST /api/broadcasts/:id/send — ONLY to customers with an inbound message
 * in the last 24 hours (Meta 24-hour window, enforced in SQL below).
 * Recipients are inserted as 'queued', then marked 'sent' via the stub
 * sender (log only — real Meta send needs approval). Returns
 * { broadcast, sent, skipped } where skipped = customers outside the window.
 */
broadcastsRouter.post('/broadcasts/:id/send', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const broadcast = await queryOne<BroadcastRow>(
    workspaceId,
    'SELECT id, title, message, offer_text, coupon_code, status, sent_at, created_at FROM broadcasts WHERE workspace_id = $1 AND id = $2',
    [workspaceId, req.params.id],
  );
  if (!broadcast) {
    res.status(404).json({ error: 'Broadcast not found' });
    return;
  }
  if (broadcast.status === 'sent') {
    res.status(400).json({ error: 'এই ব্রডকাস্টটি ইতিমধ্যে পাঠানো হয়েছে।' });
    return;
  }

  // Eligible = distinct customers with an inbound message in the last 24h.
  const { rows: eligible } = await query<{ id: string; name: string | null; phone: string | null }>(
    workspaceId,
    `SELECT DISTINCT c.id, c.name, c.phone
     FROM customers c
     JOIN conversations conv ON conv.customer_id = c.id AND conv.workspace_id = $1
     JOIN messages m ON m.conversation_id = conv.id AND m.workspace_id = $1
     WHERE c.workspace_id = $1 AND m.direction = 'in'
       AND m.created_at >= now() - interval '24 hours'`,
    [workspaceId],
  );
  const { rows: totalRows } = await query<{ n: string }>(
    workspaceId,
    'SELECT count(*) AS n FROM customers WHERE workspace_id = $1',
    [workspaceId],
  );
  const totalCustomers = Number(totalRows[0]?.n ?? 0);
  const sent = eligible.length;
  const skipped = Math.max(0, totalCustomers - sent);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const customer of eligible) {
      await client.query(
        `INSERT INTO broadcast_recipients (workspace_id, broadcast_id, customer_id, status)
         VALUES ($1, $2, $3, 'queued')`,
        [workspaceId, broadcast.id, customer.id],
      );
    }
    // STUB sender — log only. Real Meta Graph API send needs Meta approval.
    for (const customer of eligible) {
      console.log(
        `[broadcast-stub] broadcast ${broadcast.id} -> customer ${customer.id} (STUB — not really sent; real Meta send needs approval)`,
      );
    }
    await client.query(
      "UPDATE broadcast_recipients SET status = 'sent', updated_at = now() WHERE workspace_id = $1 AND broadcast_id = $2",
      [workspaceId, broadcast.id],
    );
    const { rows: updated } = await client.query(
      `UPDATE broadcasts SET status = 'sent', sent_at = now(), updated_at = now()
       WHERE workspace_id = $1 AND id = $2
       RETURNING id, title, message, offer_text, coupon_code, status, sent_at, created_at`,
      [workspaceId, broadcast.id],
    );
    await client.query('COMMIT');
    res.json({ broadcast: updated[0], sent, skipped });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('[broadcasts/send]', err);
    res.status(500).json({ error: 'Broadcast send failed' });
  } finally {
    client.release();
  }
});

/** GET /api/broadcasts/:id — broadcast + its recipients. */
broadcastsRouter.get('/broadcasts/:id', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const broadcast = await queryOne<BroadcastRow>(
    workspaceId,
    'SELECT id, title, message, offer_text, coupon_code, status, sent_at, created_at FROM broadcasts WHERE workspace_id = $1 AND id = $2',
    [workspaceId, req.params.id],
  );
  if (!broadcast) {
    res.status(404).json({ error: 'Broadcast not found' });
    return;
  }
  const { rows: recipients } = await query(
    workspaceId,
    `SELECT br.id, br.customer_id, c.name AS customer_name, c.phone AS customer_phone, br.status, br.created_at
     FROM broadcast_recipients br
     LEFT JOIN customers c ON c.id = br.customer_id AND c.workspace_id = $1
     WHERE br.workspace_id = $1 AND br.broadcast_id = $2 ORDER BY br.created_at ASC`,
    [workspaceId, req.params.id],
  );
  res.json({ broadcast, recipients });
});
