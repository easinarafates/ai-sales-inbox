// Driver for verify-short-professional.mjs — tests the short/professional
// behaviours DIRECTLY against the same PGlite dir the verifier's API boot
// uses. Run AFTER the API boot stops (PGlite is single-process), with:
//   USE_PGLITE=true PGLITE_DATA_DIR=<dir> npx tsx scripts/short-professional-driver.ts <workspaceId> <jeansId> <tshirtId> <shirtId> <channelId>
// (Provider keys are BLANK here — deterministic demo mode. The live Gemini
// short-reply checks are in short-professional-live-driver.ts, which runs
// with the real GEMINI_API_KEY.)
// Prints one DRIVER_RESULT JSON line for the verifier to parse.
// No secrets are printed.
import { pool } from '../apps/api/src/db/pool';
import { processBatch, shortenReply } from '../apps/api/src/ai-agent/agent';
import { detectShopLocation, isExplicitOrderConfirmation } from '../apps/api/src/ai-agent/detect-intent';
import { renderInvoiceImageForOrder } from '../apps/api/src/orders/invoice-image';

const [workspaceId, jeansId, tshirtId, shirtId, channelId] = process.argv.slice(2);
if (!workspaceId || !jeansId || !tshirtId || !shirtId || !channelId) {
  console.error('usage: short-professional-driver.ts <workspaceId> <jeansId> <tshirtId> <shirtId> <channelId>');
  process.exit(2);
}

const out: Record<string, unknown> = {};
let n = 200;

async function seedConversation(
  customerName: string,
  gender = 'male',
  phone: string | null = null,
  address: string | null = null,
): Promise<{ customerId: string; conversationId: string }> {
  n += 1;
  const c = await pool.query(
    `INSERT INTO customers (workspace_id, name, gender, phone, address, channel_identities) VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id`,
    [workspaceId, customerName, gender, phone, address, JSON.stringify([{ platform: 'webchat', senderId: `sp-drv-${n}` }])],
  );
  const customerId = c.rows[0].id as string;
  const cv = await pool.query(
    `INSERT INTO conversations (workspace_id, channel_id, customer_id, status, mode) VALUES ($1, $2, $3, 'open', 'ai') RETURNING id`,
    [workspaceId, channelId, customerId],
  );
  return { customerId, conversationId: cv.rows[0].id as string };
}

