// Verifier for the real Steadfast courier provider.
// Static checks + local API boot on PGlite (no keys — provider stays stub)
// + steadfast-driver.ts (stubbed fetch; NO live Steadfast calls, ever).
// Run: node scripts/verify-steadfast.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stamp = Date.now().toString(36);
const WEBCHAT_SECRET = 'verify-webchat-secret';
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail ?? '') });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(base, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
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
      JWT_SECRET: 'verify-jwt-secret-for-local-tests-only-0123456789abcdef',
      TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      WEBCHAT_SECRET,
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

function runDriver(dataDir, workspaceId) {
  return new Promise((resolve) => {
    const proc = spawn('npx', ['tsx', '../../scripts/steadfast-driver.ts', workspaceId], {
      cwd: path.join(ROOT, 'apps/api'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        USE_PGLITE: 'true',
        PGLITE_DATA_DIR: dataDir,
        JWT_SECRET: 'verify-jwt-secret-for-local-tests-only-0123456789abcdef',
        TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        WEBCHAT_SECRET,
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
  const provider = read('apps/api/src/courier/provider.ts');
  check('static: Steadfast class has a real createBooking (no TODO throw)', provider.includes('class SteadfastCourierProvider') && provider.includes('async createBooking') && provider.includes('fetchWithTimeout') && !provider.includes('Steadfast is not yet implemented'), '');
  check('static: create_order uses /create_order + invoice + cod_amount', provider.includes("'/create_order'") && provider.includes('cod_amount') && provider.includes("invoice: `ASI-${order.id}`"), '');
  check('static: auth headers Api-Key + Secret-Key + Content-Type', provider.includes("'Api-Key'") && provider.includes("'Secret-Key'") && provider.includes("'Content-Type': 'application/json'"), '');
  check('static: status endpoints (by cid / by invoice / by trackingcode)', provider.includes('/status_by_cid/') && provider.includes('/status_by_invoice/') && provider.includes('/status_by_trackingcode/'), '');
  check('static: getBalance hits /get_balance and returns current_balance', provider.includes('/get_balance') && provider.includes('current_balance'), '');
  check('static: base URL default is the real Steadfast API', read('apps/api/src/config/index.ts').includes("optional('STEADFAST_BASE_URL', 'https://portal.packzy.com/api/v1')"), '');
  check('static: COD zone helper — Dhaka 100, otherwise 130, default 130', provider.includes('deliveryChargeForAddress') && provider.includes("a.includes('ঢাকা')") && provider.includes('return 100') && provider.includes('return 130'), '');
  check('static: phone normalization to 11-digit 01 form', provider.includes('normalizeBdPhone') && provider.includes("d.startsWith('880')") && provider.includes('/^01\\d{9}$/'), '');
  check('static: no TODO stub left in the Steadfast class', !/Steadfast is not yet implemented/.test(provider), '');
  check('static: Pathao/RedX still honest TODO stubs (not removed)', provider.includes('Pathao বুকিং এখনো বাস্তবায়ন হয়নি (TODO)') && provider.includes('RedX বুকিং এখনো বাস্তবায়ন হয়নি (TODO)'), '');
  check('static: provider selection helper providerForName exists', provider.includes('export function providerForName'), '');
  check('static: migration 26 adds last_notified_status + last_checked_at', read('apps/api/src/db/migrations/26-shipment-notify.sql').includes('last_notified_status') && read('apps/api/src/db/migrations/26-shipment-notify.sql').includes('last_checked_at'), '');
  const tracking = read('apps/api/src/courier/tracking-check.ts');
  check('static: tracking check notifies on delivered/partial_delivered/cancelled/hold', tracking.includes("'delivered'") && tracking.includes("'partial_delivered'") && tracking.includes("'cancelled'") && tracking.includes("'hold'"), '');
  check('static: tracking check uses real Graph send (deliverOutgoingMessage)', tracking.includes('deliverOutgoingMessage'), '');
  check('static: no invented ETA in the tracking message', !tracking.includes('পৌঁছাবে') && !tracking.includes('আগামীকাল') && !tracking.includes('tomorrow') && tracking.includes('there is no day-before-arrival trigger'), '');
  check('static: cron sweep wires processDueShipmentChecks as a 5th step', read('apps/api/src/cron/routes.ts').includes('processDueShipmentChecks') && read('apps/api/src/cron/routes.ts').includes('shipments'), '');
  const routes = read('apps/api/src/courier/routes.ts');
  check('static: routes expose GET /courier/provider + /courier/balance + POST /courier/check-status', routes.includes("'/courier/provider'") && routes.includes("'/courier/balance'") && routes.includes("'/courier/check-status'"), '');
  check('static: track route uses the shipment’s own courier (not the env provider)', routes.includes('providerForName(shipment.courier'), '');
  check('static: booking resolves contact from the order snapshot first', routes.includes('order.customer_phone') && routes.includes('order.delivery_address'), '');
  check('static: web Courier page shows the provider choice + all options', read('apps/web/app/courier/page.tsx').includes('courier.providerTitle') && read('apps/web/app/courier/page.tsx').includes('providerInfo.providers.map') && read('apps/web/app/courier/page.tsx').includes('checkStatusNow'), '');
  check('static: web lib has providerInfo/balance/checkStatus', read('apps/web/lib/courier.ts').includes('providerInfo') && read('apps/web/lib/courier.ts').includes('checkStatus'), '');

  // ---------- Local API boot (no keys — provider stays stub) ----------
  const port = 4379;
  const dataDir = '.pglite-data-steadfast';
  const run1 = startApi(port, dataDir);
  process.on('exit', run1.stop);
  let workspaceId = '';
  try {
    const up = await waitForHealth(`http://localhost:${port}`);
    check('boot 1: API starts', up, up ? '' : run1.log().slice(-500));
    if (!up) return;
    let token = '';
    const api = async (p, { method = 'GET', auth = true, body, headers = {} } = {}) => {
      const res = await fetch(`http://localhost:${port}${p}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(auth && token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      let data = null;
      try { data = await res.json(); } catch { /* empty */ }
      return { status: res.status, data };
    };
    const signup = await api('/api/auth/signup', {
      method: 'POST', auth: false,
      body: { name: 'Steadfast Owner', email: `steadfast+${stamp}@example.com`, password: 'verify1234', workspaceName: 'Steadfast Test Shop' },
    });
    check('boot 1: signup', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
    token = signup.data?.token ?? '';
    workspaceId = signup.data?.workspace?.id ?? '';
    const live = await api(`/api/workspaces/${workspaceId}/go-live`, { method: 'POST' });
    check('boot 1: go-live', live.status === 200 && live.data?.workspace?.practice_mode === false, `status=${live.status}`);

    const prov = await api('/api/courier/provider');
    check('boot 1: GET /courier/provider → stub selected, steadfast not configured', prov.status === 200 && prov.data?.provider === 'stub' && prov.data?.configured === true, JSON.stringify(prov.data ?? {}));
    const steadfastOpt = (prov.data?.providers ?? []).find((p) => p.name === 'steadfast');
    check('boot 1: provider list has all 4 options', (prov.data?.providers ?? []).length === 4 && (prov.data?.providers ?? []).map((p) => p.name).join(',') === 'stub,steadfast,pathao,redx', JSON.stringify((prov.data?.providers ?? []).map((p) => p.name)));
    check('boot 1: steadfast option honestly reports keys missing', steadfastOpt && steadfastOpt.configured === false && String(steadfastOpt.needs).includes('STEADFAST_API_KEY'), JSON.stringify(steadfastOpt ?? {}));

    const checkStatus = await api('/api/courier/check-status', { method: 'POST', body: {} });
    check('boot 1: POST /courier/check-status with no shipments → 0 checked', checkStatus.status === 200 && checkStatus.data?.checked === 0, `status=${checkStatus.status} ${JSON.stringify(checkStatus.data ?? {})}`);

    const balance = await api('/api/courier/balance');
    check('boot 1: GET /courier/balance without Steadfast → honest 400 (not a fake balance)', balance.status === 400 && balance.data?.available === false, `status=${balance.status} ${JSON.stringify(balance.data ?? {})}`);

    // Stub booking still works (existing behaviour preserved).
    const product = await api('/api/products', { method: 'POST', body: { name: 'Jeans', pricePaisa: 50000, stock: 10 } });
    const jeansId = product.data?.id ?? product.data?.product?.id ?? '';
    check('boot 1: product created', product.status === 201 && !!jeansId, `status=${product.status}`);
    const ch = await api('/api/channels', { method: 'POST', body: { platform: 'webchat', externalId: `site-steadfast-${stamp}`, displayName: 'Steadfast Test Site' } });
    check('boot 1: webchat channel → 201', ch.status === 201, `status=${ch.status}`);
    const m1 = await api('/api/webhooks/webchat', {
      method: 'POST', auth: false,
      headers: { 'x-webchat-secret': WEBCHAT_SECRET },
      body: { externalId: `site-steadfast-${stamp}`, senderId: `wc-steadfast-${stamp}`, name: 'Steadfast Customer', text: 'জিন্সের দাম কত?' },
    });
    check('boot 1: webchat message accepted', m1.status === 200 && !!m1.data?.conversationId, `status=${m1.status}`);
    const convId = m1.data?.conversationId ?? '';
    const custList = await api('/api/customers?q=Steadfast%20Customer');
    const customers = Array.isArray(custList.data) ? custList.data : (custList.data?.customers ?? []);
    const customerId = customers[0]?.id ?? '';
    check('boot 1: customer created', !!customerId, `id=${String(customerId).slice(0, 8)}`);
    const full = await api('/api/orders', {
      method: 'POST',
      body: { customerId, conversationId: convId, items: [{ productId: jeansId, quantity: 1 }], customerPhone: '01712345678', deliveryAddress: 'House 1, Dhanmondi, Dhaka' },
    });
    check('boot 1: order with contact → 201', full.status === 201, `status=${full.status} ${JSON.stringify(full.data ?? {}).slice(0, 200)}`);
    const orderId = full.data?.order?.id ?? full.data?.id ?? '';
    const book = await api('/api/courier/bookings', { method: 'POST', body: { orderId } });
    check('boot 1: stub booking still works (awaiting_provider, no tracking)', book.status === 201 && book.data?.shipment?.status === 'awaiting_provider' && !book.data?.shipment?.trackingNumber, `status=${book.status} ${JSON.stringify(book.data?.shipment ?? {})}`);
    const track = await api(`/api/courier/track/${encodeURIComponent(book.data?.shipment?.trackingNumber ?? 'none')}`);
    check('boot 1: track without a tracking number → honest error', track.status === 400 || track.status === 404, `status=${track.status}`);
  } finally {
    run1.stop();
    await sleep(2500);
  }

  // ---------- Driver (stubbed fetch — no live Steadfast calls) ----------
  if (!workspaceId) {
    check('driver: skipped — no workspaceId from boot', false, '');
  } else {
    const { code, out, err } = await runDriver(dataDir, workspaceId);
    const line = out.split('\n').find((l) => l.startsWith('DRIVER_RESULT '));
    let d = null;
    try { d = JSON.parse(line?.slice('DRIVER_RESULT '.length) ?? 'null'); } catch { /* bad json */ }
    check('driver: ran and printed DRIVER_RESULT', code === 0 && !!d, `code=${code} err=${err.slice(-400)}`);
    if (d) {
      check('driver: missing keys → ProviderNotConfiguredError, no fetch call', String(d.missingKeysError).includes('ProviderNotConfigured') && d.missingKeysNoFetch === true, String(d.missingKeysError));
      check('driver: Dhaka booking parses consignment_id + tracking_code', d.dhakaBookingId === '1424107' && d.dhakaTracking === '15BAEB8A' && d.dhakaStatus === 'in_review', JSON.stringify({ id: d.dhakaBookingId, tr: d.dhakaTracking, st: d.dhakaStatus }));
      check('driver: create_order URL is the real Steadfast endpoint', String(d.createUrl).endsWith('/create_order') && String(d.createUrl).includes('portal.packzy.com/api/v1'), String(d.createUrl));
      check('driver: create_order is POST with Api-Key + Secret-Key + Content-Type: application/json', d.createMethod === 'POST' && d.createHeaderApiKey === 'TEST_API_KEY' && d.createHeaderSecretKey === 'TEST_SECRET_KEY' && d.createHeaderContentType === 'application/json', JSON.stringify({ m: d.createMethod, ak: d.createHeaderApiKey }));
      check('driver: invoice is ASI-<order id>', d.createInvoice === 'ASI-11111111-2222-3333-4444-555555555555', String(d.createInvoice));
      check('driver: COD Dhaka = 500 + 100 = 600', d.createCodDhaka === 600, String(d.createCodDhaka));
      check('driver: COD outside Dhaka = 500 + 130 = 630', d.createCodOutside === 630, String(d.createCodOutside));
      check('driver: COD unclear address defaults to 630 (130 charge)', d.createCodUnclear === 630 && d.chargeUnclear === 130, String(d.createCodUnclear));
      check('driver: zone helper — Dhaka 100 (EN + BN), outside 130', d.chargeDhaka === 100 && d.chargeDhakaBn === 100 && d.chargeOutside === 130, JSON.stringify({ dh: d.chargeDhaka, bn: d.chargeDhakaBn, out: d.chargeOutside }));
      check('driver: recipient name/phone/address in the request', d.createName === 'Test Customer' && d.createPhone === '01712345678' && String(d.createAddress).includes('Dhaka'), JSON.stringify({ n: d.createName, p: d.createPhone }));
      check('driver: +880 phone normalized to 01712345678', d.intlPhone === '01712345678', String(d.intlPhone));
      check('driver: invalid phone refused with CourierValidationError, no fetch', d.badPhoneError === 'CourierValidationError' && d.badPhoneNoFetch === true, String(d.badPhoneError));
      check('driver: track returns in_review', d.trackAvailable === true && d.trackStatus === 'in_review', String(d.trackStatus));
      check('driver: getBalance returns 1250', d.balance === 1250, String(d.balance));
      check('driver: status_by_cid returns delivered', d.statusByCid === 'delivered', String(d.statusByCid));
      check('driver: Steadfast error → throws with Steadfast’s message (no fake booking)', String(d.createErrorMsg).includes('Invalid phone number'), String(d.createErrorMsg));
      check('driver: status check ran — 2 checked, 2 changed, 2 notified', d.check1?.checked === 2 && d.check1?.changed === 2 && d.check1?.notified === 2 && d.check1?.failed === 0, JSON.stringify(d.check1));
      check('driver: delivered shipment stored + notified', d.ship1After?.status === 'delivered' && d.ship1After?.last_notified_status === 'delivered', JSON.stringify(d.ship1After));
      check('driver: hold shipment stored + notified', d.ship2After?.status === 'hold' && d.ship2After?.last_notified_status === 'hold', JSON.stringify(d.ship2After));
      const msgs = d.notifyMessages ?? [];
      const deliveredMsg = msgs.find((m) => String(m.body).includes('ডেলিভারি হয়েছে'));
      const holdMsg = msgs.find((m) => String(m.body).includes('আটকে আছে'));
      check('driver: delivered message sent to the customer (real Graph send, stubbed)', !!deliveredMsg && deliveredMsg.delivery_status === 'sent' && deliveredMsg.platform_message_id === 'm_test123' && String(deliveredMsg.body).includes('15BAEB8A') && String(deliveredMsg.body).includes('স্যার'), JSON.stringify(deliveredMsg ?? {}).slice(0, 300));
      check('driver: hold message sent to the customer', !!holdMsg && holdMsg.delivery_status === 'sent' && String(holdMsg.body).includes('15BAEB8B'), JSON.stringify(holdMsg ?? {}).slice(0, 300));
      check('driver: Graph send addressed the customer PSID', Array.isArray(d.graphCalls) && d.graphCalls.length === 2 && d.graphCalls.every((c) => String(c.body).includes('PSID_TEST_123')), `graphCalls=${(d.graphCalls ?? []).length}`);
      check('driver: second run sends NO duplicate message', d.check2?.notified === 0 && d.graphCalls2 === 0 && d.notifyMessageCountAfterSecondRun === 2, JSON.stringify(d.check2));
    }
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
