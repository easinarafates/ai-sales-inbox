// Driver for verify-photo-vision.mjs — proves the Gemini-vision photo
// rebuild (2026-11-12) against the same PGlite dir the verifier's API
// boot uses. Run AFTER the API boot stops (PGlite is single-process;
// the API holds the lock while it runs), with:
//   USE_PGLITE=true PGLITE_DATA_DIR=<dir> GEMINI_API_KEY=<real key> \
//     npx tsx scripts/photo-vision-driver.ts <workspaceId> <jeansId> <tshirtId> <shirtId> <channelId> <treePngPath> <carJpgPath>
// Prints one PHOTO_VISION_RESULT JSON line for the verifier to parse.
// No secrets are printed. If GEMINI_API_KEY is missing, it exits 0
// with { skipped: true } (the verifier reports it as skipped, not a pass).
//
// WHAT THIS PROVES (the 2026-11-12 rebuild):
// 1. The match_product_by_image TOOL now uses Gemini vision as PRIMARY
//    (was: embeddings only, no provider on live -> always
//    available:false -> "ছবি দিয়ে খোঁজা এখনো চালু হয়নি").
// 2. The deterministic image branch fires for the MOST RECENT image in
//    the batch (was: only when the LAST message was the image) — a
//    photo followed by "Ata ase?" in the same batch used to skip vision
//    and let the LLM fake a "সিমিলার প্রোডাক্ট" list (the car-photo
//    bug: a CAR photo got Jeans/T-shirt/Shirt as "similar").
// 3. A car photo (a product the shop does NOT carry) gets an honest
//    "আমাদের কাছে নেই" with NO similar list, NO names, NO prices.
// 4. An out-of-stock match gets "স্টক আউট".
// 5. Exactly ONE ledger row per image reply, carrying the REAL vision
//    tokens.
//
// ALL messages here are SIMULATED test messages against a local test
// workspace — never live customer messages.
import fs from 'node:fs';
import { pool } from '../apps/api/src/db/pool';
import { processBatch } from '../apps/api/src/ai-agent/agent';
import { matchProductsByImage } from '../apps/api/src/ai-agent/image-match';

const [workspaceId, jeansId, tshirtId, shirtId, channelId, treePath, carPath] =
  process.argv.slice(2);

// The shop's REAL product photos (same Blob URLs the live catalog uses).
const JEANS_IMG = 'https://wzal8khi0daufwg8.public.blob.vercel-storage.com/308ad456-0ac0-413b-a8f0-5cb5f786f80e.png';
const TSHIRT_IMG = 'https://wzal8khi0daufwg8.public.blob.vercel-storage.com/a952912b-1ab3-4cc2-a975-2a37080d1278.png';
const SHIRT_IMG = 'https://wzal8khi0daufwg8.public.blob.vercel-storage.com/50127be0-72be-4ac7-99ff-82fee4efa5eb.png';
const BICYCLE_IMG = 'https://upload.wikimedia.org/wikipedia/commons/a/a7/Ordinary_bicycle01.jpg';

const out: Record<string, unknown> = {};
let n = 300;

async function seedConversation(wsId: string, chId: string, customerName: string): Promise<{ customerId: string; conversationId: string }> {
  n += 1;
  const c = await pool.query(
    `INSERT INTO customers (workspace_id, name, gender, channel_identities) VALUES ($1, $2, 'male', $3::jsonb) RETURNING id`,
    [wsId, customerName, JSON.stringify([{ platform: 'webchat', senderId: `pv-${n}` }])],
  );
  const customerId = c.rows[0].id as string;
  const cv = await pool.query(
    `INSERT INTO conversations (workspace_id, channel_id, customer_id, status, mode) VALUES ($1, $2, $3, 'open', 'ai') RETURNING id`,
    [wsId, chId, customerId],
  );
  return { customerId, conversationId: cv.rows[0].id as string };
}

async function outBodies(wsId: string, conversationId: string): Promise<string[]> {
  const r = await pool.query(
    "SELECT body FROM messages WHERE workspace_id = $1 AND conversation_id = $2 AND direction = 'out' ORDER BY created_at ASC",
    [wsId, conversationId],
  );
  return (r.rows as { body: string | null }[]).map((row) => row.body ?? '');
}

