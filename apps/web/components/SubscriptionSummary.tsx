"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  asCurrent,
  planName,
  subscriptionPeriodEnd,
  subscriptionsApi,
  type CurrentSubscription,
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

/**
 * Small subscription card for the Billing page.
 * Mounted in `apps/web/app/billing/page.tsx` as `<SubscriptionSummary />`.
 */
export default function SubscriptionSummary() {
  const { t, lang, fmtDate, fmtTaka, fmtNum } = useI18n();
  const [current, setCurrent] = useState<CurrentSubscription | null>(null);

  const load = useCallback(async () => {
    try {
      setCurrent(asCurrent(await subscriptionsApi.current()));
    } catch {
      setCurrent(null);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (!current) return null;
  const used = current.usage?.usedReplies ?? 0;
  const included = current.usage?.includedReplies ?? 0;
  const eff = current.subscription.effectiveStatus || current.subscription.status || "";
  const fb = SUB_STATUS_FALLBACK[eff] || [eff || "—", eff || "—"];
  const statusLabel = t(SUB_STATUS_KEYS[eff] || "", fb[0], fb[1]);

  return (
    <div className="card p-5 mb-6 flex flex-wrap justify-between gap-3 items-center">
      <div>
        <p className="text-slate-500 text-sm">{t("billing.yourPlan", "Your plan", "আপনার প্ল্যান")}</p>
        <p className="text-xl font-bold">
          {planName(current.plan, lang)}{" "}
          <span className="text-sm font-normal text-slate-500">
            ({statusLabel})
          </span>
        </p>
        <p className="text-sm text-slate-500 mt-1">
          {t("billing.expires", "Expires:", "মেয়াদ শেষ:")} {fmtDate(subscriptionPeriodEnd(current.subscription))}
          {" • "}{t("billing.aiRepliesThisMonth", "AI replies this month:", "এই মাসে AI রিপ্লাই:")} {fmtNum(used)} / {fmtNum(included)}
        </p>
      </div>
      <Link href="/plans" className="bg-brand text-white px-4 py-2 rounded-lg text-sm hover:bg-brand-dark">
        {t("billing.viewPlan", "View / change plan", "প্ল্যান দেখুন / বদলান")}
      </Link>
      <p className="text-xs text-slate-400 w-full">
        {t("billing.walletBalanceLine", "Wallet balance:", "ওয়ালেট ব্যালেন্স:")} {fmtTaka(current.balancePaisa ?? 0)}
        {" • "}{t("billing.replyPackageLine", "Reply package left:", "রিপ্লাই প্যাকেজ বাকি:")} {fmtNum(current.replyCredits ?? 0)}
        {t("billing.newModelNote", " — package replies are used first.", " — প্যাকেজের রিপ্লাই আগে খরচ হয়।")}
      </p>
      {eff === "trial" && (
        <p className="text-xs text-slate-400 w-full">
          {t("billing.paygAfterTrial", "Pay-as-you-go starts after the trial ends.", "ট্রায়াল শেষ হলে pay-as-you-go শুরু হবে।")}
        </p>
      )}
    </div>
  );
}
