/**
 * Courier bookings + tracking (Phase: courier module).
 * Full paths, mounted at /api by the integrator (see integration-notes.md).
 *
 * POST /api/courier/bookings {orderId} — book a courier for an order.
 *   With the default stub provider this saves a shipment row with status
 *   'awaiting_provider' and NO tracking number — clearly labelled in
 *   Bengali. A real provider (pathao/steadfast/redx) is selected only via
 *   COURIER_PROVIDER and fails honestly until its API key is configured;
 *   it never invents a booking id or tracking number.
 * GET /api/courier/track/:trackingNumber — live tracking lookup.
 *   Honestly returns {available:false} when the provider is not configured
 *   or the number is unknown — never fake status.
 * GET /api/courier/shipments — shipments of this workspace.
 */
import { Router, type Response } from 'express';
import { query, queryOne } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';
import {
  CourierValidationError,
  getCourierProvider,
  providerForName,
  ProviderNotConfiguredError,
  SteadfastCourierProvider,
  type OrderForBooking,
} from './provider';
import { bookCourierForOrder } from './book';
import { getDeliveryChargeRules, resolveDeliveryCharge } from '../delivery-charges/service';
import { processDueShipmentChecks } from './tracking-check';

export const courierRouter = Router();
courierRouter.use(requireAuth);

interface ShipmentRow {
  id: string;
  order_id: string;
  courier: string | null;
  tracking_code: string | null;
  tracking_number: string | null;
  provider_booking_id: string | null;
  status: string | null;
  created_at: string;
}

function publicShipment(row: ShipmentRow) {
  return {
    id: row.id,
    orderId: row.order_id,
    order_id: row.order_id,
    courier: row.courier,
    trackingCode: row.tracking_code,
    tracking_code: row.tracking_code,
    trackingNumber: row.tracking_number,
    tracking_number: row.tracking_number,
    providerBookingId: row.provider_booking_id,
    provider_booking_id: row.provider_booking_id,
    status: row.status,
    createdAt: row.created_at,
    created_at: row.created_at,
  };
}

/** POST /api/courier/bookings {orderId} → {shipment, providerConfigured, message} (201).
 * The booking itself lives in ./book (shared with the order panel's
 * "Send to Courier", which picks a courier by name); this route keeps the
 * env-selected provider and the same response shape. */
courierRouter.post('/courier/bookings', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { orderId } = (req.body ?? {}) as { orderId?: string };
  if (!orderId) {
    res.status(400).json({ error: 'orderId is required' });
    return;
  }
  try {
    const result = await bookCourierForOrder(workspaceId, orderId);
    res.status(result.alreadyBooked ? 200 : 201).json({
      shipment: publicShipment(result.shipment),
      provider: result.provider,
      providerConfigured: result.providerConfigured,
      alreadyBooked: result.alreadyBooked,
      message: result.message,
    });
  } catch (err) {
    if ((err as Error & { status?: number }).status === 404) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    if (err instanceof CourierValidationError) {
      // Refused before anything was sent to the courier (bad/missing contact).
      res.status(400).json({ error: err.message, code: err.code, provider: getCourierProvider().name });
      return;
    }
    if (err instanceof ProviderNotConfiguredError) {
      // Honest failure: no shipment row, no fake booking/tracking number.
      res.status(502).json({
        error: err.message,
        code: err.code,
        provider: getCourierProvider().name,
        providerConfigured: false,
      });
      return;
    }
    console.error('[courier/bookings]', err);
    res.status(502).json({
      error: 'কুরিয়ার বুকিং করা যায়নি — প্রোভাইডারের সাথে সংযোগ ব্যর্থ হয়েছে। কোনো ভুয়া বুকিং নম্বর দেওয়া হয়নি।',
      provider: getCourierProvider().name,
      providerConfigured: false,
    });
  }
});

