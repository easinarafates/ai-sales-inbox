/**
 * Manual wallet top-up requests (Phase: courier/topup module).
 * Full paths, mounted at /api by the integrator (see courier/integration-notes.md).
 *
 * This flow works WITHOUT any payment gateway:
 *   1. The shop pays by hand (bKash Send Money / Nagad / bank) and submits
 *      the amount + method + the payer's transaction id.
 *   2. A workspace member reviews the request and approves/rejects it.
 *   3. Approving credits the wallet by the exact amount AND writes a
 *      wallet_transactions row — in one transaction, so the balance and the
 *      ledger can never disagree. Approving twice is impossible: only a
 *      'pending' request can be approved (second attempt → 409).
 *
 * Role note: there is no enforced admin role in the app today — the members
 * table only reliably has 'owner' (set at signup). So any authenticated
 * workspace member may approve/reject; reviewed_by records who did it.
 * If a stricter owner/admin gate is added later, enforce it here.
 *
 * POST /api/billing/topup/request {amountPaisa, method, transactionId} → 201 pending
 * GET  /api/billing/topup/requests → list (newest first)
 * POST /api/billing/topup/:id/approve → credits wallet + ledger entry
 * POST /api/billing/topup/:id/reject {reason} → marks rejected, no wallet change
 *
 * Gateway placeholders (bKash/Nagad base URL + credential env names, NO
 * values) live in config/index.ts — live gateway needs merchant credentials.
 */
import { Router, type Response } from 'express';
import { pool, query, queryOne } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';

export const topupRouter = Router();
topupRouter.use(requireAuth);

export const TOPUP_METHODS = ['bkash', 'nagad', 'bank', 'manual'] as const;
export type TopupMethod = (typeof TOPUP_METHODS)[number];

export const TOPUP_METHOD_BN: Record<TopupMethod, string> = {
  bkash: 'বিকাশ',
  nagad: 'নগদ',
  bank: 'ব্যাংক',
  manual: 'হাতে (ক্যাশ/অন্যান্য)',
};

interface TopupRequestRow {
  id: string;
  workspace_id: string;
  amount_paisa: number;
  method: string;
  transaction_id: string;
  status: string;
  reason: string | null;
  requested_by: string | null;
  reviewed_by: string | null;
  created_at: string;
  updated_at: string;
}

function publicTopupRequest(row: TopupRequestRow) {
  return {
    id: row.id,
    amountPaisa: Number(row.amount_paisa),
    amount_paisa: Number(row.amount_paisa),
    method: row.method,
    methodBn: TOPUP_METHOD_BN[row.method as TopupMethod] ?? row.method,
    transactionId: row.transaction_id,
    transaction_id: row.transaction_id,
    status: row.status,
    reason: row.reason,
    requestedBy: row.requested_by,
    requested_by: row.requested_by,
    reviewedBy: row.reviewed_by,
    reviewed_by: row.reviewed_by,
    createdAt: row.created_at,
    created_at: row.created_at,
  };
}

const TOPUP_COLUMNS =
  'id, workspace_id, amount_paisa, method, transaction_id, status, reason, requested_by, reviewed_by, created_at, updated_at';
const SELECT_TOPUP = `SELECT ${TOPUP_COLUMNS} FROM topup_requests`;

/** POST /api/billing/topup/request — submit a manual top-up request (pending). */
topupRouter.post('/billing/topup/request', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { amountPaisa, method, transactionId } = (req.body ?? {}) as {
    amountPaisa?: number;
    method?: string;
    transactionId?: string;
  };
  if (typeof amountPaisa !== 'number' || !Number.isInteger(amountPaisa) || amountPaisa <= 0) {
    res.status(400).json({ error: 'amountPaisa must be a positive integer (paisa)' });
    return;
  }
  if (!method || !(TOPUP_METHODS as readonly string[]).includes(method)) {
    res.status(400).json({ error: `method must be one of: ${TOPUP_METHODS.join(', ')}` });
    return;
  }
  if (!transactionId || typeof transactionId !== 'string' || transactionId.trim().length === 0) {
    res.status(400).json({
      error: 'transactionId is required — পেমেন্টের লেনদেন আইডি (TrxID) দিন, যাতে যাচাই করা যায়।',
    });
    return;
  }
  const { rows } = await query<TopupRequestRow>(
    workspaceId,
    `INSERT INTO topup_requests (workspace_id, amount_paisa, method, transaction_id, status, requested_by)
     VALUES ($1, $2, $3, $4, 'pending', $5) RETURNING ${TOPUP_COLUMNS}`,
    [workspaceId, amountPaisa, method, transactionId.trim(), req.userId ?? null],
  );
  res.status(201).json({
    topupRequest: publicTopupRequest(rows[0]),
    message: 'টপ-আপের অনুরোধ জমা হয়েছে — যাচাই করে অনুমোদন দেওয়া হলে ব্যালেন্সে টাকা যোগ হবে।',
  });
});

