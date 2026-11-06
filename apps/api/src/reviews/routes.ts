/**
 * Review requests (Phase 3, PDF §4 ঘ) — ask for a review after delivery.
 * Full paths, mounted at /api.
 *
 * POST /api/orders/:id/request-review creates a review_requests row and logs
 * an outbound review-request message STUB (log only — real Meta send needs
 * Meta approval; no message row is created here).
 */
import { Router, type Response } from 'express';
import { query, queryOne } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';

export const reviewsRouter = Router();
reviewsRouter.use(requireAuth);

interface ReviewRequestRow {
  id: string;
  order_id: string;
  customer_id: string | null;
  status: string;
  created_at: string;
}

/** POST /api/orders/:id/request-review → {reviewRequest} (201). */
reviewsRouter.post('/orders/:id/request-review', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const order = await queryOne<{ id: string; customer_id: string | null }>(
    workspaceId,
    'SELECT id, customer_id FROM orders WHERE workspace_id = $1 AND id = $2',
    [workspaceId, req.params.id],
  );
  if (!order) {
    res.status(404).json({ error: 'Order not found' });
    return;
  }
  const { rows } = await query<ReviewRequestRow>(
    workspaceId,
    `INSERT INTO review_requests (workspace_id, order_id, customer_id, status)
     VALUES ($1, $2, $3, 'requested')
     RETURNING id, order_id, customer_id, status, created_at`,
    [workspaceId, order.id, order.customer_id],
  );
  // STUB: outbound review-request message — log only, not really sent.
  console.log(
    `[review-request-stub] order ${order.id} customer ${order.customer_id ?? 'unknown'} — review request logged (STUB — not really sent; real Meta send needs approval)`,
  );
  res.status(201).json({ reviewRequest: rows[0] });
});

/** GET /api/reviews — review requests joined with order + customer names. */
reviewsRouter.get('/reviews', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rows } = await query(
    workspaceId,
    `SELECT rr.id, rr.order_id, rr.customer_id, rr.status, rr.created_at,
            o.total_paisa AS order_total_paisa, c.name AS customer_name
     FROM review_requests rr
     LEFT JOIN orders o ON o.id = rr.order_id AND o.workspace_id = $1
     LEFT JOIN customers c ON c.id = rr.customer_id AND c.workspace_id = $1
     WHERE rr.workspace_id = $1 ORDER BY rr.created_at DESC LIMIT 200`,
    [workspaceId],
  );
  res.json({ reviews: rows });
});
