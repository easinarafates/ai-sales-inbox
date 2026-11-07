"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  asArray,
  customersApi,
  getToken,
  inboxApi,
  ordersApi,
  orderTotalPaisa,
  productsApi,
  type Conversation,
  type Customer,
  type Order,
  type Product,
} from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import Icon, { type IconName } from "@/components/Icon";

/**
 * Dashboard — the first sidebar item in the design spec. Simple overview
 * only: four stat cards + recent orders + recent conversations, all from
 * the existing list APIs (no new endpoints, no invented numbers).
 */
function StatCard({
  icon,
  iconCls,
  value,
  label,
  href,
}: {
  icon: IconName;
  iconCls: string;
  value: number;
  label: string;
  href: string;
}) {
  return (
    <Link href={href} className="card flex items-center gap-3 p-4 transition hover:-translate-y-0.5 hover:shadow-md">
      <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${iconCls}`}>
        <Icon name={icon} className="h-6 w-6" />
      </span>
      <span className="min-w-0">
        <span className="block text-2xl font-bold leading-none text-slate-900">{value}</span>
        <span className="mt-1 block truncate text-sm text-slate-500">{label}</span>
      </span>
    </Link>
  );
}

function orderName(o: Order): string {
  return o.customerName || o.customer_name || o.customer?.name || "—";
}

export default function DashboardPage() {
  const router = useRouter();
  const { t, fmtDate, fmtTaka } = useI18n();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);

  useEffect(() => {
    if (!getToken()) {
      router.push("/login");
      return;
    }
    (async () => {
      try {
        const [convs, ords, prods, custs] = await Promise.all([
          inboxApi.list(),
          ordersApi.list(),
          productsApi.list(),
          customersApi.list(),
        ]);
        setConversations(asArray(convs));
        setOrders(asArray(ords));
        setProducts(asArray(prods));
        setCustomers(asArray(custs));
      } catch (err) {
        setError(err instanceof Error ? err.message : t("dashboard.loadFailed", "Could not load the dashboard.", "ড্যাশবোর্ড লোড করা যায়নি।"));
      } finally {
        setLoading(false);
      }
    })();
  }, [router, t]);

  const openOrders = orders.filter((o) => String(o.status || "").toLowerCase() !== "delivered" && String(o.status || "").toLowerCase() !== "cancelled");
  const recentOrders = [...orders]
    .sort((a, b) => String(b.createdAt || b.created_at || "").localeCompare(String(a.createdAt || a.created_at || "")))
    .slice(0, 5);
  const recentConversations = conversations.slice(0, 5);

  return (
    <div>
      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {loading ? (
          <>
            <div className="skeleton h-[84px]" />
            <div className="skeleton h-[84px]" />
            <div className="skeleton h-[84px]" />
            <div className="skeleton h-[84px]" />
          </>
        ) : (
          <>
            <StatCard icon="inbox" iconCls="bg-green-100 text-green-600" value={conversations.length} label={t("dashboard.totalConversations", "Total Conversations", "মোট কথোপকথন")} href="/inbox" />
            <StatCard icon="orders" iconCls="bg-orange-100 text-brand" value={openOrders.length} label={t("dashboard.openOrders", "Open Orders", "খোলা অর্ডার")} href="/orders" />
            <StatCard icon="box" iconCls="bg-violet-100 text-violet-600" value={products.length} label={t("dashboard.products", "Products", "প্রোডাক্ট")} href="/products" />
            <StatCard icon="customers" iconCls="bg-sky-100 text-sky-600" value={customers.length} label={t("dashboard.customers", "Customers", "কাস্টমার")} href="/customers" />
          </>
        )}
      </div>

      {error && <p className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="card p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-bold text-slate-900">{t("dashboard.recentOrders", "Recent orders", "সাম্প্রতিক অর্ডার")}</h2>
            <Link href="/orders" className="text-sm font-medium text-brand hover:text-brand-dark">
              {t("dashboard.viewAll", "View all", "সব দেখুন")} →
            </Link>
          </div>
          {loading && <div className="space-y-3"><div className="skeleton h-10" /><div className="skeleton h-10" /></div>}
          {!loading && recentOrders.length === 0 && (
            <p className="text-sm text-slate-500">{t("dashboard.noOrders", "No orders yet.", "এখনো কোনো অর্ডার নেই।")}</p>
          )}
          <div className="divide-y divide-[#eeeeee]">
            {recentOrders.map((o) => (
              <Link key={o.id} href={`/orders/${o.id}`} className="flex items-center justify-between gap-2 py-2.5 text-sm transition-colors hover:bg-orange-50 -mx-2 px-2 rounded-lg">
                <span className="min-w-0">
                  <span className="block truncate font-medium text-slate-900">{orderName(o)}</span>
                  <span className="block text-xs text-slate-500">{o.orderNumber || o.order_number || o.id.slice(0, 8)} • {o.status || "—"}</span>
                </span>
                <span className="shrink-0 font-medium text-slate-900">{fmtTaka(orderTotalPaisa(o))}</span>
              </Link>
            ))}
          </div>
        </div>

        <div className="card p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-bold text-slate-900">{t("dashboard.recentChats", "Recent chats", "সাম্প্রতিক চ্যাট")}</h2>
            <Link href="/inbox" className="text-sm font-medium text-brand hover:text-brand-dark">
              {t("dashboard.viewAll", "View all", "সব দেখুন")} →
            </Link>
          </div>
          {loading && <div className="space-y-3"><div className="skeleton h-10" /><div className="skeleton h-10" /></div>}
          {!loading && recentConversations.length === 0 && (
            <p className="text-sm text-slate-500">{t("dashboard.noChats", "No chats yet.", "এখনো কোনো চ্যাট নেই।")}</p>
          )}
          <div className="divide-y divide-[#eeeeee]">
            {recentConversations.map((c) => (
              <Link key={c.id} href={`/inbox?conversation=${c.id}`} className="flex items-center justify-between gap-2 py-2.5 text-sm transition-colors hover:bg-orange-50 -mx-2 px-2 rounded-lg">
                <span className="min-w-0">
                  <span className="block truncate font-medium text-slate-900">
                    {c.customer?.name || c.customerName || c.customer_name || t("common.unknownCustomer", "Unknown customer", "অজানা কাস্টমার")}
                  </span>
                  <span className="block truncate text-xs text-slate-500">{c.lastMessage || c.last_message || ""}</span>
                </span>
                <span className="shrink-0 text-xs text-slate-400">{fmtDate(c.updatedAt || c.updated_at || c.lastMessageAt || c.last_message_at)}</span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
