"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { billingApi, billingBalance, billingPackagePricePaisa, billingReplyCredits, billingTransactions, billingUsage, getToken, type Billing } from "@/lib/api";
import SubscriptionSummary from "@/components/SubscriptionSummary";
import TopupSection from "./topup-section";
import Link from "next/link";
import { useI18n } from "@/lib/i18n";

export default function BillingPage() {
  const router = useRouter();
  const { t, fmtDate, fmtTaka, fmtNum } = useI18n();
  const [billing, setBilling] = useState<Billing | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

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

  if (loading) return (
    <div className="space-y-3">
      <div className="skeleton h-8 w-48" />
      <div className="skeleton h-24" />
      <div className="skeleton h-24" />
    </div>
  );

  const usage = billing ? billingUsage(billing) : [];
  const transactions = billing ? billingTransactions(billing) : [];
  // Two costs per reply: the provider cost (what the reply actually
  // cost us — always recorded, even on trial) and the wallet charge
  // (0 for trial / included / package replies, 50 pay-as-you-go).
  // The page shows the provider cost as the AI cost, with the wallet
  // charge next to it, so trial usage is visible instead of "0".
  const providerCostOf = (u: { providerCostPaisa?: number; provider_cost_paisa?: number }) =>
    u.providerCostPaisa ?? u.provider_cost_paisa ?? 0;
  const walletChargeOf = (u: { costPaisa?: number; cost_paisa?: number; cost?: number }) =>
    u.costPaisa ?? u.cost_paisa ?? u.cost ?? 0;
  const totalProviderCost = billing?.totalProviderCostPaisa ?? billing?.total_provider_cost_paisa
    ?? usage.reduce((sum, u) => sum + providerCostOf(u), 0);
  const totalWalletCharged = billing?.totalWalletChargedPaisa ?? billing?.total_wallet_charged_paisa
    ?? usage.reduce((sum, u) => sum + walletChargeOf(u), 0);
  const usageCount = billing?.usageCount ?? billing?.usage_count ?? usage.length;
  const avgCost = usageCount > 0 ? totalProviderCost / usageCount : 0;
  const replyCredits = billing ? billingReplyCredits(billing) : 0;
  const packagePrice = billing ? billingPackagePricePaisa(billing) : 20;

  // Wallet transaction type, translated (never show the raw DB value).
  const txTypeLabel = (type: string | undefined) =>
    type === "topup" ? t("billing.txTopup", "Top-up", "টপ-আপ")
    : type === "ai_charge" ? t("billing.txAiCharge", "AI reply cost", "AI উত্তরের খরচ")
    : type === "subscription_charge" ? t("billing.txSubscription", "Subscription", "সাবস্ক্রিপশন")
    : type === "package_purchase" ? t("billing.txPackage", "Reply package", "রিপ্লাই প্যাকেজ")
    : type === "schedule_subscription" ? t("billing.txSchedule", "Post schedule subscription", "পোস্ট শিডিউল সাবস্ক্রিপশন")
    : type || "—";
  // What paid for one ledger reply: package credit, included plan reply, or wallet.
  const usageSourceLabel = (u: { packageCreditUsed?: boolean; package_credit_used?: boolean; includedInPlan?: boolean; included_in_plan?: boolean }) =>
    (u.packageCreditUsed ?? u.package_credit_used)
      ? t("billing.srcPackage", "Package", "প্যাকেজ")
      : (u.includedInPlan ?? u.included_in_plan)
        ? t("billing.srcIncluded", "Included", "অন্তর্ভুক্ত")
        : t("billing.srcWallet", "Wallet", "ওয়ালেট");
  // Stored descriptions are English; translate the one known value.
  const txDescription = (tx: { description?: string; type?: string }) =>
    tx.description === "Free credit on signup"
      ? t("billing.txFreeCredit", "Free credit on signup", "সাইনআপে ফ্রি ক্রেডিট")
      : tx.description || txTypeLabel(tx.type);

  return (
    <div>
      <h1 className="page-title">{t("billing.title", "Billing & Wallet", "বিলিং ও ওয়ালেট")}</h1>
      <p className="page-subtitle">{t("billing.subtitle", "Wallet balance, top-ups and transactions.", "ওয়ালেট ব্যালেন্স, টপ-আপ আর লেনদেন।")}</p>
      <SubscriptionSummary />
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="card p-5">
          <p className="text-slate-500 text-sm">{t("billing.walletBalance", "Wallet balance", "ওয়ালেট ব্যালেন্স")}</p>
          <p className="text-3xl font-bold text-brand-dark">{fmtTaka(billing ? billingBalance(billing) : 0)}</p>
          <p className="text-xs text-slate-500 mt-2">
            {usageCount > 0 && totalWalletCharged === 0 ? (
              <>{t("billing.trialCoveredNote", "Your replies so far were covered by the free trial's included replies — the wallet was charged ৳0, so the signup credit is untouched.", "এখন পর্যন্ত আপনার রিপ্লাইগুলো ফ্রি ট্রায়ালের অন্তর্ভুক্ত রিপ্লাই থেকে গেছে — ওয়ালেট থেকে ৳০ কাটা হয়নি, তাই সাইনআপের ক্রেডিট পুরোটাই আছে।")}{" "}{t("billing.afterTrialNote", "After the trial ends, each reply uses this balance.", "ট্রায়াল শেষ হলে প্রতি রিপ্লাই এই ব্যালেন্স থেকে যাবে।")}</>
            ) : totalWalletCharged > 0 ? (
              <>{t("billing.walletChargedSoFar", "Wallet charged so far for AI replies:", "AI রিপ্লাইয়ের জন্য ওয়ালেট থেকে এখন পর্যন্ত কাটা হয়েছে:")} {fmtTaka(totalWalletCharged)}</>
            ) : (
              t("billing.freeCreditNote", "🎁 New accounts get free credit — trial replies are included, so the wallet is charged only once the trial ends.", "🎁 নতুন অ্যাকাউন্টে ফ্রি ক্রেডিট দেওয়া হয় — ট্রায়ালের রিপ্লাই অন্তর্ভুক্ত, তাই ট্রায়াল শেষ হলেই ওয়ালেট থেকে কাটা শুরু হবে।")
            )}
          </p>
        </div>
        <div className="card p-5">
          <p className="text-slate-500 text-sm">{t("billing.totalAiCost", "Total AI cost", "মোট AI খরচ")}</p>
          <p className="text-3xl font-bold">{fmtTaka(totalProviderCost)}</p>
          <p className="text-xs text-slate-500 mt-2">{fmtNum(usageCount)} {t("billing.repliesCount", "replies", "টি রিপ্লাই")} · {t("billing.walletCharged", "Wallet charged", "ওয়ালেট থেকে কাটা")} {fmtTaka(totalWalletCharged)}</p>
          {usageCount > 0 && totalProviderCost > totalWalletCharged && (
            <p className="text-xs text-slate-500 mt-1">{t("billing.coveredNote", "The rest was covered by included trial / package replies — not by your wallet.", "বাকিটা ফ্রি ট্রায়াল / প্যাকেজের অন্তর্ভুক্ত রিপ্লাই থেকে গেছে — আপনার ওয়ালেট থেকে নয়।")}</p>
          )}
        </div>
        <div className="card p-5">
          <p className="text-slate-500 text-sm">{t("billing.avgCost", "Average cost / reply", "গড় খরচ / রিপ্লাই")}</p>
          <p className="text-3xl font-bold">{fmtTaka(avgCost)}</p>
          <p className="text-xs text-slate-500 mt-2">{t("billing.avgCostTarget", "Average real cost per reply (provider).", "প্রতি রিপ্লাইয়ে গড় আসল খরচ (প্রোভাইডার)।")}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="card p-5">
          <p className="text-slate-500 text-sm">{t("billing.replyPackage", "Reply package left", "রিপ্লাই প্যাকেজে বাকি")}</p>
          <p className="text-3xl font-bold">{fmtNum(replyCredits)} <span className="text-base font-normal text-slate-500">{t("billing.repliesCount", "replies", "টি রিপ্লাই")}</span></p>
          <p className="text-xs text-slate-500 mt-2">
            {t("billing.packagePriceNote", "Package replies are used first, before wallet charges.", "প্যাকেজের রিপ্লাই আগে খরচ হয় — ওয়ালেট থেকে কাটার আগে।")}
          </p>
          <Link href="/checkout?model=package" className="inline-block mt-3 bg-brand text-white px-4 py-2 rounded-lg text-sm hover:bg-brand-dark">
            {t("billing.buyPackage", "Buy reply package", "রিপ্লাই প্যাকেজ কিনুন")}
          </Link>
        </div>
        <div className="card p-5">
          <p className="text-slate-500 text-sm">{t("billing.tokenRateTitle", "Pay-as-you-go AI credit", "Pay-as-you-go AI ক্রেডিট")}</p>
          <p className="text-sm text-slate-600 mt-2">
            {t("billing.paygFlatNote", "AI replies use your wallet balance. AI replies stop honestly when the wallet is empty.", "AI রিপ্লাই আপনার ওয়ালেট ব্যালেন্স থেকে চলে। ওয়ালেট খালি হলে AI উত্তর সৎভাবে থেমে যায়।")}
          </p>
        </div>
      </div>

      <TopupSection />

      <h2 className="font-bold mb-2">{t("billing.ledgerTitle", "Cost of each AI reply", "প্রতি AI রিপ্লাইয়ের খরচ")}</h2>
      {usage.length === 0 ? (
        <div className="empty-state mb-6">{t("billing.ledgerEmpty", "No AI usage records yet.", "এখনো কোনো AI ব্যবহারের রেকর্ড নেই।")}</div>
      ) : (
        <div className="card overflow-x-auto mb-6">
          <table className="w-full text-sm">
            <thead><tr className="table-head border-b text-left text-slate-500"><th className="p-3">{t("billing.thDate", "Date", "তারিখ")}</th><th className="p-3">{t("billing.thTokens", "Tokens", "টোকেন")}</th><th className="p-3">{t("billing.thSource", "Paid from", "কোথা থেকে কাটলো")}</th><th className="p-3 text-right">{t("billing.thCost", "AI cost (paisa)", "AI খরচ (পয়সা)")}</th><th className="p-3 text-right">{t("billing.thWalletCost", "Wallet (paisa)", "ওয়ালেট (পয়সা)")}</th></tr></thead>
            <tbody>
              {usage.map((u) => (
                <tr key={u.id} className="border-b">
                  <td className="p-3">{fmtDate(u.createdAt || u.created_at)}</td>
                  <td className="p-3">{fmtNum(u.tokens ?? ((u.inputTokens ?? u.input_tokens ?? 0) + (u.outputTokens ?? u.output_tokens ?? 0)))}</td>
                  <td className="p-3">{usageSourceLabel(u)}</td>
                  <td className="p-3 text-right">{fmtNum(providerCostOf(u))}</td>
                  <td className="p-3 text-right">{fmtNum(walletChargeOf(u))}</td>
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
                  <td className="p-3">{txTypeLabel(tx.type)}</td>
                  <td className="p-3">{txDescription(tx)}</td>
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
