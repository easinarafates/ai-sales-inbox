import { Router, type Response } from 'express';
import { pool, query, queryOne } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';
import { buildBillText, type BillLine } from './bill';
import { resolveOrderContact } from './contact';
import { decrementStockForOrderItems } from '../products/stock';
import { linkOrderToAttribution } from '../analytics/attribution';

export const ordersRouter = Router();
ordersRouter.use(requireAuth);

/** Allowed forward flow: pending → on_hold → approved → processing → ready_to_ship → in_transit → delivered */
const NEXT_STATUS: Record<string, string[]> = {
  pending: ['on_hold', 'approved'],
  on_hold: ['approved', 'pending'],
  approved: ['processing'],
  processing: ['ready_to_ship'],
  ready_to_ship: ['in_transit'],
  in_transit: ['delivered'],
  delivered: [],
};

interface OrderItemInput {
  productId?: string;
  quantity?: number;
}

/**
 * POST /api/orders {customerId, conversationId, items:[{productId, quantity}], source,
 *   customerName, customerPhone, deliveryAddress}
 * Prices are taken ONLY from the products table — never from the request.
 * Delivery contact is REQUIRED, same rule as the AI create_order tool: the
 * order is refused (400) when the phone or the delivery address is missing
 * — the team must ask the customer first, never create a contact-less
 * order. Given contact is stored on the customer row AND snapshotted onto
 * the order (orders.customer_name / customer_phone / delivery_address).
 */
ordersRouter.post('/', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { customerId, conversationId, items, source, customerName, customerPhone, deliveryAddress, name, phone, address } = (req.body ?? {}) as {
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
  };
  if (!customerId || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'customerId and at least one item are required' });
    return;
  }
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
    const order = await client.query(
      `INSERT INTO orders (workspace_id, customer_id, conversation_id, source, status, payment_status, total_paisa,
                          customer_name, customer_phone, delivery_address)
       VALUES ($1, $2, $3, $4, 'pending', 'unpaid', $5, $6, $7, $8) RETURNING id, status, payment_status, total_paisa, customer_name, customer_phone, delivery_address`,
      [workspaceId, customerId, conversationId ?? null, source ?? 'team', totalPaisa, contact.customerName, contact.customerPhone, contact.deliveryAddress],
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
    res.status(201).json({
      order: order.rows[0],
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
    `SELECT o.id, o.customer_id, o.conversation_id, o.source, o.status, o.payment_status, o.total_paisa, o.created_at,
            o.customer_name, o.customer_phone, o.delivery_address,
            c.name AS live_customer_name, c.phone AS live_customer_phone, c.address AS live_customer_address,
            c.picture_url AS live_customer_picture_url
     FROM orders o LEFT JOIN customers c ON c.id = o.customer_id AND c.workspace_id = $1
     ${where} ORDER BY o.created_at DESC LIMIT 200`,
    params,
  );
  res.json({ orders: rows.map((r) => withCustomer(r as unknown as Record<string, unknown>)) });
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
): Promise<{ order: Record<string, unknown>; items: Record<string, unknown>[]; events: Record<string, unknown>[] } | null> {
  const order = await queryOne(
    workspaceId,
    `SELECT o.id, o.customer_id, o.conversation_id, o.source, o.status, o.payment_status, o.total_paisa, o.created_at,
            o.customer_name, o.customer_phone, o.delivery_address,
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
  return { order: withCustomer(order as unknown as Record<string, unknown>), items: items as unknown as Record<string, unknown>[], events: events as unknown as Record<string, unknown>[] };
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

/** PATCH /api/orders/:id/status {status} — only the next step(s) in the flow. */
ordersRouter.patch('/:id/status', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { status } = (req.body ?? {}) as { status?: string };
  if (!status) {
    res.status(400).json({ error: 'status is required' });
    return;
  }
  const order = await queryOne<{ id: string; status: string }>(
    workspaceId,
    'SELECT id, status FROM orders WHERE workspace_id = $1 AND id = $2',
    [workspaceId, req.params.id],
  );
  if (!order) {
    res.status(404).json({ error: 'Order not found' });
    return;
  }
  const allowed = NEXT_STATUS[order.status] ?? [];
  if (!allowed.includes(status)) {
    res.status(400).json({ error: `Cannot move order from ${order.status} to ${status}`, allowedNext: allowed });
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
    const full = await loadFullOrder(workspaceId, req.params.id);
    res.json(full ?? { order: { id: req.params.id, status } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('[orders/status]', err);
    res.status(500).json({ error: 'Status update failed' });
  } finally {
    client.release();
  }
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
