/**
 * Courier providers — config-gated selection.
 *
 * COURIER_PROVIDER=stub (default) | pathao | steadfast | redx
 * The order panel also offers 'sundarban' (Send to Courier picker).
 *
 * HARD RULE: never invent a tracking number or a booking confirmation.
 * - The stub provider creates only a local shipment row with status
 *   'awaiting_provider' and NO tracking number. It means: "we saved the
 *   booking request, but no real courier has it yet."
 * - Steadfast is fully implemented (real API: book, status, balance).
 *   Pathao / RedX keep the same interface, but every method fails honestly
 *   with PROVIDER_NOT_CONFIGURED until real API credentials are set (see
 *   config.courier). They never return a fake booking id or tracking number.
 * - Sundarban is NOT wired at all yet (no API integration, no credentials
 *   in config): every call fails honestly with PROVIDER_NOT_CONFIGURED
 *   until its API is implemented. It is listed so the owner sees it as
 *   "not connected yet" instead of silently missing.
 */

import { config } from '../config';
import { fetchWithTimeout } from '../ai-agent/http';

export type CourierProviderName = 'stub' | 'pathao' | 'steadfast' | 'redx' | 'sundarban';

export const COURIER_PROVIDERS: CourierProviderName[] = ['stub', 'pathao', 'steadfast', 'redx', 'sundarban'];

/** Minimal order data a courier booking needs. */
export interface OrderForBooking {
  id: string;
  customerId: string | null;
  totalPaisa: number;
  status: string;
  customerName?: string | null;
  customerPhone?: string | null;
  customerAddress?: string | null;
  /** Requirement C: the delivery charge (paisa) from the owner's configured
   * rules, resolved by the caller. When absent, the hardcoded fallback
   * below (Dhaka ৳100 / outside ৳130) is used. */
  deliveryChargePaisa?: number;
}

export interface BookingResult {
  /** The courier's own booking reference. NULL until a real provider books it. */
  providerBookingId: string | null;
  /** The courier's tracking number. NULL until a real provider issues one. */
  trackingNumber: string | null;
  /** Shipment status to store: 'awaiting_provider' (stub) or a provider status. */
  status: string;
}

export interface TrackResult {
  /** False when no live tracking is available (stub / not configured / unknown). */
  available: boolean;
  status?: string;
  /** Bengali explanation shown to the user when tracking is unavailable. */
  reason?: string;
}

export interface CourierProvider {
  readonly name: CourierProviderName;
  /** Book a parcel with the courier. Throws when the provider is not configured. */
  createBooking(order: OrderForBooking): Promise<BookingResult>;
  /** Live tracking lookup. Returns {available:false} — never fake data. */
  track(trackingNumber: string): Promise<TrackResult>;
}

/** Error thrown when a real provider is selected but has no credentials. */
export class ProviderNotConfiguredError extends Error {
  readonly code = 'PROVIDER_NOT_CONFIGURED';
  constructor(provider: string, whatIsNeeded: string) {
    super(
      `কুরিয়ার প্রোভাইডার "${provider}" এখনো যুক্ত হয়নি — ${whatIsNeeded} লাগবে। কোনো ভুয়া বুকিং বা ট্র্যাকিং নম্বর দেওয়া হয়নি।`,
    );
    this.name = 'ProviderNotConfiguredError';
  }
}

/**
 * Stub provider (default). Saves the intent locally only:
 * no API call, no booking id, no tracking number.
 */
export class StubCourierProvider implements CourierProvider {
  readonly name: CourierProviderName = 'stub';

  async createBooking(_order: OrderForBooking): Promise<BookingResult> {
    return { providerBookingId: null, trackingNumber: null, status: 'awaiting_provider' };
  }

  async track(_trackingNumber: string): Promise<TrackResult> {
    return {
      available: false,
      reason: 'কুরিয়ার প্রোভাইডার এখনো যুক্ত হয়নি — লাইভ ট্র্যাকিং পাওয়া যাচ্ছে না।',
    };
  }
}

/**
 * Pathao Courier — TODO stub.
 * TODO: implement with the real Pathao Courier API once merchant credentials
 * exist (PATHAO_BASE_URL, PATHAO_CLIENT_ID, PATHAO_CLIENT_SECRET,
 * PATHAO_USERNAME, PATHAO_PASSWORD — see config.courier.pathao).
 * Until then every call fails honestly; nothing is faked.
 */
export class PathaoCourierProvider implements CourierProvider {
  readonly name: CourierProviderName = 'pathao';

