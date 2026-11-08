#!/usr/bin/env node
/**
 * Verification for login fixes (area 2 — overnight work).
 * Local, offline — no Meta calls, no email sent.
 *
 * (a) Site login:
 *  - Email normalisation: signup stores trimmed + lower-cased email;
 *    login works with any case / surrounding spaces; a duplicate signup
 *    with a different case is still 409.
 *  - Password reset (new — there was none): POST /api/auth/forgot-password
 *    always answers the same generic 200 (known or unknown email — no
 *    enumeration); POST /api/auth/reset-password accepts a valid token
 *    once (new password logs in, old one stops working, reuse fails),
 *    rejects garbage / expired tokens with 400. Tokens are stored only
 *    as SHA-256 hashes. The emailed LINK is not testable here by a real
 *    send (no Resend key in this repo): the verifier inserts a
 *    reset row directly into the local PGlite DB to test the consume
 *    path honestly, and tests the mailer by behaviour — run A strips
 *    RESEND_API_KEY explicitly (a real key now lives in apps/api/.env,
 *    and dotenv never overwrites an already-set process env var, so
 *    the strip keeps this scenario deterministic) → mailerConfigured=false
 *    + "no mailer configured" in the log; an invalid Resend key → still
 *    200 generic with mailerConfigured=true and the failure logged,
 *    never a hang or 500.
 * (b) Facebook account switching:
 *  - GET /api/channels/{facebook,instagram,whatsapp}/login without
 *    META_APP_ID → 503 (unchanged); with a dummy app id → 200 with a
 *    real facebook.com dialog URL and NO auth_type by default;
 *    ?reauthenticate=1 → the URL carries auth_type=reauthenticate,
 *    which forces Facebook to ask for credentials again so the user can
 *    pick a DIFFERENT Facebook account.
 *
 * Run from the repo root:  node scripts/verify-auth-reset.mjs
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 */
import { spawn, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
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

/** Read one value from apps/api/.env (never printed). */
function envFileValue(name) {
  const envPath = path.join(ROOT, 'apps/api/.env');
  if (!fs.existsSync(envPath)) return '';
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (t.startsWith(`${name}=`)) return t.slice(name.length + 1).trim().replace(/^[\"']|[\"']$/g, '');
  }
  return '';
}

function makeApi(base) {
  return async function api(path, { method = 'GET', body, auth = true } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
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

function startApi(port, dataDir, extraEnv = {}) {
  const apiProc = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: path.join(ROOT, 'apps/api'),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: `pglite://./${dataDir}`,
      JWT_SECRET: envFileValue('JWT_SECRET'),
      USE_PGLITE: 'true',
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

/**
 * Insert password_resets rows straight into the local PGlite data dir
 * (API stopped — only one process may hold the folder). The verifier
 * chooses the token values, so it can then exercise the real
 * POST /api/auth/reset-password path end to end.
 */
function insertResetRows(dataDir, userId) {
  const validToken = 'verify-reset-valid-token-001';
  const expiredToken = 'verify-reset-expired-token-001';
  // Written to a file (not `node -e`) so the shell cannot mangle the
  // SQL $1/$2 placeholders; kept inside apps/api so the
  // @electric-sql/pglite import resolves, and deleted afterwards.
  const scriptPath = path.join(ROOT, 'apps/api/.verify-auth-reset-insert.mjs');
  const script = `
    import crypto from 'node:crypto';
    import { PGlite } from '@electric-sql/pglite';
    const db = new PGlite(${JSON.stringify(`./${dataDir}`)});
    await db.waitReady;
    const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
    await db.query(
      "INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [${JSON.stringify(userId)}, sha(${JSON.stringify(validToken)})],
    );
    await db.query(
      "INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() - interval '1 hour')",
      [${JSON.stringify(userId)}, sha(${JSON.stringify(expiredToken)})],
    );
    await db.close();
    console.log('reset rows inserted');
  `;
  fs.writeFileSync(scriptPath, script);
  try {
    execSync(`node ${scriptPath}`, {
      cwd: path.join(ROOT, 'apps/api'),
      stdio: 'pipe',
      timeout: 60000,
    });
  } finally {
    try { fs.unlinkSync(scriptPath); } catch { /* best effort */ }
  }
  return { validToken, expiredToken };
}

function rmDir(dir) {
  try { fs.rmSync(path.join(ROOT, 'apps/api', dir), { recursive: true, force: true }); } catch { /* best effort */ }
}

async function main() {
  const jwtSecret = envFileValue('JWT_SECRET');
  check('JWT_SECRET available for test signing (from apps/api/.env)', jwtSecret.length > 0);

  // ---------- Static checks ----------
  const mig16 = fs.readFileSync(path.join(ROOT, 'apps/api/src/db/migrations/16-password-resets.sql'), 'utf8');
  check('migration 16 creates password_resets (idempotent)', mig16.includes('CREATE TABLE IF NOT EXISTS password_resets') && mig16.includes('token_hash') && mig16.includes('expires_at') && mig16.includes('used_at'));
  check('migration 16 indexes the lookup columns', mig16.includes('idx_password_resets_user_id') && mig16.includes('idx_password_resets_token_hash'));

  const routesSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/auth/routes.ts'), 'utf8');
  check('auth routes normalise email (trim + lowercase)', routesSrc.includes('normalizeEmail') && routesSrc.includes('trim().toLowerCase()'));
  check('signup stores the normalised email', routesSrc.includes('normalisedEmail'));
  check('login looks up the normalised email', routesSrc.includes('normalizeEmail(email)'));
  check('forgot-password endpoint exists', routesSrc.includes("'/forgot-password'"));
  check('reset-password endpoint exists', routesSrc.includes("'/reset-password'"));
  check('reset tokens are stored as SHA-256 hashes, never plain', routesSrc.includes("createHash('sha256')") && !routesSrc.includes('token, expires_at'));
  check('forgot-password answers generic + mailerConfigured flag (never the token)', routesSrc.includes('RESET_GENERIC_MESSAGE') && routesSrc.includes('res.json({ message: RESET_GENERIC_MESSAGE, mailerConfigured: isMailerConfigured() })'));
  check('reset marks the token used (single-use) + 1h expiry', routesSrc.includes('used_at = now()') && routesSrc.includes('RESET_TOKEN_TTL_MS'));
  check('routes document the mailer + honest no-mailer fallback', routesSrc.includes('DELIVERY:') && routesSrc.includes('sendMail') && routesSrc.includes('mailerConfigured'));

  // --- Forgot-password fixes (2026-11-08): AppShell + mailer ---
  const shellSrc = fs.readFileSync(path.join(ROOT, 'apps/web/components/AppShell.tsx'), 'utf8');
  check('AppShell treats /forgot-password + /reset-password as public auth pages', shellSrc.includes('"/forgot-password"') && shellSrc.includes('"/reset-password"'));
  const mailerSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/mailer.ts'), 'utf8');
  check('mailer reads Resend only from env (RESEND_API_KEY/RESEND_FROM) + posts to api.resend.com', mailerSrc.includes('RESEND_API_KEY') && mailerSrc.includes('RESEND_FROM') && mailerSrc.includes('https://api.resend.com/emails') && !mailerSrc.includes('nodemailer') && !mailerSrc.includes('SMTP'));
  check('mailer exposes isMailerConfigured + sendMail, never logs anything (key never printed)', mailerSrc.includes('isMailerConfigured') && mailerSrc.includes('sendMail') && !mailerSrc.includes('console.log'));
  const cfgSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/config/index.ts'), 'utf8');
  check('config has resend block (apiKey/from, onboarding default)', cfgSrc.includes('resend:') && cfgSrc.includes('RESEND_API_KEY') && cfgSrc.includes('onboarding@resend.dev') && !cfgSrc.includes('SMTP_HOST'));
  check('routes call sendMail with the reset link', routesSrc.includes('sendMail({') && routesSrc.includes('reset-password?token=${token}'));
  const fpPage = fs.readFileSync(path.join(ROOT, 'apps/web/app/forgot-password/page.tsx'), 'utf8');
  check('forgot-password page honours mailerConfigured (emailed vs not-sent copy)', fpPage.includes('mailerConfigured') && fpPage.includes('auth.resetLinkEmailed'));
  const dictSrc = fs.readFileSync(path.join(ROOT, 'apps/web/lib/i18n-dict.ts'), 'utf8');
  check('i18n has resetLinkEmailed (EN + BN)', dictSrc.includes('auth.resetLinkEmailed') && dictSrc.includes('Check your inbox (and spam folder)') && dictSrc.includes('ইনবক্স (আর স্প্যাম ফোল্ডার) দেখো'));

  const metaSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/meta-oauth.ts'), 'utf8');
  check('loginUrl supports reauthenticate (auth_type)', metaSrc.includes('reauthenticate') && metaSrc.includes("auth_type', 'reauthenticate"));
  for (const f of ['facebook-oauth.ts', 'instagram-oauth.ts', 'whatsapp-oauth.ts']) {
    const src = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels', f), 'utf8');
    check(`${f} login passes ?reauthenticate=1 through`, src.includes("req.query.reauthenticate === '1'"));
  }

  const webApi = fs.readFileSync(path.join(ROOT, 'apps/web/lib/api.ts'), 'utf8');
  check('web api has forgotPassword + resetPassword', webApi.includes('forgotPassword') && webApi.includes('resetPassword'));
  check('web api login helpers pass reauthenticate through', webApi.includes('reauthenticate=1'));
  const loginPage = fs.readFileSync(path.join(ROOT, 'apps/web/app/login/page.tsx'), 'utf8');
  check('login page links to Forgot password + email-spelling tip', loginPage.includes('/forgot-password') && loginPage.includes('auth.emailTip'));
  check('forgot-password + reset-password pages exist', fs.existsSync(path.join(ROOT, 'apps/web/app/forgot-password/page.tsx')) && fs.existsSync(path.join(ROOT, 'apps/web/app/reset-password/page.tsx')));
  const chPage = fs.readFileSync(path.join(ROOT, 'apps/web/app/channels/page.tsx'), 'utf8');
  check('channels page offers "different Facebook account" + hint', chPage.includes('channels.switchAccount') && chPage.includes('channels.switchAccountHint') && chPage.includes('loginWith(kind, true)'));

  // ---------- Live API: run A (no Meta app) ----------
  const stamp = Date.now().toString(36);
  const portA = 4411;
  const dirA = '.pglite-data-auth-a';
  const baseA = `http://localhost:${portA}`;
  const testEmail = `auth-test+${stamp}@example.com`;
  let userId = '';
  rmDir(dirA);
  const runA = startApi(portA, dirA, { META_APP_ID: '', META_APP_SECRET: '', RESEND_API_KEY: '', RESEND_FROM: '' });
  try {
    check('API A starts (health)', await waitForHealth(baseA));
    const api = makeApi(baseA);

    // (a) normalisation: mixed case + spaces on signup
    const signup = await api('/api/auth/signup', {
      method: 'POST', auth: false,
      body: { name: 'Auth Test', email: `  Auth-Test+${stamp}@Example.COM  `, password: 'verify1234', workspaceName: 'Auth Shop' },
    });
    check('signup with mixed-case/spaced email → 201', signup.status === 201, `status=${signup.status}`);
    userId = signup.data?.user?.id ?? '';
    check('stored email is normalised (trimmed + lower-cased)', signup.data?.user?.email === testEmail, `email=${signup.data?.user?.email}`);
    token = signup.data?.token ?? '';

    const dupe = await api('/api/auth/signup', {
      method: 'POST', auth: false,
      body: { name: 'Auth Test 2', email: `AUTH-TEST+${stamp}@example.com`, password: 'verify1234', workspaceName: 'Auth Shop 2' },
    });
    check('duplicate signup with different case → 409', dupe.status === 409, `status=${dupe.status}`);

    const loginUpper = await api('/api/auth/login', {
      method: 'POST', auth: false,
      body: { email: `  AUTH-TEST+${stamp}@EXAMPLE.COM `, password: 'verify1234' },
    });
    check('login with upper-case + spaces → 200', loginUpper.status === 200, `status=${loginUpper.status}`);
    const loginWrong = await api('/api/auth/login', {
      method: 'POST', auth: false,
      body: { email: testEmail, password: 'wrongpass1' },
    });
    check('login with wrong password → 401', loginWrong.status === 401, `status=${loginWrong.status}`);
    const loginUnknown = await api('/api/auth/login', {
      method: 'POST', auth: false,
      body: { email: `nobody+${stamp}@example.com`, password: 'verify1234' },
    });
    check('login with unknown email → 401 (same as wrong password)', loginUnknown.status === 401, `status=${loginUnknown.status}`);

    // (a) forgot-password: no enumeration
    const forgotKnown = await api('/api/auth/forgot-password', {
      method: 'POST', auth: false, body: { email: testEmail },
    });
    const forgotUnknown = await api('/api/auth/forgot-password', {
      method: 'POST', auth: false, body: { email: `nobody+${stamp}@example.com` },
    });
    check('forgot-password (known email) → 200 generic', forgotKnown.status === 200 && typeof forgotKnown.data?.message === 'string', `status=${forgotKnown.status}`);
    check('forgot-password (unknown email) → same 200 generic (no enumeration)', forgotUnknown.status === 200 && forgotUnknown.data?.message === forgotKnown.data?.message, `status=${forgotUnknown.status}`);
    check('forgot-password (known) → mailerConfigured false (no Resend key in test env)', forgotKnown.data?.mailerConfigured === false, `mailerConfigured=${forgotKnown.data?.mailerConfigured}`);
    check('forgot-password (unknown) → mailerConfigured false too (no enumeration)', forgotUnknown.data?.mailerConfigured === false, `mailerConfigured=${forgotUnknown.data?.mailerConfigured}`);
    check('forgot-password reply has no token field', forgotKnown.data?.token === undefined && forgotUnknown.data?.token === undefined);
    const forgotNoEmail = await api('/api/auth/forgot-password', { method: 'POST', auth: false, body: {} });
    check('forgot-password without email → 400', forgotNoEmail.status === 400, `status=${forgotNoEmail.status}`);

    // (a) reset-password: bad token / short password rejected
    const resetBad = await api('/api/auth/reset-password', {
      method: 'POST', auth: false, body: { token: 'garbage-token', password: 'newpass123' },
    });
    check('reset-password with garbage token → 400', resetBad.status === 400, `status=${resetBad.status}`);
    const resetShort = await api('/api/auth/reset-password', {
      method: 'POST', auth: false, body: { token: 'garbage-token', password: 'short' },
    });
    check('reset-password with short password → 400', resetShort.status === 400, `status=${resetShort.status}`);

    // (b) OAuth login without a Meta app → 503 (unchanged behaviour)
    const fbNoApp = await api('/api/channels/facebook/login');
    check('facebook login without META_APP_ID → 503', fbNoApp.status === 503, `status=${fbNoApp.status}`);
  } finally {
    runA.stop();
    await sleep(2000);
  }
  check('API A log says no mailer configured (honest fallback, nothing sent)', runA.log().includes('no mailer configured'));

  // ---------- Live API: run C (Resend key present but invalid) ----------
  // A mailer whose key Resend rejects must fail gracefully: the request
  // still answers 200 generic with mailerConfigured=true, and the
  // failure is logged — never a hang, never a 500, never the token in
  // the reply. (The key is fake, so Resend answers 401.)
  const portC = 4413;
  const dirC = '.pglite-data-auth-c';
  const baseC = `http://localhost:${portC}`;
  rmDir(dirC);
  const runC = startApi(portC, dirC, {
    META_APP_ID: '', META_APP_SECRET: '',
    RESEND_API_KEY: 're_testkey_invalid_123',
  });
  try {
    check('API C starts (health)', await waitForHealth(baseC));
    const api = makeApi(baseC);
    const signupC = await api('/api/auth/signup', {
      method: 'POST', auth: false,
      body: { name: 'Mail Test', email: `mail-test+${stamp}@example.com`, password: 'verify1234', workspaceName: 'Mail Shop' },
    });
    check('API C signup → 201', signupC.status === 201, `status=${signupC.status}`);
    const forgotC = await api('/api/auth/forgot-password', {
      method: 'POST', auth: false, body: { email: `mail-test+${stamp}@example.com` },
    });
    check('forgot-password with invalid Resend key → still 200 generic', forgotC.status === 200 && typeof forgotC.data?.message === 'string', `status=${forgotC.status}`);
    check('forgot-password with invalid Resend key → mailerConfigured true', forgotC.data?.mailerConfigured === true, `mailerConfigured=${forgotC.data?.mailerConfigured}`);
    check('forgot-password reply has no token field (run C)', forgotC.data?.token === undefined);
  } finally {
    runC.stop();
    await sleep(2000);
    rmDir(dirC);
  }
  check('API C log records the send failure (graceful, not a crash)', runC.log().includes('failed to send reset email'));

  // Insert reset rows directly into the PGlite dir (API stopped), then
  // restart the same API and exercise the real reset endpoint.
  if (!userId) {
    check('userId captured for reset-row insert', false, 'signup failed above');
  } else {
    const { validToken, expiredToken } = insertResetRows(dirA, userId);
    check('reset rows inserted into local PGlite (valid + expired)', true);
    const runA2 = startApi(portA, dirA, { META_APP_ID: '', META_APP_SECRET: '', RESEND_API_KEY: '', RESEND_FROM: '' });
    try {
      check('API A restarts (health)', await waitForHealth(baseA));
      const api = makeApi(baseA);
      const resetExpired = await api('/api/auth/reset-password', {
        method: 'POST', auth: false, body: { token: expiredToken, password: 'newpass123' },
      });
      check('reset-password with expired token → 400', resetExpired.status === 400, `status=${resetExpired.status}`);
      const resetOk = await api('/api/auth/reset-password', {
        method: 'POST', auth: false, body: { token: validToken, password: 'newpass123' },
      });
      check('reset-password with valid token → 200', resetOk.status === 200, `status=${resetOk.status}`);
      const loginNew = await api('/api/auth/login', {
        method: 'POST', auth: false, body: { email: testEmail, password: 'newpass123' },
      });
      check('login with NEW password → 200', loginNew.status === 200, `status=${loginNew.status}`);
      const loginOld = await api('/api/auth/login', {
        method: 'POST', auth: false, body: { email: testEmail, password: 'verify1234' },
      });
      check('login with OLD password → 401', loginOld.status === 401, `status=${loginOld.status}`);
      const resetReuse = await api('/api/auth/reset-password', {
        method: 'POST', auth: false, body: { token: validToken, password: 'another123' },
      });
      check('reusing the same reset token → 400 (single-use)', resetReuse.status === 400, `status=${resetReuse.status}`);
    } finally {
      runA2.stop();
      await sleep(2000);
    }
    rmDir(dirA);
  }

  // ---------- Live API: run B (dummy Meta app) — reauthenticate URLs ----------
  const portB = 4412;
  const dirB = '.pglite-data-auth-b';
  const baseB = `http://localhost:${portB}`;
  rmDir(dirB);
  const runB = startApi(portB, dirB, { META_APP_ID: 'dummy-app-id', META_APP_SECRET: 'dummy-secret' });
  try {
    check('API B starts (health)', await waitForHealth(baseB));
    const api = makeApi(baseB);
    const signupB = await api('/api/auth/signup', {
      method: 'POST', auth: false,
      body: { name: 'OAuth Test', email: `oauth-test+${stamp}@example.com`, password: 'verify1234', workspaceName: 'OAuth Shop' },
    });
    check('API B signup → 201', signupB.status === 201, `status=${signupB.status}`);
    token = signupB.data?.token ?? '';
    for (const kind of ['facebook', 'instagram', 'whatsapp']) {
      const plain = await api(`/api/channels/${kind}/login`);
      check(`${kind} login → 200 dialog URL, no auth_type by default`, plain.status === 200 && typeof plain.data?.url === 'string' && plain.data.url.includes('facebook.com') && !plain.data.url.includes('auth_type'), `status=${plain.status}, url=${String(plain.data?.url ?? '').slice(0, 80)}`);
      const reauth = await api(`/api/channels/${kind}/login?reauthenticate=1`);
      check(`${kind} login ?reauthenticate=1 → URL carries auth_type=reauthenticate`, reauth.status === 200 && String(reauth.data?.url ?? '').includes('auth_type=reauthenticate'), `status=${reauth.status}`);
    }
  } finally {
    runB.stop();
    await sleep(2000);
    rmDir(dirB);
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
