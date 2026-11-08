// Verifier: bell cancel-request actions + website-side cancel notification (2026-11-08).
// - Bell: a cancel-request notification shows "Cancel Order" + "Open Chat".
// - Approve (the bell's Cancel Order) cancels the order + tells the customer.
// - Manual PATCH /api/orders/:id/status to 'cancelled' also tells the customer.
// - Setting an already-cancelled order to 'cancelled' again sends NO duplicate.
// Live checks use TEST orders (ASI-0009/ASI-0010) for a test customer "Bell Test"
// in gd_arafat, with the "কে আমি" test conversation — the two cancel messages
// are real Graph sends to the user's own test account. All test rows are
// deleted afterwards; the order counter is left at 10 (ASI-0009/0010 were
// test numbers and are never reused).
import fs from 'node:fs';
import jwt from '../apps/api/node_modules/jsonwebtoken/index.js';
import pkg from '/home/hatch/workspace/.tools/node_modules/@neondatabase/serverless/index.js';
const { neon } = pkg;

const WEB = '/home/hatch/workspace/ai-sales-inbox/apps/web';
const API = 'https://ai-sales-inbox-api.vercel.app';
const WS = '2683f2fd-b8d4-4480-b8b7-ac126ca37a28'; // gd_arafat
const CONV = 'e62792ec-4361-4258-bff7-150049450287'; // "কে আমি" test conversation
const TSHIRT = 'f50d55af-6aa9-4660-802d-db9772ae574e'; // T-shirt, ৳400, stock 8

let pass = 0, fail = 0;
function check(name, ok, detail = '') { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; }

function parseEnvFile(file) {
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[t.slice(0, eq).trim()] = v;
  }
  return env;
}
const sql = neon(parseEnvFile('/home/hatch/workspace/ai-sales-inbox/.env.local').DATABASE_URL);
const apiEnv = fs.readFileSync('/home/hatch/workspace/ai-sales-inbox/apps/api/.env', 'utf8');
const secret = apiEnv.match(/^JWT_SECRET=(.+)$/m)[1].trim();
const token = jwt.sign({ userId: 'b0d895c5-836c-46c4-9822-b6b8049dacc0', workspaceId: WS, isOwner: false }, secret, { expiresIn: '10m' });
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
async function apiJson(path, opts = {}) {
  const res = await fetch(`${API}${path}`, { headers: H, ...opts });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text };
}

// ---------- (1) Source checks ----------
const shell = fs.readFileSync(`${WEB}/components/AppShell.tsx`, 'utf8');
const notifRoutes = fs.readFileSync('/home/hatch/workspace/ai-sales-inbox/apps/api/src/notifications/routes.ts', 'utf8');
const orderRoutes = fs.readFileSync('/home/hatch/workspace/ai-sales-inbox/apps/api/src/orders/routes.ts', 'utf8');
check('bell: BellNotification has cancel_request_id + order_id', shell.includes('cancel_request_id: string | null') && shell.includes('order_id: string | null'));
check('bell: Cancel Order button calls the approve endpoint', shell.includes("`/api/orders/cancel-requests/${n.cancel_request_id}/approve`"));
check('bell: Open Chat button present', shell.includes('header.openChat') && shell.includes('"Open Chat"'));
check('bell: buttons only for cancel_request with a pending request', shell.includes('n.type === "cancel_request" && !!n.cancel_request_id'));
check('bell: approve marks read + clears Cancel button + shows Cancelled', shell.includes('cancel_request_id: null') && shell.includes('header.orderCancelled'));
check('bell: 409 also clears the Cancel button (nothing left to approve)', shell.includes('status === 409'));
check('bell: Cancel button disabled while approving (no double tap)', shell.includes('cancellingIds'));
check('api: notifications SELECT returns cancel_request_id via pending-request join', notifRoutes.includes('cancel_request_id') && notifRoutes.includes("cr.status = 'pending'") && notifRoutes.includes("n.type = 'cancel_request'"));
check('api: manual status change notifies the customer when cancelled', orderRoutes.includes('ক্যান্সেল করা হয়েছে') && orderRoutes.includes('cancelNotified') && orderRoutes.includes("status !== 'cancelled'"));
check('api: manual status change only notifies on an actual transition to cancelled', orderRoutes.includes("if (order.status === status)") && orderRoutes.includes('cancelNotifyError'));

