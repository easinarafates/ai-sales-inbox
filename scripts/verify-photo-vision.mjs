// Verifier for the 2026-11-12 Gemini-vision photo rebuild (FIX 1).
//
// Proves, end to end on the live path (a local API boot + real Gemini
// calls + the real product photos), that:
//   (a) a real Halal Chic product photo gets the CORRECT name + price + stock;
//   (b) a photo + a follow-up text in the SAME batch still vision-matches
//       (the trigger fix — the old code only ran vision when the LAST
//       message was the image, so "photo, then 'Ata ase?'" skipped vision
//       and the LLM faked a "সিমিলার" list);
//   (c) a tree / non-product photo says so honestly — no product, no "similar";
//   (d) a car photo (the EXACT user scenario) says "আমাদের কাছে নেই" —
//       NO similar list, NO names, NO prices;
//   (e) a product NOT carried (bicycle) says it is not available;
//   (f) the match_product_by_image TOOL itself uses Gemini vision as
//       PRIMARY (embeddings only as fallback) and returns real usage;
//   (g) an out-of-stock match says "স্টক আউট";
//   (h) exactly ONE ledger row per image reply, carrying the REAL vision tokens;
//   (i) a text-only question still works (no regression);
//   (j) the HTTP endpoint POST /api/image-match works with vision.
//
// Usage: node scripts/verify-photo-vision.mjs
// Exits 0 when every check passes, 1 otherwise. No secrets are printed.
// ALL test messages are SIMULATED against a local test workspace —
// never live customer messages.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEBCHAT_SECRET = 'test-webchat-secret-0123456789abcdef';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let token = '';
let token2 = '';

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail ?? '').slice(0, 800) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
}

