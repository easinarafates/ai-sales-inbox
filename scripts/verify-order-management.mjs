#!/usr/bin/env node
/**
 * Verification for Order Management (2026-11-08, user brief
 * docs/order-management-brief.md).
 *
 *  1. Auto order number: every order gets ASI-0001, ASI-0002, ... (per
 *     workspace, sequential) — API-created and AI-created alike.
 *  2. Status tabs with counts: GET /api/orders/counts.
 *  3. Report: GET /api/orders/report (today: orders/delivered/cancelled/
 *     returned/damaged + courier view).
 *  4. Order detail panel: manual status (ANY valid status, not just the
 *     next step), payment method, delivery charge snapshot, zone,
 *     handled-by, invoice link.
 *  5. Send to Courier: owner picks steadfast/pathao/sundarban/redx.
 *     Without keys a provider fails HONESTLY (502, no shipment row, no
 *     fake tracking number). Sundarban is "not connected yet".
 *  6. Customer list inside Orders: amounts HIDDEN until the owner clicks
 *     a customer (GET /api/orders/customers has no amount; the detail
 *     endpoint reveals it).
 *  7. Scan: GET /api/orders/lookup by order number / tracking / token.
 *  8. Receipt: POST /api/orders/:id/receipt sends the confirmation +
 *     invoice link; GET /api/public/invoice/:token (no login) is the
 *     invoice. NOTE: no receipt IMAGE is generated — the Vercel image
 *     renderer (@vercel/og / Satori) cannot shape Bengali conjuncts
 *     (tested 2026-11-08: they render as dotted circles), so shipping a
 *     broken image would be worse; the invoice LINK is the working
 *     receipt. The verifier checks the link + the honest no-image state.
 *
 * Checks:
 * - Static: migration 29, helpers, routes, courier book + sundarban,
 *   public invoice, web panel / invoice page / statuses.
 * - Boot 1 (local API on PGlite): full order flow + all endpoints.
 * - Driver 1 (runTool create_order directly): AI order gets a number +
 *   invoice link in the confirmation text.
 *
 * Run from the repo root:  node scripts/verify-order-management.mjs
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
const WEBCHAT_SECRET = 'order-mgmt-local-test-secret';

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeApi(base) {
  return async function api(path, { method = 'GET', body, auth = true, headers = {} } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      signal: AbortSignal.timeout(30_000),
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
JWT_SECRET: 'order-mgmt-test-jwt-secret',
      TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      WEBCHAT_SECRET,
      // Blank the provider keys so the boot runs in deterministic demo
      // mode (no live AI calls, no real courier).
GEMINI_API_KEY: '',
GROQ_API_KEY: '',
OPENAI_API_KEY: '',
ANTHROPIC_API_KEY: '',
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

function runDriver(script, dataDir, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const proc = spawn('npx', ['tsx', `../../scripts/${script}`, ...args], {
      cwd: path.join(ROOT, 'apps/api'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        USE_PGLITE: 'true',
        PGLITE_DATA_DIR: dataDir,
JWT_SECRET: 'order-mgmt-test-jwt-secret',
        TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        WEBCHAT_SECRET,
GEMINI_API_KEY: '',
GROQ_API_KEY: '',
OPENAI_API_KEY: '',
ANTHROPIC_API_KEY: '',
        ...extraEnv,
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
  const mig29 = fs.readFileSync(path.join(ROOT, 'apps/api/src/db/migrations/29-order-management.sql'), 'utf8');
  check('migration 29: order_number + invoice_token + receipt_image_url', mig29.includes('order_number TEXT') && mig29.includes('invoice_token TEXT') && mig29.includes('receipt_image_url TEXT'));
  check('migration 29: payment_method cod/advance/fifty_fifty', mig29.includes("payment_method TEXT") && mig29.includes("'cod', 'advance', 'fifty_fifty'"));
  check('migration 29: delivery_charge_paisa + handled_by', mig29.includes('delivery_charge_paisa BIGINT') && mig29.includes("handled_by TEXT"));
  check('migration 29: workspace_order_counters + backfill', mig29.includes('workspace_order_counters') && mig29.includes("ASI-'"));

  const helpers = fs.readFileSync(path.join(ROOT, 'apps/api/src/orders/order-helpers.ts'), 'utf8');
  check('order-helpers: nextOrderNumber (atomic counter) + newInvoiceToken', helpers.includes('export async function nextOrderNumber') && helpers.includes('export function newInvoiceToken'));
  check('order-helpers: zoneOfAddress + deliveryEstimateText', helpers.includes('export function zoneOfAddress') && helpers.includes('export function deliveryEstimateText'));

  const billSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/orders/bill.ts'), 'utf8');
  check('bill: confirmation carries order number + invoice link', billSrc.includes('অর্ডার নম্বর:') && billSrc.includes('ইনভয়েস দেখুন:'));

  const routesSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/orders/routes.ts'), 'utf8');
  check('orders routes: POST creates number + token + charge snapshot', routesSrc.includes('nextOrderNumber(txDb') && routesSrc.includes('newInvoiceToken()') && routesSrc.includes('deliveryChargePaisa'));
  check('orders routes: counts + report + customers + lookup endpoints', routesSrc.includes("'/counts'") && routesSrc.includes("'/report'") && routesSrc.includes("'/customers'") && routesSrc.includes("'/lookup'"));
  check('orders routes: manual status — ANY valid status (ORDER_STATUSES)', routesSrc.includes('ORDER_STATUSES') && routesSrc.includes('status must be one of'));
  check('orders routes: payment-method + send-to-courier + receipt endpoints', routesSrc.includes('payment-method') && routesSrc.includes('send-to-courier') && routesSrc.includes('/receipt'));
  check('orders routes: customer list has NO amount (hidden until click)', routesSrc.includes('The AMOUNT is deliberately NOT here'));
  check('orders routes: receipt documents the no-image reason honestly', routesSrc.includes('cannot shape Bengali conjuncts'));

  const toolsSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/ai-agent/tools.ts'), 'utf8');
  check('AI create_order: number + token + charge snapshot + invoice link', toolsSrc.includes('nextOrderNumber(db') && toolsSrc.includes('newInvoiceToken()') && toolsSrc.includes('invoiceUrl') && toolsSrc.includes('orderNumber'));

  const bookSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/courier/book.ts'), 'utf8');
  check('courier book: shared booking (one shipment per order, in_transit)', bookSrc.includes('export async function bookCourierForOrder') && bookSrc.includes("status = 'in_transit'"));
  const providerSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/courier/provider.ts'), 'utf8');
  check('courier provider: Sundarban honest not-configured', providerSrc.includes('SundarbanCourierProvider') && providerSrc.includes('sundarban') && providerSrc.includes('এখনো যুক্ত হয়নি'));
  check('courier provider: providerForName handles sundarban', providerSrc.includes("case 'sundarban':"));

  const pubSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/orders/public-invoice.ts'), 'utf8');
  check('public invoice: token auth, public fields only', pubSrc.includes("'/invoice/:token'") && pubSrc.includes('invoice_token = $1'));
  const indexSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/index.ts'), 'utf8');
  check('API mounts /api/public (public invoice)', indexSrc.includes("app.use('/api/public', publicInvoiceRouter)"));

  const statusSrc = fs.readFileSync(path.join(ROOT, 'apps/web/lib/orderStatus.tsx'), 'utf8');
  check('web orderStatus: all 12 statuses + ready/cancelled/returned/damaged/in_store', statusSrc.includes('"ready"') && statusSrc.includes('"cancelled"') && statusSrc.includes('"returned"') && statusSrc.includes('"damaged"') && statusSrc.includes('"in_store"') && statusSrc.includes('paymentMethodLabel'));
  const panelSrc = fs.readFileSync(path.join(ROOT, 'apps/web/components/OrderDetailPanel.tsx'), 'utf8');
  check('web panel: status buttons + courier picker + WhatsApp/Chat/Call + receipt', panelSrc.includes('wa.me/') && panelSrc.includes('/inbox?conversation=') && panelSrc.includes('tel:+') && panelSrc.includes('sendToCourier') && panelSrc.includes('sendReceipt'));
  const listSrc = fs.readFileSync(path.join(ROOT, 'apps/web/app/orders/page.tsx'), 'utf8');
  check('web orders page: status tabs + scan + customers/report views + slide-over', listSrc.includes('counts') && listSrc.includes('scanPlaceholder') && listSrc.includes('view === "customers"') && listSrc.includes('view === "report"') && listSrc.includes('OrderDetailPanel'));
  const invPage = fs.readFileSync(path.join(ROOT, 'apps/web/app/invoice/[token]/page.tsx'), 'utf8');
  check('web invoice page: public, Bengali receipt, print', invPage.includes('publicInvoiceApi') && invPage.includes('ইনভয়েস') && invPage.includes('window.print()'));
  const shellSrc = fs.readFileSync(path.join(ROOT, 'apps/web/components/AppShell.tsx'), 'utf8');
  check('AppShell: /invoice is a public page (no login redirect)', shellSrc.includes('pathname.startsWith("/invoice")'));

  // ---------- Boot 1: full order flow (PGlite, demo mode) ----------
  const stamp = Date.now();
  const port = 4024;
  const dataDir = '.pglite-data-ordermgmt';
  const run1 = startApi(port, dataDir);
  process.on('exit', run1.stop);
  let workspaceId = '';
  let jeansId = '';
  let customerId = '';
  let convId = '';
  let orderId = '';
  let orderNumber = '';
  let invoiceToken = '';
  try {
    const up = await waitForHealth(`http://localhost:${port}`);
    check('boot 1: API starts', up, up ? '' : run1.log().slice(-500));
    if (!up) return;
    const api = makeApi(`http://localhost:${port}`);
    const signup = await api('/api/auth/signup', {
      method: 'POST', auth: false,
      body: { name: 'Order Owner', email: `ordmgmt+${stamp}@example.com`, password: 'verify1234', workspaceName: 'Order Mgmt Test Shop' },
    });
    check('boot 1: signup', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
token = signup.data?.token ?? '';
    workspaceId = signup.data?.workspace?.id ?? '';
    const live = await api(`/api/workspaces/${workspaceId}/go-live`, { method: 'POST' });
    check('boot 1: go-live', live.status === 200 && live.data?.workspace?.practice_mode === false, `status=${live.status}`);
    const jeans = await api('/api/products', { method: 'POST', body: { name: 'Jeans', pricePaisa: 50000, stock: 10 } });
    jeansId = jeans.data?.id ?? jeans.data?.product?.id ?? '';
    check('boot 1: Jeans created (৳500)', jeans.status === 201 && !!jeansId, `status=${jeans.status}`);

    const ch = await api('/api/channels', { method: 'POST', body: { platform: 'webchat', externalId: 'site-ordmgmt', displayName: 'Order Mgmt Test Site' } });
    check('boot 1: webchat channel → 201', ch.status === 201, `status=${ch.status}`);
    const m1 = await api('/api/webhooks/webchat', {
      method: 'POST', auth: false,
      headers: { 'x-webchat-secret': WEBCHAT_SECRET },
      body: { externalId: 'site-ordmgmt', senderId: 'wc-ordmgmt-1', name: 'Order Test Customer', text: 'জিন্সের দাম কত?' },
    });
    check('boot 1: webchat message accepted', m1.status === 200 && !!m1.data?.conversationId, `status=${m1.status}`);
    convId = m1.data?.conversationId ?? '';
    const inbox = await api('/api/inbox');
    const convs = Array.isArray(inbox.data)
      ? inbox.data
      : (inbox.data?.conversations ?? inbox.data?.items ?? []);
    const conv = convs.find((c) => c.id === convId);
    customerId = conv?.customer_id ?? '';
    check('boot 1: customer created (visible in Inbox)', !!customerId && conv?.customer_name === 'Order Test Customer', `id=${String(customerId).slice(0, 8)}`);

    // 1) Auto order number (API path): Dhaka address → ৳100 charge.
    const full = await api('/api/orders', {
      method: 'POST',
      body: {
        customerId, conversationId: convId,
        items: [{ productId: jeansId, quantity: 2 }],
        customerName: 'Order Test Customer', customerPhone: '01700000001', deliveryAddress: 'House 1, Road 2, Dhanmondi, Dhaka',
      },
    });
    check('boot 1: POST order → 201', full.status === 201, `status=${full.status}`);
    orderId = full.data?.order?.id ?? '';
    orderNumber = full.data?.order?.order_number ?? full.data?.orderNumber ?? '';
    invoiceToken = full.data?.order?.invoice_token ?? '';
    check('boot 1: auto order number ASI-0001', orderNumber === 'ASI-0001', `orderNumber=${orderNumber}`);
    check('boot 1: invoice token + invoice URL returned', typeof invoiceToken === 'string' && invoiceToken.length >= 16 && typeof full.data?.invoiceUrl === 'string' && full.data.invoiceUrl.includes(`/invoice/${invoiceToken}`), `invoiceUrl=${full.data?.invoiceUrl ?? ''}`);
    check('boot 1: payment method defaults to cod, handled_by agent', full.data?.order?.payment_method === 'cod' && full.data?.order?.handled_by === 'agent', `method=${full.data?.order?.payment_method} handled=${full.data?.order?.handled_by}`);
    check('boot 1: delivery charge snapshotted (Dhaka ৳100)', Number(full.data?.order?.delivery_charge_paisa) === 10000, `charge=${full.data?.order?.delivery_charge_paisa}`);
    check('boot 1: total is 2×500 = ৳1000', Number(full.data?.order?.total_paisa) === 100000, `total=${full.data?.order?.total_paisa}`);

    // 2) Detail: zone + handled-by + estimate + invoice URL.
    const detail = await api(`/api/orders/${orderId}`);
    const dOrder = detail.data?.order ?? {};
    check('boot 1: detail has zone (Dhaka) + handledBy ai/agent + estimate', dOrder.zone?.insideDhaka === true && dOrder.zone?.label === 'ঢাকা' && dOrder.handledBy === 'agent' && typeof dOrder.deliveryEstimate === 'string' && dOrder.deliveryEstimate.length > 0, JSON.stringify(dOrder.zone ?? {}));
    check('boot 1: detail grand total = 1000 + 100 = ৳1100', Number(dOrder.grandTotalPaisa) === 110000, `grand=${dOrder.grandTotalPaisa}`);
    check('boot 1: detail invoice URL', typeof dOrder.invoiceUrl === 'string' && dOrder.invoiceUrl.includes(`/invoice/${invoiceToken}`), `${dOrder.invoiceUrl ?? ''}`);

    // 3) Counts + tabs.
    const counts = await api('/api/orders/counts');
    check('boot 1: counts — pending=1, total=1', counts.data?.counts?.pending === 1 && counts.data?.total === 1, JSON.stringify(counts.data ?? {}));

    // 4) Manual status — ANY valid status (not just the next step).
    const toApproved = await api(`/api/orders/${orderId}/status`, { method: 'PATCH', body: { status: 'approved' } });
    check('boot 1: status → approved', toApproved.data?.order?.status === 'approved', `status=${toApproved.data?.order?.status}`);
    const toCancelled = await api(`/api/orders/${orderId}/status`, { method: 'PATCH', body: { status: 'cancelled' } });
    check('boot 1: manual status approved → cancelled (any status allowed)', toCancelled.data?.order?.status === 'cancelled', `status=${toCancelled.data?.order?.status}`);
    const backToPending = await api(`/api/orders/${orderId}/status`, { method: 'PATCH', body: { status: 'pending' } });
    check('boot 1: manual status cancelled → pending (backwards allowed)', backToPending.data?.order?.status === 'pending', `status=${backToPending.data?.order?.status}`);
    const badStatus = await api(`/api/orders/${orderId}/status`, { method: 'PATCH', body: { status: 'shipped_to_moon' } });
    check('boot 1: invalid status → 400', badStatus.status === 400, `status=${badStatus.status}`);
    const counts2 = await api('/api/orders/counts');
    check('boot 1: counts after moves — pending=1 again', counts2.data?.counts?.pending === 1, JSON.stringify(counts2.data?.counts ?? {}));

    // 5) Payment method.
    const payMethod = await api(`/api/orders/${orderId}/payment-method`, { method: 'PATCH', body: { paymentMethod: 'advance' } });
    check('boot 1: payment method → advance', payMethod.data?.order?.payment_method === 'advance', `method=${payMethod.data?.order?.payment_method}`);
    const badMethod = await api(`/api/orders/${orderId}/payment-method`, { method: 'PATCH', body: { paymentMethod: 'bitcoin' } });
    check('boot 1: invalid payment method → 400', badMethod.status === 400, `status=${badMethod.status}`);

    // 6) Report (today).
    const report = await api('/api/orders/report');
    check('boot 1: report — today orders=1, value=৳1000', report.data?.today?.orders === 1 && Number(report.data?.today?.valuePaisa) === 100000, JSON.stringify(report.data?.today ?? {}));
    check('boot 1: report — courier inTransitOrders=0', report.data?.courier?.inTransitOrders === 0, JSON.stringify(report.data?.courier ?? {}));

    // 7) Customers — amount hidden in the list, revealed in the detail.
    const custs = await api('/api/orders/customers');
    const custRow = (custs.data?.customers ?? []).find((c) => c.id === customerId);
    check('boot 1: customer list — 1 order, last order today', !!custRow && custRow.orders === 1 && !!custRow.last_order_at, JSON.stringify(custRow ?? {}));
    check('boot 1: customer list has NO amount field (hidden until click)', !!custRow && !('totalPaisa' in custRow) && !('total_paisa' in custRow) && !('amount' in custRow), JSON.stringify(Object.keys(custRow ?? {})));
    const custDetail = await api(`/api/orders/customers/${customerId}`);
    check('boot 1: customer detail reveals total (৳1000) + orders', Number(custDetail.data?.stats?.totalPaisa) === 100000 && (custDetail.data?.orders ?? []).length === 1, JSON.stringify(custDetail.data?.stats ?? {}));

    // 8) Scan / lookup.
    const lookup = await api(`/api/orders/lookup?q=${encodeURIComponent(orderNumber)}`);
    check('boot 1: lookup by order number finds the order', lookup.data?.order?.id === orderId, `id=${lookup.data?.order?.id ?? ''}`);
    const lookupBad = await api('/api/orders/lookup?q=ASI-9999');
    check('boot 1: lookup unknown → 404 honest', lookupBad.status === 404, `status=${lookupBad.status}`);

    // 9) Send to Courier — Steadfast without keys: honest 502, no shipment, no tracking.
    const steadfast = await api(`/api/orders/${orderId}/send-to-courier`, { method: 'POST', body: { courier: 'steadfast' } });
    check('boot 1: send-to-courier steadfast (no keys) → 502 honest', steadfast.status === 502 && /যুক্ত হয়নি|not configured/i.test(steadfast.data?.error ?? ''), `status=${steadfast.status} ${JSON.stringify(steadfast.data ?? {}).slice(0, 200)}`);
    const shipAfterFail = await api('/api/courier/shipments');
    check('boot 1: no shipment row written after the failed booking', ((shipAfterFail.data?.shipments ?? []).length) === 0, `shipments=${(shipAfterFail.data?.shipments ?? []).length}`);
    const sundarban = await api(`/api/orders/${orderId}/send-to-courier`, { method: 'POST', body: { courier: 'sundarban' } });
    check('boot 1: send-to-courier sundarban → 502 "not connected yet"', sundarban.status === 502 && /সুন্দরবন/.test(sundarban.data?.error ?? ''), `status=${sundarban.status} ${JSON.stringify(sundarban.data ?? {}).slice(0, 200)}`);
    const provider = await api('/api/courier/provider');
    check('boot 1: provider list shows sundarban as not configured', (provider.data?.providers ?? []).some((p) => p.name === 'sundarban' && p.configured === false), JSON.stringify(provider.data?.providers ?? []));

    // 10) Receipt + public invoice (no login).
    const receipt = await api(`/api/orders/${orderId}/receipt`, { method: 'POST', body: {} });
    check('boot 1: receipt sent (webchat = local delivery) + invoice URL', receipt.data?.sent === true && typeof receipt.data?.invoiceUrl === 'string' && receipt.data.invoiceUrl.includes(`/invoice/${invoiceToken}`), JSON.stringify(receipt.data ?? {}));
    const pub = await api(`/api/public/invoice/${invoiceToken}`, { auth: false });
    check('boot 1: public invoice (no auth) — number, items, totals', pub.status === 200 && pub.data?.orderNumber === 'ASI-0001' && (pub.data?.items ?? []).length === 1 && Number(pub.data?.grandTotalPaisa) === 110000, `status=${pub.status} ${JSON.stringify(pub.data ?? {}).slice(0, 300)}`);
    check('boot 1: public invoice — payment method + estimate', pub.data?.paymentMethod === 'advance' && typeof pub.data?.deliveryEstimate === 'string' && pub.data.deliveryEstimate.length > 0, JSON.stringify({ m: pub.data?.paymentMethod, e: pub.data?.deliveryEstimate }));
    const pubBad = await api('/api/public/invoice/00000000000000000000000000000000', { auth: false });
    check('boot 1: public invoice bad token → 404', pubBad.status === 404, `status=${pubBad.status}`);

    // 11) Second order (outside Dhaka) — sequential number + ৳130 charge.
    const full2 = await api('/api/orders', {
      method: 'POST',
      body: {
        customerId, conversationId: convId,
        items: [{ productId: jeansId, quantity: 1 }],
        customerName: 'Order Test Customer', customerPhone: '01700000001', deliveryAddress: 'Village, Magura Sadar, Magura',
      },
    });
    check('boot 1: second order → ASI-0002 (sequential)', full2.data?.order?.order_number === 'ASI-0002', `orderNumber=${full2.data?.order?.order_number}`);
    check('boot 1: second order charge is outside-Dhaka ৳130', Number(full2.data?.order?.delivery_charge_paisa) === 13000, `charge=${full2.data?.order?.delivery_charge_paisa}`);
    const detail2 = full2.data?.order?.id
      ? await api(`/api/orders/${full2.data.order.id}`)
      : { status: 0, data: {} };
    check('boot 1: second order zone is Magura (outside Dhaka)', detail2.data?.order?.zone?.insideDhaka === false && detail2.data?.order?.zone?.label === 'মাগুরা', JSON.stringify(detail2.data?.order?.zone ?? {}));
  } finally {
    run1.stop();
    await sleep(2000);
  }

  // ---------- Driver 1: AI create_order tool (same PGlite data dir) ----------
  // The boot server is stopped, so the driver opens the same PGlite dir.
  const drv = await runDriver('order-management-driver.ts', dataDir, [workspaceId, customerId, convId, jeansId]);
  let drvJson = null;
  try { drvJson = JSON.parse((drv.out.match(/\{[\s\S]*\}/) ?? [''])[0] || 'null'); } catch { /* not JSON */ }
  check('driver 1: AI create_order runs', drv.code === 0 && !!drvJson && !drvJson.error, `code=${drv.code} ${drv.err.slice(-300)}`);
  check('driver 1: AI order gets ASI-0003 (sequential after the API orders)', drvJson?.orderNumber === 'ASI-0003', `orderNumber=${drvJson?.orderNumber ?? ''}`);
  check('driver 1: AI order has an invoice URL', typeof drvJson?.invoiceUrl === 'string' && drvJson.invoiceUrl.includes('/invoice/'), `${drvJson?.invoiceUrl ?? ''}`);
  check('driver 1: confirmation text has the order number + invoice link', typeof drvJson?.confirmationText === 'string' && drvJson.confirmationText.includes('ASI-0003') && drvJson.confirmationText.includes('/invoice/'), (drvJson?.confirmationText ?? '').slice(0, 200));
  check('driver 1: AI order delivery charge is Dhaka ৳100', Number(drvJson?.deliveryChargePaisa) === 10000, `charge=${drvJson?.deliveryChargePaisa ?? ''}`);

  // ---------- Summary ----------
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length > 0) {
    console.log('Failures:');
    for (const f of failed) console.log(` - ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('VERIFIER CRASHED:', err);
  process.exit(2);
});
