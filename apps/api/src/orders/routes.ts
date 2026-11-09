import { Router, type Response } from 'express';
import { pool, query, queryOne } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';
import { config } from '../config';
import { buildBillText, buildConfirmationText, type BillLine } from './bill';
import { resolveOrderContact } from './contact';
import { decrementStockForOrderItems } from '../products/stock';
import { linkOrderToAttribution } from '../analytics/attribution';
import { deliveryEstimateText, newInvoiceToken, nextOrderNumber, zoneOfAddress } from './order-helpers';
import { getDeliveryChargeRules, resolveDeliveryCharge } from '../delivery-charges/service';
import { bookCourierForOrder } from '../courier/book';
import { CourierValidationError, ProviderNotConfiguredError } from '../courier/provider';
import { deliverOutgoingMessage } from '../channels/meta-send';

export const ordersRouter = Router();
ordersRouter.use(requireAuth);

/**
 * Order statuses (order management, 2026-11-08). The user picks ANY of
 * these manually in the detail panel — the old forward-only transition
 * rule (pending → approved → ... → delivered) is retired: an owner must
 * be able to hold, cancel, return, mark damaged or move an order back.
 * - pending: new order, waiting. on_hold: held. approved: confirmed.
 * - processing: being prepared. ready: ready (being readied).
 * - ready_to_ship: packed, ready to ship. in_transit: with the courier.
 * - delivered / cancelled / returned / damaged: end states.
 * - in_store: kept at the store (not shipped).
 */
export const ORDER_STATUSES = [
  'pending', 'on_hold', 'approved', 'processing', 'ready', 'ready_to_ship',
  'in_transit', 'delivered', 'cancelled', 'returned', 'damaged', 'in_store',
] as const;

export const PAYMENT_METHODS = ['cod', 'advance', 'fifty_fifty'] as const;

interface OrderItemInput {
  productId?: string;
  quantity?: number;
}

const ORDER_COLUMNS = `o.id, o.order_number, o.customer_id, o.conversation_id, o.source, o.status, o.payment_status,
  o.payment_method, o.total_paisa, o.delivery_charge_paisa, o.handled_by, o.invoice_token, o.receipt_image_url, o.created_at,
  o.customer_name, o.customer_phone, o.delivery_address`;

function invoiceUrlFor(token: string | null | undefined): string | null {
  return token ? `${config.webAppUrl.replace(/\/$/, '')}/invoice/${token}` : null;
}

/**
 * POST /api/orders {customerId, conversationId, items:[{productId, quantity}], source,
 *   customerName, customerPhone, deliveryAddress, paymentMethod}
 * Prices are taken ONLY from the products table — never from the request.
 * Delivery contact is REQUIRED, same rule as the AI create_order tool: the
 * order is refused (400) when the phone or the delivery address is missing
 * — the team must ask the customer first, never create a contact-less
 * order. Given contact is stored on the customer row AND snapshotted onto
 * the order (orders.customer_name / customer_phone / delivery_address).
 * An order number (ASI-0001, ...) and an invoice token are created
 * automatically; the delivery charge is resolved from the owner's
 * configured rules and snapshotted onto the order.
 */
