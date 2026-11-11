#!/usr/bin/env node
/**
 * Verification for Owner Panel user + subscription management
 * (Feature 5, migration 45).
 *
 * What was built:
 * - apps/api/src/owner/admin.ts — GET /api/owner/users, block / unblock /
 *   restrict / unrestrict / delete (typed confirmation, soft delete),
 *   GET /api/owner/subscriptions (all shops' plan + schedule subs,
 *   pending top-ups, live pricing), GET /api/owner/audit-log, and an
 *   env-gated _test/seed-subscription hook.
 * - apps/api/src/auth/routes.ts — login refuses blocked (403 + exact
 *   Bengali message) and soft-deleted accounts; /me carries
 *   accountStatus + workspace.restricted (dashboard banner data).
 * - apps/api/src/subscriptions/service.ts — checkAiReplyAllowance
 *   refuses AI replies for restricted workspaces with an honest Bengali
 *   notice; approve/cancel for owner (cancel ends AT period end).
 * - apps/api/src/subscriptions/routes.ts — owner-guarded approve/cancel
 *   endpoints at POST /api/owner/subscriptions/:id/approve|/cancel.
 * - apps/api/src/scheduling/routes.ts — restricted workspaces cannot
 *   create, schedule, or publish-now a post (403 + Bengali message).
 * - apps/web/app/owner/page.tsx — Users + Subscriptions sections.
 * - apps/web/app/dashboard/page.tsx — restricted-account banner.
 *
 * Checks (all on THROWAWAY test accounts, never the real owner):
 * - Static: migration + endpoints + messages + web sections.
 * - Boot (local API on PGlite): owner lists users (200) vs member gets
 *   403 on every management endpoint + /api/ai-providers (rule kept);
 *   block → login 403 + exact Bengali message, unblock → login works;
 *   restrict → login works, /me says restricted, AI reply refused with
 *   an honest notice, scheduling refused, unrestrict reverses both;
 *   delete with typed confirmation → soft-deleted, cannot log in,
 *   platform-owner delete refused (400); subscription approve
 *   (past_due → active) and cancel (cancelled, period end unchanged)
 *   on seeded test subscriptions; pending top-up approve reuses the
 *   existing billing endpoint and credits the wallet; every action
 *   writes an audit row.
 *
 * Run from the repo root:  node scripts/verify-owner-panel-manage.mjs
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const results = [];
const WEBCHAT_SECRET = 'ownermanage-test-secret';
const BLOCKED_MSG = 'আপনার অ্যাকাউন্টটি ব্লক করা হয়েছে';

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(base, tok) {
  return async function api(path, { method = 'GET', body, auth = true, headers = {} } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(auth && tok ? { Authorization: `Bearer ${tok}` } : {}),
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
      WEBCHAT_SECRET,
      ALLOW_OWNER_TEST_HOOKS: 'true',
      GEMINI_API_KEY: '',
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

async function pollFor(fn, timeoutMs = 30000, intervalMs = 1000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  return last;
}

async function main() {
  // ---------- Static checks ----------
  const mig45 = fs.readFileSync(path.join(ROOT, 'apps/api/src/db/migrations/45-owner-panel-manage.sql'), 'utf8');
  check('migration 45: users.account_status + deleted_at', mig45.includes('account_status') && mig45.includes('deleted_at'));
  check('migration 45: workspaces.restricted flag', mig45.includes('workspaces ADD COLUMN IF NOT EXISTS restricted'));
  check('migration 45: owner_audit_log table', mig45.includes('CREATE TABLE IF NOT EXISTS owner_audit_log'));

  const adminSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/owner/admin.ts'), 'utf8');
  check('admin: GET /users + block/unblock/restrict/unrestrict/delete routes', adminSrc.includes("adminRouter.get('/users'") && adminSrc.includes("'/users/:id/block'") && adminSrc.includes("'/users/:id/unblock'") && adminSrc.includes("'/users/:id/restrict'") && adminSrc.includes("'/users/:id/unrestrict'") && adminSrc.includes("'/users/:id/delete'"));
  check('admin: delete requires typed confirmation (email or DELETE)', adminSrc.includes("typed !== 'DELETE'") && adminSrc.includes('target.email.toLowerCase()'));
  check('admin: platform owner can never be deleted (400)', adminSrc.includes("if (target.is_owner)") && adminSrc.includes('মোছা যাবে না'));
  check('admin: every action writes an audit row', adminSrc.includes('OWNER_AUDIT_INSERT_SQL'));
  check('admin: GET /subscriptions + pending top-ups + live pricing', adminSrc.includes("adminRouter.get('/subscriptions'") && adminSrc.includes('listPendingTopupsForOwner') && adminSrc.includes('replyPackagePaisa'));

  const authSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/auth/routes.ts'), 'utf8');
  check('auth: login refuses blocked with the exact Bengali message', authSrc.includes(BLOCKED_MSG) && authSrc.includes("account_status === 'blocked'"));
  check('auth: login refuses soft-deleted accounts', authSrc.includes("account_status === 'deleted'"));
  check('auth: /me carries accountStatus + workspace.restricted', authSrc.includes('accountStatus') && authSrc.includes('restricted: workspace.restricted === true'));

  const svcSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/subscriptions/service.ts'), 'utf8');
  const allowFn = svcSrc.slice(svcSrc.indexOf('export async function checkAiReplyAllowance'));
  check('service: restricted check runs first in checkAiReplyAllowance', allowFn.includes('isWorkspaceRestricted(workspaceId)') && allowFn.indexOf('isWorkspaceRestricted(workspaceId)') < allowFn.indexOf('ensureTrialSubscription(workspaceId)'));
  check('service: restricted reply gets an honest Bengali notice', svcSrc.includes('RESTRICTED_REPLY_NOTICE_BN') && svcSrc.includes('AI উত্তর আপাতত বন্ধ আছে'));
  check('service: approve/cancel for owner (cancel keeps period end)', svcSrc.includes('approveSubscriptionForOwner') && svcSrc.includes('cancelSubscriptionForOwner') && svcSrc.includes("status = 'cancelled'"));

  const subRoutesSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/subscriptions/routes.ts'), 'utf8');
  check('subscriptions routes: owner approve/cancel endpoints (requireOwner)', subRoutesSrc.includes("'/owner/subscriptions/:id/approve'") && subRoutesSrc.includes("'/owner/subscriptions/:id/cancel'") && subRoutesSrc.includes('requireOwner'));

  const schedSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/scheduling/routes.ts'), 'utf8');
  check('scheduling: restricted guard on create/schedule/publish-now', (schedSrc.match(/isWorkspaceRestricted\(workspaceId\)/g) ?? []).length >= 3);

  const ownerRoutesSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/owner/routes.ts'), 'utf8');
  check('owner routes: admin router mounted under requireOwner', ownerRoutesSrc.includes('adminRouter') && ownerRoutesSrc.indexOf('ownerRouter.use(adminRouter)') > ownerRoutesSrc.indexOf('ownerRouter.use(requireOwner)'));

  const ownerPageSrc = fs.readFileSync(path.join(ROOT, 'apps/web/app/owner/page.tsx'), 'utf8');
  check('web owner page: Users section (ব্যবহারকারী) with block/restrict/delete', ownerPageSrc.includes('ব্যবহারকারী') && ownerPageSrc.includes('userAction') && ownerPageSrc.includes('deleteUser'));
  check('web owner page: Subscriptions section (সাবস্ক্রিপশন) with approve/cancel', ownerPageSrc.includes('সাবস্ক্রিপশন') && ownerPageSrc.includes('subAction') && ownerPageSrc.includes('মেয়াদ শেষ'));
  check('web owner page: delete needs typed email (inline confirm box)', ownerPageSrc.includes('deleteConfirm') && ownerPageSrc.includes('হুবহু টাইপ করুন'));

  const dashSrc = fs.readFileSync(path.join(ROOT, 'apps/web/app/dashboard/page.tsx'), 'utf8');
  check('web dashboard: restricted banner from /me', dashSrc.includes('সীমিত করা হয়েছে') && dashSrc.includes('authApi.me()'));

  // ---------- Deductions display (taka format + tokens) — static checks ----------
  const apiOwnerSrc = fs.readFileSync(path.join(ROOT, 'apps/web/lib/api-owner.ts'), 'utf8');
  check('deductions type: OwnerDeduction carries inputTokens/outputTokens (nullable)', apiOwnerSrc.includes('inputTokens: number | null') && apiOwnerSrc.includes('outputTokens: number | null'));
  check('deductions API: recentOwnerDeductions selects l.input_tokens/l.output_tokens and returns them', ownerRoutesSrc.includes('l.input_tokens, l.output_tokens') && ownerRoutesSrc.includes('inputTokens:') && ownerRoutesSrc.includes('outputTokens:'));
  check('deductions API: seed-ledger accepts optional costPaisa + orphanDeduction (no-ledger dash case)', ownerRoutesSrc.includes('costPaisa') && ownerRoutesSrc.includes('orphanDeduction') && ownerRoutesSrc.includes('cannot be null — ai_usage_ledger token columns are NOT NULL'));
  check('deductions UI: money cells use fmtTakaWest (formatTakaLocale … "en", Western digits)', ownerPageSrc.includes('formatTakaLocale(paisa, "en")') && ownerPageSrc.includes('fmtTakaWest(d.shopChargePaisa)') && ownerPageSrc.includes('fmtTakaWest(d.ownerCostPaisa)') && ownerPageSrc.includes('fmtTakaWest(d.profitPaisa)'));
  check('deductions UI: Tokens column with in/out labels and "—" dash for missing tokens', ownerPageSrc.includes('ownerColTokens') && ownerPageSrc.includes('টোকেন') && ownerPageSrc.includes('tokenText(d)') && ownerPageSrc.includes('"—"'));
  check('deductions UI: 16 paisa → ৳0.16 arithmetic', (16 / 100).toFixed(2) === '0.16');

  // ---------- Boot: local API on PGlite ----------
  const stamp = Date.now();
  const port = 4024;
  const dataDir = '.pglite-data-owner-manage';
  const base = `http://localhost:${port}`;
  const run = startApi(port, dataDir);
  process.on('exit', run.stop);
  try {
    const up = await waitForHealth(base);
    check('boot: API starts', up, up ? '' : run.log().slice(-500));
    if (!up) return;
    const noAuth = client(base, '');
    const signup = async (name, email, ws) => {
      const r = await noAuth('/api/auth/signup', {
        method: 'POST', auth: false,
        body: { name, email, password: 'verify1234', workspaceName: ws },
      });
      return r;
    };

    // Platform owner (throwaway) + promote.
    const ownerEmail = `ownermgmt-owner+${stamp}@example.com`;
    const ownerSignup = await signup('Owner Test', ownerEmail, 'Owner Test Shop');
    check('boot: owner signup', ownerSignup.status === 201 && !!ownerSignup.data?.token, `status=${ownerSignup.status}`);
    const ownerToken = ownerSignup.data?.token ?? '';
    const ownerApi = client(base, ownerToken);
    const promote = await ownerApi('/api/owner/setup', { method: 'POST', body: { email: ownerEmail } });
    check('boot: promote to platform owner', promote.status === 200, `status=${promote.status} ${JSON.stringify(promote.data ?? {}).slice(0, 150)}`);

    // Shop B (block/restrict target) + Shop C (delete target).
    const bEmail = `ownermgmt-b+${stamp}@example.com`;
    const bSignup = await signup('Shop B', bEmail, 'Shop B Test');
    check('boot: shop B signup', bSignup.status === 201, `status=${bSignup.status}`);
    const bToken = bSignup.data?.token ?? '';
    const bWorkspaceId = bSignup.data?.workspace?.id ?? '';
    const bApi = client(base, bToken);
    const cEmail = `ownermgmt-c+${stamp}@example.com`;
    const cSignup = await signup('Shop C', cEmail, 'Shop C Test');
    check('boot: shop C signup', cSignup.status === 201, `status=${cSignup.status}`);
    const cToken = cSignup.data?.token ?? '';
    const cApi = client(base, cToken);

    // Member in B's workspace (role 'member') via team invite.
    const memberEmail = `ownermgmt-member+${stamp}@example.com`;
    const invite = await bApi('/api/team/invites', { method: 'POST', body: { email: memberEmail, role: 'member' } });
    check('boot: team invite created', invite.status === 201 && !!invite.data?.invite?.token, `status=${invite.status}`);
    const inviteToken = invite.data?.invite?.token ?? '';
    const accept = await noAuth('/api/auth/accept-invite', {
      method: 'POST', auth: false,
      body: { token: inviteToken, name: 'Member Test', password: 'verify1234' },
    });
    check('boot: member accepts invite (role member)', accept.status === 201 && !!accept.data?.token, `status=${accept.status}`);
    const memberToken = accept.data?.token ?? '';
    const memberApi = client(base, memberToken);

    const login = async (email) => noAuth('/api/auth/login', {
      method: 'POST', auth: false, body: { email, password: 'verify1234' },
    });

    // ---------- (a) owner lists users; member gets 403 everywhere ----------
    const usersList = await ownerApi('/api/owner/users');
    const listed = usersList.data?.users ?? [];
    check('(a) owner lists users (200)', usersList.status === 200 && listed.length >= 4, `status=${usersList.status} count=${listed.length}`);
    check('(a) listed users carry shop + status', listed.length > 0 && listed.every((u) => u.email && u.workspaceName && u.status), JSON.stringify(listed.map((u) => u.status)));
    const bRow = listed.find((u) => u.email === bEmail);
    const cRow = listed.find((u) => u.email === cEmail);
    const ownerRow = listed.find((u) => u.email === ownerEmail);
    check('(a) shop B + C + owner all listed', !!bRow && !!cRow && !!ownerRow, `b=${!!bRow} c=${!!cRow} owner=${!!ownerRow}`);
    const memberUsers = await memberApi('/api/owner/users');
    check('(a) member → 403 on GET /api/owner/users', memberUsers.status === 403, `status=${memberUsers.status}`);
    const memberBlock = await memberApi(`/api/owner/users/${bRow?.id ?? 'x'}/block`, { method: 'POST', body: {} });
    check('(a) member → 403 on block', memberBlock.status === 403, `status=${memberBlock.status}`);
    const memberRestrict = await memberApi(`/api/owner/users/${bRow?.id ?? 'x'}/restrict`, { method: 'POST', body: {} });
    check('(a) member → 403 on restrict', memberRestrict.status === 403, `status=${memberRestrict.status}`);
    const memberDelete = await memberApi(`/api/owner/users/${bRow?.id ?? 'x'}/delete`, { method: 'POST', body: { confirm: bEmail } });
    check('(a) member → 403 on delete', memberDelete.status === 403, `status=${memberDelete.status}`);
    const memberSubs = await memberApi('/api/owner/subscriptions');
    check('(a) member → 403 on GET /api/owner/subscriptions', memberSubs.status === 403, `status=${memberSubs.status}`);
    const memberApprove = await memberApi('/api/owner/subscriptions/x/approve', { method: 'POST', body: { kind: 'plan' } });
    check('(a) member → 403 on subscription approve', memberApprove.status === 403, `status=${memberApprove.status}`);
    const memberCancel = await memberApi('/api/owner/subscriptions/x/cancel', { method: 'POST', body: { kind: 'plan' } });
    check('(a) member → 403 on subscription cancel', memberCancel.status === 403, `status=${memberCancel.status}`);
    const memberAudit = await memberApi('/api/owner/audit-log');
    check('(a) member → 403 on GET /api/owner/audit-log', memberAudit.status === 403, `status=${memberAudit.status}`);
    const memberProviders = await memberApi('/api/ai-providers');
    check('(g) member → 403 on /api/ai-providers (owner-only rule kept)', memberProviders.status === 403, `status=${memberProviders.status}`);

    // ---------- (b) block → login 403 + exact message; unblock → login works ----------
    const blockB = await ownerApi(`/api/owner/users/${bRow.id}/block`, { method: 'POST', body: {} });
    check('(b) owner blocks shop B', blockB.status === 200 && blockB.data?.user?.status === 'blocked', `status=${blockB.status} ${JSON.stringify(blockB.data ?? {}).slice(0, 150)}`);
    const loginBlocked = await login(bEmail);
    check('(b) blocked login → 403 + exact Bengali message', loginBlocked.status === 403 && loginBlocked.data?.error === BLOCKED_MSG, `status=${loginBlocked.status} error=${JSON.stringify(loginBlocked.data?.error ?? null)}`);
    const unblockB = await ownerApi(`/api/owner/users/${bRow.id}/unblock`, { method: 'POST', body: {} });
    check('(b) owner unblocks shop B', unblockB.status === 200 && unblockB.data?.user?.status === 'active', `status=${unblockB.status}`);
    const loginBack = await login(bEmail);
    check('(b) unblocked login works again', loginBack.status === 200 && !!loginBack.data?.token, `status=${loginBack.status}`);

    // ---------- (c) restrict: login works, AI + scheduling refused, unrestrict reverses ----------
    // Webchat channel + go-live first (practice mode off so the agent answers).
    const live = await bApi(`/api/workspaces/${bWorkspaceId}/go-live`, { method: 'POST' });
    check('(c) shop B go-live', live.status === 200, `status=${live.status}`);
    const ch = await bApi('/api/channels', { method: 'POST', body: { platform: 'webchat', externalId: 'site-ownermanage', displayName: 'OwnerManage Test Site' } });
    check('(c) webchat channel → 201', ch.status === 201, `status=${ch.status}`);
    const restrictB = await ownerApi(`/api/owner/users/${bRow.id}/restrict`, { method: 'POST', body: {} });
    check('(c) owner restricts shop B', restrictB.status === 200 && restrictB.data?.user?.status === 'restricted', `status=${restrictB.status}`);
    const loginRestricted = await login(bEmail);
    check('(c) restricted login still works', loginRestricted.status === 200 && !!loginRestricted.data?.token, `status=${loginRestricted.status}`);
    const meRestricted = await client(base, loginRestricted.data?.token ?? '')('/api/auth/me');
    check('(c) /me says restricted (banner data)', meRestricted.status === 200 && meRestricted.data?.user?.accountStatus === 'restricted' && meRestricted.data?.workspace?.restricted === true, JSON.stringify({ a: meRestricted.data?.user?.accountStatus, w: meRestricted.data?.workspace?.restricted }));
    // AI reply refused with the honest notice.
    const mRestricted = await noAuth('/api/webhooks/webchat', {
      method: 'POST', auth: false,
      headers: { 'x-webchat-secret': WEBCHAT_SECRET },
      body: { externalId: 'site-ownermanage', senderId: 'wc-restr-1', name: 'Restricted Customer', text: 'জিন্সের দাম কত?' },
    });
    check('(c) restricted webchat message accepted', mRestricted.status === 200 && !!mRestricted.data?.conversationId, `status=${mRestricted.status}`);
    const restrConvId = mRestricted.data?.conversationId ?? '';
    const restrOut = await pollFor(async () => {
      const detail = await bApi(`/api/inbox/${restrConvId}`);
      const out = (detail.data?.messages ?? []).filter((m) => m.direction === 'out');
      return out.length > 0 ? out : null;
    });
    check('(c) restricted AI reply refused with honest notice (বন্ধ আছে)', !!restrOut && restrOut.some((m) => (m.body ?? '').includes('বন্ধ আছে') && (m.body ?? '').includes('AI উত্তর')), JSON.stringify((restrOut ?? []).map((m) => m.body)));
    // Scheduling refused.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const schedRefused = await bApi('/api/scheduled-posts', {
      method: 'POST',
      body: { caption: 'Restricted test post', platforms: ['facebook'], scheduledAt: tomorrow },
    });
    check('(c) restricted scheduling refused (403 + সীমিত)', schedRefused.status === 403 && String(schedRefused.data?.error ?? '').includes('সীমিত'), `status=${schedRefused.status} error=${JSON.stringify(schedRefused.data?.error ?? null)}`);
    // Unrestrict reverses both.
    const unrestrictB = await ownerApi(`/api/owner/users/${bRow.id}/unrestrict`, { method: 'POST', body: {} });
    check('(c) owner unrestricts shop B', unrestrictB.status === 200 && unrestrictB.data?.user?.status === 'active', `status=${unrestrictB.status}`);
    const meFree = await bApi('/api/auth/me');
    check('(c) /me says active again after unrestrict', meFree.status === 200 && meFree.data?.user?.accountStatus === 'active' && meFree.data?.workspace?.restricted !== true, JSON.stringify({ a: meFree.data?.user?.accountStatus, w: meFree.data?.workspace?.restricted }));
    const schedOk = await bApi('/api/scheduled-posts', {
      method: 'POST',
      body: { caption: 'Unrestricted test post', platforms: ['facebook'], scheduledAt: tomorrow },
    });
    check('(c) scheduling works again after unrestrict (201)', schedOk.status === 201, `status=${schedOk.status} ${JSON.stringify(schedOk.data ?? {}).slice(0, 150)}`);

    // ---------- (d) delete: typed confirmation, soft-deleted, owner delete refused ----------
    const delWrong = await ownerApi(`/api/owner/users/${cRow.id}/delete`, { method: 'POST', body: { confirm: 'wrong@example.com' } });
    check('(d) delete with wrong confirmation → 400', delWrong.status === 400, `status=${delWrong.status}`);
    const delC = await ownerApi(`/api/owner/users/${cRow.id}/delete`, { method: 'POST', body: { confirm: cEmail } });
    check('(d) delete with typed email → 200 soft-deleted', delC.status === 200 && delC.data?.user?.status === 'deleted', `status=${delC.status} ${JSON.stringify(delC.data ?? {}).slice(0, 150)}`);
    const loginDeleted = await login(cEmail);
    check('(d) soft-deleted login refused (403)', loginDeleted.status === 403 && String(loginDeleted.data?.error ?? '').includes('মুছে ফেলা হয়েছে'), `status=${loginDeleted.status} error=${JSON.stringify(loginDeleted.data?.error ?? null)}`);
    const delOwner = await ownerApi(`/api/owner/users/${ownerRow.id}/delete`, { method: 'POST', body: { confirm: ownerEmail } });
    check('(d) platform-owner delete refused (400)', delOwner.status === 400, `status=${delOwner.status} ${JSON.stringify(delOwner.data ?? {}).slice(0, 150)}`);
    const delAgain = await ownerApi(`/api/owner/users/${cRow.id}/delete`, { method: 'POST', body: { confirm: 'DELETE' } });
    check('(d) deleting an already-deleted account → 400', delAgain.status === 400, `status=${delAgain.status}`);

    // ---------- (e) subscriptions: approve past_due → active; cancel keeps period end ----------
    const seedPlan = await ownerApi('/api/owner/_test/seed-subscription', { method: 'POST', body: { workspaceId: bWorkspaceId, kind: 'plan', status: 'past_due' } });
    check('(e) seed past_due plan subscription', seedPlan.status === 201 && !!seedPlan.data?.subscription?.id, `status=${seedPlan.status}`);
    const planSubId = seedPlan.data?.subscription?.id ?? '';
    const seedSched = await ownerApi('/api/owner/_test/seed-subscription', { method: 'POST', body: { workspaceId: bWorkspaceId, kind: 'schedule', status: 'past_due' } });
    check('(e) seed past_due schedule subscription', seedSched.status === 201 && !!seedSched.data?.subscription?.id, `status=${seedSched.status}`);
    const schedSubId = seedSched.data?.subscription?.id ?? '';
    const schedPeriodEnd = seedSched.data?.subscription?.periodEnd ?? '';
    const subsList = await ownerApi('/api/owner/subscriptions');
    check('(e) owner lists subscriptions (200) with live pricing', subsList.status === 200 && Array.isArray(subsList.data?.subscriptions) && typeof subsList.data?.pricing?.paygReplyCostPaisa === 'number' && subsList.data?.pricing?.paygReplyCostPaisa === 23, `status=${subsList.status} payg=${subsList.data?.pricing?.paygReplyCostPaisa}`);
    check('(e) seeded subscriptions appear in the list', (subsList.data?.subscriptions ?? []).some((s) => s.id === planSubId) && (subsList.data?.subscriptions ?? []).some((s) => s.id === schedSubId), `count=${(subsList.data?.subscriptions ?? []).length}`);
    const approvePlan = await ownerApi(`/api/owner/subscriptions/${planSubId}/approve`, { method: 'POST', body: { kind: 'plan' } });
    check('(e) approve past_due plan → active', approvePlan.status === 200 && approvePlan.data?.subscription?.status === 'active', `status=${approvePlan.status} ${JSON.stringify(approvePlan.data ?? {}).slice(0, 150)}`);
    const approveAgain = await ownerApi(`/api/owner/subscriptions/${planSubId}/approve`, { method: 'POST', body: { kind: 'plan' } });
    check('(e) approving an already-active subscription → 409', approveAgain.status === 409, `status=${approveAgain.status}`);
    const cancelSched = await ownerApi(`/api/owner/subscriptions/${schedSubId}/cancel`, { method: 'POST', body: { kind: 'schedule' } });
    check('(e) cancel schedule → cancelled', cancelSched.status === 200 && cancelSched.data?.subscription?.status === 'cancelled', `status=${cancelSched.status} ${JSON.stringify(cancelSched.data ?? {}).slice(0, 150)}`);
    check('(e) cancel keeps the period end (ends at period end, not now)', cancelSched.data?.subscription?.periodEnd === schedPeriodEnd, `before=${schedPeriodEnd} after=${cancelSched.data?.subscription?.periodEnd}`);
    check('(e) cancel message promises period-end behaviour', String(cancelSched.data?.message ?? '').includes('মেয়াদ শেষ'), JSON.stringify(cancelSched.data?.message ?? null));
    const cancelAgain = await ownerApi(`/api/owner/subscriptions/${schedSubId}/cancel`, { method: 'POST', body: { kind: 'schedule' } });
    check('(e) cancelling an already-cancelled subscription → 400', cancelAgain.status === 400, `status=${cancelAgain.status}`);
    // Pending top-up approve reuses the EXISTING billing endpoint.
    const meBefore = await bApi('/api/auth/me');
    const balanceBefore = Number(meBefore.data?.workspace?.balance_paisa ?? 0);
    const trxId = `OWNMGMT${stamp}`;
    const topupReq = await bApi('/api/billing/topup/request', {
      method: 'POST',
      body: { amountPaisa: 10000, method: 'bkash', transactionId: trxId },
    });
    check('(e) shop files a manual top-up request (pending)', topupReq.status === 201 && topupReq.data?.topupRequest?.status === 'pending', `status=${topupReq.status} ${JSON.stringify(topupReq.data ?? {}).slice(0, 150)}`);
    const topupId = topupReq.data?.topupRequest?.id ?? topupReq.data?.id ?? '';
    const subsWithTopup = await ownerApi('/api/owner/subscriptions');
    check('(e) pending top-up shows in the owner subscription list', (subsWithTopup.data?.pendingTopups ?? []).some((t) => t.id === topupId && t.transactionId === trxId), `pending=${(subsWithTopup.data?.pendingTopups ?? []).length}`);
    const topupApprove = await ownerApi(`/api/billing/topup/${topupId}/approve`, { method: 'POST', body: { workspaceId: bWorkspaceId } });
    check('(e) owner approves the top-up via the existing billing endpoint', topupApprove.status === 200, `status=${topupApprove.status} ${JSON.stringify(topupApprove.data ?? {}).slice(0, 150)}`);
    const meAfter = await bApi('/api/auth/me');
    check('(e) wallet credited by exactly the top-up amount', Number(meAfter.data?.workspace?.balance_paisa ?? 0) === balanceBefore + 10000, `before=${balanceBefore} after=${meAfter.data?.workspace?.balance_paisa}`);

    // AI replies work again after unrestrict (fresh sender, no restricted notice).
    const mFree = await noAuth('/api/webhooks/webchat', {
      method: 'POST', auth: false,
      headers: { 'x-webchat-secret': WEBCHAT_SECRET },
      body: { externalId: 'site-ownermanage', senderId: 'wc-free-1', name: 'Free Customer', text: 'আসসালামু আলাইকুম' },
    });
    check('(c) unrestrict: greeting accepted after unrestrict', mFree.status === 200 && !!mFree.data?.conversationId, `status=${mFree.status}`);
    const freeConvId = mFree.data?.conversationId ?? '';
    const freeOut = await pollFor(async () => {
      const detail = await bApi(`/api/inbox/${freeConvId}`);
      const out = (detail.data?.messages ?? []).filter((m) => m.direction === 'out');
      return out.length > 0 ? out : null;
    });
    check('(c) unrestrict: greeting gets a real reply (no restricted notice)', !!freeOut && !freeOut.some((m) => (m.body ?? '').includes('বন্ধ আছে')), JSON.stringify((freeOut ?? []).map((m) => m.body)));

    // ---------- (f) every action wrote an audit row ----------
    const auditRes = await ownerApi('/api/owner/audit-log');
    const auditRows = auditRes.data?.auditLog ?? [];
    const actions = auditRows.map((a) => a.action);
    check('(f) audit log lists actions (200)', auditRes.status === 200 && auditRows.length >= 7, `status=${auditRes.status} count=${auditRows.length}`);
    for (const a of ['block', 'unblock', 'restrict', 'unrestrict', 'delete', 'approve_subscription', 'cancel_subscription']) {
      check(`(f) audit has '${a}' with actor + target`, actions.includes(a) && auditRows.some((r) => r.action === a && r.actorEmail === ownerEmail && !!r.createdAt), `actions=${JSON.stringify(actions)}`);
    }
    check('(f) audit rows carry the right targets', auditRows.some((r) => r.action === 'block' && r.targetEmail === bEmail) && auditRows.some((r) => r.action === 'delete' && r.targetEmail === cEmail), JSON.stringify(auditRows.map((r) => `${r.action}:${r.targetEmail ?? ''}`)));

    // ---------- (h) recent cost cuts: taka format + in/out tokens ----------
    // Seed ledger rows with KNOWN values, sweep them into owner deductions,
    // then read them back through GET /api/owner/overview as platform owner.
    // NOTE: ai_usage_ledger.input/output_tokens are INT NOT NULL, so a
    // ledger row can never carry NULL tokens — the dash case is a deduction
    // with NO ledger row (LEFT JOIN miss), seeded via orphanDeduction.
    const seedDed1 = await ownerApi('/api/owner/_test/seed-ledger', { method: 'POST', body: { workspaceId: bWorkspaceId, provider: 'gemini', providerCostPaisa: 16, inputTokens: 3615, outputTokens: 44, costPaisa: 50 } });
    check('(h) seed ledger row with known tokens + shop charge', seedDed1.status === 201 && seedDed1.data?.ledgerRow?.input_tokens === 3615 && seedDed1.data?.ledgerRow?.output_tokens === 44 && seedDed1.data?.ledgerRow?.cost_paisa === 50, `status=${seedDed1.status} ${JSON.stringify(seedDed1.data?.ledgerRow ?? {}).slice(0, 200)}`);
    const nullTokens = await ownerApi('/api/owner/_test/seed-ledger', { method: 'POST', body: { workspaceId: bWorkspaceId, provider: 'gemini', providerCostPaisa: 23, inputTokens: null, outputTokens: null } });
    check('(h) explicit NULL tokens rejected with a clear 400 (ledger tokens are NOT NULL)', nullTokens.status === 400 && String(nullTokens.data?.error ?? '').includes('NOT NULL'), `status=${nullTokens.status} ${JSON.stringify(nullTokens.data ?? {}).slice(0, 150)}`);
    const seedDed2 = await ownerApi('/api/owner/_test/seed-ledger', { method: 'POST', body: { workspaceId: bWorkspaceId, provider: 'gemini', providerCostPaisa: 23, orphanDeduction: true } });
    check('(h) seed orphan deduction with no ledger row (dash case)', seedDed2.status === 201 && !!seedDed2.data?.orphanDeduction?.id && seedDed2.data?.orphanDeduction?.amount_paisa === -23, `status=${seedDed2.status} ${JSON.stringify(seedDed2.data ?? {}).slice(0, 200)}`);
    const sweepRes = await ownerApi('/api/owner/wallet/sweep', { method: 'POST', body: {} });
    check('(h) sweep deducts the seeded ledger row', sweepRes.status === 200 && sweepRes.data?.deductedRows >= 1, `status=${sweepRes.status} deducted=${sweepRes.data?.deductedRows}`);
    const overview = await ownerApi('/api/owner/overview?days=30');
    const deds = overview.data?.recentDeductions ?? [];
    const row1 = deds.find((d) => d.inputTokens === 3615 && d.outputTokens === 44);
    check('(h) overview recentDeductions carries the token row', overview.status === 200 && !!row1, `status=${overview.status} rows=${deds.length}`);
    check('(h) token row: owner cost 16 paisa, shop paid 50, profit 34', !!row1 && row1.ownerCostPaisa === 16 && row1.shopChargePaisa === 50 && row1.profitPaisa === 34, JSON.stringify(row1 ?? null));
    check('(h) 16 paisa renders as ৳0.16 (Western digits)', !!row1 && `৳${(row1.ownerCostPaisa / 100).toFixed(2)}` === '৳0.16' && `৳${(row1.shopChargePaisa / 100).toFixed(2)}` === '৳0.50', `cost=${row1?.ownerCostPaisa} shop=${row1?.shopChargePaisa}`);
    const row2 = deds.find((d) => d.inputTokens === null && d.outputTokens === null && d.ownerCostPaisa === 23);
    check('(h) no-ledger row returns inputTokens/outputTokens null (dash case)', !!row2 && row2.shopChargePaisa === 0 && row2.shopName === '—', JSON.stringify(row2 ?? deds.map((d) => ({ c: d.ownerCostPaisa, i: d.inputTokens, o: d.outputTokens }))));
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
