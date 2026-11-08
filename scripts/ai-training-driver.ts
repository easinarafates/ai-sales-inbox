// Driver for verify-ai-training.mjs — tests the AI training behaviours
// DIRECTLY against the same PGlite dir the verifier's API boot uses.
// Run AFTER the API boot stops (PGlite is single-process), with:
//   USE_PGLITE=true PGLITE_DATA_DIR=<dir> npx tsx scripts/ai-training-driver.ts <workspaceId> <jeansId> <tshirtId> <shirtId>
// (Provider keys are BLANK here — deterministic demo mode. The live
// Gemini behaviours — photo match, voice, Banglish LLM reply — are in
// ai-training-live-driver.ts, which runs with the real GEMINI_API_KEY.)
// Prints one DRIVER_RESULT JSON line for the verifier to parse.
// No secrets are printed.
import { pool } from '../apps/api/src/db/pool';
import { processBatch } from '../apps/api/src/ai-agent/agent';
import { runTool } from '../apps/api/src/ai-agent/tools';
import { detectAnger, detectGibberish, detectOffTopic } from '../apps/api/src/inbox/escalation';
import { detectGreeting, detectProductListRequest, matchShowProduct } from '../apps/api/src/ai-agent/detect-intent';
import { assessAddressCompleteness, findUnknownPlaceNames, normalizeBdPhone } from '../apps/api/src/orders/bangladesh';
import { getDeliveryChargeRules, resolveDeliveryCharge, setDeliveryChargeRules } from '../apps/api/src/delivery-charges/service';

const [workspaceId, jeansId, tshirtId, shirtId, channelId] = process.argv.slice(2);
if (!workspaceId || !jeansId || !tshirtId || !shirtId || !channelId) {
  console.error('usage: ai-training-driver.ts <workspaceId> <jeansId> <tshirtId> <shirtId> <channelId>');
  process.exit(2);
}

const out: Record<string, unknown> = {};
let n = 0;

