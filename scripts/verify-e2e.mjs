#!/usr/bin/env node
/**
 * End-to-end verification for the Phase 1 MVP + Phase 2/3 (local, no Docker).
 * Run while the API is up on :4000 and the web app on :3000:
 *   node scripts/verify-e2e.mjs
 *
 * Phase 1 flow: signup → login → channel → go-live → 2 products → knowledge →
 * Messenger webhook → AI reply (product card) → billing
 * ledger (10 paisa) → order-intent message → AI-created order → order
 * status flow → ticket flow → duplicate-webhook dedup → Meta verify.
 * Phase 2/3 flow: approval-gated channels → coupons + stock → customers +
 * merge → scheduled posts + calendar + publish-now + comment carousel →
 * leads + follow-ups → analytics → AI teaching (preview/apply/rollback) →
 * broadcast (24h window) → bookings + reminders → review request →
 * CSV migration → feature requests → new web pages.
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 * NOTE: uses only test data in a fresh workspace; nothing is sent to Meta.
 */
import fs from 'node:fs';

const API = process.env.API_URL ?? 'http://localhost:4000';
const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const results = [];
let token = '';
let workspaceId = '';
let product1 = null;
let product2 = null;
let conversationId = '';
let customerId = '';
let orderId = '';

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

function verifyTokenFromEnv() {
  try {
    const env = fs.readFileSync('apps/api/.env', 'utf8');
    const m = env.match(/^META_VERIFY_TOKEN=(.*)$/m);
    return (m?.[1] ?? '').trim();
  } catch {
    return '';
  }
}

function providerFromEnv() {
  try {
    const env = fs.readFileSync('apps/api/.env', 'utf8');
    const m = env.match(/^AI_PROVIDER=(.*)$/m);
    return (m?.[1] ?? 'gemini').trim() || 'gemini';
  } catch {
    return 'gemini';
  }
}

