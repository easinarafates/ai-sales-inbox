/**
 * সাবস্ক্রিপশন সার্ভিস — প্ল্যান, ট্রায়াল, কেনা/আপগ্রেড/বাতিল/নবায়ন,
 * সীমা যাচাই (চ্যানেল/প্রোডাক্ট) ও AI রিপ্লাইয়ের অনুমতি।
 *
 * নিয়ম:
 * - সব কোয়েরি workspace_id দিয়ে ফিল্টার করে (plans টেবিলটি গ্লোবাল —
 *   সবার জন্য একই প্ল্যানের তালিকা, তাই সেখানে workspace ফিল্টার নেই)।
 * - দাম/সীমা রানটাইমে plans টেবিল থেকেই আসে (মাইগ্রেশন 04-এ সিড করা
 *   প্রস্তাবিত দাম)। কনফিগে শুধু TRIAL_DAYS ও ওভারেজের ১০ পয়সা থাকে।
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
  recentUsage: { id: string; cost_paisa: number; provider: string; included_in_plan: boolean; created_at: string }[];
}

export interface AiReplyAllowance {
  allowed: boolean;
  mode: 'included' | 'overage' | 'blocked';
  costPaisa: number;
  reason: string;
  reasonBn: string;
  usedReplies: number;
  includedReplies: number;
  balancePaisa: number;
}

export const UPGRADE_NOTICE =
  'আপনার প্ল্যানের মেয়াদ/সীমা শেষ হয়েছে — প্ল্যান নবায়ন করুন';

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
 * AI রিপ্লাইয়ের অনুমতি (agent.ts থেকে ডাকা হয়):
 * - চালু সাবস্ক্রিপশন + সীমার ভেতরে → included, ০ পয়সা।
 * - চালু + সীমা শেষ → overage, ১০ পয়সা — ওয়ালেটে টাকা থাকলে।
 * - মেয়াদ শেষ / বাতিল-মেয়াদোত্তীর্ণ, বা ওভারেজের টাকা নেই → blocked।
 *   এজেন্ট তখন কাস্টমারকে আপগ্রেড নোটিশ পাঠায় আর টিমের টিকেট খোলে —
 *   কখনো চুপচাপ ব্যর্থ হয় না, চুপচাপ উত্তরও দেয় না।
 */
export async function checkAiReplyAllowance(workspaceId: string): Promise<AiReplyAllowance> {
  const sub = await ensureTrialSubscription(workspaceId);
  const current = await getCurrentSubscription(workspaceId);
  const ws = await queryOne<{ balance_paisa: number }>(
    workspaceId,
    'SELECT balance_paisa FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  const balance = Number(ws?.balance_paisa ?? 0);
  const base = {
    usedReplies: current.usage.usedReplies,
    includedReplies: current.usage.includedReplies,
    balancePaisa: balance,
  };
  if (!isActiveSubscription(sub)) {
    return {
      ...base, allowed: false, mode: 'blocked', costPaisa: 0,
      reason: 'subscription_expired',
      reasonBn: 'প্ল্যানের মেয়াদ শেষ হয়ে গেছে।',
    };
  }
  if (current.usage.usedReplies < current.usage.includedReplies) {
    return { ...base, allowed: true, mode: 'included', costPaisa: 0, reason: 'included', reasonBn: '' };
  }
  if (balance >= config.overageReplyCostPaisa) {
    return {
      ...base, allowed: true, mode: 'overage', costPaisa: config.overageReplyCostPaisa,
      reason: 'overage', reasonBn: '',
    };
  }
  return {
    ...base, allowed: false, mode: 'blocked', costPaisa: 0,
    reason: 'wallet_empty_overage',
    reasonBn: 'প্ল্যানের অন্তর্ভুক্ত রিপ্লাই শেষ, আর ওয়ালেটেও টাকা নেই।',
  };
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
 * প্ল্যান কেনা / বদলানো — একই লজিক: পুরো নতুন দাম ওয়ালেট থেকে কাটে,
 * নতুন ৩০ দিনের পিরিয়ড এখন থেকে শুরু হয় (সহজ প্রোরেট), স্ট্যাটাস active।
 * টাকা না থাকলে 402 + বাংলা বার্তা। চার্জ wallet_transactions-এ যায়।
 */
export async function purchasePlan(workspaceId: string, slug: string): Promise<PurchaseResult> {
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
