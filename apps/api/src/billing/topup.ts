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
 * Role rule (security fix H2, 2026-11-11): approving a top-up is REAL
 * MONEY — it credits the wallet with no payment check. Only the
 * workspace OWNER (members.role = 'owner') or the PLATFORM owner
 * (users.is_owner) may approve, and NEVER the person who filed the
 * request — before this fix any workspace member could approve their
 * own request and give their shop free money. The platform owner may
 * approve another workspace's request by passing its workspaceId in
 * the body (there is no cross-workspace UI yet — the Owner Panel
 * lists only its own deposits). A transaction id (TrxID) that was
 * already used for an APPROVED top-up is rejected everywhere, and
 * requests are capped at ৳100,000 (10,000,000 paisa).
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
import { config } from '../config';
import { pool, query, queryOne } from '../db/pool';
import { decryptToken } from '../db/crypto';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';
import { getSchedulePlan, purchaseScheduleSubscription } from '../subscriptions/schedule';
import { purchaseReplyPackage } from '../subscriptions/service';

export const topupRouter = Router();
topupRouter.use(requireAuth);

export const TOPUP_METHODS = ['bkash', 'nagad', 'rocket', 'bank', 'manual'] as const;
export type TopupMethod = (typeof TOPUP_METHODS)[number];

export const TOPUP_METHOD_BN: Record<TopupMethod, string> = {
  bkash: 'বিকাশ',
  nagad: 'নগদ',
  rocket: 'রকেট',
  bank: 'ব্যাংক',
  manual: 'হাতে (ক্যাশ/অন্যান্য)',
};

/**
 * Checkout purpose — what the shop is paying for by hand. The checkout
 * page attaches one; plain wallet top-ups (TopupSection) send none.
 * Approval DELIVERS the product (below) instead of only crediting the
 * wallet. Stored as a JSON string in topup_requests.purpose (migration 46).
 */
export type TopupPurpose =
  | { kind: 'schedule'; slug: string }
  | { kind: 'package'; replies: number }
  | { kind: 'payg' };

function parsePurpose(raw: unknown): TopupPurpose | null {
  if (raw == null) return null;
  let p: unknown = raw;
  if (typeof raw === 'string') {
    try { p = JSON.parse(raw); } catch { return null; }
  }
  if (typeof p !== 'object' || p === null) return null;
  const o = p as Record<string, unknown>;
  if (o.kind === 'schedule' && typeof o.slug === 'string' && getSchedulePlan(o.slug)) {
    return { kind: 'schedule', slug: o.slug };
  }
  if (o.kind === 'package' && Number.isInteger(o.replies) && (o.replies as number) >= 1 && (o.replies as number) <= 100000) {
    return { kind: 'package', replies: o.replies as number };
  }
  if (o.kind === 'payg') return { kind: 'payg' };
  return null;
}

/** The amount a purpose must cost, in paisa — so a request can never underpay for its product. */
function purposeAmountPaisa(p: TopupPurpose): number {
  if (p.kind === 'schedule') return Number(getSchedulePlan(p.slug)?.pricePaisa ?? 0);
  if (p.kind === 'package') return p.replies * config.replyPackagePricePaisa;
  return 0; // payg: any positive amount is fine
}

interface TopupRequestRow {
  id: string;
  workspace_id: string;
  amount_paisa: number;
  method: string;
  transaction_id: string;
  status: string;
  reason: string | null;
  purpose: string | null;
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
    purpose: parsePurpose(row.purpose),
    purposeRaw: row.purpose,
    requestedBy: row.requested_by,
    requested_by: row.requested_by,
    reviewedBy: row.reviewed_by,
    reviewed_by: row.reviewed_by,
    createdAt: row.created_at,
    created_at: row.created_at,
  };
}

const TOPUP_COLUMNS =
  'id, workspace_id, amount_paisa, method, transaction_id, status, reason, purpose, requested_by, reviewed_by, created_at, updated_at';
const SELECT_TOPUP = `SELECT ${TOPUP_COLUMNS} FROM topup_requests`;

