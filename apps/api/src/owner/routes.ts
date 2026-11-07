/**
 * Owner Panel — platform super-admin API (migration 11).
 * Mounted at /api/owner (see apps/api/src/index.ts).
 *
 * The platform owner (Arafat) controls the whole SaaS business here:
 *  - Overview totals (shops, subscriptions, revenue, API spend, wallet)
 *  - Account management (all shops, suspend/activate)
 *  - Bank accounts for receiving subscription money (encrypted, masked)
 *  - Expenses (record + monthly totals by category)
 *  - API cost tracking per provider + per shop (from ai_usage_ledger only)
 *  - Owner wallet + deposits (request → manual approve) + cards on file
 *    (brand + last 4 only) + auto-deduction of AI provider costs
 *
 * Money honesty:
 * - All money is in paisa (৳ = paisa / 100). Revenue = real
 *   subscription_charge rows in wallet_transactions, never the plan list.
 * - Deposits are REQUESTS with manual approval — no live payment gateway
 *   is called and no real card is charged. The UI must label this.
 * - API costs are ONLY what ai_usage_ledger.provider_cost_paisa records.
 * - Expenses are the owner's own bookkeeping and are NOT auto-deducted
 *   from the wallet; the wallet only moves on deposits and AI-cost
 *   auto-deduction.
 *
 * Access: every route except /setup and /me requires requireOwner
 * (platform owner, users.is_owner). Shop owners get 403.
 */
import { Router, type Response } from 'express';
import { config } from '../config';
import { pool } from '../db/pool';
import { decryptToken, encryptToken } from '../db/crypto';
import type { AuthRequest } from '../types';
import { requireAuth } from '../auth/auth';
import { requireOwner } from './ownerAuth';
import { getOwnerWallet, processOwnerWalletDeductions } from './sweep';

export const ownerRouter = Router();

// ---------------------------------------------------------------------------
// Bootstrap + identity (public / normal auth only)
// ---------------------------------------------------------------------------

/**
 * POST /api/owner/setup { email, setupToken? } — promote a user to
 * platform owner. If OWNER_SETUP_TOKEN is set, the token must match.
 * If unset, promotion is allowed ONLY while no owner exists yet
 * (first-run bootstrap). Idempotent: promoting an existing owner is ok.
 */
ownerRouter.post('/setup', async (req: AuthRequest, res: Response) => {
  const { email, setupToken } = (req.body ?? {}) as { email?: string; setupToken?: string };
  if (!email || typeof email !== 'string') {
    res.status(400).json({ error: 'email is required' });
    return;
  }
  if (config.ownerSetupToken) {
    if (setupToken !== config.ownerSetupToken) {
      res.status(403).json({ error: 'Invalid setup token' });
      return;
    }
  } else {
    const owners = await pool.query('SELECT COUNT(*) AS n FROM users WHERE is_owner = TRUE');
    if (Number((owners.rows[0] as { n: string }).n) > 0) {
      res.status(403).json({ error: 'An owner already exists — set OWNER_SETUP_TOKEN to promote another user' });
      return;
    }
  }
  const { rows } = await pool.query<{ id: string; email: string; name: string | null }>(
    'UPDATE users SET is_owner = TRUE WHERE email = $1 RETURNING id, email, name',
    [email.trim()],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'No user with that email — sign up first, then promote' });
    return;
  }
  res.json({ owner: rows[0], message: 'Platform owner set — this account can now open the Owner Panel.' });
});

/** GET /api/owner/me — is the caller a platform owner? (Sidebar uses this to show/hide the Owner Panel link.) */
ownerRouter.get('/me', requireAuth, async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query<{ is_owner: boolean }>(
    'SELECT is_owner FROM users WHERE id = $1',
    [req.userId],
  );
  res.json({ isOwner: rows[0]?.is_owner === true });
});

// Every route below requires the platform owner.
ownerRouter.use(requireOwner);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function monthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0));
}

function parseDays(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? Number(value) : fallback;
  return n === 7 || n === 30 ? n : fallback;
}

function parsePeriod(value: unknown): { days: number; label: string } {
  if (value === '7d') return { days: 7, label: '7d' };
  if (value === 'month') return { days: -1, label: 'month' };
  return { days: 30, label: '30d' };
}

function rangeStart(days: number): Date {
  if (days === -1) return monthStart(new Date());
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - (days - 1));
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * DATE columns come back from the driver as JS Dates (local midnight), and
 * String(date).slice(0, 10) gives "Sat Nov 07" — not a YYYY-MM-DD date.
 * Format them properly so day keys match the YYYY-MM-DD keys the trend and
 * by-day breakdowns build. Strings (already YYYY-MM-DD) pass through.
 */
