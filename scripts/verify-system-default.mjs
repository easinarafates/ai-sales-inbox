#!/usr/bin/env node
/**
 * Verification for the "Use system default" provider fix.
 *
 * Root cause (2026-11-07, 4th occurrence): the AI Providers settings
 * page has a "Use system default" button that POSTs provider 'system',
 * which NULLed the workspace's ai_provider/ai_model columns — and the
 * system default was Groq (env AI_PROVIDER=groq), whose free-tier quota
 * is exhausted. Result: live AI replies silently stopped and fell back
 * to demo mode (saved-only, never sent).
 *
 * The fix:
 * - POST provider 'system' now resolves the configured default via
 *   systemDefaultAi() and WRITES it into the columns (never NULL).
 * - The configured default is gemini / gemini-3.5-flash-lite everywhere:
 *   apps/api/.env (AI_PROVIDER=gemini, AI_MODEL=gemini-3.5-flash-lite),
 *   the Vercel API project env, and the code fallbacks
 *   (config aiModel default + resolveWorkspaceAi invalid-env fallback).
 *
 * Checks:
 * - Static: the 'system' branch writes concrete values (no NULL);
 *   systemDefaultAi() exists and falls back to gemini/lite; the
 *   resolveWorkspaceAi invalid-env fallback is gemini, not groq;
 *   config aiModel default is gemini-3.5-flash-lite; .env has
 *   AI_PROVIDER=gemini and AI_MODEL=gemini-3.5-flash-lite.
 * - Boot 1 (OLD env: AI_PROVIDER=groq, AI_MODEL=gemini-3.5-flash):
 *   a fresh workspace resolves to groq (explicit=false); an explicit
 *   select still works; POST 'system' leaves it on groq with
 *   explicit=true — proving the reset NEVER NULLs, whatever env says.
 * - Boot 2 (NEW env: AI_PROVIDER=gemini, AI_MODEL=gemini-3.5-flash-lite):
 *   a fresh workspace resolves to gemini/lite (explicit=false);
 *   POST 'system' leaves it on gemini/gemini-3.5-flash-lite with
 *   explicit=true; a webchat price question then gets a REAL Lite reply
 *   (correct price, no demo label) and the ledger row is
 *   gemini/gemini-3.5-flash-lite with fallback_from null; an explicit
 *   select of gemini/lite still works.
 *
 * Run from the repo root:  node scripts/verify-system-default.mjs
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 * The local API runs with the real Gemini key from apps/api/.env, so
 * the boot-2 reply is a genuine Lite reply, not demo mode.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const results = [];
let token = '';

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
      JWT_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      WEBCHAT_SECRET: '',
      META_APP_ID: 'dummy-app-id',
      META_APP_SECRET: 'dummy-secret',
      META_GRAPH_BASE_URL: 'http://localhost:4020/v21.0',
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

async function main() {
  // ---------- Static checks ----------
  const routesSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/ai-providers/routes.ts'), 'utf8');
  check('system branch resolves the default via systemDefaultAi()', routesSrc.includes('systemDefaultAi()'));
  check('system branch writes concrete provider/model (no NULL)', routesSrc.includes('ai_provider = $2, ai_model = $3') && !routesSrc.includes('ai_provider = NULL') && !routesSrc.includes('ai_model = NULL'));
  check('system branch comment explains the old NULL bug', routesSrc.includes('never be NULLed by this path'));

  const providersSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/ai-agent/providers.ts'), 'utf8');
  check('providers exports systemDefaultAi', providersSrc.includes('export function systemDefaultAi'));
  check('systemDefaultAi falls back to gemini/lite', providersSrc.includes("return { provider: 'gemini', model: 'gemini-3.5-flash-lite' }"));
  check('resolveWorkspaceAi invalid-env fallback is gemini (not groq)', providersSrc.includes("? config.aiProvider : 'gemini'") && !providersSrc.includes("? config.aiProvider : 'groq'"));

  const configSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/config/index.ts'), 'utf8');
  check('config aiModel default is gemini-3.5-flash-lite', configSrc.includes("aiModel: optional('AI_MODEL', 'gemini-3.5-flash-lite')"));

  const envFile = fs.readFileSync(path.join(ROOT, 'apps/api/.env'), 'utf8');
  check('.env sets AI_PROVIDER=gemini', /^AI_PROVIDER=gemini$/m.test(envFile));
  check('.env sets AI_MODEL=gemini-3.5-flash-lite', /^AI_MODEL=gemini-3\.5-flash-lite$/m.test(envFile));

  // ---------- Stub Graph server (safety net — webchat replies need none,
  // but the reply pipeline must never hang on a Graph call) ----------
  const graphStub = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let raw = '';
    req.on('data', (c) => { raw += c.toString(); });
    req.on('end', () => {
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'POST' && url.pathname.endsWith('/messages')) {
        return send(200, { message_id: `mid-stub-${Date.now()}` });
      }
      return send(400, { error: { message: 'Unsupported.', type: 'GraphMethodException', code: 100, error_subcode: 33 } });
    });
  });
  await new Promise((resolve) => graphStub.listen(4020, resolve));

  const stamp = Date.now();
  const port = 4018;

  // ---------- Boot 1: OLD env (AI_PROVIDER=groq) ----------
  // The reset must never NULL, whatever the env default is.
  const dataDir1 = '.pglite-data-sysdef1';
  const run1 = startApi(port, dataDir1, { AI_PROVIDER: 'groq', AI_MODEL: 'gemini-3.5-flash' });
  process.on('exit', run1.stop);
  try {
    const up1 = await waitForHealth(`http://localhost:${port}`);
    check('boot 1 (old groq env): API starts', up1, up1 ? '' : run1.log().slice(-500));
    if (up1) {
      const api = makeApi(`http://localhost:${port}`);
      const signup1 = await api('/api/auth/signup', {
        method: 'POST', auth: false,
        body: { name: 'Sysdef Owner', email: `sysdef+${stamp}@example.com`, password: 'verify1234', workspaceName: 'Sysdef Shop' },
      });
      check('boot 1: signup', signup1.status === 201 && !!signup1.data?.token, `status=${signup1.status}`);
      token = signup1.data?.token ?? '';
      const live1 = await api(`/api/workspaces/${signup1.data?.workspace?.id ?? ''}/go-live`, { method: 'POST' });
      check('boot 1: go-live', live1.status === 200 && live1.data?.workspace?.practice_mode === false, `status=${live1.status}`);

      const cur1 = await api('/api/ai-providers');
      check('boot 1: fresh workspace resolves to groq env default (explicit=false)', cur1.data?.current?.provider === 'groq' && cur1.data?.current?.explicit === false, JSON.stringify(cur1.data?.current ?? {}));

      const sel1 = await api('/api/ai-providers/select', { method: 'POST', body: { provider: 'gemini' } });
      check('boot 1: explicit select gemini works', sel1.status === 200 && sel1.data?.current?.provider === 'gemini' && sel1.data?.current?.explicit === true, `status=${sel1.status} ${JSON.stringify(sel1.data?.current ?? {})}`);

      const reset1 = await api('/api/ai-providers/select', { method: 'POST', body: { provider: 'system' } });
      check("boot 1: POST 'system' succeeds", reset1.status === 200, `status=${reset1.status}`);
      const after1 = await api('/api/ai-providers');
      check("boot 1: after 'system', workspace is groq AND explicit=true (columns written, not NULL)", after1.data?.current?.provider === 'groq' && after1.data?.current?.explicit === true, JSON.stringify(after1.data?.current ?? {}));

      const reset1b = await api('/api/ai-providers/select', { method: 'POST', body: { provider: 'system' } });
      const after1b = await api('/api/ai-providers');
      check("boot 1: second 'system' reset is idempotent", reset1b.status === 200 && after1b.data?.current?.provider === 'groq' && after1b.data?.current?.explicit === true, JSON.stringify(after1b.data?.current ?? {}));
    }
  } finally {
    run1.stop();
    await sleep(2000);
    try { fs.rmSync(path.join(ROOT, 'apps/api', dataDir1), { recursive: true, force: true }); } catch { /* already gone */ }
  }

  // ---------- Boot 2: NEW env (AI_PROVIDER=gemini, AI_MODEL=gemini-3.5-flash-lite) ----------
  const dataDir2 = '.pglite-data-sysdef2';
  const run2 = startApi(port, dataDir2, { AI_PROVIDER: 'gemini', AI_MODEL: 'gemini-3.5-flash-lite' });
  process.on('exit', run2.stop);
  try {
    const up2 = await waitForHealth(`http://localhost:${port}`);
    check('boot 2 (new gemini/lite env): API starts', up2, up2 ? '' : run2.log().slice(-500));
    if (!up2) return;
    const api = makeApi(`http://localhost:${port}`);
    const signup2 = await api('/api/auth/signup', {
      method: 'POST', auth: false,
      body: { name: 'Sysdef Owner 2', email: `sysdef2+${stamp}@example.com`, password: 'verify1234', workspaceName: 'Sysdef Shop 2' },
    });
    check('boot 2: signup', signup2.status === 201 && !!signup2.data?.token, `status=${signup2.status}`);
    token = signup2.data?.token ?? '';
    const ws2 = signup2.data?.workspace?.id ?? '';
    const live2 = await api(`/api/workspaces/${ws2}/go-live`, { method: 'POST' });
    check('boot 2: go-live', live2.status === 200 && live2.data?.workspace?.practice_mode === false, `status=${live2.status}`);

    const cur2 = await api('/api/ai-providers');
    check('boot 2: fresh workspace resolves to gemini/lite (explicit=false)', cur2.data?.current?.provider === 'gemini' && cur2.data?.current?.model === 'gemini-3.5-flash-lite' && cur2.data?.current?.explicit === false, JSON.stringify(cur2.data?.current ?? {}));

    const reset2 = await api('/api/ai-providers/select', { method: 'POST', body: { provider: 'system' } });
    check("boot 2: POST 'system' succeeds", reset2.status === 200, `status=${reset2.status}`);
    const after2 = await api('/api/ai-providers');
    check("boot 2: after 'system', workspace is gemini/lite AND explicit=true (never NULL)", after2.data?.current?.provider === 'gemini' && after2.data?.current?.model === 'gemini-3.5-flash-lite' && after2.data?.current?.explicit === true, JSON.stringify(after2.data?.current ?? {}));

    // Seed the 3 Halal Chic products, then a real Lite reply must flow.
    for (const p of [
      { name: 'Shirt', pricePaisa: 60000, stock: 10 },
      { name: 'T-shirt', pricePaisa: 40000, stock: 10 },
      { name: 'Jeans', pricePaisa: 50000, stock: 10 },
    ]) {
      const created = await api('/api/products', { method: 'POST', body: p });
      check(`boot 2: product ${p.name} created`, created.status === 201, `status=${created.status}`);
    }
    const ch = await api('/api/channels', { method: 'POST', body: { platform: 'webchat', externalId: 'site-sysdef', displayName: 'Sysdef Test Site' } });
    check('boot 2: webchat channel → 201', ch.status === 201, `status=${ch.status}`);

    const m1 = await api('/api/webhooks/webchat', {
      method: 'POST', auth: false,
      body: { externalId: 'site-sysdef', senderId: 'wc-sysdef-1', name: 'Mohammad Easin', text: 'জিন্সের দাম কত?' },
    });
    check('boot 2: webchat message accepted', m1.status === 200 && !!m1.data?.conversationId, `status=${m1.status}`);
    const convId = m1.data?.conversationId ?? '';
    let outbound = null;
    const waitStart = Date.now();
    while (Date.now() - waitStart < 90000) {
      const detail = await api(`/api/inbox/${convId}`);
      const outs = (detail.data?.messages ?? []).filter((mm) => mm.direction === 'out');
      if (outs.length >= 1) { outbound = outs[outs.length - 1]; break; }
      await sleep(2000);
    }
    const body = outbound?.body ?? '';
    check('boot 2: reply arrived after system reset', !!outbound, body.slice(0, 200));
    check('boot 2: reply has the right price ৳500', body.includes('500') || body.includes('৫০০'), body.slice(0, 200));
    check('boot 2: reply is NOT a demo reply', !body.includes('[ডেমো') && !body.includes('ডেমো AI'), body.slice(0, 200));

    // The ledger row must be a real Lite row, not demo.
    let ledgerRow = null;
    const ledgerStart = Date.now();
    while (Date.now() - ledgerStart < 30000) {
      const prov = await api('/api/ai-providers');
      ledgerRow = (prov.data?.recentUsage ?? []).find((r) => r.provider === 'gemini' && r.model === 'gemini-3.5-flash-lite');
      if (ledgerRow) break;
      await sleep(2000);
    }
    check('boot 2: ledger has a real gemini/lite row', !!ledgerRow, JSON.stringify(ledgerRow ?? {}).slice(0, 200));
    check('boot 2: ledger row is NOT a fallback (fallback_from null)', ledgerRow?.fallback_from === null || ledgerRow?.fallback_from === undefined, `fallback_from=${ledgerRow?.fallback_from ?? ''}`);

    const sel2 = await api('/api/ai-providers/select', { method: 'POST', body: { provider: 'gemini', model: 'gemini-3.5-flash-lite' } });
    check('boot 2: explicit select gemini/lite still works', sel2.status === 200 && sel2.data?.current?.provider === 'gemini' && sel2.data?.current?.model === 'gemini-3.5-flash-lite' && sel2.data?.current?.explicit === true, `status=${sel2.status} ${JSON.stringify(sel2.data?.current ?? {})}`);
  } finally {
    run2.stop();
    try { graphStub.close(); } catch { /* already closed */ }
    await sleep(2000);
    try { fs.rmSync(path.join(ROOT, 'apps/api', dataDir2), { recursive: true, force: true }); } catch { /* already gone */ }
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
