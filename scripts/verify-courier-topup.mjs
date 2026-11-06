#!/usr/bin/env node
/**
 * Verification for the Courier Booking + Payment Top-Up module.
 * Run while the API is up (routers mounted — see courier/integration-notes.md):
 *   node scripts/verify-courier-topup.mjs
 *   API_URL=http://localhost:4100 node scripts/verify-courier-topup.mjs
 *
 * Flow (fresh workspace, test data only — no real courier, no gateway):
 *   signup → product → Messenger webhook (creates a customer) → order →
 *   stub courier booking (assert status awaiting_provider and NO fake
 *   tracking number) → tracking lookup honestly unavailable →
 *   top-up request → approve → wallet +exact amount, ledger entry exists →
 *   reject path works → double-approve is blocked (409, no double credit).
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 */
const API = process.env.API_URL ?? 'http://localhost:4000';
const results = [];
let token = '';
let workspaceId = '';
let customerId = '';
let productId = '';
let orderId = '';
let shipmentId = '';
let topupId = '';

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function api(path, { method = 'GET', body, auth = true } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
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
}

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const got = await fn();
    if (got) return got;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

async function main() {
  const stamp = Date.now();
  const email = `courier-verify+${stamp}@example.com`;

  // 1. Health
  const health = await api('/api/health', { auth: false });
  check('API health', health.status === 200 && health.data?.status === 'ok', JSON.stringify(health.data));

  // 2. Signup (fresh workspace, 5000 paisa free credit)
  const signup = await api('/api/auth/signup', {
    method: 'POST',
    auth: false,
    body: { name: 'Courier Verify', email, password: 'verify1234', workspaceName: 'Courier Verify Shop' },
  });
  check('signup', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
  token = signup.data?.token ?? '';
  workspaceId = signup.data?.workspace?.id ?? '';
  check('signup free credit 5000 paisa', signup.data?.workspace?.balancePaisa === 5000, `balance=${signup.data?.workspace?.balancePaisa}`);

  // 3. Login
  const login = await api('/api/auth/login', { method: 'POST', auth: false, body: { email, password: 'verify1234' } });
  check('login', login.status === 200 && !!login.data?.token, `status=${login.status}`);
  if (login.data?.token) token = login.data.token;

  // 4. Messenger channel + a customer message via webhook (creates the customer)
  const channel = await api('/api/channels', {
    method: 'POST',
    body: { platform: 'messenger', externalId: 'page-courier-verify-1', displayName: 'Courier Verify Page' },
  });
  check('connect messenger channel', channel.status === 201, `status=${channel.status}`);
  await api('/api/webhooks/meta', {
    method: 'POST',
    auth: false,
    body: {
      object: 'page',
      entry: [{
        id: 'page-courier-verify-1',
        messaging: [{
          sender: { id: 'cust-courier-verify-1' },
          recipient: { id: 'page-courier-verify-1' },
          message: { mid: `courier-mid-${stamp}-1`, text: 'শাড়ি অর্ডার করতে চাই' },
        }],
      }],
    },
  });
  const inbox = await waitFor(async () => {
    const list = await api('/api/inbox');
    const conv = (list.data?.conversations ?? [])[0];
    if (!conv) return null;
    const d = await api(`/api/inbox/${conv.id}`);
    return d.data?.customer?.id ? d.data : null;
  }, 20000, 'customer from webhook').catch((e) => {
    check('customer created via webhook', false, e.message);
    return null;
  });
  if (inbox) {
    customerId = inbox.customer.id;
    check('customer created via webhook', true, `customer=${customerId.slice(0, 8)}`);
  }

  // 5. Product + order (team-created)
  const p1 = await api('/api/products', {
    method: 'POST',
    body: { name: 'শাড়ি', pricePaisa: 150000, size: 'M', stock: 5, description: 'সুতির শাড়ি' },
  });
  productId = p1.data?.product?.id ?? '';
  check('add product (শাড়ি, ৳1500)', p1.status === 201 && !!productId, `status=${p1.status}`);
  const order = await api('/api/orders', {
    method: 'POST',
    body: { customerId, items: [{ productId, quantity: 1 }], source: 'team' },
  });
  orderId = order.data?.order?.id ?? '';
  check('create order via API (1 × শাড়ি = ৳1500)', order.status === 201 && Number(order.data?.order?.total_paisa) === 150000, `status=${order.status}, total=${order.data?.order?.total_paisa}`);

  // 6. Stub courier booking — must NOT invent a tracking number.
  const booking = await api('/api/courier/bookings', { method: 'POST', body: { orderId } });
  const shipment = booking.data?.shipment ?? {};
  shipmentId = shipment.id ?? '';
  check(
    'stub courier booking (201, status awaiting_provider, NO fake tracking number)',
    booking.status === 201 &&
      shipment.status === 'awaiting_provider' &&
      (shipment.trackingNumber ?? shipment.tracking_number) === null &&
      (shipment.providerBookingId ?? shipment.provider_booking_id) === null &&
      booking.data?.providerConfigured === false,
    `status=${booking.status}, shipment=${JSON.stringify(shipment)}`,
  );
  check(
    'stub booking message is honest (Bengali, says no tracking number yet)',
    typeof booking.data?.message === 'string' && booking.data.message.includes('ট্র্যাকিং নম্বর এখনো পাওয়া যায়নি'),
    (booking.data?.message ?? '').slice(0, 80),
  );

  // 7. Booking the same order again returns the existing shipment (no double-booking).
  const again = await api('/api/courier/bookings', { method: 'POST', body: { orderId } });
  check(
    'second booking for same order returns existing shipment (no duplicate)',
    again.status === 200 && again.data?.alreadyBooked === true && again.data?.shipment?.id === shipmentId,
    `status=${again.status}, alreadyBooked=${again.data?.alreadyBooked}`,
  );

  // 8. Booking a nonexistent order → 404.
  const badOrder = await api('/api/courier/bookings', {
    method: 'POST',
    body: { orderId: '00000000-0000-0000-0000-000000000000' },
  });
  check('booking a nonexistent order → 404', badOrder.status === 404, `status=${badOrder.status}`);

  // 9. Tracking lookup — honestly unavailable (stub has no tracking number).
  const track = await api(`/api/courier/track/TRACK-NOT-EXIST-${stamp}`, { auth: true });
  check(
    'tracking lookup for unknown number honestly unavailable (available:false)',
    track.data?.available === false,
    `status=${track.status}, available=${track.data?.available}, reason=${track.data?.reason ?? ''}`,
  );

  // 10. Shipments list contains the stub shipment.
  const list = await api('/api/courier/shipments');
  const found = (list.data?.shipments ?? []).find((s) => s.id === shipmentId);
  check(
    'shipments list contains the stub shipment',
    list.status === 200 && !!found && found.status === 'awaiting_provider',
    `count=${(list.data?.shipments ?? []).length}`,
  );

  // 11. Top-up request — invalid inputs rejected.
  const badMethod = await api('/api/billing/topup/request', {
    method: 'POST',
    body: { amountPaisa: 10000, method: 'rocket', transactionId: 'TX-1' },
  });
  check('top-up request with bad method → 400', badMethod.status === 400, `status=${badMethod.status}`);
  const noTx = await api('/api/billing/topup/request', {
    method: 'POST',
    body: { amountPaisa: 10000, method: 'bkash', transactionId: '' },
  });
  check('top-up request without transaction id → 400', noTx.status === 400, `status=${noTx.status}`);

  // 12. Top-up request (bKash, ৳100 = 10000 paisa) → pending.
  const req1 = await api('/api/billing/topup/request', {
    method: 'POST',
    body: { amountPaisa: 10000, method: 'bkash', transactionId: `TX-VERIFY-${stamp}-1` },
  });
  topupId = req1.data?.topupRequest?.id ?? '';
  check(
    'top-up request created (pending, bKash, ৳100)',
    req1.status === 201 && req1.data?.topupRequest?.status === 'pending' && Number(req1.data?.topupRequest?.amountPaisa ?? req1.data?.topupRequest?.amount_paisa) === 10000,
    `status=${req1.status}, ${JSON.stringify(req1.data?.topupRequest)}`,
  );

  // 13. Approve → wallet +exact amount (5000 → 15000), ledger entry exists.
  const billingBefore = await api('/api/billing');
  const balanceBefore = Number(billingBefore.data?.balancePaisa ?? 0);
  const approve = await api(`/api/billing/topup/${topupId}/approve`, { method: 'POST' });
  check(
    'approve top-up → wallet credited by exact amount',
    approve.status === 200 &&
      approve.data?.topupRequest?.status === 'approved' &&
      Number(approve.data?.balancePaisa) === balanceBefore + 10000,
    `status=${approve.status}, balance=${approve.data?.balancePaisa} (was ${balanceBefore})`,
  );
  const billingAfter = await api('/api/billing');
  const txs = billingAfter.data?.transactions ?? [];
  check(
    'wallet balance is 15000 after approval (5000 free + 10000 top-up)',
    Number(billingAfter.data?.balancePaisa) === 15000,
    `balance=${billingAfter.data?.balancePaisa}`,
  );
  check(
    'ledger has a topup wallet transaction of 10000 paisa',
    txs.some((t) => t.type === 'topup' && Number(t.amount_paisa ?? t.amountPaisa) === 10000),
    `transactions=${txs.length}`,
  );

  // 14. Double-approve is blocked — no double credit.
  const approveAgain = await api(`/api/billing/topup/${topupId}/approve`, { method: 'POST' });
  const billingDouble = await api('/api/billing');
  check(
    'second approve → 409 and balance unchanged (no double credit)',
    approveAgain.status === 409 && Number(billingDouble.data?.balancePaisa) === 15000,
    `status=${approveAgain.status}, balance=${billingDouble.data?.balancePaisa}`,
  );

  // 15. Reject path: new request → reject with reason → balance unchanged.
  const req2 = await api('/api/billing/topup/request', {
    method: 'POST',
    body: { amountPaisa: 5000, method: 'nagad', transactionId: `TX-VERIFY-${stamp}-2` },
  });
  const topupId2 = req2.data?.topupRequest?.id ?? '';
  const rejected = await api(`/api/billing/topup/${topupId2}/reject`, {
    method: 'POST',
    body: { reason: 'লেনদেন আইডি মেলেনি' },
  });
  const billingReject = await api('/api/billing');
  check(
    'reject top-up with reason → rejected, balance unchanged (15000)',
    req2.status === 201 &&
      rejected.status === 200 &&
      rejected.data?.topupRequest?.status === 'rejected' &&
      Number(billingReject.data?.balancePaisa) === 15000,
    `reject status=${rejected.status}, balance=${billingReject.data?.balancePaisa}`,
  );
  const rejectAgain = await api(`/api/billing/topup/${topupId2}/reject`, { method: 'POST', body: { reason: 'x' } });
  check('second reject → 409', rejectAgain.status === 409, `status=${rejectAgain.status}`);

  // 16. Top-up requests list contains both requests.
  const reqList = await api('/api/billing/topup/requests');
  const statuses = (reqList.data?.topupRequests ?? []).map((r) => r.status);
  check(
    'top-up requests list shows approved + rejected',
    reqList.status === 200 && statuses.includes('approved') && statuses.includes('rejected'),
    `statuses=${statuses.join(',')}`,
  );

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length > 0) {
    console.log('Failed:');
    for (const f of failed) console.log(` - ${f.name} — ${f.detail}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Verification crashed:', err);
  process.exit(1);
});