/** GET /api/billing/topup/requests — list this workspace's top-up requests. */
topupRouter.get('/billing/topup/requests', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const params: unknown[] = [workspaceId];
  let where = 'WHERE workspace_id = $1';
  if (status) {
    params.push(status);
    where += ` AND status = $${params.length}`;
  }
  const { rows } = await query<TopupRequestRow>(
    workspaceId,
    `${SELECT_TOPUP} ${where} ORDER BY created_at DESC LIMIT 200`,
    params,
  );
  res.json({ topupRequests: rows.map(publicTopupRequest) });
});

/** POST /api/billing/topup/:id/approve — credit the wallet + ledger entry (atomic). */
topupRouter.post('/billing/topup/:id/approve', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const existing = await queryOne<TopupRequestRow>(
    workspaceId,
    `${SELECT_TOPUP} WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, req.params.id],
  );
  if (!existing) {
    res.status(404).json({ error: 'Top-up request not found' });
    return;
  }
  if (existing.status !== 'pending') {
    res.status(409).json({
      error: `Top-up request is already ${existing.status} — it cannot be approved again`,
      topupRequest: publicTopupRequest(existing),
    });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ws = await client.query(
      'UPDATE workspaces SET balance_paisa = balance_paisa + $1, updated_at = now() WHERE id = $2 RETURNING balance_paisa',
      [Number(existing.amount_paisa), workspaceId],
    );
    await client.query(
      "INSERT INTO wallet_transactions (workspace_id, type, amount_paisa) VALUES ($1, 'topup', $2)",
      [workspaceId, Number(existing.amount_paisa)],
    );
    const updated = await client.query(
      `UPDATE topup_requests SET status = 'approved', reviewed_by = $1, updated_at = now()
       WHERE workspace_id = $2 AND id = $3 AND status = 'pending'
       RETURNING id, workspace_id, amount_paisa, method, transaction_id, status, reason, requested_by, reviewed_by, created_at, updated_at`,
      [req.userId ?? null, workspaceId, req.params.id],
    );
    if (updated.rowCount === 0) {
      // Lost a race with another approval — roll back the credit.
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'Top-up request was already reviewed' });
      return;
    }
    await client.query('COMMIT');
    res.json({
      topupRequest: publicTopupRequest(updated.rows[0] as TopupRequestRow),
      balancePaisa: ws.rows[0].balance_paisa,
      message: 'টপ-আপ অনুমোদন করা হয়েছে — ব্যালেন্সে টাকা যোগ হয়েছে।',
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('[billing/topup/approve]', err);
    res.status(500).json({ error: 'Top-up approval failed' });
  } finally {
    client.release();
  }
});

/** POST /api/billing/topup/:id/reject {reason} — reject; wallet is untouched. */
topupRouter.post('/billing/topup/:id/reject', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { reason } = (req.body ?? {}) as { reason?: string };
  const existing = await queryOne<TopupRequestRow>(
    workspaceId,
    `${SELECT_TOPUP} WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, req.params.id],
  );
  if (!existing) {
    res.status(404).json({ error: 'Top-up request not found' });
    return;
  }
  if (existing.status !== 'pending') {
    res.status(409).json({
      error: `Top-up request is already ${existing.status} — it cannot be rejected again`,
      topupRequest: publicTopupRequest(existing),
    });
    return;
  }
  const { rows } = await query<TopupRequestRow>(
    workspaceId,
    `UPDATE topup_requests SET status = 'rejected', reason = $1, reviewed_by = $2, updated_at = now()
     WHERE workspace_id = $3 AND id = $4 AND status = 'pending'
     RETURNING id, workspace_id, amount_paisa, method, transaction_id, status, reason, requested_by, reviewed_by, created_at, updated_at`,
    [typeof reason === 'string' && reason.trim() ? reason.trim() : null, req.userId ?? null, workspaceId, req.params.id],
  );
  if (rows.length === 0) {
    res.status(409).json({ error: 'Top-up request was already reviewed' });
    return;
  }
  res.json({
    topupRequest: publicTopupRequest(rows[0]),
    message: 'টপ-আপের অনুরোধ বাতিল করা হয়েছে — ব্যালেন্সে কোনো টাকা যোগ হয়নি।',
  });
});
