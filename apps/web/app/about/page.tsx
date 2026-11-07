import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "About — AI Sales Inbox",
  description:
    "About AI Sales Inbox — an AI sales assistant inbox for Bangladeshi Facebook and Instagram sellers.",
};

export default function AboutPage() {
  return (
    <main className="min-h-screen bg-[#fff8f3] text-slate-800">
      <div className="max-w-3xl mx-auto px-5 py-10">
        <p className="text-sm font-semibold tracking-wide text-[#ff6a4d] uppercase">
          AI Sales Inbox
        </p>
        <h1 className="text-3xl font-bold mt-2">About AI Sales Inbox</h1>
        <p className="text-sm text-slate-500 mt-2">
          Made for online sellers in Bangladesh.
        </p>

        <div className="mt-8 space-y-8 bg-white rounded-2xl border border-orange-100 shadow-sm p-6 sm:p-8">
          <section>
            <h2 className="text-xl font-bold">What it is</h2>
            <p className="mt-2 leading-relaxed">
              AI Sales Inbox is a sales inbox for Bangladeshi online shops
              that sell on Facebook and Instagram. Instead of answering the
              same &ldquo;price?&rdquo; message fifty times a day, the shop
              connects its Facebook Page and lets an AI assistant answer
              customers from the shop&rsquo;s own product list — with the real
              price and stock, in Bengali or English — while the seller keeps
              full control and can step in at any time.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">What it does</h2>
            <ul className="list-disc pl-6 mt-2 space-y-1 leading-relaxed">
              <li>One inbox for Facebook Page messages and Instagram DMs.</li>
              <li>
                AI replies that use only the prices and stock you entered —
                never invented prices.
              </li>
              <li>
                Orders, customers, coupons, and stock in one dashboard.
              </li>
              <li>
                Scheduled Facebook posts (text, photo, and video) with an AI
                caption helper.
              </li>
              <li>
                A wallet: new accounts get ৳50 free credit, and each AI reply
                deducts its real cost — you can see the cost of every reply
                on the Billing page.
              </li>
              <li>
                Teach the AI your own answers, save replies, and hand any chat
                to a human with one tap.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold">What it does not do (yet)</h2>
            <p className="mt-2 leading-relaxed">
              WhatsApp and TikTok are not connected yet. Wallet top-ups are
              manual (bKash / Nagad / bank, checked by hand) — a live payment
              gateway is not connected yet. Instagram and TikTok post
              publishing are coming soon; today, scheduled posts publish to
              Facebook.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">Who it is for</h2>
            <p className="mt-2 leading-relaxed">
              Small and growing online shops in Bangladesh that take orders
              through Facebook Messenger and Instagram — clothing, cosmetics,
              food, electronics, and any shop where customers ask first and
              buy in chat.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">Get started</h2>
            <p className="mt-2 leading-relaxed">
              <Link className="text-[#0f766e] underline" href="/signup">
                Sign up free
              </Link>{" "}
              — 14-day free trial and ৳50 free credit, no card needed. Read
              the{" "}
              <Link className="text-[#0f766e] underline" href="/terms">
                Terms of Service
              </Link>{" "}
              and{" "}
              <Link className="text-[#0f766e] underline" href="/privacy">
                Privacy Policy
              </Link>
              , or{" "}
              <Link className="text-[#0f766e] underline" href="/contact">
                contact us
              </Link>
              .
            </p>
          </section>
        </div>

        <p className="text-center text-sm text-slate-500 mt-8">
          <Link className="text-[#0f766e] underline" href="/login">
            Back to AI Sales Inbox
          </Link>
        </p>
      </div>
    </main>
  );
}
