/**
 * AI tools — the ONLY way the AI agent touches data.
 * The agent never writes to the DB directly; it calls these functions.
 * Every tool filters by workspace_id. No tool ever invents a price, stock
 * level, discount or delivery time — values come only from the tables.
 */
import { buildBillText, buildConfirmationText } from '../orders/bill';
import { resolveOrderContact } from '../orders/contact';
import { requestOrderCancellation as requestOrderCancellationService } from '../orders/cancel';
import { findUnknownPlaceNames, unknownPlaceAskLine } from '../orders/bangladesh';
import { newInvoiceToken, nextOrderNumber } from '../orders/order-helpers';
import { config } from '../config';
import { getDeliveryChargeRules, resolveDeliveryCharge } from '../delivery-charges/service';
import { decrementStockForOrderItems } from '../products/stock';
import { matchProductByImage } from './tools-image-match';
import { linkOrderToAttribution } from '../analytics/attribution';
import { deliverOutgoingImageMessage } from '../channels/meta-send';

export interface ToolDb {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
}

export type ToolArgs = Record<string, unknown>;

export interface ToolResult {
  [key: string]: unknown;
}

type ToolFn = (db: ToolDb, workspaceId: string, args: ToolArgs) => Promise<ToolResult>;

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** 1. Search products by text (name/description). */
const searchProducts: ToolFn = async (db, workspaceId, args) => {
  const q = asString(args.q ?? args.query);
  if (!q) return { error: 'search_products needs q' };
  const { rows } = await db.query<{ id: string; name: string; price_paisa: number; stock: number }>(
    `SELECT id, name, price_paisa, stock FROM products
     WHERE workspace_id = $1 AND (name ILIKE $2 OR description ILIKE $2) LIMIT 10`,
    [workspaceId, `%${q}%`],
  );
  return { products: rows };
};

