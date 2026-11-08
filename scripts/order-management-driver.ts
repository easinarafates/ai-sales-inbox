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
    customerName: 'Order Test Customer',
    customerPhone: '01700000001',
    deliveryAddress: 'House 1, Road 2, Dhanmondi, Dhaka',
  });
  console.log(JSON.stringify(result));
  await pool.end().catch(() => undefined);
  process.exit(0);
}

main().catch((err) => {
  console.error('DRIVER FAILED:', (err as Error).message);
  process.exit(1);
});
