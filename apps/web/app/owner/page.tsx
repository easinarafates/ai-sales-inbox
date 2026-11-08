"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { getToken } from "@/lib/api";
import { ownerApi, type OwnerOverview } from "@/lib/api-owner";

export default function OwnerDashboardPage() {
  const { t, fmtDate, fmtTaka, fmtNum } = useI18n();
  const router = useRouter();
  const [data, setData] = useState<OwnerOverview | null>(null);
  const [isOwner, setIsOwner] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState<7 | 30>(30);

  const load = useCallback(async () => {
    try {
      const me = await ownerApi.me();
      setIsOwner(me.isOwner);
      if (!me.isOwner) return;
      const d = await ownerApi.overview(days);
      setData(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ownerLoadFail", "Could not load the Owner Panel.", "ওনার প্যানেল লোড করা যায়নি।"));
    } finally {
      setLoading(false);
    }
  }, [days, t]);

  useEffect(() => {
    if (!getToken()) { router.push("/login"); return; }
    load();
  }, [load, router]);

  const card = "card p-4";
  const cardTitle = "text-sm text-slate-500";
  const cardValue = "text-2xl font-bold mt-1";

  return (
    <div>
      <h1 className="page-title">{t("ownerTitle", "Owner Panel", "ওনার প্যানেল")}</h1>
      <p className="page-subtitle">
        {t(
          "ownerSub",
          "Your whole business in one place — shops, subscriptions, money in, AI costs, and your wallet.",
          "আপনার পুরো ব্যবসা এক জায়গায় — দোকান, সাবস্ক্রিপশন, আয়, AI-এর খরচ আর আপনার ওয়ালেট।"
        )}
      </p>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}
      {loading ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          <div className="skeleton h-24" />
          <div className="skeleton h-24" />
          <div className="skeleton h-24" />
        </div>
      ) : isOwner === false ? (
        <div className="card p-6">
          <p className="font-bold text-lg">{t("ownerOnly", "Owner only", "শুধু মালিকের জন্য")}</p>
          <p className="text-sm text-slate-500 mt-1">
            {t(
              "ownerOnlyText",
              "This page is only for the platform owner. Shop owners see only their own shop.",
              "এই পেজ শুধু প্ল্যাটফর্মের মালিকের জন্য। দোকানের মালিকরা শুধু নিজের দোকান দেখতে পায়।"
            )}
          </p>
        </div>
      ) : data ? (
        <>
          {data.ownerWallet.lowBalance && (
            <p className="bg-amber-50 text-amber-700 border border-amber-300 text-sm p-3 rounded-lg mb-4">
              {t(
                "ownerLowBalance",
                "Your owner wallet is low — AI provider costs are deducted from it automatically. Top it up from the Wallet page.",
                "আপনার ওনার ওয়ালেটে টাকা কম — AI-এর খরচ এখান থেকে নিজে নিজে কাটা হয়। Wallet পেজ থেকে টাকা জমা করুন।"
              )}
            </p>
          )}
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
            <div className={card}>
              <p className={cardTitle}>{t("ownerShops", "Shops", "দোকান")}</p>
              <p className={cardValue}>{fmtNum(data.shops.total)}</p>
              <p className="text-xs text-slate-500">{fmtNum(data.shops.active)} {t("ownerShopsActive", "active", "চালু")}</p>
            </div>
            <div className={card}>
              <p className={cardTitle}>{t("ownerActiveSubs", "Active subscriptions", "চালু সাবস্ক্রিপশন")}</p>
              <p className={cardValue}>{fmtNum(data.activeSubscriptions)}</p>
              <p className="text-xs text-slate-500">
                {t("ownerExpectedMrr", "Expected / month", "প্রতি মাসে আশা")} {fmtTaka(data.expectedMonthlyRevenuePaisa)}
              </p>
            </div>
            <div className={card}>
              <p className={cardTitle}>{t("ownerRevenueMonth", "Revenue this month", "এই মাসের আয়")}</p>
              <p className={cardValue}>{fmtTaka(data.revenueThisMonthPaisa)}</p>
              <p className="text-xs text-slate-500">{fmtNum(data.revenueThisMonthCharges)} {t("ownerPayments", "payments", "পেমেন্ট")}</p>
            </div>
            <div className={card}>
              <p className={cardTitle}>{t("ownerApiSpendMonth", "AI cost this month", "এই মাসে AI-এর খরচ")}</p>
              <p className={cardValue}>{fmtTaka(data.apiSpendThisMonthPaisa)}</p>
              <p className="text-xs text-slate-500">
                {t("ownerApiSpendTotal", "All time", "সব মিলিয়ে")} {fmtTaka(data.apiSpendTotalPaisa)}
              </p>
            </div>
            <div className={card}>
              <p className={cardTitle}>{t("ownerWalletBalance", "Owner wallet", "ওনার ওয়ালেট")}</p>
              <p className={cardValue}>{fmtTaka(data.ownerWallet.balancePaisa)}</p>
              <p className="text-xs text-slate-500">
                {t("ownerLowAt", "Warn below", "কম হলে সতর্ক")} {fmtTaka(data.ownerWallet.lowBalanceThresholdPaisa)}
              </p>
            </div>
            <div className={card}>
              <p className={cardTitle}>{t("ownerProfitMonth", "Revenue − AI cost (this month)", "আয় − AI খরচ (এই মাসে)")}</p>
              <p className={cardValue}>{fmtTaka(data.revenueThisMonthPaisa - data.apiSpendThisMonthPaisa)}</p>
              <p className="text-xs text-slate-500">{t("ownerProfitNote", "Before hosting and other expenses.", "হোস্টিং ও অন্যান্য খরচের আগের হিসাব।")}</p>
            </div>
          </div>

          <div className="flex gap-2 mb-4">
            <Link href="/owner/shops" className="bg-brand hover:bg-brand-dark text-white text-sm rounded-lg px-3 py-2 shadow-sm transition">{t("ownerShops", "Shops", "দোকান")}</Link>
            <Link href="/owner/bank-accounts" className="border border-brand bg-white text-brand-dark text-sm rounded-lg px-3 py-2 shadow-sm transition hover:bg-orange-50">{t("ownerBankAccounts", "Bank accounts", "ব্যাংক অ্যাকাউন্ট")}</Link>
            <Link href="/owner/expenses" className="border border-brand bg-white text-brand-dark text-sm rounded-lg px-3 py-2 shadow-sm transition hover:bg-orange-50">{t("ownerExpenses", "Expenses", "খরচ")}</Link>
            <Link href="/owner/api-costs" className="border border-brand bg-white text-brand-dark text-sm rounded-lg px-3 py-2 shadow-sm transition hover:bg-orange-50">{t("ownerApiCosts", "API costs", "API খরচ")}</Link>
            <Link href="/owner/wallet" className="border border-brand bg-white text-brand-dark text-sm rounded-lg px-3 py-2 shadow-sm transition hover:bg-orange-50">{t("ownerWallet", "Wallet", "ওয়ালেট")}</Link>
          </div>

          <div className="flex gap-2 mb-3">
            <button onClick={() => setDays(7)} className={`text-sm rounded-lg px-3 py-1 border transition ${days === 7 ? "bg-brand text-white border-brand" : "border-slate-300 bg-white hover:bg-orange-50"}`}>7 {t("ownerDays", "days", "দিন")}</button>
            <button onClick={() => setDays(30)} className={`text-sm rounded-lg px-3 py-1 border transition ${days === 30 ? "bg-brand text-white border-brand" : "border-slate-300 bg-white hover:bg-orange-50"}`}>30 {t("ownerDays", "days", "দিন")}</button>
          </div>
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="table-head text-left border-b">
                  <th className="p-3">{t("ownerColDate", "Date", "তারিখ")}</th>
                  <th className="p-3">{t("ownerColRevenue", "Revenue", "আয়")}</th>
                  <th className="p-3">{t("ownerColApiCost", "AI cost", "AI খরচ")}</th>
                  <th className="p-3">{t("ownerColNet", "Net", "নিট")}</th>
                </tr>
              </thead>
              <tbody>
                {data.trend.map((row) => (
                  <tr key={row.date} className="border-b last:border-0 transition-colors hover:bg-orange-50">
                    <td className="p-3 whitespace-nowrap">{fmtDate(row.date)}</td>
                    <td className="p-3">{fmtTaka(row.revenuePaisa)}</td>
                    <td className="p-3">{fmtTaka(row.apiCostPaisa)}</td>
                    <td className="p-3">{fmtTaka(row.revenuePaisa - row.apiCostPaisa)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-400 mt-3">
            {t(
              "ownerRevenueNote",
              "Revenue counts real subscription payments (money shops paid from their wallets). AI cost is what the AI providers really charged, from the usage ledger.",
              "আয় মানে দোকানগুলো সত্যিকারে যে সাবস্ক্রিপশনের টাকা দিয়েছে। AI খরচ মানে AI প্রোভাইডাররা আসলে যা নিয়েছে, হিসাবের খাতা থেকে নেওয়া।"
            )}
          </p>
        </>
      ) : null}
    </div>
  );
}