async function ledgerRows(wsId: string, conversationId: string): Promise<{ input_tokens: number; output_tokens: number; cost_paisa: number; provider_cost_paisa: number; model: string }[]> {
  const r = await pool.query(
    'SELECT input_tokens, output_tokens, cost_paisa, provider_cost_paisa, model FROM ai_usage_ledger WHERE workspace_id = $1 AND conversation_id = $2 ORDER BY created_at ASC',
    [wsId, conversationId],
  );
  return r.rows as { input_tokens: number; output_tokens: number; cost_paisa: number; provider_cost_paisa: number; model: string }[];
}

const NO_PRODUCT_NAMES = (text: string): boolean =>
  !text.includes('Jeans') && !text.includes('T-shirt') && !text.includes('Shirt') && !text.includes('টি-শার্ট');

/** Free-tier Gemini is rate-limited — pause between vision calls so a transient 429 never turns a good photo into a "দেখতে পারিনি". */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const PAUSE_MS = 8000;

async function main(): Promise<void> {
  if (!process.env.GEMINI_API_KEY) {
    console.log('PHOTO_VISION_RESULT ' + JSON.stringify({ skipped: true }));
    return;
  }
  if (!workspaceId || !jeansId || !tshirtId || !shirtId || !channelId || !treePath || !carPath) {
    console.error('usage: photo-vision-driver.ts <workspaceId> <jeansId> <tshirtId> <shirtId> <channelId> <treePngPath> <carJpgPath>');
    process.exit(2);
  }
  const treeDataUrl = 'data:image/png;base64,' + fs.readFileSync(treePath).toString('base64');
  const carDataUrl = 'data:image/jpeg;base64,' + fs.readFileSync(carPath).toString('base64');
  // --- Seed: product photos. T-shirt deliberately gets NO product_images
  // row, so its match must come from REAL vision (photo + catalog text),
  // never from the exact-URL shortcut. ---
  await pool.query(
    `INSERT INTO product_images (workspace_id, product_id, url) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [workspaceId, jeansId, JEANS_IMG],
  );
  await pool.query(
    `INSERT INTO product_images (workspace_id, product_id, url) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [workspaceId, shirtId, SHIRT_IMG],
  );

  // ===== TOOL TESTS — matchProductsByImage (Gemini vision, primary) =====
  // (1) T-shirt, PURE vision (no catalog image row -> no exact-URL shortcut):
  // must match T-shirt ৳400 by vision alone, and report real token usage.
  out.toolTshirt = await matchProductsByImage(workspaceId, TSHIRT_IMG, 3);
  await sleep(PAUSE_MS);
  // (2) Jeans, exact-URL shortcut (the shop's own photo): matches without
  // a vision call — usage is honestly null (0 tokens), not faked.
  out.toolJeans = await matchProductsByImage(workspaceId, JEANS_IMG, 3);
  await sleep(PAUSE_MS);
  // (3) Tree — not a product at all: NO matches, honest message, vision method.
  out.toolTree = await matchProductsByImage(workspaceId, treeDataUrl, 3);
  await sleep(PAUSE_MS);
  // (4) Car — a product the shop does NOT carry: NO matches, "আমাদের কাছে নেই".
  out.toolCar = await matchProductsByImage(workspaceId, carDataUrl, 3);
  await sleep(PAUSE_MS);
  // (5) Bicycle — a product, but NOT ours: NO matches, "আমাদের কাছে নেই".
  out.toolBicycle = await matchProductsByImage(workspaceId, BICYCLE_IMG, 3);
  await sleep(PAUSE_MS);

  // ===== FLOW TESTS — processBatch (the live path) =====
  // Diagnostic: the subscription gate needs a positive wallet balance
  // (signup grants ৳50 = 5000 paisa). Log it so a blocked flow test
  // is diagnosable instead of mysterious.
  {
    const wsRow = await pool.query('SELECT balance_paisa, reply_credits, practice_mode FROM workspaces WHERE id = $1', [workspaceId]);
    const subRow = await pool.query('SELECT status, current_period_end FROM workspace_subscriptions WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1', [workspaceId]);
    out.workspaceBalance = { balancePaisa: wsRow.rows[0]?.balance_paisa, replyCredits: wsRow.rows[0]?.reply_credits, practiceMode: wsRow.rows[0]?.practice_mode, subscription: subRow.rows[0] ?? null };
  }
  // (6) PHOTO + TEXT IN THE SAME BATCH — the 2026-11-12 trigger fix.
  // The customer sends the T-shirt photo, then "Ata ase?" 3 seconds
  // later; both land in one batch. The OLD code only ran vision when
  // the LAST message was the image, so this batch skipped vision and
  // the LLM faked a "সিমিলার" list. Now vision must run on the most
  // recent image in the batch and name the T-shirt at ৳400.
  {
    const { conversationId } = await seedConversation(workspaceId, channelId, 'Photo Plus Text Customer');
    const result = await processBatch(workspaceId, conversationId, [
      { body: '[ছবি]', mediaType: 'image', mediaUrl: TSHIRT_IMG },
      { body: 'Ata ase?' },
    ]);
    const bodies = await outBodies(workspaceId, conversationId);
    const text = bodies.join('\n');
    out.flowPhotoPlusText = {
      conversationId, result, outBodies: bodies,
      namesTshirt: text.includes('T-shirt'),
      hasRightPrice: text.includes('৳400') || text.includes('৪০০'),
      noSimilarClaim: !text.includes('সিমিলার'),
      ledger: await ledgerRows(workspaceId, conversationId),
    };
  }

  // (7) CAR PHOTO + TEXT — the EXACT user scenario (2026-11-11: a car
  // photo got Jeans/T-shirt/Shirt as "similar"). Must say honestly
  // "আমাদের কাছে নেই" — NO similar list, NO product names, NO prices.
  {
    await sleep(PAUSE_MS);
    const { conversationId } = await seedConversation(workspaceId, channelId, 'Car Photo Customer');
    const result = await processBatch(workspaceId, conversationId, [
      { body: '[ছবি]', mediaType: 'image', mediaUrl: carDataUrl },
      { body: 'Ata ase?' },
    ]);
    const bodies = await outBodies(workspaceId, conversationId);
    const text = bodies.join('\n');
    out.flowCarPlusText = {
      conversationId, result, outBodies: bodies,
      saysNotOurs: text.includes('আমাদের কাছে নেই'),
      noSimilarClaim: !text.includes('সিমিলার'),
      noProductNames: NO_PRODUCT_NAMES(text),
      noPrices: !text.includes('৳'),
      ledger: await ledgerRows(workspaceId, conversationId),
    };
  }

  // (8) Tree photo alone — not a product at all.
  {
    await sleep(PAUSE_MS);
    const { conversationId } = await seedConversation(workspaceId, channelId, 'Tree Photo Customer');
    const result = await processBatch(workspaceId, conversationId, [{ body: '[ছবি]', mediaType: 'image', mediaUrl: treeDataUrl }]);
    const bodies = await outBodies(workspaceId, conversationId);
    const text = bodies.join('\n');
    out.flowTree = {
      conversationId, result, outBodies: bodies,
      saysNotAProduct: text.includes('কোনো প্রোডাক্ট দেখা যাচ্ছে না'),
      noSimilarClaim: !text.includes('সিমিলার'),
      noProductNames: NO_PRODUCT_NAMES(text),
      ledger: await ledgerRows(workspaceId, conversationId),
    };
  }

  // (9) Text-only shop question still works (no regression).
  {
    await sleep(PAUSE_MS);
    const { conversationId } = await seedConversation(workspaceId, channelId, 'Text Question Customer');
    const result = await processBatch(workspaceId, conversationId, [{ body: 'জিন্সের দাম কত?' }]);
    const bodies = await outBodies(workspaceId, conversationId);
    const text = bodies.join('\n');
    out.flowText = {
      conversationId, result, outBodies: bodies,
      hasPrice: text.includes('500') || text.includes('৫০০'),
    };
  }

  // (10) Out of stock — Jeans stock set to 0, then the Jeans photo.
  // Must say "স্টক আউট", never claim it is available.
  {
    await sleep(PAUSE_MS);
    await pool.query(`UPDATE products SET stock = 0 WHERE id = $1`, [jeansId]);
    const { conversationId } = await seedConversation(workspaceId, channelId, 'Out Of Stock Customer');
    const result = await processBatch(workspaceId, conversationId, [{ body: '[ছবি]', mediaType: 'image', mediaUrl: JEANS_IMG }]);
    const bodies = await outBodies(workspaceId, conversationId);
    const text = bodies.join('\n');
    out.flowOutOfStock = {
      conversationId, result, outBodies: bodies,
      saysOutOfStock: text.includes('স্টক আউট'),
      namesJeans: text.includes('Jeans'),
      ledger: await ledgerRows(workspaceId, conversationId),
    };
  }

  console.log('PHOTO_VISION_RESULT ' + JSON.stringify(out));
  await pool.end();
}

main().catch((err) => {
  console.error('photo vision driver crashed:', err);
  process.exit(1);
});
