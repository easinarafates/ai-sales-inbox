/**
 * Public invoice (order management, 2026-11-08).
 *
 * GET /api/public/invoice/:token — the link the customer clicks to view
 * their order's invoice. NO login: the unguessable invoice_token IS the
 * auth (32 hex chars). Only this one order's public fields are returned
 * — never the workspace id, never other orders, never the customer's
 * full history. A wrong token is a plain 404, no hint about what exists.
 */
import { Router, type Response } from 'express';
import { pool } from '../db/pool';
import { deliveryEstimateText, zoneOfAddress } from './order-helpers';
import { formatTaka } from './bill';

export const publicInvoiceRouter = Router();

export const PAYMENT_METHOD_BN: Record<string, string> = {
  cod: 'ক্যাশ অন ডেলিভারি',
  advance: 'অ্যাডভান্স পেমেন্ট',
  fifty_fifty: '৫০% অ্যাডভান্স, ৫০% ডেলিভারিতে',
};

publicInvoiceRouter.get('/invoice/:token', async (req, res: Response) => {
  const token = String(req.params.token ?? '').trim();
  if (!token || token.length < 16) {
    res.status(404).json({ error: 'Invoice not found' });
    return;
  }
  const { rows } = await pool.query(
    `SELECT o.id, o.order_number, o.status, o.payment_status, o.payment_method,
            o.total_paisa, o.delivery_charge_paisa, o.created_at,
            o.customer_name, o.customer_phone, o.delivery_address,
            w.name AS shop_name
     FROM orders o JOIN workspaces w ON w.id = o.workspace_id
     WHERE o.invoice_token = $1 LIMIT 1`,
    [token],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Invoice not found' });
    return;
  }
  const o = rows[0];
  const zone = zoneOfAddress(o.delivery_address as string | null);
  const { rows: items } = await pool.query(
    `SELECT oi.quantity, oi.price_paisa, p.name AS product_name
     FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = $1 ORDER BY oi.created_at ASC`,
    [o.id],
  );
  const totalPaisa = Number(o.total_paisa ?? 0);
  const deliveryChargePaisa = Number(o.delivery_charge_paisa ?? 0);
  res.json({
    orderNumber: o.order_number,
    shopName: o.shop_name,
    status: o.status,
    paymentStatus: o.payment_status,
    paymentMethod: o.payment_method,
    paymentMethodLabel: PAYMENT_METHOD_BN[String(o.payment_method ?? 'cod')] ?? o.payment_method,
    customerName: o.customer_name,
    customerPhone: o.customer_phone,
    deliveryAddress: o.delivery_address,
    zone: zone.label,
    insideDhaka: zone.insideDhaka,
    items: items.map((it) => ({
      name: it.product_name ?? 'আইটেম',
      quantity: Number(it.quantity ?? 1),
      pricePaisa: Number(it.price_paisa ?? 0),
      lineTotalPaisa: Number(it.quantity ?? 1) * Number(it.price_paisa ?? 0),
    })),
    totalPaisa,
    deliveryChargePaisa,
    grandTotalPaisa: totalPaisa + deliveryChargePaisa,
    grandTotalText: formatTaka(totalPaisa + deliveryChargePaisa),
    deliveryEstimate: deliveryEstimateText(String(o.created_at), zone.insideDhaka),
    createdAt: o.created_at,
  });
});
