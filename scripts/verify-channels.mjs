#!/usr/bin/env node
/**
 * Verification for Channels part 2: Instagram + WhatsApp fixes,
 * TikTok + YouTube connect (new).
 *
 * Local, offline — stub servers stand in for graph.facebook.com,
 * open.tiktokapis.com and googleapis.com; no real Meta/TikTok/Google
 * app is needed and no test message is ever sent.
 *
 * Static checks: scopes (instagram_manage_comments added), profile
 * verification (IG /{ig-id}, WA /{phone-number-id}, TikTok
 * /v2/user/info/, YouTube /youtube/v3/channels?mine=true), WhatsApp
 * Embedded Signup config_id, manual WA connect, TikTok/YouTube login
 * + callback modules, migration 33 (refresh_token_encrypted), Channels
 * page wiring (real TikTok/YouTube cards, no "coming soon"), api client
 * + i18n keys (EN + BN).
 *
 * Phase A (no TikTok/Google keys): tiktok/login + youtube/login → 503
 * with a Bengali message; setup-status reports them unconfigured;
 * instagram login URL carries instagram_manage_comments; whatsapp
 * login URL carries no config_id without WHATSAPP_CONFIG_ID.
 * Phase B (dummy keys + stubs): whatsapp login URL carries config_id;
 * WA manual connect verifies the number (201) and rejects a bad id
 * (400, Bengali, nothing stored); TikTok callback (code → tokens →
 * profile read) stores exactly one 'tiktok' row (refresh token kept
 * encrypted, never leaked); YouTube callback stores exactly one
 * 'youtube' row; Instagram callback verifies the IG profile (connected)
 * and fails honestly (ig_verify_failed, no row) when the profile read
 * fails; a cancelled Instagram login redirects to instagram=error, not
 * facebook=error.
 *
 * Run from the repo root:  node scripts/verify-channels.mjs
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const results = [];
let token = '';
let workspaceId = '';
let userId = '';

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Read one value from apps/api/.env (never printed). */
function envFileValue(name) {
  const envPath = path.join(ROOT, 'apps/api/.env');
  if (!fs.existsSync(envPath)) return '';
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (t.startsWith(`${name}=`)) return t.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');
  }
  return '';
}

