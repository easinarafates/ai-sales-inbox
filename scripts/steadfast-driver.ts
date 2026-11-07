// Driver for verify-steadfast.mjs — tests the real Steadfast provider with a
// STUBBED fetch (no live Steadfast calls, ever) and the shipment status
// check + customer notification against the same PGlite dir the verifier's
// API boot uses. Run AFTER the API boot stops (PGlite is single-process),
// with:
//   USE_PGLITE=true PGLITE_DATA_DIR=<dir> npx tsx scripts/steadfast-driver.ts <workspaceId>
// Prints one DRIVER_RESULT JSON line for the verifier to parse.
// No secrets are printed. Test keys only — never a real merchant key.
import { pool } from '../apps/api/src/db/pool';
import { encryptToken } from '../apps/api/src/db/crypto';

const [workspaceId] = process.argv.slice(2);
if (!workspaceId) {
  console.error('usage: steadfast-driver.ts <workspaceId>');
  process.exit(2);
}

const out: Record<string, unknown> = {};
const fetchCalls: { url: string; method: string; headers: Record<string, string>; body: string }[] = [];
let graphCalls: { url: string; body: string }[] = [];
let steadfastMode: 'ok' | 'createError' = 'ok';

function stubFetch(url: string, init: Record<string, unknown>): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> {
  const method = String((init as { method?: string }).method ?? 'GET');
  const headers = ((init as { headers?: Record<string, string> }).headers ?? {}) as Record<string, string>;
  const body = String((init as { body?: string }).body ?? '');
  if (url.includes('graph.facebook.com')) {
    graphCalls.push({ url, body });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ message_id: 'm_test123' }) });
  }
  fetchCalls.push({ url, method, headers, body });
  const u = String(url);
  if (u.includes('/create_order')) {
    if (steadfastMode === 'createError') {
      return Promise.resolve({ ok: false, status: 400, json: async () => ({ message: 'Invalid phone number' }) });
    }
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        status: 200,
        message: 'Consignment has been created successfully.',
        consignment: {
          consignment_id: 1424107,
          invoice: parsed.invoice,
          tracking_code: '15BAEB8A',
          recipient_name: parsed.recipient_name,
          recipient_phone: parsed.recipient_phone,
          recipient_address: parsed.recipient_address,
          cod_amount: parsed.cod_amount,
          status: 'in_review',
        },
      }),
    });
  }
  if (u.includes('/status_by_cid/1424107')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ status: 200, delivery_status: 'delivered' }) });
  }
  if (u.includes('/status_by_cid/1424108')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ status: 200, delivery_status: 'hold' }) });
  }
  if (u.includes('/status_by_trackingcode/15BAEB8A')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ status: 200, delivery_status: 'in_review' }) });
  }
  if (u.includes('/get_balance')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ status: 200, current_balance: 1250 }) });
  }
  return Promise.resolve({ ok: false, status: 404, json: async () => ({ message: 'not found in stub' }) });
}