/** Manual top-ups are capped: bKash/Nagad Send Money has per-day limits, so a request above this is never genuine. */
const MAX_TOPUP_PAISA = 10_000_000; // ৳100,000

/** True when the user is the workspace's owner (members.role = 'owner'). */
async function isWorkspaceOwner(userId: string, workspaceId: string): Promise<boolean> {
  const row = await queryOne<{ role: string }>(
    workspaceId,
    'SELECT role FROM members WHERE workspace_id = $1 AND user_id = $2',
    [workspaceId, userId],
  );
  return row?.role === 'owner';
}

/** True when the user is the platform owner (users.is_owner). */
async function isPlatformOwner(userId: string): Promise<boolean> {
  const { rows } = await pool.query<{ is_owner: boolean }>('SELECT is_owner FROM users WHERE id = $1', [userId]);
  return rows[0]?.is_owner === true;
}

/**
 * True when a TrxID was already used for an APPROVED top-up (any
 * workspace — a real bKash/Nagad transaction id is globally unique, so
 * the same id credited twice is fraud or a typo). Case-insensitive.
 */
async function isTrxIdAlreadyUsed(transactionId: string, excludeId?: string): Promise<boolean> {
  const params: unknown[] = [transactionId.trim().toLowerCase()];
  let sql =
    "SELECT id FROM topup_requests WHERE LOWER(transaction_id) = $1 AND status = 'approved'";
  if (excludeId) {
    sql += ' AND id <> $2';
    params.push(excludeId);
  }
  const { rows } = await pool.query(sql, params);
  return rows.length > 0;
}

/** POST /api/billing/topup/request — submit a manual top-up request (pending). */
topupRouter.post('/billing/topup/request', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { amountPaisa, method, transactionId, purpose } = (req.body ?? {}) as {
    amountPaisa?: number;
    method?: string;
    transactionId?: string;
    purpose?: unknown;
  };
  if (typeof amountPaisa !== 'number' || !Number.isInteger(amountPaisa) || amountPaisa <= 0) {
    res.status(400).json({ error: 'amountPaisa must be a positive integer (paisa)' });
    return;
  }
  if (amountPaisa > MAX_TOPUP_PAISA) {
    res.status(400).json({ error: 'টপ-আপের সর্বোচ্চ সীমা ৳১,০০,০০০ (এক লাখ টাকা) — এর বেশি হলে আলাদাভাবে যোগাযোগ করুন।' });
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
  // Checkout purpose (migration 46): the amount must exactly cover the
  // product, so approval can never deliver something underpaid.
  let purposeJson: string | null = null;
  if (purpose !== undefined && purpose !== null) {
    const parsed = parsePurpose(purpose);
    if (!parsed) {
      res.status(400).json({ error: 'purpose is not a valid checkout product (schedule slug / package replies / payg)।' });
      return;
    }
    const expected = purposeAmountPaisa(parsed);
    if (expected > 0 && amountPaisa !== expected) {
      res.status(400).json({ error: `এই প্যাকেজের দাম ${expected} পয়সা — টাকার অঙ্ক মিলছে না, আবার চেষ্টা করুন।` });
      return;
    }
    purposeJson = JSON.stringify(parsed);
  }
  // H2: the same TrxID must never be credited twice.
  if (await isTrxIdAlreadyUsed(transactionId)) {
    res.status(400).json({ error: 'এই TrxID দিয়ে আগেই একটি টপ-আপ অনুমোদিত হয়েছে — একই লেনদেন আইডি দুইবার ব্যবহার করা যায় না।' });
    return;
  }
  const { rows } = await query<TopupRequestRow>(
    workspaceId,
    `INSERT INTO topup_requests (workspace_id, amount_paisa, method, transaction_id, status, purpose, requested_by)
     VALUES ($1, $2, $3, $4, 'pending', $5, $6) RETURNING ${TOPUP_COLUMNS}`,
    [workspaceId, amountPaisa, method, transactionId.trim(), purposeJson, req.userId ?? null],
  );
  res.status(201).json({
    topupRequest: publicTopupRequest(rows[0]),
    message: 'টপ-আপের অনুরোধ জমা হয়েছে — যাচাই করে অনুমোদন দেওয়া হলে ব্যালেন্সে টাকা যোগ হবে।',
  });
});

