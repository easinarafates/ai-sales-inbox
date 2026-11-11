#!/usr/bin/env node
/**
 * Verification for Page Read (Feature 2, 2026-11-11) — "পেজ পড়ুন".
 *
 * The Halal Chic Page has OLD products sold long ago that are NOT in the
 * website's product list. Page Read fetches the Page's post history with
 * the stored Page token (server-side Graph call), extracts candidate
 * products with Gemini Lite, stores them PENDING, and only a confirmed
 * item enters the AI's knowledge book — with old-product wording so the
 * AI never claims an old product is in stock or invents a price.
 *
 * Checks:
 * - Static: migration 41 table, page-read module exports + honest
 *   Bengali reconnect message, routes are owner-only, Teach page has
 *   the "পেজ পড়ুন" section.
 * - Driver (unit, tsx, /tmp): regex extractor (Bengali + Latin digits,
 *   no invented price) + Gemini-stub extractor + old-product body wording.
 * - Boot (local API on PGlite + a stub Graph server via
 *   META_GRAPH_BASE_URL — the same override seam meta-oauth/meta-send
 *   use for offline testing; no live Facebook needed):
 *   (a) member → 403 on POST /api/knowledge/page-read;
 *   (b) no connected Page → honest Bengali reconnect message +
 *       needsReconnect, and nothing stored;
 *   (d) stub Graph read → 2 posts scanned, 2 products found, pending
 *       list, re-read inserts 0 (dedup), confirm → live knowledge item,
 *       reject → pending list empty;
 *   (e) confirmed knowledge body contains the old-product / may-be-out-
 *       of-stock wording.
 *
 * A real live Graph read of Halal Chic can ONLY be verified after deploy
 * with the real Page token (and only after the owner reconnects Halal
 * Chic once — the live token predates pages_read_engagement).
 *
 * Run from the repo root:  node scripts/verify-page-read.mjs
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
let memberToken = '';

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeApi(base, getToken) {
  return async function api(path, { method = 'GET', body, auth = true, headers = {} } = {}) {
    const authToken = typeof getToken === 'function' ? getToken() : getToken;
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
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data, text };
  };
}

async function waitForHealth(base, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
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

/** Stub Graph server: answers /v21.0/<page-id>/posts with 2 fixed posts. */
function startStubGraph(port, pageId) {
  const posts = [
    {
      id: 'post-shirt-1',
      message: 'নতুন শার্ট মাত্র ৳৬০০\nকটন শার্ট, সব সাইজ পাওয়া যাবে',
      created_time: '2025-03-01T10:00:00+0000',
      attachments: { data: [{ media_type: 'photo', media: { image: { src: 'https://example.com/shirt.jpg' } }, url: 'https://www.facebook.com/post-shirt-1' }] },
    },
    {
      id: 'post-panjabi-1',
      message: 'পুরোনো পাঞ্জাবি — দাম জানতে ইনবক্স করুন',
      created_time: '2024-12-01T10:00:00+0000',
      attachments: { data: [{ media_type: 'photo', media: { image: { src: 'https://example.com/panjabi.jpg' } }, url: 'https://www.facebook.com/post-panjabi-1' }] },
    },
  ];
  let sawAuthHeader = false;
  const server = http.createServer((req, res) => {
    if (req.headers.authorization?.startsWith('Bearer ')) sawAuthHeader = true;
    // The override base has no /v21.0 prefix (graphBase() carries the
    // version in production), so match on the /<page-id>/posts tail.
    if (req.method === 'GET' && req.url?.includes(`/${pageId}/posts`)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: posts }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found in stub graph', code: 100 } }));
  });
  return new Promise((resolve) => {
    server.listen(port, () => resolve({ server, sawAuthHeader: () => sawAuthHeader }));
  });
}

