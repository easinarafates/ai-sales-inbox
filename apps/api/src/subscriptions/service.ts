/**
 * সাবস্ক্রিপশন সার্ভিস — প্ল্যান, ট্রায়াল, কেনা/আপগ্রেড/বাতিল/নবায়ন,
 * সীমা যাচাই (চ্যানেল/প্রোডাক্ট) ও AI রিপ্লাইয়ের অনুমতি।
 *
 * YEARBITO Phase 2 (2026-11-11): পুরনো প্ল্যান (ছোট/মাঝারি/বড়) আর
 * বিক্রি হয় না (purchasePlan 410 দেয়) — চালু থাকা সাবস্ক্রিপশন
 * মেয়াদ শেষ পর্যন্ত grandfathered। নতুন মডেল: পোস্ট শিডিউল
 * সাবস্ক্রিপশন (schedule.ts), রিপ্লাই প্যাকেজ (purchaseReplyPackage,
 * ২২ পয়সা/রিপ্লাই), আর pay-as-you-go AI ক্রেডিট
 * (checkAiReplyAllowance-এর 'payg' মোড — ফ্ল্যাট ২৩ পয়সা/রিপ্লাই)।
 *
 * নিয়ম:
 * - সব কোয়েরি workspace_id দিয়ে ফিল্টার করে (plans টেবিলটি গ্লোবাল —
 *   সবার জন্য একই প্ল্যানের তালিকা, তাই সেখানে workspace ফিল্টার নেই)।
 * - দাম/সীমা রানটাইমে plans টেবিল থেকেই আসে (মাইগ্রেশন 04-এ সিড করা
 *   প্রস্তাবিত দাম)। কনফিগে শুধু TRIAL_DAYS ও ওভারেজের ২২ পয়সা থাকে।
 * - সাবস্ক্রিপশনের চার্জ wallet_transactions-এ 'subscription_charge'
 *   হিসেবে যায় — অন্য চার্জের মতোই লেজারে ওঠে।
 * - নতুন ওয়ার্কস্পেসে কোনো সাবস্ক্রিপশন না থাকলে এখান থেকেই ১৪ দিনের
 *   ফ্রি ট্রায়াল (ছোট প্ল্যান) তৈরি হয় — সাইনআপের কোডে হাত না দিয়েই
 *   (integration-notes.md-তে সাইনআপে সরাসরি বসানোর লাইনও দেওয়া আছে)।
 * - বাতিল (cancelled) প্ল্যানও মেয়াদ শেষ (current_period_end) পর্যন্ত
 *   চালু থাকে; মেয়াদ পেরোলে effectiveStatus 'expired' হয়।
 */
import { config } from '../config';
import { pool, query, queryOne } from '../db/pool';