/** GET /api/billing/payment-numbers — the platform's receiving numbers
 * (bKash / Nagad / Rocket / bank) for the checkout page, FULL numbers so
 * the shop can send money to them. Only for logged-in shop owners: these
 * are the owner's public receiving numbers (like an invoice's bKash
 * number), managed by the platform owner at /owner/bank-accounts.
 * A type with no primary account returns null — the checkout page hides
 * that method and tells the shop the number is not set yet. */
topupRouter.get('/billing/payment-numbers', async (_req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT type, bank_name, account_holder, account_number_encrypted, account_number_last4, branch, is_primary
     FROM owner_bank_accounts ORDER BY is_primary DESC, created_at ASC`,
  );
  const numbers: Record<string, { type: string; bankName: string; accountHolder: string; number: string; branch: string | null } | null> = {
    bkash: null,
    nagad: null,
    rocket: null,
    bank: null,
  };
  for (const r of rows as { type: string; bank_name: string; account_holder: string; account_number_encrypted: string; account_number_last4: string; branch: string | null; is_primary: boolean }[]) {
    if (!(r.type in numbers) || numbers[r.type]) continue; // first (primary) account per type wins
    let number = '';
    try {
      number = decryptToken(r.account_number_encrypted);
    } catch (err) {
      console.error('[billing/payment-numbers] decrypt failed for', r.type, (err as Error).message);
      continue;
    }
    numbers[r.type] = {
      type: r.type,
      bankName: r.bank_name,
      accountHolder: r.account_holder,
      number,
      branch: r.branch,
    };
  }
  res.json({ numbers });
});

/** GET /api/billing/topup/requests — list this workspace's top-up requests. */
topupRouter.get('/billing/topup/requests', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  // H2: the platform owner may list another workspace's requests
  // (?workspaceId=...) so they can review and approve them.
  let targetWorkspaceId = workspaceId;
  if (typeof req.query.workspaceId === 'string' && req.query.workspaceId) {
    if (req.userId && (await isPlatformOwner(req.userId))) targetWorkspaceId = req.query.workspaceId;
    else {
      res.status(403).json({ error: 'Only the platform owner can list another workspace’s top-up requests' });
      return;
    }
  }
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const params: unknown[] = [targetWorkspaceId];
  let where = 'WHERE workspace_id = $1';
  if (status) {
    params.push(status);
    where += ` AND status = $${params.length}`;
  }
  const { rows } = await query<TopupRequestRow>(
    targetWorkspaceId,
    `${SELECT_TOPUP} ${where} ORDER BY created_at DESC LIMIT 200`,
    params,
  );
  res.json({ topupRequests: rows.map(publicTopupRequest) });
});

/** POST /api/billing/topup/:id/approve — credit the wallet + ledger entry (atomic). */
topupRouter.post('/billing/topup/:id/approve', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  // H2: the platform owner may approve another workspace's request by
  // passing its workspaceId in the body — otherwise the request must
  // belong to the caller's own workspace.
  let targetWorkspaceId = workspaceId;
  const bodyWorkspaceId = (req.body as { workspaceId?: string } | undefined)?.workspaceId;
  const platformOwner = req.userId ? await isPlatformOwner(req.userId) : false;
  if (typeof bodyWorkspaceId === 'string' && bodyWorkspaceId) {
    if (!platformOwner) {
      res.status(403).json({ error: 'Only the platform owner can approve another workspace’s top-up request' });
      return;
    }
    targetWorkspaceId = bodyWorkspaceId;
  }
  const existing = await queryOne<TopupRequestRow>(
    targetWorkspaceId,
    `${SELECT_TOPUP} WHERE workspace_id = $1 AND id = $2`,
    [targetWorkspaceId, req.params.id],
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
  // H2: only the workspace owner (or platform owner) may approve — and
  // NEVER the person who filed the request. A staff member approving
  // their own request was the free-money hole.
  const workspaceOwner = req.userId ? await isWorkspaceOwner(req.userId, targetWorkspaceId) : false;
  if (!workspaceOwner && !platformOwner) {
    res.status(403).json({ error: 'শুধু দোকানের মালিক (বা প্ল্যাটফর্মের মালিক) টপ-আপ অনুমোদন করতে পারেন।' });
    return;
  }
  if (existing.requested_by && req.userId && existing.requested_by === req.userId) {
    res.status(403).json({ error: 'নিজের টপ-আপের অনুরোধ নিজে অনুমোদন করা যায় না — অন্য মালিককে যাচাই করতে হবে।' });
    return;
  }
  if (Number(existing.amount_paisa) > MAX_TOPUP_PAISA) {
    res.status(409).json({ error: 'Top-up amount exceeds the maximum (৳100,000)' });
    return;
  }
  const client = await pool.connect();
  // Captured inside the transaction, delivered AFTER the client is
  // released (below): the delivery functions open their own pool client,
  // so they must never run while this one is still checked out.
  let approvedRow: TopupRequestRow | null = null;
  let balanceAfterCredit = 0;
  try {
    await client.query('BEGIN');
    // H2: re-check the TrxID inside the transaction — a duplicate that
    // slipped in between request and approval must not be credited.
    const dup = await client.query(
      "SELECT id FROM topup_requests WHERE LOWER(transaction_id) = LOWER($1) AND status = 'approved' AND id <> $2",
      [existing.transaction_id, req.params.id],
    );
    if ((dup.rowCount ?? 0) > 0) {
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'এই TrxID দিয়ে আগেই একটি টপ-আপ অনুমোদিত হয়েছে।' });
      return;
    }
    const ws = await client.query(
      'UPDATE workspaces SET balance_paisa = balance_paisa + $1, updated_at = now() WHERE id = $2 RETURNING balance_paisa',
      [Number(existing.amount_paisa), targetWorkspaceId],
    );
    await client.query(
      "INSERT INTO wallet_transactions (workspace_id, type, amount_paisa) VALUES ($1, 'topup', $2)",
      [targetWorkspaceId, Number(existing.amount_paisa)],
    );
    const updated = await client.query(
      `UPDATE topup_requests SET status = 'approved', reviewed_by = $1, updated_at = now()
       WHERE workspace_id = $2 AND id = $3 AND status = 'pending'
       RETURNING id, workspace_id, amount_paisa, method, transaction_id, status, reason, purpose, requested_by, reviewed_by, created_at, updated_at`,
      [req.userId ?? null, targetWorkspaceId, req.params.id],
    );
    if (updated.rowCount === 0) {
      // Lost a race with another approval — roll back the credit.
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'Top-up request was already reviewed' });
      return;
    }
    await client.query('COMMIT');
    approvedRow = updated.rows[0] as TopupRequestRow;
    balanceAfterCredit = Number((ws.rows[0] as { balance_paisa: number }).balance_paisa);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('[billing/topup/approve]', err);
    res.status(500).json({ error: 'Top-up approval failed' });
    return;
  } finally {
    client.release();
  }
  if (!approvedRow) return; // unreachable — the try block always sets it or returns
  // Checkout purpose (migration 46): the wallet is credited above; now
  // DELIVER the product the shop paid for. Delivery runs after the
  // commit (and after the client is released) so a delivery failure can
  // never roll back the credit — the money stays in the wallet and the
  // failure is reported honestly.
  let delivery: { ok: boolean; message: string } | null = null;
  const purpose = parsePurpose(approvedRow.purpose);
  if (purpose?.kind === 'schedule') {
    try {
      const r = await purchaseScheduleSubscription(targetWorkspaceId, purpose.slug);
      delivery = r.ok
        ? { ok: true, message: `পোস্ট শিডিউল সাবস্ক্রিপশন চালু হয়েছে (${r.plan?.nameBn ?? ''})।` }
        : { ok: false, message: r.error ?? 'সাবস্ক্রিপশন চালু করা যায়নি — টাকা ওয়ালেটেই আছে।' };
    } catch (err) {
      console.error('[billing/topup/approve] schedule delivery failed:', (err as Error).message);
      delivery = { ok: false, message: 'সাবস্ক্রিপশন চালু করা যায়নি — টাকা ওয়ালেটেই আছে।' };
    }
  } else if (purpose?.kind === 'package') {
    try {
      const r = await purchaseReplyPackage(targetWorkspaceId, purpose.replies);
      delivery = r.ok
        ? { ok: true, message: `${r.replies}টি রিপ্লাই প্যাকেজে যোগ হয়েছে।` }
        : { ok: false, message: r.error ?? 'রিপ্লাই প্যাকেজ যোগ করা যায়নি — টাকা ওয়ালেটেই আছে।' };
    } catch (err) {
      console.error('[billing/topup/approve] package delivery failed:', (err as Error).message);
      delivery = { ok: false, message: 'রিপ্লাই প্যাকেজ যোগ করা যায়নি — টাকা ওয়ালেটেই আছে।' };
    }
  }
  res.json({
    topupRequest: publicTopupRequest(approvedRow),
    // Re-read: delivery (package/schedule) charges the wallet after the
    // credit, so the pre-delivery balance would be stale.
    balancePaisa: (await queryOne<{ balance_paisa: number }>(
      targetWorkspaceId,
      'SELECT balance_paisa FROM workspaces WHERE id = $1',
      [targetWorkspaceId],
    ))?.balance_paisa ?? balanceAfterCredit,
    delivery,
    message: delivery?.ok === false
      ? 'টপ-আপ অনুমোদন করা হয়েছে — ব্যালেন্সে টাকা যোগ হয়েছে, কিন্তু প্যাকেজটি চালু করা যায়নি।'
      : 'টপ-আপ অনুমোদন করা হয়েছে — ব্যালেন্সে টাকা যোগ হয়েছে।',
  });
});

/** POST /api/billing/topup/:id/reject {reason} — reject; wallet is untouched. */
topupRouter.post('/billing/topup/:id/reject', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  // H2: same cross-workspace rule as approve — the platform owner may
  // reject another workspace's request by passing its workspaceId.
  let targetWorkspaceId = workspaceId;
  const bodyWorkspaceId = (req.body as { workspaceId?: string } | undefined)?.workspaceId;
  const platformOwner = req.userId ? await isPlatformOwner(req.userId) : false;
  if (typeof bodyWorkspaceId === 'string' && bodyWorkspaceId) {
    if (!platformOwner) {
      res.status(403).json({ error: 'Only the platform owner can reject another workspace’s top-up request' });
      return;
    }
    targetWorkspaceId = bodyWorkspaceId;
  }
  const { reason } = (req.body ?? {}) as { reason?: string };
  const existing = await queryOne<TopupRequestRow>(
    targetWorkspaceId,
    `${SELECT_TOPUP} WHERE workspace_id = $1 AND id = $2`,
    [targetWorkspaceId, req.params.id],
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
  // H2: rejecting is harmless (no money moves), but it must still be
  // the workspace owner / platform owner — except the requester, who
  // may withdraw their own request.
  const workspaceOwner = req.userId ? await isWorkspaceOwner(req.userId, targetWorkspaceId) : false;
  const isRequester = !!existing.requested_by && !!req.userId && existing.requested_by === req.userId;
  if (!workspaceOwner && !platformOwner && !isRequester) {
    res.status(403).json({ error: 'শুধু দোকানের মালিক (বা প্ল্যাটফর্মের মালিক) টপ-আপের অনুরোধ বাতিল করতে পারেন।' });
    return;
  }
  const { rows } = await query<TopupRequestRow>(
    targetWorkspaceId,
    `UPDATE topup_requests SET status = 'rejected', reason = $1, reviewed_by = $2, updated_at = now()
     WHERE workspace_id = $3 AND id = $4 AND status = 'pending'
     RETURNING id, workspace_id, amount_paisa, method, transaction_id, status, reason, requested_by, reviewed_by, created_at, updated_at`,
    [typeof reason === 'string' && reason.trim() ? reason.trim() : null, req.userId ?? null, targetWorkspaceId, req.params.id],
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
