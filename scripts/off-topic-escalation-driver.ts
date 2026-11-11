// Driver for verify-off-topic-escalation.mjs — tests off-topic auto-off
// DIRECTLY against the same PGlite dir the verifier's API boot uses.
// Run AFTER the API boot stops (PGlite is single-process; the API holds
// the lock while it runs), with:
//   USE_PGLITE=true PGLITE_DATA_DIR=<dir> npx tsx scripts/off-topic-escalation-driver.ts <workspaceId> <jeansId>
// Prints one DRIVER_RESULT JSON line for the verifier to parse.
// No secrets are printed.
import { pool } from '../apps/api/src/db/pool';
import { processBatch } from '../apps/api/src/ai-agent/agent';
import { detectOffTopic } from '../apps/api/src/inbox/escalation';

const [workspaceId, jeansId] = process.argv.slice(2);
if (!workspaceId || !jeansId) {
  console.error('usage: off-topic-escalation-driver.ts <workspaceId> <jeansId>');
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
  // --- Unit checks: the off-topic list is conservative ---
  // true = off-topic (escalates, no reply, no credit); false = in scope
  // (flows through) or a greeting (still gets the AI's reply).
  const offTopicCases: [string, boolean][] = [
    // Off-topic: personal questions about the AI.
    ['তুমি ছেলে নাকি মেয়ে?', true],
    ['তোমার নাম কি?', true],
    ['তোমার বয়স কত?', true],
    ['তুমি কি মানুষ নাকি রোবট?', true],
    ['tumi chele naki meye?', true],
    ['tomar nam ki?', true],
    ['Are you a boy or a girl?', true],
    ['What is your name?', true],
    ['How old are you?', true],
    // Off-topic: unrelated topics.
    ['আজকের আবহাওয়া কেমন?', true],
    ['ক্রিকেট খেলার খবর কি?', true],
    ['একটা কৌতুক শোনাও', true],
    ['গান শোনাও তো', true],
    ['সিনেমা দেখতে যাবো?', true],
    ['বাংলাদেশের রাজধানী কি?', true],
    ['Tell me a joke', true],
    ['What is the weather today?', true],
    // In scope: shop questions must NEVER match.
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
    // Greetings are NOT off-topic.
    ['আসসালামু আলাইকুম', false],
    ['হাই', false],
    ['hello', false],
  ];
  out.offTopicUnit = offTopicCases.map(([text, expected]) => ({
    text: text.slice(0, 30),
    expected,
    got: detectOffTopic(text),
    ok: detectOffTopic(text) === expected,
  }));
  out.offTopicUnitAllOk = (out.offTopicUnit as { ok: boolean }[]).every((c) => c.ok);

  // --- Shop knowledge (mirrors the real shop): delivery charge, so the
  // delivery question gets a real knowledge reply in demo mode. ---
  await pool.query(
    `INSERT INTO knowledge_items (workspace_id, title, body)
     VALUES ($1, 'ডেলিভারি চার্জ', 'সারা বাংলাদেশে কুরিয়ারের মাধ্যমে ডেলিভারি দেওয়া হয়। ঢাকার ভেতরে ডেলিভারি চার্জ ১০০ টাকা। ঢাকার বাইরে পুরো বাংলাদেশে ডেলিভারি চার্জ ১৩০ টাকা।')`,
    [workspaceId],
  );

  // --- Messenger channel + a pre-waiting OFF-TOPIC conversation (for the
  // verifier's Meta-webhook reopen-guard test: a new message must NOT
  // reopen it). ---
  await pool.query(
    `INSERT INTO channels (workspace_id, platform, external_id, display_name, status)
     VALUES ($1, 'messenger', 'TESTPAGE1', 'Test Page', 'connected')
     ON CONFLICT DO NOTHING`,
    [workspaceId],
  );
  const guard = await seedConversation('Guard Customer', [{ platform: 'messenger', senderId: 'PSID-OFF-1' }]);
  await pool.query(
    `UPDATE conversations SET status = 'waiting', mode = 'human', handed_to = 'human',
       handover_started_at = now(), escalation_reason = 'off_topic', escalated_at = now()
     WHERE id = $1`,
    [guard.conversationId],
  );
  out.guardConversationId = guard.conversationId;
  out.guardCustomerId = guard.customerId;

  // --- (1) Off-topic Bengali message → ONE graceful deterministic reply,
  // then waiting/off_topic (Feature 1, 2026-11-11 — no AI call, no charge) ---
  const o1 = await seedConversation('Curious Customer', [{ platform: 'webchat', senderId: 'wc-d-off-1' }]);
  const r1 = await processBatch(workspaceId, o1.conversationId, [{ body: 'তুমি ছেলে নাকি মেয়ে?' }]);
  out.offTopicBn = {
    result: { replied: r1.replied, reason: r1.reason },
    state: await convState(o1.conversationId),
    outMessages: await outCount(o1.conversationId),
    outBodies: await outBodies(o1.conversationId),
    conversationId: o1.conversationId,
  };

  // --- (2) Off-topic English message → ONE graceful deterministic reply,
  // then waiting/off_topic (Feature 1, 2026-11-11) ---
  const o2 = await seedConversation('Curious Customer EN', [{ platform: 'webchat', senderId: 'wc-d-off-2' }]);
  const r2 = await processBatch(workspaceId, o2.conversationId, [{ body: 'What is your name?' }]);
  out.offTopicEn = {
    result: { replied: r2.replied, reason: r2.reason },
    state: await convState(o2.conversationId),
    outMessages: await outCount(o2.conversationId),
    outBodies: await outBodies(o2.conversationId),
    conversationId: o2.conversationId,
  };

  // --- (3) Greeting → NOT off_topic, a reply IS saved ---
  // (Demo mode answers a greeting with its labelled fallback reply, which
  // escalates as cant_answer — pre-existing demo behaviour. The point
  // here is only that the off-topic path did NOT fire.)
  const o3 = await seedConversation('Greeting Customer', [{ platform: 'webchat', senderId: 'wc-d-hi-1' }]);
  const r3 = await processBatch(workspaceId, o3.conversationId, [{ body: 'আসসালামু আলাইকুম' }]);
  out.greeting = {
    result: { replied: r3.replied, reason: r3.reason },
    state: await convState(o3.conversationId),
    outBodies: await outBodies(o3.conversationId),
    conversationId: o3.conversationId,
  };

  // --- (4) Normal price question → stays open, real reply, no escalation ---
  const o4 = await seedConversation('Normal Customer', [{ platform: 'webchat', senderId: 'wc-d-ok-1' }]);
  const r4 = await processBatch(workspaceId, o4.conversationId, [{ body: 'জিন্সের দাম কত?' }]);
  out.normal = {
    result: { replied: r4.replied, reason: r4.reason },
    state: await convState(o4.conversationId),
    outBodies: await outBodies(o4.conversationId),
    conversationId: o4.conversationId,
  };

  // --- (5) Delivery-charge question (knowledge) → stays open, real reply ---
  const o5 = await seedConversation('Delivery Customer', [{ platform: 'webchat', senderId: 'wc-d-del-1' }]);
  const r5 = await processBatch(workspaceId, o5.conversationId, [{ body: 'ঢাকার বাইরে ডেলিভারি চার্জ কত?' }]);
  out.delivery = {
    result: { replied: r5.replied, reason: r5.reason },
    state: await convState(o5.conversationId),
    outBodies: await outBodies(o5.conversationId),
    conversationId: o5.conversationId,
  };

  // --- (6) Angry message STILL escalates as angry_customer (regression) ---
  const o6 = await seedConversation('Rag Customer', [{ platform: 'webchat', senderId: 'wc-d-rag-1' }]);
  const r6 = await processBatch(workspaceId, o6.conversationId, [{ body: 'তোমাদের সার্ভিস খুব বাজে! আমি রাগ করেছি' }]);
  out.angryStill = {
    result: { replied: r6.replied, reason: r6.reason },
    state: await convState(o6.conversationId),
    outMessages: await outCount(o6.conversationId),
    conversationId: o6.conversationId,
  };

  // --- (7) Double off-topic guard: another off-topic message to the
  // already-waiting chat must not re-escalate or reply ---
  const r7 = await processBatch(workspaceId, o1.conversationId, [{ body: 'তোমার নাম কি?' }]);
  out.doubleOffTopic = {
    result: { replied: r7.replied, reason: r7.reason },
    state: await convState(o1.conversationId),
    outMessages: await outCount(o1.conversationId),
  };

  console.log(`DRIVER_RESULT ${JSON.stringify(out)}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('DRIVER ERR', err);
    process.exit(1);
  });
