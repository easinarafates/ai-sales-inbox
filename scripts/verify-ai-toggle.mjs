#!/usr/bin/env node
/**
 * Verification for the AI ON/OFF switch + Messenger dot commands.
 * Local, offline — no calls to graph.facebook.com, no Meta app needed.
 *
 * A stub Graph server stands in for graph.facebook.com:
 *   POST /v21.0/{page-id}/messages       → 200 {message_id} (records the send)
 *   POST /v21.0/{page-id}/subscribed_apps → 200 {success:true} (records fields)
 *   GET  /v21.0/*                         → 400 (profile fetch unavailable)
 *
 * Checks:
 * - Migration 19 adds workspaces.owner_psid (idempotent).
 * - parseDotCommand: '.' toggles, '.on'/'.ai on' = on, '.off'/'.ai off' = off;
 *   '..', '.5', 'hello.' are NOT commands.
 * - POST /api/inbox/:id/mode sets the mode explicitly (400 on bad mode,
 *   404 on unknown conversation); POST /dot flips it.
 * - A mode change cancels a pending timed handover (handover_until cleared).
 * - POST /api/inbox/:id/mark-owner marks the customer as the owner; the
 *   detail response reports ownerMarked without exposing the PSID.
 * - Webhook '.' from the marked owner toggles the mode AND sends the short
 *   Bengali confirmation into the chat; the '.' itself is never saved as a
 *   customer message and never enqueued for an AI reply.
 * - '.on' / '.off' / '.ai on' set the mode explicitly.
 * - Webhook '.' from a stranger: mode unchanged, NO confirmation sent,
 *   message saved but never answered by the AI (silent ignore).
 * - Message echoes (owner replying AS the Page): a '.' echo with no
 *   app_id toggles + confirms; an echo WITH app_id is ignored; a
 *   non-dot echo is ignored. Both the message_echoes object shape and
 *   the message.is_echo shape are handled.
 * - POST /api/channels/:id/resubscribe re-subscribes with the current
 *   field list (incl. message_echoes).
 * - SUBSCRIBED_FIELDS includes message_echoes.
 * - Web Inbox has the AI উত্তর switch (role="switch") at the top of the
 *   thread, the dot hint, and the mark-owner button.
 *
 * Run from the repo root:  node scripts/verify-ai-toggle.mjs
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
  const apiProc = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: path.join(ROOT, 'apps/api'),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: {
      ...process.env,
      PORT: String(port),
      USE_PGLITE: 'true',
      PGLITE_DATA_DIR: dataDir,
      JWT_SECRET: 'verify-jwt-secret-0123456789abcdef0123456789abcdef',
      TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      AI_PROVIDER: 'groq',
      GROQ_API_KEY: 'verify-groq-key',
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
  const email = `toggle+${stamp}@example.com`;
  const signup = await api('/api/auth/signup', {
    method: 'POST', auth: false,
    body: { name: 'Toggle Owner', email, password: 'verify1234', workspaceName: 'Toggle Shop' },
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

async function sendEcho(api, pageId, customerPsid, mid, text, appId = null, useIsEcho = false) {
  const messagingEvent = useIsEcho
    ? { sender: { id: pageId }, recipient: { id: customerPsid }, message: { mid, text, is_echo: true, ...(appId ? { app_id: appId } : {}) } }
    : { sender: { id: pageId }, recipient: { id: customerPsid }, message_echoes: { mid, text, ...(appId ? { app_id: appId } : {}) } };
  return api('/api/webhooks/meta', {
    method: 'POST', auth: false,
    body: { object: 'page', entry: [{ id: pageId, messaging: [messagingEvent] }] },
  });
}

async function getMode(api, convId) {
  const detail = await api(`/api/inbox/${convId}`);
  return detail.data?.conversation?.mode ?? null;
}

async function getMessages(api, convId) {
  const detail = await api(`/api/inbox/${convId}`);
  return detail.data?.messages ?? [];
}

async function main() {
  // ---------- Static checks ----------
  const dotSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/inbox/dot-commands.ts'), 'utf8');
  check('dot-commands module exists', dotSrc.length > 0);
  check("parseDotCommand: '.' toggles", dotSrc.includes("if (text === '.') return 'toggle'"));
  check("parseDotCommand: '.on' / '.ai on' = on", dotSrc.includes("'.ai on'") && dotSrc.includes("return 'on'"));
  check("parseDotCommand: '.off' / '.ai off' = off", dotSrc.includes("'.ai off'") && dotSrc.includes("return 'off'"));
  check('mode change cancels timed handover', dotSrc.includes('handover_until = NULL'));
  check('confirmation texts are the specified Bengali strings',
    dotSrc.includes('AI উত্তর চালু হয়েছে') && dotSrc.includes('AI উত্তর বন্ধ হয়েছে'));
  check('owner PSID is read from workspaces.owner_psid', dotSrc.includes('owner_psid'));

  const mig19 = fs.readFileSync(path.join(ROOT, 'apps/api/src/db/migrations/19-ai-toggle-owner.sql'), 'utf8');
  check('migration 19 adds workspaces.owner_psid (idempotent)', mig19.includes('owner_psid') && mig19.includes('IF NOT EXISTS'));

  const inboxSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/inbox/routes.ts'), 'utf8');
  check('inbox routes have POST /:id/mode', inboxSrc.includes("post('/:id/mode'"));
  check('inbox routes have POST /:id/mark-owner', inboxSrc.includes("post('/:id/mark-owner'"));
  check('inbox detail reports ownerMarked without the PSID', inboxSrc.includes('ownerMarked') && !inboxSrc.includes('owner_psid:'));
  check('inbox /dot uses the shared toggle (handover-cancelling)', inboxSrc.includes('toggleAiMode'));

  const whSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/webhooks/routes.ts'), 'utf8');
  check('webhook handles message echoes', whSrc.includes('message_echoes') && whSrc.includes('is_echo'));
  check('webhook only trusts echoes without app_id', whSrc.includes('echo.app_id'));
  check('webhook checks the marked owner PSID for dot commands', whSrc.includes('getWorkspaceOwnerPsid'));
  check('webhook sends the mode confirmation after a dot toggle', whSrc.includes('sendModeConfirmation'));

  const oauthSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/meta-oauth.ts'), 'utf8');
  check('SUBSCRIBED_FIELDS includes message_echoes', oauthSrc.includes('message_echoes'));

  const chSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/routes.ts'), 'utf8');
  check('channels routes have POST /:id/resubscribe', chSrc.includes("post('/:id/resubscribe'"));

  const pageSrc = fs.readFileSync(path.join(ROOT, 'apps/web/app/inbox/page.tsx'), 'utf8');
  check('inbox page has the AI উত্তর switch at the top of the thread', pageSrc.includes('role="switch"') && pageSrc.includes('inbox.aiReply'));
  check('inbox page explains the dot command + handover cancel', pageSrc.includes('inbox.dotHint'));
  check('inbox page has the mark-owner button', pageSrc.includes('inbox.markOwner') && pageSrc.includes('markOwner('));
  check('inbox page calls setMode for the switch', pageSrc.includes('inboxApi.setMode'));

  const libSrc = fs.readFileSync(path.join(ROOT, 'apps/web/lib/api.ts'), 'utf8');
  check('web api client has setMode + markOwner', libSrc.includes('setMode:') && libSrc.includes('markOwner:'));

  // ---------- Stub Graph server ----------
  const stubHits = [];
  const graphStub = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let raw = '';
    req.on('data', (c) => { raw += c.toString(); });
    req.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      stubHits.push({ method: req.method, path: url.pathname, body, auth: req.headers.authorization ?? '' });
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'POST' && url.pathname.endsWith('/messages')) {
        return send(200, { message_id: `mid-stub-${Date.now()}` });
      }
      if (req.method === 'POST' && url.pathname.endsWith('/subscribed_apps')) {
        return send(200, { success: true });
      }
      return send(400, { error: { message: 'Invalid OAuth access token.', type: 'OAuthException', code: 190 } });
    });
  });
  const stubPort = 4015;
  await new Promise((resolve) => graphStub.listen(stubPort, resolve));

  const stamp = Date.now();
  const port = 4016;
  const api = makeApi(`http://localhost:${port}`);
  const run = startApi(port, '.pglite-data-toggle', {
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
    const ch = await api('/api/channels', { method: 'POST', body: { platform: 'messenger', externalId: 'page-toggle', displayName: 'Toggle Page', token: 'tok-toggle' } });
    check('messenger channel (stub token) → 201', ch.status === 201, `status=${ch.status}`);
    const channelId = ch.data?.channel?.id ?? '';

    // A customer writes first; a conversation is created in AI mode.
    const hook1 = await sendCustomerMessage(api, 'page-toggle', 'psid-owner', `t-mid-1-${stamp}`, 'হ্যালো, দাম কত?');
    check('webhook accepts the first message', hook1.status === 200, `status=${hook1.status}`);
    const list = await api('/api/inbox');
    const conv = (list.data?.conversations ?? []).find((c) => c.last_message === 'হ্যালো, দাম কত?');
    check('conversation created for the new sender', !!conv?.id, `conv=${conv?.id ?? ''}`);
    const convId = conv?.id ?? '';
    check('new conversation starts in AI mode', (await getMode(api, convId)) === 'ai', `mode=${await getMode(api, convId)}`);

    // ---- Toggle endpoint + handover cancel ----
    const modeBad = await api(`/api/inbox/${convId}/mode`, { method: 'POST', body: { mode: 'maybe' } });
    check('POST /mode rejects a bad mode (400)', modeBad.status === 400, `status=${modeBad.status}`);
    const mode404 = await api('/api/inbox/00000000-0000-0000-0000-000000000000/mode', { method: 'POST', body: { mode: 'human' } });
    check('POST /mode on an unknown conversation → 404', mode404.status === 404, `status=${mode404.status}`);
    const modeHuman = await api(`/api/inbox/${convId}/mode`, { method: 'POST', body: { mode: 'human' } });
    check('POST /mode human → mode human', modeHuman.status === 200 && modeHuman.data?.conversation?.mode === 'human', `status=${modeHuman.status}`);
    check('detail reflects human mode', (await getMode(api, convId)) === 'human');
    const dotBack = await api(`/api/inbox/${convId}/dot`, { method: 'POST' });
    check('POST /dot flips human → ai', dotBack.status === 200 && dotBack.data?.conversation?.mode === 'ai', `status=${dotBack.status}`);
    const hand = await api(`/api/inbox/${convId}/handover`, { method: 'POST', body: { durationSeconds: 300 } });
    check('timed handover sets human mode', hand.status === 200 && hand.data?.handover?.mode === 'human' && hand.data?.handover?.active === true, `status=${hand.status}`);
    const modeAi = await api(`/api/inbox/${convId}/mode`, { method: 'POST', body: { mode: 'ai' } });
    check('POST /mode ai after a handover → mode ai', modeAi.status === 200 && modeAi.data?.conversation?.mode === 'ai');
    const handAfter = await api(`/api/inbox/${convId}/handover`);
    check('toggle cancels the pending handover (until cleared)', handAfter.data?.handover?.active === false && handAfter.data?.handover?.handoverUntil === null, JSON.stringify(handAfter.data?.handover ?? null));

    // ---- Mark owner ----
    const mark = await api(`/api/inbox/${convId}/mark-owner`, { method: 'POST' });
    check('POST /mark-owner → ownerMarked true', mark.status === 200 && mark.data?.ownerMarked === true, `status=${mark.status}`);
    const detailAfterMark = await api(`/api/inbox/${convId}`);
    check('detail reports ownerMarked true', detailAfterMark.data?.ownerMarked === true);
    check('detail adds no owner_psid field (no new PSID exposure)', !JSON.stringify(detailAfterMark.data ?? {}).includes('owner_psid'));
    check('mark-owner response never contains the raw PSID', !JSON.stringify(mark.data ?? {}).includes('psid-owner'));

    // ---- Owner dot commands over Messenger ----
    // Text sends only: POST /messages hits include the mark_seen read
    // receipts (sender_action, no message body) — those are not sends.
    const textSends = () => stubHits.filter((h) => h.path.endsWith('/messages') && h.body && typeof h.body.message === 'object');
    const sendsBefore = textSends().length;
    const dotOff = await sendCustomerMessage(api, 'page-toggle', 'psid-owner', `t-mid-2-${stamp}`, '.');
    check("owner '.' accepted (200)", dotOff.status === 200, `status=${dotOff.status}`);
    check("owner '.' flips ai → human", (await getMode(api, convId)) === 'human');
    const msgsAfterDot = await getMessages(api, convId);
    check("the '.' itself is never saved as a customer message", !msgsAfterDot.some((m) => m.direction === 'in' && m.body === '.'));
    const sendsAfterDot = textSends();
    check('OFF confirmation sent to Messenger (Bengali)', sendsAfterDot.length === sendsBefore + 1 && (sendsAfterDot[sendsAfterDot.length - 1]?.body?.message?.text ?? '').includes('AI উত্তর বন্ধ হয়েছে'), JSON.stringify(sendsAfterDot[sendsAfterDot.length - 1]?.body ?? null));
    const dotOn = await sendCustomerMessage(api, 'page-toggle', 'psid-owner', `t-mid-3-${stamp}`, '.on');
    check("owner '.on' → AI on", (await getMode(api, convId)) === 'ai');
    const sendsAfterOn = textSends();
    check('ON confirmation sent to Messenger (Bengali)', (sendsAfterOn[sendsAfterOn.length - 1]?.body?.message?.text ?? '').includes('AI উত্তর চালু হয়েছে'));
    const dotAiOff = await sendCustomerMessage(api, 'page-toggle', 'psid-owner', `t-mid-4-${stamp}`, '.ai off');
    check("owner '.ai off' → human", (await getMode(api, convId)) === 'human');
    const dotAiOn = await sendCustomerMessage(api, 'page-toggle', 'psid-owner', `t-mid-5-${stamp}`, '.ai on');
    check("owner '.ai on' → ai", (await getMode(api, convId)) === 'ai');
    const dotDot = await sendCustomerMessage(api, 'page-toggle', 'psid-owner', `t-mid-6-${stamp}`, '..');
    check("'..' is NOT a command (mode unchanged)", (await getMode(api, convId)) === 'ai');
    const msgsAfterDotDot = await getMessages(api, convId);
    check("'..' is saved as an ordinary message", msgsAfterDotDot.some((m) => m.direction === 'in' && m.body === '..'));

    // ---- Stranger dot commands are ignored silently ----
    const outsBeforeStranger = (await getMessages(api, convId)).filter((m) => m.direction === 'out').length;
    const sendsBeforeStranger = textSends().length;
    const stranger = await sendCustomerMessage(api, 'page-toggle', 'psid-stranger', `t-mid-7-${stamp}`, '.off');
    check("stranger '.off' accepted (200, no error to the customer)", stranger.status === 200, `status=${stranger.status}`);
    check("stranger '.off' does NOT change the mode", (await getMode(api, convId)) === 'ai');
    const sendsAfterStranger = textSends().length;
    check('stranger dot sends NO confirmation', sendsAfterStranger === sendsBeforeStranger, `sends=${sendsAfterStranger} vs ${sendsBeforeStranger}`);
    await sleep(4500); // past the 1s debounce: the AI must not answer the stranger's dot
    const msgsAfterWait = await getMessages(api, convId);
    check("stranger's '.' gets NO AI reply", msgsAfterWait.filter((m) => m.direction === 'out').length === outsBeforeStranger,
      `out before=${outsBeforeStranger}, after=${msgsAfterWait.filter((m) => m.direction === 'out').length}`);

    // ---- Message echoes (owner replying AS the Page) ----
    const echoDot = await sendEcho(api, 'page-toggle', 'psid-owner', `t-echo-1-${stamp}`, '.');
    check('echo dot accepted (200)', echoDot.status === 200, `status=${echoDot.status}`);
    check("echo '.' flips ai → human", (await getMode(api, convId)) === 'human');
    const sendsAfterEcho = textSends();
    check('echo dot sends the OFF confirmation', (sendsAfterEcho[sendsAfterEcho.length - 1]?.body?.message?.text ?? '').includes('AI উত্তর বন্ধ হয়েছে'));
    const echoApp = await sendEcho(api, 'page-toggle', 'psid-owner', `t-echo-2-${stamp}`, '.on', '959927956839086');
    check('echo WITH app_id is ignored (mode unchanged)', (await getMode(api, convId)) === 'human');
    const echoText = await sendEcho(api, 'page-toggle', 'psid-owner', `t-echo-3-${stamp}`, 'ঠিক আছে, ধন্যবাদ');
    check('non-dot echo is ignored (mode unchanged)', (await getMode(api, convId)) === 'human');
    const echoIsEcho = await sendEcho(api, 'page-toggle', 'psid-owner', `t-echo-4-${stamp}`, '.on', null, true);
    check('is_echo shape also toggles (→ ai)', (await getMode(api, convId)) === 'ai');

    // ---- Re-subscribe ----
    const resub = await api(`/api/channels/${channelId}/resubscribe`, { method: 'POST' });
    check('POST /resubscribe → subscribed true', resub.status === 200 && resub.data?.subscribed === true, `status=${resub.status}`);
    const subHit = stubHits.find((h) => h.path.endsWith('/subscribed_apps'));
    // The stub records the raw urlencoded body, e.g.
    // "subscribed_fields=messages%2Cmessaging_postbacks%2Cfeed%2Cmessage_echoes".
    check('re-subscribe asks for message_echoes', !!subHit && String(subHit.body ?? '').includes('message_echoes'), JSON.stringify(subHit?.body ?? null));
  } finally {
    run.stop();
    try { graphStub.close(); } catch { /* already gone */ }
    await sleep(2000);
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
