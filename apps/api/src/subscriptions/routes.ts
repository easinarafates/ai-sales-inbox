import { Router, type Response } from 'express';
import { config } from '../config';
import { pool } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';
import { requireOwner } from '../owner/ownerAuth';
import {
  approveSubscriptionForOwner,
  cancelCurrentSubscription,
  cancelSubscriptionForOwner,
  checkChannelLimit,
  checkProductLimit,
  expireCurrentSubscriptionForTest,
  getCurrentSubscription,
  listPlans,
  purchasePlan,
  renewCurrentSubscription,
  simulateUsageForTest,
} from './service';
import {
  FREE_POSTS_PER_DAY,
  MAX_POSTS_PER_DAY,
  SCHEDULE_PLANS,
  cancelScheduleSubscription,
  effectiveDailyPostLimit,
  getScheduleSubscription,
  occupyingCountOnDay,
  purchaseScheduleSubscription,
} from './schedule';

/**
 * সাবস্ক্রিপশন API (Phase: সাবস্ক্রিপশন সিস্টেম + YEARBITO Phase 2)।
 * Mounted by the coordinator at /api — see integration-notes.md
 * (app.use('/api', subscriptionsRouter)).
 * সব রুটে requireAuth; প্রতিটি কোয়েরি workspace_id দিয়ে ফিল্টার করে।
 *
 * YEARBITO Phase 2: পুরনো প্ল্যান (ছোট/মাঝারি/বড়) আর বিক্রি হয় না —
 * POST /subscribe, /upgrade, /downgrade, /renew এখন 410 দেয়; চালু
 * থাকা সাবস্ক্রিপশন মেয়াদ শেষ পর্যন্ত চলবে (GET /current দেখায়)।
 * নতুন কেনা: POST /schedule/subscribe (পোস্ট শিডিউল সাবস্ক্রিপশন) আর
 * POST /api/billing/reply-package (রিপ্লাই প্যাকেজ)।
 */
export const subscriptionsRouter = Router();
subscriptionsRouter.use(requireAuth);

/** GET /api/subscriptions/plans — পুরনো প্ল্যানের তালিকা (grandfathered
 *  দেখার জন্য; নতুন কেনা যায় না — Plans পেজে আর দেখানো হয় না)। */
subscriptionsRouter.get('/subscriptions/plans', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const plans = await listPlans(workspaceId);
  res.json({ plans });
});

/**
 * GET /api/subscriptions/schedule — Post Schedule সাবস্ক্রিপশন:
 * চলতি সাবস্ক্রিপশন + কেনা যায় এমন ৪টি অপশন (মাসিক/বাৎসরিক ×
 * BDT/USD) + আজকের দিনের সীমা ও ব্যবহার।
 */
subscriptionsRouter.get('/subscriptions/schedule', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const subscription = await getScheduleSubscription(workspaceId);
  const dailyLimit = await effectiveDailyPostLimit(workspaceId);
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const todayUsed = await occupyingCountOnDay(workspaceId, today);
  res.json({
    subscription,
    plans: SCHEDULE_PLANS,
    freePostsPerDay: FREE_POSTS_PER_DAY,
    maxPostsPerDay: MAX_POSTS_PER_DAY,
    dailyLimit,
    today,
    todayUsed,
  });
});

/**
 * POST /api/subscriptions/schedule/subscribe {planSlug} — পোস্ট শিডিউল
 * সাবস্ক্রিপশন কেনা (schedule-monthly-bdt / schedule-yearly-bdt /
 * schedule-monthly-usd / schedule-yearly-usd)। পুরো দাম ওয়ালেট থেকে
 * কাটে (schedule_subscription), নতুন পিরিয়ড এখন থেকে শুরু হয়।
 * টাকা না থাকলে 402 + বাংলা বার্তা।
 */
subscriptionsRouter.post('/subscriptions/schedule/subscribe', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { planSlug } = (req.body ?? {}) as { planSlug?: string };
  if (!planSlug || typeof planSlug !== 'string') {
    res.status(400).json({ error: 'planSlug দরকার (schedule-monthly-bdt / schedule-yearly-bdt / schedule-monthly-usd / schedule-yearly-usd)।' });
    return;
  }
  try {
    const result = await purchaseScheduleSubscription(workspaceId, planSlug);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.status(201).json({
      subscription: result.subscription,
      plan: result.plan,
      balancePaisa: result.balancePaisa,
      message: `পোস্ট শিডিউল সাবস্ক্রিপশন চালু হয়েছে (${result.plan?.nameBn ?? ''})।`,
    });
  } catch (err) {
    console.error('[subscriptions/schedule/subscribe]', err);
    res.status(500).json({ error: 'সাবস্ক্রিপশন কেনা যায়নি।' });
  }
});

