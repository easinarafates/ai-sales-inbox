#!/usr/bin/env node
/**
 * Verification for the checkout flow (2026-11-11 evening).
 * Local PGlite API (scratch dir). No real money, no real Gemini calls
 * needed — the checkout path is manual payment + TrxID.
 *
 * User decision: Plans/Billing buttons must WORK — they open a new
 * checkout page (pick model -> pick package -> amount auto-filled ->
 * bKash/Nagad/Rocket/bank numbers -> TrxID submit -> shows in the
 * owner account). On approval the product is DELIVERED (subscribe /
 * buy replies / credit wallet), not just wallet-credited. Model names
 * are hidden from customers everywhere (AI Providers is platform-owner
 * only). Per-reply prices (22p/23p) are no longer shown to customers.
 *
 *  Shop A (promoted to platform owner): adds bkash + rocket numbers.
 *  Shop B (customer): payment-numbers shows the full numbers; package
 *    request (500 replies, ৳110) -> owner approves -> 500 reply credits,
 *    wallet back to ৳50; schedule request (monthly-bdt) -> approve ->
 *    schedule active; PAYG request (৳100) -> approve -> wallet +৳100;
 *    wrong-amount package request -> 400; duplicate TrxID -> 400.
 *  AI Providers: 403 for shop B (non-owner), 200 for shop A (owner).
 *
 * Run from the repo root:  node scripts/verify-checkout.mjs
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeApi(base, getToken) {
  return async function api(pathName, { method = 'GET', body, auth = true, headers = {} } = {}) {
    const token = getToken();
    const res = await fetch(`${base}${pathName}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data, text };
  };
}

async function waitForHealth(base, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  return false;
}

function startApi(port, dataDir) {
  const apiProc = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: path.join(ROOT, 'apps/api'),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env, PORT: String(port), DATABASE_URL: `pglite://./${dataDir}`, ALLOW_SUBSCRIPTION_TEST_HOOKS: 'true' },
  });
  let apiLog = '';
  apiProc.stdout.on('data', (d) => { apiLog += d.toString(); });
  apiProc.stderr.on('data', (d) => { apiLog += d.toString(); });
  const stop = () => {
    try { process.kill(-apiProc.pid, 'SIGTERM'); } catch { try { apiProc.kill('SIGTERM'); } catch { /* already gone */ } }
  };
  return { proc: apiProc, stop, log: () => apiLog };
}

async function setupShop(api, stamp, tag) {
  const signup = await api('/api/auth/signup', {
    method: 'POST', auth: false,
    body: { name: `${tag} Owner`, email: `checkout+${tag}${stamp}@example.com`, password: 'verify1234', workspaceName: `${tag} Shop` },
  });
  if (signup.status !== 201 || !signup.data?.token) throw new Error(`${tag} signup failed: ${signup.status} ${signup.text?.slice(0, 200)}`);
  const token = signup.data.token;
  const workspaceId = signup.data?.workspace?.id ?? '';
  const scoped = makeApi(`http://localhost:${PORT}`, () => token);
  const live = await scoped(`/api/workspaces/${workspaceId}/go-live`, { method: 'POST' });
  if (live.status !== 200) throw new Error(`${tag} go-live failed: ${live.status}`);
  return { token, workspaceId, api: scoped, email: `checkout+${tag}${stamp}@example.com` };
}

const PORT = 4011;