async function seedConversation(customerName: string, gender = 'male'): Promise<{ customerId: string; conversationId: string }> {
  n += 1;
  const c = await pool.query(
    `INSERT INTO customers (workspace_id, name, gender, channel_identities) VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
    [workspaceId, customerName, gender, JSON.stringify([{ platform: 'webchat', senderId: `drv-${n}` }])],
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
    'SELECT status, mode, escalation_reason, gibberish_warned FROM conversations WHERE id = $1',
    [conversationId],
  );
  return (r.rows[0] as Record<string, unknown>) ?? {};
}

async function outMessages(conversationId: string): Promise<string[]> {
  const r = await pool.query(
    "SELECT body FROM messages WHERE workspace_id = $1 AND conversation_id = $2 AND direction = 'out' ORDER BY created_at ASC",
    [workspaceId, conversationId],
  );
  return (r.rows as { body: string | null }[]).map((row) => row.body ?? '');
}

async function outCount(conversationId: string): Promise<number> {
  return (await outMessages(conversationId)).length;
}

async function seedOutMessage(conversationId: string, body: string): Promise<void> {
  await pool.query(
    "INSERT INTO messages (workspace_id, conversation_id, direction, type, body) VALUES ($1, $2, 'out', 'text', $3)",
    [workspaceId, conversationId, body],
  );
}

async function notificationFor(conversationId: string): Promise<Record<string, unknown> | null> {
  const r = await pool.query(
    'SELECT id, type, title, body, is_read FROM notifications WHERE workspace_id = $1 AND conversation_id = $2 ORDER BY created_at DESC LIMIT 1',
    [workspaceId, conversationId],
  );
  return (r.rows[0] as Record<string, unknown> | undefined) ?? null;
}

async function main(): Promise<void> {
  // --- Unit matrix 1: gibberish (true = gibberish, false = real message) ---
  const gibberishCases: [string, boolean][] = [
    ['asdfghjkl', true],
    ['zxcvbnm', true],
    ['qwerty', true],
    ['ksdjfhsdkjf', true],
    ['aaaa', true],
    ['zzzz', true],
    ['হিজিবিজি', true],
    ['হিজিবিজি লিখছি', true],
    ['sdfgh', true],
    ['xq', true],
    // Real messages — must NEVER match.
    ['Hi', false],
    ['hello', false],
    ['আসসালামু আলাইকুম', false],
    ['Ata', false],
    ['jeans er dam koto', false],
    ['jins ase?', false],
    ['kemon aso', false],
    ['price koto', false],
    ['chobi dao', false],
    ['ok', false],
    ['hmm', false],
    ['500', false],
    ['👍', false],
    ['জিন্সের দাম কত?', false],
    ['Rahim', false],
    ['random', false],
    ['Ata dibo', false],
    ['Je sobi disi oita', false],
    ['tumi kemon aso', false],
    ['apni ki bolben', false],
  ];
  out.gibberishUnit = gibberishCases.map(([text, expected]) => ({
    text: text.slice(0, 30),
    expected,
    got: detectGibberish(text),
    ok: detectGibberish(text) === expected,
  }));
  out.gibberishUnitAllOk = (out.gibberishUnit as { ok: boolean }[]).every((c) => c.ok);

  // --- Unit matrix 2: greeting (true = greeting only) ---
  const greetingCases: [string, boolean][] = [
    ['Hi', true],
    ['hi', true],
    ['hello', true],
    ['আসসালামু আলাইকুম', true],
    ['সালাম', true],
    ['হ্যালো', true],
    ['Hey', true],
    ['Hi, jeans er dam koto?', false],
    ['জিন্সের দাম কত?', false],
    ['ছবি দেন', false],
    ['আমি অর্ডার করতে চাই', false],
    ['500 টাকা', false],
  ];
  out.greetingUnit = greetingCases.map(([text, expected]) => ({
    text: text.slice(0, 30),
    expected,
    got: detectGreeting(text),
    ok: detectGreeting(text) === expected,
  }));
  out.greetingUnitAllOk = (out.greetingUnit as { ok: boolean }[]).every((c) => c.ok);

  // --- Unit matrix 3: normal chats must NOT trigger any escalation detector ---
  const normalCases: string[] = [
    'আসসালামু আলাইকুম',
    'Hi',
    'জিন্সের দাম কত?',
    'টি-শার্টের স্টক আছে?',
    'অর্ডার করতে চাই',
    'আমার ঠিকানা ঢাকা',
    'ডেলিভারি চার্জ কত?',
    'jeans er dam koto',
    'jins ase?',
    'tumi kemon aso',
    'Ata',
    'chobi dao',
    'কি কি প্রোডাক্ট আছে',
    'আমার নাম রহিম',
    '500 টাকা',
  ];
  out.normalUnit = normalCases.map((text) => {
    const angry = detectAnger(text);
    const off = detectOffTopic(text);
    const gib = detectGibberish(text);
    return { text: text.slice(0, 30), angry, offTopic: off, gibberish: gib, ok: !angry && !off && !gib };
  });
  out.normalUnitAllOk = (out.normalUnit as { ok: boolean }[]).every((c) => c.ok);

  // --- Unit matrix 4: Banglish show-match (Romanized aliases) ---
  const catalog = [
    { id: jeansId, name: 'Jeans' },
    { id: tshirtId, name: 'T-shirt' },
    { id: shirtId, name: 'Shirt' },
  ];
  out.banglishShowUnit = [
    { text: 'jins ta dekhao', expected: jeansId, got: matchShowProduct('jins ta dekhao', catalog)?.id ?? null },
    { text: 'shart ta dekhao', expected: shirtId, got: matchShowProduct('shart ta dekhao', catalog)?.id ?? null },
    { text: 'tishart ta dekhao', expected: tshirtId, got: matchShowProduct('tishart ta dekhao', catalog)?.id ?? null },
    { text: 'জিন্সটা দেখাও', expected: jeansId, got: matchShowProduct('জিন্সটা দেখাও', catalog)?.id ?? null },
  ].map((c) => ({ ...c, ok: c.got === c.expected }));
  out.banglishShowUnitAllOk = (out.banglishShowUnit as { ok: boolean }[]).every((c) => c.ok);

  // --- Unit matrix 5: Banglish list-request (must hit the free
  // deterministic list flow, not fall through to the LLM) ---
  const listCases: [string, boolean][] = [
    ['ki ki product ase', true],
    ['ki ki product ache', true],
    ['sob product dekhao', true],
    ['product gulo ki ki', true],
    ['tomader kache ki ase', true],
    ['কি কি প্রোডাক্ট আছে?', true],
    ['জিন্সের দাম কত?', false],
    ['jins er dam koto', false],
  ];
  out.banglishListUnit = listCases.map(([text, expected]) => ({ text: text.slice(0, 30), expected, got: detectProductListRequest(text), ok: detectProductListRequest(text) === expected }));
  out.banglishListUnitAllOk = (out.banglishListUnit as { ok: boolean }[]).every((c) => c.ok);

  // --- Shop knowledge (delivery charge) for the normal-regression flow.
  // Boot 1 already created it via the API; only insert if missing. ---
  await pool.query(
    `INSERT INTO knowledge_items (workspace_id, title, body)
     SELECT $1, 'ডেলিভারি চার্জ', 'সারা বাংলাদেশে কুরিয়ারের মাধ্যমে ডেলিভারি দেওয়া হয়। ঢাকার ভেতরে ডেলিভারি চার্জ ১০০ টাকা। ঢাকার বাইরে পুরো বাংলাদেশে ডেলিভারি চার্জ ১৩০ টাকা।'
     WHERE NOT EXISTS (SELECT 1 FROM knowledge_items WHERE workspace_id = $1 AND title = 'ডেলিভারি চার্জ')`,
    [workspaceId],
  );

  // --- Banglish price question → Bengali reply with ৳500, stays open ---
  {
    const { conversationId } = await seedConversation('Banglish Customer');
    const result = await processBatch(workspaceId, conversationId, [{ body: 'jins er dam koto' }]);
    const state = await convState(conversationId);
    const bodies = await outMessages(conversationId);
    out.banglishPrice = {
      conversationId, result, state, outBodies: bodies,
      bengaliReply: bodies.some((b) => /[\u0980-\u09FF]/.test(b) && b.includes('500')),
    };
  }

  // --- Product list → clean text list, one product per line, one message ---
  {
    const { conversationId } = await seedConversation('List Customer');
    const result = await processBatch(workspaceId, conversationId, [{ body: 'কি কি প্রোডাক্ট আছে' }]);
    const state = await convState(conversationId);
    const bodies = await outMessages(conversationId);
    const listBody = bodies[0] ?? '';
    const lines = listBody.split('\n').filter((l) => l.trim().length > 0);
    out.listFormat = {
      conversationId, result, state, outBodies: bodies,
      oneMessage: bodies.length === 1,
      hasListHeader: listBody.includes('আমাদের প্রোডাক্টগুলো:'),
      jeansLine: lines.some((l) => l.includes('Jeans') && l.includes('500')),
      tshirtLine: lines.some((l) => l.includes('T-shirt') && l.includes('400')),
      shirtLine: lines.some((l) => l.includes('Shirt') && l.includes('600')),
    };
  }

  // --- Photo request without a product (Banglish) → ask which ---
  {
    const { conversationId } = await seedConversation('Photo Customer');
    const result = await processBatch(workspaceId, conversationId, [{ body: 'chobi dao' }]);
    const state = await convState(conversationId);
    const bodies = await outMessages(conversationId);
    out.askWhich = {
      conversationId, result, state, outBodies: bodies,
      asksWhich: bodies.some((b) => b.includes('কোন প্রোডাক্টটি দেখতে চাচ্ছেন')),
    };
  }

  // --- Repeat greeting → contextual reply (not a fresh welcome) ---
  {
    const { conversationId } = await seedConversation('Repeat Greeter');
    await seedOutMessage(conversationId, 'স্যার, জিন্সের দাম ৳৫০০।');
    const result = await processBatch(workspaceId, conversationId, [{ body: 'Hi' }]);
    const state = await convState(conversationId);
    const bodies = await outMessages(conversationId);
    const last = bodies[bodies.length - 1] ?? '';
    out.repeatGreeting = {
      conversationId, result, state, outBodies: bodies,
      contextual: last.includes('প্রোডাক্টটা নেবেন') || last.includes('নতুন করে কিছু বলতে চাচ্ছেন'),
    };
  }

  // --- Gibberish: once → reply; again → silent; meaningful → reply again ---
  {
    const { conversationId } = await seedConversation('Gibberish Customer');
    const r1 = await processBatch(workspaceId, conversationId, [{ body: 'asdfghjkl' }]);
    const after1 = await outMessages(conversationId);
    const state1 = await convState(conversationId);
    const r2 = await processBatch(workspaceId, conversationId, [{ body: 'zxcvbnm' }]);
    const after2 = await outMessages(conversationId);
    const state2 = await convState(conversationId);
    const r3 = await processBatch(workspaceId, conversationId, [{ body: 'জিন্সের দাম কত?' }]);
    const after3 = await outMessages(conversationId);
    const state3 = await convState(conversationId);
    out.gibberishFlow = {
      conversationId,
      first: { result: r1, outCount: after1.length, warned: state1.gibberish_warned, repliedOnce: after1.some((b) => b.includes('বুঝতে পারিনি')) },
      second: { result: r2, outCount: after2.length, reason: r2.reason, state: state2 },
      meaningful: { result: r3, outCount: after3.length, state: state3, hasPrice: after3.some((b) => b.includes('500')) },
    };
  }

  // --- Angry → Waiting + notification, no AI reply ---
  {
    const { conversationId } = await seedConversation('Angry Customer');
    const result = await processBatch(workspaceId, conversationId, [{ body: 'তোমরা ফালতু, ঠকবাজ!' }]);
    const state = await convState(conversationId);
    const note = await notificationFor(conversationId);
    out.angry = {
      conversationId, result, state, outMessages: await outCount(conversationId), notification: note,
    };
  }

  // --- Off-topic → Waiting + notification, no AI reply ---
  {
    const { conversationId } = await seedConversation('OffTopic Customer');
    const result = await processBatch(workspaceId, conversationId, [{ body: 'তুমি ছেলে নাকি মেয়ে?' }]);
    const state = await convState(conversationId);
    const note = await notificationFor(conversationId);
    out.offTopic = {
      conversationId, result, state, outMessages: await outCount(conversationId), notification: note,
    };
  }

  // --- Normal regression via processBatch (demo mode): each stays open + gets a reply ---
  const normalFlows: [string, string][] = [
    ['জিন্সের দাম কত?', '500'],
    ['ঢাকার বাইরে ডেলিভারি চার্জ কত?', '130'],
    ['jins ase?', 'Jeans'],
    ['টি-শার্টের স্টক আছে?', 'T-shirt'],
  ];
  out.normalFlows = [];
  for (const [text, needle] of normalFlows) {
    const { conversationId } = await seedConversation('Normal Customer');
    const result = await processBatch(workspaceId, conversationId, [{ body: text }]);
    const state = await convState(conversationId);
    const bodies = await outMessages(conversationId);
    (out.normalFlows as Record<string, unknown>[]).push({
      text, result, state, outBodies: bodies,
      ok: result.replied === true && state.status === 'open' && !state.escalation_reason && bodies.some((b) => b.includes(needle)),
    });
  }
  out.normalFlowsAllOk = (out.normalFlows as { ok: boolean }[]).every((c) => c.ok);

  // --- Order flow (requirements A + B + C): phone, address, place, confirmation, charges ---
  const toolDb = pool as unknown as Parameters<typeof runTool>[0];
  const chargeDb = { query: (text: string, params?: unknown[]) => pool.query(text, params as never[]) };

  // Unit: phone validation (11 digits, starts with 01).
  const phoneCases: [string, string | null][] = [
    ['01712345678', '01712345678'],
    ['+8801712345678', '01712345678'],
    ['8801712345678', '01712345678'],
    ['01712 345678', '01712345678'],
    ['0171234567', null], // 10 digits
    ['17123456', null], // 8 digits
    ['02123456789', null], // not 01
    ['017123456789', null], // 12 digits
    ['', null],
  ];
  out.phoneUnit = phoneCases.map(([given, expected]) => ({ given, expected, got: normalizeBdPhone(given), ok: normalizeBdPhone(given) === expected }));
  out.phoneUnitAllOk = (out.phoneUnit as { ok: boolean }[]).every((c) => c.ok);

  // Unit: address completeness.
  const addressCases: [string, boolean, boolean][] = [
    ['Dhaka', false, true], // bare district
    ['মাগুরা', false, true], // bare district (Bengali)
    ['বাসা ১২, রোড ৫, ধানমন্ডি, ঢাকা', true, false],
    ['বাসা ১২, রোড ৫', false, false], // no district
    ['গ্রাম কাশিনাথপুর, পাবনা', true, false],
  ];
  out.addressUnit = addressCases.map(([text, complete, bare]) => {
    const got = assessAddressCompleteness(text);
    return { text: text.slice(0, 30), complete: got.complete, bareDistrict: got.bareDistrict, ok: got.complete === complete && got.bareDistrict === bare };
  });
  out.addressUnitAllOk = (out.addressUnit as { ok: boolean }[]).every((c) => c.ok);

  // Unit: light place verification (village/house details never flag).
  const placeCases: [string, string[]][] = [
    ['বাসা ১২, রোড ৫, ধানমন্ডি, ঢাকা', []],
    ['গ্রাম কাশিনাথপুর, পাবনা', []],
    ['বাসা ১২, রোড ৫, মাগুরা, ঢাক্কা', ['ঢাক্কা']],
    ['বাসা ৫, মাগুরা সদর, মাগুরা', []],
  ];
  out.placeUnit = placeCases.map(([text, expected]) => {
    const got = findUnknownPlaceNames(text);
    return { text: text.slice(0, 30), expected, got, ok: JSON.stringify(got) === JSON.stringify(expected) };
  });
  out.placeUnitAllOk = (out.placeUnit as { ok: boolean }[]).every((c) => c.ok);

  // Tool: create_order with an invalid phone (10 digits) → refuses, no order.
  {
    const { customerId, conversationId } = await seedConversation('Order Phone Customer');
    const r = await runTool(toolDb, workspaceId, 'create_order', {
      customerId, conversationId,
      items: [{ productId: jeansId, quantity: 1 }],
      customerName: 'Order Phone Customer', customerPhone: '0171234567', deliveryAddress: 'বাসা ১২, রোড ৫, ধানমন্ডি, ঢাকা',
    });
    const orders = await pool.query('SELECT id FROM orders WHERE workspace_id = $1 AND customer_id = $2', [workspaceId, customerId]);
    out.orderInvalidPhone = { result: r, orderCount: orders.rows.length, ok: !r.orderId && r.invalidPhone === true && orders.rows.length === 0 };
  }

  // Tool: create_order with a bare-district address ("Dhaka") → refuses, asks for the FULL address.
  {
    const { customerId, conversationId } = await seedConversation('Order Bare Customer');
    const r = await runTool(toolDb, workspaceId, 'create_order', {
      customerId, conversationId,
      items: [{ productId: jeansId, quantity: 1 }],
      customerName: 'Order Bare Customer', customerPhone: '01712345678', deliveryAddress: 'Dhaka',
    });
    const orders = await pool.query('SELECT id FROM orders WHERE workspace_id = $1 AND customer_id = $2', [workspaceId, customerId]);
    out.orderBareDistrict = { result: r, orderCount: orders.rows.length, ok: !r.orderId && (r.missingAddressParts as string[] | undefined)?.includes('area') === true && orders.rows.length === 0 };
  }

  // Tool: create_order with an unknown place → needs confirmation, no order; with placeConfirmed → order created.
  {
    const { customerId, conversationId } = await seedConversation('Order Place Customer');
    const r1 = await runTool(toolDb, workspaceId, 'create_order', {
      customerId, conversationId,
      items: [{ productId: jeansId, quantity: 1 }],
      customerName: 'Order Place Customer', customerPhone: '01712345678', deliveryAddress: 'বাসা ১২, রোড ৫, মাগুরা, ঢাক্কা',
    });
    const before = await pool.query('SELECT id FROM orders WHERE workspace_id = $1 AND customer_id = $2', [workspaceId, customerId]);
    const r2 = await runTool(toolDb, workspaceId, 'create_order', {
      customerId, conversationId,
      items: [{ productId: jeansId, quantity: 1 }],
      customerName: 'Order Place Customer', customerPhone: '01712345678', deliveryAddress: 'বাসা ১২, রোড ৫, মাগুরা, ঢাক্কা',
      placeConfirmed: true,
    });
    const after = await pool.query('SELECT id FROM orders WHERE workspace_id = $1 AND customer_id = $2', [workspaceId, customerId]);
    out.orderUnknownPlace = {
      first: r1, second: r2, beforeCount: before.rows.length, afterCount: after.rows.length,
      ok: !r1.orderId && r1.needsPlaceConfirmation === true && before.rows.length === 0 && typeof r2.orderId === 'string' && after.rows.length === 1,
    };
  }

  // Tool: valid order → confirmation text (name, phone, address, items, delivery charge, total, "অর্ডার কনফার্ম করা হলো").
  {
    const { customerId, conversationId } = await seedConversation('Order Good Customer');
    const r = await runTool(toolDb, workspaceId, 'create_order', {
      customerId, conversationId,
      items: [{ productId: jeansId, quantity: 1 }],
      customerName: 'Order Good Customer', customerPhone: '01712345678', deliveryAddress: 'বাসা ১২, রোড ৫, ধানমন্ডি, ঢাকা',
    });
    const conf = String(r.confirmationText ?? '');
    out.orderConfirmation = {
      result: r, confirmationText: conf,
      ok: typeof r.orderId === 'string'
        && r.deliveryChargePaisa === 10000 && r.grandTotalPaisa === 60000
        && conf.includes('অর্ডার কনফার্ম করা হলো') && conf.includes('Order Good Customer')
        && conf.includes('01712345678') && conf.includes('ধানমন্ডি') && conf.includes('Jeans')
        && conf.includes('৳100') && conf.includes('৳600'),
    };
  }

  // Tool: order without an explicit name → still created (uses the stored/Facebook name), no name fuss.
  {
    const { customerId, conversationId } = await seedConversation('Order NoName Customer');
    const r = await runTool(toolDb, workspaceId, 'create_order', {
      customerId, conversationId,
      items: [{ productId: jeansId, quantity: 1 }],
      customerPhone: '01712345678', deliveryAddress: 'বাসা ১২, রোড ৫, ধানমন্ডি, ঢাকা',
    });
    const conf = String(r.confirmationText ?? '');
    out.orderNoName = {
      result: r, confirmationText: conf,
      ok: typeof r.orderId === 'string' && conf.includes('Order NoName Customer') && conf.includes('অর্ডার কনফার্ম করা হলো'),
    };
  }

  // Requirement C: set a custom charge → the AI quotes it AND the order total uses it.
  {
    // Set inside-Dhaka to ৳150 (was ৳100) for this workspace.
    await setDeliveryChargeRules(chargeDb, workspaceId, [
      { scope: 'inside_dhaka', chargePaisa: 15000 },
      { scope: 'outside_dhaka', chargePaisa: 13000 },
    ]);
    const rules = await getDeliveryChargeRules(chargeDb, workspaceId);
    const resolved = resolveDeliveryCharge(rules, 'বাসা ১২, রোড ৫, ধানমন্ডি, ঢাকা');
    // The AI (demo mode) quotes the configured charge for a delivery-charge question.
    const { conversationId: dcConv } = await seedConversation('Charge Customer');
    const dcResult = await processBatch(workspaceId, dcConv, [{ body: 'ঢাকার ভিতরে ডেলিভারি চার্জ কত?' }]);
    const dcBodies = await outMessages(dcConv);
    const dcText = dcBodies.join('\n');
    // An order for a Dhaka address uses the configured ৳150 charge (500 + 150 = 650).
    const { customerId, conversationId } = await seedConversation('Order Charge Customer');
    const r = await runTool(toolDb, workspaceId, 'create_order', {
      customerId, conversationId,
      items: [{ productId: jeansId, quantity: 1 }],
      customerName: 'Order Charge Customer', customerPhone: '01712345678', deliveryAddress: 'বাসা ১২, রোড ৫, ধানমন্ডি, ঢাকা',
    });
    out.deliveryChargeCustom = {
      rules: rules.map((x) => ({ scope: x.scope, chargePaisa: x.chargePaisa })),
      resolved, dcResult, dcText: dcText.slice(0, 200), orderResult: r,
      ok: resolved.chargePaisa === 15000
        && dcResult.replied === true && dcText.includes('150')
        && typeof r.orderId === 'string' && r.deliveryChargePaisa === 15000 && r.grandTotalPaisa === 65000
        && String(r.confirmationText ?? '').includes('৳150') && String(r.confirmationText ?? '').includes('৳650'),
    };
    // Restore the defaults for the remaining tests.
    await setDeliveryChargeRules(chargeDb, workspaceId, [
      { scope: 'inside_dhaka', chargePaisa: 10000 },
      { scope: 'outside_dhaka', chargePaisa: 13000 },
    ]);
  }

  console.log('DRIVER_RESULT ' + JSON.stringify(out));
  await pool.end();
}

main().catch((err) => {
  console.error('driver crashed:', err);
  process.exit(1);
});