  private assertConfigured(): void {
    if (!config.courier.pathao.clientId || !config.courier.pathao.clientSecret) {
      throw new ProviderNotConfiguredError(
        'pathao',
        'Pathao মার্চেন্ট অ্যাকাউন্টের API চাবি (PATHAO_CLIENT_ID / PATHAO_CLIENT_SECRET)',
      );
    }
  }

  async createBooking(_order: OrderForBooking): Promise<BookingResult> {
    this.assertConfigured();
    // TODO: POST {PATHAO_BASE_URL}/aladdin/api/v1/orders — real booking.
    throw new Error('Pathao বুকিং এখনো বাস্তবায়ন হয়নি (TODO) — চাবি থাকলেও এখনো API কল লেখা হয়নি।');
  }

  async track(_trackingNumber: string): Promise<TrackResult> {
    this.assertConfigured();
    // TODO: GET {PATHAO_BASE_URL}/aladdin/api/v1/orders/{trackingNumber} — real tracking.
    throw new Error('Pathao ট্র্যাকিং এখনো বাস্তবায়ন হয়নি (TODO)।');
  }
}

/**
 * Steadfast Courier — real implementation (official API doc V1:
 * https://github.com/codernayeem/payment-sms-courier-api-docs/blob/HEAD/courier-services/steadfast/steadfast%20api%20doc.md).
 *
 * Base URL: https://portal.packzy.com/api/v1 (STEADFAST_BASE_URL overrides).
 * Auth: `Api-Key` + `Secret-Key` headers + `Content-Type: application/json`.
 * - POST /create_order — invoice (unique, alphanumeric + hyphens/underscores),
 *   recipient_name (≤100), recipient_phone (11-digit), recipient_address
 *   (≤250), cod_amount (BDT, ≥0), note (optional, ≤480). Returns the
 *   consignment with consignment_id + tracking_code, status 'in_review'.
 * - GET /status_by_cid/{id} | /status_by_invoice/{invoice} |
 *   /status_by_trackingcode/{code} — {status: 200, delivery_status}.
 *   Statuses: in_review, pending, delivered_approval_pending,
 *   partial_delivered_approval_pending, cancelled_approval_pending,
 *   unknown_approval_pending, delivered, partial_delivered, cancelled,
 *   hold, unknown. NOTE: the doc lists NO "out for delivery" status and
 *   NO arrival-date ETA — the honest customer trigger is a status change
 *   to delivered / partial_delivered / cancelled / hold (see
 *   tracking-check.ts), never an invented ETA.
 * - GET /get_balance — {status: 200, current_balance}.
 *
 * Steadfast has NO sandbox: every booking on a live key is a REAL parcel.
 * Never create a test booking. Verify with GET /get_balance (read-only)
 * and a status lookup on a real past consignment first.
 */

/** Shop delivery-charge rule (also taught to the AI in knowledge_items):
 * Dhaka → ৳100, everywhere else in Bangladesh → ৳130; ৳130 when unclear.
 * This is only the FALLBACK — the configured rules (delivery-charges
 * service) win whenever the caller resolved them (requirement C). */
export function deliveryChargeForAddress(address: string | null | undefined): number {
  const a = (address ?? '').toLowerCase();
  if (a.includes('dhaka') || a.includes('ঢাকা')) return 100;
  return 130;
}

/** COD amount in BDT: order product total + delivery charge (configured when given). */
export function codAmountBdt(order: OrderForBooking): number {
  const delivery = typeof order.deliveryChargePaisa === 'number' ? Math.round(order.deliveryChargePaisa / 100) : deliveryChargeForAddress(order.customerAddress);
  return Math.round(Number(order.totalPaisa) / 100) + delivery;
}

/** Normalize a Bangladeshi mobile number to 11-digit 01XXXXXXXXX, or null. */
export function normalizeBdPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let d = phone.replace(/[\s\-()]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  if (d.startsWith('880')) d = d.slice(3);
  if (d.startsWith('1') && d.length === 10) d = `0${d}`;
  return /^01\d{9}$/.test(d) ? d : null;
}

/** Booking refused before anything is sent to the courier (bad/missing contact). */
export class CourierValidationError extends Error {
  readonly code = 'COURIER_VALIDATION';
  constructor(message: string) {
    super(message);
    this.name = 'CourierValidationError';
  }
}

export class SteadfastCourierProvider implements CourierProvider {
  readonly name: CourierProviderName = 'steadfast';

  private baseUrl(): string {
    return (config.courier.steadfast.baseUrl || 'https://portal.packzy.com/api/v1').replace(/\/$/, '');
  }