async function main() {
  const stamp = Date.now();
  const run = startApi(PORT, '.pglite-data-checkoutverify');
  process.on('exit', run.stop);
  try {
    const up = await waitForHealth(`http://localhost:${PORT}`);
    check('local API starts (health)', up, up ? '' : run.log().slice(-500));
    if (!up) return;

    const base = makeApi(`http://localhost:${PORT}`, () => '');
    const shopA = await setupShop(base, stamp, 'a');
    const shopB = await setupShop(base, stamp, 'b');
    check('shops A + B signup + go-live', true);

    // AI Providers gate: neither shop is platform owner yet.
    const provB0 = await shopB.api('/api/ai-providers');
    check('GET /api/ai-providers: 403 for non-owner shop', provB0.status === 403, `status=${provB0.status}`);

    // Promote A to platform owner; A sets the payment numbers.
    const setup = await shopA.api('/api/owner/setup', { method: 'POST', body: { email: shopA.email } });
    check('shop A promoted to platform owner', setup.status === 200, `status=${setup.status}`);
    const bk = await shopA.api('/api/owner/bank-accounts', { method: 'POST', body: { bankName: 'bKash', accountHolder: 'Test Owner', accountNumber: '01915181309', type: 'bkash', isPrimary: true } });
    check('owner adds bKash number', bk.status === 201, `status=${bk.status}`);
    const rk = await shopA.api('/api/owner/bank-accounts', { method: 'POST', body: { bankName: 'Rocket', accountHolder: 'Test Owner', accountNumber: '01700000000', type: 'rocket', isPrimary: true } });
    check('owner adds Rocket number', rk.status === 201, `status=${rk.status} ${rk.text?.slice(0, 120)}`);

    // Checkout: B sees the full payment numbers.
    const nums = await shopB.api('/api/billing/payment-numbers');
    const bkNum = nums.data?.numbers?.bkash?.number;
    const rkNum = nums.data?.numbers?.rocket?.number;
    check('payment-numbers: bKash full number visible to shop', nums.status === 200 && bkNum === '01915181309', `bkash=${bkNum}`);
    check('payment-numbers: Rocket full number visible to shop', rkNum === '01700000000', `rocket=${rkNum}`);

    // Package request: 500 replies x 22 = 11000 paisa, correct amount.
    const pkg = await shopB.api('/api/billing/topup/request', {
      method: 'POST',
      body: { amountPaisa: 11000, method: 'bkash', transactionId: `TEST-PKG-${stamp}`, purpose: { kind: 'package', replies: 500 } },
    });
    check('package checkout request: 201 + purpose stored', pkg.status === 201 && pkg.data?.topupRequest?.purpose?.kind === 'package', `status=${pkg.status} purpose=${JSON.stringify(pkg.data?.topupRequest?.purpose)}`);
    const pkgId = pkg.data?.topupRequest?.id;

    // Wrong amount for the same package must be refused.
    const wrong = await shopB.api('/api/billing/topup/request', {
      method: 'POST',
      body: { amountPaisa: 10000, method: 'bkash', transactionId: `TEST-WRONG-${stamp}`, purpose: { kind: 'package', replies: 500 } },
    });
    check('package request with wrong amount: 400', wrong.status === 400, `status=${wrong.status}`);

    // Schedule request: monthly-bdt at its plan price.
    const sched = await shopB.api('/api/subscriptions/schedule');
    const monthlyBdt = (sched.data?.plans ?? []).find((p) => p.slug === 'schedule-monthly-bdt');
    const schedPrice = Number(monthlyBdt?.pricePaisa ?? 0);
    check('schedule monthly-bdt plan exists with price', sched.status === 200 && schedPrice > 0, `pricePaisa=${schedPrice}`);
    const sch = await shopB.api('/api/billing/topup/request', {
      method: 'POST',
      body: { amountPaisa: schedPrice, method: 'rocket', transactionId: `TEST-SCH-${stamp}`, purpose: { kind: 'schedule', slug: 'schedule-monthly-bdt' } },
    });
    check('schedule checkout request: 201 + purpose stored', sch.status === 201 && sch.data?.topupRequest?.purpose?.slug === 'schedule-monthly-bdt', `status=${sch.status}`);
    const schId = sch.data?.topupRequest?.id;

    // Owner sees both in the pending-payments queue (with purpose).
    const queue = await shopA.api('/api/owner/payments?status=pending');
    const queued = queue.data?.payments ?? [];
    check('owner payments queue lists both pending requests', queue.status === 200 && queued.length >= 2, `count=${queued.length}`);
    check('owner queue: package row carries its purpose', queued.some((p) => p.id === pkgId && p.purpose?.kind === 'package'), `rows=${queued.map((p) => p.purpose?.kind).join(',')}`);

    // Approve the package: delivery adds 500 reply credits.
    const apprPkg = await shopA.api(`/api/billing/topup/${pkgId}/approve`, { method: 'POST', body: { workspaceId: shopB.workspaceId } });
    check('owner approves package: 200 + delivery ok', apprPkg.status === 200 && apprPkg.data?.delivery?.ok === true, `status=${apprPkg.status} delivery=${JSON.stringify(apprPkg.data?.delivery)}`);
    const billB1 = await shopB.api('/api/billing');
    const credits = billB1.data?.replyCredits ?? billB1.data?.reply_credits;
    const balance1 = billB1.data?.balancePaisa;
    check('after package approval: reply credits = 500', credits === 500, `replyCredits=${credits}`);
    check('after package approval: wallet back to 5000 (11000 in, 11000 out)', balance1 === 5000, `balancePaisa=${balance1}`);

    // Approve the schedule: subscription becomes active.
    const apprSch = await shopA.api(`/api/billing/topup/${schId}/approve`, { method: 'POST', body: { workspaceId: shopB.workspaceId } });
    check('owner approves schedule: 200 + delivery ok', apprSch.status === 200 && apprSch.data?.delivery?.ok === true, `status=${apprSch.status} delivery=${JSON.stringify(apprSch.data?.delivery)}`);
    const schedB = await shopB.api('/api/subscriptions/schedule');
    const subB = schedB.data?.subscription;
    check('after schedule approval: subscription active', subB?.status === 'active', `status=${subB?.status} plan=${subB?.planSlug ?? subB?.plan_slug}`);

    // PAYG request: approve credits the wallet only.
    const payg = await shopB.api('/api/billing/topup/request', {
      method: 'POST',
      body: { amountPaisa: 10000, method: 'bkash', transactionId: `TEST-PAYG-${stamp}`, purpose: { kind: 'payg' } },
    });
    check('PAYG checkout request: 201', payg.status === 201, `status=${payg.status}`);
    const paygId = payg.data?.topupRequest?.id;
    const apprPayg = await shopA.api(`/api/billing/topup/${paygId}/approve`, { method: 'POST', body: { workspaceId: shopB.workspaceId } });
    check('owner approves PAYG: 200, no product delivery', apprPayg.status === 200 && apprPayg.data?.delivery === null, `status=${apprPayg.status}`);
    const billB2 = await shopB.api('/api/billing');
    check('after PAYG approval: wallet = 15000', billB2.data?.balancePaisa === 15000, `balancePaisa=${billB2.data?.balancePaisa}`);

    // Duplicate TrxID must be refused (already used by an approved request).
    const dup = await shopB.api('/api/billing/topup/request', {
      method: 'POST',
      body: { amountPaisa: 11000, method: 'bkash', transactionId: `TEST-PKG-${stamp}`, purpose: { kind: 'package', replies: 500 } },
    });
    check('duplicate TrxID request: 400', dup.status === 400, `status=${dup.status}`);

    // AI Providers gate after promotion: owner 200, customer still 403.
    const provA = await shopA.api('/api/ai-providers');
    check('GET /api/ai-providers: 200 for platform owner', provA.status === 200, `status=${provA.status}`);
    const provB1 = await shopB.api('/api/ai-providers');
    check('GET /api/ai-providers: still 403 for shop customer', provB1.status === 403, `status=${provB1.status}`);

    const fails = results.filter((r) => !r.ok);
    console.log(`\n${results.length - fails.length}/${results.length} checks passed.`);
    if (fails.length > 0) process.exitCode = 1;
  } catch (err) {
    console.error('FAIL  verifier crashed:', err);
    console.log(run.log().slice(-2000));
    process.exitCode = 1;
  } finally {
    run.stop();
  }
}

main();
