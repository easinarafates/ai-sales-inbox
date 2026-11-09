"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  courierApi, ordersApi, orderItemsOf, orderTotalPaisa, deliveryChargePaisa,
  type CancelRequest, type CourierProviderOption, type Order, type Shipment,
} from "@/lib/api";
import {
  ORDER_STATUSES, PAYMENT_METHODS, handledByLabel, orderSourceLabel,
  orderStatusLabel, paymentMethodLabel, statusBadge,
} from "@/lib/orderStatus";
import { useI18n } from "@/lib/i18n";
import CustomerAvatar from "@/components/CustomerAvatar";

const COURIER_ORDER = ["steadfast", "pathao", "sundarban", "redx"] as const;
const COURIER_LABEL: Record<string, string> = {
  steadfast: "Steadfast", pathao: "Pathao", sundarban: "সুন্দরবন", redx: "RedX",
};

/** Bangladeshi 11-digit phone → international digits for wa.me / tel: links. */
function intlPhone(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("01")) return `880${digits.slice(1)}`;
  if (digits.length === 13 && digits.startsWith("880")) return digits;
  return null;
}

export default function OrderDetailPanel({
  order, shipment, onOrderChange, onClose,
}: {
  order: Order;
  shipment?: Shipment | null;
  onOrderChange: (o: Order) => void;
  onClose?: () => void;
}) {
  const { t, lang, fmtDate, fmtTaka, fmtNum } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [providers, setProviders] = useState<CourierProviderOption[]>([]);
  const [showCouriers, setShowCouriers] = useState(false);
  const [shipmentState, setShipmentState] = useState<Shipment | null>(shipment ?? null);
  const [cancelReq, setCancelReq] = useState<CancelRequest | null>(null);

  useEffect(() => { setShipmentState(shipment ?? null); }, [shipment]);
  useEffect(() => {
    courierApi.provider().then((d) => setProviders(d.providers ?? [])).catch(() => setProviders([]));
  }, []);
  // Pending cancel request for THIS order (the customer asked to cancel;
  // the owner approves / declines here — the AI never cancels on its own).
  useEffect(() => {
    setCancelReq(null);
    ordersApi.cancelRequests("pending")
      .then((d) => setCancelReq((d.requests ?? []).find((r) => r.order_id === order.id) ?? null))
      .catch(() => setCancelReq(null));
  }, [order.id]);

  const items = orderItemsOf(order);
  const pay = order.paymentStatus || order.payment_status;
  const method = order.paymentMethod || order.payment_method || "cod";
  const notProvided = t("orders.notProvided", "Not provided", "দেওয়া হয়নি");
  const custName = order.customer?.name || order.customerName || order.customer_name || "—";
  const custPhone = order.customer?.phone || order.customerPhone || order.customer_phone || "";
  const deliveryAddress = order.deliveryAddress || order.delivery_address || order.customer?.address || "";
  const convId = order.conversationId || order.conversation_id || "";
  const zone = order.zone;
  const handledBy = order.handledBy || order.handled_by;
  const invoiceUrl = order.invoiceUrl;
  // grandTotalPaisa comes from the API as a number (detail endpoint);
  // the fallback must add NUMBERS — the raw fields can be strings
  // (bigint), and string + string concatenates (bug, 2026-11-09).
  const grandTotal = Number(order.grandTotalPaisa ?? order.grandTotal ?? (orderTotalPaisa(order) + deliveryChargePaisa(order)));
  const deliveryCharge = deliveryChargePaisa(order);
  const intl = custPhone ? intlPhone(custPhone) : null;
  const tracking = shipmentState?.trackingNumber || shipmentState?.tracking_number || shipmentState?.trackingCode || shipmentState?.tracking_code || "";
  const lineTotal = (it: { quantity?: number; qty?: number; pricePaisa?: number; price_paisa?: number; price?: number }) =>
    (it.quantity ?? it.qty ?? 1) * (it.pricePaisa ?? it.price_paisa ?? it.price ?? 0);

  const run = async (fn: () => Promise<Order | void>) => {
    setBusy(true); setError(""); setNotice("");
    try {
      const next = await fn();
      if (next) onOrderChange(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("orders.actionFailed", "Could not do that.", "কাজটি করা যায়নি।"));
    } finally { setBusy(false); }
  };

  const changeStatus = (status: string) => run(() => ordersApi.updateStatus(order.id, status));
  const togglePayment = () => run(() => ordersApi.updatePayment(order.id, pay === "paid" ? "unpaid" : "paid"));
  const changePaymentMethod = (m: string) => run(() => ordersApi.updatePaymentMethod(order.id, m));

  const sendToCourier = async (courier: string) => {
    setBusy(true); setError(""); setNotice("");
    try {
      const r = await ordersApi.sendToCourier(order.id, courier);
      if (r.shipment) setShipmentState(r.shipment);
      if (r.order) onOrderChange(r.order);
      setNotice(r.message);
      setShowCouriers(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("orders.courierFailed", "Courier booking failed.", "কুরিয়ার বুকিং করা যায়নি।"));
    } finally { setBusy(false); }
  };

  const sendReceipt = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      const r = await ordersApi.sendReceipt(order.id);
      setNotice(r.sent
        ? t("orders.receiptSent", "Receipt sent to the customer.", "রসিদ কাস্টমারকে পাঠানো হয়েছে।")
        : (r.error || t("orders.receiptNotSent", "Receipt could not be sent — share the invoice link manually.", "রসিদ পাঠানো যায়নি — ইনভয়েস লিংকটি নিজে শেয়ার করুন।")));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("orders.receiptFailed", "Could not send the receipt.", "রসিদ পাঠানো যায়নি।"));
    } finally { setBusy(false); }
  };

  const decideCancel = async (approve: boolean) => {
    if (!cancelReq) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (approve) {
        const r = await ordersApi.approveCancelRequest(cancelReq.id);
        if (r.order) onOrderChange(r.order);
      } else {
        await ordersApi.declineCancelRequest(cancelReq.id);
      }
      setCancelReq(null);
      setNotice(approve
        ? t("orders.cancelApprovedNotice", "Order cancelled and the customer was told.", "অর্ডার ক্যান্সেল হয়েছে, কাস্টমারকে জানানো হয়েছে।")
        : t("orders.cancelDeclinedNotice", "Cancel request declined — the order stays as-is.", "ক্যান্সেলের অনুরোধ প্রত্যাখ্যান করা হয়েছে — অর্ডার যেমন ছিল তেমনই আছে।"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("orders.actionFailed", "Could not do that.", "কাজটি করা যায়নি।"));
    } finally { setBusy(false); }
  };

  const copyInvoice = async () => {
    if (!invoiceUrl) return;
    try { await navigator.clipboard.writeText(invoiceUrl); setNotice(t("orders.linkCopied", "Invoice link copied.", "ইনভয়েস লিংক কপি হয়েছে।")); }
    catch { setNotice(invoiceUrl); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">{t("orders.bill", "Bill", "বিল")} — {order.orderNumber || order.order_number || order.id.slice(0, 8)}</h2>
          <p className="text-sm text-slate-500 mt-1">{fmtDate(order.createdAt || order.created_at)} · {orderSourceLabel(order.source, lang)}</p>
        </div>
        {onClose && <button onClick={onClose} className="text-slate-500 hover:text-slate-800 text-xl leading-none px-2" aria-label="Close">✕</button>}
      </div>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg">{error}</p>}
      {notice && <p className="bg-green-50 text-green-800 text-sm p-3 rounded-lg">{notice}</p>}

      {/* Pending cancel request — the customer asked to cancel; the owner approves / declines. */}
      {cancelReq && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
          <p className="font-bold text-sm text-amber-900">{t("orders.cancelRequestTitle", "Customer wants to cancel this order", "কাস্টমার এই অর্ডারটি ক্যান্সেল করতে চাচ্ছেন")}</p>
          {cancelReq.reason && <p className="text-sm text-amber-800 mt-1">“{cancelReq.reason}”</p>}
          <p className="text-xs text-amber-700 mt-1">{t("orders.cancelRequestHint", "Approving cancels the order and tells the customer. Declining leaves the order as-is.", "অনুমোদন করলে অর্ডার ক্যান্সেল হবে এবং কাস্টমারকে জানানো হবে। প্রত্যাখ্যান করলে অর্ডার যেমন ছিল তেমনই থাকবে।")}</p>
          <div className="flex gap-2 mt-3">
            <button disabled={busy} onClick={() => decideCancel(true)} className="bg-red-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-red-700 disabled:opacity-50">
              {t("orders.approveCancel", "Approve cancel", "ক্যান্সেল অনুমোদন")}
            </button>
            <button disabled={busy} onClick={() => decideCancel(false)} className="bg-white border px-4 py-2 rounded-lg text-sm disabled:opacity-50">
              {t("orders.declineCancel", "Decline", "প্রত্যাখ্যান")}
            </button>
          </div>
        </div>
      )}

      {/* Who ordered + where to deliver + who talked to them */}
      <div className="card p-4">
        <div className="flex items-start gap-3">
          <CustomerAvatar name={custName === "—" ? "?" : custName} pictureUrl={order.customer?.picture_url} sizeClass="h-12 w-12" />
          <div className="flex-1 min-w-0">
            <p className="font-bold">{custName}</p>
            <p className="text-sm mt-1"><span className="text-slate-500">{t("orders.phoneLabel", "Phone:", "ফোন:")}</span> {custPhone || <span className="text-slate-400">{notProvided}</span>}</p>
            <p className="text-sm mt-1"><span className="text-slate-500">{t("orders.addressLabel", "Delivery address:", "ডেলিভারি ঠিকানা:")}</span> {deliveryAddress || <span className="text-slate-400">{notProvided}</span>}</p>
            {zone && <p className="text-sm mt-1"><span className="text-slate-500">{t("orders.zoneLabel", "Zone:", "জোন:")}</span> {zone.label}{zone.insideDhaka ? ` (${t("orders.insideDhaka", "inside Dhaka", "ঢাকার ভেতরে")})` : ` (${t("orders.outsideDhaka", "outside Dhaka", "ঢাকার বাইরে")})`}</p>}
            <p className="text-sm mt-1"><span className="text-slate-500">{t("orders.handledByLabel", "Talked to the customer:", "কাস্টমারের সাথে কথা বলেছে:")}</span> {handledByLabel(handledBy, lang)}</p>
          </div>
        </div>
        {/* Contact: WhatsApp / Open Chat / Call */}
        <div className="flex flex-wrap gap-2 mt-4">
          {intl ? (
            <>
              <a href={`https://wa.me/${intl}`} target="_blank" rel="noreferrer" className="bg-green-600 text-white px-3 py-2 rounded-lg text-sm">WhatsApp</a>
              <a href={`tel:+${intl}`} className="bg-white border px-3 py-2 rounded-lg text-sm">📞 {t("orders.call", "Call", "কল করুন")}</a>
            </>
          ) : (
            <span className="text-xs text-slate-400 self-center">{t("orders.noPhoneContact", "No phone — WhatsApp / call unavailable.", "ফোন নেই — WhatsApp / কল করা যাবে না।")}</span>
          )}
          {convId && <Link href={`/inbox?conversation=${convId}`} className="bg-white border px-3 py-2 rounded-lg text-sm">💬 {t("orders.openChat", "Open chat", "চ্যাট খুলুন")}</Link>}
        </div>
      </div>

      {/* Bill — items, delivery charge, grand total */}
      <div className="card p-4">
        <div className="flex gap-2 mb-3">{statusBadge(order.status, lang)}
          <span className={`text-xs px-2 py-0.5 rounded ${pay === "paid" ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}`}>{pay === "paid" ? t("orders.paymentPaid", "Paid", "পরিশোধিত") : t("orders.paymentUnpaid", "Unpaid", "অপরিশোধিত")}</span>
          <span className="text-xs px-2 py-0.5 rounded bg-orange-100 text-orange-800">{paymentMethodLabel(method, lang)}</span>
        </div>
        <table className="w-full text-sm">
          <thead><tr className="table-head border-b text-left text-slate-500"><th className="py-2">{t("orders.thItem", "Item", "আইটেম")}</th><th className="py-2 text-right">{t("orders.thQty", "Quantity", "পরিমাণ")}</th><th className="py-2 text-right">{t("orders.thPrice", "Price", "দাম")}</th><th className="py-2 text-right">{t("orders.thLineTotal", "Line total", "লাইন মোট")}</th></tr></thead>
          <tbody>
            {items.length === 0 && <tr><td colSpan={4} className="py-3 text-slate-500">{t("orders.noItems", "No item details found.", "কোনো আইটেমের বিবরণ পাওয়া যায়নি।")}</td></tr>}
            {items.map((it, i) => (
              <tr key={it.id || i} className="border-b">
                <td className="py-2">{it.productName || it.product_name || it.name || t("orders.itemFallback", "Item", "আইটেম")}</td>
                <td className="py-2 text-right">{fmtNum(it.quantity ?? it.qty ?? 1)}</td>
                <td className="py-2 text-right">{fmtTaka(it.pricePaisa ?? it.price_paisa ?? it.price ?? 0)}</td>
                <td className="py-2 text-right">{fmtTaka(lineTotal(it))}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-sm text-right mt-3">{t("orders.deliveryCharge", "Delivery charge:", "ডেলিভারি চার্জ:")} {fmtTaka(deliveryCharge)}</p>
        <p className="text-right font-bold text-lg">{t("common.total", "Total", "মোট")}: {fmtTaka(grandTotal)}</p>
        {order.deliveryEstimate && <p className="text-xs text-slate-500 text-right mt-1">{t("orders.deliveryEstimate", "Estimated delivery:", "আনুমানিক ডেলিভারি:")} {order.deliveryEstimate}</p>}
      </div>

      {/* Manual status — the owner picks any status */}
      <div className="card p-4">
        <h3 className="font-bold mb-2 text-sm">{t("orders.changeStatus", "Change status", "স্ট্যাটাস বদলান")}</h3>
        <div className="flex flex-wrap gap-2">
          {ORDER_STATUSES.map((s) => (
            <button key={s} disabled={busy || order.status === s} onClick={() => changeStatus(s)}
              className={`px-3 py-1.5 rounded-lg text-sm border disabled:opacity-50 ${order.status === s ? "bg-brand text-white border-brand" : "bg-white hover:bg-orange-50"}`}>
              {orderStatusLabel(s, lang)}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 mt-4">
          <button disabled={busy} onClick={togglePayment} className="bg-amber-500 text-white px-3 py-2 rounded-lg text-sm disabled:opacity-50">
            {pay === "paid" ? t("orders.markUnpaid", "Mark as unpaid", "অপরিশোধিত করুন") : t("orders.markPaid", "Mark as paid", "পরিশোধিত করুন")}
          </button>
          <select value={method} disabled={busy} onChange={(e) => changePaymentMethod(e.target.value)} className="border rounded-lg px-3 py-2 bg-white text-sm">
            {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{paymentMethodLabel(m, lang)}</option>)}
          </select>
        </div>
      </div>

      {/* Send to Courier */}
      <div className="card p-4">
        <h3 className="font-bold mb-2 text-sm">{t("orders.sendToCourier", "Send to Courier", "কুরিয়ারে পাঠান")}</h3>
        {tracking ? (
          <p className="text-sm">{t("orders.tracking", "Tracking:", "ট্র্যাকিং:")} <b className="font-mono">{tracking}</b> <span className="text-slate-500">({shipmentState?.courier || ""})</span></p>
        ) : showCouriers ? (
          <div className="space-y-2">
            {COURIER_ORDER.map((name) => {
              const p = providers.find((x) => x.name === name);
              const configured = p?.configured ?? false;
              // This shop uses only Steadfast + Pathao: Sundarban / RedX
              // stay visible but muted and honestly "not connected".
              const notUsed = name === "sundarban" || name === "redx";
              return (
                <button key={name} disabled={busy} onClick={() => sendToCourier(name)} className={`w-full text-left border rounded-lg px-3 py-2 text-sm hover:bg-orange-50 disabled:opacity-50 ${notUsed ? "opacity-60" : ""}`}>
                  <span className="font-medium">{COURIER_LABEL[name] || name}</span>
                  {notUsed && <span className="text-xs text-slate-400"> {t("orders.courierNotUsed", "(not used)", "(ব্যবহার করা হয় না)")}</span>}
                  <span className={`block text-xs ${configured ? "text-green-700" : "text-slate-500"}`}>
                    {configured
                      ? t("orders.courierReady", "Connected — booking will be made now.", "যুক্ত আছে — এখনই বুকিং হবে।")
                      : (p?.needs ? `${t("orders.courierNotConnected", "Not connected yet:", "এখনো যুক্ত হয়নি:")} ${p.needs}` : t("orders.courierNotConnectedShort", "Not connected yet.", "এখনো যুক্ত হয়নি।"))}
                  </span>
                </button>
              );
            })}
            <button disabled={busy} onClick={() => setShowCouriers(false)} className="text-sm text-slate-500 underline">{t("common.cancel", "Cancel", "বাতিল")}</button>
          </div>
        ) : (
          <button disabled={busy} onClick={() => setShowCouriers(true)} className="bg-brand text-white px-4 py-2 rounded-lg text-sm hover:bg-brand-dark disabled:opacity-50">
            {t("orders.sendToCourierBtn", "Send to Courier →", "কুরিয়ারে পাঠান →")}
          </button>
        )}
      </div>

      {/* Receipt + invoice link */}
      <div className="card p-4">
        <h3 className="font-bold mb-2 text-sm">{t("orders.receipt", "Receipt / Invoice", "রসিদ / ইনভয়েস")}</h3>
        {invoiceUrl ? (
          <p className="text-sm break-all"><a href={invoiceUrl} target="_blank" rel="noreferrer" className="text-brand-dark underline">{invoiceUrl}</a></p>
        ) : (
          <p className="text-sm text-slate-400">{t("orders.noInvoice", "No invoice link yet.", "ইনভয়েস লিংক এখনো নেই।")}</p>
        )}
        <div className="flex flex-wrap gap-2 mt-3">
          {invoiceUrl && <button disabled={busy} onClick={copyInvoice} className="bg-white border px-3 py-2 rounded-lg text-sm disabled:opacity-50">{t("orders.copyLink", "Copy invoice link", "ইনভয়েস লিংক কপি করুন")}</button>}
          <button disabled={busy} onClick={sendReceipt} className="bg-white border border-green-600 text-green-700 px-3 py-2 rounded-lg text-sm hover:bg-green-50 disabled:opacity-50">
            {t("orders.sendReceipt", "Send receipt to customer", "কাস্টমারকে রসিদ পাঠান")}
          </button>
        </div>
      </div>
    </div>
  );
}
