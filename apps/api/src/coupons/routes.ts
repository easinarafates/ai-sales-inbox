import { Router, type Response } from 'express';
import { pool, query, queryOne } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';

/**
 * Coupons (Phase 2). Mounted by the coordinator at /api, so every path
 * below is written in full (/coupons, /orders/:id/apply-coupon).
 * Discount math comes ONLY from the coupons table — never invented.
 */
export const couponsRouter = Router();
couponsRouter.use(requireAuth);

const COUPON_TYPES = ['percent', 'amount', 'free_delivery'] as const;
type CouponType = (typeof COUPON_TYPES)[number];

interface CouponRow {
  id: string;
  code: string;
  type: string;
  value: number;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

function isExpired(coupon: CouponRow): boolean {
  return !!coupon.expires_at && new Date(coupon.expires_at).getTime() < Date.now();
}

/**
 * Discount in paisa, from the coupon row only:
 * percent → floor(subtotal * value / 100); amount → min(value, subtotal);
 * free_delivery → 0 (the delivery charge is waived instead).
 */
function computeDiscount(coupon: CouponRow, subtotalPaisa: number): { discountPaisa: number; freeDelivery: boolean } {
  const subtotal = Math.max(0, Math.floor(subtotalPaisa));
  if (coupon.type === 'percent') {
    return { discountPaisa: Math.floor((subtotal * Number(coupon.value)) / 100), freeDelivery: false };
  }
  if (coupon.type === 'amount') {
    return { discountPaisa: Math.min(Number(coupon.value), subtotal), freeDelivery: false };
  }
  return { discountPaisa: 0, freeDelivery: true }; // free_delivery
}

/** GET /api/coupons — list all coupons for this workspace. */
couponsRouter.get('/coupons', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rows } = await query<CouponRow>(
    workspaceId,
    'SELECT id, code, type, value, expires_at, created_at, updated_at FROM coupons WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 200',
    [workspaceId],
  );
  res.json({ coupons: rows });
});

/** POST /api/coupons {code, type, value, expiresAt?} — create a coupon. */
couponsRouter.post('/coupons', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { code, type, value, expiresAt } = (req.body ?? {}) as {
    code?: string;
    type?: string;
    value?: number;
    expiresAt?: string;
  };
  const cleanCode = typeof code === 'string' ? code.trim() : '';
  if (!cleanCode) {
    res.status(400).json({ error: 'code is required' });
    return;
  }
  if (!type || !(COUPON_TYPES as readonly string[]).includes(type)) {
    res.status(400).json({ error: `type must be one of: ${COUPON_TYPES.join(', ')}` });
    return;
  }
  if (typeof value !== 'number' || value < 0) {
    res.status(400).json({ error: 'value must be a non-negative number' });
    return;
  }
  const dupe = await queryOne(
    workspaceId,
    'SELECT id FROM coupons WHERE workspace_id = $1 AND code = $2',
    [workspaceId, cleanCode],
  );
  if (dupe) {
    res.status(409).json({ error: 'এই কোডের কুপন ইতিমধ্যে আছে।' });
    return;
  }
  const { rows } = await query<CouponRow>(
    workspaceId,
    `INSERT INTO coupons (workspace_id, code, type, value, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, code, type, value, expires_at, created_at, updated_at`,
    [workspaceId, cleanCode, type as CouponType, Math.floor(value), expiresAt ?? null],
  );
  res.status(201).json({ coupon: rows[0] });
});

/** PATCH /api/coupons/:id {code?, type?, value?, expiresAt?} — update a coupon. */
couponsRouter.patch('/coupons/:id', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { code, type, value, expiresAt } = (req.body ?? {}) as {
    code?: string;
    type?: string;
    value?: number;
    expiresAt?: string | null;
  };
  if (type !== undefined && !(COUPON_TYPES as readonly string[]).includes(type)) {
    res.status(400).json({ error: `type must be one of: ${COUPON_TYPES.join(', ')}` });
    return;
  }
  if (value !== undefined && (typeof value !== 'number' || value < 0)) {
    res.status(400).json({ error: 'value must be a non-negative number' });
    return;
  }
  const sets: string[] = [];
  const params: unknown[] = [workspaceId, req.params.id];
  const add = (sql: string, v: unknown): void => {
    params.push(v);
    sets.push(`${sql} = $${params.length}`);
  };
  if (code !== undefined) add('code', String(code).trim());
  if (type !== undefined) add('type', type);
  if (value !== undefined) add('value', Math.floor(value));
  if (expiresAt !== undefined) add('expires_at', expiresAt);
  if (sets.length === 0) {
    res.status(400).json({ error: 'Nothing to update' });
    return;
  }
  sets.push('updated_at = now()');
  const { rows } = await query<CouponRow>(
    workspaceId,
    `UPDATE coupons SET ${sets.join(', ')} WHERE workspace_id = $1 AND id = $2
     RETURNING id, code, type, value, expires_at, created_at, updated_at`,
    params,
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Coupon not found' });
    return;
  }
  res.json({ coupon: rows[0] });
});

/** DELETE /api/coupons/:id — delete a coupon. */
couponsRouter.delete('/coupons/:id', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rowCount } = await query(
    workspaceId,
    'DELETE FROM coupons WHERE workspace_id = $1 AND id = $2',
    [workspaceId, req.params.id],
  );
  if (rowCount === 0) {
    res.status(404).json({ error: 'Coupon not found' });
    return;
  }
  res.json({ deleted: true });
});

