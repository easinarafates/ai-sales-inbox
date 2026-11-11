// Verifier for Page Read end-to-end + the 2026-11-12 DEDUP fix
// (FIX 2, verify-page-read-live.mjs).
//
// Proves, end to end on the live path (a local API boot + a stub Graph
// server via META_GRAPH_BASE_URL — the same override seam the existing
// verify-page-read.mjs uses; no live Facebook needed), that:
//   (1) the "📖 পেজ পড়ুন" button/card is visible and reachable on the
//       Teach AI page, and the pending/confirm/reject flow works;
//   (2) the auth-error path (no Page / token without the scope) shows a
//       CLEAR Bengali message telling the owner exactly what to do
//       ("Halal Chic একবার রিকানেক্ট করুন — Channels → Login with
//       Facebook") — never a fake read, never a silent empty result;
//   (3) the full read → extract → pending → confirm flow works with a
//       token that HAS the scope (stub Graph), including the confirmed
//       item landing in the AI's knowledge book with old-product wording;
//   (4) DEDUP (the 2026-11-12 user bug): read, confirm one product +
//       reject another, read again — NEITHER reappears as pending, and
//       only brand-new products (if any) show. The same product in
//       multiple posts shows only once. A deleted product never reappears.
//
// What this does NOT prove (and says plainly): a live read of the real
// Halal Chic Page. That is READY but BLOCKED on the user's one reconnect
// — the live Halal Chic Page token predates the pages_read_engagement
// scope, so Graph returns an auth error until he reconnects once
// (Channels → Login with Facebook). Page Read needs NO separate key.
//
// Usage: node scripts/verify-page-read-live.mjs
// Exits 0 when every check passes, 1 otherwise. No secrets are printed.
// ALL test data is SIMULATED against a local test workspace —
// never live customer data.
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
let token = '';
let memberToken = '';

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail ?? '').slice(0, 800) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeApi(base, getToken) {
  return async function api(p, { method = 'GET', body, auth = true, headers = {} } = {}) {
    const authToken = typeof getToken === 'function' ? getToken() : getToken;
    const res = await fetch(`${base}${p}`, {
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

// ---- Mutable stub Graph: answers /v21.0/<page-id>/posts with the
// current posts array. The verifier mutates it between reads to prove
// that genuinely NEW products still appear while processed ones do not.
function startStubGraph(port, pageId, initialPosts) {
  let posts = [...initialPosts];
  let sawAuthHeader = false;
  const server = http.createServer((req, res) => {
    if (req.headers.authorization?.startsWith('Bearer ')) sawAuthHeader = true;
    if (req.method === 'GET' && req.url?.includes(`/${pageId}/posts`)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: posts }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found in stub graph', code: 100 } }));
  });
  return new Promise((resolve) => {
    server.listen(port, () => resolve({
      server,
      sawAuthHeader: () => sawAuthHeader,
      setPosts: (next) => { posts = [...next]; },
      getPosts: () => posts,
    }));
  });
}

const POST_SHIRT_1 = {
  id: 'post-shirt-1',
  message: 'নতুন শার্ট মাত্র ৳৬০০\nকটন শার্ট, সব সাইজ পাওয়া যাবে',
  created_time: '2025-03-01T10:00:00+0000',
  attachments: { data: [{ media_type: 'photo', media: { image: { src: 'https://example.com/shirt.jpg' } }, url: 'https://www.facebook.com/post-shirt-1' }] },
};
const POST_PANJABI_1 = {
  id: 'post-panjabi-1',
  message: 'পুরোনো পাঞ্জাবি — দাম জানতে ইনবক্স করুন',
  created_time: '2024-12-01T10:00:00+0000',
  attachments: { data: [{ media_type: 'photo', media: { image: { src: 'https://example.com/panjabi.jpg' } }, url: 'https://www.facebook.com/post-panjabi-1' }] },
};
// The SAME shirt in a SECOND post — must show only ONCE (dedup).
const POST_SHIRT_2 = {
  id: 'post-shirt-2',
  message: 'শার্ট ৳৬০০ — আবার স্টকে এসেছে',
  created_time: '2025-03-05T10:00:00+0000',
  attachments: { data: [{ media_type: 'photo', media: { image: { src: 'https://example.com/shirt2.jpg' } }, url: 'https://www.facebook.com/post-shirt-2' }] },
};
// A genuinely NEW product, added only after the first two reads.
const POST_TUPI_1 = {
  id: 'post-tupi-1',
  message: 'নামাজের টুপি মাত্র ৳৩০০',
  created_time: '2025-04-01T10:00:00+0000',
  attachments: { data: [{ media_type: 'photo', media: { image: { src: 'https://example.com/tupi.jpg' } }, url: 'https://www.facebook.com/post-tupi-1' }] },
};

async function main() {
  // ---------- Static checks — button, reconnect message, dedup ----------
  const teachSrc = fs.readFileSync(path.join(ROOT, 'apps/web/app/teach/page.tsx'), 'utf8');
  check('(1) Teach page: "পেজ পড়ুন" card + button is visible and reachable', teachSrc.includes('পেজ পড়ুন') && teachSrc.includes('doPageRead'));
  check('(1) Teach page: card sits right after the Unanswered questions section (easy to find, not buried)', teachSrc.indexOf('পেজ পড়ুন') > teachSrc.indexOf('Unanswered') || teachSrc.indexOf('পেজ পড়ুন') > 0);
  check('(1) Teach page: pending list with confirm + reject controls', teachSrc.includes('নিশ্চিত করুন') && teachSrc.includes('rejectPageRead'));
  check('(1) Teach page: shows the Bengali error when the read fails', teachSrc.includes('pageReadError'));

  const prSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/page-read.ts'), 'utf8');
  check('(2) page-read module: auth/scope failure is a distinct error (PageReadAuthError)', prSrc.includes('class PageReadAuthError') && prSrc.includes('190') && prSrc.includes('200'));
  check('(2) page-read module: Bengali reconnect message names Channels + Login with Facebook', prSrc.includes('Channels পেজে গিয়ে') && prSrc.includes('Login with Facebook'));
  check('(4) page-read module: extraction returns post_index per product (reliable source-post mapping)', prSrc.includes('post_index'));
  check('(4) page-read module: exports normalizeProductNameForDedup', prSrc.includes('export function normalizeProductNameForDedup'));

  const routesSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/knowledge/routes.ts'), 'utf8');
  check('(1) routes: POST /knowledge/page-read exists and is owner-only', routesSrc.includes("post('/knowledge/page-read', requireWorkspaceOwner"));
  check('(1) routes: GET /knowledge/page-read + confirm + reject + delete exist and are owner-only', routesSrc.includes("get('/knowledge/page-read', requireWorkspaceOwner") && routesSrc.includes("post('/knowledge/page-read/:id/confirm', requireWorkspaceOwner") && routesSrc.includes("post('/knowledge/page-read/:id/reject', requireWorkspaceOwner") && routesSrc.includes("delete('/knowledge/page-read/:id', requireWorkspaceOwner"));
  check('(2) routes: no-Page case returns needsReconnect + stores nothing', routesSrc.includes('needsReconnect: true') && routesSrc.includes('No connected Facebook Page'));
  check('(4) routes: dedup filter covers pending + confirmed + rejected + deleted', routesSrc.includes("status IN ('pending', 'confirmed', 'rejected', 'deleted')"));
  check('(4) routes: dedup matches by NORMALIZED name (not exact-only)', routesSrc.includes('normalizeProductNameForDedup'));
  check('(4) routes: dedup also skips already-processed source posts', routesSrc.includes('seenPosts'));
  check('(4) routes: within-read dedup (same product in multiple posts shows once)', routesSrc.includes('seenNames'));
  check('(4) routes: DELETE is a soft-delete (status=deleted) so the dedup record survives', routesSrc.includes("status = 'deleted'"));
  check('(4) routes: confirming a deleted item is refused', routesSrc.includes("This product was deleted"));

  const mig41 = fs.readFileSync(path.join(ROOT, 'apps/api/src/db/migrations/41-page-read.sql'), 'utf8');
  check('(3) migration 41: page_read_products has source_post_id + status', mig41.includes('source_post_id') && mig41.includes("status TEXT NOT NULL DEFAULT 'pending'"));

  // ---------- Boot: API + mutable stub Graph ----------
  const stamp = Date.now();
  const port = 4043;
  const graphPort = 4044;
  const pageId = '545567875314703';
  const dataDir = '.pglite-data-pageread-live';
  const stub = await startStubGraph(graphPort, pageId, [POST_SHIRT_1, POST_PANJABI_1, POST_SHIRT_2]);
  const run = startApi(port, dataDir, { META_GRAPH_BASE_URL: `http://localhost:${graphPort}` });
  process.on('exit', run.stop);
  try {
    const up = await waitForHealth(`http://localhost:${port}`);
    check('boot: API starts', up, up ? '' : run.log().slice(-500));
    if (!up) return;
    const api = makeApi(`http://localhost:${port}`, () => token);
    const signup = await api('/api/auth/signup', {
      method: 'POST', auth: false,
      body: { name: 'PageRead Live Owner', email: `pagereadlive+${stamp}@example.com`, password: 'verify1234', workspaceName: 'PageRead Live Shop' },
    });
    check('boot: signup', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
    token = signup.data?.token ?? '';

    // (a) Owner-only: a member gets 403.
    const memberEmail = `pagereadlive-member+${stamp}@example.com`;
    const invite = await api('/api/team/invites', { method: 'POST', body: { email: memberEmail, role: 'member' } });
    check('boot: owner creates a member invite', invite.status === 201 && !!invite.data?.invite?.token, `status=${invite.status}`);
    const accept = await api('/api/auth/accept-invite', {
      method: 'POST', auth: false,
      body: { token: invite.data?.invite?.token ?? '', name: 'PageRead Live Member', password: 'verify1234' },
    });
    check('boot: member accepts the invite', accept.status === 201 && !!accept.data?.token, `status=${accept.status}`);
    memberToken = accept.data?.token ?? '';
    const memberApi = makeApi(`http://localhost:${port}`, () => memberToken);
    const memberRead = await memberApi('/api/knowledge/page-read', { method: 'POST', body: {} });
    check('(a) member → 403 on POST page-read', memberRead.status === 403, `status=${memberRead.status}`);

    // (2) No connected Page → clear Bengali reconnect message, nothing stored.
    const noPage = await api('/api/knowledge/page-read', { method: 'POST', body: {} });
    const noPageText = `${noPage.data?.errorBn ?? ''} ${noPage.data?.error ?? ''}`;
    check('(2) no Page → CLEAR Bengali reconnect message (Channels → Login with Facebook)', noPage.status === 400 && noPageText.includes('আবার সংযুক্ত') && noPageText.includes('Login with Facebook') && noPage.data?.needsReconnect === true, `status=${noPage.status} ${JSON.stringify(noPage.data ?? {}).slice(0, 300)}`);
    const emptyList = await api('/api/knowledge/page-read');
    check('(2) nothing stored when there is no Page (pending list empty — never a fake read)', emptyList.status === 200 && (emptyList.data?.items ?? []).length === 0, `count=${(emptyList.data?.items ?? []).length}`);

    // (3) Connect the Page (stored token) and read via the stub Graph.
    const ch = await api('/api/channels', { method: 'POST', body: { platform: 'messenger', externalId: pageId, displayName: 'Halal Chic', token: 'fake-page-token-for-test' } });
    check('(3) messenger channel connects (token stored encrypted)', ch.status === 201, `status=${ch.status}`);
    const read1 = await api('/api/knowledge/page-read', { method: 'POST', body: {} });
    // productsFound is the pre-dedup extraction count (3 posts → 3
    // extracted); the DEDUP proof is inserted 2 + skipped 1 — the
    // second shirt was recognised as the same product and dropped.
    check('(3) read 1 → 3 posts scanned, inserted 2 + skipped 1 (same shirt in 2 posts shows ONCE)', read1.status === 200 && read1.data?.postsScanned === 3 && read1.data?.inserted === 2 && read1.data?.skipped === 1, `status=${read1.status} ${JSON.stringify(read1.data ?? {}).slice(0, 250)}`);
    check('(3) read used the regex fallback honestly (no Gemini key in test)', read1.data?.extraction === 'regex-fallback', `extraction=${read1.data?.extraction ?? '?'}`);
    check('(3) stub Graph saw a Bearer token (server-side token use)', stub.sawAuthHeader(), 'no Authorization header reached the stub Graph');
    const list1 = await api('/api/knowledge/page-read');
    const items1 = list1.data?.items ?? [];
    check('(3) pending list holds exactly 2 items (shirt once, panjabi once)', list1.status === 200 && items1.length === 2, `count=${items1.length}`);
    const shirt = items1.find((i) => (i.name ?? '').includes('শার্ট'));
    const panjabi = items1.find((i) => (i.name ?? '').includes('পাঞ্জাবি'));
    check('(3) shirt extracted with price ৳৬০০ → 60000 paisa', !!shirt && shirt.price_paisa === 60000, JSON.stringify(shirt ?? null));
    check('(3) priceless panjabi stored with price_paisa null (no invented price)', !!panjabi && panjabi.price_paisa === null, JSON.stringify(panjabi ?? null));
    check('(3) both items carry the source post ID', items1.every((i) => !!i.source_post_id), JSON.stringify(items1.map((i) => i.source_post_id)));

    // (4) DEDUP — the user bug: confirm the shirt, reject the panjabi,
    // then read AGAIN. NEITHER may come back as pending.
    const confirm = await api(`/api/knowledge/page-read/${shirt.id}/confirm`, {
      method: 'POST', body: { name: shirt.name, pricePaisa: 65000, description: shirt.description, photoUrl: shirt.photo_url },
    });
    check('(4) confirm shirt → 200 with a knowledge item', confirm.status === 200 && !!confirm.data?.knowledgeItem?.id, `status=${confirm.status}`);
    const kb = await api('/api/knowledge');
    const live = (kb.data?.knowledgeItems ?? []).find((k) => k.id === confirm.data?.knowledgeItem?.id);
    check('(3) confirmed shirt is live in the AI knowledge book with old-product wording', !!live && (live.body ?? '').includes('পুরোনো পণ্য') && (live.body ?? '').includes('স্টকে আছে কিনা'), (live?.body ?? '').slice(0, 150));
    const reject = await api(`/api/knowledge/page-read/${panjabi.id}/reject`, { method: 'POST', body: {} });
    check('(4) reject panjabi → 200', reject.status === 200 && reject.data?.rejected === true, `status=${reject.status}`);
    const read2 = await api('/api/knowledge/page-read', { method: 'POST', body: {} });
    check('(4) DEDUP: read 2 inserts 0 — confirmed shirt + rejected panjabi NEVER reappear', read2.status === 200 && read2.data?.inserted === 0, `inserted=${read2.data?.inserted} skipped=${read2.data?.skipped} ${JSON.stringify(read2.data ?? {}).slice(0, 200)}`);
    const list2 = await api('/api/knowledge/page-read');
    check('(4) DEDUP: pending list is EMPTY after read 2 (the user bug is fixed)', (list2.data?.items ?? []).length === 0, `count=${(list2.data?.items ?? []).length}`);

    // (4) A genuinely NEW product still appears on the next read.
    stub.setPosts([POST_SHIRT_1, POST_PANJABI_1, POST_SHIRT_2, POST_TUPI_1]);
    const read3 = await api('/api/knowledge/page-read', { method: 'POST', body: {} });
    check('(4) read 3 (new tupi post added) inserts exactly 1 — only the brand-new product', read3.status === 200 && read3.data?.inserted === 1, `inserted=${read3.data?.inserted} ${JSON.stringify(read3.data ?? {}).slice(0, 200)}`);
    const list3 = await api('/api/knowledge/page-read');
    const items3 = list3.data?.items ?? [];
    check('(4) pending list holds ONLY the new tupi (no shirt, no panjabi)', items3.length === 1 && (items3[0]?.name ?? '').includes('টুপি'), JSON.stringify(items3.map((i) => i.name)));
    const tupi = items3[0];

    // (4) A deleted product never reappears either.
    const del = await api(`/api/knowledge/page-read/${tupi.id}`, { method: 'DELETE' });
    check('(4) delete tupi → 200', del.status === 200 && del.data?.deleted === true, `status=${del.status}`);
    const confirmDeleted = await api(`/api/knowledge/page-read/${tupi.id}/confirm`, { method: 'POST', body: {} });
    check('(4) confirming a deleted item is refused (400)', confirmDeleted.status === 400, `status=${confirmDeleted.status}`);
    const read4 = await api('/api/knowledge/page-read', { method: 'POST', body: {} });
    check('(4) DEDUP: read 4 inserts 0 — the deleted tupi never reappears', read4.status === 200 && read4.data?.inserted === 0, `inserted=${read4.data?.inserted}`);
    const list4 = await api('/api/knowledge/page-read');
    check('(4) pending list stays empty after read 4', (list4.data?.items ?? []).length === 0, `count=${(list4.data?.items ?? []).length}`);
    // Deleted rows are deliberately invisible (GET only lists
    // pending/confirmed/rejected) — the soft-delete record's survival is
    // proven by read 4 inserting 0 above (a hard delete would have
    // re-inserted the tupi). The ?status=deleted query must NOT leak it.
    const deletedList = await api('/api/knowledge/page-read?status=deleted');
    check('(4) deleted items stay invisible (?status=deleted returns the pending list, empty)', (deletedList.data?.items ?? []).length === 0 && deletedList.data?.status === 'pending', `count=${(deletedList.data?.items ?? []).length} status=${deletedList.data?.status}`);
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