/** GET /api/courier/track/:trackingNumber → {available, status?, reason?}. */
courierRouter.get('/courier/track/:trackingNumber', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const trackingNumber = decodeURIComponent(req.params.trackingNumber ?? '').trim();
  if (!trackingNumber) {
    res.status(400).json({ available: false, error: 'trackingNumber is required' });
    return;
  }
  const shipment = await queryOne<ShipmentRow>(
    workspaceId,
    `SELECT id, order_id, courier, tracking_code, tracking_number, provider_booking_id, status, created_at
     FROM shipments WHERE workspace_id = $1 AND (tracking_number = $2 OR tracking_code = $2 OR provider_booking_id = $2)
     ORDER BY created_at DESC LIMIT 1`,
    [workspaceId, trackingNumber],
  );
  if (!shipment) {
    res.status(404).json({
      available: false,
      reason: 'এই ট্র্যাকিং নম্বর পাওয়া যায়নি — নম্বরটি ঠিক আছে কি না দেখুন।',
    });
    return;
  }
  // A stub shipment has no real tracking: say so honestly.
  if (!shipment.provider_booking_id && !shipment.tracking_number && !shipment.tracking_code) {
    res.json({
      available: false,
      shipment: publicShipment(shipment),
      status: shipment.status,
      reason: 'কুরিয়ার প্রোভাইডার এখনো যুক্ত হয়নি — এই পার্সেলের লাইভ ট্র্যাকিং পাওয়া যাচ্ছে না।',
    });
    return;
  }
  const provider = providerForName(shipment.courier ?? getCourierProvider().name);
  try {
    const result = await provider.track(trackingNumber);
    res.json({ ...result, shipment: publicShipment(shipment) });
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      res.status(502).json({
        available: false,
        shipment: publicShipment(shipment),
        reason: err.message,
        code: err.code,
      });
      return;
    }
    console.error('[courier/track]', err);
    res.status(502).json({
      available: false,
      shipment: publicShipment(shipment),
      reason: 'ট্র্যাকিং দেখা যাচ্ছে না — কুরিয়ার প্রোভাইডারের সাথে সংযোগ ব্যর্থ হয়েছে।',
    });
  }
});

/** GET /api/courier/provider — current provider + all options with their status.
 * The selection itself is env-based (COURIER_PROVIDER); this endpoint only
 * reports it honestly — it never returns a key value. */
courierRouter.get('/courier/provider', async (req: AuthRequest, res: Response) => {
  const { config } = await import('../config');
  const current = getCourierProvider().name;
  const configured: Record<string, boolean> = {
    stub: true,
    steadfast: Boolean(config.courier.steadfast.apiKey && config.courier.steadfast.secretKey),
    pathao: Boolean(config.courier.pathao.clientId && config.courier.pathao.clientSecret),
    redx: Boolean(config.courier.redx.apiKey),
    sundarban: false,
  };
  const needs: Record<string, string> = {
    stub: '',
    steadfast: 'STEADFAST_API_KEY / STEADFAST_SECRET_KEY',
    pathao: 'PATHAO_CLIENT_ID / PATHAO_CLIENT_SECRET',
    redx: 'REDX_API_KEY',
    sundarban: 'সুন্দরবন মার্চেন্ট API (এখনো যুক্ত হয়নি)',
  };
  res.json({
    provider: current,
    configured: configured[current] ?? false,
    providers: (['stub', 'steadfast', 'pathao', 'redx', 'sundarban'] as const).map((name) => ({
      name,
      configured: configured[name] ?? false,
      needs: needs[name] ?? '',
      selected: name === current,
    })),
  });
});

/** GET /api/courier/balance — Steadfast merchant balance (read-only).
 * Only available when Steadfast is the selected provider and its keys exist. */
courierRouter.get('/courier/balance', async (req: AuthRequest, res: Response) => {
  const provider = getCourierProvider();
  if (provider.name !== 'steadfast') {
    res.status(400).json({
      available: false,
      reason: `ব্যালেন্স দেখা শুধু Steadfast-এর জন্য — এখন নির্বাচিত প্রোভাইডার "${provider.name}"।`,
    });
    return;
  }
  try {
    const balance = await (provider as SteadfastCourierProvider).getBalance();
    res.json({ available: true, provider: 'steadfast', currentBalance: balance, currency: 'BDT' });
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      res.status(502).json({ available: false, reason: err.message, code: err.code });
      return;
    }
    console.error('[courier/balance]', err);
    res.status(502).json({ available: false, reason: 'Steadfast ব্যালেন্স দেখা যাচ্ছে না — সংযোগ ব্যর্থ হয়েছে।' });
  }
});

/** POST /api/courier/check-status — re-check this workspace's Steadfast
 * shipments now and notify customers on status change. Same check the cron
 * sweep runs every 5 minutes; this is the manual trigger. */
courierRouter.post('/courier/check-status', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  try {
    const summary = await processDueShipmentChecks(workspaceId);
    res.json({ ok: true, ...summary });
  } catch (err) {
    console.error('[courier/check-status]', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

/** GET /api/courier/shipments — this workspace's shipments, newest first. */
courierRouter.get('/courier/shipments', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rows } = await query(
    workspaceId,
    `SELECT s.id, s.order_id, s.courier, s.tracking_code, s.tracking_number,
            s.provider_booking_id, s.status, s.created_at,
            o.total_paisa AS order_total_paisa, o.status AS order_status,
            c.name AS customer_name, c.phone AS customer_phone
     FROM shipments s
     LEFT JOIN orders o ON o.id = s.order_id AND o.workspace_id = $1
     LEFT JOIN customers c ON c.id = o.customer_id AND c.workspace_id = $1
     WHERE s.workspace_id = $1 ORDER BY s.created_at DESC LIMIT 200`,
    [workspaceId],
  );
  res.json({ shipments: rows.map((r) => publicShipment(r as unknown as ShipmentRow)) });
});
