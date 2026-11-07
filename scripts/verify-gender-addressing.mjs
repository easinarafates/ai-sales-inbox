#!/usr/bin/env node
/**
 * Verification for gender-aware addressing ("স্যার" / "ম্যাডাম").
 *
 * The AI must first determine whether the customer is male or female
 * (from the NAME only — Meta gives no gender field and no photo), then
 * address them accordingly throughout the reply: "স্যার" for men,
 * "ম্যাডাম" for women, neutral "আপনি" when the gender is unknown.
 *
 * Checks:
 * - Migration 23 adds customers.gender ('male'|'female'|'unknown').
 * - inferGenderFromName unit cases (via tsx): male/female/unknown names.
 * - SYSTEM_PROMPT + buildUserPrompt carry the addressing rule + the
 *   customer's gender line; the deterministic fallback also uses
 *   স্যার/ম্যাডাম/আপনি the same way.
 * - Webhook findOrCreateCustomer fills gender at creation; the Meta
 *   enrich fills it when a name is newly filled; a hand-set gender is
 *   never overwritten by inference.
 * - PATCH /api/customers/:id sets gender (400 on a bad value, 404 on an
 *   unknown customer); GET /api/inbox/:id returns the customer's gender.
 * - Live AI replies (real Gemini Lite, local API + PGlite, webchat leg
 *   so the name arrives in the payload):
 *   (a) "Mohammad Easin" → reply contains "স্যার", not "ম্যাডাম"
 *   (b) "Fatima Begum"   → reply contains "ম্যাডাম", not "স্যার"
 *   (c) "নূর" (ambiguous) → reply has NO স্যার/ম্যাডাম, uses "আপনি"
 *   (d) PATCHing the "নূর" customer to female → the NEXT reply uses
 *       "ম্যাডাম" (the corrected value drives future replies).
 * - Manual name correction (migration 23: name_manually_set):
 *   (e) PATCHing a customer's name stores it exactly as typed, sets
 *       name_manually_set, and re-infers the gender when it was unknown
 *       ("Alex" → "Fatima Begum" starts getting "ম্যাডাম").
 *   (e2) A Messenger profile refresh after a manual correction does NOT
 *       overwrite the name: the stub Graph keeps returning "Stub Name"
 *       but the stored name stays the manual one.
 * - Web Inbox thread header shows the gender (স্যার/ম্যাডাম/জানা নেই)
 *   with a control that calls customersApi.updateGender, plus a name
 *   edit that calls customersApi.updateName.
 *
 * Run from the repo root:  node scripts/verify-gender-addressing.mjs
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 * The local API runs with the real Gemini key from apps/api/.env
 * (AI_PROVIDER=gemini, AI_MODEL=gemini-3.5-flash-lite) so the replies
 * are genuine Lite replies, not demo mode. No Graph calls are made:
 * the webchat leg delivers by saving.
 */
import { spawn, execSync } from 'node:child_process';
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
      USE_PGLITE: 'true',
      PGLITE_DATA_DIR: dataDir,
      JWT_SECRET: 'verify-jwt-secret-for-local-tests-only-0123456789',
      TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      AI_PROVIDER: 'gemini',
      AI_MODEL: 'gemini-3.5-flash-lite',
      // No webchat secret locally (the real .env sets one) — the
      // verifier's webchat posts carry no secret header.
      WEBCHAT_SECRET: '',
      META_APP_ID: 'dummy-app-id',
      META_APP_SECRET: 'dummy-app-secret',
      META_GRAPH_BASE_URL: 'http://localhost:4019/v21.0',
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

