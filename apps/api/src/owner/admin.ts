/**
 * Owner Panel — user + subscription management (Feature 5, migration 45).
 * Mounted under ownerRouter (see owner/routes.ts) AFTER requireOwner,
 * so every route here is platform-owner only — any member/shop account
 * gets 403 from requireOwner before reaching these handlers.
 *
 * Users:
 * - GET /api/owner/users — all accounts (name, email, shop, joined, status).
 * - POST /api/owner/users/:id/block | unblock | restrict | unrestrict | delete
 *   Every action writes an owner_audit_log row in the same transaction.
 *   * block: login refused with 403 "আপনার অ্যাকাউন্টটি ব্লক করা হয়েছে".
 *     Existing tokens are NOT revoked (JWTs are stateless; their jti
 *     values are not stored — see migration 45). They expire in 30 days
 *     or on logout.
 *   * restrict: login still works, but AI replies + post scheduling are
 *     disabled for the account's whole shop (workspaces.restricted).
 *   * delete: SOFT delete (account_status='deleted' + deleted_at; the
 *     row and its data stay, recoverable). Login refused. Requires typed
 *     confirmation (the account's email, or the literal DELETE).
 *     The platform owner's own account can NEVER be deleted (400).
 * - GET /api/owner/audit-log — recent management actions.
 *
 * Subscriptions:
 * - GET /api/owner/subscriptions — every shop's plan + schedule
 *   subscriptions, pending manual top-ups, and the live price
 *   definitions from config (never hardcoded).
 * - Approve / Cancel live in subscriptions/routes.ts (owner-guarded,
 *   POST /api/owner/subscriptions/:id/approve|/cancel) because the
 *   logic lives in subscriptions/service.ts. Cancel ends the
 *   subscription AT ITS PERIOD END (it stays usable until then);
 *   approve re-activates a past_due subscription.
 * - Pending top-ups are approved through the EXISTING billing endpoint
 *   POST /api/billing/topup/:id/approve — no parallel approval flow.
 */
import { Router, type Response } from 'express';
import { config } from '../config';
import { pool } from '../db/pool';
import type { AuthRequest } from '../types';
import { SCHEDULE_PLANS } from '../subscriptions/schedule';
import {
  OWNER_AUDIT_INSERT_SQL,
  listAllSubscriptionsForOwner,
  listPendingTopupsForOwner,
} from '../subscriptions/service';

export const adminRouter = Router();

export type AccountStatus = 'active' | 'blocked' | 'restricted' | 'deleted';

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  workspace_id: string;
  workspace_name: string | null;
  role: string | null;
  is_owner: boolean;
  account_status: string;
  deleted_at: string | null;
  workspace_restricted: boolean;
  created_at: string;
}

function publicUser(r: UserRow) {
  const status = (['active', 'blocked', 'restricted', 'deleted'].includes(r.account_status)
    ? r.account_status
    : 'active') as AccountStatus;
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    workspaceId: r.workspace_id,
    workspaceName: r.workspace_name ?? '—',
    role: r.role ?? 'member',
    isOwner: r.is_owner === true,
    status,
    accountStatus: status,
    deletedAt: r.deleted_at,
    workspaceRestricted: r.workspace_restricted === true,
    createdAt: r.created_at,
  };
}

const USER_COLUMNS = `
  SELECT u.id, u.email, u.name, u.workspace_id, u.is_owner, u.account_status,
         u.deleted_at, u.created_at,
         w.name AS workspace_name, w.restricted AS workspace_restricted,
         m.role AS role
  FROM users u
  LEFT JOIN workspaces w ON w.id = u.workspace_id
  LEFT JOIN members m ON m.user_id = u.id AND m.workspace_id = u.workspace_id`;

async function loadUser(id: string): Promise<UserRow | null> {
  const { rows } = await pool.query<UserRow>(`${USER_COLUMNS} WHERE u.id = $1`, [id]);
  return rows[0] ?? null;
}

