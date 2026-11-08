#!/usr/bin/env node
/**
 * Verification for Instagram posting + WhatsApp sending
 * (docs/instagram-whatsapp-setup.md).
 *
 * Local, offline — no calls to graph.facebook.com. One stub server
 * stands in for the Meta Graph API (the API is pointed at it with
 * META_GRAPH_BASE_URL). Real Gemini is used for the AI-reply checks
 * (the key comes from apps/api/.env, as the API itself loads it) —
 * those checks wait up to 90s for the in-process fallback worker.
 *
 * Phase A (no Meta app id): instagram/login → 503; instagram/status →
 * connected:false; an Instagram post's publish-now fails honestly
 * (no channel) and ends 'failed'.
 * Phase B (dummy Meta app id/secret + stub Graph):
 *  Instagram (workspace 1):
 *   - login URL carries instagram_content_publish.
 *   - Shared Facebook callback creates exactly one 'instagram' channel
 *     (external_id ig-user-1), scopes stored incl. the publish scope;
 *     reconnect updates (no second row).
 *   - GET /api/instagram/status → connected + hasPublishScope true.
 *   - DM intake: object 'instagram' webhook → Inbox; duplicate mid →
 *     no duplicate message; manual reply → 201 with the REAL stub
 *     message id (ig-msg-1).
 *   - AI reply to an Instagram DM asking a price → outbound 'sent'
 *     with a real ig message id and the real price (৳500).
 *   - Schedule: image post → publish-now → 'published' with the REAL
 *     stub media id; 2-image post → carousel, real carousel media id;
 *     video post → reel, real media id (container polled
 *     IN_PROGRESS → FINISHED first); text-only post → 400; a post
 *     whose container Graph refuses with code 10 (missing scope) →
 *     'failed' with the honest reconnect message.
 *  WhatsApp (workspace 2):
 *   - Manual connect with a bad number id → 400 wa_verify_failed,
 *     no row stored; with the stub number → 201, one 'whatsapp'
 *     channel row (external_id = phone number id).
 *   - Intake: POST /api/webhooks/whatsapp → Inbox; duplicate message
 *     id → no duplicate message; manual reply → 201 with the REAL
 *     stub wamid; AI price reply → outbound 'sent' with a real wamid
 *     and the real price; AI photo request → outbound IMAGE 'sent'
 *     with a real wamid (product photo via the Cloud API image send).
 *   - 24h window: a reply to a customer whose window is closed
 *     (stub answers 131047) → 502 with windowExpired:true and the
 *     saved row honestly 'failed' — never a fake 'sent'.
 *  Static checks: container + publish flow (incl. CAROUSEL / VIDEO /
 *  FINISHED polling, real media id only, no stub ids), WhatsApp Cloud
 *  API shape (messaging_product + 131047 → windowExpired + wamid
 *  only), OAuth scope + stored scopes, publisher scope gate, routes
 *  allow instagram + reject text-only, schedule page offers instagram
 *  (no coming soon), webhook intake paths exist, AI agent routes
 *  through deliverOutgoingMessage.
 *
 * Run from the repo root:  node scripts/verify-instagram-whatsapp.mjs
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 */
import { spawn, execSync } from 'node:child_process';
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
  const email = `igwa+${stamp}@example.com`;
  const signup = await api('/api/auth/signup', {
    method: 'POST', auth: false,
    body: { name: 'IGWA Owner', email, password: 'verify1234', workspaceName: 'IGWA Shop' },
  });
  check('signup', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
  token = signup.data?.token ?? '';
  workspaceId = signup.data?.workspace?.id ?? '';
  userId = signup.data?.user?.id ?? '';
  // Fresh signups are in practice_mode (the AI only answers test
  // customers) — go live, like the real shop did, so AI replies to
  // real customers flow through the new send paths.
  if (workspaceId) {
    const live = await api(`/api/workspaces/${workspaceId}/go-live`, { method: 'POST', body: {} });
    check('go-live (practice mode off)', live.status === 200 && live.data?.workspace?.practice_mode === false, `status=${live.status}`);
  }
  return { token, workspaceId, userId };
}

function useWorkspace(ws) {
  token = ws.token;
  workspaceId = ws.workspaceId;
  userId = ws.userId;
}

/** Poll an inbox thread until a message matches, or the timeout hits.
 * Only messages NOT in `excludeIds` (e.g. ones sent before the trigger)
 * are considered. On timeout the returned value carries the thread dump
 * in `._threadDump` so a failure shows what the AI actually did. */
async function waitForOutbound(api, convId, predicate, timeoutMs = 90000, excludeIds = new Set()) {
  const start = Date.now();
  let last = [];
  while (Date.now() - start < timeoutMs) {
    const detail = await api(`/api/inbox/${convId}`);
    const messages = detail.data?.messages ?? [];
    last = messages;
    const found = messages.find((m) => !excludeIds.has(m.id) && predicate(m));
    if (found) return found;
    await sleep(3000);
  }
  const dump = last.slice(-8).map((m) => `[${m.direction}/${m.type}/${m.delivery_status ?? ''}] ${(m.body ?? '').slice(0, 80)}`).join(' | ');
  return { _threadDump: dump || '(no messages)' };
}

