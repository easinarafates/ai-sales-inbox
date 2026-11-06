#!/usr/bin/env node
/**
 * Verification for the Owner Panel (local, no Docker, no money, no live
 * payment gateway). Starts the API itself (tsx, PGlite) on :4002, runs real
 * HTTP checks for every owner endpoint, then stops the API. Run from the
 * repo root:
 *   node scripts/verify-owner-panel.mjs
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 *
 * Coverage: owner-only access (401 no token, 403 non-owner, 200 owner,
 * bootstrap setup + second-owner blocked), dashboard totals + trend,
 * shops list/detail + suspend (login blocked) + activate, bank accounts
 * CRUD + masking (full number never returned) + verify-number, expenses
 * record + monthly totals by category, API cost breakdown from the seeded
 * ledger (per provider + per shop, nothing invented), deposit
 * request→approve (double-approve 409) + reject, auto-deduction sweep
 * (deducts once, no double deduction, shop wallet untouched), low-balance
 * warning + threshold, card rules (full number/CVV rejected, brand + last
 * 4 only, delete blocked while a pending deposit references the card).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Isolated API for this verifier: its own PGlite data folder + own port, so
// it never contends with another worker's API on the shared ./​.pglite-data
// (PGlite allows only ONE process per data folder) or on :4000.
const API_PORT = process.env.VERIFY_API_PORT ?? '4002';
const API = process.env.API_URL ?? `http://localhost:${API_PORT}`;
const results = [];
let ownerToken = '';
let shopToken = '';
let ownerWorkspaceId = '';
let shopWorkspaceId = '';
let ownerEmail = '';
let shopEmail = '';

// Fixed 64-hex test key (32 bytes) so bank-account encryption works in the
// isolated run. Test-only; it never touches apps/api/.env.
const TEST_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function api(path, { method = 'GET', body, token = ownerToken } = {}) {
  // Connection: close + a hard timeout: Node's fetch reuses keep-alive
  // connections, and a request sent on a pooled connection the server has
  // just closed hangs forever (no default timeout). Fresh connection per
  // request is slower but cannot stall the whole run.
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Connection: 'close',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, text };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(timeoutMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${API}/api/health`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(1000);
  }
  return false;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function prevMonth() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth(); // 0-based; this month - 1
  const prev = new Date(Date.UTC(y, m - 1, 1));
  return {
    month: `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`,
    date: `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}-15`,
  };
}

async function main() {
  // Fresh data folder every run: exact-count checks (2 shops, exact
  // balances) must not see leftovers from an earlier run or a debug session.
  await fs.rm(path.join(ROOT, 'apps/api/.pglite-data-owner'), { recursive: true, force: true });
  // Start the API (tsx + PGlite, loads schema + migrations incl. 11).
  // Detached process group so stopping kills the whole npm/tsx tree.
  const apiProc = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: path.join(ROOT, 'apps/api'),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: {
      ...process.env,
      PORT: API_PORT,
      DATABASE_URL: 'pglite://./.pglite-data-owner',
      ALLOW_OWNER_TEST_HOOKS: 'true',
      TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    },
  });
  let apiLog = '';
  apiProc.stdout.on('data', (d) => { apiLog += d.toString(); });
  apiProc.stderr.on('data', (d) => { apiLog += d.toString(); });
  const stopApi = () => {
    try { process.kill(-apiProc.pid, 'SIGTERM'); } catch { try { apiProc.kill('SIGTERM'); } catch { /* already gone */ } }
    // If the tsx tree ignores SIGTERM, force it — and close the pipes so
    // this script's own event loop can exit afterwards.
    setTimeout(() => {
      try { process.kill(-apiProc.pid, 'SIGKILL'); } catch { try { apiProc.kill('SIGKILL'); } catch { /* already gone */ } }
      try { apiProc.stdout?.destroy(); } catch { /* already closed */ }
      try { apiProc.stderr?.destroy(); } catch { /* already closed */ }
    }, 3000).unref();
  };
  process.on('exit', stopApi);

  try {
    const up = await waitForHealth();
    check('API starts (health)', up, up ? '' : apiLog.slice(-500));
    if (!up) return;

    const stamp = Date.now();
    ownerEmail = `owner+${stamp}@example.com`;
    shopEmail = `shop+${stamp}@example.com`;

    // --- 0. Owner-only access ------------------------------------------------
    const noAuth = await api('/api/owner/overview', { token: '' });
    check('owner overview without token → 401', noAuth.status === 401, `status=${noAuth.status}`);

    const ownerSignup = await api('/api/auth/signup', {
      method: 'POST', token: '',
      body: { name: 'Arafat Owner', email: ownerEmail, password: 'verify1234', workspaceName: 'Owner Shop' },
    });
    check('owner signup', ownerSignup.status === 201 && !!ownerSignup.data?.token, `status=${ownerSignup.status}`);
    ownerToken = ownerSignup.data?.token ?? '';
    ownerWorkspaceId = ownerSignup.data?.workspace?.id ?? '';

    const shopSignup = await api('/api/auth/signup', {
      method: 'POST', token: '',
      body: { name: 'Shop Owner', email: shopEmail, password: 'verify1234', workspaceName: 'Second Shop' },
    });
    check('shop signup', shopSignup.status === 201 && !!shopSignup.data?.token, `status=${shopSignup.status}`);
    shopToken = shopSignup.data?.token ?? '';
    shopWorkspaceId = shopSignup.data?.workspace?.id ?? '';

    const nonOwner = await api('/api/owner/overview', { token: shopToken });
    check('owner overview as non-owner → 403', nonOwner.status === 403, `status=${nonOwner.status}`);
    const nonOwnerMe = await api('/api/owner/me', { token: shopToken });
    check('owner/me as non-owner → isOwner false', nonOwnerMe.status === 200 && nonOwnerMe.data?.isOwner === false, `isOwner=${nonOwnerMe.data?.isOwner}`);

    const setup = await api('/api/owner/setup', { method: 'POST', token: '', body: { email: ownerEmail } });
    check('owner bootstrap setup (first owner)', setup.status === 200 && setup.data?.owner?.email === ownerEmail, `status=${setup.status}`);
    const setupAgain = await api('/api/owner/setup', { method: 'POST', token: '', body: { email: shopEmail } });
    check('second owner bootstrap blocked', setupAgain.status === 403, `status=${setupAgain.status}`);
    const ownerMe = await api('/api/owner/me');
    check('owner/me as owner → isOwner true', ownerMe.status === 200 && ownerMe.data?.isOwner === true, `isOwner=${ownerMe.data?.isOwner}`);

    // --- 1. Dashboard totals --------------------------------------------------
    const ov = await api('/api/owner/overview');
    check('overview 200 for owner', ov.status === 200, `status=${ov.status}`);
    check('overview shops total 2, active 2', ov.data?.shops?.total === 2 && ov.data?.shops?.active === 2, `total=${ov.data?.shops?.total}, active=${ov.data?.shops?.active}`);
    check('overview subscriptions/revenue/api spend start at 0', ov.data?.activeSubscriptions === 0 && ov.data?.revenueThisMonthPaisa === 0 && ov.data?.apiSpendTotalPaisa === 0, `subs=${ov.data?.activeSubscriptions}, rev=${ov.data?.revenueThisMonthPaisa}, api=${ov.data?.apiSpendTotalPaisa}`);
    check('overview trend is 30 days', Array.isArray(ov.data?.trend) && ov.data.trend.length === 30, `days=${ov.data?.trend?.length}`);
    check('overview wallet starts ৳0 with ৳1000 threshold, low-balance true', ov.data?.ownerWallet?.balancePaisa === 0 && ov.data?.ownerWallet?.lowBalanceThresholdPaisa === 100000 && ov.data?.ownerWallet?.lowBalance === true, `balance=${ov.data?.ownerWallet?.balancePaisa}, threshold=${ov.data?.ownerWallet?.lowBalanceThresholdPaisa}`);
    const ov7 = await api('/api/owner/overview?days=7');
    check('overview ?days=7 trend is 7 days', Array.isArray(ov7.data?.trend) && ov7.data.trend.length === 7, `days=${ov7.data?.trend?.length}`);
    const ovBad = await api('/api/owner/overview?days=99');
    check('overview bad days falls back to 30', Array.isArray(ovBad.data?.trend) && ovBad.data.trend.length === 30, `days=${ovBad.data?.trend?.length}`);

    // --- 2. Account management (shops) ----------------------------------------
    const shops = await api('/api/owner/shops');
    check('shops list has both shops', (shops.data?.shops ?? []).length === 2, `count=${(shops.data?.shops ?? []).length}`);
    const shopB = (shops.data?.shops ?? []).find((s) => s.id === shopWorkspaceId);
    check('shops list shows owner email + joined date', !!shopB && shopB.ownerEmail === shopEmail && !!shopB.joinedAt, `email=${shopB?.ownerEmail}`);
    const detail = await api(`/api/owner/shops/${shopWorkspaceId}`);
    check('shop detail 200 with zero totals', detail.status === 200 && detail.data?.totals?.orders === 0 && detail.data?.totals?.aiReplies === 0, `status=${detail.status}`);
    const detail404 = await api('/api/owner/shops/00000000-0000-0000-0000-000000000000');
    check('shop detail 404 for unknown id', detail404.status === 404, `status=${detail404.status}`);

    const susp = await api(`/api/owner/shops/${shopWorkspaceId}/suspend`, { method: 'POST' });
    check('suspend shop', susp.status === 200 && susp.data?.shop?.suspended === true, `suspended=${susp.data?.shop?.suspended}`);
    const loginBlocked = await api('/api/auth/login', {
      method: 'POST', token: '',
      body: { email: shopEmail, password: 'verify1234' },
    });
    check('suspended shop user cannot log in (403)', loginBlocked.status === 403, `status=${loginBlocked.status}`);
    const act = await api(`/api/owner/shops/${shopWorkspaceId}/activate`, { method: 'POST' });
    check('activate shop', act.status === 200 && act.data?.shop?.suspended === false, `suspended=${act.data?.shop?.suspended}`);
    const loginOk = await api('/api/auth/login', {
      method: 'POST', token: '',
      body: { email: shopEmail, password: 'verify1234' },
    });
    check('re-activated shop user can log in again', loginOk.status === 200 && !!loginOk.data?.token, `status=${loginOk.status}`);
    shopToken = loginOk.data?.token ?? shopToken;
    const susp404 = await api('/api/owner/shops/00000000-0000-0000-0000-000000000000/suspend', { method: 'POST' });
    check('suspend 404 for unknown shop', susp404.status === 404, `status=${susp404.status}`);

    // --- 3. Bank accounts CRUD + masking ---------------------------------------
    const bkash = await api('/api/owner/bank-accounts', {
      method: 'POST',
      body: { bankName: 'bKash Personal', accountHolder: 'Arafat', accountNumber: '01712345678', type: 'bkash', isPrimary: true },
    });
    const bkashId = bkash.data?.bankAccount?.id ?? '';
    const bkashJson = JSON.stringify(bkash.data ?? {});
    check('bank account create (bKash, primary)', bkash.status === 201 && !!bkashId && bkash.data?.bankAccount?.accountNumberMasked === '••••5678', `status=${bkash.status}, masked=${bkash.data?.bankAccount?.accountNumberMasked}`);
    check('bank account response never contains the full number', !bkashJson.includes('01712345678'), 'full number leaked in response');
    const bank = await api('/api/owner/bank-accounts', {
      method: 'POST',
      body: { bankName: 'Dutch-Bangla Bank', accountHolder: 'Arafat', accountNumber: '123456789012', branch: 'Mirpur', type: 'bank', isPrimary: true },
    });
    const bankId = bank.data?.bankAccount?.id ?? '';
    check('bank account create (bank, primary)', bank.status === 201 && !!bankId && bank.data?.bankAccount?.accountNumberMasked === '••••9012', `masked=${bank.data?.bankAccount?.accountNumberMasked}`);
    const bankList = await api('/api/owner/bank-accounts');
    const primaries = (bankList.data?.bankAccounts ?? []).filter((a) => a.isPrimary);
    check('only one primary account (new primary wins)', (bankList.data?.bankAccounts ?? []).length === 2 && primaries.length === 1 && primaries[0]?.id === bankId, `count=${(bankList.data?.bankAccounts ?? []).length}, primaries=${primaries.length}`);
    check('bank list responses are masked only', !JSON.stringify(bankList.data ?? {}).includes('123456789012') && !JSON.stringify(bankList.data ?? {}).includes('01712345678'), 'full number leaked in list');
    const verifyNum = await api(`/api/owner/bank-accounts/${bankId}/verify-number`);
    check('verify-number decrypts + returns masked only', verifyNum.status === 200 && verifyNum.data?.ok === true && verifyNum.data?.masked === '••••9012', `ok=${verifyNum.data?.ok}, masked=${verifyNum.data?.masked}`);
    const patchBank = await api(`/api/owner/bank-accounts/${bankId}`, { method: 'PATCH', body: { branch: 'Dhanmondi' } });
    check('bank account update (branch)', patchBank.status === 200 && patchBank.data?.bankAccount?.branch === 'Dhanmondi', `branch=${patchBank.data?.bankAccount?.branch}`);
    const badType = await api('/api/owner/bank-accounts', {
      method: 'POST',
      body: { bankName: 'X', accountHolder: 'Arafat', accountNumber: '1234567890', type: 'paypal' },
    });
    check('bank account rejects bad type', badType.status === 400, `status=${badType.status}`);
    const shortNum = await api('/api/owner/bank-accounts', {
      method: 'POST',
      body: { bankName: 'X', accountHolder: 'Arafat', accountNumber: '12345', type: 'bank' },
    });
    check('bank account rejects short number', shortNum.status === 400, `status=${shortNum.status}`);
    const delBank = await api(`/api/owner/bank-accounts/${bkashId}`, { method: 'DELETE' });
    const bankList2 = await api('/api/owner/bank-accounts');
    check('bank account delete', delBank.status === 200 && (bankList2.data?.bankAccounts ?? []).length === 1, `count=${(bankList2.data?.bankAccounts ?? []).length}`);
    const delBank404 = await api('/api/owner/bank-accounts/00000000-0000-0000-0000-000000000000', { method: 'DELETE' });
    check('bank account delete 404 for unknown id', delBank404.status === 404, `status=${delBank404.status}`);

    // --- 4. Expenses ------------------------------------------------------------
    const today = todayIso();
    const prev = prevMonth();
    const ex1 = await api('/api/owner/expenses', { method: 'POST', body: { date: today, category: 'hosting', amountPaisa: 65000, note: 'VPS' } });
    const ex1Id = ex1.data?.expense?.id ?? '';
    const ex2 = await api('/api/owner/expenses', { method: 'POST', body: { date: today, category: 'ai', amountPaisa: 12000, note: 'AI top-up' } });
    const ex3 = await api('/api/owner/expenses', { method: 'POST', body: { date: prev.date, category: 'domain', amountPaisa: 100000, note: 'last month' } });
    check('expenses recorded (3)', ex1.status === 201 && !!ex1Id && ex2.status === 201 && ex3.status === 201, `statuses=${ex1.status},${ex2.status},${ex3.status}`);
    const exMonth = await api('/api/owner/expenses');
    check('expenses this month: 2 rows, totals by category', (exMonth.data?.expenses ?? []).length === 2 && exMonth.data?.totalsByCategory?.hosting === 65000 && exMonth.data?.totalsByCategory?.ai === 12000 && exMonth.data?.monthTotalPaisa === 77000, `count=${(exMonth.data?.expenses ?? []).length}, total=${exMonth.data?.monthTotalPaisa}`);
    const exPrev = await api(`/api/owner/expenses?month=${prev.month}`);
    check('expenses last month: 1 row, domain ৳1000', (exPrev.data?.expenses ?? []).length === 1 && exPrev.data?.totalsByCategory?.domain === 100000 && exPrev.data?.monthTotalPaisa === 100000, `count=${(exPrev.data?.expenses ?? []).length}, total=${exPrev.data?.monthTotalPaisa}`);
    const exBadCat = await api('/api/owner/expenses', { method: 'POST', body: { date: today, category: 'food', amountPaisa: 1000 } });
    check('expense rejects bad category', exBadCat.status === 400, `status=${exBadCat.status}`);
    const exBadAmt = await api('/api/owner/expenses', { method: 'POST', body: { date: today, category: 'ads', amountPaisa: 0 } });
    check('expense rejects zero amount', exBadAmt.status === 400, `status=${exBadAmt.status}`);
    const exBadDate = await api('/api/owner/expenses', { method: 'POST', body: { date: 'not-a-date', category: 'ads', amountPaisa: 1000 } });
    check('expense rejects bad date', exBadDate.status === 400, `status=${exBadDate.status}`);
    const exDel = await api(`/api/owner/expenses/${ex1Id}`, { method: 'DELETE' });
    const exMonth2 = await api('/api/owner/expenses');
    check('expense delete updates monthly total', exDel.status === 200 && exMonth2.data?.monthTotalPaisa === 12000, `total=${exMonth2.data?.monthTotalPaisa}`);

    // --- 5. API cost breakdown (seeded ledger, nothing invented) -----------------
    const seedNoAuth = await api('/api/owner/_test/seed-ledger', {
      method: 'POST', token: shopToken,
      body: { workspaceId: ownerWorkspaceId, provider: 'groq', providerCostPaisa: 0 },
    });
    check('seed-ledger hook rejects non-owner (403)', seedNoAuth.status === 403, `status=${seedNoAuth.status}`);
    const seed1 = await api('/api/owner/_test/seed-ledger', { method: 'POST', body: { workspaceId: ownerWorkspaceId, provider: 'groq', providerCostPaisa: 0, model: 'openai/gpt-oss-20b' } });
    const seed2 = await api('/api/owner/_test/seed-ledger', { method: 'POST', body: { workspaceId: ownerWorkspaceId, provider: 'openai', providerCostPaisa: 250, model: 'gpt-4o-mini' } });
    const seed3 = await api('/api/owner/_test/seed-ledger', { method: 'POST', body: { workspaceId: ownerWorkspaceId, provider: 'gemini', providerCostPaisa: 120, model: 'gemini-2.5-flash' } });
    const seed4 = await api('/api/owner/_test/seed-ledger', { method: 'POST', body: { workspaceId: shopWorkspaceId, provider: 'openai', providerCostPaisa: 75, model: 'gpt-4o-mini' } });
    check('seeded 4 ledger rows', seed1.status === 201 && seed2.status === 201 && seed3.status === 201 && seed4.status === 201, `statuses=${seed1.status},${seed2.status},${seed3.status},${seed4.status}`);
    const costs = await api('/api/owner/api-costs?period=30d');
    const byProv = Object.fromEntries((costs.data?.byProvider ?? []).map((p) => [p.provider, p]));
    check('api-costs total is the real ledger sum (445 paisa)', costs.status === 200 && costs.data?.totalProviderCostPaisa === 445, `total=${costs.data?.totalProviderCostPaisa}`);
    check('api-costs per provider: openai 325 (2), gemini 120 (1), groq 0 (1)', byProv.openai?.providerCostPaisa === 325 && byProv.openai?.replies === 2 && byProv.gemini?.providerCostPaisa === 120 && byProv.groq?.providerCostPaisa === 0, `openai=${byProv.openai?.providerCostPaisa}, gemini=${byProv.gemini?.providerCostPaisa}, groq=${byProv.groq?.providerCostPaisa}`);
    const byShop = Object.fromEntries((costs.data?.byShop ?? []).map((s) => [s.workspaceId, s]));
    check('api-costs per shop: owner shop 370, second shop 75', byShop[ownerWorkspaceId]?.providerCostPaisa === 370 && byShop[shopWorkspaceId]?.providerCostPaisa === 75, `owner=${byShop[ownerWorkspaceId]?.providerCostPaisa}, shop=${byShop[shopWorkspaceId]?.providerCostPaisa}`);
    const costsMonth = await api('/api/owner/api-costs?period=month');
    check('api-costs ?period=month shows the same total', costsMonth.data?.totalProviderCostPaisa === 445, `total=${costsMonth.data?.totalProviderCostPaisa}`);
    const ovAfterSeed = await api('/api/owner/overview');
    check('overview API spend now 445 (this month + total)', ovAfterSeed.data?.apiSpendThisMonthPaisa === 445 && ovAfterSeed.data?.apiSpendTotalPaisa === 445, `month=${ovAfterSeed.data?.apiSpendThisMonthPaisa}, total=${ovAfterSeed.data?.apiSpendTotalPaisa}`);

    // --- 6. Deposit request → approve --------------------------------------------
    const walletBefore = await api('/api/owner/wallet');
    check('wallet starts ৳0 before any deposit', walletBefore.data?.balancePaisa === 0, `balance=${walletBefore.data?.balancePaisa}`);
    const dep = await api('/api/owner/wallet/deposits', {
      method: 'POST',
      body: { amountPaisa: 500000, method: 'bkash', transactionId: 'TRX123OWNER' },
    });
    const depId = dep.data?.deposit?.id ?? '';
    check('deposit request recorded (pending)', dep.status === 201 && !!depId && dep.data?.deposit?.status === 'pending', `status=${dep.status}, state=${dep.data?.deposit?.status}`);
    check('deposit message is honest: NOT live money movement', String(dep.data?.message ?? '').includes('NOT live money movement'), `msg=${String(dep.data?.message ?? '').slice(0, 60)}`);
    const walletPending = await api('/api/owner/wallet');
    check('pending deposit does NOT credit the wallet', walletPending.data?.balancePaisa === 0, `balance=${walletPending.data?.balancePaisa}`);
    const depBadAmt = await api('/api/owner/wallet/deposits', { method: 'POST', body: { amountPaisa: 0, method: 'bkash', transactionId: 'X1' } });
    check('deposit rejects zero amount', depBadAmt.status === 400, `status=${depBadAmt.status}`);
    const depNoTrx = await api('/api/owner/wallet/deposits', { method: 'POST', body: { amountPaisa: 1000, method: 'bkash' } });
    check('deposit requires a transaction ID (bKash/Nagad/bank)', depNoTrx.status === 400, `status=${depNoTrx.status}`);
    const depBadMethod = await api('/api/owner/wallet/deposits', { method: 'POST', body: { amountPaisa: 1000, method: 'cash', transactionId: 'X2' } });
    check('deposit rejects bad method', depBadMethod.status === 400, `status=${depBadMethod.status}`);
    const approve = await api(`/api/owner/wallet/deposits/${depId}/approve`, { method: 'POST' });
    check('deposit approve credits wallet ৳5000', approve.status === 200 && approve.data?.balancePaisa === 500000 && approve.data?.deposit?.status === 'approved', `status=${approve.status}, balance=${approve.data?.balancePaisa}`);
    const approveAgain = await api(`/api/owner/wallet/deposits/${depId}/approve`, { method: 'POST' });
    check('double-approve rejected (409)', approveAgain.status === 409, `status=${approveAgain.status}`);
    const rejectApproved = await api(`/api/owner/wallet/deposits/${depId}/reject`, { method: 'POST', body: { reason: 'too late' } });
    check('rejecting an approved deposit rejected (409)', rejectApproved.status === 409, `status=${rejectApproved.status}`);
    const dep2 = await api('/api/owner/wallet/deposits', { method: 'POST', body: { amountPaisa: 100000, method: 'nagad', transactionId: 'TRX999' } });
    const dep2Id = dep2.data?.deposit?.id ?? '';
    const reject2 = await api(`/api/owner/wallet/deposits/${dep2Id}/reject`, { method: 'POST', body: { reason: 'payment not received' } });
    const walletAfterReject = await api('/api/owner/wallet');
    check('rejected deposit leaves wallet unchanged (৳5000)', reject2.status === 200 && reject2.data?.deposit?.status === 'rejected' && walletAfterReject.data?.balancePaisa === 500000, `balance=${walletAfterReject.data?.balancePaisa}`);

    // --- 7. Auto-deduction sweep --------------------------------------------------
    // Note: the Groq row costs ৳0, and the sweep only deducts rows with
    // provider_cost_paisa > 0 — so 3 rows are deducted, totalling 445 paisa.
    const shopsBeforeSweep = await api('/api/owner/shops');
    const balancesBefore = Object.fromEntries(
      (shopsBeforeSweep.data?.shops ?? []).map((s) => [s.id, s.balancePaisa]),
    );
    const sweep1 = await api('/api/owner/wallet/sweep', { method: 'POST' });
    check('sweep deducts the 3 costed rows (445 paisa; ৳0 Groq row skipped)', sweep1.status === 200 && sweep1.data?.deductedRows === 3 && sweep1.data?.totalPaisa === 445 && sweep1.data?.balancePaisa === 499555, `rows=${sweep1.data?.deductedRows}, total=${sweep1.data?.totalPaisa}, balance=${sweep1.data?.balancePaisa}`);
    const sweep2 = await api('/api/owner/wallet/sweep', { method: 'POST' });
    check('second sweep deducts nothing (no double deduction)', sweep2.status === 200 && sweep2.data?.deductedRows === 0 && sweep2.data?.totalPaisa === 0 && sweep2.data?.balancePaisa === 499555, `rows=${sweep2.data?.deductedRows}, balance=${sweep2.data?.balancePaisa}`);
    const walletAfterSweep = await api('/api/owner/wallet');
    const txTypes = (walletAfterSweep.data?.transactions ?? []).map((t) => `${t.type}:${t.amountPaisa}`);
    check('wallet history has deposit + one ai_cost per deducted row', walletAfterSweep.data?.balancePaisa === 499555 && txTypes.includes('deposit:500000') && txTypes.includes('ai_cost:-75') && txTypes.includes('ai_cost:-120') && txTypes.includes('ai_cost:-250'), `balance=${walletAfterSweep.data?.balancePaisa}, tx=${txTypes.join(', ')}`);
    const shopsAfterSweep = await api('/api/owner/shops');
    check('sweep does NOT touch shop wallets (balances unchanged)', (shopsAfterSweep.data?.shops ?? []).every((s) => s.balancePaisa === balancesBefore[s.id]), `balances=${(shopsAfterSweep.data?.shops ?? []).map((s) => s.balancePaisa).join(', ')}`);
    const seed5 = await api('/api/owner/_test/seed-ledger', { method: 'POST', body: { workspaceId: ownerWorkspaceId, provider: 'claude', providerCostPaisa: 300, model: 'claude-sonnet-4' } });
    const sweep3 = await api('/api/owner/wallet/sweep', { method: 'POST' });
    check('sweep picks up a new row only (1 row, 300 paisa)', seed5.status === 201 && sweep3.data?.deductedRows === 1 && sweep3.data?.totalPaisa === 300 && sweep3.data?.balancePaisa === 499255, `rows=${sweep3.data?.deductedRows}, balance=${sweep3.data?.balancePaisa}`);

    // --- 8. Low-balance warning ---------------------------------------------------
    const thrHigh = await api('/api/owner/wallet/threshold', { method: 'PATCH', body: { thresholdPaisa: 600000 } });
    check('threshold ৳6000 → low-balance true', thrHigh.status === 200 && thrHigh.data?.lowBalance === true && thrHigh.data?.lowBalanceThresholdPaisa === 600000, `low=${thrHigh.data?.lowBalance}`);
    const walletLow = await api('/api/owner/wallet');
    check('wallet reports low-balance at high threshold', walletLow.data?.lowBalance === true, `low=${walletLow.data?.lowBalance}`);
    const thrLow = await api('/api/owner/wallet/threshold', { method: 'PATCH', body: { thresholdPaisa: 10000 } });
    check('threshold ৳100 → low-balance false', thrLow.status === 200 && thrLow.data?.lowBalance === false, `low=${thrLow.data?.lowBalance}`);
    const thrBad = await api('/api/owner/wallet/threshold', { method: 'PATCH', body: { thresholdPaisa: -5 } });
    check('threshold rejects negative', thrBad.status === 400, `status=${thrBad.status}`);

    // --- 9. Cards on file ---------------------------------------------------------
    const cardFull = await api('/api/owner/wallet/cards', { method: 'POST', body: { brand: 'Visa', last4: '4242', number: '4242424242424242' } });
    check('card with full number rejected (400)', cardFull.status === 400, `status=${cardFull.status}`);
    const cardCvv = await api('/api/owner/wallet/cards', { method: 'POST', body: { brand: 'Visa', last4: '4242', cvv: '123' } });
    check('card with CVV rejected (400)', cardCvv.status === 400, `status=${cardCvv.status}`);
    const cardBadLast4 = await api('/api/owner/wallet/cards', { method: 'POST', body: { brand: 'Visa', last4: '424' } });
    check('card with 3-digit last4 rejected (400)', cardBadLast4.status === 400, `status=${cardBadLast4.status}`);
    const card = await api('/api/owner/wallet/cards', { method: 'POST', body: { brand: 'Visa', last4: '4242', expMonth: 12, expYear: 2030, isDefault: true } });
    const cardId = card.data?.card?.id ?? '';
    check('card saved (brand + last 4 only)', card.status === 201 && !!cardId && card.data?.card?.masked === 'Visa •••• 4242', `status=${card.status}, masked=${card.data?.card?.masked}`);
    const cardList = await api('/api/owner/wallet/cards');
    check('cards list shows the saved card', (cardList.data?.cards ?? []).some((c) => c.id === cardId), `count=${(cardList.data?.cards ?? []).length}`);
    const cardDep = await api('/api/owner/wallet/deposits', { method: 'POST', body: { amountPaisa: 200000, method: 'card', cardId } });
    const cardDepId = cardDep.data?.deposit?.id ?? '';
    check('card deposit request needs a saved card (accepted)', cardDep.status === 201 && !!cardDepId && cardDep.data?.deposit?.status === 'pending', `status=${cardDep.status}`);
    const delCardBlocked = await api(`/api/owner/wallet/cards/${cardId}`, { method: 'DELETE' });
    check('card delete blocked while a pending deposit references it (409)', delCardBlocked.status === 409, `status=${delCardBlocked.status}`);
    const cardDepNoCard = await api('/api/owner/wallet/deposits', { method: 'POST', body: { amountPaisa: 1000, method: 'card' } });
    check('card deposit without cardId rejected (400)', cardDepNoCard.status === 400, `status=${cardDepNoCard.status}`);
    const approveCardDep = await api(`/api/owner/wallet/deposits/${cardDepId}/approve`, { method: 'POST' });
    check('card deposit approve credits wallet (৳4992.55 + ৳2000)', approveCardDep.status === 200 && approveCardDep.data?.balancePaisa === 699255, `balance=${approveCardDep.data?.balancePaisa}`);
    const delCard = await api(`/api/owner/wallet/cards/${cardId}`, { method: 'DELETE' });
    check('card delete works once no pending deposit', delCard.status === 200, `status=${delCard.status}`);

    // --- 10. Non-owner blocked on every owner section ------------------------------
    const blockedBank = await api('/api/owner/bank-accounts', { method: 'POST', token: shopToken, body: { bankName: 'X', accountHolder: 'Y', accountNumber: '1234567890' } });
    check('non-owner blocked from bank accounts (403)', blockedBank.status === 403, `status=${blockedBank.status}`);
    const blockedWallet = await api('/api/owner/wallet', { token: shopToken });
    check('non-owner blocked from wallet (403)', blockedWallet.status === 403, `status=${blockedWallet.status}`);
    const blockedSweep = await api('/api/owner/wallet/sweep', { method: 'POST', token: shopToken });
    check('non-owner blocked from sweep (403)', blockedSweep.status === 403, `status=${blockedSweep.status}`);
    const blockedNoAuth = await api('/api/owner/wallet', { token: '' });
    check('wallet without token → 401', blockedNoAuth.status === 401, `status=${blockedNoAuth.status}`);
  } finally {
    stopApi();
    await sleep(500);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length > 0) {
    console.log('Failed:');
    for (const f of failed) console.log(` - ${f.name} — ${f.detail}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Verification crashed:', err);
  process.exit(1);
});