  private assertConfigured(): void {
    if (!config.courier.steadfast.apiKey || !config.courier.steadfast.secretKey) {
      throw new ProviderNotConfiguredError(
        'steadfast',
        'Steadfast মার্চেন্ট অ্যাকাউন্টের API চাবি (STEADFAST_API_KEY / STEADFAST_SECRET_KEY)',
      );
    }
  }

  private headers(): Record<string, string> {
    return {
      'Api-Key': config.courier.steadfast.apiKey,
      'Secret-Key': config.courier.steadfast.secretKey,
      'Content-Type': 'application/json',
    };
  }

  /** One Steadfast call. Throws a plain Error with Steadfast's own message on failure. */
  private async call(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const res = await fetchWithTimeout(
      `${this.baseUrl()}${path}`,
      { ...init, headers: { ...this.headers(), ...((init.headers as Record<string, string> | undefined) ?? {}) } },
      20000,
    );
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || !data) {
      const msg = typeof data?.message === 'string' && data.message ? data.message : `Steadfast API ব্যর্থ হয়েছে (HTTP ${res.status})`;
      throw new Error(msg);
    }
    if (typeof data.status === 'number' && data.status !== 200) {
      const msg = typeof data.message === 'string' && data.message ? data.message : `Steadfast API ব্যর্থ হয়েছে (status ${data.status})`;
      throw new Error(msg);
    }
    return data;
  }

  async createBooking(order: OrderForBooking): Promise<BookingResult> {
    this.assertConfigured();
    const name = (order.customerName ?? '').trim().slice(0, 100);
    if (!name) {
      throw new CourierValidationError('কাস্টমারের নাম পাওয়া যায়নি — নাম ছাড়া কুরিয়ার বুকিং করা যাবে না।');
    }
    const phone = normalizeBdPhone(order.customerPhone);
    if (!phone) {
      throw new CourierValidationError('কাস্টমারের ফোন নম্বর সঠিক নয় (১১ সংখ্যার মোবাইল নম্বর লাগবে) — নম্বর ঠিক করে আবার চেষ্টা করুন।');
    }
    const address = (order.customerAddress ?? '').trim().slice(0, 250);
    if (!address) {
      throw new CourierValidationError('ডেলিভারির ঠিকানা পাওয়া যায়নি — ঠিকানা ছাড়া কুরিয়ার বুকিং করা যাবে না।');
    }
    const cod = codAmountBdt(order);
    const data = await this.call('/create_order', {
      method: 'POST',
      body: JSON.stringify({
        invoice: `ASI-${order.id}`,
        recipient_name: name,
        recipient_phone: phone,
        recipient_address: address,
        cod_amount: cod,
        note: `AI Sales Inbox order ${order.id.slice(0, 8)}`,
      }),
    });
    const consignment = (data.consignment ?? null) as {
      consignment_id?: unknown;
      tracking_code?: unknown;
      status?: unknown;
    } | null;
    const consignmentId = consignment?.consignment_id;
    const trackingCode = consignment?.tracking_code;
    if (consignmentId === undefined || consignmentId === null || typeof trackingCode !== 'string' || !trackingCode) {
      throw new Error('Steadfast বুকিংয়ের উত্তর অসম্পূর্ণ — consignment_id বা tracking_code পাওয়া যায়নি। কোনো বুকিং ধরা হয়নি।');
    }
    return {
      providerBookingId: String(consignmentId),
      trackingNumber: trackingCode,
      status: typeof consignment.status === 'string' && consignment.status ? consignment.status : 'in_review',
    };
  }

  /** Live status by tracking code. Never fakes data — unavailable is honest. */
  async track(trackingNumber: string): Promise<TrackResult> {
    this.assertConfigured();
    const code = trackingNumber.trim();
    if (!code) {
      return { available: false, reason: 'ট্র্যাকিং নম্বর দেওয়া হয়নি।' };
    }
    try {
      const status = await this.getStatusByTrackingCode(code);
      return { available: true, status };
    } catch (err) {
      return { available: false, reason: (err as Error).message };
    }
  }

  /** GET /status_by_cid/{id} → delivery_status string. */
  async getStatusByConsignmentId(consignmentId: string): Promise<string> {
    this.assertConfigured();
    const data = await this.call(`/status_by_cid/${encodeURIComponent(consignmentId)}`);
    const status = data.delivery_status;
    if (typeof status !== 'string' || !status) {
      throw new Error('Steadfast থেকে ডেলিভারির অবস্থা পাওয়া যায়নি।');
    }
    return status;
  }

  /** GET /status_by_trackingcode/{code} → delivery_status string. */
  async getStatusByTrackingCode(trackingCode: string): Promise<string> {
    this.assertConfigured();
    const data = await this.call(`/status_by_trackingcode/${encodeURIComponent(trackingCode)}`);
    const status = data.delivery_status;
    if (typeof status !== 'string' || !status) {
      throw new Error('Steadfast থেকে ডেলিভারির অবস্থা পাওয়া যায়নি।');
    }
    return status;
  }

  /** GET /status_by_invoice/{invoice} → delivery_status string. */
  async getStatusByInvoice(invoice: string): Promise<string> {
    this.assertConfigured();
    const data = await this.call(`/status_by_invoice/${encodeURIComponent(invoice)}`);
    const status = data.delivery_status;
    if (typeof status !== 'string' || !status) {
      throw new Error('Steadfast থেকে ডেলিভারির অবস্থা পাওয়া যায়নি।');
    }
    return status;
  }

  /** GET /get_balance → current_balance (BDT). Read-only — the safe first live check. */
  async getBalance(): Promise<number> {
    this.assertConfigured();
    const data = await this.call('/get_balance');
    const balance = data.current_balance;
    if (typeof balance !== 'number') {
      throw new Error('Steadfast থেকে ব্যালেন্স পাওয়া যায়নি।');
    }
    return balance;
  }
}

