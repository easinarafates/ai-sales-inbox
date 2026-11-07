#!/usr/bin/env node
/**
 * Verification for "Login with Facebook" (Channels page).
 * Local, offline — no calls to graph.facebook.com, no Meta app needed.
 *
 * Phase A (no META_APP_ID): login → 503; callback without/tampered state →
 * redirect with reason=bad_state; pages/connect with a bad session → 401;
 * an OAuth `state` token must NOT work as an API auth token.
 * Phase B (dummy META_APP_ID/SECRET): login → 200 with a real
 * facebook.com dialog URL (client_id, scope, state JWT); the happy path
 * with a self-minted page-pick session JWT: pages list strips tokens,
 * connect creates exactly one 'messenger' channel row with the token
 * encrypted (GET /api/channels shows it and never leaks the token),
 * reconnect of the same page → 201 (refreshes tokens, no second row),
 * second page → 402 (trial plan: 1 channel).
 *
 * Run from the repo root:  node scripts/verify-facebook-oauth.mjs
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
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

function decodeJwtPayload(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function makeApi(base) {
  return async function api(path, { method = 'GET', body, auth = true, redirect = 'follow' } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      redirect,
      headers: {
        'Content-Type': 'application/json',
        ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
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
      DATABASE_URL: `pglite://./${dataDir}`,
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

async function setupWorkspace(api, stamp) {
  const email = `fb-oauth+${stamp}@example.com`;
  const signup = await api('/api/auth/signup', {
    method: 'POST', auth: false,
    body: { name: 'FB Owner', email, password: 'verify1234', workspaceName: 'FB Shop' },
  });
  check('signup', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
  token = signup.data?.token ?? '';
  workspaceId = signup.data?.workspace?.id ?? '';
  userId = signup.data?.user?.id ?? '';
}

async function main() {
  const jwtSecret = envFileValue('JWT_SECRET');
  check('JWT_SECRET available for test signing (from apps/api/.env)', jwtSecret.length > 0);

  // ---------- Static checks ----------
  const oauthSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/facebook-oauth.ts'), 'utf8');
  const metaSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/meta-oauth.ts'), 'utf8');
  check('facebook-oauth router exists', oauthSrc.length > 0);
  check('router has login/callback/pages/connect', ['/login', '/callback', '/pages', '/connect'].every((p) => oauthSrc.includes(`'${p}'`)));
  check('shared module uses Graph v21.0 + router has required scopes', metaSrc.includes("v21.0") && ['pages_show_list', 'pages_messaging', 'pages_manage_metadata', 'pages_read_engagement', 'pages_manage_posts', 'pages_manage_engagement'].every((s) => oauthSrc.includes(s)));
  check('shared module never puts a token in a URL (Bearer header / POST body only)', !metaSrc.includes('access_token=${') && !metaSrc.includes('fb_exchange_token=${'));
  check('shared callback dispatches by state channel (instagram/whatsapp)', oauthSrc.includes('completeInstagramOAuth') && oauthSrc.includes('completeWhatsappOAuth'));
  check('no_pages redirect carries the account name', oauthSrc.includes('fetchMeName') && oauthSrc.includes("reason: 'no_pages'") && oauthSrc.includes('account'));
  const indexSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/index.ts'), 'utf8');
  check('facebook router mounted before channels router', indexSrc.indexOf("facebookOAuthRouter") !== -1 && indexSrc.indexOf("facebookOAuthRouter") < indexSrc.indexOf("app.use('/api/channels', channelsRouter)"));
  const migSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/db/migrations/13-facebook-oauth.sql'), 'utf8');
  check('migration 13 adds token_expires_at + picture_url', migSrc.includes('token_expires_at') && migSrc.includes('picture_url') && migSrc.includes('IF NOT EXISTS'));
  const pageSrc = fs.readFileSync(path.join(ROOT, 'apps/web/app/channels/page.tsx'), 'utf8');
  check('channels page has Login with Facebook button', pageSrc.includes('Login with Facebook') && pageSrc.includes('salesChannelsApi.facebookLogin'));
  check('channels page has a page picker', pageSrc.includes('facebookPickTitle') && pageSrc.includes('facebookConnect('));
  check('channels page no longer sends facebook_page (no option / mapping for it)', !pageSrc.includes('value: "facebook_page"') && !pageSrc.includes('facebook_page:') && !pageSrc.includes("api: \"facebook_page\""));
  check('manual form maps website → webchat', pageSrc.includes("api: \"webchat\""));
  const dictSrc = fs.readFileSync(path.join(ROOT, 'apps/web/lib/i18n-dict.ts'), 'utf8');
  check('i18n has facebook keys (EN + BN)', dictSrc.includes('"channels.facebookButton": "Login with Facebook"') && dictSrc.includes('"channels.facebookButton": "Facebook দিয়ে লগইন করুন"'));
  const apiClientSrc = fs.readFileSync(path.join(ROOT, 'apps/web/lib/api.ts'), 'utf8');
  check('api client has facebookLogin/facebookPages/facebookConnect', ['facebookLogin', 'facebookPages', 'facebookConnect'].every((f) => apiClientSrc.includes(f)));

  // ================= Phase A: no Meta app =================
  const stampA = Date.now();
  const portA = 4004;
  const apiA = makeApi(`http://localhost:${portA}`);
  const runA = startApi(portA, '.pglite-data-fb-a', { META_APP_ID: '', META_APP_SECRET: '' });
  process.on('exit', runA.stop);
  try {
    const up = await waitForHealth(`http://localhost:${portA}`);
    check('Phase A API starts (health)', up, up ? '' : runA.log().slice(-500));
    if (!up) return;
    await setupWorkspace(apiA, stampA);

    const login = await apiA('/api/channels/facebook/login');
    check('login without META_APP_ID → 503', login.status === 503, `status=${login.status}`);
    check('503 message says the Meta app is not set up', typeof login.data?.error === 'string' && login.data.error.includes('META_APP_ID'), login.data?.error ?? '');

    const noState = await apiA('/api/channels/facebook/callback', { auth: false, redirect: 'manual' });
    check('callback without state → redirect bad_state', noState.status >= 300 && noState.status < 400 && (noState.location ?? '').includes('facebook=error') && (noState.location ?? '').includes('reason=bad_state'), `status=${noState.status}, location=${noState.location ?? ''}`);
    const badState = await apiA('/api/channels/facebook/callback?state=tampered&code=x', { auth: false, redirect: 'manual' });
    check('callback with tampered state → redirect bad_state', (badState.location ?? '').includes('reason=bad_state'), `location=${badState.location ?? ''}`);

    // An OAuth `state` token must never work as an API auth token.
    const stateToken = signJwt(jwtSecret, { userId, workspaceId, purpose: 'facebook_oauth' }, 600);
    const savedToken = token;
    token = stateToken;
    const asAuth = await apiA('/api/channels');
    check('state JWT rejected as auth token → 401', asAuth.status === 401, `status=${asAuth.status}`);
    token = savedToken;

    const badPages = await apiA('/api/channels/facebook/pages?session=bogus');
    check('pages with bad session → 401', badPages.status === 401, `status=${badPages.status}`);
    const badConnect = await apiA('/api/channels/facebook/connect', { method: 'POST', body: { session: 'bogus', pageId: '1' } });
    check('connect with bad session → 401', badConnect.status === 401, `status=${badConnect.status}`);
  } finally {
    runA.stop();
    await sleep(2000);
  }

  // ================= Phase B: dummy Meta app =================
  const stampB = Date.now();
  const portB = 4005;
  const apiB = makeApi(`http://localhost:${portB}`);
  const runB = startApi(portB, '.pglite-data-fb-b', { META_APP_ID: 'dummy-app-id', META_APP_SECRET: 'dummy-secret' });
  process.on('exit', runB.stop);
  try {
    const up = await waitForHealth(`http://localhost:${portB}`);
    check('Phase B API starts (health)', up, up ? '' : runB.log().slice(-500));
    if (!up) return;
    await setupWorkspace(apiB, stampB);

    const login = await apiB('/api/channels/facebook/login');
    const url = login.data?.url ?? '';
    check('login with META_APP_ID → 200 + dialog URL', login.status === 200 && url.startsWith('https://www.facebook.com/v21.0/dialog/oauth'), `status=${login.status}, url=${url.slice(0, 80)}`);
    check('dialog URL has client_id + scopes + response_type=code', url.includes('client_id=dummy-app-id') && url.includes('pages_show_list') && url.includes('pages_messaging') && url.includes('pages_manage_metadata') && url.includes('pages_read_engagement') && url.includes('response_type=code'), url.slice(0, 200));
    const stateParam = new URL(url).searchParams.get('state') ?? '';
    const statePayload = decodeJwtPayload(stateParam);
    check('state JWT carries workspaceId + purpose facebook_oauth', statePayload?.workspaceId === workspaceId && statePayload?.purpose === 'facebook_oauth', JSON.stringify(statePayload));

    // Happy path: self-minted page-pick session (no Graph calls).
    const fakePages = [
      { id: 'page-aaa', name: 'Rongdhonu Fashion', category: 'Clothing', picture: 'https://example.com/a.jpg', token: 'tok-page-aaa-secret' },
      { id: 'page-bbb', name: 'Rongdhonu Fashion 2', category: 'Clothing', picture: 'https://example.com/b.jpg', token: 'tok-page-bbb-secret' },
    ];
    const session = signJwt(jwtSecret, { purpose: 'facebook_pages', workspaceId, pages: fakePages }, 600);
    const pages = await apiB(`/api/channels/facebook/pages?session=${encodeURIComponent(session)}`);
    check('pages endpoint lists both pages', pages.status === 200 && (pages.data?.pages ?? []).length === 2, `status=${pages.status}, n=${(pages.data?.pages ?? []).length}`);
    check('pages response never leaks page tokens', !pages.text.includes('tok-page-aaa-secret') && !pages.text.includes('tok-page-bbb-secret'));

    const connectA = await apiB('/api/channels/facebook/connect', { method: 'POST', body: { session, pageId: 'page-aaa' } });
    check('connect page A → 201 messenger channel', connectA.status === 201 && connectA.data?.channel?.platform === 'messenger' && connectA.data?.channel?.external_id === 'page-aaa', `status=${connectA.status}, channel=${JSON.stringify(connectA.data?.channel)}`);

    const list = await apiB('/api/channels');
    const row = (list.data?.channels ?? []).find((c) => c.external_id === 'page-aaa');
    check('GET /api/channels shows the OAuth page', !!row && row.display_name === 'Rongdhonu Fashion', JSON.stringify(row));
    check('row has token_expires_at ~59 days out', !!row?.token_expires_at && new Date(row.token_expires_at).getTime() > Date.now() + 50 * 24 * 60 * 60 * 1000, `token_expires_at=${row?.token_expires_at}`);
    check('row has picture_url', row?.picture_url === 'https://example.com/a.jpg', `picture_url=${row?.picture_url}`);
    check('GET /api/channels never leaks the page token', !list.text.includes('tok-page-aaa-secret'));

    // Reconnect (same page, fresh tokens) must UPDATE the row, not 409.
    const fakePagesV2 = [
      { id: 'page-aaa', name: 'Rongdhonu Fashion', category: 'Clothing', picture: 'https://example.com/a2.jpg', token: 'tok-page-aaa-v2-secret' },
    ];
    const sessionV2 = signJwt(jwtSecret, { purpose: 'facebook_pages', workspaceId, pages: fakePagesV2, userToken: 'tok-user-v2-secret', connectedByUserId: 'fb-user-2' }, 600);
    const reconnect = await apiB('/api/channels/facebook/connect', { method: 'POST', body: { session: sessionV2, pageId: 'page-aaa' } });
    check('reconnect same page → 201 (updates, not 409)', reconnect.status === 201 && reconnect.data?.channel?.external_id === 'page-aaa', `status=${reconnect.status}, channel=${JSON.stringify(reconnect.data?.channel)}`);
    const listAfter = await apiB('/api/channels');
    check('reconnect created NO second row', (listAfter.data?.channels ?? []).filter((c) => c.external_id === 'page-aaa' && c.platform === 'messenger').length === 1, `messenger rows=${(listAfter.data?.channels ?? []).filter((c) => c.external_id === 'page-aaa' && c.platform === 'messenger').length}`);
    check('reconnect never leaks the new page token', !reconnect.text.includes('tok-page-aaa-v2-secret') && !listAfter.text.includes('tok-page-aaa-v2-secret'));
    const limit = await apiB('/api/channels/facebook/connect', { method: 'POST', body: { session, pageId: 'page-bbb' } });
    check('second page → 402 (trial plan: 1 channel)', limit.status === 402, `status=${limit.status}, error=${limit.data?.error ?? ''}`);
  } finally {
    runB.stop();
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
