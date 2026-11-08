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
 *   Pathao is fully implemented too (real API: token, book, info, stores).
 *   RedX keeps the same interface, but every method fails honestly with
 *   PROVIDER_NOT_CONFIGURED until real API credentials are set (see
 *   config.courier). They never return a fake booking id or tracking number.
 * - Sundarban is NOT wired at all yet (no API integration, no credentials
 *   in config): every call fails honestly with PROVIDER_NOT_CONFIGURED
 *   until its API is implemented. It is listed so the owner sees it as
 *   "not connected yet" instead of silently missing.
 * - Credentials entered on the Courier page live in courier_credentials
 *   (migration 32, encrypted) and take precedence over env vars — see
 *   ./credentials.ts. Providers accept them via their constructor.
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
  /** Human order number (ASI-0001…) when known — sent as the merchant
   * order reference so the owner can match the parcel to the order. */
  orderNumber?: string | null;
  /** Total item quantity across the order's lines (Pathao requires it). */
  itemQuantity?: number;
  /** Parcel weight in kg (Pathao requires 0.5–10). The shop does not track
   * per-product weight, so the caller passes 0.5 (the minimum) unless it
   * knows better — documented assumption, not a measured weight. */
  itemWeight?: number;
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
 * Credentials a provider can be constructed with. DB-stored credentials
 * (courier_credentials, migration 32) are passed in by the caller and take
 * precedence; when absent the provider falls back to the env config, so
 * shops that already set STEADFAST_API_KEY / PATHAO_* keep working.
 * No provider ever logs or returns these values.
 */
export interface SteadfastCreds {
  apiKey?: string;
  secretKey?: string;
  baseUrl?: string;
}

export interface PathaoCreds {
  clientId?: string;
  clientSecret?: string;
  username?: string;
  password?: string;
  /** Pathao merchant store id (pickup location). Saved on the Courier page;
   * the verify check lists the merchant's stores so the owner can pick one. */
  storeId?: string;
  /** Base URL — live default https://api-hermes.pathao.com; a sandbox URL
   * (https://courier-api-sandbox.pathao.com) may be entered for testing. */
  baseUrl?: string;
}

/**
 * Pathao Courier — REAL implementation (merchant API docs, mirrored at
 * https://github.com/shahria7k/pathao-courier/blob/HEAD/pathaodocs.md —
 * the doc Pathao merchants are given; verified 2026-11-08):
 *
 * - Auth is OAuth 2.0 password grant: POST /aladdin/api/v1/issue-token
 *   {client_id, client_secret, grant_type: "password", username, password}
 *   → {access_token, refresh_token, expires_in: 432000 (5 days)}.
 *   A 401 re-issues via the refresh_token grant once, then the password
 *   grant again. Tokens are cached in memory only (never logged, never
 *   stored in the DB — the stored credentials are the merchant keys).
 * - Create order: POST /aladdin/api/v1/orders {store_id, merchant_order_id,
 *   recipient_name (3–100), recipient_phone (11 digits), recipient_address
 *   (10–220), delivery_type: 48 (Normal) | 12 (On Demand), item_type: 2
 *   (Parcel) | 1 (Document), item_quantity, item_weight (0.5–10 kg),
 *   amount_to_collect} → data {consignment_id, merchant_order_id,
 *   order_status, delivery_fee}.
 * - Order info: GET /aladdin/api/v1/orders/{consignment_id}/info →
 *   data {consignment_id, order_status, order_status_slug, ...}.
 * - Stores: GET /aladdin/api/v1/stores → data.data [{store_id, store_name,
 *   is_active, is_default_store, ...}] — used by the read-only verify
 *   check and to pick the store_id.
 * - Base URLs: live https://api-hermes.pathao.com, sandbox
 *   https://courier-api-sandbox.pathao.com (Pathao HAS a sandbox — the
 *   verify check still only reads, never books).
 *
 * VERIFIED vs ASSUMED (2026-11-08, from the merchant doc above):
 * - VERIFIED: token endpoint + payload + 432000s expiry, order create
 *   endpoint + all field names/constraints, order-info endpoint +
 *   response shape, stores endpoint + response shape, live + sandbox
 *   base URLs, delivery_type 48/12, item_type 2/1.
 * - ASSUMED (not in the doc, coded defensively): the API wraps every
 *   response as {type: "success"|"error", code, message, data}; errors
 *   are read from message/code and any non-2xx is a failure. The
 *   consignment_id is the tracking number (Pathao has no separate
 *   tracking code). item_weight defaults to 0.5 kg (minimum) because the
 *   shop does not track per-product weight.
 * Until credentials exist every call fails honestly with
 * PROVIDER_NOT_CONFIGURED; nothing is faked.
 */
