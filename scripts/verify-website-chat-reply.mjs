#!/usr/bin/env node
/**
 * Verification for the website-chat AI reply fix (2026-11-11).
 * Local, real Gemini key, local PGlite API (scratch dir).
 *
 * Exercises the PUBLIC visitor path only — no webhook secret, no owner
 * login beyond the shop setup:
 *  1. signup -> product শাড়ি ৳1500 -> go-live (practice off)
 *  2. GET /api/website-chat/settings -> public key
 *  3. GET /api/website-chat/widget.js?key=... -> valid JS, contains the
 *     messages poll
 *  4. POST /api/website-chat/message {workspaceKey, text} -> 201 +
 *     conversationId; then poll GET /api/website-chat/messages
 *     (the visitor path) until an 'out' reply appears quoting ৳1500
 *  5. PATCH price to ৳1750, ask again via the same public route ->
 *     reply quotes ৳1750, never ৳1500 (cache invalidation intact)
 *  6. Cross-workspace guard: the poll endpoint with a bogus key / a
 *     conversation from another workspace returns 404
 *  7. Ledger peek (after API stops): Gemini rows with cached_input_tokens
 *
 * Run from the repo root:  node scripts/verify-website-chat-reply.mjs
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
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
  return async function api(pathName, { method = 'GET', body, auth = true, headers = {} } = {}) {
    const res = await fetch(`${base}${pathName}`, {
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

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const got = await fn();
    if (got) return got;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

function startApi(port, dataDir, extraEnv = {}) {
  const apiProc = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: path.join(ROOT, 'apps/api'),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env, PORT: String(port), DATABASE_URL: `pglite://./${dataDir}`, ...extraEnv },
  });
  let apiLog = '';
  apiProc.stdout.on('data', (d) => { apiLog += d.toString(); });
  apiProc.stderr.on('data', (d) => { apiLog += d.toString(); });
  const stop = () => {
    try { process.kill(-apiProc.pid, 'SIGTERM'); } catch { try { apiProc.kill('SIGTERM'); } catch { /* already gone */ } }
  };
  return { proc: apiProc, stop, log: () => apiLog };
}

