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
  PathaoCourierProvider,
  ProviderNotConfiguredError,
  SteadfastCourierProvider,
} from './provider';
import {
  CREDENTIAL_PROVIDERS,
  maskedStatus,
  providerForWorkspace,
  requireWorkspaceOwner,
  resolveCourierCredentials,
  saveCourierCredentials,
  setCredentialsVerified,
  type CourierCredentialProvider,
} from './credentials';
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
  const provider = await providerForWorkspace(workspaceId, shipment.courier ?? getCourierProvider().name);
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
 * "configured" now counts DB-stored keys too (migration 32), not just env —
 * a provider whose keys were entered on the Courier page reports honestly
 * as configured. It never returns a key value. */
courierRouter.get('/courier/provider', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { config } = await import('../config');
  const current = getCourierProvider().name;
  const steadfastResolved = await resolveCourierCredentials(workspaceId, 'steadfast');
  const pathaoResolved = await resolveCourierCredentials(workspaceId, 'pathao');
  const configured: Record<string, boolean> = {
    stub: true,
    steadfast: !!steadfastResolved,
    pathao: !!pathaoResolved,
    redx: Boolean(config.courier.redx.apiKey),
    sundarban: false,
  };
  const needs: Record<string, string> = {
    stub: '',
    steadfast: 'Steadfast Api-Key / Secret-Key (কুরিয়ার পেজে বসান)',
    pathao: 'Pathao Client ID / Client Secret / মার্চেন্ট ইমেইল / পাসওয়ার্ড (কুরিয়ার পেজে বসান)',
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

/**
 * Courier API keys (migration 32) — owner only.
 *
 * GET /api/courier/credentials — masked status for Steadfast + Pathao:
 * which fields are set (hasSet), where the keys came from (db/env/none)
 * and whether they passed a read-only verify. NEVER a key value.
 * PUT /api/courier/credentials {provider, credentials} — save (encrypts
 * the whole object, clears any previous verification). Returns the
 * masked status. Unknown fields are ignored; missing required fields → 400.
 * POST /api/courier/credentials/:provider/verify — READ-ONLY check, never
 * a test booking: Steadfast GET /get_balance; Pathao issue-token + GET
 * /aladdin/api/v1/stores (also returns the merchant's stores so the owner
 * can pick the store_id). Success marks the provider verified; failure
 * returns {connected:false, reason} honestly.
 */
courierRouter.get('/courier/credentials', requireWorkspaceOwner, async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const providers = [];
  for (const provider of CREDENTIAL_PROVIDERS) {
    providers.push(await maskedStatus(workspaceId, provider));
  }
  res.json({ providers });
});

courierRouter.put('/courier/credentials', requireWorkspaceOwner, async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { provider, credentials } = (req.body ?? {}) as { provider?: string; credentials?: Record<string, unknown> };
  if (!provider || !CREDENTIAL_PROVIDERS.includes(provider as CourierCredentialProvider)) {
    res.status(400).json({ error: "provider must be 'steadfast' or 'pathao'" });
    return;
  }
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
    res.status(400).json({ error: 'credentials object is required' });
    return;
  }
  try {
    const status = await saveCourierCredentials(workspaceId, provider as CourierCredentialProvider, credentials as Record<string, string>);
    res.json({ provider: status.provider, status });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

courierRouter.post('/courier/credentials/:provider/verify', requireWorkspaceOwner, async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const provider = req.params.provider as CourierCredentialProvider;
  if (!CREDENTIAL_PROVIDERS.includes(provider)) {
    res.status(400).json({ error: "provider must be 'steadfast' or 'pathao'" });
    return;
  }
  const resolved = await resolveCourierCredentials(workspaceId, provider);
  if (!resolved) {
    res.json({
      provider,
      connected: false,
      source: 'none',
      reason:
        provider === 'steadfast'
          ? 'Steadfast-এর Api-Key / Secret-Key এখনো দেওয়া হয়নি — কুরিয়ার পেজে চাবি বসিয়ে সংরক্ষণ করুন।'
          : 'Pathao-এর Client ID / Client Secret / মার্চেন্ট ইমেইল / পাসওয়ার্ড এখনো দেওয়া হয়নি — কুরিয়ার পেজে চাবি বসিয়ে সংরক্ষণ করুন।',
    });
    return;
  }
  try {
    if (provider === 'steadfast') {
      const instance = (await providerForWorkspace(workspaceId, 'steadfast')) as SteadfastCourierProvider;
      const balance = await instance.getBalance();
      if (resolved.source === 'db') await setCredentialsVerified(workspaceId, 'steadfast', true);
      res.json({ provider, connected: true, source: resolved.source, verified: resolved.source === 'db', currentBalance: balance, currency: 'BDT' });
      return;
    }
    const instance = (await providerForWorkspace(workspaceId, 'pathao')) as PathaoCourierProvider;
    const { stores } = await instance.verifyConnection();
    if (resolved.source === 'db') await setCredentialsVerified(workspaceId, 'pathao', true);
    res.json({
      provider,
      connected: true,
      source: resolved.source,
      verified: resolved.source === 'db',
      stores,
      storeIdSet: !!resolved.credentials.storeId,
      note: resolved.credentials.storeId
        ? undefined
        : 'স্টোর ID এখনো দেওয়া হয়নি — নিচের তালিকা থেকে আপনার স্টোর বেছে সংরক্ষণ করুন, তারপর বুকিং হবে।',
    });
  } catch (err) {
    if (resolved.source === 'db') await setCredentialsVerified(workspaceId, provider, false).catch(() => undefined);
    res.json({ provider, connected: false, source: resolved.source, reason: (err as Error).message });
  }
});

/** GET /api/courier/balance — Steadfast merchant balance (read-only).
 * Uses this workspace's stored keys (DB first, env fallback). */
courierRouter.get('/courier/balance', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const provider = await providerForWorkspace(workspaceId, 'steadfast');
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
