#!/usr/bin/env node
/**
 * Verification for FEATURE 1 — off-topic quality fix (2026-11-11).
 *
 * The problem: the owner pasted the Bangladesh national anthem lyrics
 * ("আমার সোনার বাংলা, আমি তোমায় ভালোবাসি...") and the AI replied
 * "স্যার, আমি বুঝতে পারছি" while understanding NOTHING. The lyrics
 * contain no trigger phrase, so detectOffTopic() missed them, and the
 * AI then faked understanding.
 *
 * The fix:
 * - apps/api/src/inbox/escalation.ts: detectOffTopic() gains (a) a
 *   famous Bengali song/poem opening-lines list (anthem first) and
 *   (b) a conservative "long non-shop Bengali text" layer (repeated
 *   refrain / 3+ lines / 200+ chars, all AFTER the shop-scope guard,
 *   so shop questions and greetings can never match). New
 *   offTopicReply(gender) — one deterministic, gender-aware graceful
 *   reply ("দুঃখিত স্যার, এটা বুঝতে পারিনি — মনে হচ্ছে ভুল করে
 *   মেসেজটি পাঠিয়েছেন..."), never "আমি বুঝতে পারছি". No AI call,
 *   no credit burned.
 * - agent.ts: the off-topic block now sends that ONE reply via
 *   sendChannelMessage() (saved + live-delivered like any reply),
 *   then escalates to waiting/off_topic as before. It returns
 *   replied:true (a reply WAS sent) with the same reason string.
 * - prompts.ts: new hard rule 5ক — the AI must NEVER say "আমি বুঝতে
 *   পারছি" / "বুঝেছি" / "বুঝতে পেরেছি" when it does not understand;
 *   it must say "দুঃখিত, বুঝতে পারছি না" (the canonical phrase
 *   CANT_ANSWER_RE already matches) and ask a clarifying question.
 *
 * Checks:
 * - Static: detection layers, offTopicReply, agent hook order (reply
 *   before escalate, before any AI call), prompt rule.
 * - Boot 1 (local API on PGlite, webchat webhook end-to-end — a
 *   SIMULATED test message, labelled as such): anthem lyrics → ONE
 *   graceful reply saved ("বুঝতে পারিনি" / "ভুল করে", never "আমি
 *   বুঝতে পারছি"), waiting/off_topic, no ledger charge; a greeting
 *   → a reply, NOT off_topic; a normal price question → open + real
 *   reply (৳500).
 * - Driver (processBatch directly, same PGlite dir, API stopped;
 *   generated into os.tmpdir() at runtime so the repo only gains
 *   this verifier file): extended unit matrix (existing 33 cases +
 *   new anthem / poem / long-text / guard cases), anthem via
 *   processBatch for male / female / unknown gender (right
 *   salutation, no fake-understanding line, ledger 0), normal
 *   question, angry still escalates with NO reply, double off-topic
 *   guard, boot-1 anthem conversation ledger 0.
 *
 * NOTE: this intentionally supersedes two assertions of the old
 * scripts/verify-off-topic-escalation.mjs ("NO AI reply was sent" /
 * outMessages === 0 for off-topic) — the new behaviour SENDS one
 * graceful deterministic reply before escalating. That old verifier
 * will fail those two assertions until it is updated; everything
 * else in it should still pass.
 *
 * Run from the repo root:  node scripts/verify-off-topic-quality.mjs
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const results = [];
let token = '';
/** Dummy webchat secret for the local boots (must match the boot env). */
const WEBCHAT_SECRET = 'offtopic-quality-test-secret';
/** First verse of the national anthem — the exact message that exposed the bug. */
const ANTHEM = 'আমার সোনার বাংলা, আমি তোমায় ভালোবাসি। চিরদিন তোমার আকাশ, তোমার বাতাস, আমার প্রাণে বাজায় বাঁশি॥ ও মা, ফাগুনে তোর আমের বনে ঘ্রাণে পাগল করে, মরি হায়, হায় রে— ও মা, অঘ্রানে তোর ভরা ক্ষেতে আমি কী দেখেছি মধুর হাসি॥';

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
      JWT_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      WEBCHAT_SECRET,
      // Blank the provider keys so the test runs in deterministic demo
      // mode (no live AI calls).
      GEMINI_API_KEY: '',
      GROQ_API_KEY: '',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
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