function isoDate(v: unknown): string {
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

interface BankAccountRow {
  id: string;
  bank_name: string;
  account_holder: string;
  account_number_last4: string;
  branch: string | null;
  type: string;
  is_primary: boolean;
  created_at: string;
  updated_at: string;
}

function publicBankAccount(row: BankAccountRow) {
  return {
    id: row.id,
    bankName: row.bank_name,
    bank_name: row.bank_name,
    accountHolder: row.account_holder,
    account_holder: row.account_holder,
    accountNumberMasked: `••••${row.account_number_last4}`,
    account_number_masked: `••••${row.account_number_last4}`,
    accountNumberLast4: row.account_number_last4,
    account_number_last4: row.account_number_last4,
    branch: row.branch,
    type: row.type,
    isPrimary: row.is_primary,
    is_primary: row.is_primary,
    createdAt: row.created_at,
    created_at: row.created_at,
  };
}

interface DepositRow {
  id: string;
  amount_paisa: number;
  method: string;
  transaction_id: string | null;
  status: string;
  card_id: string | null;
  requested_by: string | null;
  reviewed_by: string | null;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

function publicDeposit(row: DepositRow) {
  return {
    id: row.id,
    amountPaisa: Number(row.amount_paisa),
    amount_paisa: Number(row.amount_paisa),
    method: row.method,
    transactionId: row.transaction_id,
    transaction_id: row.transaction_id,
    status: row.status,
    cardId: row.card_id,
    card_id: row.card_id,
    requestedBy: row.requested_by,
    requested_by: row.requested_by,
    reviewedBy: row.reviewed_by,
    reviewed_by: row.reviewed_by,
    reason: row.reason,
    createdAt: row.created_at,
    created_at: row.created_at,
  };
}

interface ExpenseRow {
  id: string;
  expense_date: string;
  category: string;
  amount_paisa: number;
  note: string | null;
  created_at: string;
}

function publicExpense(row: ExpenseRow) {
  return {
    id: row.id,
    date: typeof row.expense_date === 'string' ? row.expense_date.slice(0, 10) : row.expense_date,
    category: row.category,
    amountPaisa: Number(row.amount_paisa),
    amount_paisa: Number(row.amount_paisa),
    note: row.note,
    createdAt: row.created_at,
    created_at: row.created_at,
  };
}

const DEPOSIT_METHODS = ['card', 'bkash', 'nagad', 'bank'] as const;
const EXPENSE_CATEGORIES = ['hosting', 'domain', 'ai', 'ads', 'other'] as const;
const BANK_TYPES = ['bank', 'bkash', 'nagad'] as const;

const BANK_COLUMNS =
  'id, bank_name, account_holder, account_number_last4, branch, type, is_primary, created_at, updated_at';
const DEPOSIT_COLUMNS =
  'id, amount_paisa, method, transaction_id, status, card_id, requested_by, reviewed_by, reason, created_at, updated_at';
const EXPENSE_COLUMNS = 'id, expense_date, category, amount_paisa, note, created_at';

// ---------------------------------------------------------------------------
// 1. Overview
// ---------------------------------------------------------------------------

/** GET /api/owner/overview?days=7|30 — totals + per-day trend. */
ownerRouter.get('/overview', async (req: AuthRequest, res: Response) => {
  const days = parseDays(req.query.days, 30);
  const since = rangeStart(days);
  const thisMonth = monthStart(new Date());

  const shops = await pool.query<{ total: string; active: string }>(
    'SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE suspended = FALSE) AS active FROM workspaces',
  );
  const subs = await pool.query<{ active: string }>(
    "SELECT COUNT(*) AS active FROM workspace_subscriptions WHERE status IN ('active', 'trial') AND current_period_end > now()",
  );
  const revenue = await pool.query<{ total: string; charges: string }>(
    "SELECT COALESCE(-SUM(amount_paisa), 0) AS total, COUNT(*) AS charges FROM wallet_transactions WHERE type = 'subscription_charge' AND created_at >= $1",
    [thisMonth.toISOString()],
  );
  const mrr = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(p.price_paisa), 0) AS total
     FROM workspace_subscriptions ws JOIN plans p ON p.id = ws.plan_id
     WHERE ws.status IN ('active', 'trial') AND ws.current_period_end > now()`,
  );
  const apiSpend = await pool.query<{ total: string; month: string }>(
    `SELECT COALESCE(SUM(provider_cost_paisa), 0) AS total,
            COALESCE(SUM(provider_cost_paisa) FILTER (WHERE created_at >= $1), 0) AS month
     FROM ai_usage_ledger`,
    [thisMonth.toISOString()],
  );
  const wallet = await getOwnerWallet();

  // Per-day trend (zero-filled in JS so missing days show as 0).
  const revByDay = await pool.query<{ day: string; total: string }>(
    `SELECT DATE(created_at) AS day, COALESCE(-SUM(amount_paisa), 0) AS total
     FROM wallet_transactions WHERE type = 'subscription_charge' AND created_at >= $1
     GROUP BY DATE(created_at) ORDER BY day`,
    [since.toISOString()],
  );
  const costByDay = await pool.query<{ day: string; total: string }>(
    `SELECT DATE(created_at) AS day, COALESCE(SUM(provider_cost_paisa), 0) AS total
     FROM ai_usage_ledger WHERE created_at >= $1 GROUP BY DATE(created_at) ORDER BY day`,
    [since.toISOString()],
  );
  const revMap = new Map<string, number>();
  for (const r of revByDay.rows) revMap.set(isoDate(r.day), Number(r.total));
  const costMap = new Map<string, number>();
  for (const r of costByDay.rows) costMap.set(isoDate(r.day), Number(r.total));
  const trend: { date: string; revenuePaisa: number; apiCostPaisa: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    trend.push({
      date: key,
      revenuePaisa: revMap.get(key) ?? 0,
      apiCostPaisa: costMap.get(key) ?? 0,
    });
  }

  res.json({
    shops: {
      total: Number(shops.rows[0]?.total ?? 0),
      active: Number(shops.rows[0]?.active ?? 0),
    },
    activeSubscriptions: Number(subs.rows[0]?.active ?? 0),
    revenueThisMonthPaisa: Number(revenue.rows[0]?.total ?? 0),
    revenueThisMonthCharges: Number(revenue.rows[0]?.charges ?? 0),
    expectedMonthlyRevenuePaisa: Number(mrr.rows[0]?.total ?? 0),
    apiSpendThisMonthPaisa: Number(apiSpend.rows[0]?.month ?? 0),
    apiSpendTotalPaisa: Number(apiSpend.rows[0]?.total ?? 0),
    ownerWallet: {
      balancePaisa: wallet.balancePaisa,
      lowBalanceThresholdPaisa: wallet.lowBalanceThresholdPaisa,
      lowBalance: wallet.balancePaisa < wallet.lowBalanceThresholdPaisa,
    },
    trend,
  });
});

// ---------------------------------------------------------------------------
// 2. Account management (shops)
// ---------------------------------------------------------------------------

/** GET /api/owner/shops — every shop with owner, plan, status, joined date. */
ownerRouter.get('/shops', async (_req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT w.id, w.name, w.balance_paisa, w.suspended, w.ai_enabled, w.practice_mode, w.created_at,
            (SELECT u.name FROM users u WHERE u.workspace_id = w.id ORDER BY u.created_at ASC LIMIT 1) AS owner_name,
            (SELECT u.email FROM users u WHERE u.workspace_id = w.id ORDER BY u.created_at ASC LIMIT 1) AS owner_email,
            (SELECT p.name_bn FROM workspace_subscriptions ws JOIN plans p ON p.id = ws.plan_id
              WHERE ws.workspace_id = w.id ORDER BY ws.created_at DESC LIMIT 1) AS plan_name,
            (SELECT ws.status FROM workspace_subscriptions ws
              WHERE ws.workspace_id = w.id ORDER BY ws.created_at DESC LIMIT 1) AS plan_status,
            (SELECT ws.current_period_end FROM workspace_subscriptions ws
              WHERE ws.workspace_id = w.id ORDER BY ws.created_at DESC LIMIT 1) AS plan_ends_at
     FROM workspaces w ORDER BY w.created_at DESC`,
  );
  res.json({
    shops: rows.map((r) => ({
      id: r.id,
      name: r.name,
      balancePaisa: Number(r.balance_paisa),
      suspended: r.suspended === true,
      aiEnabled: r.ai_enabled === true,
      practiceMode: r.practice_mode === true,
      ownerName: r.owner_name,
      ownerEmail: r.owner_email,
      planName: r.plan_name,
      planStatus: r.plan_status,
      planEndsAt: r.plan_ends_at,
      joinedAt: r.created_at,
      created_at: r.created_at,
    })),
  });
});