export interface PlanRow {
  id: string;
  slug: string;
  name_bn: string;
  price_paisa: number;
  included_ai_replies: number;
  max_channels: number | null;
  max_products: number | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Plan {
  id: string;
  slug: string;
  nameBn: string;
  name_bn: string;
  pricePaisa: number;
  price_paisa: number;
  includedAiReplies: number;
  included_ai_replies: number;
  maxChannels: number | null;
  max_channels: number | null;
  maxProducts: number | null;
  max_products: number | null;
  active: boolean;
}

export interface SubscriptionRow {
  id: string;
  workspace_id: string;
  plan_id: string;
  status: string;
  current_period_start: string;
  current_period_end: string;
  created_at: string;
  updated_at: string;
  plan_slug: string;
  plan_name_bn: string;
  plan_price_paisa: number;
  plan_included_ai_replies: number;
  plan_max_channels: number | null;
  plan_max_products: number | null;
}

export type SubscriptionStatus = 'trial' | 'active' | 'past_due' | 'cancelled' | 'expired';

export interface CurrentSubscription {
  subscription: {
    id: string;
    planId: string;
    plan_id: string;
    status: string;
    effectiveStatus: string;
    isActive: boolean;
    currentPeriodStart: string;
    current_period_start: string;
    currentPeriodEnd: string;
    current_period_end: string;
  };
  plan: Plan;
  usage: {
    usedReplies: number;
    includedReplies: number;
    remainingReplies: number;
    overageReplies: number;
  };
  limits: {
    channels: { used: number; limit: number | null; canAdd: boolean; message: string };
    products: { used: number; limit: number | null; canAdd: boolean; message: string };
  };
  balancePaisa: number;
  /** Reply-package credits still unused (YEARBITO Phase 2). */
  replyCredits: number;
  recentUsage: { id: string; cost_paisa: number; provider: string; included_in_plan: boolean; created_at: string }[];
}

export interface AiReplyAllowance {
  allowed: boolean;
  /** package = reply-package credit (consumed first) · included = old
   *  plan's included replies (grandfathered) · overage = old plan's
   *  flat 22 paisa (grandfathered) · payg = wallet pays the provider's
   *  real per-token cost · blocked = no reply. */
  mode: 'included' | 'package' | 'payg' | 'overage' | 'blocked';
  costPaisa: number;
  reason: string;
  reasonBn: string;
  /** Customer-facing Bengali message when blocked (sent as the outgoing
   * message instead of the generic upgrade notice). */
  blockedNoticeBn: string;
  usedReplies: number;
  includedReplies: number;
  packageCredits: number;
  balancePaisa: number;
}

/**
 * What the CUSTOMER hears when the wallet is empty and no AI reply is
 * possible. YEARBITO Phase 2: there is no "plan" to renew any more —
 * old plans are not sold, and replies resume with a wallet top-up or
 * a reply package — so the notice must NOT say "প্ল্যান নবায়ন করুন".
 * The internal reason (reasonBn, used for the team ticket) still
 * distinguishes an expired grandfathered plan from a never-had-one.
 */
export const UPGRADE_NOTICE =
  'দুঃখিত, দোকানের AI উত্তরের ব্যালেন্স শেষ হয়ে গেছে — দোকানদার নিজে শীঘ্রই উত্তর দেবেন।';

/**
 * Restricted account (Owner Panel, migration 45): the account CAN log
 * in, but AI replies are OFF. The customer gets this honest notice
 * instead of an AI reply (sent as the outgoing message, same as the
 * wallet-empty path) and the team gets a ticket with reasonBn.
 * Nothing is charged for a refused reply.
 */
export const RESTRICTED_REPLY_NOTICE_BN =
  'দুঃখিত, দোকানের AI উত্তর আপাতত বন্ধ আছে — দোকানদার নিজে শীঘ্রই উত্তর দেবেন।';

/** workspaces.restricted (migration 45) — set by owner restrict/unrestrict. */
export async function isWorkspaceRestricted(workspaceId: string): Promise<boolean> {
  const row = await queryOne<{ restricted: boolean }>(
    workspaceId,
    'SELECT restricted FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  return row?.restricted === true;
}

/** Shared audit insert (owner_audit_log, migration 45) — run inside the
 * caller's transaction so an action without its audit row cannot commit. */
export const OWNER_AUDIT_INSERT_SQL =
  `INSERT INTO owner_audit_log (actor_user_id, actor_email, target_user_id, target_email, target_workspace_id, action, detail)
   VALUES ($1, $2, $3, $4, $5, $6, $7)`;

function toPlan(row: PlanRow): Plan {
  return {
    id: row.id,
    slug: row.slug,
    nameBn: row.name_bn,
    name_bn: row.name_bn,
    pricePaisa: Number(row.price_paisa),
    price_paisa: Number(row.price_paisa),
    includedAiReplies: Number(row.included_ai_replies),
    included_ai_replies: Number(row.included_ai_replies),
    maxChannels: row.max_channels === null ? null : Number(row.max_channels),
    max_channels: row.max_channels === null ? null : Number(row.max_channels),
    maxProducts: row.max_products === null ? null : Number(row.max_products),
    max_products: row.max_products === null ? null : Number(row.max_products),
    active: row.active,
  };
}

const PLAN_COLUMNS =
  'id, slug, name_bn, price_paisa, included_ai_replies, max_channels, max_products, active, created_at, updated_at';

const SUB_WITH_PLAN = `
  SELECT ws.id, ws.workspace_id, ws.plan_id, ws.status,
         ws.current_period_start, ws.current_period_end, ws.created_at, ws.updated_at,
         p.slug AS plan_slug, p.name_bn AS plan_name_bn,
         p.price_paisa AS plan_price_paisa,
         p.included_ai_replies AS plan_included_ai_replies,
         p.max_channels AS plan_max_channels, p.max_products AS plan_max_products
  FROM workspace_subscriptions ws
  JOIN plans p ON p.id = ws.plan_id`;

/** সব চালু প্ল্যান, দামের ক্রমে। plans গ্লোবাল টেবিল — workspace ফিল্টার নেই। */
export async function listPlans(workspaceId: string): Promise<Plan[]> {
  const { rows } = await query<PlanRow>(
    workspaceId,
    `SELECT ${PLAN_COLUMNS} FROM plans WHERE active = TRUE ORDER BY price_paisa ASC`,
  );
  return rows.map(toPlan);
}

export async function getPlanBySlug(workspaceId: string, slug: string): Promise<Plan | null> {
  const row = await queryOne<PlanRow>(
    workspaceId,
    `SELECT ${PLAN_COLUMNS} FROM plans WHERE slug = $1 AND active = TRUE`,
    [slug],
  );
  return row ? toPlan(row) : null;
}

/** ওয়ার্কস্পেসের সবচেয়ে নতুন সাবস্ক্রিপশন (একটাই "চলতি" ধরা হয়)। */
export async function getLatestSubscription(workspaceId: string): Promise<SubscriptionRow | null> {
  return queryOne<SubscriptionRow>(
    workspaceId,
    `${SUB_WITH_PLAN} WHERE ws.workspace_id = $1 ORDER BY ws.created_at DESC LIMIT 1`,
    [workspaceId],
  );
}

/** মেয়াদ পেরিয়ে গেলে effectiveStatus 'expired'; নইলে DB-র status-ই। */
export function effectiveStatus(sub: SubscriptionRow): string {
  if (new Date(sub.current_period_end).getTime() <= Date.now()) return 'expired';
  return sub.status;
}

/** trial/active — আর বাতিল হলেও মেয়াদের ভেতরে থাকলে — চালু ধরা হয়। */
export function isActiveSubscription(sub: SubscriptionRow): boolean {
  const eff = effectiveStatus(sub);
  return (eff === 'trial' || eff === 'active' || eff === 'cancelled') &&
    new Date(sub.current_period_end).getTime() > Date.now();
}

function periodEnd(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

/**
 * ট্রায়াল নিশ্চিত করা — সাবস্ক্রিপশন না থাকলে ১৪ দিনের ফ্রি ট্রায়াল
 * (ছোট প্ল্যান) বানায়। আগে থেকে থাকলে সেটাই ফেরত দেয় (idempotent)।
 */
export async function ensureTrialSubscription(workspaceId: string): Promise<SubscriptionRow> {
  const existing = await getLatestSubscription(workspaceId);
  if (existing) return existing;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const planRes = await client.query(
      `SELECT ${PLAN_COLUMNS} FROM plans WHERE slug = 'choto' AND active = TRUE`,
    );
    if (planRes.rowCount === 0) throw new Error('Trial plan (choto) not found in plans table');
    const plan = planRes.rows[0] as PlanRow;
    const end = periodEnd(config.trialDays);
    await client.query(
      `INSERT INTO workspace_subscriptions (workspace_id, plan_id, status, current_period_start, current_period_end)
       SELECT $1, $2, 'trial', now(), $3
       WHERE NOT EXISTS (SELECT 1 FROM workspace_subscriptions WHERE workspace_id = $1)`,
      [workspaceId, plan.id, end.toISOString()],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  const created = await getLatestSubscription(workspaceId);
  if (!created) throw new Error('Trial subscription could not be created');
  return created;
}

/** এই পিরিয়ডে কতগুলো AI রিপ্লাই লেজারে উঠেছে (অন্তর্ভুক্ত + ওভারেজ — সব)। */
export async function countUsedReplies(workspaceId: string, periodStart: string): Promise<number> {
  const row = await queryOne<{ n: string }>(
    workspaceId,
    `SELECT COUNT(*)::text AS n FROM ai_usage_ledger
     WHERE workspace_id = $1 AND created_at >= $2`,
    [workspaceId, periodStart],
  );
  return Number(row?.n ?? 0);
}

export async function countChannels(workspaceId: string): Promise<number> {
  const row = await queryOne<{ n: string }>(
    workspaceId,
    // facebook_comment is the comment leg of a connected Facebook Page
    // (same Page, same token — the Channels page shows it under the one
    // Facebook card), not a second channel the shop connected, so it
    // never consumes a subscription channel slot.
    `SELECT COUNT(*)::text AS n FROM channels
     WHERE workspace_id = $1 AND status = 'connected' AND platform <> 'facebook_comment'`,
    [workspaceId],
  );
  return Number(row?.n ?? 0);
}

export async function countProducts(workspaceId: string): Promise<number> {
  const row = await queryOne<{ n: string }>(
    workspaceId,
    'SELECT COUNT(*)::text AS n FROM products WHERE workspace_id = $1',
    [workspaceId],
  );
  return Number(row?.n ?? 0);
}

function limitMessage(kind: 'চ্যানেল' | 'প্রোডাক্ট', limit: number | null, used: number): string {
  if (limit === null) return '';
  return `এই প্ল্যানে সর্বোচ্চ ${limit}টি ${kind} রাখা যায় (এখন ${used}টি আছে)। বেশি লাগলে প্ল্যান আপগ্রেড করুন।`;
}

/** চ্যানেলের সীমা: চালু (connected) চ্যানেল গোনা হয় — অনুমোদনের অপেক্ষায়
 * থাকা (pending_approval) চ্যানেল গোনা হয় না, কারণ সেগুলো এখনো লাইভ নয়। */
export async function checkChannelLimit(
  workspaceId: string,
): Promise<{ used: number; limit: number | null; canAdd: boolean; message: string }> {
  const sub = await ensureTrialSubscription(workspaceId);
  const used = await countChannels(workspaceId);
  const limit = sub.plan_max_channels === null ? null : Number(sub.plan_max_channels);
  const canAdd = limit === null || used < limit;
  return { used, limit, canAdd, message: canAdd ? '' : limitMessage('চ্যানেল', limit, used) };
}

/** প্রোডাক্টের সীমা। */
export async function checkProductLimit(
  workspaceId: string,
): Promise<{ used: number; limit: number | null; canAdd: boolean; message: string }> {
  const sub = await ensureTrialSubscription(workspaceId);
  const used = await countProducts(workspaceId);
  const limit = sub.plan_max_products === null ? null : Number(sub.plan_max_products);
  const canAdd = limit === null || used < limit;
  return { used, limit, canAdd, message: canAdd ? '' : limitMessage('প্রোডাক্ট', limit, used) };
}

/** চলতি সাবস্ক্রিপশন + ব্যবহার + সীমা — ড্যাশবোর্ড/প্ল্যান পেজের জন্য। */
export async function getCurrentSubscription(workspaceId: string): Promise<CurrentSubscription> {
  const sub = await ensureTrialSubscription(workspaceId);
  const plan: Plan = {
    id: sub.plan_id,
    slug: sub.plan_slug,
    nameBn: sub.plan_name_bn,
    name_bn: sub.plan_name_bn,
    pricePaisa: Number(sub.plan_price_paisa),
    price_paisa: Number(sub.plan_price_paisa),
    includedAiReplies: Number(sub.plan_included_ai_replies),
    included_ai_replies: Number(sub.plan_included_ai_replies),
    maxChannels: sub.plan_max_channels === null ? null : Number(sub.plan_max_channels),
    max_channels: sub.plan_max_channels === null ? null : Number(sub.plan_max_channels),
    maxProducts: sub.plan_max_products === null ? null : Number(sub.plan_max_products),
    max_products: sub.plan_max_products === null ? null : Number(sub.plan_max_products),
    active: true,
  };
  const usedReplies = await countUsedReplies(workspaceId, sub.current_period_start);
  const included = Number(sub.plan_included_ai_replies);
  const channelLimit = await checkChannelLimit(workspaceId);
  const productLimit = await checkProductLimit(workspaceId);
  const ws = await queryOne<{ balance_paisa: number }>(
    workspaceId,
    'SELECT balance_paisa FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  const { rows: recent } = await query<{
    id: string; cost_paisa: number; provider: string; included_in_plan: boolean; created_at: string;
  }>(
    workspaceId,
    `SELECT id, cost_paisa, provider, included_in_plan, created_at FROM ai_usage_ledger
     WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 5`,
    [workspaceId],
  );
  const creditsRow = await queryOne<{ reply_credits: number }>(
    workspaceId,
    'SELECT reply_credits FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  return {
    subscription: {
      id: sub.id,
      planId: sub.plan_id,
      plan_id: sub.plan_id,
      status: sub.status,
      effectiveStatus: effectiveStatus(sub),
      isActive: isActiveSubscription(sub),
      currentPeriodStart: sub.current_period_start,
      current_period_start: sub.current_period_start,
      currentPeriodEnd: sub.current_period_end,
      current_period_end: sub.current_period_end,
    },
    plan,
    usage: {
      usedReplies,
      includedReplies: included,
      remainingReplies: Math.max(0, included - usedReplies),
      overageReplies: Math.max(0, usedReplies - included),
    },
    limits: { channels: channelLimit, products: productLimit },
    balancePaisa: Number(ws?.balance_paisa ?? 0),
    replyCredits: Number(creditsRow?.reply_credits ?? 0),
    recentUsage: recent.map((r) => ({
      id: r.id,
      cost_paisa: Number(r.cost_paisa),
      provider: r.provider,
      included_in_plan: r.included_in_plan,
      created_at: r.created_at,
    })),
  };
}

/**
 * AI রিপ্লাইয়ের অনুমতি (agent.ts থেকে ডাকা হয়) — YEARBITO Phase 2:
 * 1. রিপ্লাই প্যাকেজের ক্রেডিট থাকলে সেটাই আগে খরচ হয় (package, ০ পয়সা)।
 * 2. পুরনো প্ল্যান (grandfathered) চালু + সীমার ভেতরে → included, ০ পয়সা।
 * 3. পুরনো প্ল্যান চালু + সীমা শেষ → overage, ফ্ল্যাট ২২ পয়সা — ওয়ালেটে
 *    টাকা থাকলে (পুরনো নিয়ম, মেয়াদ শেষ পর্যন্ত)।
 * 4. নইলে pay-as-you-go — ওয়ালেটে ফ্ল্যাট ২৩ পয়সার (PAYG_REPLY_
 *    COST_PAISA) টাকা থাকলে উত্তর যায়। প্রোভাইডারের আসল per-token
 *    খরচ লেজারে ওঠে (স্বচ্ছতার জন্য), কিন্তু ওয়ালেট থেকে কাটে
 *    ফ্ল্যাট ২৩ পয়সা — কাঁচা টোকেন খরচ নয়।
 *    পুরনো প্ল্যানের মেয়াদ শেষ হলেও ওয়ালেটে টাকা থাকলে AI থামে না —
 *    নতুন মডেলে প্ল্যানের মেয়াদ আর AI-র সুইচ নয়।
 * 5. ওয়ালেটে ২৩ পয়সার কম থাকলে → blocked। এজেন্ট তখন কাস্টমারকে
 *    সৎ বার্তা পাঠায় আর টিমের টিকেট খোলে — কখনো চুপচাপ ব্যর্থ হয়
 *    না, চুপচাপ উত্তরও দেয় না।
 */
export async function checkAiReplyAllowance(workspaceId: string): Promise<AiReplyAllowance> {
  // Restricted FIRST (migration 45) — before ensureTrialSubscription,
  // so a restricted workspace does not even get a trial created for it.
  // No AI reply, no charge, no provider call: the agent sends the
  // honest notice below and opens a ticket instead.
  if (await isWorkspaceRestricted(workspaceId)) {
    const ws = await queryOne<{ balance_paisa: number; reply_credits: number }>(
      workspaceId,
      'SELECT balance_paisa, reply_credits FROM workspaces WHERE id = $1',
      [workspaceId],
    );
    return {
      allowed: false, mode: 'blocked', costPaisa: 0,
      reason: 'account_restricted',
      reasonBn: 'অ্যাকাউন্টটি সীমিত (restricted) করা হয়েছে — AI উত্তর বন্ধ আছে। প্ল্যাটফর্মের মালিকের সাথে যোগাযোগ করুন।',
      blockedNoticeBn: RESTRICTED_REPLY_NOTICE_BN,
      usedReplies: 0, includedReplies: 0,
      packageCredits: Number(ws?.reply_credits ?? 0),
      balancePaisa: Number(ws?.balance_paisa ?? 0),
    };
  }
  const sub = await ensureTrialSubscription(workspaceId);
  const current = await getCurrentSubscription(workspaceId);
  const ws = await queryOne<{ balance_paisa: number; reply_credits: number }>(
    workspaceId,
    'SELECT balance_paisa, reply_credits FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  const balance = Number(ws?.balance_paisa ?? 0);
  const packageCredits = Number(ws?.reply_credits ?? 0);
  const base = {
    usedReplies: current.usage.usedReplies,
    includedReplies: current.usage.includedReplies,
    packageCredits,
    balancePaisa: balance,
    blockedNoticeBn: '',
  };
  // 1. Reply package first — bought upfront, consumed before pay-as-you-go.
  if (packageCredits > 0) {
    return { ...base, allowed: true, mode: 'package', costPaisa: 0, reason: 'package', reasonBn: '' };
  }
  // 2–3. Grandfathered old plan (incl. trial) while its period lasts.
  if (isActiveSubscription(sub)) {
    if (current.usage.usedReplies < current.usage.includedReplies) {
      return { ...base, allowed: true, mode: 'included', costPaisa: 0, reason: 'included', reasonBn: '' };
    }
    if (balance >= config.overageReplyCostPaisa) {
      return {
        ...base, allowed: true, mode: 'overage', costPaisa: config.overageReplyCostPaisa,
        reason: 'overage', reasonBn: '',
      };
    }
  }
  // 4. Pay-as-you-go — flat 23 paisa per reply while the wallet can cover it.
  if (balance >= config.paygReplyCostPaisa) {
    return { ...base, allowed: true, mode: 'payg', costPaisa: config.paygReplyCostPaisa, reason: 'payg', reasonBn: '' };
  }
  // 5. Wallet empty — no AI reply. The customer notice is the same
  // wallet-empty message in both cases (top up or buy a package and
  // replies resume); only the internal reason differs.
  const expired = !isActiveSubscription(sub);
  return {
    ...base, allowed: false, mode: 'blocked', costPaisa: 0,
    reason: expired ? 'subscription_expired_wallet_empty' : 'wallet_empty',
    reasonBn: expired
      ? 'প্ল্যানের মেয়াদ শেষ হয়ে গেছে আর ওয়ালেটেও টাকা নেই।'
      : 'ওয়ালেটে টাকা নেই — AI উত্তর দিতে পারছে না।',
    blockedNoticeBn: UPGRADE_NOTICE,
  };
}

export interface ReplyPackageResult {
  ok: boolean;
  status: number;
  error?: string;
  replies?: number;
  totalPaisa?: number;
  pricePerReplyPaisa?: number;
  balancePaisa?: number;
  replyCredits?: number;
}

/**
 * রিপ্লাই প্যাকেজ কেনা — replies × REPLY_PACKAGE_PRICE_PAISA (ডিফল্ট
 * ২২ পয়সা — ইউজারের সিদ্ধান্ত 2026-11-11) ওয়ালেট থেকে কাটে,
 * reply_credits-এ যোগ হয়। টাকা না থাকলে
 * 402 + বাংলা বার্তা। চার্জ wallet_transactions-এ 'package_purchase'
 * হিসেবে যায় — কখনো "পেইড" দেখানো হয় না যতক্ষণ টাকা না কাটে।
 */
export async function purchaseReplyPackage(
  workspaceId: string,
  replies: number,
): Promise<ReplyPackageResult> {
  const n = Math.floor(replies);
  if (!Number.isInteger(n) || n < 1 || n > 100000) {
    return { ok: false, status: 400, error: 'রিপ্লাই সংখ্যা ১–১০০,০০০ এর মধ্যে হতে হবে।' };
  }
  const pricePerReply = config.replyPackagePricePaisa;
  const total = n * pricePerReply;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const wsRes = await client.query(
      'SELECT balance_paisa, reply_credits FROM workspaces WHERE id = $1 FOR UPDATE',
      [workspaceId],
    );
    if (wsRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, error: 'ওয়ার্কস্পেস পাওয়া যায়নি।' };
    }
    const balance = Number((wsRes.rows[0] as { balance_paisa: number }).balance_paisa);
    if (balance < total) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        status: 402,
        error: `${n}টি রিপ্লাই কিনতে ${total} পয়সা লাগবে, কিন্তু ওয়ালেটে আছে ${balance} পয়সা। আগে ওয়ালেটে টাকা যোগ করুন।`,
      };
    }
    const newBalance = balance - total;
    const newCredits =
      Number((wsRes.rows[0] as { reply_credits: number }).reply_credits) + n;
    await client.query(
      'UPDATE workspaces SET balance_paisa = $1, reply_credits = $2, updated_at = now() WHERE id = $3',
      [newBalance, newCredits, workspaceId],
    );
    await client.query(
      "INSERT INTO wallet_transactions (workspace_id, type, amount_paisa, description) VALUES ($1, 'package_purchase', $2, $3)",
      [workspaceId, -total, `Reply package — ${n} replies @ ${pricePerReply} paisa`],
    );
    await client.query('COMMIT');
    return {
      ok: true, status: 201, replies: n, totalPaisa: total,
      pricePerReplyPaisa: pricePerReply, balancePaisa: newBalance, replyCredits: newCredits,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export interface PurchaseResult {
  ok: boolean;
  status: number;
  error?: string;
  subscription?: SubscriptionRow;
  plan?: Plan;
  balancePaisa?: number;
}

/**
 * প্ল্যান কেনা / বদলানো — YEARBITO Phase 2: পুরনো প্ল্যান (ছোট/মাঝারি/
 * বড়) আর বিক্রি হয় না — 410 + বাংলা বার্তা। আগে থেকে চালু থাকা
 * সাবস্ক্রিপশন মেয়াদ শেষ পর্যন্ত চলবে (grandfathered), কিন্তু নবায়নও
 * আর করা যাবে না; মেয়াদ শেষে নতুন মডেল (পোস্ট শিডিউল সাবস্ক্রিপশন +
 * রিপ্লাই প্যাকেজ + pay-as-you-go) চালু হয়। এই ফাংশন এখন শুধু
 * পুরনো কোডপথের নিরাপত্তা-জাল হিসেবে আছে — নতুন কেনা schedule.ts ও
 * purchaseReplyPackage দিয়ে হয়।
 */
export async function purchasePlan(workspaceId: string, slug: string): Promise<PurchaseResult> {
  if (slug === 'choto' || slug === 'majhari' || slug === 'boro') {
    return {
      ok: false,
      status: 410,
      error: 'পুরনো প্ল্যান (ছোট/মাঝারি/বড়) আর বিক্রি হয় না। নতুন মডেলে পোস্ট শিডিউল সাবস্ক্রিপশন (৳১০০/মাস) আর রিপ্লাই প্যাকেজ (২২ পয়সা/রিপ্লাই) দেখুন — আপনার চালু থাকা প্ল্যান মেয়াদ শেষ পর্যন্ত চলবে।',
    };
  }
  const plan = await getPlanBySlug(workspaceId, slug);
  if (!plan) {
    return { ok: false, status: 404, error: 'এই প্ল্যানটি পাওয়া যায়নি।' };
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const wsRes = await client.query(
      'SELECT balance_paisa FROM workspaces WHERE id = $1 FOR UPDATE',
      [workspaceId],
    );
    if (wsRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, error: 'ওয়ার্কস্পেস পাওয়া যায়নি।' };
    }
    const balance = Number((wsRes.rows[0] as { balance_paisa: number }).balance_paisa);
    if (balance < plan.pricePaisa) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        status: 402,
        error: `এই প্ল্যান কিনতে ${plan.pricePaisa} পয়সা লাগবে, কিন্তু ওয়ালেটে আছে ${balance} পয়সা। আগে ওয়ালেটে টাকা যোগ করুন।`,
      };
    }
    const newBalance = balance - plan.pricePaisa;
    await client.query(
      'UPDATE workspaces SET balance_paisa = $1, updated_at = now() WHERE id = $2',
      [newBalance, workspaceId],
    );
    await client.query(
      "INSERT INTO wallet_transactions (workspace_id, type, amount_paisa) VALUES ($1, 'subscription_charge', $2)",
      [workspaceId, -plan.pricePaisa],
    );
    const end = periodEnd(config.subscriptionPeriodDays);
    await client.query(
      `INSERT INTO workspace_subscriptions (workspace_id, plan_id, status, current_period_start, current_period_end)
       VALUES ($1, $2, 'active', now(), $3)`,
      [workspaceId, plan.id, end.toISOString()],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  const sub = await getLatestSubscription(workspaceId);
  if (!sub) return { ok: false, status: 500, error: 'সাবস্ক্রিপশন তৈরি করা যায়নি।' };
  return { ok: true, status: 201, subscription: sub, plan, balancePaisa: (await getCurrentSubscription(workspaceId)).balancePaisa };
}

/** বাতিল — স্ট্যাটাস cancelled হয়, তবে মেয়াদ শেষ পর্যন্ত চালু থাকে। */
export async function cancelCurrentSubscription(
  workspaceId: string,
): Promise<{ ok: boolean; status: number; error?: string; subscription?: SubscriptionRow }> {
  const sub = await getLatestSubscription(workspaceId);
  if (!sub) return { ok: false, status: 404, error: 'কোনো সাবস্ক্রিপশন পাওয়া যায়নি।' };
  if (sub.status === 'cancelled' || effectiveStatus(sub) === 'expired') {
    return { ok: false, status: 400, error: 'এই সাবস্ক্রিপশনটি ইতিমধ্যে বাতিল বা মেয়াদোত্তীর্ণ।' };
  }
  const updated = await queryOne<SubscriptionRow>(
    workspaceId,
    `${SUB_WITH_PLAN} WHERE ws.workspace_id = $1 AND ws.id = $2`,
    [workspaceId, sub.id],
  );
  await query(
    workspaceId,
    `UPDATE workspace_subscriptions SET status = 'cancelled', updated_at = now()
     WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, sub.id],
  );
  const after = updated
    ? { ...updated, status: 'cancelled' }
    : await getLatestSubscription(workspaceId);
  return { ok: true, status: 200, subscription: after ?? undefined };
}

/** নবায়ন — চলতি প্ল্যানের পুরো দাম কেটে নতুন ৩০ দিনের পিরিয়ড শুরু হয়। */
export async function renewCurrentSubscription(workspaceId: string): Promise<PurchaseResult> {
  const sub = await ensureTrialSubscription(workspaceId);
  return purchasePlan(workspaceId, sub.plan_slug);
}

// ---------------------------------------------------------------------------
// পরীক্ষার সহায়ক (test support) — শুধু নিজের ওয়ার্কস্পেসে কাজ করে।
// verify-subscriptions.mjs এগুলো দিয়ে মেয়াদোত্তীর্ণ ও ওভারেজ পরীক্ষা করে,
// যাতে ৫০০টি আসল AI কল না করতে হয়। দুটোই শুধু নিজের ক্ষতি করতে পারে
// (নিজের মেয়াদ শেষ করা / নিজের ব্যবহার বাড়ানো) — অন্যের ডেটা ছোঁয় না,
// আর কোনো টাকা বাড়ায় না। প্রোডাকশনে এগুলো তুলে ফেলা যেতে পারে।
// ---------------------------------------------------------------------------

/** চলতি সাবস্ক্রিপশনের মেয়াদ ১ ঘণ্টা আগে শেষ করে দেয় (মেয়াদোত্তীর্ণ পরীক্ষা)। */
export async function expireCurrentSubscriptionForTest(
  workspaceId: string,
): Promise<SubscriptionRow | null> {
  const sub = await getLatestSubscription(workspaceId);
  if (!sub) return null;
  await query(
    workspaceId,
    `UPDATE workspace_subscriptions SET current_period_end = now() - interval '1 hour', updated_at = now()
     WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, sub.id],
  );
  return getLatestSubscription(workspaceId);
}

/** এই পিরিয়ডে count-টি AI ব্যবহার হয়েছে বলে লেজারে লেখে (ওভারেজ পরীক্ষা)। */
export async function simulateUsageForTest(workspaceId: string, count: number): Promise<number> {
  const n = Math.max(0, Math.min(10000, Math.floor(count)));
  if (n === 0) return 0;
  const { rowCount } = await query(
    workspaceId,
    `INSERT INTO ai_usage_ledger (workspace_id, conversation_id, input_tokens, output_tokens, cost_paisa, provider, included_in_plan)
     SELECT $1, NULL, 0, 0, 0, 'groq', TRUE FROM generate_series(1, $2)`,
    [workspaceId, n],
  );
  return rowCount;
}

// ---------------------------------------------------------------------------
// Owner Panel — subscription management (Feature 5, migration 45).
// Platform-owner only; the routes live in owner/admin.ts (list) and
// subscriptions/routes.ts (approve/cancel, owner-guarded).
//
// What "pending" means here (no parallel flow invented): subscriptions
// in this codebase are created ONLY after the wallet is charged, so
// there is no pending-subscription row. The thing that waits on the
// owner is (a) a subscription gone 'past_due' (approve = verify the
// manual payment, set it active again) and (b) a manual top-up request
// (topup_requests status 'pending' — approved through the EXISTING
// billing endpoint POST /api/billing/topup/:id/approve, never a second
// approval path). Both are listed together by listAllSubscriptions...
// below so the owner sees everything waiting in one place.
// ---------------------------------------------------------------------------

export interface OwnerSubscription {
  id: string;
  kind: 'plan' | 'schedule';
  workspaceId: string;
  workspaceName: string;
  planName: string;
  pricePaisa: number;
  status: string;
  effectiveStatus: string;
  periodStart: string;
  periodEnd: string;
  createdAt: string;
}

export interface OwnerPendingTopup {
  id: string;
  workspaceId: string;
  workspaceName: string;
  amountPaisa: number;
  method: string;
  transactionId: string;
  status: string;
  requestedByEmail: string | null;
  createdAt: string;
  /** Checkout purpose (migration 46) — what the shop paid for. */
  purpose: { kind: string; slug?: string; replies?: number } | null;
}

export interface OwnerSubscriptionAction {
  ok: boolean;
  status: number;
  error?: string;
  subscription?: OwnerSubscription;
  message?: string;
}

function toOwnerSubscription(
  kind: 'plan' | 'schedule',
  r: {
    id: string; workspace_id: string; workspace_name: string; plan_name: string;
    price_paisa: number; status: string; current_period_start: string;
    current_period_end: string; created_at: string;
  },
): OwnerSubscription {
  const ended = new Date(r.current_period_end).getTime() <= Date.now();
  return {
    id: r.id,
    kind,
    workspaceId: r.workspace_id,
    workspaceName: r.workspace_name ?? '—',
    planName: r.plan_name,
    pricePaisa: Number(r.price_paisa),
    status: r.status,
    effectiveStatus: ended ? 'expired' : r.status,
    periodStart: r.current_period_start,
    periodEnd: r.current_period_end,
    createdAt: r.created_at,
  };
}

function schedulePlanName(billingCycle: string, currency: string): string {
  const cycle = billingCycle === 'yearly' ? 'বাৎসরিক' : 'মাসিক';
  return `পোস্ট শিডিউল — ${cycle} (${currency === 'USD' ? 'ইন্টারন্যাশনাল' : 'বাংলাদেশ'})`;
}

/** Every shop's subscriptions — old plans (grandfathered) + Post Schedule subs. */
export async function listAllSubscriptionsForOwner(): Promise<OwnerSubscription[]> {
  const plans = await pool.query<{
    id: string; workspace_id: string; status: string; current_period_start: string;
    current_period_end: string; created_at: string; plan_name: string;
    price_paisa: number; workspace_name: string;
  }>(
    `SELECT ws.id, ws.workspace_id, ws.status, ws.current_period_start, ws.current_period_end, ws.created_at,
            p.name_bn AS plan_name, p.price_paisa, w.name AS workspace_name
     FROM workspace_subscriptions ws
     JOIN plans p ON p.id = ws.plan_id
     JOIN workspaces w ON w.id = ws.workspace_id
     ORDER BY ws.created_at DESC`,
  );
  const sched = await pool.query<{
    id: string; workspace_id: string; status: string; current_period_start: string;
    current_period_end: string; created_at: string; billing_cycle: string;
    currency: string; price_paisa: number; workspace_name: string;
  }>(
    `SELECT s.id, s.workspace_id, s.status, s.current_period_start, s.current_period_end, s.created_at,
            s.billing_cycle, s.currency, s.price_paisa, w.name AS workspace_name
     FROM schedule_subscriptions s
     JOIN workspaces w ON w.id = s.workspace_id
     ORDER BY s.created_at DESC`,
  );
  const out: OwnerSubscription[] = [
    ...plans.rows.map((r) => toOwnerSubscription('plan', r)),
    ...sched.rows.map((r) =>
      toOwnerSubscription('schedule', { ...r, plan_name: schedulePlanName(r.billing_cycle, r.currency) }),
    ),
  ];
  out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return out;
}

/** Manual top-up requests still waiting on the owner (status 'pending'). */
export async function listPendingTopupsForOwner(): Promise<OwnerPendingTopup[]> {
  const { rows } = await pool.query(
    `SELECT t.id, t.workspace_id, t.amount_paisa, t.method, t.transaction_id, t.status, t.purpose, t.created_at,
            w.name AS workspace_name, u.email AS requested_by_email
     FROM topup_requests t
     JOIN workspaces w ON w.id = t.workspace_id
     LEFT JOIN users u ON u.id = t.requested_by
     WHERE t.status = 'pending' ORDER BY t.created_at DESC`,
  );
  return rows.map((r) => {
    let purpose: OwnerPendingTopup['purpose'] = null;
    try { purpose = r.purpose ? JSON.parse(r.purpose) : null; } catch { purpose = null; }
    return {
      id: r.id,
      workspaceId: r.workspace_id,
      workspaceName: (r.workspace_name as string | null) ?? '—',
      amountPaisa: Number(r.amount_paisa),
      method: r.method,
      transactionId: r.transaction_id,
      status: r.status,
      requestedByEmail: (r.requested_by_email as string | null) ?? null,
      createdAt: r.created_at,
      purpose,
    };
  });
}

export interface OwnerActor {
  id: string;
  email: string;
}

/**
 * Approve a past_due subscription — the owner verified the manual
 * payment, so the subscription goes back to 'active'. If the period
 * already ended, a fresh period starts now (30 days for an old plan /
 * schedule-monthly, 365 for schedule-yearly). Anything already active
 * or trial → 409; cancelled / expired → 400 (cancelled stays
 * cancelled; expired needs a new purchase, not an approval).
 */
export async function approveSubscriptionForOwner(
  kind: 'plan' | 'schedule',
  id: string,
  actor: OwnerActor,
): Promise<OwnerSubscriptionAction> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (kind === 'plan') {
      const { rows } = await client.query(
        `SELECT ws.id, ws.workspace_id, ws.status, ws.current_period_start, ws.current_period_end, ws.created_at,
                p.name_bn AS plan_name, p.price_paisa, w.name AS workspace_name
         FROM workspace_subscriptions ws JOIN plans p ON p.id = ws.plan_id
         JOIN workspaces w ON w.id = ws.workspace_id WHERE ws.id = $1`,
        [id],
      );
      const row = rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return { ok: false, status: 404, error: 'সাবস্ক্রিপশন পাওয়া যায়নি।' };
      }
      if (row.status === 'active' || row.status === 'trial') {
        await client.query('ROLLBACK');
        return { ok: false, status: 409, error: 'এই সাবস্ক্রিপশনটি ইতিমধ্যে চালু আছে — অনুমোদনের দরকার নেই।' };
      }
      if (row.status !== 'past_due') {
        await client.query('ROLLBACK');
        return { ok: false, status: 400, error: `শুধু বকেয়া (past_due) সাবস্ক্রিপশন অনুমোদন করা যায় — এটি এখন ${row.status}।` };
      }
      const ended = new Date(row.current_period_end).getTime() <= Date.now();
      const newEnd = ended
        ? new Date(Date.now() + config.subscriptionPeriodDays * 24 * 60 * 60 * 1000).toISOString()
        : row.current_period_end;
      await client.query(
        `UPDATE workspace_subscriptions SET status = 'active', current_period_end = $1, updated_at = now() WHERE id = $2`,
        [newEnd, id],
      );
      await client.query(OWNER_AUDIT_INSERT_SQL, [
        actor.id, actor.email, null, null, row.workspace_id, 'approve_subscription',
        `Approved past_due plan subscription ${id} (${row.plan_name})${ended ? ' — নতুন ৩০ দিনের মেয়াদ শুরু' : ''}`,
      ]);
      await client.query('COMMIT');
      const after = toOwnerSubscription('plan', { ...row, status: 'active', current_period_end: newEnd });
      return { ok: true, status: 200, subscription: after, message: 'সাবস্ক্রিপশন অনুমোদন করা হয়েছে — এখন চালু আছে।' };
    }
    const { rows } = await client.query(
      `SELECT s.id, s.workspace_id, s.status, s.current_period_start, s.current_period_end, s.created_at,
              s.billing_cycle, s.currency, s.price_paisa, w.name AS workspace_name
       FROM schedule_subscriptions s JOIN workspaces w ON w.id = s.workspace_id WHERE s.id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, error: 'সাবস্ক্রিপশন পাওয়া যায়নি।' };
    }
    if (row.status === 'active') {
      await client.query('ROLLBACK');
      return { ok: false, status: 409, error: 'এই সাবস্ক্রিপশনটি ইতিমধ্যে চালু আছে — অনুমোদনের দরকার নেই।' };
    }
    if (row.status !== 'past_due') {
      await client.query('ROLLBACK');
      return { ok: false, status: 400, error: `শুধু বকেয়া (past_due) সাবস্ক্রিপশন অনুমোদন করা যায় — এটি এখন ${row.status}।` };
    }
    const ended = new Date(row.current_period_end).getTime() <= Date.now();
    const days = row.billing_cycle === 'yearly' ? 365 : 30;
    const newEnd = ended
      ? new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
      : row.current_period_end;
    await client.query(
      `UPDATE schedule_subscriptions SET status = 'active', current_period_end = $1, updated_at = now() WHERE id = $2`,
      [newEnd, id],
    );
    await client.query(OWNER_AUDIT_INSERT_SQL, [
      actor.id, actor.email, null, null, row.workspace_id, 'approve_subscription',
      `Approved past_due schedule subscription ${id} (${schedulePlanName(row.billing_cycle, row.currency)})${ended ? ` — নতুন ${days} দিনের মেয়াদ শুরু` : ''}`,
    ]);
    await client.query('COMMIT');
    const after = toOwnerSubscription('schedule', {
      ...row, status: 'active', current_period_end: newEnd,
      plan_name: schedulePlanName(row.billing_cycle, row.currency),
    });
    return { ok: true, status: 200, subscription: after, message: 'সাবস্ক্রিপশন অনুমোদন করা হয়েছে — এখন চালু আছে।' };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Cancel a subscription — status becomes 'cancelled' BUT the period
 * end is UNCHANGED: the subscription stays usable until
 * current_period_end, then stops (same rule the shop's own Cancel
 * button already uses). This is what the Owner Panel confirm dialog
 * promises. Already cancelled / expired → 400.
 */
export async function cancelSubscriptionForOwner(
  kind: 'plan' | 'schedule',
  id: string,
  actor: OwnerActor,
): Promise<OwnerSubscriptionAction> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (kind === 'plan') {
      const { rows } = await client.query(
        `SELECT ws.id, ws.workspace_id, ws.status, ws.current_period_start, ws.current_period_end, ws.created_at,
                p.name_bn AS plan_name, p.price_paisa, w.name AS workspace_name
         FROM workspace_subscriptions ws JOIN plans p ON p.id = ws.plan_id
         JOIN workspaces w ON w.id = ws.workspace_id WHERE ws.id = $1`,
        [id],
      );
      const row = rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return { ok: false, status: 404, error: 'সাবস্ক্রিপশন পাওয়া যায়নি।' };
      }
      if (row.status === 'cancelled' || new Date(row.current_period_end).getTime() <= Date.now()) {
        await client.query('ROLLBACK');
        return { ok: false, status: 400, error: 'এই সাবস্ক্রিপশনটি ইতিমধ্যে বাতিল বা মেয়াদোত্তীর্ণ।' };
      }
      await client.query(
        `UPDATE workspace_subscriptions SET status = 'cancelled', updated_at = now() WHERE id = $1`,
        [id],
      );
      await client.query(OWNER_AUDIT_INSERT_SQL, [
        actor.id, actor.email, null, null, row.workspace_id, 'cancel_subscription',
        `Cancelled plan subscription ${id} (${row.plan_name}) — মেয়াদ শেষ (${String(row.current_period_end).slice(0, 10)}) পর্যন্ত চালু থাকবে`,
      ]);
      await client.query('COMMIT');
      const after = toOwnerSubscription('plan', { ...row, status: 'cancelled' });
      return {
        ok: true, status: 200, subscription: after,
        message: `সাবস্ক্রিপশন বাতিল হয়েছে — মেয়াদ শেষ (${String(row.current_period_end).slice(0, 10)}) পর্যন্ত চালু থাকবে।`,
      };
    }
    const { rows } = await client.query(
      `SELECT s.id, s.workspace_id, s.status, s.current_period_start, s.current_period_end, s.created_at,
              s.billing_cycle, s.currency, s.price_paisa, w.name AS workspace_name
       FROM schedule_subscriptions s JOIN workspaces w ON w.id = s.workspace_id WHERE s.id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, error: 'সাবস্ক্রিপশন পাওয়া যায়নি।' };
    }
    if (row.status === 'cancelled' || new Date(row.current_period_end).getTime() <= Date.now()) {
      await client.query('ROLLBACK');
      return { ok: false, status: 400, error: 'এই সাবস্ক্রিপশনটি ইতিমধ্যে বাতিল বা মেয়াদোত্তীর্ণ।' };
    }
    await client.query(
      `UPDATE schedule_subscriptions SET status = 'cancelled', updated_at = now() WHERE id = $1`,
      [id],
    );
    await client.query(OWNER_AUDIT_INSERT_SQL, [
      actor.id, actor.email, null, null, row.workspace_id, 'cancel_subscription',
      `Cancelled schedule subscription ${id} (${schedulePlanName(row.billing_cycle, row.currency)}) — মেয়াদ শেষ (${String(row.current_period_end).slice(0, 10)}) পর্যন্ত চালু থাকবে`,
    ]);
    await client.query('COMMIT');
    const after = toOwnerSubscription('schedule', {
      ...row, status: 'cancelled',
      plan_name: schedulePlanName(row.billing_cycle, row.currency),
    });
    return {
      ok: true, status: 200, subscription: after,
      message: `সাবস্ক্রিপশন বাতিল হয়েছে — মেয়াদ শেষ (${String(row.current_period_end).slice(0, 10)}) পর্যন্ত চালু থাকবে।`,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
