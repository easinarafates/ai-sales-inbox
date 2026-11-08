/**
 * Driver for the request_order_cancellation tool (order cancellation).
 * Usage: npx tsx ../../scripts/cancel-driver.ts <workspaceId> <customerId> <conversationId>
 * with USE_PGLITE=true + PGLITE_DATA_DIR pointing at the verifier boot's
 * data dir. Calls runTool('request_order_cancellation') four times and
 * prints the outcomes as JSON:
 *  1. First ask → 'created' (a pending request + owner notification).
 *  2. Repeat ask → 'already_pending' (no duplicate request).
 *  3. Order set to 'delivered' → 'already_delivered' (honest, no request).
 *  4. Order set to 'cancelled' → 'already_cancelled' (honest, no request).
 * The order status is restored to 'pending' at the end.
 */
import { pool } from '../apps/api/src/db/pool';
import { runTool } from '../apps/api/src/ai-agent/tools';

async function main() {
  const [workspaceId, customerId, conversationId] = process.argv.slice(2);
  if (!workspaceId || !customerId) {
    console.error('usage: cancel-driver.ts <workspaceId> <customerId> <conversationId>');
    process.exit(2);
  }
  const toolDb = pool as unknown as Parameters<typeof runTool>[0];
  const ask = () => runTool(toolDb, workspaceId, 'request_order_cancellation', {
    customerId,
    conversationId: conversationId || null,
    reason: 'অর্ডার ক্যান্সেল করুন',
  });
  const first = await ask();
  const second = await ask();
  const orderId = (first as { orderId?: string }).orderId ?? '';
  // Edge cases, by moving the order's status directly (the tool must
  // refuse honestly and create NO new request in either case).
  await pool.query("UPDATE orders SET status = 'delivered' WHERE id = $1", [orderId]);
  const delivered = await ask();
  await pool.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [orderId]);
  const cancelled = await ask();
  // Restore the order to pending so the data dir is tidy.
  await pool.query("UPDATE orders SET status = 'pending' WHERE id = $1", [orderId]);
  const reqs = await pool.query<{ status: string }>(
    'SELECT status FROM order_cancel_requests WHERE workspace_id = $1 AND order_id = $2 ORDER BY created_at ASC',
    [workspaceId, orderId],
  );
  console.log(JSON.stringify({
    first, second, delivered, cancelled,
    requestStatuses: reqs.rows.map((r) => r.status),
  }));
  await pool.end().catch(() => undefined);
  process.exit(0);
}

main().catch((err) => {
  console.error('DRIVER FAILED:', (err as Error).message);
  process.exit(1);
});
