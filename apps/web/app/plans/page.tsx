"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  asCurrent,
  asPlans,
  getToken,
  planIncludedReplies,
  planMaxChannels,
  planMaxProducts,
  planName,
  planPricePaisa,
  subscriptionPeriodEnd,
  subscriptionsApi,
  type CurrentSubscription,
  type Plan,
} from "@/lib/subscriptions";
import { useI18n } from "@/lib/i18n";

const SUB_STATUS_KEYS: Record<string, string> = {
  trial: "subStatus.trial",
  active: "subStatus.active",
  past_due: "subStatus.past_due",
  cancelled: "subStatus.cancelled",
  expired: "subStatus.expired",
};
const SUB_STATUS_FALLBACK: Record<string, [string, string]> = {
  trial: ["Free trial", "ফ্রি ট্রায়াল"],
  active: ["Active", "চালু"],
  past_due: ["Past due", "বকেয়া"],
  cancelled: ["Cancelled (active until expiry)", "বাতিল (মেয়াদ পর্যন্ত চালু)"],
  expired: ["Expired", "মেয়াদ শেষ"],
};

export default function PlansPage() {
  const router = useRouter();
  const { t, fmtDate, fmtTaka, fmtNum } = useI18n();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [current, setCurrent] = useState<CurrentSubscription | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");

  const subStatusLabel = (s: { effectiveStatus?: string; status?: string } | undefined) => {
    const eff = s?.effectiveStatus || s?.status || "";
    const fb = SUB_STATUS_FALLBACK[eff] || [eff || "—", eff || "—"];
    return t(SUB_STATUS_KEYS[eff] || "", fb[0], fb[1]);
  };
  const limitText = (v: number | null, unitKey: string, unitEn: string, unitBn: string) =>
    v === null || v === undefined
      ? t("plans.unlimited", "Unlimited", "সীমাহীন")
      : `${fmtNum(v)}${t("plans.countSuffix", "", "টি")} ${t(unitKey, unitEn, unitBn)}`;

  const load = useCallback(async () => {
    try {
      const [p, c] = await Promise.all([
        subscriptionsApi.plans(),
        subscriptionsApi.current(),
      ]);
      setPlans(asPlans(p));
      setCurrent(asCurrent(c));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("plans.loadFailed", "Could not load plans.", "প্ল্যান লোড করা যায়নি।"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!getToken()) { router.push("/login"); return; }
    load();
  }, [load, router]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setError(""); setNotice(""); setBusy(label);
    try {
      const res = await fn() as { message?: string };
      if (res?.message) setNotice(res.message);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("plans.requestFailed", "Could not make the request.", "অনুরোধটি করা যায়নি।"));
    } finally {
      setBusy("");
    }
  };

  if (loading) return <p className="text-slate-500">{t("common.loading", "Loading…", "লোড হচ্ছে…")}</p>;

  const currentPlan = current?.plan;
  const currentSub = current?.subscription;
  const used = current?.usage?.usedReplies ?? 0;
  const included = current?.usage?.includedReplies ?? 0;
  const usedPct = included > 0 ? Math.min(100, Math.round((used / included) * 100)) : 0;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-2">{t("plans.title", "Plans", "প্ল্যান")}</h1>
      <p className="text-sm text-slate-500 mb-4">
        <span className="font-bold text-amber-700">{t("common.suggestedPrice", "Suggested price", "প্রস্তাবিত দাম")}</span>{" — "}
        {t("plans.suggestedNote", "The prices below are suggested prices — not final prices. When you buy a plan, the monthly price is deducted from the wallet (see transactions on the Billing page).", "নিচের দামগুলো প্রস্তাবিত দাম — চূড়ান্ত দাম নয়। প্ল্যান কিনলে মাসের দাম ওয়ালেট থেকে কাটে (বিলিং পেজে লেনদেন দেখা যায়)।")}
      </p>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}
      {notice && <p className="bg-teal-50 text-teal-800 text-sm p-3 rounded-lg mb-4">{notice}</p>}

      {current && currentSub && (
        <div className="bg-white rounded-xl shadow p-5 mb-6">
          <div className="flex flex-wrap justify-between gap-3 items-center">
            <div>
              <p className="text-slate-500 text-sm">{t("plans.currentPlan", "Current plan", "বর্তমান প্ল্যান")}</p>
              <p className="text-xl font-bold">
                {currentPlan ? planName(currentPlan) : "—"}{" "}
                <span className="text-sm font-normal text-slate-500">({subStatusLabel(currentSub)})</span>
              </p>
              <p className="text-sm text-slate-500 mt-1">
                {t("plans.expires", "Expires:", "মেয়াদ শেষ:")} {fmtDate(subscriptionPeriodEnd(currentSub))}
                {" • "}{t("plans.aiRepliesThisMonth", "AI replies this month:", "এই মাসে AI রিপ্লাই:")} {fmtNum(used)} / {fmtNum(included)}
                {" • "}{t("plans.wallet", "Wallet:", "ওয়ালেট:")} {fmtTaka(current.balancePaisa ?? 0)}
              </p>
              <div className="w-64 bg-slate-200 rounded-full h-2 mt-2">
                <div className="bg-brand h-2 rounded-full" style={{ width: `${usedPct}%` }} />
              </div>
            </div>
            <div className="flex gap-2">
              <button
                disabled={!!busy}
                onClick={() => act("renew", () => subscriptionsApi.renew())}
                className="bg-brand text-white px-4 py-2 rounded-lg hover:bg-brand-dark disabled:opacity-50"
              >
                {busy === "renew" ? t("plans.renewing", "Renewing…", "নবায়ন হচ্ছে…") : t("plans.renew", "Renew", "নবায়ন করুন")}
              </button>
              {currentSub.status !== "cancelled" && currentSub.effectiveStatus !== "expired" && (
                <button
                  disabled={!!busy}
                  onClick={() => {
                    if (confirm(t("plans.cancelConfirm", "Cancel this plan? It will stay on until the expiry date.", "প্ল্যানটি বাতিল করবেন? মেয়াদ শেষ পর্যন্ত চালু থাকবে।"))) {
                      act("cancel", () => subscriptionsApi.cancel());
                    }
                  }}
                  className="bg-white border border-red-300 text-red-700 px-4 py-2 rounded-lg disabled:opacity-50"
                >
                  {busy === "cancel" ? t("plans.cancelling", "Cancelling…", "বাতিল হচ্ছে…") : t("plans.cancel", "Cancel", "বাতিল করুন")}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {plans.length === 0 ? (
        <p className="text-slate-500 bg-white rounded-xl shadow p-6">{t("plans.empty", "No plans found.", "কোনো প্ল্যান পাওয়া যায়নি।")}</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {plans.map((p) => {
            const isCurrent = currentPlan?.id === p.id;
            const price = planPricePaisa(p);
            const curPrice = currentPlan ? planPricePaisa(currentPlan) : 0;
            const isBigger = price > curPrice;
            const actionLabel = isCurrent
              ? t("plans.currentPlan", "Current plan", "বর্তমান প্ল্যান")
              : currentSub && (currentSub.status === "active" || currentSub.status === "trial") && !isCurrent
                ? isBigger ? t("plans.upgrade", "Upgrade", "আপগ্রেড করুন") : t("plans.downgrade", "Downgrade", "ডাউনগ্রেড করুন")
                : t("plans.takeThis", "Take this plan", "এই প্ল্যানটি নিন");
            const action = isCurrent
              ? undefined
              : currentSub && (currentSub.status === "active" || currentSub.status === "trial") && !isCurrent
                ? isBigger
                  ? () => subscriptionsApi.upgrade(p.slug)
                  : () => subscriptionsApi.downgrade(p.slug)
                : () => subscriptionsApi.subscribe(p.slug);
            return (
              <div
                key={p.id}
                className={`bg-white rounded-xl shadow p-5 flex flex-col ${isCurrent ? "ring-2 ring-brand" : ""}`}
              >
                <div className="flex justify-between items-start">
                  <h2 className="text-xl font-bold">{planName(p)}</h2>
                  <span className="text-xs bg-amber-100 text-amber-800 px-2 py-1 rounded-full">{t("common.suggestedPrice", "Suggested price", "প্রস্তাবিত দাম")}</span>
                </div>
                {isCurrent && (
                  <span className="text-xs bg-teal-100 text-teal-800 px-2 py-1 rounded-full self-start mt-2">
                    {t("plans.currentBadge", "✓ Current plan", "✓ বর্তমান প্ল্যান")}
                  </span>
                )}
                <p className="text-3xl font-bold mt-3">
                  {fmtTaka(price)}
                  <span className="text-base font-normal text-slate-500"> {t("common.perMonth", "/ month", "/ মাস")}</span>
                </p>
                <ul className="text-sm text-slate-600 mt-4 space-y-2 flex-1">
                  <li>✓ {t("plans.includedEveryMonth", "Every month,", "প্রতি মাসে")} {fmtNum(planIncludedReplies(p))} {t("plans.includedReplies", "AI replies included", "টি AI রিপ্লাই অন্তর্ভুক্ত")}</li>
                  <li>✓ {t("plans.maxChannels", "Max", "সর্বোচ্চ")} {limitText(planMaxChannels(p), "plans.channelsUnit", "channels", "চ্যানেল")}</li>
                  <li>✓ {t("plans.maxProducts", "Max", "সর্বোচ্চ")} {limitText(planMaxProducts(p), "plans.productsUnit", "products", "প্রোডাক্ট")}</li>
                  <li>✓ {t("plans.overage", "Once the limit is over, extra replies cost 10 paisa each", "সীমা শেষ হলে অতিরিক্ত রিপ্লাই ১০ পয়সা করে")}</li>
                </ul>
                <button
                  disabled={isCurrent || !!busy}
                  onClick={() => action && act(p.slug, action)}
                  className={`mt-5 py-2 rounded-lg ${isCurrent ? "bg-slate-200 text-slate-500" : "bg-brand text-white hover:bg-brand-dark"} disabled:opacity-50`}
                >
                  {busy === p.slug ? t("plans.processing", "Processing…", "প্রসেস হচ্ছে…") : actionLabel}
                </button>
              </div>
            );
          })}
        </div>
      )}

      <p className="text-xs text-slate-500 mt-6">
        {t("plans.trialNote", "New accounts get a 14-day free trial (small plan). The ৳50 free credit given at signup stays in the wallet — once the limit is over, the cost of extra AI replies is deducted from there.", "নতুন অ্যাকাউন্টে ১৪ দিনের ফ্রি ট্রায়াল থাকে (ছোট প্ল্যান)। সাইনআপে দেওয়া ৳৫০ ফ্রি ক্রেডিট ওয়ালেটে থাকে — সীমা শেষ হলে অতিরিক্ত AI রিপ্লাইয়ের খরচ সেখান থেকে কাটে।")}
      </p>
    </div>
  );
}