/** POST /api/subscriptions/schedule/cancel — বাতিল; মেয়াদ শেষ পর্যন্ত চালু থাকে। */
subscriptionsRouter.post('/subscriptions/schedule/cancel', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  try {
    const result = await cancelScheduleSubscription(workspaceId);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({
      subscription: result.subscription,
      message: 'পোস্ট শিডিউল সাবস্ক্রিপশন বাতিল হয়েছে — মেয়াদ শেষ পর্যন্ত চালু থাকবে।',
    });
  } catch (err) {
    console.error('[subscriptions/schedule/cancel]', err);
    res.status(500).json({ error: 'বাতিল করা যায়নি।' });
  }
});

/** GET /api/subscriptions/current — চলতি প্ল্যান + ব্যবহার + সীমা। */
subscriptionsRouter.get('/subscriptions/current', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const current = await getCurrentSubscription(workspaceId);
  res.json({ current });
});

/** GET /api/subscriptions/limits — চ্যানেল/প্রোডাক্ট সীমা (আর যোগ করা যাবে কি না)। */
subscriptionsRouter.get('/subscriptions/limits', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const channels = await checkChannelLimit(workspaceId);
  const products = await checkProductLimit(workspaceId);
  res.json({ channels, products });
});

/**
 * POST /api/subscriptions/subscribe {planSlug} — প্ল্যান কেনা।
 * পুরো মাসের দাম ওয়ালেট থেকে কাটে (subscription_charge), নতুন ৩০ দিনের
 * পিরিয়ড এখন থেকে শুরু হয়। টাকা না থাকলে 402 + বাংলা বার্তা।
 */
subscriptionsRouter.post('/subscriptions/subscribe', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { planSlug } = (req.body ?? {}) as { planSlug?: string };
  if (!planSlug || typeof planSlug !== 'string') {
    res.status(400).json({ error: 'planSlug দরকার — তবে পুরনো প্ল্যান (ছোট/মাঝারি/বড়) আর বিক্রি হয় না; পোস্ট শিডিউল সাবস্ক্রিপশন নিন।' });
    return;
  }
  try {
    const result = await purchasePlan(workspaceId, planSlug);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.status(201).json({
      subscription: result.subscription,
      plan: result.plan,
      balancePaisa: result.balancePaisa,
      message: `${result.plan?.nameBn ?? ''} প্ল্যান চালু হয়েছে।`,
    });
  } catch (err) {
    console.error('[subscriptions/subscribe]', err);
    res.status(500).json({ error: 'সাবস্ক্রিপশন কেনা যায়নি।' });
  }
});

/**
 * POST /api/subscriptions/upgrade {planSlug} — বড় প্ল্যানে যাওয়া।
 * POST /api/subscriptions/downgrade {planSlug} — ছোট প্ল্যানে যাওয়া।
 * দুটোতেই নতুন পিরিয়ড এখন থেকে শুরু হয় (সহজ প্রোরেট: পুরো নতুন দাম)।
 */
subscriptionsRouter.post('/subscriptions/upgrade', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { planSlug } = (req.body ?? {}) as { planSlug?: string };
  if (!planSlug || typeof planSlug !== 'string') {
    res.status(400).json({ error: 'planSlug দরকার — তবে পুরনো প্ল্যান (ছোট/মাঝারি/বড়) আর বিক্রি হয় না; পোস্ট শিডিউল সাবস্ক্রিপশন নিন।' });
    return;
  }
  try {
    const current = await getCurrentSubscription(workspaceId);
    const plans = await listPlans(workspaceId);
    const target = plans.find((p) => p.slug === planSlug);
    if (!target) {
      res.status(404).json({ error: 'এই প্ল্যানটি পাওয়া যায়নি।' });
      return;
    }
    if (target.pricePaisa <= current.plan.pricePaisa) {
      res.status(400).json({ error: 'আপগ্রেড করতে বর্তমান প্ল্যানের চেয়ে বড় (দামি) প্ল্যান বেছে নিন।' });
      return;
    }
    const result = await purchasePlan(workspaceId, planSlug);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.status(201).json({
      subscription: result.subscription,
      plan: result.plan,
      balancePaisa: result.balancePaisa,
      message: `${result.plan?.nameBn ?? ''} প্ল্যানে আপগ্রেড হয়েছে।`,
    });
  } catch (err) {
    console.error('[subscriptions/upgrade]', err);
    res.status(500).json({ error: 'আপগ্রেড করা যায়নি।' });
  }
});

