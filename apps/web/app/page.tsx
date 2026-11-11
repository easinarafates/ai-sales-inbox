"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getToken } from "@/lib/api";
import { LanguageToggle, useI18n } from "@/lib/i18n";
import Icon, { type IconName } from "@/components/Icon";

// Icons come from components/Icon.tsx — Lucide-style outline SVGs, the
// repo's own icon system (no lucide-react dependency installed). No emoji
// anywhere on this page.
const FEATURES: { icon: IconName; titleKey: string; textKey: string }[] = [
  { icon: "inbox", titleKey: "landing.f1Title", textKey: "landing.f1Text" },
  { icon: "channels", titleKey: "landing.f2Title", textKey: "landing.f2Text" },
  { icon: "orders", titleKey: "landing.f3Title", textKey: "landing.f3Text" },
  { icon: "courier", titleKey: "landing.f4Title", textKey: "landing.f4Text" },
  { icon: "schedule", titleKey: "landing.f5Title", textKey: "landing.f5Text" },
  { icon: "comments", titleKey: "landing.f6Title", textKey: "landing.f6Text" },
  { icon: "customers", titleKey: "landing.f7Title", textKey: "landing.f7Text" },
  { icon: "settings", titleKey: "landing.f8Title", textKey: "landing.f8Text" },
];

const WHO: { icon: IconName; titleKey: string; textKey: string }[] = [
  { icon: "channels", titleKey: "landing.who1Title", textKey: "landing.who1Text" },
  { icon: "posts", titleKey: "landing.who2Title", textKey: "landing.who2Text" },
  { icon: "box", titleKey: "landing.who3Title", textKey: "landing.who3Text" },
];

const HOW: { icon: IconName; num: string; titleKey: string; textKey: string }[] = [
  { icon: "channels", num: "1", titleKey: "landing.how1Title", textKey: "landing.how1Text" },
  { icon: "inbox", num: "2", titleKey: "landing.how2Title", textKey: "landing.how2Text" },
  { icon: "courier", num: "3", titleKey: "landing.how3Title", textKey: "landing.how3Text" },
];

const FAQS: { qKey: string; aKey: string }[] = [
  { qKey: "landing.faq1Q", aKey: "landing.faq1A" },
  { qKey: "landing.faq2Q", aKey: "landing.faq2A" },
  { qKey: "landing.faq3Q", aKey: "landing.faq3A" },
  { qKey: "landing.faq4Q", aKey: "landing.faq4A" },
];

const PLANS = [
  {
    nameKey: "landing.planSchedule",
    price: "৳100",
    periodKey: "common.perMonth",
    lines: ["landing.planScheduleLine1", "landing.planScheduleLine2", "landing.planScheduleLine3"],
    popular: true,
  },
  {
    nameKey: "landing.planPackage",
    price: "৳110",
    periodKey: "landing.planPackagePeriod",
    lines: ["landing.planPackageLine1", "landing.planPackageLine2", "landing.planPackageLine3"],
    popular: false,
  },
  {
    nameKey: "landing.planPayg",
    price: "টপ-আপ",
    periodKey: "landing.planPaygPeriod",
    lines: ["landing.planPaygLine1", "landing.planPaygLine2", "landing.planPaygLine3"],
    popular: false,
  },
] as const;

function SectionHeading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <h2 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">{title}</h2>
      {subtitle ? <p className="mt-2 text-sm leading-relaxed text-slate-500 sm:text-base">{subtitle}</p> : null}
    </div>
  );
}

/**
 * Hero animation — the three core ideas of YEARBITO, cycling automatically
 * (and switchable by tapping a tab). Pure CSS + React state: no video
 * files, no new dependencies. The messages shown are ILLUSTRATION
 * examples, labelled as such below the panel — never real customer data.
 */
const HERO_STAGES = [
  { key: "inbox", labelEn: "One inbox", labelBn: "এক ইনবক্স" },
  { key: "ai", labelEn: "AI replies", labelBn: "AI উত্তর" },
  { key: "sales", labelEn: "Sales automation", labelBn: "সেলস অটোমেশন" },
] as const;

