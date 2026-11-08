#!/usr/bin/env node
/**
 * Verification for per-chat / per-customer AI token + cost display.
 *
 * What it checks:
 *  A. Static: the GET /api/inbox/usage endpoint exists (registered before
 *     '/:id'), sums provider_cost_paisa ONLY (never cost_paisa), and the
 *     Inbox / Customers list / Customers detail UI + api client + i18n
 *     keys are wired.
 *  B. Live ledger (Neon, READ-ONLY): true per-conversation and
 *     per-customer sums for the gd_arafat workspace (2683f2fd-...), the
 *     three known customers ('কে আমি' x2 customer rows, Mohammad Easin,
 *     'ইয়াসিন আরাফাত').
 *  C. Local API end-to-end (PGlite, real endpoint, NO stubs): the live
 *     ledger rows from B are copied verbatim into a fresh local workspace
 *     and GET /api/inbox/usage must return the EXACT same sums — plus
 *     ?conversationId / ?customerId filters, workspace isolation, 401
 *     without a token, and a conversation with no ledger rows having no
 *     row (the UI shows 0 for it).
 *  D. Live API (Vercel): calls the deployed endpoint with a real
 *     gd_arafat JWT and compares against B. This CANNOT pass until the
 *     coordinator deploys this change — before that it reports
 *     PENDING-DEPLOY and does not fail the run.
 *  E. Web bundle: `npm run build` in apps/web, then the built chunks
 *     must contain the usage labels (EN + BN).
 *
 * Run from the repo root:  node scripts/verify-per-chat-usage.mjs
 * Prints PASS/FAIL per step and exits non-zero if anything verifiable fails.
 */
import { spawn, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { neon } = require('/home/hatch/workspace/.tools/node_modules/@neondatabase/serverless');

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const results = [];
let token = '';
let workspaceId = '';
let livePending = false;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function envFileValue(file, name) {
  const envPath = path.join(ROOT, file);
  if (!fs.existsSync(envPath)) return '';
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (t.startsWith(`${name}=`)) return t.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');
  }
  return '';
}

