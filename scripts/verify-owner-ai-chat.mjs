#!/usr/bin/env node
/**
 * Verification for the Owner AI chat — "AI Sales Manager" / "এআই সেলস
 * ম্যানেজার" (2026-11-11, Feature 4).
 *
 * The owner asks the AI about the shop's day in Bengali and the AI must
 * answer from the workspace's REAL database numbers, never invented
 * ones. Stats are computed server-side (orders, ai_usage_ledger,
 * wallet, top products — Asia/Dhaka day) and handed to Gemini
 * (gemini-3.5-flash-lite ONLY) as context; when Gemini is unavailable
 * the route answers with a deterministic Bengali reply built straight
 * from the same stats, so the numbers stay true either way.
 *
 * Checks:
 * - Static: migration 42 table, router gating (requireWorkspaceOwner),
 *   stats queries, deterministic fallback, ledger recording, mount
 *   order (before the platform-owner router), AppShell title entry,
 *   page chips + 403 handling.
 * - Boot (local API on PGlite, ALLOW_OWNER_TEST_HOOKS=true): seed
 *   known orders/ledger/wallet, then (a) the orders question returns
 *   the REAL seeded count/value, (b) the cost question returns the
 *   real seeded sum in taka AND paisa, (c) a fresh workspace with zero
 *   data gets an honest 0, (d) a member gets 403 on GET + POST,
 *   (e) history persists across two messages (second GET shows both),
 *   plus the chat's own ledger rows are recorded (Billing usage list,
 *   cost_paisa 0 — owner chat never deducts the wallet).
 *
 * Gemini: the boot does NOT blank GEMINI_API_KEY — the API loads it
 * from apps/api/.env via dotenv, so a live Gemini call is attempted
 * when the key exists. If the call fails or the key is missing, the
 * deterministic fallback answers instead; the checks assert on the
 * response's `stats` echo (deterministic) AND on the reply text, and
 * report which path answered (usedGemini) without failing on it.
 *
 * Run from the repo root:  node scripts/verify-owner-ai-chat.mjs
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const results = [];
let token = '';

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True when `text` contains the number `n` in Latin or Bengali digits. */
const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
function hasNum(text, n) {
  const s = String(text ?? '');
  const latin = String(n);
  const bn = latin.replace(/[0-9]/g, (d) => BN_DIGITS[Number(d)]);
  return s.includes(latin) || s.includes(bn);
}

function makeApi(base, authToken) {
  return async function api(path, { method = 'GET', body, auth = true, headers = {} } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(auth && authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data, text };
  };
}

async function waitForHealth(base, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(1000);
  }
  return false;
}

