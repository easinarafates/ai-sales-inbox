"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  analyticsApi,
  asArray,
  authApi,
  customersApi,
  getToken,
  inboxApi,
  orderItemsOf,
  ordersApi,
  orderTotalPaisa,
  productsApi,
  type AnalyticsOverview,
  type Conversation,
  type Customer,
  type Order,
  type Product,
} from "@/lib/api";
import { schedulingApi, type DayCounts, type ScheduledPost } from "@/lib/api-scheduling";
import { useI18n } from "@/lib/i18n";
import Icon, { type IconName } from "@/components/Icon";

/**
 * Dashboard — business status + marketing info + Analytics at the top.
 * Every number comes from the real list/analytics/scheduling APIs of this
 * workspace — nothing is hardcoded or invented. Charts use only the
 * YEARBITO palette: blue #0051F6, purple #8B35F6, navy #0F172A.
 */

const CHART_BLUE = "#0051F6";
const CHART_PURPLE = "#8B35F6";
const CHART_NAVY = "#0F172A";

type Range = "7d" | "30d";

/** Dhaka (Asia/Dhaka) calendar-day key, e.g. "2026-11-11". */
function dhakaDayKey(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function lastNDayKeys(n: number): string[] {
  const keys: string[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    keys.push(dhakaDayKey(new Date(now.getTime() - i * 24 * 60 * 60 * 1000)));
  }
  return keys;
}

function createdDayKey(o: { createdAt?: string; created_at?: string }): string {
  const raw = o.createdAt || o.created_at || "";
  if (!raw) return "";
  return dhakaDayKey(new Date(raw));
}

function StatCard({
  icon,
  iconCls,
  value,
  label,
  href,
}: {
  icon: IconName;
  iconCls: string;
  value: number | string;
  label: string;
  href: string;
}) {
  return (
    <Link href={href} className="card flex items-center gap-3 p-4 transition hover:-translate-y-0.5 hover:shadow-md">
      <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${iconCls}`}>
        <Icon name={icon} className="h-6 w-6" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-2xl font-bold leading-none text-slate-900">{value}</span>
        <span className="mt-1 block truncate text-sm text-slate-500">{label}</span>
      </span>
    </Link>
  );
}

function MiniStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card p-4">
      <p className="truncate text-sm text-slate-500">{label}</p>
      <p className="mt-1 truncate text-2xl font-bold text-slate-900">{value}</p>
      {sub ? <p className="mt-0.5 truncate text-xs text-slate-400">{sub}</p> : null}
    </div>
  );
}

/**
 * Multi-line trend chart (SVG, no chart library). Left axis = counts
 * (orders in blue, chats in navy); right axis = revenue in purple, dashed.
 * All three colours are YEARBITO brand colours only.
 */
function TrendChart({
  days,
  orders,
  chats,
  revenue,
}: {
  days: string[];
  orders: number[];
  chats: number[];
  revenue: number[];
}) {
  const W = 640;
  const H = 220;
  const PL = 36;
  const PR = 44;
  const PT = 14;
  const PB = 28;
  const maxCount = Math.max(1, ...orders, ...chats);
  const maxRevenue = Math.max(1, ...revenue);
  const x = (i: number) => PL + (i * (W - PL - PR)) / Math.max(1, days.length - 1);
  const yCount = (v: number) => PT + (1 - v / maxCount) * (H - PT - PB);
  const yRevenue = (v: number) => PT + (1 - v / maxRevenue) * (H - PT - PB);
  const line = (vals: number[], y: (v: number) => number) =>
    vals.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const allZero = orders.every((v) => v === 0) && chats.every((v) => v === 0) && revenue.every((v) => v === 0);
  const labelEvery = Math.ceil(days.length / 7);

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Orders, chats and revenue trend">
        {[0, 1, 2, 3].map((g) => {
          const y = PT + (g * (H - PT - PB)) / 3;
          return <line key={g} x1={PL} x2={W - PR} y1={y} y2={y} stroke="#eeeeee" strokeWidth="1" />;
        })}
        <text x={6} y={PT + 4} fontSize="10" fill="#64748b">{maxCount}</text>
        <text x={6} y={H - PB + 4} fontSize="10" fill="#64748b">0</text>
        <text x={W - PR + 4} y={PT + 4} fontSize="10" fill={CHART_PURPLE}>{`৳${Math.round(maxRevenue / 100)}`}</text>
        {days.map((d, i) =>
          i % labelEvery === 0 ? (
            <text key={d} x={x(i)} y={H - 8} fontSize="10" fill="#64748b" textAnchor="middle">
              {d.slice(5)}
            </text>
          ) : null
        )}
        <path d={line(orders, yCount)} fill="none" stroke={CHART_BLUE} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        <path d={line(chats, yCount)} fill="none" stroke={CHART_NAVY} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <path d={line(revenue, yRevenue)} fill="none" stroke={CHART_PURPLE} strokeWidth="2" strokeDasharray="6 4" strokeLinejoin="round" strokeLinecap="round" />
        {orders.map((v, i) => (
          <circle key={`o${i}`} cx={x(i)} cy={yCount(v)} r="3" fill={CHART_BLUE} />
        ))}
      </svg>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
        <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-4 rounded" style={{ background: CHART_BLUE }} />Orders</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-4 rounded" style={{ background: CHART_NAVY }} />Chats</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-4 rounded" style={{ background: CHART_PURPLE }} />Revenue (right axis, dashed)</span>
      </div>
      {allZero && <p className="mt-2 text-sm text-slate-500">No orders, chats or revenue in this range yet.</p>}
    </div>
  );
}

function orderName(o: Order): string {
  return o.customerName || o.customer_name || o.customer?.name || "—";
}

export default function DashboardPage() {
  const router = useRouter();
  const { t, fmtDate, fmtTaka, fmtNum } = useI18n();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  // Marketing: real scheduled-post data from GET /api/scheduled-posts.
  const [scheduled, setScheduled] = useState<ScheduledPost[]>([]);
  const [scheduledCounts, setScheduledCounts] = useState<DayCounts>({});
  const [scheduledError, setScheduledError] = useState("");
  // Analytics: real overview from GET /api/analytics/overview.
  const [analyticsRange, setAnalyticsRange] = useState<Range>("7d");
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [analyticsError, setAnalyticsError] = useState("");
  // Restricted account (Owner Panel, migration 45): login works, but AI
  // replies and post scheduling are off. GET /api/auth/me carries the
  // account status + workspace flag; a failed fetch just hides the
  // banner (it must never break the dashboard).
  const [restricted, setRestricted] = useState(false);

  useEffect(() => {
    if (!getToken()) return;
    let cancelled = false;
    (async () => {
      try {
        const me = (await authApi.me()) as unknown as {
          user?: { accountStatus?: string };
          workspace?: { restricted?: boolean };
        };
        if (!cancelled) {
          setRestricted(me?.user?.accountStatus === "restricted" || me?.workspace?.restricted === true);
        }
      } catch {
        // Banner data unavailable — stay silent, dashboard still loads.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
    // Scheduled posts load independently — a failure here must not break
    // the rest of the dashboard.
    (async () => {
      try {
        const res = await schedulingApi.list({ status: "scheduled" });
        setScheduled(res.posts || []);
        setScheduledCounts(res.counts || {});
      } catch (err) {
        setScheduledError(err instanceof Error ? err.message : "Could not load scheduled posts.");
      }
    })();
  }, [router, t]);

  useEffect(() => {
    if (!getToken()) return;
    let cancelled = false;
    (async () => {
      setAnalyticsLoading(true);
      setAnalyticsError("");
      try {
        const ov = await analyticsApi.overview(analyticsRange);
        if (!cancelled) setOverview(ov);
      } catch (err) {
        if (!cancelled) setAnalyticsError(err instanceof Error ? err.message : "Could not load analytics.");
      } finally {
        if (!cancelled) setAnalyticsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [analyticsRange]);

  const openOrders = orders.filter((o) => String(o.status || "").toLowerCase() !== "delivered" && String(o.status || "").toLowerCase() !== "cancelled");
  const deliveredOrders = orders.filter((o) => String(o.status || "").toLowerCase() === "delivered");
  const deliveredRevenuePaisa = deliveredOrders.reduce((sum, o) => sum + orderTotalPaisa(o), 0);
  const recentOrders = [...orders]
    .sort((a, b) => String(b.createdAt || b.created_at || "").localeCompare(String(a.createdAt || a.created_at || "")))
    .slice(0, 5);
  const recentConversations = conversations.slice(0, 5);

  // ---- Marketing info (real scheduled-post data) ----
  const scheduledCount = scheduled.length;
  const todayKey = dhakaDayKey(new Date());
  const scheduledToday = scheduledCounts[todayKey] ?? 0;
  const nextPost = [...scheduled]
    .map((p) => p.scheduledAt || p.scheduled_at || "")
    .filter(Boolean)
    .sort()[0];
  const nextPostLabel = nextPost ? fmtDate(nextPost) : "—";

  // ---- Analytics trend (last 7 / 30 days, from the same real lists) ----
  const rangeDays = analyticsRange === "30d" ? 30 : 7;
  const trend = useMemo(() => {
    const keys = lastNDayKeys(rangeDays);
    const ordersPerDay = keys.map(() => 0);
    const chatsPerDay = keys.map(() => 0);
    const revenuePerDay = keys.map(() => 0);
    const idx = new Map(keys.map((k, i) => [k, i]));
    for (const o of orders) {
      const i = idx.get(createdDayKey(o));
      if (i === undefined) continue;
      ordersPerDay[i] += 1;
      revenuePerDay[i] += orderTotalPaisa(o);
    }
    for (const c of conversations) {
      const raw = c.createdAt || c.created_at || "";
      if (!raw) continue;
      const i = idx.get(dhakaDayKey(new Date(raw)));
      if (i !== undefined) chatsPerDay[i] += 1;
    }
    return { keys, ordersPerDay, chatsPerDay, revenuePerDay };
  }, [orders, conversations, rangeDays]);

  const rangeOrders = useMemo(() => {
    const keys = new Set(lastNDayKeys(rangeDays));
    return orders.filter((o) => keys.has(createdDayKey(o)));
  }, [orders, rangeDays]);
  const rangeRevenuePaisa = rangeOrders.reduce((sum, o) => sum + orderTotalPaisa(o), 0);

  // ---- Top products in range (from real order items) ----
  const topProducts = useMemo(() => {
    const byName = new Map<string, { qty: number; revenue: number }>();
    for (const o of rangeOrders) {
      for (const item of orderItemsOf(o)) {
        const name = item.productName || item.product_name || item.name || "—";
        const qty = Number(item.quantity ?? item.qty ?? 1);
        const price = Number(item.pricePaisa ?? item.price_paisa ?? item.price ?? 0);
        const cur = byName.get(name) || { qty: 0, revenue: 0 };
        cur.qty += qty;
        cur.revenue += qty * price;
        byName.set(name, cur);
      }
    }
    return [...byName.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 5);
  }, [rangeOrders]);
  const topQtyMax = Math.max(1, ...topProducts.map((p) => p.qty));

  const aiPct = overview?.aiHandledPct ?? overview?.ai_handled_pct ?? 0;
  const avgCost = overview?.avgCostPaisa ?? overview?.avg_cost_paisa ?? 0;

  return (
    <div>
      {restricted && (
        <p className="bg-amber-50 text-amber-800 border border-amber-300 text-sm p-3 rounded-lg mb-4">
          {t(
            "dashboard.restricted",
            "Your account is restricted — AI replies and post scheduling are off. You can still read everything. Contact the platform owner to lift the restriction.",
            "আপনার অ্যাকাউন্টটি সীমিত করা হয়েছে — AI উত্তর আর পোস্ট শিডিউল করা বন্ধ আছে। আপনি সবকিছু পড়তে পারবেন। সীমা তুলতে প্ল্যাটফর্মের মালিকের সাথে যোগাযোগ করুন।"
          )}
        </p>
      )}
      {/* ---- Analytics (top, separate section) ---- */}
      <section data-dashboard-analytics="true" className="mb-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-bold text-slate-900">
              <Icon name="chartLine" className="h-5 w-5 text-brand" />
              {t("dashboard.analyticsTitle", "Analytics", "অ্যানালিটিক্স")}
            </h2>
            <p className="text-sm text-slate-500">
              {t("dashboard.analyticsSubtitle", "Orders, chats and revenue — from your real shop data.", "অর্ডার, চ্যাট আর রেভিনিউ — আপনার আসল শপের ডেটা থেকে।")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {(["7d", "30d"] as Range[]).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setAnalyticsRange(r)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${analyticsRange === r ? "bg-brand text-white shadow-sm" : "bg-white text-slate-600 shadow-sm hover:bg-[#EBF1FE]"}`}
              >
                {r === "7d"
                  ? t("dashboard.range7d", "Last 7 days", "গত ৭ দিন")
                  : t("dashboard.range30d", "Last 30 days", "গত ৩০ দিন")}
              </button>
            ))}
            <Link href="/analytics" className="text-sm font-medium text-brand hover:text-brand-dark">
              {t("dashboard.fullAnalytics", "Full analytics", "পুরো অ্যানালিটিক্স")} →
            </Link>
          </div>
        </div>

        {analyticsError && <p className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{analyticsError}</p>}

        {analyticsLoading ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <div className="skeleton h-20" /><div className="skeleton h-20" /><div className="skeleton h-20" /><div className="skeleton h-20" /><div className="skeleton h-20" />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <MiniStat label={t("dashboard.analyticsChats", "Chats", "চ্যাট")} value={fmtNum(overview?.conversations ?? 0)} sub={t("dashboard.analyticsRange", analyticsRange === "7d" ? "Last 7 days" : "Last 30 days", analyticsRange === "7d" ? "গত ৭ দিন" : "গত ৩০ দিন")} />
              <MiniStat label={t("dashboard.analyticsOrders", "Orders", "অর্ডার")} value={fmtNum(overview?.orders ?? 0)} sub={t("dashboard.analyticsRange", analyticsRange === "7d" ? "Last 7 days" : "Last 30 days", analyticsRange === "7d" ? "গত ৭ দিন" : "গত ৩০ দিন")} />
              <MiniStat label={t("dashboard.analyticsRevenue", "Revenue", "রেভিনিউ")} value={fmtTaka(rangeRevenuePaisa)} sub={t("dashboard.analyticsRange", analyticsRange === "7d" ? "Last 7 days" : "Last 30 days", analyticsRange === "7d" ? "গত ৭ দিন" : "গত ৩০ দিন")} />
              <MiniStat label={t("dashboard.analyticsAiHandled", "AI handled", "AI সামলেছে")} value={`${fmtNum(aiPct)}%`} sub={t("dashboard.analyticsAiHandledSub", "of chats, end to end", "চ্যাটের, পুরোটা")} />
              <MiniStat label={t("dashboard.analyticsAvgCost", "Avg. cost / reply", "গড় খরচ / উত্তর")} value={fmtTaka(avgCost)} sub={t("dashboard.analyticsAvgCostSub", "real AI cost", "আসল AI খরচ")} />
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="card p-4 lg:col-span-2">
                <h3 className="mb-3 font-bold text-slate-900">
                  {t("dashboard.trendTitle", "Orders, chats & revenue trend", "অর্ডার, চ্যাট আর রেভিনিউ ট্রেন্ড")}
                </h3>
                <TrendChart days={trend.keys} orders={trend.ordersPerDay} chats={trend.chatsPerDay} revenue={trend.revenuePerDay} />
              </div>
              <div className="card p-4">
                <h3 className="mb-3 font-bold text-slate-900">
                  {t("dashboard.topProductsTitle", "Top products", "সেরা প্রোডাক্ট")}
                </h3>
                {topProducts.length === 0 ? (
                  <p className="text-sm text-slate-500">
                    {t("dashboard.noTopProducts", "No products sold in this range yet.", "এই সময়ে এখনো কোনো প্রোডাক্ট বিক্রি হয়নি।")}
                  </p>
                ) : (
                  <ul className="space-y-3">
                    {topProducts.map((p) => (
                      <li key={p.name}>
                        <div className="flex items-baseline justify-between gap-2 text-sm">
                          <span className="min-w-0 truncate font-medium text-slate-900">{p.name}</span>
                          <span className="shrink-0 text-slate-500">
                            {fmtNum(p.qty)} × {fmtTaka(p.revenue)}
                          </span>
                        </div>
                        <div className="mt-1 h-2 overflow-hidden rounded-full bg-[#EBF1FE]">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-brand to-accent"
                            style={{ width: `${Math.round((p.qty / topQtyMax) * 100)}%` }}
                          />
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </>
        )}
      </section>

      {/* ---- Business status ---- */}
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

      {/* ---- Revenue + marketing info (real scheduled-post counts) ---- */}
      <div data-scheduled-posts="true" className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {loading ? (
          <>
            <div className="skeleton h-[84px]" />
            <div className="skeleton h-[84px]" />
            <div className="skeleton h-[84px]" />
            <div className="skeleton h-[84px]" />
          </>
        ) : (
          <>
            <StatCard icon="chartBar" iconCls="bg-[#EBF1FE] text-brand-dark" value={fmtTaka(deliveredRevenuePaisa)} label={t("dashboard.deliveredRevenue", "Revenue (delivered orders)", "রেভিনিউ (ডেলিভার হওয়া অর্ডার)")} href="/orders?status=delivered" />
            <StatCard icon="schedule" iconCls="bg-[#F3EAFE] text-accent-dark" value={scheduledCount} label={t("dashboard.scheduledPosts", "Posts scheduled", "শিডিউল করা পোস্ট")} href="/schedule" />
            <StatCard icon="megaphone" iconCls="bg-[#EBF1FE] text-brand-dark" value={scheduledToday} label={t("dashboard.scheduledToday", "Posts scheduled today", "আজ শিডিউল করা পোস্ট")} href="/schedule" />
            <StatCard icon="clock" iconCls="bg-violet-100 text-violet-600" value={nextPostLabel} label={t("dashboard.nextPost", "Next scheduled post", "পরের শিডিউল করা পোস্ট")} href="/schedule" />
          </>
        )}
      </div>
      {scheduledError && <p className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{scheduledError}</p>}

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
