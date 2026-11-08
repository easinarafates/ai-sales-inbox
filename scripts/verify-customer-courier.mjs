#!/usr/bin/env node
/**
 * Verification for Customer details + Courier API keys (2026-11-08, part 1 of 2).
 *
 * 1. CUSTOMER DETAILS
 * - GET /api/customers/:id returns a `summary` (totalSpentPaisa, grossTotalPaisa,
 *   order/delivered/cancelled/returned counts, lastOrderAt) and a
 *   `productsOrdered` list (product name + quantity + amount), all computed
 *   from REAL order/order_items rows; every order carries its `items`.
 *   Total spent EXCLUDES cancelled/returned orders (that money was never spent).
 * - GET /api/customers lists total_spent_paisa + order_count per customer
 *   (one aggregate, no per-row query).
 * - Web: detail page shows the summary + products list + per-order items;
 *   list page shows a Total spent column.
 *
 * 2. COURIER API KEYS — Steadfast + Pathao only (migration 32)
 * - courier_credentials table (workspace_id, provider, encrypted JSON,
 *   verified_at); keys are encrypted with the channel-token helper and are
 *   NEVER returned in plain text (masked hasSet flags only).
 * - Owner-only GET/PUT /api/courier/credentials + POST .../:provider/verify.
 * - Verify is READ-ONLY: Steadfast GET /get_balance, Pathao issue-token +
 *   GET /aladdin/api/v1/stores — NEVER a test booking (Steadfast has no
 *   sandbox; Pathao's sandbox exists but verify never books either).
 * - DB keys take precedence over env; booking/tracking/status-check use the
 *   workspace's stored keys. Without keys, booking + verify fail honestly
 *   and no shipment row is written.
 * - Pathao provider is REAL (token password-grant, POST /aladdin/api/v1/orders,
 *   GET /orders/{cid}/info, GET /stores) per the merchant API doc.
 * - RedX / Sundarban are de-emphasised in the Courier page + order picker
 *   and stay honestly "not connected".
 *
 * Run from the repo root:  node scripts/verify-customer-courier.mjs
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 * No real booking endpoint is ever called.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const apiRequire = createRequire(path.join(ROOT, 'apps/api/package.json'));
const results = [];
let token = '';
const WEBCHAT_SECRET = 'test-webchat-secret-verify-custcour';
const JWT_SECRET = 'test-jwt-secret-verify-1234567890';
// Fake keys used ONLY in this local PGlite boot — they must never come back
// in any API response, and they must fail the live verify honestly.
const FAKE = {
  steadfastApiKey: 'FAKE-STEADFAST-API-KEY-zz1',
  steadfastSecret: 'FAKE-STEADFAST-SECRET-zz1',
  pathaoClientId: 'FAKE-PATHAO-CLIENT-zz1',
  pathaoClientSecret: 'FAKE-PATHAO-SECRET-zz1',
  pathaoUsername: 'fake-merchant@example.com',
  pathaoPassword: 'FAKE-PATHAO-PASS-zz1',
};
const ALL_FAKE_VALUES = Object.values(FAKE);

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeApi(base) {
  return async function api(path, { method = 'GET', body, auth = true, headers = {}, rawToken } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(auth && (rawToken || token) ? { Authorization: `Bearer ${rawToken || token}` } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data, text };
  };
}

async function waitForHealth(base, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  return false;
}

function startApi(port, dataDir) {
  const apiProc = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: path.join(ROOT, 'apps/api'),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: {
      ...process.env,
      PORT: String(port),
      USE_PGLITE: 'true',
      PGLITE_DATA_DIR: dataDir,
      JWT_SECRET,
      TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      WEBCHAT_SECRET,
      META_APP_ID: 'dummy-app-id',
      META_APP_SECRET: 'dummy-app-secret',
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

function noFakeSecretLeaked(text, where) {
  const leaked = ALL_FAKE_VALUES.filter((v) => text.includes(v));
  return { ok: leaked.length === 0, detail: leaked.length ? `${where} leaked: ${leaked.join(',')}` : '' };
}

async function main() {
  // ---------- Static checks ----------
  const mig = fs.readFileSync(path.join(ROOT, 'apps/api/src/db/migrations/32-courier-credentials.sql'), 'utf8');
  check('migration 32 creates courier_credentials', mig.includes('CREATE TABLE IF NOT EXISTS courier_credentials'));
  check('migration 32 limits providers to steadfast/pathao', mig.includes("CHECK (provider IN ('steadfast', 'pathao'))"));
  check('migration 32 stores encrypted credentials + verified_at', mig.includes('credentials_encrypted') && mig.includes('verified_at'));

  const custSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/customers/routes.ts'), 'utf8');
  check('customer detail returns summary + productsOrdered', custSrc.includes('summary: {') && custSrc.includes('productsOrdered'));
  check('customer detail attaches items per order (real order_items join)', custSrc.includes('FROM order_items oi LEFT JOIN products p') && custSrc.includes('itemsByOrder'));
  check('total spent excludes cancelled/returned orders', custSrc.includes("o.status !== 'cancelled' && o.status !== 'returned'"));
  check('customer list carries total_spent_paisa + order_count', custSrc.includes('total_spent_paisa') && custSrc.includes('order_count'));

  const credSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/courier/credentials.ts'), 'utf8');
  check('credentials encrypted with the channel-token helper', credSrc.includes('encryptToken') && credSrc.includes('decryptToken'));
  check('credentials API returns masked hasSet flags only', credSrc.includes('hasSet') && !/return.*credentials\[|res\.json\(\{[^}]*credentials:/.test(credSrc.replace(/credentials_encrypted/g, '')));
  check('owner-only gate checks members role owner / platform owner', credSrc.includes("role = 'owner'") || credSrc.includes("role === 'owner'"));
  check('DB credentials resolve before env fallback', credSrc.includes('DB first, env fallback') && credSrc.includes("source: 'db'"));
  check('credentials cover steadfast + pathao fields only', credSrc.includes("CREDENTIAL_PROVIDERS: CourierCredentialProvider[] = ['steadfast', 'pathao']"));

  const provSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/courier/provider.ts'), 'utf8');
  check('Pathao token uses password grant issue-token', provSrc.includes("/aladdin/api/v1/issue-token") && provSrc.includes("grant_type: 'password'"));
  check('Pathao booking posts real /aladdin/api/v1/orders', provSrc.includes("'/aladdin/api/v1/orders'") && provSrc.includes('consignment_id'));
  check('Pathao tracking uses /orders/{cid}/info', provSrc.includes('/info'));
  check('Pathao stores list uses /aladdin/api/v1/stores', provSrc.includes("'/aladdin/api/v1/stores'"));
  check('Pathao has no TODO stub left', !provSrc.includes('Pathao বুকিং এখনো বাস্তবায়ন হয়নি'));
  check('Steadfast accepts DB-stored creds (constructor override)', provSrc.includes('constructor(creds: SteadfastCreds'));
  check('Pathao accepts DB-stored creds (constructor override)', provSrc.includes('constructor(creds: PathaoCreds'));

  const routesSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/courier/routes.ts'), 'utf8');
  check('credentials GET/PUT/verify routes exist + owner-gated', routesSrc.includes("'/courier/credentials'") && routesSrc.includes('requireWorkspaceOwner'));
  check('verify is read-only (balance / stores, no create_order call)', routesSrc.includes('getBalance()') && routesSrc.includes('verifyConnection()') && !routesSrc.includes('createBooking'));
  check('booking uses workspace-resolved provider', fs.readFileSync(path.join(ROOT, 'apps/api/src/courier/book.ts'), 'utf8').includes('providerForWorkspace'));
  check('tracking check uses per-workspace Steadfast keys', fs.readFileSync(path.join(ROOT, 'apps/api/src/courier/tracking-check.ts'), 'utf8').includes("providerForWorkspace(workspaceId, 'steadfast')") || fs.readFileSync(path.join(ROOT, 'apps/api/src/courier/tracking-check.ts'), 'utf8').includes("providerForWorkspace(workspace_id, 'steadfast')"));

  const detailPage = fs.readFileSync(path.join(ROOT, 'apps/web/app/customers/[id]/page.tsx'), 'utf8');
  check('detail page shows total spent + counts + last order', detailPage.includes('totalSpentPaisa') && detailPage.includes('lastOrderAt') && detailPage.includes('cancelledCount'));
  check('detail page shows products-ordered list', detailPage.includes('productsOrdered') && detailPage.includes('amountPaisa'));
  check('detail page shows per-order items', detailPage.includes('orderItemsOf(o)'));
  const listPage = fs.readFileSync(path.join(ROOT, 'apps/web/app/customers/page.tsx'), 'utf8');
  check('list page shows Total spent column', listPage.includes('thTotalSpent') && listPage.includes('total_spent_paisa'));
  const courierPage = fs.readFileSync(path.join(ROOT, 'apps/web/app/courier/page.tsx'), 'utf8');
  check('courier page has API keys section (Steadfast + Pathao)', courierPage.includes('courierCredentialsApi') && courierPage.includes('saveCreds') && courierPage.includes('verifyCreds'));
  check('courier page verify is labelled read-only', courierPage.includes('Verify (read-only)'));
  check('courier page shows where to get each key', courierPage.includes('portal.packzy.com') && courierPage.includes('merchant.pathao.com'));
  check('courier page de-emphasises RedX/Sundarban', courierPage.includes('othersNotUsed') && courierPage.includes('not connected and not used'));
  const panel = fs.readFileSync(path.join(ROOT, 'apps/web/components/OrderDetailPanel.tsx'), 'utf8');
  check('order picker marks Sundarban/RedX as not used', panel.includes('courierNotUsed'));

  // ---------- Boot: API behaviour over HTTP (PGlite) ----------
  const stamp = Date.now();
  const port = 4021;
  const dataDir = '.pglite-data-custcour';
  const run = startApi(port, dataDir);
  process.on('exit', run.stop);
  try {
    const up = await waitForHealth(`http://localhost:${port}`);
    check('boot: API starts (migration 32 applied by PGlite)', up, up ? '' : run.log().slice(-500));
    if (!up) return;
    const api = makeApi(`http://localhost:${port}`);
    const signup = await api('/api/auth/signup', {
      method: 'POST', auth: false,
      body: { name: 'Courier Owner', email: `custcour+${stamp}@example.com`, password: 'verify1234', workspaceName: 'CustCour Test Shop' },
    });
    check('boot: signup (owner)', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
    token = signup.data?.token ?? '';
    const workspaceId = signup.data?.workspace?.id ?? '';
    const live = await api(`/api/workspaces/${workspaceId}/go-live`, { method: 'POST' });
    check('boot: go-live', live.status === 200, `status=${live.status}`);

    // Products + customer via webchat.
    let jeansId = '';
    let tshirtId = '';
    for (const p of [{ name: 'Jeans', pricePaisa: 50000, stock: 10 }, { name: 'T-shirt', pricePaisa: 40000, stock: 10 }]) {
      const created = await api('/api/products', { method: 'POST', body: p });
      if (p.name === 'Jeans') jeansId = created.data?.id ?? created.data?.product?.id ?? '';
      if (p.name === 'T-shirt') tshirtId = created.data?.id ?? created.data?.product?.id ?? '';
    }
    check('boot: products created', !!jeansId && !!tshirtId);
    const ch = await api('/api/channels', { method: 'POST', body: { platform: 'webchat', externalId: 'site-custcour', displayName: 'CustCour Site' } });
    check('boot: webchat channel → 201', ch.status === 201, `status=${ch.status}`);
    const m1 = await api('/api/webhooks/webchat', {
      method: 'POST', auth: false,
      headers: { 'x-webchat-secret': WEBCHAT_SECRET },
      body: { externalId: 'site-custcour', senderId: 'wc-custcour-1', name: 'CustCour Customer', text: 'জিন্সের দাম কত?' },
    });
    check('boot: webchat message accepted', m1.status === 200 && !!m1.data?.conversationId, `status=${m1.status}`);
    const convId = m1.data?.conversationId ?? '';
    // The customers LIST is buyers-only, so a fresh chatter is not in it
    // yet — the inbox conversation carries the customer id.
    const conv = await api(`/api/inbox/${convId}`);
    const customerId = conv.data?.customer?.id ?? conv.data?.conversation?.customer_id ?? '';
    check('boot: customer created', !!customerId, `id=${String(customerId).slice(0, 8)}`);

    // Two real orders: Jeans x2 (৳1000) → delivered; T-shirt x1 (৳400) → cancelled.
    const o1 = await api('/api/orders', {
      method: 'POST',
      body: { customerId, conversationId: convId, items: [{ productId: jeansId, quantity: 2 }], customerName: 'CustCour Customer', customerPhone: '01700000001', deliveryAddress: 'House 1, Road 2, Dhaka' },
    });
    const o2 = await api('/api/orders', {
      method: 'POST',
      body: { customerId, conversationId: convId, items: [{ productId: tshirtId, quantity: 1 }], customerName: 'CustCour Customer', customerPhone: '01700000001', deliveryAddress: 'House 1, Road 2, Dhaka' },
    });
    const order1Id = o1.data?.order?.id ?? '';
    const order2Id = o2.data?.order?.id ?? '';
    check('boot: two orders created (201)', o1.status === 201 && o2.status === 201, `s1=${o1.status} s2=${o2.status}`);
    check('boot: order totals are real (100000 + 40000)', Number(o1.data?.order?.total_paisa) === 100000 && Number(o2.data?.order?.total_paisa) === 40000, `t1=${o1.data?.order?.total_paisa} t2=${o2.data?.order?.total_paisa}`);
    const st1 = await api(`/api/orders/${order1Id}/status`, { method: 'PATCH', body: { status: 'delivered' } });
    const st2 = await api(`/api/orders/${order2Id}/status`, { method: 'PATCH', body: { status: 'cancelled' } });
    check('boot: statuses set (delivered + cancelled)', st1.status === 200 && st2.status === 200, `s1=${st1.status} s2=${st2.status}`);

    // --- Customer detail math ---
    const detail = await api(`/api/customers/${customerId}`);
    const s = detail.data?.summary ?? {};
    check('boot: detail summary counts (2 orders, 1 delivered, 1 cancelled)', s.orderCount === 2 && s.deliveredCount === 1 && s.cancelledCount === 1 && s.returnedCount === 0, JSON.stringify(s));
    check('boot: total spent = ৳1000 (cancelled ৳400 excluded)', Number(s.totalSpentPaisa) === 100000, `totalSpent=${s.totalSpentPaisa}`);
    check('boot: gross total = ৳1400 (all orders)', Number(s.grossTotalPaisa) === 140000, `gross=${s.grossTotalPaisa}`);
    check('boot: last order date present', typeof s.lastOrderAt === 'string' && !!s.lastOrderAt, `last=${s.lastOrderAt ?? ''}`);
    const prods = detail.data?.productsOrdered ?? [];
    const jeansAgg = prods.find((p) => p.productName === 'Jeans');
    const shirtAgg = prods.find((p) => p.productName === 'T-shirt');
    check('boot: products ordered — Jeans x2 = ৳1000', jeansAgg?.quantity === 2 && Number(jeansAgg?.amountPaisa) === 100000, JSON.stringify(jeansAgg ?? {}));
    check('boot: products ordered — T-shirt x1 = ৳400', shirtAgg?.quantity === 1 && Number(shirtAgg?.amountPaisa) === 40000, JSON.stringify(shirtAgg ?? {}));
    const dOrders = detail.data?.orders ?? [];
    const dO1 = dOrders.find((o) => o.id === order1Id);
    check('boot: order carries its items (Jeans x2 @ 50000)', Array.isArray(dO1?.items) && dO1.items.length === 1 && dO1.items[0].quantity === 2 && Number(dO1.items[0].price_paisa) === 50000, JSON.stringify(dO1?.items ?? []));
    check('boot: detail response has no invented amounts (line sums = totals)', (() => {
      const lineSum = dOrders.reduce((sum, o) => sum + (o.items ?? []).reduce((a, i) => a + Number(i.quantity ?? 0) * Number(i.price_paisa ?? 0), 0), 0);
      return lineSum === 140000 && Number(s.grossTotalPaisa) === 140000;
    })(), `lineSum check`);

    // --- Customer list totals ---
    const list = await api('/api/customers');
    const listed = (Array.isArray(list.data) ? list.data : (list.data?.customers ?? [])).find((c) => c.id === customerId);
    check('boot: list row total_spent_paisa = 100000, order_count = 2', Number(listed?.total_spent_paisa) === 100000 && Number(listed?.order_count) === 2, JSON.stringify({ t: listed?.total_spent_paisa, n: listed?.order_count }));

    // --- Courier credentials: auth + owner gate ---
    const noAuth = await api('/api/courier/credentials', { auth: false });
    check('boot: credentials GET without token → 401', noAuth.status === 401, `status=${noAuth.status}`);
    const jwt = apiRequire('jsonwebtoken');
    const forged = jwt.sign({ userId: '00000000-0000-4000-8000-000000000001', workspaceId }, JWT_SECRET, { expiresIn: '1h' });
    const nonOwner = await api('/api/courier/credentials', { method: 'PUT', rawToken: forged, body: { provider: 'steadfast', credentials: { apiKey: 'x', secretKey: 'y' } } });
    check('boot: credentials PUT by non-member → 403', nonOwner.status === 403, `status=${nonOwner.status}`);
    const creds0 = await api('/api/courier/credentials');
    const p0 = (creds0.data?.providers ?? []);
    check('boot: credentials GET (owner) → steadfast+pathao, none set', creds0.status === 200 && p0.length === 2 && p0.every((p) => p.source === 'none' && p.hasKeys === false), `status=${creds0.status} ${JSON.stringify(p0.map((p) => ({ p: p.provider, s: p.source })))}`);
    check('boot: masked GET leaks no secret', noFakeSecretLeaked(creds0.text, 'GET credentials').ok);

    // --- Save validation + masking ---
    const badSave = await api('/api/courier/credentials', { method: 'PUT', body: { provider: 'steadfast', credentials: { apiKey: FAKE.steadfastApiKey } } });
    check('boot: save steadfast missing secretKey → 400', badSave.status === 400, `status=${badSave.status}`);
    const badProvider = await api('/api/courier/credentials', { method: 'PUT', body: { provider: 'redx', credentials: { apiKey: 'x' } } });
    check('boot: save redx rejected (steadfast/pathao only) → 400', badProvider.status === 400, `status=${badProvider.status}`);
    const saveS = await api('/api/courier/credentials', { method: 'PUT', body: { provider: 'steadfast', credentials: { apiKey: FAKE.steadfastApiKey, secretKey: FAKE.steadfastSecret } } });
    check('boot: save steadfast keys → 200, masked', saveS.status === 200 && saveS.data?.status?.hasKeys === true && saveS.data?.status?.source === 'db' && saveS.data?.status?.verified === false, `status=${saveS.status} ${JSON.stringify(saveS.data?.status ?? {})}`);
    check('boot: save response leaks no secret', noFakeSecretLeaked(saveS.text, 'PUT steadfast').ok);
    const saveP = await api('/api/courier/credentials', { method: 'PUT', body: { provider: 'pathao', credentials: { clientId: FAKE.pathaoClientId, clientSecret: FAKE.pathaoClientSecret, username: FAKE.pathaoUsername, password: FAKE.pathaoPassword } } });
    check('boot: save pathao keys → 200, masked', saveP.status === 200 && saveP.data?.status?.hasKeys === true, `status=${saveP.status}`);
    check('boot: save pathao response leaks no secret', noFakeSecretLeaked(saveP.text, 'PUT pathao').ok);
    const creds1 = await api('/api/courier/credentials');
    const leak1 = noFakeSecretLeaked(creds1.text, 'GET credentials after save');
    check('boot: GET after save still leaks no secret', leak1.ok, leak1.detail);
    check('boot: GET after save shows db source + hasSet flags', (() => {
      const ps = creds1.data?.providers ?? [];
      const sf = ps.find((p) => p.provider === 'steadfast');
      return sf?.source === 'db' && sf?.fields?.every((f) => f.hasSet === true) && sf?.verified === false;
    })(), JSON.stringify(creds1.data?.providers ?? []));

    // Partial update keeps stored secrets (store_id can be added alone).
    const partial = await api('/api/courier/credentials', { method: 'PUT', body: { provider: 'pathao', credentials: { storeId: '12345' } } });
    check('boot: partial save (storeId only) keeps stored secrets → 200', partial.status === 200 && partial.data?.status?.hasKeys === true, `status=${partial.status}`);
    const creds2 = await api('/api/courier/credentials');
    const pathaoAfter = (creds2.data?.providers ?? []).find((p) => p.provider === 'pathao');
    check('boot: storeId saved alongside kept secrets', pathaoAfter?.fields?.find((f) => f.key === 'storeId')?.hasSet === true && pathaoAfter?.fields?.find((f) => f.key === 'clientId')?.hasSet === true);

    // --- Provider endpoint is DB-aware ---
    const prov = await api('/api/courier/provider');
    check('boot: provider endpoint reports steadfast+pathao configured (DB keys)', prov.data?.providers?.find((p) => p.name === 'steadfast')?.configured === true && prov.data?.providers?.find((p) => p.name === 'pathao')?.configured === true, JSON.stringify(prov.data?.providers ?? []));
    check('boot: provider endpoint still honest for sundarban (not configured)', prov.data?.providers?.find((p) => p.name === 'sundarban')?.configured === false);

    // --- Verify: read-only, fails honestly on fake keys, never books ---
    const verifyS = await api('/api/courier/credentials/steadfast/verify', { method: 'POST', body: {} });
    check('boot: verify steadfast with fake keys → connected:false (no booking)', verifyS.status === 200 && verifyS.data?.connected === false && typeof verifyS.data?.reason === 'string', `status=${verifyS.status} ${JSON.stringify(verifyS.data ?? {})}`);
    check('boot: verify steadfast response leaks no secret', noFakeSecretLeaked(verifyS.text, 'verify steadfast').ok);
    const verifyP = await api('/api/courier/credentials/pathao/verify', { method: 'POST', body: {} });
    check('boot: verify pathao with fake keys → connected:false (no booking)', verifyP.status === 200 && verifyP.data?.connected === false && typeof verifyP.data?.reason === 'string', `status=${verifyP.status} ${JSON.stringify(verifyP.data ?? {})}`);
    const verifyBad = await api('/api/courier/credentials/redx/verify', { method: 'POST', body: {} });
    check('boot: verify redx → 400', verifyBad.status === 400, `status=${verifyBad.status}`);

    // --- Booking honesty: fake keys → no shipment row, no tracking number ---
    const bookP = await api(`/api/orders/${order1Id}/send-to-courier`, { method: 'POST', body: { courier: 'pathao' } });
    check('boot: Pathao booking with fake keys fails honestly (502, no fake tracking)', bookP.status === 502 && !bookP.data?.shipment, `status=${bookP.status} ${JSON.stringify(bookP.data ?? {}).slice(0, 200)}`);
    const bookS = await api(`/api/orders/${order1Id}/send-to-courier`, { method: 'POST', body: { courier: 'steadfast' } });
    check('boot: Steadfast booking with fake keys fails honestly (502, no fake tracking)', bookS.status === 502 && !bookS.data?.shipment, `status=${bookS.status} ${JSON.stringify(bookS.data ?? {}).slice(0, 200)}`);
    const ships = await api('/api/courier/shipments');
    const shipList = Array.isArray(ships.data) ? ships.data : (ships.data?.shipments ?? []);
    check('boot: no shipment row was written by the failed bookings', shipList.length === 0, `shipments=${shipList.length}`);
    const track = await api('/api/courier/track/FAKE123');
    check('boot: track unknown number → 404 honest', track.status === 404, `status=${track.status}`);
  } finally {
    run.stop();
    await sleep(2000);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length > 0) {
    console.log('FAILED:');
    for (const f of failed) console.log(` - ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('verifier crashed:', err);
  process.exit(1);
});
