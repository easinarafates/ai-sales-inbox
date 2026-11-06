#!/usr/bin/env node
/**
 * Verification for multi-provider AI (Groq / OpenAI / Gemini / Claude).
 * Local, no Docker, no money spent.
 *
 * Phase A (AI_MOCK_PROVIDERS=openai,claude): the two providers without
 * keys answer with a canned deterministic reply, so dispatch, selection,
 * cost math and the Agent Desk test can be verified without a key or a
 * paid call. Phase B (no mocks): OpenAI/Claude report key_missing and
 * cannot be selected; Gemini (key present but Google-blocked) is
 * selectable with a warning, and an agent reply falls back to real Groq
 * (free) with fallback_from recorded in the ledger.
 *
 * Coverage: GET /api/ai-providers (4 providers, statuses, current
 * choice, recent usage), POST /api/ai-providers/select (valid / invalid
 * provider / invalid model / key-missing rejection / reset to system),
 * mock dispatch for OpenAI + Claude with exact provider_cost_paisa math
 * (gpt-6-luna 85, claude-sonnet-5-5 1708), Gemini → Groq fallback with
 * a real Groq reply (no demo label), Agent Desk test through the chosen
 * provider, settings page route files present, Groq stays 0 paisa.
 *
 * Run from the repo root:  node scripts/verify-ai-providers.mjs
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

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const got = await fn();
    if (got) return got;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for: ${label}`);
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
  const email = `aiprov+${stamp}@example.com`;
  const signup = await api('/api/auth/signup', {
    method: 'POST', auth: false,
    body: { name: 'AIProv Owner', email, password: 'verify1234', workspaceName: 'AIProv Shop' },
  });
  check('signup', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
  token = signup.data?.token ?? '';
  workspaceId = signup.data?.workspace?.id ?? '';
  const channel = await api('/api/channels', {
    method: 'POST',
    body: { platform: 'messenger', externalId: `page-aiprov-${stamp}`, displayName: 'AIProv Page' },
  });
  check('connect messenger channel', channel.status === 201, `status=${channel.status}`);
  const live = await api(`/api/workspaces/${workspaceId}/go-live`, { method: 'POST' });
  check('go-live (practice mode off)', live.status === 200 && live.data?.workspace?.practice_mode === false, `status=${live.status}`);
  const p1 = await api('/api/products', {
    method: 'POST',
    body: { name: 'শাড়ি', pricePaisa: 150000, size: 'M', stock: 5, description: 'সুতির শাড়ি — লাল' },
  });
  check('add product শাড়ি (৳1500)', p1.status === 201 && !!p1.data?.product?.id, `status=${p1.status}`);
  return p1.data?.product?.id ?? '';
}

/** Send one Messenger message and wait until an outgoing AI reply appears. */
async function sendAndWaitReply(api, stamp, n, text, timeoutMs = 30000) {
  const mid = `aiprov-mid-${stamp}-${n}`;
  const hook = await api('/api/webhooks/meta', {
    method: 'POST', auth: false,
    body: {
      object: 'page',
      entry: [{ id: `page-aiprov-${stamp}`, messaging: [{ sender: { id: `cust-aiprov-${stamp}` }, recipient: { id: `page-aiprov-${stamp}` }, message: { mid, text } }] }],
    },
  });
  check(`webhook accepts message ${n}`, hook.status === 200, `status=${hook.status}`);
  const detail = await waitFor(async () => {
    const list = await api('/api/inbox');
    const conv = list.data?.conversations?.[0];
    if (!conv) return null;
    const d = await api(`/api/inbox/${conv.id}`);
    const out = (d.data?.messages ?? []).filter((m) => m.direction === 'out');
    return out.length >= n ? d.data : null;
  }, timeoutMs, `AI reply ${n}`).catch((e) => {
    check(`AI reply ${n} arrives`, false, e.message);
    return null;
  });
  if (!detail) return null;
  const outs = (detail.messages ?? []).filter((m) => m.direction === 'out');
  return outs[outs.length - 1]?.body ?? '';
}

async function latestLedgerRow(api) {
  const res = await api('/api/ai-providers');
  return res.data?.recentUsage?.[0] ?? null;
}

