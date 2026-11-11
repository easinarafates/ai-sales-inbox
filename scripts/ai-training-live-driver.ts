// LIVE driver for verify-ai-training.mjs — tests the Gemini-powered
// behaviours (photo match, voice, Banglish LLM reply, product-push
// limit) DIRECTLY against the same PGlite dir the verifier's API boot
// uses. Run AFTER the demo driver (which seeds the products +
// knowledge), with the REAL Gemini key in the environment:
//   USE_PGLITE=true PGLITE_DATA_DIR=<dir> GEMINI_API_KEY=<real key> \
//     npx tsx scripts/ai-training-live-driver.ts <workspaceId> <jeansId> <tshirtId> <shirtId> <channelId>
// Prints one LIVE_DRIVER_RESULT JSON line for the verifier to parse.
// No secrets are printed. If GEMINI_API_KEY is missing, it exits 0
// with { skipped: true } (the verifier reports it as skipped, not a pass).
import { pool } from '../apps/api/src/db/pool';
import { processBatch } from '../apps/api/src/ai-agent/agent';
import { analyseCustomerImage, transcribeCustomerAudio } from '../apps/api/src/ai-agent/media';

const [workspaceId, jeansId, tshirtId, shirtId, channelId] = process.argv.slice(2);

const JEANS_IMG = 'https://wzal8khi0daufwg8.public.blob.vercel-storage.com/308ad456-0ac0-413b-a8f0-5cb5f786f80e.png';
const TSHIRT_IMG = 'https://wzal8khi0daufwg8.public.blob.vercel-storage.com/a952912b-1ab3-4cc2-a975-2a37080d1278.png';
const SHIRT_IMG = 'https://wzal8khi0daufwg8.public.blob.vercel-storage.com/50127be0-72be-4ac7-99ff-82fee4efa5eb.png';
const BICYCLE_IMG = 'https://upload.wikimedia.org/wikipedia/commons/a/a7/Ordinary_bicycle01.jpg';
// One Bengali word ("খোলা") spoken aloud (Lingua Libre, Wikimedia Commons).
const BENGALI_VOICE = 'https://upload.wikimedia.org/wikipedia/commons/transcoded/f/fa/LL-Q9610_%28ben%29-Titodutta-%E0%A6%96%E0%A7%8B%E0%A6%B2%E0%A6%BE.wav/LL-Q9610_%28ben%29-Titodutta-%E0%A6%96%E0%A7%8B%E0%A6%B2%E0%A6%BE.wav.mp3';

const out: Record<string, unknown> = {};
let n = 100;

async function seedConversation(customerName: string): Promise<{ customerId: string; conversationId: string }> {
  n += 1;
  const c = await pool.query(
    `INSERT INTO customers (workspace_id, name, gender, channel_identities) VALUES ($1, $2, 'male', $3::jsonb) RETURNING id`,
    [workspaceId, customerName, JSON.stringify([{ platform: 'webchat', senderId: `live-${n}` }])],
  );
  const customerId = c.rows[0].id as string;
  const cv = await pool.query(
    `INSERT INTO conversations (workspace_id, channel_id, customer_id, status, mode) VALUES ($1, $2, $3, 'open', 'ai') RETURNING id`,
    [workspaceId, channelId, customerId],
  );
  return { customerId, conversationId: cv.rows[0].id as string };
}

async function convState(conversationId: string): Promise<Record<string, unknown>> {
  const r = await pool.query(
    'SELECT status, mode, escalation_reason FROM conversations WHERE id = $1',
    [conversationId],
  );
  return (r.rows[0] as Record<string, unknown>) ?? {};
}

async function outMessages(conversationId: string): Promise<{ body: string | null; type: string }[]> {
  const r = await pool.query(
    "SELECT body, type FROM messages WHERE workspace_id = $1 AND conversation_id = $2 AND direction = 'out' ORDER BY created_at ASC",
    [workspaceId, conversationId],
  );
  return (r.rows as { body: string | null; type: string }[]).map((row) => ({ body: row.body ?? '', type: row.type }));
}

async function seedOutMessage(conversationId: string, body: string): Promise<void> {
  await pool.query(
    "INSERT INTO messages (workspace_id, conversation_id, direction, type, body) VALUES ($1, $2, 'out', 'text', $3)",
    [workspaceId, conversationId, body],
  );
}