// ---------------------------------------------------------------------------
// Driver source (processBatch + unit matrix, direct DB). Generated into
// os.tmpdir() at runtime and run with tsx, so the repo only gains this
// verifier file. The driver uses NO template literals (only string
// concatenation) so it survives being embedded in this file's template
// literal; ${ROOT} below is the only interpolation, for the imports.
// ---------------------------------------------------------------------------
const DRIVER_TS = `// Driver for verify-off-topic-quality.mjs — generated at runtime.
// Tests detectOffTopic + processBatch directly against the same PGlite
// dir the verifier's API boot uses. Run AFTER the API boot stops
// (PGlite is single-process), with:
//   npx tsx <driver> <workspaceId> <jeansId> [bootAnthemConvId]
// Prints one DRIVER_RESULT JSON line. No secrets are printed.
import { pool } from '${ROOT}/apps/api/src/db/pool';
import { processBatch } from '${ROOT}/apps/api/src/ai-agent/agent';
import { detectOffTopic, offTopicReply } from '${ROOT}/apps/api/src/inbox/escalation';

const args = process.argv.slice(2);
const workspaceId = args[0];
const jeansId = args[1];
const bootAnthemConvId = args[2] || '';
if (!workspaceId || !jeansId) {
  console.error('usage: off-topic-quality-driver.ts <workspaceId> <jeansId> [bootAnthemConvId]');
  process.exit(2);
}

const NL = String.fromCharCode(10);
const ANTHEM = 'আমার সোনার বাংলা, আমি তোমায় ভালোবাসি। চিরদিন তোমার আকাশ, তোমার বাতাস, আমার প্রাণে বাজায় বাঁশি॥ ও মা, ফাগুনে তোর আমের বনে ঘ্রাণে পাগল করে, মরি হায়, হায় রে— ও মা, অঘ্রানে তোর ভরা ক্ষেতে আমি কী দেখেছি মধুর হাসি॥';
const TAGORE = 'যদি তোর ডাক শুনে কেউ না আসে তবে একলা চলো রে। একলা চলো, একলা চলো, একলা চলো রে। একলা চলো রে॥';
const POEM_LINES = ['বৃষ্টি পড়ে টাপুর টুপুর,', 'নদী ভরা জলে,', 'মাঠের সবুজ ঘাসের উপর', 'শিশির পড়ে ভোরে।', 'পাখিরা ডাকে আকাশে,', 'মেঘ ভেসে যায় দূরে।', 'ফুলের গন্ধে ভরে যায়', 'সারা গ্রামের বাতাস।'].join(NL);
const STORY_LONG = 'ভোরের আলো ফুটতেই গ্রামের মানুষ জেগে ওঠে। পাখির ডাক, নদীর কলকল শব্দ আর সবুজ মাঠের হাওয়া মিলে এক অপূর্ব সকাল তৈরি হয়। ছোট ছেলেমেয়েরা মাঠে খেলতে যায়, বুড়োরা গাছের নিচে বসে গল্প করে। দুপুরে রোদ উঠলে সবাই ছায়ায় আশ্রয় নেয়, আর সন্ধ্যা নামলে আকাশে তারা জ্বলে ওঠে। এমন শান্ত জীবন শহরে আর কোথাও পাওয়া যায় না।';
const REFRAIN = ['নদীর ধারে বসে আছি', 'নদীর ধারে বসে আছি', 'নদীর ধারে বসে আছি', 'নদীর ধারে বসে আছি', 'নদীর ধারে বসে আছি', 'নদীর ধারে বসে আছি'].join(NL);
const ORDER_LONG = 'আসসালামু আলাইকুম, আমি একটা জিন্সের প্যান্ট আর দুইটা টি-শার্ট অর্ডার করতে চাই। আমার ঠিকানা: বাড়ি ১২, রোড ৫, ধানমন্ডি, ঢাকা ১২০৫। ফোন নম্বর ০১৯১২৩৪৫৬৭৮। দাম কত হবে আর ঢাকার ভেতরে ডেলিভারি চার্জ কত টাকা জানাবেন, আর ক্যাশ অন ডেলিভারি আছে কি না বলবেন।';
const COMPLAINT_LONG = 'আমি গত সপ্তাহে আপনাদের কাছ থেকে একটা জিন্স কিনেছিলাম, দুই দিন পরেই সেলাই খুলে গেছে। আমি খুব হতাশ হয়েছি, এত তাড়াতাড়ি ছিঁড়ে যাবে ভাবতে পারিনি। আপনারা কি এটা বদলে দেবেন, নাকি আমি আবার আসব?';

const out = {};

async function seedConversation(customerName, gender, senderId, channelId) {
  const c = await pool.query(
    'INSERT INTO customers (workspace_id, name, gender, channel_identities) VALUES ($1, $2, $3, $4::jsonb) RETURNING id',
    [workspaceId, customerName, gender, JSON.stringify([{ platform: 'webchat', senderId: senderId }])],
  );
  const customerId = c.rows[0].id;
  const cv = await pool.query(
    "INSERT INTO conversations (workspace_id, customer_id, channel_id, status, mode) VALUES ($1, $2, $3, 'open', 'ai') RETURNING id",
    [workspaceId, customerId, channelId],
  );
  return { customerId: customerId, conversationId: cv.rows[0].id };
}

async function convState(conversationId) {
  const r = await pool.query(
    'SELECT status, mode, escalation_reason, escalated_at FROM conversations WHERE id = $1',
    [conversationId],
  );
  return r.rows[0] || {};
}

async function outCount(conversationId) {
  const r = await pool.query(
    "SELECT COUNT(*)::int AS n FROM messages WHERE workspace_id = $1 AND conversation_id = $2 AND direction = 'out'",
    [workspaceId, conversationId],
  );
  return Number(r.rows[0].n);
}

async function outBodies(conversationId) {
  const r = await pool.query(
    "SELECT body FROM messages WHERE workspace_id = $1 AND conversation_id = $2 AND direction = 'out' ORDER BY created_at ASC",
    [workspaceId, conversationId],
  );
  return r.rows.map((row) => row.body || '');
}

async function ledgerCount(conversationId) {
  const r = await pool.query(
    'SELECT COUNT(*)::int AS n FROM ai_usage_ledger WHERE workspace_id = $1 AND conversation_id = $2',
    [workspaceId, conversationId],
  );
  return Number(r.rows[0].n);
}

async function main() {
  // --- Unit checks: the off-topic list stays conservative, and the new
  // layers catch lyrics / poems / long non-shop Bengali text. ---
  // true = off-topic; false = in scope or greeting.
  const offTopicCases = [
    // Off-topic: personal questions about the AI (unchanged).
    ['তুমি ছেলে নাকি মেয়ে?', true],
    ['তোমার নাম কি?', true],
    ['তোমার বয়স কত?', true],
    ['তুমি কি মানুষ নাকি রোবট?', true],
    ['tumi chele naki meye?', true],
    ['tomar nam ki?', true],
    ['Are you a boy or a girl?', true],
    ['What is your name?', true],
    ['How old are you?', true],
    // Off-topic: unrelated topics (unchanged).
    ['আজকের আবহাওয়া কেমন?', true],
    ['ক্রিকেট খেলার খবর কি?', true],
    ['একটা কৌতুক শোনাও', true],
    ['গান শোনাও তো', true],
    ['সিনেমা দেখতে যাবো?', true],
    ['বাংলাদেশের রাজধানী কি?', true],
    ['Tell me a joke', true],
    ['What is the weather today?', true],
    // NEW: song / poem openings + long non-shop Bengali text.
    ['আমার সোনার বাংলা', true],
    [ANTHEM, true],
    [TAGORE, true],
    [POEM_LINES, true],
    [STORY_LONG, true],
    [REFRAIN, true],
    // In scope: shop questions must NEVER match (unchanged).
    ['জিন্সের দাম কত?', false],
    ['ঢাকার বাইরে ডেলিভারি চার্জ কত?', false],
    ['দোকান কোথায়?', false],
    ['অর্ডার কবে আসবে?', false],
    ['ক্যাশ অন ডেলিভারি আছে?', false],
    ['টি-শার্ট আছে?', false],
    ['আমার নাম রহিম, অর্ডার করতে চাই', false],
    ['বিয়ের জন্য শার্ট লাগবে', false],
    ['ছেলেদের টি-শার্ট আছে?', false],
    ['মেয়েদের শার্ট আছে?', false],
    ['আমার বাড়ি ঢাকা, ডেলিভারি দিবেন?', false],
    ['বৃষ্টির জন্য ডেলিভারি দেরি হবে?', false],
    ['I want a refund please', false],
    ['My order is late', false],
    ['will the weather delay my delivery?', false],
    // NEW: long shop messages must NEVER match (guard beats the layers).
    [ORDER_LONG, false],
    [COMPLAINT_LONG, false],
    ['আমার সোনার বাংলা শার্টটা কত?', false],
    ['আমার সোনার বাংলা গানটা শুনতে চাই, শার্টের দাম কত?', false],
    // Greetings are NOT off-topic (unchanged).
    ['আসসালামু আলাইকুম', false],
    ['হাই', false],
    ['hello', false],
  ];
  out.offTopicUnit = offTopicCases.map(function (c) {
    return { text: c[0].slice(0, 40), expected: c[1], got: detectOffTopic(c[0]), ok: detectOffTopic(c[0]) === c[1] };
  });
  out.offTopicUnitAllOk = out.offTopicUnit.every(function (c) { return c.ok; });

  // --- offTopicReply(): gender-aware, honest, never fake-understanding. ---
  out.offTopicReplyMale = offTopicReply('male');
  out.offTopicReplyFemale = offTopicReply('female');
  out.offTopicReplyUnknown = offTopicReply('unknown');
  out.offTopicReplyOk =
    out.offTopicReplyMale.indexOf('স্যার') >= 0 &&
    out.offTopicReplyFemale.indexOf('ম্যাডাম') >= 0 &&
    out.offTopicReplyUnknown.indexOf('আপনি') >= 0 &&
    out.offTopicReplyUnknown.indexOf('স্যার') < 0 &&
    out.offTopicReplyUnknown.indexOf('ম্যাডাম') < 0 &&
    [out.offTopicReplyMale, out.offTopicReplyFemale, out.offTopicReplyUnknown].every(function (b) {
      return b.indexOf('বুঝতে পারিনি') >= 0 && b.indexOf('আমি বুঝতে পারছি') < 0 && b.indexOf('ডেমো') < 0;
    });

  // --- Reuse the boot's webchat channel so the reply is delivered as
  // 'local' (saved + marked sent, like a real webchat reply). ---
  const ch = await pool.query(
    "SELECT id FROM channels WHERE workspace_id = $1 AND platform = 'webchat' ORDER BY created_at ASC LIMIT 1",
    [workspaceId],
  );
  const webchatChannelId = ch.rows[0] ? ch.rows[0].id : null;
  out.webchatChannelId = webchatChannelId;

  // --- (A) Anthem, male customer → ONE graceful reply, waiting/off_topic, no charge ---
  const a1 = await seedConversation('Rahim Uddin', 'male', 'wc-q-a1', webchatChannelId);
  const r1 = await processBatch(workspaceId, a1.conversationId, [{ body: ANTHEM }]);
  out.anthemMale = {
    result: { replied: r1.replied, reason: r1.reason },
    state: await convState(a1.conversationId),
    outMessages: await outCount(a1.conversationId),
    outBodies: await outBodies(a1.conversationId),
    ledger: await ledgerCount(a1.conversationId),
    conversationId: a1.conversationId,
  };

  // --- (B) Anthem, female customer → 'ম্যাডাম', never 'স্যার' ---
  const a2 = await seedConversation('Fatema Begum', 'female', 'wc-q-a2', webchatChannelId);
  const r2 = await processBatch(workspaceId, a2.conversationId, [{ body: ANTHEM }]);
  out.anthemFemale = {
    result: { replied: r2.replied, reason: r2.reason },
    state: await convState(a2.conversationId),
    outMessages: await outCount(a2.conversationId),
    outBodies: await outBodies(a2.conversationId),
    ledger: await ledgerCount(a2.conversationId),
    conversationId: a2.conversationId,
  };

  // --- (C) Anthem, unknown gender → neutral 'আপনি', never স্যার/ম্যাডাম ---
  // (customers.gender is NOT NULL DEFAULT 'unknown' — 'unknown' is the
  // stored value for an unknown gender, never NULL.)
  const a3 = await seedConversation('Unknown Person', 'unknown', 'wc-q-a3', webchatChannelId);
  const r3 = await processBatch(workspaceId, a3.conversationId, [{ body: ANTHEM }]);
  out.anthemUnknown = {
    result: { replied: r3.replied, reason: r3.reason },
    state: await convState(a3.conversationId),
    outMessages: await outCount(a3.conversationId),
    outBodies: await outBodies(a3.conversationId),
    ledger: await ledgerCount(a3.conversationId),
    conversationId: a3.conversationId,
  };

  // --- (D) Normal price question → stays open, real reply, no escalation ---
  const a4 = await seedConversation('Normal Customer', 'unknown', 'wc-q-a4', webchatChannelId);
  const r4 = await processBatch(workspaceId, a4.conversationId, [{ body: 'জিন্সের দাম কত?' }]);
  out.normal = {
    result: { replied: r4.replied, reason: r4.reason },
    state: await convState(a4.conversationId),
    outBodies: await outBodies(a4.conversationId),
    conversationId: a4.conversationId,
  };

  // --- (E) Angry message STILL escalates as angry_customer with NO reply ---
  const a5 = await seedConversation('Rag Customer', 'unknown', 'wc-q-a5', webchatChannelId);
  const r5 = await processBatch(workspaceId, a5.conversationId, [{ body: 'তোমাদের সার্ভিস খুব বাজে! আমি রাগ করেছি' }]);
  out.angryStill = {
    result: { replied: r5.replied, reason: r5.reason },
    state: await convState(a5.conversationId),
    outMessages: await outCount(a5.conversationId),
    conversationId: a5.conversationId,
  };

  // --- (F) Double off-topic guard: another off-topic message to the
  // already-waiting anthem chat must not re-reply or re-escalate ---
  const r6 = await processBatch(workspaceId, a1.conversationId, [{ body: 'তোমার নাম কি?' }]);
  out.doubleOffTopic = {
    result: { replied: r6.replied, reason: r6.reason },
    state: await convState(a1.conversationId),
    outMessages: await outCount(a1.conversationId),
  };

  // --- (G) The boot-1 anthem conversation (real webhook path): no charge ---
  if (bootAnthemConvId) {
    out.bootAnthem = {
      state: await convState(bootAnthemConvId),
      outMessages: await outCount(bootAnthemConvId),
      outBodies: await outBodies(bootAnthemConvId),
      ledger: await ledgerCount(bootAnthemConvId),
      conversationId: bootAnthemConvId,
    };
  }

  console.log('DRIVER_RESULT ' + JSON.stringify(out));
}

main()
  .then(function () { process.exit(0); })
  .catch(function (err) {
    console.error('DRIVER ERR', err);
    process.exit(1);
  });
`;

