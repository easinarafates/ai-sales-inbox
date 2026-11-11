#!/usr/bin/env node
/**
 * Verification for the Billing provider-cost fix (2026-11-11).
 * Local, real Gemini key, local PGlite API (scratch dir).
 *
 * The bug: GET /api/billing returned only cost_paisa (the WALLET
 * charge) per ledger row, so on trial every reply showed "Cost 0
 * paisa" and "Total AI cost" was ৳0 even though the tokens burned
 * real provider cost. The fix returns provider_cost_paisa per row
 * plus all-time aggregates (totalProviderCostPaisa,
 * totalWalletChargedPaisa, usageCount), and the Billing page shows
 * the provider cost as the AI cost with the wallet charge beside it.
 *
 *  1. signup -> product ৳500 -> go-live (practice off, trial active)
 *  2. one webchat message -> AI reply (burns tokens, ledger row)
 *  3. GET /api/billing -> assert the new fields + the numbers:
 *     provider cost > 0, wallet charge 0, balance still ৳50
 *
 * Run from the repo root:  node scripts/verify-billing-provider-cost.mjs
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const results = [];
let token = '';
let workspaceId = '';

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeApi(base) {
  return async function api(pathName, { method = 'GET', body, auth = true, headers = {} } = {}) {
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

function startApi(port, dataDir, extraEnv = {}) {
  const apiProc = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: path.join(ROOT, 'apps/api'),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env, PORT: String(port), DATABASE_URL: `pglite://./${dataDir}`, ...extraEnv },
  });
  let apiLog = '';
  apiProc.stdout.on('data', (d) => { apiLog += d.toString(); });
  apiProc.stderr.on('data', (d) => { apiLog += d.toString(); });
  const stop = () => {
    try { process.kill(-apiProc.pid, 'SIGTERM'); } catch { try { apiProc.kill('SIGTERM'); } catch { /* already gone */ } }
  };
  return { proc: apiProc, stop, log: () => apiLog };
}

async function main() {
  const stamp = Date.now();
  const port = 4008;
  const api = makeApi(`http://localhost:${port}`);
  const run = startApi(port, '.pglite-data-billingverify');
  process.on('exit', run.stop);
  try {
    const up = await waitForHealth(`http://localhost:${port}`);
    check('local API starts (health)', up, up ? '' : run.log().slice(-500));
    if (!up) return;

    const signup = await api('/api/auth/signup', {
      method: 'POST', auth: false,
      body: { name: 'Billing Owner', email: `billingverify+${stamp}@example.com`, password: 'verify1234', workspaceName: 'Billing Shop' },
    });
    check('signup', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
    token = signup.data?.token ?? '';
    workspaceId = signup.data?.workspace?.id ?? '';

    const product = await api('/api/products', {
      method: 'POST',
      body: { name: 'টেস্ট টি-শার্ট', pricePaisa: 50000, stock: 5, description: 'টেস্ট' },
    });
    check('create product ৳500', product.status === 201 && !!product.data?.product?.id, `status=${product.status}`);

    const live = await api(`/api/workspaces/${workspaceId}/go-live`, { method: 'POST' });
    check('go-live (practice mode off)', live.status === 200 && live.data?.workspace?.practice_mode === false, `status=${live.status}`);

    const settings = await api('/api/website-chat/settings');
    const publicKey = settings.data?.publicKey ?? '';
    check('website-chat settings returns public key', settings.status === 200 && publicKey.startsWith('wk_'), `status=${settings.status}`);

    // Burn tokens: one visitor message, wait for the AI reply.
    const posted = await api('/api/website-chat/message', {
      method: 'POST', auth: false,
      body: { workspaceKey: publicKey, text: '[TEST] টেস্ট টি-শার্টের দাম কত?' },
    });
    check('public POST /website-chat/message accepted (201)', posted.status === 201 && !!posted.data?.conversationId, `status=${posted.status}`);
    const conversationId = posted.data?.conversationId ?? '';
    const replies = await waitFor(async () => {
      const r = await api(`/api/website-chat/messages?key=${encodeURIComponent(publicKey)}&conversationId=${encodeURIComponent(conversationId)}`, { auth: false });
      if (r.status !== 200) return null;
      const out = (r.data?.messages ?? []).filter((m) => m.direction === 'out');
      return out.length >= 1 ? out : null;
    }, 120000, 'visitor-visible AI reply').catch((e) => {
      check('visitor-visible AI reply arrives', false, e.message);
      return null;
    });
    if (replies) check('visitor-visible AI reply arrives', true, `reply=${(replies[0]?.body ?? '').slice(0, 120)}`);

    // The billing check: the reply burned tokens, so the provider cost
    // must be visible even though the wallet was charged 0 (trial).
    const billing = await api('/api/billing');
    check('GET /api/billing returns 200', billing.status === 200, `status=${billing.status}`);
    const b = billing.data ?? {};
    const usage = b.usage ?? [];
    check('usage ledger has the AI reply row', usage.length >= 1, `rows=${usage.length}`);
    const row = usage[0] ?? {};
    const providerCost = row.provider_cost_paisa ?? row.providerCostPaisa;
    check('ledger row carries provider_cost_paisa (> 0)', typeof providerCost === 'number' && providerCost > 0, `provider_cost_paisa=${providerCost}`);
    check('ledger row wallet charge is 0 (trial, nothing deducted)', (row.cost_paisa ?? row.costPaisa ?? row.cost) === 0, `cost_paisa=${row.cost_paisa ?? row.costPaisa ?? row.cost}`);
    const rowSum = usage.reduce((s, u) => s + (u.provider_cost_paisa ?? u.providerCostPaisa ?? 0), 0);
    check('totalProviderCostPaisa > 0 and matches the row sum', typeof b.totalProviderCostPaisa === 'number' && b.totalProviderCostPaisa > 0 && b.totalProviderCostPaisa === rowSum, `totalProviderCostPaisa=${b.totalProviderCostPaisa} rowSum=${rowSum}`);
    check('totalWalletChargedPaisa is 0 (trial)', b.totalWalletChargedPaisa === 0, `totalWalletChargedPaisa=${b.totalWalletChargedPaisa}`);
    check('usageCount counts the reply', typeof b.usageCount === 'number' && b.usageCount >= 1, `usageCount=${b.usageCount}`);
    check('wallet balance still ৳50 (5000 paisa) — nothing deducted', b.balancePaisa === 5000, `balancePaisa=${b.balancePaisa}`);
    // Recompute the average the page will show, from the same figures.
    const avg = b.usageCount > 0 ? b.totalProviderCostPaisa / b.usageCount : 0;
    console.log(`\nBilling for the test shop: ${b.usageCount} reply, provider cost ${b.totalProviderCostPaisa} paisa (৳${(b.totalProviderCostPaisa / 100).toFixed(2)}), wallet charged ${b.totalWalletChargedPaisa} paisa, average ${avg.toFixed(2)} paisa/reply, balance ৳${(b.balancePaisa / 100).toFixed(2)}.`);
  } finally {
    run.stop();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed.`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('verifier crashed:', e); process.exit(1); });