/** Provider instance by name — used when a shipment's own courier matters, not the env default. */
export function providerForName(name: string): CourierProvider {
  switch (name) {
    case 'pathao':
      return new PathaoCourierProvider();
    case 'steadfast':
      return new SteadfastCourierProvider();
    case 'redx':
      return new RedXCourierProvider();
    case 'sundarban':
      return new SundarbanCourierProvider();
    case 'stub':
    default:
      return new StubCourierProvider();
  }
}

/**
 * Sundarban Courier — NOT wired yet.
 * There is no Sundarban API integration and no credential in config, so
 * every call fails honestly with PROVIDER_NOT_CONFIGURED. It is listed
 * (and shown in the order panel) so the owner sees it as "not connected
 * yet" — never a fake booking. Wiring it needs the Sundarban merchant
 * API + credentials, a follow-up, not this change.
 */
export class SundarbanCourierProvider implements CourierProvider {
  readonly name: CourierProviderName = 'sundarban';

  private assertConfigured(): never {
    throw new ProviderNotConfiguredError(
      'sundarban',
      'সুন্দরবন কুরিয়ারের API এখনো যুক্ত হয়নি (মার্চেন্ট API + চাবি লাগবে)',
    );
  }

  async createBooking(_order: OrderForBooking): Promise<BookingResult> {
    this.assertConfigured();
  }

  async track(_trackingNumber: string): Promise<TrackResult> {
    this.assertConfigured();
  }
}

/**
 * RedX Courier — TODO stub.
 * TODO: implement with the real RedX API once merchant credentials exist
 * (REDX_BASE_URL, REDX_API_KEY — see config.courier.redx). Until then
 * every call fails honestly.
 */
export class RedXCourierProvider implements CourierProvider {
  readonly name: CourierProviderName = 'redx';

  private assertConfigured(): void {
    if (!config.courier.redx.apiKey) {
      throw new ProviderNotConfiguredError('redx', 'RedX মার্চেন্ট অ্যাকাউন্টের API চাবি (REDX_API_KEY)');
    }
  }

  async createBooking(_order: OrderForBooking): Promise<BookingResult> {
    this.assertConfigured();
    // TODO: POST {REDX_BASE_URL}/parcel — real booking.
    throw new Error('RedX বুকিং এখনো বাস্তবায়ন হয়নি (TODO) — চাবি থাকলেও এখনো API কল লেখা হয়নি।');
  }

  async track(_trackingNumber: string): Promise<TrackResult> {
    this.assertConfigured();
    // TODO: GET {REDX_BASE_URL}/parcel/track/{trackingNumber} — real tracking.
    throw new Error('RedX ট্র্যাকিং এখনো বাস্তবায়ন হয়নি (TODO)।');
  }
}

/** Select the courier provider from COURIER_PROVIDER (default: stub). */
export function getCourierProvider(): CourierProvider {
  const name = (config.courierProvider ?? 'stub') as CourierProviderName;
  if (name !== 'stub' && !COURIER_PROVIDERS.includes(name)) {
    console.warn(`[courier] unknown COURIER_PROVIDER="${name}" — falling back to stub (no real booking)`);
    return new StubCourierProvider();
  }
  return providerForName(name);
}