ordersRouter.post('/', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { customerId, conversationId, items, source, customerName, customerPhone, deliveryAddress, name, phone, address, paymentMethod } = (req.body ?? {}) as {
    customerId?: string;
    conversationId?: string;
    items?: OrderItemInput[];
    source?: string;
    customerName?: string;
    customerPhone?: string;
    deliveryAddress?: string;
    name?: string;
    phone?: string;
    address?: string;
    paymentMethod?: string;
  };
  if (!customerId || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'customerId and at least one item are required' });
    return;
  }
  const method = PAYMENT_METHODS.includes(paymentMethod as never) ? (paymentMethod as 'cod' | 'advance' | 'fifty_fifty') : 'cod';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const customer = await client.query(
      'SELECT id FROM customers WHERE workspace_id = $1 AND id = $2',
      [workspaceId, customerId],
    );
    if (customer.rowCount === 0) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: 'Customer not found in this workspace' });
      return;
    }
    // Who is this order for? Same refusal as the AI tool — no phone or no
    // delivery address, no order. The team must ask the customer first.
    const txDb = {
      query: async <T,>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> => {
        const r = await client.query(text, params as never[]);
        return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
      },
    };
    const { contact, error, missingPhone, missingAddress } = await resolveOrderContact(
      txDb,
      workspaceId,
      customerId,
      { customerName, customerPhone, deliveryAddress, name, phone, address },
    );
    if (!contact) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: error ?? 'Phone number and delivery address are required', missingPhone: missingPhone ?? false, missingAddress: missingAddress ?? false });
      return;
    }
    let totalPaisa = 0;
    const lines: BillLine[] = [];
    const pricedItems: { productId: string; quantity: number; pricePaisa: number }[] = [];
    for (const item of items) {
      const quantity = Math.max(1, Math.floor(item.quantity ?? 1));
      const product = await client.query(
        'SELECT id, name, price_paisa, stock FROM products WHERE workspace_id = $1 AND id = $2',
        [workspaceId, item.productId],
      );
      if (product.rowCount === 0) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: `Product not found: ${item.productId}` });
        return;
      }
      const p = product.rows[0];
      totalPaisa += Number(p.price_paisa) * quantity;
      lines.push({ name: p.name as string, quantity, pricePaisa: Number(p.price_paisa) });
      pricedItems.push({ productId: p.id as string, quantity, pricePaisa: Number(p.price_paisa) });
    }
    // Auto order number + invoice token + delivery charge (owner's rules).
    const orderNumber = await nextOrderNumber(txDb, workspaceId);
    const invoiceToken = newInvoiceToken();
    const chargeRules = await getDeliveryChargeRules(txDb, workspaceId);
    const { chargePaisa: deliveryChargePaisa } = resolveDeliveryCharge(chargeRules, contact.deliveryAddress);
    const order = await client.query(
      `INSERT INTO orders (workspace_id, customer_id, conversation_id, source, status, payment_status, payment_method,
                          total_paisa, delivery_charge_paisa, handled_by, order_number, invoice_token,
                          customer_name, customer_phone, delivery_address)
       VALUES ($1, $2, $3, $4, 'pending', 'unpaid', $5, $6, $7, 'agent', $8, $9, $10, $11, $12)
       RETURNING id, order_number, status, payment_status, payment_method, total_paisa, delivery_charge_paisa, invoice_token, customer_name, customer_phone, delivery_address`,
      [workspaceId, customerId, conversationId ?? null, source ?? 'team', method, totalPaisa, deliveryChargePaisa, orderNumber, invoiceToken, contact.customerName, contact.customerPhone, contact.deliveryAddress],
    );
    const orderId = order.rows[0].id as string;
    // Post attribution (05-post-attribution.sql): if this order comes from
    // a conversation that started as a comment on a scheduled post, stamp
    // order_id onto that attribution row so per-post analytics counts it.
    // Same transaction, so the order and its attribution never disagree.
    // A failure here must not fail the order — it is logged, and the
    // analytics endpoint also counts orders via orders.conversation_id.
    try {
      await linkOrderToAttribution(
        {
          query: async <T,>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> => {
            const r = await client.query(text, params as never[]);
            return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
          },
        },
        workspaceId,
        orderId,
        conversationId ?? null,
      );
    } catch (err) {
      console.error('[orders/create] post attribution link failed:', (err as Error).message);
    }
    for (const item of pricedItems) {
      await client.query(
        'INSERT INTO order_items (workspace_id, order_id, product_id, quantity, price_paisa) VALUES ($1, $2, $3, $4, $5)',
        [workspaceId, orderId, item.productId, item.quantity, item.pricePaisa],
      );
    }
    await client.query(
      "INSERT INTO order_events (workspace_id, order_id, from_status, to_status, note) VALUES ($1, $2, NULL, 'pending', 'Order created')",
      [workspaceId, orderId],
    );
    // Phase 2: decrement stock for the ordered items (same transaction).
    // Products that hit 0 get a team note + an order_events note (Bengali).
    const outOfStock = await decrementStockForOrderItems(txDb, workspaceId, orderId);
    for (const product of outOfStock) {
      const noteBody = `স্টক শেষ হয়ে গেছে: ${product.name} — এই প্রোডাক্টের স্টক এখন ০।`;
      await client.query(
        'INSERT INTO notes (workspace_id, customer_id, body) VALUES ($1, $2, $3)',
        [workspaceId, customerId, noteBody],
      );
      await client.query(
        'INSERT INTO order_events (workspace_id, order_id, from_status, to_status, note) VALUES ($1, $2, $3, $4, $5)',
        [workspaceId, orderId, 'pending', 'pending', `স্টক শেষ: ${product.name}`],
      );
    }
    await client.query('COMMIT');
    // Return the same full camelCase order shape as GET /:id (with
    // handledBy, zone, invoiceUrl, grand total) — not the raw INSERT row,
    // whose snake_case columns do not match the web Order interface.
    const full = await loadFullOrder(workspaceId, orderId);
    res.status(201).json({
      order: full?.order ?? order.rows[0],
      orderNumber,
      invoiceUrl: invoiceUrlFor(invoiceToken),
      billText: buildBillText(orderId, lines, totalPaisa, {
        name: contact.customerName,
        phone: contact.customerPhone,
        address: contact.deliveryAddress,
      }),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('[orders/create]', err);
    res.status(500).json({ error: 'Order creation failed' });
  } finally {
    client.release();
  }
});

ordersRouter.get('/', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const params: unknown[] = [workspaceId];
  let where = 'WHERE o.workspace_id = $1';
  if (status) {
    params.push(status);
    where += ` AND o.status = $${params.length}`;
  }
  // A-to-Z list rows: the order's own delivery snapshot (what the customer
  // gave when they ordered) + the live customer row (name, phone, address,
  // photo) so the list can show who ordered, how to reach them and where
  // to deliver — without a second request per order.
  const { rows } = await query(
    workspaceId,
    `SELECT ${ORDER_COLUMNS},
            c.name AS live_customer_name, c.phone AS live_customer_phone, c.address AS live_customer_address,
            c.picture_url AS live_customer_picture_url
     FROM orders o LEFT JOIN customers c ON c.id = o.customer_id AND c.workspace_id = $1
     ${where} ORDER BY o.created_at DESC LIMIT 200`,
    params,
  );
  res.json({ orders: rows.map((r) => withCustomer(r as unknown as Record<string, unknown>)) });
});

