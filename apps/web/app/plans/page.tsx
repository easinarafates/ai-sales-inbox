"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  billingApi,
  billingPackagePricePaisa,
  billingReplyCredits,
  getToken,
  type Billing,
} from "@/lib/api";
import {
  asCurrent,
  planName,
  scheduleApi,
  schedulePlanPriceText,
  subscriptionPeriodEnd,
  subscriptionsApi,
  type CurrentSubscription,
  type ScheduleOverview,
  type SchedulePlan,
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

const PACKAGE_TIERS = [
  { nameKey: "plans.tierPro", nameFb: ["Pro", "প্রো"] as [string, string], replies: 500 },
  { nameKey: "plans.tierPremium", nameFb: ["Premium", "প্রিমিয়াম"] as [string, string], replies: 1000 },
  { nameKey: "plans.tierBusiness", nameFb: ["Business", "বিজনেস"] as [string, string], replies: 2500 },
];
const PAYG_TOPUP_PRESETS = [100, 200, 500, 1000];

export default function PlansPage() {
  const router = useRouter();
  const { t, lang, fmtDate, fmtTaka, fmtNum } = useI18n();
  const [schedule, setSchedule] = useState<ScheduleOverview | null>(null);
  const [current, setCurrent] = useState<CurrentSubscription | null>(null);
  const [billing, setBilling] = useState<Billing | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [customReplies, setCustomReplies] = useState("");

  const subStatusLabel = (s: { effectiveStatus?: string; status?: string } | undefined) => {
    const eff = s?.effectiveStatus || s?.status || "";
    const fb = SUB_STATUS_FALLBACK[eff] || [eff || "—", eff || "—"];
    return t(SUB_STATUS_KEYS[eff] || "", fb[0], fb[1]);
  };

  const load = useCallback(async () => {
    try {
      const [s, c, b] = await Promise.all([
        scheduleApi.get(),
        subscriptionsApi.current(),
        billingApi.get(),
      ]);
      setSchedule(s);
      setCurrent(asCurrent(c));
      setBilling(b);
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

  if (loading) return (
    <div className="space-y-3">
      <div className="skeleton h-8 w-48" />
      <div className="skeleton h-24" />
      <div className="skeleton h-24" />
    </div>
  );

  const currentPlan = current?.plan;
  const currentSub = current?.subscription;
  const oldPlanActive = !!currentSub && (currentSub.effectiveStatus === "trial" || currentSub.effectiveStatus === "active" || currentSub.effectiveStatus === "cancelled");
  const used = current?.usage?.usedReplies ?? 0;
  const included = current?.usage?.includedReplies ?? 0;
  const usedPct = included > 0 ? Math.min(100, Math.round((used / included) * 100)) : 0;
  const schedSub = schedule?.subscription;
  const schedActive = !!schedSub?.isActive;
  const dailyLimit = schedule?.dailyLimit ?? 1;
  const todayUsed = schedule?.todayUsed ?? 0;
  const replyCredits = billing ? billingReplyCredits(billing) : 0;
  const packagePrice = billing ? billingPackagePricePaisa(billing) : 22;
  const wallet = billing ? (billing.balancePaisa ?? billing.balance_paisa ?? billing.balance ?? 0) : (current?.balancePaisa ?? 0);

  const goCheckout = (qs: string) => router.push(`/checkout?${qs}`);

  return (
    <div>
      <h1 className="page-title">{t("plans.title", "Plans", "প্ল্যান")}</h1>
      <p className="page-subtitle">
        {t("plans.newModelNote", "Pick what you need — pay by bKash / Nagad / Rocket, approved by hand.", "যেটা দরকার সেটা নিন — বিকাশ / নগদ / রকেটে টাকা পাঠিয়ে কিনুন, হাতে অনুমোদন হয়।")}
      </p>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}
      {notice && <p className="bg-green-50 text-green-800 text-sm p-3 rounded-lg mb-4">{notice}</p>}

      {/* ---- Current status ---- */}
      <div className="card p-5 mb-6">
        <div className="flex flex-wrap justify-between gap-3 items-center">
          <div>
            <p className="text-slate-500 text-sm">{t("plans.currentStatus", "Your current status", "আপনার বর্তমান অবস্থা")}</p>
            <p className="text-sm text-slate-600 mt-1">
              {t("plans.wallet", "Wallet:", "ওয়ালেট:")} <b>{fmtTaka(wallet)}</b>
              {" • "}{t("plans.replyPackageLeft", "Reply package left:", "রিপ্লাই প্যাকেজ বাকি:")} <b>{fmtNum(replyCredits)}</b>
              {" • "}{t("plans.todayPosts", "Posts scheduled today:", "আজ শিডিউল করা পোস্ট:")} <b>{fmtNum(todayUsed)} / {fmtNum(dailyLimit)}</b>
            </p>
            {oldPlanActive && currentPlan && currentSub && (
              <p className="text-sm text-slate-600 mt-2">
                {t("plans.oldPlan", "Old plan:", "পুরনো প্ল্যান:")} <b>{planName(currentPlan, lang)}</b>{" "}
                <span className="text-slate-500">({subStatusLabel(currentSub)})</span>
                {" • "}{t("plans.expires", "Expires:", "মেয়াদ শেষ:")} {fmtDate(subscriptionPeriodEnd(currentSub))}
                {" • "}{t("plans.aiRepliesThisMonth", "AI replies this month:", "এই মাসে AI রিপ্লাই:")} {fmtNum(used)} / {fmtNum(included)}
                <span className="block text-xs text-amber-700 mt-1">
                  {t("plans.oldPlanNote", "This old plan runs until its expiry date and cannot be renewed. After that, the new model below applies.", "এই পুরনো প্ল্যান মেয়াদ শেষ পর্যন্ত চলবে — নবায়ন করা যাবে না। মেয়াদ শেষে নিচের নতুন মডেল চালু হবে।")}
                </span>
              </p>
            )}
            {schedActive && schedSub && (
              <p className="text-sm text-slate-600 mt-2">
                {t("plans.scheduleActive", "Post Schedule subscription:", "পোস্ট শিডিউল সাবস্ক্রিপশন:")} <b>{schedSub.status === "cancelled" ? t("plans.cancelledUntil", "Cancelled — active until", "বাতিল — মেয়াদ পর্যন্ত চালু") : t("plans.activeUntil", "Active until", "চালু আছে, মেয়াদ শেষ:")}</b> {fmtDate(schedSub.currentPeriodEnd)}
              </p>
            )}
            <div className="w-64 bg-slate-200 rounded-full h-2 mt-2">
              <div className="bg-brand h-2 rounded-full" style={{ width: `${usedPct}%` }} />
            </div>
          </div>
        </div>
      </div>

      {/* ---- 1. Post Schedule subscription ---- */}
      <h2 className="font-bold text-lg mb-2">{t("plans.scheduleTitle", "1. Post Schedule subscription", "১. পোস্ট শিডিউল সাবস্ক্রিপশন")}</h2>
      <p className="text-sm text-slate-600 mb-4">
        {t("plans.scheduleFree", "1 scheduled post per day is FREE. To schedule more on the same day, take a subscription — no lifetime plan.", "দিনে ১টি পোস্ট শিডিউল করা ফ্রি। একই দিনে বেশি পোস্ট শিডিউল করতে সাবস্ক্রিপশন নিন — কোনো লাইফটাইম প্ল্যান নেই।")}
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        {(["monthly", "yearly"] as const).map((cycle) => {
          const tierPlans = (schedule?.plans ?? []).filter((p: SchedulePlan) => p.cycle === cycle);
          const bd = tierPlans.find((p: SchedulePlan) => p.currency === "BDT");
          const intl = tierPlans.find((p: SchedulePlan) => p.currency === "USD");
          const tierName = cycle === "monthly"
            ? t("plans.tierPro", "Pro", "প্রো")
            : t("plans.tierPremium", "Premium", "প্রিমিয়াম");
          const per = cycle === "yearly"
            ? t("common.perYear", "/ year", "/ বছর")
            : t("common.perMonth", "/ month", "/ মাস");
          return (
            <div key={cycle} className="card p-5 flex flex-col">
              <h3 className="text-lg font-bold">
                {tierName}{" "}
                <span className="text-sm font-normal text-slate-500">
                  — {cycle === "monthly" ? t("plans.monthlyNote", "Pay every month", "প্রতি মাসে পেমেন্ট") : t("plans.yearlyNote", "Pay once a year", "বছরে একবার পেমেন্ট")}
                </span>
              </h3>
              <ul className="text-sm text-slate-600 mt-3 space-y-1">
                <li>✓ {t("plans.scheduleUnlimited", "Schedule up to 15 posts per day", "দিনে সর্বোচ্চ ১৫টি পোস্ট শিডিউল")}</li>
              </ul>
              <div className="mt-4 space-y-3">
                {[bd, intl].filter(Boolean).map((p) => {
                  const plan = p as SchedulePlan;
                  const isCurrent = schedActive && schedSub?.billingCycle === plan.cycle && schedSub?.currency === plan.currency;
                  return (
                    <div key={plan.slug} className={`flex items-center justify-between gap-3 border rounded-lg px-3 py-2 ${isCurrent ? "ring-2 ring-brand" : ""}`}>
                      <div>
                        <p className="font-bold text-sm">{plan.currency === "USD" ? t("plans.intl", "International", "ইন্টারন্যাশনাল") : t("plans.bangladesh", "Bangladesh", "বাংলাদেশ")}</p>
                        <p className="text-xl font-bold">
                          {schedulePlanPriceText(plan, fmtTaka)}
                          <span className="text-sm font-normal text-slate-500"> {per}</span>
                        </p>
                        {plan.currency === "USD" && (
                          <p className="text-xs text-slate-500">{t("plans.usdWalletNote", "Charged to your wallet in taka at the current dollar rate.", "ওয়ালেট থেকে ডলার রেটে টাকায় কাটা হয়।")}</p>
                        )}
                      </div>
                      <button
                        disabled={isCurrent || !!busy}
                        onClick={() => goCheckout(`model=schedule&plan=${plan.slug}`)}
                        className={`shrink-0 px-4 py-2 rounded-lg text-sm ${isCurrent ? "bg-slate-200 text-slate-500" : "bg-brand text-white hover:bg-brand-dark"} disabled:opacity-50`}
                      >
                        {isCurrent ? t("plans.currentPlan", "Current plan", "বর্তমান প্ল্যান") : t("plans.takeThis", "Take this plan", "এই প্ল্যানটি নিন")}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {schedActive && schedSub?.status !== "cancelled" && (
        <button
          disabled={!!busy}
          onClick={() => {
            if (confirm(t("plans.cancelScheduleConfirm", "Cancel the Post Schedule subscription? It will stay on until the expiry date.", "পোস্ট শিডিউল সাবস্ক্রিপশন বাতিল করবেন? মেয়াদ শেষ পর্যন্ত চালু থাকবে।"))) {
              act("sched-cancel", () => scheduleApi.cancel());
            }
          }}
          className="bg-white border border-red-300 text-red-700 px-4 py-2 rounded-lg disabled:opacity-50 mb-6"
        >
          {busy === "sched-cancel" ? t("plans.cancelling", "Cancelling…", "বাতিল হচ্ছে…") : t("plans.cancelSchedule", "Cancel schedule subscription", "শিডিউল সাবস্ক্রিপশন বাতিল করুন")}
        </button>
      )}

      {/* ---- 2. Reply package ---- */}
      <h2 className="font-bold text-lg mb-2">{t("plans.packageTitle", "2. Reply package — buy AI replies upfront", "২. রিপ্লাই প্যাকেজ — AI রিপ্লাই আগেই কিনে রাখুন")}</h2>
      <p className="text-sm text-slate-600 mb-4">
        {t("plans.packageNote", "Bought replies are used FIRST — before wallet charges.", "কেনা রিপ্লাই আগে খরচ হয় — ওয়ালেট থেকে কাটার আগে।")}
      </p>
      <div className="card p-5 mb-6">
        <p className="text-sm text-slate-600">
          {t("plans.packageLeft", "Replies left in your package:", "প্যাকেজে বাকি রিপ্লাই:")} <b className="text-lg">{fmtNum(replyCredits)}</b>
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
          {PACKAGE_TIERS.map((tier) => (
            <div key={tier.replies} className="border rounded-xl p-4 flex flex-col">
              <h3 className="text-lg font-bold">{t(tier.nameKey, tier.nameFb[0], tier.nameFb[1])}</h3>
              <p className="text-3xl font-bold mt-2">{fmtNum(tier.replies)} <span className="text-base font-normal text-slate-500">{t("plans.replies", "replies", "রিপ্লাই")}</span></p>
              <p className="text-lg font-bold mt-1">{fmtTaka(tier.replies * packagePrice)}</p>
              <button
                onClick={() => goCheckout(`model=package&replies=${tier.replies}`)}
                className="mt-4 bg-brand text-white px-4 py-2 rounded-lg hover:bg-brand-dark"
              >
                {`${t("plans.buy", "Buy", "কিনুন")} ${fmtNum(tier.replies)} — ${fmtTaka(tier.replies * packagePrice)}`}
              </button>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 mt-4">
          <span className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={100000}
              value={customReplies}
              onChange={(e) => setCustomReplies(e.target.value)}
              placeholder={t("plans.customCount", "Other amount", "অন্য সংখ্যা")}
              className="border rounded-lg px-3 py-2 w-32 text-sm"
            />
            <button
              disabled={!customReplies || Number(customReplies) < 1}
              onClick={() => goCheckout(`model=package&replies=${Number(customReplies)}`)}
              className="bg-brand text-white px-4 py-2 rounded-lg hover:bg-brand-dark disabled:opacity-50"
            >
              {t("plans.buy", "Buy", "কিনুন")}
            </button>
          </span>
        </div>
      </div>

      {/* ---- 3. Pay-as-you-go AI credit ---- */}
      <h2 className="font-bold text-lg mb-2">{t("plans.paygTitle", "3. Pay-as-you-go AI credit", "৩. Pay-as-you-go AI ক্রেডিট")}</h2>
      <div className="card p-5 mb-6">
        <p className="text-sm text-slate-600">
          {t("plans.paygNote", "No package left? AI replies use your wallet balance.", "প্যাকেজ শেষ? AI রিপ্লাই আপনার ওয়ালেট ব্যালেন্স থেকে চলবে।")}
        </p>
        <div className="mt-4 border-t pt-4">
          <p className="font-bold">{t("plans.paygTopupTitle", "Top up your wallet", "ওয়ালেটে টাকা জমা করুন")}</p>
          <p className="text-sm text-slate-600 mt-1">
            {t("plans.wallet", "Wallet:", "ওয়ালেট:")} <b>{fmtTaka(wallet)}</b>
            {" — "}{t("plans.paygTopupNote", "Top up with bKash / Nagad / Rocket — approved by hand. The money stays in your account.", "বিকাশ / নগদ / রকেটে টপ-আপ করুন — হাতে অনুমোদন হয়। টাকা আপনার অ্যাকাউন্টেই থাকে।")}
          </p>
          <div className="flex flex-wrap gap-2 mt-3">
            {PAYG_TOPUP_PRESETS.map((n) => (
              <button
                key={n}
                onClick={() => goCheckout(`model=payg&amount=${n}`)}
                className="bg-brand text-white px-4 py-2 rounded-lg hover:bg-brand-dark"
              >
                {t("plans.topupCta", "Top up", "টপ-আপ করুন")} {fmtTaka(n * 100)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <p className="text-xs text-slate-500 mt-6">
        {t("plans.trialNote", "New accounts get a 14-day free trial and ৳50 free credit at signup. The trial's included replies are free; after that, replies use your package first, then pay-as-you-go from the wallet.", "নতুন অ্যাকাউন্টে ১৪ দিনের ফ্রি ট্রায়াল আর সাইনআপে ৳৫০ ফ্রি ক্রেডিট থাকে। ট্রায়ালের অন্তর্ভুক্ত রিপ্লাই ফ্রি; তারপর প্রথমে প্যাকেজ, তারপর ওয়ালেট থেকে pay-as-you-go খরচ কাটে।")}
      </p>
    </div>
  );
}
