"use client";
import { useEffect } from "react";
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
    nameKey: "landing.planSmall",
    price: "৳499",
    repliesKey: "landing.planReplies500",
    channelsKey: "landing.planChannels1",
    popular: false,
  },
  {
    nameKey: "landing.planMedium",
    price: "৳999",
    repliesKey: "landing.planReplies2000",
    channelsKey: "landing.planChannels3",
    popular: true,
  },
  {
    nameKey: "landing.planLarge",
    price: "৳1999",
    repliesKey: "landing.planReplies8000",
    channelsKey: "landing.planChannelsUnlimited",
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
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand text-sm font-bold text-white shadow-sm">
              AI
            </span>
            <span className="truncate font-bold text-slate-900">
              {t("app.name", "AI Sales Inbox", "AI সেলস ইনবক্স")}
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
        {/* ---- Hero ---- */}
        <section className="bg-[#FFF1EA]">
          <div className="mx-auto max-w-6xl px-4 py-14 text-center sm:px-6 sm:py-20">
            <p className="mx-auto inline-block rounded-full bg-white px-4 py-1.5 text-sm font-medium text-slate-700 shadow-sm">
              {t("landing.heroBadge", "Made for Bangladeshi online shops", "বাংলাদেশি অনলাইন শপের জন্য তৈরি")}
            </p>
            <h1 className="mx-auto mt-5 max-w-3xl text-4xl font-bold leading-tight tracking-tight text-slate-900 sm:text-5xl">
              {t(
                "landing.heroTitle",
                "Your shop's messages, answered by AI — in one inbox",
                "আপনার শপের মেসেজের উত্তর দেবে AI — একটাই ইনবক্সে"
              )}
            </h1>
            <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-slate-600 sm:text-lg">
              {t("landing.heroSubtitle", "", "")}
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link href="/signup" className="btn-primary w-full px-6 py-3 text-base sm:w-auto">
                {t("landing.heroCtaSignup", "Start free — 14-day trial", "ফ্রি শুরু করুন — ১৪ দিনের ট্রায়াল")}
              </Link>
              <Link href="/login" className="btn-ghost w-full px-6 py-3 text-base sm:w-auto">
                {t("landing.heroCtaLogin", "Log in", "লগইন করুন")}
              </Link>
            </div>
            <p className="mt-4 text-sm text-slate-500">
              {t(
                "landing.heroNote",
                "New accounts get a 14-day free trial and ৳50 free credit. No card needed to start.",
                "নতুন অ্যাকাউন্টে ১৪ দিনের ফ্রি ট্রায়াল আর ৳৫০ ফ্রি ক্রেডিট। শুরু করতে কার্ড লাগবে না।"
              )}
            </p>
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
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#FFF1EA] text-brand-dark">
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
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#FFF1EA] text-brand-dark">
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
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#FFF1EA] text-brand-dark">
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
                    <span className="rounded-full bg-orange-50 px-2 py-1 text-xs font-medium text-slate-500">
                      {t("landing.pricingSuggested", "Suggested price", "প্রস্তাবিত দাম")}
                    </span>
                  </div>
                  {p.popular && (
                    <span className="mt-2 self-start rounded-full bg-[#FFF1EA] px-2 py-1 text-xs font-bold text-brand-dark">
                      {t("landing.planPopular", "Most popular", "সবচেয়ে জনপ্রিয়")}
                    </span>
                  )}
                  <p className="mt-3 text-3xl font-bold text-slate-900">
                    {p.price}
                    <span className="text-base font-normal text-slate-500">
                      {" "}
                      {t("common.perMonth", "/ month", "/ মাস")}
                    </span>
                  </p>
                  <ul className="mt-4 flex-1 space-y-2 text-sm text-slate-600">
                    <li className="flex items-start gap-2">
                      <Icon name="checkCircle" className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                      {t(p.repliesKey, "", "")}
                    </li>
                    <li className="flex items-start gap-2">
                      <Icon name="checkCircle" className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                      {t(p.channelsKey, "", "")}
                    </li>
                    <li className="flex items-start gap-2">
                      <Icon name="checkCircle" className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                      {t("landing.planOverage", "Extra replies cost 10 paisa each", "অতিরিক্ত রিপ্লাই ১০ পয়সা করে")}
                    </li>
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
                "New accounts get a 14-day free trial (small plan) and ৳50 free credit. Prices above are suggested prices — not final prices.",
                "নতুন অ্যাকাউন্টে ১৪ দিনের ফ্রি ট্রায়াল (ছোট প্ল্যান) আর ৳৫০ ফ্রি ক্রেডিট থাকে। উপরের দামগুলো প্রস্তাবিত দাম — চূড়ান্ত দাম নয়।"
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
        <section className="bg-[#FFF1EA]">
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
            {t("landing.footerTagline", "AI Sales Inbox — sell more, reply less.", "AI সেলস ইনবক্স — বেশি বিক্রি, কম উত্তর দেওয়া।")}
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
            <Link href="/data-deletion" className="hover:text-brand-dark">
              {t("landing.dataDeletion", "Data Deletion", "ডেটা মুছে ফেলা")}
            </Link>
          </nav>
        </div>
        <p className="border-t border-[#eeeeee] py-3 text-center text-xs text-slate-400">
          {t("landing.copyright", "© 2026 AI Sales Inbox", "© ২০২৬ AI সেলস ইনবক্স")}
        </p>
      </footer>
    </div>
  );
}
