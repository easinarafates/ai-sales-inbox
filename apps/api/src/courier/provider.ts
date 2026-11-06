/**
 * Courier providers — config-gated selection.
 *
 * COURIER_PROVIDER=stub (default) | pathao | steadfast | redx
 *
 * HARD RULE: never invent a tracking number or a booking confirmation.
 * - The stub provider creates only a local shipment row with status
 *   'awaiting_provider' and NO tracking number. It means: "we saved the
 *   booking request, but no real courier has it yet."
 * - Pathao / Steadfast / RedX implement the same interface, but every
 *   method fails honestly with PROVIDER_NOT_CONFIGURED until real API
 *   credentials are set (see config.courier). They never return a fake
 *   booking id or tracking number.
 */

import { config } from '../config';

export type CourierProviderName = 'stub' | 'pathao' | 'steadfast' | 'redx';

export const COURIER_PROVIDERS: CourierProviderName[] = ['stub', 'pathao', 'steadfast', 'redx'];

/** Minimal order data a courier booking needs. */
export interface OrderForBooking {
  id: string;
  customerId: string | null;
  totalPaisa: number;
  status: string;
  customerName?: string | null;
  customerPhone?: string | null;
  customerAddress?: string | null;
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
 * Steadfast Courier — TODO stub.
 * TODO: implement with the real Steadfast API once merchant credentials
 * exist (STEADFAST_BASE_URL, STEADFAST_API_KEY, STEADFAST_SECRET_KEY —
 * see config.courier.steadfast). Until then every call fails honestly.
 */
export class SteadfastCourierProvider implements CourierProvider {
  readonly name: CourierProviderName = 'steadfast';

  private assertConfigured(): void {
    if (!config.courier.steadfast.apiKey || !config.courier.steadfast.secretKey) {
      throw new ProviderNotConfiguredError(
        'steadfast',
        'Steadfast মার্চেন্ট অ্যাকাউন্টের API চাবি (STEADFAST_API_KEY / STEADFAST_SECRET_KEY)',
      );
    }
  }

  async createBooking(_order: OrderForBooking): Promise<BookingResult> {
    this.assertConfigured();
    // TODO: POST {STEADFAST_BASE_URL}/create_order — real booking.
    throw new Error('Steadfast বুকিং এখনো বাস্তবায়ন হয়নি (TODO) — চাবি থাকলেও এখনো API কল লেখা হয়নি।');
  }

  async track(_trackingNumber: string): Promise<TrackResult> {
    this.assertConfigured();
    // TODO: GET {STEADFAST_BASE_URL}/status_by_tracking_code/{trackingNumber} — real tracking.
    throw new Error('Steadfast ট্র্যাকিং এখনো বাস্তবায়ন হয়নি (TODO)।');
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
  switch (name) {
    case 'pathao':
      return new PathaoCourierProvider();
    case 'steadfast':
      return new SteadfastCourierProvider();
    case 'redx':
      return new RedXCourierProvider();
    case 'stub':
    default:
      if (name !== 'stub') {
        console.warn(`[courier] unknown COURIER_PROVIDER="${name}" — falling back to stub (no real booking)`);
      }
      return new StubCourierProvider();
  }
}