/** GET /api/orders/counts — one count per status, for the tabs on top. */
ordersRouter.get('/counts', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rows } = await query<{ status: string; n: string }>(
    workspaceId,
    'SELECT status, COUNT(*)::text AS n FROM orders WHERE workspace_id = $1 GROUP BY status',
    [workspaceId],
  );
  const counts: Record<string, number> = {};
  for (const s of ORDER_STATUSES) counts[s] = 0;
  let total = 0;
  for (const r of rows) {
    counts[r.status] = Number(r.n);
    total += Number(r.n);
  }
  res.json({ counts, total });
});

/**
 * Money breakdown for the Orders Report tab (2026-11-09, user request:
 * the tab showed counts only, never the taka). Each category is
 * { count, valuePaisa } where valuePaisa is the TRUE grand total per
 * order: total_paisa + delivery_charge_paisa. All sums are done in SQL
 * on BIGINT and converted with Number() here — never string-concatenated
 * (see the 2026-11-09 orders-total bug, where "60000"+"10000" became
 * ৳60,000,100). loss = cancelled + damaged + returned (no payment
 * comes from those orders). inProgress = every order not in an end
 * state, so the rows reconcile: delivered + cancelled + damaged +
 * returned + inProgress = total.
 */
const MONEY_END_STATES = ['delivered', 'cancelled', 'damaged', 'returned'] as const;
type MoneyCategory = { count: number; valuePaisa: number };
type MoneyBreakdown = {
  total: MoneyCategory; delivered: MoneyCategory; cancelled: MoneyCategory;
  damaged: MoneyCategory; returned: MoneyCategory; loss: MoneyCategory;
  pending: MoneyCategory; inCourier: MoneyCategory; inProgress: MoneyCategory;
};
function buildMoneyBreakdown(rows: { status: string; n: string; grand: string }[]): MoneyBreakdown {
  const byStatus = new Map<string, MoneyCategory>();
  for (const r of rows) byStatus.set(r.status, { count: Number(r.n), valuePaisa: Number(r.grand) });
  const cat = (s: string): MoneyCategory => byStatus.get(s) ?? { count: 0, valuePaisa: 0 };
  const sum = (...cs: MoneyCategory[]): MoneyCategory =>
    cs.reduce((a, c) => ({ count: a.count + c.count, valuePaisa: a.valuePaisa + c.valuePaisa }), { count: 0, valuePaisa: 0 });
  const total = sum(...byStatus.values());
  const delivered = cat('delivered');
  const cancelled = cat('cancelled');
  const damaged = cat('damaged');
  const returned = cat('returned');
  const loss = sum(cancelled, damaged, returned);
  const pending = cat('pending');
  const inCourier = cat('in_transit');
  const inProgress = sum(...[...byStatus.entries()].filter(([s]) => !(MONEY_END_STATES as readonly string[]).includes(s)).map(([, v]) => v));
  return { total, delivered, cancelled, damaged, returned, loss, pending, inCourier, inProgress };
}

/** GET /api/orders/report — today's report (Asia/Dhaka day) + courier view. */
ordersRouter.get('/report', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  // Today in Asia/Dhaka (UTC+6): 00:00 Dhaka = 18:00 UTC the day before.
  const now = new Date();
  const dhakaNow = new Date(now.getTime() + 6 * 60 * 60 * 1000);
  const dayStartUtc = new Date(Date.UTC(dhakaNow.getUTCFullYear(), dhakaNow.getUTCMonth(), dhakaNow.getUTCDate(), 0, 0, 0) - 6 * 60 * 60 * 1000);
  const dayEndUtc = new Date(dayStartUtc.getTime() + 24 * 60 * 60 * 1000);
  const day = dayStartUtc.toISOString();
  const dayEnd = dayEndUtc.toISOString();
  const { rows: todayRows } = await query<{ status: string; n: string; value: string; grand: string }>(
    workspaceId,
    `SELECT status, COUNT(*)::text AS n, COALESCE(SUM(total_paisa), 0)::text AS value,
            COALESCE(SUM(COALESCE(total_paisa, 0) + COALESCE(delivery_charge_paisa, 0)), 0)::text AS grand
     FROM orders WHERE workspace_id = $1 AND created_at >= $2 AND created_at < $3 GROUP BY status`,
    [workspaceId, day, dayEnd],
  );
  const today: Record<string, number> = { orders: 0, delivered: 0, cancelled: 0, returned: 0, damaged: 0, valuePaisa: 0 };
  for (const r of todayRows) {
    today.orders += Number(r.n);
    today.valuePaisa += Number(r.value);
    if (r.status === 'delivered') today.delivered = Number(r.n);
    if (r.status === 'cancelled') today.cancelled = Number(r.n);
    if (r.status === 'returned') today.returned = Number(r.n);
    if (r.status === 'damaged') today.damaged = Number(r.n);
  }
  // Money breakdown (grand totals) for today + all time. The `today`
  // shape above is kept byte-for-byte (an existing verifier pins
  // today.valuePaisa to the item-only sum); the money lives in the new
  // todayMoney / overall objects.
  const todayMoney = buildMoneyBreakdown(todayRows);
  const { rows: overallRows } = await query<{ status: string; n: string; grand: string }>(
    workspaceId,
    `SELECT status, COUNT(*)::text AS n,
            COALESCE(SUM(COALESCE(total_paisa, 0) + COALESCE(delivery_charge_paisa, 0)), 0)::text AS grand
     FROM orders WHERE workspace_id = $1 GROUP BY status`,
    [workspaceId],
  );
  const overall = buildMoneyBreakdown(overallRows);
  const { rows: courierRows } = await query<{ status: string; n: string }>(
    workspaceId,
    `SELECT COALESCE(s.status, o.status)::text AS status, COUNT(*)::text AS n
     FROM shipments s LEFT JOIN orders o ON o.id = s.order_id AND o.workspace_id = $1
     WHERE s.workspace_id = $1 GROUP BY COALESCE(s.status, o.status)`,
    [workspaceId],
  );
  const inCourier = await queryOne<{ n: string }>(
    workspaceId,
    "SELECT COUNT(*)::text AS n FROM orders WHERE workspace_id = $1 AND status = 'in_transit'",
    [workspaceId],
  );
  res.json({
    // The Dhaka calendar date (dhakaNow is now shifted +6h, so its UTC
    // date IS the Dhaka date) — NOT dayStartUtc's UTC date, which is the
    // previous day (midnight Dhaka = 18:00 UTC the day before).
    date: dhakaNow.toISOString().slice(0, 10),
    today,
    todayMoney,
    overall,
    courier: {
      inTransitOrders: Number(inCourier?.n ?? 0),
      shipmentsByStatus: Object.fromEntries(courierRows.map((r) => [r.status, Number(r.n)])),
    },
  });
});

