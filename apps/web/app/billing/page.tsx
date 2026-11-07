"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { billingApi, billingBalance, billingTransactions, billingUsage, getToken, type Billing } from "@/lib/api";
import SubscriptionSummary from "@/components/SubscriptionSummary";
import TopupSection from "./topup-section";
import { useI18n } from "@/lib/i18n";

export default function BillingPage() {
  const router = useRouter();
  const { t, fmtDate, fmtTaka, fmtNum } = useI18n();
  const [billing, setBilling] = useState<Billing | null>(null);
  const [topupTaka, setTopupTaka] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setBilling(await billingApi.get());
    } catch (err) {
      setError(err instanceof Error ? err.message : t("billing.loadFailed", "Could not load billing.", "বিলিং লোড করা যায়নি।"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!getToken()) { router.push("/login"); return; }
    load();
  }, [load, router]);

  const topup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(""); setNotice(""); setSaving(true);
    try {
      const amountPaisa = Math.round(parseFloat(topupTaka || "0") * 100);
      await billingApi.topup(amountPaisa);
      setNotice(`${t("billing.topupRequested", "Top-up request sent. It will be confirmed here once the payment gateway is connected — for now this is a stub.", "টপ-আপের অনুরোধ পাঠানো হয়েছে। পেমেন্ট গেটওয়ে যুক্ত হলে এখানেই নিশ্চিত হবে — আপাতত এটি একটি স্টাব।")} (${fmtTaka(amountPaisa)})`);
      setTopupTaka("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("billing.topupFailed", "Top-up failed.", "টপ-আপ ব্যর্থ হয়েছে।"));
    } finally { setSaving(false); }
  };

  if (loading) return <p className="text-slate-500">{t("common.loading", "Loading…", "লোড হচ্ছে…")}</p>;

  const usage = billing ? billingUsage(billing) : [];
  const transactions = billing ? billingTransactions(billing) : [];
  const totalCost = usage.reduce((sum, u) => sum + (u.costPaisa ?? u.cost_paisa ?? u.cost ?? 0), 0);
  const avgCost = usage.length > 0 ? totalCost / usage.length : 0;

  return (
    <div>
      <h1 className="page-title">{t("billing.title", "Billing & Wallet", "বিলিং ও ওয়ালেট")}</h1>
      <p className="page-subtitle">{t("billing.subtitle", "Wallet balance, top-ups and transactions.", "ওয়ালেট ব্যালেন্স, টপ-আপ আর লেনদেন।")}</p>
      <SubscriptionSummary />
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}
      {notice && <p className="bg-teal-50 text-teal-800 text-sm p-3 rounded-lg mb-4">{notice}</p>}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="card p-5">
          <p className="text-slate-500 text-sm">{t("billing.walletBalance", "Wallet balance", "ওয়ালেট ব্যালেন্স")}</p>
          <p className="text-3xl font-bold text-brand-dark">{fmtTaka(billing ? billingBalance(billing) : 0)}</p>
          <p className="text-xs text-slate-500 mt-2">{t("billing.freeCreditNote", "🎁 New accounts get free credit — no monthly fee, only the cost of each AI reply is deducted.", "🎁 নতুন অ্যাকাউন্টে ফ্রি ক্রেডিট দেওয়া হয় — কোনো মাসিক ফি নেই, শুধু প্রতি AI রিপ্লাইয়ের খরচ কাটা হয়।")}</p>
        </div>
        <div className="card p-5">
          <p className="text-slate-500 text-sm">{t("billing.totalAiCost", "Total AI cost (ledger)", "মোট AI খরচ (লেজার)")}</p>
          <p className="text-3xl font-bold">{fmtTaka(totalCost)}</p>
          <p className="text-xs text-slate-500 mt-2">{fmtNum(usage.length)} {t("billing.repliesCount", "replies", "টি রিপ্লাই")}</p>
        </div>
        <div className="card p-5">
          <p className="text-slate-500 text-sm">{t("billing.avgCost", "Average cost / reply", "গড় খরচ / রিপ্লাই")}</p>
          <p className="text-3xl font-bold">{fmtNum(Math.round(avgCost * 100) / 100)} {t("billing.avgCostUnit", "paisa", "পয়সা")}</p>
          <p className="text-xs text-slate-500 mt-2">{t("billing.avgCostTarget", "Target: under 20 paisa (Phase 1 gate)", "লক্ষ্য: ২০ পয়সার নিচে (ফেজ ১ গেট)")}</p>
        </div>
      </div>

      <form onSubmit={topup} className="card p-4 mb-6 flex flex-wrap gap-2 items-end">
        <div className="flex-1 min-w-52">
          <label className="block text-sm font-medium mb-1">{t("billing.topupAmount", "Top-up amount (৳)", "টপ-আপের পরিমাণ (৳)")}</label>
          <input required type="number" min="1" step="0.01" value={topupTaka} onChange={(e) => setTopupTaka(e.target.value)} placeholder={t("billing.topupAmountPlaceholder", "e.g. 500", "যেমন: 500")} className="w-full border rounded-lg px-3 py-2" />
        </div>
        <button disabled={saving} className="bg-brand text-white px-5 py-2 rounded-lg hover:bg-brand-dark disabled:opacity-50">{saving ? t("billing.topupProcessing", "Processing…", "প্রসেস হচ্ছে…") : t("billing.topupButton", "Top up", "টপ-আপ করুন")}</button>
        <p className="text-xs text-slate-500 w-full">{t("billing.topupGatewayNote", "Payment gateway (bKash/Nagad/card) is not connected yet — this form only sends amountPaisa to the API.", "পেমেন্ট গেটওয়ে (বিকাশ/নগদ/কার্ড) এখনো যুক্ত হয়নি — এই ফর্মটি API-তে amountPaisa পাঠায় মাত্র।")}</p>
      </form>

      <TopupSection />

      <h2 className="font-bold mb-2">{t("billing.ledgerTitle", "Cost of each AI reply — ledger (ai_usage_ledger)", "প্রতি AI রিপ্লাইয়ের খরচ — লেজার (ai_usage_ledger)")}</h2>
      {usage.length === 0 ? (
        <p className="text-slate-500 card p-6 mb-6">{t("billing.ledgerEmpty", "No AI usage records yet.", "এখনো কোনো AI ব্যবহারের রেকর্ড নেই।")}</p>
      ) : (
        <div className="card overflow-x-auto mb-6">
          <table className="w-full text-sm">
            <thead><tr className="table-head border-b text-left text-slate-500"><th className="p-3">{t("billing.thDate", "Date", "তারিখ")}</th><th className="p-3">{t("billing.thModel", "Model", "মডেল")}</th><th className="p-3">{t("billing.thTokens", "Tokens", "টোকেন")}</th><th className="p-3 text-right">{t("billing.thCost", "Cost (paisa)", "খরচ (পয়সা)")}</th></tr></thead>
            <tbody>
              {usage.map((u) => (
                <tr key={u.id} className="border-b">
                  <td className="p-3">{fmtDate(u.createdAt || u.created_at)}</td>
                  <td className="p-3">{u.provider || u.model || "—"}</td>
                  <td className="p-3">{fmtNum(u.tokens ?? ((u.inputTokens ?? u.input_tokens ?? 0) + (u.outputTokens ?? u.output_tokens ?? 0)))}</td>
                  <td className="p-3 text-right">{fmtNum(u.costPaisa ?? u.cost_paisa ?? u.cost ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="font-bold mb-2">{t("billing.txTitle", "Wallet transactions", "ওয়ালেট লেনদেন")}</h2>
      {transactions.length === 0 ? (
        <div className="empty-state">{t("billing.txEmpty", "No transactions.", "কোনো লেনদেন নেই।")}</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="table-head border-b text-left text-slate-500"><th className="p-3">{t("billing.thDate", "Date", "তারিখ")}</th><th className="p-3">{t("billing.thType", "Type", "ধরন")}</th><th className="p-3">{t("billing.thDesc", "Description", "বিবরণ")}</th><th className="p-3 text-right">{t("billing.thAmount", "Amount", "পরিমাণ")}</th></tr></thead>
            <tbody>
              {transactions.map((tx) => (
                <tr key={tx.id} className="border-b">
                  <td className="p-3">{fmtDate(tx.createdAt || tx.created_at)}</td>
                  <td className="p-3">{tx.type || "—"}</td>
                  <td className="p-3">{tx.description || "—"}</td>
                  <td className="p-3 text-right">{fmtTaka(tx.amountPaisa ?? tx.amount_paisa ?? tx.amount ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