/** GET /api/owner/shops/:id — one shop + usage totals. */
ownerRouter.get('/shops/:id', async (req: AuthRequest, res: Response) => {
  const id = req.params.id;
  const { rows } = await pool.query(
    `SELECT w.id, w.name, w.balance_paisa, w.suspended, w.ai_enabled, w.practice_mode, w.created_at,
            (SELECT u.name FROM users u WHERE u.workspace_id = w.id ORDER BY u.created_at ASC LIMIT 1) AS owner_name,
            (SELECT u.email FROM users u WHERE u.workspace_id = w.id ORDER BY u.created_at ASC LIMIT 1) AS owner_email
     FROM workspaces w WHERE w.id = $1`,
    [id],
  );
  const shop = rows[0];
  if (!shop) {
    res.status(404).json({ error: 'Shop not found' });
    return;
  }
  const counts = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM orders WHERE workspace_id = $1) AS orders,
       (SELECT COUNT(*) FROM conversations WHERE workspace_id = $1) AS conversations,
       (SELECT COUNT(*) FROM ai_usage_ledger WHERE workspace_id = $1) AS ai_replies,
       (SELECT COALESCE(SUM(provider_cost_paisa), 0) FROM ai_usage_ledger WHERE workspace_id = $1) AS api_cost_paisa`,
    [id],
  );
  const subs = await pool.query(
    `SELECT ws.status, ws.current_period_start, ws.current_period_end, p.name_bn AS plan_name, p.price_paisa AS plan_price
     FROM workspace_subscriptions ws JOIN plans p ON p.id = ws.plan_id
     WHERE ws.workspace_id = $1 ORDER BY ws.created_at DESC LIMIT 5`,
    [id],
  );
  res.json({
    shop: {
      id: shop.id,
      name: shop.name,
      balancePaisa: Number(shop.balance_paisa),
      suspended: shop.suspended === true,
      aiEnabled: shop.ai_enabled === true,
      practiceMode: shop.practice_mode === true,
      ownerName: shop.owner_name,
      ownerEmail: shop.owner_email,
      joinedAt: shop.created_at,
    },
    totals: {
      orders: Number(counts.rows[0]?.orders ?? 0),
      conversations: Number(counts.rows[0]?.conversations ?? 0),
      aiReplies: Number(counts.rows[0]?.ai_replies ?? 0),
      apiCostPaisa: Number(counts.rows[0]?.api_cost_paisa ?? 0),
    },
    subscriptions: subs.rows.map((s) => ({
      status: s.status,
      planName: s.plan_name,
      planPricePaisa: Number(s.plan_price),
      periodStart: s.current_period_start,
      periodEnd: s.current_period_end,
    })),
  });
});

async function setSuspended(req: AuthRequest, res: Response, suspended: boolean): Promise<void> {
  const { rows } = await pool.query<{ id: string; name: string; suspended: boolean }>(
    'UPDATE workspaces SET suspended = $1, updated_at = now() WHERE id = $2 RETURNING id, name, suspended',
    [suspended, req.params.id],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Shop not found' });
    return;
  }
  res.json({
    shop: { id: rows[0].id, name: rows[0].name, suspended: rows[0].suspended === true },
    message: suspended
      ? 'Shop suspended — its users can no longer log in and its AI is paused until re-activated.'
      : 'Shop re-activated.',
  });
}

/** POST /api/owner/shops/:id/suspend — block logins for the shop's users. */
ownerRouter.post('/shops/:id/suspend', async (req: AuthRequest, res: Response) => {
  await setSuspended(req, res, true);
});

/** POST /api/owner/shops/:id/activate — lift a suspension. */
ownerRouter.post('/shops/:id/activate', async (req: AuthRequest, res: Response) => {
  await setSuspended(req, res, false);
});

// ---------------------------------------------------------------------------
// 3. Bank accounts (receive subscription money)
// ---------------------------------------------------------------------------

/** GET /api/owner/bank-accounts — masked numbers only, never the full number. */
ownerRouter.get('/bank-accounts', async (_req: AuthRequest, res: Response) => {
  const { rows } = await pool.query<BankAccountRow>(
    `SELECT ${BANK_COLUMNS} FROM owner_bank_accounts ORDER BY is_primary DESC, created_at ASC`,
  );
  res.json({ bankAccounts: rows.map(publicBankAccount) });
});

/** POST /api/owner/bank-accounts — add an account (number encrypted at rest). */
ownerRouter.post('/bank-accounts', async (req: AuthRequest, res: Response) => {
  const { bankName, accountHolder, accountNumber, branch, type, isPrimary } = (req.body ?? {}) as {
    bankName?: string;
    accountHolder?: string;
    accountNumber?: string;
    branch?: string;
    type?: string;
    isPrimary?: boolean;
  };
  if (!bankName || typeof bankName !== 'string' || !bankName.trim()) {
    res.status(400).json({ error: 'bankName is required' });
    return;
  }
  if (!accountHolder || typeof accountHolder !== 'string' || !accountHolder.trim()) {
    res.status(400).json({ error: 'accountHolder is required' });
    return;
  }
  const digits = typeof accountNumber === 'string' ? accountNumber.replace(/[\s-]/g, '') : '';
  if (!/^\d{6,24}$/.test(digits)) {
    res.status(400).json({ error: 'accountNumber must be 6–24 digits' });
    return;
  }
  if (type && !(BANK_TYPES as readonly string[]).includes(type)) {
    res.status(400).json({ error: `type must be one of: ${BANK_TYPES.join(', ')}` });
    return;
  }
  const last4 = digits.slice(-4);
  let encrypted: string;
  try {
    encrypted = encryptToken(digits);
  } catch (err) {
    console.error('[owner/bank-accounts] encryption failed:', (err as Error).message);
    res.status(500).json({ error: 'Could not store the account securely (encryption key missing)' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (isPrimary === true) {
      await client.query('UPDATE owner_bank_accounts SET is_primary = FALSE');
    }
    const { rows } = await client.query<BankAccountRow>(
      `INSERT INTO owner_bank_accounts (bank_name, account_holder, account_number_encrypted, account_number_last4, branch, type, is_primary)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${BANK_COLUMNS}`,
      [
        bankName.trim(),
        accountHolder.trim(),
        encrypted,
        last4,
        typeof branch === 'string' && branch.trim() ? branch.trim() : null,
        type ?? 'bank',
        isPrimary === true,
      ],
    );
    await client.query('COMMIT');
    res.status(201).json({ bankAccount: publicBankAccount(rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('[owner/bank-accounts] create failed:', (err as Error).message);
    res.status(500).json({ error: 'Could not add the bank account' });
  } finally {
    client.release();
  }
});

/** PATCH /api/owner/bank-accounts/:id — edit details (the number itself cannot be edited; delete + re-add instead). */
ownerRouter.patch('/bank-accounts/:id', async (req: AuthRequest, res: Response) => {
  const { bankName, accountHolder, branch, type, isPrimary } = (req.body ?? {}) as {
    bankName?: string;
    accountHolder?: string;
    branch?: string;
    type?: string;
    isPrimary?: boolean;
  };
  if (type !== undefined && !(BANK_TYPES as readonly string[]).includes(type)) {
    res.status(400).json({ error: `type must be one of: ${BANK_TYPES.join(', ')}` });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (isPrimary === true) {
      await client.query('UPDATE owner_bank_accounts SET is_primary = FALSE');
    }
    const { rows } = await client.query<BankAccountRow>(
      `UPDATE owner_bank_accounts SET
         bank_name = COALESCE($1, bank_name),
         account_holder = COALESCE($2, account_holder),
         branch = COALESCE($3, branch),
         type = COALESCE($4, type),
         is_primary = COALESCE($5, is_primary),
         updated_at = now()
       WHERE id = $6 RETURNING ${BANK_COLUMNS}`,
      [
        typeof bankName === 'string' && bankName.trim() ? bankName.trim() : null,
        typeof accountHolder === 'string' && accountHolder.trim() ? accountHolder.trim() : null,
        typeof branch === 'string' ? branch.trim() || null : null,
        type ?? null,
        isPrimary === undefined ? null : isPrimary,
        req.params.id,
      ],
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Bank account not found' });
      return;
    }
    await client.query('COMMIT');
    res.json({ bankAccount: publicBankAccount(rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('[owner/bank-accounts] update failed:', (err as Error).message);
    res.status(500).json({ error: 'Could not update the bank account' });
  } finally {
    client.release();
  }
});

/** DELETE /api/owner/bank-accounts/:id */
ownerRouter.delete('/bank-accounts/:id', async (req: AuthRequest, res: Response) => {
  const { rowCount } = await pool.query('DELETE FROM owner_bank_accounts WHERE id = $1', [req.params.id]);
  if (rowCount === 0) {
    res.status(404).json({ error: 'Bank account not found' });
    return;
  }
  res.json({ deleted: true });
});

/** GET /api/owner/bank-accounts/:id/verify-number — owner-only re-check that the stored number decrypts (returns masked only). Test/support use; never returns the full number. */
ownerRouter.get('/bank-accounts/:id/verify-number', async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query<{ account_number_encrypted: string; account_number_last4: string }>(
    'SELECT account_number_encrypted, account_number_last4 FROM owner_bank_accounts WHERE id = $1',
    [req.params.id],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Bank account not found' });
    return;
  }
  try {
    const decrypted = decryptToken(rows[0].account_number_encrypted);
    res.json({ ok: decrypted.slice(-4) === rows[0].account_number_last4, masked: `••••${rows[0].account_number_last4}` });
  } catch {
    res.status(500).json({ ok: false, error: 'Stored number could not be decrypted' });
  }
});

// ---------------------------------------------------------------------------
// 4. Expenses
// ---------------------------------------------------------------------------

/** POST /api/owner/expenses — record a new expense. */
ownerRouter.post('/expenses', async (req: AuthRequest, res: Response) => {
  const { date, category, amountPaisa, note } = (req.body ?? {}) as {
    date?: string;
    category?: string;
    amountPaisa?: number;
    note?: string;
  };
  if (!date || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
    res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    return;
  }
  if (!category || !(EXPENSE_CATEGORIES as readonly string[]).includes(category)) {
    res.status(400).json({ error: `category must be one of: ${EXPENSE_CATEGORIES.join(', ')}` });
    return;
  }
  if (typeof amountPaisa !== 'number' || !Number.isInteger(amountPaisa) || amountPaisa <= 0) {
    res.status(400).json({ error: 'amountPaisa must be a positive integer (paisa)' });
    return;
  }
  const { rows } = await pool.query<ExpenseRow>(
    `INSERT INTO owner_expenses (expense_date, category, amount_paisa, note)
     VALUES ($1, $2, $3, $4) RETURNING ${EXPENSE_COLUMNS}`,
    [date, category, amountPaisa, typeof note === 'string' && note.trim() ? note.trim() : null],
  );
  res.status(201).json({ expense: publicExpense(rows[0]) });
});

/** GET /api/owner/expenses?month=YYYY-MM — list + totals by category for the month. */
ownerRouter.get('/expenses', async (req: AuthRequest, res: Response) => {
  const now = new Date();
  const month = typeof req.query.month === 'string' && /^\d{4}-\d{2}$/.test(req.query.month)
    ? req.query.month
    : `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const start = `${month}-01`;
  const [y, m] = month.split('-').map(Number);
  const end = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const { rows } = await pool.query<ExpenseRow>(
    `SELECT ${EXPENSE_COLUMNS} FROM owner_expenses WHERE expense_date >= $1 AND expense_date < $2 ORDER BY expense_date DESC, created_at DESC`,
    [start, end],
  );
  const totals = await pool.query<{ category: string; total: string }>(
    `SELECT category, COALESCE(SUM(amount_paisa), 0) AS total FROM owner_expenses
     WHERE expense_date >= $1 AND expense_date < $2 GROUP BY category ORDER BY total DESC`,
    [start, end],
  );
  const totalsByCategory: Record<string, number> = {};
  for (const c of EXPENSE_CATEGORIES) totalsByCategory[c] = 0;
  let monthTotal = 0;
  for (const t of totals.rows) {
    totalsByCategory[t.category] = Number(t.total);
    monthTotal += Number(t.total);
  }
  res.json({ month, expenses: rows.map(publicExpense), totalsByCategory, monthTotalPaisa: monthTotal });
});