/**
 * GET /api/orders/customers — one row per customer who ordered: how many
 * orders, how many cancelled, how many returned, how many delivered, and
 * when they last ordered. The AMOUNT is deliberately NOT here — the user
 * asked that the money stays hidden until the owner clicks a customer.
 */
ordersRouter.get('/customers', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rows } = await query(
    workspaceId,
    `SELECT c.id, c.name, c.phone, c.picture_url,
            COUNT(o.id)::int AS orders,
            COUNT(o.id) FILTER (WHERE o.status = 'cancelled')::int AS cancelled,
            COUNT(o.id) FILTER (WHERE o.status = 'returned')::int AS returned,
            COUNT(o.id) FILTER (WHERE o.status = 'delivered')::int AS delivered,
            MAX(o.created_at) AS last_order_at
     FROM customers c JOIN orders o ON o.customer_id = c.id AND o.workspace_id = $1
     WHERE c.workspace_id = $1
     GROUP BY c.id, c.name, c.phone, c.picture_url
     ORDER BY last_order_at DESC`,
    [workspaceId],
  );
  res.json({ customers: rows });
});

/**
 * GET /api/orders/customers/:customerId — the click-to-reveal: the same
 * customer stats PLUS the total amount spent and their orders. This is
 * the only place the customer's money total is returned.
 */
ordersRouter.get('/customers/:customerId', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const customer = await queryOne<{ id: string; name: string | null; phone: string | null; picture_url: string | null }>(
    workspaceId,
    'SELECT id, name, phone, picture_url FROM customers WHERE workspace_id = $1 AND id = $2',
    [workspaceId, req.params.customerId],
  );
  if (!customer) {
    res.status(404).json({ error: 'Customer not found' });
    return;
  }
  const stats = await queryOne<{ orders: number; cancelled: number; returned: number; delivered: number; total_paisa: string; last_order_at: string | null }>(
    workspaceId,
    `SELECT COUNT(*)::int AS orders,
            COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
            COUNT(*) FILTER (WHERE status = 'returned')::int AS returned,
            COUNT(*) FILTER (WHERE status = 'delivered')::int AS delivered,
            COALESCE(SUM(total_paisa), 0)::text AS total_paisa,
            MAX(created_at) AS last_order_at
     FROM orders WHERE workspace_id = $1 AND customer_id = $2`,
    [workspaceId, req.params.customerId],
  );
  const { rows: orders } = await query(
    workspaceId,
    `SELECT ${ORDER_COLUMNS} FROM orders o WHERE o.workspace_id = $1 AND o.customer_id = $2 ORDER BY o.created_at DESC LIMIT 50`,
    [workspaceId, req.params.customerId],
  );
  res.json({
    customer,
    stats: {
      orders: stats?.orders ?? 0,
      cancelled: stats?.cancelled ?? 0,
      returned: stats?.returned ?? 0,
      delivered: stats?.delivered ?? 0,
      totalPaisa: Number(stats?.total_paisa ?? 0),
      lastOrderAt: stats?.last_order_at ?? null,
    },
    orders: orders.map((r) => withCustomer(r as unknown as Record<string, unknown>)),
  });
});

/**
 * GET /api/orders/cancel-requests — the owner's cancel-request queue:
 * pending first, then decided, newest first. Each row carries the order
 * number + customer so the owner can approve / decline from the Orders
 * page. (Registered before GET /:id so Express never treats
 * "cancel-requests" as an order id.)
 */
