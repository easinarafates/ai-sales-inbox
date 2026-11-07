#!/usr/bin/env node
/**
 * Verification for the Owner per-request token + cost usage view (local, no
 * Docker, no money). Starts the API itself (tsx, PGlite) on :4003, seeds
 * ai_usage_ledger rows via the env-gated test hook, and checks the
 * GET /api/owner/api-costs endpoint returns per-request rows (newest first)
 * with input/output tokens and real provider costs, plus consistent totals
 * per provider / per shop / per day. Also checks the owner api-costs page
 * source renders the new table and summary cards. Run from the repo root:
 *   node scripts/verify-owner-usage.mjs
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 *
 * Coverage: owner-only access (401 no token, 403 non-owner), per-request
 * rows with tokens + cost + shop + customer (customer resolved through the
 * conversation join; rows without a conversation show customerName null,
 * never invented), totals consistent with the rows, per-provider / per-shop
 * / per-day token sums, period filter (7d/30d/month), page source checks.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Isolated API for this verifier: its own PGlite data folder + own port, so
// it never contends with another worker's API on the shared ./​.pglite-data
// (PGlite allows only ONE process per data folder) or on :4000.
const API_PORT = process.env.VERIFY_API_PORT ?? '4003';
const API = process.env.API_URL ?? `http://localhost:${API_PORT}`;
const results = [];
let ownerToken = '';
let shopToken = '';
let ownerWorkspaceId = '';
let shopWorkspaceId = '';

// Fixed 64-hex test key (32 bytes) so bank-account encryption works in the
// isolated run. Test-only; it never touches apps/api/.env.
const TEST_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function api(path, { method = 'GET', body, token = ownerToken } = {}) {
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

async function main() {
  // Fresh data folder every run: exact-count checks must not see leftovers
  // from an earlier run or a debug session.
  await fs.rm(path.join(ROOT, 'apps/api/.pglite-data-owner-usage'), { recursive: true, force: true });
  // Start the API (tsx + PGlite, loads schema + migrations incl. 11).
  // Detached process group so stopping kills the whole npm/tsx tree.
  const apiProc = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: path.join(ROOT, 'apps/api'),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: {
      ...process.env,
      PORT: API_PORT,
      DATABASE_URL: 'pglite://./.pglite-data-owner-usage',
      ALLOW_OWNER_TEST_HOOKS: 'true',
      TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    },
  });
  let apiLog = '';
  apiProc.stdout.on('data', (d) => { apiLog += d.toString(); });
  apiProc.stderr.on('data', (d) => { apiLog += d.toString(); });
  const stopApi = () => {
    try { process.kill(-apiProc.pid, 'SIGTERM'); } catch { try { apiProc.kill('SIGTERM'); } catch { /* already gone */ } }
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
    const ownerEmail = `owner-usage+${stamp}@example.com`;
    const shopEmail = `shop-usage+${stamp}@example.com`;

    // --- 0. Owner-only access ------------------------------------------------
    const noAuth = await api('/api/owner/api-costs?period=30d', { token: '' });
    check('api-costs without token → 401', noAuth.status === 401, `status=${noAuth.status}`);

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

    const nonOwner = await api('/api/owner/api-costs?period=30d', { token: shopToken });
    check('api-costs as non-owner → 403', nonOwner.status === 403, `status=${nonOwner.status}`);
    const setup = await api('/api/owner/setup', { method: 'POST', token: '', body: { email: ownerEmail } });
    check('owner bootstrap setup (first owner)', setup.status === 200, `status=${setup.status}`);

    // --- 1. Seed ledger rows (numbers mirror the user's reference table) ----
    // Owner shop: gemini 16182 in / 26 out / 10p; openai 16053 / 70 / 11p;
    // groq 15978 / 107 / 0p. Second shop: gemini 15879 / 173 / 19p with a
    // real customer, so the conversation join is proven end-to-end.
    const seed = async (body) => api('/api/owner/_test/seed-ledger', { method: 'POST', body });
    const s1 = await seed({ workspaceId: ownerWorkspaceId, provider: 'gemini', providerCostPaisa: 10, inputTokens: 16182, outputTokens: 26, model: 'gemini-3.5-flash' });
    await sleep(120);
    const s2 = await seed({ workspaceId: ownerWorkspaceId, provider: 'openai', providerCostPaisa: 11, inputTokens: 16053, outputTokens: 70, model: 'gpt-5-mini' });
    await sleep(120);
    const s3 = await seed({ workspaceId: ownerWorkspaceId, provider: 'groq', providerCostPaisa: 0, inputTokens: 15978, outputTokens: 107, model: 'openai/gpt-oss-20b' });
    await sleep(120);
    const s4 = await seed({ workspaceId: shopWorkspaceId, provider: 'gemini', providerCostPaisa: 19, inputTokens: 15879, outputTokens: 173, model: 'gemini-3.5-flash', customerName: 'Rahim Uddin' });
    check('seeded 4 ledger rows', [s1, s2, s3, s4].every((s) => s.status === 201), `statuses=${[s1, s2, s3, s4].map((s) => s.status).join(',')}`);
    check('seeded row with customer links a conversation', !!s4.data?.ledgerRow?.conversation_id, `conversation_id=${s4.data?.ledgerRow?.conversation_id ?? 'none'}`);

    // --- 2. Per-request rows --------------------------------------------------
    const costs = await api('/api/owner/api-costs?period=30d');
    check('api-costs 200 for owner', costs.status === 200, `status=${costs.status}`);
    const rows = costs.data?.rows ?? [];
    check('rows: 4 per-request rows returned', rows.length === 4, `count=${rows.length}`);
    const newestFirst = rows.every((r, i) => i === 0 || rows[i - 1].createdAt >= r.createdAt);
    check('rows are newest first', newestFirst, `first=${rows[0]?.createdAt}, last=${rows[rows.length - 1]?.createdAt}`);
    const newest = rows[0] ?? {};
    check('newest row is the last-seeded one (15879 in / 173 out / 19p)', newest.inputTokens === 15879 && newest.outputTokens === 173 && newest.providerCostPaisa === 19, `in=${newest.inputTokens}, out=${newest.outputTokens}, cost=${newest.providerCostPaisa}`);
    check('newest row resolves the customer through the conversation join', newest.customerName === 'Rahim Uddin', `customer=${newest.customerName}`);
    check('newest row shows shop + provider + model + purpose', newest.shopName === 'Second Shop' && newest.provider === 'gemini' && newest.model === 'gemini-3.5-flash' && newest.purpose === 'customer_reply', `shop=${newest.shopName}, provider=${newest.provider}, model=${newest.model}, purpose=${newest.purpose}`);
    const othersBlank = rows.slice(1).every((r) => r.customerName === null);
    check('rows without a conversation show a blank customer (never invented)', othersBlank, `customers=${rows.slice(1).map((r) => r.customerName).join(',')}`);
    const geminiRow = rows.find((r) => r.provider === 'gemini' && r.inputTokens === 16182);
    check('row tokens + cost match the seeded ledger values', geminiRow?.outputTokens === 26 && geminiRow?.providerCostPaisa === 10 && geminiRow?.shopName === 'Owner Shop', `out=${geminiRow?.outputTokens}, cost=${geminiRow?.providerCostPaisa}`);

    // --- 3. Totals consistent with the rows -----------------------------------
    const sumIn = rows.reduce((s, r) => s + r.inputTokens, 0);
    const sumOut = rows.reduce((s, r) => s + r.outputTokens, 0);
    const sumCost = rows.reduce((s, r) => s + r.providerCostPaisa, 0);
    check('totals: input 64092, output 376, cost 40p, 4 replies, avg 10p',
      costs.data?.totalInputTokens === 64092 && costs.data?.totalOutputTokens === 376 &&
      costs.data?.totalProviderCostPaisa === 40 && costs.data?.totalReplies === 4 &&
      costs.data?.avgCostPaisa === 10,
      `in=${costs.data?.totalInputTokens}, out=${costs.data?.totalOutputTokens}, cost=${costs.data?.totalProviderCostPaisa}, replies=${costs.data?.totalReplies}, avg=${costs.data?.avgCostPaisa}`);
    check('row sums equal the totals (nothing invented, nothing lost)',
      sumIn === costs.data?.totalInputTokens && sumOut === costs.data?.totalOutputTokens && sumCost === costs.data?.totalProviderCostPaisa,
      `rows in=${sumIn}, out=${sumOut}, cost=${sumCost}`);

    // --- 4. Per-provider / per-shop / per-day token sums -----------------------
    const byProv = Object.fromEntries((costs.data?.byProvider ?? []).map((p) => [p.provider, p]));
    check('byProvider gemini: 2 replies, 32061 in, 199 out, 29p',
      byProv.gemini?.replies === 2 && byProv.gemini?.inputTokens === 32061 && byProv.gemini?.outputTokens === 199 && byProv.gemini?.providerCostPaisa === 29,
      `replies=${byProv.gemini?.replies}, in=${byProv.gemini?.inputTokens}, out=${byProv.gemini?.outputTokens}, cost=${byProv.gemini?.providerCostPaisa}`);
    check('byProvider openai: 1 reply, 16053 in, 70 out, 11p',
      byProv.openai?.replies === 1 && byProv.openai?.inputTokens === 16053 && byProv.openai?.outputTokens === 70 && byProv.openai?.providerCostPaisa === 11,
      `in=${byProv.openai?.inputTokens}, out=${byProv.openai?.outputTokens}, cost=${byProv.openai?.providerCostPaisa}`);
    check('byProvider groq: 1 reply, 15978 in, 107 out, ৳0',
      byProv.groq?.replies === 1 && byProv.groq?.inputTokens === 15978 && byProv.groq?.outputTokens === 107 && byProv.groq?.providerCostPaisa === 0,
      `in=${byProv.groq?.inputTokens}, out=${byProv.groq?.outputTokens}, cost=${byProv.groq?.providerCostPaisa}`);
    const byShop = Object.fromEntries((costs.data?.byShop ?? []).map((s) => [s.workspaceId, s]));
    check('byShop owner shop: 3 replies, 48213 in, 203 out, 21p',
      byShop[ownerWorkspaceId]?.replies === 3 && byShop[ownerWorkspaceId]?.inputTokens === 48213 && byShop[ownerWorkspaceId]?.outputTokens === 203 && byShop[ownerWorkspaceId]?.providerCostPaisa === 21,
      `in=${byShop[ownerWorkspaceId]?.inputTokens}, out=${byShop[ownerWorkspaceId]?.outputTokens}, cost=${byShop[ownerWorkspaceId]?.providerCostPaisa}`);
    check('byShop second shop: 1 reply, 15879 in, 173 out, 19p',
      byShop[shopWorkspaceId]?.replies === 1 && byShop[shopWorkspaceId]?.inputTokens === 15879 && byShop[shopWorkspaceId]?.outputTokens === 173 && byShop[shopWorkspaceId]?.providerCostPaisa === 19,
      `in=${byShop[shopWorkspaceId]?.inputTokens}, out=${byShop[shopWorkspaceId]?.outputTokens}`);
    const today = new Date().toISOString().slice(0, 10);
    const dayRows = (costs.data?.byDay ?? []).filter((d) => d.date === today);
    const dayGemini = dayRows.find((d) => d.provider === 'gemini');
    check('byDay today gemini: 32061 in, 199 out, 29p',
      dayGemini?.inputTokens === 32061 && dayGemini?.outputTokens === 199 && dayGemini?.providerCostPaisa === 29,
      `in=${dayGemini?.inputTokens}, out=${dayGemini?.outputTokens}, cost=${dayGemini?.providerCostPaisa}`);
    // The overview trend used the same broken date formatting (DATE columns
    // come back as JS Dates; String(date) is "Sat Nov 07", never matching a
    // YYYY-MM-DD key, so the trend showed 0). Today's trend entry must now
    // carry the real cost.
    const ov = await api('/api/owner/overview?days=7');
    const todayTrend = (ov.data?.trend ?? []).find((t) => t.date === today);
    check('overview trend today shows the real AI cost (40p)',
      todayTrend?.apiCostPaisa === 40,
      `trend=${JSON.stringify(todayTrend ?? null)}`);

    // --- 5. Period filter -------------------------------------------------------
    const costs7 = await api('/api/owner/api-costs?period=7d');
    check('period=7d shows the same totals', costs7.data?.totalProviderCostPaisa === 40 && costs7.data?.totalInputTokens === 64092 && (costs7.data?.rows ?? []).length === 4, `total=${costs7.data?.totalProviderCostPaisa}, rows=${(costs7.data?.rows ?? []).length}`);
    const costsMonth = await api('/api/owner/api-costs?period=month');
    check('period=month shows the same totals', costsMonth.data?.totalProviderCostPaisa === 40 && costsMonth.data?.totalReplies === 4, `total=${costsMonth.data?.totalProviderCostPaisa}`);

    // --- 6. Page source: table + summary cards render ---------------------------
    const pageSrc = await fs.readFile(path.join(ROOT, 'apps/web/app/owner/api-costs/page.tsx'), 'utf8');
    const libSrc = await fs.readFile(path.join(ROOT, 'apps/web/lib/api-owner.ts'), 'utf8');
    check('page has the per-request table (WHEN / WHAT IT WAS FOR / SHOP / CUSTOMER / IN / OUT / COST)',
      pageSrc.includes('ownerUsageThWhen') && pageSrc.includes('ownerUsageThPurpose') && pageSrc.includes('ownerUsageThCustomer') &&
      pageSrc.includes('ownerUsageThIn') && pageSrc.includes('ownerUsageThOut') && pageSrc.includes('ownerUsageThCost'),
      'missing column key');
    check('page renders rows newest-first with date+time, shop, customer, tokens, ৳ cost',
      pageSrc.includes('data.rows.map') && pageSrc.includes('fmtDate(r.createdAt)') && pageSrc.includes('r.customerName') &&
      pageSrc.includes('fmtNum(r.inputTokens)') && pageSrc.includes('fmtNum(r.outputTokens)') && pageSrc.includes('fmtTaka(r.providerCostPaisa)'),
      'missing row rendering');
    check('page has summary cards (total IN, total OUT, total cost, replies, avg cost)',
      pageSrc.includes('ownerUsageTotalIn') && pageSrc.includes('ownerUsageTotalOut') && pageSrc.includes('ownerUsageAvg') &&
      pageSrc.includes('data.totalInputTokens') && pageSrc.includes('data.totalOutputTokens') && pageSrc.includes('data.avgCostPaisa'),
      'missing summary card');
    check('page table scrolls horizontally on mobile', pageSrc.includes('overflow-x-auto'), 'no overflow-x-auto');
    check('lib type carries rows + token totals', libSrc.includes('ApiCostRow') && libSrc.includes('totalInputTokens') && libSrc.includes('totalOutputTokens') && libSrc.includes('rows: ApiCostRow[]'), 'missing type fields');
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
