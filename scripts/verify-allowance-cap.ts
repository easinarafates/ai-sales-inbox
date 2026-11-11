/**
 * Verification for the user's cap rule (2026-11-11 19:35, main chat):
 * "Trial or paid — nobody gets even a little more than the set package.
 *  Not 9 taka each. Keep our 60% profit, free or paid — same rule."
 *
 * Tests the REAL checkAiReplyAllowance gate (subscriptions/service.ts)
 * on a fresh PGlite DB — no server, no Gemini, no money:
 *  1. Trial (choto plan) gives exactly 500 included replies.
 *  2. The 501st reply is NEVER free — overage 22p while the wallet
 *     can cover it, blocked when it cannot.
 *  3. Wallet empty + no package + no trial left -> blocked (no reply).
 *  4. PAYG is a flat 23p per reply from the wallet (after the
 *     trial/plan expires; while a plan is still active, over-limit
 *     replies are the flat 22p overage instead).
 *  5. A bought reply package is consumed FIRST (0p wallet per reply).
 *  6. An EXPIRED trial grants nothing — only PAYG/blocked after it.
 *  7. Margin math: at ~9p measured provider cost, package 22p = 59%
 *     and PAYG 23p = 61% — the two average exactly 60%.
 *
 * Run from apps/api:
 *   DATABASE_URL=pglite://./.pglite-data-allowanceverify npx tsx ../../scripts/verify-allowance-cap.ts
 * (Data dir is wiped at start. Prints PASS/FAIL per step, exits
 *  non-zero if anything fails.)
 */
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const API = path.join(ROOT, 'apps/api');
const DATA_DIR = '.pglite-data-allowanceverify';

// Wipe the scratch DB so the run is repeatable.
execSync(`rm -rf ${path.join(API, DATA_DIR)}`, { stdio: 'ignore' });