ordersRouter.get('/cancel-requests', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const params: unknown[] = [workspaceId];
  let where = 'WHERE r.workspace_id = $1';
  if (status === 'pending' || status === 'approved' || status === 'declined') {
    params.push(status);
    where += ` AND r.status = $${params.length}`;
  }
  const { rows } = await query(
    workspaceId,
    `SELECT r.id, r.order_id, r.customer_id, r.conversation_id, r.reason, r.status, r.decided_at, r.created_at,
            o.order_number, o.status AS order_status, o.total_paisa, o.created_at AS order_created_at,
            c.name AS customer_name, c.phone AS customer_phone
     FROM order_cancel_requests r
     LEFT JOIN orders o ON o.id = r.order_id AND o.workspace_id = $1
     LEFT JOIN customers c ON c.id = r.customer_id AND c.workspace_id = $1
     ${where}
     ORDER BY CASE WHEN r.status = 'pending' THEN 0 ELSE 1 END, r.created_at DESC LIMIT 100`,
    params,
  );
  const pending = rows.filter((r) => (r as { status: string }).status === 'pending').length;
  res.json({ requests: rows, pendingCount: pending });
});

/**
 * POST /api/orders/cancel-requests/:id/approve — the owner (or their
 * representative) approves a cancellation. The order becomes 'cancelled'
 * (logged in order_events) and the customer is told by Messenger
 * ("আপনার অর্ডারটি ক্যান্সেল করা হয়েছে।"). Only a pending request can
 * be approved; an order that is already delivered / cancelled / returned
 * / damaged is refused honestly (409).
 */
ordersRouter.post('/cancel-requests/:id/approve', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const request = await queryOne<{ id: string; order_id: string; customer_id: string | null; conversation_id: string | null; status: string; reason: string | null }>(
    workspaceId,
    'SELECT id, order_id, customer_id, conversation_id, status, reason FROM order_cancel_requests WHERE workspace_id = $1 AND id = $2',
    [workspaceId, req.params.id],
  );
  if (!request) {
    res.status(404).json({ error: 'Cancel request not found' });
    return;
  }
  if (request.status !== 'pending') {
    res.status(409).json({ error: `This cancel request was already ${request.status}.` });
    return;
  }
  const order = await queryOne<{ id: string; status: string; order_number: string | null }>(
    workspaceId,
    'SELECT id, status, order_number FROM orders WHERE workspace_id = $1 AND id = $2',
    [workspaceId, request.order_id],
  );
  if (!order) {
    res.status(404).json({ error: 'Order not found' });
    return;
  }
  if (order.status === 'cancelled') {
    res.status(409).json({ error: 'This order is already cancelled.' });
    return;
  }
  if (order.status === 'delivered' || order.status === 'returned' || order.status === 'damaged') {
    res.status(409).json({ error: `This order is already ${order.status} and cannot be cancelled.` });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "UPDATE order_cancel_requests SET status = 'approved', decided_at = now(), updated_at = now() WHERE workspace_id = $1 AND id = $2",
      [workspaceId, req.params.id],
    );
    await client.query(
      "UPDATE orders SET status = 'cancelled', updated_at = now() WHERE workspace_id = $1 AND id = $2",
      [workspaceId, order.id],
    );
    await client.query(
      "INSERT INTO order_events (workspace_id, order_id, from_status, to_status, note) VALUES ($1, $2, $3, 'cancelled', 'Cancelled by owner — cancel request approved')",
      [workspaceId, order.id, order.status],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('[orders/cancel-approve]', err);
    res.status(500).json({ error: 'Approval failed' });
    return;
  } finally {
    client.release();
  }
  // Tell the customer (Messenger). The order is cancelled either way —
  // a failed send (e.g. 24h window expired) is reported honestly, never
  // faked, and the owner can message the customer by hand from the Inbox.
  let sent = false;
  let sendError: string | null = null;
  if (request.conversation_id) {
    const customer = request.customer_id
      ? await queryOne<{ gender: string | null }>(
          workspaceId,
          'SELECT gender FROM customers WHERE workspace_id = $1 AND id = $2',
          [workspaceId, request.customer_id],
        )
      : null;
    const sal = customer?.gender === 'male' ? 'স্যার' : customer?.gender === 'female' ? 'ম্যাডাম' : '';
    const text = sal
      ? `${sal}, আপনার অর্ডারটি (${order.order_number ?? ''}) ক্যান্সেল করা হয়েছে।`
      : `আপনার অর্ডারটি (${order.order_number ?? ''}) ক্যান্সেল করা হয়েছে।`;
    const result = await deliverOutgoingMessage(workspaceId, request.conversation_id, text);
    sent = result.sent;
    sendError = result.error ?? null;
  } else {
    sendError = 'এই অর্ডারের কোনো মেসেঞ্জার চ্যাট নেই — কাস্টমারকে নিজে জানান।';
  }
  const full = await loadFullOrder(workspaceId, order.id);
  res.json({ request: { id: request.id, status: 'approved' }, order: full?.order ?? { id: order.id, status: 'cancelled' }, sent, sendError });
});

/**
 * POST /api/orders/cancel-requests/:id/decline — the owner declines a
 * cancellation. The order stays exactly as it is; NO message is sent
 * automatically — the owner handles it with the customer manually from
 * the Inbox. Only a pending request can be declined.
 */
