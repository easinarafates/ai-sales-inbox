#!/usr/bin/env node
/**
 * Verification for the Setup fake-completion fix (Task 15, 2026-11-11).
 *
 * THE BUG (user-reported): clicking ANY step in Setup marked it Done —
 * Courier showed done (never set up), Invite Your Team showed done
 * (nobody invited), Go Live showed done (just clicked). Root cause:
 * POST /api/setup/complete-step blindly appended the clicked step to
 * setup_progress.completed_steps with no check, and GET
 * /api/setup/progress just read that stored flag back.
 *
 * THE FIX:
 * - apps/api/src/setup/routes.ts: every step is COMPUTED from real
 *   workspace state on each read (channels connected / workspace name
 *   + business district / >=1 product / users.phone / courier
 *   credentials verified_at / team invite or 2nd member / test code
 *   verified). The stored completed_steps array is never trusted and
 *   is self-healed to the real set on read.
 * - POST /api/setup/complete-step now serves ONLY go-live test-code
 *   issuance (gated on the other six really being done); any other
 *   step is rejected with 400.
 * - apps/web/app/setup/page.tsx: clicking a step only navigates to
 *   the page where the task is really done; only Go Live still calls
 *   the API (for the test code).
 *
 * Checks (all on a FRESH throwaway PGlite workspace — simulated test
 * data only, never a live user action):
 * - Static: real-state queries present, blind array_append gone,
 *   complete-step rejects non-go-live steps, page has no
 *   mark-done-on-click.
 * - Boot 1: (a) fresh workspace → all 7 NOT done, 0 of 7; (b) simulate
 *   clicking every step (POST complete-step for each) → still 0 of 7;
 *   (c) add a product for real → ONLY products done, 1 of 7;
 *   (d) save a phone number for real → 2 of 7; plus real completions
 *   of facebook (connect a Messenger channel), business (set the
 *   business district) and team (create an invite) → 5 of 7, with
 *   courier + go-live still NOT done; wrong test code → 400.
 * - Fake-flags: stop the API, write ALL 7 steps into the stored
 *   completed_steps array directly in PGlite (what the old bug left
 *   behind), reboot, GET progress → still only the really-done steps;
 *   stop again and read the row → the stored array was healed to the
 *   real set.
 *
 * NOT covered here (needs a live provider): courier verified_at (the
 * verify call hits Steadfast/Pathao) and the full go-live code flow
 * (needs all six really done, incl. courier). The go-live gate is
 * covered statically + by the 400-missing-steps check in (b).
 *
 * Run from the repo root:  node scripts/verify-setup-real-completion.mjs
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const results = [];
let token = '';

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ALL_STEPS = ['facebook', 'business', 'products', 'notifications', 'courier', 'team', 'go-live'];

function makeApi(base) {
  return async function api(pathname, { method = 'GET', body, auth = true, headers = {} } = {}) {
    const res = await fetch(`${base}${pathname}`, {
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
      JWT_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      GEMINI_API_KEY: '',
      GROQ_API_KEY: '',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      META_APP_ID: 'dummy-app-id',
      META_APP_SECRET: 'dummy-meta-secret',
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

/** Direct PGlite access to the same data dir while the API is stopped. */
async function withPglite(dataDir, fn) {
  const requireApi = createRequire(path.join(ROOT, 'apps/api/package.json'));
  const { PGlite } = requireApi('@electric-sql/pglite');
  const pg = new PGlite(path.join(ROOT, 'apps/api', dataDir));
  try {
    // waitReady is a Promise property on this PGlite version, not a method.
    if (pg.waitReady) await pg.waitReady;
    return await fn(pg);
  } finally {
    await pg.close();
  }
}

function doneSteps(progress) {
  return (progress?.steps ?? []).filter((s) => s.completed).map((s) => s.step);
}

