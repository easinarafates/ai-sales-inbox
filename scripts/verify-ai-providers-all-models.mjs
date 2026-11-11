#!/usr/bin/env node
/**
 * Verification for ALL-MODELS AI Providers (user decision, 2026-11-11
 * 18:43): Gemini, OpenAI, Claude and Groq are ALL listed in the
 * owner-only AI Provider settings, each with an honest LIVE-PROBED
 * status. Gemini (gemini-3.5-flash-lite) stays the DEFAULT — "gemini
 * final" means default, not only model. gpt-5-nano is NOT listed
 * anywhere (deprecated, shuts down 11 Dec 2026).
 *
 * What is verified:
 * - Static: all four providers listed (Gemini first), no nano literal
 *   in any owned file, the probe path is real fetches (not hardcoded
 *   statuses) with a 5-minute cache, resolveWorkspaceAi honours the
 *   stored choice, the reply path throws the chosen provider's real
 *   error when the Groq backup also fails, the page shows every status
 *   badge + a Claude key input + a warning banner.
 * - Boot 1 (keys blanked, AI_MOCK_PROVIDERS=gemini): GET lists 4 with
 *   per-provider status (gemini connected/default, the rest
 *   key_missing); select gemini → no warning; select openai/claude/
 *   groq → 200 WITH a clear warning (saved, not refused); select
 *   nano → 400; reset → Gemini default; member → 403 on both
 *   endpoints; SHOP owner (workspace owner, NOT platform owner) →
 *   403 on both endpoints; check-key never echoes the pasted key.
 *   GATE (user decision 2026-11-11, main chat ~18:48 + side chat
 *   18:47 — DECIDED): AI Providers are PLATFORM-owner only
 *   (requireOwner). A shop owner IS the customer here and must never
 *   see which model answers them, so the boot user is promoted to
 *   platform owner via POST /api/owner/setup before the endpoint
 *   checks run. Do NOT "fix" this back to a workspace-owner gate.
 * - Boot 2 (REAL keys from apps/api/.env, no mocks, live probes):
 *   Gemini probes connected, OpenAI probes no_credits (key present,
 *   429 insufficient_quota — a failed call is not billed), Claude is
 *   key_missing (no key, never probed), Groq reports whatever its
 *   live probe says (connected or quota_exhausted — the quota resets,
 *   so the honest value is the probe's, not a hardcoded claim);
 *   select openai/gpt-5-mini → 200 with the no-credits warning and
 *   the system default stays Gemini.
 * - Boot 3 (AI_MOCK_PROVIDERS=openai, keys blanked): OpenAI probes
 *   connected — proving the status follows the PROBE outcome, not a
 *   hardcoded "no credits" string (requirement e).
 * - tsc --noEmit in apps/api must pass.
 *
 * Live probes cost at most a few tokens (Gemini ~7 in / ~0 out;
 * OpenAI/Groq failures cost nothing). No key value is ever printed.
 *
 * Run from the repo root:  node scripts/verify-ai-providers-all-models.mjs
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
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

/** Read apps/api/.env (presence only — values are never printed). */
function readEnvKeys() {
  const envPath = path.join(ROOT, 'apps/api/.env');
  const out = { GEMINI_API_KEY: '', OPENAI_API_KEY: '', GROQ_API_KEY: '', ANTHROPIC_API_KEY: '' };
  try {
    const text = fs.readFileSync(envPath, 'utf8');
    for (const line of text.split('\n')) {
      const i = line.indexOf('=');
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      if (k in out) out[k] = line.slice(i + 1).trim();
    }
  } catch { /* no .env — live boot will report it */ }
  return out;
}

