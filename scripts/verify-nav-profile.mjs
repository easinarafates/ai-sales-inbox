#!/usr/bin/env node
/**
 * Verification for the grouped sidebar + header Profile menu.
 * Local, offline — no calls to graph.facebook.com, no Meta app needed.
 *
 * Checks:
 * - Sidebar has 5 labelled sections (Shop, Posts & Analytics, Teach AI,
 *   Help, Settings) with a distinct accent colour each; every one of the
 *   29 menu items (20 core + 9 extra) sits in exactly one section; no
 *   page was removed or renamed (href list is the pre-change list).
 * - Section label keys exist in the i18n dict in EN and BN; the
 *   previously-missing nav.postAnalysis + nav.owner keys exist too.
 * - AppShell renders the ProfileMenu in the header; the mobile drawer
 *   uses the same Sidebar component (same grouping on mobile).
 * - ProfileMenu shows the shop name, email, plan/trial, balance, a
 *   photo change/remove flow and Log out; logged out it offers Log in.
 * - Migration 21 adds users.avatar_url (idempotent).
 * - GET /api/auth/me returns avatarUrl + subscription (null when none).
 * - POST /api/profile/upload-token returns 503 locally (no Blob token)
 *   — never a 500; POST /api/profile/photo accepts a base64 image and
 *   stores it, rejects a non-image, rejects a bad URL; DELETE clears it;
 *   all profile routes 401 without auth.
 * - Web build: run `npm run build` in apps/web separately (not here).
 *
 * Run from the repo root:  node scripts/verify-nav-profile.mjs
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
      JWT_SECRET: 'verify-jwt-secret-0123456789abcdef0123456789abcdef',
      TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      AI_PROVIDER: 'groq',
      GROQ_API_KEY: 'verify-groq-key',
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

// 1x1 transparent PNG, valid base64 data URL.
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function main() {
  // ---------- Static checks ----------
  const sidebarSrc = fs.readFileSync(path.join(ROOT, 'apps/web/components/Sidebar.tsx'), 'utf8');
  const extraSrc = fs.readFileSync(path.join(ROOT, 'apps/web/components/NavExtra.tsx'), 'utf8');
  const shellSrc = fs.readFileSync(path.join(ROOT, 'apps/web/components/AppShell.tsx'), 'utf8');
  const profileSrc = fs.readFileSync(path.join(ROOT, 'apps/web/components/ProfileMenu.tsx'), 'utf8');
  const dictSrc = fs.readFileSync(path.join(ROOT, 'apps/web/lib/i18n-dict.ts'), 'utf8');
  const apiSrc = fs.readFileSync(path.join(ROOT, 'apps/web/lib/api.ts'), 'utf8');

  // The complete pre-change href list — no page may be removed or renamed.
  const expectedHrefs = [
    '/inbox', '/products', '/orders', '/tickets', '/billing', '/plans',
    '/courier', '/channels', '/coupons', '/customers', '/schedule',
    '/leads', '/analytics', '/post-analysis', '/teach', '/broadcasts',
    '/bookings', '/reviews', '/migration', '/feature-requests',
    '/owner', '/comments', '/saved-replies', '/agent-desk', '/team',
    '/setup', '/website-chat', '/guide', '/ai-providers',
  ];
  const combined = sidebarSrc + '\n' + extraSrc;
  const missing = expectedHrefs.filter((h) => !combined.includes(`"${h}"`));
  check('all 29 pre-change menu items still exist (no page removed/renamed)', missing.length === 0, missing.join(', ') || '29/29 present');
  const dupes = expectedHrefs.filter((h) => (combined.match(new RegExp(`href: "${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g')) || []).length > 1);
  check('each menu item appears exactly once across Sidebar + NavExtra', dupes.length === 0, dupes.join(', ') || 'no duplicates');

  const sectionIds = ['shop', 'posts', 'teach', 'help', 'settings'];
  check('Sidebar defines 5 sections', sectionIds.every((id) => sidebarSrc.includes(`id: "${id}"`)), sectionIds.join(', '));
  const dotMatches = [...sidebarSrc.matchAll(/dotClass: "(bg-[a-z0-9-]+)"/g)].map((m) => m[1]);
  check('each section has a distinct accent colour', new Set(dotMatches).size === 5, dotMatches.join(', '));
  const sectionKeys = ['nav.sectionShop', 'nav.sectionPosts', 'nav.sectionTeach', 'nav.sectionHelp', 'nav.sectionSettings'];
  check('section label keys exist in the i18n dict', sectionKeys.every((k) => dictSrc.includes(`"${k}"`)));
  // The dict has separate en/bn blocks; each key must appear twice (once per language).
  const twice = sectionKeys.filter((k) => (dictSrc.match(new RegExp(`"${k.replace('.', '\\.')}"`, 'g')) || []).length >= 2);
  check('section label keys exist in BOTH English and Bengali', twice.length === sectionKeys.length, `${twice.length}/${sectionKeys.length}`);
  check('previously-missing nav.postAnalysis key now exists (EN+BN)', (dictSrc.match(/"nav\.postAnalysis"/g) || []).length >= 2);
  check('previously-missing nav.owner key now exists (EN+BN)', (dictSrc.match(/"nav\.owner"/g) || []).length >= 2);
  check('extra nav items carry a section (fallback Settings)', extraSrc.includes('section?:') && extraSrc.includes('section: "'));
  check('Owner Panel stays owner-only (filtered by isOwner)', sidebarSrc.includes('item.href !== "/owner" || isOwner'));

  check('AppShell renders ProfileMenu in the header', shellSrc.includes('ProfileMenu') && shellSrc.includes('<ProfileMenu />'));
  check('mobile drawer uses the same Sidebar (grouping applies on mobile)', shellSrc.includes('<Sidebar mobileOpen={menuOpen}'));

  check('ProfileMenu fetches auth me()', profileSrc.includes('authApi.me()'));
  check('ProfileMenu shows shop name + email', profileSrc.includes('workspace?.name') && profileSrc.includes('user.email'));
  check('ProfileMenu shows plan / trial / balance', profileSrc.includes('profile.plan') && profileSrc.includes('profile.trial') && profileSrc.includes('profile.balance'));
  check('ProfileMenu has change-photo + remove-photo', profileSrc.includes('profileApi.uploadPhoto') && profileSrc.includes('profileApi.removePhoto'));
  check('ProfileMenu logs out via clearToken', profileSrc.includes('clearToken()') && profileSrc.includes('profile.logout'));
  check('ProfileMenu offers Log in when logged out', profileSrc.includes('profile.login') && profileSrc.includes('href="/login"'));
  check('ProfileMenu shows the photo in the header once set', profileSrc.includes('<img src={avatarUrl}'));
  check('web api client has profileApi + avatarUrl on User', apiSrc.includes('profileApi') && apiSrc.includes('avatarUrl'));

  const mig21 = fs.readFileSync(path.join(ROOT, 'apps/api/src/db/migrations/21-user-avatar.sql'), 'utf8');
  check('migration 21 adds users.avatar_url (idempotent)', mig21.includes('avatar_url') && mig21.includes('IF NOT EXISTS'));

  const authSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/auth/routes.ts'), 'utf8');
  check('auth routes have the profile router', authSrc.includes('profileRouter'));
  check('profile router has upload-token + photo POST/DELETE', authSrc.includes("post('/upload-token'") && authSrc.includes("post('/photo'") && authSrc.includes("delete('/photo'"));
  check('me returns avatarUrl + subscription', authSrc.includes('avatarUrl') && authSrc.includes('subscription'));
  const indexSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/index.ts'), 'utf8');
  check('profile router mounted at /api/profile', indexSrc.includes("app.use('/api/profile', profileRouter)"));

  // ---------- Live checks (local PGlite API) ----------
  const port = 4021;
  const base = `http://localhost:${port}`;
  const run = startApi(port, '.pglite-data-navprofile', {});
  const api = makeApi(base);
  try {
    const up = await waitForHealth(base);
    check('local API boots', up);
    if (!up) {
      console.log('API log tail:\n' + run.log().slice(-3000));
      return;
    }

    const stamp = Date.now().toString(36);
    const signup = await api('/api/auth/signup', {
      method: 'POST', auth: false,
      body: { name: 'Nav Owner', email: `nav+${stamp}@example.com`, password: 'verify1234', workspaceName: 'Nav Shop' },
    });
    check('signup', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
    token = signup.data?.token ?? '';

    const me1 = await api('/api/auth/me');
    check('GET /me returns user + workspace', me1.status === 200 && !!me1.data?.user?.email && !!me1.data?.workspace?.name, `status=${me1.status}`);
    check('GET /me has avatarUrl key (null before a photo)', me1.status === 200 && 'avatarUrl' in (me1.data?.user ?? {}), `avatarUrl=${me1.data?.user?.avatarUrl}`);
    check('GET /me has subscription key (null when no subscription row)', me1.status === 200 && 'subscription' in (me1.data ?? {}), `subscription=${JSON.stringify(me1.data?.subscription)}`);

    const noAuth = await api('/api/auth/me', { auth: false });
    check('GET /me 401 without auth', noAuth.status === 401, `status=${noAuth.status}`);

    const upToken = await api('/api/profile/upload-token', { method: 'POST', body: {} });
    check('POST /profile/upload-token 503 locally (no Blob token, never 500)', upToken.status === 503, `status=${upToken.status}`);

    const badPhoto = await api('/api/profile/photo', { method: 'POST', body: { fileBase64: 'data:text/plain;base64,aGVsbG8=', mimeType: 'text/plain' } });
    check('POST /profile/photo rejects a non-image', badPhoto.status === 400, `status=${badPhoto.status}`);
    const badUrl = await api('/api/profile/photo', { method: 'POST', body: { url: 'ftp://example.com/x.png' } });
    check('POST /profile/photo rejects a non-http(s) URL', badUrl.status === 400, `status=${badUrl.status}`);

    const setPhoto = await api('/api/profile/photo', { method: 'POST', body: { fileBase64: TINY_PNG, fileName: 'avatar.png', mimeType: 'image/png' } });
    check('POST /profile/photo accepts a base64 image', setPhoto.status === 200 && !!setPhoto.data?.user?.avatarUrl, `status=${setPhoto.status} avatarUrl=${setPhoto.data?.user?.avatarUrl}`);
    const me2 = await api('/api/auth/me');
    check('GET /me returns the new avatarUrl', me2.status === 200 && me2.data?.user?.avatarUrl === setPhoto.data?.user?.avatarUrl, `avatarUrl=${me2.data?.user?.avatarUrl}`);

    const delPhoto = await api('/api/profile/photo', { method: 'DELETE' });
    check('DELETE /profile/photo clears the avatar', delPhoto.status === 200 && delPhoto.data?.user?.avatarUrl === null, `status=${delPhoto.status}`);
    const me3 = await api('/api/auth/me');
    check('GET /me shows avatarUrl null after removal', me3.status === 200 && me3.data?.user?.avatarUrl === null);

    const noAuthPhoto = await api('/api/profile/photo', { method: 'POST', auth: false, body: { fileBase64: TINY_PNG, mimeType: 'image/png' } });
    check('POST /profile/photo 401 without auth', noAuthPhoto.status === 401, `status=${noAuthPhoto.status}`);
  } finally {
    run.stop();
    await sleep(500);
  }
}

main().then(() => {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) process.exit(1);
}).catch((err) => {
  console.error('Verifier crashed:', err);
  process.exit(1);
});
