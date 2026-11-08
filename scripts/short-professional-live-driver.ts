// LIVE driver for verify-short-professional.mjs — tests the SHORT-reply
// behaviour with the REAL Gemini key, DIRECTLY against the same PGlite dir
// the verifier's API boot uses. Run AFTER the demo driver, with:
//   USE_PGLITE=true PGLITE_DATA_DIR=<dir> GEMINI_API_KEY=<real key> \
//     npx tsx scripts/short-professional-live-driver.ts <workspaceId> <jeansId> <tshirtId> <shirtId> <channelId>
// Prints one LIVE_DRIVER_RESULT JSON line for the verifier to parse.
// No secrets are printed. If GEMINI_API_KEY is missing, it exits 0
// with { skipped: true } (the verifier reports it as skipped, not a pass).
import { pool } from '../apps/api/src/db/pool';
import { processBatch } from '../apps/api/src/ai-agent/agent';

const [workspaceId, jeansId, tshirtId, shirtId, channelId] = process.argv.slice(2);

const JEANS_IMG = 'https://wzal8khi0daufwg8.public.blob.vercel-storage.com/308ad456-0ac0-413b-a8f0-5cb5f786f80e.png';

const out: Record<string, unknown> = {};
let n = 300;

async function seedConversation(customerName: string): Promise<{ customerId: string; conversationId: string }> {
  n += 1;
  const c = await pool.query(
    `INSERT INTO customers (workspace_id, name, gender, channel_identities) VALUES ($1, $2, 'male', $3::jsonb) RETURNING id`,
    [workspaceId, customerName, JSON.stringify([{ platform: 'webchat', senderId: `sp-live-${n}` }])],
  );
  const customerId = c.rows[0].id as string;
  const cv = await pool.query(
    `INSERT INTO conversations (workspace_id, channel_id, customer_id, status, mode) VALUES ($1, $2, $3, 'open', 'ai') RETURNING id`,
    [workspaceId, channelId, customerId],
  );
  return { customerId, conversationId: cv.rows[0].id as string };
}

async function outMessages(conversationId: string): Promise<string[]> {
  const r = await pool.query(
    "SELECT body FROM messages WHERE workspace_id = $1 AND conversation_id = $2 AND direction = 'out' ORDER BY created_at ASC",
    [workspaceId, conversationId],
  );
  return (r.rows as { body: string | null }[]).map((row) => row.body ?? '');
}

async function seedInMessage(conversationId: string, body: string, mediaType: string | null = null, mediaUrl: string | null = null): Promise<void> {
  await pool.query(
    "INSERT INTO messages (workspace_id, conversation_id, direction, type, body, media_type, media_url) VALUES ($1, $2, 'in', 'text', $3, $4, $5)",
    [workspaceId, conversationId, body, mediaType, mediaUrl],
  );
}

function countLines(s: string): number {
  return s.split('\n').map((l) => l.trim()).filter(Boolean).length;
}

async function main(): Promise<void> {
  if (!process.env.GEMINI_API_KEY) {
    console.log('LIVE_DRIVER_RESULT ' + JSON.stringify({ skipped: true, reason: 'no GEMINI_API_KEY' }));
    process.exit(0);
  }

  // --- Live 1: "এই প্রোডাক্টটি কি জিন্স?" after a Jeans photo match → ONE sentence ---
  const jeansConv = await seedConversation('লাইভ জিন্স কাস্টমার');
  await seedInMessage(jeansConv.conversationId, '[ছবি]', 'image', JEANS_IMG);
  const photoRes = await processBatch(workspaceId, jeansConv.conversationId, [
    { body: '[ছবি]', mediaType: 'image', mediaUrl: JEANS_IMG },
  ]);
  const photoOuts = await outMessages(jeansConv.conversationId);
  const photoMatched = photoRes.replied && /Jeans/.test(photoOuts[0] ?? '');
  await seedInMessage(jeansConv.conversationId, 'এই প্রোডাক্টটি কি জিন্স?');
  const qRes = await processBatch(workspaceId, jeansConv.conversationId, [
    { body: 'এই প্রোডাক্টটি কি জিন্স?', mediaType: null },
  ]);
  const qOuts = await outMessages(jeansConv.conversationId);
  const qReply = qOuts[qOuts.length - 1] ?? '';
  out.jeansYesNo = {
    photoMatched,
    replied: qRes.replied,
    reply: qReply,
    ok:
      photoMatched &&
      qRes.replied &&
      countLines(qReply) <= 2 &&
      /হ্যাঁ/.test(qReply) &&
      /জিন্স/.test(qReply) &&
      !/আমাদের কাছে অনেক/.test(qReply),
  };

  // --- Live 2: "অন্য কোনো কালারে আছে?" → one short "no" ---
  await seedInMessage(jeansConv.conversationId, 'অন্য কোনো কালারে আছে?');
  const cRes = await processBatch(workspaceId, jeansConv.conversationId, [
    { body: 'অন্য কোনো কালারে আছে?', mediaType: null },
  ]);
  const cOuts = await outMessages(jeansConv.conversationId);
  const cReply = cOuts[cOuts.length - 1] ?? '';
  out.otherColour = {
    replied: cRes.replied,
    reply: cReply,
    ok:
      cRes.replied &&
      countLines(cReply) <= 2 &&
      /না/.test(cReply) &&
      /কালার/.test(cReply) &&
      !/আমাদের কাছে অনেক/.test(cReply),
  };

  // --- Live 3: a price question → short, with the right price ---
  const priceConv = await seedConversation('লাইভ দাম কাস্টমার');
  await seedInMessage(priceConv.conversationId, 'Jeans এর দাম কত?');
  const pRes = await processBatch(workspaceId, priceConv.conversationId, [
    { body: 'Jeans এর দাম কত?', mediaType: null },
  ]);
  const pOuts = await outMessages(priceConv.conversationId);
  const pReply = pOuts[0] ?? '';
  out.priceShort = {
    replied: pRes.replied,
    reply: pReply,
    ok: pRes.replied && countLines(pReply) <= 2 && /৫০০/.test(pReply) && pReply.length <= 200,
  };

  // --- Live 4: shop location still one line with a real provider ---
  const locConv = await seedConversation('লাইভ ঠিকানা কাস্টমার');
  await seedInMessage(locConv.conversationId, 'দোকান কোথায়?');
  const lRes = await processBatch(workspaceId, locConv.conversationId, [
    { body: 'দোকান কোথায়?', mediaType: null },
  ]);
  const lOuts = await outMessages(locConv.conversationId);
  const lReply = lOuts[0] ?? '';
  out.shopLocationLive = {
    replied: lRes.replied,
    reason: lRes.reason,
    reply: lReply,
    ok: lRes.replied && lRes.reason === 'shop_location' && countLines(lReply) === 1 && lReply.includes('মাগুরায়'),
  };

  console.log('LIVE_DRIVER_RESULT ' + JSON.stringify(out));
  process.exit(0);
}

main().catch((err) => {
  console.error('LIVE_DRIVER_ERROR', err);
  process.exit(1);
});