// ---------- (2) Live checks ----------
let custId = null, order1 = null, order2 = null, req1 = null, notif1 = null;
let orderNum1 = null, orderNum2 = null;
try {
  // (a) The existing ASI-0006 notification now carries the pending request id.
  const list0 = await apiJson('/api/notifications?limit=20');
  check('live: GET /api/notifications returns 200', list0.status === 200);
  const asi6 = (list0.json?.notifications ?? []).find((n) => n.order_id === 'a3ecf2e8-711f-4725-a096-1f1bc15f9150');
  check('live: ASI-0006 cancel-request notification carries cancel_request_id', !!asi6 && asi6.cancel_request_id === 'b37313f0-418c-4bc0-ae5e-8175cdf31616' && asi6.type === 'cancel_request', asi6 ? `cancel_request_id=${asi6.cancel_request_id}` : 'notification missing');
  const nonCancel = (list0.json?.notifications ?? []).find((n) => n.type !== 'cancel_request');
  check('live: non-cancel notifications have no cancel_request_id', !nonCancel || nonCancel.cancel_request_id == null, nonCancel ? `type=${nonCancel.type}` : 'no non-cancel notification present');

  // (b) Test customer + test order #1 (real POST /api/orders path).
  const c = await sql.query(`INSERT INTO customers (workspace_id, name, gender, phone, address) VALUES ($1, 'Bell Test', 'unknown', '01712345678', 'বাসা ১, রোড ২, ধানমন্ডি, ঢাকা') RETURNING id`, [WS]);
  custId = c[0].id;
  const o1 = await apiJson('/api/orders', {
    method: 'POST',
    body: JSON.stringify({ customerId: custId, conversationId: CONV, items: [{ productId: TSHIRT, quantity: 1 }], customerPhone: '01712345678', deliveryAddress: 'বাসা ১, রোড ২, ধানমন্ডি, ঢাকা' }),
  });
  check('live: test order #1 created via POST /api/orders', o1.status === 201, `HTTP ${o1.status}`);
  order1 = o1.json?.order?.id ?? o1.json?.id;
  orderNum1 = o1.json?.orderNumber ?? o1.json?.order?.order_number;
  check('live: test order #1 is pending', !!order1 && (o1.json?.order?.status === 'pending' || o1.json?.status === 'pending'), `order=${orderNum1}`);
  // Pending cancel request + notification for order #1 (mirrors requestOrderCancellation).
  const r1 = await sql.query(`INSERT INTO order_cancel_requests (workspace_id, order_id, customer_id, conversation_id, reason, status) VALUES ($1, $2, $3, $4, 'bell test', 'pending') RETURNING id`, [WS, order1, custId, CONV]);
  req1 = r1[0].id;
  const n1 = await sql.query(`INSERT INTO notifications (workspace_id, type, title, body, conversation_id, customer_id, order_id) VALUES ($1, 'cancel_request', 'অর্ডার ক্যান্সেলের অনুরোধ', $2, $3, $4, $5) RETURNING id`, [WS, `Bell Test (অর্ডার ${orderNum1}) অর্ডারটি ক্যান্সেল করতে চাচ্ছেন — অনুমোদন করলে ক্যান্সেল হবে।`, CONV, custId, order1]);
  notif1 = n1[0].id;
  const list1 = await apiJson('/api/notifications?limit=20');
  const tn1 = (list1.json?.notifications ?? []).find((n) => n.order_id === order1);
  check('live: test cancel-request notification carries its cancel_request_id', !!tn1 && tn1.cancel_request_id === req1 && tn1.type === 'cancel_request', tn1 ? `cancel_request_id=${tn1.cancel_request_id}` : 'test notification missing');

  // (c) Approve via the bell's endpoint (the "Cancel Order" button path).
  const ap = await apiJson(`/api/orders/cancel-requests/${req1}/approve`, { method: 'POST' });
  check('live: approve returns 200 + order cancelled', ap.status === 200 && ap.json?.order?.status === 'cancelled', `HTTP ${ap.status} status=${ap.json?.order?.status}`);
  check('live: approve tells the customer (sent, or an honest send error)', ap.json && (ap.json.sent === true || typeof ap.json.sendError === 'string'), `sent=${ap.json?.sent} sendError=${ap.json?.sendError}`);
  const msg1 = await sql.query(`SELECT id, delivery_status FROM messages WHERE workspace_id=$1 AND conversation_id=$2 AND body LIKE $3 ORDER BY created_at DESC LIMIT 1`, [WS, CONV, `%${orderNum1}%ক্যান্সেল করা হয়েছে%`]);
  check('live: customer message row exists for the approved cancellation', msg1.length === 1, msg1[0] ? `delivery_status=${msg1[0].delivery_status}` : 'no message row');
  const list2 = await apiJson('/api/notifications?limit=20');
  const tn1b = (list2.json?.notifications ?? []).find((n) => n.order_id === order1);
  check('live: after approve, the notification no longer has a cancel_request_id (button goes away)', !!tn1b && tn1b.cancel_request_id == null, tn1b ? `cancel_request_id=${tn1b.cancel_request_id}` : 'notification missing');

  // (d) Manual status change to 'cancelled' (the Orders-page path) notifies the customer.
  const o2 = await apiJson('/api/orders', {
    method: 'POST',
    body: JSON.stringify({ customerId: custId, conversationId: CONV, items: [{ productId: TSHIRT, quantity: 1 }], customerPhone: '01712345678', deliveryAddress: 'বাসা ১, রোড ২, ধানমন্ডি, ঢাকা' }),
  });
  check('live: test order #2 created via POST /api/orders', o2.status === 201, `HTTP ${o2.status}`);
  order2 = o2.json?.order?.id ?? o2.json?.id;
  orderNum2 = o2.json?.orderNumber ?? o2.json?.order?.order_number;
  const st = await apiJson(`/api/orders/${order2}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }) });
  check('live: manual PATCH to cancelled returns 200 + order cancelled', st.status === 200 && (st.json?.order?.status === 'cancelled'), `HTTP ${st.status} status=${st.json?.order?.status}`);
  check('live: manual cancel reports cancelNotified (or an honest notify error)', st.json && (st.json.cancelNotified === true || typeof st.json.cancelNotifyError === 'string'), `cancelNotified=${st.json?.cancelNotified} cancelNotifyError=${st.json?.cancelNotifyError}`);
  const msg2 = await sql.query(`SELECT id, delivery_status FROM messages WHERE workspace_id=$1 AND conversation_id=$2 AND body LIKE $3 ORDER BY created_at DESC LIMIT 1`, [WS, CONV, `%${orderNum2}%ক্যান্সেল করা হয়েছে%`]);
  check('live: customer message row exists for the manual cancellation', msg2.length === 1, msg2[0] ? `delivery_status=${msg2[0].delivery_status}` : 'no message row');
  // (e) Setting the same order to 'cancelled' again sends NO duplicate.
  const st2 = await apiJson(`/api/orders/${order2}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }) });
  check('live: re-setting an already-cancelled order returns 200 with NO cancelNotified field', st2.status === 200 && st2.json && !('cancelNotified' in st2.json), `HTTP ${st2.status}`);
  const msg2count = await sql.query(`SELECT COUNT(*)::text AS n FROM messages WHERE workspace_id=$1 AND conversation_id=$2 AND body LIKE $3`, [WS, CONV, `%${orderNum2}%ক্যান্সেল করা হয়েছে%`]);
  check('live: no duplicate cancel message for the re-set', msg2count[0]?.n === '1', `count=${msg2count[0]?.n}`);
} finally {
  // ---------- cleanup (test rows only) ----------
  try {
    if (orderNum1 || orderNum2) {
      await sql.query(`DELETE FROM messages WHERE workspace_id=$1 AND conversation_id=$2 AND (body LIKE $3 OR body LIKE $4)`, [WS, CONV, `%${orderNum1 ?? '___none___'}%`, `%${orderNum2 ?? '___none___'}%`]);
    }
    if (order1 || order2) {
      const ids = [order1, order2].filter(Boolean);
      for (const oid of ids) {
        await sql.query(`DELETE FROM order_events WHERE workspace_id=$1 AND order_id=$2`, [WS, oid]);
        await sql.query(`DELETE FROM order_items WHERE workspace_id=$1 AND order_id=$2`, [WS, oid]);
        await sql.query(`DELETE FROM order_cancel_requests WHERE workspace_id=$1 AND order_id=$2`, [WS, oid]);
        await sql.query(`DELETE FROM notifications WHERE workspace_id=$1 AND order_id=$2`, [WS, oid]);
        await sql.query(`DELETE FROM orders WHERE workspace_id=$1 AND id=$2`, [WS, oid]);
      }
      await sql.query(`UPDATE products SET stock = stock + 2 WHERE workspace_id=$1 AND id=$2`, [WS, TSHIRT]);
    }
    if (custId) await sql.query(`DELETE FROM customers WHERE workspace_id=$1 AND id=$2`, [WS, custId]);
    console.log(`cleanup done (orders ${orderNum1}, ${orderNum2}; customer removed; T-shirt stock restored +2)`);
  } catch (e) {
    console.log('CLEANUP FAILED:', e.message);
    fail++;
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