async function main() {
  // ---------- Static checks ----------
  const mig23 = fs.readFileSync(path.join(ROOT, 'apps/api/src/db/migrations/23-customer-gender.sql'), 'utf8');
  check('migration 23 adds customers.gender with default unknown', mig23.includes('ADD COLUMN IF NOT EXISTS gender') && mig23.includes("DEFAULT 'unknown'"));
  check('migration 23 constrains gender to male/female/unknown', mig23.includes("CHECK (gender IN ('male', 'female', 'unknown'))"));
  check('migration 23 adds customers.name_manually_set', mig23.includes('ADD COLUMN IF NOT EXISTS name_manually_set'));

  const genderSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/customers/gender.ts'), 'utf8');
  check('gender module exports inferGenderFromName', genderSrc.includes('export function inferGenderFromName'));
  check('gender module never guesses from a photo', genderSrc.includes('NEVER guessed from a photo') || genderSrc.includes('never guessed from a photo'));
  check('gender module has conservative unknown fallback', genderSrc.includes("return 'unknown'"));

  const promptsSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/ai-agent/prompts.ts'), 'utf8');
  check('SYSTEM_PROMPT has the স্যার/ম্যাডাম addressing rule', promptsSrc.includes('সম্বোধন') && promptsSrc.includes('"স্যার"') && promptsSrc.includes('"ম্যাডাম"'));
  check('SYSTEM_PROMPT forbids স্যার/ম্যাডাম when gender unknown', promptsSrc.includes('লিঙ্গ জানা না থাকলে') && promptsSrc.includes('"আপনি"'));
  check('buildUserPrompt includes the addressing line', promptsSrc.includes('addressingLine(ctx.customerGender)'));
  check('AgentContext carries customerGender', promptsSrc.includes('customerGender'));

  const agentSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/ai-agent/agent.ts'), 'utf8');
  check('agent loads the customer gender in processBatch', agentSrc.includes('gender') && agentSrc.includes('FROM customers WHERE workspace_id = $1 AND id = $2'));
  check('deterministic fallback takes gender and uses স্যার/ম্যাডাম', agentSrc.includes('deterministicProductReply(') && agentSrc.includes('ধন্যবাদ, স্যার।') && agentSrc.includes('ধন্যবাদ, ম্যাডাম।'));
  check('demo mode also opens/closes with the salutation', agentSrc.includes('genderSalutation(gender)') && agentSrc.includes('ধন্যবাদ, ${salutation}।'));
  check('demo mode addresses unknown gender with neutral আপনি (never স্যার/ম্যাডাম)', agentSrc.includes('আপনার প্রশ্নের উত্তর দিচ্ছি') && agentSrc.includes('Unknown gender: neutral'));
  check('deterministic fallback addresses unknown gender with neutral আপনি', agentSrc.includes('return `আপনার প্রশ্নের উত্তর দিচ্ছি:'));
  check('second-call prompt repeats the addressing rule', agentSrc.includes('addressingLine(customerGender)'));

  const whSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/webhooks/routes.ts'), 'utf8');
  check('webhook fills gender at customer creation', whSrc.includes('inferGenderFromName(name ?? null)') && whSrc.includes('INSERT INTO customers (workspace_id, name, gender, channel_identities)'));
  check('webhook never overwrites an existing gender', whSrc.includes('never overwritten here') || whSrc.includes('NEVER overwritten'));

  const profileSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/meta-profile.ts'), 'utf8');
  check('profile enrich fills gender only from a newly filled name', profileSrc.includes('inferGenderFromName(name)') && profileSrc.includes('nameWasFilled'));

  const custSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/customers/routes.ts'), 'utf8');
  check('customers routes have PATCH /:id for gender', custSrc.includes("customersRouter.patch('/customers/:id'"));
  check('PATCH validates the gender value', custSrc.includes("gender must be 'male', 'female' or 'unknown'"));
  check('PATCH accepts a name correction and sets the manual flag', custSrc.includes('name_manually_set = TRUE') && custSrc.includes('name must be a non-empty string'));
  check('PATCH re-infers gender from a corrected name when unknown', custSrc.includes('inferGenderFromName(newName)'));

  const profileSrc2 = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/meta-profile.ts'), 'utf8');
  check('profile enrich never overwrites a manually set name', profileSrc2.includes('customerNameManuallySet') && profileSrc2.includes('nameManuallySet ? input.customerName'));

  const inboxApiSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/inbox/routes.ts'), 'utf8');
  check('inbox detail returns the customer gender', inboxApiSrc.includes('address, gender, name_manually_set, picture_url'));

  const libSrc = fs.readFileSync(path.join(ROOT, 'apps/web/lib/api.ts'), 'utf8');
  check('web api client has Customer.gender + updateGender', libSrc.includes('gender?: string') && libSrc.includes('updateGender:'));
  check('web api client has updateName', libSrc.includes('updateName:') && libSrc.includes('name_manually_set'));

  const pageSrc = fs.readFileSync(path.join(ROOT, 'apps/web/app/inbox/page.tsx'), 'utf8');
  check('inbox page shows the gender in the thread header', pageSrc.includes('inbox.addressAs') && pageSrc.includes('inbox.genderMaleShort'));
  check('inbox page has a gender control calling updateGender', pageSrc.includes('changeGender') && pageSrc.includes('customersApi.updateGender'));
  check('inbox page has a name edit calling updateName', pageSrc.includes('saveName') && pageSrc.includes('customersApi.updateName'));
  check('inbox page shows the manual-name note', pageSrc.includes('inbox.nameManual') && pageSrc.includes('name_manually_set'));

  // ---------- Unit checks (inference table) ----------
  let unitOut = '';
  try {
    unitOut = execSync('npx tsx ../../scripts/check-gender-inference.ts', {
      cwd: path.join(ROOT, 'apps/api'),
      encoding: 'utf8',
      timeout: 60000,
    });
  } catch (err) {
    unitOut = (err.stdout ?? '') + (err.stderr ?? '');
  }
  const unitCases = unitOut.split('\n').filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l));
  const unitFailed = unitCases.filter((c) => !c.ok);
  check(`inferGenderFromName unit cases (${unitCases.length - unitFailed.length}/${unitCases.length})`, unitCases.length >= 20 && unitFailed.length === 0,
    unitFailed.map((c) => `${c.name}: got ${c.got}, want ${c.expected}`).join('; '));

  // ---------- Stub Graph server (for the Messenger refresh test) ----------
  // POST /{page-id}/messages → 200 (mark_seen + AI reply sends).
  // GET /{page-id}/conversations?user_id={psid} → the participant named
  // "Stub Name" (the profile enrich's fallback route).
  // GET /{psid} (direct read) → 400, like real Meta for this sender.
  const stubHits = [];
  const graphStub = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let raw = '';
    req.on('data', (c) => { raw += c.toString(); });
    req.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      stubHits.push({ method: req.method, path: url.pathname, body });
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'POST' && url.pathname.endsWith('/messages')) {
        return send(200, { message_id: `mid-stub-${Date.now()}` });
      }
      if (req.method === 'GET' && url.pathname.endsWith('/conversations')) {
        const psid = url.searchParams.get('user_id') ?? 'unknown';
        return send(200, { data: [{ id: 'thread-stub', participants: { data: [{ id: psid, name: 'Stub Name' }] } }] });
      }
      return send(400, { error: { message: 'Unsupported get request.', type: 'GraphMethodException', code: 100, error_subcode: 33 } });
    });
  });
  const stubPort = 4019;
  await new Promise((resolve) => graphStub.listen(stubPort, resolve));

  // ---------- Local API checks ----------
  const stamp = Date.now();
  const port = 4017;
  const api = makeApi(`http://localhost:${port}`);
  const dataDir = '.pglite-data-gender';
  const run = startApi(port, dataDir);
  process.on('exit', run.stop);
  try {
    const up = await waitForHealth(`http://localhost:${port}`);
    check('API starts (health)', up, up ? '' : run.log().slice(-500));
    if (!up) return;

    const email = `gender+${stamp}@example.com`;
    const signup = await api('/api/auth/signup', {
      method: 'POST', auth: false,
      body: { name: 'Gender Owner', email, password: 'verify1234', workspaceName: 'Gender Shop' },
    });
    check('signup', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
    token = signup.data?.token ?? '';
    workspaceId = signup.data?.workspace?.id ?? '';

    // New signups start in practice mode, which silently blocks ALL AI
    // replies to non-test customers — go live first, or every reply
    // wait below times out with no outbound message at all.
    const live = await api(`/api/workspaces/${workspaceId}/go-live`, { method: 'POST' });
    check('go-live (practice mode off)', live.status === 200 && live.data?.workspace?.practice_mode === false, `status=${live.status}`);

    // Seed the 3 Halal Chic products (same prices as the live test).
    for (const p of [
      { name: 'Shirt', pricePaisa: 60000, stock: 10 },
      { name: 'T-shirt', pricePaisa: 40000, stock: 10 },
      { name: 'Jeans', pricePaisa: 50000, stock: 10 },
    ]) {
      const created = await api('/api/products', { method: 'POST', body: p });
      check(`product ${p.name} ৳${p.pricePaisa / 100} created`, created.status === 201, `status=${created.status}`);
    }

    const ch = await api('/api/channels', { method: 'POST', body: { platform: 'webchat', externalId: 'site-gender', displayName: 'Gender Test Site' } });
    check('webchat channel → 201', ch.status === 201, `status=${ch.status} ${JSON.stringify(ch.data ?? {}).slice(0, 200)}`);

    async function sendWebchat(senderId, name, text) {
      const r = await api('/api/webhooks/webchat', {
        method: 'POST', auth: false,
        body: { externalId: 'site-gender', senderId, name, text },
      });
      return r;
    }
    async function waitOutbound(convId, minCount = 1, timeoutMs = 90000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const detail = await api(`/api/inbox/${convId}`);
        const outs = (detail.data?.messages ?? []).filter((m) => m.direction === 'out');
        if (outs.length >= minCount) return outs[outs.length - 1];
        await sleep(2000);
      }
      return null;
    }
    async function outCount(convId) {
      const detail = await api(`/api/inbox/${convId}`);
      return (detail.data?.messages ?? []).filter((m) => m.direction === 'out').length;
    }
    async function customerOf(convId) {
      const detail = await api(`/api/inbox/${convId}`);
      return detail.data?.customer ?? null;
    }

    // (a) Male — Mohammad Easin asks the jeans price.
    const m1 = await sendWebchat('wc-male-1', 'Mohammad Easin', 'জিন্সের দাম কত?');
    check('webchat (a) male message accepted', m1.status === 200 && !!m1.data?.conversationId, `status=${m1.status}`);
    const convMale = m1.data?.conversationId ?? '';
    const outMale = convMale ? await waitOutbound(convMale) : null;
    const bodyMale = outMale?.body ?? '';
    check('(a) male reply contains "স্যার"', bodyMale.includes('স্যার'), bodyMale.slice(0, 200));
    check('(a) male reply has NO "ম্যাডাম"', !bodyMale.includes('ম্যাডাম'), bodyMale.slice(0, 200));
    check('(a) male reply has the right price ৳500', bodyMale.includes('500') || bodyMale.includes('৫০০'), bodyMale.slice(0, 200));
    const custMale = convMale ? await customerOf(convMale) : null;
    check('(a) male customer stored gender=male', custMale?.gender === 'male', `gender=${custMale?.gender ?? ''}`);
    const detailMale = convMale ? await api(`/api/inbox/${convMale}`) : null;
    check('(a) inbox detail returns customer gender', detailMale?.data?.customer?.gender === 'male');

    // (b) Female — Fatima Begum asks about the T-shirt.
    const m2 = await sendWebchat('wc-female-1', 'Fatima Begum', 'টি-শার্ট আছে?');
    check('webchat (b) female message accepted', m2.status === 200 && !!m2.data?.conversationId, `status=${m2.status}`);
    const convFemale = m2.data?.conversationId ?? '';
    const outFemale = convFemale ? await waitOutbound(convFemale) : null;
    const bodyFemale = outFemale?.body ?? '';
    check('(b) female reply contains "ম্যাডাম"', bodyFemale.includes('ম্যাডাম'), bodyFemale.slice(0, 200));
    check('(b) female reply has NO "স্যার"', !bodyFemale.includes('স্যার'), bodyFemale.slice(0, 200));
    check('(b) female reply has the right price ৳400', bodyFemale.includes('400') || bodyFemale.includes('৪০০'), bodyFemale.slice(0, 200));
    const custFemale = convFemale ? await customerOf(convFemale) : null;
    check('(b) female customer stored gender=female', custFemale?.gender === 'female', `gender=${custFemale?.gender ?? ''}`);

    // (c) Ambiguous — "নূর" asks the shirt price.
    const m3 = await sendWebchat('wc-unknown-1', 'নূর', 'শার্টের দাম কত?');
    check('webchat (c) ambiguous message accepted', m3.status === 200 && !!m3.data?.conversationId, `status=${m3.status}`);
    const convUnknown = m3.data?.conversationId ?? '';
    const outUnknown = convUnknown ? await waitOutbound(convUnknown) : null;
    const bodyUnknown = outUnknown?.body ?? '';
    check('(c) ambiguous reply has NO "স্যার"', !bodyUnknown.includes('স্যার'), bodyUnknown.slice(0, 200));
    check('(c) ambiguous reply has NO "ম্যাডাম"', !bodyUnknown.includes('ম্যাডাম'), bodyUnknown.slice(0, 200));
    check('(c) ambiguous reply uses neutral "আপনি"', bodyUnknown.includes('আপনি') || bodyUnknown.includes('আপনার'), bodyUnknown.slice(0, 200));
    check('(c) ambiguous reply has the right price ৳600', bodyUnknown.includes('600') || bodyUnknown.includes('৬০০'), bodyUnknown.slice(0, 200));
    const custUnknown = convUnknown ? await customerOf(convUnknown) : null;
    check('(c) ambiguous customer stored gender=unknown', custUnknown?.gender === 'unknown', `gender=${custUnknown?.gender ?? ''}`);

    // (d) PATCH the gender control.
    const unknownId = custUnknown?.id ?? '';
    const badPatch = await api(`/api/customers/${unknownId}`, { method: 'PATCH', body: { gender: 'other' } });
    check('(d) PATCH rejects a bad gender (400)', badPatch.status === 400, `status=${badPatch.status}`);
    const patch404 = await api('/api/customers/00000000-0000-0000-0000-000000000000', { method: 'PATCH', body: { gender: 'female' } });
    check('(d) PATCH on an unknown customer → 404', patch404.status === 404, `status=${patch404.status}`);
    const patched = await api(`/api/customers/${unknownId}`, { method: 'PATCH', body: { gender: 'female' } });
    check("(d) PATCH gender → female (200)", patched.status === 200 && patched.data?.customer?.gender === 'female', `status=${patched.status} gender=${patched.data?.customer?.gender ?? ''}`);
    const afterPatch = await api(`/api/customers/${unknownId}`);
    check('(d) GET confirms the stored gender', afterPatch.data?.customer?.gender === 'female', `gender=${afterPatch.data?.customer?.gender ?? ''}`);

    // (d2) The corrected value drives the NEXT reply.
    const outsBefore = await outCount(convUnknown);
    const m4 = await sendWebchat('wc-unknown-1', 'নূর', 'জিন্সের দাম কত?');
    check('webchat (d2) follow-up accepted', m4.status === 200, `status=${m4.status}`);
    const outAfter = convUnknown ? await waitOutbound(convUnknown, outsBefore + 1) : null;
    const bodyAfter = outAfter?.body ?? '';
    check('(d2) after PATCH to female, the next reply uses "ম্যাডাম"', bodyAfter.includes('ম্যাডাম'), bodyAfter.slice(0, 200));
    check('(d2) after PATCH, the next reply has NO "স্যার"', !bodyAfter.includes('স্যার'), bodyAfter.slice(0, 200));

    // (e) Manual name correction + gender re-inference.
    // "Alex" is unknown; correcting the name to "Fatima Begum" must store
    // it exactly, flag it manual, and re-infer the gender to female.
    const m5 = await sendWebchat('wc-rename-1', 'Alex', 'জিন্সের দাম কত?');
    check('webchat (e) ambiguous "Alex" message accepted', m5.status === 200 && !!m5.data?.conversationId, `status=${m5.status}`);
    const convRename = m5.data?.conversationId ?? '';
    const outRename = convRename ? await waitOutbound(convRename) : null;
    check('(e) "Alex" reply has NO "স্যার"/"ম্যাডাম"', outRename && !outRename.body.includes('স্যার') && !outRename.body.includes('ম্যাডাম'), (outRename?.body ?? '').slice(0, 200));
    const custRename = convRename ? await customerOf(convRename) : null;
    check('(e) "Alex" stored gender=unknown', custRename?.gender === 'unknown', `gender=${custRename?.gender ?? ''}`);
    const renamed = await api(`/api/customers/${custRename?.id ?? ''}`, { method: 'PATCH', body: { name: 'Fatima Begum' } });
    check('(e) PATCH name → "Fatima Begum" (200)', renamed.status === 200 && renamed.data?.customer?.name === 'Fatima Begum', `status=${renamed.status} name=${renamed.data?.customer?.name ?? ''}`);
    check('(e) PATCH name sets name_manually_set', renamed.data?.customer?.name_manually_set === true, `flag=${renamed.data?.customer?.name_manually_set ?? ''}`);
    check('(e) correcting the name re-infers gender to female', renamed.data?.customer?.gender === 'female', `gender=${renamed.data?.customer?.gender ?? ''}`);
    const badName = await api(`/api/customers/${custRename?.id ?? ''}`, { method: 'PATCH', body: { name: '   ' } });
    check('(e) PATCH rejects an empty name (400)', badName.status === 400, `status=${badName.status}`);
    const outsRenameBefore = await outCount(convRename);
    const m6 = await sendWebchat('wc-rename-1', 'Alex', 'টি-শার্ট আছে?');
    check('webchat (e) follow-up accepted', m6.status === 200, `status=${m6.status}`);
    const outRename2 = convRename ? await waitOutbound(convRename, outsRenameBefore + 1) : null;
    check('(e) after the rename, the next reply uses "ম্যাডাম"', (outRename2?.body ?? '').includes('ম্যাডাম'), (outRename2?.body ?? '').slice(0, 200));

    // (e2) A Messenger profile refresh must NOT overwrite a manual name.
    // The stub Graph keeps returning "Stub Name" for this PSID; the
    // stored name must stay the manual one across another message.
    // A SECOND workspace: the trial plan allows 1 channel, and the
    // webchat channel already uses this workspace's slot.
    const email2 = `gender2+${stamp}@example.com`;
    const signup2 = await api('/api/auth/signup', {
      method: 'POST', auth: false,
      body: { name: 'Gender Owner 2', email: email2, password: 'verify1234', workspaceName: 'Gender Shop 2' },
    });
    check('(e2) second workspace signup', signup2.status === 201 && !!signup2.data?.token, `status=${signup2.status}`);
    token = signup2.data?.token ?? '';
    workspaceId = signup2.data?.workspace?.id ?? '';
    const live2 = await api(`/api/workspaces/${workspaceId}/go-live`, { method: 'POST' });
    check('(e2) second workspace go-live', live2.status === 200 && live2.data?.workspace?.practice_mode === false, `status=${live2.status}`);
    const chMsg = await api('/api/channels', { method: 'POST', body: { platform: 'messenger', externalId: 'page-gender', displayName: 'Gender Page', token: 'tok-gender' } });
    check('messenger channel (stub token) → 201', chMsg.status === 201, `status=${chMsg.status}`);
    async function sendMessenger(senderId, mid, text) {
      return api('/api/webhooks/meta', {
        method: 'POST', auth: false,
        body: { object: 'page', entry: [{ id: 'page-gender', messaging: [{ sender: { id: senderId }, recipient: { id: 'page-gender' }, message: { mid, text } }] }] },
      });
    }
    async function waitCustomerName(convId, want, timeoutMs = 20000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const c = await customerOf(convId);
        if (c?.name === want) return c;
        await sleep(1000);
      }
      return customerOf(convId);
    }
    const convHitsBefore = stubHits.filter((h) => h.path.endsWith('/conversations')).length;
    const mm1 = await sendMessenger('psid-manual', `g-mid-1-${stamp}`, 'জিন্সের দাম কত?');
    check('messenger (e2) first message accepted', mm1.status === 200, `status=${mm1.status}`);
    const listMsg = await api('/api/inbox');
    const convManual = (listMsg.data?.conversations ?? []).find((c) => c.last_message === 'জিন্সের দাম কত?' && c.channel === 'messenger');
    const convManualId = convManual?.id ?? '';
    check('(e2) conversation created for the new sender', !!convManualId);
    const custStub = convManualId ? await waitCustomerName(convManualId, 'Stub Name') : null;
    check('(e2) profile refresh fills the name from Graph ("Stub Name")', custStub?.name === 'Stub Name', `name=${custStub?.name ?? ''}`);
    const manualPatch = await api(`/api/customers/${custStub?.id ?? ''}`, { method: 'PATCH', body: { name: 'Manual Name' } });
    check('(e2) PATCH name → "Manual Name" (200)', manualPatch.status === 200 && manualPatch.data?.customer?.name === 'Manual Name', `status=${manualPatch.status}`);
    const convHitsMid = stubHits.filter((h) => h.path.endsWith('/conversations')).length;
    const mm2 = await sendMessenger('psid-manual', `g-mid-2-${stamp}`, 'শার্টের দাম কত?');
    check('messenger (e2) second message accepted', mm2.status === 200, `status=${mm2.status}`);
    // Wait until the refresh actually ran again (a new /conversations
    // hit), so the check is not vacuous — then the name must still be
    // the manual one.
    let refreshed = false;
    const refreshStart = Date.now();
    while (Date.now() - refreshStart < 20000) {
      if (stubHits.filter((h) => h.path.endsWith('/conversations')).length > convHitsMid) { refreshed = true; break; }
      await sleep(1000);
    }
    check('(e2) the profile refresh ran again after the second message', refreshed, `hits=${stubHits.filter((h) => h.path.endsWith('/conversations')).length}`);
    await sleep(2000);
    const custAfterRefresh = convManualId ? await customerOf(convManualId) : null;
    check('(e2) the manual name SURVIVES the refresh', custAfterRefresh?.name === 'Manual Name', `name=${custAfterRefresh?.name ?? ''}`);
    check('(e2) the manual flag is still set', custAfterRefresh?.name_manually_set === true, `flag=${custAfterRefresh?.name_manually_set ?? ''}`);
    void convHitsBefore;
  } finally {
    run.stop();
    try { graphStub.close(); } catch { /* already closed */ }
    await sleep(2000);
    // Remove the throwaway PGlite dir — stale verifier DBs break Vercel
    // deploys ("files > 15000").
    try { fs.rmSync(path.join(ROOT, 'apps/api', dataDir), { recursive: true, force: true }); } catch { /* already gone */ }
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
