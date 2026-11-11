import { Router, type Response } from 'express';
import { pool, query, queryOne } from '../db/pool';
import { config } from '../config';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';
import { tokenRateForModel } from '../ai-agent/pricing';
import { purchaseReplyPackage } from '../subscriptions/service';

export const billingRouter = Router();
billingRouter.use(requireAuth);

/**
 * Per-token cost of the workspace's default AI model, in paisa per
 * 1,000 tokens — shown on the Billing page so the shop sees exactly
 * what pay-as-you-go deducts. Rates come from ai-agent/pricing.ts
 * (the provider's published pricing). The ledger also records
 * the provider's real cost of every reply (provider_cost_paisa),
 * while the shop pays the flat pay-as-you-go price (23 paisa).
 */
function tokenRates() {
  const model = config.aiModel;
  const rate = tokenRateForModel(model);
  const perUsd = config.usdToBdtPaisa;
  return {
    model,
    provider: config.aiProvider,
    inputUsdPerMillionTokens: rate.input,
    outputUsdPerMillionTokens: rate.output,
    inputPaisaPer1000Tokens: Math.round(rate.input * perUsd / 1000 * 100) / 100,
    outputPaisaPer1000Tokens: Math.round(rate.output * perUsd / 1000 * 100) / 100,
  };
}

/**
 * GET /api/billing — balance + wallet transactions + AI usage ledger
 * + reply-package credits + per-token rates (YEARBITO Phase 2).
 *
 * The ledger has TWO costs per reply (see ai-agent/agent.ts):
 * - cost_paisa = what the WALLET was charged (0 for trial / included /
 *   package replies, 50 for pay-as-you-go).
 * - provider_cost_paisa = what the reply actually cost us at the
 *   provider (Gemini), always recorded, even when the wallet paid 0.
 * The page shows the provider cost as "Total AI cost" and per reply,
 * so a shop on trial still sees what its AI usage costs — the wallet
 * charge is shown separately. Totals are aggregates over ALL rows
 * (the table itself shows only the last 100).
 */
billingRouter.get('/', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const workspace = await queryOne<{ balance_paisa: number; reply_credits: number }>(
    workspaceId,
    'SELECT balance_paisa, reply_credits FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  const { rows: transactions } = await query(
    workspaceId,
    'SELECT id, type, amount_paisa, description, created_at FROM wallet_transactions WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 100',
    [workspaceId],
  );
  const { rows: usage } = await query(
    workspaceId,
    `SELECT id, conversation_id, input_tokens, output_tokens, cost_paisa, provider_cost_paisa, provider, model, package_credit_used, included_in_plan, created_at
     FROM ai_usage_ledger WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [workspaceId],
  );
  const totals = await queryOne<{ total_provider_cost_paisa: string | number; total_wallet_charged_paisa: string | number; usage_count: string | number }>(
    workspaceId,
    `SELECT COALESCE(SUM(provider_cost_paisa), 0) AS total_provider_cost_paisa,
            COALESCE(SUM(cost_paisa), 0) AS total_wallet_charged_paisa,
            COUNT(*) AS usage_count
     FROM ai_usage_ledger WHERE workspace_id = $1`,
    [workspaceId],
  );
  res.json({
    balancePaisa: workspace?.balance_paisa ?? 0,
    transactions,
    usage,
    totalProviderCostPaisa: Number(totals?.total_provider_cost_paisa ?? 0),
    totalWalletChargedPaisa: Number(totals?.total_wallet_charged_paisa ?? 0),
    usageCount: Number(totals?.usage_count ?? 0),
    replyCredits: workspace?.reply_credits ?? 0,
    packagePricePaisa: config.replyPackagePricePaisa,
    tokenRates: tokenRates(),
  });
});

/**
 * POST /api/billing/reply-package {replies} — buy a bundle of AI
 * replies upfront (default 22 paisa/reply, REPLY_PACKAGE_PRICE_PAISA).
 * Paid from the wallet balance; credits land in reply_credits at once
 * and are consumed FIRST by AI replies, before pay-as-you-go. Not
 * enough balance → 402 + Bengali message. Nothing here is ever shown
 * as "paid" before the wallet was actually charged.
 */
billingRouter.post('/reply-package', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { replies } = (req.body ?? {}) as { replies?: number };
  if (typeof replies !== 'number') {
    res.status(400).json({ error: 'replies (সংখ্যা) দরকার।' });
    return;
  }
  try {
    const result = await purchaseReplyPackage(workspaceId, replies);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.status(201).json({
      replies: result.replies,
      totalPaisa: result.totalPaisa,
      pricePerReplyPaisa: result.pricePerReplyPaisa,
      balancePaisa: result.balancePaisa,
      replyCredits: result.replyCredits,
      message: `${result.replies}টি রিপ্লাই কেনা হয়েছে — প্রতিটি ${result.pricePerReplyPaisa} পয়সা করে।`,
    });
  } catch (err) {
    console.error('[billing/reply-package]', err);
    res.status(500).json({ error: 'রিপ্লাই প্যাকেজ কেনা যায়নি।' });
  }
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
