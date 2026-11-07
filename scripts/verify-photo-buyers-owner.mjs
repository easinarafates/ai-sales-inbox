#!/usr/bin/env node
/**
 * Verification for product photos + never-admit + buyers-only + owner
 * guard (2026-11-08) — four linked fixes the owner asked for:
 *
 * (1) Product photos: when a customer asks for a photo the AI could not
 *     send one (text-only Graph send). Now: sendMetaImageMessage +
 *     deliverOutgoingImageMessage (attachment type image, payload URL =
 *     the product's Blob URL) + a send_product_photos tool. "কি কি
 *     প্রোডাক্ট আছে?" → one image message per product (photo + name +
 *     price below it) + an interest question; picking one → its photo +
 *     details + price. Images come ONLY from product_images.
 * (2) Never admit being an AI: prompt rule 9 (never "AI/এআই/রোবট/বট/
 *     অটোমেটেড", in any language) + a deterministic deflection for
 *     "তুমি এত দ্রুত রিপ্লাই দিচ্ছ কেন?" ("স্যার, আপনার সেবা দেওয়ার
 *     জন্য আমরা সবসময় দ্রুত উত্তর দেওয়ার চেষ্টা করি।") — no AI call,
 *     not escalated. "তুমি কি AI?" still escalates off-topic.
 * (3) Customers list = buyers only: GET /api/customers returns only
 *     customers with >= 1 order. The Inbox is unchanged.
 * (4) Owner guard: workspaces.owner_psid was WRONGLY 9336113056470349
 *     (Mohammad Easin, a real customer) — now 29638693045727594 (the
 *     owner). The webhook intake handles the owner's dot commands
 *     (workspace-wide AI toggle) but NEVER creates a customer or
 *     conversation for him and NEVER runs the AI reply; a non-owner
 *     (9336113056470349) cannot toggle. Owner rows + test order
 *     84a31567 are deleted from the live DB (separate live step — the
 *     PGlite boots below prove the guard logic, not the deletion).
 *
 * Checks:
 * - Static: image send, tool, prompt rule, detectors, customers
 *   filter, owner guard, global toggle, web image render.
 * - Boot 1 (local API on PGlite, webchat webhook end-to-end): list
 *   request → 3 image rows + 3 captions + interest question; show
 *   request → jeans photo + details (৳৫০০); fast-reply question →
 *   deflection, no AI word, not escalated; "তুমি কি AI?" →
 *   waiting/off_topic; price question → open + real reply, no photos;
 *   buyers-only via POST /api/orders + GET /api/customers.
 * - Driver (processBatch directly, same PGlite dir): detector unit
 *   matrices, list/show/fast/AI/normal flows, tool test with stubbed
 *   Graph fetch (3 sent + platform ids, no-photo failure, comment
 *   failure), buyers-only predicate, workspace toggle.
 * - Boot 2 (same dir, Meta webhook): owner "." toggles the workspace
 *   AI off (a customer message then gets NO reply) and ".on" turns it
 *   back on (a customer message gets a reply); no customer or
 *   conversation is ever created for the owner PSID; a non-owner "."
 *   does not toggle; an owner normal message creates nothing.
 *
 * Run from the repo root:  node scripts/verify-photo-buyers-owner.mjs
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
const WEBCHAT_SECRET = 'test-webchat-secret-photo';

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
      JWT_SECRET: 'test-jwt-secret-for-verifier-only-0123456789abcdef',
      TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      WEBCHAT_SECRET,
      // Blank the provider keys so the test runs in deterministic demo
      // mode (no live AI calls).
      GEMINI_API_KEY: '',
      GROQ_API_KEY: '',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      META_APP_ID: 'dummy-app-id',
      META_APP_SECRET: 'dummy-app-secret',
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

function runDriver(dataDir, workspaceId, jeansId, shirtId, tshirtId) {
  return new Promise((resolve) => {
    const proc = spawn('npx', ['tsx', '../../scripts/photo-buyers-owner-driver.ts', workspaceId, jeansId, shirtId, tshirtId], {
      cwd: path.join(ROOT, 'apps/api'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        USE_PGLITE: 'true',
        PGLITE_DATA_DIR: dataDir,
        JWT_SECRET: 'test-jwt-secret-for-verifier-only-0123456789abcdef',
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

async function webchat(api, senderId, name, text) {
  return api('/api/webhooks/webchat', {
    method: 'POST', auth: false,
    headers: { 'x-webchat-secret': WEBCHAT_SECRET },
    body: { externalId: 'site-photo', senderId, name, text },
  });
}

async function threadOut(api, conversationId) {
  const detail = await api(`/api/inbox/${conversationId}`);
  const msgs = detail.data?.messages ?? [];
  return { conv: detail.data?.conversation ?? {}, msgs, out: msgs.filter((m) => m.direction === 'out') };
}

async function main() {
  // ---------- Static checks ----------
  const sendSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/meta-send.ts'), 'utf8');
  check('meta-send: sendMetaImageMessage (attachment type image, payload url)', sendSrc.includes('export async function sendMetaImageMessage') && sendSrc.includes("type: 'image'") && sendSrc.includes('payload: { url: input.imageUrl'));
  check('meta-send: deliverOutgoingImageMessage (type image row, body = URL)', sendSrc.includes('export async function deliverOutgoingImageMessage') && sendSrc.includes("'out', 'image'"));
  check('meta-send: comment channels honestly refuse images', sendSrc.includes('image_send_not_supported_for_facebook_comment'));

  const toolsSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/ai-agent/tools.ts'), 'utf8');
  check('tools: send_product_photos registered', toolsSrc.includes('send_product_photos: sendProductPhotos'));
  check('tools: photos come ONLY from product_images (first by created_at)', toolsSrc.includes('FROM product_images') && toolsSrc.includes('ORDER BY pi.created_at ASC LIMIT 1'));
  check('tools: no-photo product fails honestly (no_photo)', toolsSrc.includes("error: 'no_photo'"));

  const promptSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/ai-agent/prompts.ts'), 'utf8');
  check('prompt: rule 9 never admits AI/robot/bot/automated', promptSrc.includes('9. তুমি কখনো বলবে না তুমি AI') && promptSrc.includes('"AI" শব্দটা উত্তরে কখনো লিখো না'));
  check('prompt: fast-reply deflection wording', promptSrc.includes('আপনার সেবা দেওয়ার জন্য আমরা সবসময় দ্রুত উত্তর দেওয়ার চেষ্টা করি'));
  check('prompt: send_product_photos in the tool list (list → all ids, pick → one id)', promptSrc.includes('send_product_photos') && promptSrc.includes('কি কি প্রোডাক্ট আছে') && promptSrc.includes('টেক্সটে তালিকা লিখো না'));

  const intentSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/ai-agent/detect-intent.ts'), 'utf8');
  check('detect-intent: fast-reply detector exported', intentSrc.includes('export function detectFastReplyQuestion'));
  check('detect-intent: list-request detector exported', intentSrc.includes('export function detectProductListRequest'));
  check('detect-intent: show-product matcher exported', intentSrc.includes('export function matchShowProduct'));

  const agentSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/ai-agent/agent.ts'), 'utf8');
  check('agent: fast-reply deflection runs before the AI call', agentSrc.includes('detectFastReplyQuestion(batchedText)') && agentSrc.includes("reason: 'deflected_fast_reply'"));
  check('agent: photo flows run before the AI call', agentSrc.includes('detectProductListRequest(batchedText)') && agentSrc.includes("reason: 'product_photos_sent'") && agentSrc.includes("reason: 'product_photo_sent'"));
  check('agent: photo flows use deliverOutgoingImageMessage', agentSrc.includes('deliverOutgoingImageMessage(workspaceId, conversationId'));
  check('agent: deterministic reply does not re-list after photos', agentSrc.includes("tool !== 'send_product_photos'") && agentSrc.includes('photoSent.length === 1'));

  const custSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/customers/routes.ts'), 'utf8');
  check('customers: list is buyers-only (EXISTS orders)', custSrc.includes('EXISTS (SELECT 1 FROM orders o'));

  const hookSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/webhooks/routes.ts'), 'utf8');
  check('webhook: owner guard before mark_seen (never a customer/conversation/AI reply)', hookSrc.includes('Owner guard: the shop owner messaging his own Page') && hookSrc.indexOf('ownerPsid && ownerPsid === sender.id') < hookSrc.indexOf('mark_seen'));
  check('webhook: owner dot toggles the workspace AI switch', hookSrc.includes('toggleWorkspaceAiMode(channel.workspace_id)') && hookSrc.includes('setWorkspaceAiMode(channel.workspace_id'));
  check('webhook: owner comments skipped too', hookSrc.includes('commentOwnerPsid'));

  const queueSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/queue/client.ts'), 'utf8');
  check('queue: batch is only UNANSWERED messages (after latest out)', queueSrc.includes("AND created_at > COALESCE(") && queueSrc.includes("direction = 'out'") && queueSrc.includes("TIMESTAMP 'epoch'"));
  const workerSrc = fs.readFileSync(path.join(ROOT, 'workers/queue/src/worker.ts'), 'utf8');
  check('worker: batch is only UNANSWERED messages (after latest out)', workerSrc.includes("AND created_at > COALESCE(") && workerSrc.includes("direction = 'out'") && workerSrc.includes("TIMESTAMP 'epoch'"));

  const dotSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/inbox/dot-commands.ts'), 'utf8');
  check('dot-commands: workspace-level toggle exists', dotSrc.includes('export async function setWorkspaceAiMode') && dotSrc.includes('export async function toggleWorkspaceAiMode'));

  const webSrc = fs.readFileSync(path.join(ROOT, 'apps/web/app/inbox/page.tsx'), 'utf8');
  check('web: inbox thread renders image messages as <img>', webSrc.includes('type === "image"') && webSrc.includes('<img src={msgText(m)}'));

  // ---------- Boot 1: webchat webhook end-to-end ----------
  const stamp = Date.now();
  const port = 4023;
  const dataDir = '.pglite-data-photo';
  const run1 = startApi(port, dataDir);
  process.on('exit', run1.stop);
  let workspaceId = '';
  let jeansId = '';
  let shirtId = '';
  let tshirtId = '';
  const IMG = {
    jeans: 'https://example.com/photos/jeans.png',
    shirt: 'https://example.com/photos/shirt.png',
    tshirt: 'https://example.com/photos/tshirt.png',
  };
  try {
    const up = await waitForHealth(`http://localhost:${port}`);
    check('boot 1: API starts', up, up ? '' : run1.log().slice(-500));
    if (!up) return;
    const api = makeApi(`http://localhost:${port}`);
    const signup = await api('/api/auth/signup', {
      method: 'POST', auth: false,
      body: { name: 'Photo Owner', email: `photo+${stamp}@example.com`, password: 'verify1234', workspaceName: 'Photo Test Shop' },
    });
    check('boot 1: signup', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
    token = signup.data?.token ?? '';
    workspaceId = signup.data?.workspace?.id ?? '';
    const live = await api(`/api/workspaces/${workspaceId}/go-live`, { method: 'POST' });
    check('boot 1: go-live', live.status === 200 && live.data?.workspace?.practice_mode === false, `status=${live.status}`);
    const mk = async (name, pricePaisa, stock) => {
      const r = await api('/api/products', { method: 'POST', body: { name, pricePaisa, stock } });
      return r.data?.id ?? r.data?.product?.id ?? '';
    };
    jeansId = await mk('Jeans', 50000, 9);
    shirtId = await mk('Shirt', 60000, 10);
    tshirtId = await mk('T-shirt', 40000, 9);
    check('boot 1: 3 products created', !!jeansId && !!shirtId && !!tshirtId, `jeans=${jeansId.slice(0, 8)} shirt=${shirtId.slice(0, 8)} tshirt=${tshirtId.slice(0, 8)}`);
    for (const [id, url] of [[jeansId, IMG.jeans], [shirtId, IMG.shirt], [tshirtId, IMG.tshirt]]) {
      const r = await api(`/api/products/${id}/images`, { method: 'POST', body: { url } });
      check(`boot 1: photo added (${url.split('/').pop()})`, r.status === 201 || r.status === 200, `status=${r.status}`);
    }
    const ch = await api('/api/channels', { method: 'POST', body: { platform: 'webchat', externalId: 'site-photo', displayName: 'Photo Test Site' } });
    check('boot 1: webchat channel → 201', ch.status === 201, `status=${ch.status}`);

    // (a) List request → 3 photos + 3 captions + interest question.
    const mList = await webchat(api, 'wc-photo-list-1', 'List Customer', 'কি কি প্রোডাক্ট আছে?');
    check('boot 1: list webchat message accepted', mList.status === 200 && !!mList.data?.conversationId, `status=${mList.status}`);
    const listConvId = mList.data?.conversationId ?? '';
    const listFound = await pollFor(async () => {
      const t = await threadOut(api, listConvId);
      const imgs = t.out.filter((m) => m.type === 'image');
      const q = t.out.some((m) => (m.body ?? '').includes('আগ্রহী'));
      return imgs.length === 3 && q ? t : null;
    });
    check('boot 1: list → 3 image messages (one per product)', !!listFound && listFound.out.filter((m) => m.type === 'image').length === 3, `images=${(listFound?.out ?? []).filter((m) => m.type === 'image').length}`);
    check('boot 1: list → correct photo URLs', !!listFound && [IMG.jeans, IMG.shirt, IMG.tshirt].every((u) => listFound.out.some((m) => m.type === 'image' && m.body === u)), JSON.stringify((listFound?.out ?? []).filter((m) => m.type === 'image').map((m) => m.body)));
    check('boot 1: list → name + price caption below each photo', !!listFound && ['Jeans', 'Shirt', 'T-shirt'].every((n) => listFound.out.some((m) => m.type === 'text' && (m.body ?? '').includes(n) && /৳(৫০০|৬০০|৪০০)|500|600|400/.test(m.body ?? ''))), JSON.stringify((listFound?.out ?? []).filter((m) => m.type === 'text').map((m) => m.body)));
    check('boot 1: list → interest question, chat stays open', !!listFound && listFound.conv.status === 'open' && listFound.conv.mode === 'ai', `status=${listFound?.conv?.status ?? '?'}`);

    // (b) Show request → the jeans photo + details + price.
    const mShow = await webchat(api, 'wc-photo-show-1', 'Show Customer', 'জিন্সটা দেখাও');
    check('boot 1: show webchat message accepted', mShow.status === 200 && !!mShow.data?.conversationId, `status=${mShow.status}`);
    const showConvId = mShow.data?.conversationId ?? '';
    const showFound = await pollFor(async () => {
      const t = await threadOut(api, showConvId);
      const imgs = t.out.filter((m) => m.type === 'image');
      return imgs.length === 1 ? t : null;
    });
    check('boot 1: show → exactly 1 image (the jeans photo)', !!showFound && showFound.out.filter((m) => m.type === 'image').length === 1 && showFound.out.some((m) => m.type === 'image' && m.body === IMG.jeans), JSON.stringify((showFound?.out ?? []).filter((m) => m.type === 'image').map((m) => m.body)));
    check('boot 1: show → details text with Jeans + ৳500', !!showFound && showFound.out.some((m) => m.type === 'text' && (m.body ?? '').includes('Jeans') && ((m.body ?? '').includes('৳500') || (m.body ?? '').includes('500'))), JSON.stringify((showFound?.out ?? []).filter((m) => m.type === 'text').map((m) => m.body)));

    // (b2) REGRESSION (live bug 2026-11-08): the queue used to batch the
    // LAST 10 incoming messages with no lower bound, so "জিন্সটা দেখাও"
    // sent right after the list request re-fired the list intent and
    // re-sent the WHOLE list. Same conversation, same sender: the show
    // request must send ONLY the jeans photo + details.
    const listOutBefore = listFound.out.length;
    const mShowSame = await webchat(api, 'wc-photo-list-1', 'List Customer', 'জিন্সটা দেখাও');
    check('boot 1: same-thread show message accepted', mShowSame.status === 200 && mShowSame.data?.conversationId === listConvId, `status=${mShowSame.status}`);
    const showSameFound = await pollFor(async () => {
      const t = await threadOut(api, listConvId);
      return t.out.length >= listOutBefore + 2 ? t : null;
    });
    const newMsgs = (showSameFound?.out ?? []).slice(listOutBefore);
    check('boot 1: same-thread show → exactly 2 new messages (photo + details)', !!showSameFound && newMsgs.length === 2, `new=${newMsgs.length} ${JSON.stringify(newMsgs.map((m) => `${m.type}:${(m.body ?? '').slice(0, 30)}`))}`);
    check('boot 1: same-thread show → jeans photo only, NO second list', !!showSameFound && newMsgs.length === 2 && newMsgs[0].type === 'image' && newMsgs[0].body === IMG.jeans && newMsgs[1].type === 'text' && (newMsgs[1].body ?? '').includes('Jeans') && !newMsgs.some((m) => (m.body ?? '').includes('আগ্রহী')), JSON.stringify(newMsgs.map((m) => m.body)));

    // (c) Fast-reply question → deflection, no AI word, not escalated.
    const mFast = await webchat(api, 'wc-photo-fast-1', 'Fast Customer', 'তুমি এত দ্রুত রিপ্লাই দিচ্ছ কেন?');
    check('boot 1: fast-reply webchat message accepted', mFast.status === 200 && !!mFast.data?.conversationId, `status=${mFast.status}`);
    const fastConvId = mFast.data?.conversationId ?? '';
    const fastFound = await pollFor(async () => {
      const t = await threadOut(api, fastConvId);
      return t.out.length > 0 ? t : null;
    });
    const fastText = (fastFound?.out ?? []).map((m) => m.body ?? '').join(' ');
    check('boot 1: fast-reply → deflection text', !!fastFound && fastText.includes('দ্রুত উত্তর'), JSON.stringify(fastText.slice(0, 120)));
    check('boot 1: fast-reply → NO AI admission (no AI/এআই/রোবট)', !!fastFound && !/AI|এআই|রোবট|robot|bot/i.test(fastText), JSON.stringify(fastText.slice(0, 120)));
    check('boot 1: fast-reply → NOT escalated, chat stays open', !!fastFound && fastFound.conv.status === 'open' && !fastFound.conv.escalation_reason, `status=${fastFound?.conv?.status ?? '?'} reason=${fastFound?.conv?.escalation_reason ?? 'null'}`);

    // (d) "তুমি কি AI?" → escalated off-topic, no admission.
    const mAi = await webchat(api, 'wc-photo-ai-1', 'AI Customer', 'তুমি কি AI?');
    check('boot 1: AI-question webchat message accepted', mAi.status === 200 && !!mAi.data?.conversationId, `status=${mAi.status}`);
    const aiConvId = mAi.data?.conversationId ?? '';
    const aiFound = await pollFor(async () => {
      const t = await threadOut(api, aiConvId);
      return t.conv.status === 'waiting' ? t : null;
    });
    check('boot 1: AI question → waiting/off_topic', !!aiFound && aiFound.conv.escalation_reason === 'off_topic', `reason=${aiFound?.conv?.escalation_reason ?? '?'}`);
    check('boot 1: AI question → no reply (no admission possible)', !!aiFound && aiFound.out.length === 0, `out=${aiFound?.out?.length ?? '?'}`);

    // (e) Normal price question → open + real reply, NO photos.
    const mNormal = await webchat(api, 'wc-photo-ok-1', 'Normal Customer', 'জিন্সের দাম কত?');
    check('boot 1: normal webchat message accepted', mNormal.status === 200 && !!mNormal.data?.conversationId, `status=${mNormal.status}`);
    const normalConvId = mNormal.data?.conversationId ?? '';
    const normalFound = await pollFor(async () => {
      const t = await threadOut(api, normalConvId);
      return t.out.length > 0 ? t : null;
    });
    check('boot 1: normal question stays open + reply has ৳৫০০', !!normalFound && normalFound.conv.status === 'open' && normalFound.out.some((m) => (m.body ?? '').includes('৳৫০০') || (m.body ?? '').includes('500')), JSON.stringify((normalFound?.out ?? []).map((m) => m.body).slice(0, 1)));
    check('boot 1: normal question sent NO photos', !!normalFound && normalFound.out.filter((m) => m.type === 'image').length === 0, `images=${(normalFound?.out ?? []).filter((m) => m.type === 'image').length}`);

    // (f) Buyers-only: order for the normal customer, then the list.
    const normalDetail = await api(`/api/inbox/${normalConvId}`);
    const normalCustomerId = normalDetail.data?.customer?.id ?? normalDetail.data?.conversation?.customer_id ?? '';
    const order = await api('/api/orders', {
      method: 'POST',
      body: { customerId: normalCustomerId, conversationId: normalConvId, items: [{ productId: jeansId, quantity: 1 }], customerName: 'Normal Customer', customerPhone: '01700000001', deliveryAddress: 'Dhaka' },
    });
    check('boot 1: order created for the normal customer', order.status === 201, `status=${order.status} ${JSON.stringify(order.data ?? {}).slice(0, 120)}`);
    const custList = await api('/api/customers');
    const names = (custList.data?.customers ?? []).map((c) => c.name);
    check('boot 1: GET /api/customers returns the buyer', names.includes('Normal Customer'), JSON.stringify(names));
    check('boot 1: GET /api/customers hides non-buyers', !names.includes('List Customer') && !names.includes('Show Customer') && !names.includes('Fast Customer') && !names.includes('AI Customer'), JSON.stringify(names));
    const custSearch = await api('/api/customers?q=Normal');
    check('boot 1: GET /api/customers?q= finds the buyer', (custSearch.data?.customers ?? []).some((c) => c.name === 'Normal Customer'), JSON.stringify((custSearch.data?.customers ?? []).map((c) => c.name)));
    const custSearchMiss = await api('/api/customers?q=List');
    check('boot 1: GET /api/customers?q= hides a non-buyer', (custSearchMiss.data?.customers ?? []).length === 0, JSON.stringify((custSearchMiss.data?.customers ?? []).map((c) => c.name)));
  } finally {
    run1.stop();
    await sleep(2000);
  }

  // ---------- Driver: processBatch directly + unit checks ----------
  const driver = await runDriver(dataDir, workspaceId, jeansId, shirtId, tshirtId);
  let driverResult = null;
  const driverLine = (driver.out ?? '').split('\n').find((l) => l.startsWith('DRIVER_RESULT '));
  try {
    driverResult = driverLine ? JSON.parse(driverLine.slice('DRIVER_RESULT '.length)) : null;
  } catch {
    driverResult = null;
  }
  check('driver: ran clean (exit 0 + result line)', driver.code === 0 && !!driverResult, `code=${driver.code} err=${(driver.err ?? '').slice(-300)}`);
  if (driverResult) {
    check('driver: fast-reply unit matrix all correct', driverResult.fastUnitAllOk === true, JSON.stringify((driverResult.fastUnit ?? []).filter((c) => !c.ok)));
    check('driver: list-request unit matrix all correct', driverResult.listUnitAllOk === true, JSON.stringify((driverResult.listUnit ?? []).filter((c) => !c.ok)));
    check('driver: show-product unit matrix all correct', driverResult.showUnitAllOk === true, JSON.stringify((driverResult.showUnit ?? []).filter((c) => !c.ok)));
    const lf = driverResult.listFlow ?? {};
    check('driver: list flow → product_photos_sent, 3 images + interest question', lf.result?.replied === true && lf.result?.reason === 'product_photos_sent' && (lf.images ?? []).length === 3 && (lf.captions ?? []).some((b) => (b ?? '').includes('আগ্রহী')) && lf.state?.status === 'open', JSON.stringify({ r: lf.result, imgs: (lf.images ?? []).length, caps: lf.captions }));
    const sf = driverResult.showFlow ?? {};
    check('driver: show flow → product_photo_sent, jeans photo + ৳৫০০ details', sf.result?.replied === true && sf.result?.reason === 'product_photo_sent' && (sf.images ?? []).length === 1 && (sf.texts ?? []).some((b) => (b ?? '').includes('৳৫০০') || (b ?? '').includes('500')), JSON.stringify({ r: sf.result, imgs: sf.images, texts: sf.texts }));
    const ff = driverResult.fastFlow ?? {};
    check('driver: fast flow → deflected_fast_reply, no AI word, not escalated', ff.result?.replied === true && ff.result?.reason === 'deflected_fast_reply' && ff.hasAiWord === false && ff.state?.status === 'open' && !ff.state?.escalation_reason, JSON.stringify({ r: ff.result, text: (ff.text ?? '').slice(0, 100), s: ff.state }));
    const aq = driverResult.aiQuestion ?? {};
    check('driver: AI question → off_topic, no reply', aq.result?.replied === false && aq.state?.status === 'waiting' && aq.state?.escalation_reason === 'off_topic' && aq.outMessages === 0, JSON.stringify({ r: aq.result, s: aq.state }));
    const nm = driverResult.normal ?? {};
    check('driver: normal price → open + ৳৫০০, no photos', nm.result?.replied === true && nm.state?.status === 'open' && (nm.images ?? 0) === 0 && (nm.texts ?? []).some((b) => (b ?? '').includes('৳৫০০') || (b ?? '').includes('500')), JSON.stringify({ r: nm.result, s: nm.state }));
    const ts = driverResult.toolSend ?? {};
    check('driver: tool sends 3 images via Graph path (sent + platform ids)', Array.isArray(ts.result?.sent) && ts.result.sent.length === 3 && ts.result.sent.every((s) => !!s.platformMessageId) && ts.fetchCalls === 3, JSON.stringify({ sent: (ts.result?.sent ?? []).length, fetch: ts.fetchCalls }));
    check('driver: tool image rows recorded sent with the right URLs', Array.isArray(ts.imageRows) && ts.imageRows.length === 3 && ts.imageRows.every((r) => r.delivery === 'sent' && typeof r.url === 'string' && r.url.startsWith('https://example.com/photos/')), JSON.stringify(ts.imageRows));
    const np = driverResult.toolNoPhoto ?? {};
    check('driver: tool no-photo product fails honestly, no fetch call', (np.result?.failed ?? []).some((f) => f.error === 'no_photo') && np.fetchCallsDelta === 0, JSON.stringify(np.result));
    const tc = driverResult.toolComment ?? {};
    check('driver: tool on facebook_comment fails honestly (no image)', (tc.result?.failed ?? []).some((f) => f.error === 'image_send_not_supported_for_facebook_comment'), JSON.stringify(tc.result));
    const bo = driverResult.buyersOnly ?? {};
    check('driver: buyers-only predicate lists the buyer, hides the non-buyer', bo.buyerListed === true && bo.nonBuyerListed === false, JSON.stringify(bo.listed));
    const wt = driverResult.workspaceToggle ?? {};
    check('driver: workspace AI toggle flips off/on', wt.afterOff === false && wt.afterToggle === true && wt.afterOn === true, JSON.stringify(wt));
    check('driver: messenger channel seeded for boot 2', !!driverResult.boot2ChannelId, `id=${String(driverResult.boot2ChannelId ?? '').slice(0, 8)}`);
  }

  // ---------- Boot 2: Meta webhook owner guard ----------
  const run2 = startApi(port, dataDir);
  process.on('exit', run2.stop);
  try {
    const up2 = await waitForHealth(`http://localhost:${port}`);
    check('boot 2: API starts on the same dir', up2, up2 ? '' : run2.log().slice(-500));
    if (up2) {
      const api = makeApi(`http://localhost:${port}`);
      const OWNER = '29638693045727594';
      const CUSTOMER = '9336113056470349';
      const metaHook = async (senderId, text, mid) => fetch(`http://localhost:${port}/api/webhooks/meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          object: 'page',
          entry: [{
            id: 'TESTPAGE1', time: Math.floor(Date.now() / 1000),
            messaging: [{
              sender: { id: senderId }, recipient: { id: 'TESTPAGE1' },
              timestamp: Date.now(),
              message: { mid, text },
            }],
          }],
        }),
      });
      const inboxHas = async (q) => {
        const r = await api(`/api/inbox?q=${encodeURIComponent(q)}`);
        return (r.data?.conversations ?? []).length;
      };
      // Name-independent owner check: if the guard ever failed, the
      // owner's message would be SAVED as an incoming message in some
      // conversation. Scan every thread for that exact incoming body.
      const ownerMessagePresent = async (text) => {
        const all = await api('/api/inbox');
        for (const c of (all.data?.conversations ?? [])) {
          const d = await api(`/api/inbox/${c.id}`);
          if ((d.data?.messages ?? []).some((m) => m.direction === 'in' && (m.body ?? '') === text)) return true;
        }
        return false;
      };
      const findConversationWithIncoming = async (text) => {
        const all = await api('/api/inbox');
        for (const c of (all.data?.conversations ?? [])) {
          const d = await api(`/api/inbox/${c.id}`);
          if ((d.data?.messages ?? []).some((m) => m.direction === 'in' && (m.body ?? '').includes(text))) return c.id;
        }
        return '';
      };

      // Owner "." → AI off (no customer/conversation for the owner).
      const h1 = await metaHook(OWNER, '.', `owner-dot-off-${stamp}`);
      check('boot 2: owner dot accepted', h1.status === 200, `status=${h1.status}`);
      await sleep(3000);
      check('boot 2: owner dot created NO customer/conversation', !(await ownerMessagePresent('.')), 'owner dot saved as a message');

      // AI is now off: a real customer message gets NO AI reply.
      const h2 = await metaHook(CUSTOMER, 'জিন্সের দাম কত?', `cust-off-${stamp}`);
      check('boot 2: customer message accepted while AI off', h2.status === 200, `status=${h2.status}`);
      await sleep(9000);
      const custConvId = await findConversationWithIncoming('জিন্সের দাম কত?');
      const custDetail = custConvId ? await api(`/api/inbox/${custConvId}`) : null;
      const custOut = (custDetail?.data?.messages ?? []).filter((m) => m.direction === 'out');
      check('boot 2: AI off → customer got NO reply', custOut.length === 0, `out=${custOut.length}`);

      // Owner ".on" → AI back on.
      const h3 = await metaHook(OWNER, '.on', `owner-dot-on-${stamp}`);
      check('boot 2: owner .on accepted', h3.status === 200, `status=${h3.status}`);
      await sleep(3000);
      check('boot 2: owner .on created NO customer/conversation either', !(await ownerMessagePresent('.on')), 'owner .on saved as a message');

      // AI is back on: a new customer message gets a reply.
      const h4 = await metaHook(CUSTOMER, 'শার্টের দাম কত?', `cust-on-${stamp}`);
      check('boot 2: customer message accepted while AI on', h4.status === 200, `status=${h4.status}`);
      const custOn = await pollFor(async () => {
        const d = await api(`/api/inbox/${custConvId}`);
        const out = (d.data?.messages ?? []).filter((m) => m.direction === 'out');
        return out.length > 0 ? out : null;
      }, 30000);
      check('boot 2: AI on → customer got a reply', !!custOn && custOn.length > 0, `out=${custOn?.length ?? 0}`);

      // Non-owner "." must NOT toggle: AI stays on.
      const h5 = await metaHook(CUSTOMER, '.', `cust-dot-${stamp}`);
      check('boot 2: non-owner dot accepted (saved, not toggled)', h5.status === 200, `status=${h5.status}`);
      await sleep(3000);
      const h6 = await metaHook(CUSTOMER, 'টি-শার্টের দাম কত?', `cust-after-dot-${stamp}`);
      check('boot 2: message after non-owner dot accepted', h6.status === 200, `status=${h6.status}`);
      const custStillOn = await pollFor(async () => {
        const d = await api(`/api/inbox/${custConvId}`);
        const out = (d.data?.messages ?? []).filter((m) => m.direction === 'out');
        return out.length >= 2 ? out : null;
      }, 30000);
      check('boot 2: non-owner dot did NOT turn the AI off', !!custStillOn && custStillOn.length >= 2, `out=${custStillOn?.length ?? 0}`);

      // Owner normal message creates nothing.
      const h7 = await metaHook(OWNER, 'হাই', `owner-hi-${stamp}`);
      check('boot 2: owner normal message accepted (ignored)', h7.status === 200, `status=${h7.status}`);
      await sleep(3000);
      check('boot 2: owner normal message created NO customer/conversation', !(await ownerMessagePresent('হাই')), 'owner message saved');
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