/** DELETE /api/owner/expenses/:id */
ownerRouter.delete('/expenses/:id', async (req: AuthRequest, res: Response) => {
  const { rowCount } = await pool.query('DELETE FROM owner_expenses WHERE id = $1', [req.params.id]);
  if (rowCount === 0) {
    res.status(404).json({ error: 'Expense not found' });
    return;
  }
  res.json({ deleted: true });
});

// ---------------------------------------------------------------------------
// 5. API cost tracking (read-only, from ai_usage_ledger)
// ---------------------------------------------------------------------------

/** GET /api/owner/api-costs?period=7d|30d|month — per-provider + per-shop costs
 * plus per-request rows (newest first) and token totals.
 * Costs come ONLY from ai_usage_ledger.provider_cost_paisa; token counts
 * from input_tokens/output_tokens. Every ledger row is an AI reply, so the
 * per-request purpose is honestly "customer_reply" — no other purpose is
 * invented. Customer name comes from the ledger row's conversation
 * (LEFT JOIN, so rows without a conversation show a blank customer). */
ownerRouter.get('/api-costs', async (req: AuthRequest, res: Response) => {
  const { days, label } = parsePeriod(req.query.period);
  const since = rangeStart(days);
  const byProvider = await pool.query<{ provider: string; replies: string; total: string; wallet: string; in_tokens: string; out_tokens: string }>(
    `SELECT provider, COUNT(*) AS replies,
            COALESCE(SUM(provider_cost_paisa), 0) AS total,
            COALESCE(SUM(cost_paisa), 0) AS wallet,
            COALESCE(SUM(input_tokens), 0) AS in_tokens,
            COALESCE(SUM(output_tokens), 0) AS out_tokens
     FROM ai_usage_ledger WHERE created_at >= $1 GROUP BY provider ORDER BY total DESC`,
    [since.toISOString()],
  );
  const byDay = await pool.query<{ day: string; provider: string; total: string; in_tokens: string; out_tokens: string }>(
    `SELECT DATE(created_at) AS day, provider, COALESCE(SUM(provider_cost_paisa), 0) AS total,
            COALESCE(SUM(input_tokens), 0) AS in_tokens,
            COALESCE(SUM(output_tokens), 0) AS out_tokens
     FROM ai_usage_ledger WHERE created_at >= $1 GROUP BY DATE(created_at), provider ORDER BY day`,
    [since.toISOString()],
  );
  const byShop = await pool.query<{ workspace_id: string; name: string; replies: string; total: string; in_tokens: string; out_tokens: string }>(
    `SELECT l.workspace_id, w.name, COUNT(*) AS replies, COALESCE(SUM(l.provider_cost_paisa), 0) AS total,
            COALESCE(SUM(l.input_tokens), 0) AS in_tokens,
            COALESCE(SUM(l.output_tokens), 0) AS out_tokens
     FROM ai_usage_ledger l LEFT JOIN workspaces w ON w.id = l.workspace_id
     WHERE l.created_at >= $1 GROUP BY l.workspace_id, w.name ORDER BY total DESC`,
    [since.toISOString()],
  );
  const rows = await pool.query<{
    id: string; created_at: string; provider: string; model: string;
    input_tokens: number; output_tokens: number; provider_cost_paisa: number;
    shop_name: string | null; customer_name: string | null;
  }>(
    `SELECT l.id, l.created_at, l.provider, l.model, l.input_tokens, l.output_tokens,
            l.provider_cost_paisa, w.name AS shop_name, cu.name AS customer_name
     FROM ai_usage_ledger l
     LEFT JOIN workspaces w ON w.id = l.workspace_id
     LEFT JOIN conversations c ON c.id = l.conversation_id
     LEFT JOIN customers cu ON cu.id = c.customer_id
     WHERE l.created_at >= $1
     ORDER BY l.created_at DESC, l.id DESC
     LIMIT 100`,
    [since.toISOString()],
  );
  const total = byProvider.rows.reduce((sum, r) => sum + Number(r.total), 0);
  const totalInputTokens = byProvider.rows.reduce((sum, r) => sum + Number(r.in_tokens), 0);
  const totalOutputTokens = byProvider.rows.reduce((sum, r) => sum + Number(r.out_tokens), 0);
  const totalReplies = byProvider.rows.reduce((sum, r) => sum + Number(r.replies), 0);
  res.json({
    period: label,
    since: since.toISOString(),
    totalProviderCostPaisa: total,
    totalInputTokens,
    totalOutputTokens,
    totalReplies,
    avgCostPaisa: totalReplies > 0 ? total / totalReplies : 0,
    byProvider: byProvider.rows.map((r) => ({
      provider: r.provider,
      replies: Number(r.replies),
      providerCostPaisa: Number(r.total),
      walletChargePaisa: Number(r.wallet),
      inputTokens: Number(r.in_tokens),
      outputTokens: Number(r.out_tokens),
    })),
    byDay: byDay.rows.map((r) => ({
      date: isoDate(r.day),
      provider: r.provider,
      providerCostPaisa: Number(r.total),
      inputTokens: Number(r.in_tokens),
      outputTokens: Number(r.out_tokens),
    })),
    byShop: byShop.rows.map((r) => ({
      workspaceId: r.workspace_id,
      shopName: r.name ?? '—',
      replies: Number(r.replies),
      providerCostPaisa: Number(r.total),
      inputTokens: Number(r.in_tokens),
      outputTokens: Number(r.out_tokens),
    })),
    rows: rows.rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      purpose: 'customer_reply',
      shopName: r.shop_name ?? '—',
      customerName: r.customer_name,
      provider: r.provider,
      model: r.model,
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      providerCostPaisa: Number(r.provider_cost_paisa),
    })),
    note: 'Costs come only from ai_usage_ledger.provider_cost_paisa — what the AI providers really charged. Groq is always ৳0.',
  });
});

