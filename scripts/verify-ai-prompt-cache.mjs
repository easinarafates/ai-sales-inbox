#!/usr/bin/env node
/**
 * Verification for 24h Gemini prompt caching (migration 39).
 * Local, real Gemini key, local PGlite API (scratch dir), webchat channel.
 *
 * Coverage:
 *  A. Unit (real code, no HTTP): computeAiCostPaisa cached-aware math;
 *     buildStableContext/buildVariablePrompt byte-identical to the same
 *     sections of buildUserPrompt; hashStableContext changes on a price
 *     change.
 *  B. E2E: 5 webchat price questions → real Gemini replies quoting the
 *     DB price (৳1500); the 5th reply passes the volume gate (>= 4 AI
 *     replies in the last 60 min) so an explicit-cache creation is
 *     attempted and fails with the free-tier 429 — the reply still goes
 *     out correctly (fallback), and the throttle means no second
 *     creation attempt within the hour. [ai-cache] lines are logged.
 *  C. Invalidation: PATCH the product price to ৳1750, ask again → the
 *     reply quotes ৳1750 (the new price), never the old ৳1500.
 *  D. Ledger (DB peek after the API stops): every reply has a row with
 *     cached_input_tokens populated (0 is fine on the free tier) and
 *     provider_cost_paisa equal to the cached-aware formula.
 *
 * Run from the repo root:  node scripts/verify-ai-prompt-cache.mjs
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

function webchatSecret() {
  const env = fs.readFileSync(path.join(ROOT, 'apps/api/.env'), 'utf8');
  const line = env.split('\n').find((l) => l.startsWith('WEBCHAT_SECRET='));
  return line ? line.slice('WEBCHAT_SECRET='.length).trim() : '';
}

async function main() {
  // ---------- A. Unit: pricing math + prompt split + hash ----------
  const unitScript = `
    import { computeAiCostPaisa } from './src/ai-agent/pricing.ts';
    import { buildStableContext, buildUserPrompt, buildVariablePrompt } from './src/ai-agent/prompts.ts';
    import { hashStableContext } from './src/ai-agent/gemini-cache.ts';
    const ctx = {
      customerName: 'Test', customerPhone: null, customerAddress: null, customerGender: 'unknown',
      history: [{ direction: 'in', body: 'শাড়ির দাম কত?' }],
      openOrders: [], orderSummary: { totalOrders: 0, pendingCount: 0, recent: [] },
      knowledge: [{ title: 'ডেলিভারি', body: 'ঢাকায় ৬০ টাকা।' }],
      products: [{ id: 'p1', name: 'শাড়ি', pricePaisa: 150000, stock: 5, variantType: null, variants: [] }],
      messages: ['শাড়ির দাম কত?'],
      deliveryCharges: 'ডেলিভারি চার্জ: ঢাকার ভেতরে ৳100।',
    };
    const full = buildUserPrompt(ctx);
    const stable = buildStableContext(ctx);
    const variable = buildVariablePrompt(ctx);
    const stableSections = stable.split('\\n\\n');
    const variableSections = variable.split('\\n\\n');
    const fullSections = full.split('\\n\\n');
    // Original order: v0 v1 v2 s0 [s1..] v3 v4 v5
    const reassembled = [variableSections[0], variableSections[1], variableSections[2], ...stableSections, variableSections[3], variableSections[4], variableSections[5]].join('\\n\\n');
    const ctx2 = { ...ctx, products: [{ id: 'p1', name: 'শাড়ি', pricePaisa: 175000, stock: 5, variantType: null, variants: [] }] };
    console.log(JSON.stringify({
      cachedCost: computeAiCostPaisa('gemini', 'gemini-3.5-flash-lite', 3890, 100, 3517),
      uncachedCost: computeAiCostPaisa('gemini', 'gemini-3.5-flash-lite', 3890, 100),
      groqCost: computeAiCostPaisa('groq', 'openai/gpt-oss-20b', 3890, 100, 3517),
      splitIdentical: reassembled === full,
      stableInFull: full.includes(stableSections[0]) && full.includes(stableSections[stableSections.length - 1]),
      hashSame: hashStableContext(stable) === hashStableContext(buildStableContext(ctx)),
      hashChanges: hashStableContext(stable) !== hashStableContext(buildStableContext(ctx2)),
      fullSectionCount: fullSections.length,
    }));
  `;
  const unit = spawnSync('npx', ['tsx', '-e', unitScript], {
    cwd: path.join(ROOT, 'apps/api'),
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: 'pglite://./.pglite-data-cacheverify-unit' },
    timeout: 120000,
  });
  let unitOut = null;
  try {
    const lastLine = (unit.stdout || '').trim().split('\n').filter(Boolean).pop();
    unitOut = JSON.parse(lastLine);
  } catch { /* fall through to failure detail */ }
  check('unit: cached-aware cost (3890 in, 3517 cached, 100 out) = 6 paisa',
    unitOut?.cachedCost === 6, JSON.stringify(unitOut ?? { stderr: (unit.stderr || '').slice(-400) }));
  check('unit: same call uncached = 17 paisa (old 4-arg call still works)',
    unitOut?.uncachedCost === 17, JSON.stringify(unitOut ?? {}));
  check('unit: groq cost stays 0 even with cached tokens', unitOut?.groqCost === 0, JSON.stringify(unitOut ?? {}));
  check('unit: stable + variable sections reassemble to buildUserPrompt byte-identically',
    unitOut?.splitIdentical === true, JSON.stringify(unitOut ?? {}));
  check('unit: stable sections appear byte-identically inside buildUserPrompt',
    unitOut?.stableInFull === true, JSON.stringify(unitOut ?? {}));
  check('unit: hash is deterministic and changes when the price changes',
    unitOut?.hashSame === true && unitOut?.hashChanges === true, JSON.stringify(unitOut ?? {}));

  // ---------- B + C. E2E: live Gemini via webchat ----------
  const stamp = Date.now();
  const port = 4006;
  const api = makeApi(`http://localhost:${port}`);
  const run = startApi(port, '.pglite-data-cacheverify');
  process.on('exit', run.stop);
  try {
    const up = await waitForHealth(`http://localhost:${port}`);
    check('E2E API starts (health)', up, up ? '' : run.log().slice(-500));
    if (!up) return;

    const signup = await api('/api/auth/signup', {
      method: 'POST', auth: false,
      body: { name: 'Cache Owner', email: `cacheverify+${stamp}@example.com`, password: 'verify1234', workspaceName: 'Cache Shop' },
    });
    check('signup', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
    token = signup.data?.token ?? '';
    workspaceId = signup.data?.workspace?.id ?? '';

    const product = await api('/api/products', {
      method: 'POST',
      body: { name: 'শাড়ি', pricePaisa: 150000, stock: 5, description: 'সুতির শাড়ি' },
    });
    check('create product শাড়ি ৳1500', product.status === 201 && !!product.data?.product?.id, `status=${product.status}`);
    const productId = product.data?.product?.id ?? '';

    const live = await api(`/api/workspaces/${workspaceId}/go-live`, { method: 'POST' });
    check('go-live (practice mode off)', live.status === 200 && live.data?.workspace?.practice_mode === false, `status=${live.status}`);

    const channel = await api('/api/channels', {
      method: 'POST',
      body: { platform: 'webchat', externalId: 'website-chat', displayName: 'Website chat' },
    });
    check('connect webchat channel', channel.status === 201, `status=${channel.status} ${JSON.stringify(channel.data ?? {}).slice(0, 200)}`);

    const secret = webchatSecret();
    check('WEBCHAT_SECRET present in .env (for the webhook)', !!secret);

    async function outReplies() {
      const list = await api('/api/inbox');
      const conv = list.data?.conversations?.[0];
      if (!conv) return { n: 0, detail: null, last: null };
      const d = await api(`/api/inbox/${conv.id}`);
      const out = (d.data?.messages ?? []).filter((m) => m.direction === 'out');
      return { n: out.length, detail: d.data, last: out[out.length - 1] };
    }

    async function sendAndWaitReply(n, text, expectPrice) {
      const hook = await api('/api/webhooks/webchat', {
        method: 'POST', auth: false,
        headers: { 'x-webchat-secret': secret },
        body: { externalId: 'website-chat', senderId: 'cache-visitor-1', name: 'Cache Visitor', text },
      });
      check(`webchat webhook accepts message ${n} ("${text}")`, hook.status === 200, `status=${hook.status} ${JSON.stringify(hook.data ?? {}).slice(0, 200)}`);
      const detail = await waitFor(async () => {
        const cur = await outReplies();
        return cur.n >= n ? cur : null;
      }, 120000, `AI reply ${n}`).catch((e) => {
        check(`AI reply ${n} arrives`, false, e.message);
        return null;
      });
      if (!detail) return null;
      const body = detail.last?.body ?? '';
      const hasPrice = expectPrice === 1500
        ? /1,?500|১,?৫০০/.test(body)
        : /1,?750|১,?৭৫০/.test(body);
      check(`AI reply ${n} quotes the DB price (৳${expectPrice})`, hasPrice, `reply=${body.slice(0, 200)}`);
      return body;
    }

    // 5 replies: the 5th passes the volume gate (>= 4 in the last hour),
    // so an explicit-cache creation is attempted (free tier → 429) and
    // the reply still goes out uncached.
    await sendAndWaitReply(1, 'শাড়ির দাম কত?', 1500);
    await sendAndWaitReply(2, 'শাড়িটার দাম জানতে চাই', 1500);
    await sendAndWaitReply(3, 'এই শাড়ির প্রাইস কত?', 1500);
    await sendAndWaitReply(4, 'শাড়ির দামটা একটু বলবেন?', 1500);
    await sendAndWaitReply(5, 'আবার বলুন, শাড়ির দাম কত?', 1500);

    // C. Invalidation: change the price, ask again — new price only.
    const patched = await api(`/api/products/${productId}`, {
      method: 'PATCH',
      body: { pricePaisa: 175000 },
    });
    check('PATCH product price to ৳1750', patched.status === 200 && patched.data?.product?.price_paisa === 175000, `status=${patched.status}`);
    const reply6 = await sendAndWaitReply(6, 'শাড়ির দাম কত?', 1750);
    if (reply6) {
      const mentionsOld = /1,?500|১,?৫০০/.test(reply6);
      check('reply after price change never quotes the old ৳1500 as the price', !mentionsOld, `reply=${reply6.slice(0, 200)}`);
    }

    // B (logs): [ai-cache] lines for every Gemini reply; exactly ONE
    // explicit-cache creation attempt (free-tier 429), throttled after.
    const log = run.log();
    const cacheLines = log.split('\n').filter((l) => l.includes('[ai-cache] ws='));
    check('[ai-cache] log line per Gemini reply (6 replies)', cacheLines.length >= 6, `found ${cacheLines.length}`);
    const createFails = log.split('\n').filter((l) => l.includes('[ai-cache] create failed'));
    check('explicit-cache creation attempted once (free-tier 429) then throttled',
      createFails.length === 1, `create-failed lines=${createFails.length}: ${(createFails[0] ?? '').slice(0, 160)}`);
    console.log('--- [ai-cache] lines ---');
    for (const l of cacheLines) console.log(l);
    if (createFails[0]) console.log('--- create failure ---');
    if (createFails[0]) console.log(createFails[0].slice(0, 300));
  } finally {
    run.stop();
    await sleep(1500);
  }

  // ---------- D. Ledger peek (API stopped — PGlite single-process) ----------
  const peek = spawnSync('node', ['scripts/peek-cache-ledger.mjs', '.pglite-data-cacheverify', workspaceId], {
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
    check('ledger has 6 Gemini rows for the workspace', (peekOut.rows ?? []).length >= 6, `rows=${(peekOut.rows ?? []).length}`);
    const allGemini = (peekOut.rows ?? []).every((r) => r.provider === 'gemini');
    check('all 6 ledger rows are provider=gemini (real Gemini, not demo/groq)', allGemini);
    const allHaveCachedCol = (peekOut.rows ?? []).every((r) => typeof r.cached_input_tokens === 'number');
    check('every row has cached_input_tokens populated (0 is fine on free tier)', allHaveCachedCol);
    const costsMatch = (peekOut.rows ?? []).every((r) => r.provider_cost_paisa === r.expected_provider_cost_paisa);
    check('provider_cost_paisa equals the cached-aware formula on every row', costsMatch,
      JSON.stringify((peekOut.rows ?? []).map((r) => ({ in: r.input_tokens, cached: r.cached_input_tokens, out: r.output_tokens, got: r.provider_cost_paisa, want: r.expected_provider_cost_paisa }))));
    check('no explicit-cache row left behind (creation failed, nothing stored)',
      (peekOut.cacheRows ?? []).length === 0, `cache rows=${(peekOut.cacheRows ?? []).length}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error('verifier crashed:', err);
  process.exit(1);
});
