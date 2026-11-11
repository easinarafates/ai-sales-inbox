#!/usr/bin/env node
/**
 * Verification for Feature 3 — Image understanding + the fake-match fix
 * (2026-11-11).
 *
 * THE BUG (user-reported): no matter what photo the customer sent — even
 * a TREE photo — the AI replied "সিমিলার প্রোডাক্ট দেখাচ্ছি" WITHOUT
 * reading the photo. Root cause in agent.ts: the no-match branch fell
 * back to "the vision match's similarIds, else the first few catalog
 * products", so ANY photo got a product list that was never matched.
 *
 * THE FIX:
 * - media.ts: analyseCustomerImage now returns isProduct (does the photo
 *   show a sellable product at all?) + the ONE vision call's token usage,
 *   and NEVER a similar-products list (similarIds is always []). A match
 *   counts only at confidence >= VISION_MATCH_CONFIDENCE_THRESHOLD (0.85).
 * - agent.ts (image branch only): no similar fallback anywhere. Tree /
 *   non-product photo -> "এই ছবিতে কোনো প্রোডাক্ট দেখা যাচ্ছে না";
 *   product photo with no trusted match -> "এই ছবির প্রোডাক্টটা আমাদের
 *   কাছে নেই" with NO names, NO prices, NO "সিমিলার". Matched live
 *   product -> name + price (+ stock); matched CONFIRMED Page-Read old
 *   product -> old price if known, NEVER a stock claim, + owner ticket.
 *   Exactly ONE ledger row per image reply, carrying the real vision
 *   tokens + provider cost (0 tokens when the exact-URL shortcut matched
 *   without a call — honest either way).
 * - image-match.ts (embedding path): CERTAIN_THRESHOLD raised 0.75 ->
 *   0.85, and below it NO matches are returned (was: top 2-3 shown as
 *   "closest"). tools-image-match.ts doc updated to match.
 * - prompts.ts: new hard rule 5খ (no fake similar-product claims, ever);
 *   rule 5ক (never fake understanding) preserved byte-identical.
 * - Webhook intake needed NO change: webhooks/routes.ts already
 *   downloads a Messenger photo with the Page token, stores it on Blob,
 *   saves media_url/media_type, marks seen FIRST, then enqueues.
 * - No migration 43: no schema change was needed (media_url from 27,
 *   page_read_products from 41, ledger already exists).
 *
 * Checks:
 * - Static: fake fallback gone, new branches + threshold + 5ক/5খ present,
 *   webhook image intake wired, local tree test image exists.
 * - Boot 1 (local API on PGlite): seed the real Halal Chic catalog
 *   (Shirt ৳600, T-shirt ৳400, Jeans ৳500) + webchat channels in two
 *   workspaces (ws2 has NO live products, only a confirmed old product).
 * - Driver (processBatch + analyseCustomerImage directly, same PGlite
 *   dir, API stopped, REAL Gemini key from apps/api/.env): tree ->
 *   not-a-product; bicycle -> honest "not ours", no similar list;
 *   Jeans photo -> Jeans ৳500; T-shirt photo (NO catalog image, pure
 *   vision) -> T-shirt ৳400; old product -> old price, no stock claim;
 *   text question still works; exactly ONE ledger row per image reply
 *   with real vision tokens where a call was made.
 *
 * ALL messages here are SIMULATED test messages against local test
 * workspaces — never live customer messages.
 *
 * Run from the repo root:  node scripts/verify-image-understanding.mjs
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const results = [];
let token = '';
let token2 = '';
/** Dummy webchat secret for the local boots (must match the boot env). */
const WEBCHAT_SECRET = 'image-test-secret';

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeApi(base, getToken) {
  return async function api(path, { method = 'GET', body, auth = true, headers = {} } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(auth && getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
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
      // Blank the provider keys so the boot runs in deterministic demo
      // mode (no live AI calls). The driver gets the real key.
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

function runDriver(dataDir, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const proc = spawn('npx', ['tsx', '../../scripts/image-understanding-driver.ts', ...args], {
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

async function main() {
  // ---------- Static checks ----------
  const agentSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/ai-agent/agent.ts'), 'utf8');
  check('agent: fake fallback "first few catalog products" is GONE', !agentSrc.includes('matchProducts.slice(0, 3)') && !agentSrc.includes('else the first few catalog products'));
  check('agent: old "সিমিলার প্রোডাক্টগুলো দেখতে পারেন" reply is GONE', !agentSrc.includes('সিমিলার প্রোডাক্টগুলো দেখতে পারেন'));
  check('agent: no-match branch never mentions সিমিলার as an offer', !/সিমিলার প্রোডাক্টগুলো/.test(agentSrc));
  check('agent: non-product branch exists (photo_not_a_product)', agentSrc.includes("reason: 'photo_not_a_product'") && agentSrc.includes('এই ছবিতে কোনো প্রোডাক্ট দেখা যাচ্ছে না'));
  check('agent: no-match reply is honest "আমাদের কাছে নেই" + asks the name', agentSrc.includes('এই ছবির প্রোডাক্টটা আমাদের কাছে নেই') && agentSrc.includes('এটা কী প্রোডাক্ট, নাম লিখে জানাবেন?'));
  check('agent: match trusted only at the vision confidence threshold', agentSrc.includes('VISION_MATCH_CONFIDENCE_THRESHOLD') && agentSrc.includes('outcome.confidence >= VISION_MATCH_CONFIDENCE_THRESHOLD'));
  check('agent: old-product branch exists (photo_matched_old_product, never a stock claim)', agentSrc.includes("reason: 'photo_matched_old_product'") && agentSrc.includes('এখন স্টকে আছে কিনা নিশ্চিত নয়'));
  check('agent: old products loaded from confirmed page_read_products', agentSrc.includes('page_read_products') && agentSrc.includes("status = 'confirmed'"));
  check('agent: image reply records real vision tokens in the ledger (chargeImage)', agentSrc.includes('chargeImage') && agentSrc.includes('outcome?.usage') && agentSrc.includes("computeAiCostPaisa('gemini', config.aiModel"));
  check('agent: off-topic block untouched (detectOffTopic + escalated_off_topic still present)', agentSrc.includes('detectOffTopic(batchedText)') && agentSrc.includes("reason: 'escalated_off_topic'"));

  const promptsSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/ai-agent/prompts.ts'), 'utf8');
  check('prompts: rule 5ক preserved exactly (never fake understanding)', promptsSrc.includes('5ক. না বুঝলে বোঝার ভান কখনো করো না') && promptsSrc.includes('"আমি বুঝতে পারছি", "বুঝেছি" বা "বুঝতে পেরেছি"'));
  check('prompts: new hard rule 5খ (no fake similar-product claims)', promptsSrc.includes('5খ. ছবির প্রোডাক্ট নিয়ে কখনো বানিয়ে বলো না') && promptsSrc.includes('মিল না পেলে কোনো প্রোডাক্টের তালিকা দেখিয়ে "সিমিলার" বলবে না'));

  const mediaSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/ai-agent/media.ts'), 'utf8');
  check('media: vision threshold is 0.85 (strict)', mediaSrc.includes('VISION_MATCH_CONFIDENCE_THRESHOLD = 0.85'));
  check('media: vision prompt asks isProduct (non-product detection)', mediaSrc.includes('"isProduct": true|false') && mediaSrc.includes('isProduct=false'));
  check('media: similarIds is always [] (no look-alike list produced)', mediaSrc.includes('similarIds: []') && !mediaSrc.includes('parsed.similarIds'));
  check('media: vision token usage is returned for the ledger', mediaSrc.includes('usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens }'));

  const matchSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/ai-agent/image-match.ts'), 'utf8');
  check('image-match: CERTAIN_THRESHOLD raised to 0.85', matchSrc.includes('CERTAIN_THRESHOLD = 0.85'));
  check('image-match: below-threshold returns NO matches (never look-alikes)', matchSrc.includes('score < CERTAIN_THRESHOLD') && matchSrc.includes('নিশ্চিত মিলে এমন প্রোডাক্ট পাওয়া যায়নি'));

  const toolSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/ai-agent/tools-image-match.ts'), 'utf8');
  check('tools-image-match: doc states the 0.85 bar + no fake similar list', toolSrc.includes('0.85') && toolSrc.includes('no-fake'));

  const routesSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/webhooks/routes.ts'), 'utf8');
  check('webhook: Messenger photo intake wired (download + Blob + media_url)', routesSrc.includes("kind === 'image'") && routesSrc.includes('downloadMetaAttachment') && routesSrc.includes('media_url'));
  check('webhook: seen is marked BEFORE the AI queue runs', routesSrc.indexOf('sendMarkSeen') > 0 && routesSrc.indexOf('sendMarkSeen') < routesSrc.indexOf('await enqueueMessage('));

  check('no migration 43 needed (no schema change)', !fs.existsSync(path.join(ROOT, 'apps/api/src/db/migrations/43-image-understanding.sql')));
  check('tree test image exists locally (not hotlinked)', fs.existsSync(path.join(ROOT, 'scripts/test-images/tree.png')));

  // ---------- Boot 1: seed the real catalog in two workspaces ----------
  const stamp = Date.now();
  const port = 4033;
  const dataDir = '.pglite-data-image-understanding';
  const run1 = startApi(port, dataDir);
  process.on('exit', run1.stop);
  let workspaceId = '';
  let jeansId = '';
  let tshirtId = '';
  let shirtId = '';
  let channelId = '';
  let workspace2Id = '';
  let channel2Id = '';
  try {
    const up = await waitForHealth(`http://localhost:${port}`);
    check('boot 1: API starts', up, up ? '' : run1.log().slice(-500));
    if (!up) return;
    const api = makeApi(`http://localhost:${port}`, () => token);
    const signup = await api('/api/auth/signup', {
      method: 'POST', auth: false,
      body: { name: 'Image Owner', email: `image+${stamp}@example.com`, password: 'verify1234', workspaceName: 'Image Test Shop' },
    });
    check('boot 1: signup ws1', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
    token = signup.data?.token ?? '';
    workspaceId = signup.data?.workspace?.id ?? '';
    const live = await api(`/api/workspaces/${workspaceId}/go-live`, { method: 'POST' });
    check('boot 1: ws1 go-live', live.status === 200 && live.data?.workspace?.practice_mode === false, `status=${live.status}`);
    const mk = async (name, pricePaisa, stock) => {
      const r = await api('/api/products', { method: 'POST', body: { name, pricePaisa, stock } });
      return r.data?.id ?? r.data?.product?.id ?? '';
    };
    jeansId = await mk('Jeans', 50000, 10);
    tshirtId = await mk('T-shirt', 40000, 9);
    shirtId = await mk('Shirt', 60000, 10);
    check('boot 1: Jeans ৳500 + T-shirt ৳400 + Shirt ৳600 created', !!jeansId && !!tshirtId && !!shirtId, `ids=${[jeansId, tshirtId, shirtId].map((s) => s.slice(0, 8)).join(',')}`);
    const ch = await api('/api/channels', { method: 'POST', body: { platform: 'webchat', externalId: 'site-image', displayName: 'Image Test Site' } });
    check('boot 1: ws1 webchat channel → 201', ch.status === 201, `status=${ch.status}`);
    channelId = ch.data?.id ?? ch.data?.channel?.id ?? '';

    // Second workspace: NO live products — only a confirmed old product (seeded by the driver).
    const api2 = makeApi(`http://localhost:${port}`, () => token2);
    const signup2 = await api2('/api/auth/signup', {
      method: 'POST', auth: false,
      body: { name: 'Image Owner 2', email: `image2+${stamp}@example.com`, password: 'verify1234', workspaceName: 'Image Old-Product Shop' },
    });
    check('boot 1: signup ws2', signup2.status === 201 && !!signup2.data?.token, `status=${signup2.status}`);
    token2 = signup2.data?.token ?? '';
    workspace2Id = signup2.data?.workspace?.id ?? '';
    const live2 = await api2(`/api/workspaces/${workspace2Id}/go-live`, { method: 'POST' });
    check('boot 1: ws2 go-live', live2.status === 200 && live2.data?.workspace?.practice_mode === false, `status=${live2.status}`);
    const ch2 = await api2('/api/channels', { method: 'POST', body: { platform: 'webchat', externalId: 'site-image-2', displayName: 'Image Old Site' } });
    check('boot 1: ws2 webchat channel → 201', ch2.status === 201, `status=${ch2.status}`);
    channel2Id = ch2.data?.id ?? ch2.data?.channel?.id ?? '';
  } finally {
    run1.stop();
    await sleep(2000);
  }

  // ---------- Driver: real Gemini vision against the same PGlite dir ----------
  const apiEnv = readEnvFile(path.join(ROOT, 'apps/api/.env'));
  const geminiKey = apiEnv.GEMINI_API_KEY ?? '';
  const treePath = path.join(ROOT, 'scripts/test-images/tree.png');
  const driver = await runDriver(dataDir, [workspaceId, jeansId, tshirtId, shirtId, channelId, treePath, workspace2Id, channel2Id], { GEMINI_API_KEY: geminiKey });
  let driverResult = null;
  const driverLine = (driver.out ?? '').split('\n').find((l) => l.startsWith('IMAGE_DRIVER_RESULT '));
  try {
    driverResult = driverLine ? JSON.parse(driverLine.slice('IMAGE_DRIVER_RESULT '.length)) : null;
  } catch {
    driverResult = null;
  }
  check('driver: ran clean (exit 0 + result line)', driver.code === 0 && !!driverResult, `code=${driver.code} err=${(driver.err ?? '').slice(-2000)}`);
  try { fs.rmSync(path.join(ROOT, 'apps/api', dataDir), { recursive: true, force: true }); } catch { /* already gone */ }
  if (driverResult?.skipped) {
    console.log('NOTE  live vision checks SKIPPED: no GEMINI_API_KEY in apps/api/.env — run with a real key to prove the vision flow.');
    results.push({ name: 'driver: SKIPPED (no key)', ok: true, detail: 'live checks not run' });
  } else if (driverResult) {
    const vt = driverResult.visionTree ?? {};
    check('vision unit: tree is NOT a product (isProduct false, no match, no similarIds)', vt.matchedId === null && vt.isProduct === false && Array.isArray(vt.similarIds) && vt.similarIds.length === 0, JSON.stringify(vt));
    check('vision unit: tree vision call recorded usage (one Gemini call)', vt.hasUsage === true, JSON.stringify(vt));
    const vb = driverResult.visionBicycle ?? {};
    check('vision unit: bicycle IS a product but matches NOTHING (no fake match)', vb.matchedId === null && vb.isProduct === true && Array.isArray(vb.similarIds) && vb.similarIds.length === 0, JSON.stringify(vb));
    const vtn = driverResult.visionTshirtNoImages ?? {};
    check('vision unit: T-shirt matches by PURE vision (no catalog image, no shortcut)', vtn.matchedId === tshirtId && (vtn.confidence ?? 0) >= 0.85, JSON.stringify(vtn));

    const tr = driverResult.treePhoto ?? {};
    check('(a) tree photo → honest "কোনো প্রোডাক্ট দেখা যাচ্ছে না", NO সিমিলার, NO product names', tr.result?.replied === true && tr.result?.reason === 'photo_not_a_product' && tr.saysNotAProduct === true && tr.noSimilarClaim === true && tr.noProductNames === true, JSON.stringify({ r: tr.result, b: tr.outBodies }));
    check('(a) ledger: exactly ONE row for the tree reply, with real vision tokens', Array.isArray(tr.ledger) && tr.ledger.length === 1 && (tr.ledger[0]?.input_tokens ?? 0) > 0, JSON.stringify(tr.ledger));

    const bc = driverResult.bicyclePhoto ?? {};
    check('(c) bicycle photo → honest "আমাদের কাছে নেই", NO সিমিলার, NO names, NO prices', bc.result?.replied === true && bc.result?.reason === 'photo_not_our_product' && bc.saysNotOurs === true && bc.noSimilarClaim === true && bc.noProductNames === true && bc.noPrices === true, JSON.stringify({ r: bc.result, b: bc.outBodies }));
    check('(c) ledger: exactly ONE row for the bicycle reply, with real vision tokens', Array.isArray(bc.ledger) && bc.ledger.length === 1 && (bc.ledger[0]?.input_tokens ?? 0) > 0, JSON.stringify(bc.ledger));

    const jn = driverResult.jeansPhoto ?? {};
    check('(b) Jeans photo → RIGHT product, RIGHT price ৳500', jn.result?.replied === true && jn.result?.reason === 'photo_matched_in_stock' && jn.namesJeans === true && jn.hasRightPrice === true, JSON.stringify({ r: jn.result, b: jn.outBodies }));
    check('(b) ledger: exactly ONE row for the Jeans reply', Array.isArray(jn.ledger) && jn.ledger.length === 1, JSON.stringify(jn.ledger));

    const ts = driverResult.tshirtPhoto ?? {};
    check('(b) T-shirt photo (pure vision) → RIGHT product, RIGHT price ৳400', ts.result?.replied === true && ts.result?.reason === 'photo_matched_in_stock' && ts.namesTshirt === true && ts.hasRightPrice === true, JSON.stringify({ r: ts.result, b: ts.outBodies }));
    check('(b) ledger: exactly ONE row for the T-shirt reply, with real vision tokens', Array.isArray(ts.ledger) && ts.ledger.length === 1 && (ts.ledger[0]?.input_tokens ?? 0) > 0, JSON.stringify(ts.ledger));

    const op = driverResult.oldProductPhoto ?? {};
    check('old product photo → old name + old price ৳800, "নিশ্চিত নয়", NEVER a stock claim', op.result?.replied === true && op.result?.reason === 'photo_matched_old_product' && op.namesOldProduct === true && op.hasOldPrice === true && op.saysStockUncertain === true && op.noStockClaim === true, JSON.stringify({ r: op.result, b: op.outBodies }));
    check('old product ledger: exactly ONE row', Array.isArray(op.ledger) && op.ledger.length === 1, JSON.stringify(op.ledger));

    const tq = driverResult.textQuestion ?? {};
    check('(e) text-only question still works (Jeans price, no regression)', tq.result?.replied === true && tq.hasPrice === true && !String(tq.result?.reason ?? '').startsWith('photo_'), JSON.stringify({ r: tq.result, b: tq.outBodies }));
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