// ---------------------------------------------------------------------------
// 6. Owner wallet, cards, deposits, sweep
// ---------------------------------------------------------------------------

/** GET /api/owner/wallet — balance, threshold, low-balance flag, history. */
ownerRouter.get('/wallet', async (_req: AuthRequest, res: Response) => {
  const wallet = await getOwnerWallet();
  const { rows } = await pool.query(
    `SELECT id, type, amount_paisa, provider, reference, note, created_at
     FROM owner_wallet_transactions ORDER BY created_at DESC LIMIT 50`,
  );
  res.json({
    balancePaisa: wallet.balancePaisa,
    lowBalanceThresholdPaisa: wallet.lowBalanceThresholdPaisa,
    lowBalance: wallet.balancePaisa < wallet.lowBalanceThresholdPaisa,
    transactions: rows.map((r) => ({
      id: r.id,
      type: r.type,
      amountPaisa: Number(r.amount_paisa),
      provider: r.provider,
      reference: r.reference,
      note: r.note,
      createdAt: r.created_at,
    })),
  });
});

/** PATCH /api/owner/wallet/threshold { thresholdPaisa } */
ownerRouter.patch('/wallet/threshold', async (req: AuthRequest, res: Response) => {
  const { thresholdPaisa } = (req.body ?? {}) as { thresholdPaisa?: number };
  if (typeof thresholdPaisa !== 'number' || !Number.isInteger(thresholdPaisa) || thresholdPaisa < 0) {
    res.status(400).json({ error: 'thresholdPaisa must be a non-negative integer (paisa)' });
    return;
  }
  const { rows } = await pool.query<{ balance_paisa: number; low_balance_threshold_paisa: number }>(
    `UPDATE owner_wallet SET low_balance_threshold_paisa = $1, updated_at = now()
     WHERE id = (SELECT id FROM owner_wallet ORDER BY created_at ASC LIMIT 1)
     RETURNING balance_paisa, low_balance_threshold_paisa`,
    [thresholdPaisa],
  );
  res.json({
    balancePaisa: Number(rows[0].balance_paisa),
    lowBalanceThresholdPaisa: Number(rows[0].low_balance_threshold_paisa),
    lowBalance: Number(rows[0].balance_paisa) < Number(rows[0].low_balance_threshold_paisa),
  });
});

