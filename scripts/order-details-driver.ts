// Driver for verify-order-details.mjs — tests the AI create_order tool
// DIRECTLY against the same PGlite dir the verifier's API boot uses.
// Run AFTER the API boot stops (PGlite is single-process; the API holds
// the lock while it runs), with:
//   USE_PGLITE=true PGLITE_DATA_DIR=<dir> npx tsx scripts/order-details-driver.ts <workspaceId> <jeansId> <tshirtId>
// Prints one DRIVER_RESULT JSON line for the verifier to parse.
// No secrets are printed.
import { pool } from '../apps/api/src/db/pool';
import { runTool } from '../apps/api/src/ai-agent/tools';

const [workspaceId, jeansId, tshirtId] = process.argv.slice(2);
if (!workspaceId || !jeansId || !tshirtId) {
  console.error('usage: order-details-driver.ts <workspaceId> <jeansId> <tshirtId>');
  process.exit(2);
}

const out: Record<string, unknown> = {};

async function main(): Promise<void> {
  // Two fresh customers with NO stored contact (phone/address NULL).
  const c2 = await pool.query(
    `INSERT INTO customers (workspace_id, name, channel_identities) VALUES ($1, 'Tool Test Customer', '{}'::jsonb) RETURNING id`,
    [workspaceId],
  );
  const customer2 = c2.rows[0].id as string;
  const c3 = await pool.query(
    `INSERT INTO customers (workspace_id, name, channel_identities) VALUES ($1, 'Legacy Customer', '{}'::jsonb) RETURNING id`,
    [workspaceId],
  );
  const customer3 = c3.rows[0].id as string;
  out.customer2 = customer2;
  out.customer3 = customer3;

  // (1) Tool WITHOUT contact must REFUSE — never create a contact-less order.
  const refused = await runTool(
    pool as never,
    workspaceId,
    'create_order',
    { customerId: customer2, items: [{ productId: jeansId, quantity: 1 }] },
  );
  out.toolRefused = typeof refused.error === 'string' && refused.error.length > 0;
  out.toolRefusedMissingPhone = refused.missingPhone === true;
  out.toolRefusedMissingAddress = refused.missingAddress === true;
  out.toolRefusedError = refused.error ?? null;
  const noOrder = await pool.query('SELECT id FROM orders WHERE workspace_id = $1 AND customer_id = $2', [workspaceId, customer2]);
  out.toolRefusedCreatedNothing = noOrder.rows.length === 0;

  // (2) Tool WITH contact must create the order + snapshot + store on customer.
  const created = await runTool(
    pool as never,
    workspaceId,
    'create_order',
    {
      customerId: customer2,
      items: [{ productId: jeansId, quantity: 1 }],
      customerName: 'Tool Test Customer',
      customerPhone: '01700000002',
      deliveryAddress: 'Tool Test Road 2, Dhaka',
    },
  );
  out.toolCreatedOrderId = typeof created.orderId === 'string' ? created.orderId : null;
  out.toolCreatedTotal = created.totalPaisa ?? null;
  out.toolBillHasAddress = typeof created.billText === 'string' && (created.billText as string).includes('Tool Test Road 2, Dhaka');
  out.toolBillHasPhone = typeof created.billText === 'string' && (created.billText as string).includes('01700000002');
  if (typeof created.orderId === 'string') {
    const o = await pool.query(
      'SELECT customer_name, customer_phone, delivery_address, total_paisa FROM orders WHERE id = $1',
      [created.orderId],
    );
    const row = o.rows[0] as Record<string, unknown>;
    out.toolOrderSnapshot = row ?? null;
    const cu = await pool.query('SELECT phone, address FROM customers WHERE id = $1', [customer2]);
    out.toolCustomerStored = cu.rows[0] ?? null;
  }

  // (3) Legacy order: created the OLD way (no snapshot columns) for a
  // customer with no stored contact — the shape of the 2 live orders.
  // The Orders pages must show 'দেওয়া হয়নি' for its phone/address.
  const leg = await pool.query(
    `INSERT INTO orders (workspace_id, customer_id, source, status, payment_status, total_paisa)
     VALUES ($1, $2, 'ai', 'pending', 'unpaid', 50000) RETURNING id`,
    [workspaceId, customer3],
  );
  const legacyId = leg.rows[0].id as string;
  await pool.query(
    'INSERT INTO order_items (workspace_id, order_id, product_id, quantity, price_paisa) VALUES ($1, $2, $3, 1, 50000)',
    [workspaceId, legacyId, jeansId],
  );
  out.legacyOrderId = legacyId;
  void tshirtId;
  console.log(`DRIVER_RESULT ${JSON.stringify(out)}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('DRIVER ERR', err);
    process.exit(1);
  });