function startApi(port, dataDir) {
  const apiProc = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: path.join(ROOT, 'apps/api'),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: {
      ...process.env,
      PORT: String(port),
      USE_PGLITE: 'true',
      PGLITE_DATA_DIR: dataDir,
      JWT_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      ALLOW_OWNER_TEST_HOOKS: 'true',
      // GEMINI_API_KEY is deliberately NOT blanked: the API loads it
      // from apps/api/.env, so a live call is attempted when the key
      // exists; the deterministic fallback covers a missing/slow key.
      GROQ_API_KEY: '',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      META_APP_ID: 'dummy-app-id',
      META_APP_SECRET: 'dummy-meta-secret',
    },
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
  // ---------- Static checks ----------
  const mig42 = fs.readFileSync(path.join(ROOT, 'apps/api/src/db/migrations/42-owner-ai-chat.sql'), 'utf8');
  check('migration 42: owner_ai_chats table (workspace_id, role, content, created_at)', mig42.includes('CREATE TABLE IF NOT EXISTS owner_ai_chats') && mig42.includes('workspace_id UUID NOT NULL') && mig42.includes("role TEXT NOT NULL") && mig42.includes('content TEXT NOT NULL'));

  const chatSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/owner/ai-chat.ts'), 'utf8');
  check('router: requireAuth + requireWorkspaceOwner gate (Task 14 pattern)', chatSrc.includes('requireAuth') && chatSrc.includes('requireWorkspaceOwner'));
  check('router: no platform-owner gate (requireOwner) on this chat', !/requireOwner\s*\(/.test(chatSrc) && !/from '\.\/ownerAuth'/.test(chatSrc));
  check('stats: orders today from orders table (count + SUM total_paisa)', chatSrc.includes('FROM orders WHERE workspace_id = $1 AND created_at >=' ) && chatSrc.includes('SUM(total_paisa)'));
  check('stats: AI cost today = SUM(provider_cost_paisa) from ai_usage_ledger', chatSrc.includes('SUM(provider_cost_paisa)') && chatSrc.includes('FROM ai_usage_ledger'));
  check('stats: wallet balance from workspaces.balance_paisa', chatSrc.includes('balance_paisa FROM workspaces'));
  check('stats: pending orders + top products queried', chatSrc.includes("status = 'pending'") && chatSrc.includes('FROM order_items'));
  check('stats: Dhaka day start (Asia/Dhaka)', chatSrc.includes("timeZone: 'Asia/Dhaka'"));
  check('reply: Gemini via callGeminiMultimodal (plain text, not JSON mode)', chatSrc.includes('callGeminiMultimodal') && !chatSrc.includes('callGemini('));
  check('reply: deterministic stats fallback when Gemini is unavailable', chatSrc.includes('buildStatsReply') && chatSrc.includes('usedGemini'));
  check('reply: prompt forbids inventing numbers, 0 means 0', chatSrc.includes('কোনো সংখ্যা বানাবে না') && chatSrc.includes('০ হলে সোজা ০ বলবে'));
  check('ledger: chat reply recorded with real provider cost, wallet charge 0', chatSrc.includes('INSERT INTO ai_usage_ledger') && chatSrc.includes('provider_cost_paisa') && chatSrc.includes('cost_paisa,\n        provider, included_in_plan, model, provider_cost_paisa'));
  check('history: GET returns workspace messages oldest first', chatSrc.includes("ORDER BY created_at ASC, id ASC LIMIT 50"));

  const indexSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/index.ts'), 'utf8');
  check('mount: /api/owner/ai-chat mounted', indexSrc.includes("app.use('/api/owner/ai-chat', ownerAiChatRouter)"));
  check('mount: ai-chat mounts BEFORE the platform-owner /api/owner router', indexSrc.indexOf("app.use('/api/owner/ai-chat'") < indexSrc.indexOf("app.use('/api/owner', ownerRouter)"));

  const shellSrc = fs.readFileSync(path.join(ROOT, 'apps/web/components/AppShell.tsx'), 'utf8');
  check('AppShell: /ai-manager title "AI Sales Manager" / "এআই সেলস ম্যানেজার"', shellSrc.includes('"/ai-manager"') && shellSrc.includes('AI Sales Manager') && shellSrc.includes('এআই সেলস ম্যানেজার'));

  const pageSrc = fs.readFileSync(path.join(ROOT, 'apps/web/app/ai-manager/page.tsx'), 'utf8');
  check('page: 3 example question chips', pageSrc.includes('আজকে কতগুলো অর্ডার হয়েছে?') && pageSrc.includes('আজকে কত টাকা খরচ হয়েছে?') && pageSrc.includes('পেন্ডিং অর্ডার কতগুলো?'));
  check('page: 403 shows owner-only notice (not a generic error)', pageSrc.includes('notOwner') && pageSrc.includes('এটা শুধু দোকানের মালিক দেখতে পারেন'));
  check('page: loads history on open + sends via POST', pageSrc.includes('api.get<{ messages: ChatMessage[] }>(" /api/owner/ai-chat")'.replace(' ', '')) || (pageSrc.includes('api.get') && pageSrc.includes('/api/owner/ai-chat') && pageSrc.includes('api.post')));

  // ---------- Boot: local API on PGlite ----------
  const stamp = Date.now();
  const port = 4027;
  const dataDir = '.pglite-data-aichat';
  const run = startApi(port, dataDir);
  process.on('exit', run.stop);
  try {
    const up = await waitForHealth(`http://localhost:${port}`);
    check('boot: API starts', up, up ? '' : run.log().slice(-500));
    if (!up) return;
    const api = makeApi(`http://localhost:${port}`, null);
    const ownerApi = (t) => makeApi(`http://localhost:${port}`, t);

    // Owner 1: the shop owner. Seed known numbers:
    // 3 orders today (50000 pending + 75000 delivered + 25000 pending
    // = 150000 paisa = ৳1500), ledger 9+14+7 = 30 paisa, wallet ৳1000.
    const signup = await api('/api/auth/signup', {
      method: 'POST', auth: false,
      body: { name: 'AI Chat Owner', email: `aichat+${stamp}@example.com`, password: 'verify1234', workspaceName: 'AI Chat Test Shop' },
    });
    check('boot: owner signup', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
    token = signup.data?.token ?? '';
    const me = ownerApi(token);
    const seed = await me('/api/owner/ai-chat/_test/seed', {
      method: 'POST',
      body: {
        walletBalancePaisa: 100000,
        orders: [
          { totalPaisa: 50000, status: 'pending', productName: 'Panjabi', productPricePaisa: 50000, quantity: 1 },
          { totalPaisa: 75000, status: 'delivered', productName: 'Panjabi', productPricePaisa: 25000, quantity: 3 },
          { totalPaisa: 25000, status: 'pending', productName: 'T-Shirt', productPricePaisa: 25000, quantity: 1 },
        ],
        ledger: [
          { providerCostPaisa: 9 },
          { providerCostPaisa: 14 },
          { providerCostPaisa: 7 },
        ],
      },
    });
    check('boot: seed known data (3 orders, 30 paisa ledger, ৳1000 wallet)', seed.status === 200 && seed.data?.seeded?.ordersInserted === 3 && seed.data?.seeded?.ledgerInserted === 3, `status=${seed.status} ${JSON.stringify(seed.data ?? {}).slice(0, 200)}`);

    // (a) Orders question — REAL seeded count/value.
    const qOrders = await me('/api/owner/ai-chat', { method: 'POST', body: { message: 'আজকে কতগুলো অর্ডার হয়েছে?' } });
    check('(a) orders question → 200 + reply', qOrders.status === 200 && typeof qOrders.data?.reply === 'string' && qOrders.data.reply.length > 0, `status=${qOrders.status}`);
    const s1 = qOrders.data?.stats ?? {};
    check('(a) stats echo: 3 orders today, value 150000 paisa', s1.ordersTodayCount === 3 && s1.ordersTodayValuePaisa === 150000, JSON.stringify({ c: s1.ordersTodayCount, v: s1.ordersTodayValuePaisa }));
    check('(a) stats echo: AI cost today is exactly the seeded 30 paisa (no prior chat)', s1.aiCostTodayPaisa === 30, `aiCostTodayPaisa=${s1.aiCostTodayPaisa}`);
    check('(a) stats echo: wallet 100000 paisa, pending 2 orders', s1.walletBalancePaisa === 100000 && s1.pendingCount === 2, JSON.stringify({ w: s1.walletBalancePaisa, p: s1.pendingCount }));
    check('(a) reply states the real count 3 (not invented)', hasNum(qOrders.data?.reply, 3), JSON.stringify((qOrders.data?.reply ?? '').slice(0, 200)));
    check('(a) reply states the real total ৳1500', hasNum(qOrders.data?.reply, 1500), JSON.stringify((qOrders.data?.reply ?? '').slice(0, 200)));
    console.log(`      (info) orders reply usedGemini=${qOrders.data?.usedGemini} aiCostPaisa=${qOrders.data?.aiCostPaisa}`);
    const costAfterQ1 = Number(qOrders.data?.aiCostPaisa ?? 0);

    // (b) Cost question — real seeded sum in taka AND paisa.
    const qCost = await me('/api/owner/ai-chat', { method: 'POST', body: { message: 'আজকে কত টাকা খরচ হয়েছে?' } });
    check('(b) cost question → 200 + reply', qCost.status === 200 && typeof qCost.data?.reply === 'string', `status=${qCost.status}`);
    const s2 = qCost.data?.stats ?? {};
    // The first chat reply's own provider cost is real AI cost today,
    // so the second stats read is seeded 30 + that reply's cost.
    check('(b) stats echo: AI cost today = 30 seeded + first chat reply cost', s2.aiCostTodayPaisa === 30 + costAfterQ1, `aiCostTodayPaisa=${s2.aiCostTodayPaisa} expected=${30 + costAfterQ1}`);
    check('(b) reply states the cost in paisa (30 + first reply cost)', hasNum(qCost.data?.reply, s2.aiCostTodayPaisa), JSON.stringify((qCost.data?.reply ?? '').slice(0, 200)));
    check('(b) reply states the cost in taka too (0.30+ — "0." present)', /0[.,]/.test(String(qCost.data?.reply ?? '')) || hasNum(qCost.data?.reply, 0.3), JSON.stringify((qCost.data?.reply ?? '').slice(0, 200)));
    console.log(`      (info) cost reply usedGemini=${qCost.data?.usedGemini} aiCostPaisa=${qCost.data?.aiCostPaisa}`);

    // Pending question — also checks the pending stat path.
    const qPending = await me('/api/owner/ai-chat', { method: 'POST', body: { message: 'পেন্ডিং অর্ডার কতগুলো?' } });
    check('pending question → 200, stats pendingCount 2', qPending.status === 200 && qPending.data?.stats?.pendingCount === 2, `status=${qPending.status} pending=${qPending.data?.stats?.pendingCount}`);
    check('pending reply states the real count 2', hasNum(qPending.data?.reply, 2), JSON.stringify((qPending.data?.reply ?? '').slice(0, 200)));

    // (e) History persists across messages.
    const history = await me('/api/owner/ai-chat');
    const msgs = history.data?.messages ?? [];
    check('(e) history GET → 200 with 6 messages (3 user + 3 assistant)', history.status === 200 && msgs.length === 6, `status=${history.status} count=${msgs.length}`);
    check('(e) history alternates user/assistant in order', msgs.length === 6 && msgs.every((m, i) => m.role === (i % 2 === 0 ? 'user' : 'assistant')), JSON.stringify(msgs.map((m) => m.role)));
    check('(e) history holds the real questions asked', msgs.filter((m) => m.role === 'user').map((m) => m.content).join('|').includes('কতগুলো অর্ডার') && msgs.filter((m) => m.role === 'user').map((m) => m.content).join('|').includes('কত টাকা খরচ'), JSON.stringify(msgs.map((m) => m.content).slice(0, 3)));

    // Ledger: the chat's own replies are recorded (Billing usage list).
    const billing = await me('/api/billing');
    const usage = billing.data?.usage ?? [];
    const chatRows = usage.filter((r) => r.conversation_id === null && (r.model === 'gemini-3.5-flash-lite' || r.provider === 'demo'));
    check('ledger: chat replies recorded in ai_usage_ledger (Billing usage)', billing.status === 200 && chatRows.length >= 1, `status=${billing.status} chatRows=${chatRows.length} usageTotal=${usage.length}`);
    check('ledger: chat rows never deduct the wallet (cost_paisa 0)', chatRows.length >= 1 && chatRows.every((r) => Number(r.cost_paisa) === 0), JSON.stringify(chatRows.map((r) => r.cost_paisa)));
    const walletAfter = await me('/api/billing');
    check('ledger: wallet balance unchanged by owner chat (still ৳1000)', walletAfter.data?.balancePaisa === 100000, `balancePaisa=${walletAfter.data?.balancePaisa}`);

    // (c) Zero data — a fresh workspace gets an honest 0.
    const signup2 = await api('/api/auth/signup', {
      method: 'POST', auth: false,
      body: { name: 'Empty Owner', email: `aichat-empty+${stamp}@example.com`, password: 'verify1234', workspaceName: 'Empty Test Shop' },
    });
    check('(c) empty-workspace signup', signup2.status === 201 && !!signup2.data?.token, `status=${signup2.status}`);
    const emptyApi = ownerApi(signup2.data?.token ?? '');
    const qEmpty = await emptyApi('/api/owner/ai-chat', { method: 'POST', body: { message: 'আজকে কতগুলো অর্ডার হয়েছে?' } });
    check('(c) zero-data question → 200', qEmpty.status === 200, `status=${qEmpty.status}`);
    const s0 = qEmpty.data?.stats ?? {};
    check('(c) zero-data stats are all 0', s0.ordersTodayCount === 0 && s0.ordersTodayValuePaisa === 0 && s0.aiCostTodayPaisa === 0 && s0.pendingCount === 0, JSON.stringify(s0));
    check('(c) zero-data reply honestly says 0', hasNum(qEmpty.data?.reply, 0), JSON.stringify((qEmpty.data?.reply ?? '').slice(0, 200)));

    // (d) Member (non-owner) gets 403 on both endpoints.
    const invite = await me('/api/team/invites', { method: 'POST', body: { email: `aichat-member+${stamp}@example.com`, role: 'member' } });
    check('(d) owner creates a member invite', invite.status === 201, `status=${invite.status} ${JSON.stringify(invite.data ?? {}).slice(0, 150)}`);
    const invitesList = await me('/api/team/invites');
    const inv = (invitesList.data?.invites ?? []).find((i) => i.email === `aichat-member+${stamp}@example.com`);
    const inviteToken = (inv?.inviteLink ?? '').split('invite=')[1] ?? '';
    check('(d) invite link carries a token', !!inviteToken, `link=${String(inv?.inviteLink ?? '').slice(0, 60)}`);
    const accept = await api('/api/auth/accept-invite', {
      method: 'POST', auth: false,
      body: { token: inviteToken, name: 'Team Member', password: 'verify1234' },
    });
    check('(d) member accepts invite (role member)', accept.status === 201 && accept.data?.role === 'member', `status=${accept.status} role=${accept.data?.role}`);
    const memberApi = ownerApi(accept.data?.token ?? '');
    const memberGet = await memberApi('/api/owner/ai-chat');
    check('(d) member GET history → 403', memberGet.status === 403, `status=${memberGet.status}`);
    const memberPost = await memberApi('/api/owner/ai-chat', { method: 'POST', body: { message: 'আজকে কতগুলো অর্ডার হয়েছে?' } });
    check('(d) member POST message → 403', memberPost.status === 403, `status=${memberPost.status}`);
    const memberSeed = await memberApi('/api/owner/ai-chat/_test/seed', { method: 'POST', body: {} });
    check('(d) member cannot use the test seed hook either (403)', memberSeed.status === 403, `status=${memberSeed.status}`);

    // Bad input: empty message → 400, no token → 401.
    const emptyMsg = await me('/api/owner/ai-chat', { method: 'POST', body: { message: '   ' } });
    check('validation: empty message → 400', emptyMsg.status === 400, `status=${emptyMsg.status}`);
    const noAuth = await api('/api/owner/ai-chat');
    check('validation: no token → 401', noAuth.status === 401, `status=${noAuth.status}`);
  } finally {
    run.stop();
    await sleep(2000);
    try { fs.rmSync(path.join(ROOT, 'apps/api', dataDir), { recursive: true, force: true }); } catch { /* already gone */ }
  }
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length > 0) {
      console.log('FAILED:');
      for (const f of failed) console.log(` - ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
      process.exit(1);
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error('Verifier crashed:', err);
    process.exit(1);
  });
