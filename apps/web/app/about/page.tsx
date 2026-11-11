import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "About — YEARBITO",
  description:
    "About YEARBITO — an AI sales assistant inbox for Bangladeshi Facebook, Instagram, WhatsApp, TikTok and YouTube sellers, operated by Year Media.",
};

export default function AboutPage() {
  return (
    <main className="min-h-screen bg-white text-slate-800">
      <div className="max-w-3xl mx-auto px-5 py-10">
        <p className="text-sm font-semibold tracking-wide text-[#0051F6] uppercase">
          YEARBITO
        </p>
        <h1 className="text-3xl font-bold mt-2">About YEARBITO</h1>
        <p className="text-sm text-slate-500 mt-2">
          Made for online sellers in Bangladesh · Operated by Year Media
        </p>

        <div className="mt-6 rounded-2xl border border-orange-200 bg-[#EBF1FE] p-5">
          <p className="font-semibold text-slate-800">সংক্ষেপে (বাংলায়)</p>
          <p className="mt-1 leading-relaxed text-slate-700">
            YEARBITO বাংলাদেশি অনলাইন দোকানদারদের জন্য — ফেসবুক,
            ইনস্টাগ্রাম, WhatsApp, TikTok আর YouTube-এর মেসেজ এক জায়গায়
            আসে, AI আপনার প্রোডাক্টের আসল দাম আর স্টক দেখে কাস্টমারকে
            বাংলায় উত্তর দেয়, অর্ডার নেয়, আর Steadfast / Pathao দিয়ে
            কুরিয়ার বুক করে। নতুন অ্যাকাউন্টে ১৪ দিনের ফ্রি ট্রায়াল আর
            ৳৫০ ফ্রি ক্রেডিট থাকে। যোগাযোগ: info.yearmedia@gmail.com
          </p>
        </div>

        <div className="mt-8 space-y-8 bg-white rounded-2xl border border-orange-100 shadow-sm p-6 sm:p-8">
          <section>
            <h2 className="text-xl font-bold">What it is</h2>
            <p className="mt-2 leading-relaxed">
              YEARBITO is a sales inbox for Bangladeshi online shops
              that sell on Facebook, Instagram, WhatsApp, TikTok and YouTube.
              Instead of answering the same &ldquo;price?&rdquo; message fifty
              times a day, the shop connects its Pages and channels and lets
              an AI assistant answer customers from the shop&rsquo;s own
              product list — with the real price and stock, in Bengali or
              English — while the seller keeps full control and can step in at
              any time.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">Who it is for</h2>
            <p className="mt-2 leading-relaxed">
              Small and growing online shops in Bangladesh that take orders
              through chat — clothing, cosmetics, food, electronics, and any
              shop where customers ask first and buy in chat. If your
              customers message you on Messenger, Instagram, WhatsApp, TikTok
              or YouTube, this inbox brings all of it into one place.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">How it works</h2>
            <ol className="list-decimal pl-6 mt-2 space-y-1 leading-relaxed">
              <li>
                <strong>Connect your channels</strong> — your Facebook Page,
                Instagram account, WhatsApp Business number, TikTok account
                and YouTube channel, from the Channels page.
              </li>
              <li>
                <strong>Add your products</strong> — names, prices, photos
                and stock. The AI only answers from this list, so it never
                invents a price.
              </li>
              <li>
                <strong>Let the AI reply</strong> — it answers customers,
                shows product cards, applies coupons and takes orders. You can
                turn it off for any chat and answer yourself, and you confirm
                every order before delivery.
              </li>
            </ol>
          </section>

          <section>
            <h2 className="text-xl font-bold">What it does</h2>
            <ul className="list-disc pl-6 mt-2 space-y-1 leading-relaxed">
              <li>
                One inbox for Facebook Page messages, Instagram DMs, WhatsApp
                messages, TikTok messages and YouTube comments.
              </li>
              <li>
                AI replies that use only the prices and stock you entered —
                never invented prices.
              </li>
              <li>
                Orders, customers, coupons, and stock in one dashboard.
              </li>
              <li>
                Courier booking with Steadfast and Pathao (delivery ৳100
                inside Dhaka, ৳130 outside Dhaka), with delivery tracking
                and customer updates.
              </li>
              <li>
                Scheduled posts — Facebook, Instagram, YouTube and TikTok
                videos — with an AI caption helper.
              </li>
              <li>
                Comments on your Facebook, YouTube and TikTok posts, with
                replies from the same page.
              </li>
              <li>
                Plans and credit: every new account starts with a 14-day
                free trial and ৳50 free credit. Plans include a set number
                of AI replies per month (Small 500, Medium 2,000, Large
                8,000), and you can see the cost of every reply on the
                Billing page.
              </li>
              <li>
                Teach the AI your own answers, save replies, and hand any chat
                to a human with one tap.
              </li>
            </ul>
            <p className="mt-2 leading-relaxed">
              Some channels need approval from Meta, Google or TikTok before
              they can connect — the Channels page shows the status of each
              channel, and the dashboard tells you honestly what is connected
              and what is still waiting for approval.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">Pricing</h2>
            <ul className="list-disc pl-6 mt-2 space-y-1 leading-relaxed">
              <li>
                <strong>Post Schedule subscription:</strong> 1 scheduled
                post per day is free. More: ৳100/month or ৳1,000/year in
                Bangladesh; $1/month or $10/year internationally.
              </li>
              <li>
                <strong>AI credit (pay-as-you-go):</strong> AI replies
                use your wallet balance.
              </li>
              <li>
                <strong>Reply package:</strong> bought upfront
                (for example ৳110 for 500 replies) and used first.
              </li>
            </ul>
            <p className="mt-2 leading-relaxed">
              Every new account starts with a 14-day free trial and ৳50 free
              credit. No card is needed to start. See the{" "}
              <Link className="text-[#0051F6] underline" href="/terms">
                Terms of Service
              </Link>{" "}
              for the full pricing terms.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">Who we are</h2>
            <p className="mt-2 leading-relaxed">
              YEARBITO is operated by Year Media, a Bangladeshi team
              building tools for online sellers. We run the service, answer
              support questions, and keep improving it from what sellers tell
              us. Email us at{" "}
              <a
                className="text-[#0051F6] underline"
                href="mailto:info.yearmedia@gmail.com"
              >
                info.yearmedia@gmail.com
              </a>
              . Read the{" "}
              <Link className="text-[#0051F6] underline" href="/terms">
                Terms of Service
              </Link>{" "}
              and{" "}
              <Link className="text-[#0051F6] underline" href="/privacy">
                Privacy Policy
              </Link>
              , or{" "}
              <Link className="text-[#0051F6] underline" href="/contact">
                contact us
              </Link>
              .
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">Get started</h2>
            <p className="mt-2 leading-relaxed">
              <Link className="text-[#0051F6] underline" href="/signup">
                Sign up free
              </Link>{" "}
              — 14-day free trial and ৳50 free credit, no card needed.
            </p>
          </section>
        </div>

        <p className="text-center text-sm text-slate-500 mt-8">
          <Link className="text-[#0051F6] underline" href="/login">
            Back to YEARBITO
          </Link>
        </p>
      </div>
    </main>
  );
}