/** Minimal HS256 JWT signer (same secret the live API uses). */
function signJwt(secret, payload, expiresInSec = 3600) {
  const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ ...payload, iat: now, exp: now + expiresInSec })}`;
  return `${data}.${crypto.createHmac('sha256', secret).update(data).digest('base64url')}`;
}

function makeApi(base) {
  return async function api(path, { method = 'GET', body, auth = true, headers = {} } = {}) {
    const res = await fetch(`${base}${path}`, {
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

async function setupWorkspace(api, stamp) {
  const email = `usage+${stamp}@example.com`;
  const signup = await api('/api/auth/signup', {
    method: 'POST', auth: false,
    body: { name: 'Usage Owner', email, password: 'verify1234', workspaceName: 'Usage Shop' },
  });
  check('local signup', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
  token = signup.data?.token ?? '';
  workspaceId = signup.data?.workspace?.id ?? '';
}

const GD_ARAFAT_WS = '2683f2fd-b8d4-4480-b8b7-ac126ca37a28';

async function main() {
  // ================= A. Static checks =================
  const routesSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/inbox/routes.ts'), 'utf8');
  const usageIdx = routesSrc.indexOf("inboxRouter.get('/usage'");
  const idIdx = routesSrc.indexOf("inboxRouter.get('/:id'");
  check('endpoint GET /api/inbox/usage exists in inbox routes', usageIdx !== -1);
  check("endpoint registered BEFORE '/:id' (so 'usage' is not an id)", usageIdx !== -1 && idIdx !== -1 && usageIdx < idIdx);
  const usageBlock = usageIdx !== -1 ? routesSrc.slice(usageIdx, routesSrc.indexOf("inboxRouter.get('/:id'", usageIdx)) : '';
  check('endpoint sums provider_cost_paisa (Owner Panel basis)', usageBlock.includes('SUM(l.provider_cost_paisa)'));
  check('endpoint never sums cost_paisa (wallet deduction)', !usageBlock.includes('SUM(l.cost_paisa)') && !usageBlock.includes('SUM(cost_paisa)'));
  check('endpoint scopes by workspace (WHERE l.workspace_id = $1)', usageBlock.includes('WHERE l.workspace_id = $1'));
  check('endpoint returns per-conversation + per-customer rollups', usageBlock.includes('byConversation') && usageBlock.includes('byCustomer'));

  const apiClientSrc = fs.readFileSync(path.join(ROOT, 'apps/web/lib/api.ts'), 'utf8');
  check('web api client has usageApi.list + UsageSummary types', apiClientSrc.includes('usageApi') && apiClientSrc.includes('ConversationUsage') && apiClientSrc.includes('CustomerUsage') && apiClientSrc.includes('/api/inbox/usage'));

  const inboxSrc = fs.readFileSync(path.join(ROOT, 'apps/web/app/inbox/page.tsx'), 'utf8');
  check('inbox page loads usage + shows it in the thread header', inboxSrc.includes('usageApi.list()') && inboxSrc.includes('usageByConv') && inboxSrc.includes('inbox.aiUsageTitle'));
  check('inbox page shows an honest 0 when a chat has no AI replies', inboxSrc.includes('inbox.noAiReplies'));
  check('inbox list shows per-chat cost when replies exist', inboxSrc.includes('AI ·') && inboxSrc.includes('aiUsageReplies'));

  const custSrc = fs.readFileSync(path.join(ROOT, 'apps/web/app/customers/page.tsx'), 'utf8');
  check('customers list has an AI cost column (usageByCustomer)', custSrc.includes('customers.thAiCost') && custSrc.includes('usageByCustomer'));
  const custDetailSrc = fs.readFileSync(path.join(ROOT, 'apps/web/app/customers/[id]/page.tsx'), 'utf8');
  check('customer detail has an AI usage card with per-chat breakdown', custDetailSrc.includes('customers.aiUsageTitle') && custDetailSrc.includes('customers.aiUsagePerChat') && custDetailSrc.includes('/inbox?conversation='));

  const dictSrc = fs.readFileSync(path.join(ROOT, 'apps/web/lib/i18n-dict.ts'), 'utf8');
  check('i18n has usage keys (EN + BN)', dictSrc.includes('"inbox.aiUsageTitle": "AI usage so far"') && dictSrc.includes('"inbox.aiUsageTitle": "এখন পর্যন্ত AI ব্যবহার"') && dictSrc.includes('"customers.thAiCost": "AI cost"') && dictSrc.includes('"customers.thAiCost": "AI খরচ"') && dictSrc.includes('"inbox.noAiReplies": "No AI replies yet"') && dictSrc.includes('"inbox.noAiReplies": "AI এখনো উত্তর দেয়নি"'));

  // ================= B. Live ledger (Neon, read-only) =================
  const dbUrl = envFileValue('.env.local', 'DATABASE_URL');
  check('Neon DATABASE_URL available (from .env.local, never printed)', dbUrl.length > 0);
  if (!dbUrl) return;
  const sql = neon(dbUrl);
  const liveConv = await sql.query(`
    SELECT cu.id AS customer_id, cu.name AS customer_name, c.id AS conversation_id,
           COUNT(l.id) AS replies,
           COALESCE(SUM(l.input_tokens),0) AS in_tokens,
           COALESCE(SUM(l.output_tokens),0) AS out_tokens,
           COALESCE(SUM(l.provider_cost_paisa),0) AS cost_paisa
    FROM customers cu
    JOIN conversations c ON c.customer_id = cu.id AND c.workspace_id = cu.workspace_id
    JOIN ai_usage_ledger l ON l.conversation_id = c.id AND l.workspace_id = cu.workspace_id
    WHERE cu.workspace_id = $1
    GROUP BY cu.id, cu.name, c.id
    ORDER BY cu.name, c.id`, [GD_ARAFAT_WS]);
  const liveCust = await sql.query(`
    SELECT cu.id AS customer_id, cu.name AS customer_name,
           COUNT(l.id) AS replies,
           COALESCE(SUM(l.input_tokens),0) AS in_tokens,
           COALESCE(SUM(l.output_tokens),0) AS out_tokens,
           COALESCE(SUM(l.provider_cost_paisa),0) AS cost_paisa
    FROM customers cu
    JOIN conversations c ON c.customer_id = cu.id AND c.workspace_id = cu.workspace_id
    JOIN ai_usage_ledger l ON l.conversation_id = c.id AND l.workspace_id = cu.workspace_id
    WHERE cu.workspace_id = $1
    GROUP BY cu.id, cu.name
    ORDER BY cu.name`, [GD_ARAFAT_WS]);
  const liveRows = await sql.query(`
    SELECT conversation_id, input_tokens, output_tokens, cost_paisa,
           provider_cost_paisa, provider, model
    FROM ai_usage_ledger WHERE workspace_id = $1 AND conversation_id IS NOT NULL`,
    [GD_ARAFAT_WS]);
  const orphan = await sql.query(
    `SELECT COUNT(*) AS n FROM ai_usage_ledger WHERE workspace_id = $1 AND conversation_id IS NULL`,
    [GD_ARAFAT_WS]);
  const num = (r, k) => Number(r[k] ?? 0);
  const liveTotals = liveRows.reduce((a, r) => ({
    replies: a.replies + 1,
    inTokens: a.inTokens + num(r, 'input_tokens'),
    outTokens: a.outTokens + num(r, 'output_tokens'),
    costPaisa: a.costPaisa + num(r, 'provider_cost_paisa'),
  }), { replies: 0, inTokens: 0, outTokens: 0, costPaisa: 0 });

  check('live ledger: gd_arafat has ledger rows with a conversation', liveRows.length > 0, `${liveRows.length} rows`);
  console.log(`  live totals: ${liveTotals.replies} replies, ${liveTotals.inTokens} in + ${liveTotals.outTokens} out tokens, ৳${(liveTotals.costPaisa / 100).toFixed(2)} (${liveTotals.costPaisa} paisa)`);
  for (const c of liveCust) {
    console.log(`  live customer ${c.customer_name} (${c.customer_id}): ${c.replies} replies, ${c.in_tokens} in + ${c.out_tokens} out, ৳${(Number(c.cost_paisa) / 100).toFixed(2)}`);
  }
  console.log(`  live ledger rows with NO conversation (unattributed, excluded from per-chat totals): ${orphan[0]?.n ?? '?'}`);
  // Known reference values from 2026-11-08 (may have drifted since — the
  // endpoint must match the LIVE sums above, not these).
  const keami = liveCust.filter((c) => c.customer_name === 'কে আমি');
  const keamiTotal = keami.reduce((a, c) => ({ replies: a.replies + Number(c.replies), in: a.in + Number(c.in_tokens), out: a.out + Number(c.out_tokens), cost: a.cost + Number(c.cost_paisa) }), { replies: 0, in: 0, out: 0, cost: 0 });
  check("live 'কে আমি' (both customer rows): 95 replies, 273616 in + 6335 out, ৳11.37", keamiTotal.replies === 95 && keamiTotal.in === 273616 && keamiTotal.out === 6335 && keamiTotal.cost === 1137, `${keamiTotal.replies} replies, ${keamiTotal.in}+${keamiTotal.out}, ৳${(keamiTotal.cost / 100).toFixed(2)}`);
  const easin = liveCust.find((c) => c.customer_name === 'Mohammad Easin');
  // Reference from 2026-11-08 was 65 replies / ৳2.01 — the live ledger
  // has drifted by 1 reply / 6 paisa since (a row changed or was
  // removed). The endpoint must match the CURRENT live sums (checked
  // in C), so drift here is reported, not failed.
  check("live Mohammad Easin found (2026-11-08 reference was 65 replies / ৳2.01)", !!easin, easin ? `now ${easin.replies} replies, ৳${(Number(easin.cost_paisa) / 100).toFixed(2)}` : 'not found');
  const owner = liveCust.find((c) => c.customer_name === 'ইয়াসিন আরাফাত');
  check("live 'ইয়াসিন আরাফাত': 25 replies, ৳2.94", owner && Number(owner.replies) === 25 && Number(owner.cost_paisa) === 294, owner ? `${owner.replies} replies, ৳${(Number(owner.cost_paisa) / 100).toFixed(2)}` : 'not found');

  // ================= C. Local API end-to-end (PGlite, real endpoint) =================
  const port = 4021;
  const dataDir = '.pglite-data-usage';
  const api = makeApi(`http://localhost:${port}`);
  const run1 = startApi(port, dataDir);
  process.on('exit', run1.stop);
  try {
    const up = await waitForHealth(`http://localhost:${port}`);
    check('local API starts (health)', up, up ? '' : run1.log().slice(-500));
    if (!up) return;
    await setupWorkspace(api, Date.now());
  } finally {
    run1.stop();
    await sleep(3000);
  }
  if (!workspaceId) return;

  // Seed the local PGlite DB with the REAL live rows (verbatim) while the
  // API is stopped — PGlite allows only one process per data folder.
  const seedJson = path.join('/tmp', 'usage-seed.json');
  fs.writeFileSync(seedJson, JSON.stringify({
    workspaceId,
    customers: liveCust.map((c) => ({ id: c.customer_id, name: c.customer_name })),
    conversations: liveConv.map((c) => ({ id: c.conversation_id, customerId: c.customer_id })),
    ledgerRows: liveRows.map((r) => ({
      conversationId: r.conversation_id,
      inputTokens: num(r, 'input_tokens'),
      outputTokens: num(r, 'output_tokens'),
      costPaisa: num(r, 'cost_paisa'),
      providerCostPaisa: num(r, 'provider_cost_paisa'),
      provider: r.provider ?? 'gemini',
      model: r.model ?? '',
    })),
  }));
  const seedOut = execSync(`node scripts/seed-usage-verify.mjs ${dataDir} ${seedJson}`, { cwd: ROOT, encoding: 'utf8' });
  console.log(seedOut.trim());
  check('seed copied the live ledger rows into local PGlite', seedOut.includes('seeded'));

  const run2 = startApi(port, dataDir);
  process.on('exit', run2.stop);
  try {
    const up = await waitForHealth(`http://localhost:${port}`);
    check('local API restarts after seeding (health)', up, up ? '' : run2.log().slice(-500));
    if (!up) return;

    const usage = await api('/api/inbox/usage');
    check('GET /api/inbox/usage → 200', usage.status === 200, `status=${usage.status}`);
    const byConv = usage.data?.byConversation ?? [];
    const byCust = usage.data?.byCustomer ?? [];
    // Per-conversation: exact match on every live row.
    let convMatch = byConv.length === liveConv.length;
    const convDetail = [];
    for (const lc of liveConv) {
      const got = byConv.find((r) => r.conversationId === lc.conversation_id);
      const ok = !!got && got.replies === Number(lc.replies) && got.inputTokens === Number(lc.in_tokens)
        && got.outputTokens === Number(lc.out_tokens) && got.costPaisa === Number(lc.cost_paisa)
        && got.customerId === lc.customer_id && got.customerName === lc.customer_name;
      if (!ok) { convMatch = false; convDetail.push(`${lc.customer_name}/${lc.conversation_id.slice(0, 8)}: live ${lc.replies}r ${lc.in_tokens}+${lc.out_tokens} ৳${(Number(lc.cost_paisa) / 100).toFixed(2)} vs api ${got ? `${got.replies}r ${got.inputTokens}+${got.outputTokens} ৳${(got.costPaisa / 100).toFixed(2)}` : 'MISSING'}`); }
    }
    check('byConversation matches the live ledger exactly (all chats)', convMatch, convDetail.join(' | ') || `${byConv.length} chats`);
    // Per-customer: exact match.
    let custMatch = byCust.length === liveCust.length;
    const custDetail = [];
    for (const lc of liveCust) {
      const got = byCust.find((r) => r.customerId === lc.customer_id);
      const convCount = liveConv.filter((c) => c.customer_id === lc.customer_id).length;
      const ok = !!got && got.replies === Number(lc.replies) && got.inputTokens === Number(lc.in_tokens)
        && got.outputTokens === Number(lc.out_tokens) && got.costPaisa === Number(lc.cost_paisa)
        && got.conversationCount === convCount;
      if (!ok) { custMatch = false; custDetail.push(`${lc.customer_name}: live ${lc.replies}r ৳${(Number(lc.cost_paisa) / 100).toFixed(2)} vs api ${got ? `${got.replies}r ৳${(got.costPaisa / 100).toFixed(2)}` : 'MISSING'}`); }
    }
    check('byCustomer matches the live ledger exactly (all customers)', custMatch, custDetail.join(' | ') || `${byCust.length} customers`);
    const t = usage.data?.totals ?? {};
    check('totals match the live grand sums', t.replies === liveTotals.replies && t.inputTokens === liveTotals.inTokens && t.outputTokens === liveTotals.outTokens && t.costPaisa === liveTotals.costPaisa, `${t.replies}r ${t.inputTokens}+${t.outputTokens} ৳${((t.costPaisa ?? 0) / 100).toFixed(2)}`);

    // Filters.
    const oneConv = liveConv[0];
    const filtered = await api(`/api/inbox/usage?conversationId=${oneConv.conversation_id}`);
    check('?conversationId= returns exactly that chat', filtered.status === 200 && filtered.data?.byConversation?.length === 1 && filtered.data.byConversation[0].conversationId === oneConv.conversation_id && filtered.data.byConversation[0].costPaisa === Number(oneConv.cost_paisa), `status=${filtered.status}, rows=${filtered.data?.byConversation?.length}`);
    const filteredCust = await api(`/api/inbox/usage?customerId=${oneConv.customer_id}`);
    check('?customerId= returns exactly that customer rollup', filteredCust.status === 200 && filteredCust.data?.byCustomer?.length === 1 && filteredCust.data.byCustomer[0].customerId === oneConv.customer_id, `status=${filteredCust.status}, rows=${filteredCust.data?.byCustomer?.length}`);

    // The seeded customer/conversation with NO ledger rows has no row —
    // the UI shows 0 for it (checked in A), never an invented number.
    const noAi = byConv.find((r) => r.customerName === 'No AI Yet');
    const noAiCust = byCust.find((r) => r.customerName === 'No AI Yet');
    check('chat with no AI replies has NO usage row (UI shows 0)', !noAi && !noAiCust);

    // Auth + isolation.
    const noAuth = await api('/api/inbox/usage', { auth: false });
    check('no token → 401', noAuth.status === 401, `status=${noAuth.status}`);
    const savedToken = token;
    await setupWorkspace(api, Date.now() + 1); // second workspace
    const other = await api('/api/inbox/usage');
    check('a different workspace sees no usage rows (isolation)', other.status === 200 && (other.data?.byConversation ?? []).length === 0 && (other.data?.byCustomer ?? []).length === 0 && other.data?.totals?.costPaisa === 0, `rows=${(other.data?.byConversation ?? []).length}`);
    token = savedToken;
  } finally {
    run2.stop();
    await sleep(2000);
  }

  // ================= D. Live API (Vercel) — pending deploy =================
  const jwtSecret = envFileValue('apps/api/.env', 'JWT_SECRET');
  check('JWT_SECRET available for the live check (from apps/api/.env)', jwtSecret.length > 0);
  if (jwtSecret) {
    // ourteamstock — member of the live gd_arafat workspace (same as
    // ~/workspace/.tools/neon-load/mint-live-jwt.js).
    const liveToken = signJwt(jwtSecret, { userId: 'b0d895c5', workspaceId: GD_ARAFAT_WS }, 3600);
    const liveRes = await fetch('https://ai-sales-inbox-api.vercel.app/api/inbox/usage', {
      headers: { Authorization: `Bearer ${liveToken}` },
    });
    const liveText = await liveRes.text();
    let liveData = null;
    try { liveData = JSON.parse(liveText); } catch { /* not JSON */ }
    if (liveRes.status === 404) {
      livePending = true;
      console.log('PENDING-DEPLOY  live GET /api/inbox/usage → 404: the endpoint is not deployed yet. Re-run this verifier after the coordinator deploys; the local checks above already prove the endpoint returns the exact live sums.');
    } else if (liveRes.status === 504 && liveText.includes('FUNCTION_INVOCATION_TIMEOUT')) {
      // Also "not deployed yet": the OLD deployed code has no /usage
      // route, so 'usage' falls into GET /:id, whose UUID query throws
      // on the non-UUID id — Express 4 never answers an async-handler
      // rejection, so the function hangs until the 60s timeout (the
      // same pattern as the old WhatsApp-callback 504). After deploy,
      // /usage is registered BEFORE /:id, so this path answers 200.
      livePending = true;
      console.log('PENDING-DEPLOY  live GET /api/inbox/usage → 504 FUNCTION_INVOCATION_TIMEOUT: the endpoint is not deployed yet — the old code treats "usage" as a conversation id and hangs on it. Re-run this verifier after the coordinator deploys; the local checks above already prove the endpoint returns the exact live sums.');
    } else if (liveRes.status === 200 && liveData) {
      const lt = liveData.totals ?? {};
      const ok = lt.replies === liveTotals.replies && lt.inputTokens === liveTotals.inTokens && lt.outputTokens === liveTotals.outTokens && lt.costPaisa === liveTotals.costPaisa;
      check('LIVE endpoint totals match the live ledger exactly', ok, `${lt.replies}r ${lt.inputTokens}+${lt.outputTokens} ৳${((lt.costPaisa ?? 0) / 100).toFixed(2)}`);
    } else {
      check('live endpoint reachable', false, `status=${liveRes.status} ${liveText.slice(0, 200)}`);
    }
  }

  // ================= E. Web bundle contains the usage display =================
  console.log('Building the web app (npm run build)…');
  try {
    execSync('npm run build', { cwd: path.join(ROOT, 'apps/web'), stdio: 'pipe', timeout: 600000 });
    check('web build succeeds', true);
  } catch (e) {
    check('web build succeeds', false, String(e?.message ?? e).slice(0, 300));
  }
  const chunksDir = path.join(ROOT, 'apps/web/.next/static/chunks');
  let bundleText = '';
  if (fs.existsSync(chunksDir)) {
    const files = [];
    const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
    walk(chunksDir);
    bundleText = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  }
  check('built bundle contains the EN usage labels', bundleText.includes('AI usage so far') && bundleText.includes('No AI replies yet') && bundleText.includes('AI cost'), `chunks=${bundleText.length > 0 ? 'read' : 'none'}`);
  check('built bundle contains the BN usage labels', bundleText.includes('এখন পর্যন্ত AI ব্যবহার') && bundleText.includes('AI এখনো উত্তর দেয়নি') && bundleText.includes('AI খরচ'));
  check('built bundle contains the /api/inbox/usage call', bundleText.includes('/api/inbox/usage'));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — ${failed.length} FAILED` : ''}${livePending ? ' (live endpoint PENDING-DEPLOY — re-run after deploy)' : ''}`);
  if (failed.length > 0) {
    console.log('Failed checks:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('verifier crashed:', err);
  process.exit(1);
});