async function main() {
  // ---------- Static checks ----------
  const routesSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/setup/routes.ts'), 'utf8');
  check('routes: facebook computed from connected messenger/facebook_comment channel', routesSrc.includes("platform IN ('messenger', 'facebook_comment')") && routesSrc.includes("status = 'connected'"));
  check('routes: business computed from workspace name + business_district', routesSrc.includes('business_district') && routesSrc.includes("NULLIF(BTRIM(name), '') IS NOT NULL"));
  check('routes: products computed from >=1 products row', routesSrc.includes('SELECT 1 FROM products WHERE workspace_id = $1'));
  check('routes: notifications computed from users.phone', routesSrc.includes('SELECT 1 FROM users WHERE id = $2::uuid') && routesSrc.includes("NULLIF(BTRIM(phone), '') IS NOT NULL"));
  check('routes: courier computed from verified courier credentials', routesSrc.includes('courier_credentials') && routesSrc.includes('verified_at IS NOT NULL'));
  check('routes: team computed from team_invites or a 2nd member', routesSrc.includes('SELECT 1 FROM team_invites WHERE workspace_id = $1') && routesSrc.includes('FROM members WHERE workspace_id = $1 AND user_id <> $2::uuid'));
  check('routes: go-live computed from test_code_verified', routesSrc.includes("state['go-live'] = row.test_code_verified === true"));
  check('routes: no blind array_append of a clicked step', !routesSrc.includes('array_append(completed_steps'));
  check('routes: complete-step rejects non-go-live steps with 400', routesSrc.includes("if (step !== 'go-live')") && routesSrc.includes('steps complete automatically when the task is really done'));
  check('routes: stored flags are self-healed to the real set', routesSrc.includes('healStoredFlags'));
  check('routes: go-live code issuance still gated on the other six really done', routesSrc.includes("SETUP_STEPS.filter((s) => s !== 'go-live' && !state[s])"));

  const pageSrc = fs.readFileSync(path.join(ROOT, 'apps/web/app/setup/page.tsx'), 'utf8');
  check('web: no "Complete step" mark-done button (label key + click handler gone)', !pageSrc.includes('t("setupComplete"') && !pageSrc.includes('complete(s.step)') && !pageSrc.includes('onClick={() => complete('));
  check('web: steps navigate to the real task pages', pageSrc.includes('href: "/channels"') && pageSrc.includes('href: "/products"') && pageSrc.includes('href: "/courier"') && pageSrc.includes('href: "/team"') && pageSrc.includes('href: "/profile'));
  check('web: completeStep is called only for go-live test code', pageSrc.includes('setupApi.completeStep("go-live")') && !pageSrc.includes('completeStep(step)') && !pageSrc.includes('complete(s.step)'));
  check('web: go-live button disabled until the other six are done', pageSrc.includes('disabled={busy === "go-live" || !otherSixDone}'));

  // ---------- Boot 1: fresh workspace, click simulation, real completions ----------
  const stamp = Date.now();
  const port = 4027;
  const dataDir = '.pglite-data-setup-real';
  const run1 = startApi(port, dataDir);
  process.on('exit', run1.stop);
  let workspaceId = '';
  try {
    const up = await waitForHealth(`http://localhost:${port}`);
    check('boot 1: API starts', up, up ? '' : run1.log().slice(-500));
    if (!up) return;
    const api = makeApi(`http://localhost:${port}`);
    const signup = await api('/api/auth/signup', {
      method: 'POST', auth: false,
      body: { name: 'Setup Test Owner', email: `setuptest+${stamp}@example.com`, password: 'verify1234', workspaceName: 'Setup Test Shop' },
    });
    check('boot 1: signup', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
    token = signup.data?.token ?? '';
    workspaceId = signup.data?.workspace?.id ?? '';

    // (a) Fresh workspace: all 7 NOT done, 0 of 7.
    const fresh = await api('/api/setup/progress');
    check('(a) fresh workspace: progress loads', fresh.status === 200 && !!fresh.data?.progress, `status=${fresh.status}`);
    check('(a) fresh workspace: 0 of 7 steps done', fresh.data?.progress?.completedCount === 0 && fresh.data?.progress?.totalSteps === 7, `count=${fresh.data?.progress?.completedCount ?? '?'}`);
    check('(a) fresh workspace: every step shows NOT done', doneSteps(fresh.data?.progress).length === 0, JSON.stringify(doneSteps(fresh.data?.progress)));

    // (b) Simulate clicking EVERY step — the old bug marked each Done.
    for (const step of ALL_STEPS) {
      const click = await api('/api/setup/complete-step', { method: 'POST', body: { step } });
      check(`(b) clicking "${step}" does NOT mark it done (400, not 200)`, click.status === 400, `status=${click.status}`);
    }
    const afterClicks = await api('/api/setup/progress');
    check('(b) after clicking all 7 steps: still 0 of 7', afterClicks.data?.progress?.completedCount === 0, `count=${afterClicks.data?.progress?.completedCount ?? '?'}`);
    check('(b) after clicking all 7 steps: every step still NOT done', doneSteps(afterClicks.data?.progress).length === 0, JSON.stringify(doneSteps(afterClicks.data?.progress)));

    // (e) The old mark-done path no longer exists: a bare complete-step
    // for a non-go-live step is rejected, never 200 with progress done.
    const oldPath = await api('/api/setup/complete-step', { method: 'POST', body: { step: 'courier' } });
    check('(e) old mark-done path rejected (400 + real progress, courier still not done)', oldPath.status === 400 && (oldPath.data?.progress?.steps ?? []).find((s) => s.step === 'courier')?.completed === false, `status=${oldPath.status}`);

    // Wrong test code is still rejected.
    const wrongCode = await api('/api/setup/verify-test', { method: 'POST', body: { code: '12345' } });
    check('verify-test: wrong code rejected (400, verified false)', wrongCode.status === 400 && wrongCode.data?.verified === false, `status=${wrongCode.status}`);

    // (c) Complete ONE step for real: add a product through the API.
    const product = await api('/api/products', { method: 'POST', body: { name: 'Test Kurti', pricePaisa: 50000, stock: 5 } });
    check('(c) product created for real', product.status === 201, `status=${product.status}`);
    const afterProduct = await api('/api/setup/progress');
    check('(c) after adding a product: ONLY products done, 1 of 7', afterProduct.data?.progress?.completedCount === 1 && JSON.stringify(doneSteps(afterProduct.data?.progress)) === JSON.stringify(['products']), `done=${JSON.stringify(doneSteps(afterProduct.data?.progress))}`);

    // (d) Complete a SECOND step for real: save a phone number.
    const phone = await api('/api/profile', { method: 'PATCH', body: { name: 'Setup Test Owner', phone: '01712345678' } });
    check('(d) phone number saved for real', phone.status === 200 && phone.data?.user?.phone === '01712345678', `status=${phone.status} phone=${phone.data?.user?.phone ?? '?'}`);
    const afterPhone = await api('/api/setup/progress');
    check('(d) after saving a phone: 2 of 7 (products + notifications only)', afterPhone.data?.progress?.completedCount === 2 && JSON.stringify(doneSteps(afterPhone.data?.progress).sort()) === JSON.stringify(['notifications', 'products']), `done=${JSON.stringify(doneSteps(afterPhone.data?.progress))}`);

    // More real completions: facebook (connect a Messenger channel),
    // business (set the business district), team (create an invite).
    const channel = await api('/api/channels', { method: 'POST', body: { platform: 'messenger', externalId: '1234567890', displayName: 'Setup Test Page', token: 'dummy-page-token' } });
    check('real: Messenger channel connects (201, connected)', channel.status === 201 && channel.data?.channel?.status === 'connected', `status=${channel.status} ${JSON.stringify(channel.data ?? {}).slice(0, 160)}`);
    const district = await api('/api/delivery-charges', { method: 'PUT', body: { rules: [], businessDistrict: 'Dhaka' } });
    check('real: business district saved (Dhaka — API normalises to lowercase)', district.status === 200 && String(district.data?.businessDistrict ?? '').toLowerCase() === 'dhaka', `status=${district.status} district=${district.data?.businessDistrict ?? '?'}`);
    const invite = await api('/api/team/invites', { method: 'POST', body: { email: 'teammate@example.com' } });
    check('real: team invite created (201)', invite.status === 201 && !!invite.data?.invite?.id, `status=${invite.status}`);
    const afterReal = await api('/api/setup/progress');
    check('real: 5 of 7 done (facebook, business, products, notifications, team)', afterReal.data?.progress?.completedCount === 5 && JSON.stringify(doneSteps(afterReal.data?.progress).sort()) === JSON.stringify(['business', 'facebook', 'notifications', 'products', 'team']), `done=${JSON.stringify(doneSteps(afterReal.data?.progress))}`);
    check('real: courier + go-live still NOT done (nothing verified, no code)', doneSteps(afterReal.data?.progress).includes('courier') === false && doneSteps(afterReal.data?.progress).includes('go-live') === false, `done=${JSON.stringify(doneSteps(afterReal.data?.progress))}`);

    // Go-live code is still blocked while courier is missing.
    const goLiveBlocked = await api('/api/setup/complete-step', { method: 'POST', body: { step: 'go-live' } });
    check('go-live: code blocked while courier is missing (400 + missingSteps)', goLiveBlocked.status === 400 && (goLiveBlocked.data?.missingSteps ?? []).includes('courier'), `status=${goLiveBlocked.status} missing=${JSON.stringify(goLiveBlocked.data?.missingSteps ?? [])}`);
  } finally {
    run1.stop();
    await sleep(2000);
  }

  // ---------- Fake flags: seed the old bug's stored array directly ----------
  await withPglite(dataDir, async (pg) => {
    const lit = `ARRAY[${ALL_STEPS.map((s) => `'${s}'`).join(',')}]`;
    await pg.query(`UPDATE setup_progress SET completed_steps = ${lit} WHERE workspace_id = $1`, [workspaceId]);
  });
  check('fake-flags: all 7 steps planted in the stored array (old-bug state)', true, 'seeded via direct PGlite write while API stopped');

  const run2 = startApi(port, dataDir);
  process.on('exit', run2.stop);
  try {
    const up2 = await waitForHealth(`http://localhost:${port}`);
    check('boot 2: API restarts on the same dir', up2, up2 ? '' : run2.log().slice(-500));
    if (up2) {
      const api = makeApi(`http://localhost:${port}`);
      const seeded = await api('/api/setup/progress');
      check('fake-flags: progress IGNORES the planted flags (still 5 of 7, real steps only)', seeded.data?.progress?.completedCount === 5 && JSON.stringify(doneSteps(seeded.data?.progress).sort()) === JSON.stringify(['business', 'facebook', 'notifications', 'products', 'team']), `done=${JSON.stringify(doneSteps(seeded.data?.progress))} count=${seeded.data?.progress?.completedCount ?? '?'}`);
      check('fake-flags: courier + go-live still NOT done despite planted flags', doneSteps(seeded.data?.progress).includes('courier') === false && doneSteps(seeded.data?.progress).includes('go-live') === false, `done=${JSON.stringify(doneSteps(seeded.data?.progress))}`);
    }
  } finally {
    run2.stop();
    await sleep(2000);
  }

  // The read must have healed the stored array back to the real set.
  const storedAfter = await withPglite(dataDir, async (pg) => {
    const res = await pg.query('SELECT completed_steps FROM setup_progress WHERE workspace_id = $1', [workspaceId]);
    return res.rows[0]?.completed_steps ?? null;
  });
  check('fake-flags: stored array healed in the DB to the real 5 steps', Array.isArray(storedAfter) && storedAfter.length === 5 && JSON.stringify([...storedAfter].sort()) === JSON.stringify(['business', 'facebook', 'notifications', 'products', 'team']), `stored=${JSON.stringify(storedAfter)}`);

  try { fs.rmSync(path.join(ROOT, 'apps/api', dataDir), { recursive: true, force: true }); } catch { /* already gone */ }
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
