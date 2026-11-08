/**
 * Order cancellation requests (2026-11-08, user report).
 *
 * The AI must NEVER cancel an order on its own. When a customer asks to
 * cancel, the AI (deterministic handler in ai-agent/agent.ts, or the
 * request_order_cancellation tool) calls requestOrderCancellation here:
 *  - a PENDING cancel request is created (at most one per order — the
 *    partial unique index enforces it, and a repeat ask returns the
 *    existing request instead of a duplicate);
 *  - the owner gets a notification (bell + order view) — "[Customer]
 *    (order ASI-XXXX) wants to cancel the order";
 *  - the ORDER ITSELF IS NOT CANCELLED. It stays in its current status
 *    until the owner approves (orders/routes.ts: approve → status
 *    'cancelled' + the customer is told) or declines (order unchanged,
 *    the owner handles it manually).
 *
 * Edge cases, all honest, no request created:
 *  - no active order at all → 'no_order';
 *  - the order is already delivered → 'already_delivered';
 *  - the order is already cancelled → 'already_cancelled';
 *  - the order is returned / damaged → 'not_cancellable'.
 *
 * The reply text is built here (with the customer's salutation) so the
 * AI sends the exact professional wording — "আমরা প্রতিনিধির কাছে
 * অর্ডার ক্যান্সেলের জন্য অনুরোধ করছি" — instead of rewording it.
 */
import { createNotification } from '../notifications/service';
import { genderSalutation, normalizeCustomerGender } from '../customers/gender';

export interface CancelDb {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
}

export type CancelOutcome =
  | 'created'
  | 'already_pending'
  | 'no_order'
  | 'already_delivered'
  | 'already_cancelled'
  | 'not_cancellable';

export interface CancelRequestResult {
  outcome: CancelOutcome;
  /** True only when a NEW request row was created. */
  created: boolean;
  requestId: string | null;
  orderId: string | null;
  orderNumber: string | null;
  orderStatus: string | null;
  /** The exact professional reply for the customer (salutation included). */
  replyText: string;
}

/** Statuses an order can still be cancelled from (owner approval pending). */
const CANCELLABLE_STATUSES = [
  'pending', 'on_hold', 'approved', 'processing', 'ready', 'ready_to_ship', 'in_transit', 'in_store',
] as const;

/** Extract an order number (ASI-0001) from the customer's message, if any. */
export function extractOrderNumber(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.match(/ASI-\d{4}/i);
  return m ? m[0].toUpperCase() : null;
}

