#!/usr/bin/env node
/**
 * Verification for manual customer photos (Inbox upload).
 * Run from the repo root:
 *   node scripts/verify-customer-photo.mjs
 *
 * Starts its OWN API (tsx, port 4017) on a throwaway PGlite data dir in
 * /tmp, so it never touches the real local database or port 4000. A stub
 * Graph server (port 4018) stands in for graph.facebook.com.
 *
 * Covers:
 * - Migration 18 adds customers.picture_source (idempotent) and the
 *   Meta refresh never overwrites a manual photo (static + live).
 * - POST /api/customers/:id/photo accepts a base64 image and an
 *   already-uploaded URL; stores picture_url + picture_source='manual';
 *   the Inbox list + detail show the manual photo.
 * - A manual photo survives a later Meta refresh that DOES return a
 *   (different) photo — including when the customer's name is still
 *   missing and the refresh runs to fill the name.
 * - DELETE /api/customers/:id/photo clears the photo (back to
 *   initials); a later Meta refresh may fill a Meta photo again.
 * - Validation: non-image upload 400, invalid URL 400, bad UUID 400,
 *   missing customer 404, unauthenticated 401, cross-workspace 404,
 *   upload-token without a Blob token 503.
 * - Merge preserves photos: the kept customer's photo wins; a kept
 *   customer with no photo inherits the merged customer's photo.
 * - User-token fallbacks (migration 20): the probe script
 *   scripts/verify-user-token-photo.ts runs here too — the same routes
 *   retried with the Page admin's USER token. It also proves the
 *   removed /me/picture owner route is never called: that endpoint
 *   returns the connecting account's photo, not the sender's, so it
 *   must never store a customer photo. Its PASS/FAIL lines are folded
 *   into this count.
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 * NOTE: uses only test data in a fresh workspace; nothing is sent to Meta.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = path.join(ROOT, 'apps', 'api');
const PORT = Number(process.env.VERIFY_PORT ?? 4017);
const STUB_PORT = Number(process.env.VERIFY_STUB_PORT ?? 4018);
const API = `http://localhost:${PORT}`;
const results = [];
let token = '';
let tokenB = '';

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, { method = 'GET', body, auth = true, useToken = token } = {}) {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(auth && useToken ? { Authorization: `Bearer ${useToken}` } : {}),
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
}

function parseEnvFile(file) {
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

async function waitForHealth(child, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`API exited early with code ${child.exitCode}`);
    try {
      const res = await fetch(`${API}/api/health`);
      if (res.status === 200) return true;
    } catch {
      // not up yet
    }
    await sleep(1000);
  }
  throw new Error('timed out waiting for API health');
}

// 1x1 transparent PNG (base64, no data: prefix — the endpoint accepts both).
const PNG_1X1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// "hello" as text/plain base64 — must be rejected (not an image).
const TEXT_B64 = Buffer.from('hello, not an image').toString('base64');

// Stub Graph: the conversations endpoint returns a name for the no-pic
// senders, and a photo ONLY when the verifier flips it on via the
// test-only /__test/set-photo control route (simulates Meta starting
// to return a photo for a sender who previously had none).
const nopicPhotos = new Map(); // senderId -> photo URL (or null = no photo)
// psid-noname: the conversations endpoint finds NO participant at first
// (so the name stays NULL); the verifier flips nonameReady on to
// simulate Meta later returning a name + photo for this sender.
let nonameReady = false;

async function main() {
  // ---------- Static checks ----------
  const mig18 = fs.readFileSync(path.join(ROOT, 'apps/api/src/db/migrations/18-customer-picture-source.sql'), 'utf8');
  check('migration 18 adds customers.picture_source (idempotent)', mig18.includes('picture_source') && mig18.includes('IF NOT EXISTS'));
  check('migration 18 backfills existing photos as meta', mig18.includes("'meta'"));

  const profileSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/meta-profile.ts'), 'utf8');
  check('meta-profile tracks picture_source (manual vs meta)', profileSrc.includes('customerPictureSource') && profileSrc.includes("'manual'"));
  check('meta-profile never overwrites a manual photo', profileSrc.includes("const pictureIsManual = input.customerPictureSource === 'manual'") && profileSrc.includes('? input.customerPictureUrl'));
  check('meta-profile marks Meta-filled photos as meta', profileSrc.includes("? 'meta'"));

  const custSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/customers/routes.ts'), 'utf8');
  check('customers router has POST /:id/photo', custSrc.includes("/:id/photo") && custSrc.includes("picture_source = 'manual'"));
  check('customers router has DELETE /:id/photo', custSrc.includes("picture_url = NULL, picture_source = NULL"));
  check('customers router has POST /customers/upload-token', custSrc.includes("'/customers/upload-token'") && custSrc.includes('handleUpload'));
  check('customers list/detail return picture_url + picture_source', custSrc.includes('picture_url, picture_source, channel_identities'));
  check('merge preserves photos (kept wins, else inherits)', custSrc.includes('picture_url = COALESCE(picture_url, $5)'));

  const whSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/webhooks/routes.ts'), 'utf8');
  check('webhook passes picture_source into the profile enrich', whSrc.includes('customerPictureSource: customer.picture_source'));

  const inboxApiSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/inbox/routes.ts'), 'utf8');
  check('inbox detail returns picture_source', inboxApiSrc.includes('picture_url, picture_source, channel_identities'));

  const webApiSrc = fs.readFileSync(path.join(ROOT, 'apps/web/lib/api.ts'), 'utf8');
  // Manual upload was REJECTED by the user (2026-11-07): the web photo
  // helpers and photo labels must be gone from the shipped UI.
  check('web customersApi has NO photo helpers (manual upload removed)', !webApiSrc.includes('uploadPhoto') && !webApiSrc.includes('setPhoto') && !webApiSrc.includes('deletePhoto'));

  const pageSrc = fs.readFileSync(path.join(ROOT, 'apps/web/app/inbox/page.tsx'), 'utf8');
  // The user REJECTED manual photo upload (2026-11-07): the Inbox must
  // NOT offer any photo picker/save/remove control. The backend photo
  // endpoints still exist (already deployed) but are unreachable from
  // the UI. These checks assert the UI is gone.
  check('inbox page has NO manual photo upload control', !pageSrc.includes('photoInputRef') && !pageSrc.includes('savePhoto') && !pageSrc.includes('removePhoto') && !pageSrc.includes('uploadPhoto'));
  check('inbox page shows a source badge (MESSENGER/INSTAGRAM/WHATSAPP/…) from the channel platform', pageSrc.includes('ChannelBadge') && pageSrc.includes('MESSENGER') && pageSrc.includes('INSTAGRAM') && pageSrc.includes('WHATSAPP') && pageSrc.includes('TIKTOK'));
  check('source badge is next to the name in the list and in the thread header', pageSrc.includes('<ChannelBadge conversation={c} />') && pageSrc.includes('<ChannelBadge conversation={selected.conversation} />'));
  check("customer photo shows next to the customer's messages", pageSrc.includes('sizeClass="h-8 w-8"') && pageSrc.includes('!isMe && !isAi'));
  check('meta-profile documents the /picture probe (400/33 — not wired in)', profileSrc.includes('/picture?redirect=false') && profileSrc.includes('100/33'));

  const dictSrc = fs.readFileSync(path.join(ROOT, 'apps/web/lib/i18n-dict.ts'), 'utf8');
  check('i18n has NO inbox photo keys (manual upload removed)', !dictSrc.includes('inbox.changePhoto') && !dictSrc.includes('inbox.addPhoto') && !dictSrc.includes('ছবি বদলান'));

  // ---------- Stub Graph server ----------
  const graphStub = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'POST' && url.pathname === '/__test/set-photo') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}');
          if (parsed.url) nopicPhotos.set(parsed.senderId, parsed.url);
          else nopicPhotos.delete(parsed.senderId);
          if (parsed.senderId === 'psid-noname' && parsed.ready) nonameReady = true;
          send(200, { ok: true });
        } catch {
          send(400, { ok: false });
        }
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v21.0/psid-meta') {
      return send(200, { id: 'psid-meta', first_name: 'Meta', last_name: 'Photo', profile_pic: { url: 'https://example.com/meta.jpg' } });
    }
    if (req.method === 'GET' && url.pathname === '/v21.0/psid-meta2') {
      return send(200, { id: 'psid-meta2', first_name: 'Meta', last_name: 'Two', profile_pic: { url: 'https://example.com/meta2.jpg' } });
    }
    if (req.method === 'GET' && (url.pathname === '/v21.0/psid-nopic' || url.pathname === '/v21.0/psid-nopic2' || url.pathname === '/v21.0/psid-nopic3' || url.pathname === '/v21.0/psid-noname')) {
      // Direct PSID read blocked exactly like Meta does for
      // phone-registered senders — 400 GraphMethodException 100/33.
      return send(400, { error: { message: "Unsupported get request.", type: 'GraphMethodException', code: 100, error_subcode: 33 } });
    }
    if (req.method === 'GET' && url.pathname === '/v21.0/page-photo/conversations') {
      const userId = url.searchParams.get('user_id') ?? '';
      if (userId === 'psid-noname') {
        if (!nonameReady) return send(200, { data: [] });
        return send(200, { data: [{ id: 'conv-photo', participants: [{ id: 'psid-noname', name: 'No Name Customer', picture: { data: { url: 'https://example.com/meta-noname.jpg' } } }, { id: 'page-photo', name: 'Photo Page' }] }] });
      }
      const names = { 'psid-nopic': 'No Pic Customer', 'psid-nopic2': 'Second No Pic', 'psid-nopic3': 'Third No Pic' };
      const name = names[userId];
      if (!name) return send(200, { data: [] });
      const participant = { id: userId, name };
      const photo = nopicPhotos.get(userId);
      if (photo) participant.picture = { data: { url: photo } };
      return send(200, { data: [{ id: 'conv-photo', participants: [participant, { id: 'page-photo', name: 'Photo Page' }] }] });
    }
    return send(400, { error: { message: 'Invalid OAuth access token.', type: 'OAuthException', code: 190 } });
  });
  await new Promise((resolve) => graphStub.listen(STUB_PORT, resolve));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'custphoto-verify-'));
  const dataDir = path.join(tmpDir, 'pglite-data');
  const env = {
    ...process.env,
    ...parseEnvFile(path.join(API_DIR, '.env')),
    PORT: String(PORT),
    USE_PGLITE: 'true',
    // PGlite only honours pglite:// URLs (a file: URL silently falls
    // back to the shared dev .pglite-data — must not happen here).
    DATABASE_URL: `pglite://${dataDir}`,
    META_APP_ID: 'dummy-app-id',
    META_APP_SECRET: 'dummy-secret',
    META_GRAPH_BASE_URL: `http://localhost:${STUB_PORT}/v21.0`,
  };
  // No Blob token in this harness: the base64 path stores on disk, and
  // the upload-token route must answer 503.
  delete env.BLOB_READ_WRITE_TOKEN;
  const tsxBin = path.join(API_DIR, 'node_modules', '.bin', 'tsx');
  const child = spawn(tsxBin, ['src/index.ts'], {
    cwd: API_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let apiLog = '';
  child.stdout.on('data', (d) => { apiLog += d.toString(); });
  child.stderr.on('data', (d) => { apiLog += d.toString(); });

  const sendMsg = (senderId, mid, text) =>
    api('/api/webhooks/meta', {
      method: 'POST', auth: false,
      body: { object: 'page', entry: [{ id: 'page-photo', messaging: [{ sender: { id: senderId }, recipient: { id: 'page-photo' }, message: { mid, text } }] }] },
    });
  const findConvByLastMessage = async (text) => {
    const list = await api('/api/inbox');
    return (list.data?.conversations ?? []).find((c) => c.last_message === text) ?? null;
  };
  const getCustomer = async (conv) => {
    const detail = await api(`/api/inbox/${conv.id}`);
    return detail.data?.customer ?? null;
  };

  try {
    await waitForHealth(child);
    check('API starts on throwaway PGlite DB (migration 18 applied)', true, `port=${PORT}`);

    const stamp = Date.now();
    const signup = await api('/api/auth/signup', {
      method: 'POST', auth: false,
      body: { name: 'Photo Verify', email: `custphoto+${stamp}@example.com`, password: 'verify1234', workspaceName: 'Photo Verify Shop' },
    });
    check('signup workspace A', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
    token = signup.data?.token ?? '';
    if (!token) throw new Error('no token from signup — cannot continue');
    const signupB = await api('/api/auth/signup', {
      method: 'POST', auth: false,
      body: { name: 'Photo Verify B', email: `custphoto-b+${stamp}@example.com`, password: 'verify1234', workspaceName: 'Photo Verify Shop B' },
    });
    tokenB = signupB.data?.token ?? '';
    check('signup workspace B (cross-workspace checks)', signupB.status === 201 && !!tokenB, `status=${signupB.status}`);

    const ch = await api('/api/channels', { method: 'POST', body: { platform: 'messenger', externalId: 'page-photo', displayName: 'Photo Page', token: 'tok-photo' } });
    check('messenger channel (stub token) → 201', ch.status === 201, `status=${ch.status}`);

    const missingId = '00000000-0000-0000-0000-000000000000';

    // ---- Customer with no Meta photo: set a manual photo via base64 ----
    const hook1 = await sendMsg('psid-nopic', `ph-mid-1-${stamp}`, 'ছবি ছাড়া কাস্টমার');
    check('webhook accepts the first message', hook1.status === 200, `status=${hook1.status}`);
    const conv1 = await findConvByLastMessage('ছবি ছাড়া কাস্টমার');
    check('conversation created for the no-photo sender', !!conv1?.id, `conv=${conv1?.id ?? ''}`);
    check('no-photo sender gets the real name, no photo', conv1?.customer_name === 'No Pic Customer' && !conv1?.customer_picture_url, `name=${conv1?.customer_name ?? ''}`);
    const cust1 = conv1 ? await getCustomer(conv1) : null;
    const cust1Id = cust1?.id;
    if (!cust1Id) throw new Error('no customer id — cannot continue');

    const tok = await api('/api/customers/upload-token', { method: 'POST', body: {} });
    check('upload-token without Blob answers 503', tok.status === 503, `status=${tok.status}`);
    const noAuth = await api(`/api/customers/${cust1Id}/photo`, { method: 'POST', auth: false, body: { url: 'https://example.com/x.jpg' } });
    check('set photo without auth → 401', noAuth.status === 401, `status=${noAuth.status}`);
    const miss = await api(`/api/customers/${missingId}/photo`, { method: 'POST', body: { url: 'https://example.com/x.jpg' } });
    check('set photo on missing customer → 404', miss.status === 404, `status=${miss.status}`);
    const badUuid = await api('/api/customers/not-a-uuid/photo', { method: 'POST', body: { url: 'https://example.com/x.jpg' } });
    check('set photo with bad UUID → 400', badUuid.status === 400, `status=${badUuid.status}`);
    const badMime = await api(`/api/customers/${cust1Id}/photo`, { method: 'POST', body: { fileBase64: TEXT_B64, fileName: 'hello.txt', mimeType: 'text/plain' } });
    check('non-image upload rejected (400)', badMime.status === 400, `status=${badMime.status}`);
    const badUrl = await api(`/api/customers/${cust1Id}/photo`, { method: 'POST', body: { url: 'not-a-url' } });
    check('invalid image URL rejected (400)', badUrl.status === 400, `status=${badUrl.status}`);
    const crossSet = await api(`/api/customers/${cust1Id}/photo`, { method: 'POST', useToken: tokenB, body: { url: 'https://example.com/x.jpg' } });
    check('cross-workspace set photo → 404', crossSet.status === 404, `status=${crossSet.status}`);

    const set1 = await api(`/api/customers/${cust1Id}/photo`, {
      method: 'POST',
      body: { fileBase64: PNG_1X1_B64, fileName: 'customer.png', mimeType: 'image/png' },
    });
    const manualUrl = set1.data?.customer?.picture_url ?? '';
    check(
      'set photo via base64 → 200, manual URL + source',
      set1.status === 200 && !!manualUrl && set1.data?.customer?.picture_source === 'manual',
      `status=${set1.status}, url=${manualUrl}, source=${set1.data?.customer?.picture_source ?? ''}`,
    );
    const conv1b = await findConvByLastMessage('ছবি ছাড়া কাস্টমার');
    check('inbox list shows the manual photo', conv1b?.customer_picture_url === manualUrl, `pic=${conv1b?.customer_picture_url ?? ''}`);
    const cust1b = conv1 ? await getCustomer(conv1) : null;
    check('inbox detail shows the manual photo + source', cust1b?.picture_url === manualUrl && cust1b?.picture_source === 'manual', `pic=${cust1b?.picture_url ?? ''}, source=${cust1b?.picture_source ?? ''}`);

    // ---- CRITICAL: manual photo survives a Meta refresh that DOES return a photo ----
    await fetch(`http://localhost:${STUB_PORT}/__test/set-photo`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senderId: 'psid-nopic', url: 'https://example.com/meta-would-win.jpg' }),
    });
    const hook1b = await sendMsg('psid-nopic', `ph-mid-2-${stamp}`, 'দ্বিতীয় মেসেজ');
    check('second message accepted after Meta starts returning a photo', hook1b.status === 200, `status=${hook1b.status}`);
    const conv1c = await findConvByLastMessage('দ্বিতীয় মেসেজ');
    check(
      'manual photo survives the Meta refresh (not overwritten)',
      conv1c?.customer_picture_url === manualUrl,
      `pic=${conv1c?.customer_picture_url ?? ''}`,
    );
    const cust1c = conv1c ? await getCustomer(conv1c) : null;
    check('manual source survives the Meta refresh', cust1c?.picture_source === 'manual', `source=${cust1c?.picture_source ?? ''}`);

    // ---- Manual photo + MISSING name: refresh fills the name, never the photo ----
    // psid-nopic2's name comes from the stub, so the manual photo here
    // exercises the early-return path; the true name-missing case is
    // psid-noname below.
    const hook2 = await sendMsg('psid-nopic2', `ph-mid-3-${stamp}`, 'নাম ছাড়া কাস্টমার');
    check('webhook accepts the message for the second no-photo sender', hook2.status === 200, `status=${hook2.status}`);
    const conv2 = await findConvByLastMessage('নাম ছাড়া কাস্টমার');
    check('second no-photo sender gets the real name', conv2?.customer_name === 'Second No Pic', `name=${conv2?.customer_name ?? ''}`);
    const cust2 = conv2 ? await getCustomer(conv2) : null;
    const cust2Id = cust2?.id;
    if (!cust2Id) throw new Error('no customer 2 id — cannot continue');
    const set2 = await api(`/api/customers/${cust2Id}/photo`, {
      method: 'POST',
      body: { url: 'https://example.com/manual-2.jpg' },
    });
    const manual2Url = set2.data?.customer?.picture_url ?? '';
    check('register an uploaded URL as manual photo → 200', set2.status === 200 && manual2Url === 'https://example.com/manual-2.jpg' && set2.data?.customer?.picture_source === 'manual', `status=${set2.status}`);
    // Now Meta starts returning a photo for psid-nopic2 too; the next
    // message must NOT replace the manual photo (name is already set,
    // so this also exercises the early-return path).
    await fetch(`http://localhost:${STUB_PORT}/__test/set-photo`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senderId: 'psid-nopic2', url: 'https://example.com/meta2-would-win.jpg' }),
    });
    const hook2b = await sendMsg('psid-nopic2', `ph-mid-4-${stamp}`, 'আরেকটা মেসেজ');
    check('second message accepted for customer 2', hook2b.status === 200, `status=${hook2b.status}`);
    const conv2b = await findConvByLastMessage('আরেকটা মেসেজ');
    check('manual photo survives for customer 2 as well', conv2b?.customer_picture_url === manual2Url, `pic=${conv2b?.customer_picture_url ?? ''}`);

    // ---- TRUE name-missing case: manual photo set while the name is
    // NULL; the next Meta refresh fills the name but NEVER the photo ----
    const hookN = await sendMsg('psid-noname', `ph-mid-noname-1-${stamp}`, 'নামহীন কাস্টমার');
    check('webhook accepts the message for the nameless sender', hookN.status === 200, `status=${hookN.status}`);
    const convN = await findConvByLastMessage('নামহীন কাস্টমার');
    check('nameless sender stays Unknown (no name, no photo)', !!convN?.id && !convN?.customer_name && !convN?.customer_picture_url, `name=${convN?.customer_name ?? ''}`);
    const custN = convN ? await getCustomer(convN) : null;
    const custNId = custN?.id;
    if (!custNId) throw new Error('no nameless customer id — cannot continue');
    const setN = await api(`/api/customers/${custNId}/photo`, {
      method: 'POST',
      body: { url: 'https://example.com/manual-noname.jpg' },
    });
    check('manual photo set on the nameless customer → 200', setN.status === 200 && setN.data?.customer?.picture_url === 'https://example.com/manual-noname.jpg' && setN.data?.customer?.picture_source === 'manual', `status=${setN.status}`);
    // Meta now starts returning a name AND a photo for this sender.
    await fetch(`http://localhost:${STUB_PORT}/__test/set-photo`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senderId: 'psid-noname', url: 'https://example.com/meta-noname.jpg', ready: true }),
    });
    const hookN2 = await sendMsg('psid-noname', `ph-mid-noname-2-${stamp}`, 'নামহীন দ্বিতীয় মেসেজ');
    check('second message accepted for the nameless sender', hookN2.status === 200, `status=${hookN2.status}`);
    const convN2 = await findConvByLastMessage('নামহীন দ্বিতীয় মেসেজ');
    check('refresh fills the missing name', convN2?.customer_name === 'No Name Customer', `name=${convN2?.customer_name ?? ''}`);
    check(
      'refresh does NOT replace the manual photo with the Meta photo',
      convN2?.customer_picture_url === 'https://example.com/manual-noname.jpg',
      `pic=${convN2?.customer_picture_url ?? ''}`,
    );
    const custN2 = convN2 ? await getCustomer(convN2) : null;
    check('manual source survives the name-filling refresh', custN2?.picture_source === 'manual', `source=${custN2?.picture_source ?? ''}`);

    // ---- Manual photo replaces a Meta photo (owner's choice) ----
    const hookM = await sendMsg('psid-meta', `ph-mid-5-${stamp}`, 'মেটা ছবির কাস্টমার');
    check('webhook accepts the Meta-photo sender', hookM.status === 200, `status=${hookM.status}`);
    const convM = await findConvByLastMessage('মেটা ছবির কাস্টমার');
    check('Meta-photo sender gets the Meta photo', convM?.customer_picture_url === 'https://example.com/meta.jpg', `pic=${convM?.customer_picture_url ?? ''}`);
    const custM = convM ? await getCustomer(convM) : null;
    const custMId = custM?.id;
    if (!custMId) throw new Error('no Meta customer id — cannot continue');
    check('Meta-filled photo is marked meta', custM?.picture_source === 'meta', `source=${custM?.picture_source ?? ''}`);
    const setM = await api(`/api/customers/${custMId}/photo`, {
      method: 'POST',
      body: { url: 'https://example.com/manual-over-meta.jpg' },
    });
    check(
      'manual photo replaces a Meta photo (owner choice)',
      setM.status === 200 && setM.data?.customer?.picture_url === 'https://example.com/manual-over-meta.jpg' && setM.data?.customer?.picture_source === 'manual',
      `status=${setM.status}`,
    );

    // ---- DELETE: photo cleared, Meta may fill again ----
    const delM = await api(`/api/customers/${custMId}/photo`, { method: 'DELETE' });
    check(
      'delete photo → 200, picture + source cleared',
      delM.status === 200 && !delM.data?.customer?.picture_url && delM.data?.customer?.picture_source === null,
      `status=${delM.status}`,
    );
    const delCross = await api(`/api/customers/${cust1Id}/photo`, { method: 'DELETE', useToken: tokenB });
    check('cross-workspace delete → 404', delCross.status === 404, `status=${delCross.status}`);
    const delMiss = await api(`/api/customers/${missingId}/photo`, { method: 'DELETE' });
    check('delete photo of missing customer → 404', delMiss.status === 404, `status=${delMiss.status}`);
    const hookM2 = await sendMsg('psid-meta', `ph-mid-6-${stamp}`, 'ডিলিটের পর মেসেজ');
    check('message accepted after photo delete', hookM2.status === 200, `status=${hookM2.status}`);
    const convM2 = await findConvByLastMessage('ডিলিটের পর মেসেজ');
    check('Meta refills the photo after delete (source meta)', convM2?.customer_picture_url === 'https://example.com/meta.jpg', `pic=${convM2?.customer_picture_url ?? ''}`);
    const custM2 = convM2 ? await getCustomer(convM2) : null;
    check('refilled photo is marked meta', custM2?.picture_source === 'meta', `source=${custM2?.picture_source ?? ''}`);

    // ---- Merge preserves photos ----
    const hookM2b = await sendMsg('psid-meta2', `ph-mid-7-${stamp}`, 'মার্জের জন্য মেটা');
    check('webhook accepts the second Meta-photo sender', hookM2b.status === 200, `status=${hookM2b.status}`);
    const convM2b = await findConvByLastMessage('মার্জের জন্য মেটা');
    const custM2b = convM2b ? await getCustomer(convM2b) : null;
    const custM2bId = custM2b?.id;
    if (!custM2bId) throw new Error('no Meta2 customer id — cannot continue');
    check('second Meta sender has a Meta photo', custM2b?.picture_url === 'https://example.com/meta2.jpg' && custM2b?.picture_source === 'meta', `pic=${custM2b?.picture_url ?? ''}`);
    // Keep = cust1 (manual photo), merge = Meta2 customer → manual wins.
    const merge1 = await api('/api/customers/merge', { method: 'POST', body: { keepCustomerId: cust1Id, mergeCustomerId: custM2bId } });
    check(
      'merge keeps the manual photo (kept wins)',
      merge1.status === 200 && merge1.data?.customer?.picture_url === manualUrl && merge1.data?.customer?.picture_source === 'manual',
      `status=${merge1.status}`,
    );
    // Keep = a photo-less customer, merge = the Meta-photo customer → inherits it.
    const hook3 = await sendMsg('psid-nopic3', `ph-mid-8-${stamp}`, 'মার্জের জন্য ছবি ছাড়া');
    check('webhook accepts the third no-photo sender', hook3.status === 200, `status=${hook3.status}`);
    const conv3 = await findConvByLastMessage('মার্জের জন্য ছবি ছাড়া');
    const cust3 = conv3 ? await getCustomer(conv3) : null;
    const cust3Id = cust3?.id;
    if (!cust3Id) throw new Error('no customer 3 id — cannot continue');
    check('third no-photo sender has no photo', !cust3?.picture_url, `pic=${cust3?.picture_url ?? ''}`);
    const merge2 = await api('/api/customers/merge', { method: 'POST', body: { keepCustomerId: cust3Id, mergeCustomerId: custMId } });
    check(
      'merge inherits the merged photo when kept has none',
      merge2.status === 200 && merge2.data?.customer?.picture_url === 'https://example.com/meta.jpg' && merge2.data?.customer?.picture_source === 'meta',
      `status=${merge2.status}`,
    );

    // User-token fallbacks (migration 20): run the standalone probe
    // script and fold its PASS/FAIL lines into this verifier's count.
    // It uses its own stub Graph (port 4021) + throwaway PGlite DB, so
    // it never touches this verifier's API.
    const probeOut = await new Promise((resolve) => {
      const tsxBin = path.join(ROOT, 'apps/api/node_modules/.bin/tsx');
      const proc = spawn(tsxBin, ['scripts/verify-user-token-photo.ts'], { cwd: ROOT });
      let out = '';
      proc.stdout.on('data', (d) => { out += d.toString(); });
      proc.stderr.on('data', (d) => { out += d.toString(); });
      proc.on('close', () => resolve(out));
    });
    for (const line of probeOut.split('\n')) {
      const m = line.match(/^(PASS|FAIL)\s+(.+?)(?: — (.*))?$/);
      if (!m) continue;
      check(`user-token probe: ${m[2]}`, m[1] === 'PASS', m[3] ?? '');
    }

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    if (failed.length > 0) {
      console.log('Failed:');
      for (const f of failed) console.log(` - ${f.name} — ${f.detail}`);
      console.log('\n--- API log (last 3000 chars) ---');
      console.log(apiLog.slice(-3000));
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('Verification crashed:', err);
    console.log('\n--- API log (last 3000 chars) ---');
    console.log(apiLog.slice(-3000));
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    await sleep(1000);
    if (child.exitCode === null) child.kill('SIGKILL');
    try { graphStub.close(); } catch { /* already closed */ }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // temp dir cleanup is best-effort
    }
  }
}

main();
