#!/usr/bin/env node
/**
 * Subscription verification (standalone, local, no Docker).
 * Run while the API is up (with the subscriptions router mounted — see
 * apps/api/src/subscriptions/integration-notes.md) and the web app is up:
 *   API_URL=http://localhost:4000 WEB_URL=http://localhost:3000 node scripts/verify-subscriptions.mjs
 * NOTE: this verifier uses the test hooks POST /api/subscriptions/test/*,
 * which are OFF by default — start the API with the flag on, e.g.
 *   ALLOW_SUBSCRIPTION_TEST_HOOKS=true ./scripts/run-local.sh
 * (Without the flag the hook calls answer 404 and the expiry/overage
 * steps fail — that is the gate working, not a bug.)
 * NOTE 2: the test channels carry a stub Page token and this verifier
 * starts a stub Meta Graph server on port 4012, because an undelivered
 * AI reply is NOT charged (no-charge-on-failed-send) — without a
 * deliverable channel the overage ledger checks would see no charge.
 * Start the API with the stub Graph URL too, e.g.
 *   ALLOW_SUBSCRIPTION_TEST_HOOKS=true META_GRAPH_BASE_URL=http://localhost:4012/v21.0 ./scripts/run-local.sh
 *
 * Fresh workspaces per run. Flow:
 *   A: signup → plans list → trial on signup → channel limit flag →
 *      go-live → product → AI reply INCLUDED (0 paisa, included_in_plan) →
 *      subscribe needs money (402) → topup → subscribe → upgrade →
 *      downgrade → cancel (still active) → renew → simulate 500 uses →
 *      overage reply (10 paisa) → expire → blocked with upgrade notice +
 *      ticket → renew again → product-limit flag (100 products).
 *   B: signup → topup to exactly one plan price → subscribe (balance 0) →
 *      simulate 500 uses → AI blocked (overage needs 10 paisa, wallet empty)
 *      with upgrade notice + ticket.
 * Plus: web app serves /plans.
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 */
import http from 'node:http';