/** Minimal HS256 JWT signer (same secret the test API uses). */
function signJwt(secret, payload, expiresInSec = 600) {
  const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ ...payload, iat: now, exp: now + expiresInSec })}`;
  return `${data}.${crypto.createHmac('sha256', secret).update(data).digest('base64url')}`;
}

function decodeJwtPayload(tok) {
  try {
    return JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function makeApi(base) {
  return async function api(path, { method = 'GET', body, auth = true, redirect = 'follow', headers = {} } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      redirect,
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
    return { status: res.status, data, text, location: res.headers.get('location') };
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

async function setupWorkspace(api, stamp) {
  const email = `ch2+${stamp}@example.com`;
  const signup = await api('/api/auth/signup', {
    method: 'POST', auth: false,
    body: { name: 'CH2 Owner', email, password: 'verify1234', workspaceName: 'CH2 Shop' },
  });
  check('signup', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
  token = signup.data?.token ?? '';
  workspaceId = signup.data?.workspace?.id ?? '';
  userId = signup.data?.user?.id ?? '';
}

async function main() {
  const jwtSecret = envFileValue('JWT_SECRET');
  check('JWT_SECRET available for test signing (from apps/api/.env)', jwtSecret.length > 0);

  // ================= Static checks =================
  const mig33 = fs.readFileSync(path.join(ROOT, 'apps/api/src/db/migrations/33-channels-refresh-tokens.sql'), 'utf8');
  check('migration 33 adds refresh_token_encrypted (idempotent)', mig33.includes('refresh_token_encrypted') && mig33.includes('IF NOT EXISTS'));

  const cfgSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/config/index.ts'), 'utf8');
  check('config has TikTok client key/secret + redirect URI (env only)', cfgSrc.includes('TIKTOK_CLIENT_KEY') && cfgSrc.includes('TIKTOK_CLIENT_SECRET') && cfgSrc.includes('TIKTOK_OAUTH_REDIRECT_URI'));
  check('config has Google client id/secret + redirect URI (env only)', cfgSrc.includes('GOOGLE_CLIENT_ID') && cfgSrc.includes('GOOGLE_CLIENT_SECRET') && cfgSrc.includes('GOOGLE_OAUTH_REDIRECT_URI'));
  check('config has WhatsApp Embedded Signup config id (env only)', cfgSrc.includes('WHATSAPP_CONFIG_ID'));
  check('no OAuth secret is hardcoded in config', !cfgSrc.match(/TIKTOK_CLIENT_SECRET\s*:\s*['"][^'"]+['"]/) || cfgSrc.includes("process.env.TIKTOK_CLIENT_SECRET"));

  const metaSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/meta-oauth.ts'), 'utf8');
  check('meta-oauth has graphBase() override (offline stub support)', metaSrc.includes('export function graphBase()'));
  check('meta-oauth loginUrl supports config_id (Embedded Signup)', metaSrc.includes("configId") && metaSrc.includes("searchParams.set('config_id'"));
  check('createOAuthChannel stores a refresh token + custom expiry', metaSrc.includes('refreshToken') && metaSrc.includes('refresh_token_encrypted') && metaSrc.includes('expiresAt'));

  const igSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/instagram-oauth.ts'), 'utf8');
  check('instagram login requests instagram_manage_comments too', igSrc.includes('instagram_manage_comments'));
  check('instagram verifies the profile (GET /{ig-id}?fields=id,username,profile_picture_url)', igSrc.includes('fetchInstagramProfile') && igSrc.includes('profile_picture_url'));
  check('instagram completer fails honestly when the profile read fails', igSrc.includes("reason: 'ig_verify_failed'"));

  const waSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/whatsapp-oauth.ts'), 'utf8');
  check('whatsapp login passes config_id when configured', waSrc.includes('config.whatsapp.configId'));
  check('whatsapp has a manual Cloud API connect (POST /manual)', waSrc.includes("'/manual'"));
  check('whatsapp manual connect verifies the number first (GET /{phone-number-id})', waSrc.includes('fetchPhoneNumber') && waSrc.includes('display_phone_number'));
  check('whatsapp manual connect fails in Bengali on a bad number/token', waSrc.includes('যাচাই করা যায়নি'));
  check('whatsapp manual connect never sends a test message', !waSrc.includes('/messages'));

  const fbSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/facebook-oauth.ts'), 'utf8');
  check('shared callback redirects a cancelled login to the right channel (not always facebook)', fbSrc.includes('cancelled?.channel') && fbSrc.includes("reason: 'cancelled'"));

  const ttSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/tiktok-oauth.ts'), 'utf8');
  check('tiktok module exists: authorize URL with user.info.basic', ttSrc.includes('/v2/auth/authorize/') && ttSrc.includes('user.info.basic'));
  check('tiktok exchanges the code at /v2/oauth/token/', ttSrc.includes('/v2/oauth/token/') && ttSrc.includes('authorization_code'));
  check('tiktok verifies via GET /v2/user/info/', ttSrc.includes('/v2/user/info/') && ttSrc.includes('fetchTikTokProfile'));
  check('tiktok login fails 503 in Bengali when keys are missing', ttSrc.includes('status(503)') && ttSrc.includes('TikTok এখনো সেটআপ হয়নি'));
  check('tiktok stores the refresh token + expiry from the token response', ttSrc.includes('refreshToken') && ttSrc.includes('expires_in'));

  const ytSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/youtube-oauth.ts'), 'utf8');
  check('youtube module exists: Google authorize URL with youtube.readonly + offline access', ytSrc.includes('accounts.google.com/o/oauth2/v2/auth') && ytSrc.includes('youtube.readonly') && ytSrc.includes("access_type', 'offline"));
  check('youtube exchanges the code at the Google token endpoint', ytSrc.includes('exchangeCode') && ytSrc.includes('grant_type'));
  check('youtube verifies via GET /youtube/v3/channels?mine=true', ytSrc.includes('/youtube/v3/channels') && ytSrc.includes("mine', 'true"));
  check('youtube login fails 503 in Bengali when keys are missing', ytSrc.includes('status(503)') && ytSrc.includes('YouTube এখনো সেটআপ হয়নি'));
  check('youtube stores the refresh token + expiry from the token response', ytSrc.includes('refreshToken') && ytSrc.includes('expires_in'));

  const routesSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/routes.ts'), 'utf8');
  check('channels router accepts platform youtube', routesSrc.includes("'youtube'"));
  check('channels router exposes GET /setup-status (booleans only)', routesSrc.includes("'/setup-status'") && routesSrc.includes('tiktokConfigured') && routesSrc.includes('youtubeConfigured'));

  const indexSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/index.ts'), 'utf8');
  check('tiktok + youtube routers mounted before the channels router', indexSrc.includes('tiktokOAuthRouter') && indexSrc.includes('youtubeOAuthRouter') && indexSrc.indexOf('tiktokOAuthRouter') < indexSrc.indexOf("app.use('/api/channels', channelsRouter)") && indexSrc.indexOf('youtubeOAuthRouter') < indexSrc.indexOf("app.use('/api/channels', channelsRouter)"));

  const pageSrc = fs.readFileSync(path.join(ROOT, 'apps/web/app/channels/page.tsx'), 'utf8');
  check('channels page has real TikTok + YouTube cards (no SOON_CARDS, no coming soon)', pageSrc.includes('"tiktok"') && pageSrc.includes('"youtube"') && !pageSrc.includes('SOON_CARDS'));
  check('channels page calls tiktokLogin + youtubeLogin', pageSrc.includes('salesChannelsApi.tiktokLogin') && pageSrc.includes('salesChannelsApi.youtubeLogin'));
  check('channels page handles tiktok/youtube redirect results', pageSrc.includes('tiktokConnected') && pageSrc.includes('youtubeConnected'));
  check('channels page shows the setup-needed hint for unconfigured TikTok/YouTube', pageSrc.includes('tiktokSetupNeeded') && pageSrc.includes('youtubeSetupNeeded'));
  check('channels page has the WhatsApp manual connect form', pageSrc.includes('whatsappManualConnect') && pageSrc.includes('whatsappManualTitle'));
  check('channels page still has the Meta switch-account hint only for Meta kinds', pageSrc.includes('META_KINDS'));

  const apiClientSrc = fs.readFileSync(path.join(ROOT, 'apps/web/lib/api.ts'), 'utf8');
  check('api client has tiktok/youtube login + whatsapp manual + setup-status', ['tiktokLogin', 'youtubeLogin', 'whatsappManualConnect', 'setupStatus'].every((f) => apiClientSrc.includes(f)));

  const dictSrc = fs.readFileSync(path.join(ROOT, 'apps/web/lib/i18n-dict.ts'), 'utf8');
  check('i18n has TikTok/YouTube keys (EN + BN)', dictSrc.includes('"channels.tiktokButton": "Connect TikTok"') && dictSrc.includes('"channels.tiktokButton": "TikTok যুক্ত করুন"') && dictSrc.includes('"channels.youtubeButton": "Connect YouTube"') && dictSrc.includes('"channels.youtubeButton": "YouTube যুক্ত করুন"'));
  check('i18n has verify_failed + setup-needed messages (EN + BN)', dictSrc.includes('oauthErrorVerifyFailed') && dictSrc.includes('tiktokSetupNeeded') && dictSrc.includes('youtubeSetupNeeded'));

  // ================= Phase A: no TikTok/Google keys =================
  const stampA = Date.now();
  const portA = 4016;
  const apiA = makeApi(`http://localhost:${portA}`);
  const runA = startApi(portA, '.pglite-data-ch2-a', { META_APP_ID: 'dummy-app-id', META_APP_SECRET: 'dummy-secret' });
  process.on('exit', runA.stop);
  try {
    const up = await waitForHealth(`http://localhost:${portA}`);
    check('Phase A API starts (health)', up, up ? '' : runA.log().slice(-500));
    if (!up) return;
    await setupWorkspace(apiA, stampA);

    const ttLogin = await apiA('/api/channels/tiktok/login');
    check('tiktok login without keys → 503 with a Bengali message', ttLogin.status === 503 && typeof ttLogin.data?.error === 'string' && ttLogin.data.error.includes('TikTok এখনো সেটআপ হয়নি'), `status=${ttLogin.status}, error=${ttLogin.data?.error ?? ''}`);
    const ytLogin = await apiA('/api/channels/youtube/login');
    check('youtube login without keys → 503 with a Bengali message', ytLogin.status === 503 && typeof ytLogin.data?.error === 'string' && ytLogin.data.error.includes('YouTube এখনো সেটআপ হয়নি'), `status=${ytLogin.status}, error=${ytLogin.data?.error ?? ''}`);

    const setup = await apiA('/api/channels/setup-status');
    check('setup-status reports tiktok/youtube unconfigured, meta configured', setup.status === 200 && setup.data?.tiktokConfigured === false && setup.data?.youtubeConfigured === false && setup.data?.metaConfigured === true, JSON.stringify(setup.data));

    const igLogin = await apiA('/api/channels/instagram/login');
    const igUrl = igLogin.data?.url ?? '';
    check('instagram login URL carries instagram_manage_comments', igLogin.status === 200 && igUrl.includes('instagram_manage_comments') && igUrl.includes('instagram_basic') && igUrl.includes('instagram_manage_messages'), igUrl.slice(0, 200));
    const waLogin = await apiA('/api/channels/whatsapp/login');
    const waUrl = waLogin.data?.url ?? '';
    check('whatsapp login URL has no config_id without WHATSAPP_CONFIG_ID', waLogin.status === 200 && !waUrl.includes('config_id'), waUrl.slice(0, 200));
  } finally {
    runA.stop();
    await sleep(2000);
  }

  // ================= Phase B: dummy keys + stub servers =================
  // One stub stands in for Graph + TikTok + Google, routed by path.
  const stubHits = [];
  const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { parsed = null; }
      const u = new URL(req.url, 'http://stub');
      stubHits.push({ method: req.method, path: u.pathname, body });
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const form = new URLSearchParams(body || '');
      // --- Graph ---
      if (req.method === 'POST' && u.pathname === '/v21.0/oauth/access_token') {
        // The code keys the fixture: ig-code-fail yields a distinct token
        // so /me/accounts can return only the page whose IG profile read
        // fails (ig-222) — that drives the real ig_verify_failed path.
        if (form.get('grant_type') === 'fb_exchange_token') {
          return send(200, { access_token: form.get('fb_exchange_token') === 'tok-short-fail' ? 'tok-long-fail' : 'tok-long-lived' });
        }
        return send(200, { access_token: form.get('code') === 'ig-code-fail' ? 'tok-short-fail' : 'tok-short' });
      }
      if (req.method === 'GET' && u.pathname === '/v21.0/me') {
        return send(200, u.searchParams.get('fields') === 'id' ? { id: 'fb-user-1' } : { name: 'Test User' });
      }
      if (req.method === 'GET' && u.pathname === '/v21.0/me/accounts') {
        // The fail-token sees only page-ig-2 (IG profile read 400s).
        if (req.headers.authorization === 'Bearer tok-long-fail') {
          return send(200, { data: [
            { id: 'page-ig-2', name: 'Test Page 2', category: 'Clothing', picture: { data: { url: '' } }, access_token: 'tok-page-2' },
          ] });
        }
        // Default: exactly ONE linked Page, so the completer takes the
        // direct-connect path (the multi-page picker is covered by the
        // session-based tests in verify-channels-oauth.mjs).
        return send(200, { data: [
          { id: 'page-ig-1', name: 'Test Page', category: 'Clothing', picture: { data: { url: 'https://example.com/p.jpg' } }, access_token: 'tok-page-1' },
        ] });
      }
      if (req.method === 'GET' && u.pathname === '/v21.0/page-ig-1') {
        return send(200, { instagram_business_account: { id: 'ig-111', username: 'test.ig', profile_picture_url: 'https://example.com/ig.jpg' } });
      }
      if (req.method === 'GET' && u.pathname === '/v21.0/page-ig-2') {
        return send(200, { instagram_business_account: { id: 'ig-222', username: 'test.ig2', profile_picture_url: '' } });
      }
      if (req.method === 'GET' && u.pathname === '/v21.0/ig-111') {
        return send(200, { id: 'ig-111', username: 'test.ig', profile_picture_url: 'https://example.com/ig.jpg' });
      }
      if (req.method === 'GET' && u.pathname === '/v21.0/ig-222') {
        return send(400, { error: { message: 'Unsupported get request.', code: 100 } });
      }
      if (req.method === 'GET' && u.pathname === '/v21.0/pn-manual-1') {
        return send(200, { id: 'pn-manual-1', display_phone_number: '+880 1911-000001', verified_name: 'Test Shop' });
      }
      if (req.method === 'GET' && u.pathname === '/v21.0/pn-bad') {
        return send(400, { error: { message: 'Unsupported get request.', code: 100 } });
      }
      if (req.method === 'POST' && u.pathname === '/v21.0/page-ig-1/subscribed_apps') {
        return send(200, { success: true });
      }
      // --- TikTok ---
      if (req.method === 'POST' && u.pathname === '/v2/oauth/token/') {
        return send(200, { access_token: 'tok-tt-access', refresh_token: 'tok-tt-refresh', open_id: 'tt-open-1', expires_in: 86400, scope: 'user.info.basic' });
      }
      if (req.method === 'GET' && u.pathname === '/v2/user/info/') {
        if (req.headers.authorization !== 'Bearer tok-tt-access') return send(401, { error: { code: 'invalid_token' } });
        return send(200, { data: { user: { open_id: 'tt-open-1', display_name: 'EA Islamic TV', avatar_url: 'https://example.com/tt.jpg' } } });
      }
      // --- Google ---
      if (req.method === 'POST' && u.pathname === '/token') {
        return send(200, { access_token: 'tok-yt-access', refresh_token: 'tok-yt-refresh', expires_in: 3600, token_type: 'Bearer' });
      }
      if (req.method === 'GET' && u.pathname === '/youtube/v3/channels') {
        if (req.headers.authorization !== 'Bearer tok-yt-access') return send(401, { error: { message: 'Unauthorized' } });
        return send(200, { items: [{ id: 'UC-test-1', snippet: { title: 'EA Islamic TV', thumbnails: { default: { url: 'https://example.com/yt.jpg' } } } }] });
      }
      return send(404, { error: { message: `stub: no route ${req.method} ${u.pathname}` } });
    });
  });
  const stubPort = 4020;
  await new Promise((resolve) => stub.listen(stubPort, resolve));

  const stampB = Date.now();
  const portB = 4017;
  const apiB = makeApi(`http://localhost:${portB}`);
  const stubBase = `http://localhost:${stubPort}`;
  const runB = startApi(portB, '.pglite-data-ch2-b', {
    META_APP_ID: 'dummy-app-id',
    META_APP_SECRET: 'dummy-secret',
    META_GRAPH_BASE_URL: `${stubBase}/v21.0`,
    WHATSAPP_CONFIG_ID: 'wa-config-1',
    TIKTOK_CLIENT_KEY: 'dummy-tt-key',
    TIKTOK_CLIENT_SECRET: 'dummy-tt-secret',
    TIKTOK_API_BASE_URL: stubBase,
    TIKTOK_AUTH_BASE_URL: stubBase,
    TIKTOK_OAUTH_REDIRECT_URI: `http://localhost:${portB}/api/channels/tiktok/callback`,
    GOOGLE_CLIENT_ID: 'dummy-gg-id',
    GOOGLE_CLIENT_SECRET: 'dummy-gg-secret',
    GOOGLE_OAUTH_TOKEN_URL: `${stubBase}/token`,
    GOOGLE_API_BASE_URL: stubBase,
    GOOGLE_OAUTH_REDIRECT_URI: `http://localhost:${portB}/api/channels/youtube/callback`,
  });
  process.on('exit', runB.stop);
  try {
    const up = await waitForHealth(`http://localhost:${portB}`);
    check('Phase B API starts (health)', up, up ? '' : runB.log().slice(-500));
    if (!up) return;
    await setupWorkspace(apiB, stampB);

    const setup = await apiB('/api/channels/setup-status');
    check('setup-status reports everything configured (dummy keys)', setup.status === 200 && setup.data?.tiktokConfigured === true && setup.data?.youtubeConfigured === true && setup.data?.whatsappConfigIdConfigured === true, JSON.stringify(setup.data));

    // ---- WhatsApp login carries config_id; TikTok/YouTube login URLs build ----
    const waLogin = await apiB('/api/channels/whatsapp/login');
    check('whatsapp login URL carries config_id=wa-config-1 (Embedded Signup)', waLogin.status === 200 && (waLogin.data?.url ?? '').includes('config_id=wa-config-1'), (waLogin.data?.url ?? '').slice(0, 220));
    const ttLogin = await apiB('/api/channels/tiktok/login');
    const ttUrl = ttLogin.data?.url ?? '';
    check('tiktok login → 200 authorize URL (client_key, user.info.basic, redirect_uri)', ttLogin.status === 200 && ttUrl.includes('/v2/auth/authorize/') && ttUrl.includes('client_key=dummy-tt-key') && ttUrl.includes('user.info.basic'), ttUrl.slice(0, 220));
    const ttState = decodeJwtPayload(new URL(ttUrl).searchParams.get('state') ?? '');
    check('tiktok state JWT carries purpose=tiktok_oauth + workspace', ttState?.purpose === 'tiktok_oauth' && ttState?.workspaceId === workspaceId, JSON.stringify(ttState));
    const ytLogin = await apiB('/api/channels/youtube/login');
    const ytUrl = ytLogin.data?.url ?? '';
    check('youtube login → 200 Google authorize URL (youtube.readonly, offline)', ytLogin.status === 200 && ytUrl.includes('accounts.google.com/o/oauth2/v2/auth') && decodeURIComponent(ytUrl).includes('youtube.readonly') && ytUrl.includes('access_type=offline'), ytUrl.slice(0, 220));
    const ytState = decodeJwtPayload(new URL(ytUrl).searchParams.get('state') ?? '');
    check('youtube state JWT carries purpose=youtube_oauth + workspace', ytState?.purpose === 'youtube_oauth' && ytState?.workspaceId === workspaceId, JSON.stringify(ytState));

    // ---- WhatsApp manual connect (verified) ----
    const waManualBad = await apiB('/api/channels/whatsapp/manual', { method: 'POST', body: { phoneNumberId: 'pn-bad', token: 'tok-manual-bad' } });
    check('whatsapp manual with an unverifiable number → 400 Bengali, nothing stored', waManualBad.status === 400 && typeof waManualBad.data?.error === 'string' && waManualBad.data.error.includes('যাচাই করা যায়নি'), `status=${waManualBad.status}, error=${waManualBad.data?.error ?? ''}`);
    const waManualNoToken = await apiB('/api/channels/whatsapp/manual', { method: 'POST', body: { phoneNumberId: 'pn-manual-1' } });
    check('whatsapp manual without a token → 400', waManualNoToken.status === 400, `status=${waManualNoToken.status}`);
    const waManual = await apiB('/api/channels/whatsapp/manual', { method: 'POST', body: { phoneNumberId: 'pn-manual-1', token: 'tok-manual-good', wabaId: 'waba-manual-1' } });
    check('whatsapp manual with a verified number → 201 whatsapp channel', waManual.status === 201 && waManual.data?.channel?.platform === 'whatsapp' && waManual.data?.channel?.external_id === 'pn-manual-1', `status=${waManual.status}, channel=${JSON.stringify(waManual.data?.channel)}`);
    const waManualHit = stubHits.find((h) => h.path === '/v21.0/pn-manual-1');
    check('whatsapp manual verified the number via Graph before storing', !!waManualHit, `hits=${stubHits.map((h) => h.path).join(',')}`);

    // ---- TikTok callback (code → tokens → profile read → stored) ----
    // Fresh workspace: the trial plan allows 1 channel, and the WA manual
    // row above already uses workspace 1's slot.
    await setupWorkspace(apiB, stampB + 10);
    const ttStateCb = signJwt(jwtSecret, { purpose: 'tiktok_oauth', workspaceId, userId }, 600);
    const ttCb = await apiB(`/api/channels/tiktok/callback?code=tt-code-1&state=${encodeURIComponent(ttStateCb)}`, { auth: false, redirect: 'manual' });
    check('tiktok callback → redirect tiktok=connected&name=EA Islamic TV', ttCb.status >= 300 && ttCb.status < 400 && (ttCb.location ?? '').includes('tiktok=connected') && (ttCb.location ?? '').includes('name=EA+Islamic+TV'), `status=${ttCb.status}, location=${ttCb.location ?? ''}`);
    const ttBadState = await apiB('/api/channels/tiktok/callback?code=x&state=bogus', { auth: false, redirect: 'manual' });
    check('tiktok callback with a bad state → redirect bad_state', (ttBadState.location ?? '').includes('reason=bad_state'), `location=${ttBadState.location ?? ''}`);
    const channelsAfterTt = await apiB('/api/channels');
    const ttRow = (channelsAfterTt.data?.channels ?? []).find((c) => c.platform === 'tiktok');
    check('GET /api/channels shows the TikTok row (open_id + display name + avatar)', !!ttRow && ttRow.external_id === 'tt-open-1' && ttRow.display_name === 'EA Islamic TV' && ttRow.picture_url === 'https://example.com/tt.jpg', JSON.stringify(ttRow));
    check('TikTok row expiry is ~24h out (from expires_in)', !!ttRow?.token_expires_at && new Date(ttRow.token_expires_at).getTime() > Date.now() + 20 * 60 * 60 * 1000 && new Date(ttRow.token_expires_at).getTime() < Date.now() + 25 * 60 * 60 * 1000, `token_expires_at=${ttRow?.token_expires_at}`);
    check('GET /api/channels never leaks TikTok tokens', !channelsAfterTt.text.includes('tok-tt-access') && !channelsAfterTt.text.includes('tok-tt-refresh'));
    const ttCb2 = await apiB(`/api/channels/tiktok/callback?code=tt-code-2&state=${encodeURIComponent(signJwt(jwtSecret, { purpose: 'tiktok_oauth', workspaceId, userId }, 600))}`, { auth: false, redirect: 'manual' });
    check('tiktok reconnect → still connected (updates, no second row)', (ttCb2.location ?? '').includes('tiktok=connected'), `location=${ttCb2.location ?? ''}`);
    const channelsAfterTt2 = await apiB('/api/channels');
    check('tiktok reconnect created NO second row', (channelsAfterTt2.data?.channels ?? []).filter((c) => c.platform === 'tiktok').length === 1);

    // ---- YouTube callback (code → tokens → channel read → stored) ----
    // Fresh workspace again (trial plan: 1 channel).
    await setupWorkspace(apiB, stampB + 20);
    const ytStateCb = signJwt(jwtSecret, { purpose: 'youtube_oauth', workspaceId, userId }, 600);
    const ytCb = await apiB(`/api/channels/youtube/callback?code=yt-code-1&state=${encodeURIComponent(ytStateCb)}`, { auth: false, redirect: 'manual' });
    check('youtube callback → redirect youtube=connected&name=EA Islamic TV', ytCb.status >= 300 && ytCb.status < 400 && (ytCb.location ?? '').includes('youtube=connected') && (ytCb.location ?? '').includes('name=EA+Islamic+TV'), `status=${ytCb.status}, location=${ytCb.location ?? ''}`);
    const channelsAfterYt = await apiB('/api/channels');
    const ytRow = (channelsAfterYt.data?.channels ?? []).find((c) => c.platform === 'youtube');
    check('GET /api/channels shows the YouTube row (channel id + title + thumbnail)', !!ytRow && ytRow.external_id === 'UC-test-1' && ytRow.display_name === 'EA Islamic TV' && ytRow.picture_url === 'https://example.com/yt.jpg', JSON.stringify(ytRow));
    check('YouTube row expiry is ~1h out (from expires_in)', !!ytRow?.token_expires_at && new Date(ytRow.token_expires_at).getTime() > Date.now() && new Date(ytRow.token_expires_at).getTime() < Date.now() + 2 * 60 * 60 * 1000, `token_expires_at=${ytRow?.token_expires_at}`);
    check('GET /api/channels never leaks YouTube tokens', !channelsAfterYt.text.includes('tok-yt-access') && !channelsAfterYt.text.includes('tok-yt-refresh'));
    check('tiktok + youtube callbacks really exchanged the code and read the profile/channel (stub hits)', stubHits.some((h) => h.method === 'POST' && h.path === '/v2/oauth/token/') && stubHits.some((h) => h.path === '/v2/user/info/') && stubHits.some((h) => h.method === 'POST' && h.path === '/token') && stubHits.some((h) => h.path === '/youtube/v3/channels'));

    // ---- Instagram callback (shared Meta callback, profile verified) ----
    // Fresh workspace: trial plan = 1 channel.
    await setupWorkspace(apiB, stampB + 30);
    const igState = signJwt(jwtSecret, { purpose: 'facebook_oauth', channel: 'instagram', userId, workspaceId }, 600);
    const igCb = await apiB(`/api/channels/facebook/callback?code=ig-code-1&state=${encodeURIComponent(igState)}`, { auth: false, redirect: 'manual' });
    check('instagram callback → redirect instagram=connected&name=test.ig', igCb.status >= 300 && igCb.status < 400 && (igCb.location ?? '').includes('instagram=connected') && decodeURIComponent(igCb.location ?? '').includes('test.ig'), `status=${igCb.status}, location=${igCb.location ?? ''}`);
    check('instagram callback read the IG profile (GET /ig-111) before storing', stubHits.some((h) => h.path === '/v21.0/ig-111'), `hits=${stubHits.map((h) => h.path).join(',')}`);
    const igChannels = await apiB('/api/channels');
    const igRow = (igChannels.data?.channels ?? []).find((c) => c.platform === 'instagram');
    check('GET /api/channels shows the Instagram row (username + picture + source page)', !!igRow && igRow.external_id === 'ig-111' && igRow.display_name === 'test.ig' && igRow.source_id === 'page-ig-1', JSON.stringify(igRow));

    // ---- Instagram profile-read failure → honest error, no row ----
    // Fresh workspace; the stub answers ig-code-fail with the fail token,
    // whose only Page links ig-222 — and GET /ig-222 is a 400.
    await setupWorkspace(apiB, stampB + 40);
    const igFailState = signJwt(jwtSecret, { purpose: 'facebook_oauth', channel: 'instagram', userId, workspaceId }, 600);
    const igFailCb = await apiB(`/api/channels/facebook/callback?code=ig-code-fail&state=${encodeURIComponent(igFailState)}`, { auth: false, redirect: 'manual' });
    check('instagram callback with an unreadable profile → redirect instagram=error&reason=ig_verify_failed', (igFailCb.location ?? '').includes('instagram=error') && (igFailCb.location ?? '').includes('reason=ig_verify_failed'), `status=${igFailCb.status}, location=${igFailCb.location ?? ''}`);
    const igFailChannels = await apiB('/api/channels');
    check('failed instagram verify stored NO channel row', (igFailChannels.data?.channels ?? []).filter((c) => c.platform === 'instagram').length === 0, JSON.stringify(igFailChannels.data?.channels));

    // ---- Cancelled Instagram login redirects to instagram=error ----
    const igCancelState = signJwt(jwtSecret, { purpose: 'facebook_oauth', channel: 'instagram', userId, workspaceId }, 600);
    const igCancel = await apiB(`/api/channels/facebook/callback?error=access_denied&state=${encodeURIComponent(igCancelState)}`, { auth: false, redirect: 'manual' });
    check('cancelled instagram login → redirect instagram=error&reason=cancelled (not facebook)', (igCancel.location ?? '').includes('instagram=error') && (igCancel.location ?? '').includes('reason=cancelled'), `location=${igCancel.location ?? ''}`);
  } finally {
    runB.stop();
    try { stub.close(); } catch { /* already closed */ }
    await sleep(2000);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — ${failed.length} FAILED` : ''}`);
  if (failed.length > 0) {
    console.log('Failed checks:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('verifier crashed:', err);
  process.exit(1);
});
