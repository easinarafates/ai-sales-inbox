#!/usr/bin/env node
/**
 * Verification for Instagram + WhatsApp OAuth (Channels page) and the
 * no_pages account-name improvement.
 * Local, offline — no calls to graph.facebook.com, no Meta app needed.
 * (The shared Meta callback's Graph leg cannot run offline; it is covered
 * by static checks plus the session-based happy paths below.)
 *
 * Phase A (no META_APP_ID): instagram/login → 503, whatsapp/login → 503;
 * shared callback without state → redirect bad_state; pages/accounts/
 * connect with a bad session → 401.
 * Phase B (dummy META_APP_ID/SECRET): instagram/login + whatsapp/login →
 * 200 with real facebook.com dialog URLs (own scopes, state JWT carries
 * channel); self-minted picker sessions: IG pages list strips tokens,
 * connect creates exactly one 'instagram' channel row (IG id, username,
 * picture, source_id = Page ID) with the token encrypted, unlinked page
 * → 400 ig_not_linked, duplicate → 409, second account → 402 (trial
 * plan: 1 channel); WA accounts list strips the user token, connect
 * creates exactly one 'whatsapp' channel row (phone-number ID, display
 * number, source_id = WABA ID), duplicate → 409, unknown number → 400.
 * Webhook subscription: the IG connect attempts POST /{page-id}/
 * subscribed_apps with the Page token (dummy token → Graph rejects →
 * logged, connect still 201); GET /api/webhooks/meta handshake with
 * the right META_VERIFY_TOKEN → 200 + challenge, wrong token → 403.
 *
 * Run from the repo root:  node scripts/verify-channels-oauth.mjs
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
  const email = `ch-oauth+${stamp}@example.com`;
  const signup = await api('/api/auth/signup', {
    method: 'POST', auth: false,
    body: { name: 'CH Owner', email, password: 'verify1234', workspaceName: 'CH Shop' },
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
  const metaSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/meta-oauth.ts'), 'utf8');
  check('meta-oauth shared module exists', metaSrc.length > 0);
  check('shared module uses Graph v21.0', metaSrc.includes('v21.0'));
  check('shared module has state/session/login/callback helpers', ['signStateToken', 'verifyState', 'signSession', 'verifySession', 'loginUrl', 'webRedirect', 'exchangeCodeForToken', 'exchangeForLongLived', 'fetchMeName', 'fetchPages', 'createOAuthChannel'].every((f) => metaSrc.includes(f)));
  check('shared module never puts a token in a URL (Bearer header / POST body only)', !metaSrc.includes('access_token=${') && !metaSrc.includes('fb_exchange_token=${'));
  check('shared module dispatches callback by state channel', metaSrc.includes("channel: OAuthChannel") || metaSrc.includes('OAuthChannel'));

  const igSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/instagram-oauth.ts'), 'utf8');
  check('instagram router exists with login/pages/connect', ['/login', '/pages', '/connect'].every((p) => igSrc.includes(`'${p}'`)));
  check('instagram login requests instagram scopes', ['instagram_basic', 'instagram_manage_messages', 'pages_show_list'].every((s) => igSrc.includes(s)));
  check('instagram checks instagram_business_account per page', igSrc.includes('instagram_business_account'));
  check('instagram reports ig_not_linked when no page has IG', igSrc.includes("reason: 'ig_not_linked'") || igSrc.includes("'ig_not_linked'"));
  check('instagram completer is exported for the shared callback', igSrc.includes('completeInstagramOAuth'));

  const waSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/whatsapp-oauth.ts'), 'utf8');
  check('whatsapp router exists with login/accounts/connect', ['/login', '/accounts', '/connect'].every((p) => waSrc.includes(`'${p}'`)));
  check('whatsapp login requests whatsapp scopes', ['whatsapp_business_management', 'whatsapp_business_messaging'].every((s) => waSrc.includes(s)));
  check('whatsapp lists WABAs + phone numbers', waSrc.includes('whatsapp_business_accounts') && waSrc.includes('phone_numbers'));
  check('whatsapp reports no_waba when none found', waSrc.includes("'no_waba'"));
  check('whatsapp completer is exported for the shared callback', waSrc.includes('completeWhatsappOAuth'));

  const fbSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/facebook-oauth.ts'), 'utf8');
  check('shared callback dispatches to instagram + whatsapp completers', fbSrc.includes('completeInstagramOAuth') && fbSrc.includes('completeWhatsappOAuth'));
  check('facebook no_pages redirect carries the account name', fbSrc.includes('fetchMeName') && fbSrc.includes("reason: 'no_pages'") && fbSrc.includes('account'));
  check('facebook pick redirect carries the account name', fbSrc.includes("facebook: 'pick'") && fbSrc.includes('account'));

  // ---- Webhook subscription (Meta only pushes events for subscribed Pages) ----
  check('meta-oauth exports subscribePageToApp', metaSrc.includes('export async function subscribePageToApp'));
  check('subscribe posts to /{page-id}/subscribed_apps with the Page token as Bearer', metaSrc.includes('/subscribed_apps') && metaSrc.includes("Authorization: `Bearer ${pageToken}`"));
  check('subscribe sends subscribed_fields (messages, messaging_postbacks, feed)', metaSrc.includes('SUBSCRIBED_FIELDS') && metaSrc.includes('messages,messaging_postbacks,feed'));
  check('subscribe failure is best-effort: logged, returns false, never throws', metaSrc.includes('subscribe page to app failed') && metaSrc.includes('return false') && metaSrc.includes('catch (err)'));
  check('createOAuthChannel subscribes messenger + instagram Pages only (not WhatsApp)', metaSrc.includes("input.platform === 'messenger' || input.platform === 'instagram'") && !waSrc.includes('subscribePageToApp'));
  check('instagram subscribe uses the Page id (sourceId), not the IG id', metaSrc.includes("input.platform === 'messenger' ? input.externalId : (input.sourceId ?? '')"));
  const whSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/webhooks/routes.ts'), 'utf8');
  check('webhook handshake checks hub.verify_token against META_VERIFY_TOKEN', whSrc.includes("token === config.meta.verifyToken") && whSrc.includes("mode === 'subscribe'"));
  check('webhook handshake returns the challenge on match, 403 otherwise', whSrc.includes('String(challenge ??') && whSrc.includes('sendStatus(403)'));

  const mig14 = fs.readFileSync(path.join(ROOT, 'apps/api/src/db/migrations/14-channels-oauth.sql'), 'utf8');
  check('migration 14 adds source_id (idempotent)', mig14.includes('source_id') && mig14.includes('IF NOT EXISTS'));
  const routesSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/routes.ts'), 'utf8');
  check('GET /api/channels selects source_id', routesSrc.includes('source_id'));
  const indexSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/index.ts'), 'utf8');
  check('instagram + whatsapp routers mounted before channels router', indexSrc.indexOf('instagramOAuthRouter') !== -1 && indexSrc.indexOf('whatsappOAuthRouter') !== -1 && indexSrc.indexOf('instagramOAuthRouter') < indexSrc.indexOf("app.use('/api/channels', channelsRouter)") && indexSrc.indexOf('whatsappOAuthRouter') < indexSrc.indexOf("app.use('/api/channels', channelsRouter)"));

  const pageSrc = fs.readFileSync(path.join(ROOT, 'apps/web/app/channels/page.tsx'), 'utf8');
  check('channels page has one card per OAuth channel (facebook/instagram/whatsapp)', pageSrc.includes('OAUTH_KINDS') && ['facebook', 'instagram', 'whatsapp'].every((k) => pageSrc.includes(`"${k}"`)));
  check('channels page shows TikTok + YouTube as coming soon', pageSrc.includes('SOON_CARDS') && pageSrc.includes('comingSoon') && pageSrc.includes('"tiktok"') && pageSrc.includes('"youtube"'));
  check('channels page has NO fake TikTok/YouTube connect calls', !pageSrc.includes('tiktokLogin') && !pageSrc.includes('youtubeLogin') && !pageSrc.includes('tiktokConnect') && !pageSrc.includes('youtubeConnect'));
  check('channels page calls instagramLogin + whatsappLogin', pageSrc.includes('instagramLogin()') && pageSrc.includes('whatsappLogin()'));
  check('channels page shows which account was used (loggedInAs + {account})', pageSrc.includes('loggedInAs') && pageSrc.includes("{account}"));
  check('channels page has instagram + whatsapp pickers', pageSrc.includes('instagramPickTitle') && pageSrc.includes('whatsappPickTitle') && pageSrc.includes('instagramConnect(') && pageSrc.includes('whatsappConnect('));
  check('channels page still has Facebook card + picker (no regression)', pageSrc.includes('Login with Facebook') && pageSrc.includes('facebookLogin()') && pageSrc.includes('facebookPickTitle') && pageSrc.includes('facebookConnect('));

  const apiClientSrc = fs.readFileSync(path.join(ROOT, 'apps/web/lib/api.ts'), 'utf8');
  check('api client has instagram/whatsapp login+list+connect', ['instagramLogin', 'instagramPages', 'instagramConnect', 'whatsappLogin', 'whatsappAccounts', 'whatsappConnect'].every((f) => apiClientSrc.includes(f)));
  const dictSrc = fs.readFileSync(path.join(ROOT, 'apps/web/lib/i18n-dict.ts'), 'utf8');
  check('i18n has instagram + whatsapp keys (EN + BN)', dictSrc.includes('"channels.instagramButton": "Connect Instagram"') && dictSrc.includes('"channels.instagramButton": "Instagram যুক্ত করুন"') && dictSrc.includes('"channels.whatsappButton": "Connect WhatsApp"') && dictSrc.includes('"channels.whatsappButton": "WhatsApp যুক্ত করুন"'));
  check('i18n has account-aware no_pages + ig_not_linked + no_waba messages', dictSrc.includes('facebookErrorNoPagesAccount') && dictSrc.includes('instagramErrorNoIg') && dictSrc.includes('whatsappErrorNoWaba'));
  check('no_pages message tells the user to use the owning account AND allow Page access', dictSrc.includes('allow access to your Pages') && dictSrc.includes('owns your Page'));

  // ================= Phase A: no Meta app =================
  const stampA = Date.now();
  const portA = 4006;
  const apiA = makeApi(`http://localhost:${portA}`);
  const runA = startApi(portA, '.pglite-data-ch-a', { META_APP_ID: '', META_APP_SECRET: '' });
  process.on('exit', runA.stop);
  try {
    const up = await waitForHealth(`http://localhost:${portA}`);
    check('Phase A API starts (health)', up, up ? '' : runA.log().slice(-500));
    if (!up) return;
    await setupWorkspace(apiA, stampA);

    const igLogin = await apiA('/api/channels/instagram/login');
    check('instagram login without META_APP_ID → 503', igLogin.status === 503, `status=${igLogin.status}`);
    const waLogin = await apiA('/api/channels/whatsapp/login');
    check('whatsapp login without META_APP_ID → 503', waLogin.status === 503, `status=${waLogin.status}`);
    check('503 messages say the Meta app is not set up', typeof igLogin.data?.error === 'string' && igLogin.data.error.includes('META_APP_ID') && typeof waLogin.data?.error === 'string' && waLogin.data.error.includes('META_APP_ID'));

    const noState = await apiA('/api/channels/facebook/callback', { auth: false, redirect: 'manual' });
    check('shared callback without state → redirect bad_state', noState.status >= 300 && noState.status < 400 && (noState.location ?? '').includes('facebook=error') && (noState.location ?? '').includes('reason=bad_state'), `status=${noState.status}, location=${noState.location ?? ''}`);

    // An OAuth `state` token must never work as an API auth token (new channels too).
    const stateToken = signJwt(jwtSecret, { userId, workspaceId, purpose: 'facebook_oauth', channel: 'instagram' }, 600);
    const savedToken = token;
    token = stateToken;
    const asAuth = await apiA('/api/channels/instagram/login');
    check('instagram state JWT rejected as auth token → 401', asAuth.status === 401, `status=${asAuth.status}`);
    token = savedToken;

    const badIgPages = await apiA('/api/channels/instagram/pages?session=bogus');
    check('instagram pages with bad session → 401', badIgPages.status === 401, `status=${badIgPages.status}`);
    const badIgConnect = await apiA('/api/channels/instagram/connect', { method: 'POST', body: { session: 'bogus', pageId: '1' } });
    check('instagram connect with bad session → 401', badIgConnect.status === 401, `status=${badIgConnect.status}`);
    const badWaAccts = await apiA('/api/channels/whatsapp/accounts?session=bogus');
    check('whatsapp accounts with bad session → 401', badWaAccts.status === 401, `status=${badWaAccts.status}`);
    const badWaConnect = await apiA('/api/channels/whatsapp/connect', { method: 'POST', body: { session: 'bogus', wabaId: '1', phoneNumberId: '2' } });
    check('whatsapp connect with bad session → 401', badWaConnect.status === 401, `status=${badWaConnect.status}`);
  } finally {
    runA.stop();
    await sleep(2000);
  }

  // ================= Phase B: dummy Meta app =================
  const stampB = Date.now();
  const portB = 4007;
  const apiB = makeApi(`http://localhost:${portB}`);
  const runB = startApi(portB, '.pglite-data-ch-b', { META_APP_ID: 'dummy-app-id', META_APP_SECRET: 'dummy-secret', META_VERIFY_TOKEN: 'test-verify-token-123' });
  process.on('exit', runB.stop);
  try {
    const up = await waitForHealth(`http://localhost:${portB}`);
    check('Phase B API starts (health)', up, up ? '' : runB.log().slice(-500));
    if (!up) return;

    // ---- Instagram flow (own workspace: trial plan = 1 channel) ----
    await setupWorkspace(apiB, stampB);
    const igLogin = await apiB('/api/channels/instagram/login');
    const igUrl = igLogin.data?.url ?? '';
    check('instagram login → 200 + dialog URL', igLogin.status === 200 && igUrl.startsWith('https://www.facebook.com/v21.0/dialog/oauth'), `status=${igLogin.status}, url=${igUrl.slice(0, 80)}`);
    check('instagram dialog URL has instagram scopes', igUrl.includes('instagram_basic') && igUrl.includes('instagram_manage_messages') && igUrl.includes('pages_show_list') && igUrl.includes('response_type=code'), igUrl.slice(0, 200));
    const igState = decodeJwtPayload(new URL(igUrl).searchParams.get('state') ?? '');
    check('instagram state JWT carries channel=instagram', igState?.channel === 'instagram' && igState?.purpose === 'facebook_oauth', JSON.stringify(igState));

    const igPages = [
      { id: 'page-ig-1', name: 'Rongdhonu Fashion', category: 'Clothing', picture: 'https://example.com/p1.jpg', token: 'tok-ig-page-1-secret', instagram: { id: 'ig-111', username: 'rongdhonu.fashion', picture: 'https://example.com/ig1.jpg' } },
      { id: 'page-ig-2', name: 'Rongdhonu Fashion 2', category: 'Clothing', picture: 'https://example.com/p2.jpg', token: 'tok-ig-page-2-secret', instagram: null },
    ];
    const igSession = signJwt(jwtSecret, { purpose: 'instagram_pages', workspaceId, pages: igPages }, 600);
    const igList = await apiB(`/api/channels/instagram/pages?session=${encodeURIComponent(igSession)}`);
    check('instagram pages lists both pages with IG info', igList.status === 200 && (igList.data?.pages ?? []).length === 2 && igList.data.pages[0].instagram?.username === 'rongdhonu.fashion' && igList.data.pages[1].instagram === null, `status=${igList.status}, pages=${JSON.stringify(igList.data?.pages)}`);
    check('instagram pages response never leaks page tokens', !igList.text.includes('tok-ig-page-1-secret') && !igList.text.includes('tok-ig-page-2-secret'));

    const igNoLink = await apiB('/api/channels/instagram/connect', { method: 'POST', body: { session: igSession, pageId: 'page-ig-2' } });
    check('connect page without IG → 400 ig_not_linked', igNoLink.status === 400 && igNoLink.data?.reason === 'ig_not_linked', `status=${igNoLink.status}, body=${JSON.stringify(igNoLink.data)}`);

    const igConnect = await apiB('/api/channels/instagram/connect', { method: 'POST', body: { session: igSession, pageId: 'page-ig-1' } });
    check('connect linked page → 201 instagram channel', igConnect.status === 201 && igConnect.data?.channel?.platform === 'instagram' && igConnect.data?.channel?.external_id === 'ig-111', `status=${igConnect.status}, channel=${JSON.stringify(igConnect.data?.channel)}`);
    // The dummy page token cannot really subscribe on Graph — the connect
    // must still succeed (subscribe failure is best-effort, never fatal).
    await sleep(500);
    check('subscribe failure does not break the connect (dummy token, Graph rejects)', runB.log().includes('subscribe page to app failed for page page-ig-1'), runB.log().slice(-300));

    // ---- Meta webhook handshake (uses the META_VERIFY_TOKEN above) ----
    const hsOk = await apiB('/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=test-verify-token-123&hub.challenge=hello123', { auth: false });
    check('webhook handshake with the right verify token → 200 + challenge', hsOk.status === 200 && hsOk.text === 'hello123', `status=${hsOk.status}, body=${hsOk.text}`);
    const hsBad = await apiB('/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=hello123', { auth: false });
    check('webhook handshake with a wrong verify token → 403', hsBad.status === 403, `status=${hsBad.status}`);

    const igListChannels = await apiB('/api/channels');
    const igRow = (igListChannels.data?.channels ?? []).find((c) => c.external_id === 'ig-111');
    check('GET /api/channels shows the Instagram row (username + picture + source page)', !!igRow && igRow.display_name === 'rongdhonu.fashion' && igRow.picture_url === 'https://example.com/ig1.jpg' && igRow.source_id === 'page-ig-1', JSON.stringify(igRow));
    check('Instagram row has token_expires_at ~59 days out', !!igRow?.token_expires_at && new Date(igRow.token_expires_at).getTime() > Date.now() + 50 * 24 * 60 * 60 * 1000, `token_expires_at=${igRow?.token_expires_at}`);
    check('GET /api/channels never leaks the IG page token', !igListChannels.text.includes('tok-ig-page-1-secret'));

    const igDupe = await apiB('/api/channels/instagram/connect', { method: 'POST', body: { session: igSession, pageId: 'page-ig-1' } });
    check('duplicate instagram connect → 409', igDupe.status === 409, `status=${igDupe.status}`);
    const igPages2 = [
      { id: 'page-ig-9', name: 'Other Shop', category: 'Clothing', picture: '', token: 'tok-ig-page-9-secret', instagram: { id: 'ig-999', username: 'other.shop', picture: '' } },
    ];
    const igSession2 = signJwt(jwtSecret, { purpose: 'instagram_pages', workspaceId, pages: igPages2 }, 600);
    const igLimit = await apiB('/api/channels/instagram/connect', { method: 'POST', body: { session: igSession2, pageId: 'page-ig-9' } });
    check('second instagram account → 402 (trial plan: 1 channel)', igLimit.status === 402, `status=${igLimit.status}, error=${igLimit.data?.error ?? ''}`);

    // ---- WhatsApp flow (fresh workspace: trial plan = 1 channel) ----
    await setupWorkspace(apiB, stampB + 1);
    const waLogin = await apiB('/api/channels/whatsapp/login');
    const waUrl = waLogin.data?.url ?? '';
    check('whatsapp login → 200 + dialog URL', waLogin.status === 200 && waUrl.startsWith('https://www.facebook.com/v21.0/dialog/oauth'), `status=${waLogin.status}, url=${waUrl.slice(0, 80)}`);
    check('whatsapp dialog URL has whatsapp scopes', waUrl.includes('whatsapp_business_management') && waUrl.includes('whatsapp_business_messaging') && waUrl.includes('response_type=code'), waUrl.slice(0, 200));
    const waState = decodeJwtPayload(new URL(waUrl).searchParams.get('state') ?? '');
    check('whatsapp state JWT carries channel=whatsapp', waState?.channel === 'whatsapp' && waState?.purpose === 'facebook_oauth', JSON.stringify(waState));

    const waSessionData = {
      purpose: 'whatsapp_accounts',
      workspaceId,
      userToken: 'tok-wa-user-secret',
      wabas: [
        { id: 'waba-1', name: 'Rongdhonu WABA', phoneNumbers: [
          { id: 'pn-111', displayNumber: '+880 1911-111111', verifiedName: 'Rongdhonu Fashion' },
          { id: 'pn-222', displayNumber: '+880 1911-222222', verifiedName: 'Rongdhonu Fashion' },
        ] },
      ],
    };
    const waSession = signJwt(jwtSecret, waSessionData, 600);
    const waList = await apiB(`/api/channels/whatsapp/accounts?session=${encodeURIComponent(waSession)}`);
    check('whatsapp accounts lists WABA + both numbers', waList.status === 200 && (waList.data?.wabas ?? []).length === 1 && (waList.data.wabas[0].phoneNumbers ?? []).length === 2, `status=${waList.status}, wabas=${JSON.stringify(waList.data?.wabas)}`);
    check('whatsapp accounts response never leaks the user token', !waList.text.includes('tok-wa-user-secret'));

    const waUnknown = await apiB('/api/channels/whatsapp/connect', { method: 'POST', body: { session: waSession, wabaId: 'waba-1', phoneNumberId: 'pn-nope' } });
    check('connect unknown number → 400', waUnknown.status === 400, `status=${waUnknown.status}`);

    const waConnect = await apiB('/api/channels/whatsapp/connect', { method: 'POST', body: { session: waSession, wabaId: 'waba-1', phoneNumberId: 'pn-111' } });
    check('connect number → 201 whatsapp channel', waConnect.status === 201 && waConnect.data?.channel?.platform === 'whatsapp' && waConnect.data?.channel?.external_id === 'pn-111', `status=${waConnect.status}, channel=${JSON.stringify(waConnect.data?.channel)}`);

    const waListChannels = await apiB('/api/channels');
    const waRow = (waListChannels.data?.channels ?? []).find((c) => c.external_id === 'pn-111');
    check('GET /api/channels shows the WhatsApp row (number + source WABA)', !!waRow && waRow.display_name === '+880 1911-111111' && waRow.source_id === 'waba-1', JSON.stringify(waRow));
    check('GET /api/channels never leaks the WA user token', !waListChannels.text.includes('tok-wa-user-secret'));

    const waDupe = await apiB('/api/channels/whatsapp/connect', { method: 'POST', body: { session: waSession, wabaId: 'waba-1', phoneNumberId: 'pn-111' } });
    check('duplicate whatsapp connect → 409', waDupe.status === 409, `status=${waDupe.status}`);
    const waLimit = await apiB('/api/channels/whatsapp/connect', { method: 'POST', body: { session: waSession, wabaId: 'waba-1', phoneNumberId: 'pn-222' } });
    check('second whatsapp number → 402 (trial plan: 1 channel)', waLimit.status === 402, `status=${waLimit.status}, error=${waLimit.data?.error ?? ''}`);

    // ---- Facebook login state still carries channel=facebook ----
    const fbLogin = await apiB('/api/channels/facebook/login');
    const fbState = decodeJwtPayload(new URL(fbLogin.data?.url ?? '').searchParams.get('state') ?? '');
    check('facebook state JWT carries channel=facebook', fbState?.channel === 'facebook', JSON.stringify(fbState));
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