function runDriver(dataDir, workspaceId, jeansId, bootAnthemConvId) {
  const driverPath = path.join(os.tmpdir(), `off-topic-quality-driver-${Date.now()}.ts`);
  fs.writeFileSync(driverPath, DRIVER_TS);
  return new Promise((resolve) => {
    const proc = spawn('npx', ['tsx', driverPath, workspaceId, jeansId, bootAnthemConvId || ''], {
      cwd: path.join(ROOT, 'apps/api'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        USE_PGLITE: 'true',
        PGLITE_DATA_DIR: dataDir,
        JWT_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        WEBCHAT_SECRET,
        GEMINI_API_KEY: '',
        GROQ_API_KEY: '',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
      },
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('close', (code) => {
      try { fs.unlinkSync(driverPath); } catch { /* already gone */ }
      resolve({ code, out, err });
    });
  });
}

async function main() {
  // ---------- Static checks ----------
  const escSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/inbox/escalation.ts'), 'utf8');
  check('escalation: famous-openings list includes the anthem first line', escSrc.includes('FAMOUS_BENGALI_OPENINGS') && escSrc.includes("'আমার সোনার বাংলা'"));
  check('escalation: long non-shop Bengali text layer exists', escSrc.includes('isLongNonShopBengaliText') && escSrc.includes('[\\u0980-\\u09FF]'));
  check('escalation: shop-scope guard still runs first in detectOffTopic', escSrc.indexOf('SHOP_SCOPE_SIGNALS') < escSrc.indexOf('FAMOUS_BENGALI_OPENINGS'));
  check('escalation: offTopicReply exported, gender-aware (স্যার/ম্যাডাম/আপনি)', escSrc.includes('export function offTopicReply') && escSrc.includes("'স্যার'") && escSrc.includes("'ম্যাডাম'"));
  check('escalation: off-topic reply says বুঝতে পারিনি + ভুল করে, never "আমি বুঝতে পারছি"', escSrc.includes('বুঝতে পারিনি') && escSrc.includes('ভুল করে') && !escSrc.includes('আমি বুঝতে পারছি'));

  const agentSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/ai-agent/agent.ts'), 'utf8');
  check('agent: off-topic block calls offTopicReply with the customer gender', agentSrc.includes('offTopicReply(normalizeCustomerGender('));
  const replyIdx = agentSrc.indexOf('offTopicReply(normalizeCustomerGender(');
  const escIdx = agentSrc.indexOf("escalateConversation(workspaceId, conversationId, 'off_topic')");
  check('agent: graceful reply is sent BEFORE the off_topic escalation', replyIdx > 0 && escIdx > 0 && replyIdx < escIdx);
  check('agent: reply goes through sendChannelMessage (saved + delivered)', agentSrc.includes('sendChannelMessage(') && agentSrc.lastIndexOf('sendChannelMessage(', replyIdx) > agentSrc.indexOf('detectOffTopic(batchedText)') && agentSrc.lastIndexOf('sendChannelMessage(', replyIdx) < escIdx);
  check('agent: off-topic block still runs BEFORE any AI call / allowance check', agentSrc.indexOf('detectOffTopic(batchedText)') < agentSrc.indexOf('checkAiReplyAllowance(workspaceId)'));

  const promptSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/ai-agent/prompts.ts'), 'utf8');
  check('prompt: hard rule 5ক forbids faking understanding (আমি বুঝতে পারছি / বুঝেছি / বুঝতে পেরেছি)', promptSrc.includes('5ক') && promptSrc.includes('আমি বুঝতে পারছি') && promptSrc.includes('বুঝেছি') && promptSrc.includes('বুঝতে পেরেছি'));
  check('prompt: unsure reply uses the canonical "বুঝতে পারছি না" (matches CANT_ANSWER_RE)', promptSrc.includes('বুঝতে পারছি না') && escSrc.includes("বুঝতে পারছি না"));

  // ---------- Boot 1: webchat webhook end-to-end (SIMULATED test messages) ----------
  const stamp = Date.now();
  const port = 4023;
  const dataDir = '.pglite-data-offtopic-quality';
  const run1 = startApi(port, dataDir);
  process.on('exit', run1.stop);
  let workspaceId = '';
  let jeansId = '';
  let bootAnthemConvId = '';
  try {
    const up = await waitForHealth(`http://localhost:${port}`);
    check('boot 1: API starts', up, up ? '' : run1.log().slice(-500));
    if (!up) return;
    const api = makeApi(`http://localhost:${port}`);
    const signup = await api('/api/auth/signup', {
      method: 'POST', auth: false,
      body: { name: 'OffTopic Quality Owner', email: `offtopicq+${stamp}@example.com`, password: 'verify1234', workspaceName: 'OffTopic Quality Test Shop' },
    });
    check('boot 1: signup', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
    token = signup.data?.token ?? '';
    workspaceId = signup.data?.workspace?.id ?? '';
    const live = await api(`/api/workspaces/${workspaceId}/go-live`, { method: 'POST' });
    check('boot 1: go-live', live.status === 200 && live.data?.workspace?.practice_mode === false, `status=${live.status}`);
    const jeans = await api('/api/products', { method: 'POST', body: { name: 'Jeans', pricePaisa: 50000, stock: 10 } });
    check('boot 1: Jeans product created', jeans.status === 201, `status=${jeans.status}`);
    jeansId = jeans.data?.id ?? jeans.data?.product?.id ?? '';
    const ch = await api('/api/channels', { method: 'POST', body: { platform: 'webchat', externalId: 'site-quality', displayName: 'Quality Test Site' } });
    check('boot 1: webchat channel → 201', ch.status === 201, `status=${ch.status}`);

    // Anthem lyrics over the real intake path (SIMULATED test message).
    const mAnthem = await api('/api/webhooks/webchat', {
      method: 'POST', auth: false,
      headers: { 'x-webchat-secret': WEBCHAT_SECRET },
      body: { externalId: 'site-quality', senderId: 'wc-q-anthem', name: 'Anthem Customer', text: ANTHEM },
    });
    check('boot 1: anthem webchat message accepted', mAnthem.status === 200 && !!mAnthem.data?.conversationId, `status=${mAnthem.status}`);
    bootAnthemConvId = mAnthem.data?.conversationId ?? '';
    const anthemFound = await pollFor(async () => {
      const detail = await api(`/api/inbox/${bootAnthemConvId}`);
      const conv = detail.data?.conversation ?? {};
      const out = (detail.data?.messages ?? []).filter((m) => m.direction === 'out');
      return conv.status === 'waiting' && out.length >= 1 ? { conv, out } : null;
    });
    check('boot 1: anthem → status waiting', !!anthemFound && anthemFound.conv.status === 'waiting', `status=${anthemFound?.conv?.status ?? '?'}`);
    check('boot 1: anthem → mode human (AI stopped)', !!anthemFound && anthemFound.conv.mode === 'human', `mode=${anthemFound?.conv?.mode ?? '?'}`);
    check('boot 1: anthem → reason off_topic', !!anthemFound && anthemFound.conv.escalation_reason === 'off_topic', `reason=${anthemFound?.conv?.escalation_reason ?? '?'}`);
    const anthemBody = (anthemFound?.out ?? []).map((m) => m.body ?? '').join(' ');
    check('boot 1: anthem got EXACTLY ONE graceful reply', !!anthemFound && anthemFound.out.length === 1, `out=${anthemFound?.out?.length ?? 0}`);
    check('boot 1: anthem reply says বুঝতে পারিনি + ভুল করে', anthemBody.includes('বুঝতে পারিনি') && anthemBody.includes('ভুল করে'), JSON.stringify(anthemBody.slice(0, 120)));
    check('boot 1: anthem reply NEVER says "আমি বুঝতে পারছি"', !anthemBody.includes('আমি বুঝতে পারছি'), JSON.stringify(anthemBody.slice(0, 120)));

    // Greeting over the same path — must NOT be off-topic; a reply is saved.
    const mHi = await api('/api/webhooks/webchat', {
      method: 'POST', auth: false,
      headers: { 'x-webchat-secret': WEBCHAT_SECRET },
      body: { externalId: 'site-quality', senderId: 'wc-q-hi', name: 'Greeting Customer', text: 'আসসালামু আলাইকুম' },
    });
    check('boot 1: greeting webchat message accepted', mHi.status === 200 && !!mHi.data?.conversationId, `status=${mHi.status}`);
    const hiConvId = mHi.data?.conversationId ?? '';
    const hiFound = await pollFor(async () => {
      const detail = await api(`/api/inbox/${hiConvId}`);
      const msgs = detail.data?.messages ?? [];
      const out = msgs.filter((m) => m.direction === 'out');
      return out.length > 0 ? detail.data?.conversation ?? {} : null;
    });
    check('boot 1: greeting got a reply (not off_topic)', !!hiFound && hiFound.escalation_reason !== 'off_topic', `reason=${hiFound?.escalation_reason ?? '?'}`);

    // Normal price question over the same path.
    const mNormal = await api('/api/webhooks/webchat', {
      method: 'POST', auth: false,
      headers: { 'x-webchat-secret': WEBCHAT_SECRET },
      body: { externalId: 'site-quality', senderId: 'wc-q-ok', name: 'Normal Customer', text: 'জিন্সের দাম কত?' },
    });
    check('boot 1: normal webchat message accepted', mNormal.status === 200 && !!mNormal.data?.conversationId, `status=${mNormal.status}`);
    const normalConvId = mNormal.data?.conversationId ?? '';
    const normalFound = await pollFor(async () => {
      const detail = await api(`/api/inbox/${normalConvId}`);
      const msgs = detail.data?.messages ?? [];
      const out = msgs.filter((m) => m.direction === 'out');
      const conv = detail.data?.conversation ?? {};
      return out.length > 0 ? { conv, out } : null;
    });
    check('boot 1: normal question stays open', !!normalFound && normalFound.conv.status === 'open', `status=${normalFound?.conv?.status ?? '?'}`);
    check('boot 1: normal question got a real reply (৳500)', !!normalFound && normalFound.out.some((m) => (m.body ?? '').includes('৳৫০০') || (m.body ?? '').includes('৫০০') || (m.body ?? '').includes('500')), JSON.stringify((normalFound?.out ?? []).map((m) => m.body).slice(0, 1)));
    check('boot 1: normal question was NOT escalated', !!normalFound && !normalFound.conv.escalation_reason, `reason=${normalFound?.conv?.escalation_reason ?? 'null'}`);
  } finally {
    run1.stop();
    await sleep(2000);
  }

  // ---------- Driver: processBatch directly + unit checks ----------
  const driver = await runDriver(dataDir, workspaceId, jeansId, bootAnthemConvId);
  let driverResult = null;
  const driverLine = (driver.out ?? '').split('\n').find((l) => l.startsWith('DRIVER_RESULT '));
  try {
    driverResult = driverLine ? JSON.parse(driverLine.slice('DRIVER_RESULT '.length)) : null;
  } catch {
    driverResult = null;
  }
  check('driver: ran clean (exit 0 + result line)', driver.code === 0 && !!driverResult, `code=${driver.code} err=${(driver.err ?? '').slice(-300)} out=${(driver.out ?? '').slice(-300)}`);
  if (driverResult) {
    check('driver: extended off-topic unit matrix all correct', driverResult.offTopicUnitAllOk === true, JSON.stringify((driverResult.offTopicUnit ?? []).filter((c) => !c.ok)));
    check('driver: offTopicReply() gender-aware + honest for all genders', driverResult.offTopicReplyOk === true, JSON.stringify({ m: driverResult.offTopicReplyMale, f: driverResult.offTopicReplyFemale, u: driverResult.offTopicReplyUnknown }));
    const am = driverResult.anthemMale ?? {};
    const amBody = (am.outBodies ?? []).join(' ');
    check('driver: anthem (male) → replied + waiting/off_topic + 1 reply', am.result?.replied === true && am.result?.reason === 'escalated_off_topic' && am.state?.status === 'waiting' && am.state?.mode === 'human' && am.state?.escalation_reason === 'off_topic' && am.outMessages === 1, JSON.stringify({ r: am.result, s: am.state, out: am.outMessages }));
    check('driver: anthem (male) reply addresses স্যার, says বুঝতে পারিনি, never "আমি বুঝতে পারছি"', amBody.includes('স্যার') && amBody.includes('বুঝতে পারিনি') && amBody.includes('ভুল করে') && !amBody.includes('আমি বুঝতে পারছি'), JSON.stringify(amBody.slice(0, 120)));
    check('driver: anthem (male) burned NO credit (ledger 0)', am.ledger === 0, `ledger=${am.ledger ?? '?'}`);
    const af = driverResult.anthemFemale ?? {};
    const afBody = (af.outBodies ?? []).join(' ');
    check('driver: anthem (female) → ম্যাডাম, never স্যার, ledger 0', af.result?.replied === true && af.state?.escalation_reason === 'off_topic' && af.outMessages === 1 && afBody.includes('ম্যাডাম') && !afBody.includes('স্যার') && af.ledger === 0, JSON.stringify({ b: afBody.slice(0, 120), ledger: af.ledger }));
    const au = driverResult.anthemUnknown ?? {};
    const auBody = (au.outBodies ?? []).join(' ');
    check('driver: anthem (unknown gender) → neutral আপনি, never স্যার/ম্যাডাম, ledger 0', au.result?.replied === true && au.state?.escalation_reason === 'off_topic' && au.outMessages === 1 && auBody.includes('আপনি') && !auBody.includes('স্যার') && !auBody.includes('ম্যাডাম') && au.ledger === 0, JSON.stringify({ b: auBody.slice(0, 120), ledger: au.ledger }));
    const nm = driverResult.normal ?? {};
    check('driver: normal price stays open + reply has ৳500', nm.result?.replied === true && nm.state?.status === 'open' && nm.state?.mode === 'ai' && !nm.state?.escalation_reason && (nm.outBodies ?? []).some((b) => b.includes('৳500') || b.includes('500')), JSON.stringify({ r: nm.result, s: nm.state }));
    const ag = driverResult.angryStill ?? {};
    check('driver: angry still escalates as angry_customer with NO reply', ag.result?.replied === false && ag.state?.status === 'waiting' && ag.state?.escalation_reason === 'angry_customer' && ag.outMessages === 0, JSON.stringify({ r: ag.result, s: ag.state, out: ag.outMessages }));
    const dbl = driverResult.doubleOffTopic ?? {};
    check('driver: second off-topic message does not re-reply or re-escalate', dbl.result?.reason === 'human_mode' && dbl.state?.status === 'waiting' && dbl.state?.escalation_reason === 'off_topic' && dbl.outMessages === 1, JSON.stringify({ r: dbl.result, s: dbl.state, out: dbl.outMessages }));
    const ba = driverResult.bootAnthem ?? {};
    const baBody = (ba.outBodies ?? []).join(' ');
    check('driver: boot-1 anthem conversation burned NO credit (ledger 0)', ba.ledger === 0, `ledger=${ba.ledger ?? '?'}`);
    check('driver: boot-1 anthem reply text is the graceful one', ba.outMessages === 1 && baBody.includes('বুঝতে পারিনি') && !baBody.includes('আমি বুঝতে পারছি'), JSON.stringify(baBody.slice(0, 120)));
  }

  // ---------- Cleanup ----------
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
