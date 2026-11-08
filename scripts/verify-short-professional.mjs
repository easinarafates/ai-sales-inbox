#!/usr/bin/env node
/**
 * Verification for SHORT + PROFESSIONAL AI replies, the invoice image,
 * and like/sticker handling (2026-11-08, user report: "the AI gives VERY
 * LONG answers and makes mistakes — make it completely professional").
 *
 * A. SHORT REPLIES (core rule, everywhere):
 *    - Product list = just the list (header + one line per product), no
 *      trailing question, no extra line.
 *    - "দোকান কোথায়?" → ONE line from the knowledge book
 *      ("স্যার, আমাদের দোকান মাগুরায়।").
 *    - Order confirm = just the confirmation + at most ONE short
 *      suggestion line about another product.
 *    - "এই প্রোডাক্টটি কি জিন্স?" → one sentence ("স্যার, হ্যাঁ, এই
 *      প্রোডাক্টটি জিন্স।"); "অন্য কোনো কালারে আছে?" → one short "no".
 *    - Deterministic brevity guard (shortenReply) caps any LLM reply.
 * B. INVOICE IMAGE: after the order is confirmed, the AI sends the
 *    invoice as a PNG (headless Chromium + Hind Siliguri — correct
 *    Bengali conjuncts, NOT Satori) as a Messenger image attachment,
 *    alongside the invoice link. A render/upload failure is logged
 *    honestly and never blocks the confirmation.
 * C. LIKE / STICKER: a thumbs-up sticker (sticker_id 369239263222822)
 *    arrives as an image attachment with payload.sticker_id — it is
 *    saved as type 'sticker' with body '[লাইক]' and NO media_url (never
 *    downloaded as a photo, never vision-matched). The AI replies
 *    contextually and SHORTLY: no context → "স্যার, কিভাবে আপনাকে
 *    সাহায্য করতে পারি?"; after a product question → a brief
 *    acknowledgment tied to it. NEVER "আমাদের কাছে এই প্রোডাক্ট নেই".
 *
 * Checks:
 * - Static: prompt rule 0 + examples, shortenReply + wiring, list is
 *   just-the-list, detectShopLocation, like handler, shop-location
 *   handler, invoice-image module (Chromium, no Satori), extras wiring
 *   (live + demo), webhook sticker detection.
 * - Boot (local API on PGlite, blank provider keys → demo mode, stub
 *   Graph server): webchat list = just the list; simulated Meta webhook
 *   with a sticker → saved as type 'sticker' + short reply, no product
 *   mention; sticker after a product question → contextual short reply.
 * - Driver 1 (processBatch directly, demo mode): shortenReply units,
 *   detectShopLocation units, list, shop location (one line), like
 *   (no context + after product), order confirm + suggestion, invoice
 *   image render (PNG bytes, 700px wide, >10KB).
 * - Driver 2 (processBatch directly, REAL Gemini key from apps/api/.env):
 *   jeans yes/no, other colour, price short, shop location live.
 *   Skipped (reported, not passed) without a key.
 *
 * Run from the repo root:  node scripts/verify-short-professional.mjs
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
const WEBCHAT_SECRET = 'short-prof-test-secret';

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
      JWT_SECRET: 'short-prof-test-jwt-secret-0123456789abcdef',
      TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      WEBCHAT_SECRET,
      // Blank the provider keys so the boot runs in deterministic demo
      // mode (no live AI calls). The live driver gets the real key.
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

function runDriver(script, dataDir, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const proc = spawn('npx', ['tsx', `../../scripts/${script}`, ...args], {
      cwd: path.join(ROOT, 'apps/api'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        USE_PGLITE: 'true',
        PGLITE_DATA_DIR: dataDir,
        JWT_SECRET: 'short-prof-test-jwt-secret-0123456789abcdef',
        TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        WEBCHAT_SECRET,
        GEMINI_API_KEY: '',
        GROQ_API_KEY: '',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
        ...extraEnv,
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

function readEnvFile(file) {
  const env = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      env[t.slice(0, eq).trim()] = v;
    }
  } catch { /* no .env — live driver skips */ }
  return env;
}