/** 2. Build product cards (name/price/stock) for the agent to present. */
const sendProductCards: ToolFn = async (db, workspaceId, args) => {
  const ids = Array.isArray(args.productIds) ? (args.productIds as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  if (ids.length === 0) return { error: 'send_product_cards needs productIds' };
  const { rows } = await db.query<{ id: string; name: string; price_paisa: number; stock: number; description: string | null }>(
    `SELECT id, name, price_paisa, stock, description FROM products
     WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
    [workspaceId, ids],
  );
  return {
    cards: rows.map((p) => ({
      productId: p.id,
      name: p.name,
      pricePaisa: Number(p.price_paisa),
      stock: Number(p.stock),
      description: p.description,
    })),
  };
};

/**
 * 2b. REALLY send product photos — one image message per product, via the
 * real Graph send (deliverOutgoingImageMessage). The photo comes ONLY
 * from product_images (the product's own uploaded photos) — never a
 * placeholder. Each sent entry carries pricePaisa so the agent's
 * hallucination guard accepts the price in the follow-up text. A
 * product with no photo, or a channel that cannot receive images
 * (facebook_comment), lands in `failed` with the reason — the agent
 * then falls back to a text reply for that product instead of
 * pretending a photo went out. Needs conversationId (agent.ts injects
 * it, like customerId).
 */
const sendProductPhotos: ToolFn = async (db, workspaceId, args) => {
  const ids = Array.isArray(args.productIds) ? (args.productIds as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  if (ids.length === 0) return { error: 'send_product_photos needs productIds' };
  const conversationId = asString(args.conversationId);
  if (!conversationId) return { error: 'send_product_photos needs conversationId' };
  const sent: Record<string, unknown>[] = [];
  const failed: Record<string, unknown>[] = [];
  for (const productId of ids) {
    const { rows } = await db.query<{ id: string; name: string; price_paisa: number; stock: number; description: string | null; image_url: string | null }>(
      `SELECT p.id, p.name, p.price_paisa, p.stock, p.description,
              (SELECT pi.url FROM product_images pi WHERE pi.workspace_id = $1 AND pi.product_id = p.id ORDER BY pi.created_at ASC LIMIT 1) AS image_url
       FROM products p WHERE p.workspace_id = $1 AND p.id = $2`,
      [workspaceId, productId],
    );
    const product = rows[0];
    if (!product) {
      failed.push({ productId, error: 'Product not found' });
      continue;
    }
    if (!product.image_url) {
      failed.push({ productId, name: product.name, error: 'no_photo' });
      continue;
    }
    const result = await deliverOutgoingImageMessage(workspaceId, conversationId, product.image_url);
    if (!result.sent) {
      failed.push({ productId, name: product.name, error: result.error ?? 'image_send_failed' });
      continue;
    }
    sent.push({
      productId: product.id,
      name: product.name,
      pricePaisa: Number(product.price_paisa),
      stock: Number(product.stock),
      description: product.description,
      imageUrl: product.image_url,
      messageId: result.messageId,
      platformMessageId: result.platformMessageId,
    });
  }
  return { sent, failed };
};

/** 3. Create an order. Prices come ONLY from the products table.
 * Delivery contact is REQUIRED: the tool refuses when the customer's phone
 * or delivery address is missing (it must ask the customer first — never
 * create the order and never claim the contact is already known). When the
 * contact is given, it is stored on the customer row AND snapshotted onto
 * the order (orders.customer_name / customer_phone / delivery_address),
 * so the Orders page shows A-to-Z who ordered, when, and where to deliver.
 */
const createOrder: ToolFn = async (db, workspaceId, args) => {
  const customerId = asString(args.customerId);
  const conversationId = asString(args.conversationId) || null;
  const items = Array.isArray(args.items) ? args.items : [];
  if (!customerId || items.length === 0) return { error: 'create_order needs customerId and items' };
  // Who is this order for? Refuse without a phone + delivery address —
  // and (AI orders only, requirement A) refuse when the address is
  // present but not complete enough to deliver (no district, or no
  // upazila/area detail). The missing piece is named so the AI asks
  // for JUST that piece in one short line.
  const { contact, error, missingPhone, missingAddress, missingAddressParts, invalidPhone, givenPhone } = await resolveOrderContact(db, workspaceId, customerId, {
    customerName: args.customerName,
    customerPhone: args.customerPhone,
    deliveryAddress: args.deliveryAddress,
    name: args.name,
    phone: args.phone,
    address: args.address,
  }, { requireValidContact: true });
  if (!contact) return { error: error ?? 'create_order needs the customer phone number and delivery address', missingPhone: missingPhone ?? false, missingAddress: missingAddress ?? false, missingAddressParts: missingAddressParts ?? [], invalidPhone: invalidPhone ?? false, givenPhone: givenPhone ?? null };
  // Light address verification (requirement A refinement): the place
  // names in the address are checked against the local district/upazila
  // lists. An unmatched name only earns a polite "please double-check"
  // prompt — never a hard block. The order is NOT created until the
  // customer confirms the place (the LLM calls create_order again with
  // placeConfirmed: true after the customer confirms).
  const unknownPlaces = findUnknownPlaceNames(contact.deliveryAddress);
  if (unknownPlaces.length > 0 && args.placeConfirmed !== true) {
    return {
      error: `The delivery address names a place that does not match a real Bangladeshi district/upazila: "${unknownPlaces.join(', ')}". Ask the customer to double-check it in one short Bengali line: "${unknownPlaceAskLine(unknownPlaces)}" Do NOT create the order yet. If the customer confirms the place is correct, call create_order again with placeConfirmed: true.`,
      needsPlaceConfirmation: true,
      unknownPlaces,
    };
  }
  let totalPaisa = 0;
  const lines: { name: string; quantity: number; pricePaisa: number }[] = [];
  const priced: { productId: string; quantity: number; pricePaisa: number }[] = [];
  for (const raw of items) {
    const item = raw as Record<string, unknown>;
    const productId = asString(item.productId);
    const quantity = Math.max(1, Math.floor(Number(item.quantity ?? 1)));
    const { rows } = await db.query<{ id: string; name: string; price_paisa: number }>(
      'SELECT id, name, price_paisa FROM products WHERE workspace_id = $1 AND id = $2',
      [workspaceId, productId],
    );
    if (rows.length === 0) return { error: `Product not found: ${productId}` };
    totalPaisa += Number(rows[0].price_paisa) * quantity;
    lines.push({ name: rows[0].name, quantity, pricePaisa: Number(rows[0].price_paisa) });
    priced.push({ productId: rows[0].id, quantity, pricePaisa: Number(rows[0].price_paisa) });
  }
  // Order management: auto order number (ASI-0001, ...) + invoice token,
  // and the delivery charge resolved from the owner's rules is snapshotted
  // onto the order (so the bill/receipt never change when rules change).
  const chargeRules = await getDeliveryChargeRules(db, workspaceId);
  const { chargePaisa: deliveryChargePaisa } = resolveDeliveryCharge(chargeRules, contact.deliveryAddress);
  const orderNumber = await nextOrderNumber(db, workspaceId);
  const invoiceToken = newInvoiceToken();
  const { rows: orderRows } = await db.query<{ id: string }>(
    `INSERT INTO orders (workspace_id, customer_id, conversation_id, source, status, payment_status, payment_method,
                        total_paisa, delivery_charge_paisa, handled_by, order_number, invoice_token,
                        customer_name, customer_phone, delivery_address)
     VALUES ($1, $2, $3, 'ai', 'pending', 'unpaid', 'cod', $4, $5, 'ai', $6, $7, $8, $9, $10) RETURNING id`,
    [workspaceId, customerId, conversationId, totalPaisa, deliveryChargePaisa, orderNumber, invoiceToken, contact.customerName, contact.customerPhone, contact.deliveryAddress],
  );
  const orderId = orderRows[0].id;
  // Post attribution (05-post-attribution.sql): if this conversation
  // started as a comment on a scheduled post, stamp order_id onto that
  // attribution row so per-post analytics counts the order. Best-effort
  // — a failure must not fail the order (analytics also counts orders
  // via orders.conversation_id).
  try {
    await linkOrderToAttribution(db, workspaceId, orderId, conversationId);
  } catch (err) {
    console.error('[tool:create_order] post attribution link failed:', (err as Error).message);
  }
  for (const item of priced) {
    await db.query(
      'INSERT INTO order_items (workspace_id, order_id, product_id, quantity, price_paisa) VALUES ($1, $2, $3, $4, $5)',
      [workspaceId, orderId, item.productId, item.quantity, item.pricePaisa],
    );
  }
  await db.query(
    "INSERT INTO order_events (workspace_id, order_id, from_status, to_status, note) VALUES ($1, $2, NULL, 'pending', 'Order created by AI')",
    [workspaceId, orderId],
  );
  // Phase 2: decrement stock for the ordered items. A stock failure must
  // not fail the order itself — it is logged and the team is told.
  let outOfStock: { id: string; name: string }[] = [];
  try {
    const hitZero = await decrementStockForOrderItems(db, workspaceId, orderId);
    outOfStock = hitZero.map((p) => ({ id: p.id, name: p.name }));
  } catch (err) {
    console.error('[tool:create_order] stock decrement failed:', (err as Error).message);
  }
  // Requirement B + C: the order confirmation carries the delivery
  // charge from the owner's configured rules (never hardcoded) and the
  // grand total (products + delivery) — the amount the customer pays.
  const grandTotalPaisa = totalPaisa + deliveryChargePaisa;
  const confirmationContact = {
    name: contact.customerName,
    phone: contact.customerPhone,
    address: contact.deliveryAddress,
  };
  const invoiceUrl = `${config.webAppUrl.replace(/\/$/, '')}/invoice/${invoiceToken}`;
  return {
    orderId,
    orderNumber,
    invoiceToken,
    invoiceUrl,
    totalPaisa,
    deliveryChargePaisa,
    grandTotalPaisa,
    billText: buildBillText(orderId, lines, totalPaisa, confirmationContact),
    confirmationText: buildConfirmationText(lines, totalPaisa, deliveryChargePaisa, confirmationContact, { orderNumber, invoiceUrl }),
    outOfStock,
    customerName: contact.customerName,
    customerPhone: contact.customerPhone,
    deliveryAddress: contact.deliveryAddress,
  };
};

/**
 * 4. Update an order — ONLY while it is pending or on_hold (before confirm).
 * Later statuses must go to a human.
 */
const updateOrder: ToolFn = async (db, workspaceId, args) => {
  const orderId = asString(args.orderId);
  const { rows } = await db.query<{ id: string; status: string }>(
    'SELECT id, status FROM orders WHERE workspace_id = $1 AND id = $2',
    [workspaceId, orderId],
  );
  if (rows.length === 0) return { error: 'Order not found' };
  const status = rows[0].status;
  if (status !== 'pending' && status !== 'on_hold') {
    return {
      error: `Order is already ${status} — it can no longer be changed by AI. Please ask a human to help.`,
      needsHuman: true,
    };
  }
  // Optional status move (pending <-> on_hold, or approve).
  if (typeof args.status === 'string') {
    const next = args.status as string;
    const allowed: Record<string, string[]> = { pending: ['on_hold', 'approved'], on_hold: ['approved', 'pending'] };
    if (!(allowed[status] ?? []).includes(next)) {
      return { error: `Cannot move order from ${status} to ${next}` };
    }
    await db.query(
      'UPDATE orders SET status = $1, updated_at = now() WHERE workspace_id = $2 AND id = $3',
      [next, workspaceId, orderId],
    );
    await db.query(
      'INSERT INTO order_events (workspace_id, order_id, from_status, to_status) VALUES ($1, $2, $3, $4)',
      [workspaceId, orderId, status, next],
    );
    return { orderId, status: next };
  }
  // Optional item replacement (re-priced from the products table).
  if (Array.isArray(args.items)) {
    let totalPaisa = 0;
    const priced: { productId: string; quantity: number; pricePaisa: number }[] = [];
    for (const raw of args.items as Record<string, unknown>[]) {
      const productId = asString(raw.productId);
      const quantity = Math.max(1, Math.floor(Number(raw.quantity ?? 1)));
      const { rows: pRows } = await db.query<{ id: string; price_paisa: number }>(
        'SELECT id, price_paisa FROM products WHERE workspace_id = $1 AND id = $2',
        [workspaceId, productId],
      );
      if (pRows.length === 0) return { error: `Product not found: ${productId}` };
      totalPaisa += Number(pRows[0].price_paisa) * quantity;
      priced.push({ productId: pRows[0].id, quantity, pricePaisa: Number(pRows[0].price_paisa) });
    }
    await db.query('DELETE FROM order_items WHERE workspace_id = $1 AND order_id = $2', [workspaceId, orderId]);
    for (const item of priced) {
      await db.query(
        'INSERT INTO order_items (workspace_id, order_id, product_id, quantity, price_paisa) VALUES ($1, $2, $3, $4, $5)',
        [workspaceId, orderId, item.productId, item.quantity, item.pricePaisa],
      );
    }
    await db.query(
      'UPDATE orders SET total_paisa = $1, updated_at = now() WHERE workspace_id = $2 AND id = $3',
      [totalPaisa, workspaceId, orderId],
    );
    return { orderId, totalPaisa };
  }
  return { error: 'update_order needs status or items' };
};

/**
 * 4b. Request an order cancellation — the ONLY way the AI handles a
 * cancel. The AI NEVER cancels an order itself (update_order cannot
 * move an order to 'cancelled' — see tool 4). This tool creates a
 * PENDING cancel request + an owner notification (bell + order view)
 * and returns the exact professional reply for the customer
 * ("আমরা প্রতিনিধির কাছে অর্ডার ক্যান্সেলের জন্য অনুরোধ করছি") — the
 * order stays in its current status until the owner approves it.
 * Delivered / already-cancelled orders get an honest reply and NO
 * request. A repeat ask returns the existing pending request.
 */
const requestOrderCancellation: ToolFn = async (db, workspaceId, args) => {
  const customerId = asString(args.customerId);
  const conversationId = asString(args.conversationId) || null;
  if (!customerId) return { error: 'request_order_cancellation needs customerId' };
  const result = await requestOrderCancellationService(db, workspaceId, {
    customerId,
    conversationId,
    reason: asString(args.reason),
    orderNumber: asString(args.orderNumber) || null,
  });
  return {
    cancelOutcome: result.outcome,
    cancelRequestCreated: result.created,
    requestId: result.requestId,
    orderId: result.orderId,
    orderNumber: result.orderNumber,
    orderStatus: result.orderStatus,
    replyText: result.replyText,
  };
};

/**
 * 5. Coupons — Phase 2: validate a coupon row if one exists, otherwise say
 * coupons are not available. NEVER invent a discount.
 */
const applyCoupon: ToolFn = async (db, workspaceId, args) => {
  const code = asString(args.code).trim();
  if (!code) return { error: 'apply_coupon needs code' };
  const { rows } = await db.query<{ code: string; type: string; value: number; expires_at: string | null }>(
    'SELECT code, type, value, expires_at FROM coupons WHERE workspace_id = $1 AND code = $2',
    [workspaceId, code],
  );
  if (rows.length === 0) {
    return { available: false, message: 'এই কুপনটি নেই। ডিসকাউন্টের জন্য মানুষের সাথে কথা বলুন।' };
  }
  const coupon = rows[0];
  if (coupon.expires_at && new Date(coupon.expires_at).getTime() < Date.now()) {
    return { available: false, message: 'কুপনের মেয়াদ শেষ হয়ে গেছে।' };
  }
  return { available: true, code: coupon.code, type: coupon.type, value: Number(coupon.value) };
};

/** 6. Stock check — price and stock from the products table only. */
const checkStock: ToolFn = async (db, workspaceId, args) => {
  const productId = asString(args.productId);
  const q = asString(args.q ?? args.name);
  const { rows } = await db.query<{ id: string; name: string; price_paisa: number; stock: number }>(
    productId
      ? 'SELECT id, name, price_paisa, stock FROM products WHERE workspace_id = $1 AND id = $2'
      : 'SELECT id, name, price_paisa, stock FROM products WHERE workspace_id = $1 AND name ILIKE $2 LIMIT 5',
    productId ? [workspaceId, productId] : [workspaceId, `%${q}%`],
  );
  if (rows.length === 0) return { error: 'Product not found' };
  return { products: rows };
};

/**
 * 7. Parcel tracking — Phase 1: reads the shipments table if a shipment
 * exists; otherwise says tracking is not yet connected (courier booking is
 * Phase 2 — see shipments/couriers stub note in agent.ts).
 */
const trackParcel: ToolFn = async (db, workspaceId, args) => {
  const orderId = asString(args.orderId);
  if (!orderId) return { error: 'track_parcel needs orderId' };
  const { rows } = await db.query<{ courier: string | null; tracking_code: string | null; status: string | null }>(
    'SELECT courier, tracking_code, status FROM shipments WHERE workspace_id = $1 AND order_id = $2 ORDER BY created_at DESC LIMIT 1',
    [workspaceId, orderId],
  );
  if (rows.length === 0) {
    return { connected: false, message: 'এই অর্ডারের ট্র্যাকিং এখনো সংযুক্ত হয়নি। কুরিয়ার সংযোগ ফেজ ২-তে আসবে।' };
  }
  return { connected: true, shipment: rows[0] };
};

/** 8. Create a support ticket + hand the chat to a human. */
const createTicket: ToolFn = async (db, workspaceId, args) => {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO tickets (workspace_id, conversation_id, customer_id, reason, status)
     VALUES ($1, $2, $3, $4, 'open') RETURNING id`,
    [
      workspaceId,
      asString(args.conversationId) || null,
      asString(args.customerId) || null,
      asString(args.reason) || 'AI could not answer',
    ],
  );
  return { ticketId: rows[0].id };
};

/** 9. Create a lead for a potential customer. */
const createLead: ToolFn = async (db, workspaceId, args) => {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO leads (workspace_id, customer_id, need, follow_up_at)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [
      workspaceId,
      asString(args.customerId) || null,
      asString(args.need) || null,
      (args.followUpAt as string | undefined) ?? null,
    ],
  );
  return { leadId: rows[0].id };
};

