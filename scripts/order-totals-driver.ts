/**
 * Driver for verify-order-totals.mjs — exercises the web money helpers
 * with the EXACT shapes production Postgres returns: bigint columns
 * (orders.total_paisa, delivery_charge_paisa) arrive as STRINGS via
 * node-postgres. The helpers must still add numerically.
 *
 * Run:  npx tsx scripts/order-totals-driver.ts
 * Prints one JSON line per order: {orderNumber, displayPaisa, display}
 */
import { orderTotalPaisa, deliveryChargePaisa, formatTaka } from "../apps/web/lib/api";

// Stored values from the LIVE Neon DB (gd_arafat), as pg returns them
// (strings). Expected display = items + delivery, in paisa.
const ORDERS: Array<{ orderNumber: string; total_paisa: string; delivery_charge_paisa: string; expectedPaisa: number }> = [
  { orderNumber: "ASI-0001", total_paisa: "40000", delivery_charge_paisa: "0", expectedPaisa: 40000 },
  { orderNumber: "ASI-0002", total_paisa: "50000", delivery_charge_paisa: "0", expectedPaisa: 50000 },
  { orderNumber: "ASI-0003", total_paisa: "40000", delivery_charge_paisa: "0", expectedPaisa: 40000 },
  { orderNumber: "ASI-0004", total_paisa: "50000", delivery_charge_paisa: "10000", expectedPaisa: 60000 },
  { orderNumber: "ASI-0005", total_paisa: "50000", delivery_charge_paisa: "10000", expectedPaisa: 60000 },
  { orderNumber: "ASI-0006", total_paisa: "50000", delivery_charge_paisa: "10000", expectedPaisa: 60000 },
  { orderNumber: "ASI-0007", total_paisa: "40000", delivery_charge_paisa: "10000", expectedPaisa: 50000 },
  { orderNumber: "ASI-0008", total_paisa: "60000", delivery_charge_paisa: "10000", expectedPaisa: 70000 },
  { orderNumber: "ASI-0011", total_paisa: "50000", delivery_charge_paisa: "13000", expectedPaisa: 63000 },
];

for (const o of ORDERS) {
  const displayPaisa = orderTotalPaisa(o as never) + deliveryChargePaisa(o as never);
  console.log(JSON.stringify({
    orderNumber: o.orderNumber,
    displayPaisa,
    display: formatTaka(displayPaisa),
    expectedPaisa: o.expectedPaisa,
    // What the OLD code produced (raw string + string), for contrast.
    oldDisplay: formatTaka((o.total_paisa as unknown as number) + (o.delivery_charge_paisa as unknown as number)),
  }));
}
