import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms of Service — AI Sales Inbox",
  description:
    "Terms of Service for AI Sales Inbox — what the service does, trial and wallet top-ups, prices, and what sellers are responsible for.",
};

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-[#fff8f3] text-slate-800">
      <div className="max-w-3xl mx-auto px-5 py-10">
        <p className="text-sm font-semibold tracking-wide text-[#ff6a4d] uppercase">
          AI Sales Inbox
        </p>
        <h1 className="text-3xl font-bold mt-2">Terms of Service</h1>
        <p className="text-sm text-slate-500 mt-2">
          Last updated: 7 November 2026 · Website:{" "}
          <a
            className="text-[#0f766e] underline"
            href="https://ai-sales-inbox-web.vercel.app"
          >
            ai-sales-inbox-web.vercel.app
          </a>
        </p>

        <div className="mt-8 space-y-8 bg-white rounded-2xl border border-orange-100 shadow-sm p-6 sm:p-8">
          <section>
            <h2 className="text-xl font-bold">1. What the service is</h2>
            <p className="mt-2 leading-relaxed">
              AI Sales Inbox is a software service (SaaS) for online sellers
              in Bangladesh who sell on Facebook and Instagram. It brings a
              seller&rsquo;s Facebook Page messages, Facebook post comments,
              and Instagram direct messages into one inbox, lets an AI sales
              assistant answer customers using the seller&rsquo;s own product
              list and prices, and lets the seller manage orders, coupons,
              stock, scheduled posts, and billing from one dashboard.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">2. Trial and free credit</h2>
            <p className="mt-2 leading-relaxed">
              New accounts get a 14-day free trial of the small plan and ৳50
              free credit in the wallet. There is no monthly fee beyond the
              plan price: the cost of each AI reply is deducted from the
              wallet balance.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">3. Prices</h2>
            <p className="mt-2 leading-relaxed">
              The prices shown on the website are suggested prices, not final
              prices. The final price of a plan is confirmed before you pay.
              When you buy a plan, the monthly price is deducted from your
              wallet balance (see the transactions on the Billing page).
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">4. Wallet top-ups</h2>
            <p className="mt-2 leading-relaxed">
              Wallet top-ups are manual for now: you send money by hand
              (bKash / Nagad / bank transfer), submit the amount and
              transaction ID from the Billing page, and the money is added to
              your balance only after it is checked and approved. A live
              payment gateway (bKash / Nagad merchant) is not connected yet,
              so no card payment is taken directly on this website.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">5. The AI assistant</h2>
            <p className="mt-2 leading-relaxed">
              The AI assistant drafts replies from the products, prices, and
              stock you enter. It must not invent prices: if a price is not
              in your product list, it says so instead of guessing. You can
              turn the AI off for any chat from the Inbox and answer yourself.
              The AI is a helper, not a salesperson — you are responsible for
              the orders you confirm, the prices you charge, and the
              deliveries you make.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">6. Your account and data</h2>
            <p className="mt-2 leading-relaxed">
              You are responsible for keeping your login safe and for the
              Facebook Pages and Instagram accounts you connect. We may
              suspend a shop that misuses the service (for example spam,
              fraud, or impersonation). How your data is collected, used, and
              deleted is explained in the{" "}
              <Link className="text-[#0f766e] underline" href="/privacy">
                Privacy Policy
              </Link>
              .
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">7. Changes to these terms</h2>
            <p className="mt-2 leading-relaxed">
              These terms may change as the service grows (for example when a
              live payment gateway or new channels are added). The
              &ldquo;Last updated&rdquo; date above will change, and major
              changes will be announced in the dashboard.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">8. Contact</h2>
            <p className="mt-2 leading-relaxed">
              Questions about these terms: contact us through the AI Sales
              Inbox dashboard (Support / Tickets), or see the{" "}
              <Link className="text-[#0f766e] underline" href="/contact">
                Contact page
              </Link>
              . Our support email address is being set up and will be listed
              there once it is ready.
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