async function actorEmail(req: AuthRequest): Promise<string> {
  const { rows } = await pool.query<{ email: string }>(
    'SELECT email FROM users WHERE id = $1',
    [req.userId ?? ''],
  );
  return rows[0]?.email ?? '';
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/** GET /api/owner/users — every account with its shop and status. */
adminRouter.get('/users', async (_req: AuthRequest, res: Response) => {
  const { rows } = await pool.query<UserRow>(`${USER_COLUMNS} ORDER BY u.created_at DESC`);
  res.json({ users: rows.map(publicUser) });
});

/** GET /api/owner/audit-log — recent management actions (newest first). */
adminRouter.get('/audit-log', async (_req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT id, actor_user_id, actor_email, target_user_id, target_email,
            target_workspace_id, action, detail, created_at
     FROM owner_audit_log ORDER BY created_at DESC LIMIT 200`,
  );
  res.json({
    auditLog: rows.map((r) => ({
      id: r.id,
      actorUserId: r.actor_user_id,
      actorEmail: r.actor_email,
      targetUserId: r.target_user_id,
      targetEmail: r.target_email,
      targetWorkspaceId: r.target_workspace_id,
      action: r.action,
      detail: r.detail,
      createdAt: r.created_at,
    })),
  });
});

function setStatusHandler(action: 'block' | 'unblock' | 'restrict' | 'unrestrict') {
  return async (req: AuthRequest, res: Response): Promise<void> => {
    const target = await loadUser(req.params.id);
    if (!target) {
      res.status(404).json({ error: 'অ্যাকাউন্ট পাওয়া যায়নি।' });
      return;
    }
    const email = await actorEmail(req);
    const nextStatus: AccountStatus =
      action === 'block' ? 'blocked' : action === 'restrict' ? 'restricted' : 'active';
    if (target.is_owner && (action === 'block' || action === 'restrict')) {
      res.status(400).json({ error: 'প্ল্যাটফর্মের মালিকের অ্যাকাউন্ট ব্লক বা সীমিত করা যাবে না।' });
      return;
    }
    if (target.account_status === nextStatus) {
      res.json({
        user: publicUser(target),
        message:
          action === 'block'
            ? 'এই অ্যাকাউন্টটি ইতিমধ্যে ব্লক করা আছে।'
            : action === 'restrict'
              ? 'এই অ্যাকাউন্টটি ইতিমধ্যে সীমিত করা আছে।'
              : 'এই অ্যাকাউন্টটি ইতিমধ্যে চালু আছে।',
      });
      return;
    }
    if (target.account_status === 'deleted' && action !== 'unblock' && action !== 'unrestrict') {
      res.status(400).json({ error: 'মুছে ফেলা অ্যাকাউন্ট প্রথমে চালু করতে হবে — আগে আনব্লক করুন।' });
      return;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (action === 'restrict') {
        await client.query(
          `UPDATE users SET account_status = 'restricted', updated_at = now() WHERE id = $1`,
          [target.id],
        );
        await client.query(
          `UPDATE workspaces SET restricted = TRUE, updated_at = now() WHERE id = $1`,
          [target.workspace_id],
        );
      } else if (action === 'unrestrict') {
        await client.query(
          `UPDATE users SET account_status = 'active', updated_at = now() WHERE id = $1`,
          [target.id],
        );
        // Only clear the workspace flag when nobody else in that shop
        // is still restricted — otherwise one unrestrict would silently
        // lift another account's restriction.
        const still = await client.query(
          `SELECT COUNT(*) AS n FROM users WHERE workspace_id = $1 AND account_status = 'restricted' AND id <> $2`,
          [target.workspace_id, target.id],
        );
        if (Number((still.rows[0] as { n: string }).n) === 0) {
          await client.query(
            `UPDATE workspaces SET restricted = FALSE, updated_at = now() WHERE id = $1`,
            [target.workspace_id],
          );
        }
      } else {
        await client.query(
          `UPDATE users SET account_status = $1, updated_at = now() WHERE id = $2`,
          [nextStatus, target.id],
        );
      }
      const detail =
        action === 'block'
          ? `Blocked account ${target.email} — লগইন বন্ধ।`
          : action === 'unblock'
            ? `Unblocked account ${target.email} — লগইন আবার চালু।`
            : action === 'restrict'
              ? `Restricted account ${target.email} — AI উত্তর আর পোস্ট শিডিউল বন্ধ (শুধু পড়া যাবে)।`
              : `Removed restriction from ${target.email} — AI উত্তর আর পোস্ট শিডিউল আবার চালু।`;
      await client.query(OWNER_AUDIT_INSERT_SQL, [
        req.userId ?? null, email, target.id, target.email, target.workspace_id, action, detail,
      ]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      console.error(`[owner/admin/${action}]`, err);
      res.status(500).json({ error: 'কাজটি করা যায়নি।' });
      return;
    } finally {
      client.release();
    }
    const updated = await loadUser(target.id);
    const message =
      action === 'block'
        ? 'অ্যাকাউন্ট ব্লক করা হয়েছে — এই অ্যাকাউন্ট দিয়ে আর লগইন করা যাবে না।'
        : action === 'unblock'
          ? 'ব্লক তুলে নেওয়া হয়েছে — অ্যাকাউন্ট দিয়ে আবার লগইন করা যাবে।'
          : action === 'restrict'
            ? 'অ্যাকাউন্ট সীমিত করা হয়েছে — লগইন করা যাবে, কিন্তু AI উত্তর আর পোস্ট শিডিউল বন্ধ থাকবে।'
            : 'সীমা তুলে নেওয়া হয়েছে — AI উত্তর আর পোস্ট শিডিউল আবার চালু হয়েছে।';
    res.json({ user: updated ? publicUser(updated) : publicUser(target), message });
  };
}

/** POST /api/owner/users/:id/block — login refused from now on. */
adminRouter.post('/users/:id/block', setStatusHandler('block'));

/** POST /api/owner/users/:id/unblock — reverse a block. */
adminRouter.post('/users/:id/unblock', setStatusHandler('unblock'));

/** POST /api/owner/users/:id/restrict — read-only: login works, AI + scheduling off. */
adminRouter.post('/users/:id/restrict', setStatusHandler('restrict'));

/** POST /api/owner/users/:id/unrestrict — reverse a restriction. */
adminRouter.post('/users/:id/unrestrict', setStatusHandler('unrestrict'));

/**
 * POST /api/owner/users/:id/delete {confirm} — SOFT delete.
 * confirm must be the account's email (case-insensitive) or the literal
 * "DELETE" — the UI makes the owner type it. The platform owner's own
 * account, and the actor's own account, can never be deleted (400).
 * The row stays (deleted_at set) — data is recoverable, login is refused.
 */
adminRouter.post('/users/:id/delete', async (req: AuthRequest, res: Response) => {
  const target = await loadUser(req.params.id);
  if (!target) {
    res.status(404).json({ error: 'অ্যাকাউন্ট পাওয়া যায়নি।' });
    return;
  }
  if (target.is_owner) {
    res.status(400).json({ error: 'প্ল্যাটফর্মের মালিকের অ্যাকাউন্ট মোছা যাবে না।' });
    return;
  }
  if (target.id === req.userId) {
    res.status(400).json({ error: 'নিজের অ্যাকাউন্ট মোছা যাবে না।' });
    return;
  }
  if (target.account_status === 'deleted') {
    res.status(400).json({ error: 'এই অ্যাকাউন্টটি ইতিমধ্যে মোছা হয়েছে।' });
    return;
  }
  const { confirm } = (req.body ?? {}) as { confirm?: string };
  const typed = typeof confirm === 'string' ? confirm.trim() : '';
  if (typed.toLowerCase() !== target.email.toLowerCase() && typed !== 'DELETE') {
    res.status(400).json({
      error: 'মুছে ফেলতে অ্যাকাউন্টের ইমেইলটি হুবহু টাইপ করুন (অথবা DELETE লিখুন)।',
    });
    return;
  }
  const email = await actorEmail(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE users SET account_status = 'deleted', deleted_at = now(), updated_at = now() WHERE id = $1`,
      [target.id],
    );
    // Soft delete only: the row and its data stay (recoverable), the
    // account just cannot log in any more. Other members of the same
    // shop are unaffected — this is a per-account action, not a
    // workspace suspension (that already exists at /shops/:id/suspend).
    await client.query(OWNER_AUDIT_INSERT_SQL, [
      req.userId ?? null, email, target.id, target.email, target.workspace_id, 'delete',
      `Soft-deleted account ${target.email} — ডেটা আছে, লগইন বন্ধ।`,
    ]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('[owner/admin/delete]', err);
    res.status(500).json({ error: 'অ্যাকাউন্ট মোছা যায়নি।' });
    return;
  } finally {
    client.release();
  }
  const updated = await loadUser(target.id);
  res.json({
    user: updated ? publicUser(updated) : publicUser(target),
    message: 'অ্যাকাউন্ট মুছে ফেলা হয়েছে (সফট ডিলিট — ডেটা আছে, লগইন বন্ধ)।',
  });
});

