// Driver for verify-waiting-escalation.mjs — tests automatic escalation
// DIRECTLY against the same PGlite dir the verifier's API boot uses.
// Run AFTER the API boot stops (PGlite is single-process; the API holds
// the lock while it runs), with:
//   USE_PGLITE=true PGLITE_DATA_DIR=<dir> npx tsx scripts/waiting-escalation-driver.ts <workspaceId> <jeansId>
// Prints one DRIVER_RESULT JSON line for the verifier to parse.
// No secrets are printed.
import { pool } from '../apps/api/src/db/pool';
import { processBatch } from '../apps/api/src/ai-agent/agent';
import { detectAnger, isCantAnswerReply } from '../apps/api/src/inbox/escalation';

const [workspaceId, jeansId] = process.argv.slice(2);
if (!workspaceId || !jeansId) {
  console.error('usage: waiting-escalation-driver.ts <workspaceId> <jeansId>');
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

async function main(): Promise<void> {
  // --- Unit checks: the anger list is conservative ---
  const angerCases: [string, boolean][] = [
    ['তোমাদের সার্ভিস খুব বাজে! আমি রাগ করেছি', true],
    ['ধোকা দিয়েছো, চিটার!', true],
    ['This is the worst service, you cheated me!', true],
    ['I am so angry right now', true],
    ['ami rag korechi, faltu service', true],
    ['জিন্সের দাম কত?', false],
    ['আমি রিফান্ড চাই, টাকা ফেরত চাই', false],
    ['দাম বেশি, কমানো যাবে?', false],
    ['অর্ডার কবে আসবে?', false],
    ['I want a refund please', false],
    ['My order is late', false],
  ];
  out.angerUnit = angerCases.map(([text, expected]) => ({
    text: text.slice(0, 30),
    expected,
    got: detectAnger(text),
    ok: detectAnger(text) === expected,
  }));
  out.angerUnitAllOk = (out.angerUnit as { ok: boolean }[]).every((c) => c.ok);
  out.cantAnswerUnit = {
    fallback: isCantAnswerReply('দুঃখিত, এই প্রশ্নের উত্তর আমার কাছে নেই। একজন মানুষ শীঘ্রই আপনাকে উত্তর দেবে।'),
    promptPhrase: isCantAnswerReply('জানি না, একজন মানুষ দেখে জানাচ্ছে'),
    normalPrice: isCantAnswerReply('জিন্সের দাম ৳৫০০।'),
  };

  // --- Messenger channel + a pre-waiting conversation (for the verifier's
  // Meta-webhook reopen-guard test: a new message must NOT reopen it). ---
  await pool.query(
    `INSERT INTO channels (workspace_id, platform, external_id, display_name, status)
     VALUES ($1, 'messenger', 'TESTPAGE1', 'Test Page', 'connected')
     ON CONFLICT DO NOTHING`,
    [workspaceId],
  );
  const guard = await seedConversation('Guard Customer', [{ platform: 'messenger', senderId: 'PSID-WAIT-1' }]);
  await pool.query(
    `UPDATE conversations SET status = 'waiting', mode = 'human', handed_to = 'human',
       handover_started_at = now(), escalation_reason = 'angry_customer', escalated_at = now()
     WHERE id = $1`,
    [guard.conversationId],
  );
  out.guardConversationId = guard.conversationId;
  out.guardCustomerId = guard.customerId;

  // --- (1) Angry Bengali message → waiting, no AI reply ---
  const a1 = await seedConversation('Rag Customer', [{ platform: 'webchat', senderId: 'wc-d-rag-1' }]);
  const r1 = await processBatch(workspaceId, a1.conversationId, [{ body: 'তোমাদের সার্ভিস খুব বাজে! আমি রাগ করেছি, টাকা ফেরত দাও' }]);
  out.angryBn = {
    result: { replied: r1.replied, reason: r1.reason },
    state: await convState(a1.conversationId),
    outMessages: await outCount(a1.conversationId),
    conversationId: a1.conversationId,
  };

  // --- (2) Angry English message → waiting, no AI reply ---
  const a2 = await seedConversation('Angry Customer', [{ platform: 'webchat', senderId: 'wc-d-rag-2' }]);
  const r2 = await processBatch(workspaceId, a2.conversationId, [{ body: 'This is the worst service, you cheated me!' }]);
  out.angryEn = {
    result: { replied: r2.replied, reason: r2.reason },
    state: await convState(a2.conversationId),
    outMessages: await outCount(a2.conversationId),
    conversationId: a2.conversationId,
  };

  // --- (3) Can't-answer question (no product/knowledge match) → waiting, fallback reply saved ---
  const a3 = await seedConversation('Lost Customer', [{ platform: 'webchat', senderId: 'wc-d-lost-1' }]);
  const r3 = await processBatch(workspaceId, a3.conversationId, [{ body: 'তোমাদের দোকান কোথায়?' }]);
  out.cantAnswer = {
    result: { replied: r3.replied, reason: r3.reason },
    state: await convState(a3.conversationId),
    outBodies: await outBodies(a3.conversationId),
    conversationId: a3.conversationId,
  };

  // --- (4) Normal price question → stays open, real AI reply, no escalation ---
  const a4 = await seedConversation('Normal Customer', [{ platform: 'webchat', senderId: 'wc-d-ok-1' }]);
  const r4 = await processBatch(workspaceId, a4.conversationId, [{ body: 'জিন্সের দাম কত?' }]);
  out.normal = {
    result: { replied: r4.replied, reason: r4.reason },
    state: await convState(a4.conversationId),
    outBodies: await outBodies(a4.conversationId),
    conversationId: a4.conversationId,
  };

  // --- (5) Plain refund request → NEVER 'angry_customer' ---
  const a5 = await seedConversation('Refund Customer', [{ platform: 'webchat', senderId: 'wc-d-ref-1' }]);
  const r5 = await processBatch(workspaceId, a5.conversationId, [{ body: 'আমি রিফান্ড চাই, টাকা ফেরত চাই' }]);
  out.refundOnly = {
    result: { replied: r5.replied, reason: r5.reason },
    state: await convState(a5.conversationId),
    conversationId: a5.conversationId,
  };

  // --- (6) Double-escalation guard: another angry message to the already-waiting chat ---
  const r6 = await processBatch(workspaceId, a1.conversationId, [{ body: 'আবার বলছি, খুব বাজে!' }]);
  out.doubleEscalation = {
    result: { replied: r6.replied, reason: r6.reason },
    state: await convState(a1.conversationId),
    outMessages: await outCount(a1.conversationId),
  };

  console.log(`DRIVER_RESULT ${JSON.stringify(out)}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('DRIVER ERR', err);
    process.exit(1);
  });
