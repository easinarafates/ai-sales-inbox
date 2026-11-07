#!/usr/bin/env node
/**
 * Verification for customer name + photo from Meta (area 4).
 * Local, offline — no calls to graph.facebook.com, no Meta app needed.
 *
 * A stub Graph server stands in for graph.facebook.com:
 *   GET /v21.0/psid-ok     → Messenger profile (Rina Akter + photo)
 *   GET /v21.0/psid-err    → Graph 400 (profile unavailable)
 *   GET /v21.0/psid-empty  → 200 {} (no profile fields at all)
 *   GET /v21.0/psid-conv   → Graph 400 (direct PSID read blocked) —
 *                             the Page conversations endpoint below then
 *                             returns the real name (Karim Uddin + photo)
 *   GET /v21.0/page-profile-ok/conversations?user_id=psid-conv
 *                         → participants incl. Karim Uddin; any other
 *                           user_id → empty data []
 *   GET /v21.0/igsid-ok    → Instagram profile (name + profile_picture_url)
 *   anything else          → 400 invalid token
 *
 * Checks:
 * - Migration 16 adds customers.picture_url (idempotent).
 * - First Messenger message from a new sender stores the fetched name +
 *   photo; the Inbox list + detail show them.
 * - A repeat message from the same sender does NOT fetch again.
 * - Graph error / empty profile → graceful fallback ("Unknown"), the
 *   message is still saved and the webhook still returns 200.
 * - Instagram first sight stores name + photo too.
 * - A channel with no Page token skips the fetch and still saves the
 *   message (no crash, no stub hit).
 * - Web Inbox renders the photo with an initials fallback (static).
 *
 * Run from the repo root:  node scripts/verify-customer-profile.mjs
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
let workspaceId = '';

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
  const email = `profile+${stamp}@example.com`;
  const signup = await api('/api/auth/signup', {
    method: 'POST', auth: false,
    body: { name: 'Profile Owner', email, password: 'verify1234', workspaceName: 'Profile Shop' },
  });
  check('signup', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
  token = signup.data?.token ?? '';
  workspaceId = signup.data?.workspace?.id ?? '';
}

async function sendCustomerMessage(api, pageId, senderId, mid, text, object = 'page') {
  return api('/api/webhooks/meta', {
    method: 'POST', auth: false,
    body: { object, entry: [{ id: pageId, messaging: [{ sender: { id: senderId }, recipient: { id: pageId }, message: { mid, text } }] }] },
  });
}

async function findConvByLastMessage(api, text) {
  const list = await api('/api/inbox');
  return (list.data?.conversations ?? []).find((c) => c.last_message === text) ?? null;
}

async function main() {
  // ---------- Static checks ----------
  const profileSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/meta-profile.ts'), 'utf8');
  check('meta-profile helper exists', profileSrc.length > 0);
  check('helper fetches Messenger first_name/last_name/profile_pic', profileSrc.includes('first_name,last_name,profile_pic'));
  check('helper fetches IG name/username/profile_picture_url', profileSrc.includes('name,username,profile_picture_url'));
  check('helper uses Graph v21.0 (same base as meta-oauth)', profileSrc.includes("from './meta-oauth'") && profileSrc.includes('GRAPH_BASE'));
  check('helper never throws (fetch + enrich return null / swallow)', (profileSrc.includes('catch {') || profileSrc.includes('catch (err)')) && profileSrc.includes('return null'));
  check('helper sends the Page token as Bearer (never in a URL)', profileSrc.includes('Authorization: `Bearer ${input.pageToken}`') && !profileSrc.includes('access_token=${'));
  check('helper only fills missing name/picture (never overwrites)', profileSrc.includes('input.customerName ?? profile.name') && profileSrc.includes('input.customerPictureUrl ?? profile.pictureUrl'));
  // (Manual-photo update, 2026-11-07: the guard is now needName/needPicture —
  // a 'manual' photo is never refreshed — but it still skips the fetch
  // entirely when the customer already has both name and picture.)
  check('helper skips the fetch when name + picture are already known', profileSrc.includes('if (!needName && !needPicture) return;'));
  check('helper falls back to the Page conversations endpoint when the direct PSID read is blocked', profileSrc.includes('/conversations?user_id=') && profileSrc.includes('participants'));
  check('helper takes the participant whose id matches the sender', profileSrc.includes('!== senderId') || profileSrc.includes('=== senderId'));
  check('helper logs profile failures instead of failing silently', profileSrc.includes('console.warn') && profileSrc.includes('[meta-profile]'));

  const whSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/webhooks/routes.ts'), 'utf8');
  check('webhook calls enrichCustomerProfileIfNeeded on Messenger/IG DMs', whSrc.includes('enrichCustomerProfileIfNeeded'));
  check('webhook enrich is best-effort (failure logged, never breaks intake)', whSrc.includes('profile enrich failed'));
  check('webhook reads the channel Page token for the fetch', whSrc.includes('decryptToken(channel.token_encrypted)'));
  check('webhook passes the Page ID so the conversations fallback can run', whSrc.includes('pageId'));
  check('webhook customer row carries picture_url', whSrc.includes('picture_url'));

  const mig16 = fs.readFileSync(path.join(ROOT, 'apps/api/src/db/migrations/16-customer-profile-picture.sql'), 'utf8');
  check('migration 16 adds customers.picture_url (idempotent)', mig16.includes('picture_url') && mig16.includes('IF NOT EXISTS'));

  const inboxSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/inbox/routes.ts'), 'utf8');
  check('inbox list + detail return customer_picture_url', inboxSrc.includes('cu.picture_url AS customer_picture_url'));
  // (Manual-photo update, 2026-11-07: the detail SELECT now also returns
  // picture_source between picture_url and channel_identities.)
  check('inbox detail returns the customer picture_url', inboxSrc.includes('picture_url, picture_source, channel_identities'));

  const pageSrc = fs.readFileSync(path.join(ROOT, 'apps/web/app/inbox/page.tsx'), 'utf8');
  check('inbox page renders a photo avatar with initials fallback', pageSrc.includes('<img src={pictureUrl}') && pageSrc.includes('CustomerAvatar'));
  check('inbox initials avatar uses a per-customer colour (recognisable without a photo)', pageSrc.includes('AVATAR_COLORS') && pageSrc.includes('avatarColor(name)'));
  check('inbox page shows the avatar in the list + thread header + profile card', pageSrc.includes('convPicture(c)') && pageSrc.includes('sizeClass="h-12 w-12"') && pageSrc.includes('sizeClass="h-14 w-14"'));

  // ---------- Stub Graph server ----------
  const stubHits = [];
  const graphStub = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    stubHits.push({ method: req.method, path: url.pathname, auth: req.headers.authorization ?? '' });
    const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'GET' && url.pathname === '/v21.0/psid-ok') {
      return send(200, { id: 'psid-ok', first_name: 'Rina', last_name: 'Akter', profile_pic: { url: 'https://example.com/rina.jpg' } });
    }
    if (req.method === 'GET' && url.pathname === '/v21.0/psid-err') {
      return send(400, { error: { message: '(#100) No matching user found.', type: 'OAuthException', code: 100 } });
    }
    if (req.method === 'GET' && url.pathname === '/v21.0/psid-empty') {
      return send(200, { id: 'psid-empty' });
    }
    if (req.method === 'GET' && url.pathname === '/v21.0/igsid-ok') {
      return send(200, { id: 'igsid-ok', name: 'Rongdhonu Fashion', username: 'rongdhonu.fashion', profile_picture_url: 'https://example.com/ig-rina.jpg' });
    }
    if (req.method === 'GET' && url.pathname === '/v21.0/psid-nopic') {
      // Live case (2026-11-07): direct PSID read blocked exactly like Meta
      // does for phone-registered senders — 400 GraphMethodException 100/33.
      return send(400, { error: { message: "Unsupported get request. Object with ID 'psid-nopic' does not exist, cannot be loaded due to missing permissions, or does not support this operation.", type: 'GraphMethodException', code: 100, error_subcode: 33 } });
    }
    // Page conversations fallback: direct PSID read is blocked (400 above),
    // but the Page's conversations endpoint returns the participant's name.
    if (req.method === 'GET' && url.pathname === '/v21.0/page-profile-ok/conversations') {
      if (url.searchParams.get('user_id') === 'psid-conv') {
        return send(200, { data: [{ id: 'conv-1', participants: [{ id: 'psid-conv', name: 'Karim Uddin', picture: { data: { url: 'https://example.com/karim.jpg' } } }, { id: 'page-profile-ok', name: 'Profile Page' }] }] });
      }
      if (url.searchParams.get('user_id') === 'psid-nopic') {
        // Live case (2026-11-07): Meta strips the picture field for
        // page-scoped users — the participant carries a name but NO photo.
        return send(200, { data: [{ id: 'conv-2', participants: [{ id: 'psid-nopic', name: 'Tanvir Hasan' }, { id: 'page-profile-ok', name: 'Profile Page' }] }] });
      }
      return send(200, { data: [] });
    }
    return send(400, { error: { message: 'Invalid OAuth access token.', type: 'OAuthException', code: 190 } });
  });
  const stubPort = 4013;
  await new Promise((resolve) => graphStub.listen(stubPort, resolve));

  const stamp = Date.now();
  const port = 4011;
  const api = makeApi(`http://localhost:${port}`);
  const run = startApi(port, '.pglite-data-profile', {
    META_APP_ID: 'dummy-app-id',
    META_APP_SECRET: 'dummy-secret',
    META_GRAPH_BASE_URL: `http://localhost:${stubPort}/v21.0`,
  });
  process.on('exit', run.stop);
  try {
    const up = await waitForHealth(`http://localhost:${port}`);
    check('API starts (health)', up, up ? '' : run.log().slice(-500));
    if (!up) return;

    // ---- Messenger: happy path + first-sight-only ----
    await setupWorkspace(api, stamp);
    const ch1 = await api('/api/channels', { method: 'POST', body: { platform: 'messenger', externalId: 'page-profile-ok', displayName: 'Profile Page', token: 'tok-profile-page' } });
    check('messenger channel (stub token) → 201', ch1.status === 201, `status=${ch1.status}`);
    const hook1 = await sendCustomerMessage(api, 'page-profile-ok', 'psid-ok', `p1-mid-${stamp}`, 'শাড়ির দাম কত?');
    check('webhook accepts the first message', hook1.status === 200, `status=${hook1.status}`);
    const conv1 = await findConvByLastMessage(api, 'শাড়ির দাম কত?');
    check('conversation created for the new sender', !!conv1?.id, `conv=${conv1?.id ?? ''}`);
    check('inbox list shows the fetched name', conv1?.customer_name === 'Rina Akter', `customer_name=${conv1?.customer_name ?? ''}`);
    check('inbox list shows the fetched photo URL', conv1?.customer_picture_url === 'https://example.com/rina.jpg', `customer_picture_url=${conv1?.customer_picture_url ?? ''}`);
    if (conv1) {
      const detail1 = await api(`/api/inbox/${conv1.id}`);
      check('inbox detail shows the customer name + photo', detail1.data?.customer?.name === 'Rina Akter' && detail1.data?.customer?.picture_url === 'https://example.com/rina.jpg', JSON.stringify(detail1.data?.customer ?? null));
      check('inbox detail has the incoming message saved', (detail1.data?.messages ?? []).some((m) => m.direction === 'in' && m.body === 'শাড়ির দাম কত?'), `messages=${(detail1.data?.messages ?? []).length}`);
    }
    check('stub Graph got exactly one profile fetch (Page token as Bearer)', stubHits.filter((h) => h.path === '/v21.0/psid-ok').length === 1 && stubHits.find((h) => h.path === '/v21.0/psid-ok')?.auth === 'Bearer tok-profile-page', `hits=${JSON.stringify(stubHits)}`);
    const hook1b = await sendCustomerMessage(api, 'page-profile-ok', 'psid-ok', `p1-mid2-${stamp}`, 'আরেকটা মেসেজ');
    check('repeat message accepted', hook1b.status === 200, `status=${hook1b.status}`);
    check('repeat message does NOT fetch the profile again', stubHits.filter((h) => h.path === '/v21.0/psid-ok').length === 1, `profile hits=${stubHits.filter((h) => h.path === '/v21.0/psid-ok').length}`);
    const conv1b = await findConvByLastMessage(api, 'আরেকটা মেসেজ');
    check('repeat message lands in the same conversation', !!conv1b && conv1b.id === conv1?.id, `conv=${conv1b?.id ?? ''} vs ${conv1?.id ?? ''}`);

    // ---- Messenger: direct PSID read blocked (400) → conversations fallback ----
    const hookConv = await sendCustomerMessage(api, 'page-profile-ok', 'psid-conv', `p1-mid-conv-${stamp}`, 'ফলব্যাক টেস্ট');
    check('webhook accepts the message when the direct profile read is blocked', hookConv.status === 200, `status=${hookConv.status}`);
    const convConv = await findConvByLastMessage(api, 'ফলব্যাক টেস্ট');
    check('conversations fallback stores the real name', convConv?.customer_name === 'Karim Uddin', `customer_name=${convConv?.customer_name ?? ''}`);
    check('conversations fallback stores the real photo URL', convConv?.customer_picture_url === 'https://example.com/karim.jpg', `customer_picture_url=${convConv?.customer_picture_url ?? ''}`);
    check('fallback hit both the direct read (400) and the conversations endpoint', stubHits.some((h) => h.path === '/v21.0/psid-conv') && stubHits.some((h) => h.path === '/v21.0/page-profile-ok/conversations' && h.auth === 'Bearer tok-profile-page'), `hits=${JSON.stringify(stubHits.filter((h) => h.path.includes('psid-conv') || h.path.includes('conversations')))}`);

    // ---- Messenger: Meta returns a name but NO photo (live case) ----
    const hookNoPic = await sendCustomerMessage(api, 'page-profile-ok', 'psid-nopic', `p1-mid-nopic-${stamp}`, 'ছবি ছাড়া টেস্ট');
    check('webhook accepts the message when Meta returns no photo', hookNoPic.status === 200, `status=${hookNoPic.status}`);
    const convNoPic = await findConvByLastMessage(api, 'ছবি ছাড়া টেস্ট');
    check('no-photo fallback stores the real name', convNoPic?.customer_name === 'Tanvir Hasan', `customer_name=${convNoPic?.customer_name ?? ''}`);
    check('no-photo fallback leaves picture_url NULL (never invents a photo)', !convNoPic?.customer_picture_url, `customer_picture_url=${convNoPic?.customer_picture_url ?? ''}`);

    // ---- Messenger: Graph error → graceful fallback, message still saved ----
    const hookErr = await sendCustomerMessage(api, 'page-profile-ok', 'psid-err', `p1-mid-err-${stamp}`, 'এরর টেস্ট');
    check('webhook accepts the message even when Graph errors', hookErr.status === 200, `status=${hookErr.status}`);
    const convErr = await findConvByLastMessage(api, 'এরর টেস্ট');
    check('Graph-error sender still gets a conversation', !!convErr?.id, `conv=${convErr?.id ?? ''}`);
    check('Graph-error sender falls back to Unknown (no name/photo)', !convErr?.customer_name && !convErr?.customer_picture_url, `name=${convErr?.customer_name ?? ''}, pic=${convErr?.customer_picture_url ?? ''}`);

    // ---- Messenger: empty profile → graceful fallback ----
    const hookEmpty = await sendCustomerMessage(api, 'page-profile-ok', 'psid-empty', `p1-mid-empty-${stamp}`, 'খালি প্রোফাইল টেস্ট');
    check('webhook accepts the message when Graph returns no profile fields', hookEmpty.status === 200, `status=${hookEmpty.status}`);
    const convEmpty = await findConvByLastMessage(api, 'খালি প্রোফাইল টেস্ট');
    check('empty-profile sender falls back to Unknown', !!convEmpty?.id && !convEmpty?.customer_name && !convEmpty?.customer_picture_url, `name=${convEmpty?.customer_name ?? ''}`);

    // ---- Instagram: first sight stores name + photo ----
    await setupWorkspace(api, stamp + 1);
    const chIg = await api('/api/channels', { method: 'POST', body: { platform: 'instagram', externalId: 'ig-profile-ok', displayName: 'ig.shop', token: 'tok-ig-profile' } });
    check('instagram channel (stub token) → 201', chIg.status === 201, `status=${chIg.status}`);
    const hookIg = await sendCustomerMessage(api, 'ig-profile-ok', 'igsid-ok', `ig-mid-${stamp}`, 'হ্যালো', 'instagram');
    check('IG webhook accepts the message', hookIg.status === 200, `status=${hookIg.status}`);
    const convIg = await findConvByLastMessage(api, 'হ্যালো');
    check('IG inbox list shows the fetched name', convIg?.customer_name === 'Rongdhonu Fashion', `customer_name=${convIg?.customer_name ?? ''}`);
    check('IG inbox list shows the fetched photo URL', convIg?.customer_picture_url === 'https://example.com/ig-rina.jpg', `customer_picture_url=${convIg?.customer_picture_url ?? ''}`);
    check('stub Graph got the IG profile fetch (Page token as Bearer)', stubHits.some((h) => h.path === '/v21.0/igsid-ok' && h.auth === 'Bearer tok-ig-profile'), `hits=${JSON.stringify(stubHits.filter((h) => h.path.includes('igsid')))}`);

    // ---- No Page token: no fetch, message still saved ----
    await setupWorkspace(api, stamp + 2);
    const chNoTok = await api('/api/channels', { method: 'POST', body: { platform: 'messenger', externalId: 'page-no-token', displayName: 'No Token Page' } });
    check('messenger channel without token → 201', chNoTok.status === 201, `status=${chNoTok.status}`);
    const hitsBefore = stubHits.length;
    const hookNoTok = await sendCustomerMessage(api, 'page-no-token', 'psid-ok', `p3-mid-${stamp}`, 'টোকেন ছাড়া মেসেজ');
    check('webhook accepts the message without a Page token', hookNoTok.status === 200, `status=${hookNoTok.status}`);
    check('no-token channel makes no Graph call', stubHits.length === hitsBefore, `hits before=${hitsBefore}, after=${stubHits.length}`);
    const convNoTok = await findConvByLastMessage(api, 'টোকেন ছাড়া মেসেজ');
    check('no-token sender still gets a conversation (Unknown)', !!convNoTok?.id && !convNoTok?.customer_name, `conv=${convNoTok?.id ?? ''}`);
  } finally {
    run.stop();
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