export class PathaoCourierProvider implements CourierProvider {
  readonly name: CourierProviderName = 'pathao';

  private readonly creds: PathaoCreds;

  constructor(creds: PathaoCreds = {}) {
    this.creds = creds;
  }

  private baseUrl(): string {
    return (this.creds.baseUrl || config.courier.pathao.baseUrl || 'https://api-hermes.pathao.com').replace(/\/$/, '');
  }

  private resolved(): Required<Omit<PathaoCreds, 'storeId' | 'baseUrl'>> & { storeId: string | null; baseUrl: string } {
    return {
      clientId: this.creds.clientId || config.courier.pathao.clientId || '',
      clientSecret: this.creds.clientSecret || config.courier.pathao.clientSecret || '',
      username: this.creds.username || config.courier.pathao.username || '',
      password: this.creds.password || config.courier.pathao.password || '',
      storeId: this.creds.storeId || config.courier.pathao.storeId || null,
      baseUrl: this.baseUrl(),
    };
  }

  private assertConfigured(): ReturnType<PathaoCourierProvider['resolved']> {
    const c = this.resolved();
    if (!c.clientId || !c.clientSecret || !c.username || !c.password) {
      throw new ProviderNotConfiguredError(
        'pathao',
        'Pathao মার্চেন্ট API চাবি (Client ID, Client Secret, মার্চেন্ট ইমেইল ও পাসওয়ার্ড — কুরিয়ার পেজে বসান)',
      );
    }
    return c;
  }

  private assertStoreConfigured(): ReturnType<PathaoCourierProvider['resolved']> {
    const c = this.assertConfigured();
    if (!c.storeId) {
      throw new ProviderNotConfiguredError(
        'pathao',
        'Pathao স্টোর ID — কুরিয়ার পেজে "যাচাই করুন" চাপলে আপনার স্টোরের তালিকা আসবে, সেখান থেকে স্টোর বেছে নিন',
      );
    }
    return c;
  }

  /** In-memory access-token cache, keyed by client id + username. The
   * token lives at most until expires_in (5 days per the doc) minus a
   * 5-minute safety margin; refresh_token is kept beside it for renewal. */
  private static tokenCache = new Map<string, { accessToken: string; refreshToken: string | null; expiresAt: number }>();

  private cacheKey(c: { clientId: string; username: string }): string {
    return `${c.clientId}:${c.username}`;
  }

