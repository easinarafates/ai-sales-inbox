#!/usr/bin/env node
/**
 * Verification for the reprice to 60% AVERAGE margin (2026-11-11 18:32).
 * Local PGlite API (scratch dir), real Gemini key, test hooks on.
 *
 * User decision: profit 60% on AVERAGE across package + pay-as-you-go
 * (hosting + ads cost money too). At ~9 paisa avg provider cost:
 * package 22 paisa (59%), pay-as-you-go 23 paisa (61%) — average
 * exactly 60%; overage 22 paisa (matches the package). Old prices
 * were 20 / 22 / 20 (and 40 / 50 / 10 before that).
 *
 *  Shop A (pay-as-you-go): signup -> GET /billing packagePricePaisa is
 *    22 -> product -> go-live -> expire trial (test hook) -> one webchat
 *    message -> AI reply -> ledger wallet charge is 23 paisa -> promote
 *    the shop owner to platform owner -> run the owner sweep -> GET
 *    /api/owner/overview shows the deduction (shop paid 23, owner cost
 *    = provider cost, profit = 23 - provider cost).
 *  Shop B (overage): signup -> product -> go-live -> simulate-usage 500
 *    (exhausts the trial's 500 included replies) -> one webchat message
 *    -> AI reply -> ledger wallet charge is 22 paisa.
 *
 * Run from the repo root:  node scripts/verify-reprice-22-23.mjs
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

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const got = await fn();
    if (got) return got;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for: ${label}`);
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
    body: { name: `${tag} Owner`, email: `reprice+${tag}${stamp}@example.com`, password: 'verify1234', workspaceName: `${tag} Shop` },
  });
  if (signup.status !== 201 || !signup.data?.token) throw new Error(`${tag} signup failed: ${signup.status}`);
  const token = signup.data.token;
  const workspaceId = signup.data?.workspace?.id ?? '';
  const scoped = makeApi(`http://localhost:${PORT}`, () => token);
  const product = await scoped('/api/products', {
    method: 'POST',
    body: { name: 'টেস্ট টি-শার্ট', pricePaisa: 50000, stock: 5, description: 'টেস্ট' },
  });
  if (product.status !== 201) throw new Error(`${tag} product failed: ${product.status}`);
  const live = await scoped(`/api/workspaces/${workspaceId}/go-live`, { method: 'POST' });
  if (live.status !== 200) throw new Error(`${tag} go-live failed: ${live.status}`);
  const settings = await scoped('/api/website-chat/settings');
  const publicKey = settings.data?.publicKey ?? '';
  if (!publicKey.startsWith('wk_')) throw new Error(`${tag} no public key`);
  return { token, workspaceId, api: scoped, publicKey };
}

async function oneWebchatReply(shop, tag) {
  const posted = await shop.api('/api/website-chat/message', {
    method: 'POST', auth: false,
    body: { workspaceKey: shop.publicKey, text: '[TEST] টেস্ট টি-শার্টের দাম কত?' },
  });
  if (posted.status !== 201 || !posted.data?.conversationId) throw new Error(`${tag} webchat post failed: ${posted.status}`);
  const conversationId = posted.data.conversationId;
  const replies = await waitFor(async () => {
    const r = await shop.api(`/api/website-chat/messages?key=${encodeURIComponent(shop.publicKey)}&conversationId=${encodeURIComponent(conversationId)}`, { auth: false });
    if (r.status !== 200) return null;
    const out = (r.data?.messages ?? []).filter((m) => m.direction === 'out');
    return out.length >= 1 ? out : null;
  }, 120000, `${tag} AI reply`);
  return replies;
}

const PORT = 4010;

async function main() {
  const stamp = Date.now();
  const run = startApi(PORT, '.pglite-data-reprice23verify');
  process.on('exit', run.stop);
  try {
    const up = await waitForHealth(`http://localhost:${PORT}`);
    check('local API starts (health)', up, up ? '' : run.log().slice(-500));
    if (!up) return;

    // ---- Shop A: pay-as-you-go (trial expired) ----
    const shopA = await setupShop(makeApi(`http://localhost:${PORT}`, () => ''), stamp, 'a');
    check('shop A signup + product + go-live', true);
    const billingA0 = await shopA.api('/api/billing');
    const pkgPrice = billingA0.data?.packagePricePaisa;
    check('GET /billing: packagePricePaisa is 22', billingA0.status === 200 && pkgPrice === 22, `packagePricePaisa=${pkgPrice}`);
    const expA = await shopA.api('/api/subscriptions/test/expire-current', { method: 'POST' });
    check('shop A trial expired (test hook)', expA.status === 200, `status=${expA.status}`);
    const repliesA = await oneWebchatReply(shopA, 'A');
    check('shop A AI reply arrives (pay-as-you-go)', !!repliesA, `reply=${(repliesA[0]?.body ?? '').slice(0, 80)}`);
    const billingA = await shopA.api('/api/billing');
    const rowA = (billingA.data?.usage ?? [])[0] ?? {};
    const walletA = rowA.cost_paisa ?? rowA.costPaisa;
    const providerA = rowA.provider_cost_paisa ?? rowA.providerCostPaisa;
    check('shop A ledger: wallet charge is 23 paisa (pay-as-you-go)', walletA === 23, `cost_paisa=${walletA}`);
    check('shop A ledger: provider cost > 0', typeof providerA === 'number' && providerA > 0, `provider_cost_paisa=${providerA}`);
    check('shop A balance is 5000 - 23 = 4977', billingA.data?.balancePaisa === 4977, `balancePaisa=${billingA.data?.balancePaisa}`);
    // Owner deductions: promote the shop owner, run the sweep, read the feed.
    const setup = await shopA.api('/api/owner/setup', { method: 'POST', body: { email: `reprice+a${stamp}@example.com` } });
    check('shop A owner promoted to platform owner (first-run setup)', setup.status === 200, `status=${setup.status}`);
    const sweep = await shopA.api('/api/owner/wallet/sweep', { method: 'POST' });
    check('owner sweep ran', sweep.status === 200, `status=${sweep.status} deductedRows=${sweep.data?.deductedRows}`);
    const overview = await shopA.api('/api/owner/overview?days=30');
    const ded = (overview.data?.recentDeductions ?? [])[0] ?? {};
    check('owner overview: deduction row exists for the reply', overview.status === 200 && !!ded.id, `rows=${(overview.data?.recentDeductions ?? []).length}`);
    check('owner deduction: shop paid 23 paisa', ded.shopChargePaisa === 23, `shopChargePaisa=${ded.shopChargePaisa}`);
    check('owner deduction: owner cost cut equals the provider cost', ded.ownerCostPaisa === providerA, `ownerCostPaisa=${ded.ownerCostPaisa} provider=${providerA}`);
    check('owner deduction: profit is 23 - provider cost', ded.profitPaisa === 23 - providerA, `profitPaisa=${ded.profitPaisa}`);

    // ---- Shop B: overage (trial included replies exhausted) ----
    const shopB = await setupShop(makeApi(`http://localhost:${PORT}`, () => ''), stamp, 'b');
    check('shop B signup + product + go-live', true);
    const sim = await shopB.api('/api/subscriptions/test/simulate-usage', { method: 'POST', body: { count: 500 } });
    check('shop B simulate-usage 500 (exhausts included replies)', sim.status === 200, `status=${sim.status}`);
    const repliesB = await oneWebchatReply(shopB, 'B');
    check('shop B AI reply arrives (overage)', !!repliesB, `reply=${(repliesB[0]?.body ?? '').slice(0, 80)}`);
    const billingB = await shopB.api('/api/billing');
    const rowB = (billingB.data?.usage ?? []).find((u) => (u.cost_paisa ?? u.costPaisa) > 0) ?? {};
    const walletB = rowB.cost_paisa ?? rowB.costPaisa;
    check('shop B ledger: wallet charge is 22 paisa (overage)', walletB === 22, `cost_paisa=${walletB}`);
  } finally {
    run.stop();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('FAIL  verifier crashed:', err);
  process.exit(1);
});
