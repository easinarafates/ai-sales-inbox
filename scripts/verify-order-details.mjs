#!/usr/bin/env node
/**
 * Verification for the Orders A-to-Z details fix (2026-11-07).
 *
 * The problem: the Orders page showed only an id, a total and a status —
 * never who ordered, when they could be reached, or where to deliver.
 * The orders table had no phone/address snapshot, and the create_order AI
 * tool accepted only {items}, so the AI could not pass or store the
 * phone/address even when it asked for them (it once falsely claimed it
 * already had them and created the order anyway).
 *
 * The fix:
 * - Migration 24: orders.customer_name / customer_phone / delivery_address.
 * - Shared resolveOrderContact() (orders/contact.ts): the AI create_order
 *   tool AND POST /api/orders refuse when the phone or delivery address is
 *   missing, and otherwise store the contact on the customer row AND
 *   snapshot it onto the order.
 * - AI prompt rule 2ক: never claim the phone/address is already known;
 *   the user prompt shows 'দেওয়া হয়নি' when either is missing.
 * - GET /api/orders + GET /api/orders/:id join the customer row, so the
 *   pages show name + avatar/photo, phone, delivery address, source,
 *   status, payment, items with line totals, and total.
 * - Orders list + detail pages show all of it, with an honest
 *   'দেওয়া হয়নি' / 'Not provided' when phone/address are missing, and
 *   the detail page links to the Inbox conversation (?conversation=<id>).
 *
 * Checks:
 * - Static: migration, tool refusal + snapshot, prompt rule, API join,
 *   web pages (avatar, address column, line totals, conversation link,
 *   'not provided' label).
 * - Boot 1 (local API on PGlite): POST /api/orders without contact → 400
 *   (missingPhone/missingAddress); phone-only → 400 (missingAddress);
 *   full contact → 201 with snapshot + bill naming the address; customer
 *   row updated; list + detail show every A-to-Z field; line totals sum
 *   to the order total.
 * - Driver (runTool directly, same PGlite dir, API stopped): the tool
 *   refuses without contact (and creates nothing) and creates + snapshots
 *   with contact; a legacy no-contact order is seeded.
 * - Boot 2 (same dir): the legacy order lists with NULL snapshot AND NULL
 *   customer phone/address (the shape of the 2 live orders) — the honest
 *   'not provided' case — while the tool-created order shows its snapshot.
 *
 * Run from the repo root:  node scripts/verify-order-details.mjs
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const results = [];
let token = '';
/** Dummy webchat secret for the local boots (must match the boot env). */
const WEBCHAT_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeApi(base) {
  return async function api(path, { method = 'GET', body, auth = true, headers = {} } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data, text };
  };
}

async function waitForHealth(base, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(1000);
  }
  return false;
}

function startApi(port, dataDir, extraEnv = {}) {
  const apiProc = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: path.join(ROOT, 'apps/api'),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: {
      ...process.env,
      PORT: String(port),
      USE_PGLITE: 'true',
      PGLITE_DATA_DIR: dataDir,
      JWT_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      WEBCHAT_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      META_APP_ID: 'dummy-app-id',
      META_APP_SECRET: 'dummy-app-secret',
      ...extraEnv,
    },
  });
  let apiLog = '';
  apiProc.stdout.on('data', (d) => { apiLog += d.toString(); });
  apiProc.stderr.on('data', (d) => { apiLog += d.toString(); });
  const stop = () => {
    try { process.kill(-apiProc.pid, 'SIGTERM'); } catch { try { apiProc.kill('SIGTERM'); } catch { /* already gone */ } }
  };
  return { proc: apiProc, stop, log: () => apiLog };
}

