/**
 * WhatsApp callback timeout fix (2026-11-09) — the live browser test
 * proved the shared OAuth callback timed out (504 FUNCTION_INVOCATION_TIMEOUT)
 * twice on the WhatsApp path: the old completeWhatsappOAuth fetched the
 * WABA accounts + phone numbers synchronously, and its sequential Graph
 * calls ran past Vercel's 10s default function limit, so the flow never
 * reached the number picker.
 *
 * What this verifier proves (stub Meta Graph, local API, PGlite):
 *   - The WhatsApp callback now answers FAST (<8s) and redirects to
 *     whatsapp=pick with a token-only session — even while the stub's
 *     /me/whatsapp_business_accounts route sleeps 12s (longer than the
 *     old 10s Vercel limit). The callback never touches the WABA
 *     endpoint (hit counter unchanged across the callback).
 *   - GET /accounts (the picker's XHR) then does the slow lookup live
 *     and returns the WABA accounts + numbers.
 *   - POST /connect with the picked number creates exactly one
 *     'whatsapp' channel row.
 *   - Empty WABA list → /accounts returns {wabas: [], reason: 'no_waba'}
 *     (the Channels page shows the no_waba message — no callback error).
 *   - Scope missing (2026-11-09 live finding): a plain Facebook Login
 *     never grants whatsapp_business_management, so the fresh token
 *     fails /me/whatsapp_business_accounts with 400 (#100)
 *     "nonexisting field". /accounts and /connect then answer 502 with
 *     reason 'wa_scope_missing' naming Embedded Signup / the manual
 *     form — never a generic "could not load" and never an empty list
 *     pretending "no account". The Channels page surfaces the API's
 *     own error message and warns on the WhatsApp card that Embedded
 *     Signup is needed while WHATSAPP_CONFIG_ID is unset.
 *   - Regression: the Facebook and Instagram callbacks still work and
 *     answer fast.
 *   - Static: vercel.json maxDuration 60; the OAuth Graph timeout cap
 *     (OAUTH_GRAPH_TIMEOUT_MS) is used by the exchange helpers.
 *
 * Local, offline — no calls to graph.facebook.com. No real Meta app.
 * Run from the repo root:  node scripts/verify-whatsapp-callback-timeout.mjs
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

function envFileValue(name) {
  const envPath = path.join(ROOT, 'apps/api/.env');
  if (!fs.existsSync(envPath)) return '';
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (t.startsWith(`${name}=`)) return t.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');
  }
  return '';
}

function signJwt(secret, payload, expiresInSec = 600) {
  const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ ...payload, iat: now, exp: now + expiresInSec })}`;
  return `${data}.${crypto.createHmac('sha256', secret).update(data).digest('base64url')}`;
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
      DATABASE_URL: `pglite://${dataDir}`,
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
  const email = `watime+${stamp}@example.com`;
  const signup = await api('/api/auth/signup', {
    method: 'POST', auth: false,
    body: { name: 'WATime Owner', email, password: 'verify1234', workspaceName: 'WATime Shop' },
  });
  check('signup', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
  const ws = { token: signup.data?.token ?? '', workspaceId: signup.data?.workspace?.id ?? '', userId: signup.data?.user?.id ?? '' };
  useWs(ws);
  return ws;
}

/** Switch the global auth context to a workspace (makeApi reads it live). */
function useWs(ws) {
  token = ws.token;
  workspaceId = ws.workspaceId;
  userId = ws.userId;
}