function makeApi(base, getToken) {
  return async (p, { method = 'GET', body = null, auth = true, headers = {} } = {}) => {
    const res = await fetch(base + p, {
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
    const proc = spawn('npx', ['tsx', '../../scripts/photo-vision-driver.ts', ...args], {
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

// The shop's REAL product photos (same Blob URLs the live catalog uses).
const TSHIRT_IMG = 'https://wzal8khi0daufwg8.public.blob.vercel-storage.com/a952912b-1ab3-4cc2-a975-2a37080d1278.png';

async function main() {
  // ---------- Static checks — the 2026-11-12 rebuild ----------
  const agentSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/ai-agent/agent.ts'), 'utf8');
  check('agent: image branch uses the MOST RECENT image in the batch (photo + text fix)', agentSrc.includes("[...batchedMessages].reverse().find((m) => m.mediaType === 'image' && m.mediaUrl)"));
  check('agent: image branch does NOT use last-message-only (the old bug)', !agentSrc.includes('const newestMedia = batchedMessages[batchedMessages.length - 1]'));
  check('agent: photo URL is passed to the LLM in ctx.messages (tool can call it)', agentSrc.includes('[ছবির লিংক:'));
  check('agent: tool-loop vision usage is accumulated into the ledger tokens', agentSrc.includes('visionUsage') && agentSrc.includes('inputTokens += Number(visionUsage.inputTokens'));
  check('agent: old "সিমিলার প্রোডাক্টগুলো দেখতে পারেন" reply is GONE', !agentSrc.includes('সিমিলার প্রোডাক্টগুলো দেখতে পারেন'));
  check('agent: no-match reply is honest "আমাদের কাছে নেই"', agentSrc.includes('এই ছবির প্রোডাক্টটা আমাদের কাছে নেই'));
  check('agent: non-product branch exists (photo_not_a_product)', agentSrc.includes("reason: 'photo_not_a_product'") && agentSrc.includes('এই ছবিতে কোনো প্রোডাক্ট দেখা যাচ্ছে না'));

  const matchSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/ai-agent/image-match.ts'), 'utf8');
  check('image-match: Gemini vision is the PRIMARY path (analyseCustomerImage first)', matchSrc.includes('analyseCustomerImage') && matchSrc.includes('loadVisionCandidates'));
  check('image-match: vision runs BEFORE any embeddings fallback', matchSrc.indexOf('analyseCustomerImage') < matchSrc.indexOf('matchProductsByEmbeddings'));
  check('image-match: match counts only at confidence >= 0.85', matchSrc.includes('CERTAIN_THRESHOLD = 0.85') && matchSrc.includes('outcome.confidence >= CERTAIN_THRESHOLD'));
  check('image-match: non-product returns NO matches with the honest message', matchSrc.includes("message: 'এই ছবিতে কোনো প্রোডাক্ট দেখা যাচ্ছে না।'"));
  check('image-match: result carries visionUsage + matchMethod for the ledger', matchSrc.includes('visionUsage') && matchSrc.includes("matchMethod: 'vision'"));
  check('image-match: embeddings kept only as a fallback', matchSrc.includes('matchProductsByEmbeddings'));

  const mediaSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/ai-agent/media.ts'), 'utf8');
  check('media: vision threshold is 0.85 (strict)', mediaSrc.includes('VISION_MATCH_CONFIDENCE_THRESHOLD = 0.85'));
  check('media: vision call retries once on transient failure (429/5xx) so one blip never reports "not available"', mediaSrc.includes('vision match attempt') && mediaSrc.includes('setTimeout(r, 5000)'));
  check('media: vision prompt asks isProduct (non-product detection)', mediaSrc.includes('"isProduct": true|false') && mediaSrc.includes('isProduct=false'));

  const toolSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/ai-agent/tools-image-match.ts'), 'utf8');
  check('tools-image-match: doc says Gemini vision is primary, never a similar list', toolSrc.includes('GEMINI VISION first') && toolSrc.includes('never a "similar products" list') && toolSrc.includes('Embeddings is only a fallback'));

  const promptsSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/ai-agent/prompts.ts'), 'utf8');
  check('prompts: tool desc says Gemini vision + pass the real photo link + never fake similar', promptsSrc.includes('Gemini vision দিয়ে ছবি দেখে মেলায়') && promptsSrc.includes('ছবির আসল লিংক') && promptsSrc.includes('বানিয়ে মিলিয়ে দিও না'));

  const routesSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/image-match/routes.ts'), 'utf8');
  check('image-match HTTP route calls matchProductsByImage', routesSrc.includes('matchProductsByImage'));

  check('tree test image exists locally (not hotlinked)', fs.existsSync(path.join(ROOT, 'scripts/test-images/tree.png')));
  check('car test image exists locally (not hotlinked)', fs.existsSync(path.join(ROOT, 'scripts/test-images/car.jpg')));

  // ---------- Boot 1: seed the real catalog ----------
  const stamp = Date.now();
  const port = 4035;
  const dataDir = '.pglite-data-photo-vision';
  const run1 = startApi(port, dataDir);
  process.on('exit', run1.stop);
  let workspaceId = '';
  let jeansId = '';
  let tshirtId = '';
  let shirtId = '';
  let channelId = '';
  try {
    const up = await waitForHealth(`http://localhost:${port}`);
    check('boot 1: API starts', up, up ? '' : run1.log().slice(-500));
    if (!up) return;
    const api = makeApi(`http://localhost:${port}`, () => token);
    const signup = await api('/api/auth/signup', {
      method: 'POST', auth: false,
      body: { name: 'Photo Vision Owner', email: `photovision+${stamp}@example.com`, password: 'verify1234', workspaceName: 'Photo Vision Shop' },
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
    jeansId = await mk('Jeans', 50000, 10);
    tshirtId = await mk('T-shirt', 40000, 9);
    shirtId = await mk('Shirt', 60000, 10);
    check('boot 1: Jeans ৳500 + T-shirt ৳400 + Shirt ৳600 created', !!jeansId && !!tshirtId && !!shirtId, `ids=${[jeansId, tshirtId, shirtId].map((s) => s.slice(0, 8)).join(',')}`);
    const ch = await api('/api/channels', { method: 'POST', body: { platform: 'webchat', externalId: 'site-photovision', displayName: 'Photo Vision Site' } });
    check('boot 1: webchat channel → 201', ch.status === 201, `status=${ch.status}`);
    channelId = ch.data?.id ?? ch.data?.channel?.id ?? '';
  } finally {
    run1.stop();
    await sleep(2000);
  }

  // ---------- Driver: real Gemini vision against the same PGlite dir ----------
  const apiEnv = readEnvFile(path.join(ROOT, 'apps/api/.env'));
  const geminiKey = apiEnv.GEMINI_API_KEY ?? '';
  const treePath = path.join(ROOT, 'scripts/test-images/tree.png');
  const carPath = path.join(ROOT, 'scripts/test-images/car.jpg');
  const driver = await runDriver(dataDir, [workspaceId, jeansId, tshirtId, shirtId, channelId, treePath, carPath], { GEMINI_API_KEY: geminiKey });
  let driverResult = null;
  const driverLine = (driver.out ?? '').split('\n').find((l) => l.startsWith('PHOTO_VISION_RESULT '));
  try {
    driverResult = driverLine ? JSON.parse(driverLine.slice('PHOTO_VISION_RESULT '.length)) : null;
  } catch {
    driverResult = null;
  }
  check('driver: ran clean (exit 0 + result line)', driver.code === 0 && !!driverResult, `code=${driver.code} err=${(driver.err ?? '').slice(-2000)}`);
  if (driverResult?.skipped) {
    console.log('NOTE  live vision checks SKIPPED: no GEMINI_API_KEY in apps/api/.env — run with a real key to prove the vision flow.');
    results.push({ name: 'driver: SKIPPED (no key)', ok: true, detail: 'live checks not run' });
  } else if (driverResult) {
    const tt = driverResult.toolTshirt ?? {};
    check('(f) TOOL: T-shirt photo → vision matches T-shirt ৳400 by PURE vision, real usage', Array.isArray(tt.matches) && tt.matches.length === 1 && tt.matches[0]?.name === 'T-shirt' && tt.matches[0]?.pricePaisa === 40000 && tt.matchMethod === 'vision' && (tt.visionUsage?.inputTokens ?? 0) > 0, JSON.stringify(tt));
    const tj = driverResult.toolJeans ?? {};
    check('(f) TOOL: Jeans photo → matches Jeans ৳500 (exact-URL shortcut, honest 0 vision tokens)', Array.isArray(tj.matches) && tj.matches.length === 1 && tj.matches[0]?.name === 'Jeans' && tj.matches[0]?.pricePaisa === 50000 && tj.matchMethod === 'vision', JSON.stringify(tj));
    const ttr = driverResult.toolTree ?? {};
    check('(f) TOOL: tree → NO matches, "প্রোডাক্ট দেখা যাচ্ছে না", vision method', Array.isArray(ttr.matches) && ttr.matches.length === 0 && ttr.matchMethod === 'vision' && String(ttr.message ?? '').includes('প্রোডাক্ট দেখা যাচ্ছে না'), JSON.stringify(ttr));
    const tc = driverResult.toolCar ?? {};
    check('(f) TOOL: car → NO matches, "আমাদের কাছে নেই", vision method', Array.isArray(tc.matches) && tc.matches.length === 0 && tc.matchMethod === 'vision' && String(tc.message ?? '').includes('আমাদের কাছে নেই'), JSON.stringify(tc));
    const tb = driverResult.toolBicycle ?? {};
    check('(e) TOOL: bicycle (not carried) → NO matches, "আমাদের কাছে নেই"', Array.isArray(tb.matches) && tb.matches.length === 0 && String(tb.message ?? '').includes('আমাদের কাছে নেই'), JSON.stringify(tb));

    const fp = driverResult.flowPhotoPlusText ?? {};
    check('(b) FLOW: photo + "Ata ase?" in ONE batch → T-shirt ৳400, NO সিমিলার (trigger fix)', fp.result?.replied === true && fp.result?.reason === 'photo_matched_in_stock' && fp.namesTshirt === true && fp.hasRightPrice === true && fp.noSimilarClaim === true, JSON.stringify({ r: fp.result, b: fp.outBodies }));
    check('(b) ledger: exactly ONE row for the photo+text reply, real vision tokens', Array.isArray(fp.ledger) && fp.ledger.length === 1 && (fp.ledger[0]?.input_tokens ?? 0) > 0, JSON.stringify(fp.ledger));

    const fc = driverResult.flowCarPlusText ?? {};
    check('(d) FLOW: CAR photo + "Ata ase?" → "আমাদের কাছে নেই", NO সিমিলার, NO names, NO prices (user scenario)', fc.result?.replied === true && fc.result?.reason === 'photo_not_our_product' && fc.saysNotOurs === true && fc.noSimilarClaim === true && fc.noProductNames === true && fc.noPrices === true, JSON.stringify({ r: fc.result, b: fc.outBodies }));
    check('(d) ledger: exactly ONE row for the car reply, real vision tokens', Array.isArray(fc.ledger) && fc.ledger.length === 1 && (fc.ledger[0]?.input_tokens ?? 0) > 0, JSON.stringify(fc.ledger));

    const ft = driverResult.flowTree ?? {};
    check('(c) FLOW: tree photo → "কোনো প্রোডাক্ট দেখা যাচ্ছে না", NO সিমিলার, NO names', ft.result?.replied === true && ft.result?.reason === 'photo_not_a_product' && ft.saysNotAProduct === true && ft.noSimilarClaim === true && ft.noProductNames === true, JSON.stringify({ r: ft.result, b: ft.outBodies }));
    check('(c) ledger: exactly ONE row for the tree reply, real vision tokens', Array.isArray(ft.ledger) && ft.ledger.length === 1 && (ft.ledger[0]?.input_tokens ?? 0) > 0, JSON.stringify(ft.ledger));

    const tq = driverResult.flowText ?? {};
    check('(i) FLOW: text-only question still works (Jeans price, no regression)', tq.result?.replied === true && tq.hasPrice === true && !String(tq.result?.reason ?? '').startsWith('photo_'), JSON.stringify({ r: tq.result, b: tq.outBodies }));

    const fo = driverResult.flowOutOfStock ?? {};
    check('(g) FLOW: Jeans photo, stock 0 → "স্টক আউট", names Jeans', fo.result?.replied === true && fo.result?.reason === 'photo_matched_out_of_stock' && fo.saysOutOfStock === true && fo.namesJeans === true, JSON.stringify({ r: fo.result, b: fo.outBodies }));
    check('(g) ledger: exactly ONE row for the out-of-stock reply', Array.isArray(fo.ledger) && fo.ledger.length === 1, JSON.stringify(fo.ledger));
  }

  // ---------- Boot 2: HTTP endpoint POST /api/image-match with the real key ----------
  // Proves the tool over HTTP (the same function the agent tool calls).
  if (geminiKey) {
    const port2 = 4036;
    const run2 = startApi(port2, dataDir, { GEMINI_API_KEY: geminiKey });
    process.on('exit', run2.stop);
    try {
      const up2 = await waitForHealth(`http://localhost:${port2}`);
      check('boot 2: API starts (real key)', up2, up2 ? '' : run2.log().slice(-500));
      if (up2) {
        const api2 = makeApi(`http://localhost:${port2}`, () => token);
        const r = await api2('/api/image-match', { method: 'POST', body: { imageUrl: TSHIRT_IMG, limit: 3 } });
        const ok = r.status === 200 && Array.isArray(r.data?.matches) && r.data.matches.length === 1 && r.data.matches[0]?.name === 'T-shirt' && r.data.matches[0]?.pricePaisa === 40000 && r.data.matchMethod === 'vision' && (r.data.visionUsage?.inputTokens ?? 0) > 0;
        check('(j) HTTP: POST /api/image-match with the T-shirt photo → vision match T-shirt ৳400 + real usage', ok, `status=${r.status} body=${JSON.stringify(r.data).slice(0, 500)}`);
      }
    } finally {
      run2.stop();
      await sleep(2000);
    }
  } else {
    console.log('NOTE  HTTP /api/image-match check SKIPPED: no GEMINI_API_KEY in apps/api/.env.');
    results.push({ name: 'HTTP: SKIPPED (no key)', ok: true, detail: 'live check not run' });
  }
  try { fs.rmSync(path.join(ROOT, 'apps/api', dataDir), { recursive: true, force: true }); } catch { /* already gone */ }
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
