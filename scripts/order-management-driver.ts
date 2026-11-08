/**
 * Driver for the AI create_order tool (order management).
 * Usage: npx tsx ../../scripts/order-management-driver.ts <workspaceId> <customerId> <conversationId> <productId>
 * with USE_PGLITE=true + PGLITE_DATA_DIR pointing at the verifier boot's
 * data dir. Calls runTool('create_order') with a full Dhaka contact and
 * prints the result as JSON — the verifier checks the auto order number
 * (ASI-0002, after the API-created ASI-0001) and the invoice link in the
 * confirmation text.
 */
import { pool } from '../apps/api/src/db/pool';
import { runTool } from '../apps/api/src/ai-agent/tools';

async function main() {
  const [workspaceId, customerId, conversationId, productId] = process.argv.slice(2);
  if (!workspaceId || !customerId || !productId) {
    console.error('usage: order-management-driver.ts <workspaceId> <customerId> <conversationId> <productId>');
    process.exit(2);
  }
  const toolDb = pool as unknown as Parameters<typeof runTool>[0];
  const result = await runTool(toolDb, workspaceId, 'create_order', {
    customerId,
    conversationId: conversationId || null,
    items: [{ productId, quantity: 1 }],
    // REGRESSION (name-overwrite bug): the order is for a DIFFERENT
    // recipient ("Rina") than the customer's Facebook name
    // ("Order Test Customer"). The order snapshot must carry "Rina",
    // but the customer row must keep its Facebook name.
    customerName: 'Rina',
    customerPhone: '01700000001',
    deliveryAddress: 'House 1, Road 2, Dhanmondi, Dhaka',
  });
  // Read back what the order flow left behind: the order's recipient
  // name and the customer row's name (must be unchanged).
  const cust = await pool.query<{ name: string | null }>('SELECT name FROM customers WHERE id = $1', [customerId]);
  const ord = await pool.query<{ customer_name: string | null }>(
    'SELECT customer_name FROM orders WHERE workspace_id = $1 AND order_number = $2',
    [workspaceId, (result as { orderNumber?: string }).orderNumber ?? ''],
  );
  console.log(JSON.stringify({
    ...result,
    customerNameAfter: cust.rows[0]?.name ?? null,
    orderCustomerName: ord.rows[0]?.customer_name ?? null,
  }));
  await pool.end().catch(() => undefined);
  process.exit(0);
}

main().catch((err) => {
  console.error('DRIVER FAILED:', (err as Error).message);
  process.exit(1);
});
