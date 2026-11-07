#!/usr/bin/env node
/**
 * Verification for the AI anti-hallucination guard (area 1, overnight fix).
 * Local, no Docker, no money spent (Groq free tier).
 *
 * The user's #1 complaint: a customer asked "Product price" and the shop
 * had NO products — the AI must never invent a price. It must say plainly
 * (in Bengali) that no products are added yet and ask which product the
 * customer means.
 *
 * Coverage:
 *  A. Unit: guardReplyAgainstHallucination / extractPriceAmounts, imported
 *     from the real agent.ts — invented price + empty catalog → replaced
 *     with EMPTY_CATALOG_REPLY; real catalog price → kept; invented price
 *     + real catalog → replaced with the real price list.
 *  B. E2E (live Groq, stub Graph, local PGlite API, practice mode OFF):
 *     webhook "Product price" with ZERO products → outgoing reply is
 *     delivered (delivery_status='sent', stub message_id), contains NO
 *     currency amount at all, is in Bengali, and says no products are
 *     added yet; a ledger row is written (provider groq, 0 paisa).
 *  C. E2E with one real product (শাড়ি ৳1500): "শাড়ির দাম কত?" → the
 *     reply's only currency amount is 1500 (no invented price).
 *
 * Run from the repo root:  node scripts/verify-ai-empty-catalog.mjs
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 */
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
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
  return async function api(path, { method = 'GET', body, auth = true } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
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

/** Currency-marked amounts in a reply (same shapes the guard checks). */
function replyAmounts(text) {
  const out = [];
  const bn = (s) => s.replace(/[০-৯]/g, (d) => String('০১২৩৪৫৬৭৮৯'.indexOf(d)));
  for (const re of [/৳\s*([০-৯0-9][০-৯0-9,]*\.?[০-৯0-9]*)/g, /([০-৯0-9][০-৯0-9,]*\.?[০-৯0-9]*)\s*টাকা/g, /(?:price|দাম)[^০-৯0-9\n]{0,25}([০-৯0-9][০-৯0-9,]*\.?[০-৯0-9]*)/gi]) {
    for (const m of text.matchAll(re)) {
      const n = Number(bn(m[1]).replace(/,/g, ''));
      if (Number.isFinite(n) && n > 0) out.push(n);
    }
  }
  return out;
}

async function main() {
  // ---------- A. Unit: the guard itself (real code, no HTTP) ----------
  const unitScript = `
    import { guardReplyAgainstHallucination, extractPriceAmounts, EMPTY_CATALOG_REPLY } from './src/ai-agent/agent.ts';
    const emptyCtx = { customerName: null, customerPhone: null, history: [], openOrders: [], knowledge: [], products: [], messages: ['Product price'] };
    const oneCtx = { ...emptyCtx, products: [{ id: 'p1', name: 'শাড়ি', pricePaisa: 150000, stock: 5 }] };
    const r1 = guardReplyAgainstHallucination('শাড়ির দাম ৳১৫০০ টাকা।', emptyCtx);
    const r2 = guardReplyAgainstHallucination('শাড়ির দাম ৳১৫০০ টাকা।', oneCtx);
    const r3 = guardReplyAgainstHallucination('দাম ৳৯৯৯ মাত্র!', oneCtx);
    const r4 = guardReplyAgainstHallucination('আসসালামু আলাইকুম, কেমন আছেন?', emptyCtx);
    console.log(JSON.stringify({
      r1replaced: r1.replaced, r1reply: r1.reply, r1isEmptyReply: r1.reply === EMPTY_CATALOG_REPLY,
      r2replaced: r2.replaced, r3replaced: r3.replaced, r3reply: r3.reply,
      r4replaced: r4.replaced,
      amtBn: extractPriceAmounts('দাম ৳১,৫০০'), amtEn: extractPriceAmounts('price 999 taka'),
    }));
  `;
  const unit = spawnSync('npx', ['tsx', '-e', unitScript], {
    cwd: path.join(ROOT, 'apps/api'),
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: 'pglite://./.pglite-data-emptycat-unit' },
    timeout: 120000,
  });
  let unitOut = null;
  try {
    const lastLine = (unit.stdout || '').trim().split('\n').filter(Boolean).pop();
    unitOut = JSON.parse(lastLine);
  } catch { /* fall through to failure detail */ }
  check('unit: invented price + empty catalog → replaced with empty-catalog reply',
    unitOut?.r1replaced === true && unitOut?.r1isEmptyReply === true,
    unitOut ? `replaced=${unitOut.r1replaced}` : `stderr=${(unit.stderr || '').slice(-400)}`);
  check('unit: real catalog price (৳1500) → kept, not replaced', unitOut?.r2replaced === false, JSON.stringify(unitOut ?? {}));
  check('unit: invented price + real catalog → replaced with real price list',
    unitOut?.r3replaced === true && (/1,?500/.test(unitOut?.r3reply ?? '') || /১৫০০/.test(unitOut?.r3reply ?? '')), JSON.stringify(unitOut?.r3reply ?? ''));
  check('unit: reply with no price → untouched', unitOut?.r4replaced === false, JSON.stringify(unitOut ?? {}));
  check('unit: extractPriceAmounts parses Bengali digits (৳১,৫০০ → 1500)',
    Array.isArray(unitOut?.amtBn) && unitOut.amtBn[0] === 1500, JSON.stringify(unitOut?.amtBn));
  check('unit: extractPriceAmounts parses "price 999 taka" → 999',
    Array.isArray(unitOut?.amtEn) && unitOut.amtEn[0] === 999, JSON.stringify(unitOut?.amtEn));

  // ---------- B + C. E2E: stub Graph + local API + live Groq ----------
  const stubPort = 0; // dynamic port — other overnight agents run verifiers too
  const graphStub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ recipient_id: 'cust', message_id: 'm_stub_emptycat' }));
    });
  });
  await new Promise((resolve) => graphStub.listen(stubPort, resolve));
  const graphBase = `http://localhost:${(graphStub.address()).port}/v21.0`;
  process.on('exit', () => { try { graphStub.close(); } catch { /* already closed */ } });

  const stamp = Date.now();
  const port = 4005;
  const api = makeApi(`http://localhost:${port}`);
  const run = startApi(port, '.pglite-data-emptycat', { META_GRAPH_BASE_URL: graphBase });
  process.on('exit', run.stop);
  // Declared here (not inside the try) so the finally block below can read it.
  let liveGroqB = false;
  let r1 = null;
  try {
    const up = await waitForHealth(`http://localhost:${port}`);
    check('E2E API starts (health)', up, up ? '' : run.log().slice(-500));
    if (!up) return;

    const signup = await api('/api/auth/signup', {
      method: 'POST', auth: false,
      body: { name: 'EmptyCat Owner', email: `emptycat+${stamp}@example.com`, password: 'verify1234', workspaceName: 'EmptyCat Shop' },
    });
    check('signup', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
    token = signup.data?.token ?? '';
    workspaceId = signup.data?.workspace?.id ?? '';
    const channel = await api('/api/channels', {
      method: 'POST',
      body: { platform: 'messenger', externalId: `page-emptycat-${stamp}`, displayName: 'EmptyCat Page', token: 'tok-stub-emptycat' },
    });
    check('connect messenger channel', channel.status === 201, `status=${channel.status}`);
    const live = await api(`/api/workspaces/${workspaceId}/go-live`, { method: 'POST' });
    check('go-live (practice mode off)', live.status === 200 && live.data?.workspace?.practice_mode === false, `status=${live.status}`);

    async function outCount() {
      const list = await api('/api/inbox');
      const conv = list.data?.conversations?.[0];
      if (!conv) return { n: 0, detail: null };
      const d = await api(`/api/inbox/${conv.id}`);
      const out = (d.data?.messages ?? []).filter((m) => m.direction === 'out');
      return { n: out.length, detail: d.data, last: out[out.length - 1] };
    }

    async function sendAndWaitReply(n, text, timeoutMs = 90000) {
      const mid = `emptycat-mid-${stamp}-${n}-${Date.now()}`;
      const hook = await api('/api/webhooks/meta', {
        method: 'POST', auth: false,
        body: {
          object: 'page',
          entry: [{ id: `page-emptycat-${stamp}`, messaging: [{ sender: { id: `cust-emptycat-${stamp}` }, recipient: { id: `page-emptycat-${stamp}` }, message: { mid, text } }] }],
        },
      });
      check(`webhook accepts message ${n} ("${text}")`, hook.status === 200, `status=${hook.status}`);
      const detail = await waitFor(async () => {
        const cur = await outCount();
        return cur.n >= n ? cur.detail : null;
      }, timeoutMs, `AI reply ${n}`).catch((e) => {
        check(`AI reply ${n} arrives`, false, e.message);
        return null;
      });
      if (!detail) return null;
      const outs = (detail.messages ?? []).filter((m) => m.direction === 'out');
      return { body: outs[outs.length - 1]?.body ?? '', row: outs[outs.length - 1] };
    }

    // B: ZERO products, customer asks "Product price" (the exact live case).
    // Groq's free tier is shared (200,000 tokens/day across all overnight
    // work), so a 429 can push an attempt into the labelled demo fallback
    // — that fallback is honest (saved only, never sent) but it is NOT the
    // live path, so retry until a real Groq reply arrives. Groq's own
    // 429 message says when to retry (about 6 minutes when the daily
    // budget is spent), so space attempts 75s apart, up to ~7 minutes.
    let r1b = null;
    for (let attempt = 1; attempt <= 6; attempt++) {
      const before = (await outCount()).n;
      r1b = await sendAndWaitReply(before + 1, 'Product price');
      r1 = r1b;
      if (r1b && !r1b.body.includes('[ডেমো AI')) { liveGroqB = true; break; }
      console.log(`  (attempt ${attempt}: provider fallback/demo reply — Groq daily budget spent, retrying in 75s for a live window)`);
      await sleep(75000);
    }
    check('B: live Groq path exercised for empty-catalog case (not demo fallback)',
      liveGroqB, liveGroqB ? '' : 'Groq 429 on all 6 attempts — live path not exercised this run; demo fallback reply was still the safe empty-catalog text');
    check('B: empty-catalog "Product price" gets an AI reply', typeof r1?.body === 'string' && r1.body.length > 0, (r1?.body ?? '').slice(0, 120));
    check('B: reply was actually delivered via stub Graph (sent)',
      r1?.row?.delivery_status === 'sent' && r1?.row?.platform_message_id === 'm_stub_emptycat',
      `delivery_status=${r1?.row?.delivery_status}, platform_message_id=${r1?.row?.platform_message_id}`);
    check('B: reply contains NO currency amount (no invented price)',
      replyAmounts(r1?.body ?? '').length === 0, `amounts=${JSON.stringify(replyAmounts(r1?.body ?? ''))} reply=${(r1?.body ?? '').slice(0, 160)}`);
    check('B: reply says (in Bengali) no products are added yet / asks which product',
      /এখনো কোনো প্রোডাক্ট/.test(r1?.body ?? '') || /যোগ করা হয়নি/.test(r1?.body ?? ''),
      (r1?.body ?? '').slice(0, 200));
    const ledger = await api('/api/ai-providers');
    const row1 = ledger.data?.recentUsage?.[0] ?? null;
    check('B: ledger row written, provider groq, 0 paisa (included in plan)',
      row1?.provider === 'groq' && Number(row1?.cost_paisa) === 0, JSON.stringify(row1));

    // C: one real product, price question → only the real price may appear.
    const p1 = await api('/api/products', {
      method: 'POST',
      body: { name: 'শাড়ি', pricePaisa: 150000, size: 'M', stock: 5, description: 'সুতির শাড়ি — লাল' },
    });
    check('add product শাড়ি (৳1500)', p1.status === 201 && !!p1.data?.product?.id, `status=${p1.status}`);
    const r2 = await sendAndWaitReply((await outCount()).n + 1, 'শাড়ির দাম কত?');
    check('C: price question with a real product gets a reply', typeof r2?.body === 'string' && r2.body.length > 0, (r2?.body ?? '').slice(0, 120));
    const amounts2 = replyAmounts(r2?.body ?? '');
    check('C: reply amounts are only the real price (1500) — no invented price',
      amounts2.length > 0 && amounts2.every((a) => a === 1500),
      `amounts=${JSON.stringify(amounts2)} reply=${(r2?.body ?? '').slice(0, 200)}`);
    check('C: second reply delivered via stub Graph (sent)',
      r2?.row?.delivery_status === 'sent', `delivery_status=${r2?.row?.delivery_status}`);
  } finally {
    if (!liveGroqB) console.log(`--- API log tail (Groq failure detail) ---\n${run.log().split('\n').filter((l) => /\[ai\]|\[agent/.test(l)).slice(-6).join('\n')}`);
    run.stop();
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