/** 10. Search the knowledge book. */
const searchKnowledge: ToolFn = async (db, workspaceId, args) => {
  const q = asString(args.q ?? args.query);
  if (!q) return { error: 'search_knowledge needs q' };
  const { rows } = await db.query<{ title: string | null; body: string }>(
    `SELECT title, body FROM knowledge_items
     WHERE workspace_id = $1 AND (title ILIKE $2 OR body ILIKE $2) LIMIT 5`,
    [workspaceId, `%${q}%`],
  );
  return { items: rows };
};

export const tools: Record<string, ToolFn> = {
  search_products: searchProducts,
  send_product_cards: sendProductCards,
  send_product_photos: sendProductPhotos,
  create_order: createOrder,
  update_order: updateOrder,
  request_order_cancellation: requestOrderCancellation,
  apply_coupon: applyCoupon,
  check_stock: checkStock,
  track_parcel: trackParcel,
  create_ticket: createTicket,
  create_lead: createLead,
  search_knowledge: searchKnowledge,
  /** Phase 2: image product matching (stub embedding provider — never fakes a match). */
  match_product_by_image: matchProductByImage,
};

export async function runTool(
  db: ToolDb,
  workspaceId: string,
  name: string,
  args: ToolArgs,
): Promise<ToolResult> {
  const fn = tools[name];
  if (!fn) return { error: `Unknown tool: ${name}` };
  try {
    return await fn(db, workspaceId, args);
  } catch (err) {
    console.error(`[tool:${name}]`, err);
    return { error: 'Tool failed — hand to a human' };
  }
}
