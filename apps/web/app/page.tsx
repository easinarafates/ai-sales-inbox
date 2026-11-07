"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getToken } from "@/lib/api";
import { LanguageToggle, useI18n } from "@/lib/i18n";

const FEATURES = [
  { icon: "🤖", titleKey: "landing.f1Title", textKey: "landing.f1Text" },
  { icon: "💬", titleKey: "landing.f2Title", textKey: "landing.f2Text" },
  { icon: "🛒", titleKey: "landing.f3Title", textKey: "landing.f3Text" },
  { icon: "🔗", titleKey: "landing.f4Title", textKey: "landing.f4Text" },
  { icon: "🗓️", titleKey: "landing.f5Title", textKey: "landing.f5Text" },
  { icon: "📊", titleKey: "landing.f6Title", textKey: "landing.f6Text" },
] as const;

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
    <div className="min-h-screen bg-[#FFF1EA] text-slate-800">
      {/* ---- Top bar ---- */}
      <header className="sticky top-0 z-10 border-b border-orange-100 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link href="/" className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand text-sm font-bold text-white shadow-sm">
              AI
            </span>
            <span className="font-bold text-slate-900">
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
          <div className="flex items-center gap-2">
            <LanguageToggle />
            <Link
              href="/login"
              className="hidden rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-orange-50 sm:inline-flex"
            >
              {t("landing.login", "Log in", "লগইন")}
            </Link>
            <Link href="/signup" className="btn-primary">
              {t("landing.signup", "Sign up", "সাইন আপ")}
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 sm:px-6">
        {/* ---- Hero ---- */}
        <section className="py-14 text-center sm:py-20">
          <p className="mx-auto inline-block rounded-full bg-green-50 px-4 py-1.5 text-sm font-medium text-green-700">
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
            {t(
              "landing.heroSubtitle",
              "AI Sales Inbox brings your Facebook Page messages and Instagram DMs into one place. The AI replies to customers, shows your products, and takes orders — even while you sleep. WhatsApp is coming soon.",
              "AI সেলস ইনবক্স আপনার ফেসবুক পেজের মেসেজ আর ইনস্টাগ্রাম DM এক জায়গায় নিয়ে আসে। AI কাস্টমারের উত্তর দেয়, প্রোডাক্ট দেখায়, অর্ডার নেয় — আপনি ঘুমালেও। WhatsApp শীঘ্রই আসছে।"
            )}
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link href="/signup" className="btn-primary px-6 py-3 text-base">
              {t("landing.heroCtaSignup", "Start free — 14-day trial", "ফ্রি শুরু করুন — ১৪ দিনের ট্রায়াল")}
            </Link>
            <Link href="/login" className="btn-ghost px-6 py-3 text-base">
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
        </section>

        {/* ---- Features ---- */}
        <section id="features" className="scroll-mt-20 py-10">
          <h2 className="text-center text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            {t("landing.featuresTitle", "Everything your shop needs to sell in chat", "চ্যাটে বিক্রির জন্য যা যা দরকার, সব এক জায়গায়")}
          </h2>
          <p className="mt-2 text-center text-sm text-slate-500 sm:text-base">
            {t("landing.featuresSubtitle", "Less copy-paste, fewer missed customers, more orders.", "কপি-পেস্ট কম, মিস হওয়া কাস্টমার কম, অর্ডার বেশি।")}
          </p>
          <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <div key={f.titleKey} className="card card-hover p-5">
                <p className="text-2xl" aria-hidden="true">
                  {f.icon}
                </p>
                <h3 className="mt-3 font-bold text-slate-900">{t(f.titleKey, "", "")}</h3>
                <p className="mt-1 text-sm leading-relaxed text-slate-600">{t(f.textKey, "", "")}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ---- How it works ---- */}
        <section id="how" className="scroll-mt-20 py-10">
          <h2 className="text-center text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            {t("landing.howTitle", "Start selling in three steps", "তিন ধাপে বিক্রি শুরু করুন")}
          </h2>
          <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-3">
            {(
              [
                { titleKey: "landing.how1Title", textKey: "landing.how1Text" },
                { titleKey: "landing.how2Title", textKey: "landing.how2Text" },
                { titleKey: "landing.how3Title", textKey: "landing.how3Text" },
              ] as const
            ).map((s) => (
              <div key={s.titleKey} className="card p-5">
                <h3 className="font-bold text-slate-900">{t(s.titleKey, "", "")}</h3>
                <p className="mt-1 text-sm leading-relaxed text-slate-600">{t(s.textKey, "", "")}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ---- Pricing ---- */}
        <section id="pricing" className="scroll-mt-20 py-10">
          <h2 className="text-center text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            {t("landing.pricingTitle", "Simple plans for every shop", "প্রতিটি শপের জন্য সহজ প্ল্যান")}
          </h2>
          <p className="mt-2 text-center text-sm text-slate-500 sm:text-base">
            {t("landing.pricingSubtitle", "Start free for 14 days. Upgrade only when your shop grows.", "১৪ দিন ফ্রি ব্যবহার করুন। শপ বড় হলে তখনই আপগ্রেড করুন।")}
          </p>
          <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-3">
            {PLANS.map((p) => (
              <div
                key={p.nameKey}
                className={`card flex flex-col p-5 ${p.popular ? "ring-2 ring-brand" : ""}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-xl font-bold text-slate-900">{t(p.nameKey, "", "")}</h3>
                  <span className="rounded-full bg-amber-100 px-2 py-1 text-xs font-medium text-amber-800">
                    {t("landing.pricingSuggested", "Suggested price", "প্রস্তাবিত দাম")}
                  </span>
                </div>
                {p.popular && (
                  <span className="mt-2 self-start rounded-full bg-green-100 px-2 py-1 text-xs font-medium text-green-800">
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
                  <li>✓ {t(p.repliesKey, "", "")}</li>
                  <li>✓ {t(p.channelsKey, "", "")}</li>
                  <li>✓ {t("landing.planOverage", "Extra replies cost 10 paisa each", "অতিরিক্ত রিপ্লাই ১০ পয়সা করে")}</li>
                </ul>
                <Link href="/signup" className="btn-primary mt-5 w-full">
                  {t("landing.planCta", "Start free trial", "ফ্রি ট্রায়াল শুরু করুন")}
                </Link>
              </div>
            ))}
          </div>
          <p className="mt-6 text-center text-xs text-slate-500">
            {t(
              "landing.trialNote",
              "New accounts get a 14-day free trial (small plan) and ৳50 free credit. Prices above are suggested prices — not final prices.",
              "নতুন অ্যাকাউন্টে ১৪ দিনের ফ্রি ট্রায়াল (ছোট প্ল্যান) আর ৳৫০ ফ্রি ক্রেডিট থাকে। উপরের দামগুলো প্রস্তাবিত দাম — চূড়ান্ত দাম নয়।"
            )}
          </p>
        </section>
      </main>

      {/* ---- Footer ---- */}
      <footer className="border-t border-orange-100 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-4 py-6 text-sm text-slate-500 sm:flex-row sm:px-6">
          <p>
            {t("landing.footerTagline", "AI Sales Inbox — sell more, reply less.", "AI সেলস ইনবক্স — বেশি বিক্রি, কম উত্তর দেওয়া।")}
          </p>
          <div className="flex items-center gap-4">
            <Link href="/login" className="text-green-700 underline hover:text-green-800">
              {t("landing.login", "Log in", "লগইন")}
            </Link>
            <Link href="/signup" className="text-green-700 underline hover:text-green-800">
              {t("landing.signup", "Sign up", "সাইন আপ")}
            </Link>
            <Link href="/privacy" className="text-green-700 underline hover:text-green-800">
              {t("landing.privacy", "Privacy Policy", "প্রাইভেসি পলিসি")}
            </Link>
            <Link href="/terms" className="text-green-700 underline hover:text-green-800">
              {t("landing.terms", "Terms of Service", "ব্যবহারের শর্ত")}
            </Link>
            <Link href="/about" className="text-green-700 underline hover:text-green-800">
              {t("landing.about", "About", "আমাদের সম্পর্কে")}
            </Link>
            <Link href="/contact" className="text-green-700 underline hover:text-green-800">
              {t("landing.contact", "Contact", "যোগাযোগ")}
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