/** POST /api/owner/wallet/sweep — run the AI-cost auto-deduction now. */
ownerRouter.post('/wallet/sweep', async (_req: AuthRequest, res: Response) => {
  const result = await processOwnerWalletDeductions();
  const wallet = await getOwnerWallet();
  res.json({
    ...result,
    balancePaisa: wallet.balancePaisa,
    lowBalance: wallet.balancePaisa < wallet.lowBalanceThresholdPaisa,
  });
});

// --- Cards on file (brand + last 4 only) ---

interface CardRow {
  id: string;
  brand: string;
  last4: string;
  exp_month: number | null;
  exp_year: number | null;
  is_default: boolean;
  created_at: string;
}

function publicCard(row: CardRow) {
  return {
    id: row.id,
    brand: row.brand,
    last4: row.last4,
    masked: `${row.brand} •••• ${row.last4}`,
    expMonth: row.exp_month,
    expYear: row.exp_year,
    isDefault: row.is_default,
    createdAt: row.created_at,
  };
}

/** GET /api/owner/wallet/cards */
ownerRouter.get('/wallet/cards', async (_req: AuthRequest, res: Response) => {
  const { rows } = await pool.query<CardRow>(
    'SELECT id, brand, last4, exp_month, exp_year, is_default, created_at FROM owner_cards ORDER BY is_default DESC, created_at ASC',
  );
  res.json({ cards: rows.map(publicCard) });
});

