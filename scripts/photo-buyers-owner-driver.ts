// Driver for verify-photo-buyers-owner.mjs — tests the photo flow,
// never-admit deflection, and buyers-only + owner-guard pieces DIRECTLY
// against the same PGlite dir the verifier's API boot uses.
// Run AFTER the API boot stops (PGlite is single-process; the API holds
// the lock while it runs), with:
//   USE_PGLITE=true PGLITE_DATA_DIR=<dir> npx tsx scripts/photo-buyers-owner-driver.ts <workspaceId> <jeansId> <shirtId> <tshirtId>
// Prints one DRIVER_RESULT JSON line for the verifier to parse.
// No secrets are printed.
import { pool } from '../apps/api/src/db/pool';
import { processBatch } from '../apps/api/src/ai-agent/agent';
import { runTool } from '../apps/api/src/ai-agent/tools';
import {
  detectFastReplyQuestion,
  detectProductListRequest,
  matchShowProduct,
} from '../apps/api/src/ai-agent/detect-intent';
import { setWorkspaceAiMode, toggleWorkspaceAiMode } from '../apps/api/src/inbox/dot-commands';
import { encryptToken } from '../apps/api/src/db/crypto';

const [workspaceId, jeansId, shirtId, tshirtId] = process.argv.slice(2);
if (!workspaceId || !jeansId || !shirtId || !tshirtId) {
  console.error('usage: photo-buyers-owner-driver.ts <workspaceId> <jeansId> <shirtId> <tshirtId>');
  process.exit(2);
}

const out: Record<string, unknown> = {};

async function seedConversation(
  customerName: string,
  identities: unknown,
  platform: string,
  channelId: string | null = null,
): Promise<{ customerId: string; conversationId: string }> {
  const c = await pool.query(
    `INSERT INTO customers (workspace_id, name, channel_identities) VALUES ($1, $2, $3::jsonb) RETURNING id`,
    [workspaceId, customerName, JSON.stringify(identities)],
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
    'SELECT status, mode, escalation_reason, escalated_at FROM conversations WHERE id = $1',
    [conversationId],
  );
  return (r.rows[0] as Record<string, unknown>) ?? {};
}

async function outRows(conversationId: string): Promise<{ type: string; body: string | null; delivery_status: string }[]> {
  const r = await pool.query(
    "SELECT type, body, delivery_status FROM messages WHERE workspace_id = $1 AND conversation_id = $2 AND direction = 'out' ORDER BY created_at ASC",
    [workspaceId, conversationId],
  );
  return r.rows as { type: string; body: string | null; delivery_status: string }[];
}

