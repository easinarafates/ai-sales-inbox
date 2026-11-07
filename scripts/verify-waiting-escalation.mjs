#!/usr/bin/env node
/**
 * Verification for automatic escalation to a 'Waiting' status (2026-11-07).
 *
 * The problem: when a customer got angry, or said something the AI could
 * not understand, the AI either kept replying badly or went silent with
 * nothing in the Inbox marking the chat as needing a human — and a new
 * message could reopen the chat and restart the AI.
 *
 * The fix:
 * - Migration 25: conversations.escalation_reason + escalated_at.
 * - New apps/api/src/inbox/escalation.ts: detectAnger (curated BN/EN
 *   list — a plain refund request or normal complaint never matches),
 *   isCantAnswerReply, escalateConversation (status='waiting' +
 *   mode='human' + handover fields; never twice, never when the owner
 *   already handles it).
 * - agent.ts hooks: anger check before any AI call; low-confidence
 *   branch escalates 'ai_unsure'; empty reply escalates 'cant_answer';
 *   demo-mode can't-answer + failed order escalate 'cant_answer'; a
 *   sent can't-answer reply escalates 'cant_answer'.
 * - Webhook intake (Meta + TikTok) never reopens a 'waiting' chat.
 * - Inbox API: list/detail return escalation_reason + escalated_at;
 *   POST /:id/reopen (back to Open, mode stays 'human'); /done clears
 *   the escalation.
 * - Inbox UI: Waiting tab (Bengali "মানুষের অপেক্ষায়" — deliberately
 *   NOT Pending's "অপেক্ষমাণ"), status filter option, reason badge on
 *   waiting rows + a banner with Back to Open / Done in the thread.
 *
 * Checks:
 * - Static: migration, escalation module, agent hooks, webhook guards,
 *   inbox routes, web UI pieces.
 * - Boot 1 (local API on PGlite, webchat webhook end-to-end): an angry
 *   Bengali message → waiting/angry_customer with NO AI reply; a normal
 *   price question → open + real reply (৳500).
 * - Driver (processBatch directly, same PGlite dir, API stopped): anger
 *   unit matrix, can't-answer unit checks, angry BN + EN, can't-answer
 *   demo, normal price, refund-only (never 'angry_customer'),
 *   double-escalation guard.
 * - Boot 2 (same dir): ?status=waiting filter returns the waiting chats
 *   with reasons; Meta webhook to a waiting chat does NOT reopen it;
 *   reopen → open + mode still human + reason cleared; done → done +
 *   cleared; reopen on a non-waiting chat → 404.
 *
 * Run from the repo root:  node scripts/verify-waiting-escalation.mjs
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const results = [];
let token = '';
/** Dummy webchat secret for the local boots (must match the boot env). */
const WEBCHAT_SECRET = 'waitesc-test-secret';

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function startApi(port, dataDir, extraEnv = {}) {
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
      // Blank the provider keys so the test runs in deterministic demo
      // mode (no live AI calls): the can't-answer fallback is the path
      // under test. dotenv never overrides env vars set here.
      GEMINI_API_KEY: '',
      GROQ_API_KEY: '',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      META_APP_ID: 'dummy-app-id',
      META_APP_SECRET: 'dummy-meta-secret',
      ...extraEnv,
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

function runDriver(dataDir, workspaceId, jeansId) {
  return new Promise((resolve) => {
    const proc = spawn('npx', ['tsx', '../../scripts/waiting-escalation-driver.ts', workspaceId, jeansId], {
      cwd: path.join(ROOT, 'apps/api'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        USE_PGLITE: 'true',
        PGLITE_DATA_DIR: dataDir,
        JWT_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        WEBCHAT_SECRET,
        GEMINI_API_KEY: '',
        GROQ_API_KEY: '',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
      },
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('close', (code) => resolve({ code, out, err }));
  });
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

function asList(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.conversations)) return data.conversations;
  return [];
}

async function main() {
  // ---------- Static checks ----------
  const mig = fs.readFileSync(path.join(ROOT, 'apps/api/src/db/migrations/25-escalation-waiting.sql'), 'utf8');
  check('migration 25 adds escalation_reason', mig.includes('ADD COLUMN IF NOT EXISTS escalation_reason'));
  check('migration 25 adds escalated_at', mig.includes('ADD COLUMN IF NOT EXISTS escalated_at'));

  const escSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/inbox/escalation.ts'), 'utf8');
  check('escalation module exports detectAnger + escalateConversation', escSrc.includes('export function detectAnger') && escSrc.includes('export async function escalateConversation'));
  check('anger list has Bengali + English words', escSrc.includes("'রাগ'") && escSrc.includes("'angry'") && escSrc.includes("'worst'"));
  check('escalate sets waiting + human + handover fields', escSrc.includes("status = 'waiting'") && escSrc.includes("mode = 'human'") && escSrc.includes('handover_started_at = now()') && escSrc.includes('escalation_reason'));
  check('escalate never fires twice / never when owner handles it', escSrc.includes("status <> 'waiting'") && escSrc.includes("mode = 'ai'"));

  const agentSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/ai-agent/agent.ts'), 'utf8');
  check('agent: anger check before any AI call', agentSrc.includes("detectAnger(batchedText)") && agentSrc.includes("reason: 'escalated_angry_customer'"));
  check('agent: low-confidence branch escalates ai_unsure', agentSrc.includes("escalateConversation(workspaceId, conversationId, 'ai_unsure')"));
  check('agent: empty reply escalates cant_answer', agentSrc.includes("escalateConversation(workspaceId, conversationId, 'cant_answer')"));
  check('agent: demo can\'t-answer escalates cant_answer', agentSrc.includes("Demo mode could not answer") && agentSrc.includes('cant_answer'));
  check('agent: sent can\'t-answer reply escalates', agentSrc.includes('isCantAnswerReply(parsed.reply)'));

  const hookSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/webhooks/routes.ts'), 'utf8');
  check('webhook: waiting chat is never reopened', hookSrc.includes("latest?.status === 'waiting'") && hookSrc.includes("status <> 'waiting'"));
  const tikSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/webhooks/tiktok-dm.ts'), 'utf8');
  check('tiktok webhook: waiting chat is never reopened', tikSrc.includes("latest?.status === 'waiting'") && tikSrc.includes("status <> 'waiting'"));

  const inboxApiSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/inbox/routes.ts'), 'utf8');
  check('inbox API: list/detail return escalation fields', inboxApiSrc.includes('c.escalation_reason, c.escalated_at'));
  check('inbox API: reopen endpoint keeps mode human', inboxApiSrc.includes("'/api/inbox/:id/reopen'") || inboxApiSrc.includes("/:id/reopen"));
  check('inbox API: done clears the escalation', inboxApiSrc.includes("escalation_reason = NULL, escalated_at = NULL"));

  const webSrc = fs.readFileSync(path.join(ROOT, 'apps/web/app/inbox/page.tsx'), 'utf8');
  check('web: Waiting tab with distinct Bengali label', webSrc.includes("labelBn: \"মানুষের অপেক্ষায়\"") && webSrc.includes('id: "waiting"'));
  check('web: Pending still says অপেক্ষমাণ (no collision with Waiting)', webSrc.includes("labelBn: \"অপেক্ষমাণ\"") && webSrc.includes("labelBn: \"মানুষের অপেক্ষায়\""));
  check('web: status filter has a Waiting option', webSrc.includes('<option value="waiting">'));
  check('web: waiting rows show a reason badge', webSrc.includes('waitingReason(c)') && webSrc.includes('waitingBadge'));
  check('web: thread has a waiting banner with Back to Open', webSrc.includes('waitingBanner') && webSrc.includes('inboxApi.reopen'));
  check('web: statusOf maps waiting', webSrc.includes('if (s === "waiting") return "waiting"'));

  const apiLibSrc = fs.readFileSync(path.join(ROOT, 'apps/web/lib/api.ts'), 'utf8');
  check('web api: inboxApi.reopen exists', apiLibSrc.includes('reopen: (id: string)'));

  // ---------- Boot 1: webchat webhook end-to-end ----------
  const stamp = Date.now();
  const port = 4021;
  const dataDir = '.pglite-data-waitesc';
  const run1 = startApi(port, dataDir);
  process.on('exit', run1.stop);
  let workspaceId = '';
  let jeansId = '';
  let angryConvId = '';
  let normalConvId = '';
  try {
    const up = await waitForHealth(`http://localhost:${port}`);
    check('boot 1: API starts', up, up ? '' : run1.log().slice(-500));
    if (!up) return;
    const api = makeApi(`http://localhost:${port}`);
    const signup = await api('/api/auth/signup', {
      method: 'POST', auth: false,
      body: { name: 'Waiting Owner', email: `waitesc+${stamp}@example.com`, password: 'verify1234', workspaceName: 'Waiting Test Shop' },
    });
    check('boot 1: signup', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
    token = signup.data?.token ?? '';
    workspaceId = signup.data?.workspace?.id ?? '';
    const live = await api(`/api/workspaces/${workspaceId}/go-live`, { method: 'POST' });
    check('boot 1: go-live', live.status === 200 && live.data?.workspace?.practice_mode === false, `status=${live.status}`);
    const jeans = await api('/api/products', { method: 'POST', body: { name: 'Jeans', pricePaisa: 50000, stock: 10 } });
    check('boot 1: Jeans product created', jeans.status === 201, `status=${jeans.status}`);
    jeansId = jeans.data?.id ?? jeans.data?.product?.id ?? '';
    const ch = await api('/api/channels', { method: 'POST', body: { platform: 'webchat', externalId: 'site-waitesc', displayName: 'Waiting Test Site' } });
    check('boot 1: webchat channel → 201', ch.status === 201, `status=${ch.status}`);

    // Angry Bengali message over the real intake path.
    const mAngry = await api('/api/webhooks/webchat', {
      method: 'POST', auth: false,
      headers: { 'x-webchat-secret': WEBCHAT_SECRET },
      body: { externalId: 'site-waitesc', senderId: 'wc-angry-1', name: 'Rag Customer', text: 'তোমাদের সার্ভিস খুব বাজে! আমি রাগ করেছি' },
    });
    check('boot 1: angry webchat message accepted', mAngry.status === 200 && !!mAngry.data?.conversationId, `status=${mAngry.status}`);
    angryConvId = mAngry.data?.conversationId ?? '';
    const angryFound = await pollFor(async () => {
      const detail = await api(`/api/inbox/${angryConvId}`);
      const conv = detail.data?.conversation ?? {};
      return conv.status === 'waiting' ? conv : null;
    });
    check('boot 1: (a) angry message → status waiting', !!angryFound, `status=${angryFound?.status ?? '?'}`);
    check('boot 1: (a) mode is human (AI stopped)', angryFound?.mode === 'human', `mode=${angryFound?.mode ?? '?'}`);
    check('boot 1: (a) reason is angry_customer', angryFound?.escalation_reason === 'angry_customer', `reason=${angryFound?.escalation_reason ?? '?'}`);
    const angryThread = await api(`/api/inbox/${angryConvId}`);
    const angryOut = (angryThread.data?.messages ?? []).filter((m) => m.direction === 'out');
    check('boot 1: (a) NO AI reply was sent to the angry customer', angryOut.length === 0, `out=${angryOut.length}`);

    // Normal price question over the same path.
    const mNormal = await api('/api/webhooks/webchat', {
      method: 'POST', auth: false,
      headers: { 'x-webchat-secret': WEBCHAT_SECRET },
      body: { externalId: 'site-waitesc', senderId: 'wc-ok-1', name: 'Normal Customer', text: 'জিন্সের দাম কত?' },
    });
    check('boot 1: normal webchat message accepted', mNormal.status === 200 && !!mNormal.data?.conversationId, `status=${mNormal.status}`);
    normalConvId = mNormal.data?.conversationId ?? '';
    const normalFound = await pollFor(async () => {
      const detail = await api(`/api/inbox/${normalConvId}`);
      const msgs = detail.data?.messages ?? [];
      const out = msgs.filter((m) => m.direction === 'out');
      const conv = detail.data?.conversation ?? {};
      return out.length > 0 ? { conv, out } : null;
    });
    check('boot 1: (c) normal question stays open', !!normalFound && normalFound.conv.status === 'open', `status=${normalFound?.conv?.status ?? '?'}`);
    check('boot 1: (c) normal question got a real reply (৳500)', !!normalFound && normalFound.out.some((m) => (m.body ?? '').includes('৳৫০০') || (m.body ?? '').includes('৫০০') || (m.body ?? '').includes('500')), JSON.stringify((normalFound?.out ?? []).map((m) => m.body).slice(0, 1)));
    check('boot 1: (c) normal question was NOT escalated', !!normalFound && !normalFound.conv.escalation_reason, `reason=${normalFound?.conv?.escalation_reason ?? 'null'}`);
  } finally {
    run1.stop();
    await sleep(2000);
  }

  // ---------- Driver: processBatch directly + unit checks ----------
  const driver = await runDriver(dataDir, workspaceId, jeansId);
  let driverResult = null;
  const driverLine = (driver.out ?? '').split('\n').find((l) => l.startsWith('DRIVER_RESULT '));
  try {
    driverResult = driverLine ? JSON.parse(driverLine.slice('DRIVER_RESULT '.length)) : null;
  } catch {
    driverResult = null;
  }
  check('driver: ran clean (exit 0 + result line)', driver.code === 0 && !!driverResult, `code=${driver.code} err=${(driver.err ?? '').slice(-300)}`);
  if (driverResult) {
    check('driver: anger unit matrix all correct', driverResult.angerUnitAllOk === true, JSON.stringify((driverResult.angerUnit ?? []).filter((c) => !c.ok)));
    check('driver: can\'t-answer unit checks correct', driverResult.cantAnswerUnit?.fallback === true && driverResult.cantAnswerUnit?.promptPhrase === true && driverResult.cantAnswerUnit?.normalPrice === false, JSON.stringify(driverResult.cantAnswerUnit ?? {}));
    const ab = driverResult.angryBn ?? {};
    check('driver: (a) angry BN → waiting/angry_customer, no reply', ab.result?.replied === false && ab.state?.status === 'waiting' && ab.state?.mode === 'human' && ab.state?.escalation_reason === 'angry_customer' && ab.outMessages === 0, JSON.stringify({ r: ab.result, s: ab.state, out: ab.outMessages }));
    const ae = driverResult.angryEn ?? {};
    check('driver: (a) angry EN → waiting/angry_customer, no reply', ae.result?.replied === false && ae.state?.status === 'waiting' && ae.state?.mode === 'human' && ae.state?.escalation_reason === 'angry_customer' && ae.outMessages === 0, JSON.stringify({ r: ae.result, s: ae.state, out: ae.outMessages }));
    const ca = driverResult.cantAnswer ?? {};
    check('driver: (b) can\'t-answer → waiting/cant_answer, fallback saved', ca.state?.status === 'waiting' && ca.state?.mode === 'human' && ca.state?.escalation_reason === 'cant_answer' && (ca.outBodies ?? []).some((b) => b.includes('উত্তর আমার কাছে নেই')), JSON.stringify({ s: ca.state, out: ca.outBodies }));
    const nm = driverResult.normal ?? {};
    check('driver: (c) normal price stays open + reply has ৳500', nm.result?.replied === true && nm.state?.status === 'open' && nm.state?.mode === 'ai' && !nm.state?.escalation_reason && (nm.outBodies ?? []).some((b) => b.includes('৳500') || b.includes('500')), JSON.stringify({ r: nm.result, s: nm.state }));
    const rf = driverResult.refundOnly ?? {};
    check('driver: refund-only is NEVER angry_customer', rf.state?.escalation_reason !== 'angry_customer', `reason=${rf.state?.escalation_reason ?? 'null'}`);
    const dbl = driverResult.doubleEscalation ?? {};
    check('driver: (e) second angry message does not re-escalate', dbl.result?.reason === 'human_mode' && dbl.state?.status === 'waiting' && dbl.state?.escalation_reason === 'angry_customer' && dbl.outMessages === 0, JSON.stringify({ r: dbl.result, s: dbl.state }));
    check('driver: guard conversation seeded waiting', !!driverResult.guardConversationId, `id=${String(driverResult.guardConversationId ?? '').slice(0, 8)}`);
  }

  // ---------- Boot 2: inbox API + reopen-guard over the Meta webhook ----------
  const run2 = startApi(port, dataDir);
  process.on('exit', run2.stop);
  try {
    const up2 = await waitForHealth(`http://localhost:${port}`);
    check('boot 2: API starts on the same dir', up2, up2 ? '' : run2.log().slice(-500));
    if (up2) {
      const api = makeApi(`http://localhost:${port}`);
      const waiting = await api('/api/inbox?status=waiting');
      const wList = asList(waiting.data);
      check('boot 2: (d) ?status=waiting returns the waiting chats', wList.length >= 3, `count=${wList.length}`);
      check('boot 2: (d) waiting rows carry escalation_reason', wList.length > 0 && wList.every((c) => !!c.escalation_reason), JSON.stringify(wList.map((c) => c.escalation_reason)));
      const guardId = driverResult?.guardConversationId ?? '';
      // A new Meta message to the waiting guard conversation must NOT reopen it.
      const hook = await fetch(`http://localhost:${port}/api/webhooks/meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          object: 'page',
          entry: [{
            id: 'TESTPAGE1', time: Math.floor(Date.now() / 1000),
            messaging: [{
              sender: { id: 'PSID-WAIT-1' }, recipient: { id: 'TESTPAGE1' },
              timestamp: Date.now(),
              message: { mid: `wait-guard-${stamp}`, text: 'আবার বলছি, খুব বাজে!' },
            }],
          }],
        }),
      });
      check('boot 2: Meta webhook accepted for the waiting chat', hook.status === 200, `status=${hook.status}`);
      await sleep(4000);
      const guardAfter = await api(`/api/inbox/${guardId}`);
      const guardConv = guardAfter.data?.conversation ?? {};
      check('boot 2: waiting chat was NOT reopened by a new message', guardConv.status === 'waiting', `status=${guardConv.status ?? '?'}`);
      check('boot 2: waiting chat mode still human', guardConv.mode === 'human', `mode=${guardConv.mode ?? '?'}`);
      const guardOut = (guardAfter.data?.messages ?? []).filter((m) => m.direction === 'out');
      check('boot 2: no AI reply went out to the waiting chat', guardOut.length === 0, `out=${guardOut.length}`);

      // (e) Owner moves the angry chat back to Open — mode stays human, reason cleared.
      const reopen = await api(`/api/inbox/${angryConvId}/reopen`, { method: 'POST' });
      check('boot 2: (e) reopen → 200', reopen.status === 200, `status=${reopen.status} ${JSON.stringify(reopen.data ?? {}).slice(0, 150)}`);
      const reopened = await api(`/api/inbox/${angryConvId}`);
      const reConv = reopened.data?.conversation ?? {};
      check('boot 2: (e) reopened chat is open', reConv.status === 'open', `status=${reConv.status ?? '?'}`);
      check('boot 2: (e) reopened chat stays human mode (owner handles it)', reConv.mode === 'human', `mode=${reConv.mode ?? '?'}`);
      check('boot 2: (e) escalation reason cleared on reopen', !reConv.escalation_reason, `reason=${reConv.escalation_reason ?? 'null'}`);

      // (e) Owner marks another waiting chat Closed.
      const cantId = driverResult?.cantAnswer?.conversationId ?? '';
      const done = await api(`/api/inbox/${cantId}/done`, { method: 'POST' });
      check('boot 2: (e) done on a waiting chat → 200', done.status === 200, `status=${done.status}`);
      const doneAfter = await api(`/api/inbox/${cantId}`);
      check('boot 2: (e) done chat is done + escalation cleared', doneAfter.data?.conversation?.status === 'done' && !doneAfter.data?.conversation?.escalation_reason, `status=${doneAfter.data?.conversation?.status ?? '?'} reason=${doneAfter.data?.conversation?.escalation_reason ?? 'null'}`);

      // Reopen on a non-waiting chat must fail honestly.
      const badReopen = await api(`/api/inbox/${normalConvId}/reopen`, { method: 'POST' });
      check('boot 2: reopen on a non-waiting chat → 404', badReopen.status === 404, `status=${badReopen.status}`);
    }
  } finally {
    run2.stop();
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
