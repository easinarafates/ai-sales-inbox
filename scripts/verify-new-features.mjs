#!/usr/bin/env node
/**
 * Verification for the Worker B new features (local, no Docker, no money).
 * Starts the API itself (tsx, PGlite) on :4000, runs real HTTP checks for
 * every new endpoint, then stops the API. Run from the repo root:
 *   node scripts/verify-new-features.mjs
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 *
 * Coverage: image-match honest-unavailable, handover set → status →
 * return-to-ai, handover expiry via the sweep (durationSeconds test-only
 * override, max 300s), voice-note without/with transcript (draft order,
 * no stock reserved), saved-replies CRUD, comments moderation transitions,
 * follow-ups hot/warm filter, agent-desk endpoints removed (menu
 * slim-down 2026-11-07 — GET instructions + POST test return 404),
 * team invite create/list/revoke (no email sent), website-chat
 * message creates an inbox conversation, setup progress + test-code verify
 * (wrong rejected, right accepted).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Isolated API for this verifier: its own PGlite data folder + own port, so
// it never contends with another worker's API on the shared ./​.pglite-data
// (PGlite allows only ONE process per data folder) or on :4000.
const API_PORT = process.env.VERIFY_API_PORT ?? '4001';
const API = process.env.API_URL ?? `http://localhost:${API_PORT}`;
const results = [];
let token = '';
let workspaceId = '';
let conversationId = '';
let customerId = '';
let productId = '';

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function api(path, { method = 'GET', body, auth = true } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
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
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(timeoutMs = 90000) {
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
  // Start the API (tsx + PGlite, loads schema + migrations incl. 08).
  // Detached process group so stopping kills the whole npm/tsx tree.
  const apiProc = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: path.join(ROOT, 'apps/api'),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: {
      ...process.env,
      PORT: API_PORT,
      DATABASE_URL: 'pglite://./.pglite-data-newfeat',
    },
  });
  let apiLog = '';
  apiProc.stdout.on('data', (d) => { apiLog += d.toString(); });
  apiProc.stderr.on('data', (d) => { apiLog += d.toString(); });
  const stopApi = () => {
    try { process.kill(-apiProc.pid, 'SIGTERM'); } catch { try { apiProc.kill('SIGTERM'); } catch { /* already gone */ } }
  };
  process.on('exit', stopApi);

  try {
    const up = await waitForHealth();
    check('API starts (health)', up, up ? '' : apiLog.slice(-500));
    if (!up) return;

    const stamp = Date.now();
    const email = `newfeat+${stamp}@example.com`;

    // Signup + product + a website-chat conversation to work with.
    const signup = await api('/api/auth/signup', {
      method: 'POST', auth: false,
      body: { name: 'NewFeat Owner', email, password: 'verify1234', workspaceName: 'NewFeat Shop' },
    });
    check('signup', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
    token = signup.data?.token ?? '';
    workspaceId = signup.data?.workspace?.id ?? '';

    const p1 = await api('/api/products', {
      method: 'POST',
      body: { name: 'শাড়ি', pricePaisa: 150000, size: 'M', stock: 5, description: 'সুতির শাড়ি — লাল' },
    });
    productId = p1.data?.product?.id ?? '';
    check('add product শাড়ি (৳1500, stock 5)', p1.status === 201 && !!productId, `status=${p1.status}`);

    // --- 1b. Public uploads (Worker C, index.ts static route + 40mb limit) ---
    // Upload a ~2 MB file (base64 JSON) and fetch it back WITHOUT auth.
    const { randomBytes } = await import('node:crypto');
    const bigBuf = randomBytes(2 * 1024 * 1024);
    const uploadRes = await api('/api/scheduled-posts/upload', {
      method: 'POST',
      body: { fileBase64: bigBuf.toString('base64'), fileName: 'test-photo.jpg', mimeType: 'image/jpeg' },
    });
    const storedName = uploadRes.data?.fileName ?? String(uploadRes.data?.url ?? '').split('/').pop() ?? '';
    check('upload ~2 MB file via base64 (was blocked by 1mb limit)', uploadRes.status === 201 && Number(uploadRes.data?.sizeBytes) === 2 * 1024 * 1024, `status=${uploadRes.status}, sizeBytes=${uploadRes.data?.sizeBytes}`);
    if (storedName) {
      const pubRes = await fetch(`${API}/uploads/${storedName}`);
      const pubBuf = Buffer.from(await pubRes.arrayBuffer());
      check('GET /uploads/<file> WITHOUT auth returns 200 + full file', pubRes.status === 200 && pubBuf.length === 2 * 1024 * 1024 && pubBuf.equals(bigBuf), `status=${pubRes.status}, bytes=${pubBuf.length}`);
    } else {
      check('GET /uploads/<file> WITHOUT auth returns 200 + full file', false, 'no stored filename returned');
    }

    // --- 1. Photo recognition: honest unavailable (no embeddings key) ---
    const im = await api('/api/image-match', { method: 'POST', body: { imageRef: 'https://example.com/sari.jpg' } });
    check('image-match honest unavailable (no embeddings key)', im.status === 200 && im.data?.available === false && (im.data?.matches ?? []).length === 0, `available=${im.data?.available}`);
    const imNoAuth = await api('/api/image-match', { method: 'POST', auth: false, body: { imageRef: 'https://example.com/sari.jpg' } });
    check('image-match requires auth', imNoAuth.status === 401, `status=${imNoAuth.status}`);
    const imBad = await api('/api/image-match', { method: 'POST', body: {} });
    check('image-match rejects missing imageRef', imBad.status === 400, `status=${imBad.status}`);

    // --- 9. Website chat: settings + public message creates inbox conversation ---
    const settings = await api('/api/website-chat/settings');
    const publicKey = settings.data?.publicKey ?? '';
    check('website-chat settings returns public key + snippet', settings.status === 200 && !!publicKey && String(settings.data?.snippet ?? '').includes('widget.js'), `key=${String(publicKey).slice(0, 8)}…`);
    const widget = await fetch(`${API}/api/website-chat/widget.js?key=${encodeURIComponent(publicKey)}`);
    const widgetText = await widget.text();
    check('website-chat widget.js serves (public)', widget.status === 200 && widgetText.includes('ai-inbox-chat'), `status=${widget.status}`);
    const wmsg = await api('/api/website-chat/message', {
      method: 'POST', auth: false,
      body: { workspaceKey: publicKey, text: 'আসসালামু আলাইকুম, শাড়ি আছে?', visitorName: 'Rahim Visitor' },
    });
    conversationId = wmsg.data?.conversationId ?? '';
    check('website-chat message creates conversation (public, no auth)', wmsg.status === 201 && !!conversationId, `status=${wmsg.status}`);
    const inbox = await api('/api/inbox');
    check('website-chat conversation visible in inbox', (inbox.data?.conversations ?? []).some((c) => c.id === conversationId), `convs=${(inbox.data?.conversations ?? []).length}`);
    const convDetail = await api(`/api/inbox/${conversationId}`);
    customerId = convDetail.data?.customer?.id ?? '';
    check('website-chat visitor message saved in thread', (convDetail.data?.messages ?? []).some((m) => m.direction === 'in' && String(m.body ?? '').includes('শাড়ি')), `msgs=${(convDetail.data?.messages ?? []).length}`);
    const wmsgBad = await api('/api/website-chat/message', { method: 'POST', auth: false, body: { workspaceKey: 'wk_badkey', text: 'hi' } });
    check('website-chat rejects unknown key', wmsgBad.status === 400, `status=${wmsgBad.status}`);

    // --- 3. Handover: set → status → return-to-ai → expiry sweep ---
    const hoBad = await api(`/api/inbox/${conversationId}/handover`, { method: 'POST', body: { durationHours: 2 } });
    check('handover rejects durationHours other than 1|4', hoBad.status === 400, `status=${hoBad.status}`);
    const ho = await api(`/api/inbox/${conversationId}/handover`, { method: 'POST', body: { durationHours: 1 } });
    check('handover set (1h) → human + timer', ho.status === 200 && ho.data?.handover?.mode === 'human' && ho.data?.handover?.active === true && ho.data?.handover?.handedTo === 'human', `mode=${ho.data?.handover?.mode}, active=${ho.data?.handover?.active}`);
    const hoStatus = await api(`/api/inbox/${conversationId}/handover`);
    check('handover status shows human + timer', hoStatus.status === 200 && hoStatus.data?.handover?.active === true && hoStatus.data?.handover?.expiresInSeconds > 0, `expiresIn=${hoStatus.data?.handover?.expiresInSeconds}s`);
    const ret = await api(`/api/inbox/${conversationId}/return-to-ai`, { method: 'POST' });
    check('return-to-ai works', ret.status === 200 && ret.data?.handover?.mode === 'ai' && ret.data?.handover?.active === false, `mode=${ret.data?.handover?.mode}`);
    // Expiry: short test-only duration, then run the sweep manually.
    const hoShort = await api(`/api/inbox/${conversationId}/handover`, { method: 'POST', body: { durationSeconds: 3 } });
    check('handover test duration (3s) accepted', hoShort.status === 200 && hoShort.data?.handover?.active === true, `status=${hoShort.status}`);
    await sleep(4000);
    const sweep = await api('/api/inbox/handovers/run', { method: 'POST' });
    check('handover sweep returns expired chat', sweep.status === 200 && Number(sweep.data?.returned) >= 1, `returned=${sweep.data?.returned}`);
    const hoAfter = await api(`/api/inbox/${conversationId}/handover`);
    check('handover expired → back to AI', hoAfter.data?.handover?.mode === 'ai' && hoAfter.data?.handover?.active === false, `mode=${hoAfter.data?.handover?.mode}`);
    const ho404 = await api('/api/inbox/00000000-0000-0000-0000-000000000000/handover');
    check('handover status 404 for unknown conversation', ho404.status === 404, `status=${ho404.status}`);

    // --- 2. Voice-note orders ---
    const vnEmpty = await api(`/api/inbox/${conversationId}/voice-note`, { method: 'POST', body: { durationSec: 12 } });
    check('voice-note without transcript stored as transcript pending', vnEmpty.status === 201 && vnEmpty.data?.voiceNote?.status === 'transcript_pending' && vnEmpty.data?.draftOrder === null, `status=${vnEmpty.data?.voiceNote?.status}`);
    const vn = await api(`/api/inbox/${conversationId}/voice-note`, {
      method: 'POST',
      body: { transcript: 'শাড়ি ২টি অর্ডার করতে চাই, নাম রহিম, ফোন 01712345678, ঠিকানা ঢাকা মিরপুর', durationSec: 20 },
    });
    const draftOrder = vn.data?.draftOrder ?? null;
    check('voice-note with transcript extracts order intent', vn.status === 201 && !!draftOrder, `status=${vn.status}, draft=${draftOrder?.id ?? 'none'}`);
    if (draftOrder) {
      check('voice-note draft order is pending + source voice (not confirmed)', draftOrder.status === 'pending' && draftOrder.source === 'voice', `status=${draftOrder.status}, source=${draftOrder.source}`);
      check('voice-note draft total is 2 × ৳1500 = ৳3000', Number(draftOrder.total_paisa) === 300000, `total=${draftOrder.total_paisa}`);
      const prodAfter = await api('/api/products');
      const sari = (prodAfter.data?.products ?? []).find((p) => p.id === productId);
      check('voice-note draft reserves NO stock (still 5)', Number(sari?.stock) === 5, `stock=${sari?.stock}`);
    }
    const vnList = await api(`/api/inbox/${conversationId}/voice-notes`);
    check('voice-notes list returns both notes', vnList.status === 200 && (vnList.data?.voiceNotes ?? []).length >= 2, `count=${(vnList.data?.voiceNotes ?? []).length}`);

    // --- 4. Saved replies CRUD ---
    const sr = await api('/api/saved-replies', { method: 'POST', body: { title: 'ডেলিভারি চার্জ', body: 'ঢাকার ভেতরে ডেলিভারি চার্জ ৬০ টাকা।' } });
    const srId = sr.data?.savedReply?.id ?? '';
    check('saved-reply create', sr.status === 201 && !!srId, `status=${sr.status}`);
    const srList = await api('/api/saved-replies');
    check('saved-replies list contains it', (srList.data?.savedReplies ?? []).some((r) => r.id === srId), `count=${(srList.data?.savedReplies ?? []).length}`);
    const srPatch = await api(`/api/saved-replies/${srId}`, { method: 'PATCH', body: { body: 'ঢাকার ভেতরে ডেলিভারি চার্জ ৮০ টাকা।' } });
    check('saved-reply update', srPatch.status === 200 && String(srPatch.data?.savedReply?.body ?? '').includes('৮০'), `body=${srPatch.data?.savedReply?.body}`);
    const srDel = await api(`/api/saved-replies/${srId}`, { method: 'DELETE' });
    const srList2 = await api('/api/saved-replies');
    check('saved-reply delete', srDel.status === 200 && !(srList2.data?.savedReplies ?? []).some((r) => r.id === srId), `deleted=${srDel.data?.deleted}`);

    // --- 5. Comments moderation ---
    const cm1 = await api('/api/comments', { method: 'POST', body: { platformPostId: 'post-1', body: 'শাড়ির দাম কত?' } });
    const cm1Id = cm1.data?.comment?.id ?? '';
    const cm2 = await api('/api/comments', { method: 'POST', body: { platformPostId: 'post-1', body: 'খুব সুন্দর!' } });
    const cm2Id = cm2.data?.comment?.id ?? '';
    const cm3 = await api('/api/comments', { method: 'POST', body: { platformPostId: 'post-1', body: 'স্প্যাম কমেন্ট' } });
    const cm3Id = cm3.data?.comment?.id ?? '';
    check('comments created (3)', cm1.status === 201 && cm2.status === 201 && cm3.status === 201, `statuses=${cm1.status},${cm2.status},${cm3.status}`);
    const cmList = await api('/api/comments?status=to_check');
    check('comments list ?status=to_check shows new comments', (cmList.data?.comments ?? []).filter((c) => [cm1Id, cm2Id, cm3Id].includes(c.id)).length === 3, `count=${(cmList.data?.comments ?? []).length}`);
    const cmAns = await api(`/api/comments/${cm1Id}/answer`, { method: 'POST', body: { text: 'শাড়ির দাম ৳১৫০০।' } });
    check('comment answer → answered + reply stored', cmAns.status === 200 && cmAns.data?.comment?.status === 'answered' && cmAns.data?.comment?.reply_text === 'শাড়ির দাম ৳১৫০০।', `status=${cmAns.data?.comment?.status}`);
    const cmHide = await api(`/api/comments/${cm3Id}/hide`, { method: 'POST' });
    check('comment hide → hidden', cmHide.status === 200 && cmHide.data?.comment?.status === 'hidden', `status=${cmHide.data?.comment?.status}`);
    const cmDone = await api(`/api/comments/${cm2Id}/mark-done`, { method: 'POST' });
    check('comment mark-done → done', cmDone.status === 200 && cmDone.data?.comment?.status === 'done', `status=${cmDone.data?.comment?.status}`);
    const cmHiddenList = await api('/api/comments?status=hidden');
    check('comments list ?status=hidden shows the hidden one', (cmHiddenList.data?.comments ?? []).some((c) => c.id === cm3Id), `count=${(cmHiddenList.data?.comments ?? []).length}`);
    const cmDel = await api(`/api/comments/${cm3Id}`, { method: 'DELETE' });
    const cmListAfter = await api('/api/comments');
    check('comment delete removes it', cmDel.status === 200 && !(cmListAfter.data?.comments ?? []).some((c) => c.id === cm3Id), `deleted=${cmDel.data?.deleted}`);

    // --- 6. Follow-ups hot/warm ---
    const fuHot = await api('/api/followups', {
      method: 'POST',
      body: { customerId, message: 'শাড়িটি এখনো আছে, কিনতে চান?', sendAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), warmth: 'hot' },
    });
    const fuWarm = await api('/api/followups', {
      method: 'POST',
      body: { customerId, message: 'নতুন কালেকশন এসেছে, দেখবেন?', sendAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), warmth: 'warm' },
    });
    check('follow-up create with warmth hot/warm', fuHot.status === 201 && fuHot.data?.followup?.warmth === 'hot' && fuWarm.status === 201 && fuWarm.data?.followup?.warmth === 'warm', `hot=${fuHot.data?.followup?.warmth}, warm=${fuWarm.data?.followup?.warmth}`);
    const fuHotList = await api('/api/followups?warmth=hot');
    const fuWarmList = await api('/api/followups?warmth=warm');
    check('follow-ups ?warmth=hot returns hot only', (fuHotList.data?.followups ?? []).every((f) => f.warmth === 'hot') && (fuHotList.data?.followups ?? []).some((f) => f.id === fuHot.data?.followup?.id), `count=${(fuHotList.data?.followups ?? []).length}`);
    check('follow-ups ?warmth=warm returns warm only', (fuWarmList.data?.followups ?? []).every((f) => f.warmth === 'warm') && (fuWarmList.data?.followups ?? []).some((f) => f.id === fuWarm.data?.followup?.id), `count=${(fuWarmList.data?.followups ?? []).length}`);
    const fuBad = await api('/api/followups', {
      method: 'POST',
      body: { customerId, message: 'x', sendAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), warmth: 'cold' },
    });
    check('follow-up rejects invalid warmth', fuBad.status === 400, `status=${fuBad.status}`);

    // --- 6b. Leads ?warmth=hot|warm filter ---
    const leadHot = await api('/api/leads', { method: 'POST', body: { customerId, need: 'শাড়ি কিনতে চায়', warmth: 'hot' } });
    const leadWarm = await api('/api/leads', { method: 'POST', body: { customerId, need: 'পাঞ্জাবি দেখতে চায়', warmth: 'warm' } });
    check('lead create with warmth hot/warm', leadHot.status === 201 && leadHot.data?.lead?.warmth === 'hot' && leadWarm.status === 201 && leadWarm.data?.lead?.warmth === 'warm', `hot=${leadHot.data?.lead?.warmth}, warm=${leadWarm.data?.lead?.warmth}`);
    const leadsHot = await api('/api/leads?warmth=hot');
    const leadsWarm = await api('/api/leads?warmth=warm');
    check('leads ?warmth=hot returns hot only', (leadsHot.data?.leads ?? []).every((l) => l.warmth === 'hot') && (leadsHot.data?.leads ?? []).some((l) => l.id === leadHot.data?.lead?.id), `count=${(leadsHot.data?.leads ?? []).length}`);
    check('leads ?warmth=warm returns warm only', (leadsWarm.data?.leads ?? []).every((l) => l.warmth === 'warm') && (leadsWarm.data?.leads ?? []).some((l) => l.id === leadWarm.data?.lead?.id), `count=${(leadsWarm.data?.leads ?? []).length}`);
    const leadsBad = await api('/api/leads?warmth=cold');
    check('leads rejects invalid warmth filter', leadsBad.status === 400, `status=${leadsBad.status}`);

    // --- 7. Agent Desk removed (menu slim-down 2026-11-07) -------------
    // The whole /api/agent-desk/* surface is gone; the UI page, nav
    // entry and API router were removed. The instructions table stays
    // in the DB (migrations untouched, data preserved).
    const adGone = await api('/api/agent-desk/instructions');
    check('GET /api/agent-desk/instructions is 404 (router removed)', adGone.status === 404, `status=${adGone.status}`);
    const adTestGone = await api('/api/agent-desk/test', { method: 'POST', body: { question: 'দাম কত?' } });
    check('POST /api/agent-desk/test is 404 (router removed)', adTestGone.status === 404, `status=${adTestGone.status}`);

    // --- 8. Team invites (no email sent) ---
    const inv = await api('/api/team/invites', { method: 'POST', body: { email: 'helper@example.com', role: 'member' } });
    const invId = inv.data?.invite?.id ?? '';
    check('team invite created with shareable link (no email sent)', inv.status === 201 && !!invId && String(inv.data?.invite?.inviteLink ?? '').includes('/signup?invite='), `status=${inv.status}`);
    const invList = await api('/api/team/invites');
    check('team list shows invite + owner member', (invList.data?.invites ?? []).some((i) => i.id === invId) && (invList.data?.members ?? []).length >= 1, `invites=${(invList.data?.invites ?? []).length}, members=${(invList.data?.members ?? []).length}`);
    const invDup = await api('/api/team/invites', { method: 'POST', body: { email: 'helper@example.com' } });
    check('team duplicate pending invite rejected', invDup.status === 400, `status=${invDup.status}`);
    const invBad = await api('/api/team/invites', { method: 'POST', body: { email: 'not-an-email' } });
    check('team invite rejects bad email', invBad.status === 400, `status=${invBad.status}`);
    const invRev = await api(`/api/team/invites/${invId}/revoke`, { method: 'POST' });
    check('team invite revoked', invRev.status === 200 && invRev.data?.invite?.status === 'revoked', `status=${invRev.data?.invite?.status}`);

    // --- 11. Setup wizard ---
    const sp0 = await api('/api/setup/progress');
    check('setup progress starts at 0/7', sp0.status === 200 && sp0.data?.progress?.completedCount === 0 && sp0.data?.progress?.totalSteps === 7, `done=${sp0.data?.progress?.completedCount}`);
    const spGoEarly = await api('/api/setup/complete-step', { method: 'POST', body: { step: 'go-live' } });
    check('setup go-live blocked until other steps done', spGoEarly.status === 400 && Array.isArray(spGoEarly.data?.missingSteps), `status=${spGoEarly.status}`);
    const spBad = await api('/api/setup/complete-step', { method: 'POST', body: { step: 'nope' } });
    check('setup rejects unknown step', spBad.status === 400, `status=${spBad.status}`);
    for (const step of ['facebook', 'business', 'products', 'notifications', 'courier', 'team']) {
      const r = await api('/api/setup/complete-step', { method: 'POST', body: { step } });
      check(`setup complete step: ${step}`, r.status === 200 && r.data?.progress?.steps?.find((s) => s.step === step)?.completed === true, `status=${r.status}`);
    }
    const spGo = await api('/api/setup/complete-step', { method: 'POST', body: { step: 'go-live' } });
    const testCode = spGo.data?.testCode ?? '';
    check('setup go-live issues a 5-digit test code', spGo.status === 200 && /^\d{5}$/.test(testCode), `code=${testCode ? '•••••' : '(none)'}`);
    const spWrong = await api('/api/setup/verify-test', { method: 'POST', body: { code: testCode === '12345' ? '54321' : '12345' } });
    check('setup wrong test code rejected', spWrong.status === 400 && spWrong.data?.verified === false, `status=${spWrong.status}`);
    const spRight = await api('/api/setup/verify-test', { method: 'POST', body: { code: testCode } });
    check('setup right test code accepted → go-live done', spRight.status === 200 && spRight.data?.verified === true && spRight.data?.progress?.goLive === true, `verified=${spRight.data?.verified}`);

    // Auth guard spot-checks on the new routers.
    const noAuth = await api('/api/saved-replies', { auth: false });
    check('new routes require auth (saved-replies)', noAuth.status === 401, `status=${noAuth.status}`);
    const noAuthSetup = await api('/api/setup/progress', { auth: false });
    check('new routes require auth (setup)', noAuthSetup.status === 401, `status=${noAuthSetup.status}`);
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