/**
 * POST /api/coupons/validate {code, subtotalPaisa}
 * → {valid, discountPaisa, freeDelivery?, type?, value?, message?}
 */
couponsRouter.post('/coupons/validate', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { code, subtotalPaisa } = (req.body ?? {}) as { code?: string; subtotalPaisa?: number };
  const cleanCode = typeof code === 'string' ? code.trim() : '';
  if (!cleanCode || typeof subtotalPaisa !== 'number' || subtotalPaisa < 0) {
    res.status(400).json({ error: 'code and a non-negative subtotalPaisa are required' });
    return;
  }
  const coupon = await queryOne<CouponRow>(
    workspaceId,
    'SELECT id, code, type, value, expires_at, created_at, updated_at FROM coupons WHERE workspace_id = $1 AND code = $2',
    [workspaceId, cleanCode],
  );
  if (!coupon) {
    res.json({ valid: false, discountPaisa: 0, message: 'কুপনটি পাওয়া যায়নি।' });
    return;
  }
  if (isExpired(coupon)) {
    res.json({ valid: false, discountPaisa: 0, message: 'কুপনের মেয়াদ শেষ হয়ে গেছে।' });
    return;
  }
  const { discountPaisa, freeDelivery } = computeDiscount(coupon, subtotalPaisa);
  res.json({
    valid: true,
    discountPaisa,
    freeDelivery,
    type: coupon.type,
    value: Number(coupon.value),
    message: 'কুপনটি প্রযোজ্য।',
  });
});

/**
 * POST /api/orders/:id/apply-coupon {code}
 * Only for orders in status pending / on_hold. Subtotal comes from
 * order_items only; the coupon row decides the discount. Records a
 * coupon_redemptions row + an order_events note.
 */
couponsRouter.post('/orders/:id/apply-coupon', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { code } = (req.body ?? {}) as { code?: string };
  const cleanCode = typeof code === 'string' ? code.trim() : '';
  if (!cleanCode) {
    res.status(400).json({ error: 'code is required' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderRes = await client.query(
      'SELECT id, status, total_paisa FROM orders WHERE workspace_id = $1 AND id = $2',
      [workspaceId, req.params.id],
    );
    if (orderRes.rowCount === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    const order = orderRes.rows[0] as { id: string; status: string; total_paisa: number };
    if (order.status !== 'pending' && order.status !== 'on_hold') {
      await client.query('ROLLBACK');
      res.status(400).json({ error: `এই অর্ডারে আর কুপন বসানো যাবে না — অর্ডার এখন ${order.status} অবস্থায় আছে।` });
      return;
    }
    const couponRes = await client.query(
      'SELECT id, code, type, value, expires_at FROM coupons WHERE workspace_id = $1 AND code = $2',
      [workspaceId, cleanCode],
    );
    if (couponRes.rowCount === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'কুপনটি পাওয়া যায়নি।' });
      return;
    }
    const coupon = couponRes.rows[0] as CouponRow;
    if (isExpired(coupon)) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: 'কুপনের মেয়াদ শেষ হয়ে গেছে।' });
      return;
    }
    const already = await client.query(
      'SELECT id FROM coupon_redemptions WHERE workspace_id = $1 AND coupon_id = $2 AND order_id = $3',
      [workspaceId, coupon.id, order.id],
    );
    if (already.rowCount !== null && already.rowCount > 0) {
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'এই কুপনটি এই অর্ডারে ইতিমধ্যে প্রয়োগ করা হয়েছে।' });
      return;
    }
    const subtotalRes = await client.query(
      'SELECT COALESCE(SUM(quantity * price_paisa), 0) AS subtotal FROM order_items WHERE workspace_id = $1 AND order_id = $2',
      [workspaceId, order.id],
    );
    const subtotal = Number((subtotalRes.rows[0] as { subtotal: string }).subtotal);
    const { discountPaisa, freeDelivery } = computeDiscount(coupon, subtotal);
    const newTotal = Math.max(0, subtotal - discountPaisa);
    await client.query(
      'UPDATE orders SET total_paisa = $1, updated_at = now() WHERE workspace_id = $2 AND id = $3',
      [newTotal, workspaceId, order.id],
    );
    await client.query(
      `INSERT INTO coupon_redemptions (workspace_id, coupon_id, order_id, discount_paisa)
       VALUES ($1, $2, $3, $4)`,
      [workspaceId, coupon.id, order.id, discountPaisa],
    );
    const note = freeDelivery
      ? `কুপন ${coupon.code} প্রয়োগ করা হয়েছে — ফ্রি ডেলিভারি।`
      : `কুপন ${coupon.code} প্রয়োগ করা হয়েছে — ছাড় ${discountPaisa} পয়সা।`;
    await client.query(
      'INSERT INTO order_events (workspace_id, order_id, from_status, to_status, note) VALUES ($1, $2, $3, $4, $5)',
      [workspaceId, order.id, order.status, order.status, note],
    );
    await client.query('COMMIT');
    res.json({
      order: { id: order.id, total_paisa: newTotal, discount_paisa: discountPaisa },
      coupon: { id: coupon.id, code: coupon.code, type: coupon.type, value: Number(coupon.value) },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('[coupons/apply]', err);
    res.status(500).json({ error: 'Coupon apply failed' });
  } finally {
    client.release();
  }
});
