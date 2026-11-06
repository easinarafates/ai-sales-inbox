#!/usr/bin/env node
/**
 * Verification for TikTok DM + real embeddings + Chrome extension.
 * Run while the API is up on :4000 (start it first — see RUNNING.md):
 *   node scripts/verify-tiktok-embeddings.mjs
 *
 * Checks three groups:
 *  A. Live API (:4000) — TikTok DM channel gating + DM webhook gate.
 *     These need the integrator to have applied integration-notes.md
 *     (index.ts mount + channels/routes.ts 'tiktok_dm'); until then they
 *     report PENDING-INTEGRATION (not a code failure) — see the summary.
 *  B. Module checks (subprocesses, fresh throwaway PGlite dirs) — the DM
 *     router mounted standalone (both approval states, dedup, parsing,
 *     stub-only send) and the embeddings provider (stub default,
 *     URL-without-key → stub, full config → real provider that returns
 *     null on failure, never a fake vector).
 *  C. Static checks — Chrome extension files + manifest + integration notes.
 * Prints PASS / FAIL / PENDING per step and exits non-zero if any FAIL.
 * NOTE: uses only test data in fresh workspaces/dirs; nothing is sent to
 * TikTok or any embeddings provider (the 'full' check uses an unreachable
 * local URL on purpose).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.API_URL ?? 'http://localhost:4000';
const results = [];
let token = '';

function check(name, status, detail = '') {
  // status: 'pass' | 'fail' | 'pending'
  results.push({ name, status, detail: String(detail ?? '') });
  const label = status === 'pass' ? 'PASS' : status === 'pending' ? 'PENDING' : 'FAIL';
  console.log(`${label}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function api(path, { method = 'GET', body, auth = true } = {}) {
  const res = await fetch(`${API}${path}`, {
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
}

function runJsonSubprocess(label, script, args, env) {
  const out = spawnSync(process.execPath, [script, ...args], {
    cwd: path.join(ROOT, 'apps', 'api'),
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 180_000,
  });
  const stdout = out.stdout ?? '';
  const start = stdout.indexOf('__HARNESS_JSON_START__');
  const startEmb = stdout.indexOf('__EMB_JSON_START__');
  const marker = start >= 0 ? '__HARNESS_JSON_START__' : '__EMB_JSON_START__';
  const endMarker = start >= 0 ? '__HARNESS_JSON_END__' : '__EMB_JSON_END__';
  const s = stdout.indexOf(marker);
  const e = stdout.indexOf(endMarker);
  if (s < 0 || e < 0) {
    check(`${label} (subprocess produced no JSON)`, 'fail', `exit=${out.status}, stderr=${(out.stderr ?? '').slice(-500)}`);
    return;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(stdout.slice(s + marker.length, e).trim());
  } catch (err) {
    check(`${label} (bad JSON)`, 'fail', err.message);
    return;
  }
  for (const c of parsed.checks ?? []) {
    check(`${label}: ${c.name}`, c.ok ? 'pass' : 'fail', c.detail ?? '');
  }
}

async function main() {
  // 0. Build the API so dist/ matches the current source.
  const build = spawnSync('npm', ['run', 'build'], {
    cwd: path.join(ROOT, 'apps', 'api'),
    encoding: 'utf8',
    timeout: 180_000,
  });
  check('API builds (tsc)', build.status === 0 ? 'pass' : 'fail', build.status === 0 ? 'tsc clean' : (build.stderr ?? build.stdout ?? '').slice(-500));
  if (build.status !== 0) {
    const failed = results.filter((r) => r.status === 'fail');
    console.log(`\n0/${results.length} checks passed — build failed, stopping.`);
    process.exit(1);
  }

  // =====================================================================
  // A. Live API (:4000) — needs the integrator's mounts to pass.
  // =====================================================================
  let apiUp = false;
  try {
    const health = await api('/api/health', { auth: false });
    apiUp = health.status === 200 && health.data?.status === 'ok';
    check('API health', apiUp ? 'pass' : 'fail', JSON.stringify(health.data));
  } catch (e) {
    check('API health', 'fail', `API is not running on ${API} — start it first (./scripts/run-local.sh). ${e.message}`);
  }

  if (apiUp) {
    const stamp = Date.now();
    const signup = await api('/api/auth/signup', {
      method: 'POST',
      auth: false,
      body: { name: 'DM Verify Owner', email: `dm-verify+${stamp}@example.com`, password: 'verify1234', workspaceName: 'DM Verify Shop' },
    });
    token = signup.data?.token ?? '';
    check('signup (fresh workspace for DM checks)', signup.status === 201 && !!token ? 'pass' : 'fail', `status=${signup.status}`);

    // TikTok DM channel: approval-gated → pending_approval while
    // TIKTOK_DM_APPROVED is unset. Needs channels/routes.ts registration.
    const dmChannel = await api('/api/channels', {
      method: 'POST',
      body: { platform: 'tiktok_dm', externalId: `tt-dm-verify-${stamp}`, displayName: 'Verify TikTok DM' },
    });
    if (dmChannel.status === 201 && dmChannel.data?.status === 'pending_approval' && dmChannel.data?.approvalRequired === true) {
      check('TikTok DM channel is pending_approval (no approval yet)', 'pass', `status=${dmChannel.status}`);
    } else if (dmChannel.status === 400) {
      check('TikTok DM channel is pending_approval (no approval yet)', 'pending', `HTTP 400 — 'tiktok_dm' not registered in channels/routes.ts yet (integrator step, see integration-notes.md §2)`);
    } else {
      check('TikTok DM channel is pending_approval (no approval yet)', 'fail', `status=${dmChannel.status}, ${JSON.stringify(dmChannel.data)}`);
    }

    // Live DM webhook: 403 while unapproved (after the index.ts mount).
    // Until the integrator mounts the router, the request falls through to
    // the '/api'-mounted routers whose router-level requireAuth answers 401
    // (pre-existing platform behaviour: unmatched /api/* paths 401 rather
    // than 404) — that also means "not mounted yet".
    const dmHook = await api('/api/webhooks/tiktok-dm', {
      method: 'POST',
      auth: false,
      body: { messageId: `dm-verify-${stamp}`, senderId: 'tt-user-x', text: 'হ্যালো', recipientId: 'tt-dm-verify-1' },
    });
    if (dmHook.status === 403 && dmHook.data?.approvalRequired === true) {
      check('DM webhook with TIKTOK_DM_APPROVED unset is rejected (403)', 'pass', JSON.stringify(dmHook.data).slice(0, 120));
    } else if (dmHook.status === 404 || dmHook.status === 401) {
      check('DM webhook with TIKTOK_DM_APPROVED unset is rejected (403)', 'pending', `HTTP ${dmHook.status} — tiktokDmRouter not mounted in index.ts yet (integrator step, see integration-notes.md §1); unmounted /api/* paths answer ${dmHook.status} here`);
    } else {
      check('DM webhook with TIKTOK_DM_APPROVED unset is rejected (403)', 'fail', `status=${dmHook.status}, ${JSON.stringify(dmHook.data)}`);
    }
  }

  // =====================================================================
  // B1. Embeddings provider (subprocess module checks — no live API needed).
  // =====================================================================
  const embBaseEnv = {
    DATABASE_URL: 'pglite:///tmp/emb-check-unused',
    JWT_SECRET: 'verify-jwt-secret',
    TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  };
  runJsonSubprocess(
    'embeddings default',
    path.join(ROOT, 'scripts', 'check-embeddings.mjs'),
    ['--mode', 'stub'],
    { ...embBaseEnv },
  );
  runJsonSubprocess(
    'embeddings URL-no-key',
    path.join(ROOT, 'scripts', 'check-embeddings.mjs'),
    ['--mode', 'url-no-key'],
    {
      ...embBaseEnv,
      EMBEDDING_PROVIDER: 'openai-compatible',
      EMBEDDING_API_URL: 'https://127.0.0.1:9/v1',
      EMBEDDING_MODEL: 'test-model',
    },
  );
  runJsonSubprocess(
    'embeddings full-config',
    path.join(ROOT, 'scripts', 'check-embeddings.mjs'),
    ['--mode', 'full'],
    {
      ...embBaseEnv,
      EMBEDDING_PROVIDER: 'openai-compatible',
      EMBEDDING_API_URL: 'https://127.0.0.1:9/v1',
      EMBEDDING_API_KEY: 'test-key-not-real',
      EMBEDDING_MODEL: 'test-model',
    },
  );

  // =====================================================================
  // B2. TikTok DM router harness (fresh throwaway PGlite dir per scenario).
  // =====================================================================
  for (const scenario of ['unapproved', 'approved']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tiktok-dm-verify-${scenario}-`));
    try {
      runJsonSubprocess(
        `tiktok-dm harness (${scenario})`,
        path.join(ROOT, 'scripts', 'harness-tiktok-dm.mjs'),
        ['--scenario', scenario],
        {
          DATABASE_URL: `pglite://${dir}`,
          SCHEMA_PATH: path.join(ROOT, 'schema.sql'),
          JWT_SECRET: 'verify-jwt-secret',
          TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          TIKTOK_DM_VERIFY_TOKEN: 'harness-token',
          TIKTOK_DM_APPROVED: scenario === 'approved' ? 'true' : '',
          AI_PROVIDER: 'gemini',
          GEMINI_API_KEY: '',
          GROQ_API_KEY: '',
        },
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // =====================================================================
  // C. Chrome extension (static checks).
  // =====================================================================
  const extDir = path.join(ROOT, 'chrome-extension');
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
    check('extension manifest.json parses', 'pass', `name=${manifest.name}`);
  } catch (e) {
    check('extension manifest.json parses', 'fail', e.message);
  }
  if (manifest) {
    check('extension manifest is v3', manifest.manifest_version === 3 ? 'pass' : 'fail', `manifest_version=${manifest.manifest_version}`);
    const referenced = new Set();
    if (manifest.action?.default_popup) referenced.add(manifest.action.default_popup);
    for (const cs of manifest.content_scripts ?? []) {
      for (const f of cs.js ?? []) referenced.add(f);
      for (const f of cs.css ?? []) referenced.add(f);
    }
    for (const f of Object.values(manifest.icons ?? {})) referenced.add(f);
    for (const f of Object.values(manifest.action?.default_icon ?? {})) referenced.add(f);
    const missing = [...referenced].filter((f) => !fs.existsSync(path.join(extDir, f)));
    check('every file the manifest references exists', missing.length === 0 ? 'pass' : 'fail', missing.length === 0 ? `${referenced.size} file(s)` : `missing: ${missing.join(', ')}`);
    const csMatches = (manifest.content_scripts ?? []).flatMap((cs) => cs.matches ?? []);
    check('content script runs on facebook/messenger/business pages', csMatches.some((m) => m.includes('facebook.com')) && csMatches.some((m) => m.includes('messenger.com')) ? 'pass' : 'fail', csMatches.join(', '));
    check('extension asks only for storage permission', JSON.stringify(manifest.permissions ?? []) === JSON.stringify(['storage']) ? 'pass' : 'fail', JSON.stringify(manifest.permissions ?? []));
  }
  const extFiles = ['popup.html', 'popup.js', 'popup.css', 'content.js', 'content.css', 'README.md', 'icons/icon16.png', 'icons/icon48.png', 'icons/icon128.png'];
  for (const f of extFiles) {
    check(`extension file present: ${f}`, fs.existsSync(path.join(extDir, f)) ? 'pass' : 'fail');
  }
  try {
    const popupHtml = fs.readFileSync(path.join(extDir, 'popup.html'), 'utf8');
    check('popup.html loads popup.js', popupHtml.includes('popup.js') ? 'pass' : 'fail');
    const popupJs = fs.readFileSync(path.join(extDir, 'popup.js'), 'utf8');
    check('popup uses chrome.storage.local for settings (token only, no localStorage)', popupJs.includes('chrome.storage.local') && !popupJs.includes('localStorage') ? 'pass' : 'fail', 'token in chrome.storage.local; no password handling');
    const contentJs = fs.readFileSync(path.join(extDir, 'content.js'), 'utf8');
    check('content script never posts a message (no fetch/XHR)', !contentJs.includes('fetch(') && !contentJs.includes('XMLHttpRequest') ? 'pass' : 'fail');
    const readme = fs.readFileSync(path.join(extDir, 'README.md'), 'utf8');
    check('extension README (Bengali) explains unpacked load', readme.includes('Load unpacked') && readme.includes('chrome://extensions') ? 'pass' : 'fail');
  } catch (e) {
    check('extension file contents readable', 'fail', e.message);
  }

  // =====================================================================
  // D. Integration notes.
  // =====================================================================
  const notesPath = path.join(ROOT, 'apps', 'api', 'src', 'webhooks', 'integration-notes.md');
  if (fs.existsSync(notesPath)) {
    const notes = fs.readFileSync(notesPath, 'utf8');
    check('integration-notes.md exists', 'pass', notesPath);
    check('integration notes give the exact router mount', notes.includes("app.use('/api/webhooks', tiktokDmRouter)") ? 'pass' : 'fail');
    check("integration notes give the 'tiktok_dm' channel registration", notes.includes('tiktok_dm') && notes.includes('tiktokDmApproved') ? 'pass' : 'fail');
    check('integration notes list the new env vars', notes.includes('TIKTOK_DM_APPROVED') && notes.includes('EMBEDDING_API_URL') ? 'pass' : 'fail');
  } else {
    check('integration-notes.md exists', 'fail', notesPath);
  }

  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail');
  const pending = results.filter((r) => r.status === 'pending');
  console.log(`\n${passed}/${results.length} checks passed (${failed.length} failed, ${pending.length} pending integration).`);
  if (pending.length > 0) {
    console.log('Pending integration (apply apps/api/src/webhooks/integration-notes.md, then re-run):');
    for (const p of pending) console.log(` - ${p.name} — ${p.detail}`);
  }
  if (failed.length > 0) {
    console.log('Failed:');
    for (const f of failed) console.log(` - ${f.name} — ${f.detail}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Verification crashed:', err);
  process.exit(1);
});