async function main() {
  // ---------- Static checks: settings page route exists ----------
  const pagePath = path.join(ROOT, 'apps/web/app/ai-providers/page.tsx');
  const pageSrc = fs.existsSync(pagePath) ? fs.readFileSync(pagePath, 'utf8') : '';
  check('settings page file exists (app/ai-providers/page.tsx)', pageSrc.length > 0);
  check('settings page calls the providers API', pageSrc.includes('aiProvidersApi.get()'));
  const navSrc = fs.readFileSync(path.join(ROOT, 'apps/web/components/NavExtra.tsx'), 'utf8');
  check('sidebar nav has AI Providers entry', navSrc.includes('"/ai-providers"'));
  const dictSrc = fs.readFileSync(path.join(ROOT, 'apps/web/lib/i18n-dict.ts'), 'utf8');
  check('i18n dictionary has AI Providers keys', dictSrc.includes('"nav.ai-providers"'));

  // ================= Phase A: mocked OpenAI + Claude =================
  const stampA = Date.now();
  const portA = 4002;
  const apiA = makeApi(`http://localhost:${portA}`);
  const runA = startApi(portA, '.pglite-data-aiprov-a', { AI_MOCK_PROVIDERS: 'openai,claude' });
  process.on('exit', runA.stop);
  try {
    const up = await waitForHealth(`http://localhost:${portA}`);
    check('Phase A API starts (health)', up, up ? '' : runA.log().slice(-500));
    if (!up) return;
    await setupWorkspace(apiA, stampA);

    // --- GET /api/ai-providers ---
    const get1 = await apiA('/api/ai-providers');
    const providers = get1.data?.providers ?? [];
    check('GET ai-providers lists all 4 providers', get1.status === 200 && providers.length === 4, `status=${get1.status}, n=${providers.length}`);
    const byId = Object.fromEntries(providers.map((p) => [p.id, p]));
    check('groq is connected (real key)', byId.groq?.status === 'connected', `status=${byId.groq?.status}`);
    check('openai is connected via test mock', byId.openai?.status === 'connected' && byId.openai?.mock === true, `status=${byId.openai?.status}, mock=${byId.openai?.mock}`);
    check('claude is connected via test mock', byId.claude?.status === 'connected' && byId.claude?.mock === true, `status=${byId.claude?.status}, mock=${byId.claude?.mock}`);
    check('gemini is blocked (key present, Google billing)', byId.gemini?.status === 'blocked' && !!byId.gemini?.blockedReason, `status=${byId.gemini?.status}`);
    check('openai default model is gpt-6-luna', byId.openai?.defaultModel === 'gpt-6-luna', `model=${byId.openai?.defaultModel}`);
    check('claude default model is claude-sonnet-5-5', byId.claude?.defaultModel === 'claude-sonnet-5-5', `model=${byId.claude?.defaultModel}`);
    check('current choice is system default groq', get1.data?.current?.provider === 'groq' && get1.data?.current?.explicit === false, JSON.stringify(get1.data?.current));

    // --- POST select: validation ---
    const badProvider = await apiA('/api/ai-providers/select', { method: 'POST', body: { provider: 'bogus' } });
    check('select unknown provider → 400', badProvider.status === 400, `status=${badProvider.status}`);
    const badModel = await apiA('/api/ai-providers/select', { method: 'POST', body: { provider: 'openai', model: 'gpt-nope' } });
    check('select unknown model → 400', badModel.status === 400, `status=${badModel.status}`);

    // --- Select OpenAI (mock) → mock dispatch + exact cost math ---
    const selOpenai = await apiA('/api/ai-providers/select', { method: 'POST', body: { provider: 'openai' } });
    check('select openai (mock) → 200, current=openai/gpt-6-luna', selOpenai.status === 200 && selOpenai.data?.current?.provider === 'openai' && selOpenai.data?.current?.model === 'gpt-6-luna', `status=${selOpenai.status}, current=${JSON.stringify(selOpenai.data?.current)}`);
    const reply1 = await sendAndWaitReply(apiA, stampA, 1, 'শাড়ির দাম কত?');
    check('mock openai reply arrives', typeof reply1 === 'string' && reply1.length > 0, (reply1 ?? '').slice(0, 80));
    const row1 = await latestLedgerRow(apiA);
    check('ledger: mock openai row provider=openai, model=gpt-6-luna', row1?.provider === 'openai' && row1?.model === 'gpt-6-luna', JSON.stringify(row1));
    check('ledger: mock openai provider cost is exactly 85 paisa (gpt-6-luna math)', Number(row1?.provider_cost_paisa) === 85, `provider_cost_paisa=${row1?.provider_cost_paisa}`);
    check('ledger: mock openai wallet charge is 0 (included in plan)', Number(row1?.cost_paisa) === 0, `cost_paisa=${row1?.cost_paisa}`);

    // --- Select Claude Sonnet 5.5 (mock) → exact cost math ---
    const selClaude = await apiA('/api/ai-providers/select', { method: 'POST', body: { provider: 'claude', model: 'claude-sonnet-5-5' } });
    check('select claude sonnet-5-5 (mock) → 200', selClaude.status === 200 && selClaude.data?.current?.provider === 'claude' && selClaude.data?.current?.model === 'claude-sonnet-5-5', `status=${selClaude.status}`);
    const reply2 = await sendAndWaitReply(apiA, stampA, 2, 'শাড়ির দাম কত?');
    check('mock claude reply arrives', typeof reply2 === 'string' && reply2.length > 0, (reply2 ?? '').slice(0, 80));
    const row2 = await latestLedgerRow(apiA);
    check('ledger: mock claude row provider=claude, model=claude-sonnet-5-5', row2?.provider === 'claude' && row2?.model === 'claude-sonnet-5-5', JSON.stringify(row2));
    check('ledger: mock claude provider cost is exactly 1708 paisa (sonnet-5-5 math)', Number(row2?.provider_cost_paisa) === 1708, `provider_cost_paisa=${row2?.provider_cost_paisa}`);

    // --- Agent Desk test runs through the chosen (mock claude) provider ---
    const draft = await apiA('/api/agent-desk/instructions', { method: 'POST', body: { body: 'Always greet politely in Bengali.' } });
    check('agent-desk draft created', draft.status === 201, `status=${draft.status}`);
    const test = await apiA('/api/agent-desk/test', { method: 'POST', body: { question: 'ডেলিভারি চার্জ কত?' } });
    check('agent-desk test answers via chosen provider (claude)', test.status === 200 && test.data?.aiAvailable === true && test.data?.provider === 'claude', `status=${test.status}, provider=${test.data?.provider}`);

    // --- Reset to system default ---
    const reset = await apiA('/api/ai-providers/select', { method: 'POST', body: { provider: 'system' } });
    check('reset to system default → groq, explicit=false', reset.status === 200 && reset.data?.current?.provider === 'groq' && reset.data?.current?.explicit === false, `status=${reset.status}, current=${JSON.stringify(reset.data?.current)}`);
  } finally {
    runA.stop();
    await sleep(2000);
  }

  // ================= Phase B: no mocks — missing keys + Gemini fallback =================
  const stampB = Date.now();
  const portB = 4003;
  const apiB = makeApi(`http://localhost:${portB}`);
  const runB = startApi(portB, '.pglite-data-aiprov-b', {});
  process.on('exit', runB.stop);
  try {
    const up = await waitForHealth(`http://localhost:${portB}`);
    check('Phase B API starts (health)', up, up ? '' : runB.log().slice(-500));
    if (!up) return;
    await setupWorkspace(apiB, stampB);

    const get2 = await apiB('/api/ai-providers');
    const providers2 = get2.data?.providers ?? [];
    const byId2 = Object.fromEntries(providers2.map((p) => [p.id, p]));
    check('no mocks: openai reports key_missing', byId2.openai?.status === 'key_missing', `status=${byId2.openai?.status}`);
    check('no mocks: claude reports key_missing', byId2.claude?.status === 'key_missing', `status=${byId2.claude?.status}`);
    check('no mocks: groq is connected (real key)', byId2.groq?.status === 'connected', `status=${byId2.groq?.status}`);
    check('no mocks: gemini is blocked', byId2.gemini?.status === 'blocked', `status=${byId2.gemini?.status}`);

    const selNoKey = await apiB('/api/ai-providers/select', { method: 'POST', body: { provider: 'openai' } });
    check('select openai without key → 400 (not selectable as live)', selNoKey.status === 400, `status=${selNoKey.status}, error=${selNoKey.data?.error ?? ''}`);
    const selNoKey2 = await apiB('/api/ai-providers/select', { method: 'POST', body: { provider: 'claude' } });
    check('select claude without key → 400', selNoKey2.status === 400, `status=${selNoKey2.status}`);

    // Gemini is selectable (key present) but blocked — choosing it warns.
    const selGemini = await apiB('/api/ai-providers/select', { method: 'POST', body: { provider: 'gemini' } });
    check('select gemini (blocked) is allowed with a warning', selGemini.status === 200 && selGemini.data?.current?.provider === 'gemini' && !!selGemini.data?.warning, `status=${selGemini.status}, warning=${!!selGemini.data?.warning}`);

    // Agent reply: Gemini fails (real 404/403) → falls back to real Groq.
    // 60s wait: a stalled provider may burn the 20s timeout first.
    const replyB = await sendAndWaitReply(apiB, stampB, 1, 'শাড়ির দাম কত?', 60000);
    check('gemini→groq fallback reply arrives', typeof replyB === 'string' && replyB.length > 0, (replyB ?? '').slice(0, 80));
    check('fallback reply is a real Groq reply (no demo label)', typeof replyB === 'string' && !replyB.includes('[ডেমো AI'), (replyB ?? '').slice(0, 120));
    const rowB = await latestLedgerRow(apiB);
    check('ledger: fallback row provider=groq, fallback_from=gemini', rowB?.provider === 'groq' && rowB?.fallback_from === 'gemini', JSON.stringify(rowB));
    check('ledger: fallback row model is the groq model', rowB?.model === 'openai/gpt-oss-20b', `model=${rowB?.model}`);
    check('ledger: groq fallback provider cost is 0 paisa', Number(rowB?.provider_cost_paisa) === 0, `provider_cost_paisa=${rowB?.provider_cost_paisa}`);
    check('ledger: groq fallback wallet charge is 0 (included in plan)', Number(rowB?.cost_paisa) === 0, `cost_paisa=${rowB?.cost_paisa}`);

    // Groq direct selection still works without mocks.
    const selGroq = await apiB('/api/ai-providers/select', { method: 'POST', body: { provider: 'groq' } });
    check('select groq (real key) → 200', selGroq.status === 200 && selGroq.data?.current?.provider === 'groq', `status=${selGroq.status}`);
  } finally {
    runB.stop();
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
