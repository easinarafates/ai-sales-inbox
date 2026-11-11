#!/usr/bin/env node
/**
 * Verification for the profile phone number (2026-11-11).
 * Local PGlite API (scratch dir) — no Gemini, no production data.
 *
 * The Profile page lets the user change their phone number; the email
 * is the login identity and stays LOCKED. The users table had no phone
 * column (migration 40), and PATCH /api/profile only accepted a name.
 *
 *  1. signup -> GET /api/auth/me -> phone is null
 *  2. PATCH /api/profile {name, phone: "01915181309"} -> 200, phone saved, email unchanged
 *  3. GET /api/auth/me -> phone persists
 *  4. PATCH invalid phone "12345" -> 400
 *  5. PATCH name only (no phone key) -> 200, phone left alone
 *  6. PATCH phone "" -> 200, phone cleared (null)
 *  7. PATCH phone " 01915 181309 " -> 200, stored normalized "01915181309"
 *
 * Run from the repo root:  node scripts/verify-profile-phone.mjs
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
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
  return async function api(pathName, { method = 'GET', body, auth = true, headers = {} } = {}) {
    const res = await fetch(`${base}${pathName}`, {
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
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data, text };
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

function startApi(port, dataDir) {
  const apiProc = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: path.join(ROOT, 'apps/api'),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env, PORT: String(port), DATABASE_URL: `pglite://./${dataDir}` },
  });
  let apiLog = '';
  apiProc.stdout.on('data', (d) => { apiLog += d.toString(); });
  apiProc.stderr.on('data', (d) => { apiLog += d.toString(); });
  const stop = () => {
    try { process.kill(-apiProc.pid, 'SIGTERM'); } catch { try { apiProc.kill('SIGTERM'); } catch { /* already gone */ } }
  };
  return { proc: apiProc, stop, log: () => apiLog };
}

async function main() {
  const stamp = Date.now();
  const port = 4009;
  const api = makeApi(`http://localhost:${port}`);
  const run = startApi(port, '.pglite-data-phoneverify');
  process.on('exit', run.stop);
  try {
    const up = await waitForHealth(`http://localhost:${port}`);
    check('local API starts (health)', up, up ? '' : run.log().slice(-500));
    if (!up) return;

    const email = `phoneverify+${stamp}@example.com`;
    const signup = await api('/api/auth/signup', {
      method: 'POST', auth: false,
      body: { name: 'Phone Owner', email, password: 'verify1234', workspaceName: 'Phone Shop' },
    });
    check('signup', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
    if (!signup.data?.token) return;
    token = signup.data.token;

    const me0 = await api('/api/auth/me');
    check('GET /me: phone is null at first', me0.status === 200 && me0.data?.user?.phone === null, `phone=${JSON.stringify(me0.data?.user?.phone)}`);

    const set1 = await api('/api/profile', {
      method: 'PATCH',
      body: { name: 'Phone Owner', phone: '01915181309' },
    });
    check('PATCH phone 01915181309 -> 200 + saved', set1.status === 200 && set1.data?.user?.phone === '01915181309', `status=${set1.status} phone=${JSON.stringify(set1.data?.user?.phone)}`);
    check('PATCH does not change email', set1.data?.user?.email === email, `email=${set1.data?.user?.email}`);

    const me1 = await api('/api/auth/me');
    check('GET /me: phone persists', me1.status === 200 && me1.data?.user?.phone === '01915181309', `phone=${JSON.stringify(me1.data?.user?.phone)}`);

    const bad = await api('/api/profile', {
      method: 'PATCH',
      body: { name: 'Phone Owner', phone: '12345' },
    });
    check('PATCH invalid phone "12345" -> 400', bad.status === 400, `status=${bad.status}`);

    const nameOnly = await api('/api/profile', {
      method: 'PATCH',
      body: { name: 'Phone Owner 2' },
    });
    check('PATCH name only: phone left alone', nameOnly.status === 200 && nameOnly.data?.user?.phone === '01915181309' && nameOnly.data?.user?.name === 'Phone Owner 2', `status=${nameOnly.status} phone=${JSON.stringify(nameOnly.data?.user?.phone)}`);

    const clear = await api('/api/profile', {
      method: 'PATCH',
      body: { name: 'Phone Owner 2', phone: '' },
    });
    check('PATCH phone "" clears it', clear.status === 200 && clear.data?.user?.phone === null, `status=${clear.status} phone=${JSON.stringify(clear.data?.user?.phone)}`);

    const spaced = await api('/api/profile', {
      method: 'PATCH',
      body: { name: 'Phone Owner 2', phone: ' 01915 181309 ' },
    });
    check('PATCH phone with spaces normalizes', spaced.status === 200 && spaced.data?.user?.phone === '01915181309', `status=${spaced.status} phone=${JSON.stringify(spaced.data?.user?.phone)}`);
  } finally {
    run.stop();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('FAIL  verifier crashed:', err);
  process.exit(1);
});