ordersRouter.post('/cancel-requests/:id/decline', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rows } = await query(
    workspaceId,
    `UPDATE order_cancel_requests SET status = 'declined', decided_at = now(), updated_at = now()
     WHERE workspace_id = $1 AND id = $2 AND status = 'pending' RETURNING id, order_id, status`,
    [workspaceId, req.params.id],
  );
  if (rows.length === 0) {
    res.status(409).json({ error: 'Cancel request not found or already decided.' });
    return;
  }
  res.json({ request: rows[0] });
});

/**
 * GET /api/orders/lookup?q=... — the scan box: look an order up by its
 * order number (ASI-0001, or a prefix), a courier tracking number, or an
 * invoice token. Returns the full order, or 404 with an honest message.
 */
ordersRouter.get('/lookup', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!q) {
    res.status(400).json({ error: 'q is required (order number, tracking number or invoice token)' });
    return;
  }
  const full = await queryOne<{ id: string }>(
    workspaceId,
    `SELECT o.id FROM orders o
     LEFT JOIN shipments s ON s.order_id = o.id AND s.workspace_id = $1
     WHERE o.workspace_id = $1
       AND (o.order_number ILIKE $2 OR o.invoice_token = $3
            OR s.tracking_number = $3 OR s.tracking_code = $3 OR s.provider_booking_id = $3)
     ORDER BY o.created_at DESC LIMIT 1`,
    [workspaceId, `${q}%`, q],
  );
  if (!full) {
    res.status(404).json({ error: 'এই নম্বরে কোনো অর্ডার বা পার্সেল পাওয়া যায়নি — নম্বরটি ঠিক আছে কি না দেখুন।' });
    return;
  }
  const loaded = await loadFullOrder(workspaceId, full.id);
  if (!loaded) {
    res.status(404).json({ error: 'Order not found' });
    return;
  }
  res.json(loaded);
});

ordersRouter.get('/:id', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const full = await loadFullOrder(workspaceId, req.params.id);
  if (!full) {
    res.status(404).json({ error: 'Order not found' });
    return;
  }
  res.json(full);
});

