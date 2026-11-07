"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  asArray,
  getToken,
  ordersApi,
  orderTotalPaisa,
  type Order,
} from "@/lib/api";
import {
  courierApi,
  shipmentOrderId,
  shipmentTrackingNumber,
  type CourierProviderInfo,
  type Shipment,
  type TrackResult,
} from "@/lib/courier";
import { useI18n } from "@/lib/i18n";

const SHIPMENT_STATUS_KEYS: Record<string, string> = {
  awaiting_provider: "shipmentStatus.awaiting_provider",
  booked: "shipmentStatus.booked",
  picked_up: "shipmentStatus.picked_up",
  in_transit: "shipmentStatus.in_transit",
  delivered: "shipmentStatus.delivered",
  cancelled: "shipmentStatus.cancelled",
  failed: "shipmentStatus.failed",
  in_review: "shipmentStatus.in_review",
  pending: "shipmentStatus.pending",
  hold: "shipmentStatus.hold",
  partial_delivered: "shipmentStatus.partial_delivered",
};
const SHIPMENT_STATUS_FALLBACK: Record<string, [string, string]> = {
  awaiting_provider: ["Courier not connected", "কুরিয়ার যুক্ত হয়নি"],
  booked: ["Booked", "বুক হয়েছে"],
  picked_up: ["Picked up", "পিকআপ হয়েছে"],
  in_transit: ["On the way", "পথে আছে"],
  delivered: ["Delivered", "ডেলিভারি হয়েছে"],
  cancelled: ["Cancelled", "বাতিল"],
  failed: ["Failed", "ব্যর্থ"],
  in_review: ["In review", "যাচাই হচ্ছে"],
  pending: ["Pending", "অপেক্ষায়"],
  hold: ["On hold", "আটকে আছে"],
  partial_delivered: ["Partially delivered", "আংশিক ডেলিভারি হয়েছে"],
};