async function main(): Promise<void> {
  // Install the fetch stub BEFORE importing the provider (it uses global fetch).
  (globalThis as unknown as { fetch: unknown }).fetch = stubFetch as unknown;

  const providerMod = await import('../apps/api/src/courier/provider');
  const { config } = await import('../apps/api/src/config');

  const baseOrder = {
    id: '11111111-2222-3333-4444-555555555555',
    customerId: 'cust-1',
    totalPaisa: 50000,
    status: 'pending',
    customerName: 'Test Customer',
    customerPhone: '01712345678',
    customerAddress: 'House 1, Dhanmondi, Dhaka',
  };

  // (1) Missing keys → honest ProviderNotConfiguredError, no fetch call.
  const provider = new providerMod.SteadfastCourierProvider();
  let missingKeysError = '';
  try {
    await provider.createBooking(baseOrder);
  } catch (err) {
    missingKeysError = (err as Error).name + ':' + ((err as { code?: string }).code ?? '');
  }
  out.missingKeysError = missingKeysError;
  out.missingKeysNoFetch = fetchCalls.length === 0;

  // Configure test keys (test values only) for the rest of the run.
  (config.courier.steadfast as { apiKey: string }).apiKey = 'TEST_API_KEY';
  (config.courier.steadfast as { secretKey: string }).secretKey = 'TEST_SECRET_KEY';

  // (2) Dhaka booking: COD = 500 + 100 delivery charge.
  const dhaka = await provider.createBooking(baseOrder);
  const createCall = fetchCalls.find((c) => c.url.includes('/create_order'));
  const createBody = JSON.parse(createCall?.body ?? '{}') as Record<string, unknown>;
  out.dhakaBookingId = dhaka.providerBookingId;
  out.dhakaTracking = dhaka.trackingNumber;
  out.dhakaStatus = dhaka.status;
  out.createUrl = createCall?.url ?? '';
  out.createMethod = createCall?.method ?? '';
  out.createHeaderApiKey = createCall?.headers['Api-Key'] ?? '';
  out.createHeaderSecretKey = createCall?.headers['Secret-Key'] ?? '';
  out.createHeaderContentType = createCall?.headers['Content-Type'] ?? '';
  out.createInvoice = createBody.invoice ?? '';
  out.createCodDhaka = createBody.cod_amount ?? null;
  out.createPhone = createBody.recipient_phone ?? '';
  out.createName = createBody.recipient_name ?? '';
  out.createAddress = createBody.recipient_address ?? '';

  // (3) Outside Dhaka: COD = 500 + 130.
  const outside = await provider.createBooking({ ...baseOrder, customerAddress: 'House 2, Agrabad, Chittagong' });
  const outsideCall = fetchCalls.filter((c) => c.url.includes('/create_order')).pop();
  out.createCodOutside = (JSON.parse(outsideCall?.body ?? '{}') as Record<string, unknown>).cod_amount ?? null;
  out.outsideBookingId = outside.providerBookingId;

  // (4) Unclear address defaults to 130.
  out.createCodUnclear = providerMod.codAmountBdt({ ...baseOrder, customerAddress: 'Some village road' });
  out.chargeDhaka = providerMod.deliveryChargeForAddress('Dhanmondi, Dhaka');
  out.chargeDhakaBn = providerMod.deliveryChargeForAddress('ধানমন্ডি, ঢাকা');
  out.chargeOutside = providerMod.deliveryChargeForAddress('Chittagong');
  out.chargeUnclear = providerMod.deliveryChargeForAddress(null);

  // (5) Phone normalization: +880 form → 11-digit 01 form; bad phone refused with no fetch.
  const beforeBad = fetchCalls.length;
  const intl = await provider.createBooking({ ...baseOrder, customerPhone: '+8801712345678' });
  const intlCall = fetchCalls.filter((c) => c.url.includes('/create_order')).pop();
  out.intlPhone = (JSON.parse(intlCall?.body ?? '{}') as Record<string, unknown>).recipient_phone ?? '';
  out.intlBookingId = intl.providerBookingId;
  let badPhoneError = '';
  try {
    await provider.createBooking({ ...baseOrder, customerPhone: '123' });
  } catch (err) {
    badPhoneError = (err as Error).name;
  }
  out.badPhoneError = badPhoneError;
  out.badPhoneNoFetch = fetchCalls.length === beforeBad + 1;

  // (6) Track + balance + status-by-consignment.
  const tracked = await provider.track('15BAEB8A');
  out.trackAvailable = tracked.available;
  out.trackStatus = tracked.status ?? null;
  out.balance = await provider.getBalance();
  out.statusByCid = await provider.getStatusByConsignmentId('1424107');

  // (7) Steadfast error response → throws with Steadfast's message, no fake booking.
  steadfastMode = 'createError';
  let createErrorMsg = '';
  try {
    await provider.createBooking(baseOrder);
  } catch (err) {
    createErrorMsg = (err as Error).message;
  }
  out.createErrorMsg = createErrorMsg;
  steadfastMode = 'ok';

  // (8) Shipment status check + customer notification (PGlite, stubbed fetch).
  const trackingCheck = await import('../apps/api/src/courier/tracking-check');
  const channel = await pool.query(
    `INSERT INTO channels (workspace_id, platform, external_id, display_name, token_encrypted, status)
     VALUES ($1, 'messenger', 'PAGE_TEST_123', 'Test Page', $2, 'connected') RETURNING id`,
    [workspaceId, encryptToken('TEST_PAGE_TOKEN')],
  );
  const channelId = channel.rows[0].id as string;
  const customer = await pool.query(
    `INSERT INTO customers (workspace_id, name, phone, gender, channel_identities)
     VALUES ($1, 'Notify Test', '01712345678', 'male', $2::jsonb) RETURNING id`,
    [workspaceId, JSON.stringify([{ platform: 'messenger', senderId: 'PSID_TEST_123' }])],
  );
  const customerId = customer.rows[0].id as string;
  const conv = await pool.query(
    `INSERT INTO conversations (workspace_id, channel_id, customer_id, status, mode)
     VALUES ($1, $2, $3, 'open', 'ai') RETURNING id`,
    [workspaceId, channelId, customerId],
  );
  const convId = conv.rows[0].id as string;
  const order = await pool.query(
    `INSERT INTO orders (workspace_id, customer_id, conversation_id, source, status, payment_status, total_paisa, customer_name, customer_phone, delivery_address)
     VALUES ($1, $2, $3, 'messenger', 'pending', 'unpaid', 50000, 'Notify Test', '01712345678', 'House 1, Dhanmondi, Dhaka') RETURNING id`,
    [workspaceId, customerId, convId],
  );
  const orderId = order.rows[0].id as string;
  await pool.query(
    `INSERT INTO shipments (workspace_id, order_id, courier, tracking_code, tracking_number, provider_booking_id, status)
     VALUES ($1, $2, 'steadfast', '15BAEB8A', '15BAEB8A', '1424107', 'in_review')`,
    [workspaceId, orderId],
  );
  await pool.query(
    `INSERT INTO shipments (workspace_id, order_id, courier, tracking_code, tracking_number, provider_booking_id, status)
     VALUES ($1, $2, 'steadfast', '15BAEB8B', '15BAEB8B', '1424108', 'pending')`,
    [workspaceId, orderId],
  );
  graphCalls = [];
  const summary1 = await trackingCheck.processDueShipmentChecks(workspaceId);
  out.check1 = summary1;
  const ship1 = await pool.query('SELECT status, last_notified_status FROM shipments WHERE provider_booking_id = $1', ['1424107']);
  out.ship1After = ship1.rows[0] ?? null;
  const ship2 = await pool.query('SELECT status, last_notified_status FROM shipments WHERE provider_booking_id = $1', ['1424108']);
  out.ship2After = ship2.rows[0] ?? null;
  const msgs = await pool.query(
    `SELECT body, delivery_status, platform_message_id FROM messages WHERE workspace_id = $1 AND conversation_id = $2 AND direction = 'out' ORDER BY created_at`,
    [workspaceId, convId],
  );
  out.notifyMessages = msgs.rows;
  out.graphCalls = graphCalls;
  // Second run: terminal shipment is skipped, hold was already notified — no duplicates.
  graphCalls = [];
  const summary2 = await trackingCheck.processDueShipmentChecks(workspaceId);
  out.check2 = summary2;
  out.graphCalls2 = graphCalls.length;
  const msgs2 = await pool.query('SELECT COUNT(*) AS n FROM messages WHERE workspace_id = $1 AND conversation_id = $2 AND direction = $3', [workspaceId, convId, 'out']);
  out.notifyMessageCountAfterSecondRun = Number((msgs2.rows[0] as { n: string }).n);

  console.log('DRIVER_RESULT ' + JSON.stringify(out));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('DRIVER_ERROR', (err as Error).message);
    process.exit(1);
  });
