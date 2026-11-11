import { invalidateWorkspacePromptCache } from '../ai-agent/gemini-cache';

/**
 * Stock decrement for orders (Phase 2).
 *
 * The coordinator wires this into the AI `create_order` tool — do NOT call
 * it from tools.ts here. The HTTP order-create handler calls it directly.
 *
 * `db` is any workspace-scoped query surface with the same shape as the
 * AI tool DB (ToolDb) or a pg client wrapped to that shape. Every query
 * filters by workspace_id. Stock never goes below 0.
 */

/** Minimal query surface: same shape as the AI tools' ToolDb. */
export interface StockDb {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number }>;
}

export interface OutOfStockProduct {
  id: string;
  name: string;
  stock: number;
}

interface OrderItemRow {
  product_id: string;
  quantity: number;
  name: string;
  stock: number;
}

/**
 * Decrement products.stock by each order_item quantity for one order.
 * Returns the products whose stock hit exactly 0 (callers notify the team).
 */
export async function decrementStockForOrderItems(
  db: StockDb,
  workspaceId: string,
  orderId: string,
): Promise<OutOfStockProduct[]> {
  const { rows: items } = await db.query<OrderItemRow>(
    `SELECT oi.product_id, oi.quantity, p.name, p.stock
     FROM order_items oi
     JOIN products p ON p.id = oi.product_id AND p.workspace_id = $1
     WHERE oi.workspace_id = $1 AND oi.order_id = $2`,
    [workspaceId, orderId],
  );
  const outOfStock: OutOfStockProduct[] = [];
  for (const item of items) {
    const { rows } = await db.query<{ id: string; name: string; stock: number }>(
      `UPDATE products SET stock = GREATEST(0, stock - $2), updated_at = now()
       WHERE workspace_id = $1 AND id = $3
       RETURNING id, name, stock`,
      [workspaceId, Math.max(0, Math.floor(item.quantity)), item.product_id],
    );
    if (rows.length > 0 && Number(rows[0].stock) === 0) {
      outOfStock.push({ id: rows[0].id, name: rows[0].name, stock: 0 });
    }
  }
  // Stock is part of the AI's cached prompt prefix — an order changes
  // the numbers the next reply quotes, so drop the cache (no-op when
  // no cache exists). Only when stock actually moved.
  if (items.length > 0) await invalidateWorkspacePromptCache(workspaceId);
  return outOfStock;
}