// ---------------------------------------------------------------------------
// Stub Meta Graph server — the WABA endpoint sleeps 12s (longer than
// Vercel's old 10s default function limit); everything else is fast.
// A hit counter proves which endpoints the callback touches.
// ---------------------------------------------------------------------------
function startStub() {
  let wabaMode = 'full'; // 'full' | 'empty'
  let wabaHits = 0;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      let body = '';
      req.on('data', (c) => { body += c.toString(); });
      req.on('end', () => {
        const params = new URLSearchParams(body);
        // Test-only control: switch the WABA list between full/empty/scope.
        // 'scope' = the token was never granted whatsapp_business_management
        // (plain Facebook Login) — Meta answers 400 (#100) immediately.
        if (req.method === 'POST' && url.pathname === '/__test/waba-mode') {
          try { const m = JSON.parse(body).mode; wabaMode = m === 'empty' || m === 'scope' ? m : 'full'; } catch { /* keep */ }
          send(200, { mode: wabaMode });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/oauth/access_token') {
          // Test-only: code=hang-forever never answers — proves the
          // callback's 15s Graph cap + awaited error handling respond
          // with exchange_failed instead of hanging (the old 504).
          if (params.get('code') === 'hang-forever') return;
          if (params.get('grant_type') === 'fb_exchange_token') send(200, { access_token: 'long-token-1' });
          else send(200, { access_token: 'short-token-1' });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/me') {
          if ((url.searchParams.get('fields') ?? '') === 'name') send(200, { name: 'Test Owner' });
          else send(200, { id: 'fb-user-1' });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/me/accounts') {
          send(200, { data: [{ id: 'page-1', name: 'Halal Chic', category: 'Shopping', access_token: 'page-token-1', picture: { data: { url: '' } } }] });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/page-1') {
          send(200, { instagram_business_account: { id: 'ig-user-1', username: 'halalchic', profile_picture_url: 'https://example.com/ig.jpg' } });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/ig-user-1') {
          send(200, { id: 'ig-user-1', username: 'halalchic', profile_picture_url: 'https://example.com/ig.jpg' });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/page-1/subscribed_apps') {
          send(200, { success: true });
          return;
        }
        // ---- The slow endpoint: 12s delay, then the WABA list ----
        if (req.method === 'GET' && url.pathname === '/me/whatsapp_business_accounts') {
          wabaHits += 1;
          // 'scope' mode: the token was never granted
          // whatsapp_business_management (plain Facebook Login) — Meta
          // answers 400 (#100) immediately, exactly like live 2026-11-09.
          if (wabaMode === 'scope') {
            send(400, { error: { message: '(#100) Tried accessing nonexisting field (whatsapp_business_accounts)', code: 100, type: 'OAuthException' } });
            return;
          }
          setTimeout(() => {
            if (wabaMode === 'empty') send(200, { data: [] });
            else send(200, { data: [{ id: 'waba-1', name: 'Halal Chic WA' }, { id: 'waba-2', name: 'Second WA' }] });
          }, 12000);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/waba-1/phone_numbers') {
          send(200, { data: [{ id: 'wa-phone-1', display_phone_number: '+880 1700-000001', verified_name: 'Halal Chic' }, { id: 'wa-phone-2', display_phone_number: '+880 1700-000002', verified_name: 'Halal Chic 2' }] });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/waba-2/phone_numbers') {
          send(200, { data: [{ id: 'wa-phone-3', display_phone_number: '+880 1700-000003', verified_name: 'Second' }] });
          return;
        }
        send(404, { error: 'stub: no such route', path: url.pathname });
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, wabaHits: () => wabaHits }));
  });
}

