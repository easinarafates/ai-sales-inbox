#!/usr/bin/env node
/**
 * Verification for off-topic auto-off (2026-11-08) — an extension of the
 * Waiting escalation system.
 *
 * The problem: a customer asking something outside the shop's scope —
 * "তুমি ছেলে নাকি মেয়ে?", personal questions about the AI, weather,
 * sports, politics, jokes, songs, movies, news, trivia — got an AI
 * reply (or a can't-answer reply), burning AI credit on a question the
 * shop can never answer. The owner asked the AI to turn itself OFF for
 * those questions, exactly like it already does for angry customers.
 *
 * The fix:
 * - apps/api/src/inbox/escalation.ts: new detectOffTopic() — curated
 *   BN + EN + Romanized phrase lists, guarded by a shop-scope list
 *   (products, price, orders, delivery, payment, shop) that runs first
 *   so shop questions and greetings can never match; 'off_topic' added
 *   to EscalationReason (migration 25's escalation_reason is plain
 *   TEXT with no CHECK constraint, so no new migration was needed).
 * - agent.ts: off-topic check right after the anger check, BEFORE any
 *   AI call — sends ONE deterministic graceful reply ("দুঃখিত, বুঝতে
 *   পারিনি…", gender-aware, no AI call, no charge), then escalates to
 *   waiting/off_topic, plus an unanswered record (owner sees it in
 *   Teach AI). Behaviour changed 2026-11-11 (Feature 1): it used to
 *   send NO reply at all.
 * - Inbox UI: waiting badge shows 'off_topic' as "বিষয়ের বাইরে" /
 *   "Off-topic question"; tab/filter unchanged (they already list
 *   Waiting). Reopen guard already covers every waiting chat, so an
 *   off-topic waiting chat behaves exactly like the others.
 *
 * Checks:
 * - Static: escalation module, agent hook + its position before the AI
 *   call, web badge.
 * - Boot 1 (local API on PGlite, webchat webhook end-to-end): an
 *   off-topic Bengali message → waiting/off_topic with exactly ONE
 *   graceful deterministic reply (never "আমি বুঝতে পারছি"); a
 *   greeting → a reply is saved and the chat is NOT off_topic; a normal
 *   price question → open + real reply (৳500).
 * - Driver (processBatch directly, same PGlite dir, API stopped):
 *   off-topic unit matrix (33 cases: personal questions + unrelated
 *   topics true; shop questions + greetings false), off-topic BN + EN,
 *   greeting, normal price, delivery-charge knowledge reply, angry
 *   still escalates as angry_customer, double off-topic guard.
 * - Boot 2 (same dir): ?status=waiting returns the waiting chats with
 *   reasons (incl. off_topic); Meta webhook to a waiting chat does NOT
 *   reopen it; reopen → open + mode still human + reason cleared;
 *   done → done + cleared.
 *
 * Run from the repo root:  node scripts/verify-off-topic-escalation.mjs
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const results = [];
let token = '';
/** Dummy webchat secret for the local boots (must match the boot env). */
const WEBCHAT_SECRET = 'offtopic-test-secret';
/** Dummy Meta app secret for the local boots (must match the boot env). */
const META_APP_SECRET = 'dummy-meta-secret';

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
      // mode (no live AI calls).
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
    const proc = spawn('npx', ['tsx', '../../scripts/off-topic-escalation-driver.ts', workspaceId, jeansId], {
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
  const mig25 = fs.readFileSync(path.join(ROOT, 'apps/api/src/db/migrations/25-escalation-waiting.sql'), 'utf8');
  check('migration 25: escalation_reason is plain TEXT (no CHECK constraint — no new migration needed)', mig25.includes('escalation_reason TEXT') && !/CHECK/i.test(mig25));

  const escSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/inbox/escalation.ts'), 'utf8');
  check("escalation reason set includes 'off_topic'", escSrc.includes("'off_topic'"));
  check('escalation module exports detectOffTopic', escSrc.includes('export function detectOffTopic'));
  check('off-topic list has personal-question phrases (BN + EN + Romanized)', escSrc.includes("'ছেলে নাকি মেয়ে'") && escSrc.includes("'are you a boy'") && escSrc.includes("'chele naki meye'"));
  check('off-topic list covers unrelated topics (weather, sports, jokes, songs)', escSrc.includes("'আবহাওয়া'") && escSrc.includes("'ক্রিকেট'") && escSrc.includes("'কৌতুক'") && escSrc.includes("'গান'"));
  check('shop-scope guard runs first in detectOffTopic', escSrc.indexOf('SHOP_SCOPE_SIGNALS') < escSrc.indexOf('BENGALI_OFF_TOPIC_PHRASES') && escSrc.includes('if (SHOP_SCOPE_SIGNALS.some((signal) => lower.includes(signal))) return false;'));

  const agentSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/ai-agent/agent.ts'), 'utf8');
  check('agent: off-topic check present with escalated_off_topic reason', agentSrc.includes('detectOffTopic(batchedText)') && agentSrc.includes("reason: 'escalated_off_topic'"));
  check('agent: off-topic escalates as off_topic', agentSrc.includes("escalateConversation(workspaceId, conversationId, 'off_topic')"));
  const offTopicIdx = agentSrc.indexOf('detectOffTopic(batchedText)');
  check('agent: off-topic check runs BEFORE any AI call', offTopicIdx > 0 && offTopicIdx < agentSrc.indexOf('callAiForWorkspaceSplit(') && offTopicIdx < agentSrc.indexOf('checkAiReplyAllowance(workspaceId)'));
  check('agent: off-topic check runs right after the anger check', agentSrc.indexOf('detectOffTopic(batchedText)') > agentSrc.indexOf("escalated_angry_customer"));

  const webSrc = fs.readFileSync(path.join(ROOT, 'apps/web/app/inbox/page.tsx'), 'utf8');
  check('web: waiting badge shows off_topic as বিষয়ের বাইরে', webSrc.includes('if (r === "off_topic")') && webSrc.includes('বিষয়ের বাইরে'));

  // ---------- Boot 1: webchat webhook end-to-end ----------
  const stamp = Date.now();
  const port = 4022;
  const dataDir = '.pglite-data-offtopic';
  const run1 = startApi(port, dataDir);
  process.on('exit', run1.stop);
  let workspaceId = '';
  let jeansId = '';
  let offTopicConvId = '';
  let normalConvId = '';
  try {
    const up = await waitForHealth(`http://localhost:${port}`);
    check('boot 1: API starts', up, up ? '' : run1.log().slice(-500));
    if (!up) return;
    const api = makeApi(`http://localhost:${port}`);
    const signup = await api('/api/auth/signup', {
      method: 'POST', auth: false,
      body: { name: 'OffTopic Owner', email: `offtopic+${stamp}@example.com`, password: 'verify1234', workspaceName: 'OffTopic Test Shop' },
    });
    check('boot 1: signup', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
    token = signup.data?.token ?? '';
    workspaceId = signup.data?.workspace?.id ?? '';
    const live = await api(`/api/workspaces/${workspaceId}/go-live`, { method: 'POST' });
    check('boot 1: go-live', live.status === 200 && live.data?.workspace?.practice_mode === false, `status=${live.status}`);
    const jeans = await api('/api/products', { method: 'POST', body: { name: 'Jeans', pricePaisa: 50000, stock: 10 } });
    check('boot 1: Jeans product created', jeans.status === 201, `status=${jeans.status}`);
    jeansId = jeans.data?.id ?? jeans.data?.product?.id ?? '';
    const ch = await api('/api/channels', { method: 'POST', body: { platform: 'webchat', externalId: 'site-offtopic', displayName: 'OffTopic Test Site' } });
    check('boot 1: webchat channel → 201', ch.status === 201, `status=${ch.status}`);

    // Off-topic Bengali message over the real intake path.
    const mOff = await api('/api/webhooks/webchat', {
      method: 'POST', auth: false,
      headers: { 'x-webchat-secret': WEBCHAT_SECRET },
      body: { externalId: 'site-offtopic', senderId: 'wc-off-1', name: 'Curious Customer', text: 'তুমি ছেলে নাকি মেয়ে?' },
    });
    check('boot 1: off-topic webchat message accepted', mOff.status === 200 && !!mOff.data?.conversationId, `status=${mOff.status}`);
    offTopicConvId = mOff.data?.conversationId ?? '';
    const offFound = await pollFor(async () => {
      const detail = await api(`/api/inbox/${offTopicConvId}`);
      const conv = detail.data?.conversation ?? {};
      return conv.status === 'waiting' ? conv : null;
    });
    check('boot 1: off-topic message → status waiting', !!offFound, `status=${offFound?.status ?? '?'}`);
    check('boot 1: mode is human (AI stopped)', offFound?.mode === 'human', `mode=${offFound?.mode ?? '?'}`);
    check('boot 1: reason is off_topic', offFound?.escalation_reason === 'off_topic', `reason=${offFound?.escalation_reason ?? '?'}`);
    const offThread = await api(`/api/inbox/${offTopicConvId}`);
    const offOut = (offThread.data?.messages ?? []).filter((m) => m.direction === 'out');
    // Feature 1 (2026-11-11): exactly ONE deterministic graceful reply —
    // never an AI reply, never "আমি বুঝতে পারছি".
    check('boot 1: exactly ONE graceful reply to the off-topic question', offOut.length === 1 && (offOut[0]?.body ?? '').includes('বুঝতে পারিনি') && !(offOut[0]?.body ?? '').includes('আমি বুঝতে পারছি'), `out=${offOut.length} body=${JSON.stringify((offOut[0]?.body ?? '').slice(0, 120))}`);

    // Greeting over the same path — must NOT be off-topic; a reply is saved.
    const mHi = await api('/api/webhooks/webchat', {
      method: 'POST', auth: false,
      headers: { 'x-webchat-secret': WEBCHAT_SECRET },
      body: { externalId: 'site-offtopic', senderId: 'wc-hi-1', name: 'Greeting Customer', text: 'আসসালামু আলাইকুম' },
    });
    check('boot 1: greeting webchat message accepted', mHi.status === 200 && !!mHi.data?.conversationId, `status=${mHi.status}`);
    const hiConvId = mHi.data?.conversationId ?? '';
    const hiFound = await pollFor(async () => {
      const detail = await api(`/api/inbox/${hiConvId}`);
      const msgs = detail.data?.messages ?? [];
      const out = msgs.filter((m) => m.direction === 'out');
      return out.length > 0 ? detail.data?.conversation ?? {} : null;
    });
    check('boot 1: greeting got a reply (not off_topic)', !!hiFound && hiFound.escalation_reason !== 'off_topic', `reason=${hiFound?.escalation_reason ?? '?'}`);

    // Normal price question over the same path.
    const mNormal = await api('/api/webhooks/webchat', {
      method: 'POST', auth: false,
      headers: { 'x-webchat-secret': WEBCHAT_SECRET },
      body: { externalId: 'site-offtopic', senderId: 'wc-ok-1', name: 'Normal Customer', text: 'জিন্সের দাম কত?' },
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
    check('boot 1: normal question stays open', !!normalFound && normalFound.conv.status === 'open', `status=${normalFound?.conv?.status ?? '?'}`);
    check('boot 1: normal question got a real reply (৳500)', !!normalFound && normalFound.out.some((m) => (m.body ?? '').includes('৳৫০০') || (m.body ?? '').includes('৫০০') || (m.body ?? '').includes('500')), JSON.stringify((normalFound?.out ?? []).map((m) => m.body).slice(0, 1)));
    check('boot 1: normal question was NOT escalated', !!normalFound && !normalFound.conv.escalation_reason, `reason=${normalFound?.conv?.escalation_reason ?? 'null'}`);
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
    check('driver: off-topic unit matrix all correct', driverResult.offTopicUnitAllOk === true, JSON.stringify((driverResult.offTopicUnit ?? []).filter((c) => !c.ok)));
    const ob = driverResult.offTopicBn ?? {};
    check('driver: off-topic BN → waiting/off_topic, ONE graceful reply', ob.result?.replied === true && ob.result?.reason === 'escalated_off_topic' && ob.state?.status === 'waiting' && ob.state?.mode === 'human' && ob.state?.escalation_reason === 'off_topic' && ob.outMessages === 1 && (ob.outBodies ?? []).some((b) => b.includes('বুঝতে পারিনি') && !b.includes('আমি বুঝতে পারছি')), JSON.stringify({ r: ob.result, s: ob.state, out: ob.outMessages, b: ob.outBodies }));
    const oe = driverResult.offTopicEn ?? {};
    check('driver: off-topic EN → waiting/off_topic, ONE graceful reply', oe.result?.replied === true && oe.result?.reason === 'escalated_off_topic' && oe.state?.status === 'waiting' && oe.state?.mode === 'human' && oe.state?.escalation_reason === 'off_topic' && oe.outMessages === 1 && (oe.outBodies ?? []).some((b) => b.includes('বুঝতে পারিনি') && !b.includes('আমি বুঝতে পারছি')), JSON.stringify({ r: oe.result, s: oe.state, out: oe.outMessages, b: oe.outBodies }));
    const gr = driverResult.greeting ?? {};
    check('driver: greeting gets a reply and is NOT off_topic', gr.result?.replied === true && gr.state?.escalation_reason !== 'off_topic' && (gr.outBodies ?? []).length > 0, JSON.stringify({ r: gr.result, s: gr.state }));
    const nm = driverResult.normal ?? {};
    check('driver: normal price stays open + reply has ৳500', nm.result?.replied === true && nm.state?.status === 'open' && nm.state?.mode === 'ai' && !nm.state?.escalation_reason && (nm.outBodies ?? []).some((b) => b.includes('৳500') || b.includes('500')), JSON.stringify({ r: nm.result, s: nm.state }));
    const dl = driverResult.delivery ?? {};
    check('driver: delivery-charge question stays open + reply has ১৩০', dl.result?.replied === true && dl.state?.status === 'open' && !dl.state?.escalation_reason && (dl.outBodies ?? []).some((b) => b.includes('১৩০') || b.includes('130')), JSON.stringify({ r: dl.result, s: dl.state }));
    const ag = driverResult.angryStill ?? {};
    check('driver: angry still escalates as angry_customer', ag.result?.replied === false && ag.state?.status === 'waiting' && ag.state?.escalation_reason === 'angry_customer' && ag.outMessages === 0, JSON.stringify({ r: ag.result, s: ag.state }));
    const dbl = driverResult.doubleOffTopic ?? {};
    // Feature 1: the FIRST off-topic message already sent the one graceful
    // reply, so the total stays 1 — the second message adds NO new reply.
    check('driver: second off-topic message does not re-escalate', dbl.result?.reason === 'human_mode' && dbl.state?.status === 'waiting' && dbl.state?.escalation_reason === 'off_topic' && dbl.outMessages === 1, JSON.stringify({ r: dbl.result, s: dbl.state }));
    check('driver: guard conversation seeded waiting (off_topic)', !!driverResult.guardConversationId, `id=${String(driverResult.guardConversationId ?? '').slice(0, 8)}`);
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
      check('boot 2: ?status=waiting returns the waiting chats', wList.length >= 4, `count=${wList.length}`);
      check('boot 2: waiting rows carry escalation_reason (incl. off_topic)', wList.length > 0 && wList.every((c) => !!c.escalation_reason) && wList.some((c) => c.escalation_reason === 'off_topic'), JSON.stringify(wList.map((c) => c.escalation_reason)));
      const guardId = driverResult?.guardConversationId ?? '';
      // A new Meta message to the waiting guard conversation must NOT reopen it.
      // The Meta POST is signed like Meta signs it (HMAC-SHA256 of the
      // raw body with META_APP_SECRET, X-Hub-Signature-256) — the
      // 2026-11-11 security fix rejects unsigned webhook POSTs with 403.
      const hookBody = JSON.stringify({
        object: 'page',
        entry: [{
          id: 'TESTPAGE1', time: Math.floor(Date.now() / 1000),
          messaging: [{
            sender: { id: 'PSID-OFF-1' }, recipient: { id: 'TESTPAGE1' },
            timestamp: Date.now(),
            message: { mid: `off-guard-${stamp}`, text: 'তোমার নাম কি?' },
          }],
        }],
      });
      const hookSig = `sha256=${crypto.createHmac('sha256', META_APP_SECRET).update(hookBody).digest('hex')}`;
      const hook = await fetch(`http://localhost:${port}/api/webhooks/meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': hookSig },
        body: hookBody,
      });
      check('boot 2: Meta webhook accepted for the waiting chat', hook.status === 200, `status=${hook.status}`);
      await sleep(4000);
      const guardAfter = await api(`/api/inbox/${guardId}`);
      const guardConv = guardAfter.data?.conversation ?? {};
      check('boot 2: waiting chat was NOT reopened by a new message', guardConv.status === 'waiting', `status=${guardConv.status ?? '?'}`);
      check('boot 2: waiting chat mode still human', guardConv.mode === 'human', `mode=${guardConv.mode ?? '?'}`);
      check('boot 2: waiting chat reason still off_topic', guardConv.escalation_reason === 'off_topic', `reason=${guardConv.escalation_reason ?? '?'}`);
      const guardOut = (guardAfter.data?.messages ?? []).filter((m) => m.direction === 'out');
      check('boot 2: no AI reply went out to the waiting chat', guardOut.length === 0, `out=${guardOut.length}`);

      // Owner moves the off-topic chat back to Open — mode stays human, reason cleared.
      const reopen = await api(`/api/inbox/${offTopicConvId}/reopen`, { method: 'POST' });
      check('boot 2: reopen → 200', reopen.status === 200, `status=${reopen.status} ${JSON.stringify(reopen.data ?? {}).slice(0, 150)}`);
      const reopened = await api(`/api/inbox/${offTopicConvId}`);
      const reConv = reopened.data?.conversation ?? {};
      check('boot 2: reopened chat is open', reConv.status === 'open', `status=${reConv.status ?? '?'}`);
      check('boot 2: reopened chat stays human mode (owner handles it)', reConv.mode === 'human', `mode=${reConv.mode ?? '?'}`);
      check('boot 2: escalation reason cleared on reopen', !reConv.escalation_reason, `reason=${reConv.escalation_reason ?? 'null'}`);

      // Owner marks another waiting chat Closed.
      const enId = driverResult?.offTopicEn?.conversationId ?? '';
      const done = await api(`/api/inbox/${enId}/done`, { method: 'POST' });
      check('boot 2: done on a waiting chat → 200', done.status === 200, `status=${done.status}`);
      const doneAfter = await api(`/api/inbox/${enId}`);
      check('boot 2: done chat is done + escalation cleared', doneAfter.data?.conversation?.status === 'done' && !doneAfter.data?.conversation?.escalation_reason, `status=${doneAfter.data?.conversation?.status ?? '?'} reason=${doneAfter.data?.conversation?.escalation_reason ?? 'null'}`);
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
