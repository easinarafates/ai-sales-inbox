"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  asArray, getToken, ordersApi, orderTotalPaisa,
  type Order, type OrderCustomer,
} from "@/lib/api";
import { ORDER_STATUSES, orderSourceLabel, orderStatusLabel, statusBadge } from "@/lib/orderStatus";
import { useI18n } from "@/lib/i18n";
import CustomerAvatar from "@/components/CustomerAvatar";
import OrderDetailPanel from "@/components/OrderDetailPanel";

type View = "orders" | "customers" | "report";

interface ReportData {
  date: string;
  today: { orders: number; delivered: number; cancelled: number; returned: number; damaged: number; valuePaisa: number };
  courier: { inTransitOrders: number; shipmentsByStatus: Record<string, number> };
}

export default function OrdersPage() {
  const router = useRouter();
  const { t, lang, fmtDate, fmtTaka } = useI18n();
  const [orders, setOrders] = useState<Order[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [totalOrders, setTotalOrders] = useState(0);
  const [filterStatus, setFilterStatus] = useState("");
  const [view, setView] = useState<View>("orders");
  const [customers, setCustomers] = useState<OrderCustomer[]>([]);
  const [report, setReport] = useState<ReportData | null>(null);
  const [scanQ, setScanQ] = useState("");
  const [scanError, setScanError] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Order | null>(null);
  const [openCustomer, setOpenCustomer] = useState<string | null>(null);
  const [customerDetail, setCustomerDetail] = useState<Record<string, { totalPaisa: number; orders: Order[]; cancelled: number; returned: number; delivered: number; lastOrderAt: string | null }>>({});

  const load = useCallback(async () => {
    try {
      const [data, c] = await Promise.all([ordersApi.list(), ordersApi.counts()]);
      setOrders(asArray(data));
      setCounts(c.counts ?? {});
      setTotalOrders(c.total ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("orders.loadFailed", "Could not load orders.", "অর্ডার লোড করা যায়নি।"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  const loadCustomers = useCallback(async () => {
    try {
      const d = await ordersApi.customers();
      setCustomers(d.customers ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("orders.loadFailed", "Could not load orders.", "অর্ডার লোড করা যায়নি।"));
    }
  }, [t]);

  const loadReport = useCallback(async () => {
    try {
      setReport(await ordersApi.report());
    } catch (err) {
      setError(err instanceof Error ? err.message : t("orders.loadFailed", "Could not load orders.", "অর্ডার লোড করা যায়নি।"));
    }
  }, [t]);

  useEffect(() => {
    if (!getToken()) { router.push("/login"); return; }
    load();
  }, [load, router]);

  useEffect(() => {
    if (view === "customers") loadCustomers();
    if (view === "report") loadReport();
  }, [view, loadCustomers, loadReport]);

  const filtered = orders.filter((o) => !filterStatus || o.status === filterStatus);

  const runScan = async () => {
    if (!scanQ.trim()) return;
    setScanError("");
    try {
      const found = await ordersApi.lookup(scanQ.trim());
      if (found.order) {
        const full = { ...found.order, items: found.items ?? [], shipment: found.shipment ?? null };
        setSelected(full as Order);
      }
    } catch (err) {
      setScanError(err instanceof Error ? err.message : t("orders.scanNotFound", "Not found.", "পাওয়া যায়নি।"));
    }
  };

  const openOrder = async (o: Order) => {
    // The list row has no items/shipment/zone — fetch the full order for
    // the panel, and fall back to the row itself if the fetch fails.
    try {
      setSelected(await ordersApi.get(o.id));
    } catch {
      setSelected(o);
    }
  };

  const toggleCustomer = async (id: string) => {
    if (openCustomer === id) { setOpenCustomer(null); return; }
    setOpenCustomer(id);
    if (!customerDetail[id]) {
      try {
        const d = await ordersApi.customerDetail(id);
        setCustomerDetail((prev) => ({ ...prev, [id]: { totalPaisa: d.stats.totalPaisa, orders: d.orders ?? [], cancelled: d.stats.cancelled, returned: d.stats.returned, delivered: d.stats.delivered, lastOrderAt: d.stats.lastOrderAt } }));
      } catch {
        // The list stays usable without the amount — the owner can retry.
      }
    }
  };

  const onOrderChange = (next: Order) => {
    setOrders((prev) => prev.map((o) => (o.id === next.id ? { ...o, ...next } : o)));
    setSelected((prev) => (prev && prev.id === next.id ? { ...prev, ...next } : prev));
    ordersApi.counts().then((c) => { setCounts(c.counts ?? {}); setTotalOrders(c.total ?? 0); }).catch(() => undefined);
  };

  return (
    <div>
      <h1 className="page-title">{t("orders.title", "Orders", "অর্ডার")}</h1>
      <p className="page-subtitle">{t("orders.subtitle", "Every order, from new to delivered.", "নতুন থেকে ডেলিভারি পর্যন্ত প্রতিটি অর্ডার।")}</p>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}

      {/* Status tabs with counts */}
      <div className="flex flex-wrap gap-2 mb-4">
        <button onClick={() => setFilterStatus("")} className={`px-3 py-1.5 rounded-full text-sm border ${filterStatus === "" ? "bg-brand text-white border-brand" : "bg-white"}`}>
          {t("common.all", "All", "সব")} ({totalOrders})
        </button>
        {ORDER_STATUSES.map((s) => (
          <button key={s} onClick={() => setFilterStatus(s)} className={`px-3 py-1.5 rounded-full text-sm border ${filterStatus === s ? "bg-brand text-white border-brand" : "bg-white"}`}>
            {orderStatusLabel(s, lang)} ({counts[s] ?? 0})
          </button>
        ))}
      </div>

      {/* Scan box — order number / tracking number / invoice token */}
      <div className="flex gap-2 mb-4">
        <input
          value={scanQ}
          onChange={(e) => setScanQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") runScan(); }}
          placeholder={t("orders.scanPlaceholder", "Scan / type order no. (ASI-0001), tracking no. or invoice token…", "স্ক্যান করুন / লিখুন — অর্ডার নম্বর (ASI-0001), ট্র্যাকিং নম্বর বা ইনভয়েস টোকেন…")}
          className="flex-1 border rounded-lg px-3 py-2 bg-white text-sm"
        />
        <button onClick={runScan} className="bg-brand text-white px-4 py-2 rounded-lg text-sm hover:bg-brand-dark">
          {t("orders.scan", "Scan", "স্ক্যান")}
        </button>
      </div>
      {scanError && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{scanError}</p>}

      {/* Views: Orders / Customers / Report */}
      <div className="flex gap-2 mb-4">
        {(["orders", "customers", "report"] as View[]).map((v) => (
          <button key={v} onClick={() => setView(v)} className={`px-4 py-2 rounded-lg text-sm ${view === v ? "bg-brand text-white" : "bg-white border"}`}>
            {v === "orders" ? t("orders.viewOrders", "Orders", "অর্ডার") : v === "customers" ? t("orders.viewCustomers", "Customers", "কাস্টমার") : t("orders.viewReport", "Report", "রিপোর্ট")}
          </button>
        ))}
      </div>

      {view === "orders" && (
        loading ? (<div className="space-y-2"><div className="skeleton h-12" /><div className="skeleton h-12" /><div className="skeleton h-12" /></div>) : filtered.length === 0 ? (
          <div className="empty-state">{t("orders.empty", "No orders yet.", "কোনো অর্ডার নেই।")}</div>
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="table-head border-b text-left text-slate-500"><th className="p-3">{t("orders.thOrder", "Order", "অর্ডার")}</th><th className="p-3">{t("orders.thCustomer", "Customer", "কাস্টমার")}</th><th className="p-3">{t("orders.thAddress", "Delivery address", "ডেলিভারি ঠিকানা")}</th><th className="p-3">{t("orders.thTotal", "Total", "মোট")}</th><th className="p-3">{t("orders.thStatus", "Status", "স্ট্যাটাস")}</th><th className="p-3">{t("orders.thDate", "Date", "তারিখ")}</th></tr></thead>
              <tbody>
                {filtered.map((o) => {
                  const name = o.customer?.name || o.customerName || o.customer_name || "—";
                  const phone = o.customer?.phone || o.customerPhone || o.customer_phone || "";
                  const address = o.deliveryAddress || o.delivery_address || o.customer?.address || "";
                  const notProvided = t("orders.notProvided", "Not provided", "দেওয়া হয়নি");
                  return (
                    <tr key={o.id} onClick={() => openOrder(o)} className="border-b transition-colors hover:bg-orange-50 cursor-pointer">
                      <td className="p-3"><span className="font-medium">{o.orderNumber || o.order_number || o.id.slice(0, 8)}</span><span className="block text-xs text-slate-500">{t("orders.via", "via", "মাধ্যম")}: {orderSourceLabel(o.source, lang)}</span></td>
                      <td className="p-3"><span className="flex items-center gap-2"><CustomerAvatar name={name === "—" ? "?" : name} pictureUrl={o.customer?.picture_url} sizeClass="h-8 w-8" /><span><span className="block font-medium">{name}</span><span className="block text-xs text-slate-500">{phone || notProvided}</span></span></span></td>
                      <td className="p-3 text-slate-600 max-w-[220px]">{address || <span className="text-slate-400">{notProvided}</span>}</td>
                      <td className="p-3">{fmtTaka(orderTotalPaisa(o) + (o.deliveryChargePaisa ?? o.delivery_charge_paisa ?? 0))}</td>
                      <td className="p-3">{statusBadge(o.status, lang)}</td>
                      <td className="p-3 text-slate-500">{fmtDate(o.createdAt || o.created_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}

      {view === "customers" && (
        customers.length === 0 ? (
          <div className="empty-state">{t("orders.noCustomers", "No customers with orders yet.", "এখনো অর্ডার দেওয়া কোনো কাস্টমার নেই।")}</div>
        ) : (
          <div className="space-y-2">
            {customers.map((c) => {
              const open = openCustomer === c.id;
              const detail = customerDetail[c.id];
              return (
                <div key={c.id} className="card p-4">
                  <button onClick={() => toggleCustomer(c.id)} className="w-full text-left">
                    <span className="flex items-center gap-3">
                      <CustomerAvatar name={c.name || "?"} pictureUrl={c.picture_url ?? undefined} sizeClass="h-10 w-10" />
                      <span className="flex-1 min-w-0">
                        <span className="block font-medium">{c.name || "—"}</span>
                        <span className="block text-xs text-slate-500">{c.phone || ""}</span>
                      </span>
                      <span className="text-sm text-slate-600 text-right">
                        <span className="block">{t("orders.ordersCount", "Orders:", "অর্ডার:")} <b>{c.orders}</b></span>
                        <span className="block text-xs">{t("orders.lastOrder", "Last order:", "শেষ অর্ডার:")} {c.last_order_at ? fmtDate(c.last_order_at) : "—"}</span>
                      </span>
                      <span className="text-slate-400">{open ? "▾" : "▸"}</span>
                    </span>
                  </button>
                  {open && (
                    <div className="mt-3 border-t pt-3 text-sm">
                      <p>{t("orders.deliveredCount", "Delivered:", "ডেলিভারি হয়েছে:")} <b>{c.delivered}</b> · {t("orders.cancelledCount", "Cancelled:", "বাতিল:")} <b>{c.cancelled}</b> · {t("orders.returnedCount", "Returned:", "রিটার্ন:")} <b>{c.returned}</b></p>
                      {detail ? (
                        <>
                          <p className="mt-2">{t("orders.totalSpent", "Total spent:", "মোট খরচ:")} <b>{fmtTaka(detail.totalPaisa)}</b></p>
                          <p className="text-xs text-slate-500 mt-1">{t("orders.lastOrder", "Last order:", "শেষ অর্ডার:")} {detail.lastOrderAt ? fmtDate(detail.lastOrderAt) : "—"}</p>
                        </>
                      ) : (
                        <p className="text-xs text-slate-400 mt-2">{t("common.loading", "Loading…", "লোড হচ্ছে…")}</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )
      )}

      {view === "report" && (
        report ? (
          <div className="space-y-4">
            <div className="card p-4">
              <h2 className="font-bold">{t("orders.todayReport", "Today's report", "আজকের রিপোর্ট")} — {report.date}</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-3">
                {[
                  [t("orders.reportOrders", "Orders", "অর্ডার"), report.today.orders],
                  [t("orders.reportDelivered", "Delivered", "ডেলিভারি হয়েছে"), report.today.delivered],
                  [t("orders.reportCancelled", "Cancelled", "বাতিল"), report.today.cancelled],
                  [t("orders.reportReturned", "Returned", "রিটার্ন"), report.today.returned],
                  [t("orders.reportDamaged", "Damaged", "ক্ষতিগ্রস্ত"), report.today.damaged],
                  [t("orders.reportValue", "Order value", "অর্ডারের মূল্য"), fmtTaka(report.today.valuePaisa)],
                ].map(([label, value]) => (
                  <div key={String(label)} className="bg-orange-50 rounded-lg p-3">
                    <p className="text-xs text-slate-500">{label}</p>
                    <p className="font-bold text-lg">{value}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="card p-4">
              <h2 className="font-bold">{t("orders.courierView", "Courier", "কুরিয়ার")}</h2>
              <p className="text-sm mt-2">{t("orders.inCourierNow", "Orders with the courier now:", "এখন কুরিয়ারে আছে:")} <b>{report.courier.inTransitOrders}</b></p>
              <div className="flex flex-wrap gap-2 mt-3">
                {Object.entries(report.courier.shipmentsByStatus).map(([s, n]) => (
                  <span key={s} className="text-xs bg-slate-100 px-2 py-1 rounded">{s}: {n}</span>
                ))}
              </div>
              <Link href="/courier" className="text-brand-dark underline text-sm mt-3 inline-block">{t("orders.goCourier", "Open Courier page →", "কুরিয়ার পেজ খুলুন →")}</Link>
            </div>
          </div>
        ) : (
          <div className="space-y-2"><div className="skeleton h-24" /><div className="skeleton h-24" /></div>
        )
      )}

      {/* Right-side detail panel (slide-over) */}
      {selected && (
        <div className="fixed inset-0 z-40">
          <div className="absolute inset-0 bg-black/30" onClick={() => setSelected(null)} />
          <div className="absolute right-0 top-0 h-full w-full max-w-xl bg-[#f7f5f3] overflow-y-auto p-4 sm:p-6 shadow-xl">
            <OrderDetailPanel
              order={selected}
              shipment={(selected as Order & { shipment?: unknown }).shipment as never}
              onOrderChange={onOrderChange}
              onClose={() => setSelected(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