/** POST /api/owner/wallet/cards — add a card on file. Full numbers/CVV are NEVER accepted. */
ownerRouter.post('/wallet/cards', async (req: AuthRequest, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  for (const forbidden of ['number', 'cardNumber', 'card_number', 'fullNumber', 'cvv', 'cvc', 'securityCode']) {
    if (body[forbidden] !== undefined) {
      res.status(400).json({
        error: `Do not send ${forbidden} — only the card brand and last 4 digits are stored. Full card numbers and CVV are never kept.`,
      });
      return;
    }
  }
  const { brand, last4, expMonth, expYear, isDefault } = body as {
    brand?: string;
    last4?: string;
    expMonth?: number;
    expYear?: number;
    isDefault?: boolean;
  };
  if (!brand || typeof brand !== 'string' || !brand.trim() || brand.trim().length > 20) {
    res.status(400).json({ error: 'brand is required (e.g. Visa, Mastercard)' });
    return;
  }
  if (!last4 || typeof last4 !== 'string' || !/^\d{4}$/.test(last4)) {
    res.status(400).json({ error: 'last4 must be exactly 4 digits' });
    return;
  }
  if (expMonth !== undefined && (typeof expMonth !== 'number' || expMonth < 1 || expMonth > 12)) {
    res.status(400).json({ error: 'expMonth must be 1–12' });
    return;
  }
  if (expYear !== undefined && (typeof expYear !== 'number' || expYear < 2026 || expYear > 2100)) {
    res.status(400).json({ error: 'expYear must be a plausible year' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (isDefault === true) {
      await client.query('UPDATE owner_cards SET is_default = FALSE');
    }
    const { rows } = await client.query<CardRow>(
      `INSERT INTO owner_cards (brand, last4, exp_month, exp_year, is_default)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, brand, last4, exp_month, exp_year, is_default, created_at`,
      [brand.trim(), last4, expMonth ?? null, expYear ?? null, isDefault === true],
    );
    await client.query('COMMIT');
    res.status(201).json({ card: publicCard(rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('[owner/cards] create failed:', (err as Error).message);
    res.status(500).json({ error: 'Could not save the card' });
  } finally {
    client.release();
  }
});

/** PATCH /api/owner/wallet/cards/:id/set-default */
ownerRouter.patch('/wallet/cards/:id/set-default', async (req: AuthRequest, res: Response) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const exists = await client.query('SELECT id FROM owner_cards WHERE id = $1', [req.params.id]);
    if (exists.rowCount === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Card not found' });
      return;
    }
    await client.query('UPDATE owner_cards SET is_default = FALSE');
    const { rows } = await client.query<CardRow>(
      `UPDATE owner_cards SET is_default = TRUE WHERE id = $1
       RETURNING id, brand, last4, exp_month, exp_year, is_default, created_at`,
      [req.params.id],
    );
    await client.query('COMMIT');
    res.json({ card: publicCard(rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('[owner/cards] set-default failed:', (err as Error).message);
    res.status(500).json({ error: 'Could not set the default card' });
  } finally {
    client.release();
  }
});

/** DELETE /api/owner/wallet/cards/:id — blocked while a pending deposit references it.
 * Approved/rejected deposits do NOT block it: migration 12 made the FK
 * ON DELETE SET NULL, so deleting clears the card link on old deposits. */
ownerRouter.delete('/wallet/cards/:id', async (req: AuthRequest, res: Response) => {
  try {
    const pending = await pool.query(
      "SELECT COUNT(*) AS n FROM owner_deposits WHERE card_id = $1 AND status = 'pending'",
      [req.params.id],
    );
    if (Number((pending.rows[0] as { n: string }).n) > 0) {
      res.status(409).json({ error: 'This card has a pending deposit — approve or reject it first' });
      return;
    }
    const { rowCount } = await pool.query('DELETE FROM owner_cards WHERE id = $1', [req.params.id]);
    if (rowCount === 0) {
      res.status(404).json({ error: 'Card not found' });
      return;
    }
    res.json({ deleted: true });
  } catch (err) {
    // A DB error here must answer 500, never hang: Express 4 does not
    // forward async rejections to the error handler, so an uncaught throw
    // leaves the client waiting forever (this bit us with the 23503 FK
    // error before migration 12).
    console.error('[owner/cards] delete failed:', (err as Error).message);
    res.status(500).json({ error: 'Could not delete the card' });
  }
});

// --- Deposits (request → manual approve; NO live gateway) ---

/** POST /api/owner/wallet/deposits — record a deposit request (money received by hand). */
ownerRouter.post('/wallet/deposits', async (req: AuthRequest, res: Response) => {
  const { amountPaisa, method, transactionId, cardId } = (req.body ?? {}) as {
    amountPaisa?: number;
    method?: string;
    transactionId?: string;
    cardId?: string;
  };
  if (typeof amountPaisa !== 'number' || !Number.isInteger(amountPaisa) || amountPaisa <= 0) {
    res.status(400).json({ error: 'amountPaisa must be a positive integer (paisa)' });
    return;
  }
  if (!method || !(DEPOSIT_METHODS as readonly string[]).includes(method)) {
    res.status(400).json({ error: `method must be one of: ${DEPOSIT_METHODS.join(', ')}` });
    return;
  }
  if (method === 'card') {
    if (!cardId || typeof cardId !== 'string') {
      res.status(400).json({ error: 'cardId is required for card deposits — add the card on file first' });
      return;
    }
    const card = await pool.query('SELECT id FROM owner_cards WHERE id = $1', [cardId]);
    if (card.rowCount === 0) {
      res.status(400).json({ error: 'cardId does not match a saved card' });
      return;
    }
  } else if (!transactionId || typeof transactionId !== 'string' || !transactionId.trim()) {
    res.status(400).json({ error: 'transactionId is required — the payment reference (TrxID) so the deposit can be verified' });
    return;
  }
  const { rows } = await pool.query<DepositRow>(
    `INSERT INTO owner_deposits (amount_paisa, method, transaction_id, status, card_id, requested_by)
     VALUES ($1, $2, $3, 'pending', $4, $5) RETURNING ${DEPOSIT_COLUMNS}`,
    [
      amountPaisa,
      method,
      method === 'card' ? null : (transactionId as string).trim(),
      method === 'card' ? cardId : null,
      req.userId ?? null,
    ],
  );
  res.status(201).json({
    deposit: publicDeposit(rows[0]),
    message:
      'Deposit request recorded — it is NOT live money movement yet. Approve it after verifying the payment, and the owner wallet will be credited.',
  });
});

/** GET /api/owner/wallet/deposits?status=pending|approved|rejected */
ownerRouter.get('/wallet/deposits', async (req: AuthRequest, res: Response) => {
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const params: unknown[] = [];
  let where = '';
  if (status) {
    params.push(status);
    where = 'WHERE status = $1';
  }
  const { rows } = await pool.query<DepositRow>(
    `SELECT ${DEPOSIT_COLUMNS} FROM owner_deposits ${where} ORDER BY created_at DESC LIMIT 200`,
    params,
  );
  res.json({ deposits: rows.map(publicDeposit) });
});

/** POST /api/owner/wallet/deposits/:id/approve — credit the owner wallet (atomic, once only). */
ownerRouter.post('/wallet/deposits/:id/approve', async (req: AuthRequest, res: Response) => {
  const existing = await pool.query<DepositRow>(
    `SELECT ${DEPOSIT_COLUMNS} FROM owner_deposits WHERE id = $1`,
    [req.params.id],
  );
  const deposit = existing.rows[0];
  if (!deposit) {
    res.status(404).json({ error: 'Deposit not found' });
    return;
  }
  if (deposit.status !== 'pending') {
    res.status(409).json({
      error: `Deposit is already ${deposit.status} — it cannot be approved again`,
      deposit: publicDeposit(deposit),
    });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const wallet = await client.query(
      `UPDATE owner_wallet SET balance_paisa = balance_paisa + $1, updated_at = now()
       WHERE id = (SELECT id FROM owner_wallet ORDER BY created_at ASC LIMIT 1) RETURNING balance_paisa`,
      [Number(deposit.amount_paisa)],
    );
    await client.query(
      "INSERT INTO owner_wallet_transactions (type, amount_paisa, reference, note) VALUES ('deposit', $1, $2, $3)",
      [Number(deposit.amount_paisa), deposit.id, `Deposit approved (${deposit.method})`],
    );
    const updated = await client.query<DepositRow>(
      `UPDATE owner_deposits SET status = 'approved', reviewed_by = $1, updated_at = now()
       WHERE id = $2 AND status = 'pending' RETURNING ${DEPOSIT_COLUMNS}`,
      [req.userId ?? null, req.params.id],
    );
    if (updated.rowCount === 0) {
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'Deposit was already reviewed' });
      return;
    }
    await client.query('COMMIT');
    res.json({
      deposit: publicDeposit(updated.rows[0]),
      balancePaisa: Number(wallet.rows[0].balance_paisa),
      message: 'Deposit approved — owner wallet credited.',
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('[owner/deposits/approve]', err);
    res.status(500).json({ error: 'Deposit approval failed' });
  } finally {
    client.release();
  }
});

/** POST /api/owner/wallet/deposits/:id/reject {reason} — no wallet change. */
ownerRouter.post('/wallet/deposits/:id/reject', async (req: AuthRequest, res: Response) => {
  const { reason } = (req.body ?? {}) as { reason?: string };
  const { rows } = await pool.query<DepositRow>(
    `UPDATE owner_deposits SET status = 'rejected', reason = $1, reviewed_by = $2, updated_at = now()
     WHERE id = $3 AND status = 'pending' RETURNING ${DEPOSIT_COLUMNS}`,
    [typeof reason === 'string' && reason.trim() ? reason.trim() : null, req.userId ?? null, req.params.id],
  );
  if (rows.length === 0) {
    const existing = await pool.query<DepositRow>(
      `SELECT ${DEPOSIT_COLUMNS} FROM owner_deposits WHERE id = $1`,
      [req.params.id],
    );
    if (!existing.rows[0]) {
      res.status(404).json({ error: 'Deposit not found' });
      return;
    }
    res.status(409).json({ error: `Deposit is already ${existing.rows[0].status} — it cannot be rejected again` });
    return;
  }
  res.json({ deposit: publicDeposit(rows[0]), message: 'Deposit rejected — wallet unchanged.' });
});

// ---------------------------------------------------------------------------
// Test hook (env-gated, verifier only)
// ---------------------------------------------------------------------------

/**
 * POST /api/owner/_test/seed-ledger — insert one ai_usage_ledger row
 * (owner_deducted=false) so the verifier can test the API-cost breakdown
 * and the auto-deduction sweep without driving the whole agent.
 * 404 unless ALLOW_OWNER_TEST_HOOKS=true.
 */
ownerRouter.post('/_test/seed-ledger', async (req: AuthRequest, res: Response) => {
  if (!config.allowOwnerTestHooks) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const { workspaceId, provider, providerCostPaisa, inputTokens, outputTokens, model, customerName } = (req.body ?? {}) as {
    workspaceId?: string;
    provider?: string;
    providerCostPaisa?: number;
    inputTokens?: number;
    outputTokens?: number;
    model?: string;
    customerName?: string;
  };
  if (!workspaceId || typeof workspaceId !== 'string') {
    res.status(400).json({ error: 'workspaceId is required' });
    return;
  }
  if (!provider || typeof provider !== 'string') {
    res.status(400).json({ error: 'provider is required' });
    return;
  }
  if (typeof providerCostPaisa !== 'number' || !Number.isInteger(providerCostPaisa) || providerCostPaisa < 0) {
    res.status(400).json({ error: 'providerCostPaisa must be a non-negative integer (paisa)' });
    return;
  }
  // Optional customer: create a customer + conversation and link the ledger
  // row to it, so the verifier can prove the per-request table resolves the
  // customer name through the conversation join. Rows without a customer
  // keep conversation_id NULL (customer shows blank, never invented).
  let conversationId: string | null = null;
  if (typeof customerName === 'string' && customerName.trim()) {
    const cust = await pool.query<{ id: string }>(
      'INSERT INTO customers (workspace_id, name) VALUES ($1, $2) RETURNING id',
      [workspaceId, customerName.trim()],
    );
    const conv = await pool.query<{ id: string }>(
      'INSERT INTO conversations (workspace_id, customer_id) VALUES ($1, $2) RETURNING id',
      [workspaceId, cust.rows[0].id],
    );
    conversationId = conv.rows[0].id;
  }
  const { rows } = await pool.query(
    `INSERT INTO ai_usage_ledger (workspace_id, conversation_id, input_tokens, output_tokens, cost_paisa, provider, model, provider_cost_paisa, owner_deducted)
     VALUES ($1, $2, $3, $4, 0, $5, $6, $7, FALSE)
     RETURNING id, workspace_id, conversation_id, provider, model, input_tokens, output_tokens, cost_paisa, provider_cost_paisa, owner_deducted, created_at`,
    [
      workspaceId,
      conversationId,
      typeof inputTokens === 'number' ? inputTokens : 100,
      typeof outputTokens === 'number' ? outputTokens : 50,
      provider,
      typeof model === 'string' ? model : '',
      providerCostPaisa,
    ],
  );
  res.status(201).json({ ledgerRow: rows[0] });
});