async function sendWebchat(api, externalId, senderId, name, text) {
  return api('/api/webhooks/webchat', {
    method: 'POST', auth: false,
    headers: { 'x-webchat-secret': WEBCHAT_SECRET },
    body: { externalId, senderId, name, text },
  });
}

async function threadOut(api, conversationId) {
  const detail = await api(`/api/inbox/${conversationId}`);
  const msgs = detail.data?.messages ?? [];
  return { conv: detail.data?.conversation ?? {}, msgs, out: msgs.filter((m) => m.direction === 'out') };
}

async function sendMetaSticker(api, pageId, senderId, mid, stickerId = 369239263222822) {
  return api('/api/webhooks/meta', {
    method: 'POST', auth: false,
    body: {
      object: 'page',
      entry: [{
        id: pageId,
        messaging: [{
          sender: { id: senderId },
          recipient: { id: pageId },
          timestamp: Date.now(),
          message: {
            mid,
            attachments: [{ type: 'image', payload: { sticker_id: stickerId } }],
          },
        }],
      }],
    },
  });
}

async function sendMetaText(api, pageId, senderId, mid, text) {
  return api('/api/webhooks/meta', {
    method: 'POST', auth: false,
    body: {
      object: 'page',
      entry: [{
        id: pageId,
        messaging: [{
          sender: { id: senderId },
          recipient: { id: pageId },
          timestamp: Date.now(),
          message: { mid, text },
        }],
      }],
    },
  });
}

function countLines(s) {
  return s.split('\n').map((l) => l.trim()).filter(Boolean).length;
}

