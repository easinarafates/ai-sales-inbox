// Courier typed fetch helpers (courier module — own file, lib/api.ts untouched).
import { api, asArrayOf } from "@/lib/api";

export interface Shipment {
  id: string;
  orderId?: string;
  order_id?: string;
  courier?: string;
  trackingCode?: string | null;
  tracking_code?: string | null;
  trackingNumber?: string | null;
  tracking_number?: string | null;
  providerBookingId?: string | null;
  provider_booking_id?: string | null;
  status?: string;
  order_total_paisa?: number;
  order_status?: string;
  customer_name?: string;
  customer_phone?: string;
  createdAt?: string;
  created_at?: string;
  [key: string]: unknown;
}

export function shipmentTrackingNumber(s: Shipment): string | null {
  return s.trackingNumber ?? s.tracking_number ?? s.trackingCode ?? s.tracking_code ?? null;
}

export function shipmentOrderId(s: Shipment): string {
  return s.orderId ?? s.order_id ?? "";
}

export const SHIPMENT_STATUS_BN: Record<string, string> = {
  awaiting_provider: "কুরিয়ার যুক্ত হয়নি",
  booked: "বুক হয়েছে",
  picked_up: "পিকআপ হয়েছে",
  in_transit: "পথে আছে",
  delivered: "ডেলিভারি হয়েছে",
  cancelled: "বাতিল",
  failed: "ব্যর্থ",
};

export function shipmentStatusBn(status?: string | null): string {
  if (!status) return "—";
  return SHIPMENT_STATUS_BN[status] ?? status;
}

export interface BookCourierResult {
  shipment: Shipment;
  provider?: string;
  providerConfigured?: boolean;
  alreadyBooked?: boolean;
  message?: string;
  [key: string]: unknown;
}

export interface TrackResult {
  available: boolean;
  status?: string;
  reason?: string;
  shipment?: Shipment;
  [key: string]: unknown;
}

export interface CourierProviderOption {
  name: string;
  configured: boolean;
  needs: string;
  selected: boolean;
}

export interface CourierProviderInfo {
  provider: string;
  configured: boolean;
  providers: CourierProviderOption[];
}

export interface ShipmentCheckSummary {
  checked: number;
  changed: number;
  notified: number;
  failed: number;
  errors: string[];
}

export type DeliveryChargeScope = "inside_dhaka" | "outside_dhaka" | "district";

export interface DeliveryChargeRule {
  id: string;
  scope: DeliveryChargeScope;
  district: string | null;
  chargePaisa: number;
}

export const deliveryChargesApi = {
  list: () => api.get<{ rules: DeliveryChargeRule[] }>("/api/delivery-charges"),
  save: (rules: { scope: DeliveryChargeScope; district?: string | null; chargePaisa: number }[]) =>
    api.put<{ rules: DeliveryChargeRule[] }>("/api/delivery-charges", { rules }),
};

export const courierApi = {
  book: (orderId: string) =>
    api.post<BookCourierResult>("/api/courier/bookings", { orderId }),
  listShipments: async () => {
    const data = await api.get<Shipment[] | { shipments: Shipment[] }>(
      "/api/courier/shipments"
    );
    return asArrayOf<Shipment>(data, ["shipments"]);
  },
  track: (trackingNumber: string) =>
    api.get<TrackResult>(
      `/api/courier/track/${encodeURIComponent(trackingNumber)}`
    ),
  providerInfo: () => api.get<CourierProviderInfo>("/api/courier/provider"),
  balance: () =>
    api.get<{ available: boolean; currentBalance?: number; reason?: string }>(
      "/api/courier/balance"
    ),
  checkStatus: () =>
    api.post<ShipmentCheckSummary & { ok: boolean }>(
      "/api/courier/check-status",
      {}
    ),
};
