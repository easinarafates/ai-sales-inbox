/**
 * Customer memory — the AI's view of a customer's order history.
 *
 * When a customer asks "আমার অর্ডারটা কোথায়" ("where is my order"), the
 * AI must answer from REAL order data, never invent an order or a status.
 * This module is the single source for that data: the customer's order
 * summary (total orders, pending count, recent orders with their real
 * order number + Bengali status) goes into the AI's prompt (AgentContext)
 * and into the deterministic demo reply, so both paths answer from the
 * same true numbers.
 *
 * The order number shown is the ASI number (ASI-0001…), never a UUID
 * fragment — that is the number the customer sees on their receipt and
 * invoice. Orders made before migration 29 have no number; those fall
 * back to the short id, and the summary says so honestly.
 */

export interface CustomerOrderSummary {
  totalOrders: number;
  /** Orders not yet delivered/cancelled/returned (pending, on_hold, approved, processing, ready, ready_to_ship, in_transit). */
  pendingCount: number;
  recent: {
    orderNumber: string;
    status: string;
    statusBn: string;
    totalPaisa: number;
    createdAt: string;
  }[];
}

/** Bengali labels for the 12 order statuses — same wording as the web Orders page (apps/web/lib/orderStatus.tsx). */
export const ORDER_STATUS_BN: Record<string, string> = {
  pending: 'অপেক্ষমাণ',
  on_hold: 'হোল্ডে',
  approved: 'অনুমোদিত',
  processing: 'প্রস্তুত হচ্ছে',
  ready: 'রেডি',
  ready_to_ship: 'পাঠাতে প্রস্তুত',
  in_transit: 'কুরিয়ারে',
  delivered: 'ডেলিভারি হয়েছে',
  cancelled: 'বাতিল',
  returned: 'রিটার্ন',
  damaged: 'ক্ষতিগ্রস্ত',
  in_store: 'স্টোরে আছে',
};

export function orderStatusBn(status: string): string {
  return ORDER_STATUS_BN[status] ?? status;
}

/** Statuses that still need action (the order is not finished yet). */
const PENDING_STATUSES = ['pending', 'on_hold', 'approved', 'processing', 'ready', 'ready_to_ship', 'in_transit'];

export interface OrderSummaryDb {
  /** Non-generic on purpose: the pool helper, a ToolDb and a pg client all
   * satisfy this (their generic query defaults to Record rows). */
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Load a customer's real order history. Never invents anything — an empty result means "no orders yet". */
export async function getCustomerOrderSummary(
  db: OrderSummaryDb,
  workspaceId: string,
  customerId: string,
): Promise<CustomerOrderSummary> {
  const { rows: countRows } = await db.query(
    `SELECT COUNT(*)::text AS total,
            COUNT(*) FILTER (WHERE status = ANY($3))::text AS pending
     FROM orders WHERE workspace_id = $1 AND customer_id = $2`,
    [workspaceId, customerId, PENDING_STATUSES],
  );
  const counts = countRows[0] as unknown as { total: string; pending: string };
  const { rows: recentRows } = await db.query(
    `SELECT id, order_number, status, total_paisa, created_at FROM orders
     WHERE workspace_id = $1 AND customer_id = $2
     ORDER BY created_at DESC LIMIT 5`,
    [workspaceId, customerId],
  );
  const recent = recentRows as unknown as {
    id: string;
    order_number: string | null;
    status: string;
    total_paisa: number;
    created_at: string;
  }[];
  return {
    totalOrders: Number(counts?.total ?? 0),
    pendingCount: Number(counts?.pending ?? 0),
    recent: recent.map((r) => ({
      orderNumber: r.order_number ?? `অর্ডার ${String(r.id).slice(0, 8)}`,
      status: r.status,
      statusBn: orderStatusBn(r.status),
      totalPaisa: Number(r.total_paisa ?? 0),
      createdAt: r.created_at,
    })),
  };
}

/** Render the summary as Bengali lines for the AI prompt / demo reply. Real data only. */
export function formatOrderSummaryBn(summary: CustomerOrderSummary): string {
  if (summary.totalOrders === 0) return 'এই কাস্টমারের এখনো কোনো অর্ডার নেই।';
  const lines = [
    `মোট অর্ডার: ${summary.totalOrders}টি, অপেক্ষমাণ: ${summary.pendingCount}টি।`,
    ...summary.recent.map(
      (o) => `• ${o.orderNumber} — ${o.statusBn}, মোট ৳${(o.totalPaisa / 100).toLocaleString('en-IN')}`,
    ),
  ];
  return lines.join('\n');
}

/**
 * Does this message ask about the customer's order status?
 * Bengali ("আমার অর্ডারটা কোথায়", "অর্ডার স্ট্যাটাস", "পার্সেল কোথায়"),
 * English ("my order", "order status", "where is my order") and Banglish
 * ("amar order kothay", "order kobe asbe"). A placement request
 * ("অর্ডার করতে চাই", "order dibo") is NOT a status question.
 */
export function isOrderStatusQuestion(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t) return false;
  // Placement phrases win: "অর্ডার করতে চাই / order dibo / order korbo"
  // is an order, not a status question.
  if (/অর্ডার\s*(করতে|দিতে|করব|দিবো|দিব|চাই)|order\s*(dibo|korbo|korte|chai|place|korte chai)/i.test(t)) return false;
  return (
    /আমার\s*অর্ডার|অর্ডারটা|অর্ডারটি|অর্ডারের\s*(অবস্থা|স্ট্যাটাস|খবর)|পার্সেল.*(কোথায়|কোথায়|অবস্থা|স্ট্যাটাস)|অর্ডার.*(কোথায়|কোথায়|কখন|আসবে|পাব|স্ট্যাটাস|অবস্থা)/i.test(t) ||
    /\bmy\s+order\b|\border\s+status\b|\bwhere\s+(is\s+)?my\s+order\b|\btrack\s+(my\s+)?(order|parcel)\b/i.test(t) ||
    /amar\s+order.*(kothay|kobe|status|kothai)|order.*(kothay|kothai|kobe asbe)/i.test(t)
  );
}