async function main(): Promise<void> {
  if (!process.env.GEMINI_API_KEY) {
    console.log('LIVE_DRIVER_RESULT ' + JSON.stringify({ skipped: true, reason: 'no GEMINI_API_KEY' }));
    await pool.end();
    return;
  }
  if (!workspaceId || !jeansId || !tshirtId || !shirtId || !channelId) {
    console.error('usage: ai-training-live-driver.ts <workspaceId> <jeansId> <tshirtId> <shirtId> <channelId>');
    process.exit(2);
  }

  // Product images (the real catalog photos) so vision can compare.
  await pool.query(
    `INSERT INTO product_images (workspace_id, product_id, url) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [workspaceId, jeansId, JEANS_IMG],
  );
  await pool.query(
    `INSERT INTO product_images (workspace_id, product_id, url) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [workspaceId, tshirtId, TSHIRT_IMG],
  );
  await pool.query(
    `INSERT INTO product_images (workspace_id, product_id, url) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [workspaceId, shirtId, SHIRT_IMG],
  );

  // --- Vision unit: Jeans photo matches Jeans; bicycle matches nothing ---
  const catalog = [
    { id: jeansId, name: 'Jeans', pricePaisa: 50000, stock: 10, description: null, imageUrl: JEANS_IMG },
    { id: tshirtId, name: 'T-shirt', pricePaisa: 40000, stock: 9, description: null, imageUrl: TSHIRT_IMG },
    { id: shirtId, name: 'Shirt', pricePaisa: 60000, stock: 10, description: null, imageUrl: SHIRT_IMG },
  ];
  const jeansMatch = await analyseCustomerImage(JEANS_IMG, catalog);
  out.visionJeans = { matchedId: jeansMatch?.matchedId ?? null, confidence: jeansMatch?.confidence ?? 0, description: jeansMatch?.description ?? '' };
  // Vision-only (no shortcut): the T-shirt photo against a catalog WITHOUT
  // product images — the exact-URL shortcut cannot fire, so the vision
  // model must genuinely recognise the navy t-shirt from the photo itself.
  const catalogNoImages = catalog.map((p) => ({ ...p, imageUrl: null }));
  const tshirtVision = await analyseCustomerImage(TSHIRT_IMG, catalogNoImages);
  out.visionTshirtNoImages = { matchedId: tshirtVision?.matchedId ?? null, confidence: tshirtVision?.confidence ?? 0, description: tshirtVision?.description ?? '' };
  const bikeMatch = await analyseCustomerImage(BICYCLE_IMG, catalog);
  out.visionBicycle = { matchedId: bikeMatch?.matchedId ?? null, similarIds: bikeMatch?.similarIds ?? [], description: bikeMatch?.description ?? '' };

  // --- Voice unit: the Bengali sample transcribes ---
  const transcript = await transcribeCustomerAudio(BENGALI_VOICE);
  out.voiceTranscript = { transcript };

  // --- Photo match, in stock: Jeans photo → Jeans + ৳500 ---
  {
    const { conversationId } = await seedConversation('Photo Jeans Customer');
    const result = await processBatch(workspaceId, conversationId, [{ body: '[ছবি]', mediaType: 'image', mediaUrl: JEANS_IMG }]);
    const state = await convState(conversationId);
    const bodies = await outMessages(conversationId);
    const text = bodies.map((b) => b.body ?? '').join('\n');
    out.photoInStock = {
      conversationId, result, state, outBodies: bodies,
      namesJeans: text.includes('Jeans') && text.includes('500'),
      hasPhoto: bodies.some((b) => b.type === 'image'),
    };
  }

  // --- Photo match, out of stock: Shirt stock → 0, Shirt photo → "স্টক আউট" ---
  {
    await pool.query('UPDATE products SET stock = 0 WHERE workspace_id = $1 AND id = $2', [workspaceId, shirtId]);
    const { conversationId } = await seedConversation('Photo Shirt Customer');
    const result = await processBatch(workspaceId, conversationId, [{ body: '[ছবি]', mediaType: 'image', mediaUrl: SHIRT_IMG }]);
    const state = await convState(conversationId);
    const bodies = await outMessages(conversationId);
    const text = bodies.map((b) => b.body ?? '').join('\n');
    out.photoOutOfStock = {
      conversationId, result, state, outBodies: bodies,
      saysOutOfStock: text.includes('স্টক আউট') && text.includes('Shirt'),
    };
    // Restore the stock for later tests.
    await pool.query('UPDATE products SET stock = 10 WHERE workspace_id = $1 AND id = $2', [workspaceId, shirtId]);
  }

  // --- Photo match, not our product: bicycle → "নেই" + similar products ---
  {
    const { conversationId } = await seedConversation('Photo Bicycle Customer');
    const result = await processBatch(workspaceId, conversationId, [{ body: '[ছবি]', mediaType: 'image', mediaUrl: BICYCLE_IMG }]);
    const state = await convState(conversationId);
    const bodies = await outMessages(conversationId);
    const text = bodies.map((b) => b.body ?? '').join('\n');
    out.photoNotFound = {
      conversationId, result, state, outBodies: bodies,
      saysNotOurs: text.includes('আমাদের কাছে নেই'),
      listsSimilar: text.includes('Jeans') || text.includes('T-shirt') || text.includes('Shirt'),
    };
  }

  // --- Voice note → transcribed → text reply (not the "শুনতে পারিনি" fallback) ---
  {
    const { conversationId } = await seedConversation('Voice Customer');
    const result = await processBatch(workspaceId, conversationId, [{ body: '[ভয়েস মেসেজ]', mediaType: 'audio', mediaUrl: BENGALI_VOICE }]);
    const state = await convState(conversationId);
    const bodies = await outMessages(conversationId);
    const text = bodies.map((b) => b.body ?? '').join('\n');
    out.voiceFlow = {
      conversationId, result, state, outBodies: bodies,
      notUnheard: !text.includes('শুনতে পারিনি'),
      replied: result.replied === true,
    };
  }

  // --- Voice note that cannot be fetched → honest "শুনতে পারিনি" reply ---
  {
    const { conversationId } = await seedConversation('Voice Fail Customer');
    const result = await processBatch(workspaceId, conversationId, [{ body: '[ভয়েস মেসেজ]', mediaType: 'audio', mediaUrl: 'https://example.invalid/no-such-audio.mp3' }]);
    const state = await convState(conversationId);
    const bodies = await outMessages(conversationId);
    const text = bodies.map((b) => b.body ?? '').join('\n');
    out.voiceFail = {
      conversationId, result, state, outBodies: bodies,
      honestFallback: text.includes('শুনতে পারিনি'),
    };
  }

  // --- Banglish → Bengali reply (real LLM): "tumi" in, "আপনি" out ---
  {
    const { conversationId } = await seedConversation('Banglish LLM Customer');
    const result = await processBatch(workspaceId, conversationId, [{ body: 'tumi kemon aso, jeans er dam koto' }]);
    const state = await convState(conversationId);
    const bodies = await outMessages(conversationId);
    const text = bodies.map((b) => b.body ?? '').join('\n');
    const hasBengali = /[\u0980-\u09FF]/.test(text);
    const hasBanglishProse = /tumi kemon|er dam koto/i.test(text);
    out.banglishLlm = {
      conversationId, result, state, outBodies: bodies,
      hasBengali, hasBanglishProse, hasPrice: text.includes('500') || text.includes('৫০০'),
      politeApni: text.includes('আপনি') || text.includes('স্যার'),
    };
  }

  // --- Product-push limit (real LLM): 2 product mentions already, then a
  // delivery question → the reply answers delivery WITHOUT pushing products ---
  {
    const { conversationId } = await seedConversation('Push Limit Customer');
    await seedOutMessage(conversationId, 'স্যার, আমাদের প্রোডাক্টগুলো:\n• Jeans — ৳500\n• T-shirt — ৳400');
    await seedOutMessage(conversationId, 'স্যার, Jeans-এর দাম ৳৫০০।');
    const result = await processBatch(workspaceId, conversationId, [{ body: 'ঢাকার বাইরে ডেলিভারি চার্জ কত?' }]);
    const state = await convState(conversationId);
    const bodies = await outMessages(conversationId);
    const last = bodies[bodies.length - 1]?.body ?? '';
    out.productPush = {
      conversationId, result, state, outBodies: bodies,
      answersDelivery: last.includes('১৩০') || last.includes('130'),
      noProductPush: !last.includes('Jeans') && !last.includes('T-shirt') && !last.includes('Shirt') && !last.includes('টি-শার্ট'),
    };
  }

  console.log('LIVE_DRIVER_RESULT ' + JSON.stringify(out));
  await pool.end();
}

main().catch((err) => {
  console.error('live driver crashed:', err);
  process.exit(1);
});
