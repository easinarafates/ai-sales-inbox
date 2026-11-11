// Driver for verify-image-understanding.mjs — tests REAL Gemini vision
// photo matching DIRECTLY against the same PGlite dir the verifier's API
// boot uses. Run AFTER the API boot stops (PGlite is single-process;
// the API holds the lock while it runs), with:
//   USE_PGLITE=true PGLITE_DATA_DIR=<dir> GEMINI_API_KEY=<real key> \
//     npx tsx scripts/image-understanding-driver.ts <workspaceId> <jeansId> <tshirtId> <shirtId> <channelId> <treePngPath> <workspace2Id> <workspace2ChannelId>
// Prints one IMAGE_DRIVER_RESULT JSON line for the verifier to parse.
// No secrets are printed. If GEMINI_API_KEY is missing, it exits 0
// with { skipped: true } (the verifier reports it as skipped, not a pass).
//
// ALL messages here are SIMULATED test messages against a local test
// workspace — never live customer messages.
import fs from 'node:fs';
import { pool } from '../apps/api/src/db/pool';
import { processBatch } from '../apps/api/src/ai-agent/agent';
import { analyseCustomerImage } from '../apps/api/src/ai-agent/media';

const [workspaceId, jeansId, tshirtId, shirtId, channelId, treePath, workspace2Id, workspace2ChannelId] =
  process.argv.slice(2);

// The shop's REAL product photos (same Blob URLs the live AI-training
// driver uses) + a real non-product photo (bicycle, Wikimedia).
const JEANS_IMG = 'https://wzal8khi0daufwg8.public.blob.vercel-storage.com/308ad456-0ac0-413b-a8f0-5cb5f786f80e.png';
const TSHIRT_IMG = 'https://wzal8khi0daufwg8.public.blob.vercel-storage.com/a952912b-1ab3-4cc2-a975-2a37080d1278.png';
const SHIRT_IMG = 'https://wzal8khi0daufwg8.public.blob.vercel-storage.com/50127be0-72be-4ac7-99ff-82fee4efa5eb.png';
const BICYCLE_IMG = 'https://upload.wikimedia.org/wikipedia/commons/a/a7/Ordinary_bicycle01.jpg';
// Tree photo: a LOCAL file (scripts/test-images/tree.png, drawn locally),
// sent as a data: URL so no live image is hotlinked. Read inside main()
// (after the arg check) so a missing path fails with the usage message,
// not an import-time crash.

const out: Record<string, unknown> = {};
let n = 200;