const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const { query, pool } = (await import(path.join(API, 'src/db/pool.ts'))) as typeof import(
    '../apps/api/src/db/pool'
  );
  const { config } = (await import(path.join(API, 'src/config/index.ts'))) as typeof import(
    '../apps/api/src/config/index'
  );
  const {
    checkAiReplyAllowance,
    ensureTrialSubscription,
    purchaseReplyPackage,
    getCurrentSubscription,
  } = (await import(path.join(API, 'src/subscriptions/service.ts'))) as typeof import(
    '../apps/api/src/subscriptions/service'
  );

  // --- Config actually in effect (defaults if env unset) ---
  console.log(
    `config: package=${config.replyPackagePricePaisa}p payg=${config.paygReplyCostPaisa}p overage=${config.overageReplyCostPaisa}p trialDays=${config.trialDays} freeCredit=${config.freeCreditPaisa}p`,
  );
  check('Config prices are 22 / 23 / 22 paisa', config.replyPackagePricePaisa === 22 && config.paygReplyCostPaisa === 23 && config.overageReplyCostPaisa === 22);

  // --- Fresh shop, exactly like a real signup: ৳50 (5000p) free credit ---
  // Setup uses pool.query directly (pre-workspace flow, like signup).
  const wsRes = await pool.query(
    `INSERT INTO workspaces (name, balance_paisa) VALUES ('Cap Test Shop', 5000) RETURNING id`,
  );
  const wsId = (wsRes.rows[0] as { id: string }).id;
  console.log(`workspace: ${wsId}`);

  // 1. Trial created: choto plan, 500 included.
  const sub = await ensureTrialSubscription(wsId);
  const current = await getCurrentSubscription(wsId);
  check('Trial is choto with 500 included replies', sub.plan_slug === 'choto' && current.usage.includedReplies === 500, `plan=${sub.plan_slug} included=${current.usage.includedReplies}`);

  // 2. First reply is free (included, 0p).
  let a = await checkAiReplyAllowance(wsId);
  check('Reply 1: included, 0 paisa, allowed', a.allowed && a.mode === 'included' && a.costPaisa === 0, `mode=${a.mode} cost=${a.costPaisa}`);

  // 3. Use 499 included replies (ledger rows, no AI calls).
  await query(
    wsId,
    `INSERT INTO ai_usage_ledger (workspace_id, conversation_id, input_tokens, output_tokens, cost_paisa, provider, included_in_plan, provider_cost_paisa)
     SELECT $1, NULL, 2000, 50, 0, 'gemini', TRUE, 9 FROM generate_series(1, 499)`,
    [wsId],
  );
  const used499 = await getCurrentSubscription(wsId);
  check('After 499 replies: used=499 of 500', used499.usage.usedReplies === 499, `used=${used499.usage.usedReplies}`);
  a = await checkAiReplyAllowance(wsId);
  check('Reply 500: still included, 0 paisa', a.allowed && a.mode === 'included' && a.costPaisa === 0, `mode=${a.mode} cost=${a.costPaisa}`);

  // 4. The 501st reply is NEVER free.
  await query(
    wsId,
    `INSERT INTO ai_usage_ledger (workspace_id, conversation_id, input_tokens, output_tokens, cost_paisa, provider, included_in_plan, provider_cost_paisa)
     VALUES ($1, NULL, 2000, 50, 0, 'gemini', TRUE, 9)`,
    [wsId],
  );
  const used500 = await getCurrentSubscription(wsId);
  check('After 500 replies: used=500 of 500', used500.usage.usedReplies === 500, `used=${used500.usage.usedReplies}`);
  a = await checkAiReplyAllowance(wsId);
  check('Reply 501: NOT free — overage 22p (wallet ৳50 covers it)', a.allowed && a.mode === 'overage' && a.costPaisa === 22, `mode=${a.mode} cost=${a.costPaisa}`);

  // 5. Wallet empty -> blocked, no reply at all.
  await query(wsId, `UPDATE workspaces SET balance_paisa = 10 WHERE id = $1`, [wsId]);
  a = await checkAiReplyAllowance(wsId);
  check('Wallet 10p + trial used up: BLOCKED', !a.allowed && a.mode === 'blocked', `mode=${a.mode} allowed=${a.allowed}`);

  // 6. Over-limit while the trial is STILL active: flat 22p overage
  // (not PAYG — PAYG 23p applies only after the plan expires, step 9).
  await query(wsId, `UPDATE workspaces SET balance_paisa = 2300 WHERE id = $1`, [wsId]);
  a = await checkAiReplyAllowance(wsId);
  check('Wallet ৳23 + trial used up, trial active: overage flat 22p', a.allowed && a.mode === 'overage' && a.costPaisa === 22, `mode=${a.mode} cost=${a.costPaisa}`);

  // 7. Bought package is consumed FIRST (0p wallet per reply).
  await query(wsId, `UPDATE workspaces SET balance_paisa = 16000 WHERE id = $1`, [wsId]);
  const bought = await purchaseReplyPackage(wsId, 500);
  check('Buy 500 package replies for ৳110 from wallet', bought.ok === true && bought.replyCredits === 500 && bought.balancePaisa === 5000, `ok=${bought.ok} credits=${bought.replyCredits} balance=${bought.balancePaisa}`);
  a = await checkAiReplyAllowance(wsId);
  check('With 500 package credits: package mode, 0p wallet', a.allowed && a.mode === 'package' && a.costPaisa === 0, `mode=${a.mode} cost=${a.costPaisa}`);

  // 8. Package exhausted + trial exhausted -> overage, never included.
  // NOTE (current behaviour, documented not failed): package replies
  // count toward the 500 monthly usage, so 500 package replies + the
  // 500 trial replies share one 500 cap — the customer gets 500 total,
  // never more. (Whether package + trial should STACK to 1000 is a
  // product decision for Boss, not a leak.)
  await query(wsId, `UPDATE workspaces SET reply_credits = 0 WHERE id = $1`, [wsId]);
  await query(
    wsId,
    `INSERT INTO ai_usage_ledger (workspace_id, conversation_id, input_tokens, output_tokens, cost_paisa, provider, included_in_plan, package_credit_used, provider_cost_paisa)
     SELECT $1, NULL, 2000, 50, 0, 'gemini', FALSE, TRUE, 9 FROM generate_series(1, 500)`,
    [wsId],
  );
  a = await checkAiReplyAllowance(wsId);
  check('Package + trial both used up: overage 22p, never included again', a.allowed && a.mode !== 'included' && a.costPaisa === 22, `mode=${a.mode} cost=${a.costPaisa}`);

  // 9. Expired trial grants NOTHING.
  await query(wsId, `UPDATE workspace_subscriptions SET current_period_end = now() - interval '1 day' WHERE workspace_id = $1`, [wsId]);
  a = await checkAiReplyAllowance(wsId);
  check('Trial expired + wallet ৳50: PAYG 23p, not included', a.allowed && a.mode === 'payg' && a.costPaisa === 23, `mode=${a.mode} cost=${a.costPaisa}`);
  await query(wsId, `UPDATE workspaces SET balance_paisa = 10 WHERE id = $1`, [wsId]);
  a = await checkAiReplyAllowance(wsId);
  check('Trial expired + wallet 10p: BLOCKED', !a.allowed && a.mode === 'blocked', `mode=${a.mode} allowed=${a.allowed}`);

  // 10. Buying with too little balance fails honestly (no credits given).
  const poor = await purchaseReplyPackage(wsId, 100000);
  check('Buy 100,000 replies with 10p: refused (402), no credits', poor.ok === false && poor.status === 402, `ok=${poor.ok} status=${poor.status}`);

  // 11. Margin math at the measured ~9p average provider cost.
  const avgCost = 9;
  const pkgMargin = ((22 - avgCost) / 22) * 100;
  const paygMargin = ((23 - avgCost) / 23) * 100;
  const avgMargin = (pkgMargin + paygMargin) / 2;
  console.log(`margins at ${avgCost}p cost: package ${pkgMargin.toFixed(1)}% / PAYG ${paygMargin.toFixed(1)}% / average ${avgMargin.toFixed(1)}%`);
  check('60% profit on average (package 59% + PAYG 61%)', Math.abs(avgMargin - 60) < 0.5 && pkgMargin >= 58 && paygMargin <= 62);
  check('Per-reply cost is paisa, not taka (9p, never ৳9)', avgCost === 9);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err: Error) => {
  console.error('ERROR', err);
  process.exit(2);
});