export default function CourierPage() {
  const router = useRouter();
  const { t, fmtDate, fmtTaka } = useI18n();
  const [orders, setOrders] = useState<Order[]>([]);
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [providerInfo, setProviderInfo] = useState<CourierProviderInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [selectedOrderId, setSelectedOrderId] = useState("");
  const [trackingInput, setTrackingInput] = useState("");
  const [trackResult, setTrackResult] = useState<TrackResult | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [booking, setBooking] = useState(false);
  const [tracking, setTracking] = useState(false);

  const shipmentStatusLabel = (s?: string | null) => {
    if (!s) return "—";
    const fb = SHIPMENT_STATUS_FALLBACK[s] || [s, s];
    return t(SHIPMENT_STATUS_KEYS[s] || "", fb[0], fb[1]);
  };

  const load = useCallback(async () => {
    try {
      const [orderData, shipmentData, providerData] = await Promise.all([
        ordersApi.list(),
        courierApi.listShipments(),
        courierApi.providerInfo().catch(() => null),
      ]);
      setOrders(asArray(orderData));
      setShipments(shipmentData);
      if (providerData) setProviderInfo(providerData);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("courier.loadFailed", "Could not load courier information.", "কুরিয়ার তথ্য লোড করা যায়নি।"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!getToken()) {
      router.push("/login");
      return;
    }
    load();
  }, [load, router]);

  const bookCourier = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedOrderId) return;
    setError("");
    setNotice("");
    setBooking(true);
    try {
      const res = await courierApi.book(selectedOrderId);
      setNotice(
        res.message ||
          (res.providerConfigured
            ? t("courier.booked", "Courier booking completed.", "কুরিয়ার বুকিং সম্পন্ন হয়েছে।")
            : t("courier.bookedSaved", "Courier booking saved — the real courier is not connected yet, so no tracking number yet.", "কুরিয়ার বুকিং সংরক্ষণ করা হয়েছে — আসল কুরিয়ার এখনো যুক্ত হয়নি, তাই ট্র্যাকিং নম্বর এখনো পাওয়া যায়নি।"))
      );
      setSelectedOrderId("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("courier.bookFailed", "Courier booking failed.", "কুরিয়ার বুকিং ব্যর্থ হয়েছে।"));
    } finally {
      setBooking(false);
    }
  };

  const lookupTracking = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!trackingInput.trim()) return;
    setError("");
    setTrackResult(null);
    setTracking(true);
    try {
      const res = await courierApi.track(trackingInput.trim());
      setTrackResult(res);
    } catch (err) {
      // 404 (unknown number) also comes back as an error — show it honestly.
      setTrackResult({
        available: false,
        reason:
          err instanceof Error
            ? err.message
            : t("courier.trackNotFound", "This tracking number was not found — check if the number is correct.", "এই ট্র্যাকিং নম্বর পাওয়া যায়নি — নম্বরটি ঠিক আছে কি না দেখুন।"),
      });
    } finally {
      setTracking(false);
    }
  };

  const checkStatusNow = async () => {
    setError("");
    setNotice("");
    setChecking(true);
    try {
      const res = await courierApi.checkStatus();
      setNotice(
        t(
          "courier.checkDone",
          `Checked ${res.checked} shipment(s): ${res.changed} status change(s), ${res.notified} customer message(s) sent.`,
          `${res.checked}টি শিপমেন্ট দেখা হয়েছে: ${res.changed}টি অবস্থা বদলেছে, ${res.notified}টি কাস্টমার মেসেজ পাঠানো হয়েছে।`
        )
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("courier.checkFailed", "Status check failed.", "অবস্থা দেখা যায়নি।"));
    } finally {
      setChecking(false);
    }
  };

  const shippedOrderIds = new Set(shipments.map((s) => shipmentOrderId(s)));
  const bookableOrders = orders.filter((o) => !shippedOrderIds.has(o.id));

  if (loading) return <p className="text-slate-500">{t("common.loading", "Loading…", "লোড হচ্ছে…")}</p>;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">
        {t("courier.title", "Courier", "কুরিয়ার")}
      </h1>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}
      {notice && <p className="bg-green-50 text-green-800 text-sm p-3 rounded-lg mb-4">{notice}</p>}

      <div className="card p-4 mb-6">
        <p className="font-bold mb-1">
          {t("courier.providerTitle", "Courier provider", "কুরিয়ার প্রোভাইডার")}
          {providerInfo ? `: ${providerInfo.provider === "steadfast" ? "Steadfast" : providerInfo.provider === "pathao" ? "Pathao" : providerInfo.provider === "redx" ? "RedX" : t("courier.stubName", "Local only (stub)", "শুধু লোকাল (স্টাব)")}` : ""}
        </p>
        {providerInfo && (
          <ul className="text-sm text-slate-600 space-y-1">
            {providerInfo.providers.map((p) => (
              <li key={p.name}>
                <span className="font-medium">{p.name === "steadfast" ? "Steadfast" : p.name === "pathao" ? "Pathao" : p.name === "redx" ? "RedX" : t("courier.stubName", "Local only (stub)", "শুধু লোকাল (স্টাব)")}</span>
                {" — "}
                {p.selected ? t("courier.selected", "selected", "নির্বাচিত") + " • " : ""}
                {p.configured
                  ? t("courier.connected", "connected", "যুক্ত আছে")
                  : p.name === "stub"
                    ? t("courier.stubDesc", "saves bookings locally only, no tracking number", "শুধু লোকালভাবে বুকিং সংরক্ষণ করে, ট্র্যাকিং নম্বর দেয় না")
                    : t("courier.needsKeys", "keys needed", "চাবি লাগবে") + ` (${p.needs})`}
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-slate-500 mt-2">
          {t("courier.providerNote", "All four options stay available — the provider is chosen in the server settings (COURIER_PROVIDER). Real booking and live tracking need that provider's merchant API key.", "চারটি অপশনই থাকবে — প্রোভাইডার সার্ভার সেটিংসে (COURIER_PROVIDER) বেছে নেওয়া হয়। আসল বুকিং ও লাইভ ট্র্যাকিং পেতে সেই প্রোভাইডারের মার্চেন্ট API চাবি লাগবে।")}
        </p>
        {providerInfo && !providerInfo.configured && (
          <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3 mt-3">
            {t("courier.notConnectedBody", "Booking now will only save the request — no tracking number will come. To get real booking and live tracking you need a Pathao / Steadfast / RedX merchant API key.", "এখন বুকিং করলে শুধু অনুরোধটি সংরক্ষণ হবে — ট্র্যাকিং নম্বর আসবে না। আসল বুকিং ও লাইভ ট্র্যাকিং পেতে Pathao / Steadfast / RedX-এর মার্চেন্ট API চাবি লাগবে।")}
          </p>
        )}
      </div>

      <form onSubmit={bookCourier} className="card p-4 mb-6 flex flex-wrap gap-2 items-end">
        <div className="flex-1 min-w-64">
          <label className="block text-sm font-medium mb-1">{t("courier.pickOrder", "Pick an order", "অর্ডার বেছে নিন")}</label>
          <select
            required
            value={selectedOrderId}
            onChange={(e) => setSelectedOrderId(e.target.value)}
            className="w-full border rounded-lg px-3 py-2 bg-white"
          >
            <option value="">{t("courier.pickOrderPlaceholder", "— Pick an order —", "— অর্ডার বেছে নিন —")}</option>
            {bookableOrders.map((o) => (
              <option key={o.id} value={o.id}>
                {t("courier.orderOption", "Order", "অর্ডার")} {o.id.slice(0, 8)} • {fmtTaka(orderTotalPaisa(o))} • {o.status || "—"}
              </option>
            ))}
          </select>
        </div>
        <button disabled={booking || bookableOrders.length === 0} className="bg-brand text-white px-5 py-2 rounded-lg hover:bg-brand-dark disabled:opacity-50">
          {booking ? t("courier.booking", "Booking…", "বুক হচ্ছে…") : t("courier.bookButton", "Book courier", "কুরিয়ার বুক করুন")}
        </button>
        <p className="text-xs text-slate-500 w-full">
          {t("courier.oneBookingNote", "One order gets only one courier booking — orders already booked will not show in the list.", "একটি অর্ডারে একটিই কুরিয়ার বুকিং হয় — আগেই বুক করা অর্ডার তালিকায় দেখাবে না।")}
        </p>
      </form>

      <form onSubmit={lookupTracking} className="card p-4 mb-6 flex flex-wrap gap-2 items-end">
        <div className="flex-1 min-w-64">
          <label className="block text-sm font-medium mb-1">{t("courier.trackLabel", "Search by tracking number", "ট্র্যাকিং নম্বর দিয়ে খুঁজুন")}</label>
          <input
            value={trackingInput}
            onChange={(e) => setTrackingInput(e.target.value)}
            placeholder={t("courier.trackPlaceholder", "e.g. TRK123456", "যেমন: TRK123456")}
            className="w-full border rounded-lg px-3 py-2"
          />
        </div>
        <button disabled={tracking} className="bg-green-600 text-white px-5 py-2 rounded-lg hover:bg-green-700 disabled:opacity-50">
          {tracking ? t("courier.tracking", "Searching…", "খুঁজছি…") : t("courier.trackButton", "Track", "ট্র্যাক করুন")}
        </button>
      </form>
      {trackResult && (
        <div className={`rounded-xl shadow p-4 mb-6 text-sm ${trackResult.available ? "bg-green-50 text-green-800" : "bg-white text-slate-700"}`}>
          {trackResult.available ? (
            <p>
              <span className="font-bold">{t("courier.trackAvailable", "Parcel status:", "পার্সেলের অবস্থা:")} </span>
              {trackResult.status || "—"}
            </p>
          ) : (
            <p>
              <span className="font-bold">{t("courier.trackUnavailable", "Tracking not found.", "ট্র্যাকিং পাওয়া যাচ্ছে না।")} </span>
              {trackResult.reason || t("courier.trackNoProvider", "The courier provider is not connected yet.", "কুরিয়ার প্রোভাইডার এখনো যুক্ত হয়নি।")}
            </p>
          )}
        </div>
      )}

      <div className="flex items-center gap-3 mb-2">
        <h2 className="font-bold">{t("courier.shipmentsTitle", "Shipment list", "শিপমেন্টের তালিকা")}</h2>
        <button
          onClick={checkStatusNow}
          disabled={checking || shipments.length === 0}
          className="bg-brand text-white text-sm px-4 py-1.5 rounded-lg hover:bg-brand-dark disabled:opacity-50"
        >
          {checking ? t("courier.checking", "Checking…", "দেখছি…") : t("courier.checkNow", "Check status now", "এখন অবস্থা দেখুন")}
        </button>
        <p className="text-xs text-slate-500">
          {t("courier.checkNote", "Steadfast status is also checked automatically every 5 minutes; the customer is messaged when a parcel is delivered, cancelled or held.", "Steadfast-এর অবস্থা প্রতি ৫ মিনিটে আপনাআপনি দেখা হয়; পার্সেল ডেলিভারি হলে, বাতিল হলে বা আটকে গেলে কাস্টমারকে মেসেজ পাঠানো হয়।")}
        </p>
      </div>
      {shipments.length === 0 ? (
        <div className="empty-state">{t("courier.empty", "No shipments yet.", "এখনো কোনো শিপমেন্ট নেই।")}</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="table-head border-b text-left text-slate-500">
                <th className="p-3">{t("courier.thOrder", "Order", "অর্ডার")}</th>
                <th className="p-3">{t("courier.thCustomer", "Customer", "কাস্টমার")}</th>
                <th className="p-3">{t("courier.thCourier", "Courier", "কুরিয়ার")}</th>
                <th className="p-3">{t("courier.thTracking", "Tracking number", "ট্র্যাকিং নম্বর")}</th>
                <th className="p-3">{t("courier.thStatus", "Status", "অবস্থা")}</th>
                <th className="p-3">{t("courier.thDate", "Date", "তারিখ")}</th>
              </tr>
            </thead>
            <tbody>
              {shipments.map((s) => (
                <tr key={s.id} className="border-b">
                  <td className="p-3">{shipmentOrderId(s).slice(0, 8)}</td>
                  <td className="p-3">{(s.customer_name as string) || "—"}</td>
                  <td className="p-3">{s.courier || "—"}</td>
                  <td className="p-3">{shipmentTrackingNumber(s) || t("courier.noTrackingYet", "Not available yet", "এখনো পাওয়া যায়নি")}</td>
                  <td className="p-3">{shipmentStatusLabel(s.status)}</td>
                  <td className="p-3">{fmtDate(s.createdAt || s.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