// ---------------------------------------------------------------------------
// Subscriptions (list; approve/cancel live in subscriptions/routes.ts)
// ---------------------------------------------------------------------------

/**
 * GET /api/owner/subscriptions — every shop's subscriptions (plan +
 * schedule) with status and dates, pending manual top-ups waiting on
 * the owner, and the live price definitions. Prices come from config /
 * SCHEDULE_PLANS — nothing is hardcoded here.
 */
adminRouter.get('/subscriptions', async (_req: AuthRequest, res: Response) => {
  const [subscriptions, pendingTopups] = await Promise.all([
    listAllSubscriptionsForOwner(),
    listPendingTopupsForOwner(),
  ]);
  res.json({
    subscriptions,
    pendingTopups,
    pricing: {
      replyPackagePaisa: config.replyPackagePricePaisa,
      paygReplyCostPaisa: config.paygReplyCostPaisa,
      overageReplyCostPaisa: config.overageReplyCostPaisa,
      schedulePlans: SCHEDULE_PLANS.map((p) => ({
        slug: p.slug,
        cycle: p.cycle,
        currency: p.currency,
        pricePaisa: p.pricePaisa,
        displayPrice: p.displayPrice,
        periodDays: p.periodDays,
        nameBn: p.nameBn,
        nameEn: p.nameEn,
      })),
    },
  });
});