const DRIVER_SRC = `
import { extractProductsFromPosts, extractProductsRegex, buildOldProductKnowledgeBody } from '/home/hatch/workspace/ai-sales-inbox/apps/api/src/channels/page-read.ts';
async function main() {
const out = {};
// 1. Regex: Latin digits, price stated.
const r1 = extractProductsRegex([{ id: 'p1', message: 'নতুন শার্ট মাত্র ৳৬০০\\nকটন শার্ট', created_time: '2025-03-01T10:00:00+0000', attachments: { data: [{ media_type: 'photo', media: { image: { src: 'https://example.com/s.jpg' } } }] } }]);
out.regexShirt = { name: r1[0]?.name, pricePaisa: r1[0]?.pricePaisa, photo: r1[0]?.photoUrl };
// 2. Regex: Bengali digits.
const r2 = extractProductsRegex([{ id: 'p2', message: 'পাঞ্জাবি ৳১২০০', created_time: '2025-01-01T10:00:00+0000' }]);
out.regexBengaliDigits = { name: r2[0]?.name, pricePaisa: r2[0]?.pricePaisa };
// 3. Regex: no price -> null, never invented.
const r3 = extractProductsRegex([{ id: 'p3', message: 'পুরোনো পাঞ্জাবি — দাম জানতে ইনবক্স করুন', created_time: '2024-01-01T10:00:00+0000' }]);
out.regexNoPrice = { name: r3[0]?.name, pricePaisa: r3[0]?.pricePaisa };
// 4. Gemini stub: correct name/price, no invented price for the priceless one.
const stub = async () => ({ text: JSON.stringify({ products: [
  { name: 'পাঞ্জাবি', price_taka: 850, description: 'সুতি পাঞ্জাবি' },
  { name: 'টুপি', price_taka: null, description: 'নামাজের টুপি' },
] }) });
const g = await extractProductsFromPosts(
  [{ id: 'g1', message: 'পাঞ্জাবি ৮৫০ টাকা', created_time: '2025-02-01T10:00:00+0000' }, { id: 'g2', message: 'টুপি', created_time: '2025-02-02T10:00:00+0000' }],
  stub,
);
out.gemini = { extraction: g.extraction, products: g.products.map((p) => ({ name: p.name, pricePaisa: p.pricePaisa })) };
// 5. Gemini stub returning nothing usable -> regex fallback still finds products.
const empty = async () => ({ text: '' });
const f = await extractProductsFromPosts([{ id: 'f1', message: 'শার্ট ৳৫০০', created_time: '2025-02-01T10:00:00+0000' }], empty);
out.geminiFallback = { extraction: f.extraction, count: f.products.length, pricePaisa: f.products[0]?.pricePaisa };
// 6. Old-product knowledge body wording.
const body = buildOldProductKnowledgeBody({ name: 'শার্ট', price_paisa: 60000, description: 'কটন শার্ট', photo_url: null, source_post_url: 'https://www.facebook.com/post-shirt-1' });
const bodyNoPrice = buildOldProductKnowledgeBody({ name: 'পাঞ্জাবি', price_paisa: null, description: null, photo_url: null, source_post_url: null });
out.body = { hasOld: body.includes('পুরোনো পণ্য'), hasStockUnsure: body.includes('স্টকে আছে কিনা'), hasNoInvent: body.includes('বানিয়ে'), hasOwner: body.includes('মালিক'), hasPrice: body.includes('৳600') || body.includes('৳৬০০') || body.includes('600') };
out.bodyNoPrice = { saysNoPrice: bodyNoPrice.includes('দাম লেখা ছিল না'), noInvent: bodyNoPrice.includes('বানিয়ে') };
console.log('DRIVER_RESULT ' + JSON.stringify(out));
}
main();
`;