/** Full order row + items + events, in the shape the web app expects. */
async function loadFullOrder(
  workspaceId: string,
  orderId: string,
): Promise<{ order: Record<string, unknown>; items: Record<string, unknown>[]; events: Record<string, unknown>[]; shipment: Record<string, unknown> | null } | null> {
  const order = await queryOne(
    workspaceId,
    `SELECT ${ORDER_COLUMNS},
            c.name AS live_customer_name, c.phone AS live_customer_phone, c.address AS live_customer_address,
            c.picture_url AS live_customer_picture_url
     FROM orders o LEFT JOIN customers c ON c.id = o.customer_id AND c.workspace_id = $1
     WHERE o.workspace_id = $1 AND o.id = $2`,
    [workspaceId, orderId],
  );
  if (!order) return null;
  const { rows: items } = await query(
    workspaceId,
    `SELECT oi.id, oi.product_id, p.name AS product_name, oi.quantity, oi.price_paisa
     FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id AND p.workspace_id = $1
     WHERE oi.workspace_id = $1 AND oi.order_id = $2`,
    [workspaceId, orderId],
  );
  const { rows: events } = await query(
    workspaceId,
    'SELECT id, from_status, to_status, note, created_at FROM order_events WHERE workspace_id = $1 AND order_id = $2 ORDER BY created_at ASC',
    [workspaceId, orderId],
  );
  const shipment = await queryOne(
    workspaceId,
    `SELECT id, order_id, courier, tracking_code, tracking_number, provider_booking_id, status, created_at
     FROM shipments WHERE workspace_id = $1 AND order_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [workspaceId, orderId],
  );
  const row = order as unknown as Record<string, unknown>;
  const zone = zoneOfAddress((row.delivery_address as string | null) ?? (row.live_customer_address as string | null) ?? null);
  const withExtra = withCustomer(row);
  withExtra.zone = zone;
  withExtra.handledBy = row.handled_by === 'agent' ? 'agent' : 'ai';
  withExtra.invoiceUrl = invoiceUrlFor(row.invoice_token as string | null);
  withExtra.deliveryEstimate = deliveryEstimateText(
    (row.created_at as string) ?? new Date().toISOString(),
    zone.insideDhaka,
  );
  withExtra.grandTotalPaisa = Number(row.total_paisa ?? 0) + Number(row.delivery_charge_paisa ?? 0);
  return {
    order: withExtra,
    items: items as unknown as Record<string, unknown>[],
    events: events as unknown as Record<string, unknown>[],
    shipment: (shipment as unknown as Record<string, unknown> | null) ?? null,
  };
}

/**
 * Attach the live customer profile to an order row. The order carries its
 * own delivery snapshot (customer_name / customer_phone / delivery_address
 * — what was given at order time); the live row carries the current name,
 * phone, address and photo. The web app prefers the snapshot for delivery
 * and falls back to the live row, showing 'দেওয়া হয়নি' when both are
 * missing — never invented data.
 */
function withCustomer(row: Record<string, unknown>): Record<string, unknown> {
  const { live_customer_name, live_customer_phone, live_customer_address, live_customer_picture_url, ...rest } = row;
  return {
    ...rest,
    customer: {
      id: row.customer_id ?? null,
      name: (live_customer_name as string | null) ?? (row.customer_name as string | null) ?? null,
      phone: (live_customer_phone as string | null) ?? (row.customer_phone as string | null) ?? null,
      address: (live_customer_address as string | null) ?? (row.delivery_address as string | null) ?? null,
      picture_url: (live_customer_picture_url as string | null) ?? null,
    },
  };
}

/**
 * PATCH /api/orders/:id/status {status} — the owner picks ANY status
 * manually (pending / hold / approved / processing / ready / ready to
 * ship / in transit / delivered / cancelled / returned / damaged /
 * in store). Every change is logged in order_events. The old forward-only
 * rule is retired on purpose: the user asked to select the status
 * himself, including moving an order back.
 */
ordersRouter.patch('/:id/status', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { status } = (req.body ?? {}) as { status?: string };
  if (!status || !ORDER_STATUSES.includes(status as never)) {
    res.status(400).json({ error: `status must be one of: ${ORDER_STATUSES.join(', ')}` });
    return;
  }
  const order = await queryOne<{ id: string; status: string; conversation_id: string | null; order_number: string | null; customer_id: string | null }>(
    workspaceId,
    'SELECT id, status, conversation_id, order_number, customer_id FROM orders WHERE workspace_id = $1 AND id = $2',
    [workspaceId, req.params.id],
  );
  if (!order) {
    res.status(404).json({ error: 'Order not found' });
    return;
  }
  if (order.status === status) {
    const full = await loadFullOrder(workspaceId, req.params.id);
    res.json(full ?? { order: { id: req.params.id, status } });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE orders SET status = $1, updated_at = now() WHERE workspace_id = $2 AND id = $3',
      [status, workspaceId, req.params.id],
    );
    await client.query(
      'INSERT INTO order_events (workspace_id, order_id, from_status, to_status) VALUES ($1, $2, $3, $4)',
      [workspaceId, req.params.id, order.status, status],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('[orders/status]', err);
    res.status(500).json({ error: 'Status update failed' });
    return;
  } finally {
    client.release();
  }
  const full = await loadFullOrder(workspaceId, req.params.id);
  const base = full ?? { order: { id: req.params.id, status } };
  if (status !== 'cancelled') {
    res.json(base);
    return;
  }
  // Website-side cancellation: the customer MUST be told (same wording
  // as the cancel-request approve path). Only when the status actually
  // changed TO cancelled (the same-status early return above means this
  // never fires for an already-cancelled order). Best-effort and reported
  // honestly — a failed send (e.g. the 24h Messenger window expired)
  // never rolls back the cancellation; the owner can message the
  // customer by hand from the Inbox.
  let cancelNotified = false;
  let cancelNotifyError: string | null = null;
  if (!order.conversation_id) {
    cancelNotifyError = 'এই অর্ডারের কোনো মেসেঞ্জার চ্যাট নেই — কাস্টমারকে নিজে জানান।';
  } else {
    const customer = order.customer_id
      ? await queryOne<{ gender: string | null }>(
          workspaceId,
          'SELECT gender FROM customers WHERE workspace_id = $1 AND id = $2',
          [workspaceId, order.customer_id],
        )
      : null;
    const sal = customer?.gender === 'male' ? 'স্যার' : customer?.gender === 'female' ? 'ম্যাডাম' : '';
    const text = sal
      ? `${sal}, আপনার অর্ডারটি (${order.order_number ?? ''}) ক্যান্সেল করা হয়েছে।`
      : `আপনার অর্ডারটি (${order.order_number ?? ''}) ক্যান্সেল করা হয়েছে।`;
    const result = await deliverOutgoingMessage(workspaceId, order.conversation_id, text);
    cancelNotified = result.sent;
    cancelNotifyError = result.error ?? null;
  }
  res.json({ ...base, cancelNotified, cancelNotifyError });
});

/** PATCH /api/orders/:id/payment {paymentStatus} — unpaid | paid. */
ordersRouter.patch('/:id/payment', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { paymentStatus } = (req.body ?? {}) as { paymentStatus?: string };
  if (paymentStatus !== 'unpaid' && paymentStatus !== 'paid') {
    res.status(400).json({ error: 'paymentStatus must be unpaid or paid' });
    return;
  }
  const { rows } = await query(
    workspaceId,
    'UPDATE orders SET payment_status = $1, updated_at = now() WHERE workspace_id = $2 AND id = $3 RETURNING id, payment_status',
    [paymentStatus, workspaceId, req.params.id],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Order not found' });
    return;
  }
  const full = await loadFullOrder(workspaceId, req.params.id);
  res.json(full ?? { order: rows[0] });
});

/**
 * PATCH /api/orders/:id/payment-method {paymentMethod} — cod | advance |
 * fifty_fifty. The customer pays cash on delivery by default; the owner
 * records advance / 50-50 here, and the receipt + invoice show it.
 */
ordersRouter.patch('/:id/payment-method', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { paymentMethod } = (req.body ?? {}) as { paymentMethod?: string };
  if (!paymentMethod || !PAYMENT_METHODS.includes(paymentMethod as never)) {
    res.status(400).json({ error: `paymentMethod must be one of: ${PAYMENT_METHODS.join(', ')}` });
    return;
  }
  const { rows } = await query(
    workspaceId,
    'UPDATE orders SET payment_method = $1, updated_at = now() WHERE workspace_id = $2 AND id = $3 RETURNING id, payment_method',
    [paymentMethod, workspaceId, req.params.id],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Order not found' });
    return;
  }
  const full = await loadFullOrder(workspaceId, req.params.id);
  res.json(full ?? { order: rows[0] });
});

/**
 * POST /api/orders/:id/send-to-courier {courier} — "Send to Courier":
 * the owner picks a courier (steadfast | pathao | sundarban | redx) and
 * the parcel is booked with that courier's real API. Returns the
 * tracking number from the courier. A courier that is not connected
 * fails honestly (502, no shipment row, no fake tracking number).
 */
ordersRouter.post('/:id/send-to-courier', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { courier } = (req.body ?? {}) as { courier?: string };
  if (!courier || typeof courier !== 'string') {
    res.status(400).json({ error: 'courier is required (steadfast | pathao | sundarban | redx)' });
    return;
  }
  const name = courier.toLowerCase().trim();
  if (!['steadfast', 'pathao', 'sundarban', 'redx'].includes(name)) {
    res.status(400).json({ error: `Unknown courier: ${courier}` });
    return;
  }
  try {
    const result = await bookCourierForOrder(workspaceId, req.params.id, name);
    const full = await loadFullOrder(workspaceId, req.params.id);
    res.status(result.alreadyBooked ? 200 : 201).json({
      shipment: result.shipment,
      provider: result.provider,
      providerConfigured: result.providerConfigured,
      alreadyBooked: result.alreadyBooked,
      message: result.message,
      order: full?.order ?? null,
    });
  } catch (err) {
    if ((err as Error & { status?: number }).status === 404) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    if (err instanceof CourierValidationError) {
      res.status(400).json({ error: err.message, code: err.code });
      return;
    }
    if (err instanceof ProviderNotConfiguredError) {
      res.status(502).json({ error: err.message, code: err.code, providerConfigured: false });
      return;
    }
    console.error('[orders/send-to-courier]', err);
    res.status(502).json({ error: 'কুরিয়ার বুকিং করা যায়নি — প্রোভাইডারের সাথে সংযোগ ব্যর্থ হয়েছে। কোনো ভুয়া বুকিং নম্বর দেওয়া হয়নি।', providerConfigured: false });
  }
});

/**
 * POST /api/orders/:id/receipt — (re)send the receipt to the customer:
 * the short confirmation text (order number, name, phone, address,
 * items, delivery charge, total) + the invoice link. The order needs a
 * Messenger conversation to send to; without one the link is returned
 * for the owner to share manually — never a fake "sent".
 * NOTE: no receipt IMAGE is sent here. The image renderer available on
 * Vercel (@vercel/og / Satori) cannot shape Bengali conjuncts — tested
 * 2026-11-08, they render as dotted circles. The invoice LINK is the
 * working receipt (perfect Bengali HTML, printable); a proper image
 * renderer is a follow-up, not a broken image.
 */
ordersRouter.post('/:id/receipt', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const full = await loadFullOrder(workspaceId, req.params.id);
  if (!full) {
    res.status(404).json({ error: 'Order not found' });
    return;
  }
  const order = full.order as Record<string, unknown>;
  // Older orders have no invoice token — mint one now so the link works.
  let token = order.invoice_token as string | null;
  if (!token) {
    token = newInvoiceToken();
    await query(
      workspaceId,
      'UPDATE orders SET invoice_token = $1, updated_at = now() WHERE workspace_id = $1 AND id = $2',
      [token, workspaceId, req.params.id],
    );
    order.invoice_token = token;
    order.invoiceUrl = invoiceUrlFor(token);
  }
  const invoiceUrl = invoiceUrlFor(token);
  const lines: BillLine[] = full.items.map((it) => ({
    name: String(it.product_name ?? it.name ?? 'আইটেম'),
    quantity: Number(it.quantity ?? 1),
    pricePaisa: Number(it.price_paisa ?? it.pricePaisa ?? 0),
  }));
  const text = buildConfirmationText(
    lines,
    Number(order.total_paisa ?? 0),
    Number(order.delivery_charge_paisa ?? 0),
    {
      name: (order.customer_name as string | null) ?? (order.customer as { name?: string | null } | null)?.name ?? null,
      phone: (order.customer_phone as string | null) ?? (order.customer as { phone?: string | null } | null)?.phone ?? null,
      address: (order.delivery_address as string | null) ?? (order.customer as { address?: string | null } | null)?.address ?? null,
    },
    { orderNumber: order.order_number as string | null, invoiceUrl },
  );
  const conversationId = (order.conversation_id as string | null) ?? (order.conversationId as string | null) ?? null;
  if (!conversationId) {
    res.json({
      sent: false,
      invoiceUrl,
      orderNumber: order.order_number ?? null,
      reason: 'এই অর্ডারের কোনো মেসেঞ্জার চ্যাট নেই — ইনভয়েস লিংকটি নিজে শেয়ার করুন।',
    });
    return;
  }
  const result = await deliverOutgoingMessage(workspaceId, conversationId, text);
  res.json({
    sent: result.sent,
    delivery: result.delivery,
    error: result.error ?? null,
    invoiceUrl,
    orderNumber: order.order_number ?? null,
  });
});