const PROVIDER = providerFromEnv();
console.log(`AI provider under test: ${PROVIDER} (from apps/api/.env)`);

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
  const email = `verify+${stamp}@example.com`;

  // 1. Health
  const health = await api('/api/health', { auth: false });
  check('API health', health.status === 200 && health.data?.status === 'ok', JSON.stringify(health.data));

  // 2. Signup (fresh workspace, 5000 paisa free credit)
  const signup = await api('/api/auth/signup', {
    method: 'POST',
    auth: false,
    body: { name: 'Verify Owner', email, password: 'verify1234', workspaceName: 'Verify Shop' },
  });
  check('signup', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
  token = signup.data?.token ?? '';
  workspaceId = signup.data?.workspace?.id ?? '';
  check('signup free credit 5000 paisa', signup.data?.workspace?.balancePaisa === 5000, `balance=${signup.data?.workspace?.balancePaisa}`);

  // 3. Login
  const login = await api('/api/auth/login', {
    method: 'POST',
    auth: false,
    body: { email, password: 'verify1234' },
  });
  check('login', login.status === 200 && !!login.data?.token, `status=${login.status}`);
  if (login.data?.token) token = login.data.token;

  // 4. Connect a Messenger channel (fake page id — no Meta call)
  const channel = await api('/api/channels', {
    method: 'POST',
    body: { platform: 'messenger', externalId: 'page-verify-1', displayName: 'Verify Page' },
  });
  check('connect messenger channel', channel.status === 201, `status=${channel.status}`);

  // 5. Go live (out of practice mode so the agent answers this customer)
  const live = await api(`/api/workspaces/${workspaceId}/go-live`, { method: 'POST' });
  check('go-live (practice mode off)', live.status === 200 && live.data?.workspace?.practice_mode === false, `status=${live.status}`);

  // 6. Two products
  const p1 = await api('/api/products', {
    method: 'POST',
    body: { name: 'শাড়ি', pricePaisa: 150000, size: 'M', stock: 5, description: 'সুতির শাড়ি — লাল' },
  });
  product1 = p1.data?.product ?? null;
  check('add product 1 (শাড়ি, ৳1500)', p1.status === 201 && product1?.price_paisa === 150000, `status=${p1.status}`);
  const p2 = await api('/api/products', {
    method: 'POST',
    body: { name: 'পাঞ্জাবি', pricePaisa: 120000, size: 'L', stock: 3, description: 'সুতির পাঞ্জাবি — সাদা' },
  });
  product2 = p2.data?.product ?? null;
  check('add product 2 (পাঞ্জাবি, ৳1200)', p2.status === 201 && product2?.price_paisa === 120000, `status=${p2.status}`);

  // 7. Knowledge item (delivery info)
  const kb = await api('/api/knowledge', {
    method: 'POST',
    body: { title: 'ডেলিভারি', body: 'ঢাকার ভেতরে ডেলিভারি চার্জ ৬০ টাকা, সময় ২-৩ দিন।' },
  });
  check('add knowledge item', kb.status === 201, `status=${kb.status}`);

  // 8. Incoming Messenger message via webhook
  const mid1 = `verify-mid-${stamp}-1`;
  const hook = await api('/api/webhooks/meta', {
    method: 'POST',
    auth: false,
    body: {
      object: 'page',
      entry: [
        {
          id: 'page-verify-1',
          messaging: [
            {
              sender: { id: 'cust-verify-1' },
              recipient: { id: 'page-verify-1' },
              message: { mid: mid1, text: 'শাড়ির দাম কত?' },
            },
          ],
        },
      ],
    },
  });
  check('webhook accepts Messenger message', hook.status === 200, `status=${hook.status}`);

  // 9. Wait for the AI reply (queue fallback: 3s debounce + processing)
  const detail = await waitFor(async () => {
    const list = await api('/api/inbox');
    const conv = list.data?.conversations?.[0];
    if (!conv) return null;
    const d = await api(`/api/inbox/${conv.id}`);
    const out = (d.data?.messages ?? []).filter((m) => m.direction === 'out');
    return out.length > 0 ? d.data : null;
  }, 30000, 'AI reply').catch((e) => {
    check('AI reply arrives', false, e.message);
    return null;
  });
  if (detail) {
    conversationId = detail.conversation.id;
    customerId = detail.customer?.id ?? '';
    const reply = (detail.messages ?? []).filter((m) => m.direction === 'out').map((m) => m.body ?? '').join('\n');
    check('AI reply arrives', true, `conv=${conversationId.slice(0, 8)}`);
    const outMsg = (detail.messages ?? []).filter((m) => m.direction === 'out')[0];
    // The verify channel has no Page token, so the reply cannot be
    // delivered to Meta — the row must honestly say so (delivery
    // 'failed'), not pretend it was sent.
    check('undelivered AI reply is marked failed (no Page token)', outMsg?.delivery_status === 'failed', `delivery_status=${outMsg?.delivery_status}, error=${outMsg?.delivery_error ?? ''}`);
    if (PROVIDER === 'groq') {
      // Real Groq reply: must NOT be the labelled demo fallback.
      check('real Groq reply (no demo label)', !reply.includes('[ডেমো AI'), reply.slice(0, 120));
    } else {
      check('demo reply is labelled (not real Gemini)', reply.includes('[ডেমো AI'), 'label missing');
    }
    check('AI reply uses real product price (৳1500)', reply.includes('1,500') || reply.includes('১৫০০') || reply.includes('1500'), reply.slice(0, 120));
    check('AI reply mentions শাড়ি', reply.includes('শাড়ি'), reply.slice(0, 120));
  }

  // 10. Billing: NO charge for an undelivered reply.
  // The verify channel has no Page token, so the AI reply cannot be
  // delivered to Meta (delivery_status='failed' above) — the shop must
  // not be charged for it: no ledger entry, balance stays 5000.
  const billing = await api('/api/billing');
  const usage = billing.data?.usage ?? [];
  check('no ledger entry for the undelivered AI reply', usage.length === 0, `entries=${usage.length}`);
  check('wallet balance stays 5000 (no charge for undelivered reply)', Number(billing.data?.balancePaisa) === 5000, `balance=${billing.data?.balancePaisa}`);

  // 11. Order intent via Messenger → agent asks for name/phone/address
  // (the system prompt requires those BEFORE create_order), then the
  // customer supplies them and the agent creates the order via its tool.
  async function sendCustomerMessage(mid, text) {
    await api('/api/webhooks/meta', {
      method: 'POST',
      auth: false,
      body: {
        object: 'page',
        entry: [
          {
            id: 'page-verify-1',
            messaging: [
              {
                sender: { id: 'cust-verify-1' },
                recipient: { id: 'page-verify-1' },
                message: { mid, text },
              },
            ],
          },
        ],
      },
    });
  }
  async function outCount() {
    const d = await api(`/api/inbox/${conversationId}`);
    return (d.data?.messages ?? []).filter((m) => m.direction === 'out').length;
  }
  const mid2 = `verify-mid-${stamp}-2`;
  await sendCustomerMessage(mid2, 'শাড়ি অর্ডার করতে চাই');
  const outBefore = await outCount();
  const askedForDetails = await waitFor(async () => {
    const n = await outCount();
    if (n <= outBefore) return null;
    const d = await api(`/api/inbox/${conversationId}`);
    const last = (d.data?.messages ?? []).filter((m) => m.direction === 'out').pop();
    return last?.body ?? null;
  }, 45000, 'agent asking for order details').catch(() => null);
  check(
    'agent asks for name/phone/address before ordering',
    typeof askedForDetails === 'string' && /ফোন|ঠিকানা/.test(askedForDetails),
    (askedForDetails ?? '').slice(0, 120),
  );
  const mid3 = `verify-mid-${stamp}-3`;
  await sendCustomerMessage(mid3, 'আমার নাম রহিম, ফোন 01712345678, ঠিকানা: ঢাকা, মিরপুর');
  const aiOrder = await waitFor(async () => {
    const list = await api('/api/orders');
    return (list.data?.orders ?? []).find((o) => o.source === 'ai' && Number(o.total_paisa) === 150000) ?? null;
  }, 60000, 'AI-created order').catch((e) => {
    check('agent creates order after details given', false, e.message);
    return null;
  });
  if (aiOrder) {
    orderId = aiOrder.id;
    check('agent creates order after details given', true, `order=${orderId.slice(0, 8)}, total=${aiOrder.total_paisa}`);
  }

  // 12. Order via API (team-created) + status flow pending → approved → processing
  const teamOrder = await api('/api/orders', {
    method: 'POST',
    body: { customerId, conversationId, items: [{ productId: product2.id, quantity: 2 }], source: 'team' },
  });
  check('create order via API (2 × পাঞ্জাবি = ৳2400)', teamOrder.status === 201 && Number(teamOrder.data?.order?.total_paisa) === 240000, `status=${teamOrder.status}, total=${teamOrder.data?.order?.total_paisa}`);
  const teamOrderId = teamOrder.data?.order?.id ?? '';
  const s1 = await api(`/api/orders/${teamOrderId}/status`, { method: 'PATCH', body: { status: 'approved' } });
  check('order status pending → approved', s1.status === 200 && s1.data?.order?.status === 'approved', `status=${s1.status}`);
  const s2 = await api(`/api/orders/${teamOrderId}/status`, { method: 'PATCH', body: { status: 'processing' } });
  check('order status approved → processing', s2.status === 200 && s2.data?.order?.status === 'processing', `status=${s2.status}`);
  const got = await api(`/api/orders/${teamOrderId}`);
  check('order detail has items + events', got.status === 200 && (got.data?.items ?? []).length === 1 && (got.data?.events ?? []).length >= 3, `items=${got.data?.items?.length}, events=${got.data?.events?.length}`);

  // 13. Ticket flow
  const ticket = await api('/api/tickets', {
    method: 'POST',
    body: { conversationId, customerId, reason: 'ডেমো টিকেট টেস্ট' },
  });
  const ticketId = ticket.data?.ticket?.id ?? '';
  check('create ticket', ticket.status === 201 && !!ticketId, `status=${ticket.status}`);
  const t2 = await api(`/api/tickets/${ticketId}`, { method: 'PATCH', body: { status: 'resolved' } });
  check('ticket resolved', t2.status === 200 && t2.data?.ticket?.status === 'resolved', `status=${t2.status}`);

  // 14. Duplicate webhook (same mid) must not duplicate the inbound message
  const before = await api(`/api/inbox/${conversationId}`);
  const beforeIn = (before.data?.messages ?? []).filter((m) => m.direction === 'in').length;
  await api('/api/webhooks/meta', {
    method: 'POST',
    auth: false,
    body: {
      object: 'page',
      entry: [
        {
          id: 'page-verify-1',
          messaging: [
            {
              sender: { id: 'cust-verify-1' },
              recipient: { id: 'page-verify-1' },
              message: { mid: mid1, text: 'শাড়ির দাম কত?' },
            },
          ],
        },
      ],
    },
  });
  const after = await api(`/api/inbox/${conversationId}`);
  const afterIn = (after.data?.messages ?? []).filter((m) => m.direction === 'in').length;
  check('duplicate webhook ignored (no duplicate message)', afterIn === beforeIn, `inbound before=${beforeIn}, after=${afterIn}`);

  // 15. Meta verification handshake
  const vtoken = verifyTokenFromEnv();
  if (vtoken) {
    const res = await fetch(`${API}/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(vtoken)}&hub.challenge=verify123`);
    const text = await res.text();
    check('Meta verify handshake', res.status === 200 && text === 'verify123', `status=${res.status}`);
  } else {
    check('Meta verify handshake', false, 'META_VERIFY_TOKEN not found in apps/api/.env');
  }

  // 16. Web app serves the login page
  try {
    const res = await fetch(`${WEB}/login`);
    check('web app serves /login', res.status === 200, `status=${res.status}`);
  } catch (e) {
    check('web app serves /login', false, e.message);
  }

  // =====================================================================
  // Phase 2/3 checks (locally runnable flows — no Meta approval needed).
  // =====================================================================
  const kbId = kb.data?.knowledgeItem?.id ?? '';
  const dhakaDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const dhakaMonth = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit' }).format(d);

  // 17. WhatsApp + TikTok channels are approval-gated (pending_approval)
  const wa = await api('/api/channels', { method: 'POST', body: { platform: 'whatsapp', externalId: 'wa-verify-1', displayName: 'Verify WhatsApp' } });
  check('WhatsApp channel is pending_approval (no approval yet)', wa.status === 201 && wa.data?.status === 'pending_approval' && wa.data?.approvalRequired === true, `status=${wa.status}, ${JSON.stringify(wa.data)}`);
  const tt = await api('/api/channels', { method: 'POST', body: { platform: 'tiktok', externalId: 'tt-verify-1', displayName: 'Verify TikTok' } });
  check('TikTok channel is pending_approval (no approval yet)', tt.status === 201 && tt.data?.status === 'pending_approval' && tt.data?.approvalRequired === true, `status=${tt.status}`);

  // 18. WhatsApp webhook verify handshake (falls back to META_VERIFY_TOKEN)
  if (vtoken) {
    const res = await fetch(`${API}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(vtoken)}&hub.challenge=verify-wa`);
    const text = await res.text();
    check('WhatsApp verify handshake', res.status === 200 && text === 'verify-wa', `status=${res.status}`);
  } else {
    check('WhatsApp verify handshake', false, 'META_VERIFY_TOKEN not found in apps/api/.env');
  }

  // 19. Coupons: percent / amount / free delivery + apply to the AI order
  const c1 = await api('/api/coupons', { method: 'POST', body: { code: 'EID10', type: 'percent', value: 10 } });
  check('create percent coupon EID10 (10%)', c1.status === 201 && !!c1.data?.coupon?.id, `status=${c1.status}`);
  const v1 = await api('/api/coupons/validate', { method: 'POST', body: { code: 'EID10', subtotalPaisa: 150000 } });
  check('validate EID10 on ৳1500 → ৳150 off', v1.status === 200 && v1.data?.valid === true && Number(v1.data?.discountPaisa) === 15000, `discount=${v1.data?.discountPaisa}`);
  const c2 = await api('/api/coupons', { method: 'POST', body: { code: 'TK50', type: 'amount', value: 5000 } });
  const v2 = await api('/api/coupons/validate', { method: 'POST', body: { code: 'TK50', subtotalPaisa: 150000 } });
  check('validate amount coupon TK50 (৳50) → 5000 paisa off', c2.status === 201 && v2.data?.valid === true && Number(v2.data?.discountPaisa) === 5000, `discount=${v2.data?.discountPaisa}`);
  const c3 = await api('/api/coupons', { method: 'POST', body: { code: 'FREEDEL', type: 'free_delivery', value: 0 } });
  const v3 = await api('/api/coupons/validate', { method: 'POST', body: { code: 'FREEDEL', subtotalPaisa: 150000 } });
  check('validate free-delivery coupon → freeDelivery true', c3.status === 201 && v3.data?.valid === true && v3.data?.freeDelivery === true, `freeDelivery=${v3.data?.freeDelivery}`);
  const applied = await api(`/api/orders/${orderId}/apply-coupon`, { method: 'POST', body: { code: 'EID10' } });
  check('apply EID10 to AI order (৳1500 → ৳1350)', applied.status === 200 && Number(applied.data?.order?.total_paisa) === 135000 && Number(applied.data?.order?.discount_paisa) === 15000, `total=${applied.data?.order?.total_paisa}`);

  // 20. Stock: AI order decremented শাড়ি 5→4, team order decremented পাঞ্জাবি 3→1
  const prodList = await api('/api/products');
  const sari = (prodList.data?.products ?? []).find((p) => p.name === 'শাড়ি');
  const panjabi = (prodList.data?.products ?? []).find((p) => p.name === 'পাঞ্জাবি');
  check('AI order decremented stock (শাড়ি 5 → 4)', Number(sari?.stock) === 4, `stock=${sari?.stock}`);
  check('team order decremented stock (পাঞ্জাবি 3 → 1)', Number(panjabi?.stock) === 1, `stock=${panjabi?.stock}`);
  const low = await api('/api/products/low-stock?threshold=2');
  const lowNames = (low.data?.products ?? []).map((p) => p.name);
  check('low-stock list (threshold 2) shows পাঞ্জাবি, not শাড়ি', lowNames.includes('পাঞ্জাবি') && !lowNames.includes('শাড়ি'), `low=${lowNames.join(',')}`);
  const adj = await api(`/api/products/${panjabi?.id}/adjust-stock`, { method: 'POST', body: { delta: 2, reason: 'verify restock' } });
  check('adjust-stock পাঞ্জাবি +2 → stock 3', adj.status === 200 && (Number(adj.data?.product?.stock) === 3 || Number(adj.data?.stock) === 3), `status=${adj.status}, stock=${adj.data?.product?.stock ?? adj.data?.stock}`);

  // 21. Customers: list + profile + merge (second customer via webhook)
  const custList = await api('/api/customers');
  check('customers list contains the verify customer', (custList.data?.customers ?? []).some((c) => c.id === customerId), `count=${(custList.data?.customers ?? []).length}`);
  const custProfile = await api(`/api/customers/${customerId}`);
  check('customer profile loads', custProfile.status === 200 && !!custProfile.data?.customer, `status=${custProfile.status}`);
  await api('/api/webhooks/meta', {
    method: 'POST', auth: false,
    body: { object: 'page', entry: [{ id: 'page-verify-1', messaging: [{ sender: { id: 'cust-verify-2' }, recipient: { id: 'page-verify-1' }, message: { mid: `verify-mid-${stamp}-4`, text: 'পাঞ্জাবির দাম কত?' } }] }] },
  });
  const second = await waitFor(async () => {
    const list = await api('/api/inbox');
    const convs = list.data?.conversations ?? [];
    if (convs.length < 2) return null;
    const other = convs.find((c) => c.id !== conversationId);
    if (!other) return null;
    const d = await api(`/api/inbox/${other.id}`);
    return d.data?.customer?.id ?? null;
  }, 20000, 'second customer').catch(() => null);
  if (second) {
    const merged = await api('/api/customers/merge', { method: 'POST', body: { keepCustomerId: customerId, mergeCustomerId: second } });
    check('merge second customer into first', merged.status === 200 && !!merged.data?.customer, `status=${merged.status}`);
  } else {
    check('merge second customer into first', false, 'second customer not found');
  }

  // 22. Scheduled posts: draft → schedule → calendar → publish-now → comment carousel
  const sp = await api('/api/scheduled-posts', {
    method: 'POST',
    body: { caption: 'ঈদ অফার! শাড়ি মাত্র ৳১৫০০', platforms: ['facebook'], productIds: [product1.id] },
  });
  const postId = sp.data?.post?.id ?? '';
  check('create scheduled post (draft)', sp.status === 201 && sp.data?.post?.status === 'draft', `status=${sp.status}, ${sp.data?.post?.status}`);
  const future = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const sched = await api(`/api/scheduled-posts/${postId}/schedule`, { method: 'POST', body: { scheduledAt: future } });
  check('schedule post (+2h)', sched.status === 200 && sched.data?.post?.status === 'scheduled', `status=${sched.status}`);
  const cal = await api(`/api/scheduled-posts/calendar?month=${dhakaMonth(new Date(future))}`);
  const calHas = Object.values(cal.data?.days ?? {}).flat().some((p) => p.id === postId);
  check('calendar view contains the scheduled post', cal.status === 200 && calHas, `month=${cal.data?.month}`);
  const pub = await api(`/api/scheduled-posts/${postId}/publish-now`, { method: 'POST' });
  const platformPostId = pub.data?.post?.platform_post_id ?? '';
  check('publish-now → published (stub platform id)', pub.status === 200 && pub.data?.post?.status === 'published' && String(platformPostId).startsWith('stub-'), `status=${pub.data?.post?.status}, platform_post_id=${platformPostId}`);
  const carousel = await api(`/api/comments/${encodeURIComponent(platformPostId)}/carousel`);
  check('comment carousel shows the linked শাড়ি card', carousel.status === 200 && (carousel.data?.cards ?? []).some((c) => c.name === 'শাড়ি'), `cards=${(carousel.data?.cards ?? []).map((c) => c.name).join(',')}`);

  // 23. Leads + follow-ups (call time + send-now)
  const tomorrow17 = new Date(Date.now() + 24 * 60 * 60 * 1000);
  tomorrow17.setHours(17, 0, 0, 0);
  const lead = await api('/api/leads', { method: 'POST', body: { customerId, need: 'শাড়ি কিনতে চায়', callAt: tomorrow17.toISOString() } });
  const leadId = lead.data?.lead?.id ?? '';
  check('create lead with call time (tomorrow 17:00)', lead.status === 201 && !!leadId && !!lead.data?.lead?.call_at, `status=${lead.status}`);
  const fu = await api('/api/followups', {
    method: 'POST',
    body: { leadId, message: 'শাড়িটি এখনো স্টকে আছে, অর্ডার করতে চান?', sendAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
  });
  const fuId = fu.data?.followup?.id ?? '';
  check('create follow-up (+1h)', fu.status === 201 && !!fuId, `status=${fu.status}`);
  const sent = await api(`/api/followups/${fuId}/send-now`, { method: 'POST' });
  check('send-now delivers the follow-up', sent.status === 200 && sent.data?.followup?.status === 'sent' && sent.data?.stopped === false, `status=${sent.data?.followup?.status}`);

  // 24. Analytics overview + posts + lost sales
  const ov = await api('/api/analytics/overview?range=today');
  check(
    'analytics overview (today) has conversations/orders/AI %',
    ov.status === 200 && Number(ov.data?.conversations) >= 1 && Number(ov.data?.orders) >= 2 && typeof ov.data?.aiHandledPct === 'number' && typeof ov.data?.humanHandoverCount === 'number',
    `conversations=${ov.data?.conversations}, orders=${ov.data?.orders}, aiHandledPct=${ov.data?.aiHandledPct}`,
  );
  const ap = await api('/api/analytics/posts');
  check('analytics posts loads', ap.status === 200 && Array.isArray(ap.data?.posts), `posts=${(ap.data?.posts ?? []).length}`);
  const ls = await api('/api/analytics/lost-sales');
  check('lost-sales analytics loads', ls.status === 200 && Array.isArray(ls.data?.reasons), `total=${ls.data?.total}`);

  // 25. AI teaching tools: unanswered list + knowledge preview/apply/rollback
  const un = await api('/api/unanswered');
  check('unanswered-questions list loads', un.status === 200 && Array.isArray(un.data?.unanswered), `count=${(un.data?.unanswered ?? []).length}`);
  const firstUn = (un.data?.unanswered ?? [])[0];
  if (firstUn) {
    const taught = await api(`/api/unanswered/${firstUn.id}/teach`, { method: 'POST', body: { answer: 'এই প্রশ্নের উত্তর শেখানো হয়েছে।' } });
    check('teach answer for an unanswered question', taught.status === 200 || taught.status === 201, `status=${taught.status}`);
  } else {
    check('teach answer (no unanswered questions yet)', true, 'nothing to teach — endpoint OK');
  }
  if (kbId) {
    const prev = await api('/api/knowledge/preview-change', { method: 'POST', body: { knowledgeId: kbId, instruction: 'ডেলিভারি চার্জ ৮০ টাকা লিখো' } });
    check('knowledge preview-change returns a preview', prev.status === 200 && typeof prev.data?.preview === 'string' && prev.data.preview.length > 0, `preview=${(prev.data?.preview ?? '').slice(0, 60)}`);
    const applied2 = await api('/api/knowledge/apply-change', { method: 'POST', body: { knowledgeId: kbId, newBody: 'ঢাকার ভেতরে ডেলিভারি চার্জ ৮০ টাকা, সময় ২-৩ দিন।' } });
    const versionId = applied2.data?.versionId ?? '';
    const kbAfter = await api('/api/knowledge');
    const changed = (kbAfter.data?.knowledgeItems ?? []).find((k) => k.id === kbId);
    check('knowledge apply-change saves the new body', applied2.status === 200 && !!versionId && changed?.body?.includes('৮০ টাকা'), `status=${applied2.status}`);
    const rolled = await api(`/api/knowledge/${kbId}/rollback`, { method: 'POST', body: { versionId } });
    const kbBack = await api('/api/knowledge');
    const restored = (kbBack.data?.knowledgeItems ?? []).find((k) => k.id === kbId);
    check('knowledge rollback restores the old body', rolled.status === 200 && restored?.body?.includes('৬০ টাকা'), `body=${(restored?.body ?? '').slice(0, 40)}`);
  } else {
    check('knowledge preview/apply/rollback', false, 'knowledge item id missing');
  }

  // 26. Offer broadcast (24h window) — the verify customer messaged minutes ago
  const bc = await api('/api/broadcasts', { method: 'POST', body: { title: 'ঈদ অফার', message: 'শাড়িতে ১০% ছাড়!', couponCode: 'EID10' } });
  const bcId = bc.data?.broadcast?.id ?? '';
  check('create broadcast (draft)', bc.status === 201 && !!bcId, `status=${bc.status}`);
  const bcs = await api(`/api/broadcasts/${bcId}/send`, { method: 'POST' });
  check('broadcast sends within the 24h window', bcs.status === 200 && Number(bcs.data?.sent) >= 1, `sent=${bcs.data?.sent}, skipped=${bcs.data?.skipped}`);

  // 27. Receptionist mode: booking + day-before reminder
  const tomorrowDate = dhakaDate(new Date(Date.now() + 24 * 60 * 60 * 1000));
  const bk = await api('/api/bookings', {
    method: 'POST',
    body: { customerId, service: 'ফেসিয়াল', date: tomorrowDate, time: '17:00', advanceTxId: 'TX-VERIFY-1', advancePaisa: 50000 },
  });
  const bkId = bk.data?.booking?.id ?? '';
  check('create booking for tomorrow', bk.status === 201 && !!bkId, `status=${bk.status}`);
  const bkc = await api(`/api/bookings/${bkId}`, { method: 'PATCH', body: { status: 'confirmed' } });
  check('confirm booking', bkc.status === 200 && bkc.data?.booking?.status === 'confirmed', `status=${bkc.data?.booking?.status}`);
  const due = await api('/api/bookings/reminders-due');
  check('reminders-due lists tomorrow’s booking', due.status === 200 && (due.data?.bookings ?? []).some((b) => b.id === bkId), `due=${(due.data?.bookings ?? []).length}`);
  const rem = await api(`/api/bookings/${bkId}/remind`, { method: 'POST' });
  check('day-before reminder sent', rem.status === 200 && rem.data?.booking?.reminder_sent === true, `reminder_sent=${rem.data?.booking?.reminder_sent}`);

  // 28. Review request after delivery + review list
  const rr = await api(`/api/orders/${orderId}/request-review`, { method: 'POST' });
  check('request review for the AI order', rr.status === 201 && !!rr.data?.reviewRequest?.id, `status=${rr.status}`);
  const rv = await api('/api/reviews');
  check('reviews list contains the request', rv.status === 200 && (rv.data?.reviews ?? []).some((r) => r.order_id === orderId), `count=${(rv.data?.reviews ?? []).length}`);

  // 29. Data migration: import 1 product via CSV
  const mig = await api('/api/migration/import', {
    method: 'POST',
    body: { type: 'products', csv: 'name,price_paisa,size,stock,description\nটেস্ট শার্ট,50000,M,10,সুতির শার্ট' },
  });
  check('CSV import adds 1 product', mig.status === 200 && Number(mig.data?.imported) === 1 && Number(mig.data?.failed) === 0, `imported=${mig.data?.imported}, failed=${mig.data?.failed}`);
  const migList = await api('/api/migration/imports');
  check('migration imports list loads', migList.status === 200 && (migList.data?.imports ?? []).length >= 1, `count=${(migList.data?.imports ?? []).length}`);

  // 30. In-app feature request
  const fr = await api('/api/feature-requests', { method: 'POST', body: { title: 'WhatsApp বাটন চাই', description: 'ইনবক্সে WhatsApp চ্যাট বাটন দরকার।' } });
  const frId = fr.data?.featureRequest?.id ?? '';
  check('create feature request', fr.status === 201 && !!frId, `status=${fr.status}`);
  const fr2 = await api(`/api/feature-requests/${frId}`, { method: 'PATCH', body: { status: 'in_progress' } });
  check('feature request status → in_progress', fr2.status === 200 && fr2.data?.featureRequest?.status === 'in_progress', `status=${fr2.data?.featureRequest?.status}`);

  // 31. New web pages serve
  try {
    const res = await fetch(`${WEB}/coupons`);
    check('web app serves /coupons', res.status === 200, `status=${res.status}`);
  } catch (e) {
    check('web app serves /coupons', false, e.message);
  }

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