function runDriver() {
  return new Promise((resolve) => {
    const stamp = Date.now();
    const driverPath = `/tmp/page-read-driver-${stamp}.ts`;
    fs.writeFileSync(driverPath, DRIVER_SRC);
    const proc = spawn('npx', ['tsx', driverPath], {
      cwd: path.join(ROOT, 'apps/api'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        USE_PGLITE: 'true',
        PGLITE_DATA_DIR: '.pglite-data-pageread-driver',
        JWT_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        GEMINI_API_KEY: '',
      },
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('close', (code) => {
      try { fs.unlinkSync(driverPath); } catch { /* already gone */ }
      resolve({ code, out, err });
    });
  });
}

async function main() {
  // ---------- Static checks ----------
  const mig41 = fs.readFileSync(path.join(ROOT, 'apps/api/src/db/migrations/41-page-read.sql'), 'utf8');
  check('migration 41: page_read_products table with pending status', mig41.includes('CREATE TABLE IF NOT EXISTS page_read_products') && mig41.includes("status TEXT NOT NULL DEFAULT 'pending'") && mig41.includes('price_paisa INT'));
  check('migration 41: idempotent (IF NOT EXISTS)', mig41.includes('IF NOT EXISTS'));

  const prSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/page-read.ts'), 'utf8');
  check('page-read module: exports fetchPagePosts + extractProductsFromPosts', prSrc.includes('export async function fetchPagePosts') && prSrc.includes('export async function extractProductsFromPosts'));
  check('page-read module: exports regex fallback + old-product body builder', prSrc.includes('export function extractProductsRegex') && prSrc.includes('export function buildOldProductKnowledgeBody'));
  check('page-read module: Graph fields include message/created_time/attachments', prSrc.includes('message,created_time,attachments{media,media_type,url,description}'));
  check('page-read module: honours META_GRAPH_BASE_URL via graphBase()', prSrc.includes('graphBase()') && prSrc.includes("from './meta-oauth'"));
  check('page-read module: auth/scope failure is a distinct error (PageReadAuthError)', prSrc.includes('class PageReadAuthError') && prSrc.includes('190') && prSrc.includes('200'));
  check('page-read module: Bengali reconnect message mentions Channels + Login with Facebook', prSrc.includes('Channels পেজে গিয়ে') && prSrc.includes('Login with Facebook'));
  check('page-read module: Gemini via callGemini (config model, never hardcoded)', prSrc.includes('callGemini') && !prSrc.includes('gemini-3.5-flash-lite'));
  check('page-read module: never invents a price (null when unstated)', prSrc.includes('pricePaisa: priceTaka === null ? null') || prSrc.includes('price_taka') && prSrc.includes('null'));

  const routesSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/knowledge/routes.ts'), 'utf8');
  check('routes: POST /knowledge/page-read exists and is owner-only', routesSrc.includes("post('/knowledge/page-read', requireWorkspaceOwner"));
  check('routes: GET /knowledge/page-read exists and is owner-only', routesSrc.includes("get('/knowledge/page-read', requireWorkspaceOwner"));
  check('routes: confirm + reject + delete exist and are owner-only', routesSrc.includes("post('/knowledge/page-read/:id/confirm', requireWorkspaceOwner") && routesSrc.includes("post('/knowledge/page-read/:id/reject', requireWorkspaceOwner") && routesSrc.includes("delete('/knowledge/page-read/:id', requireWorkspaceOwner"));
  check('routes: loads Page token via getWorkspacePageChannel + decryptPageToken', routesSrc.includes('getWorkspacePageChannel') && routesSrc.includes('decryptPageToken'));
  check('routes: no-Page case returns needsReconnect + stores nothing', routesSrc.includes('needsReconnect: true') && routesSrc.includes('No connected Facebook Page'));
  check('routes: confirm writes knowledge via buildOldProductKnowledgeBody + invalidates prompt cache', routesSrc.includes('buildOldProductKnowledgeBody') && routesSrc.includes('invalidateWorkspacePromptCache'));

  const teachSrc = fs.readFileSync(path.join(ROOT, 'apps/web/app/teach/page.tsx'), 'utf8');
  check('teach page: "পেজ পড়ুন" section with button', teachSrc.includes('পেজ পড়ুন') && teachSrc.includes('doPageRead'));
  check('teach page: pending list with confirm + reject controls', teachSrc.includes('নিশ্চিত করুন') && teachSrc.includes('rejectPageRead'));
  check('teach page: shows the Bengali error when the read fails', teachSrc.includes('pageReadError'));
  check('teach page: price edit shows "দাম ছিল না" when the post had no price', teachSrc.includes('দাম ছিল না'));

  // ---------- Driver: extraction unit tests ----------
  const driver = await runDriver();
  let d = null;
  const line = (driver.out ?? '').split('\n').find((l) => l.startsWith('DRIVER_RESULT '));
  try { d = line ? JSON.parse(line.slice('DRIVER_RESULT '.length)) : null; } catch { d = null; }
  check('driver: ran clean (exit 0 + result line)', driver.code === 0 && !!d, `code=${driver.code} err=${(driver.err ?? '').slice(-400)}`);
  if (d) {
    check('driver: regex extracts name + ৳৬০০ → 60000 paisa', (d.regexShirt?.name ?? '').includes('শার্ট') && d.regexShirt?.pricePaisa === 60000, JSON.stringify(d.regexShirt));
    check('driver: regex handles Bengali digits ৳১২০০ → 120000 paisa', d.regexBengaliDigits?.pricePaisa === 120000, JSON.stringify(d.regexBengaliDigits));
    check('driver: regex invents NO price when the post has none (null)', d.regexNoPrice?.pricePaisa === null, JSON.stringify(d.regexNoPrice));
    check('driver: Gemini stub extracts name/price correctly', d.gemini?.extraction === 'gemini' && d.gemini?.products?.[0]?.pricePaisa === 85000, JSON.stringify(d.gemini));
    check('driver: Gemini stub invents NO price for the priceless product (null)', d.gemini?.products?.[1]?.pricePaisa === null, JSON.stringify(d.gemini));
    check('driver: empty Gemini reply falls back to regex honestly', d.geminiFallback?.extraction === 'regex-fallback' && d.geminiFallback?.count === 1 && d.geminiFallback?.pricePaisa === 50000, JSON.stringify(d.geminiFallback));
    check('driver: old-product body has পুরোনো পণ্য + স্টক-অনিশ্চিত + মালিক wording', d.body?.hasOld && d.body?.hasStockUnsure && d.body?.hasOwner && d.body?.hasNoInvent, JSON.stringify(d.body));
    check('driver: no-price body says the price was not stated, never invents one', d.bodyNoPrice?.saysNoPrice && d.bodyNoPrice?.noInvent, JSON.stringify(d.bodyNoPrice));
  }

  // ---------- Boot: API + stub Graph ----------
  const stamp = Date.now();
  const port = 4023;
  const graphPort = 4024;
  const pageId = '545567875314703';
  const dataDir = '.pglite-data-pageread';
  const stub = await startStubGraph(graphPort, pageId);
  const run = startApi(port, dataDir, { META_GRAPH_BASE_URL: `http://localhost:${graphPort}` });
  process.on('exit', run.stop);
  try {
    const up = await waitForHealth(`http://localhost:${port}`);
    check('boot: API starts', up, up ? '' : run.log().slice(-500));
    if (!up) return;
    const api = makeApi(`http://localhost:${port}`, () => token);
    const signup = await api('/api/auth/signup', {
      method: 'POST', auth: false,
      body: { name: 'PageRead Owner', email: `pageread+${stamp}@example.com`, password: 'verify1234', workspaceName: 'PageRead Test Shop' },
    });
    check('boot: signup', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
    token = signup.data?.token ?? '';

    // (a) Owner-only: invite a member, have them accept, then try the read.
    const memberEmail = `pageread-member+${stamp}@example.com`;
    const invite = await api('/api/team/invites', { method: 'POST', body: { email: memberEmail, role: 'member' } });
    check('boot: owner creates a member invite', invite.status === 201 && !!invite.data?.invite?.token, `status=${invite.status}`);
    const inviteToken = invite.data?.invite?.token ?? '';
    const accept = await api('/api/auth/accept-invite', {
      method: 'POST', auth: false,
      body: { token: inviteToken, name: 'PageRead Member', password: 'verify1234' },
    });
    check('boot: member accepts the invite', accept.status === 201 && !!accept.data?.token, `status=${accept.status}`);
    memberToken = accept.data?.token ?? '';
    const memberApi = makeApi(`http://localhost:${port}`, () => memberToken);
    const memberRead = await memberApi('/api/knowledge/page-read', { method: 'POST', body: {} });
    check('(a) member → 403 on POST page-read', memberRead.status === 403, `status=${memberRead.status}`);
    const memberList = await memberApi('/api/knowledge/page-read');
    check('(a) member → 403 on GET page-read list', memberList.status === 403, `status=${memberList.status}`);

    // (b) No connected Page → honest Bengali reconnect message, nothing stored.
    const noPage = await api('/api/knowledge/page-read', { method: 'POST', body: {} });
    check('(b) no Page → honest Bengali reconnect message', noPage.status === 400 && (noPage.data?.errorBn ?? '').includes('আবার সংযুক্ত') && noPage.data?.needsReconnect === true, `status=${noPage.status} ${JSON.stringify(noPage.data ?? {}).slice(0, 200)}`);
    const emptyList = await api('/api/knowledge/page-read');
    check('(b) nothing stored when there is no Page (pending list empty)', emptyList.status === 200 && (emptyList.data?.items ?? []).length === 0, `status=${emptyList.status} count=${(emptyList.data?.items ?? []).length}`);

    // (d) Connect the Page (stored token) and read via the stub Graph.
    const ch = await api('/api/channels', { method: 'POST', body: { platform: 'messenger', externalId: pageId, displayName: 'Halal Chic', token: 'fake-page-token-for-test' } });
    check('(d) messenger channel connects (token stored encrypted)', ch.status === 201, `status=${ch.status} ${JSON.stringify(ch.data ?? {}).slice(0, 150)}`);
    const read = await api('/api/knowledge/page-read', { method: 'POST', body: {} });
    check('(d) read → 2 posts scanned, 2 products found', read.status === 200 && read.data?.postsScanned === 2 && read.data?.productsFound === 2, `status=${read.status} ${JSON.stringify(read.data ?? {}).slice(0, 250)}`);
    check('(d) read used the regex fallback honestly (no Gemini key in test)', read.data?.extraction === 'regex-fallback', `extraction=${read.data?.extraction ?? '?'}`);
    check('(d) stub Graph saw a Bearer token (server-side token use)', stub.sawAuthHeader(), 'no Authorization header reached the stub Graph');
    const list = await api('/api/knowledge/page-read');
    const items = list.data?.items ?? [];
    check('(d) pending list holds 2 items', list.status === 200 && items.length === 2, `count=${items.length}`);
    const shirt = items.find((i) => (i.name ?? '').includes('শার্ট'));
    const panjabi = items.find((i) => (i.name ?? '').includes('পাঞ্জাবি'));
    check('(d) shirt extracted with price ৳৬০০ → 60000 paisa', !!shirt && shirt.price_paisa === 60000, JSON.stringify(shirt ?? null));
    check('(d) priceless post stored with price_paisa null (no invented price)', !!panjabi && panjabi.price_paisa === null, JSON.stringify(panjabi ?? null));
    check('(d) both items carry a photo URL from the post attachments', items.every((i) => !!i.photo_url), JSON.stringify(items.map((i) => i.photo_url)));

    // Re-read: dedup — nothing new is inserted.
    const reRead = await api('/api/knowledge/page-read', { method: 'POST', body: {} });
    check('(d) re-read inserts 0 duplicates', reRead.status === 200 && reRead.data?.inserted === 0 && reRead.data?.skipped === 2, `inserted=${reRead.data?.inserted} skipped=${reRead.data?.skipped}`);

    // Confirm the shirt with an edited price (৳650) → live knowledge item.
    const confirm = await api(`/api/knowledge/page-read/${shirt.id}/confirm`, {
      method: 'POST', body: { name: shirt.name, pricePaisa: 65000, description: shirt.description, photoUrl: shirt.photo_url },
    });
    check('(d) confirm → 200 with a knowledge item', confirm.status === 200 && !!confirm.data?.knowledgeItem?.id, `status=${confirm.status} ${JSON.stringify(confirm.data ?? {}).slice(0, 200)}`);
    const kb = await api('/api/knowledge');
    const live = (kb.data?.knowledgeItems ?? []).find((k) => k.id === confirm.data?.knowledgeItem?.id);
    check('(e) confirmed item is live in the knowledge book', !!live, `knowledge count=${(kb.data?.knowledgeItems ?? []).length}`);
    check('(e) live body says পুরোনো পণ্য', !!live && (live.body ?? '').includes('পুরোনো পণ্য'), (live?.body ?? '').slice(0, 120));
    check('(e) live body says stock is unsure + send to the owner', !!live && (live.body ?? '').includes('স্টকে আছে কিনা') && (live.body ?? '').includes('মালিক'), (live?.body ?? '').slice(0, 200));
    check('(e) live body never claims the old product is in stock', !!live && !(live.body ?? '').includes('স্টকে আছে।') && !(live.body ?? '').includes('স্টকে আছে,'), (live?.body ?? '').slice(0, 200));
    check('(e) live body carries the owner-edited price ৳650', !!live && (live.body ?? '').includes('650'), (live?.body ?? '').slice(0, 200));
    const confirmAgain = await api(`/api/knowledge/page-read/${shirt.id}/confirm`, { method: 'POST', body: {} });
    check('(d) confirming twice is refused (400)', confirmAgain.status === 400, `status=${confirmAgain.status}`);

    // Reject the panjabi → pending list is empty.
    const reject = await api(`/api/knowledge/page-read/${panjabi.id}/reject`, { method: 'POST', body: {} });
    check('(d) reject → 200', reject.status === 200 && reject.data?.rejected === true, `status=${reject.status}`);
    const afterReject = await api('/api/knowledge/page-read');
    check('(d) pending list empty after confirm + reject', (afterReject.data?.items ?? []).length === 0, `count=${(afterReject.data?.items ?? []).length}`);
    const confirmedList = await api('/api/knowledge/page-read?status=confirmed');
    check('(d) confirmed list holds the shirt', (confirmedList.data?.items ?? []).length === 1, `count=${(confirmedList.data?.items ?? []).length}`);
  } finally {
    run.stop();
    stub.server.close();
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