// ---------------------------------------------------------------------------
// Test hook (env-gated, verifier only)
// ---------------------------------------------------------------------------

/**
 * POST /api/owner/_test/seed-subscription {workspaceId, kind, status} —
 * insert a plan or schedule subscription in the requested status so the
 * verifier can test approve/cancel without driving a purchase.
 * 404 unless ALLOW_OWNER_TEST_HOOKS=true (same gate as _test/seed-ledger).
 */
adminRouter.post('/_test/seed-subscription', async (req: AuthRequest, res: Response) => {
  if (!config.allowOwnerTestHooks) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const { workspaceId, kind, status } = (req.body ?? {}) as {
    workspaceId?: string;
    kind?: string;
    status?: string;
  };
  if (!workspaceId || typeof workspaceId !== 'string') {
    res.status(400).json({ error: 'workspaceId is required' });
    return;
  }
  if (kind !== 'plan' && kind !== 'schedule') {
    res.status(400).json({ error: "kind must be 'plan' or 'schedule'" });
    return;
  }
  const wanted = typeof status === 'string' && status ? status : 'past_due';
  if (!['past_due', 'active', 'trial', 'cancelled'].includes(wanted)) {
    res.status(400).json({ error: 'status must be past_due, active, trial or cancelled' });
    return;
  }
  if (kind === 'plan') {
    const plan = await pool.query<{ id: string }>(
      `SELECT id FROM plans WHERE slug = 'choto' AND active = TRUE`,
    );
    if (plan.rowCount === 0) {
      res.status(500).json({ error: 'Trial plan (choto) not found in plans table' });
      return;
    }
    const { rows } = await pool.query(
      `INSERT INTO workspace_subscriptions (workspace_id, plan_id, status, current_period_start, current_period_end)
       VALUES ($1, $2, $3, now(), now() + interval '30 days') RETURNING id, status, current_period_end`,
      [workspaceId, plan.rows[0].id, wanted],
    );
    res.status(201).json({
      subscription: { id: rows[0].id, kind, status: rows[0].status, periodEnd: rows[0].current_period_end },
    });
    return;
  }
  const plan = SCHEDULE_PLANS.find((p) => p.slug === 'schedule-monthly-bdt');
  if (!plan) {
    res.status(500).json({ error: 'Schedule plan not found' });
    return;
  }
  const { rows } = await pool.query(
    `INSERT INTO schedule_subscriptions (workspace_id, billing_cycle, currency, price_paisa, status, current_period_start, current_period_end)
     VALUES ($1, 'monthly', 'BDT', $2, $3, now(), now() + interval '30 days') RETURNING id, status, current_period_end`,
    [workspaceId, plan.pricePaisa, wanted],
  );
  res.status(201).json({
    subscription: { id: rows[0].id, kind, status: rows[0].status, periodEnd: rows[0].current_period_end },
  });
});