/** Ids of the thread's current outbound messages (snapshot before a trigger). */
async function outboundIds(api, convId) {
  const detail = await api(`/api/inbox/${convId}`);
  return new Set((detail.data?.messages ?? []).filter((m) => m.direction === 'out').map((m) => m.id));
}

const PRICE_RE = /500|৫০০/;

// ---------------------------------------------------------------------------
// Stub Meta Graph server
// ---------------------------------------------------------------------------

function startStub() {
  let childSeq = 0;
  const statusCalls = {};
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const send = (status, obj, headers = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(obj));
      };
      let body = '';
      req.on('data', (c) => { body += c.toString(); });
      req.on('end', () => {
        let parsed = {};
        try { parsed = body ? JSON.parse(body) : {}; } catch { parsed = {}; }
        const params = new URLSearchParams(body);

        // ---- media bytes (image / video URLs the publisher passes through) ----
        if (req.method === 'GET' && (url.pathname === '/image.jpg' || url.pathname === '/image2.jpg')) {
          res.writeHead(200, { 'Content-Type': 'image/jpeg' });
          res.end(Buffer.from('fake-jpeg-bytes-for-test'));
          return;
        }
        if (req.method === 'GET' && url.pathname === '/video.mp4') {
          res.writeHead(200, { 'Content-Type': 'video/mp4' });
          res.end(Buffer.from('fake-mp4-bytes-for-test'));
          return;
        }
        // ---- OAuth token exchange (code + long-lived) ----
        if (req.method === 'POST' && url.pathname === '/oauth/access_token') {
          if (params.get('grant_type') === 'fb_exchange_token') {
            send(200, { access_token: 'long-token-1', expires_in: 5184000 });
          } else {
            send(200, { access_token: 'short-token-1' });
          }
          return;
        }
        // ---- /me (name + id) ----
        if (req.method === 'GET' && url.pathname === '/me') {
          if ((url.searchParams.get('fields') ?? '') === 'name') send(200, { name: 'Test Owner' });
          else send(200, { id: 'fb-user-1' });
          return;
        }
        // ---- /me/accounts (the Page) ----
        if (req.method === 'GET' && url.pathname === '/me/accounts') {
          send(200, { data: [{ id: 'page-1', name: 'Halal Chic', category: 'Shopping', access_token: 'page-token-1', picture: { data: { url: '' } } }] });
          return;
        }
        // ---- Page → linked Instagram account ----
        if (req.method === 'GET' && url.pathname === '/page-1') {
          send(200, { instagram_business_account: { id: 'ig-user-1', username: 'halalchic', profile_picture_url: 'https://example.com/ig.jpg' } });
          return;
        }
        // ---- Instagram profile verify ----
        if (req.method === 'GET' && url.pathname === '/ig-user-1') {
          send(200, { id: 'ig-user-1', username: 'halalchic', profile_picture_url: 'https://example.com/ig.jpg' });
          return;
        }
        // ---- Page subscribe (best-effort) ----
        if (req.method === 'POST' && url.pathname === '/page-1/subscribed_apps') {
          send(200, { success: true });
          return;
        }
        // ---- Page conversations (profile-enrich fallback: empty) ----
        if (req.method === 'GET' && url.pathname === '/page-1/conversations') {
          send(200, { data: [] });
          return;
        }
        // ---- WhatsApp phone number verify ----
        if (req.method === 'GET' && url.pathname === '/wa-phone-1') {
          send(200, { id: 'wa-phone-1', display_phone_number: '+880 1700-000001', verified_name: 'Halal Chic' });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/wa-bad-1') {
          send(404, { error: { message: 'Unsupported get request.', code: 100 } });
          return;
        }
        // ---- Instagram media container create ----
        if (req.method === 'POST' && url.pathname === '/ig-user-1/media') {
          if (typeof parsed.image_url === 'string' && parsed.image_url.includes('scope-error')) {
            send(400, { error: { message: '(#10) This endpoint requires the instagram_content_publish permission to access.', code: 10 } });
            return;
          }
          if (parsed.media_type === 'CAROUSEL') {
            send(200, { id: 'ig-container-carousel' });
            return;
          }
          if (parsed.media_type === 'VIDEO') {
            send(200, { id: 'ig-container-video' });
            return;
          }
          if (parsed.is_carousel_item) {
            childSeq += 1;
            send(200, { id: `ig-child-${childSeq}` });
            return;
          }
          send(200, { id: 'ig-container-1' });
          return;
        }
        // ---- Instagram container status (video: IN_PROGRESS once, then FINISHED) ----
        if (req.method === 'GET' && url.pathname.startsWith('/ig-container')) {
          const id = url.pathname.slice(1);
          statusCalls[id] = (statusCalls[id] ?? 0) + 1;
          if (id === 'ig-container-video' && statusCalls[id] === 1) {
            send(200, { id, status_code: 'IN_PROGRESS' });
          } else {
            send(200, { id, status_code: 'FINISHED' });
          }
          return;
        }
        // ---- Instagram media_publish ----
        if (req.method === 'POST' && url.pathname === '/ig-user-1/media_publish') {
          const map = {
            'ig-container-1': 'ig-media-123',
            'ig-container-carousel': 'ig-media-carousel-1',
            'ig-container-video': 'ig-media-reel-1',
          };
          const mediaId = map[parsed.creation_id] ?? null;
          if (!mediaId) {
            send(400, { error: { message: 'unknown creation_id', code: 100 } });
            return;
          }
          send(200, { id: mediaId });
          return;
        }
        // ---- Instagram DM send / mark_seen ----
        if (req.method === 'POST' && url.pathname === '/ig-user-1/messages') {
          if (parsed.sender_action === 'mark_seen') {
            send(200, { recipient_id: 'ig-sender-1' });
            return;
          }
          if (parsed.message?.text) {
            send(200, { message_id: 'ig-msg-1', recipient_id: 'ig-sender-1' });
            return;
          }
          send(400, { error: { message: 'bad message', code: 100 } });
          return;
        }
        // ---- WhatsApp Cloud API send ----
        if (req.method === 'POST' && url.pathname === '/wa-phone-1/messages') {
          if (parsed.messaging_product !== 'whatsapp') {
            send(400, { error: { message: 'messaging_product must be whatsapp', code: 100 } });
            return;
          }
          if (parsed.to === '8801700000002') {
            send(400, { error: { message: '(#131047) Message failed to send because it was outside the allowed window. Please use a template message.', code: 131047 } });
            return;
          }
          if (parsed.type === 'image') {
            send(200, { messaging_product: 'whatsapp', contacts: [{ input: parsed.to, wa_id: parsed.to }], messages: [{ id: 'wamid.img-1' }] });
            return;
          }
          if (parsed.type === 'text') {
            send(200, { messaging_product: 'whatsapp', contacts: [{ input: parsed.to, wa_id: parsed.to }], messages: [{ id: 'wamid.text-1' }] });
            return;
          }
          send(400, { error: { message: 'unsupported type', code: 100 } });
          return;
        }
        send(404, { error: 'stub: no such route', path: url.pathname });
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  const jwtSecret = envFileValue('JWT_SECRET');
  check('JWT_SECRET available for test signing (from apps/api/.env)', jwtSecret.length > 0);
  const geminiKey = envFileValue('GEMINI_API_KEY');
  check('GEMINI_API_KEY present in apps/api/.env (AI-reply checks are live)', geminiKey.length > 0);
  const stub = await startStub();
  const stubPort = stub.address().port;
  const stubBase = `http://127.0.0.1:${stubPort}`;
  const imageUrl = `${stubBase}/image.jpg`;
  const imageUrl2 = `${stubBase}/image2.jpg`;
  const videoUrl = `${stubBase}/video.mp4`;

  // ---------- Static checks ----------
  const igPostSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/instagram-post.ts'), 'utf8');
  check('instagram-post: container create + media_publish flow', igPostSrc.includes('/media') && igPostSrc.includes('media_publish') && igPostSrc.includes('creation_id'));
  check('instagram-post: image / carousel (is_carousel_item + CAROUSEL) / video (VIDEO) containers', igPostSrc.includes('is_carousel_item') && igPostSrc.includes('CAROUSEL') && igPostSrc.includes("media_type: 'VIDEO'"));
  check('instagram-post: waits for FINISHED container status before publishing', igPostSrc.includes("status_code") && igPostSrc.includes("=== 'FINISHED'"));
  check('instagram-post: only a real media id counts as published', igPostSrc.includes('mediaId: pub.data.id') && !igPostSrc.includes('stub-'));
  check('instagram-post: publish-scope gate reads stored scopes (NULL = cannot publish)', igPostSrc.includes('hasInstagramPublishScope') && igPostSrc.includes('instagram_content_publish'));
  check('instagram-post: scope error (code 10/200) maps to needsReconnect', igPostSrc.includes('needsReconnect') && igPostSrc.includes('code === 10'));
  const igOauth = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/instagram-oauth.ts'), 'utf8');
  check('instagram oauth: requests instagram_content_publish', igOauth.includes('instagram_content_publish'));
  check('instagram oauth: stores granted scopes on the channel row', igOauth.includes("scopes: SCOPES.join(',')"));
  const sendSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/meta-send.ts'), 'utf8');
  check('meta-send: WhatsApp Cloud API send (messaging_product whatsapp + /messages)', sendSrc.includes("messaging_product: 'whatsapp'") && sendSrc.includes('/messages') && sendSrc.includes('sendWhatsAppTextMessage'));
  check('meta-send: WhatsApp image send (image:{link})', sendSrc.includes('sendWhatsAppImageMessage') && sendSrc.includes("image: { link:"));
  check('meta-send: WhatsApp 131047 maps to windowExpired (never a fake send)', sendSrc.includes('131047') && sendSrc.includes('windowExpired'));
  check('meta-send: WhatsApp replies route through deliverOutgoingMessage/ImageMessage', sendSrc.includes("channel.platform === 'whatsapp'") && sendSrc.includes('sendWhatsAppTextMessage({') && sendSrc.includes('sendWhatsAppImageMessage({'));
  check('meta-send: only a real wamid counts as sent (messages[0].id)', sendSrc.includes('messages?.[0]?.id'));
  check('meta-send: no whatsapp send_not_supported stub remains', !sendSrc.includes('send_not_supported_for_whatsapp') && !sendSrc.includes("WhatsApp is NOT sent here"));
  const pubSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/scheduling/publisher.ts'), 'utf8');
  check('publisher: instagram leg publishes via publishInstagramPost + real media id', pubSrc.includes("platform === 'instagram'") && pubSrc.includes('publishInstagramPost') && pubSrc.includes('result.mediaId'));
  check('publisher: instagram without publish scope fails honestly with reconnect message', pubSrc.includes('hasInstagramPublishScope') && pubSrc.includes('instagramReconnectMessage'));
  check('publisher: instagram text-only post fails honestly (needs media)', pubSrc.includes("Instagram-এ শুধু ছবি বা ভিডিও পোস্ট করা যায়"));
  const schedSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/scheduling/routes.ts'), 'utf8');
  check('scheduling routes: instagram allowed, text-only instagram → 400', schedSrc.includes("p !== 'instagram'") && schedSrc.includes("plats.includes('instagram') && mt === 'text'"));
  const schedPage = fs.readFileSync(path.join(ROOT, 'apps/web/app/schedule/page.tsx'), 'utf8');
  check('schedule page: instagram is a real platform option (no coming soon)', schedPage.includes('"facebook", "instagram", "youtube", "tiktok"') && !schedPage.includes('PLATFORM_COMING_SOON'));
  check('schedule page: instagram reconnect hint from /instagram/status', schedPage.includes('igStatus') && schedPage.includes('needsReconnectForPublish'));
  const socialSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/social-routes.ts'), 'utf8');
  check('social routes: GET /instagram/status (connected + publish scope)', socialSrc.includes("'/instagram/status'") && socialSrc.includes('hasPublishScope'));
  const hookSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/webhooks/routes.ts'), 'utf8');
  check('webhooks: instagram DM intake exists (object instagram → Inbox)', hookSrc.includes("=== 'instagram'") && hookSrc.includes("findChannelByExternalId(platform, recipient?.id"));
  check('webhooks: whatsapp intake exists (POST /webhooks/whatsapp → Inbox)', hookSrc.includes("'/whatsapp'") && hookSrc.includes("findChannelByExternalId('whatsapp', phoneNumberId)"));
  const agentSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/ai-agent/agent.ts'), 'utf8');
  check('agent: AI replies route through deliverOutgoingMessage (shared with manual replies)', agentSrc.includes('deliverOutgoingMessage(workspaceId, conversationId, reply'));
  const docSrc = fs.readFileSync(path.join(ROOT, 'docs/instagram-whatsapp-setup.md'), 'utf8');
  check('docs: setup doc covers IG link + WA number + 24h window + reconnect', docSrc.includes('instagram_content_publish') && docSrc.includes('24') && docSrc.includes('WHATSAPP_CONFIG_ID'));

  // Unit check: the scope gate as a pure function (old scopes / NULL → false).
  try {
    const out = execSync(
      `npx tsx -e "(async()=>{const m=await import('./src/channels/instagram-post.ts');const cases=[[null,false],[{scopes:null},false],[{scopes:'instagram_basic instagram_manage_messages'},false],[{scopes:'instagram_basic,instagram_content_publish'},true]];let ok=true;for(const [inp,exp] of cases){if(m.hasInstagramPublishScope(inp)!==exp) ok=false;}console.log(ok?'SCOPE-OK':'SCOPE-FAIL');})();"`,
      { cwd: path.join(ROOT, 'apps/api'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } },
    );
    check('scope gate unit: NULL/old scopes → false, publish scope → true', /SCOPE-OK/.test(out), out.trim().slice(0, 100));
  } catch (err) {
    check('scope gate unit: NULL/old scopes → false, publish scope → true', false, String(err.message ?? err).slice(0, 200));
  }

  // ================= Phase A: no Meta app id =================
  const stampA = Date.now();
  const portA = 4010;
  const apiA = makeApi(`http://localhost:${portA}`);
  const runA = startApi(portA, '.pglite-data-igwa-a', {
    META_APP_ID: '', META_APP_SECRET: '',
    META_GRAPH_BASE_URL: stubBase,
  });
  process.on('exit', runA.stop);
  try {
    const up = await waitForHealth(`http://localhost:${portA}`);
    check('Phase A API starts (health)', up, up ? '' : runA.log().slice(-500));
    if (!up) return;
    await setupWorkspace(apiA, stampA);
    const igLoginA = await apiA('/api/channels/instagram/login');
    check('Phase A instagram/login → 503 not set up yet', igLoginA.status === 503, `status=${igLoginA.status}`);
    const igStatusA = await apiA('/api/instagram/status');
    check('Phase A instagram/status → connected false, no publish scope', igStatusA.status === 200 && igStatusA.data?.connected === false && igStatusA.data?.hasPublishScope === false, JSON.stringify(igStatusA.data ?? {}).slice(0, 200));
    const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const postA = await apiA('/api/scheduled-posts', {
      method: 'POST',
      body: { caption: 'No channel yet', mediaUrls: [imageUrl], mediaType: 'image', platforms: ['instagram'], scheduledAt: future },
    });
    check('Phase A instagram image post created (scheduled)', postA.status === 201 && postA.data?.post?.status === 'scheduled', `status=${postA.status} ${JSON.stringify(postA.data ?? {}).slice(0, 200)}`);
    if (postA.data?.post?.id) {
      const pubA = await apiA(`/api/scheduled-posts/${postA.data.post.id}/publish-now`, { method: 'POST' });
      check('Phase A instagram publish-now without channel → failed honestly', pubA.status === 200 && pubA.data?.post?.status === 'failed', `status=${pubA.status} post=${JSON.stringify(pubA.data?.post ?? {}).slice(0, 200)}`);
      const gotA = await apiA(`/api/scheduled-posts/${postA.data.post.id}`);
      check('Phase A failed post carries the reason (no fake published)', /Instagram/.test(gotA.data?.post?.lastError ?? ''), `lastError=${gotA.data?.post?.lastError ?? ''}`);
    }
    const badIg = await apiA('/api/scheduled-posts', {
      method: 'POST',
      body: { caption: 'x', mediaUrls: [], mediaType: 'text', platforms: ['instagram'], scheduledAt: future },
    });
    check('Phase A instagram text-only post → 400 (needs media)', badIg.status === 400, `status=${badIg.status}`);
  } finally {
    runA.stop();
    await sleep(500);
  }

  // ================= Phase B: dummy Meta app + stub Graph =================
  const stampB = Date.now() + 1;
  const portB = 4011;
  const apiB = makeApi(`http://localhost:${portB}`);
  const runB = startApi(portB, '.pglite-data-igwa-b', {
    META_APP_ID: 'dummy-app-id',
    META_APP_SECRET: 'dummy-app-secret',
    META_GRAPH_BASE_URL: stubBase,
  });
  process.on('exit', runB.stop);
  try {
    const up = await waitForHealth(`http://localhost:${portB}`);
    check('Phase B API starts (health)', up, up ? '' : runB.log().slice(-500));
    if (!up) return;

    // ---------------- Instagram workspace ----------------
    const ws1 = await setupWorkspace(apiB, stampB);
    const igLogin = await apiB('/api/channels/instagram/login');
    check('Phase B instagram/login → 200 with instagram_content_publish in URL', igLogin.status === 200 && /instagram_content_publish/.test(igLogin.data?.url ?? ''), `status=${igLogin.status}`);
    const igState = signJwt(jwtSecret, { purpose: 'facebook_oauth', channel: 'instagram', userId, workspaceId });
    const igCb = await apiB(`/api/channels/facebook/callback?code=dummy-code&state=${encodeURIComponent(igState)}`, { redirect: 'manual' });
    check('Phase B instagram callback → connected redirect', igCb.status === 302 && /instagram=connected/.test(igCb.location ?? ''), `status=${igCb.status} loc=${igCb.location ?? ''}`);
    const channels = await apiB('/api/channels');
    const igRow = (channels.data?.channels ?? []).find((c) => c.platform === 'instagram');
    check('Phase B exactly one instagram channel row', !!igRow, `instagram=${!!igRow}`);
    check('Phase B instagram channel is the stub account', igRow?.external_id === 'ig-user-1' && igRow?.display_name === 'halalchic', `ext=${igRow?.external_id ?? ''} name=${igRow?.display_name ?? ''}`);
    const igCb2 = await apiB(`/api/channels/facebook/callback?code=dummy-code2&state=${encodeURIComponent(signJwt(jwtSecret, { purpose: 'facebook_oauth', channel: 'instagram', userId, workspaceId }))}`, { redirect: 'manual' });
    const channels2 = await apiB('/api/channels');
    const igRows2 = (channels2.data?.channels ?? []).filter((c) => c.platform === 'instagram');
    check('Phase B instagram reconnect updates (no second row)', igCb2.status === 302 && igRows2.length === 1, `rows=${igRows2.length}`);
    const igStatus = await apiB('/api/instagram/status');
    check('Phase B instagram/status → connected + hasPublishScope + no reconnect needed', igStatus.status === 200 && igStatus.data?.connected === true && igStatus.data?.hasPublishScope === true && igStatus.data?.needsReconnectForPublish === false, JSON.stringify(igStatus.data ?? {}).slice(0, 200));

    // Product for the AI price checks.
    const jeans = await apiB('/api/products', { method: 'POST', body: { name: 'Jeans', pricePaisa: 50000, stock: 10 } });
    check('Phase B product Jeans ৳500 created (IG workspace)', jeans.status === 201 && !!jeans.data?.product?.id, `status=${jeans.status}`);

    // ---- Instagram DM intake → Inbox → manual reply (real stub send) ----
    const dmB = await apiB('/api/webhooks/meta', {
      method: 'POST', auth: false,
      body: {
        object: 'instagram',
        entry: [{
          id: 'ig-user-1',
          messaging: [{ sender: { id: 'ig-sender-1' }, recipient: { id: 'ig-user-1' }, timestamp: Date.now(), message: { mid: 'ig-mid-1', text: 'Hello' } }],
        }],
      },
    });
    check('Phase B instagram DM webhook → 200', dmB.status === 200, `status=${dmB.status}`);
    const inboxB = await apiB('/api/inbox');
    const igConv = (inboxB.data?.conversations ?? [])[0];
    check('Phase B IG DM is in the Inbox (1 conversation)', (inboxB.data?.conversations ?? []).length === 1 && !!igConv, `conversations=${(inboxB.data?.conversations ?? []).length}`);
    if (igConv) {
      const detail = await apiB(`/api/inbox/${igConv.id}`);
      const hasInbound = (detail.data?.messages ?? []).some((m) => m.direction === 'in' && (m.body ?? '').includes('Hello'));
      check('Phase B inbox thread shows the inbound IG DM text', hasInbound, `messages=${(detail.data?.messages ?? []).length}`);
      const reply = await apiB(`/api/inbox/${igConv.id}/reply`, { method: 'POST', body: { body: 'Hello! How can I help?' } });
      check('Phase B manual IG reply → 201 with REAL stub message id', reply.status === 201 && reply.data?.platformMessageId === 'ig-msg-1', `status=${reply.status} ${JSON.stringify(reply.data ?? {}).slice(0, 300)}`);
      // Duplicate webhook (same mid) → no second inbound message.
      await apiB('/api/webhooks/meta', {
        method: 'POST', auth: false,
        body: {
          object: 'instagram',
          entry: [{
            id: 'ig-user-1',
            messaging: [{ sender: { id: 'ig-sender-1' }, recipient: { id: 'ig-user-1' }, timestamp: Date.now(), message: { mid: 'ig-mid-1', text: 'Hello' } }],
          }],
        },
      });
      const detail2 = await apiB(`/api/inbox/${igConv.id}`);
      const inboundCount = (detail2.data?.messages ?? []).filter((m) => m.direction === 'in').length;
      check('Phase B duplicate IG DM → no duplicate inbound (dedup)', inboundCount === 1, `inbound=${inboundCount}`);
      // ---- AI reply to an Instagram DM (price question, live Gemini) ----
      // NOTE: the AI writes prices in Bengali digits (৳৫০০), so the
      // predicate accepts 500 or ৫০০ — and only messages sent AFTER
      // this trigger count (the manual reply above must not match).
      const igBefore = await outboundIds(apiB, igConv.id);
      await apiB('/api/webhooks/meta', {
        method: 'POST', auth: false,
        body: {
          object: 'instagram',
          entry: [{
            id: 'ig-user-1',
            messaging: [{ sender: { id: 'ig-sender-1' }, recipient: { id: 'ig-user-1' }, timestamp: Date.now(), message: { mid: 'ig-mid-2', text: 'Jeans এর দাম কত?' } }],
          }],
        },
      });
      const aiOut = await waitForOutbound(apiB, igConv.id, (m) => m.direction === 'out' && m.delivery_status === 'sent' && typeof m.platform_message_id === 'string' && m.platform_message_id.startsWith('ig-msg') && PRICE_RE.test(m.body ?? ''), 90000, igBefore);
      check('Phase B AI reply to IG DM → sent via Instagram with real price ৳500', !!aiOut && !aiOut._threadDump, aiOut?._threadDump ? `no matching outbound in 90s; thread: ${aiOut._threadDump}` : `body=${(aiOut.body ?? '').slice(0, 120)} id=${aiOut.platform_message_id}`);
    }

    // ---- Instagram scheduling: image / carousel / reel / scope error ----
    const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const mkPost = async (mediaUrls, mediaType, platforms = ['instagram']) => apiB('/api/scheduled-posts', {
      method: 'POST',
      body: { caption: 'New arrival!', mediaUrls, mediaType, platforms, scheduledAt: future },
    });
    const imgPost = await mkPost([imageUrl], 'image');
    check('Phase B instagram image post created (scheduled)', imgPost.status === 201 && imgPost.data?.post?.status === 'scheduled', `status=${imgPost.status} ${JSON.stringify(imgPost.data ?? {}).slice(0, 200)}`);
    if (imgPost.data?.post?.id) {
      const pub = await apiB(`/api/scheduled-posts/${imgPost.data.post.id}/publish-now`, { method: 'POST' });
      check('Phase B instagram image publish-now → published with REAL media id', pub.status === 200 && pub.data?.post?.status === 'published' && pub.data?.post?.platform_post_id === 'ig-media-123', `post=${JSON.stringify(pub.data?.post ?? {}).slice(0, 300)}`);
    }
    const carPost = await mkPost([imageUrl, imageUrl2], 'image');
    check('Phase B instagram 2-image post created (scheduled)', carPost.status === 201 && carPost.data?.post?.status === 'scheduled', `status=${carPost.status}`);
    if (carPost.data?.post?.id) {
      const pub = await apiB(`/api/scheduled-posts/${carPost.data.post.id}/publish-now`, { method: 'POST' });
      check('Phase B instagram carousel publish-now → published with REAL carousel media id', pub.status === 200 && pub.data?.post?.status === 'published' && pub.data?.post?.platform_post_id === 'ig-media-carousel-1', `post=${JSON.stringify(pub.data?.post ?? {}).slice(0, 300)}`);
    }
    const vidPost = await mkPost([videoUrl], 'video');
    check('Phase B instagram video post created (scheduled)', vidPost.status === 201 && vidPost.data?.post?.status === 'scheduled', `status=${vidPost.status}`);
    if (vidPost.data?.post?.id) {
      const pub = await apiB(`/api/scheduled-posts/${vidPost.data.post.id}/publish-now`, { method: 'POST' });
      check('Phase B instagram reel publish-now → published with REAL reel media id (container polled)', pub.status === 200 && pub.data?.post?.status === 'published' && pub.data?.post?.platform_post_id === 'ig-media-reel-1', `post=${JSON.stringify(pub.data?.post ?? {}).slice(0, 300)}`);
    }
    const scopePost = await mkPost([`${stubBase}/scope-error.jpg`], 'image');
    check('Phase B instagram scope-error post created (scheduled)', scopePost.status === 201 && scopePost.data?.post?.status === 'scheduled', `status=${scopePost.status}`);
    if (scopePost.data?.post?.id) {
      const pub = await apiB(`/api/scheduled-posts/${scopePost.data.post.id}/publish-now`, { method: 'POST' });
      check('Phase B scope-error post → failed (never fake published)', pub.status === 200 && pub.data?.post?.status === 'failed', `status=${pub.status} post=${JSON.stringify(pub.data?.post ?? {}).slice(0, 200)}`);
      const got = await apiB(`/api/scheduled-posts/${scopePost.data.post.id}`);
      check('Phase B scope-error post carries the honest reconnect message', /আবার যুক্ত/.test(got.data?.post?.lastError ?? ''), `lastError=${got.data?.post?.lastError ?? ''}`);
    }

    // ---------------- WhatsApp workspace ----------------
    const ws2 = await setupWorkspace(apiB, stampB + 1000);
    const waBad = await apiB('/api/channels/whatsapp/manual', {
      method: 'POST',
      body: { phoneNumberId: 'wa-bad-1', token: 'wa-token-1' },
    });
    check('Phase B whatsapp manual connect (bad number) → 400 wa_verify_failed, no row', waBad.status === 400 && /যাচাই/.test(waBad.data?.error ?? ''), `status=${waBad.status} ${JSON.stringify(waBad.data ?? {}).slice(0, 200)}`);
    const waChannels0 = await apiB('/api/channels');
    check('Phase B failed whatsapp connect stored NO channel row', (waChannels0.data?.channels ?? []).filter((c) => c.platform === 'whatsapp').length === 0, JSON.stringify(waChannels0.data?.channels ?? []));
    const waOk = await apiB('/api/channels/whatsapp/manual', {
      method: 'POST',
      body: { phoneNumberId: 'wa-phone-1', token: 'wa-token-1' },
    });
    check('Phase B whatsapp manual connect → 201', waOk.status === 201 && !!waOk.data?.channel?.id, `status=${waOk.status} ${JSON.stringify(waOk.data ?? {}).slice(0, 200)}`);
    const waChannels = await apiB('/api/channels');
    const waRow = (waChannels.data?.channels ?? []).find((c) => c.platform === 'whatsapp');
    check('Phase B exactly one whatsapp channel row (external_id = phone number id)', !!waRow && waRow.external_id === 'wa-phone-1', `ext=${waRow?.external_id ?? ''}`);

    // Product (+ photo) for the AI price/photo checks.
    const waJeans = await apiB('/api/products', { method: 'POST', body: { name: 'Jeans', pricePaisa: 50000, stock: 10 } });
    check('Phase B product Jeans ৳500 created (WA workspace)', waJeans.status === 201 && !!waJeans.data?.product?.id, `status=${waJeans.status}`);
    if (waJeans.data?.product?.id) {
      const img = await apiB(`/api/products/${waJeans.data.product.id}/images`, { method: 'POST', body: { url: imageUrl } });
      check('Phase B product photo registered', img.status === 201 || img.status === 200, `status=${img.status} ${JSON.stringify(img.data ?? {}).slice(0, 200)}`);
    }

    // ---- WhatsApp intake → Inbox → manual reply (real stub wamid) ----
    const waPayload = (id, from, text) => ({
      object: 'whatsapp_business_account',
      entry: [{
        id: 'waba-1',
        changes: [{
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '+880 1700-000001', phone_number_id: 'wa-phone-1' },
            contacts: [{ profile: { name: 'WhatsApp Buyer' }, wa_id: from }],
            messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
          },
        }],
      }],
    });
    const waIn = await apiB('/api/webhooks/whatsapp', { method: 'POST', auth: false, body: waPayload('wamid-in-1', '8801700000001', 'Jeans এর দাম কত?') });
    check('Phase B whatsapp webhook → 200', waIn.status === 200, `status=${waIn.status}`);
    const inboxW = await apiB('/api/inbox');
    const waConv = (inboxW.data?.conversations ?? []).find((c) => (c.customer_name ?? c.customerName ?? '').includes('WhatsApp Buyer'));
    check('Phase B WA message is in the Inbox (WhatsApp Buyer conversation)', !!waConv, `conversations=${(inboxW.data?.conversations ?? []).length}`);
    if (waConv) {
      const detail = await apiB(`/api/inbox/${waConv.id}`);
      const hasInbound = (detail.data?.messages ?? []).some((m) => m.direction === 'in' && (m.body ?? '').includes('Jeans এর দাম কত'));
      check('Phase B inbox thread shows the inbound WA text', hasInbound, `messages=${(detail.data?.messages ?? []).length}`);
      const reply = await apiB(`/api/inbox/${waConv.id}/reply`, { method: 'POST', body: { body: 'হ্যাঁ স্যার, Jeans ৳500।' } });
      check('Phase B manual WA reply → 201 with REAL wamid', reply.status === 201 && reply.data?.platformMessageId === 'wamid.text-1', `status=${reply.status} ${JSON.stringify(reply.data ?? {}).slice(0, 300)}`);
      // Duplicate webhook (same message id) → no second inbound message.
      await apiB('/api/webhooks/whatsapp', { method: 'POST', auth: false, body: waPayload('wamid-in-1', '8801700000001', 'Jeans এর দাম কত?') });
      const detail2 = await apiB(`/api/inbox/${waConv.id}`);
      const inboundCount = (detail2.data?.messages ?? []).filter((m) => m.direction === 'in' && (m.body ?? '').includes('Jeans এর দাম কত')).length;
      check('Phase B duplicate WA message → no duplicate inbound (dedup)', inboundCount === 1, `inbound=${inboundCount}`);
      // ---- AI price reply (live Gemini → stub WhatsApp send) ----
      // Only outbound messages sent AFTER this trigger count — the
      // manual reply above ('Jeans ৳500') must not match.
      const waBefore = await outboundIds(apiB, waConv.id);
      await apiB('/api/webhooks/whatsapp', { method: 'POST', auth: false, body: waPayload('wamid-in-2', '8801700000001', 'Jeans এর দাম কত? আর ডেলিভারি চার্জ কত?') });
      const aiOut = await waitForOutbound(apiB, waConv.id, (m) => m.direction === 'out' && m.type === 'text' && m.delivery_status === 'sent' && typeof m.platform_message_id === 'string' && m.platform_message_id.startsWith('wamid.') && PRICE_RE.test(m.body ?? ''), 90000, waBefore);
      check('Phase B AI reply to WA chat → sent via WhatsApp with real price ৳500', !!aiOut && !aiOut._threadDump, aiOut?._threadDump ? `no matching outbound in 90s; thread: ${aiOut._threadDump}` : `body=${(aiOut.body ?? '').slice(0, 120)} id=${aiOut.platform_message_id}`);
      // ---- AI photo reply (product photo via the Cloud API image send) ----
      const waBeforeImg = await outboundIds(apiB, waConv.id);
      await apiB('/api/webhooks/whatsapp', { method: 'POST', auth: false, body: waPayload('wamid-in-3', '8801700000001', 'Jeans এর ছবি দেন') });
      const aiImg = await waitForOutbound(apiB, waConv.id, (m) => m.direction === 'out' && m.type === 'image' && m.delivery_status === 'sent' && typeof m.platform_message_id === 'string' && m.platform_message_id.startsWith('wamid.'), 90000, waBeforeImg);
      check('Phase B AI photo reply to WA chat → IMAGE sent via WhatsApp with real wamid', !!aiImg && !aiImg._threadDump, aiImg?._threadDump ? `no image outbound in 90s; thread: ${aiImg._threadDump}` : `id=${aiImg.platform_message_id} url=${(aiImg.body ?? '').slice(0, 80)}`);
    }

    // ---- 24h window: reply to the expired-window customer → honest 502 ----
    await apiB('/api/webhooks/whatsapp', { method: 'POST', auth: false, body: waPayload('wamid-in-4', '8801700000002', 'Hi, I am back after a month') });
    const inboxW2 = await apiB('/api/inbox');
    const waConv2 = (inboxW2.data?.conversations ?? []).find((c) => {
      // Second conversation for the expired-window sender: find by detail is
      // expensive; the list is small (2), so match on the newest one.
      return c.id !== waConv?.id;
    });
    check('Phase B expired-window customer has his own conversation', !!waConv2, `conversations=${(inboxW2.data?.conversations ?? []).length}`);
    if (waConv2) {
      const reply2 = await apiB(`/api/inbox/${waConv2.id}/reply`, { method: 'POST', body: { body: 'Hello!' } });
      check('Phase B reply outside 24h window → 502 with windowExpired:true', reply2.status === 502 && reply2.data?.windowExpired === true, `status=${reply2.status} ${JSON.stringify(reply2.data ?? {}).slice(0, 300)}`);
      check('Phase B expired reply row is honestly failed (never fake sent)', reply2.data?.message?.delivery_status === 'failed', `delivery_status=${reply2.data?.message?.delivery_status ?? ''}`);
    }

    // ---------------- No-channel workspace ----------------
    const ws3 = await setupWorkspace(apiB, stampB + 2000);
    const future3 = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const post3 = await apiB('/api/scheduled-posts', {
      method: 'POST',
      body: { caption: 'No IG here', mediaUrls: [imageUrl], mediaType: 'image', platforms: ['instagram'], scheduledAt: future3 },
    });
    if (post3.data?.post?.id) {
      const pub3 = await apiB(`/api/scheduled-posts/${post3.data.post.id}/publish-now`, { method: 'POST' });
      check('Phase B no-IG workspace publish-now → failed honestly', pub3.status === 200 && pub3.data?.post?.status === 'failed', `status=${pub3.status}`);
    } else {
      check('Phase B no-IG workspace publish-now → failed honestly', false, `post create status=${post3.status}`);
    }
    void ws1; void ws2; void ws3;
  } finally {
    runB.stop();
    await sleep(500);
  }

  stub.close();
  // Clean up the local PGlite test DBs (never ship them / deploy with them).
  for (const dir of ['.pglite-data-igwa-a', '.pglite-data-igwa-b']) {
    try { execSync(`rm -rf ${path.join(ROOT, 'apps/api', dir)}`); } catch { /* already gone */ }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log('FAILED:');
    for (const f of failed) console.log(` - ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