async function main() {
  const jwtSecret = envFileValue('JWT_SECRET');
  check('JWT_SECRET available for test signing (from apps/api/.env)', jwtSecret.length > 0);
  const stub = await startStub();
  const stubPort = stub.server.address().port;
  const stubBase = `http://127.0.0.1:${stubPort}`;

  // ---------- Static checks ----------
  const vercelJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/api/vercel.json'), 'utf8'));
  check('vercel.json: API function maxDuration is 60s (safety net over the old 10s default)', vercelJson?.functions?.['api/index.ts']?.maxDuration === 60, `maxDuration=${vercelJson?.functions?.['api/index.ts']?.maxDuration}`);
  const metaSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/meta-oauth.ts'), 'utf8');
  check('meta-oauth: OAUTH_GRAPH_TIMEOUT_MS cap exists (15000)', /OAUTH_GRAPH_TIMEOUT_MS\s*=\s*15000/.test(metaSrc));
  check('meta-oauth: code exchange + /me + /me/accounts use the capped timeout', metaSrc.includes('graphFetch') && /fetchWithTimeout\(`\$\{graphBase\(\)\}\/me\?fields=name`/.test(metaSrc) && metaSrc.includes('OAUTH_GRAPH_TIMEOUT_MS'));
  const waSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/whatsapp-oauth.ts'), 'utf8');
  check('whatsapp callback: does NOT fetch WABAs synchronously any more', !/completeWhatsappOAuth[\s\S]{0,1200}fetchWabas\(/.test(waSrc) && waSrc.includes("whatsapp: 'pick'"));
  check('whatsapp callback: redirects to pick with a token-only session', waSrc.includes("signSession('whatsapp_accounts', {") && waSrc.includes('userToken: longToken'));
  check('whatsapp /accounts: fetches WABAs live from Graph (resolveWabas)', waSrc.includes('resolveWabas(session)') && waSrc.includes('fetchWabasEnriched'));
  check('whatsapp /connect: validates the pick against a live WABA list', waSrc.includes('resolveWabas(verified)'));
  check('whatsapp: empty list returns reason no_waba (page shows the message)', waSrc.includes("'no_waba'"));
  check('whatsapp: phone-number lookups run in parallel (Promise.all)', waSrc.includes('Promise.all'));
  // --- Scope-missing (2026-11-09 live finding): a plain Facebook Login
  // never grants whatsapp_business_management, so the fresh token fails
  // /me/whatsapp_business_accounts with 400 (#100) "nonexisting field".
  // That must surface as reason wa_scope_missing (Embedded Signup or the
  // manual form) — never a generic "could not load" and never an empty
  // list pretending "no account".
  check('whatsapp: 400 #100 nonexisting-field is detected as a scope error (wa_scope_missing)', waSrc.includes('wa_scope_missing') && waSrc.includes('nonexisting field'));
  check('whatsapp: scope error is never masked by the embedded-list fallback', /if \(err instanceof WaScopeMissingError\) throw err;/.test(waSrc));
  check('whatsapp: /accounts answers the scope error with reason wa_scope_missing', waSrc.includes("reason: 'wa_scope_missing'"));
  const channelsPageSrc = fs.readFileSync(path.join(ROOT, 'apps/web/app/channels/page.tsx'), 'utf8');
  check('channels page: picker load failure surfaces the API error message (not only the generic line)', /err instanceof Error && err\.message \? err\.message : t\("channels\.oauthLoadFailed"/.test(channelsPageSrc));
  check('channels page: stale picker error is cleared on load (no stale banner on a plain load)', /const load = useCallback\(async \(\) => \{[\s\S]{0,500}?setError\(""\)/.test(channelsPageSrc));
  check('channels page: WhatsApp card warns Embedded Signup is needed when no config id', channelsPageSrc.includes('whatsappSetupNeeded') && channelsPageSrc.includes('WHATSAPP_CONFIG_ID'));

  const fbSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/facebook-oauth.ts'), 'utf8');
  check('shared callback AWAITS the completers (un-awaited return was the 504 root cause)', /await completeWhatsappOAuth\(/.test(fbSrc) && /await completeFacebookOAuth\(/.test(fbSrc) && /await completeInstagramOAuth\(/.test(fbSrc), 'facebook-oauth.ts callback awaits all three completers');
  check('shared callback catch guards against double-redirect (headersSent)', fbSrc.includes('res.headersSent'));

  // ---------- Live: dummy Meta app + slow-WABA stub ----------
  const stamp = Date.now();
  const port = 4012;
  const api = makeApi(`http://localhost:${port}`);
  const run = startApi(port, '.pglite-data-wa-timeout', {
    META_APP_ID: 'dummy-app-id',
    META_APP_SECRET: 'dummy-app-secret',
    META_GRAPH_BASE_URL: stubBase,
  });
  process.on('exit', run.stop);
  try {
    const up = await waitForHealth(`http://localhost:${port}`);
    check('API starts (health)', up, up ? '' : run.log().slice(-500));
    if (!up) return;
    // Fresh trial workspaces have 1 channel slot, so each flow gets its
    // own workspace: wsA = WhatsApp, wsB = Facebook, wsC = Instagram.
    const wsA = await setupWorkspace(api, stamp);
    const stateFor = (channel) => signJwt(jwtSecret, { purpose: 'facebook_oauth', channel, userId, workspaceId });

    // --- The callback, with the stub WABA endpoint sleeping 12s ---
    const hitsBefore = stub.wabaHits();
    const t0 = Date.now();
    const waCb = await api(`/api/channels/facebook/callback?code=dummy-code&state=${encodeURIComponent(stateFor('whatsapp'))}`, { redirect: 'manual' });
    const waCbMs = Date.now() - t0;
    const waLoc = waCb.location ?? '';
    check('whatsapp callback → 302 whatsapp=pick (reaches the number picker, not a 504)', waCb.status === 302 && /whatsapp=pick/.test(waLoc), `status=${waCb.status} loc=${waLoc.slice(0, 160)}`);
    check(`whatsapp callback answers FAST (${waCbMs}ms < 8000ms) while the WABA endpoint sleeps 12s`, waCbMs < 8000, `${waCbMs}ms`);
    check('whatsapp callback never touched the WABA endpoint (hit counter unchanged)', stub.wabaHits() === hitsBefore, `hits ${hitsBefore} → ${stub.wabaHits()}`);
    const session = new URL(waLoc, 'http://localhost').searchParams.get('session') ?? '';
    check('whatsapp callback returns a picker session', session.length > 50, `len=${session.length}`);

    // --- The picker XHR does the slow lookup (after the redirect) ---
    const t1 = Date.now();
    const accounts = await api(`/api/channels/whatsapp/accounts?session=${encodeURIComponent(session)}`);
    const accountsMs = Date.now() - t1;
    const wabas = accounts.data?.wabas ?? [];
    const totalNumbers = wabas.reduce((n, w) => n + (w.phoneNumbers?.length ?? 0), 0);
    check('whatsapp /accounts → 200 with 2 WABAs / 3 numbers', accounts.status === 200 && wabas.length === 2 && totalNumbers === 3, `status=${accounts.status} wabas=${wabas.length} numbers=${totalNumbers} (${accountsMs}ms)`);
    check('whatsapp /accounts did the slow lookup (took the 12s stub delay)', accountsMs >= 11000, `${accountsMs}ms`);
    check('whatsapp /accounts strips the token (no access_token in the response)', !JSON.stringify(accounts.data ?? {}).includes('long-token-1'));

    // --- Connect the picked number ---
    const conn = await api('/api/channels/whatsapp/connect', {
      method: 'POST',
      body: { session, wabaId: 'waba-1', phoneNumberId: 'wa-phone-1' },
    });
    check('whatsapp /connect (picked number) → 201', conn.status === 201 && !!conn.data?.channel?.id, `status=${conn.status} ${JSON.stringify(conn.data ?? {}).slice(0, 160)}`);
    const list = await api('/api/channels');
    const waRow = (list.data?.channels ?? []).find((c) => c.platform === 'whatsapp');
    check('exactly one whatsapp channel row (external_id = phone number id)', !!waRow && waRow.external_id === 'wa-phone-1', `ext=${waRow?.external_id ?? ''}`);

    // --- Empty WABA list → honest no_waba from /accounts ---
    await fetch(`${stubBase}/__test/waba-mode`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'empty' }) });
    const emptySession = signJwt(jwtSecret, { purpose: 'whatsapp_accounts', workspaceId: wsA.workspaceId, userToken: 'long-token-1' });
    const emptyAccounts = await api(`/api/channels/whatsapp/accounts?session=${encodeURIComponent(emptySession)}`);
    check('whatsapp /accounts with no WABA → 200, empty list, reason no_waba', emptyAccounts.status === 200 && (emptyAccounts.data?.wabas ?? []).length === 0 && emptyAccounts.data?.reason === 'no_waba', `status=${emptyAccounts.status} ${JSON.stringify(emptyAccounts.data ?? {}).slice(0, 120)}`);

    // --- Scope missing: plain Facebook Login never grants
    // whatsapp_business_management (live 2026-11-09: 400 #100 x3) ---
    // The picker must NOT see a generic "could not load" and must NOT
    // see an empty list pretending "no account": it gets a distinct
    // wa_scope_missing reason naming Embedded Signup / the manual form.
    await fetch(`${stubBase}/__test/waba-mode`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'scope' }) });
    const scopeAccounts = await api(`/api/channels/whatsapp/accounts?session=${encodeURIComponent(emptySession)}`);
    check('whatsapp /accounts with scope missing → 502, reason wa_scope_missing (not an empty list)', scopeAccounts.status === 502 && scopeAccounts.data?.reason === 'wa_scope_missing' && !Array.isArray(scopeAccounts.data?.wabas), `status=${scopeAccounts.status} ${JSON.stringify(scopeAccounts.data ?? {}).slice(0, 160)}`);
    check('whatsapp /accounts scope error names Embedded Signup as the way forward', /Embedded Signup/.test(scopeAccounts.data?.error ?? ''), `error=${(scopeAccounts.data?.error ?? '').slice(0, 120)}`);
    const scopeConnect = await api('/api/channels/whatsapp/connect', { method: 'POST', body: { session: emptySession, wabaId: 'waba-1', phoneNumberId: 'wa-phone-1' } });
    check('whatsapp /connect with scope missing → 502, reason wa_scope_missing', scopeConnect.status === 502 && scopeConnect.data?.reason === 'wa_scope_missing', `status=${scopeConnect.status}`);
    // Back to full mode so later checks (if any) see accounts again.
    await fetch(`${stubBase}/__test/waba-mode`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'full' }) });

    // --- Regression: Facebook + Instagram callbacks still fast ---
    // (each in its own fresh workspace — 1 channel slot each)
    const wsB = await setupWorkspace(api, stamp + 1);
    const t2 = Date.now();
    const fbCb = await api(`/api/channels/facebook/callback?code=dummy-code-fb&state=${encodeURIComponent(stateFor('facebook'))}`, { redirect: 'manual' });
    const fbMs = Date.now() - t2;
    check('facebook callback → 302 facebook=connected (1 page)', fbCb.status === 302 && /facebook=connected/.test(fbCb.location ?? ''), `status=${fbCb.status} loc=${(fbCb.location ?? '').slice(0, 120)}`);
    check(`facebook callback fast (${fbMs}ms < 8000ms)`, fbMs < 8000, `${fbMs}ms`);
    const wsC = await setupWorkspace(api, stamp + 2);
    const t3 = Date.now();
    const igCb = await api(`/api/channels/facebook/callback?code=dummy-code-ig&state=${encodeURIComponent(stateFor('instagram'))}`, { redirect: 'manual' });
    const igMs = Date.now() - t3;
    check('instagram callback → 302 instagram=connected (linked IG)', igCb.status === 302 && /instagram=connected/.test(igCb.location ?? ''), `status=${igCb.status} loc=${(igCb.location ?? '').slice(0, 120)}`);
    check(`instagram callback fast (${igMs}ms < 8000ms)`, igMs < 8000, `${igMs}ms`);

    // --- Bad state → fast honest redirect ---
    useWs(wsA);
    const t4 = Date.now();
    const bad = await api('/api/channels/facebook/callback?code=x&state=garbage', { redirect: 'manual' });
    const badMs = Date.now() - t4;
    check('callback with bad state → fast bad_state redirect (no hang)', bad.status === 302 && /bad_state/.test(bad.location ?? '') && badMs < 3000, `status=${bad.status} ${badMs}ms`);

    // --- Root-cause regression: a HANGING code exchange must NOT hang the callback ---
    // Before the fix the shared callback did `return completeWhatsappOAuth(...)`
    // un-awaited, so the 15s Graph abort became an unhandled rejection and NO
    // response was ever sent (browser hung to the 504). Now it must answer
    // with an exchange_failed redirect at ~15s, for whatsapp AND facebook.
    const t5 = Date.now();
    const hang = await api(`/api/channels/facebook/callback?code=hang-forever&state=${encodeURIComponent(stateFor('whatsapp'))}`, { redirect: 'manual' });
    const hangMs = Date.now() - t5;
    check('hanging code exchange (whatsapp) → exchange_failed redirect, not a hang', hang.status === 302 && /whatsapp=error/.test(hang.location ?? '') && /exchange_failed/.test(hang.location ?? ''), `status=${hang.status} ${hangMs}ms loc=${(hang.location ?? '').slice(0, 120)}`);
    check(`hanging code exchange (whatsapp) answers within 25s (${hangMs}ms)`, hangMs < 25000, `${hangMs}ms`);
    const t6 = Date.now();
    const hangFb = await api(`/api/channels/facebook/callback?code=hang-forever&state=${encodeURIComponent(stateFor('facebook'))}`, { redirect: 'manual' });
    const hangFbMs = Date.now() - t6;
    check('hanging code exchange (facebook) → exchange_failed redirect', hangFb.status === 302 && /facebook=error/.test(hangFb.location ?? '') && /exchange_failed/.test(hangFb.location ?? ''), `status=${hangFb.status} ${hangFbMs}ms loc=${(hangFb.location ?? '').slice(0, 120)}`);
    check(`hanging code exchange (facebook) answers within 25s (${hangFbMs}ms)`, hangFbMs < 25000, `${hangFbMs}ms`);
  } finally {
    run.stop();
    stub.server.close();
    await sleep(500);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    console.log('FAILED:');
    for (const f of failed) console.log(` - ${f.name} — ${f.detail}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('VERIFIER CRASH:', err);
  process.exit(1);
});