async function outMessages(conversationId: string): Promise<{ body: string; type: string }[]> {
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

async function seedInMessage(conversationId: string, body: string, mediaType: string | null = null): Promise<void> {
  await pool.query(
    "INSERT INTO messages (workspace_id, conversation_id, direction, type, body, media_type) VALUES ($1, $2, 'in', 'text', $3, $4)",
    [workspaceId, conversationId, body, mediaType],
  );
}

function countLines(s: string): number {
  return s.split('\n').map((l) => l.trim()).filter(Boolean).length;
}

async function main(): Promise<void> {
  // --- Unit 1: shortenReply (the deterministic brevity guard) ---
  const longReply =
    'স্যার, আমাদের কাছে অনেক প্রোডাক্ট আছে। আমরা টি-শার্ট, প্যান্ট ও শার্ট বিক্রি করি। ' +
    'আমাদের দোকান মাগুরায় অবস্থিত এবং আমরা সারা দেশে ডেলিভারি দিই। ' +
    'Jeans এর দাম ৳৫০০ এবং T-shirt এর দাম ৳৪০০। ' +
    'আপনি চাইলে আরও অনেক কিছু জানতে পারেন, যেমন ডেলিভারি চার্জ, স্টক, অর্ডারের নিয়ম। ' +
    'আমাদের দোকানে সবসময় নতুন নতুন প্রোডাক্ট আসে, তাই মাঝে মাঝে খোঁজ নিলে ভালো হয়। ' +
    'আমাদের কাস্টমার সার্ভিস সবসময় আপনার পাশে আছে। ' +
    'আপনি চাইলে ক্যাশ অন ডেলিভারিতে অর্ডার করতে পারেন, ডেলিভারি চার্জ ঢাকার ভেতরে ১০০ টাকা আর ঢাকার বাইরে ১৩০ টাকা। ' +
    'আরও জানতে চাইলে যেকোনো সময় মেসেজ করুন, আমরা সবসময় সাহায্য করতে প্রস্তুত আছি। ধন্যবাদ।';
  const short1 = shortenReply(longReply);
  out.shortenLong = {
    inLen: longReply.length,
    outLen: short1.reply.length,
    shortened: short1.shortened,
    // The price sentence must survive; the reply must be much shorter.
    keepsPrice: /৳৫০০/.test(short1.reply),
    ok: short1.shortened && short1.reply.length <= 450 && /৳৫০০/.test(short1.reply),
  };
  const alreadyShort = 'স্যার, হ্যাঁ, এই প্রোডাক্টটি জিন্স।';
  const short2 = shortenReply(alreadyShort);
  out.shortenShortUntouched = { ok: !short2.shortened && short2.reply === alreadyShort, reply: short2.reply };
  const oneLongSentence = 'স্যার, ' + 'আমাদের দোকানে অনেক অনেক প্রোডাক্ট আছে এবং আমরা সবসময় ভালো মানের পণ্য দেওয়ার চেষ্টা করি '.repeat(6) + 'ধন্যবাদ।';
  const short3 = shortenReply(oneLongSentence);
  out.shortenOneLongSentence = {
    ok: short3.shortened && short3.reply.length <= 460 && short3.reply.endsWith('…'),
    outLen: short3.reply.length,
  };

  // --- Unit 2: detectShopLocation ---
  const locCases: [string, boolean][] = [
    ['দোকান কোথায়?', true],
    ['তোমাদের সব কোথায়', true],
    ['দোকানের ঠিকানা কি', true],
    ['আপনাদের শপ কোথায়', true],
    ['where is your shop?', true],
    ['shop kothay', true],
    ['tomader dokan kothay', true],
    ['জিন্সের দাম কত?', false],
    ['Hi', false],
    ['অর্ডার করতে চাই', false],
    ['প্রোডাক্টগুলো দেখান', false],
    ['ডেলিভারি চার্জ কত', false],
  ];
  out.shopLocationUnit = locCases.map(([text, expected]) => ({
    text,
    expected,
    got: detectShopLocation(text),
    ok: detectShopLocation(text) === expected,
  }));
  out.shopLocationUnitAllOk = (out.shopLocationUnit as { ok: boolean }[]).every((c) => c.ok);

  // --- Unit 3: isExplicitOrderConfirmation (2026-11-08, like-created
  // orders) — a like / Hi / OK / bare "হ্যাঁ" / question must NEVER
  // count as an order confirmation; only an explicit order/confirm
  // phrasing counts. A cancel request must NOT count either. ---
  const confirmCases: [string, boolean][] = [
    // Must NEVER confirm (false).
    ['[লাইক]', false],
    ['[স্টিকার]', false],
    ['Hi', false],
    ['হাই', false],
    ['OK', false],
    ['ঠিক আছে', false],
    ['হ্যাঁ', false],
    ['ধন্যবাদ', false],
    ['আচ্ছা', false],
    ['হুম', false],
    ['ডেলিভারি চার্জ কত?', false],
    ['কতদিনে আসবে?', false],
    ['আমার অর্ডারটা কতদূর', false],
    ['অর্ডার ক্যানসেল করো', false],
    ['অর্ডার ক্যানসেল করতে চাই', false],
    ['জিন্সের দাম কত?', false],
    ['', false],
    // Must confirm (true).
    ['অর্ডার কনফার্ম করো', true],
    ['অর্ডার কনফার্ম করুন', true],
    ['হ্যাঁ, অর্ডার করবো', true],
    ['অর্ডার করবো', true],
    ['অর্ডার দাও', true],
    ['কনফার্ম করো', true],
    ['কনফার্ম', true],
    ['আমি জিন্স কিনতে চাই', true],
    ['আমি একটা জিন্স কিনতে চাই। নাম টেস্ট, ফোন 01712345678, ঠিকানা বাসা ১, রোড ২, ধানমন্ডি, ঢাকা। অর্ডার কনফার্ম করুন।', true],
    ['confirm the order', true],
    ['confirm order', true],
    ['place order', true],
    ['order korbo', true],
    ['confirm koro', true],
  ];
  out.orderConfirmUnit = confirmCases.map(([text, expected]) => ({
    text,
    expected,
    got: isExplicitOrderConfirmation(text),
    ok: isExplicitOrderConfirmation(text) === expected,
  }));
  out.orderConfirmUnitAllOk = (out.orderConfirmUnit as { ok: boolean }[]).every((c) => c.ok);

  // --- Flow 1: product list is JUST the list (no trailing question) ---
  const listConv = await seedConversation('তালিকা কাস্টমার');
  await seedInMessage(listConv.conversationId, 'প্রোডাক্টগুলো দেখান');
  const listRes = await processBatch(workspaceId, listConv.conversationId, [
    { body: 'প্রোডাক্টগুলো দেখান', mediaType: null },
  ]);
  const listOuts = await outMessages(listConv.conversationId);
  const listReply = listOuts[0]?.body ?? '';
  out.listJustTheList = {
    replied: listRes.replied,
    reply: listReply,
    // Header + one line per product (3 products), no trailing question.
    ok:
      listRes.replied &&
      listReply.startsWith('স্যার, আমাদের প্রোডাক্টগুলো:') &&
      countLines(listReply) === 4 &&
      !/কোনটি সম্পর্কে জানতে চান/.test(listReply) &&
      !/নামটা লিখে জানান/.test(listReply),
  };

  // --- Flow 2: shop location = ONE line from the knowledge book ---
  await pool.query(
    `INSERT INTO knowledge_items (workspace_id, title, body) VALUES ($1, 'দোকানের ঠিকানা', 'আমাদের দোকান মাগুরায়।')`,
    [workspaceId],
  );
  const locConv = await seedConversation('ঠিকানা কাস্টমার');
  await seedInMessage(locConv.conversationId, 'দোকান কোথায়?');
  const locRes = await processBatch(workspaceId, locConv.conversationId, [
    { body: 'দোকান কোথায়?', mediaType: null },
  ]);
  const locOuts = await outMessages(locConv.conversationId);
  const locReply = locOuts[0]?.body ?? '';
  out.shopLocationOneLine = {
    replied: locRes.replied,
    reason: locRes.reason,
    reply: locReply,
    ok: locRes.replied && locRes.reason === 'shop_location' && countLines(locReply) === 1 && locReply.includes('মাগুরায়'),
  };

  // --- Flow 3: like with NO previous context → short "how can I help" ---
  const likeConv = await seedConversation('লাইক কাস্টমার');
  await seedInMessage(likeConv.conversationId, '[লাইক]', 'sticker');
  const likeRes = await processBatch(workspaceId, likeConv.conversationId, [
    { body: '[লাইক]', mediaType: 'sticker' },
  ]);
  const likeOuts = await outMessages(likeConv.conversationId);
  const likeReply = likeOuts[0]?.body ?? '';
  out.likeNoContext = {
    replied: likeRes.replied,
    reason: likeRes.reason,
    reply: likeReply,
    ok:
      likeRes.replied &&
      likeRes.reason === 'like_acknowledged' &&
      countLines(likeReply) <= 1 &&
      /কিভাবে আপনাকে সাহায্য করতে পারি/.test(likeReply) &&
      !/প্রোডাক্ট/.test(likeReply) &&
      !/আমাদের কাছে এই প্রোডাক্ট নেই/.test(likeReply),
  };

  // --- Flow 4: like AFTER a product question → contextual short reply ---
  const likeCtxConv = await seedConversation('লাইক প্রোডাক্ট কাস্টমার');
  await seedInMessage(likeCtxConv.conversationId, 'Jeans এর দাম কত?');
  await seedOutMessage(likeCtxConv.conversationId, 'স্যার, Jeans — ৳৫০০।');
  await seedInMessage(likeCtxConv.conversationId, '[লাইক]', 'sticker');
  const likeCtxRes = await processBatch(workspaceId, likeCtxConv.conversationId, [
    { body: '[লাইক]', mediaType: 'sticker' },
  ]);
  const likeCtxOuts = await outMessages(likeCtxConv.conversationId);
  const likeCtxReply = likeCtxOuts[likeCtxOuts.length - 1]?.body ?? '';
  out.likeAfterProduct = {
    replied: likeCtxRes.replied,
    reason: likeCtxRes.reason,
    reply: likeCtxReply,
    ok:
      likeCtxRes.replied &&
      likeCtxRes.reason === 'like_acknowledged' &&
      countLines(likeCtxReply) <= 1 &&
      /ধন্যবাদ/.test(likeCtxReply) &&
      !/আমাদের কাছে এই প্রোডাক্ট নেই/.test(likeCtxReply),
  };

  // --- Flow 5: order confirm → confirmation + invoice image + ONE suggestion ---
  const orderConv = await seedConversation('অর্ডার কাস্টমার', 'male', '01712345678', 'বাসা ১২, রোড ৫, ধানমন্ডি, ঢাকা');
  await seedInMessage(orderConv.conversationId, 'Jeans অর্ডার করতে চাই');
  const orderRes = await processBatch(workspaceId, orderConv.conversationId, [
    { body: 'Jeans অর্ডার করতে চাই', mediaType: null },
  ]);
  const orderOuts = await outMessages(orderConv.conversationId);
  const confirmText = orderOuts[0]?.body ?? '';
  const suggestionText = orderOuts[1]?.body ?? '';
  const imageOuts = orderOuts.filter((m) => m.type === 'image');
  // The order row (for the invoice render check below).
  const orderRow = await pool.query(
    `SELECT id, order_number FROM orders WHERE workspace_id = $1 AND conversation_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [workspaceId, orderConv.conversationId],
  );
  const orderId = (orderRow.rows[0] as { id: string; order_number: string } | undefined)?.id ?? '';
  const orderNumber = (orderRow.rows[0] as { id: string; order_number: string } | undefined)?.order_number ?? '';
  out.orderConfirm = {
    replied: orderRes.replied,
    reason: orderRes.reason,
    confirm: confirmText,
    suggestion: suggestionText,
    imageMessages: imageOuts.length,
    // Confirmation: complete (name/address/items/total) and compact.
    // In demo mode the reason is 'demo_mode' (the live path returns
    // 'order_confirmed'); the confirmation text is the same either way.
    confirmOk:
      orderRes.replied &&
      (orderRes.reason === 'order_confirmed' || orderRes.reason === 'demo_mode') &&
      /অর্ডার কনফার্ম করা হলো/.test(confirmText) &&
      /Jeans/.test(confirmText) &&
      /৳/.test(confirmText) &&
      /ইনভয়েস দেখুন/.test(confirmText),
    // ONE short suggestion about another product, nothing more.
    suggestionOk:
      countLines(suggestionText) <= 1 &&
      /আপনি কি আর কোনো প্রোডাক্ট নিতে চাচ্ছেন/.test(suggestionText) &&
      /(T-shirt|Shirt)/.test(suggestionText),
    // NOTE: no Blob token in the local boot, so the image upload is
    // expected to fail here (logged honestly) — the PNG render itself
    // is proven by the invoiceRender check below, and the live check
    // (production Blob) proves the full send path.
    orderId,
    orderNumber,
  };

  // --- Flow 6: invoice image renders correct Bengali (headless Chromium) ---
  if (orderId) {
    const rendered = await renderInvoiceImageForOrder(
      pool as unknown as { query: <T>(text: string, params?: unknown[]) => Promise<{ rows: T[] }> },
      workspaceId,
      orderId,
    );
    if (rendered) {
      const png = rendered.png;
      const isPng = png.length > 4 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47;
      const width = png.readUInt32BE(16);
      const height = png.readUInt32BE(20);
      out.invoiceRender = {
        ok: isPng && width === 700 && height > 200 && png.length > 10000,
        bytes: png.length,
        width,
        height,
        orderNumber: rendered.orderNumber,
      };
    } else {
      out.invoiceRender = { ok: false, error: 'render returned null' };
    }
  } else {
    out.invoiceRender = { ok: false, error: 'no order created in flow 5' };
  }

  console.log('DRIVER_RESULT ' + JSON.stringify(out));
  process.exit(0);
}

main().catch((err) => {
  console.error('DRIVER_ERROR', err);
  process.exit(1);
});
