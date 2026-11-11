#!/usr/bin/env node
/**
 * Verification for angry / abusive / diverting-customer handling
 * (2026-11-11) — an extension of the Waiting escalation system.
 *
 * The problem (owner report): a customer who gets angry, swears or
 * abuses (including in Bengali), talks nonsense, or keeps diverting
 * off-topic burned AI credit on every message. Investigation found
 * most of the machinery already existed (2026-11-08) — deterministic
 * pre-AI anger + off-topic checks, waiting/human escalation, and the
 * top-bell notification — but three real gaps:
 *  1. detectAnger() had NO swear/abuse words at all (Bengali gali
 *     included): a swearing customer sailed straight to the AI.
 *  2. The bell notification TITLE had no customer name ("কাস্টমার
 *     রেগে গিয়েছে") — the owner asked for "[Customer name] রেগে
 *     গিয়েছে".
 *  3. Short Bengali nonsense had no guard (detectGibberish() returns
 *     false for any Bengali-script text, and the long-text off-topic
 *     layer only catches >= 60 chars).
 *  4. THE BELL API 403s FOR NON-PLATFORM-OWNERS (found by this
 *     verifier, 2026-11-11): GET /api/notifications returns 403
 *     "Owner access only" for an ordinary shop owner. Cause is a
 *     mount-order accident in apps/api/src/index.ts — the
 *     ai-providers router runs router-level requireOwner on a bare
 *     '/api' mount, and it is mounted BEFORE /api/notifications (and
 *     /api/delivery-charges, same cause), so Express runs requireOwner
 *     before the notifications router is ever reached. The endpoint
 *     itself is fine (it returns 200 with the named notifications
 *     once the caller IS a platform owner). Arafat IS the platform
 *     owner, so his bell works — but every other shop owner sees an
 *     empty bell. FIX (one line, in index.ts — NOT one of this
 *     task's owned files, so it is flagged here, not applied): move
 *     app.use('/api/notifications', notificationsRouter) — and the
 *     delivery-charges mount — ABOVE app.use('/api',
 *     aiProvidersRouter). This verifier proves the 403 as a failing
 *     check, then promotes the test user to platform owner (via the
 *     real POST /api/owner/setup bootstrap, mirroring Arafat) and
 *     proves the owner's bell works end-to-end.
 *
 * The fix (all in the owned files):
 * - apps/api/src/inbox/escalation.ts: curated abuse blocklist
 *   (Bengali-script stems + Romanized + English, whole-word where
 *   possible) inside detectAnger(); notification titles now carry
 *   the real customer name; new isRepeatedNonShopMessage() guard —
 *   the same long non-shop text 3 times running escalates (a single
 *   short Bengali nonsense message has no safe deterministic test,
 *   so only the repetition escalates).
 * - apps/api/src/ai-agent/agent.ts: the repeated-nonsense check runs
 *   right after the off-topic check, still BEFORE any AI call and
 *   before the subscription gate. Voice notes still transcribe first
 *   (the words are unknowable until transcribed) — that one Gemini
 *   call is unavoidable, but it writes NO ledger row and charges NO
 *   wallet credit, and the reply-generation cost stays zero.
 * - The bell itself (apps/web/components/AppShell.tsx) needed NO
 *   change: it already polls /api/notifications, renders title +
 *   body, and opens /inbox?conversation=<id> on tap. It stays in
 *   the top header; no bar was moved or created.
 *
 * Checks (all messages below are SIMULATED test inputs, never live
 * customer messages):
 * - Static: abuse list present + conservative (no bare 'বাল' /
 *   'হারাম' stems, no mild words), name in the notification titles,
 *   anger + repeated checks before any AI call, bell renders the
 *   title/body and links to the conversation, no new migration.
 * - Boot 1 (local API on PGlite, webchat webhook end-to-end):
 *   abusive Bengali / English / Romanized messages → waiting /
 *   human / angry_customer with NO reply and a bell notification
 *   titled "[Name] রেগে গিয়েছে"; a normal complaint ("দাম বেশি")
 *   gets a reply and is NEVER angry_customer with no bell row; a
 *   normal price question stays open with a real ৳500 reply;
 *   repeated diverting → exactly ONE deterministic template reply.
 * - Driver (processBatch directly, same PGlite dir, API stopped):
 *   anger unit matrix (old + new abuse words true; normal
 *   complaints / refunds / bare 'হারাম' / 'বালক' false), repeat
 *   unit matrix, abusive BN/EN/Romanized + classic anger → waiting
 *   with 0 out messages, 0 ledger rows and a named bell row, no
 *   re-escalation / no second bell row on a second angry message,
 *   repeated off-topic → 1 template reply then human_mode, repeated
 *   nonsense (3x) → waiting/off_topic with 0 ledger rows, and
 *   controls proving the guard needs 3 repeats and never fires on
 *   shop questions.
 * - Boot 2 (same dir): ?status=waiting lists the waiting chats,
 *   the bell API serves the named notifications and mark-read works,
 *   a Meta webhook message to a waiting chat does NOT reopen it.
 *
 * NOTE on demo mode: the verifier boots with blank provider keys,
 * so normal replies come from the deterministic demo matcher. A
 * complaint like "দাম বেশি" has no product-keyword match, so demo
 * mode answers it with its pre-existing can't-answer fallback (and
 * escalates cant_answer) — that is demo-mode behaviour for any
 * unanswerable text, not this change. The assertions therefore prove
 * a complaint is NEVER angry_customer, gets a reply, and creates NO
 * bell row; "stays open" is asserted on the price question (which
 * the demo matcher answers from the real product) and is a live-
 * mode behaviour for the complaint (real Gemini answers it).
 *
 * Run from the repo root:  node scripts/verify-angry-customer.mjs
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const results = [];
let token = '';
/** Dummy webchat secret for the local boots (must match the boot env). */
const WEBCHAT_SECRET = 'angry-test-secret';
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
    const proc = spawn('npx', ['tsx', '../../scripts/angry-customer-driver.ts', workspaceId, jeansId], {
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
  check('no migration 48 file was created', !fs.existsSync(path.join(ROOT, 'apps/api/src/db/migrations/48-angry-customer.sql')));

  const escSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/inbox/escalation.ts'), 'utf8');
  check('escalation module exports detectAnger + isRepeatedNonShopMessage', escSrc.includes('export function detectAnger') && escSrc.includes('export function isRepeatedNonShopMessage'));
  check('abuse blocklist has Bengali-script gali', escSrc.includes("'বোকাচোদা'") && escSrc.includes("'মাদারচোদ'") && escSrc.includes("'খানকি'") && escSrc.includes("'হারামজাদা'"));
  check('abuse blocklist has English swearing', escSrc.includes("'fucking'") && escSrc.includes("'bastard'") && escSrc.includes("'shit'"));
  check('abuse blocklist has Romanized Bengali gali', escSrc.includes("'bokachoda'") && escSrc.includes("'madarchod'") && escSrc.includes("'khanki'"));
  check("conservative: no bare 'বাল' stem (it hides inside 'বালক')", (() => { const b = escSrc.match(/const BENGALI_ABUSE_STEMS = \[([\s\S]*?)\];/); return !!b && !/'বাল',/.test(b[1]); })());
  check("conservative: no bare 'হারাম' stem (normal religious word)", (() => { const b = escSrc.match(/const BENGALI_ABUSE_STEMS = \[([\s\S]*?)\];/); return !!b && !/'হারাম',/.test(b[1]); })());
  const abuseBlock = escSrc.match(/const ABUSE_WORDS = \[([\s\S]*?)\];/);
  check('conservative: mild words (damn/hell/crap) are NOT in the abuse list', !!abuseBlock && !/'damn'/.test(abuseBlock[1]) && !/'hell'/.test(abuseBlock[1]) && !/'crap'/.test(abuseBlock[1]));
  check('notification title carries the customer name (angry)', escSrc.includes('title: `${name} রেগে গিয়েছে`'));
  check('notification title carries the customer name (off-topic/diverting)', escSrc.includes('title: `${name} বিষয়ের বাইরে প্রশ্ন করছে`'));
  check('notification body carries the customer name', escSrc.includes('body: `${name} রেগে গিয়েছে'));

  const indexSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/index.ts'), 'utf8');
  const notifMount = indexSrc.indexOf("app.use('/api/notifications'");
  const aiProvMount = indexSrc.indexOf("app.use('/api', aiProvidersRouter)");
  check('KNOWN GAP — /api/notifications mounts AFTER the bare-/api ai-providers router (requireOwner claims it first)', notifMount > 0 && aiProvMount > 0 && notifMount < aiProvMount, `fix: move app.use('/api/notifications', notificationsRouter) above app.use('/api', aiProvidersRouter) in apps/api/src/index.ts (same for /api/delivery-charges)`);

  const agentSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/ai-agent/agent.ts'), 'utf8');
  const angerIdx = agentSrc.indexOf('detectAnger(batchedText)');
  const aiCallIdx = agentSrc.indexOf('callAiForWorkspaceSplit(');
  check('agent: anger check present with escalated_angry_customer reason', angerIdx > 0 && agentSrc.includes("reason: 'escalated_angry_customer'"));
  check('agent: anger check runs BEFORE any AI call', angerIdx > 0 && aiCallIdx > 0 && angerIdx < aiCallIdx);
  const repeatIdx = agentSrc.indexOf('isRepeatedNonShopMessage(latestBody');
  check('agent: repeated-nonsense check present with its own reason', repeatIdx > 0 && agentSrc.includes("reason: 'escalated_repeated_nonsense'"));
  check('agent: repeated-nonsense check runs after the off-topic check, before any AI call', repeatIdx > agentSrc.indexOf('detectOffTopic(batchedText)') && repeatIdx < aiCallIdx);
  const transcribeIdx = agentSrc.indexOf('transcribeCustomerAudio(audioMsg.mediaUrl');
  check('agent: voice transcription runs before the anger check (known cost — see report)', transcribeIdx > 0 && transcribeIdx < angerIdx);
  const angerSegment = agentSrc.slice(angerIdx, agentSrc.indexOf("reason: 'escalated_angry_customer'", angerIdx));
  check('agent: anger path burns nothing (no charge / no ledger row on that path)', !angerSegment.includes('chargeForReply') && !angerSegment.includes('ai_usage_ledger'));
  const providersSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/ai-agent/providers.ts'), 'utf8');
  check('Groq fallback untouched (still wired in providers)', /groq/i.test(providersSrc));

  // Bell (top header, NOT moved, no new bar): it renders the
  // notification title + body and opens /inbox?conversation=<id>.
  const shellSrc = fs.readFileSync(path.join(ROOT, 'apps/web/components/AppShell.tsx'), 'utf8');
  const headerOpen = shellSrc.indexOf('<header');
  const headerClose = shellSrc.indexOf('</header>');
  const bellLabel = shellSrc.indexOf('header.notifications');
  check('bell: still inside the top <header> (not moved to the left)', headerOpen > 0 && headerClose > headerOpen && bellLabel > headerOpen && bellLabel < headerClose);
  check('bell: renders the notification title and body', shellSrc.includes('{n.title}') && shellSrc.includes('{n.body}'));
  check('bell: clicking a notification opens its chat (/inbox?conversation=<id>)', shellSrc.includes('router.push(`/inbox?conversation=${n.conversation_id}`)'));
  const inboxSrc = fs.readFileSync(path.join(ROOT, 'apps/web/app/inbox/page.tsx'), 'utf8');
  check('inbox: reads ?conversation= and opens that thread', inboxSrc.includes('searchParams.get("conversation")') && inboxSrc.includes('openThread(conversationParam)'));

  // ---------- Boot 1: webchat webhook end-to-end ----------
  const stamp = Date.now();
  const port = 4025;
  const dataDir = '.pglite-data-angry';
  const run1 = startApi(port, dataDir);
  process.on('exit', run1.stop);
  let workspaceId = '';
  let jeansId = '';
  let offTopicConvId = '';
  let offTopicNotifId = '';
  try {
    const up = await waitForHealth(`http://localhost:${port}`);
    check('boot 1: API starts', up, up ? '' : run1.log().slice(-500));
    if (!up) return;
    const api = makeApi(`http://localhost:${port}`);
    const ownerEmail = `angry+${stamp}@example.com`;
    const signup = await api('/api/auth/signup', {
      method: 'POST', auth: false,
      body: { name: 'Angry Owner', email: ownerEmail, password: 'verify1234', workspaceName: 'Angry Test Shop' },
    });
    check('boot 1: signup', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
    token = signup.data?.token ?? '';
    workspaceId = signup.data?.workspace?.id ?? '';
    const live = await api(`/api/workspaces/${workspaceId}/go-live`, { method: 'POST' });
    check('boot 1: go-live', live.status === 200 && live.data?.workspace?.practice_mode === false, `status=${live.status}`);
    const jeans = await api('/api/products', { method: 'POST', body: { name: 'Jeans', pricePaisa: 50000, stock: 10 } });
    check('boot 1: Jeans product created', jeans.status === 201, `status=${jeans.status}`);
    jeansId = jeans.data?.id ?? jeans.data?.product?.id ?? '';
    const ch = await api('/api/channels', { method: 'POST', body: { platform: 'webchat', externalId: 'site-angry', displayName: 'Angry Test Site' } });
    check('boot 1: webchat channel → 201', ch.status === 201, `status=${ch.status}`);

    // KNOWN GAP (see the header): as a plain shop owner (not a
    // platform owner) the bell API 403s — the ai-providers router's
    // bare-/api requireOwner runs before /api/notifications is
    // reached. Proved live here, then the test user is promoted to
    // platform owner (the real POST /api/owner/setup bootstrap —
    // Arafat IS the platform owner) so the owner's bell is verified
    // end-to-end below.
    const bellAsShopOwner = await api('/api/notifications?limit=20');
    check('KNOWN GAP — bell API works for a non-platform-owner shop account', bellAsShopOwner.status === 200, `status=${bellAsShopOwner.status} — GET /api/notifications 403s "Owner access only" for a shop owner; fix: move app.use('/api/notifications', notificationsRouter) above app.use('/api', aiProvidersRouter) in apps/api/src/index.ts`);
    const promote = await api('/api/owner/setup', { method: 'POST', auth: false, body: { email: ownerEmail } });
    check('boot 1: test user promoted to platform owner (mirrors Arafat)', promote.status === 200, `status=${promote.status} ${JSON.stringify(promote.data ?? {}).slice(0, 120)}`);

    async function sendWebchat(senderId, name, text) {
      const m = await api('/api/webhooks/webchat', {
        method: 'POST', auth: false,
        headers: { 'x-webchat-secret': WEBCHAT_SECRET },
        body: { externalId: 'site-angry', senderId, name, text },
      });
      return m;
    }
    async function bellFor(conversationId) {
      const list = await api('/api/notifications?limit=50');
      const rows = list.data?.notifications ?? [];
      return rows.find((n) => n.conversation_id === conversationId) ?? null;
    }
    async function waitWaiting(conversationId) {
      return pollFor(async () => {
        const detail = await api(`/api/inbox/${conversationId}`);
        const conv = detail.data?.conversation ?? {};
        return conv.status === 'waiting' ? conv : null;
      });
    }

    // (a1) Abusive Bengali-script message — only the NEW list catches it.
    const mAbBn = await sendWebchat('wc-angry-bn', 'Ragib Hasan', 'তুমি একটা বোকাচোদা! শালা, টাকা ফেরত দাও');
    check('boot 1: abusive-BN webchat message accepted', mAbBn.status === 200 && !!mAbBn.data?.conversationId, `status=${mAbBn.status}`);
    const abBnConvId = mAbBn.data?.conversationId ?? '';
    const abBn = await waitWaiting(abBnConvId);
    check('boot 1: abusive BN → status waiting', !!abBn, `status=${abBn?.status ?? '?'}`);
    check('boot 1: abusive BN → mode human (AI stopped)', abBn?.mode === 'human', `mode=${abBn?.mode ?? '?'}`);
    check('boot 1: abusive BN → reason angry_customer', abBn?.escalation_reason === 'angry_customer', `reason=${abBn?.escalation_reason ?? '?'}`);
    const abBnThread = await api(`/api/inbox/${abBnConvId}`);
    check('boot 1: abusive BN → NO reply sent', (abBnThread.data?.messages ?? []).filter((m) => m.direction === 'out').length === 0, `out=${(abBnThread.data?.messages ?? []).filter((m) => m.direction === 'out').length}`);
    const abBnNotif = await bellFor(abBnConvId);
    check('boot 1: bell notification exists for the abusive-BN chat', !!abBnNotif, `notif=${abBnNotif ? 'yes' : 'no'}`);
    check('boot 1: bell title reads "[Name] রেগে গিয়েছে"', abBnNotif?.title === 'Ragib Hasan রেগে গিয়েছে', `title=${abBnNotif?.title ?? '?'}`);
    check('boot 1: bell body has the name + রেগে গিয়েছে', !!abBnNotif && (abBnNotif.body ?? '').includes('Ragib Hasan') && (abBnNotif.body ?? '').includes('রেগে গিয়েছে'), `body=${abBnNotif?.body ?? '?'}`);
    check('boot 1: bell notification links to the chat (conversation_id)', abBnNotif?.conversation_id === abBnConvId, `conversation_id=${String(abBnNotif?.conversation_id ?? '').slice(0, 8)}`);

    // (a2) Abusive English message.
    const mAbEn = await sendWebchat('wc-angry-en', 'Angry Adam', 'You are a fucking bastard, give me my money back');
    check('boot 1: abusive-EN webchat message accepted', mAbEn.status === 200 && !!mAbEn.data?.conversationId, `status=${mAbEn.status}`);
    const abEnConvId = mAbEn.data?.conversationId ?? '';
    const abEn = await waitWaiting(abEnConvId);
    check('boot 1: abusive EN → waiting/human/angry_customer, no reply', !!abEn && abEn.mode === 'human' && abEn.escalation_reason === 'angry_customer' && (await api(`/api/inbox/${abEnConvId}`)).data?.messages?.filter((m) => m.direction === 'out').length === 0, `status=${abEn?.status ?? '?'} reason=${abEn?.escalation_reason ?? '?'}`);
    const abEnNotif = await bellFor(abEnConvId);
    check('boot 1: bell title reads "Angry Adam রেগে গিয়েছে"', abEnNotif?.title === 'Angry Adam রেগে গিয়েছে', `title=${abEnNotif?.title ?? '?'}`);

    // (a3) Abusive Romanized-Bengali message.
    const mAbRo = await sendWebchat('wc-angry-ro', 'Roman Ragib', 'tora sob sala bokachoda');
    check('boot 1: abusive-Romanized webchat message accepted', mAbRo.status === 200 && !!mAbRo.data?.conversationId, `status=${mAbRo.status}`);
    const abRoConvId = mAbRo.data?.conversationId ?? '';
    const abRo = await waitWaiting(abRoConvId);
    check('boot 1: abusive Romanized → waiting/human/angry_customer, no reply', !!abRo && abRo.mode === 'human' && abRo.escalation_reason === 'angry_customer' && (await api(`/api/inbox/${abRoConvId}`)).data?.messages?.filter((m) => m.direction === 'out').length === 0, `status=${abRo?.status ?? '?'} reason=${abRo?.escalation_reason ?? '?'}`);
    const abRoNotif = await bellFor(abRoConvId);
    check('boot 1: bell title reads "Roman Ragib রেগে গিয়েছে"', abRoNotif?.title === 'Roman Ragib রেগে গিয়েছে', `title=${abRoNotif?.title ?? '?'}`);

    // (b1) Normal complaint ("দাম বেশি") — NEVER angry, gets a reply, NO bell row.
    // (Demo-mode note: the demo matcher has no product keyword for this
    // text, so it answers with its pre-existing can't-answer fallback —
    // the assertion is therefore "never angry_customer + reply saved +
    // no notification", not "stays open"; live Gemini answers it.)
    const mComp = await sendWebchat('wc-ok-comp', 'Normal Customer', 'দাম বেশি, কমানো যাবে?');
    check('boot 1: normal complaint accepted', mComp.status === 200 && !!mComp.data?.conversationId, `status=${mComp.status}`);
    const compConvId = mComp.data?.conversationId ?? '';
    const compFound = await pollFor(async () => {
      const detail = await api(`/api/inbox/${compConvId}`);
      const msgs = detail.data?.messages ?? [];
      const out = msgs.filter((m) => m.direction === 'out');
      return out.length > 0 ? { conv: detail.data?.conversation ?? {}, out } : null;
    });
    check('boot 1: normal complaint got a reply', !!compFound && compFound.out.length > 0, `out=${compFound?.out?.length ?? 0}`);
    check('boot 1: normal complaint is NEVER angry_customer', !!compFound && compFound.conv.escalation_reason !== 'angry_customer', `reason=${compFound?.conv?.escalation_reason ?? 'null'}`);
    check('boot 1: normal complaint creates NO bell notification', (await bellFor(compConvId)) === null, `notif=${(await bellFor(compConvId))?.title ?? 'none'}`);

    // (b2) Normal price question — stays open, real ৳500 reply, no escalation.
    const mNormal = await sendWebchat('wc-ok-1', 'Price Customer', 'জিন্সের দাম কত?');
    check('boot 1: normal price question accepted', mNormal.status === 200 && !!mNormal.data?.conversationId, `status=${mNormal.status}`);
    const normalConvId = mNormal.data?.conversationId ?? '';
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
    check('boot 1: normal question creates NO bell notification', (await bellFor(normalConvId)) === null, `notif=${(await bellFor(normalConvId))?.title ?? 'none'}`);

    // (c) Repeated diverting over the real path: first off-topic message
    // → ONE deterministic template reply + waiting; second off-topic
    // message → nothing new goes out.
    const mDiv1 = await sendWebchat('wc-div-1', 'Diverting Customer', 'তুমি ছেলে নাকি মেয়ে?');
    check('boot 1: first off-topic message accepted', mDiv1.status === 200 && !!mDiv1.data?.conversationId, `status=${mDiv1.status}`);
    offTopicConvId = mDiv1.data?.conversationId ?? '';
    const div1 = await waitWaiting(offTopicConvId);
    check('boot 1: first off-topic → waiting/off_topic', !!div1 && div1.escalation_reason === 'off_topic', `reason=${div1?.escalation_reason ?? '?'}`);
    const divThread1 = await api(`/api/inbox/${offTopicConvId}`);
    const divOut1 = (divThread1.data?.messages ?? []).filter((m) => m.direction === 'out');
    check('boot 1: first off-topic → exactly ONE deterministic template reply', divOut1.length === 1 && (divOut1[0]?.body ?? '').includes('বুঝতে পারিনি'), `out=${divOut1.length} body=${(divOut1[0]?.body ?? '').slice(0, 40)}`);
    const divNotif = await bellFor(offTopicConvId);
    offTopicNotifId = divNotif?.id ?? '';
    check('boot 1: off-topic bell title carries the name', !!divNotif && divNotif.title.includes('Diverting Customer'), `title=${divNotif?.title ?? '?'}`);
    const mDiv2 = await sendWebchat('wc-div-1', 'Diverting Customer', 'আবহাওয়া কেমন আজ?');
    check('boot 1: second off-topic message accepted', mDiv2.status === 200, `status=${mDiv2.status}`);
    await sleep(5000);
    const divThread2 = await api(`/api/inbox/${offTopicConvId}`);
    const divOut2 = (divThread2.data?.messages ?? []).filter((m) => m.direction === 'out');
    check('boot 1: second off-topic → still exactly ONE reply (no AI call, no new reply)', divOut2.length === 1, `out=${divOut2.length}`);
    check('boot 1: second off-topic → chat still waiting', divThread2.data?.conversation?.status === 'waiting', `status=${divThread2.data?.conversation?.status ?? '?'}`);
    const divNotif2 = await bellFor(offTopicConvId);
    check('boot 1: second off-topic → no second bell notification for the chat', !!divNotif2 && divNotif2.id === offTopicNotifId, `notifId=${String(divNotif2?.id ?? '').slice(0, 8)}`);
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
    check('driver: anger unit matrix all correct (old + new abuse words; complaints false)', driverResult.angerUnitAllOk === true, JSON.stringify((driverResult.angerUnit ?? []).filter((c) => !c.ok)));
    check('driver: repeated-nonsense unit matrix all correct', driverResult.repeatUnitAllOk === true, JSON.stringify((driverResult.repeatUnit ?? []).filter((c) => !c.ok)));
    const ab = driverResult.abusiveBn ?? {};
    check('driver: abusive BN → waiting/human/angry_customer, 0 replies, 0 ledger rows', ab.result?.replied === false && ab.result?.reason === 'escalated_angry_customer' && ab.state?.status === 'waiting' && ab.state?.mode === 'human' && ab.state?.escalation_reason === 'angry_customer' && ab.outMessages === 0 && ab.ledgerRows === 0, JSON.stringify({ r: ab.result, s: ab.state, out: ab.outMessages, ledger: ab.ledgerRows }));
    check('driver: abusive BN → bell row titled "Ragib Hasan রেগে গিয়েছে"', (ab.notifications ?? []).length === 1 && ab.notifications[0]?.type === 'angry_customer' && ab.notifications[0]?.title === 'Ragib Hasan রেগে গিয়েছে' && (ab.notifications[0]?.body ?? '').includes('Ragib Hasan') && ab.notifications[0]?.conversation_id === ab.conversationId, JSON.stringify(ab.notifications ?? []));
    const ae = driverResult.abusiveEn ?? {};
    check('driver: abusive EN → waiting/human/angry_customer, 0 replies, 0 ledger rows', ae.result?.replied === false && ae.result?.reason === 'escalated_angry_customer' && ae.state?.status === 'waiting' && ae.state?.mode === 'human' && ae.state?.escalation_reason === 'angry_customer' && ae.outMessages === 0 && ae.ledgerRows === 0, JSON.stringify({ r: ae.result, s: ae.state, out: ae.outMessages, ledger: ae.ledgerRows }));
    check('driver: abusive EN → bell row titled "Angry Adam রেগে গিয়েছে"', (ae.notifications ?? []).length === 1 && ae.notifications[0]?.title === 'Angry Adam রেগে গিয়েছে', JSON.stringify(ae.notifications ?? []));
    const ar = driverResult.abusiveRo ?? {};
    check('driver: abusive Romanized → waiting/human/angry_customer, 0 replies, 0 ledger rows', ar.result?.replied === false && ar.result?.reason === 'escalated_angry_customer' && ar.state?.status === 'waiting' && ar.state?.mode === 'human' && ar.state?.escalation_reason === 'angry_customer' && ar.outMessages === 0 && ar.ledgerRows === 0, JSON.stringify({ r: ar.result, s: ar.state, out: ar.outMessages, ledger: ar.ledgerRows }));
    check('driver: abusive Romanized → bell row titled "Roman Ragib রেগে গিয়েছে"', (ar.notifications ?? []).length === 1 && ar.notifications[0]?.title === 'Roman Ragib রেগে গিয়েছে', JSON.stringify(ar.notifications ?? []));
    const ac = driverResult.angryClassic ?? {};
    check('driver: classic angry BN still escalates (old list intact)', ac.result?.replied === false && ac.state?.status === 'waiting' && ac.state?.escalation_reason === 'angry_customer' && ac.outMessages === 0 && ac.ledgerRows === 0, JSON.stringify({ r: ac.result, s: ac.state }));
    const dbl = driverResult.doubleAngry ?? {};
    check('driver: second angry message does not re-escalate / no second bell row', dbl.result?.reason === 'human_mode' && dbl.state?.status === 'waiting' && dbl.state?.escalation_reason === 'angry_customer' && dbl.outMessages === 0 && dbl.ledgerRows === 0 && (dbl.notifications ?? []).length === 1, JSON.stringify({ r: dbl.result, s: dbl.state, n: (dbl.notifications ?? []).length }));
    const nc = driverResult.normalComplaint ?? {};
    check('driver: normal complaint gets a reply, is NEVER angry_customer, no bell row', nc.result?.replied === true && nc.state?.escalation_reason !== 'angry_customer' && nc.outMessages >= 1 && (nc.notifications ?? []).length === 0, JSON.stringify({ r: nc.result, s: nc.state, out: nc.outMessages }));
    const nm = driverResult.normalPrice ?? {};
    check('driver: normal price stays open + reply has ৳500', nm.result?.replied === true && nm.state?.status === 'open' && nm.state?.mode === 'ai' && !nm.state?.escalation_reason && (nm.outBodies ?? []).some((b) => b.includes('৳500') || b.includes('500')), JSON.stringify({ r: nm.result, s: nm.state }));
    const ro = driverResult.repeatedOffTopic ?? {};
    check('driver: first off-topic → 1 template reply, waiting/off_topic, 0 ledger rows', ro.first?.result?.replied === true && ro.first?.result?.reason === 'escalated_off_topic' && ro.first?.state?.status === 'waiting' && ro.first?.state?.mode === 'human' && ro.first?.state?.escalation_reason === 'off_topic' && ro.first?.outMessages === 1 && (ro.first?.outBodies ?? []).some((b) => b.includes('বুঝতে পারিনি')) && ro.first?.ledgerRows === 0, JSON.stringify({ r: ro.first?.result, s: ro.first?.state, out: ro.first?.outMessages, ledger: ro.first?.ledgerRows }));
    check('driver: second off-topic → human_mode, still 1 reply, 0 ledger rows, still 1 bell row', ro.second?.result?.reason === 'human_mode' && ro.second?.outMessages === 1 && ro.second?.ledgerRows === 0 && (ro.second?.notifications ?? []).length === 1, JSON.stringify({ r: ro.second?.result, out: ro.second?.outMessages, ledger: ro.second?.ledgerRows }));
    check('driver: off-topic bell title carries the name', (ro.first?.notifications ?? []).length === 1 && (ro.first?.notifications[0]?.title ?? '').includes('Diverting Customer'), JSON.stringify(ro.first?.notifications ?? []));
    const rn = driverResult.repeatedNonsense ?? {};
    check('driver: repeated nonsense (3x) → waiting/human/off_topic, 0 replies, 0 ledger rows', rn.result?.replied === false && rn.result?.reason === 'escalated_repeated_nonsense' && rn.state?.status === 'waiting' && rn.state?.mode === 'human' && rn.state?.escalation_reason === 'off_topic' && rn.outMessages === 0 && rn.ledgerRows === 0, JSON.stringify({ r: rn.result, s: rn.state, out: rn.outMessages, ledger: rn.ledgerRows }));
    check('driver: repeated nonsense → bell row with the name', (rn.notifications ?? []).length === 1 && (rn.notifications[0]?.title ?? '').includes('Nonsense Nasir'), JSON.stringify(rn.notifications ?? []));
    const rsc = driverResult.repeatedShopControl ?? {};
    check('driver: same shop question 3x is NOT nonsense (normal reply, stays open)', rsc.result?.replied === true && rsc.state?.status === 'open' && !rsc.state?.escalation_reason && rsc.outMessages >= 1, JSON.stringify({ r: rsc.result, s: rsc.state }));
    const rtc = driverResult.repeatedTwiceControl ?? {};
    check('driver: same nonsense only 2x is NOT escalated as repeated nonsense', rtc.result?.reason !== 'escalated_repeated_nonsense' && rtc.state?.escalation_reason !== 'off_topic', JSON.stringify({ r: rtc.result, s: rtc.state }));
    const rb = driverResult.repeatedBatch ?? {};
    check('driver: 3 identical messages in ONE batch → escalated_repeated_nonsense, 0 ledger rows', rb.result?.replied === false && rb.result?.reason === 'escalated_repeated_nonsense' && rb.state?.status === 'waiting' && rb.state?.escalation_reason === 'off_topic' && rb.outMessages === 0 && rb.ledgerRows === 0, JSON.stringify({ r: rb.result, s: rb.state }));
    check('driver: guard conversation seeded waiting (angry_customer)', !!driverResult.guardConversationId, `id=${String(driverResult.guardConversationId ?? '').slice(0, 8)}`);
  }

  // ---------- Boot 2: inbox API + bell API + Meta reopen-guard ----------
  const run2 = startApi(port, dataDir);
  process.on('exit', run2.stop);
  try {
    const up2 = await waitForHealth(`http://localhost:${port}`);
    check('boot 2: API starts on the same dir', up2, up2 ? '' : run2.log().slice(-500));
    if (up2) {
      const api = makeApi(`http://localhost:${port}`);
      const waiting = await api('/api/inbox?status=waiting');
      const wList = asList(waiting.data);
      check('boot 2: ?status=waiting returns the waiting chats', wList.length >= 10, `count=${wList.length}`);
      check('boot 2: waiting rows carry escalation_reason (incl. angry_customer + off_topic)', wList.length > 0 && wList.every((c) => !!c.escalation_reason) && wList.some((c) => c.escalation_reason === 'angry_customer') && wList.some((c) => c.escalation_reason === 'off_topic'), JSON.stringify(wList.map((c) => c.escalation_reason)));
      const bell = await api('/api/notifications?limit=50');
      const bellRows = bell.data?.notifications ?? [];
      const angryRows = bellRows.filter((n) => n.type === 'angry_customer');
      check('boot 2: bell API serves the angry notifications', angryRows.length >= 6, `angry=${angryRows.length} total=${bellRows.length}`);
      check('boot 2: every angry bell row title has a name + রেগে গিয়েছে', angryRows.length > 0 && angryRows.every((n) => (n.title ?? '').includes('রেগে গিয়েছে') && (n.title ?? '') !== 'কাস্টমার রেগে গিয়েছে' && !!(n.conversation_id)), JSON.stringify(angryRows.map((n) => n.title)));
      check('boot 2: every bell row links to a conversation (click opens the chat)', bellRows.length > 0 && bellRows.every((n) => !!n.conversation_id), `rows=${bellRows.length}`);
      // Mark-read: the first angry notification becomes read and the
      // unread count drops by exactly one.
      const unreadBefore = bell.data?.unreadCount ?? 0;
      const firstAngry = angryRows[0];
      check('boot 2: at least one angry notification to mark read', !!firstAngry, `angry=${angryRows.length}`);
      if (firstAngry) {
        const readRes = await api(`/api/notifications/${firstAngry.id}/read`, { method: 'POST' });
        check('boot 2: mark notification read → 200', readRes.status === 200, `status=${readRes.status}`);
        const bellAfter = await api('/api/notifications?limit=50');
        const readRow = (bellAfter.data?.notifications ?? []).find((n) => n.id === firstAngry.id);
        check('boot 2: notification is now read + unread count dropped by 1', readRow?.is_read === true && (bellAfter.data?.unreadCount ?? 0) === unreadBefore - 1, `unread ${unreadBefore} → ${bellAfter.data?.unreadCount ?? '?'}`);
        // Clicking the notification opens the chat: the conversation it
        // points at is the waiting angry chat.
        const openConv = await api(`/api/inbox/${firstAngry.conversation_id}`);
        check('boot 2: notification target opens the waiting angry chat', openConv.data?.conversation?.status === 'waiting' && openConv.data?.conversation?.escalation_reason === 'angry_customer', `status=${openConv.data?.conversation?.status ?? '?'} reason=${openConv.data?.conversation?.escalation_reason ?? '?'}`);
      }

      // A new Meta message to the waiting guard conversation must NOT reopen it.
      // The Meta POST is signed like Meta signs it (HMAC-SHA256 of the
      // raw body with META_APP_SECRET, X-Hub-Signature-256) — the
      // 2026-11-11 security fix rejects unsigned webhook POSTs with 403.
      const guardId = driverResult?.guardConversationId ?? '';
      const hookBody = JSON.stringify({
        object: 'page',
        entry: [{
          id: 'TESTPAGE1', time: Math.floor(Date.now() / 1000),
          messaging: [{
            sender: { id: 'PSID-ANGRY-1' }, recipient: { id: 'TESTPAGE1' },
            timestamp: Date.now(),
            message: { mid: `angry-guard-${stamp}`, text: 'তোরা সব মাদারচোদ!' },
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
      check('boot 2: waiting chat was NOT reopened by an angry message', guardConv.status === 'waiting', `status=${guardConv.status ?? '?'}`);
      check('boot 2: waiting chat mode still human', guardConv.mode === 'human', `mode=${guardConv.mode ?? '?'}`);
      check('boot 2: waiting chat reason still angry_customer', guardConv.escalation_reason === 'angry_customer', `reason=${guardConv.escalation_reason ?? '?'}`);
      const guardOut = (guardAfter.data?.messages ?? []).filter((m) => m.direction === 'out');
      check('boot 2: no AI reply went out to the waiting chat', guardOut.length === 0, `out=${guardOut.length}`);
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