const API = process.env.API_URL ?? 'http://localhost:4000';
const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
// Stub Meta Graph port (the API must be started with
// META_GRAPH_BASE_URL=http://localhost:4012/v21.0 — see header).
const STUB_GRAPH_PORT = 4012;
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function api(path, { method = 'GET', body, auth = true, token = '' } = {}) {
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

async function signup(tag) {
  const stamp = Date.now();
  const email = `subs+${tag}+${stamp}@example.com`;
  const r = await api('/api/auth/signup', {
    method: 'POST',
    auth: false,
    body: { name: 'Subs Owner', email, password: 'verify1234', workspaceName: `Subs Shop ${tag}` },
  });
  return { token: r.data?.token ?? '', workspaceId: r.data?.workspace?.id ?? '', status: r.status, balance: r.data?.workspace?.balancePaisa };
}

async function sendCustomerMessage(token, mid, text) {
  await api('/api/webhooks/meta', {
    method: 'POST',
    auth: false,
    body: {
      object: 'page',
      entry: [{ id: 'page-subs-1', messaging: [{ sender: { id: 'cust-subs-1' }, recipient: { id: 'page-subs-1' }, message: { mid, text } }] }],
    },
  });
}

async function outMessages(token, conversationId) {
  const d = await api(`/api/inbox/${conversationId}`, { token });
  return (d.data?.messages ?? []).filter((m) => m.direction === 'out');
}

async function setupChatWorkspace(tag) {
  // signup → channel → go-live → 1 product. Returns {token, workspaceId, conversationId?}.
  const s = await signup(tag);
  if (!s.token) return s;
  await api('/api/channels', { method: 'POST', token: s.token, body: { platform: 'messenger', externalId: 'page-subs-1', displayName: 'Subs Page', token: 'tok-stub-subs' } });
  await api(`/api/workspaces/${s.workspaceId}/go-live`, { method: 'POST', token: s.token });
  await api('/api/products', { method: 'POST', token: s.token, body: { name: 'শাড়ি', pricePaisa: 150000, size: 'M', stock: 5, description: 'সুতির শাড়ি' } });
  return s;
}

async function findFirstConversation(token) {
  const list = await api('/api/inbox', { token });
  return list.data?.conversations?.[0]?.id ?? '';
}

async function waitForOut(token, conversationId, minOut, timeoutMs = 45000) {
  return waitFor(async () => {
    const outs = await outMessages(token, conversationId);
    return outs.length >= minOut ? outs : null;
  }, timeoutMs, 'outgoing reply');
}

async function waitForConversationWithOut(token, minOut) {
  return waitFor(async () => {
    const list = await api('/api/inbox', { token });
    const conv = list.data?.conversations?.[0];
    if (!conv) return null;
    const d = await api(`/api/inbox/${conv.id}`, { token });
    const out = (d.data?.messages ?? []).filter((m) => m.direction === 'out');
    return out.length >= minOut ? { conversationId: conv.id, out } : null;
  }, 45000, 'AI/notice reply');
}

async function main() {
  // Stub Meta Graph server (offline stand-in for graph.facebook.com):
  // every /{node}/messages POST is accepted with a fake message_id, so
  // the test channel's AI replies count as delivered (and therefore
  // charged — see the no-charge-on-failed-send rule). The API must be
  // started with META_GRAPH_BASE_URL=http://localhost:4012/v21.0.
  const graphStub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ recipient_id: 'cust-subs-1', message_id: 'm_stub_subs' }));
    });
  });
  await new Promise((resolve) => graphStub.listen(STUB_GRAPH_PORT, resolve));
  process.on('exit', () => { try { graphStub.close(); } catch { /* already closed */ } });

  const health = await api('/api/health', { auth: false });
  check('API health', health.status === 200 && health.data?.status === 'ok', JSON.stringify(health.data));

  // ================= Workspace A (main flow) =================
  const A = await setupChatWorkspace('a');
  check('A: signup', A.status === 201 && !!A.token, `status=${A.status}`);
  check('A: signup free credit 5000 paisa', A.balance === 5000, `balance=${A.balance}`);
  const tokenA = A.token;

  // Plans list
  const plansRes = await api('/api/subscriptions/plans', { token: tokenA });
  const plans = plansRes.data?.plans ?? [];
  const bySlug = Object.fromEntries(plans.map((p) => [p.slug, p]));
  check('plans list has 3 suggested plans', plansRes.status === 200 && plans.length === 3, `count=${plans.length}`);
  check(
    'plans: ছোট ৳499/500 replies/1 channel/100 products',
    Number(bySlug.choto?.price_paisa) === 49900 && Number(bySlug.choto?.included_ai_replies) === 500 &&
    Number(bySlug.choto?.max_channels) === 1 && Number(bySlug.choto?.max_products) === 100,
    JSON.stringify(bySlug.choto),
  );
  check(
    'plans: মাঝারি ৳999/2000/3/500',
    Number(bySlug.majhari?.price_paisa) === 99900 && Number(bySlug.majhari?.included_ai_replies) === 2000 &&
    Number(bySlug.majhari?.max_channels) === 3 && Number(bySlug.majhari?.max_products) === 500,
    JSON.stringify(bySlug.majhari),
  );
  check(
    'plans: বড় ৳1999/8000/unlimited/unlimited',
    Number(bySlug.boro?.price_paisa) === 199900 && Number(bySlug.boro?.included_ai_replies) === 8000 &&
    bySlug.boro?.max_channels === null && bySlug.boro?.max_products === null,
    JSON.stringify(bySlug.boro),
  );

  // Trial on signup (lazy-created on first read)
  const cur1 = await api('/api/subscriptions/current', { token: tokenA });
  const c1 = cur1.data?.current;
  check(
    'trial on signup (ছোট, status trial)',
    cur1.status === 200 && c1?.plan?.slug === 'choto' && c1?.subscription?.status === 'trial' && c1?.subscription?.isActive === true,
    `plan=${c1?.plan?.slug}, status=${c1?.subscription?.status}`,
  );
  const endMs = new Date(c1?.subscription?.current_period_end ?? 0).getTime() - Date.now();
  check('trial lasts ~14 days', endMs > 13 * 24 * 3600 * 1000 && endMs <= 14 * 24 * 3600 * 1000 + 60000, `ends in ${Math.round(endMs / 3600000)}h`);
  check('trial usage starts at 0/500', c1?.usage?.usedReplies === 0 && c1?.usage?.includedReplies === 500, `used=${c1?.usage?.usedReplies}`);

  // Channel limit flag: 1 connected channel (messenger) on ছোট (max 1)
  const lim1 = await api('/api/subscriptions/limits', { token: tokenA });
  check(
    'channel limit: 1 used / 1 max → cannot add more',
    lim1.data?.channels?.used === 1 && lim1.data?.channels?.limit === 1 && lim1.data?.channels?.canAdd === false &&
    typeof lim1.data?.channels?.message === 'string' && lim1.data?.channels?.message.includes('চ্যানেল'),
    JSON.stringify(lim1.data?.channels),
  );
  check(
    'product limit: 1 used / 100 max → can add',
    lim1.data?.products?.used === 1 && lim1.data?.products?.limit === 100 && lim1.data?.products?.canAdd === true,
    JSON.stringify(lim1.data?.products),
  );

  // Included AI reply: free, 0 paisa, included_in_plan.
  // NOTE: Groq is non-deterministic — it sometimes answers with low
  // confidence (< 0.6), and the pre-existing agent handoff then creates
  // a ticket instead of replying (no ledger entry). That is correct
  // behaviour, not a subscription failure — so retry the probe with a
  // fresh message (up to 3 attempts) until an outgoing reply arrives.
  const stamp = Date.now();
  let conversationId = '';
  let firstReply = '';
  for (let attempt = 1; attempt <= 3 && !conversationId; attempt++) {
    await sendCustomerMessage(tokenA, `subs-mid-${stamp}-1-${attempt}`, 'শাড়ির দাম কত?');
    const found = await waitFor(async () => {
      const id = await findFirstConversation(tokenA);
      if (!id) return null;
      const outs = await outMessages(tokenA, id);
      return outs.length >= 1 ? { conversationId: id, out: outs } : null;
    }, 45000, 'AI/notice reply').catch(() => null);
    if (found) {
      conversationId = found.conversationId;
      firstReply = found.out.map((m) => m.body ?? '').join('\n');
    }
  }
  check('included AI reply arrives (not an upgrade notice)', !!conversationId && !firstReply.includes('প্ল্যানের মেয়াদ'), firstReply.slice(0, 100));
  if (conversationId) {
    check('included reply mentions শাড়ি + real price', firstReply.includes('শাড়ি') && (firstReply.includes('1,500') || firstReply.includes('১৫০০') || firstReply.includes('1500')), firstReply.slice(0, 120));
    const firstOuts = await outMessages(tokenA, conversationId);
    // 'sent' = real Groq reply delivered via the stub Graph; 'local' =
    // the demo fallback (Groq was unavailable, reply saved only — by
    // design it is never live-sent). Only 'failed' means the API was
    // not started with META_GRAPH_BASE_URL=http://localhost:4012/v21.0.
    check('included reply was delivered (not failed)', ['sent', 'local'].includes(firstOuts[0]?.delivery_status), `delivery_status=${firstOuts[0]?.delivery_status} — if 'failed', start the API with META_GRAPH_BASE_URL=http://localhost:4012/v21.0`);
  } else {
    check('included reply mentions শাড়ি + real price', false, 'no reply after 3 attempts');
  }
  const bill1 = await api('/api/billing', { token: tokenA });
  check('included reply costs 0 paisa, balance stays 5000', Number(bill1.data?.balancePaisa) === 5000 && Number(bill1.data?.usage?.[0]?.cost_paisa) === 0, `balance=${bill1.data?.balancePaisa}, cost=${bill1.data?.usage?.[0]?.cost_paisa}`);
  const curAfterReply = await api('/api/subscriptions/current', { token: tokenA });
  const recent = curAfterReply.data?.current?.recentUsage ?? [];
  check(
    'ledger entry marked included_in_plan=true',
    recent.length >= 1 && recent[0]?.included_in_plan === true && Number(recent[0]?.cost_paisa) === 0,
    JSON.stringify(recent[0]),
  );

  // Subscribe needs money (402), then topup + subscribe
  const subPoor = await api('/api/subscriptions/subscribe', { method: 'POST', token: tokenA, body: { planSlug: 'choto' } });
  check('subscribe ছোট with ৳50 balance → 402 Bengali error', subPoor.status === 402 && typeof subPoor.data?.error === 'string' && subPoor.data.error.length > 5, `status=${subPoor.status}`);
  const top1 = await api('/api/billing/topup', { method: 'POST', token: tokenA, body: { amountPaisa: 100000 } });
  check('topup ৳1000 → balance 105000', top1.status === 201 && Number(top1.data?.balancePaisa) === 105000, `balance=${top1.data?.balancePaisa}`);
  const sub1 = await api('/api/subscriptions/subscribe', { method: 'POST', token: tokenA, body: { planSlug: 'choto' } });
  check('subscribe ছোট → active, balance 55100', sub1.status === 201 && sub1.data?.subscription?.status === 'active' && Number(sub1.data?.balancePaisa) === 55100, `status=${sub1.status}, balance=${sub1.data?.balancePaisa}`);
  const billSub = await api('/api/billing', { token: tokenA });
  const subTx = (billSub.data?.transactions ?? []).find((t) => t.type === 'subscription_charge');
  check('subscription charge in wallet ledger (-49900)', !!subTx && Number(subTx.amount_paisa) === -49900, JSON.stringify(subTx));

  // Upgrade to মাঝারি (needs topup first), then downgrade to ছোট
  await api('/api/billing/topup', { method: 'POST', token: tokenA, body: { amountPaisa: 50000 } });
  const up = await api('/api/subscriptions/upgrade', { method: 'POST', token: tokenA, body: { planSlug: 'majhari' } });
  check('upgrade → মাঝারি, balance 5200', up.status === 201 && up.data?.plan?.slug === 'majhari' && Number(up.data?.balancePaisa) === 5200, `status=${up.status}, balance=${up.data?.balancePaisa}`);
  const curUp = await api('/api/subscriptions/current', { token: tokenA });
  check('upgraded plan: 2000 included, max 3 channels', curUp.data?.current?.usage?.includedReplies === 2000 && curUp.data?.current?.limits?.channels?.limit === 3, `included=${curUp.data?.current?.usage?.includedReplies}`);
  const badUp = await api('/api/subscriptions/upgrade', { method: 'POST', token: tokenA, body: { planSlug: 'choto' } });
  check('upgrade to a smaller plan → 400', badUp.status === 400, `status=${badUp.status}`);
  await api('/api/billing/topup', { method: 'POST', token: tokenA, body: { amountPaisa: 50000 } });
  const down = await api('/api/subscriptions/downgrade', { method: 'POST', token: tokenA, body: { planSlug: 'choto' } });
  check('downgrade → ছোট, balance 5300', down.status === 201 && down.data?.plan?.slug === 'choto' && Number(down.data?.balancePaisa) === 5300, `status=${down.status}, balance=${down.data?.balancePaisa}`);

  // Cancel (stays active until period end), then renew
  const cancel = await api('/api/subscriptions/cancel', { method: 'POST', token: tokenA });
  check('cancel → status cancelled', cancel.status === 200 && cancel.data?.subscription?.status === 'cancelled', `status=${cancel.status}`);
  const curCancel = await api('/api/subscriptions/current', { token: tokenA });
  check('cancelled plan still active until period end', curCancel.data?.current?.subscription?.isActive === true && curCancel.data?.current?.subscription?.status === 'cancelled', `isActive=${curCancel.data?.current?.subscription?.isActive}`);
  await api('/api/billing/topup', { method: 'POST', token: tokenA, body: { amountPaisa: 50000 } });
  const renew = await api('/api/subscriptions/renew', { method: 'POST', token: tokenA });
  check('renew → active again, balance 5400', renew.status === 201 && renew.data?.subscription?.status === 'active' && Number(renew.data?.balancePaisa) === 5400, `status=${renew.status}, balance=${renew.data?.balancePaisa}`);

  // Overage: simulate 500 used replies → next AI reply costs 10 paisa.
  // (Same low-confidence handoff flakiness as the included reply above:
  // retry the probe with a fresh message, up to 2 attempts, until a new
  // outgoing row appears.)
  const sim = await api('/api/subscriptions/test/simulate-usage', { method: 'POST', token: tokenA, body: { count: 500 } });
  check('simulate 500 used replies', sim.status === 200 && sim.data?.usedReplies >= 500, `used=${sim.data?.usedReplies}`);
  conversationId = conversationId || (await findFirstConversation(tokenA));
  const outBefore = (await outMessages(tokenA, conversationId)).length;
  let over = null;
  for (let attempt = 1; attempt <= 2 && !over; attempt++) {
    await sendCustomerMessage(tokenA, `subs-mid-${stamp}-2-${attempt}`, 'শাড়ির দাম কত?');
    over = await waitForOut(tokenA, conversationId, outBefore + 1).catch(() => null);
  }
  check('overage AI reply still arrives', !!over, `out before=${outBefore}`);
  const bill2 = await api('/api/billing', { token: tokenA });
  check('overage reply costs 10 paisa, balance 5390', Number(bill2.data?.balancePaisa) === 5390, `balance=${bill2.data?.balancePaisa}`);
  const curOver = await api('/api/subscriptions/current', { token: tokenA });
  const recentOver = (curOver.data?.current?.recentUsage ?? [])[0];
  check('overage ledger entry: cost 10, included_in_plan=false', Number(recentOver?.cost_paisa) === 10 && recentOver?.included_in_plan === false, JSON.stringify(recentOver));

  // Expired: expire → AI blocked with upgrade notice + ticket, ledger unchanged
  const exp = await api('/api/subscriptions/test/expire-current', { method: 'POST', token: tokenA });
  check('expire-current (test hook)', exp.status === 200, `status=${exp.status}`);
  const curExp = await api('/api/subscriptions/current', { token: tokenA });
  check('expired plan shows effectiveStatus expired, not active', curExp.data?.current?.subscription?.effectiveStatus === 'expired' && curExp.data?.current?.subscription?.isActive === false, `effective=${curExp.data?.current?.subscription?.effectiveStatus}`);
  const ticketsBefore = await api('/api/tickets', { token: tokenA });
  const ticketCountBefore = (ticketsBefore.data?.tickets ?? []).length;
  const usedBefore = curExp.data?.current?.usage?.usedReplies ?? 0;
  conversationId = conversationId || (await findFirstConversation(tokenA));
  const outBefore2 = (await outMessages(tokenA, conversationId)).length;
  await sendCustomerMessage(tokenA, `subs-mid-${stamp}-3`, 'শাড়ির দাম কত?');
  const blocked = await waitForOut(tokenA, conversationId, outBefore2 + 1).catch(() => null);
  if (blocked) {
    const last = blocked[blocked.length - 1]?.body ?? '';
    check('expired plan: customer gets the Bengali upgrade notice', last.includes('প্ল্যানের মেয়াদ/সীমা শেষ হয়েছে'), last.slice(0, 120));
  } else {
    check('expired plan: customer gets the Bengali upgrade notice', false, 'no outgoing message arrived');
  }
  const ticketsAfter = await api('/api/tickets', { token: tokenA });
  const newTickets = (ticketsAfter.data?.tickets ?? []).slice(ticketCountBefore);
  check('expired plan: team ticket created', (ticketsAfter.data?.tickets ?? []).length > ticketCountBefore, `before=${ticketCountBefore}, after=${(ticketsAfter.data?.tickets ?? []).length}`);
  const curAfterBlock = await api('/api/subscriptions/current', { token: tokenA });
  check('expired plan: no AI reply logged (usage unchanged)', (curAfterBlock.data?.current?.usage?.usedReplies ?? -1) === usedBefore, `used before=${usedBefore}, after=${curAfterBlock.data?.current?.usage?.usedReplies}`);
  void newTickets;

  // Renew after expiry restores the plan
  await api('/api/billing/topup', { method: 'POST', token: tokenA, body: { amountPaisa: 50000 } });
  const renew2 = await api('/api/subscriptions/renew', { method: 'POST', token: tokenA });
  check('renew after expiry → active', renew2.status === 201 && renew2.data?.subscription?.status === 'active', `status=${renew2.status}`);

  // Product limit flag: fill up to 100 products → cannot add more
  for (let i = 0; i < 99; i++) {
    await api('/api/products', { method: 'POST', token: tokenA, body: { name: `পণ্য ${i + 1}`, pricePaisa: 1000, stock: 1 } });
  }
  const lim2 = await api('/api/subscriptions/limits', { token: tokenA });
  check(
    'product limit: 100 used / 100 max → cannot add more',
    lim2.data?.products?.used === 100 && lim2.data?.products?.limit === 100 && lim2.data?.products?.canAdd === false &&
    typeof lim2.data?.products?.message === 'string' && lim2.data?.products?.message.includes('প্রোডাক্ট'),
    JSON.stringify(lim2.data?.products),
  );

  // ================= Workspace B (wallet-empty overage block) =================
  const B = await setupChatWorkspace('b');
  check('B: signup', B.status === 201 && !!B.token, `status=${B.status}`);
  const tokenB = B.token;
  await api('/api/billing/topup', { method: 'POST', token: tokenB, body: { amountPaisa: 44900 } });
  const subB = await api('/api/subscriptions/subscribe', { method: 'POST', token: tokenB, body: { planSlug: 'choto' } });
  check('B: subscribe drains wallet to 0', subB.status === 201 && Number(subB.data?.balancePaisa) === 0, `balance=${subB.data?.balancePaisa}`);
  await api('/api/subscriptions/test/simulate-usage', { method: 'POST', token: tokenB, body: { count: 500 } });
  await sendCustomerMessage(tokenB, `subs-mid-${stamp}-b1`, 'শাড়ির দাম কত?');
  const blockedB = await waitForConversationWithOut(tokenB, 1).catch(() => null);
  if (blockedB) {
    const last = blockedB.out[blockedB.out.length - 1]?.body ?? '';
    check('B: wallet empty + over limit → upgrade notice, no AI answer', last.includes('প্ল্যানের মেয়াদ/সীমা শেষ হয়েছে'), last.slice(0, 120));
  } else {
    check('B: wallet empty + over limit → upgrade notice, no AI answer', false, 'no outgoing message arrived');
  }
  const ticketsB = await api('/api/tickets', { token: tokenB });
  check('B: team ticket created for the block', (ticketsB.data?.tickets ?? []).length >= 1, `tickets=${(ticketsB.data?.tickets ?? []).length}`);

  // ================= Web =================
  try {
    const res = await fetch(`${WEB}/plans`);
    check('web app serves /plans', res.status === 200, `status=${res.status}`);
  } catch (e) {
    check('web app serves /plans', false, e.message);
  }

  // Close the stub Graph server so the process can exit: a listening
  // server keeps the Node event loop alive, and main() returns without
  // process.exit() on a full pass.
  await new Promise((resolve) => graphStub.close(() => resolve()));

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
