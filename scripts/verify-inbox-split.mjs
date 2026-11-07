#!/usr/bin/env node
/**
 * Verification for the Halal Chic inbox split (2026-11-08).
 *
 * The problem: Halal Chic (Page 545567875314703) was connected in TWO
 * workspaces (gd_arafat + OUR TEAM). The webhook channel lookup picked
 * the NEWEST channel regardless of status, so new messages routed to
 * OUR TEAM while the user (logged in as gd_arafat) saw only his one
 * stale conversation. Separately, the Page's own comments/replies came
 * back through the feed webhook (from.id == Page id) and created a
 * "Halal Chic" customer talking to itself (335 messages).
 *
 * The fix:
 * - Data (live Neon, done by scripts/inbox-split-migrate.js): OUR TEAM's
 *   two Halal Chic channels → 'disconnected'; the three live
 *   conversations + their customers/messages/orders moved into gd_arafat;
 *   the stale gd_arafat Mohammad Easin conversation merged into the live
 *   one (24 messages re-pointed) and its duplicate customer deleted.
 *   The "Halal Chic" self-conversation + the fake Fatima/নূর test
 *   customers were deliberately left in OUR TEAM.
 * - Code: webhooks/routes.ts + webhooks/tiktok-dm.ts
 *   findChannelByExternalId now requires status = 'connected', so a
 *   disconnected duplicate can never win the lookup again.
 * - Code: the Facebook comment loop skips events where the sender id
 *   equals the Page id, before the dedup record and the comments table
 *   — the Page's own comments/replies never create a customer or a
 *   conversation again.
 *
 * Checks:
 * - Static: the connected-only filter in both lookup functions; the
 *   page-self guard in the comment loop.
 * - Boot 1 (local API on PGlite): two workspaces A + B; A gets a
 *   connected messenger + facebook_comment channel for fake page P1;
 *   B gets a NEWER connected messenger channel for the same P1.
 * - Driver (direct pool, API stopped): B's messenger channel →
 *   'disconnected'.
 * - Boot 2 (same dir): a Messenger message to P1 lands in A (not B);
 *   a comment FROM the page id creates NO customer/conversation in A;
 *   a comment from a real sender creates a conversation in A.
 *
 * Run from the repo root:  node scripts/verify-inbox-split.mjs
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const results = [];
let tokenA = '';
let tokenB = '';
const PAGE_ID = '910000000000001';

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function apiFor(base, token) {
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

function startApi(port, dataDir) {
  const apiProc = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: path.join(ROOT, 'apps/api'),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: {
      ...process.env,
      PORT: String(port),
      USE_PGLITE: 'true',
      PGLITE_DATA_DIR: dataDir,
      JWT_SECRET: 'verify-inbox-split-secret-0123456789abcdef',
      TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      GEMINI_API_KEY: '',
      GROQ_API_KEY: '',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      META_APP_ID: 'dummy-app-id',
      META_APP_SECRET: 'dummy-app-secret-0123456789abcdef',
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

function runDriver(dataDir, channelId) {
  return new Promise((resolve) => {
    const proc = spawn('npx', ['tsx', '../../scripts/inbox-split-driver.ts', channelId], {
      cwd: path.join(ROOT, 'apps/api'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        USE_PGLITE: 'true',
        PGLITE_DATA_DIR: dataDir,
        JWT_SECRET: 'verify-inbox-split-secret-0123456789abcdef',
        TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      },
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('close', (code) => resolve({ code, out, err }));
  });
}

async function pollFor(fn, timeoutMs = 30000, intervalMs = 1000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  return last;
}

function asList(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.conversations)) return data.conversations;
  if (data && Array.isArray(data.customers)) return data.customers;
  return [];
}

async function main() {
  // ---------- Static checks ----------
  const hookSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/webhooks/routes.ts'), 'utf8');
  check(
    'webhook routes: channel lookup requires connected status',
    hookSrc.includes("AND status = 'connected' ORDER BY created_at DESC LIMIT 1"),
  );
  check(
    'webhook routes: page-self comment is skipped before dedup',
    hookSrc.includes('if (senderId === pageId) continue;'),
  );
  const tikSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/webhooks/tiktok-dm.ts'), 'utf8');
  check(
    'tiktok-dm: channel lookup requires connected status',
    tikSrc.includes("AND status = 'connected' ORDER BY created_at DESC LIMIT 1"),
  );

  // ---------- Boot 1: two workspaces, same page in both ----------
  const stamp = Date.now();
  const port = 4022;
  const dataDir = '.pglite-data-inboxsplit';
  const absDir = path.join(ROOT, 'apps/api', dataDir);
  try { fs.rmSync(absDir, { recursive: true, force: true }); } catch { /* fresh dir */ }
  const run1 = startApi(port, dataDir);
  process.on('exit', run1.stop);
  let channelBId = '';
  try {
    const up = await waitForHealth(`http://localhost:${port}`);
    check('boot 1: API starts', up, up ? '' : run1.log().slice(-500));
    if (!up) return;
    const anon = apiFor(`http://localhost:${port}`, '');
    const sA = await anon('/api/auth/signup', {
      method: 'POST', auth: false,
      body: { name: 'Split Owner A', email: `split-a+${stamp}@example.com`, password: 'verify1234', workspaceName: 'Split Shop A' },
    });
    check('boot 1: signup A', sA.status === 201 && !!sA.data?.token, `status=${sA.status}`);
    tokenA = sA.data?.token ?? '';
    const sB = await anon('/api/auth/signup', {
      method: 'POST', auth: false,
      body: { name: 'Split Owner B', email: `split-b+${stamp}@example.com`, password: 'verify1234', workspaceName: 'Split Shop B' },
    });
    check('boot 1: signup B', sB.status === 201 && !!sB.data?.token, `status=${sB.status}`);
    tokenB = sB.data?.token ?? '';
    const apiA = apiFor(`http://localhost:${port}`, tokenA);
    const apiB = apiFor(`http://localhost:${port}`, tokenB);
    const chAm = await apiA('/api/channels', { method: 'POST', body: { platform: 'messenger', externalId: PAGE_ID, displayName: 'Test Page A' } });
    check('boot 1: A messenger channel → 201 connected', chAm.status === 201 && chAm.data?.channel?.status === 'connected', `status=${chAm.status}`);
    const chAc = await apiA('/api/channels', { method: 'POST', body: { platform: 'facebook_comment', externalId: PAGE_ID, displayName: 'Test Page A comments' } });
    check('boot 1: A facebook_comment channel → 201 connected', chAc.status === 201 && chAc.data?.channel?.status === 'connected', `status=${chAc.status}`);
    // B connects the SAME page later (newer row — the old bug's winner).
    const chBm = await apiB('/api/channels', { method: 'POST', body: { platform: 'messenger', externalId: PAGE_ID, displayName: 'Test Page B' } });
    check('boot 1: B messenger channel (newer) → 201 connected', chBm.status === 201 && chBm.data?.channel?.status === 'connected', `status=${chBm.status}`);
    channelBId = chBm.data?.channel?.id ?? '';
  } finally {
    run1.stop();
    await sleep(2000);
  }

  // ---------- Driver: disconnect B's (newer) channel ----------
  const driver = await runDriver(dataDir, channelBId);
  let driverResult = null;
  const driverLine = (driver.out ?? '').split('\n').find((l) => l.startsWith('DRIVER_RESULT '));
  try {
    driverResult = driverLine ? JSON.parse(driverLine.slice('DRIVER_RESULT '.length)) : null;
  } catch {
    driverResult = null;
  }
  check('driver: B channel disconnected', !!driverResult?.disconnected && driverResult?.row?.status === 'disconnected', driver.err.slice(-200) || JSON.stringify(driverResult));

  // ---------- Boot 2: routing + page-self guard ----------
  const run2 = startApi(port, dataDir);
  process.on('exit', run2.stop);
  try {
    const up = await waitForHealth(`http://localhost:${port}`);
    check('boot 2: API starts', up, up ? '' : run2.log().slice(-500));
    if (!up) return;
    const apiA = apiFor(`http://localhost:${port}`, tokenA);
    const apiB = apiFor(`http://localhost:${port}`, tokenB);
    const anon = apiFor(`http://localhost:${port}`, '');

    // A Messenger message to the page must land in A, not B.
    const mIn = await anon('/api/webhooks/meta', {
      method: 'POST', auth: false,
      body: {
        object: 'page',
        entry: [{
          id: PAGE_ID,
          time: Math.floor(Date.now() / 1000),
          messaging: [{
            sender: { id: 'psid-split-1' },
            recipient: { id: PAGE_ID },
            timestamp: Date.now(),
            message: { mid: `split-mid-${stamp}`, text: 'জিন্সের দাম কত?' },
          }],
        }],
      },
    });
    check('boot 2: messenger webhook accepted', mIn.status === 200, `status=${mIn.status}`);
    const inA = await pollFor(async () => {
      const list = await apiA('/api/inbox');
      const convs = asList(list.data);
      return convs.length > 0 ? convs : null;
    });
    check('boot 2: message routed to workspace A', !!inA && inA.length === 1, `convs=${inA?.length ?? 0}`);
    const inB = await apiB('/api/inbox');
    check('boot 2: message did NOT route to workspace B', asList(inB.data).length === 0, `convs=${asList(inB.data).length}`);

    // A comment FROM the page itself must create nothing.
    const beforeCustomers = await apiA('/api/customers');
    const beforeCount = asList(beforeCustomers.data).length;
    const beforeInbox = await apiA('/api/inbox');
    const beforeInboxCount = asList(beforeInbox.data).length;
    const selfComment = await anon('/api/webhooks/meta', {
      method: 'POST', auth: false,
      body: {
        object: 'page',
        entry: [{
          id: PAGE_ID,
          time: Math.floor(Date.now() / 1000),
          changes: [{
            field: 'feed',
            value: {
              item: 'comment',
              comment_id: `split-self-${stamp}`,
              post_id: `${PAGE_ID}_post1`,
              message: 'স্যার, জিন্সের দাম ৳৫০০।',
              from: { id: PAGE_ID, name: 'Test Page' },
            },
          }],
        }],
      },
    });
    check('boot 2: page-self comment webhook accepted', selfComment.status === 200, `status=${selfComment.status}`);
    await sleep(3000);
    const afterCustomers = await apiA('/api/customers');
    const afterCount = asList(afterCustomers.data).length;
    const afterInbox = await apiA('/api/inbox');
    const afterInboxCount = asList(afterInbox.data).length;
    check('boot 2: page-self comment created NO customer', afterCount === beforeCount, `before=${beforeCount} after=${afterCount}`);
    check('boot 2: page-self comment created NO conversation', afterInboxCount === beforeInboxCount, `before=${beforeInboxCount} after=${afterInboxCount}`);
    const selfNamed = asList(afterCustomers.data).some((c) => {
      const ids = Array.isArray(c.channel_identities) ? c.channel_identities : [];
      return ids.some((i) => i.platform === 'facebook_comment' && String(i.senderId) === PAGE_ID);
    });
    check('boot 2: no facebook_comment self-identity customer exists', !selfNamed);

    // A comment from a REAL sender still creates a conversation in A.
    const realComment = await anon('/api/webhooks/meta', {
      method: 'POST', auth: false,
      body: {
        object: 'page',
        entry: [{
          id: PAGE_ID,
          time: Math.floor(Date.now() / 1000),
          changes: [{
            field: 'feed',
            value: {
              item: 'comment',
              comment_id: `split-real-${stamp}`,
              post_id: `${PAGE_ID}_post1`,
              message: 'শার্টের দাম কত?',
              from: { id: 'cmt-sender-1', name: 'Real Commenter' },
            },
          }],
        }],
      },
    });
    check('boot 2: real comment webhook accepted', realComment.status === 200, `status=${realComment.status}`);
    const realFound = await pollFor(async () => {
      const list = await apiA('/api/inbox');
      const convs = asList(list.data);
      return convs.find((c) => (c.customer_name ?? c.customerName ?? '').includes('Real Commenter')) ?? null;
    });
    check('boot 2: real comment created a conversation in A', !!realFound, realFound ? '' : 'not found');
  } finally {
    run2.stop();
    await sleep(2000);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log('FAILURES:');
    for (const f of failed) console.log(` - ${f.name} — ${f.detail}`);
    process.exit(1);
  }
  // Clean up the bulky PGlite test dir so it never ships to Vercel.
  try { fs.rmSync(absDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

main().catch((err) => {
  console.error('verifier crashed:', err);
  process.exit(1);
});
