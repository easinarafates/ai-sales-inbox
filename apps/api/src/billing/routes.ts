import { Router, type Response } from 'express';
import { pool, query, queryOne } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';

export const billingRouter = Router();
billingRouter.use(requireAuth);

/** GET /api/billing — balance + wallet transactions + AI usage ledger. */
billingRouter.get('/', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const workspace = await queryOne<{ balance_paisa: number }>(
    workspaceId,
    'SELECT balance_paisa FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  const { rows: transactions } = await query(
    workspaceId,
    'SELECT id, type, amount_paisa, created_at FROM wallet_transactions WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 100',
    [workspaceId],
  );
  const { rows: usage } = await query(
    workspaceId,
    `SELECT id, conversation_id, input_tokens, output_tokens, cost_paisa, provider, created_at
     FROM ai_usage_ledger WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [workspaceId],
  );
  res.json({ balancePaisa: workspace?.balance_paisa ?? 0, transactions, usage });
});

/**
 * POST /api/billing/topup {amountPaisa} — manual/stub top-up.
 * Phase 1 has NO payment gateway: this records a manual top-up (e.g. bKash/
 * bank transfer confirmed by the team). A real gateway plugs in here later.
 */
billingRouter.post('/topup', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { amountPaisa } = (req.body ?? {}) as { amountPaisa?: number };
  if (typeof amountPaisa !== 'number' || !Number.isInteger(amountPaisa) || amountPaisa <= 0) {
    res.status(400).json({ error: 'amountPaisa must be a positive integer (paisa)' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ws = await client.query(
      'UPDATE workspaces SET balance_paisa = balance_paisa + $1, updated_at = now() WHERE id = $2 RETURNING balance_paisa',
      [amountPaisa, workspaceId],
    );
    await client.query(
      "INSERT INTO wallet_transactions (workspace_id, type, amount_paisa) VALUES ($1, 'topup', $2)",
      [workspaceId, amountPaisa],
    );
    await client.query('COMMIT');
    res.status(201).json({ balancePaisa: ws.rows[0].balance_paisa });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('[billing/topup]', err);
    res.status(500).json({ error: 'Top-up failed' });
  } finally {
    client.release();
  }
});