subscriptionsRouter.post('/subscriptions/downgrade', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { planSlug } = (req.body ?? {}) as { planSlug?: string };
  if (!planSlug || typeof planSlug !== 'string') {
    res.status(400).json({ error: 'planSlug দরকার — তবে পুরনো প্ল্যান (ছোট/মাঝারি/বড়) আর বিক্রি হয় না; পোস্ট শিডিউল সাবস্ক্রিপশন নিন।' });
    return;
  }
  try {
    const current = await getCurrentSubscription(workspaceId);
    const plans = await listPlans(workspaceId);
    const target = plans.find((p) => p.slug === planSlug);
    if (!target) {
      res.status(404).json({ error: 'এই প্ল্যানটি পাওয়া যায়নি।' });
      return;
    }
    if (target.pricePaisa >= current.plan.pricePaisa) {
      res.status(400).json({ error: 'ডাউনগ্রেড করতে বর্তমান প্ল্যানের চেয়ে ছোট (কম দামি) প্ল্যান বেছে নিন।' });
      return;
    }
    const result = await purchasePlan(workspaceId, planSlug);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.status(201).json({
      subscription: result.subscription,
      plan: result.plan,
      balancePaisa: result.balancePaisa,
      message: `${result.plan?.nameBn ?? ''} প্ল্যানে ডাউনগ্রেড হয়েছে।`,
    });
  } catch (err) {
    console.error('[subscriptions/downgrade]', err);
    res.status(500).json({ error: 'ডাউনগ্রেড করা যায়নি।' });
  }
});

/**
 * POST /api/subscriptions/cancel — বাতিল। স্ট্যাটাস cancelled হয়, তবে
 * মেয়াদ শেষ (current_period_end) পর্যন্ত প্ল্যান চালু থাকে।
 */
subscriptionsRouter.post('/subscriptions/cancel', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  try {
    const result = await cancelCurrentSubscription(workspaceId);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({
      subscription: result.subscription,
      message: 'প্ল্যান বাতিল হয়েছে — মেয়াদ শেষ পর্যন্ত চালু থাকবে।',
    });
  } catch (err) {
    console.error('[subscriptions/cancel]', err);
    res.status(500).json({ error: 'বাতিল করা যায়নি।' });
  }
});

/** POST /api/subscriptions/renew — নবায়ন: চলতি প্ল্যানের দাম কেটে নতুন ৩০ দিন শুরু। */
subscriptionsRouter.post('/subscriptions/renew', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  try {
    const result = await renewCurrentSubscription(workspaceId);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.status(201).json({
      subscription: result.subscription,
      plan: result.plan,
      balancePaisa: result.balancePaisa,
      message: 'প্ল্যান নবায়ন হয়েছে — নতুন ৩০ দিন শুরু হলো।',
    });
  } catch (err) {
    console.error('[subscriptions/renew]', err);
    res.status(500).json({ error: 'নবায়ন করা যায়নি।' });
  }
});

// ---------------------------------------------------------------------------
// Owner Panel — subscription approve / cancel (Feature 5, migration 45).
// Platform-owner only (requireOwner). These live here — not in
// owner/admin.ts — because the logic lives in service.ts next to the
// shop's own cancel; the list lives in owner/admin.ts. The paths are
// /api/owner/subscriptions/* so the Owner Panel calls one API prefix.
// NOTE on mount order: ownerRouter (mounted at /api/owner before this
// router) has no POST /subscriptions/:id/* route, so these requests
// fall through to here; requireOwner already ran there for non-owners.
// ---------------------------------------------------------------------------

async function ownerActor(req: AuthRequest): Promise<{ id: string; email: string }> {
  const { rows } = await pool.query<{ email: string }>(
    'SELECT email FROM users WHERE id = $1',
    [req.userId ?? ''],
  );
  return { id: req.userId ?? '', email: rows[0]?.email ?? '' };
}