async function seedConversation(wsId: string, chId: string, customerName: string): Promise<{ customerId: string; conversationId: string }> {
  n += 1;
  const c = await pool.query(
    `INSERT INTO customers (workspace_id, name, gender, channel_identities) VALUES ($1, $2, 'male', $3::jsonb) RETURNING id`,
    [wsId, customerName, JSON.stringify([{ platform: 'webchat', senderId: `img-${n}` }])],
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

/** Free-tier Gemini is rate-limited — pause between vision/LLM calls so
 * a transient 429 never turns a good photo into a "দেখতে পারিনি". */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const PAUSE_MS = 8000;

async function main(): Promise<void> {
  if (!process.env.GEMINI_API_KEY) {
    console.log('IMAGE_DRIVER_RESULT ' + JSON.stringify({ skipped: true }));
    return;
  }
  if (!workspaceId || !jeansId || !tshirtId || !shirtId || !channelId || !treePath || !workspace2Id || !workspace2ChannelId) {
    console.error('usage: image-understanding-driver.ts <workspaceId> <jeansId> <tshirtId> <shirtId> <channelId> <treePngPath> <workspace2Id> <workspace2ChannelId>');
    process.exit(2);
  }
  const treeDataUrl = 'data:image/png;base64,' + fs.readFileSync(treePath).toString('base64');
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

  const catalog = [
    { id: jeansId, name: 'Jeans', pricePaisa: 50000, stock: 10, description: null, imageUrl: JEANS_IMG },
    { id: tshirtId, name: 'T-shirt', pricePaisa: 40000, stock: 9, description: null, imageUrl: TSHIRT_IMG },
    { id: shirtId, name: 'Shirt', pricePaisa: 60000, stock: 10, description: null, imageUrl: SHIRT_IMG },
  ];
  const catalogNoImages = catalog.map((p) => ({ ...p, imageUrl: null }));

  // --- Vision unit: tree is NOT a product; bicycle is a product but NOT ours; T-shirt matches by vision alone ---
  const treeVision = await analyseCustomerImage(treeDataUrl, catalog);
  out.visionTree = {
    matchedId: treeVision?.matchedId ?? null,
    isProduct: treeVision?.isProduct ?? null,
    confidence: treeVision?.confidence ?? null,
    similarIds: treeVision?.similarIds ?? null,
    hasUsage: !!treeVision?.usage && treeVision.usage.inputTokens > 0,
    description: treeVision?.description ?? '',
  };
  await sleep(PAUSE_MS);
  const bikeVision = await analyseCustomerImage(BICYCLE_IMG, catalog);
  out.visionBicycle = {
    matchedId: bikeVision?.matchedId ?? null,
    isProduct: bikeVision?.isProduct ?? null,
    confidence: bikeVision?.confidence ?? null,
    similarIds: bikeVision?.similarIds ?? null,
    hasUsage: !!bikeVision?.usage && bikeVision.usage.inputTokens > 0,
    description: bikeVision?.description ?? '',
  };
  const tshirtVision = await analyseCustomerImage(TSHIRT_IMG, catalogNoImages);
  out.visionTshirtNoImages = {
    matchedId: tshirtVision?.matchedId ?? null,
    confidence: tshirtVision?.confidence ?? null,
    isProduct: tshirtVision?.isProduct ?? null,
  };
  await sleep(PAUSE_MS);

  // --- (a) NON-product photo (tree) through the real flow ---
  {
    const { conversationId } = await seedConversation(workspaceId, channelId, 'Tree Photo Customer');
    const result = await processBatch(workspaceId, conversationId, [{ body: '[ছবি]', mediaType: 'image', mediaUrl: treeDataUrl }]);
    const bodies = await outBodies(workspaceId, conversationId);
    const text = bodies.join('\n');
    out.treePhoto = {
      conversationId, result, outBodies: bodies,
      saysNotAProduct: text.includes('কোনো প্রোডাক্ট দেখা যাচ্ছে না'),
      noSimilarClaim: !text.includes('সিমিলার'),
      noProductNames: NO_PRODUCT_NAMES(text),
      ledger: await ledgerRows(workspaceId, conversationId),
    };
  }

  // --- (c) Product photo that matches NOTHING (bicycle) ---
  {
    await sleep(PAUSE_MS);
    const { conversationId } = await seedConversation(workspaceId, channelId, 'Bicycle Photo Customer');
    const result = await processBatch(workspaceId, conversationId, [{ body: '[ছবি]', mediaType: 'image', mediaUrl: BICYCLE_IMG }]);
    const bodies = await outBodies(workspaceId, conversationId);
    const text = bodies.join('\n');
    out.bicyclePhoto = {
      conversationId, result, outBodies: bodies,
      saysNotOurs: text.includes('আমাদের কাছে নেই'),
      noSimilarClaim: !text.includes('সিমিলার'),
      noProductNames: NO_PRODUCT_NAMES(text),
      noPrices: !text.includes('৳'),
      ledger: await ledgerRows(workspaceId, conversationId),
    };
  }

  // --- (b1) REAL product photo, in stock (Jeans ৳500 — exact-URL shortcut: the shop's own photo) ---
  {
    await sleep(PAUSE_MS);
    const { conversationId } = await seedConversation(workspaceId, channelId, 'Jeans Photo Customer');
    const result = await processBatch(workspaceId, conversationId, [{ body: '[ছবি]', mediaType: 'image', mediaUrl: JEANS_IMG }]);
    const bodies = await outBodies(workspaceId, conversationId);
    const text = bodies.join('\n');
    out.jeansPhoto = {
      conversationId, result, outBodies: bodies,
      namesJeans: text.includes('Jeans'),
      hasRightPrice: text.includes('৳500') || text.includes('৫০০'),
      ledger: await ledgerRows(workspaceId, conversationId),
    };
  }

  // --- (b2) REAL product photo, in stock, PURE vision (T-shirt ৳400 — no catalog image, no shortcut) ---
  {
    await sleep(PAUSE_MS);
    const { conversationId } = await seedConversation(workspaceId, channelId, 'Tshirt Photo Customer');
    const result = await processBatch(workspaceId, conversationId, [{ body: '[ছবি]', mediaType: 'image', mediaUrl: TSHIRT_IMG }]);
    const bodies = await outBodies(workspaceId, conversationId);
    const text = bodies.join('\n');
    out.tshirtPhoto = {
      conversationId, result, outBodies: bodies,
      namesTshirt: text.includes('T-shirt'),
      hasRightPrice: text.includes('৳400') || text.includes('৪০০'),
      ledger: await ledgerRows(workspaceId, conversationId),
    };
  }

  // --- (e) Text-only shop question still works (no regression) ---
  {
    await sleep(PAUSE_MS);
    const { conversationId } = await seedConversation(workspaceId, channelId, 'Text Question Customer');
    const result = await processBatch(workspaceId, conversationId, [{ body: 'জিন্সের দাম কত?' }]);
    const bodies = await outBodies(workspaceId, conversationId);
    const text = bodies.join('\n');
    out.textQuestion = {
      conversationId, result, outBodies: bodies,
      hasPrice: text.includes('500') || text.includes('৫০০'),
    };
  }

  // --- Old (Page-Read) product, second workspace: NO live products, only
  // a CONFIRMED old product whose photo is the T-shirt image. Sending
  // that photo must name the OLD product, quote its old price, and NEVER
  // claim stock. ---
  {
    await pool.query(
      `INSERT INTO page_read_products (workspace_id, name, price_paisa, description, photo_url, status)
       VALUES ($1, 'পুরোনো পাঞ্জাবি', 80000, 'পেজের পুরোনো পোস্ট থেকে শেখা পাঞ্জাবি', $2, 'confirmed')`,
      [workspace2Id, TSHIRT_IMG],
    );
    const { conversationId } = await seedConversation(workspace2Id, workspace2ChannelId, 'Old Product Customer');
    const result = await processBatch(workspace2Id, conversationId, [{ body: '[ছবি]', mediaType: 'image', mediaUrl: TSHIRT_IMG }]);
    const bodies = await outBodies(workspace2Id, conversationId);
    const text = bodies.join('\n');
    out.oldProductPhoto = {
      conversationId, result, outBodies: bodies,
      namesOldProduct: text.includes('পুরোনো পাঞ্জাবি'),
      saysOld: text.includes('পুরোনো'),
      hasOldPrice: text.includes('৳800') || text.includes('৮০০'),
      saysStockUncertain: text.includes('নিশ্চিত নয়'),
      // "স্টকে আছে কিনা নিশ্চিত নয়" is an UNCERTAIN statement, not a
      // stock claim — so the check excludes that exact phrasing and
      // looks for a positive claim instead ("টি আছে ✅" / "স্টক: N").
      noStockClaim: !text.includes('টি আছে ✅') && !text.includes('স্টক:'),
      ledger: await ledgerRows(workspace2Id, conversationId),
    };
  }

  console.log('IMAGE_DRIVER_RESULT ' + JSON.stringify(out));
  await pool.end();
}

main().catch((err) => {
  console.error('image driver crashed:', err);
  process.exit(1);
});
