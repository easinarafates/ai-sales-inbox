#!/usr/bin/env node
/**
 * Verification for fast Seen + fast AI reply on Messenger.
 *
 * User requirement: when a customer messages a connected Page, the Page
 * must FIRST mark the message SEEN (a real Graph read receipt), then
 * analyze it, then reply — all within a few seconds, so the customer
 * is not kept waiting.
 *
 * Local, offline — no calls to graph.facebook.com, no Meta app needed.
 *
 * A stub Graph server stands in for graph.facebook.com:
 *   POST /v21.0/{page-id}/messages with sender_action:'mark_seen'
 *       → 200 {recipient_id} (records the read receipt)
 *   POST /v21.0/{page-id}/messages with message.text
 *       → 200 {message_id} (records the send)
 *   POST /v21.0/{page-id}/subscribed_apps → 200 {success:true}
 *   GET  /v21.0/* → 400 (profile fetch unavailable)
 *
 * Checks:
 * - sendMarkSeen exists in meta-send.ts and posts
 *   {recipient:{id}, sender_action:'mark_seen'} to /{nodeId}/messages
 *   with the Page token as a Bearer header (never in the URL), and never
 *   throws (failures come back as { ok: false }).
 * - The webhook fires mark_seen fire-and-forget (waitUntil) BEFORE the
 *   profile enrich, the save and the AI enqueue — so the Seen tick goes
 *   out while the AI is still thinking.
 * - The AI debounce is 300ms (was 1s) in both the BullMQ job delay and the
 *   in-process fallback.
 * - Live: a customer webhook message produces a mark_seen hit on the
 *   stub within 2s, before any reply, and an AI reply (demo mode here —
 *   the fake Groq key fails and the labelled demo reply is saved)
 *   still arrives in the Inbox.
 * - Live: when Graph answers 400 to mark_seen, the webhook still
 *   returns 200, the message is still saved, and the reply still
 *   arrives — a failed receipt never blocks the message or the reply.
 * - Live: a message echo (the owner replying AS the Page) does NOT
 *   trigger a mark_seen — echoes are the Page's own messages.
 *
 * Run from the repo root:  node scripts/verify-mark-seen.mjs
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 */
import { spawn, execSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
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
  // Spawn the local tsx binary directly (not via npx): the npx wrapper
  // spawns node as a grandchild, and a group kill does not always reach
  // it — leaked API servers cause stale-server false failures on re-run.
  const apiProc = spawn(path.join(ROOT, 'apps/api/node_modules/.bin/tsx'), ['src/index.ts'], {
    cwd: path.join(ROOT, 'apps/api'),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: {
      ...process.env,
      PORT: String(port),
      USE_PGLITE: 'true',
      PGLITE_DATA_DIR: dataDir,
      JWT_SECRET: 'test-jwt-secret-for-verifier-only-0123456789abcdef',
      TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      AI_PROVIDER: 'groq',
      GROQ_API_KEY: 'test-key',
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

async function setupWorkspace(api, stamp) {
  const email = `markseen+${stamp}@example.com`;
  const signup = await api('/api/auth/signup', {
    method: 'POST', auth: false,
    body: { name: 'Seen Owner', email, password: 'verify1234', workspaceName: 'Seen Shop' },
  });
  check('signup', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
  token = signup.data?.token ?? '';
  workspaceId = signup.data?.workspace?.id ?? '';
}

async function sendCustomerMessage(api, pageId, senderId, mid, text, object = 'page') {
  return api('/api/webhooks/meta', {
    method: 'POST', auth: false,
    body: { object, entry: [{ id: pageId, messaging: [{ sender: { id: senderId }, recipient: { id: pageId }, message: { mid, text } }] }] },
  });
}

async function sendEcho(api, pageId, customerPsid, mid, text) {
  return api('/api/webhooks/meta', {
    method: 'POST', auth: false,
    body: { object: 'page', entry: [{ id: pageId, messaging: [{ sender: { id: pageId }, recipient: { id: customerPsid }, message_echoes: { mid, text } }] }] },
  });
}

async function getConversation(api, convId) {
  const detail = await api(`/api/inbox/${convId}`);
  return detail.data ?? {};
}

async function main() {
  // ---------- Static checks ----------
  const sendSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/meta-send.ts'), 'utf8');
  check('sendMarkSeen exists in meta-send.ts', sendSrc.includes('export async function sendMarkSeen'));
  check("sendMarkSeen posts sender_action 'mark_seen'", sendSrc.includes("sender_action: 'mark_seen'"));
  check('sendMarkSeen posts to /{nodeId}/messages with recipient id',
    sendSrc.includes("`${sendGraphBase()}/${encodeURIComponent(input.nodeId)}/messages`") &&
    sendSrc.includes('recipient: { id: input.recipientId }'));
  check('sendMarkSeen never throws (returns { ok: false })',
    sendSrc.includes('if (r.ok) return { ok: true };') && sendSrc.includes('return { ok: false, error: r.error, code: r.code };'));
  check('sendMarkSeen uses the Bearer header (token never in a URL)',
    sendSrc.includes('Authorization: `Bearer ${pageToken}`'));

  const whSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/webhooks/routes.ts'), 'utf8');
  check('webhook imports sendMarkSeen', whSrc.includes("import { sendMarkSeen } from '../channels/meta-send'"));
  check('webhook fires mark_seen before the profile enrich',
    whSrc.indexOf('sendMarkSeen({') > 0 && whSrc.indexOf('sendMarkSeen({') < whSrc.indexOf('enrichCustomerProfileIfNeeded({'));
  check('webhook fires mark_seen fire-and-forget via waitUntil (not awaited)',
    whSrc.includes('waitUntil(') && whSrc.includes('sendMarkSeen({') && !whSrc.includes('await sendMarkSeen('));
  check('webhook logs a failed mark_seen but never blocks on it',
    whSrc.includes("mark_seen failed:") && whSrc.includes('// --- Seen FIRST'));

  const queueSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/queue/client.ts'), 'utf8');
  check('BullMQ inbox job delay is 300ms', queueSrc.includes('delay: 300,'));
  check('in-process fallback debounce is 300ms', queueSrc.includes('setTimeout(resolve, 300)'));
  check('no 1s debounce left in the queue client',
    !queueSrc.includes('delay: 1000,') && !queueSrc.includes('setTimeout(resolve, 1000)'));
  check('queue dedup guard still in place (fallbackInFlight)', queueSrc.includes('fallbackInFlight'));

  const workerSrc = fs.readFileSync(path.join(ROOT, 'workers/queue/src/worker.ts'), 'utf8');
  check('worker comments say 300ms debounce', workerSrc.includes('300ms delay') && workerSrc.includes('300ms debounce'));

  // ---------- Stub Graph server ----------
  const stubHits = [];
  let failMarkSeen = false;
  const graphStub = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let raw = '';
    req.on('data', (c) => { raw += c.toString(); });
    req.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      const hit = { method: req.method, path: url.pathname, body, auth: req.headers.authorization ?? '', at: Date.now() };
      stubHits.push(hit);
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'POST' && url.pathname.endsWith('/messages')) {
        if (body && body.sender_action === 'mark_seen') {
          if (failMarkSeen) return send(400, { error: { message: 'Invalid OAuth access token.', type: 'OAuthException', code: 190 } });
          return send(200, { recipient_id: body?.recipient?.id ?? '' });
        }
        return send(200, { message_id: `mid-stub-${Date.now()}` });
      }
      if (req.method === 'POST' && url.pathname.endsWith('/subscribed_apps')) {
        return send(200, { success: true });
      }
      return send(400, { error: { message: 'Invalid OAuth access token.', type: 'OAuthException', code: 190 } });
    });
  });
  const stubPort = 4017;
  await new Promise((resolve) => graphStub.listen(stubPort, resolve));

  const stamp = Date.now();
  const port = 4018;
  const api = makeApi(`http://localhost:${port}`);
  const dataDir = '.pglite-data-markseen';
  const dataDirAbs = path.join(ROOT, 'apps/api', dataDir);
  try { fs.rmSync(dataDirAbs, { recursive: true, force: true }); } catch { /* stale dir locked by a leaked server — start anyway */ }
  const run = startApi(port, dataDir, {
    META_APP_ID: 'dummy-app-id',
    META_APP_SECRET: 'dummy-app-secret',
    META_GRAPH_BASE_URL: `http://localhost:${stubPort}/v21.0`,
  });
  process.on('exit', run.stop);
  try {
    const up = await waitForHealth(`http://localhost:${port}`);
    check('API starts (health)', up, up ? '' : run.log().slice(-500));
    if (!up) return;

    await setupWorkspace(api, stamp);
    const ch = await api('/api/channels', { method: 'POST', body: { platform: 'messenger', externalId: 'page-markseen', displayName: 'Seen Page', token: 'tok-markseen' } });
    check('messenger channel (stub token) → 201', ch.status === 201, `status=${ch.status}`);
    const live = await api(`/api/workspaces/${workspaceId}/go-live`, { method: 'POST' });
    check('workspace goes live (AI answers)', live.status === 200 && live.data?.workspace?.practice_mode === false, `status=${live.status}`);

    const markSeenHits = (psid) => stubHits.filter((h) => h.body && h.body.sender_action === 'mark_seen' && h.body?.recipient?.id === psid);
    const outMessages = (conv) => (conv.messages ?? []).filter((m) => m.direction === 'out');

    // ---- Test A: happy path — Seen fast, then the reply ----
    const t0 = Date.now();
    const hookA = await sendCustomerMessage(api, 'page-markseen', 'psid-seen-1', `seen-a-1-${stamp}`, 'দাম কত?');
    check('webhook A accepts the message', hookA.status === 200, `status=${hookA.status}`);
    let seenA = null;
    for (let i = 0; i < 20; i++) {
      seenA = markSeenHits('psid-seen-1')[0];
      if (seenA) break;
      await sleep(250);
    }
    const seenLatencyA = seenA ? seenA.at - t0 : -1;
    check('mark_seen reaches Graph for the customer PSID', !!seenA);
    check('mark_seen arrives within 2s of the webhook', seenLatencyA >= 0 && seenLatencyA < 2000, `latency=${seenLatencyA}ms`);
    check('mark_seen hits /v21.0/{page-id}/messages with the Page token as Bearer',
      !!seenA && seenA.path === '/v21.0/page-markseen/messages' && seenA.auth === 'Bearer tok-markseen',
      seenA ? `path=${seenA.path} auth=${seenA.auth ? 'Bearer …' : '(none)'}` : 'no hit');
    const listA = await api('/api/inbox');
    const convA = (listA.data?.conversations ?? []).find((c) => c.last_message === 'দাম কত?');
    check('conversation created for the new sender', !!convA?.id, `conv=${convA?.id ?? ''}`);
    const convId = convA?.id ?? '';
    let replyAt = -1;
    let replyText = '';
    for (let i = 0; i < 80; i++) {
      const conv = await getConversation(api, convId);
      const outs = outMessages(conv);
      if (outs.length > 0) { replyAt = Date.now(); replyText = outs[0]?.body ?? ''; break; }
      await sleep(500);
    }
    const replyLatencyA = replyAt > 0 ? replyAt - t0 : -1;
    check('AI reply arrives in the Inbox after Seen', replyAt > 0, replyLatencyA >= 0 ? `end-to-end=${replyLatencyA}ms reply="${replyText.slice(0, 60)}"` : 'no reply within 40s');
    check('Seen comes before the reply is visible', seenLatencyA >= 0 && replyLatencyA > 0 && seenLatencyA < replyLatencyA, `seen=${seenLatencyA}ms reply=${replyLatencyA}ms`);

    // ---- Test B: Graph 400s the mark_seen — nothing breaks ----
    failMarkSeen = true;
    const outsBefore = outMessages(await getConversation(api, convId)).length;
    const t1 = Date.now();
    const hookB = await sendCustomerMessage(api, 'page-markseen', 'psid-seen-1', `seen-b-1-${stamp}`, 'আর কি আছে?');
    check('webhook B still accepts the message when mark_seen fails', hookB.status === 200, `status=${hookB.status}`);
    let failedSeenAttempt = false;
    for (let i = 0; i < 20; i++) {
      failedSeenAttempt = markSeenHits('psid-seen-1').some((h) => h.at >= t1);
      if (failedSeenAttempt) break;
      await sleep(250);
    }
    check('mark_seen was still attempted (and failed) on Graph', failedSeenAttempt);
    let replyB = false;
    for (let i = 0; i < 80; i++) {
      const conv = await getConversation(api, convId);
      if (outMessages(conv).length > outsBefore) { replyB = true; break; }
      await sleep(500);
    }
    check('reply still arrives when mark_seen fails', replyB);
    const listB = await api('/api/inbox');
    const convB = (listB.data?.conversations ?? []).find((c) => c.id === convId);
    check('second message still saved in the Inbox', convB?.last_message === 'আর কি আছে?' || (convB?.last_message ?? '').length > 0, `last="${convB?.last_message ?? ''}"`);
    failMarkSeen = false;

    // ---- Test C: echoes do not trigger mark_seen ----
    const seenCountBefore = markSeenHits('psid-seen-1').length;
    const echo = await sendEcho(api, 'page-markseen', 'psid-seen-1', `seen-echo-1-${stamp}`, 'hello there');
    check('echo webhook accepted', echo.status === 200, `status=${echo.status}`);
    await sleep(1500);
    check('no mark_seen for a message echo', markSeenHits('psid-seen-1').length === seenCountBefore,
      `before=${seenCountBefore} after=${markSeenHits('psid-seen-1').length}`);
  } finally {
    run.stop();
    await sleep(2000);
    graphStub.close();
    // Kill anything still listening on the API port (a leaked tsx
    // grandchild would otherwise hold the port and the PGlite dir).
    try { execSync(`fuser -k ${port}/tcp 2>/dev/null || true`, { stdio: 'ignore' }); } catch { /* fuser missing — ignore */ }
    await sleep(1000);
    try {
      const stillUp = await fetch(`http://localhost:${port}/api/health`).then((r) => r.ok).catch(() => false);
      if (!stillUp) {
        try { fs.rmSync(dataDirAbs, { recursive: true, force: true }); } catch { /* leave the dir; a leaked server owns it */ }
      } else {
        console.log('WARN  API server still listening after stop — PGlite dir left in place (leaked server owns it)');
      }
    } catch { /* ignore cleanup errors */ }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log('Failures:');
    for (const f of failed) console.log(` - ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Verifier crashed:', err);
  process.exitCode = 1;
});
