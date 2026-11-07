"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import PostAttributionTable from "./PostAttributionTable";
import {
  analyticsApi,
  asArrayOf,
  getToken,
  type AnalyticsOverview,
  type AnalyticsPost,
  type LostSaleReason,
} from "@/lib/api";
import { useI18n } from "@/lib/i18n";

type Range = "today" | "yesterday" | "7d" | "30d";

const RANGE_KEYS: Record<Range, string> = {
  today: "analytics.rangeToday",
  yesterday: "analytics.rangeYesterday",
  "7d": "analytics.range7d",
  "30d": "analytics.range30d",
};
const RANGE_FALLBACK: Record<Range, [string, string]> = {
  today: ["Today", "আজ"],
  yesterday: ["Yesterday", "গতকাল"],
  "7d": ["Last 7 days", "গত ৭ দিন"],
  "30d": ["Last 30 days", "গত ৩০ দিন"],
};

const SOURCE_KEYS: Record<string, string> = {
  ai: "analytics.sourceAi",
  product_page: "analytics.sourceProductPage",
  team: "analytics.sourceTeam",
  website: "analytics.sourceWebsite",
  other: "analytics.sourceOther",
};
const SOURCE_FALLBACK: Record<string, [string, string]> = {
  ai: ["AI chat", "AI চ্যাট"],
  product_page: ["Product page", "প্রোডাক্ট পেজ"],
  team: ["Team", "টিম"],
  website: ["Website", "ওয়েবসাইট"],
  other: ["Other", "অন্যান্য"],
};

export default function AnalyticsPage() {
  const router = useRouter();
  const { t, fmtTaka, fmtNum } = useI18n();
  const [range, setRange] = useState<Range>("7d");
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [posts, setPosts] = useState<AnalyticsPost[]>([]);
  const [lostSales, setLostSales] = useState<LostSaleReason[]>([]);
  const [lostTotal, setLostTotal] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (r: Range) => {
    setLoading(true);
    setError("");
    try {
      const [ov, ps, ls] = await Promise.all([
        analyticsApi.overview(r),
        analyticsApi.posts(),
        analyticsApi.lostSales(),
      ]);
      setOverview(ov);
      setPosts(asArrayOf<AnalyticsPost>(ps, ["posts"]));
      setLostSales(ls.reasons || []);
      setLostTotal(ls.total || 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("analytics.loadFailed", "Could not load analytics.", "অ্যানালিটিক্স লোড করা যায়নি।"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!getToken()) { router.push("/login"); return; }
    load(range);
  }, [load, range, router]);

  const source = overview?.orderSource || overview?.order_source || {};
  const aiPct = overview?.aiHandledPct ?? overview?.ai_handled_pct ?? 0;
  const handovers = overview?.humanHandoverCount ?? overview?.human_handover_count ?? 0;
  const avgCost = overview?.avgCostPaisa ?? overview?.avg_cost_paisa ?? 0;

  const cards: { label: string; value: string }[] = [
    { label: t("analytics.cardChats", "Chats", "চ্যাট"), value: fmtNum(overview?.conversations ?? 0) },
    { label: t("analytics.cardOrders", "Orders", "অর্ডার"), value: fmtNum(overview?.orders ?? 0) },
    { label: t("analytics.cardAiHandled", "AI handled", "AI সামলেছে"), value: `${fmtNum(aiPct)}%` },
    { label: t("analytics.cardHandovers", "Went to a human", "মানুষের হাতে গেছে"), value: fmtNum(handovers) },
    { label: t("analytics.cardAvgCost", "Average cost (per reply)", "গড় খরচ (প্রতি উত্তর)"), value: fmtTaka(avgCost) },
  ];

  return (
    <div>
      <h1 className="page-title">{t("analytics.title", "Analytics", "অ্যানালিটিক্স")}</h1>
      <p className="page-subtitle">{t("analytics.subtitle", "Replies, orders and what is selling.", "রিপ্লাই, অর্ডার আর কী বিক্রি হচ্ছে।")}</p>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}

      <div className="flex gap-2 mb-4">
        {(Object.keys(RANGE_KEYS) as Range[]).map((r) => (
          <button
            key={r}
            onClick={() => setRange(r)}
            className={`px-4 py-2 rounded-lg text-sm transition ${range === r ? "bg-brand text-white shadow-sm" : "bg-white shadow-sm hover:bg-orange-50"}`}
          >
            {t(RANGE_KEYS[r], RANGE_FALLBACK[r][0], RANGE_FALLBACK[r][1])}
          </button>
        ))}
      </div>

      {loading ? (<div className="grid grid-cols-2 gap-3 md:grid-cols-5"><div className="skeleton h-20" /><div className="skeleton h-20" /><div className="skeleton h-20" /><div className="skeleton h-20" /><div className="skeleton h-20" /></div>) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
            {cards.map((c) => (
              <div key={c.label} className="card card-hover p-4">
                <p className="text-sm text-slate-500">{c.label}</p>
                <p className="text-2xl font-bold">{c.value}</p>
              </div>
            ))}
          </div>

          <div className="card p-4 mb-6">
            <h2 className="font-bold mb-3">{t("analytics.sourceTitle", "Where orders came from", "অর্ডার কোথা থেকে এসেছে")}</h2>
            {Object.keys(source).length === 0 ? (
              <p className="text-sm text-slate-500">{t("analytics.noData", "No information.", "কোনো তথ্য নেই।")}</p>
            ) : (
              <ul className="text-sm space-y-1">
                {Object.entries(source).map(([k, v]) => {
                  const fb = SOURCE_FALLBACK[k] || [k, k];
                  return (
                    <li key={k} className="flex justify-between border-b py-1">
                      <span>{t(SOURCE_KEYS[k] || "", fb[0], fb[1])}</span>
                      <span className="font-medium">{fmtNum(v as number)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <PostAttributionTable posts={posts} />

          <div className="card p-4 overflow-x-auto">
            <h2 className="font-bold mb-3">{t("analytics.lostTitle", "Reasons for lost sales (total", "বিক্রি হারানোর কারণ (মোট")} {fmtNum(lostTotal)})</h2>
            {lostSales.length === 0 ? (
              <p className="text-sm text-slate-500">{t("analytics.noData", "No information.", "কোনো তথ্য নেই।")}</p>
            ) : (
              <table className="w-full text-sm">
                <thead><tr className="table-head border-b text-left text-slate-500"><th className="p-3">{t("analytics.thReason", "Reason", "কারণ")}</th><th className="p-3">{t("analytics.thCount", "Count", "সংখ্যা")}</th></tr></thead>
                <tbody>
                  {lostSales.map((r, i) => (
                    <tr key={i} className="border-b transition-colors hover:bg-orange-50">
                      <td className="p-3">{r.reason}</td>
                      <td className="p-3">{fmtNum(r.count)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
