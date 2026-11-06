/**
 * Owner-wallet auto-deduction (Owner Panel, migration 11).
 *
 * Every AI reply's provider cost (ai_usage_ledger.provider_cost_paisa,
 * written by the agent per reply) is deducted from the OWNER wallet —
 * the platform owner pays the AI providers, not the shops. The shop's own
 * wallet charge (cost_paisa, 0 or the flat 10-paisa overage) is untouched;
 * the two wallets are separate.
 *
 * Each ledger row is deducted exactly once: the sweep marks it
 * owner_deducted=true inside the same transaction as the deduction, so a
 * second run (or a concurrent run) can never deduct it again. The owner
 * balance may go negative — that is recorded honestly and the low-balance
 * warning (balance < threshold) tells the owner to top up.
 *
 * Runs from the API's 60s PGlite sweep and the BullMQ worker sweep, and
 * on demand via POST /api/owner/wallet/sweep.
 */
import { pool } from '../db/pool';

export interface OwnerDeductionResult {
  deductedRows: number;
  totalPaisa: number;
}

export async function getOwnerWallet(): Promise<{ balancePaisa: number; lowBalanceThresholdPaisa: number }> {
  const { rows } = await pool.query(
    'SELECT balance_paisa, low_balance_threshold_paisa FROM owner_wallet ORDER BY created_at ASC LIMIT 1',
  );
  const row = rows[0] as { balance_paisa: number; low_balance_threshold_paisa: number } | undefined;
  if (!row) {
    // Migration 11 seeds the row; this is only a safety net.
    const created = await pool.query(
      'INSERT INTO owner_wallet (balance_paisa, low_balance_threshold_paisa) VALUES (0, 100000) RETURNING balance_paisa, low_balance_threshold_paisa',
    );
    const c = created.rows[0] as { balance_paisa: number; low_balance_threshold_paisa: number };
    return { balancePaisa: Number(c.balance_paisa), lowBalanceThresholdPaisa: Number(c.low_balance_threshold_paisa) };
  }
  return {
    balancePaisa: Number(row.balance_paisa),
    lowBalanceThresholdPaisa: Number(row.low_balance_threshold_paisa),
  };
}

export async function processOwnerWalletDeductions(): Promise<OwnerDeductionResult> {
  const { rows } = await pool.query<{ id: string; provider: string; provider_cost_paisa: number }>(
    `SELECT id, provider, provider_cost_paisa FROM ai_usage_ledger
     WHERE owner_deducted = FALSE AND provider_cost_paisa > 0
     ORDER BY created_at ASC LIMIT 500`,
  );
  let deductedRows = 0;
  let totalPaisa = 0;
  for (const row of rows) {
    const cost = Number(row.provider_cost_paisa);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const marked = await client.query(
        'UPDATE ai_usage_ledger SET owner_deducted = TRUE WHERE id = $1 AND owner_deducted = FALSE',
        [row.id],
      );
      if (marked.rowCount === 0) {
        // Lost a race with another sweep — skip without deducting.
        await client.query('ROLLBACK');
        continue;
      }
      await client.query(
        'UPDATE owner_wallet SET balance_paisa = balance_paisa - $1, updated_at = now() WHERE id = (SELECT id FROM owner_wallet ORDER BY created_at ASC LIMIT 1)',
        [cost],
      );
      await client.query(
        "INSERT INTO owner_wallet_transactions (type, amount_paisa, provider, reference, note) VALUES ('ai_cost', $1, $2, $3, $4)",
        [-cost, row.provider, row.id, 'AI reply provider cost (auto-deducted)'],
      );
      await client.query('COMMIT');
      deductedRows += 1;
      totalPaisa += cost;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      console.error('[owner/sweep] deduction failed for ledger row', row.id, (err as Error).message);
    } finally {
      client.release();
    }
  }
  return { deductedRows, totalPaisa };
}