/**
 * POST /api/owner/subscriptions/:id/approve {kind: 'plan'|'schedule'} —
 * approve a past_due subscription (manual payment verified by the
 * owner): it goes back to 'active'. If its period already ended, a
 * fresh period starts now. Already active → 409.
 */
subscriptionsRouter.post('/owner/subscriptions/:id/approve', requireOwner, async (req: AuthRequest, res: Response) => {
  const { kind } = (req.body ?? {}) as { kind?: string };
  if (kind !== 'plan' && kind !== 'schedule') {
    res.status(400).json({ error: "kind দরকার — 'plan' বা 'schedule'।" });
    return;
  }
  try {
    const result = await approveSubscriptionForOwner(kind, req.params.id, await ownerActor(req));
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ subscription: result.subscription, message: result.message });
  } catch (err) {
    console.error('[subscriptions/owner/approve]', err);
    res.status(500).json({ error: 'সাবস্ক্রিপশন অনুমোদন করা যায়নি।' });
  }
});

/**
 * POST /api/owner/subscriptions/:id/cancel {kind: 'plan'|'schedule'} —
 * cancel a subscription. It ends AT ITS PERIOD END: status becomes
 * 'cancelled' but the subscription stays usable until
 * current_period_end — exactly what the Owner Panel confirm dialog
 * promises the owner.
 */
subscriptionsRouter.post('/owner/subscriptions/:id/cancel', requireOwner, async (req: AuthRequest, res: Response) => {
  const { kind } = (req.body ?? {}) as { kind?: string };
  if (kind !== 'plan' && kind !== 'schedule') {
    res.status(400).json({ error: "kind দরকার — 'plan' বা 'schedule'।" });
    return;
  }
  try {
    const result = await cancelSubscriptionForOwner(kind, req.params.id, await ownerActor(req));
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ subscription: result.subscription, message: result.message });
  } catch (err) {
    console.error('[subscriptions/owner/cancel]', err);
    res.status(500).json({ error: 'সাবস্ক্রিপশন বাতিল করা যায়নি।' });
  }
});

// ---------------------------------------------------------------------------
// পরীক্ষার সহায়ক রুট (service.ts-এ ব্যাখ্যা দেখুন) — শুধু নিজের ওয়ার্কস্পেস।
// গেট করা: ALLOW_SUBSCRIPTION_TEST_HOOKS=true না থাকলে 404 (ডিফল্ট বন্ধ)।
// লোকালে যাচাই চালাতে API-টি ওই ফ্ল্যাগ দিয়ে চালু করুন:
//   ALLOW_SUBSCRIPTION_TEST_HOOKS=true ./scripts/run-local.sh
// ---------------------------------------------------------------------------

function testHooksAllowed(res: Response): boolean {
  if (config.allowSubscriptionTestHooks) return true;
  res.status(404).json({ error: 'Not found' });
  return false;
}

/** POST /api/subscriptions/test/expire-current — চলতি প্ল্যানের মেয়াদ শেষ করে দেয়। */
subscriptionsRouter.post('/subscriptions/test/expire-current', async (req: AuthRequest, res: Response) => {
  if (!testHooksAllowed(res)) return;
  const workspaceId = getWorkspaceId(req);
  const sub = await expireCurrentSubscriptionForTest(workspaceId);
  if (!sub) {
    res.status(404).json({ error: 'কোনো সাবস্ক্রিপশন পাওয়া যায়নি।' });
    return;
  }
  res.json({ subscription: sub, message: 'পরীক্ষার জন্য মেয়াদ শেষ করা হয়েছে।' });
});

/** POST /api/subscriptions/test/simulate-usage {count} — লেজারে count-টি ব্যবহার লেখে। */
subscriptionsRouter.post('/subscriptions/test/simulate-usage', async (req: AuthRequest, res: Response) => {
  if (!testHooksAllowed(res)) return;
  const workspaceId = getWorkspaceId(req);
  const { count } = (req.body ?? {}) as { count?: number };
  if (typeof count !== 'number' || count < 0) {
    res.status(400).json({ error: 'count (0–10000) দরকার।' });
    return;
  }
  const inserted = await simulateUsageForTest(workspaceId, count);
  const current = await getCurrentSubscription(workspaceId);
  res.json({ inserted, usedReplies: current.usage.usedReplies });
});
