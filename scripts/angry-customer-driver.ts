// Driver for verify-angry-customer.mjs — tests angry / abusive /
// diverting-customer handling DIRECTLY against the same PGlite dir the
// verifier's API boot uses.
// Run AFTER the API boot stops (PGlite is single-process; the API holds
// the lock while it runs), with:
//   USE_PGLITE=true PGLITE_DATA_DIR=<dir> npx tsx scripts/angry-customer-driver.ts <workspaceId> <jeansId>
// Prints one DRIVER_RESULT JSON line for the verifier to parse.
// No secrets are printed.
//
// All messages below are SIMULATED test inputs (not live customers).
import { pool } from '../apps/api/src/db/pool';
import { processBatch } from '../apps/api/src/ai-agent/agent';
import { detectAnger, isRepeatedNonShopMessage } from '../apps/api/src/inbox/escalation';

const [workspaceId, jeansId] = process.argv.slice(2);
if (!workspaceId || !jeansId) {
  console.error('usage: angry-customer-driver.ts <workspaceId> <jeansId>');
  process.exit(2);
}

const out: Record<string, unknown> = {};

async function seedConversation(customerName: string, identities: unknown): Promise<{ customerId: string; conversationId: string }> {
  const c = await pool.query(
    `INSERT INTO customers (workspace_id, name, channel_identities) VALUES ($1, $2, $3::jsonb) RETURNING id`,
    [workspaceId, customerName, JSON.stringify(identities)],
  );
  const customerId = c.rows[0].id as string;
  const cv = await pool.query(
    `INSERT INTO conversations (workspace_id, customer_id, status, mode) VALUES ($1, $2, 'open', 'ai') RETURNING id`,
    [workspaceId, customerId],
  );
  return { customerId, conversationId: cv.rows[0].id as string };
}

async function convState(conversationId: string): Promise<Record<string, unknown>> {
  const r = await pool.query(
    'SELECT status, mode, escalation_reason, escalated_at FROM conversations WHERE id = $1',
    [conversationId],
  );
  return (r.rows[0] as Record<string, unknown>) ?? {};
}

async function outCount(conversationId: string): Promise<number> {
  const r = await pool.query(
    "SELECT COUNT(*)::int AS n FROM messages WHERE workspace_id = $1 AND conversation_id = $2 AND direction = 'out'",
    [workspaceId, conversationId],
  );
  return Number((r.rows[0] as { n: number }).n);
}

async function outBodies(conversationId: string): Promise<string[]> {
  const r = await pool.query(
    "SELECT body FROM messages WHERE workspace_id = $1 AND conversation_id = $2 AND direction = 'out' ORDER BY created_at ASC",
    [workspaceId, conversationId],
  );
  return (r.rows as { body: string | null }[]).map((row) => row.body ?? '');
}

/** Ledger rows for this conversation — must stay 0 on every escalation path (no credit burned). */
async function ledgerCount(conversationId: string): Promise<number> {
  const r = await pool.query(
    'SELECT COUNT(*)::int AS n FROM ai_usage_ledger WHERE workspace_id = $1 AND conversation_id = $2',
    [workspaceId, conversationId],
  );
  return Number((r.rows[0] as { n: number }).n);
}

/** Bell notifications created for this conversation. */
async function notificationsFor(conversationId: string): Promise<{ type: string; title: string; body: string; conversation_id: string }[]> {
  const r = await pool.query(
    'SELECT type, title, body, conversation_id FROM notifications WHERE workspace_id = $1 AND conversation_id = $2 ORDER BY created_at ASC',
    [workspaceId, conversationId],
  );
  return r.rows as { type: string; title: string; body: string; conversation_id: string }[];
}

/** Save an inbound message row, exactly as the webhook does before the queue runs. */
async function insertInbound(conversationId: string, body: string): Promise<void> {
  await pool.query(
    `INSERT INTO messages (workspace_id, conversation_id, direction, type, body) VALUES ($1, $2, 'in', 'text', $3)`,
    [workspaceId, conversationId, body],
  );
}