export async function requestOrderCancellation(
  db: CancelDb,
  workspaceId: string,
  input: { customerId: string; conversationId?: string | null; reason?: string | null; orderNumber?: string | null },
): Promise<CancelRequestResult> {
  const customerId = input.customerId;
  const conversationId = input.conversationId ?? null;
  const reason = (input.reason ?? '').trim().slice(0, 500) || null;

  const { rows: custRows } = await db.query<{ name: string | null; gender: string | null }>(
    'SELECT name, gender FROM customers WHERE workspace_id = $1 AND id = $2',
    [workspaceId, customerId],
  );
  const customerName = custRows[0]?.name ?? 'একজন কাস্টমার';
  const sal = genderSalutation(normalizeCustomerGender(custRows[0]?.gender));
  const prefix = sal ? `${sal}, ` : '';

  // Find the target order: the named one (ASI-XXXX), or the customer's
  // most recent order that can still be cancelled.
  let order: { id: string; order_number: string | null; status: string } | null = null;
  if (input.orderNumber) {
    const { rows } = await db.query<{ id: string; order_number: string | null; status: string }>(
      'SELECT id, order_number, status FROM orders WHERE workspace_id = $1 AND customer_id = $2 AND order_number = $3 ORDER BY created_at DESC LIMIT 1',
      [workspaceId, customerId, input.orderNumber.toUpperCase()],
    );
    order = rows[0] ?? null;
  }
  if (!order) {
    const { rows } = await db.query<{ id: string; order_number: string | null; status: string }>(
      `SELECT id, order_number, status FROM orders
       WHERE workspace_id = $1 AND customer_id = $2
         AND status = ANY($3::text[])
       ORDER BY created_at DESC LIMIT 1`,
      [workspaceId, customerId, [...CANCELLABLE_STATUSES]],
    );
    order = rows[0] ?? null;
  }
  if (!order) {
    // No cancellable order — is there a delivered / cancelled one to
    // explain honestly, or no order at all?
    const { rows: lastRows } = await db.query<{ id: string; order_number: string | null; status: string }>(
      'SELECT id, order_number, status FROM orders WHERE workspace_id = $1 AND customer_id = $2 ORDER BY created_at DESC LIMIT 1',
      [workspaceId, customerId],
    );
    const last = lastRows[0] ?? null;
    if (last?.status === 'delivered') {
      return {
        outcome: 'already_delivered', created: false, requestId: null,
        orderId: last.id, orderNumber: last.order_number, orderStatus: last.status,
        replyText: `${prefix}এই অর্ডারটি (${last.order_number ?? ''}) ইতিমধ্যে ডেলিভার হয়ে গেছে, তাই এটি ক্যান্সেল করা যাবে না। কোনো সমস্যা থাকলে জানাবেন, প্রতিনিধি দেখে নেবেন।`,
      };
    }
    if (last?.status === 'cancelled') {
      return {
        outcome: 'already_cancelled', created: false, requestId: null,
        orderId: last.id, orderNumber: last.order_number, orderStatus: last.status,
        replyText: `${prefix}এই অর্ডারটি (${last.order_number ?? ''}) ইতিমধ্যে ক্যান্সেল করা হয়েছে।`,
      };
    }
    if (last && (last.status === 'returned' || last.status === 'damaged')) {
      return {
        outcome: 'not_cancellable', created: false, requestId: null,
        orderId: last.id, orderNumber: last.order_number, orderStatus: last.status,
        replyText: `${prefix}এই অর্ডারটি (${last.order_number ?? ''}) আর ক্যান্সেল করা যাবে না — এটি ইতিমধ্যে ${last.status === 'returned' ? 'রিটার্ন' : 'ক্ষতিগ্রস্ত'} অবস্থায় আছে। প্রতিনিধি আপনার সাথে যোগাযোগ করবেন।`,
      };
    }
    return {
      outcome: 'no_order', created: false, requestId: null,
      orderId: null, orderNumber: null, orderStatus: null,
      replyText: `${prefix}আপনার কোনো সক্রিয় অর্ডার পাওয়া যায়নি, তাই ক্যান্সেল করার মতো কিছু নেই। অর্ডার নম্বরটি জানালে দেখে নিচ্ছি।`,
    };
  }

  // A pending request already exists for this order — return it, never
  // a duplicate (the partial unique index enforces the same rule).
  const { rows: existingRows } = await db.query<{ id: string }>(
    "SELECT id FROM order_cancel_requests WHERE workspace_id = $1 AND order_id = $2 AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
    [workspaceId, order.id],
  );
  if (existingRows[0]) {
    return {
      outcome: 'already_pending', created: false, requestId: existingRows[0].id,
      orderId: order.id, orderNumber: order.order_number, orderStatus: order.status,
      replyText: `${prefix}আপনার অর্ডার ক্যান্সেলের অনুরোধটি ইতিমধ্যে প্রতিনিধির কাছে পাঠানো হয়েছে — তিনি শীঘ্রই নিশ্চিত করবেন।`,
    };
  }

  const { rows: reqRows } = await db.query<{ id: string }>(
    `INSERT INTO order_cancel_requests (workspace_id, order_id, customer_id, conversation_id, reason, status)
     VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING id`,
    [workspaceId, order.id, customerId, conversationId, reason],
  );
  const requestId = reqRows[0]?.id ?? null;

  // Owner notification (bell + order view): "[Customer] (order ASI-XXXX)
  // wants to cancel the order". Created only when the request is new.
  await createNotification(workspaceId, {
    type: 'cancel_request',
    title: 'অর্ডার ক্যান্সেলের অনুরোধ',
    body: `${customerName} (অর্ডার ${order.order_number ?? ''}) অর্ডারটি ক্যান্সেল করতে চাচ্ছেন — অনুমোদন করলে ক্যান্সেল হবে।`,
    conversationId,
    customerId,
    orderId: order.id,
  });

  return {
    outcome: 'created', created: true, requestId,
    orderId: order.id, orderNumber: order.order_number, orderStatus: order.status,
    replyText: `${prefix}আমরা প্রতিনিধির কাছে আপনার অর্ডার ক্যান্সেলের জন্য অনুরোধ করছি — তিনি শীঘ্রই নিশ্চিত করবেন।`,
  };
}