async function main() {
  const stamp = Date.now();
  const port = 4007;
  const api = makeApi(`http://localhost:${port}`);
  const run = startApi(port, '.pglite-data-webchatverify');
  process.on('exit', run.stop);
  let publicKey = '';
  let conversationId = '';
  let productId = '';
  try {
    const up = await waitForHealth(`http://localhost:${port}`);
    check('local API starts (health)', up, up ? '' : run.log().slice(-500));
    if (!up) return;

    const signup = await api('/api/auth/signup', {
      method: 'POST', auth: false,
      body: { name: 'Webchat Owner', email: `webchatverify+${stamp}@example.com`, password: 'verify1234', workspaceName: 'Webchat Shop' },
    });
    check('signup', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
    token = signup.data?.token ?? '';
    workspaceId = signup.data?.workspace?.id ?? '';

    const product = await api('/api/products', {
      method: 'POST',
      body: { name: 'শাড়ি', pricePaisa: 150000, stock: 5, description: 'সুতির শাড়ি' },
    });
    check('create product শাড়ি ৳1500', product.status === 201 && !!product.data?.product?.id, `status=${product.status}`);
    productId = product.data?.product?.id ?? '';

    const live = await api(`/api/workspaces/${workspaceId}/go-live`, { method: 'POST' });
    check('go-live (practice mode off)', live.status === 200 && live.data?.workspace?.practice_mode === false, `status=${live.status}`);

    const settings = await api('/api/website-chat/settings');
    publicKey = settings.data?.publicKey ?? '';
    check('website-chat settings returns public key', settings.status === 200 && publicKey.startsWith('wk_'), `status=${settings.status}`);

    // Widget JS must be valid JS and contain the reply poll.
    const widget = await api(`/api/website-chat/widget.js?key=${encodeURIComponent(publicKey)}`, { auth: false });
    const widgetPath = path.join(ROOT, '.pglite-data-webchatverify-widget.js');
    fs.writeFileSync(widgetPath, widget.text ?? '');
    const syntax = spawnSync('node', ['--check', widgetPath], { encoding: 'utf8' });
    check('widget.js is valid JavaScript', syntax.status === 0, syntax.stderr?.slice(0, 200) ?? '');
    check('widget.js polls /website-chat/messages for replies',
      (widget.text ?? '').includes('/api/website-chat/messages') && (widget.text ?? '').includes('setInterval'),
      'poll + interval present');
    fs.unlinkSync(widgetPath);

    async function pollVisitorReplies(convId) {
      const r = await api(`/api/website-chat/messages?key=${encodeURIComponent(publicKey)}&conversationId=${encodeURIComponent(convId)}`, { auth: false });
      if (r.status !== 200) return null;
      return (r.data?.messages ?? []).filter((m) => m.direction === 'out');
    }

    async function sendViaPublicRoute(n, text, expectPrice) {
      const posted = await api('/api/website-chat/message', {
        method: 'POST', auth: false,
        body: { workspaceKey: publicKey, text },
      });
      check(`public POST /website-chat/message ${n} accepted (201)`, posted.status === 201 && !!posted.data?.conversationId,
        `status=${posted.status} ${JSON.stringify(posted.data ?? {}).slice(0, 200)}`);
      if (posted.status !== 201) return null;
      if (!conversationId) conversationId = posted.data.conversationId;
      check(`public message ${n} reuses the same conversation`, posted.data.conversationId === conversationId,
        `conv=${posted.data.conversationId}`);
      const replies = await waitFor(async () => {
        const out = await pollVisitorReplies(conversationId);
        return out && out.length >= n ? out : null;
      }, 120000, `visitor-visible AI reply ${n}`).catch((e) => {
        check(`visitor-visible AI reply ${n} arrives via poll endpoint`, false, e.message);
        return null;
      });
      if (!replies) return null;
      const body = replies[replies.length - 1]?.body ?? '';
      const hasPrice = expectPrice === 1500 ? /1,?500|১,?৫০০/.test(body) : /1,?750|১,?৭৫০/.test(body);
      check(`visitor-visible AI reply ${n} quotes the DB price (৳${expectPrice})`, hasPrice, `reply=${body.slice(0, 200)}`);
      // The same reply must also be visible in the Inbox (owner side).
      const detail = await api(`/api/inbox/${conversationId}`);
      const inboxOut = (detail.data?.messages ?? []).filter((m) => m.direction === 'out');
      check(`AI reply ${n} is also in the Inbox`, inboxOut.length >= n, `inbox out=${inboxOut.length}`);
      return body;
    }

    await sendViaPublicRoute(1, 'শাড়ির দাম কত?', 1500);

    // Cross-workspace guard on the poll endpoint.
    const badKey = await api(`/api/website-chat/messages?key=wk_bogus&conversationId=${encodeURIComponent(conversationId)}`, { auth: false });
    check('poll with bogus key returns 404', badKey.status === 404, `status=${badKey.status}`);
    const badConv = await api(`/api/website-chat/messages?key=${encodeURIComponent(publicKey)}&conversationId=00000000-0000-0000-0000-000000000000`, { auth: false });
    check('poll with foreign conversation id returns 404', badConv.status === 404, `status=${badConv.status}`);

    // Cache invalidation intact: change the price, ask again.
    const patched = await api(`/api/products/${productId}`, { method: 'PATCH', body: { pricePaisa: 175000 } });
    check('PATCH product price to ৳1750', patched.status === 200 && patched.data?.product?.price_paisa === 175000, `status=${patched.status}`);
    const reply2 = await sendViaPublicRoute(2, 'শাড়ির দাম কত?', 1750);
    if (reply2) {
      check('reply after price change never quotes the old ৳1500 as the price', !/1,?500|১,?৫০০/.test(reply2), `reply=${reply2.slice(0, 200)}`);
    }

    const log = run.log();
    const cacheLines = log.split('\n').filter((l) => l.includes('[ai-cache] ws='));
    console.log(`--- [ai-cache] lines (${cacheLines.length}) ---`);
    for (const l of cacheLines) console.log(l);
    check('[ai-cache] log line per Gemini reply', cacheLines.length >= 2, `found ${cacheLines.length}`);
    console.log(`--- conversationId=${conversationId} workspaceId=${workspaceId} ---`);
  } finally {
    run.stop();
    await sleep(1500);
  }

  // Ledger peek (API stopped — PGlite single-process).
  const peek = spawnSync('node', ['scripts/peek-cache-ledger.mjs', '.pglite-data-webchatverify', workspaceId], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000,
  });
  let peekOut = null;
  try {
    peekOut = JSON.parse((peek.stdout || '').trim().split('\n').filter(Boolean).pop());
  } catch { /* fall through */ }
  if (!peekOut) {
    check('ledger peek runs', false, `stdout=${(peek.stdout || '').slice(-300)} stderr=${(peek.stderr || '').slice(-300)}`);
  } else {
    console.log('--- ledger rows (latest first) ---');
    for (const r of peekOut.rows ?? []) console.log(JSON.stringify(r));
    check('ledger has >= 2 Gemini rows for the workspace', (peekOut.rows ?? []).length >= 2, `rows=${(peekOut.rows ?? []).length}`);
    const allGemini = (peekOut.rows ?? []).every((r) => r.provider === 'gemini');
    check('all ledger rows are provider=gemini (real Gemini, not demo/groq)', allGemini);
    const allHaveCachedCol = (peekOut.rows ?? []).every((r) => typeof r.cached_input_tokens === 'number');
    check('every row has cached_input_tokens populated (0 is fine on free tier)', allHaveCachedCol);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error('verifier crashed:', err);
  process.exit(1);
});