async function main(): Promise<void> {
  // --- Unit checks: the anger + abuse list ---
  // True cases: the old anger words still fire, and the NEW (2026-11-11)
  // abuse blocklist fires on Bengali-script gali, Romanized gali and
  // English swearing — including messages with NO old anger word in them
  // (those are the ones that used to sail through to the AI).
  const angerCases: [string, boolean][] = [
    // Old list (must keep working).
    ['তোমাদের সার্ভিস খুব বাজে! আমি রাগ করেছি', true],
    ['ধোকা দিয়েছো, চিটার!', true],
    ['This is the worst service, you cheated me!', true],
    ['ami rag korechi, faltu service', true],
    // NEW: Bengali-script abuse — no old anger word present.
    ['তুমি একটা বোকাচোদা!', true],
    ['শালা, টাকা ফেরত দাও', true],
    ['তোরা সব মাদারচোদ', true],
    ['খানকি, আমার অর্ডার কোথায়', true],
    ['তুমি হারামজাদা', true],
    ['কুত্তার বাচ্চা, টাকা দে', true],
    // NEW: English swearing — no old anger word present.
    ['You are a fucking bastard', true],
    ['This is shit service', true],
    // NEW: Romanized Bengali gali — no old anger word present.
    ['tora sob sala bokachoda', true],
    ['you madarchod, give my money back', true],
    // Negatives: normal complaints / questions must NEVER trigger.
    ['জিন্সের দাম কত?', false],
    ['দাম বেশি, কমানো যাবে?', false],
    ['আমি রিফান্ড চাই, টাকা ফেরত চাই', false],
    ['অর্ডার কবে আসবে?', false],
    ['I want a refund please', false],
    ['My order is late', false],
    ['এটা কি হারাম?', false], // bare 'হারাম' is a normal word, not abuse
    ['বালকদের জামা আছে?', false], // 'বালক' (boy) must not match 'বাল'
    ['শার্টের কালার কী কী আছে?', false],
    ['ধন্যবাদ, ভালো সার্ভিস', false],
  ];
  out.angerUnit = angerCases.map(([text, expected]) => ({
    text: text.slice(0, 30),
    expected,
    got: detectAnger(text),
    ok: detectAnger(text) === expected,
  }));
  out.angerUnitAllOk = (out.angerUnit as { ok: boolean }[]).every((c) => c.ok);

  // --- Unit checks: the repeated-nonsense guard ---
  const nonsense = 'আবজক তবজক লমপ ঝমপ';
  const repeatCases: [string, (string | null | undefined)[], boolean][] = [
    [nonsense, [nonsense, nonsense], true],
    [nonsense, [nonsense], false], // only one previous repeat — not yet
    [nonsense, [nonsense, 'other text here'], false], // previous two differ
    ['জিন্সের দাম কত টাকা বলেন', ['জিন্সের দাম কত টাকা বলেন', 'জিন্সের দাম কত টাকা বলেন'], false], // shop question
    ['আসসালামু আলাইকুম', ['আসসালামু আলাইকুম', 'আসসালামু আলাইকুম'], false], // greeting
    ['হ্যাঁ', ['হ্যাঁ', 'হ্যাঁ'], false], // too short
    ['01700000000', ['01700000000', '01700000000'], false], // digits only
    ['কেমন আছো', ['কেমন আছো', 'কেমন আছো'], false], // small-talk
  ];
  out.repeatUnit = repeatCases.map(([text, prev, expected]) => ({
    text: text.slice(0, 30),
    expected,
    got: isRepeatedNonShopMessage(text, prev),
    ok: isRepeatedNonShopMessage(text, prev) === expected,
  }));
  out.repeatUnitAllOk = (out.repeatUnit as { ok: boolean }[]).every((c) => c.ok);

  // --- Messenger channel + a pre-waiting conversation (for the verifier's
  // Meta-webhook reopen-guard test: a new message must NOT reopen it). ---
  await pool.query(
    `INSERT INTO channels (workspace_id, platform, external_id, display_name, status)
     VALUES ($1, 'messenger', 'TESTPAGE1', 'Test Page', 'connected')
     ON CONFLICT DO NOTHING`,
    [workspaceId],
  );
  const guard = await seedConversation('Guard Customer', [{ platform: 'messenger', senderId: 'PSID-ANGRY-1' }]);
  await pool.query(
    `UPDATE conversations SET status = 'waiting', mode = 'human', handed_to = 'human',
       handover_started_at = now(), escalation_reason = 'angry_customer', escalated_at = now()
     WHERE id = $1`,
    [guard.conversationId],
  );
  out.guardConversationId = guard.conversationId;
  out.guardCustomerId = guard.customerId;

  // --- (1) Abusive Bengali-script message → waiting, no reply, no ledger, bell row with the name ---
  const a1 = await seedConversation('Ragib Hasan', [{ platform: 'webchat', senderId: 'wc-d-abuse-bn' }]);
  const r1 = await processBatch(workspaceId, a1.conversationId, [{ body: 'তুমি একটা বোকাচোদা, শালা! টাকা ফেরত দাও' }]);
  out.abusiveBn = {
    result: { replied: r1.replied, reason: r1.reason },
    state: await convState(a1.conversationId),
    outMessages: await outCount(a1.conversationId),
    ledgerRows: await ledgerCount(a1.conversationId),
    notifications: await notificationsFor(a1.conversationId),
    conversationId: a1.conversationId,
  };

  // --- (2) Abusive English message → same ---
  const a2 = await seedConversation('Angry Adam', [{ platform: 'webchat', senderId: 'wc-d-abuse-en' }]);
  const r2 = await processBatch(workspaceId, a2.conversationId, [{ body: 'You are a fucking bastard, give me my money back' }]);
  out.abusiveEn = {
    result: { replied: r2.replied, reason: r2.reason },
    state: await convState(a2.conversationId),
    outMessages: await outCount(a2.conversationId),
    ledgerRows: await ledgerCount(a2.conversationId),
    notifications: await notificationsFor(a2.conversationId),
    conversationId: a2.conversationId,
  };

  // --- (3) Abusive Romanized-Bengali message → same ---
  const a3 = await seedConversation('Roman Ragib', [{ platform: 'webchat', senderId: 'wc-d-abuse-ro' }]);
  const r3 = await processBatch(workspaceId, a3.conversationId, [{ body: 'tora sob sala bokachoda' }]);
  out.abusiveRo = {
    result: { replied: r3.replied, reason: r3.reason },
    state: await convState(a3.conversationId),
    outMessages: await outCount(a3.conversationId),
    ledgerRows: await ledgerCount(a3.conversationId),
    notifications: await notificationsFor(a3.conversationId),
    conversationId: a3.conversationId,
  };

  // --- (4) Classic angry Bengali (old list) still escalates ---
  const a4 = await seedConversation('Rag Customer', [{ platform: 'webchat', senderId: 'wc-d-rag-1' }]);
  const r4 = await processBatch(workspaceId, a4.conversationId, [{ body: 'তোমাদের সার্ভিস খুব বাজে! আমি রাগ করেছি, টাকা ফেরত দাও' }]);
  out.angryClassic = {
    result: { replied: r4.replied, reason: r4.reason },
    state: await convState(a4.conversationId),
    outMessages: await outCount(a4.conversationId),
    ledgerRows: await ledgerCount(a4.conversationId),
    notifications: await notificationsFor(a4.conversationId),
    conversationId: a4.conversationId,
  };

  // --- (5) Second angry message to the already-waiting chat: no re-escalation, no new bell row ---
  const r5 = await processBatch(workspaceId, a1.conversationId, [{ body: 'আবার বলছি, তোরা সব মাদারচোদ!' }]);
  out.doubleAngry = {
    result: { replied: r5.replied, reason: r5.reason },
    state: await convState(a1.conversationId),
    outMessages: await outCount(a1.conversationId),
    ledgerRows: await ledgerCount(a1.conversationId),
    notifications: await notificationsFor(a1.conversationId),
  };

  // --- (6) Normal complaint ("দাম বেশি") → normal AI reply, stays open, no bell row ---
  const a6 = await seedConversation('Normal Customer', [{ platform: 'webchat', senderId: 'wc-d-ok-1' }]);
  const r6 = await processBatch(workspaceId, a6.conversationId, [{ body: 'দাম বেশি, কমানো যাবে?' }]);
  out.normalComplaint = {
    result: { replied: r6.replied, reason: r6.reason },
    state: await convState(a6.conversationId),
    outMessages: await outCount(a6.conversationId),
    notifications: await notificationsFor(a6.conversationId),
    conversationId: a6.conversationId,
  };

  // --- (7) Normal price question → stays open, real reply with ৳500 ---
  const a7 = await seedConversation('Price Customer', [{ platform: 'webchat', senderId: 'wc-d-ok-2' }]);
  const r7 = await processBatch(workspaceId, a7.conversationId, [{ body: 'জিন্সের দাম কত?' }]);
  out.normalPrice = {
    result: { replied: r7.replied, reason: r7.reason },
    state: await convState(a7.conversationId),
    outBodies: await outBodies(a7.conversationId),
    conversationId: a7.conversationId,
  };

  // --- (8) Repeated diverting: two off-topic messages in a row ---
  // First: ONE deterministic template reply, then waiting. Second: the
  // chat is already human-mode, so nothing new goes out and no credit
  // is burned.
  const a8 = await seedConversation('Diverting Customer', [{ platform: 'webchat', senderId: 'wc-d-div-1' }]);
  const r8a = await processBatch(workspaceId, a8.conversationId, [{ body: 'তুমি ছেলে নাকি মেয়ে?' }]);
  const afterFirst = {
    result: { replied: r8a.replied, reason: r8a.reason },
    state: await convState(a8.conversationId),
    outMessages: await outCount(a8.conversationId),
    outBodies: await outBodies(a8.conversationId),
    ledgerRows: await ledgerCount(a8.conversationId),
    notifications: await notificationsFor(a8.conversationId),
  };
  const r8b = await processBatch(workspaceId, a8.conversationId, [{ body: 'আবহাওয়া কেমন আজ?' }]);
  out.repeatedOffTopic = {
    first: afterFirst,
    second: {
      result: { replied: r8b.replied, reason: r8b.reason },
      state: await convState(a8.conversationId),
      outMessages: await outCount(a8.conversationId),
      ledgerRows: await ledgerCount(a8.conversationId),
      notifications: await notificationsFor(a8.conversationId),
    },
    conversationId: a8.conversationId,
  };

  // --- (9) Repeated nonsense: the same non-shop Bengali text 3x ---
  // The webhook saves each message before the queue runs, so the two
  // previous repeats + the current message are all in the DB when
  // processBatch runs — seed all three rows, then process the third.
  const a9 = await seedConversation('Nonsense Nasir', [{ platform: 'webchat', senderId: 'wc-d-non-1' }]);
  await insertInbound(a9.conversationId, nonsense);
  await insertInbound(a9.conversationId, nonsense);
  await insertInbound(a9.conversationId, nonsense);
  const r9 = await processBatch(workspaceId, a9.conversationId, [{ body: nonsense }]);
  out.repeatedNonsense = {
    result: { replied: r9.replied, reason: r9.reason },
    state: await convState(a9.conversationId),
    outMessages: await outCount(a9.conversationId),
    ledgerRows: await ledgerCount(a9.conversationId),
    notifications: await notificationsFor(a9.conversationId),
    conversationId: a9.conversationId,
  };

  // --- (10) Control: the same message 3x WITH a shop signal → NOT nonsense, normal reply ---
  const shopRepeat = 'জিন্সের দাম কত টাকা বলেন';
  const a10 = await seedConversation('Repeat Shopper', [{ platform: 'webchat', senderId: 'wc-d-rep-1' }]);
  await insertInbound(a10.conversationId, shopRepeat);
  await insertInbound(a10.conversationId, shopRepeat);
  await insertInbound(a10.conversationId, shopRepeat);
  const r10 = await processBatch(workspaceId, a10.conversationId, [{ body: shopRepeat }]);
  out.repeatedShopControl = {
    result: { replied: r10.replied, reason: r10.reason },
    state: await convState(a10.conversationId),
    outMessages: await outCount(a10.conversationId),
    conversationId: a10.conversationId,
  };

  // --- (11) Control: the same nonsense only TWICE → NOT escalated (the guard needs 3) ---
  const a11 = await seedConversation('Twice Customer', [{ platform: 'webchat', senderId: 'wc-d-tw-1' }]);
  await insertInbound(a11.conversationId, nonsense);
  await insertInbound(a11.conversationId, nonsense);
  const r11 = await processBatch(workspaceId, a11.conversationId, [{ body: nonsense }]);
  out.repeatedTwiceControl = {
    result: { replied: r11.replied, reason: r11.reason },
    state: await convState(a11.conversationId),
    conversationId: a11.conversationId,
  };

  // --- (12) Control: 3 identical messages in ONE batch → escalates (rapid repeats) ---
  const a12 = await seedConversation('Rapid Customer', [{ platform: 'webchat', senderId: 'wc-d-rap-1' }]);
  const r12 = await processBatch(workspaceId, a12.conversationId, [{ body: nonsense }, { body: nonsense }, { body: nonsense }]);
  out.repeatedBatch = {
    result: { replied: r12.replied, reason: r12.reason },
    state: await convState(a12.conversationId),
    outMessages: await outCount(a12.conversationId),
    ledgerRows: await ledgerCount(a12.conversationId),
    notifications: await notificationsFor(a12.conversationId),
    conversationId: a12.conversationId,
  };

  console.log(`DRIVER_RESULT ${JSON.stringify(out)}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('DRIVER ERR', err);
    process.exit(1);
  });