async function main() {
  // ---------- Static checks: A (short replies) ----------
  const promptSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/ai-agent/prompts.ts'), 'utf8');
  check('A: prompt has brevity rule 0 (shortest reply, one line when enough)', promptSrc.includes('0. উত্তর সবসময় সংক্ষিপ্ত হবে') && promptSrc.includes('তত কম শব্দে দাও'));
  check('A: prompt rule 0 carries the exact examples (list / shop / jeans / colour)', promptSrc.includes('আমাদের শপ মাগুরাতে।') && promptSrc.includes('এই প্রোডাক্টটি জিন্স।') && promptSrc.includes('অন্য কোনো কালারে আমাদের অ্যাভেলেবেল নাই'));
  check('A: prompt rule 10 (list) forbids a trailing question/line', promptSrc.includes('তালিকার পরে আর কিছু লিখো না'));

  const agentSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/ai-agent/agent.ts'), 'utf8');
  check('A: shortenReply guard exported', agentSrc.includes('export function shortenReply'));
  check('A: shortenReply always keeps prices + invoice/confirmation lines', agentSrc.includes('ইনভয়েস') && agentSrc.includes('অর্ডার কনফার্ম') && agentSrc.includes('অর্ডার নম্বর'));
  check('A: brevity guard applied to LLM replies (after the hallucination guard, before send)', agentSrc.indexOf('shortenReply(parsed.reply)') > agentSrc.indexOf('guardReplyAgainstHallucination(parsed.reply') && agentSrc.indexOf('shortenReply(parsed.reply)') < agentSrc.indexOf('Send the reply for real'));
  check('A: list reply is just the list (no trailing question)', agentSrc.includes("আমাদের প্রোডাক্টগুলো:\\n${list}`") && !agentSrc.includes("আমাদের প্রোডাক্টগুলো:\\n${list}\\nকোনটি সম্পর্কে জানতে চান"));
  check('A: shop-location handler (detectShopLocation → one line from knowledge)', agentSrc.includes('detectShopLocation(latestText)') && agentSrc.includes("reason: 'shop_location'"));
  check('A: like handler (sticker → contextual short reply, no product match)', agentSrc.includes("reason: 'like_acknowledged'") && agentSrc.includes("mediaType === 'sticker'"));
  check('A: order-confirmation extras helper exists (invoice image + one suggestion)', agentSrc.includes('sendOrderConfirmationExtras') && agentSrc.includes('invoice image') && agentSrc.includes('One short suggestion'));

  const intentSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/ai-agent/detect-intent.ts'), 'utf8');
  check('A: detectShopLocation exported (Bengali + Banglish + English)', intentSrc.includes('export function detectShopLocation') && intentSrc.includes('দোকান (কোথায়|কোথাই|কই') && intentSrc.includes('where is (your |the )?(shop|store)'));

  // ---------- Static checks: B (invoice image) ----------
  const imgSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/orders/invoice-image.ts'), 'utf8');
  check('B: invoice-image module renders via headless Chromium (puppeteer + @sparticuz/chromium)', imgSrc.includes('@sparticuz/chromium') && imgSrc.includes('puppeteer-core') && imgSrc.includes('page.screenshot'));
  const imgFontSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/orders/invoice-font.ts'), 'utf8');
  check('B: invoice image uses an embedded Bengali font (Hind Siliguri, no Satori import)', imgSrc.includes('Hind Siliguri') && imgFontSrc.includes('Hind Siliguri') && !/\bimport\b[^;]*satori/i.test(imgSrc) && !/\bimport\b[^;]*@vercel\/og/i.test(imgSrc));
  check('B: renderInvoiceImageForOrder loads the order + items (same fields as the public invoice API)', imgSrc.includes('export async function renderInvoiceImageForOrder') && imgSrc.includes('order_number') && imgSrc.includes('invoice_token'));
  check('B: extras are wired into the LIVE confirmation block (after confirmSent)', (() => {
    const start = agentSrc.indexOf('if (createdOrder) {');
    const end = agentSrc.indexOf("reason: 'order_confirmed'", start);
    return start > 0 && end > start && agentSrc.slice(start, end).includes('sendOrderConfirmationExtras(');
  })());
  check('B: extras are wired into the DEMO confirmation branch (liveSend: false)', agentSrc.includes('if (demoCreatedOrder) {') && agentSrc.includes('{ liveSend: false },') && agentSrc.split('sendOrderConfirmationExtras(').length - 1 === 3);
  check('B: invoice image failure never blocks the confirmation (best-effort try/catch + honest log)', imgSrc.includes('return null') && agentSrc.includes('invoice image render failed') && agentSrc.includes('invoice image upload failed'));

  // ---------- Static checks: C (like / sticker) ----------
  const hookSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/webhooks/routes.ts'), 'utf8');
  check('C: webhook reads sticker_id from the attachment payload', hookSrc.includes('sticker_id?: number') && hookSrc.includes('payload?.sticker_id'));
  check('C: sticker is detected FIRST (before any photo download/vision)', hookSrc.indexOf('payload.sticker_id') > 0 && hookSrc.indexOf('payload.sticker_id') < hookSrc.indexOf('const kind = attachment.type'));
  check('C: like sticker (369239263222822) → body [লাইক], no media URL', hookSrc.includes('369239263222822') && hookSrc.includes("'[লাইক]'") && hookSrc.includes('url: null'));
  check('C: sticker saved as its own type (msgType sticker, not image)', hookSrc.includes("msgType: 'sticker'") && hookSrc.includes("type: 'sticker'"));

  // ---------- Stub Graph server (captures the AI's sends) ----------
  const stubHits = [];
  const graphStub = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let raw = '';
    req.on('data', (c) => { raw += c.toString(); });
    req.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      stubHits.push({ method: req.method, path: url.pathname, body, at: Date.now() });
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'POST' && url.pathname.endsWith('/messages')) {
        if (body && body.sender_action === 'mark_seen') return send(200, { recipient_id: body?.recipient?.id ?? '' });
        return send(200, { message_id: `mid-stub-${Date.now()}` });
      }
      return send(200, { success: true });
    });
  });
  const stubPort = 4025;
  await new Promise((resolve) => graphStub.listen(stubPort, resolve));

  // ---------- Boot (demo mode, PGlite) ----------
  const stamp = Date.now();
  const port = 4026;
  const dataDir = '.pglite-data-shortprof';
  const dataDirAbs = path.join(ROOT, 'apps/api', dataDir);
  try { fs.rmSync(dataDirAbs, { recursive: true, force: true }); } catch { /* stale dir locked by a leaked server — start anyway */ }
  const run1 = startApi(port, dataDir, {
    META_APP_ID: 'dummy-app-id',
    META_APP_SECRET: 'dummy-app-secret',
    META_GRAPH_BASE_URL: `http://localhost:${stubPort}/v21.0`,
  });
  process.on('exit', run1.stop);
  let workspaceId = '';
  let jeansId = '';
  let tshirtId = '';
  let shirtId = '';
  let channelId = '';
  try {
    const up = await waitForHealth(`http://localhost:${port}`);
    check('boot: API starts', up, up ? '' : run1.log().slice(-500));
    if (!up) return;
    const api = makeApi(`http://localhost:${port}`);
    // NOTE: the trial plan allows only 1 connected channel per workspace,
    // so the boot uses TWO workspaces — A (webchat: list test + the
    // products the drivers use) and B (messenger: sticker tests).
    const signup = await api('/api/auth/signup', {
      method: 'POST', auth: false,
      body: { name: 'ShortProf Owner', email: `shortprof+${stamp}@example.com`, password: 'verify1234', workspaceName: 'ShortProf Test Shop' },
    });
    check('boot: signup (workspace A)', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
    token = signup.data?.token ?? '';
    workspaceId = signup.data?.workspace?.id ?? '';
    const live = await api(`/api/workspaces/${workspaceId}/go-live`, { method: 'POST' });
    check('boot: go-live (workspace A)', live.status === 200 && live.data?.workspace?.practice_mode === false, `status=${live.status}`);
    const jeans = await api('/api/products', { method: 'POST', body: { name: 'Jeans', pricePaisa: 50000, stock: 10 } });
    jeansId = jeans.data?.id ?? jeans.data?.product?.id ?? '';
    check('boot: Jeans created (৳500)', jeans.status === 201 && !!jeansId, `status=${jeans.status}`);
    const tsh = await api('/api/products', { method: 'POST', body: { name: 'T-shirt', pricePaisa: 40000, stock: 9 } });
    tshirtId = tsh.data?.id ?? tsh.data?.product?.id ?? '';
    check('boot: T-shirt created (৳400)', tsh.status === 201 && !!tshirtId, `status=${tsh.status}`);
    const sht = await api('/api/products', { method: 'POST', body: { name: 'Shirt', pricePaisa: 60000, stock: 10 } });
    shirtId = sht.data?.id ?? sht.data?.product?.id ?? '';
    check('boot: Shirt created (৳600)', sht.status === 201 && !!shirtId, `status=${sht.status}`);
    const ch = await api('/api/channels', { method: 'POST', body: { platform: 'webchat', externalId: 'site-shortprof', displayName: 'ShortProf Test Site' } });
    channelId = ch.data?.channel?.id ?? ch.data?.id ?? '';
    check('boot: webchat channel → 201', ch.status === 201 && !!channelId, `status=${ch.status}`);
    // Workspace B (messenger only — the trial's 1-channel slot).
    const signupB = await api('/api/auth/signup', {
      method: 'POST', auth: false,
      body: { name: 'ShortProf Owner B', email: `shortprof-b+${stamp}@example.com`, password: 'verify1234', workspaceName: 'ShortProf Sticker Shop' },
    });
    check('boot: signup (workspace B)', signupB.status === 201 && !!signupB.data?.token, `status=${signupB.status}`);
    const tokenB = signupB.data?.token ?? '';
    const workspaceB = signupB.data?.workspace?.id ?? '';
    const liveB = await api(`/api/workspaces/${workspaceB}/go-live`, { method: 'POST', auth: true, headers: { Authorization: `Bearer ${tokenB}` } });
    check('boot: go-live (workspace B)', liveB.status === 200 && liveB.data?.workspace?.practice_mode === false, `status=${liveB.status}`);
    const msg = await api('/api/channels', { method: 'POST', body: { platform: 'messenger', externalId: 'page-shortprof', displayName: 'ShortProf Page', token: 'tok-shortprof' }, headers: { Authorization: `Bearer ${tokenB}` } });
    check('boot: messenger channel (stub token) → 201', msg.status === 201, `status=${msg.status}`);
    // Workspace B needs the same catalog, or the price question below
    // gets an empty-catalog reply and the like has no product context.
    for (const [name, pricePaisa, stock] of [['Jeans', 50000, 10], ['T-shirt', 40000, 9], ['Shirt', 60000, 10]]) {
      const p = await api('/api/products', { method: 'POST', body: { name, pricePaisa, stock }, headers: { Authorization: `Bearer ${tokenB}` } });
      check(`boot: ${name} created in workspace B (৳${pricePaisa / 100})`, p.status === 201, `status=${p.status}`);
    }
    // Back to workspace A for the list test.
    token = signup.data?.token ?? '';

    // 1) List via webchat = JUST the list (one text message, no trailing question).
    const mList = await sendWebchat(api, 'site-shortprof', 'wc-sp-list-1', 'List Customer', 'কি কি প্রোডাক্ট আছে');
    const listConv = mList.data?.conversationId ?? '';
    const listFound = await pollFor(async () => {
      const { out } = await threadOut(api, listConv);
      return out.length > 0 ? { out } : null;
    });
    const listReply = (listFound?.out ?? []).map((m) => m.body ?? '').join('\n');
    check('boot: list is ONE text message', !!listFound && listFound.out.length === 1, `out=${listFound?.out?.length ?? 0}`);
    check('boot: list is just the list (header + 3 product lines, no trailing question)',
      // The webchat customer has no gender on file, so there may be no
      // "স্যার," prefix — the point is header + 3 lines, nothing more.
      listReply.includes('আমাদের প্রোডাক্টগুলো:') &&
      countLines(listReply) === 4 &&
      !/কোনটি সম্পর্কে জানতে চান/.test(listReply) &&
      !/নামটা লিখে জানান/.test(listReply),
      JSON.stringify(listReply.slice(0, 200)));

    // 2) Like (sticker) with NO context → saved as sticker + short help reply.
    // (Workspace B now — the sticker conversations live there.)
    token = tokenB;
    const hookLike = await sendMetaSticker(api, 'page-shortprof', 'psid-like-1', `like-1-${stamp}`);
    check('boot: sticker webhook accepted', hookLike.status === 200, `status=${hookLike.status}`);
    const likeList = await pollFor(async () => {
      const list = await api('/api/inbox');
      const conv = (list.data?.conversations ?? []).find((c) => c.last_message === '[লাইক]');
      return conv ? { conv } : null;
    });
    const likeConvId = likeList?.conv?.id ?? '';
    check('boot: like creates a conversation (last message [লাইক])', !!likeConvId, `conv=${likeConvId}`);
    const likeThread = likeConvId ? await threadOut(api, likeConvId) : { msgs: [], out: [] };
    const likeIn = (likeThread.msgs ?? []).find((m) => m.direction === 'in');
    check('boot: like saved as type sticker with body [লাইক] (not a photo)', !!likeIn && likeIn.type === 'sticker' && likeIn.body === '[লাইক]', JSON.stringify(likeIn ?? null).slice(0, 150));
    const likeReplyFound = await pollFor(async () => {
      const { out } = await threadOut(api, likeConvId);
      return out.length > 0 ? { out } : null;
    }, 45000);
    const likeReply = (likeReplyFound?.out ?? []).map((m) => m.body ?? '').join('\n');
    check('boot: like → short help reply (≤1 line, no product mention, no "we don\'t have this product")',
      !!likeReplyFound &&
      countLines(likeReply) <= 1 &&
      /কিভাবে আপনাকে সাহায্য করতে পারি/.test(likeReply) &&
      !/প্রোডাক্ট/.test(likeReply) &&
      !/আমাদের কাছে এই প্রোডাক্ট নেই/.test(likeReply),
      JSON.stringify(likeReply.slice(0, 150)));

    // 3) Like AFTER a product question → contextual short reply.
    const hookQ = await sendMetaText(api, 'page-shortprof', 'psid-like-2', `like-q-1-${stamp}`, 'Jeans এর দাম কত?');
    check('boot: product question webhook accepted', hookQ.status === 200, `status=${hookQ.status}`);
    const qList = await pollFor(async () => {
      const list = await api('/api/inbox');
      const conv = (list.data?.conversations ?? []).find((c) => c.last_message === 'Jeans এর দাম কত?');
      return conv ? { conv } : null;
    });
    const qConvId = qList?.conv?.id ?? '';
    const qReplyFound = await pollFor(async () => {
      const { out } = await threadOut(api, qConvId);
      return out.length > 0 ? { out } : null;
    }, 45000);
    check('boot: product question gets a reply first', !!qReplyFound && (qReplyFound.out[0]?.body ?? '').includes('500'), JSON.stringify(qReplyFound?.out?.[0]?.body ?? '').slice(0, 120));
    const hookLike2 = await sendMetaSticker(api, 'page-shortprof', 'psid-like-2', `like-2-${stamp}`);
    check('boot: second sticker webhook accepted', hookLike2.status === 200, `status=${hookLike2.status}`);
    const like2Found = await pollFor(async () => {
      const { out } = await threadOut(api, qConvId);
      return out.length >= 2 ? { out } : null;
    }, 45000);
    const like2Reply = (like2Found?.out ?? []).map((m) => m.body ?? '').pop() ?? '';
    check('boot: like after a product question → contextual short reply (ধন্যবাদ, ≤1 line, no "we don\'t have this product")',
      !!like2Found &&
      countLines(like2Reply) <= 1 &&
      /ধন্যবাদ/.test(like2Reply) &&
      !/আমাদের কাছে এই প্রোডাক্ট নেই/.test(like2Reply),
      JSON.stringify(like2Reply.slice(0, 150)));
  } finally {
    run1.stop();
    await sleep(2000);
  }

  // ---------- Driver 1: processBatch directly + unit matrices (demo mode) ----------
  const driver = await runDriver('short-professional-driver.ts', dataDir, [workspaceId, jeansId, tshirtId, shirtId, channelId]);
  let driverResult = null;
  const driverLine = (driver.out ?? '').split('\n').find((l) => l.startsWith('DRIVER_RESULT '));
  try {
    driverResult = driverLine ? JSON.parse(driverLine.slice('DRIVER_RESULT '.length)) : null;
  } catch {
    driverResult = null;
  }
  check('driver 1: ran clean (exit 0 + result line)', driver.code === 0 && !!driverResult, `code=${driver.code} err=${(driver.err ?? '').slice(-400)}`);
  if (driverResult) {
    check('driver 1: shortenReply trims a long reply, keeps the price, ≤450 chars', driverResult.shortenLong?.ok === true, JSON.stringify(driverResult.shortenLong ?? {}));
    check('driver 1: shortenReply leaves a short reply untouched', driverResult.shortenShortUntouched?.ok === true, JSON.stringify(driverResult.shortenShortUntouched ?? {}));
    check('driver 1: shortenReply cuts one over-long sentence at a word boundary', driverResult.shortenOneLongSentence?.ok === true, JSON.stringify(driverResult.shortenOneLongSentence ?? {}));
    check('driver 1: detectShopLocation unit matrix all correct', driverResult.shopLocationUnitAllOk === true, JSON.stringify((driverResult.shopLocationUnit ?? []).filter((c) => !c.ok)));
    check('driver 1: list is just the list (header + 3 lines, no trailing question)', driverResult.listJustTheList?.ok === true, JSON.stringify(driverResult.listJustTheList ?? {}).slice(0, 300));
    check('driver 1: shop location = ONE line from the knowledge book', driverResult.shopLocationOneLine?.ok === true, JSON.stringify(driverResult.shopLocationOneLine ?? {}));
    check('driver 1: like (no context) → short help reply, no product mention', driverResult.likeNoContext?.ok === true, JSON.stringify(driverResult.likeNoContext ?? {}));
    check('driver 1: like after a product question → contextual short reply', driverResult.likeAfterProduct?.ok === true, JSON.stringify(driverResult.likeAfterProduct ?? {}));
    const oc = driverResult.orderConfirm ?? {};
    check('driver 1: order confirm is complete + compact (name/address/items/total + invoice link)', oc.confirmOk === true, JSON.stringify(oc.confirm ?? '').slice(0, 300));
    check('driver 1: order confirm adds ONE short suggestion about another product', oc.suggestionOk === true, JSON.stringify(oc.suggestion ?? ''));
    check('driver 1: invoice image renders (valid PNG, 700px wide, >10KB)', driverResult.invoiceRender?.ok === true, JSON.stringify(driverResult.invoiceRender ?? {}));
  }

  // ---------- Driver 2: live Gemini short replies ----------
  const envFile = readEnvFile(path.join(ROOT, 'apps/api/.env'));
  const liveKey = envFile.GEMINI_API_KEY ?? '';
  if (!liveKey) {
    console.log('SKIP  live driver: no GEMINI_API_KEY in apps/api/.env — live short-reply checks not run (not a pass)');
  } else {
    const live = await runDriver('short-professional-live-driver.ts', dataDir, [workspaceId, jeansId, tshirtId, shirtId, channelId], { GEMINI_API_KEY: liveKey });
    let liveResult = null;
    const liveLine = (live.out ?? '').split('\n').find((l) => l.startsWith('LIVE_DRIVER_RESULT '));
    try {
      liveResult = liveLine ? JSON.parse(liveLine.slice('LIVE_DRIVER_RESULT '.length)) : null;
    } catch {
      liveResult = null;
    }
    if (liveResult?.skipped) {
      console.log('SKIP  live driver: no GEMINI_API_KEY in the driver env — live short-reply checks not run (not a pass)');
    } else {
      check('live driver: ran clean (exit 0 + result line)', live.code === 0 && !!liveResult, `code=${live.code} err=${(live.err ?? '').slice(-400)}`);
      if (liveResult) {
        check('live: "এই প্রোডাক্টটি কি জিন্স?" → ONE sentence, হ্যাঁ + জিন্স', liveResult.jeansYesNo?.ok === true, JSON.stringify(liveResult.jeansYesNo ?? {}));
        check('live: "অন্য কোনো কালারে আছে?" → one short "no" (≤2 lines)', liveResult.otherColour?.ok === true, JSON.stringify(liveResult.otherColour ?? {}));
        check('live: price question → short reply with the right price (≤2 lines)', liveResult.priceShort?.ok === true, JSON.stringify(liveResult.priceShort ?? {}));
        check('live: shop location → ONE line with a real provider', liveResult.shopLocationLive?.ok === true, JSON.stringify(liveResult.shopLocationLive ?? {}));
      }
    }
  }

  graphStub.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — ${failed.length} FAILED` : ''}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('VERIFIER ERROR', err);
  process.exit(1);
});
