"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { getToken, ordersApi, orderItemsOf, orderTotalPaisa, type Order } from "@/lib/api";
import { ORDER_STATUSES, orderStatusLabel, statusBadge } from "@/lib/orderStatus";
import { useI18n } from "@/lib/i18n";

// Allowed forward flow (Phase 1): pending -> approved -> processing -> ready_to_ship -> in_transit -> delivered
// on_hold can be set from pending/approved/processing and released back.
const NEXT_STEP: Record<string, string> = {
  pending: "approved", approved: "processing", processing: "ready_to_ship",
  ready_to_ship: "in_transit", in_transit: "delivered",
};

export default function OrderDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { t, lang, fmtDate, fmtTaka, fmtNum } = useI18n();
  const id = params.id as string;
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setOrder(await ordersApi.get(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("orders.loadDetailFailed", "Order not found.", "অর্ডার পাওয়া যায়নি।"));
    } finally {
      setLoading(false);
    }
  }, [id, t]);

  useEffect(() => {
    if (!getToken()) { router.push("/login"); return; }
    load();
  }, [load, router]);

  const changeStatus = async (status: string) => {
    setBusy(true); setError("");
    try {
      setOrder(await ordersApi.updateStatus(id, status));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("orders.statusFailed", "Could not change the status.", "স্ট্যাটাস বদলানো যায়নি।"));
    } finally { setBusy(false); }
  };

  const togglePayment = async () => {
    if (!order) return;
    const current = order.paymentStatus || order.payment_status;
    const next = current === "paid" ? "unpaid" : "paid";
    setBusy(true); setError("");
    try {
      setOrder(await ordersApi.updatePayment(id, next));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("orders.paymentFailed", "Could not change the payment status.", "পেমেন্ট স্ট্যাটাস বদলানো যায়নি।"));
    } finally { setBusy(false); }
  };

  if (loading) return <p className="text-slate-500">{t("common.loading", "Loading…", "লোড হচ্ছে…")}</p>;
  if (error && !order) return <div><p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg">{error}</p><Link href="/orders" className="text-brand-dark underline text-sm">{t("orders.backToList", "← Back to order list", "← অর্ডার তালিকায় ফিরুন")}</Link></div>;
  if (!order) return <p className="text-slate-500">{t("orders.detailNotFound", "Order not found.", "অর্ডার পাওয়া যায়নি।")}</p>;

  const items = orderItemsOf(order);
  const next = order.status ? NEXT_STEP[order.status] : undefined;
  const pay = order.paymentStatus || order.payment_status;

  return (
    <div>
      <Link href="/orders" className="text-brand-dark underline text-sm">{t("orders.listLink", "← Order list", "← অর্ডার তালিকা")}</Link>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mt-3">{error}</p>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-3">
        {/* Bill view */}
        <div className="card p-6">
          <h1 className="text-xl font-bold">{t("orders.bill", "Bill", "বিল")} — {order.orderNumber || order.order_number || order.id.slice(0, 8)}</h1>
          <p className="text-sm text-slate-500 mt-1">{t("orders.billDate", "Date:", "তারিখ:")} {fmtDate(order.createdAt || order.created_at)}</p>
          <p className="text-sm mt-1">{t("orders.customerLabel", "Customer:", "কাস্টমার:")} {order.customer?.name || "—"}{order.customer?.phone ? ` • ${order.customer.phone}` : ""}</p>
          <div className="flex gap-2 mt-3">{statusBadge(order.status, lang)}
            <span className={`text-xs px-2 py-0.5 rounded ${pay === "paid" ? "bg-teal-100 text-teal-800" : "bg-red-100 text-red-800"}`}>{pay === "paid" ? t("orders.paymentPaid", "Paid", "পরিশোধিত") : t("orders.paymentUnpaid", "Unpaid", "অপরিশোধিত")}</span>
          </div>
          <table className="w-full text-sm mt-4">
            <thead><tr className="table-head border-b text-left text-slate-500"><th className="py-2">{t("orders.thItem", "Item", "আইটেম")}</th><th className="py-2 text-right">{t("orders.thQty", "Quantity", "পরিমাণ")}</th><th className="py-2 text-right">{t("orders.thPrice", "Price", "দাম")}</th></tr></thead>
            <tbody>
              {items.length === 0 && <tr><td colSpan={3} className="py-3 text-slate-500">{t("orders.noItems", "No item details found.", "কোনো আইটেমের বিবরণ পাওয়া যায়নি।")}</td></tr>}
              {items.map((it, i) => (
                <tr key={it.id || i} className="border-b">
                  <td className="py-2">{it.productName || it.product_name || it.name || it.productId || it.product_id || t("orders.itemFallback", "Item", "আইটেম")}</td>
                  <td className="py-2 text-right">{fmtNum(it.quantity ?? it.qty ?? 1)}</td>
                  <td className="py-2 text-right">{fmtTaka(it.pricePaisa ?? it.price_paisa ?? it.price ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-right font-bold text-lg mt-3">{t("common.total", "Total", "মোট")}: {fmtTaka(orderTotalPaisa(order))}</p>
        </div>

        {/* Actions */}
        <div className="card p-6 h-fit">
          <h2 className="font-bold mb-3">{t("orders.manage", "Manage order", "অর্ডার পরিচালনা")}</h2>
          <p className="text-sm text-slate-500 mb-3">{t("orders.currentStep", "Current step:", "বর্তমান ধাপ:")} <b>{orderStatusLabel(order.status, lang)}</b></p>
          <div className="flex flex-wrap gap-2">
            {next && (
              <button disabled={busy} onClick={() => changeStatus(next)} className="bg-brand text-white px-4 py-2 rounded-lg text-sm hover:bg-brand-dark disabled:opacity-50">
                {t("orders.nextStep", "Next step:", "পরের ধাপ:")} {orderStatusLabel(next, lang)}
              </button>
            )}
            {order.status !== "on_hold" && order.status !== "delivered" && (
              <button disabled={busy} onClick={() => changeStatus("on_hold")} className="bg-teal-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-teal-700 disabled:opacity-50">{t("orders.hold", "Put on hold", "হোল্ডে রাখুন")}</button>
            )}
            {order.status === "on_hold" && (
              <button disabled={busy} onClick={() => changeStatus("pending")} className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm disabled:opacity-50">{t("orders.releaseHold", "Release hold (pending)", "হোল্ড ছাড়ুন (অপেক্ষমাণ)")}</button>
            )}
            <button disabled={busy} onClick={togglePayment} className="bg-amber-500 text-white px-4 py-2 rounded-lg text-sm disabled:opacity-50">
              {pay === "paid" ? t("orders.markUnpaid", "Mark as unpaid", "অপরিশোধিত করুন") : t("orders.markPaid", "Mark as paid", "পরিশোধিত করুন")}
            </button>
          </div>
          <h3 className="font-bold mt-5 mb-2 text-sm">{t("orders.allSteps", "All steps", "সব ধাপ")}</h3>
          <ol className="space-y-1 text-sm">
            {ORDER_STATUSES.map((s) => (
              <li key={s} className={s === order.status ? "font-bold text-brand-dark" : "text-slate-500"}>
                {s === order.status ? "● " : "○ "}{orderStatusLabel(s, lang)}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}
