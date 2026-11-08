/**
 * Shared courier booking (order management, 2026-11-08).
 *
 * One code path books a courier for an order, used by both:
 *  - POST /api/courier/bookings (env-selected provider), and
 *  - POST /api/orders/:id/send-to-courier (the owner picks a courier:
 *    steadfast / pathao / sundarban).
 *
 * HARD RULE (unchanged): never invent a booking or tracking number.
 * A provider that is not configured throws ProviderNotConfiguredError
 * and NO shipment row is written. A stub booking writes a shipment with
 * status 'awaiting_provider' and NULL tracking — clearly labelled.
 * A real booking writes the courier's own tracking number + booking id,
 * and the order moves to in_transit (the parcel is now with the courier).
 */
import { query, queryOne } from '../db/pool';
import { getDeliveryChargeRules, resolveDeliveryCharge } from '../delivery-charges/service';
import {
  getCourierProvider,
  providerForName,
  type CourierProvider,
  type OrderForBooking,
} from './provider';

export interface BookedShipment {
  id: string;
  order_id: string;
  courier: string | null;
  tracking_code: string | null;
  tracking_number: string | null;
  provider_booking_id: string | null;
  status: string | null;
  created_at: string;
}

export interface BookCourierResult {
  shipment: BookedShipment;
  provider: string;
  providerConfigured: boolean;
  alreadyBooked: boolean;
  message: string;
}

interface OrderRow {
  id: string;
  customer_id: string | null;
  total_paisa: number;
  status: string;
  customer_name: string | null;
  customer_phone: string | null;
  delivery_address: string | null;
}

export async function bookCourierForOrder(
  workspaceId: string,
  orderId: string,
  providerName?: string,
): Promise<BookCourierResult> {
  const order = await queryOne<OrderRow>(
    workspaceId,
    'SELECT id, customer_id, total_paisa, status, customer_name, customer_phone, delivery_address FROM orders WHERE workspace_id = $1 AND id = $2',
    [workspaceId, orderId],
  );
  if (!order) {
    const err = new Error('Order not found') as Error & { status?: number };
    err.status = 404;
    throw err;
  }

  // One shipment per order: return the existing one instead of double-booking.
  const existing = await queryOne<BookedShipment>(
    workspaceId,
    'SELECT id, order_id, courier, tracking_code, tracking_number, provider_booking_id, status, created_at FROM shipments WHERE workspace_id = $1 AND order_id = $2 ORDER BY created_at DESC LIMIT 1',
    [workspaceId, orderId],
  );
  if (existing) {
    return {
      shipment: existing,
      provider: existing.courier ?? 'stub',
      providerConfigured: existing.provider_booking_id !== null,
      alreadyBooked: true,
      message: 'এই অর্ডারের কুরিয়ার বুকিং আগেই করা হয়েছে।',
    };
  }

  const customer = order.customer_id
    ? await queryOne<{ name: string | null; phone: string | null; address: string | null }>(
        workspaceId,
        'SELECT name, phone, address FROM customers WHERE workspace_id = $1 AND id = $2',
        [workspaceId, order.customer_id],
      )
    : null;
  // The order snapshot (taken when the order was placed) is the delivery
  // contact the courier must use; the customer row is only a fallback.
  const deliveryAddress = order.delivery_address ?? customer?.address ?? null;
  // The COD includes the delivery charge from the owner's configured
  // rules (not the hardcoded ৳100/৳130).
  const chargeRules = await getDeliveryChargeRules(
    { query: (text: string, params?: unknown[]) => query(workspaceId, text, params ?? []) },
    workspaceId,
  );
  const { chargePaisa: deliveryChargePaisa } = resolveDeliveryCharge(chargeRules, deliveryAddress);
  const orderForBooking: OrderForBooking = {
    id: order.id,
    customerId: order.customer_id,
    totalPaisa: Number(order.total_paisa),
    status: order.status,
    customerName: order.customer_name ?? customer?.name ?? null,
    customerPhone: order.customer_phone ?? customer?.phone ?? null,
    customerAddress: deliveryAddress,
    deliveryChargePaisa,
  };

  // The owner picks the courier in the order panel; the courier page's
  // generic booking uses the env-selected provider.
  const provider: CourierProvider = providerName ? providerForName(providerName) : getCourierProvider();
  const booking = await provider.createBooking(orderForBooking);

  const { rows } = await query<BookedShipment>(
    workspaceId,
    `INSERT INTO shipments (workspace_id, order_id, courier, tracking_code, tracking_number, provider_booking_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, order_id, courier, tracking_code, tracking_number, provider_booking_id, status, created_at`,
    [
      workspaceId,
      order.id,
      provider.name,
      booking.trackingNumber,
      booking.trackingNumber,
      booking.providerBookingId,
      booking.status,
    ],
  );
  const isStub = booking.providerBookingId === null && booking.trackingNumber === null;
  // A real booking means the parcel is with the courier now.
  if (!isStub) {
    await query(
      workspaceId,
      "UPDATE orders SET status = 'in_transit', updated_at = now() WHERE workspace_id = $1 AND id = $2 AND status <> 'in_transit'",
      [workspaceId, order.id],
    );
    await query(
      workspaceId,
      "INSERT INTO order_events (workspace_id, order_id, from_status, to_status, note) VALUES ($1, $2, $3, 'in_transit', $4)",
      [workspaceId, order.id, order.status, `কুরিয়ারে পাঠানো হয়েছে (${provider.name}) — ট্র্যাকিং: ${booking.trackingNumber}`],
    );
  }
  return {
    shipment: rows[0],
    provider: provider.name,
    providerConfigured: !isStub,
    alreadyBooked: false,
    message: isStub
      ? 'কুরিয়ার বুকিং সংরক্ষণ করা হয়েছে, কিন্তু আসল কুরিয়ার এখনো যুক্ত হয়নি — তাই ট্র্যাকিং নম্বর এখনো পাওয়া যায়নি। কুরিয়ার যুক্ত হলে এখানেই ট্র্যাকিং নম্বর দেখা যাবে।'
      : 'কুরিয়ার বুকিং সম্পন্ন হয়েছে।',
  };
}