async function main(): Promise<void> {
  const catalog = [
    { id: jeansId, name: 'Jeans' },
    { id: shirtId, name: 'Shirt' },
    { id: tshirtId, name: 'T-shirt' },
  ];

  // --- Unit matrices: the detectors are conservative ---
  const fastCases: [string, boolean][] = [
    ['তুমি এত দ্রুত রিপ্লাই দিচ্ছ কেন?', true],
    ['কেন এত তাড়াতাড়ি উত্তর দাও?', true],
    ['তোমার রিপ্লাই এত ফাস্ট কেন?', true],
    ['why do you reply so fast?', true],
    ['Why are you so fast?', true],
    ['জিন্সের দাম কত?', false],
    ['দ্রুত ডেলিভারি দিবেন?', false],
    ['ডেলিভারি কতদিনে আসবে?', false],
    ['অর্ডার কবে আসবে?', false],
  ];
  out.fastUnit = fastCases.map(([text, expected]) => ({ text: text.slice(0, 30), expected, got: detectFastReplyQuestion(text), ok: detectFastReplyQuestion(text) === expected }));
  out.fastUnitAllOk = (out.fastUnit as { ok: boolean }[]).every((c) => c.ok);

  const listCases: [string, boolean][] = [
    ['কি কি প্রোডাক্ট আছে?', true],
    ['কি কি প্রোডাক্ট আছে একটু বলো', true],
    ['সব প্রোডাক্ট দেখাও', true],
    ['তোমাদের কাছে কি আছে?', true],
    ['what products do you have?', true],
    ['জিন্সের দাম কত?', false],
    ['টি-শার্ট আছে?', false],
    ['শার্ট অর্ডার করতে চাই', false],
  ];
  out.listUnit = listCases.map(([text, expected]) => ({ text: text.slice(0, 30), expected, got: detectProductListRequest(text), ok: detectProductListRequest(text) === expected }));
  out.listUnitAllOk = (out.listUnit as { ok: boolean }[]).every((c) => c.ok);

  const showCases: [string, string | null][] = [
    ['জিন্সটা দেখাও', 'Jeans'],
    ['শার্টের ছবি দাও', 'Shirt'], // exact alias: শার্ট → Shirt (T-shirt is টি-শার্ট)
    ['টি-শার্টটা দেখতে চাই', 'T-shirt'],
    ['জিন্সের দাম কত?', null], // no show word
    ['প্যান্ট দেখাও', null], // no Pants product in the catalog
  ];
  out.showUnit = showCases.map(([text, expected]) => {
    const got = matchShowProduct(text, catalog);
    return { text: text.slice(0, 30), expected, got: got?.name ?? null, ok: (got?.name ?? null) === expected };
  });
  out.showUnitAllOk = (out.showUnit as { ok: boolean }[]).every((c) => c.ok);

  // The webchat channel Boot 1 created via the API — the processBatch
  // conversations below need a real channel row, otherwise the image
  // send fails with 'no_channel_connected' and falls through to text.
  const wc = await pool.query(
    `SELECT id FROM channels WHERE workspace_id = $1 AND platform = 'webchat' ORDER BY created_at DESC LIMIT 1`,
    [workspaceId],
  );
  const webchatChannelId = (wc.rows[0] as { id: string } | undefined)?.id ?? null;
  out.webchatChannelId = webchatChannelId;

  // --- (1) List request → ONE clean TEXT list, NO photos ---
  // (AI-training 2026-11-08: the list is text, not photo cards.)
  const l1 = await seedConversation('List Customer', [{ platform: 'webchat', senderId: 'wc-d-list-1' }], 'webchat', webchatChannelId);
  const r1 = await processBatch(workspaceId, l1.conversationId, [{ body: 'কি কি প্রোডাক্ট আছে?' }]);
  const rows1 = await outRows(l1.conversationId);
  out.listFlow = {
    result: { replied: r1.replied, reason: r1.reason },
    state: await convState(l1.conversationId),
    images: rows1.filter((m) => m.type === 'image').map((m) => m.body),
    captions: rows1.filter((m) => m.type === 'text').map((m) => m.body),
    conversationId: l1.conversationId,
  };

  // --- (2) Show request → the jeans photo + details + price ---
  const s1 = await seedConversation('Show Customer', [{ platform: 'webchat', senderId: 'wc-d-show-1' }], 'webchat', webchatChannelId);
  const r2 = await processBatch(workspaceId, s1.conversationId, [{ body: 'জিন্সটা দেখাও' }]);
  const rows2 = await outRows(s1.conversationId);
  out.showFlow = {
    result: { replied: r2.replied, reason: r2.reason },
    state: await convState(s1.conversationId),
    images: rows2.filter((m) => m.type === 'image').map((m) => m.body),
    texts: rows2.filter((m) => m.type === 'text').map((m) => m.body),
    conversationId: s1.conversationId,
  };

  // --- (3) Fast-reply question → deflection, no AI admission, not escalated ---
  const f1 = await seedConversation('Fast Customer', [{ platform: 'webchat', senderId: 'wc-d-fast-1' }], 'webchat', webchatChannelId);
  const r3 = await processBatch(workspaceId, f1.conversationId, [{ body: 'তুমি এত দ্রুত রিপ্লাই দিচ্ছ কেন?' }]);
  const rows3 = await outRows(f1.conversationId);
  const deflection = rows3.map((m) => m.body ?? '').join(' ');
  out.fastFlow = {
    result: { replied: r3.replied, reason: r3.reason },
    state: await convState(f1.conversationId),
    text: deflection,
    hasAiWord: /AI|এআই|রোবট|robot|bot/i.test(deflection),
    conversationId: f1.conversationId,
  };

  // --- (4) "তুমি কি AI?" → escalated off-topic, no admission, no reply ---
  const a1 = await seedConversation('AI Customer', [{ platform: 'webchat', senderId: 'wc-d-ai-1' }], 'webchat', webchatChannelId);
  const r4 = await processBatch(workspaceId, a1.conversationId, [{ body: 'তুমি কি AI?' }]);
  const rows4 = await outRows(a1.conversationId);
  out.aiQuestion = {
    result: { replied: r4.replied, reason: r4.reason },
    state: await convState(a1.conversationId),
    outMessages: rows4.length,
    conversationId: a1.conversationId,
  };

  // --- (5) Normal price question → open, real reply, NO photos ---
  const n1 = await seedConversation('Normal Customer', [{ platform: 'webchat', senderId: 'wc-d-ok-1' }], 'webchat', webchatChannelId);
  const r5 = await processBatch(workspaceId, n1.conversationId, [{ body: 'জিন্সের দাম কত?' }]);
  const rows5 = await outRows(n1.conversationId);
  out.normal = {
    result: { replied: r5.replied, reason: r5.reason },
    state: await convState(n1.conversationId),
    images: rows5.filter((m) => m.type === 'image').length,
    texts: rows5.filter((m) => m.type === 'text').map((m) => m.body),
    conversationId: n1.conversationId,
  };

  // --- (5b) FLOOD HARDENING (2026-11-08): a stale batch that still
  // holds an old list request must never re-send the list ---
  // (a) stale list + show pick → the pick wins: exactly 1 jeans photo.
  const m1 = await seedConversation('Mixed Show Customer', [{ platform: 'webchat', senderId: 'wc-d-mix-1' }], 'webchat', webchatChannelId);
  const rm1 = await processBatch(workspaceId, m1.conversationId, [{ body: 'কি কি প্রোডাক্ট আছে?' }, { body: 'জিন্সটা দেখাও' }]);
  const rowsM1 = await outRows(m1.conversationId);
  out.mixedShow = {
    result: { replied: rm1.replied, reason: rm1.reason },
    state: await convState(m1.conversationId),
    images: rowsM1.filter((m) => m.type === 'image').map((m) => m.body),
    texts: rowsM1.filter((m) => m.type === 'text').map((m) => m.body),
    conversationId: m1.conversationId,
  };
  // (b) stale list + refusal → NO photos at all.
  const m2 = await seedConversation('Mixed Refusal Customer', [{ platform: 'webchat', senderId: 'wc-d-mix-2' }], 'webchat', webchatChannelId);
  const rm2 = await processBatch(workspaceId, m2.conversationId, [{ body: 'কি কি প্রোডাক্ট আছে?' }, { body: 'নিবো না' }]);
  const rowsM2 = await outRows(m2.conversationId);
  out.mixedRefusal = {
    result: { replied: rm2.replied, reason: rm2.reason },
    images: rowsM2.filter((m) => m.type === 'image').length,
    conversationId: m2.conversationId,
  };
  // (c) repeat list request on the thread that JUST got the list (l1,
  // whose latest out is the interest question) → the guard blocks the
  // re-send: 0 new images.
  const rg = await processBatch(workspaceId, l1.conversationId, [{ body: 'কি কি প্রোডাক্ট আছে?' }]);
  const rowsG = await outRows(l1.conversationId);
  out.guardRepeat = {
    result: { replied: rg.replied, reason: rg.reason },
    newImages: rowsG.filter((m) => m.type === 'image').length - rows1.filter((m) => m.type === 'image').length,
    conversationId: l1.conversationId,
  };

  // --- (6) Tool test with stubbed Graph fetch: send_product_photos ---
  // Seed a messenger channel with a real encrypted token (decryptToken
  // must succeed) + a customer with a messenger identity.
  const tokenEnc = encryptToken('dummy-page-token-for-driver');
  const ch = await pool.query(
    `INSERT INTO channels (workspace_id, platform, external_id, display_name, status, token_encrypted)
     VALUES ($1, 'messenger', 'TESTPAGE1', 'Test Page', 'connected', $2) RETURNING id`,
    [workspaceId, tokenEnc],
  );
  const channelId = ch.rows[0].id as string;
  const t1 = await seedConversation(
    'Tool Customer',
    [{ platform: 'messenger', senderId: 'PSID-TOOL-1' }],
    'messenger',
    channelId,
  );
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => {
    fetchCalls += 1;
    return { ok: true, json: async () => ({ message_id: `m_stub${fetchCalls}` }) } as unknown as Response;
  }) as typeof fetch;
  try {
    const toolOut = await runTool(
      { query: async (text: string, params?: unknown[]) => { const r = await pool.query(text, params as never[]); return { rows: r.rows as Record<string, unknown>[], rowCount: r.rowCount ?? 0 }; } },
      workspaceId,
      'send_product_photos',
      { productIds: [jeansId, shirtId, tshirtId], conversationId: t1.conversationId },
    );
    const toolRows = await outRows(t1.conversationId);
    out.toolSend = {
      result: toolOut,
      fetchCalls,
      imageRows: toolRows.filter((m) => m.type === 'image').map((m) => ({ url: m.body, delivery: m.delivery_status })),
    };
    // A product with no photo → failed 'no_photo', no fetch call.
    const noPhoto = await pool.query(
      `INSERT INTO products (workspace_id, name, price_paisa, stock) VALUES ($1, 'NoPhoto Product', 10000, 5) RETURNING id`,
      [workspaceId],
    );
    const noPhotoId = noPhoto.rows[0].id as string;
    const before = fetchCalls;
    const toolOut2 = await runTool(
      { query: async (text: string, params?: unknown[]) => { const r = await pool.query(text, params as never[]); return { rows: r.rows as Record<string, unknown>[], rowCount: r.rowCount ?? 0 }; } },
      workspaceId,
      'send_product_photos',
      { productIds: [noPhotoId], conversationId: t1.conversationId },
    );
    out.toolNoPhoto = { result: toolOut2, fetchCallsDelta: fetchCalls - before };
  } finally {
    globalThis.fetch = realFetch;
  }

  // --- (7) Tool test: facebook_comment cannot receive images ---
  const chFc = await pool.query(
    `INSERT INTO channels (workspace_id, platform, external_id, display_name, status, token_encrypted)
     VALUES ($1, 'facebook_comment', 'TESTPAGE1', 'Test Page', 'connected', $2) RETURNING id`,
    [workspaceId, tokenEnc],
  );
  const fcConv = await seedConversation(
    'Comment Customer',
    [{ platform: 'facebook_comment', senderId: 'PSID-FC-1' }],
    'facebook_comment',
    chFc.rows[0].id as string,
  );
  const toolOut3 = await runTool(
    { query: async (text: string, params?: unknown[]) => { const r = await pool.query(text, params as never[]); return { rows: r.rows as Record<string, unknown>[], rowCount: r.rowCount ?? 0 }; } },
    workspaceId,
    'send_product_photos',
    { productIds: [jeansId], conversationId: fcConv.conversationId },
  );
  out.toolComment = { result: toolOut3 };

  // --- (8) Buyers-only predicate: buyer vs non-buyer ---
  const buyer = await pool.query(
    `INSERT INTO customers (workspace_id, name) VALUES ($1, 'Buyer One') RETURNING id`,
    [workspaceId],
  );
  const buyerId = buyer.rows[0].id as string;
  await pool.query(
    `INSERT INTO orders (workspace_id, customer_id, source, status, payment_status, total_paisa)
     VALUES ($1, $2, 'ai', 'pending', 'unpaid', 50000)`,
    [workspaceId, buyerId],
  );
  const nonBuyer = await pool.query(
    `INSERT INTO customers (workspace_id, name) VALUES ($1, 'Never Ordered') RETURNING id`,
    [workspaceId],
  );
  const listed = await pool.query(
    `SELECT id, name FROM customers WHERE workspace_id = $1
     AND EXISTS (SELECT 1 FROM orders o WHERE o.workspace_id = customers.workspace_id AND o.customer_id = customers.id)
     ORDER BY name`,
    [workspaceId],
  );
  out.buyersOnly = {
    listed: (listed.rows as { id: string; name: string }[]).map((r) => r.name),
    buyerListed: (listed.rows as { id: string }[]).some((r) => r.id === buyerId),
    nonBuyerListed: (listed.rows as { id: string }[]).some((r) => r.id === nonBuyer.rows[0].id),
  };

  // --- (9) Workspace AI toggle (owner dot-command backend) ---
  const beforeToggle = await pool.query('SELECT ai_enabled FROM workspaces WHERE id = $1', [workspaceId]);
  const afterOff = await setWorkspaceAiMode(workspaceId, false);
  const afterToggle = await toggleWorkspaceAiMode(workspaceId);
  const afterOn = await setWorkspaceAiMode(workspaceId, true);
  out.workspaceToggle = {
    before: (beforeToggle.rows[0] as { ai_enabled: boolean }).ai_enabled,
    afterOff,
    afterToggle,
    afterOn,
  };

  // --- Seed for the verifier's Boot 2 Meta-webhook owner tests ---
  await pool.query(`UPDATE workspaces SET owner_psid = '29638693045727594' WHERE id = $1`, [workspaceId]);
  out.boot2ChannelId = channelId;
  out.boot2OwnerPsid = '29638693045727594';

  console.log(`DRIVER_RESULT ${JSON.stringify(out)}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('DRIVER ERR', err);
    process.exit(1);
  });