  /** Issue a fresh access token (password grant, or refresh grant). */
  private async issueToken(c: ReturnType<PathaoCourierProvider['resolved']>, grant: 'password' | 'refresh_token', refreshToken?: string): Promise<{ accessToken: string; refreshToken: string | null; expiresIn: number }> {
    const body: Record<string, string> =
      grant === 'password'
        ? { client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'password', username: c.username, password: c.password }
        : { client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken ?? '' };
    const res = await fetchWithTimeout(`${c.baseUrl}/aladdin/api/v1/issue-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 20000);
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || !data || typeof data.access_token !== 'string' || !data.access_token) {
      const msg = typeof data?.message === 'string' && data.message ? data.message : `Pathao থেকে টোকেন পাওয়া যায়নি (HTTP ${res.status}) — চাবিগুলো ঠিক আছে কি না দেখুন।`;
      throw new Error(msg);
    }
    return {
      accessToken: data.access_token as string,
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : null,
      expiresIn: typeof data.expires_in === 'number' ? data.expires_in : 432000,
    };
  }

  /** A usable access token: cached while fresh, refreshed, then re-issued. */
  private async accessToken(c: ReturnType<PathaoCourierProvider['resolved']>): Promise<string> {
    const key = this.cacheKey(c);
    const cached = PathaoCourierProvider.tokenCache.get(key);
    if (cached && cached.expiresAt > Date.now() + 5 * 60 * 1000) return cached.accessToken;
    let issued: { accessToken: string; refreshToken: string | null; expiresIn: number } | null = null;
    if (cached?.refreshToken) {
      try {
        issued = await this.issueToken(c, 'refresh_token', cached.refreshToken);
      } catch {
        issued = null; // refresh failed — fall through to the password grant
      }
    }
    if (!issued) issued = await this.issueToken(c, 'password');
    PathaoCourierProvider.tokenCache.set(key, {
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      expiresAt: Date.now() + issued.expiresIn * 1000,
    });
    return issued.accessToken;
  }

  /** One authenticated Pathao call. Retries once after a 401 (token
   * expired mid-flight): refresh/re-issue, then replay the request. */
  private async call(path: string, init: RequestInit = {}, _retried = false): Promise<Record<string, unknown>> {
    const c = this.assertConfigured();
    const token = await this.accessToken(c);
    const res = await fetchWithTimeout(
      `${c.baseUrl}${path}`,
      { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...((init.headers as Record<string, string> | undefined) ?? {}) } },
      20000,
    );
    if (res.status === 401 && !_retried) {
      PathaoCourierProvider.tokenCache.delete(this.cacheKey(c));
      return this.call(path, init, true);
    }
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || !data) {
      const msg = typeof data?.message === 'string' && data.message ? data.message : `Pathao API ব্যর্থ হয়েছে (HTTP ${res.status})`;
      throw new Error(msg);
    }
    if (data.type === 'error' || (typeof data.code === 'number' && data.code >= 400)) {
      const msg = typeof data.message === 'string' && data.message ? data.message : `Pathao API ব্যর্থ হয়েছে (code ${String(data.code ?? '?')})`;
      throw new Error(msg);
    }
    return data;
  }

  async createBooking(order: OrderForBooking): Promise<BookingResult> {
    const c = this.assertStoreConfigured();
    const name = (order.customerName ?? '').trim();
    if (name.length < 3 || name.length > 100) {
      throw new CourierValidationError('কাস্টমারের নাম পাওয়া যায়নি বা খুব ছোট (৩–১০০ অক্ষর লাগবে) — নাম ছাড়া Pathao বুকিং করা যাবে না।');
    }
    const phone = normalizeBdPhone(order.customerPhone);
    if (!phone) {
      throw new CourierValidationError('কাস্টমারের ফোন নম্বর সঠিক নয় (১১ সংখ্যার মোবাইল নম্বর লাগবে) — নম্বর ঠিক করে আবার চেষ্টা করুন।');
    }
    const address = (order.customerAddress ?? '').trim();
    if (address.length < 10 || address.length > 220) {
      throw new CourierValidationError('ডেলিভারির ঠিকানা ১০–২২০ অক্ষরের হতে হবে — ঠিকানা পুরো লিখে আবার চেষ্টা করুন।');
    }
    const quantity = Math.max(1, Math.floor(order.itemQuantity ?? 1));
    const weight = Math.min(10, Math.max(0.5, Number(order.itemWeight ?? 0.5) || 0.5));
    const data = await this.call('/aladdin/api/v1/orders', {
      method: 'POST',
      body: JSON.stringify({
        store_id: Number(c.storeId),
        merchant_order_id: order.orderNumber ?? `ASI-${order.id.slice(0, 8)}`,
        recipient_name: name,
        recipient_phone: phone,
        recipient_address: address,
        delivery_type: 48, // Normal delivery (12 = On Demand)
        item_type: 2, // Parcel (1 = Document)
        item_quantity: quantity,
        item_weight: weight,
        item_description: `AI Sales Inbox order ${order.orderNumber ?? order.id.slice(0, 8)}`,
        amount_to_collect: codAmountBdt(order),
      }),
    });
    const payload = (data.data ?? null) as { consignment_id?: unknown; order_status?: unknown } | null;
    const consignmentId = payload?.consignment_id;
    if (typeof consignmentId !== 'string' || !consignmentId) {
      throw new Error('Pathao বুকিংয়ের উত্তর অসম্পূর্ণ — consignment_id পাওয়া যায়নি। কোনো বুকিং ধরা হয়নি।');
    }
    return {
      providerBookingId: consignmentId,
      trackingNumber: consignmentId,
      status: typeof payload.order_status === 'string' && payload.order_status ? payload.order_status : 'Pending',
    };
  }

  /** Live status by consignment id. Never fakes data — unavailable is honest. */
  async track(trackingNumber: string): Promise<TrackResult> {
    this.assertConfigured();
    const cid = trackingNumber.trim();
    if (!cid) {
      return { available: false, reason: 'ট্র্যাকিং নম্বর দেওয়া হয়নি।' };
    }
    try {
      const info = await this.getOrderInfo(cid);
      return { available: true, status: info };
    } catch (err) {
      return { available: false, reason: (err as Error).message };
    }
  }

  /** GET /aladdin/api/v1/orders/{consignment_id}/info → order_status string. */
  async getOrderInfo(consignmentId: string): Promise<string> {
    this.assertConfigured();
    const data = await this.call(`/aladdin/api/v1/orders/${encodeURIComponent(consignmentId)}/info`);
    const payload = (data.data ?? null) as { order_status?: unknown; order_status_slug?: unknown } | null;
    const status = payload?.order_status ?? payload?.order_status_slug;
    if (typeof status !== 'string' || !status) {
      throw new Error('Pathao থেকে পার্সেলের অবস্থা পাওয়া যায়নি।');
    }
    return status;
  }

  /** GET /aladdin/api/v1/stores → the merchant's stores (read-only).
   * Used by the verify check so the owner can pick the store_id. */
  async getStores(): Promise<{ storeId: number; storeName: string; isActive: boolean; isDefault: boolean }[]> {
    this.assertConfigured();
    const data = await this.call('/aladdin/api/v1/stores');
    const payload = (data.data ?? null) as { data?: unknown[] } | null;
    const list = Array.isArray(payload?.data) ? (payload.data as Record<string, unknown>[]) : [];
    return list
      .filter((s) => typeof s.store_id === 'number')
      .map((s) => ({
        storeId: s.store_id as number,
        storeName: typeof s.store_name === 'string' ? s.store_name : `Store ${String(s.store_id)}`,
        isActive: (s.is_active as number) === 1,
        isDefault: (s.is_default_store as number) === 1,
      }));
  }

  /** Read-only connection check: issue a token + list stores. Never books. */
  async verifyConnection(): Promise<{ stores: { storeId: number; storeName: string; isActive: boolean; isDefault: boolean }[] }> {
    const stores = await this.getStores();
    return { stores };
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

  private readonly creds: SteadfastCreds;

  /** DB-stored keys (migration 32) may be passed in; they take precedence
   * over env. No-arg construction keeps the old env-only behaviour. */
  constructor(creds: SteadfastCreds = {}) {
    this.creds = creds;
  }

  private baseUrl(): string {
    return (this.creds.baseUrl || config.courier.steadfast.baseUrl || 'https://portal.packzy.com/api/v1').replace(/\/$/, '');
  }

  private resolved(): { apiKey: string; secretKey: string; baseUrl: string } {
    return {
      apiKey: this.creds.apiKey || config.courier.steadfast.apiKey || '',
      secretKey: this.creds.secretKey || config.courier.steadfast.secretKey || '',
      baseUrl: this.baseUrl(),
    };
  }

  private assertConfigured(): { apiKey: string; secretKey: string; baseUrl: string } {
    const c = this.resolved();
    if (!c.apiKey || !c.secretKey) {
      throw new ProviderNotConfiguredError(
        'steadfast',
        'Steadfast মার্চেন্ট অ্যাকাউন্টের API চাবি (Api-Key / Secret-Key — কুরিয়ার পেজে বসান)',
      );
    }
    return c;
  }

  private headers(): Record<string, string> {
    const c = this.resolved();
    return {
      'Api-Key': c.apiKey,
      'Secret-Key': c.secretKey,
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

/** Provider instance by name — used when a shipment's own courier matters, not the env default.
 * Optional `creds` are DB-stored credentials (migration 32); they take
 * precedence over env vars. Omit them for the old env-only behaviour. */
export function providerForName(
  name: string,
  creds: { steadfast?: SteadfastCreds; pathao?: PathaoCreds } = {},
): CourierProvider {
  switch (name) {
    case 'pathao':
      return new PathaoCourierProvider(creds.pathao ?? {});
    case 'steadfast':
      return new SteadfastCourierProvider(creds.steadfast ?? {});
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