function HeroAnimation() {
  const { t } = useI18n();
  const [stage, setStage] = useState(0);
  // Auto-advance every 5s; the timer restarts after a manual tap too.
  useEffect(() => {
    const id = setInterval(() => setStage((s) => (s + 1) % HERO_STAGES.length), 5000);
    return () => clearInterval(id);
  }, [stage]);

  return (
    <div data-hero-animation="yearbito-hero" className="w-full">
      <div className="overflow-hidden rounded-2xl border border-[#eeeeee] bg-white shadow-xl">
        {/* Window bar */}
        <div className="flex items-center gap-2 border-b border-[#eeeeee] bg-slate-50/60 px-4 py-3">
          <span className="h-3 w-3 rounded-full bg-brand" />
          <span className="h-3 w-3 rounded-full bg-accent" />
          <span className="h-3 w-3 rounded-full bg-ink" />
          <span className="ml-2 text-sm font-bold text-slate-900">YEARBITO</span>
          <span className="ml-auto rounded-full bg-[#EBF1FE] px-2 py-0.5 text-xs font-medium text-brand-dark">
            {t("landing.heroAnimLive", "Live demo", "লাইভ ডেমো")}
          </span>
        </div>

        <div key={stage} data-hero-stage={HERO_STAGES[stage].key} className="min-h-[320px] p-5 sm:min-h-[300px]">
          {stage === 0 && (
            <div>
              <p className="font-bold text-slate-900">
                {t("landing.heroAnimInboxTitle", "Messages from everywhere — in one inbox", "সব জায়গার মেসেজ — এক ইনবক্সে")}
              </p>
              <p className="mt-1 text-sm text-slate-500">
                {t("landing.heroAnimInboxText", "Facebook, Instagram and WhatsApp messages arrive together. One chat per customer — nothing gets missed.", "ফেসবুক, ইনস্টাগ্রাম আর WhatsApp-এর মেসেজ একসাথে আসে। একজন কাস্টমারের জন্য একটাই চ্যাট — কিছু মিস হয় না।")}
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {[
                  { name: "Facebook", cls: "bg-brand text-white" },
                  { name: "Instagram", cls: "bg-accent text-white" },
                  { name: "WhatsApp", cls: "bg-ink text-white" },
                ].map((ch) => (
                  <span key={ch.name} className={`hero-bubble-in rounded-full px-3 py-1.5 text-xs font-bold shadow-sm ${ch.cls}`}>
                    {ch.name}
                  </span>
                ))}
              </div>
              <div className="mt-1 flex justify-center gap-16" aria-hidden="true">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="hero-flow-dot block h-2 w-2 rounded-full bg-brand"
                    style={{ animationDelay: `${i * 0.35}s` }}
                  />
                ))}
              </div>
              <div className="mt-2 rounded-xl border border-[#eeeeee] bg-slate-50/60 p-3">
                {[
                  { name: "কাস্টমার", msg: "দাম কত?", delay: "0.2s" },
                  { name: "কাস্টমার", msg: "ডেলিভারি চার্জ কত?", delay: "0.5s" },
                ].map((c) => (
                  <div key={c.msg} className="hero-bubble-in flex items-center gap-3 border-b border-[#eeeeee] py-2 last:border-0" style={{ animationDelay: c.delay }}>
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand to-accent text-xs font-bold text-white">
                      কা
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-slate-900">{c.name}</span>
                      <span className="block truncate text-xs text-slate-500">{c.msg}</span>
                    </span>
                    <span className="ml-auto shrink-0 text-xs text-slate-400">
                      {t("landing.heroAnimNow", "now", "এখনই")}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {stage === 1 && (
            <div>
              <p className="font-bold text-slate-900">
                {t("landing.heroAnimAiTitle", "The AI answers — even while you sleep", "AI উত্তর দেয় — আপনি ঘুমালেও")}
              </p>
              <p className="mt-1 text-sm text-slate-500">
                {t("landing.heroAnimAiText", "Price, stock and delivery — answered in Bengali, politely as Sir or Madam.", "দাম, স্টক আর ডেলিভারি — বাংলায় উত্তর দেয়, স্যার বা ম্যাডাম বলে সম্মানের সাথে।")}
              </p>
              <div className="mt-5 space-y-3">
                <div className="hero-bubble-in ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-[#EBF1FE] px-4 py-2.5 text-sm text-slate-800">
                  এই পাঞ্জাবিটার দাম কত?
                </div>
                <div className="hero-bubble-in flex w-fit items-center gap-1.5 rounded-2xl rounded-bl-sm border border-[#eeeeee] bg-white px-4 py-3 shadow-sm" style={{ animationDelay: "0.4s" }}>
                  {[0, 1, 2].map((i) => (
                    <span key={i} className="hero-typing-dot block h-2 w-2 rounded-full bg-brand" style={{ animationDelay: `${i * 0.2}s` }} />
                  ))}
                  <span className="ml-1 text-xs text-slate-400">AI লিখছে…</span>
                </div>
                <div className="hero-bubble-in w-fit max-w-[90%] rounded-2xl rounded-bl-sm border border-brand/20 bg-white px-4 py-2.5 text-sm text-slate-800 shadow-sm" style={{ animationDelay: "0.9s" }}>
                  <span className="mb-1 inline-block rounded-full bg-gradient-to-r from-brand to-accent px-2 py-0.5 text-[11px] font-bold text-white">AI</span>
                  <span className="block">স্যার, এটার দাম ৳৮৫০। ঢাকার ভিতরে ডেলিভারি ৳১০০, বাইরে ৳১৩০। অর্ডার করতে আপনার ঠিকানাটা দিন।</span>
                </div>
                <p className="hero-bubble-in flex items-center gap-1.5 text-xs font-medium text-brand-dark" style={{ animationDelay: "1.3s" }}>
                  <Icon name="checkCircle" className="h-4 w-4" />
                  {t("landing.heroAnimAiDone", "AI replied instantly — no waiting for the customer", "AI সাথে সাথে উত্তর দিয়েছে — কাস্টমারকে অপেক্ষা করতে হয়নি")}
                </p>
              </div>
            </div>
          )}

          {stage === 2 && (
            <div>
              <p className="font-bold text-slate-900">
                {t("landing.heroAnimSalesTitle", "Order → invoice → courier, automatically", "অর্ডার → ইনভয়েস → কুরিয়ার, অটোমেটিক")}
              </p>
              <p className="mt-1 text-sm text-slate-500">
                {t("landing.heroAnimSalesText", "When a customer confirms, YEARBITO creates the order, sends the invoice and books the courier.", "কাস্টমার কনফার্ম করলেই YEARBITO অর্ডার তৈরি করে, ইনভয়েস পাঠায় আর কুরিয়ার বুক করে।")}
              </p>
              <div className="mt-5 space-y-4">
                {[
                  { icon: "orders" as IconName, title: "অর্ডার তৈরি হয়েছে", sub: "কাস্টমারের নাম, ঠিকানা আর প্রোডাক্ট — সব সেভ", delay: "0.15s" },
                  { icon: "inbox" as IconName, title: "ইনভয়েস পাঠানো হয়েছে", sub: "কাস্টমারকে ইনভয়েস লিংক আর ছবি দেওয়া হয়েছে", delay: "0.7s" },
                  { icon: "courier" as IconName, title: "কুরিয়ারে বুক হয়েছে", sub: "Steadfast / Pathao — ট্র্যাকিং নম্বরসহ", delay: "1.25s" },
                ].map((s) => (
                  <div key={s.title} className="hero-bubble-in flex items-center gap-3" style={{ animationDelay: s.delay }}>
                    <span className="hero-check-pop flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand to-accent text-white" style={{ animationDelay: s.delay }}>
                      <Icon name={s.icon} className="h-5 w-5" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-bold text-slate-900">{s.title}</span>
                      <span className="block truncate text-xs text-slate-500">{s.sub}</span>
                    </span>
                    <Icon name="checkCircle" className="hero-check-pop ml-auto h-5 w-5 shrink-0 text-brand" />
                  </div>
                ))}
              </div>
              <div className="mt-6 h-2 overflow-hidden rounded-full bg-[#EBF1FE]">
                <div className="hero-progress h-full rounded-full bg-gradient-to-r from-brand to-accent" />
              </div>
              <p className="mt-2 text-center text-xs font-medium text-slate-500">
                {t("landing.heroAnimSalesDone", "No copy-paste, no missed step", "কপি-পেস্ট নেই, কোনো ধাপ মিস হয় না")}
              </p>
            </div>
          )}
        </div>

        {/* Stage tabs */}
        <div className="flex gap-2 border-t border-[#eeeeee] bg-slate-50/60 p-3">
          {HERO_STAGES.map((s, i) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setStage(i)}
              aria-pressed={stage === i}
              className={`flex-1 rounded-lg px-2 py-2 text-xs font-bold transition sm:text-sm ${stage === i ? "bg-brand text-white shadow-sm" : "bg-white text-slate-600 hover:bg-[#EBF1FE]"}`}
            >
              {t(`landing.heroStage${i + 1}`, s.labelEn, s.labelBn)}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-2 text-center text-xs text-slate-400">
        {t("landing.heroAnimCaption", "Example shown — sample messages, not real customer data.", "উদাহরণ দেখানো হচ্ছে — নমুনা মেসেজ, আসল কাস্টমারের ডেটা নয়।")}
      </p>
    </div>
  );
}

export default function LandingPage() {
  const router = useRouter();
  const { t } = useI18n();

  // Logged-in users go straight to the dashboard (inbox); everyone else
  // sees the public landing page. No redirect loop: /inbox never sends
  // anyone back to /. The landing renders immediately (and prerenders
  // fully on the server) — the redirect happens after hydration, so a
  // logged-in user sees at most a brief flash of this page.
  useEffect(() => {
    if (getToken()) router.replace("/inbox");
  }, [router]);

  return (
    <div className="min-h-screen overflow-x-hidden bg-white text-slate-800">
      {/* ---- Top bar ---- */}
      <header className="sticky top-0 z-10 border-b border-[#eeeeee] bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link href="/" className="flex min-w-0 items-center gap-2">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand to-accent text-sm font-bold text-white shadow-sm">
              Y
            </span>
            <span className="truncate font-bold text-slate-900">
              {t("app.name", "YEARBITO", "YEARBITO")}
            </span>
          </Link>
          <nav className="hidden items-center gap-5 text-sm font-medium text-slate-600 md:flex">
            <a href="#features" className="hover:text-brand-dark">
              {t("landing.featuresNav", "Features", "ফিচার")}
            </a>
            <a href="#how" className="hover:text-brand-dark">
              {t("landing.howNav", "How it works", "কীভাবে কাজ করে")}
            </a>
            <a href="#pricing" className="hover:text-brand-dark">
              {t("landing.pricingNav", "Pricing", "দাম")}
            </a>
          </nav>
          <div className="flex shrink-0 items-center gap-2">
            <LanguageToggle />
            <Link
              href="/login"
              className="hidden rounded-lg border border-[#eeeeee] bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-orange-50 sm:inline-flex"
            >
              {t("landing.login", "Log in", "লগইন")}
            </Link>
            <Link href="/signup" className="btn-primary">
              {t("landing.signup", "Sign up", "সাইন আপ")}
            </Link>
          </div>
        </div>
      </header>

      <main>
        {/* ---- Hero: text left, animated demo right (stacks on mobile) ---- */}
        <section className="bg-[#EBF1FE]">
          <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-14 sm:px-6 sm:py-20 lg:grid-cols-2">
            <div className="text-center lg:text-left">
              <p className="inline-block rounded-full bg-white px-4 py-1.5 text-sm font-medium text-slate-700 shadow-sm">
                {t("landing.heroBadge", "Made for Bangladeshi online shops", "বাংলাদেশি অনলাইন শপের জন্য তৈরি")}
              </p>
              <h1 className="mt-5 text-4xl font-bold leading-tight tracking-tight text-slate-900 sm:text-5xl">
                {t(
                  "landing.heroTitle",
                  "Your shop's messages, answered by AI — in one inbox",
                  "আপনার শপের মেসেজের উত্তর দেবে AI — একটাই ইনবক্সে"
                )}
              </h1>
              <p className="mt-3 bg-gradient-to-r from-brand to-accent bg-clip-text text-lg font-bold text-transparent">
                {t("landing.tagline", "Your Ideas, Amplified.", "Your Ideas, Amplified.")}
              </p>
              <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-slate-600 sm:text-lg lg:mx-0">
                {t("landing.heroSubtitle", "", "")}
              </p>
              <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center lg:justify-start">
                <Link href="/signup" className="btn-primary w-full px-6 py-3 text-base sm:w-auto">
                  {t("landing.heroCtaSignup", "Start free — 14-day trial", "ফ্রি শুরু করুন — ১৪ দিনের ট্রায়াল")}
                </Link>
                <Link href="/login" className="btn-ghost w-full px-6 py-3 text-base sm:w-auto">
                  {t("landing.heroCtaLogin", "Log in", "লগইন করুন")}
                </Link>
              </div>
              <ul className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm font-medium text-slate-700 lg:justify-start">
                {[
                  ["landing.heroCheck1", "14-day free trial", "১৪ দিনের ফ্রি ট্রায়াল"],
                  ["landing.heroCheck2", "৳50 free credit", "৳৫০ ফ্রি ক্রেডিট"],
                  ["landing.heroCheck3", "No card needed", "কার্ড লাগবে না"],
                ].map(([key, en, bn]) => (
                  <li key={key} className="flex items-center gap-1.5">
                    <Icon name="checkCircle" className="h-4 w-4 text-brand" />
                    {t(key, en, bn)}
                  </li>
                ))}
              </ul>
              <p className="mt-4 text-sm text-slate-500">
                {t(
                  "landing.heroNote",
                  "New accounts get a 14-day free trial and ৳50 free credit. No card needed to start.",
                  "নতুন অ্যাকাউন্টে ১৪ দিনের ফ্রি ট্রায়াল আর ৳৫০ ফ্রি ক্রেডিট। শুরু করতে কার্ড লাগবে না।"
                )}
              </p>
            </div>
            <HeroAnimation />
          </div>
        </section>

        {/* ---- Who it is for ---- */}
        <section id="who" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-12 sm:px-6 sm:py-16">
          <SectionHeading
            title={t("landing.whoTitle", "Built for Bangladeshi sellers", "বাংলাদেশি বিক্রেতাদের জন্য তৈরি")}
            subtitle={t("landing.whoSubtitle", "If you sell on Facebook or Instagram, this is made for you.", "আপনি ফেসবুক বা ইনস্টাগ্রামে বিক্রি করলে, এটা আপনার জন্যই তৈরি।")}
          />
          <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {WHO.map((w) => (
              <div key={w.titleKey} className="card card-hover p-5">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#EBF1FE] text-brand-dark">
                  <Icon name={w.icon} className="h-6 w-6" />
                </span>
                <h3 className="mt-4 font-bold text-slate-900">{t(w.titleKey, "", "")}</h3>
                <p className="mt-1 text-sm leading-relaxed text-slate-600">{t(w.textKey, "", "")}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ---- Features ---- */}
        <section id="features" className="bg-slate-50/60">
          <div className="mx-auto max-w-6xl scroll-mt-20 px-4 py-12 sm:px-6 sm:py-16">
            <SectionHeading
              title={t("landing.featuresTitle", "Everything your shop needs to sell in chat", "চ্যাটে বিক্রির জন্য যা যা দরকার, সব এক জায়গায়")}
              subtitle={t("landing.featuresSubtitle", "Less copy-paste, fewer missed customers, more orders.", "কপি-পেস্ট কম, মিস হওয়া কাস্টমার কম, অর্ডার বেশি।")}
            />
            <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((f) => (
                <div key={f.titleKey} className="card card-hover p-5">
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#EBF1FE] text-brand-dark">
                    <Icon name={f.icon} className="h-6 w-6" />
                  </span>
                  <h3 className="mt-4 font-bold text-slate-900">{t(f.titleKey, "", "")}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-slate-600">{t(f.textKey, "", "")}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ---- How it works ---- */}
        <section id="how" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-12 sm:px-6 sm:py-16">
          <SectionHeading
            title={t("landing.howTitle", "Start selling in three steps", "তিন ধাপে বিক্রি শুরু করুন")}
          />
          <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-3">
            {HOW.map((s) => (
              <div key={s.titleKey} className="card card-hover p-5">
                <div className="flex items-center justify-between">
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#EBF1FE] text-brand-dark">
                    <Icon name={s.icon} className="h-6 w-6" />
                  </span>
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand text-sm font-bold text-white">
                    {s.num}
                  </span>
                </div>
                <h3 className="mt-4 font-bold text-slate-900">{t(s.titleKey, "", "")}</h3>
                <p className="mt-1 text-sm leading-relaxed text-slate-600">{t(s.textKey, "", "")}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ---- Pricing ---- */}
        <section id="pricing" className="bg-slate-50/60">
          <div className="mx-auto max-w-6xl scroll-mt-20 px-4 py-12 sm:px-6 sm:py-16">
            <SectionHeading
              title={t("landing.pricingTitle", "Simple plans for every shop", "প্রতিটি শপের জন্য সহজ প্ল্যান")}
              subtitle={t("landing.pricingSubtitle", "Start free for 14 days. Upgrade only when your shop grows.", "১৪ দিন ফ্রি ব্যবহার করুন। শপ বড় হলে তখনই আপগ্রেড করুন।")}
            />
            <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-3">
              {PLANS.map((p) => (
                <div
                  key={p.nameKey}
                  className={`card flex flex-col p-5 ${p.popular ? "ring-2 ring-brand" : ""}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="text-xl font-bold text-slate-900">{t(p.nameKey, "", "")}</h3>
                  </div>
                  {p.popular && (
                    <span className="mt-2 self-start rounded-full bg-[#EBF1FE] px-2 py-1 text-xs font-bold text-brand-dark">
                      {t("landing.planPopular", "Most popular", "সবচেয়ে জনপ্রিয়")}
                    </span>
                  )}
                  <p className="mt-3 text-3xl font-bold text-slate-900">
                    {p.price}
                    <span className="text-base font-normal text-slate-500">
                      {" "}
                      {t(p.periodKey, "", "")}
                    </span>
                  </p>
                  <ul className="mt-4 flex-1 space-y-2 text-sm text-slate-600">
                    {p.lines.map((lineKey) => (
                      <li key={lineKey} className="flex items-start gap-2">
                        <Icon name="checkCircle" className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                        {t(lineKey, "", "")}
                      </li>
                    ))}
                  </ul>
                  <Link href="/signup" className="btn-primary mt-5 w-full">
                    {t("landing.planCta", "Start free trial", "ফ্রি ট্রায়াল শুরু করুন")}
                  </Link>
                </div>
              ))}
            </div>
            <p className="mt-6 text-center text-sm text-slate-500">
              {t(
                "landing.trialNote",
                "New accounts get a 14-day free trial and ৳50 free credit. Prices above are the real prices.",
                "নতুন অ্যাকাউন্টে ১৪ দিনের ফ্রি ট্রায়াল আর ৳৫০ ফ্রি ক্রেডিট থাকে। উপরের দামগুলোই আসল দাম।"
              )}
            </p>
          </div>
        </section>

        {/* ---- FAQ ---- */}
        <section id="faq" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-12 sm:px-6 sm:py-16">
          <SectionHeading
            title={t("landing.faqTitle", "Questions sellers ask", "বিক্রেতারা যা জানতে চান")}
            subtitle={t("landing.faqSubtitle", "Straight answers — nothing hidden.", "সোজা উত্তর — কিছু লুকানো নেই।")}
          />
          <div className="mx-auto mt-8 grid max-w-4xl grid-cols-1 gap-4 sm:grid-cols-2">
            {FAQS.map((f) => (
              <div key={f.qKey} className="card p-5">
                <h3 className="flex items-start gap-2 font-bold text-slate-900">
                  <Icon name="help" className="mt-0.5 h-5 w-5 shrink-0 text-brand" />
                  {t(f.qKey, "", "")}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{t(f.aKey, "", "")}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ---- Footer CTA ---- */}
        <section className="bg-[#EBF1FE]">
          <div className="mx-auto max-w-6xl px-4 py-12 text-center sm:px-6 sm:py-16">
            <h2 className="mx-auto max-w-2xl text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
              {t("landing.ctaTitle", "Start answering every customer — even while you sleep", "প্রতিটি কাস্টমারের উত্তর দিন — ঘুমানোর সময়ও")}
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-slate-600 sm:text-base">
              {t("landing.ctaText", "Join with a 14-day free trial and ৳50 free credit. No card needed.", "১৪ দিনের ফ্রি ট্রায়াল আর ৳৫০ ফ্রি ক্রেডিট দিয়ে শুরু করুন। কার্ড লাগবে না।")}
            </p>
            <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link href="/signup" className="btn-primary w-full px-6 py-3 text-base sm:w-auto">
                {t("landing.heroCtaSignup", "Start free — 14-day trial", "ফ্রি শুরু করুন — ১৪ দিনের ট্রায়াল")}
              </Link>
              <Link href="/login" className="btn-ghost w-full px-6 py-3 text-base sm:w-auto">
                {t("landing.heroCtaLogin", "Log in", "লগইন করুন")}
              </Link>
            </div>
          </div>
        </section>
      </main>

      {/* ---- Footer ---- */}
      <footer className="border-t border-[#eeeeee] bg-white">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-6 text-sm text-slate-500 sm:flex-row sm:px-6">
          <p className="text-center sm:text-left">
            {t("landing.footerTagline", "YEARBITO — sell more, reply less.", "YEARBITO — বেশি বিক্রি, কম উত্তর দেওয়া।")}
          </p>
          <nav className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
            <Link href="/about" className="hover:text-brand-dark">
              {t("landing.about", "About", "আমাদের সম্পর্কে")}
            </Link>
            <Link href="/contact" className="hover:text-brand-dark">
              {t("landing.contact", "Contact", "যোগাযোগ")}
            </Link>
            <Link href="/terms" className="hover:text-brand-dark">
              {t("landing.terms", "Terms of Service", "ব্যবহারের শর্ত")}
            </Link>
            <Link href="/privacy" className="hover:text-brand-dark">
              {t("landing.privacy", "Privacy Policy", "প্রাইভেসি পলিসি")}
            </Link>
            <Link href="/refund" className="hover:text-brand-dark">
              {t("landing.refund", "Refund Policy", "রিফান্ড পলিসি")}
            </Link>
            <Link href="/data-deletion" className="hover:text-brand-dark">
              {t("landing.dataDeletion", "Data Deletion", "ডেটা মুছে ফেলা")}
            </Link>
          </nav>
        </div>
        <p className="border-t border-[#eeeeee] py-3 text-center text-xs text-slate-400">
          {t("landing.copyright", "© 2026 YEARBITO — A product of Year Media", "© ২০২৬ YEARBITO — Year Media-র একটি প্রোডাক্ট")}
        </p>
      </footer>
    </div>
  );
}
