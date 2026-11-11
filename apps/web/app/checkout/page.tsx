"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { billingApi, billingPackagePricePaisa, getToken, type Billing } from "@/lib/api";
import { scheduleApi, schedulePlanPriceText, type ScheduleOverview, type SchedulePlan } from "@/lib/subscriptions";
import { topupApi, type CheckoutPurpose, type PaymentNumbers } from "@/lib/topup";
import { useI18n } from "@/lib/i18n";

type Model = "schedule" | "package" | "payg";

const PACKAGE_TIERS = [500, 1000, 2500];
const PAYG_AMOUNTS = [100, 200, 500, 1000]; // taka

type PayMethod = "bkash" | "nagad" | "rocket" | "bank";

const METHOD_ORDER: PayMethod[] = ["bkash", "nagad", "rocket", "bank"];
const METHOD_LABEL: Record<PayMethod, string> = {
  bkash: "bKash",
  nagad: "Nagad",
  rocket: "Rocket",
  bank: "Bank",
};

export default function CheckoutPage() {
  const router = useRouter();
  const { t, fmtTaka } = useI18n();
  const [loading, setLoading] = useState(true);
  const [schedule, setSchedule] = useState<ScheduleOverview | null>(null);
  const [billing, setBilling] = useState<Billing | null>(null);
  const [numbers, setNumbers] = useState<PaymentNumbers | null>(null);
  const [model, setModel] = useState<Model>("schedule");
  const [planSlug, setPlanSlug] = useState("");
  const [replies, setReplies] = useState(500);
  const [paygTaka, setPaygTaka] = useState(100);
  const [method, setMethod] = useState<PayMethod>("bkash");
  const [trxId, setTrxId] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const packagePrice = billing ? billingPackagePricePaisa(billing) : 22;

  const load = useCallback(async () => {
    try {
      const [s, b, n] = await Promise.all([
        scheduleApi.get(),
        billingApi.get(),
        topupApi.paymentNumbers(),
      ]);
      setSchedule(s);
      setBilling(b);
      setNumbers(n.numbers);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("checkout.loadFailed", "Could not load the payment page.", "পেমেন্ট পেজ লোড করা যায়নি।"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!getToken()) { router.push("/login"); return; }
    load();
  }, [load, router]);

  // Deep-link: /checkout?model=schedule&plan=schedule-monthly-bdt
  // (or model=package&replies=500, model=payg&amount=100).
  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search);
      const m = q.get("model");
      if (m === "schedule" || m === "package" || m === "payg") setModel(m);
      const plan = q.get("plan");
      if (plan) setPlanSlug(plan);
      const r = Number(q.get("replies"));
      if (Number.isInteger(r) && r > 0) setReplies(r);
      const a = Number(q.get("amount"));
      if (Number.isInteger(a) && a > 0) setPaygTaka(a);
    } catch { /* ignore */ }
  }, []);

  const plans = useMemo(() => schedule?.plans ?? [], [schedule]);

  useEffect(() => {
    if (model === "schedule" && !planSlug && plans.length > 0) {
      setPlanSlug(plans[0].slug);
    }
  }, [model, planSlug, plans]);

  const selectedPlan: SchedulePlan | undefined = plans.find((p) => p.slug === planSlug);

  const amountPaisa = useMemo(() => {
    if (model === "schedule") return selectedPlan ? Number(selectedPlan.pricePaisa ?? 0) : 0;
    if (model === "package") return replies * packagePrice;
    return paygTaka * 100;
  }, [model, selectedPlan, replies, packagePrice, paygTaka]);

  const purpose: CheckoutPurpose | null = useMemo(() => {
    if (model === "schedule" && selectedPlan) return { kind: "schedule", slug: selectedPlan.slug };
    if (model === "package") return { kind: "package", replies };
    if (model === "payg") return { kind: "payg" };
    return null;
  }, [model, selectedPlan, replies]);

  const selectedNumber = numbers?.[method] ?? null;

  const submit = async () => {
    setError("");
    if (!purpose || amountPaisa <= 0) {
      setError(t("checkout.pickFirst", "Pick a package first.", "আগে একটি প্যাকেজ বাছুন।"));
      return;
    }
    if (!selectedNumber) {
      setError(t("checkout.noNumber", "This payment number is not set yet — pick another method.", "এই পেমেন্ট নম্বর এখনো দেওয়া হয়নি — অন্য মাধ্যম বাছুন।"));
      return;
    }
    if (!trxId.trim()) {
      setError(t("checkout.trxNeeded", "Enter the transaction ID (TrxID) from your Send Money.", "Send Money-এর লেনদেন আইডি (TrxID) দিন।"));
      return;
    }
    setBusy(true);
    try {
      await topupApi.request({ amountPaisa, method, transactionId: trxId.trim(), purpose });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("checkout.submitFailed", "Could not submit the payment.", "পেমেন্ট জমা দেওয়া যায়নি।"));
    } finally {
      setBusy(false);
    }
  };

  const copyNumber = async () => {
    if (!selectedNumber) return;
    try {
      await navigator.clipboard.writeText(selectedNumber.number);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable */ }
  };

  if (loading) return (
    <div className="space-y-3">
      <div className="skeleton h-8 w-48" />
      <div className="skeleton h-24" />
    </div>
  );

  if (done) return (
    <div className="card p-6 text-center">
      <p className="text-2xl">✓</p>
      <h1 className="page-title mt-2">{t("checkout.sentTitle", "Payment submitted", "পেমেন্ট জমা হয়েছে")}</h1>
      <p className="text-sm text-slate-600 mt-2">
        {t("checkout.sentNote", "The owner will check your TrxID and approve it. Your package starts right after approval.", "মালিক আপনার TrxID যাচাই করে অনুমোদন দেবেন। অনুমোদনের পরপরই আপনার প্যাকেজ চালু হবে।")}
      </p>
      <p className="text-sm text-slate-600 mt-1">
        {t("checkout.sentAmount", "Amount:", "টাকা:")} <b>{fmtTaka(amountPaisa)}</b>
        {" • "}{t("checkout.sentTrx", "TrxID:", "TrxID:")} <b>{trxId}</b>
      </p>
      <Link href="/billing" className="inline-block mt-4 bg-brand text-white px-4 py-2 rounded-lg hover:bg-brand-dark">
        {t("checkout.viewBilling", "See my Billing", "আমার বিলিং দেখুন")}
      </Link>
    </div>
  );

  const modelCard = (m: Model, title: string, sub: string) => (
    <button
      key={m}
      onClick={() => setModel(m)}
      className={`card p-4 text-left ${model === m ? "ring-2 ring-brand" : ""}`}
    >
      <p className="font-bold">{title}</p>
      <p className="text-xs text-slate-500 mt-1">{sub}</p>
    </button>
  );

  return (
    <div>
      <h1 className="page-title">{t("checkout.title", "Pay", "পেমেন্ট")}</h1>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}

      <h2 className="font-bold mb-2">{t("checkout.pickModel", "1. What do you want?", "১. কী নিতে চান?")}</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
        {modelCard("schedule", t("checkout.modelSchedule", "Post Schedule subscription", "পোস্ট শিডিউল সাবস্ক্রিপশন"), t("checkout.modelScheduleSub", "Schedule posts automatically", "পোস্ট নিজে নিজে শিডিউল হবে"))}
        {modelCard("package", t("checkout.modelPackage", "AI Reply package", "AI রিপ্লাই প্যাকেজ"), t("checkout.modelPackageSub", "Buy AI replies upfront", "আগেই AI রিপ্লাই কিনে রাখুন"))}
        {modelCard("payg", t("checkout.modelPayg", "Pay-as-you-go AI credit", "Pay-as-you-go AI ক্রেডিট"), t("checkout.modelPaygSub", "Top up your wallet", "ওয়ালেটে টাকা জমা করুন"))}
      </div>

      <h2 className="font-bold mb-2">{t("checkout.pickPackage", "2. Pick a package", "২. প্যাকেজ বাছুন")}</h2>
      {model === "schedule" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
          {plans.map((p) => (
            <button key={p.slug} onClick={() => setPlanSlug(p.slug)} className={`card p-4 text-left ${planSlug === p.slug ? "ring-2 ring-brand" : ""}`}>
              <p className="font-bold">{p.currency === "USD" ? t("plans.intl", "International", "ইন্টারন্যাশনাল") : t("plans.bangladesh", "Bangladesh", "বাংলাদেশ")}{" — "}{p.cycle === "yearly" ? t("plans.tierPremium", "Premium", "প্রিমিয়াম") : t("plans.tierPro", "Pro", "প্রো")}</p>
              <p className="text-2xl font-bold mt-1">{schedulePlanPriceText(p, fmtTaka)}</p>
            </button>
          ))}
        </div>
      )}
      {model === "package" && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
          {PACKAGE_TIERS.map((n) => (
            <button key={n} onClick={() => setReplies(n)} className={`card p-4 text-left ${replies === n ? "ring-2 ring-brand" : ""}`}>
              <p className="font-bold">{n === 500 ? t("plans.tierPro", "Pro", "প্রো") : n === 1000 ? t("plans.tierPremium", "Premium", "প্রিমিয়াম") : t("plans.tierBusiness", "Business", "বিজনেস")}</p>
              <p className="text-2xl font-bold mt-1">{fmtTaka(n * packagePrice)}</p>
              <p className="text-sm text-slate-500">{n} {t("plans.replies", "replies", "রিপ্লাই")}</p>
            </button>
          ))}
        </div>
      )}
      {model === "payg" && (
        <div className="flex flex-wrap gap-2 mb-6">
          {PAYG_AMOUNTS.map((n) => (
            <button key={n} onClick={() => setPaygTaka(n)} className={`px-4 py-2 rounded-lg border ${paygTaka === n ? "bg-brand text-white border-brand" : "border-slate-300 bg-white"}`}>
              {fmtTaka(n * 100)}
            </button>
          ))}
        </div>
      )}

      <div className="card p-5 mb-6">
        <p className="text-sm text-slate-500">{t("checkout.amount", "Amount to pay", "যে টাকা দিতে হবে")}</p>
        <p className="text-3xl font-bold">{fmtTaka(amountPaisa)}</p>
      </div>

      <h2 className="font-bold mb-2">{t("checkout.payHow", "3. Send money, then enter the TrxID", "৩. টাকা পাঠান, তারপর TrxID দিন")}</h2>
      <div className="card p-5 mb-6">
        <div className="flex flex-wrap gap-2 mb-4">
          {METHOD_ORDER.map((m) => {
            const hasNumber = !!numbers?.[m];
            return (
              <button
                key={m}
                disabled={!hasNumber}
                onClick={() => setMethod(m)}
                className={`px-4 py-2 rounded-lg border ${method === m ? "bg-brand text-white border-brand" : "border-slate-300 bg-white"} disabled:opacity-40`}
              >
                {METHOD_LABEL[m]}{!hasNumber ? ` (${t("checkout.notSet", "not set", "দেওয়া হয়নি")})` : ""}
              </button>
            );
          })}
        </div>
        {selectedNumber ? (
          <div className="border rounded-lg p-4">
            <p className="text-sm text-slate-500">{t("checkout.sendTo", "Send to this number (Send Money)", "এই নম্বরে টাকা পাঠান (Send Money)")}</p>
            <p className="text-2xl font-bold mt-1">{selectedNumber.number}</p>
            <p className="text-sm text-slate-600 mt-1">{selectedNumber.accountHolder}{selectedNumber.bankName ? ` • ${selectedNumber.bankName}` : ""}{selectedNumber.branch ? ` • ${selectedNumber.branch}` : ""}</p>
            <button onClick={copyNumber} className="mt-2 text-sm text-brand underline">{copied ? t("checkout.copied", "Copied!", "কপি হয়েছে!") : t("checkout.copy", "Copy number", "নম্বর কপি করুন")}</button>
          </div>
        ) : (
          <p className="text-sm text-amber-700 bg-amber-50 border border-amber-300 rounded-lg p-3">
            {t("checkout.noNumbers", "Payment numbers are not set yet. Please ask the owner to add the bKash / Nagad / Rocket numbers.", "পেমেন্ট নম্বর এখনো দেওয়া হয়নি। মালিককে বলুন বিকাশ / নগদ / রকেট নম্বর দিতে।")}
          </p>
        )}
        <div className="mt-4">
          <label className="text-sm font-bold block mb-1">{t("checkout.trxLabel", "Transaction ID (TrxID)", "লেনদেন আইডি (TrxID)")}</label>
          <input
            value={trxId}
            onChange={(e) => setTrxId(e.target.value)}
            placeholder={t("checkout.trxPh", "e.g. 9HX7K2L4M5", "যেমন 9HX7K2L4M5")}
            className="border rounded-lg px-3 py-2 w-full max-w-sm text-sm"
          />
        </div>
        <button
          disabled={busy || !selectedNumber || !trxId.trim()}
          onClick={submit}
          className="mt-4 bg-brand text-white px-5 py-2 rounded-lg hover:bg-brand-dark disabled:opacity-50"
        >
          {busy ? t("checkout.submitting", "Submitting…", "জমা হচ্ছে…") : t("checkout.submit", "Submit payment", "পেমেন্ট জমা দিন")}
        </button>
      </div>
    </div>
  );
}