function makeApi(base) {
  return async function api(path, { method = 'GET', body, authToken = null } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const t = authToken !== null ? authToken : token;
    if (t) headers.Authorization = `Bearer ${t}`;
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
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

async function waitForHealth(base, timeoutMs = 180000) {
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

/** Fail fast if another process already answers on this port (other
 * workers share this machine — a foreign API on our port would make
 * our signup/token hit THEIR data dir and 403 later). */
async function assertPortFree(port) {
  try {
    const res = await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) return false;
  } catch { /* nothing there */ }
  return true;
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
      JWT_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      META_APP_ID: 'dummy-app-id',
      META_APP_SECRET: 'dummy-meta-secret',
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

function runTsc() {
  return new Promise((resolve) => {
    const proc = spawn('npx', ['tsc', '--noEmit'], { cwd: path.join(ROOT, 'apps/api'), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { out += d.toString(); });
    proc.on('close', (code) => resolve({ code, out }));
  });
}

async function signupOwner(api, stamp, tag) {
  const signup = await api('/api/auth/signup', {
    method: 'POST', authToken: '',
    body: { name: `${tag} Owner`, email: `${tag.toLowerCase()}+${stamp}@example.com`, password: 'verify1234', workspaceName: `${tag} Shop` },
  });
  check(`${tag}: signup`, signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
  token = signup.data?.token ?? '';
  workspaceId = signup.data?.workspace?.id ?? '';
  if (signup.status !== 201) return false;
  // DECIDED GATE (user, 2026-11-11): AI Providers are PLATFORM-owner
  // only. Promote this boot user to platform owner via the first-owner
  // setup bootstrap (fresh PGlite dir, no owner exists yet, no
  // OWNER_SETUP_TOKEN set in the boot env) so the endpoint checks run
  // as the platform owner.
  const promote = await api('/api/owner/setup', {
    method: 'POST',
    body: { email: `${tag.toLowerCase()}+${stamp}@example.com` },
  });
  check(`${tag}: promote to platform owner`, promote.status === 200, `status=${promote.status}`);
  return promote.status === 200;
}

/** A plain shop (workspace) owner — NOT the platform owner. Must get 403. */
async function signupShopOwner(api, stamp, tag) {
  const signup = await api('/api/auth/signup', {
    method: 'POST', authToken: '',
    body: { name: `${tag} Shop Owner`, email: `shop+${stamp}@example.com`, password: 'verify1234', workspaceName: `${tag} Other Shop` },
  });
  check(`${tag}: shop-owner signup`, signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
  return signup.data?.token ?? '';
}

async function makeMember(api, stamp, tag) {
  const invite = await api('/api/team/invites', {
    method: 'POST',
    body: { email: `member+${stamp}@example.com`, role: 'member' },
  });
  check(`${tag}: owner creates member invite`, invite.status === 201 && !!invite.data?.invite?.token, `status=${invite.status}`);
  const inviteToken = invite.data?.invite?.token ?? '';
  const accept = await api('/api/auth/accept-invite', {
    method: 'POST', authToken: '',
    body: { token: inviteToken, name: 'Team Member', password: 'verify1234' },
  });
  check(`${tag}: member accepts invite`, accept.status === 201 && !!accept.data?.token, `status=${accept.status}`);
  return accept.data?.token ?? '';
}

function noNano(obj) {
  return !JSON.stringify(obj ?? {}).includes('gpt-5-nano');
}

async function main() {
  // ---------- Static checks ----------
  const providersSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/ai-agent/providers.ts'), 'utf8');
  const routesSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/ai-providers/routes.ts'), 'utf8');
  const pagePath = path.join(ROOT, 'apps/web/app/ai-providers/page.tsx');
  const pageSrc = fs.existsSync(pagePath) ? fs.readFileSync(pagePath, 'utf8') : '';

  check('static: display order is gemini, openai, claude, groq', providersSrc.includes("['gemini', 'openai', 'claude', 'groq']"));
  check('static: no gpt-5-nano literal in providers.ts', !providersSrc.includes('gpt-5-nano'));
  check('static: no gpt-5-nano literal in routes.ts', !routesSrc.includes('gpt-5-nano'));
  check('static: no gpt-5-nano literal in page.tsx', !pageSrc.includes('gpt-5-nano'));
  check('static: OpenAI model list is gpt-5-mini + gpt-5', providersSrc.includes("'gpt-5-mini', 'gpt-5'"));
  check('static: Gemini default is gemini-3.5-flash-lite', providersSrc.includes("provider: 'gemini', model: 'gemini-3.5-flash-lite'"));
  check('static: probe path is real fetches (gemini/openai/groq/claude)', providersSrc.includes('generativelanguage.googleapis.com') && providersSrc.includes('api.openai.com/v1/chat/completions') && providersSrc.includes('api.groq.com/openai/v1/chat/completions') && providersSrc.includes('api.anthropic.com/v1/messages'));
  check('static: probe cache is 5 minutes', providersSrc.includes('PROVIDER_PROBE_CACHE_TTL_MS = 5 * 60 * 1000'));
  check('static: 429 insufficient_quota maps to no_credits', providersSrc.includes('insufficient_quota') && providersSrc.includes("'no_credits'"));
  check('static: resolveWorkspaceAi honours the stored choice', providersSrc.includes('SELECT ai_provider, ai_model FROM workspaces') && providersSrc.includes('providerModels(p).includes(m)'));
  check('static: chosen-provider error is thrown when Groq also fails', providersSrc.includes('backup Groq also failed'));
  check('static: no silent fallback TO gemini (fallback target is groq only)', providersSrc.includes("callProvider('groq', prompt)") && !/fallback.*gemini/i.test(providersSrc.split('callAiForWorkspace')[1]?.split('callAiForWorkspaceSplit')[0] ?? ''));
  check('static: routes GET uses live-probed getAllProviderInfo + refresh', routesSrc.includes('getAllProviderInfo({ forceRefresh })') && routesSrc.includes("refresh === '1'"));
  check('static: routes select does NOT 400 on a missing key (saves + warns)', !routesSrc.includes('is not connected') && routesSrc.includes('providerWarningBn(info)'));
  check('static: check-key endpoint exists and never stores the key', routesSrc.includes('/check-key') && routesSrc.includes('NEVER stored'));
  check('static: page shows all four status badges', pageSrc.includes('ক্রেডিট নেই') && pageSrc.includes('ফ্রি লিমিট শেষ') && pageSrc.includes('কী দেওয়া হয়নি') && pageSrc.includes('চালু আছে • ডিফল্ট'));
  check('static: page has a prominent warning when the current model cannot reply', pageSrc.includes('currentBroken') && pageSrc.includes('⚠️'));
  check('static: page has a Claude key input + check button (no nagging copy)', pageSrc.includes('/check-key') && pageSrc.includes('sk-ant-') && pageSrc.includes('সেভ হয় না'));
  check('static: page has a refresh-status button', pageSrc.includes('refresh=1') && pageSrc.includes('স্ট্যাটাস আবার যাচাই করুন'));
  check('static: page choose button is disabled only while saving or already current (never for a non-working provider)', pageSrc.includes('disabled={saving === p.id || (isCurrent && selectedModel === data.current.model)}'));

  // ================= Boot 1: blanked keys, mocked Gemini =================
  const stamp1 = Date.now();
  const port1 = 4123;
  const dataDir1 = '.pglite-data-aiprov-all-a';
  check('boot 1: port 4123 is free (no foreign API answering)', await assertPortFree(port1));
  const run1 = startApi(port1, dataDir1, {
    AI_MOCK_PROVIDERS: 'gemini',
    GEMINI_API_KEY: '', GROQ_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '',
  });
  process.on('exit', run1.stop);
  let memberToken = '';
  try {
    const up = await waitForHealth(`http://localhost:${port1}`);
    check('boot 1: API starts', up, up ? '' : run1.log().slice(-500));
    if (up) {
      const api = makeApi(`http://localhost:${port1}`);
      if (!(await signupOwner(api, stamp1, 'Boot1'))) return;
      memberToken = await makeMember(api, stamp1, 'Boot1');

      const get1 = await api('/api/ai-providers?refresh=1');
      check('boot 1: GET lists all 4 providers', get1.status === 200 && Array.isArray(get1.data?.providers) && get1.data.providers.length === 4, `status=${get1.status} count=${get1.data?.providers?.length ?? '?'}`);
      const byId = {};
      for (const p of get1.data?.providers ?? []) byId[p.id] = p;
      check('boot 1: order is gemini, openai, claude, groq', JSON.stringify((get1.data?.providers ?? []).map((p) => p.id)) === JSON.stringify(['gemini', 'openai', 'claude', 'groq']));
      check('boot 1: defaultProvider is gemini', get1.data?.defaultProvider === 'gemini', `default=${get1.data?.defaultProvider ?? '?'}`);
      const g = byId.gemini ?? {};
      check('boot 1: Gemini connected + default + can reply', g.status === 'connected' && g.isDefault === true && g.canReply === true, JSON.stringify({ s: g.status, d: g.isDefault, c: g.canReply, probe: g.probe }));
      check('boot 1: Gemini models = [gemini-3.5-flash-lite]', JSON.stringify(g.models) === JSON.stringify(['gemini-3.5-flash-lite']));
      const o = byId.openai ?? {};
      check('boot 1: OpenAI key_missing + cannot reply (no key in this boot)', o.status === 'key_missing' && o.keyPresent === false && o.canReply === false, JSON.stringify({ s: o.status, k: o.keyPresent, c: o.canReply }));
      check('boot 1: OpenAI models are gpt-5-mini + gpt-5', JSON.stringify(o.models) === JSON.stringify(['gpt-5-mini', 'gpt-5']));
      const c = byId.claude ?? {};
      check('boot 1: Claude key_missing + cannot reply', c.status === 'key_missing' && c.keyPresent === false && c.canReply === false, JSON.stringify({ s: c.status, k: c.keyPresent }));
      const q = byId.groq ?? {};
      check('boot 1: Groq key_missing + cannot reply (no key in this boot)', q.status === 'key_missing' && q.keyPresent === false && q.canReply === false, JSON.stringify({ s: q.status, k: q.keyPresent }));
      check('boot 1: no gpt-5-nano anywhere in the GET response', noNano(get1.data), JSON.stringify(get1.data?.providers ?? []).slice(0, 200));
      check('boot 1: current is the Gemini default, not explicit', get1.data?.current?.provider === 'gemini' && get1.data?.current?.model === 'gemini-3.5-flash-lite' && get1.data?.current?.explicit === false, JSON.stringify(get1.data?.current));

      // Member (non-owner) is refused on BOTH endpoints.
      const mGet = await api('/api/ai-providers', { authToken: memberToken });
      check('boot 1: member GET → 403', mGet.status === 403, `status=${mGet.status}`);
      const mSel = await api('/api/ai-providers/select', { method: 'POST', authToken: memberToken, body: { provider: 'gemini' } });
      check('boot 1: member POST select → 403', mSel.status === 403, `status=${mSel.status}`);

      // Shop owner (workspace owner, NOT platform owner) is refused too
      // — DECIDED gate: a shop owner IS the customer here.
      const shopToken = await signupShopOwner(api, stamp1, 'Boot1');
      const sGet = await api('/api/ai-providers', { authToken: shopToken });
      check('boot 1: shop-owner GET → 403', sGet.status === 403, `status=${sGet.status}`);
      const sSel = await api('/api/ai-providers/select', { method: 'POST', authToken: shopToken, body: { provider: 'gemini' } });
      check('boot 1: shop-owner POST select → 403', sSel.status === 403, `status=${sSel.status}`);

      // (b) select gemini: succeeds, no warning.
      const selG = await api('/api/ai-providers/select', { method: 'POST', body: { provider: 'gemini' } });
      check('boot 1: select gemini → 200, no warning', selG.status === 200 && !selG.data?.warning, `status=${selG.status} warning=${selG.data?.warning ?? 'none'}`);

      // (c) select openai/gpt-5-mini: SAVED (200) but WITH a clear warning.
      const selO = await api('/api/ai-providers/select', { method: 'POST', body: { provider: 'openai', model: 'gpt-5-mini' } });
      check('boot 1: select openai/gpt-5-mini → 200 WITH warning', selO.status === 200 && typeof selO.data?.warning === 'string' && selO.data.warning.includes('উত্তর দিতে পারবে না'), `status=${selO.status} warning=${selO.data?.warning ?? 'none'}`);
      check('boot 1: select openai reports canReply false', selO.data?.canReply === false, `canReply=${selO.data?.canReply}`);
      const afterO = await api('/api/ai-providers');
      check('boot 1: current is now openai/gpt-5-mini (explicit)', afterO.data?.current?.provider === 'openai' && afterO.data?.current?.model === 'gpt-5-mini' && afterO.data?.current?.explicit === true, JSON.stringify(afterO.data?.current));
      check('boot 1: selecting openai does NOT move the default (gemini still isDefault)', (afterO.data?.providers ?? []).find((p) => p.id === 'gemini')?.isDefault === true, '');

      const selC = await api('/api/ai-providers/select', { method: 'POST', body: { provider: 'claude' } });
      check('boot 1: select claude → 200 WITH warning (no key)', selC.status === 200 && typeof selC.data?.warning === 'string' && selC.data.warning.includes('উত্তর দিতে পারবে না'), `status=${selC.status} warning=${selC.data?.warning ?? 'none'}`);
      const selQ = await api('/api/ai-providers/select', { method: 'POST', body: { provider: 'groq' } });
      check('boot 1: select groq → 200 WITH warning (no key in this boot)', selQ.status === 200 && typeof selQ.data?.warning === 'string', `status=${selQ.status} warning=${selQ.data?.warning ?? 'none'}`);

      const selNano = await api('/api/ai-providers/select', { method: 'POST', body: { provider: 'openai', model: 'gpt-5-nano' } });
      check('boot 1: select gpt-5-nano → 400 (deprecated, not offered)', selNano.status === 400, `status=${selNano.status}`);
      const selBogus = await api('/api/ai-providers/select', { method: 'POST', body: { provider: 'nope' } });
      check('boot 1: select unknown provider → 400', selBogus.status === 400, `status=${selBogus.status}`);

      const reset = await api('/api/ai-providers/select', { method: 'POST', body: { provider: 'system' } });
      check('boot 1: reset to system → Gemini default, not explicit', reset.status === 200 && reset.data?.current?.provider === 'gemini' && reset.data?.current?.explicit === false, `status=${reset.status} current=${JSON.stringify(reset.data?.current)}`);

      // Key check: a dummy Claude key must fail honestly and never be echoed back.
      const dummyKey = 'sk-ant-test-dummy-key-0000';
      const kc = await api('/api/ai-providers/check-key', { method: 'POST', body: { provider: 'claude', apiKey: dummyKey } });
      check('boot 1: check-key with a dummy key → keyWorks false', kc.status === 200 && kc.data?.keyWorks === false, `status=${kc.status} keyWorks=${kc.data?.keyWorks}`);
      check('boot 1: check-key never echoes the pasted key', kc.status === 200 && !JSON.stringify(kc.data ?? {}).includes(dummyKey));
      const kcEmpty = await api('/api/ai-providers/check-key', { method: 'POST', body: { provider: 'claude', apiKey: '' } });
      check('boot 1: check-key with an empty key → 400', kcEmpty.status === 400, `status=${kcEmpty.status}`);
    }
  } finally {
    run1.stop();
    await sleep(2000);
  }

  // ================= Boot 2: REAL keys, live probes, no mocks =================
  const liveKeys = readEnvKeys();
  const stamp2 = Date.now();
  const port2 = 4124;
  const dataDir2 = '.pglite-data-aiprov-all-b';
  check('boot 2: port 4124 is free (no foreign API answering)', await assertPortFree(port2));
  const run2 = startApi(port2, dataDir2, {
    AI_MOCK_PROVIDERS: '',
    GEMINI_API_KEY: liveKeys.GEMINI_API_KEY,
    OPENAI_API_KEY: liveKeys.OPENAI_API_KEY,
    GROQ_API_KEY: liveKeys.GROQ_API_KEY,
    ANTHROPIC_API_KEY: liveKeys.ANTHROPIC_API_KEY,
  });
  process.on('exit', run2.stop);
  try {
    const up = await waitForHealth(`http://localhost:${port2}`);
    check('boot 2: API starts', up, up ? '' : run2.log().slice(-500));
    if (up) {
      const api = makeApi(`http://localhost:${port2}`);
      if (!(await signupOwner(api, stamp2, 'Boot2'))) return;
      check('boot 2: real Gemini key present in .env', liveKeys.GEMINI_API_KEY.length > 0);
      check('boot 2: real OpenAI key present in .env', liveKeys.OPENAI_API_KEY.length > 0);
      check('boot 2: real Groq key present in .env', liveKeys.GROQ_API_KEY.length > 0);
      check('boot 2: no Anthropic key in .env (Claude stays key_missing)', liveKeys.ANTHROPIC_API_KEY.length === 0);

      const get2 = await api('/api/ai-providers?refresh=1');
      check('boot 2: GET ?refresh=1 → 200 with 4 providers', get2.status === 200 && (get2.data?.providers ?? []).length === 4, `status=${get2.status}`);
      const byId = {};
      for (const p of get2.data?.providers ?? []) byId[p.id] = p;
      const g = byId.gemini ?? {};
      check('boot 2: LIVE probe — Gemini connected + can reply', g.status === 'connected' && g.canReply === true && g.probe === 'live', JSON.stringify({ s: g.status, c: g.canReply, probe: g.probe }));
      const o = byId.openai ?? {};
      check('boot 2: LIVE probe — OpenAI no_credits (key present, no credits)', o.status === 'no_credits' && o.keyPresent === true && o.canReply === false, JSON.stringify({ s: o.status, k: o.keyPresent, c: o.canReply, detail: o.statusDetail }));
      const c = byId.claude ?? {};
      check('boot 2: Claude key_missing (no key — never probed)', c.status === 'key_missing' && c.keyPresent === false && c.canReply === false, JSON.stringify({ s: c.status, k: c.keyPresent }));
      const q = byId.groq ?? {};
      // Groq's free quota resets daily, so the honest value is whatever
      // the live probe just said — connected or quota_exhausted — as
      // long as it came from a live probe with a checked time.
      check('boot 2: LIVE probe — Groq status is probe-derived (connected or quota_exhausted)', (q.status === 'connected' || q.status === 'quota_exhausted') && q.probe === 'live' && !!q.checkedAt, JSON.stringify({ s: q.status, probe: q.probe, checkedAt: q.checkedAt }));
      check('boot 2: no gpt-5-nano anywhere in the live GET response', noNano(get2.data));

      // (c) live: select openai/gpt-5-mini → saved WITH the no-credits warning.
      const selO = await api('/api/ai-providers/select', { method: 'POST', body: { provider: 'openai', model: 'gpt-5-mini' } });
      check('boot 2: select openai/gpt-5-mini → 200 WITH no-credits warning', selO.status === 200 && typeof selO.data?.warning === 'string' && selO.data.warning.includes('ক্রেডিট নেই'), `status=${selO.status} warning=${selO.data?.warning ?? 'none'}`);
      check('boot 2: select openai reports canReply false', selO.data?.canReply === false, `canReply=${selO.data?.canReply}`);
      const afterO = await api('/api/ai-providers');
      check('boot 2: default is STILL Gemini after selecting OpenAI', (afterO.data?.providers ?? []).find((p) => p.id === 'gemini')?.isDefault === true && afterO.data?.defaultProvider === 'gemini', '');
      const reset = await api('/api/ai-providers/select', { method: 'POST', body: { provider: 'system' } });
      check('boot 2: reset to system → Gemini default', reset.status === 200 && reset.data?.current?.provider === 'gemini', `status=${reset.status}`);
    }
  } finally {
    run2.stop();
    await sleep(2000);
  }

  // ================= Boot 3: mocked OpenAI proves status is probe-derived =================
  const stamp3 = Date.now();
  const port3 = 4125;
  const dataDir3 = '.pglite-data-aiprov-all-c';
  check('boot 3: port 4125 is free (no foreign API answering)', await assertPortFree(port3));
  const run3 = startApi(port3, dataDir3, {
    AI_MOCK_PROVIDERS: 'openai',
    GEMINI_API_KEY: '', GROQ_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '',
  });
  process.on('exit', run3.stop);
  try {
    const up = await waitForHealth(`http://localhost:${port3}`);
    check('boot 3: API starts', up, up ? '' : run3.log().slice(-500));
    if (up) {
      const api = makeApi(`http://localhost:${port3}`);
      if (!(await signupOwner(api, stamp3, 'Boot3'))) return;
      const get3 = await api('/api/ai-providers?refresh=1');
      const o = (get3.data?.providers ?? []).find((p) => p.id === 'openai') ?? {};
      check('boot 3 (e): mocked OpenAI probes CONNECTED — status follows the probe, not a hardcoded claim', o.status === 'connected' && o.canReply === true && o.probe === 'mock', JSON.stringify({ s: o.status, c: o.canReply, probe: o.probe }));
      const selO = await api('/api/ai-providers/select', { method: 'POST', body: { provider: 'openai', model: 'gpt-5-mini' } });
      check('boot 3: select mocked openai → 200 with NO warning', selO.status === 200 && !selO.data?.warning && selO.data?.canReply === true, `status=${selO.status} warning=${selO.data?.warning ?? 'none'}`);
    }
  } finally {
    run3.stop();
    await sleep(2000);
    for (const d of [dataDir1, dataDir2, dataDir3]) {
      try { fs.rmSync(path.join(ROOT, 'apps/api', d), { recursive: true, force: true }); } catch { /* already gone */ }
    }
  }

  // ---------- tsc ----------
  const tsc = await runTsc();
  check('tsc --noEmit passes in apps/api', tsc.code === 0, tsc.code === 0 ? '' : tsc.out.slice(-500));
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
