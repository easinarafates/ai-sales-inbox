import { Router, type Response } from 'express';
import { pool, query, queryOne } from '../db/pool';
import { config } from '../config';
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
    'SELECT id, type, amount_paisa, description, created_at FROM wallet_transactions WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 100',
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
 * POST /api/billing/topup {amountPaisa} — TEST-ONLY direct top-up.
 *
 * SECURITY: this adds balance to the caller's own wallet with NO payment
 * verification, so it must NEVER be live in production — any shop could
 * give itself unlimited balance. It exists only so the subscription
 * verifier can fund test wallets, and it is gated behind
 * ALLOW_SUBSCRIPTION_TEST_HOOKS (off by default, 403 otherwise). Real
 * top-ups go through the manual request flow (POST /api/billing/topup/
 * request) which the owner approves after checking the real payment.
 */
billingRouter.post('/topup', async (req: AuthRequest, res: Response) => {
  if (!config.allowSubscriptionTestHooks) {
    res.status(403).json({ error: 'Direct top-up is disabled — send a top-up request instead; it is checked by hand.' });
    return;
  }
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