function runDriver(dataDir, workspaceId, jeansId, tshirtId) {
  return new Promise((resolve) => {
    const proc = spawn('npx', ['tsx', '../../scripts/order-details-driver.ts', workspaceId, jeansId, tshirtId], {
      cwd: path.join(ROOT, 'apps/api'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        USE_PGLITE: 'true',
        PGLITE_DATA_DIR: dataDir,
        JWT_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        WEBCHAT_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      },
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('close', (code) => resolve({ code, out, err }));
  });
}

async function main() {
  // ---------- Static checks ----------
  const mig = fs.readFileSync(path.join(ROOT, 'apps/api/src/db/migrations/24-order-delivery-details.sql'), 'utf8');
  check('migration 24 adds customer_name to orders', mig.includes('ADD COLUMN IF NOT EXISTS customer_name'));
  check('migration 24 adds customer_phone to orders', mig.includes('ADD COLUMN IF NOT EXISTS customer_phone'));
  check('migration 24 adds delivery_address to orders', mig.includes('ADD COLUMN IF NOT EXISTS delivery_address'));

  const contactSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/orders/contact.ts'), 'utf8');
  check('shared resolveOrderContact exists', contactSrc.includes('export async function resolveOrderContact'));
  check('contact helper refuses when phone/address missing', contactSrc.includes('missingPhone') && contactSrc.includes('missingAddress') && contactSrc.includes('Ask the customer for it first'));

  const toolsSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/ai-agent/tools.ts'), 'utf8');
  check('create_order tool resolves contact first', toolsSrc.includes('resolveOrderContact(db, workspaceId, customerId'));
  check('create_order tool returns refusal with missing flags', toolsSrc.includes('missingPhone: missingPhone ?? false'));
  check('create_order INSERT snapshots contact onto the order', toolsSrc.includes('customer_name, customer_phone, delivery_address'));
  check('create_order bill confirms delivery details', toolsSrc.includes('deliveryAddress: contact.deliveryAddress'));

  const promptSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/ai-agent/prompts.ts'), 'utf8');
  check('prompt rule 2k: never claim contact is already known', promptSrc.includes('2ক') && promptSrc.includes('দেওয়া হয়নি'));
  check('prompt create_order spec includes phone + address', promptSrc.includes('customerPhone') && promptSrc.includes('deliveryAddress'));
  check('user prompt shows phone/address or দেওয়া হয়নি', promptSrc.includes("ফোন: ${ctx.customerPhone ?? 'দেওয়া হয়নি'}") && promptSrc.includes("ঠিকানা: ${ctx.customerAddress ?? 'দেওয়া হয়নি'}"));

  const ordersSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/orders/routes.ts'), 'utf8');
  check('POST /api/orders uses resolveOrderContact + refuses', ordersSrc.includes('resolveOrderContact(') && ordersSrc.includes("res.status(400).json({ error: error ?? 'Phone number and delivery address are required'"));
  check('POST /api/orders snapshots contact onto the order', ordersSrc.includes('customer_name, customer_phone, delivery_address'));
  check('GET /api/orders joins the customer row', ordersSrc.includes('LEFT JOIN customers c ON c.id = o.customer_id'));
  check('detail loader attaches the customer object', ordersSrc.includes('withCustomer(order'));

  const listSrc = fs.readFileSync(path.join(ROOT, 'apps/web/app/orders/page.tsx'), 'utf8');
  check('list page shows avatar + phone + address columns', listSrc.includes('CustomerAvatar') && listSrc.includes('thAddress') && listSrc.includes('notProvided'));
  check('list page shows source (via)', listSrc.includes('orderSourceLabel'));
  check('list page shows honest not-provided label', listSrc.includes('"দেওয়া হয়নি"'));

  const detailSrc = fs.readFileSync(path.join(ROOT, 'apps/web/app/orders/[id]/page.tsx'), 'utf8');
  check('detail page has Customer & delivery card', detailSrc.includes('Customer & delivery') && detailSrc.includes('addressLabel'));
  check('detail page links to the Inbox conversation', detailSrc.includes('/inbox?conversation=${convId}'));
  check('detail page has a line-total column', detailSrc.includes('thLineTotal') && detailSrc.includes('lineTotal(it)'));
  check('detail page flags a total mismatch honestly', detailSrc.includes('totalMismatch'));

  const inboxSrc = fs.readFileSync(path.join(ROOT, 'apps/web/app/inbox/page.tsx'), 'utf8');
  check('inbox opens ?conversation= deep links', inboxSrc.includes('searchParams.get("conversation")') && inboxSrc.includes('Suspense'));

  // ---------- Boot 1: API behaviour over HTTP ----------
  const stamp = Date.now();
  const port = 4019;
  const dataDir = '.pglite-data-orddet';
  const run1 = startApi(port, dataDir);
  process.on('exit', run1.stop);
  let workspaceId = '';
  let jeansId = '';
  let tshirtId = '';
  let apiOrderId = '';
  try {
    const up = await waitForHealth(`http://localhost:${port}`);
    check('boot 1: API starts', up, up ? '' : run1.log().slice(-500));
    if (!up) return;
    const api = makeApi(`http://localhost:${port}`);
    const signup = await api('/api/auth/signup', {
      method: 'POST', auth: false,
      body: { name: 'Order Owner', email: `orddet+${stamp}@example.com`, password: 'verify1234', workspaceName: 'Order Test Shop' },
    });
    check('boot 1: signup', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
    token = signup.data?.token ?? '';
    workspaceId = signup.data?.workspace?.id ?? '';
    const live = await api(`/api/workspaces/${workspaceId}/go-live`, { method: 'POST' });
    check('boot 1: go-live', live.status === 200 && live.data?.workspace?.practice_mode === false, `status=${live.status}`);

    for (const p of [
      { name: 'Shirt', pricePaisa: 60000, stock: 10 },
      { name: 'T-shirt', pricePaisa: 40000, stock: 10 },
      { name: 'Jeans', pricePaisa: 50000, stock: 10 },
    ]) {
      const created = await api('/api/products', { method: 'POST', body: p });
      check(`boot 1: product ${p.name} created`, created.status === 201, `status=${created.status}`);
      if (p.name === 'Jeans') jeansId = created.data?.id ?? created.data?.product?.id ?? '';
      if (p.name === 'T-shirt') tshirtId = created.data?.id ?? created.data?.product?.id ?? '';
    }
    check('boot 1: product ids captured', !!jeansId && !!tshirtId, `jeans=${jeansId.slice(0, 8)} tshirt=${tshirtId.slice(0, 8)}`);

    // A customer arrives via webchat (no phone/address stored yet).
    const ch = await api('/api/channels', { method: 'POST', body: { platform: 'webchat', externalId: 'site-orddet', displayName: 'Order Test Site' } });
    check('boot 1: webchat channel → 201', ch.status === 201, `status=${ch.status}`);
    const m1 = await api('/api/webhooks/webchat', {
      method: 'POST', auth: false,
      headers: { 'x-webchat-secret': WEBCHAT_SECRET },
      body: { externalId: 'site-orddet', senderId: 'wc-orddet-1', name: 'Order Test Customer', text: 'জিন্সের দাম কত?' },
    });
    check('boot 1: webchat message accepted', m1.status === 200 && !!m1.data?.conversationId, `status=${m1.status}`);
    const convId = m1.data?.conversationId ?? '';
    const custList = await api('/api/customers?q=Order%20Test%20Customer');
    const customers = Array.isArray(custList.data) ? custList.data : (custList.data?.customers ?? []);
    const customer = customers.find((c) => c.name === 'Order Test Customer') ?? customers[0];
    const customerId = customer?.id ?? '';
    check('boot 1: customer created with no phone/address', !!customerId && !customer?.phone && !customer?.address, `id=${String(customerId).slice(0, 8)} phone=${customer?.phone ?? 'null'}`);

    // (b) POST without contact → refused.
    const noContact = await api('/api/orders', {
      method: 'POST',
      body: { customerId, conversationId: convId, items: [{ productId: jeansId, quantity: 1 }] },
    });
    check('boot 1: POST order without contact → 400 refused', noContact.status === 400 && noContact.data?.missingPhone === true && noContact.data?.missingAddress === true, `status=${noContact.status} ${JSON.stringify(noContact.data ?? {})}`);

    // Phone only → still refused (address missing).
    const phoneOnly = await api('/api/orders', {
      method: 'POST',
      body: { customerId, conversationId: convId, items: [{ productId: jeansId, quantity: 1 }], customerPhone: '01700000001' },
    });
    check('boot 1: POST order with phone only → 400 (address missing)', phoneOnly.status === 400 && phoneOnly.data?.missingAddress === true && phoneOnly.data?.missingPhone === false, `status=${phoneOnly.status}`);

    // (a) POST with full contact → 201, snapshot + bill confirm the details.
    const full = await api('/api/orders', {
      method: 'POST',
      body: {
        customerId, conversationId: convId,
        items: [{ productId: jeansId, quantity: 2 }, { productId: tshirtId, quantity: 1 }],
        customerName: 'Order Test Customer', customerPhone: '01700000001', deliveryAddress: 'House 1, Road 2, Dhaka',
      },
    });
    check('boot 1: POST order with contact → 201', full.status === 201, `status=${full.status} ${JSON.stringify(full.data?.order ?? full.data ?? {}).slice(0, 200)}`);
    apiOrderId = full.data?.order?.id ?? '';
    check('boot 1: order snapshots name/phone/address', full.data?.order?.customer_name === 'Order Test Customer' && full.data?.order?.customer_phone === '01700000001' && full.data?.order?.delivery_address === 'House 1, Road 2, Dhaka', JSON.stringify(full.data?.order ?? {}).slice(0, 300));
    check('boot 1: order total is 2×500 + 1×400 = ৳1400', Number(full.data?.order?.total_paisa) === 140000, `total=${full.data?.order?.total_paisa ?? ''}`);
    check('boot 1: bill names the delivery address + phone', typeof full.data?.billText === 'string' && full.data.billText.includes('House 1, Road 2, Dhaka') && full.data.billText.includes('01700000001'), (full.data?.billText ?? '').slice(0, 300));

    // Customer row now carries the contact too.
    const custAfter = await api(`/api/customers/${customerId}`);
    const custRow = custAfter.data?.customer ?? custAfter.data ?? {};
    check('boot 1: customer row stores phone + address', custRow.phone === '01700000001' && custRow.address === 'House 1, Road 2, Dhaka', JSON.stringify(custRow).slice(0, 200));

    // (a) List shows every A-to-Z field.
    const list = await api('/api/orders');
    const listed = (Array.isArray(list.data) ? list.data : (list.data?.orders ?? [])).find((o) => o.id === apiOrderId);
    check('boot 1: list contains the order', !!listed, `orders=${(Array.isArray(list.data) ? list.data : (list.data?.orders ?? [])).length}`);
    check('boot 1: list row has customer name/phone/address/photo fields', !!listed?.customer && listed.customer.name === 'Order Test Customer' && listed.customer.phone === '01700000001' && listed.customer.address === 'House 1, Road 2, Dhaka' && 'picture_url' in listed.customer, JSON.stringify(listed?.customer ?? {}));
    check('boot 1: list row has snapshot fields + source + conversation', listed?.customer_phone === '01700000001' && listed?.delivery_address === 'House 1, Road 2, Dhaka' && listed?.source === 'team' && listed?.conversation_id === convId, `source=${listed?.source ?? ''} conv=${String(listed?.conversation_id ?? '').slice(0, 8)}`);

    // (a/d) Detail: items with names, quantities, unit prices; line totals sum to the total.
    const detail = await api(`/api/orders/${apiOrderId}`);
    const dOrder = detail.data?.order ?? {};
    const dItems = detail.data?.items ?? [];
    check('boot 1: detail has the order + 2 items', !!dOrder.id && dItems.length === 2, `items=${dItems.length}`);
    const jeansLine = dItems.find((i) => i.product_name === 'Jeans');
    const tshirtLine = dItems.find((i) => i.product_name === 'T-shirt');
    check('boot 1: detail lines carry product name/qty/unit price', jeansLine?.quantity === 2 && Number(jeansLine?.price_paisa) === 50000 && tshirtLine?.quantity === 1 && Number(tshirtLine?.price_paisa) === 40000, JSON.stringify(dItems));
    const lineSum = dItems.reduce((s, i) => s + Number(i.quantity ?? 0) * Number(i.price_paisa ?? 0), 0);
    check('boot 1: (d) line totals add up to the order total', lineSum === 140000 && Number(dOrder.total_paisa) === 140000, `lineSum=${lineSum} total=${dOrder.total_paisa ?? ''}`);
    check('boot 1: detail has customer + snapshot + source + conversation', !!dOrder.customer && dOrder.customer_phone === '01700000001' && dOrder.delivery_address === 'House 1, Road 2, Dhaka' && dOrder.source === 'team' && dOrder.conversation_id === convId, JSON.stringify({ c: dOrder.customer, s: dOrder.source }).slice(0, 200));
  } finally {
    run1.stop();
    await sleep(2000);
  }

  // ---------- Driver: the AI tool directly + legacy order seed ----------
  const driver = await runDriver(dataDir, workspaceId, jeansId, tshirtId);
  let driverResult = null;
  const driverLine = (driver.out ?? '').split('\n').find((l) => l.startsWith('DRIVER_RESULT '));
  try {
    driverResult = driverLine ? JSON.parse(driverLine.slice('DRIVER_RESULT '.length)) : null;
  } catch {
    driverResult = null;
  }
  check('driver: ran clean (exit 0 + result line)', driver.code === 0 && !!driverResult, `code=${driver.code} err=${(driver.err ?? '').slice(-300)}`);
  if (driverResult) {
    check('driver: (b) tool refuses without contact', driverResult.toolRefused === true && driverResult.toolRefusedMissingPhone === true && driverResult.toolRefusedMissingAddress === true, `error=${driverResult.toolRefusedError ?? ''}`);
    check('driver: refused tool created NO order', driverResult.toolRefusedCreatedNothing === true);
    check('driver: (a) tool creates with contact', !!driverResult.toolCreatedOrderId && Number(driverResult.toolCreatedTotal) === 50000, `orderId=${String(driverResult.toolCreatedOrderId ?? '').slice(0, 8)} total=${driverResult.toolCreatedTotal ?? ''}`);
    check('driver: tool order snapshot stored', driverResult.toolOrderSnapshot?.customer_phone === '01700000002' && driverResult.toolOrderSnapshot?.delivery_address === 'Tool Test Road 2, Dhaka', JSON.stringify(driverResult.toolOrderSnapshot ?? {}));
    check('driver: tool stored contact on the customer row', driverResult.toolCustomerStored?.phone === '01700000002' && driverResult.toolCustomerStored?.address === 'Tool Test Road 2, Dhaka', JSON.stringify(driverResult.toolCustomerStored ?? {}));
    check('driver: tool bill confirms address + phone', driverResult.toolBillHasAddress === true && driverResult.toolBillHasPhone === true);
    check('driver: legacy no-contact order seeded', !!driverResult.legacyOrderId, `legacy=${String(driverResult.legacyOrderId ?? '').slice(0, 8)}`);
  }

  // ---------- Boot 2: the legacy order over HTTP (same PGlite dir) ----------
  const run2 = startApi(port, dataDir);
  process.on('exit', run2.stop);
  try {
    const up2 = await waitForHealth(`http://localhost:${port}`);
    check('boot 2: API starts on the same dir', up2, up2 ? '' : run2.log().slice(-500));
    if (up2) {
      const api = makeApi(`http://localhost:${port}`);
      const list2 = await api('/api/orders');
      const orders2 = Array.isArray(list2.data) ? list2.data : (list2.data?.orders ?? []);
      const legacy = orders2.find((o) => o.id === driverResult?.legacyOrderId);
      check('boot 2: (c) legacy order lists', !!legacy, `orders=${orders2.length}`);
      check('boot 2: (c) legacy snapshot is NULL (honest not-provided case)', legacy?.customer_name === null && legacy?.customer_phone === null && legacy?.delivery_address === null, JSON.stringify({ n: legacy?.customer_name, p: legacy?.customer_phone, a: legacy?.delivery_address }));
      check('boot 2: (c) legacy customer phone/address are NULL too', legacy?.customer?.phone === null && legacy?.customer?.address === null, JSON.stringify(legacy?.customer ?? {}));
      const toolOrder = orders2.find((o) => o.id === driverResult?.toolCreatedOrderId);
      check('boot 2: tool-created order lists with its snapshot', !!toolOrder && toolOrder.customer_phone === '01700000002' && toolOrder.delivery_address === 'Tool Test Road 2, Dhaka', `found=${!!toolOrder}`);
      if (legacy) {
        const legDetail = await api(`/api/orders/${legacy.id}`);
        const legItems = legDetail.data?.items ?? [];
        const legSum = legItems.reduce((s, i) => s + Number(i.quantity ?? 0) * Number(i.price_paisa ?? 0), 0);
        check('boot 2: legacy detail line totals add up (50000)', legSum === 50000 && Number(legDetail.data?.order?.total_paisa) === 50000, `lineSum=${legSum}`);
      }
    }
  } finally {
    run2.stop();
    await sleep(2000);
    try { fs.rmSync(path.join(ROOT, 'apps/api', dataDir), { recursive: true, force: true }); } catch { /* already gone */ }
  }
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length > 0) {
      console.log('FAILED:');
      for (const f of failed) console.log(` - ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
      process.exit(1);
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error('Verifier crashed:', err);
    process.exit(1);
  });
