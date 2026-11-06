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
 * Real send (Phase C): a stub Graph server answers /{node}/messages so
 * the AI auto-reply + manual reply delivery can be tested offline —
 * success (message_id), 24h-window 551, webchat-local, no-token 502 —
 * plus the no-charge-on-failed-send rule via the billing ledger.
 *
 * Run from the repo root:  node scripts/verify-channels-oauth.mjs
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

function decodeJwtPayload(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
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

  // ---- Real send (meta-send.ts + agent + inbox reply) ----
  const sendSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/meta-send.ts'), 'utf8');
  check('meta-send helper exists (sendMetaTextMessage + deliverOutgoingMessage)', sendSrc.includes('export async function sendMetaTextMessage') && sendSrc.includes('export async function deliverOutgoingMessage'));
  check('send posts to /{nodeId}/messages with the Page token as Bearer', sendSrc.includes('/messages') && sendSrc.includes('Authorization: `Bearer ${input.pageToken}`'));
  check('send sends recipient PSID/IG SID + text', sendSrc.includes('recipient: { id: input.recipientId }') && sendSrc.includes('message: { text: input.text }'));
  check('send detects the 24h window (Graph 551 → windowExpired)', sendSrc.includes('code === 551') && sendSrc.includes('windowExpired'));
  check('delivery marks sent/failed/local on the message row (platform_message_id + delivery_error)', sendSrc.includes('delivery_status = $1') && sendSrc.includes('platform_message_id') && sendSrc.includes('delivery_error'));
  check('send never throws (all failures returned)', sendSrc.includes('catch (err)') && sendSrc.includes('ok: false'));
  check('demo-mode replies are saved only, never live-sent', sendSrc.includes('liveSend === false') && sendSrc.includes("delivery: 'local'"));
  check('webchat delivery is local (widget reads it from the DB)', sendSrc.includes("channel.platform === 'webchat'"));
  check('unsupported platforms fail honestly (whatsapp/tiktok/comment)', sendSrc.includes('send_not_supported_for_'));
  check('send uses Graph v21.0 (same base as meta-oauth)', sendSrc.includes("from './meta-oauth'") && sendSrc.includes('GRAPH_BASE'));
  const mig15 = fs.readFileSync(path.join(ROOT, 'apps/api/src/db/migrations/15-message-delivery.sql'), 'utf8');
  check('migration 15 adds delivery_status + delivery_error (idempotent)', mig15.includes('delivery_status') && mig15.includes('delivery_error') && mig15.includes('IF NOT EXISTS'));
  const agentSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/ai-agent/agent.ts'), 'utf8');
  check('agent wires sendChannelMessage to the real deliver helper', agentSrc.includes('deliverOutgoingMessage') && agentSrc.includes('sendChannelMessage'));
  check('agent does not charge when the send fails', agentSrc.includes('if (!sendResult.sent)') && agentSrc.includes("'send_failed_window_expired'"));
  check('demo path never live-sends', agentSrc.includes('liveSend: false'));
  check('no send stub comment remains in agent.ts', !agentSrc.includes('live Meta send is a stub') && !agentSrc.includes('STUB in Phase 1'));
  const inboxSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/inbox/routes.ts'), 'utf8');
  check('manual reply delivers via the shared helper', inboxSrc.includes('deliverOutgoingMessage'));
  check('manual reply returns 502 (not a false 201) when delivery fails', inboxSrc.includes('status(502)') && inboxSrc.includes('windowExpired'));
  check('inbox detail returns delivery_status + delivery_error', inboxSrc.includes('delivery_status') && inboxSrc.includes('delivery_error'));
  check('no send stub comment remains in inbox routes', !inboxSrc.includes('Phase-1 stub'));
  const toolsSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/ai-agent/tools.ts'), 'utf8');
  check('send_product_cards is a data-only tool (returns card data; no fake send)', toolsSrc.includes('sendProductCards') && toolsSrc.includes('cards: rows.map') && !toolsSrc.includes('/messages'));

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
    await sleep(2000);
  }

  // ================= Phase C: real send (stub Graph server) =================
  // The stub stands in for graph.facebook.com so delivery can be tested
  // offline: page-send-ok / ig-send-ok accept the message, page-send-551
  // answers Graph 551 (24h window closed), anything else is a bad token.
  const stubHits = [];
  const graphStub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { parsed = null; }
      stubHits.push({ method: req.method, path: req.url, auth: req.headers.authorization ?? '', body: parsed });
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'POST' && req.url === '/v21.0/page-send-ok/messages') return send(200, { recipient_id: parsed?.recipient?.id, message_id: 'm_stub_ok_1' });
      if (req.method === 'POST' && req.url === '/v21.0/page-send-551/messages') return send(400, { error: { message: "(#551) This person isn't available right now.", type: 'OAuthException', code: 551, error_subcode: 2018278 } });
      if (req.method === 'POST' && req.url === '/v21.0/ig-send-ok/messages') return send(200, { recipient_id: parsed?.recipient?.id, message_id: 'm_stub_ig_1' });
      return send(400, { error: { message: 'Invalid OAuth access token.', type: 'OAuthException', code: 190 } });
    });
  });
  const stubPort = 4010;
  await new Promise((resolve) => graphStub.listen(stubPort, resolve));
  const stampC = Date.now();
  const portC = 4008;
  const apiC = makeApi(`http://localhost:${portC}`);
  const runC = startApi(portC, '.pglite-data-ch-c', { META_APP_ID: 'dummy-app-id', META_APP_SECRET: 'dummy-secret', META_GRAPH_BASE_URL: `http://localhost:${stubPort}/v21.0` });
  process.on('exit', runC.stop);
  try {
    const up = await waitForHealth(`http://localhost:${portC}`);
    check('Phase C API starts (health)', up, up ? '' : runC.log().slice(-500));
    if (!up) return;

    async function addShopData(api) {
      const p = await api('/api/products', { method: 'POST', body: { name: 'শাড়ি', pricePaisa: 150000, size: 'M', stock: 5, description: 'সুতির শাড়ি — লাল' } });
      check('C product added (শাড়ি, ৳1500)', p.status === 201, `status=${p.status}`);
      const k = await api('/api/knowledge', { method: 'POST', body: { title: 'ডেলিভারি', body: 'ঢাকার ভেতরে ডেলিভারি চার্জ ৬০ টাকা, সময় ২-৩ দিন।' } });
      check('C knowledge added', k.status === 201, `status=${k.status}`);
    }
    async function waitForOut(api, convId, timeoutMs = 60000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const d = await api(`/api/inbox/${convId}`);
        const out = (d.data?.messages ?? []).filter((m) => m.direction === 'out');
        if (out.length > 0) return d.data;
        await sleep(2000);
      }
      return null;
    }
    async function sendCustomerMessage(api, pageId, senderId, mid, text, object = 'page') {
      return api('/api/webhooks/meta', {
        method: 'POST', auth: false,
        body: { object, entry: [{ id: pageId, messaging: [{ sender: { id: senderId }, recipient: { id: pageId }, message: { mid, text } }] }] },
      });
    }

    // ---- C1: Messenger AI auto-reply delivers via the stub ----
    await setupWorkspace(apiC, stampC);
    const ch1 = await apiC('/api/channels', { method: 'POST', body: { platform: 'messenger', externalId: 'page-send-ok', displayName: 'Send OK Page', token: 'tok-stub-page' } });
    check('C1 messenger channel (stub token) → 201', ch1.status === 201, `status=${ch1.status}`);
    await addShopData(apiC);
    const live1 = await apiC(`/api/workspaces/${workspaceId}/go-live`, { method: 'POST' });
    check('C1 go-live (practice mode off)', live1.status === 200 && live1.data?.workspace?.practice_mode === false, `status=${live1.status}`);
    const hook1 = await sendCustomerMessage(apiC, 'page-send-ok', 'psid-1', `c1-mid-${stampC}`, 'শাড়ির দাম কত?');
    check('C1 webhook accepts the message', hook1.status === 200, `status=${hook1.status}`);
    const conv1 = (await apiC('/api/inbox')).data?.conversations?.[0];
    check('C1 conversation created', !!conv1?.id, `conv=${conv1?.id ?? ''}`);
    const detail1 = conv1 ? await waitForOut(apiC, conv1.id) : null;
    check('C1 AI reply arrives', !!detail1, 'no outgoing message within 60s');
    if (detail1) {
      const out1 = (detail1.messages ?? []).filter((m) => m.direction === 'out')[0];
      check('C1 AI reply is a real (non-demo) reply', !(out1?.body ?? '').includes('[ডেমো AI'), (out1?.body ?? '').slice(0, 80));
      check('C1 AI reply is marked sent with the stub message_id', out1?.delivery_status === 'sent' && out1?.platform_message_id === 'm_stub_ok_1', `delivery_status=${out1?.delivery_status}, platform_message_id=${out1?.platform_message_id}`);
      const hit1 = stubHits.find((h) => h.path === '/v21.0/page-send-ok/messages' && h.body?.recipient?.id === 'psid-1');
      check('C1 stub Graph got the send (right PSID + Page token as Bearer)', !!hit1 && hit1.auth === 'Bearer tok-stub-page' && hit1.body?.message?.text === out1?.body, JSON.stringify(hit1?.body ?? null));
      const bill1 = await apiC('/api/billing');
      check('C1 delivered reply is charged (ledger entry, 0 paisa Groq)', (bill1.data?.usage ?? []).length >= 1 && Number(bill1.data.usage[0]?.cost_paisa) === 0, `entries=${(bill1.data?.usage ?? []).length}, cost=${bill1.data?.usage?.[0]?.cost_paisa}`);
      check('C1 wallet balance stays 5000 after the delivered reply', Number(bill1.data?.balancePaisa) === 5000, `balance=${bill1.data?.balancePaisa}`);
      const manual1 = await apiC(`/api/inbox/${conv1.id}/reply`, { method: 'POST', body: { body: 'জি, শাড়িটি স্টকে আছে।' } });
      check('C1 manual reply → 201 delivered', manual1.status === 201 && manual1.data?.delivered === true && manual1.data?.platformMessageId === 'm_stub_ok_1', `status=${manual1.status}, delivered=${manual1.data?.delivered}`);
      check('C1 manual reply row is marked sent', manual1.data?.message?.delivery_status === 'sent', `delivery_status=${manual1.data?.message?.delivery_status}`);
    }

    // ---- C2: 24h window (551) — AI reply fails, NO charge; manual reply → 502 ----
    await setupWorkspace(apiC, stampC + 1);
    const ch2 = await apiC('/api/channels', { method: 'POST', body: { platform: 'messenger', externalId: 'page-send-551', displayName: 'Send 551 Page', token: 'tok-stub-page-551' } });
    check('C2 messenger channel (551 page) → 201', ch2.status === 201, `status=${ch2.status}`);
    await addShopData(apiC);
    const live2 = await apiC(`/api/workspaces/${workspaceId}/go-live`, { method: 'POST' });
    check('C2 go-live', live2.status === 200, `status=${live2.status}`);
    const hook2 = await sendCustomerMessage(apiC, 'page-send-551', 'psid-2', `c2-mid-${stampC}`, 'শাড়ির দাম কত?');
    check('C2 webhook accepts the message', hook2.status === 200, `status=${hook2.status}`);
    const conv2 = (await apiC('/api/inbox')).data?.conversations?.[0];
    const detail2 = conv2 ? await waitForOut(apiC, conv2.id) : null;
    check('C2 AI reply row still appears (saved, not lost)', !!detail2, 'no outgoing message within 60s');
    if (detail2) {
      const out2 = (detail2.messages ?? []).filter((m) => m.direction === 'out')[0];
      check('C2 AI reply is marked failed (Graph 551)', out2?.delivery_status === 'failed' && String(out2?.delivery_error ?? '').includes('551'), `delivery_status=${out2?.delivery_status}, error=${out2?.delivery_error ?? ''}`);
      const bill2 = await apiC('/api/billing');
      check('C2 NO ledger entry for the undelivered AI reply', (bill2.data?.usage ?? []).length === 0, `entries=${(bill2.data?.usage ?? []).length}`);
      check('C2 wallet balance stays 5000 (no charge for undelivered reply)', Number(bill2.data?.balancePaisa) === 5000, `balance=${bill2.data?.balancePaisa}`);
      const manual2 = await apiC(`/api/inbox/${conv2.id}/reply`, { method: 'POST', body: { body: 'দুঃখিত, পরে জানাচ্ছি।' } });
      check('C2 manual reply → 502 with windowExpired', manual2.status === 502 && manual2.data?.windowExpired === true, `status=${manual2.status}, windowExpired=${manual2.data?.windowExpired}`);
      check('C2 manual reply row is marked failed (not a false 201)', manual2.data?.message?.delivery_status === 'failed', `delivery_status=${manual2.data?.message?.delivery_status}`);
    }

    // ---- C3: webchat manual reply is local (widget reads it from the DB) ----
    await setupWorkspace(apiC, stampC + 2);
    const ch3 = await apiC('/api/channels', { method: 'POST', body: { platform: 'webchat', externalId: 'site-send-ok', displayName: 'Website Chat' } });
    check('C3 webchat channel → 201', ch3.status === 201, `status=${ch3.status}`);
    // The test API loads apps/api/.env, which sets WEBCHAT_SECRET — the
    // webhook requires it as x-webchat-secret (403 without it).
    const webchatSecret = envFileValue('WEBCHAT_SECRET');
    const wc = await apiC('/api/webhooks/webchat', { method: 'POST', auth: false, headers: webchatSecret ? { 'x-webchat-secret': webchatSecret } : {}, body: { externalId: 'site-send-ok', senderId: 'web-1', name: 'Web Customer', text: 'হ্যালো' } });
    check('C3 webchat incoming creates a conversation', wc.status === 200 && !!wc.data?.conversationId, `status=${wc.status}`);
    if (wc.data?.conversationId) {
      const manual3 = await apiC(`/api/inbox/${wc.data.conversationId}/reply`, { method: 'POST', body: { body: 'হ্যালো, কিভাবে সাহায্য করতে পারি?' } });
      check('C3 webchat manual reply → 201 local delivery', manual3.status === 201 && manual3.data?.delivered === true && manual3.data?.message?.delivery_status === 'local', `status=${manual3.status}, delivery_status=${manual3.data?.message?.delivery_status}`);
    }

    // ---- C4: messenger channel without a token → manual reply 502 ----
    await setupWorkspace(apiC, stampC + 3);
    const ch4 = await apiC('/api/channels', { method: 'POST', body: { platform: 'messenger', externalId: 'page-no-token', displayName: 'No Token Page' } });
    check('C4 messenger channel without token → 201', ch4.status === 201, `status=${ch4.status}`);
    const hook4 = await sendCustomerMessage(apiC, 'page-no-token', 'psid-4', `c4-mid-${stampC}`, 'হ্যালো');
    check('C4 webhook accepts the message', hook4.status === 200, `status=${hook4.status}`);
    const conv4 = (await apiC('/api/inbox')).data?.conversations?.[0];
    if (conv4) {
      const manual4 = await apiC(`/api/inbox/${conv4.id}/reply`, { method: 'POST', body: { body: 'হ্যালো' } });
      check('C4 manual reply without a Page token → 502', manual4.status === 502 && String(manual4.data?.reason ?? '').includes('no_page_token'), `status=${manual4.status}, reason=${manual4.data?.reason}`);
      check('C4 reply row is marked failed', manual4.data?.message?.delivery_status === 'failed', `delivery_status=${manual4.data?.message?.delivery_status}`);
    } else {
      check('C4 conversation created', false, 'no conversation');
    }

    // ---- C5: Instagram manual reply via the stub ----
    await setupWorkspace(apiC, stampC + 4);
    const ch5 = await apiC('/api/channels', { method: 'POST', body: { platform: 'instagram', externalId: 'ig-send-ok', displayName: 'ig.shop', token: 'tok-stub-ig' } });
    check('C5 instagram channel (stub token) → 201', ch5.status === 201, `status=${ch5.status}`);
    const hook5 = await sendCustomerMessage(apiC, 'ig-send-ok', 'igsid-1', `c5-mid-${stampC}`, 'হ্যালো', 'instagram');
    check('C5 IG webhook accepts the message', hook5.status === 200, `status=${hook5.status}`);
    const conv5 = (await apiC('/api/inbox')).data?.conversations?.[0];
    if (conv5) {
      const manual5 = await apiC(`/api/inbox/${conv5.id}/reply`, { method: 'POST', body: { body: 'হ্যালো! ধন্যবাদ।' } });
      check('C5 IG manual reply → 201 delivered', manual5.status === 201 && manual5.data?.delivered === true && manual5.data?.platformMessageId === 'm_stub_ig_1', `status=${manual5.status}, platformMessageId=${manual5.data?.platformMessageId}`);
      const hit5 = stubHits.find((h) => h.path === '/v21.0/ig-send-ok/messages' && h.body?.recipient?.id === 'igsid-1');
      check('C5 stub Graph got the IG send (right IG SID + Page token)', !!hit5 && hit5.auth === 'Bearer tok-stub-ig', JSON.stringify(hit5?.body ?? null));
    } else {
      check('C5 IG conversation created', false, 'no conversation');
    }

    // ---- C6: auth / 404 guards on the reply endpoint ----
    const noAuth = await apiC(`/api/inbox/${conv1?.id ?? '00000000-0000-0000-0000-000000000000'}/reply`, { method: 'POST', auth: false, body: { body: 'x' } });
    check('C6 reply without auth → 401', noAuth.status === 401, `status=${noAuth.status}`);
    const notFound = await apiC('/api/inbox/00000000-0000-0000-0000-000000000000/reply', { method: 'POST', body: { body: 'x' } });
    check('C6 reply to an unknown conversation → 404', notFound.status === 404, `status=${notFound.status}`);
  } finally {
    runC.stop();
    try { graphStub.close(); } catch { /* already closed */ }
    await sleep(2000);
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
