"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { asArray, getToken, ordersApi, orderTotalPaisa, type Order } from "@/lib/api";
import { ORDER_STATUSES, orderStatusLabel, statusBadge } from "@/lib/orderStatus";
import { useI18n } from "@/lib/i18n";

export default function OrdersPage() {
  const router = useRouter();
  const { t, lang, fmtDate, fmtTaka } = useI18n();
  const [orders, setOrders] = useState<Order[]>([]);
  const [filterStatus, setFilterStatus] = useState("");
  const [filterPayment, setFilterPayment] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await ordersApi.list();
      setOrders(asArray(data));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("orders.loadFailed", "Could not load orders.", "অর্ডার লোড করা যায়নি।"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!getToken()) { router.push("/login"); return; }
    load();
  }, [load, router]);

  const filtered = orders.filter((o) => {
    if (filterStatus && o.status !== filterStatus) return false;
    if (filterPayment && (o.paymentStatus || o.payment_status) !== filterPayment) return false;
    return true;
  });

  return (
    <div>
      <h1 className="page-title">{t("orders.title", "Orders", "অর্ডার")}</h1>
      <p className="page-subtitle">{t("orders.subtitle", "Every order, from new to delivered.", "নতুন থেকে ডেলিভারি পর্যন্ত প্রতিটি অর্ডার।")}</p>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}
      <div className="flex gap-2 mb-4">
        <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="border rounded-lg px-3 py-2 bg-white">
          <option value="">{t("common.allStatus", "All statuses", "সব স্ট্যাটাস")}</option>
          {ORDER_STATUSES.map((s) => <option key={s} value={s}>{orderStatusLabel(s, lang)}</option>)}
        </select>
        <select value={filterPayment} onChange={(e) => setFilterPayment(e.target.value)} className="border rounded-lg px-3 py-2 bg-white">
          <option value="">{t("common.allPayment", "All payments", "সব পেমেন্ট")}</option>
          <option value="unpaid">{t("orders.paymentUnpaid", "Unpaid", "অপরিশোধিত")}</option>
          <option value="paid">{t("orders.paymentPaid", "Paid", "পরিশোধিত")}</option>
        </select>
      </div>
      {loading ? (<div className="space-y-2"><div className="skeleton h-12" /><div className="skeleton h-12" /><div className="skeleton h-12" /></div>) : filtered.length === 0 ? (
        <div className="empty-state">{t("orders.empty", "No orders yet.", "কোনো অর্ডার নেই।")}</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="table-head border-b text-left text-slate-500"><th className="p-3">{t("orders.thOrder", "Order", "অর্ডার")}</th><th className="p-3">{t("orders.thCustomer", "Customer", "কাস্টমার")}</th><th className="p-3">{t("orders.thTotal", "Total", "মোট")}</th><th className="p-3">{t("orders.thStatus", "Status", "স্ট্যাটাস")}</th><th className="p-3">{t("orders.thPayment", "Payment", "পেমেন্ট")}</th><th className="p-3">{t("orders.thDate", "Date", "তারিখ")}</th><th className="p-3"></th></tr></thead>
            <tbody>
              {filtered.map((o) => {
                const pay = o.paymentStatus || o.payment_status;
                return (
                  <tr key={o.id} className="border-b transition-colors hover:bg-orange-50">
                    <td className="p-3 font-medium">{o.orderNumber || o.order_number || o.id.slice(0, 8)}</td>
                    <td className="p-3">{o.customer?.name || "—"}</td>
                    <td className="p-3">{fmtTaka(orderTotalPaisa(o))}</td>
                    <td className="p-3">{statusBadge(o.status, lang)}</td>
                    <td className="p-3"><span className={`text-xs px-2 py-0.5 rounded ${pay === "paid" ? "bg-teal-100 text-teal-800" : "bg-red-100 text-red-800"}`}>{pay === "paid" ? t("orders.paymentPaid", "Paid", "পরিশোধিত") : t("orders.paymentUnpaid", "Unpaid", "অপরিশোধিত")}</span></td>
                    <td className="p-3 text-slate-500">{fmtDate(o.createdAt || o.created_at)}</td>
                    <td className="p-3 text-right"><Link href={`/orders/${o.id}`} className="text-brand-dark underline">{t("common.details", "Details", "বিস্তারিত")}</Link></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
