import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms of Service — YEARBITO",
  description:
    "Terms of Service for YEARBITO — what the service does, plans and prices, trial and wallet top-ups, refunds, acceptable use, and what sellers are responsible for.",
};

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-white text-slate-800">
      <div className="max-w-3xl mx-auto px-5 py-10">
        <p className="text-sm font-semibold tracking-wide text-[#0051F6] uppercase">
          YEARBITO
        </p>
        <h1 className="text-3xl font-bold mt-2">Terms of Service</h1>
        <p className="text-sm text-slate-500 mt-2">
          Last updated: 9 November 2026 · Operated by Year Media · Website:{" "}
          <a
            className="text-[#0051F6] underline"
            href="https://ai-sales-inbox-web.vercel.app"
          >
            ai-sales-inbox-web.vercel.app
          </a>
        </p>

        <div className="mt-6 rounded-2xl border border-orange-200 bg-[#EBF1FE] p-5">
          <p className="font-semibold text-slate-800">সংক্ষেপে (বাংলায়)</p>
          <p className="mt-1 leading-relaxed text-slate-700">
            YEARBITO আপনার ফেসবুক পেজ আর চ্যানেলের মেসেজের উত্তর AI দিয়ে
            দেয়, অর্ডার আর কুরিয়ার সামলায়। নতুন অ্যাকাউন্টে ১৪ দিনের ফ্রি
            ট্রায়াল আর ৳৫০ ফ্রি ক্রেডিট থাকে। পেমেন্ট হাতে করতে হয় —
            bKash / Rocket / Nagad-এ Send Money করে TrxID জমা দিলে আমরা চেক
            করে অ্যাকাউন্টে যোগ করি; কার্ডের তথ্য আমরা রাখি না, আর নিজে থেকে
            টাকা কাটা হয় না। ভুল করে টাকা পাঠালে বা অব্যবহৃত ক্রেডিট ফেরত
            চাইলে info.yearmedia@gmail.com-এ লিখুন।
          </p>
        </div>

        <div className="mt-8 space-y-8 bg-white rounded-2xl border border-orange-100 shadow-sm p-6 sm:p-8">
          <section>
            <h2 className="text-xl font-bold">1. What the service is</h2>
            <p className="mt-2 leading-relaxed">
              YEARBITO is a software service (SaaS) for online sellers
              in Bangladesh who sell on Facebook, Instagram, WhatsApp, TikTok
              and YouTube. It brings a seller&rsquo;s messages and comments
              from those channels into one inbox, lets an AI sales assistant
              answer customers using the seller&rsquo;s own product list and
              prices, and lets the seller manage products, orders, coupons,
              stock, scheduled posts, couriers and billing from one dashboard.
            </p>
            <p className="mt-2 leading-relaxed">
              By creating an account and using the service, you agree to these
              terms. If you do not agree, please do not use the service.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">2. Plans and prices</h2>
            <p className="mt-2 leading-relaxed">
              The service is sold in three separate parts — pay only for
              what you use. Everything is paid from your wallet balance
              (see section 4). The current prices are:
            </p>
            <ul className="list-disc pl-6 mt-2 space-y-1 leading-relaxed">
              <li>
                <strong>Post Schedule subscription:</strong> 1 scheduled
                post per day is free. To schedule more on the same day:
                ৳100 per month or ৳1,000 per year in Bangladesh; $1 per
                month or $10 per year internationally (charged to the
                wallet in taka at the current dollar rate). There is no
                lifetime plan.
              </li>
              <li>
                <strong>AI credit (pay-as-you-go):</strong> AI replies
                use your wallet balance. The real cost of every reply
                is still listed on the Billing page for transparency.
              </li>
              <li>
                <strong>Reply package:</strong> bought upfront
                (for example ৳110 for 500 replies). Bought replies are
                used first, before pay-as-you-go charges.
              </li>
            </ul>
            <p className="mt-2 leading-relaxed">
              The price shown on the Plans page at the time you buy is the
              price you pay. If a price changes, the new price applies
              only to new purchases and renewals, and we will show it
              on the Plans page before you pay. Old monthly plans (Small
              / Medium / Large) are no longer sold; a subscription bought
              before this change keeps running until its expiry date.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">3. Trial and free credit</h2>
            <p className="mt-2 leading-relaxed">
              New accounts get a 14-day free trial and ৳50 free credit. No
              card is needed to start the trial. When the trial ends, AI
              replies use your reply package first, then pay-as-you-go
              from your wallet balance; scheduling more than 1 post a day
              needs a Post Schedule subscription.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">4. Wallet top-ups and payments</h2>
            <p className="mt-2 leading-relaxed">
              Payments are manual. To add credit to your wallet, send money
              by bKash, Rocket or Nagad (Send Money), then submit the amount
              and the transaction ID (TrxID) from the Billing page. The money
              is added to your balance only after our team checks and approves
              the top-up. A live payment gateway is not connected yet, so no
              card payment is taken directly on this website, we never ask
              for your card number or PIN, and we never charge you
              automatically — you only pay when you send money yourself.
            </p>
            <p className="mt-2 leading-relaxed">
              Because top-ups are checked by hand, a top-up is only added
              after approval. If you sent money by mistake, contact us
              through the{" "}
              <Link className="text-[#0051F6] underline" href="/contact">
                Contact page
              </Link>{" "}
              or at{" "}
              <a
                className="text-[#0051F6] underline"
                href="mailto:info.yearmedia@gmail.com"
              >
                info.yearmedia@gmail.com
              </a>{" "}
              as soon as possible, before the top-up is approved, so we can
              check it. Wallet balance is used only inside the service
              (plans and AI replies) and cannot be withdrawn as cash.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">5. Refunds</h2>
            <p className="mt-2 leading-relaxed">
              Top-ups are manual, so refunds are handled by hand as well. If
              you sent money by mistake, or you have unused credit and want
              it back, contact us at{" "}
              <a
                className="text-[#0051F6] underline"
                href="mailto:info.yearmedia@gmail.com"
              >
                info.yearmedia@gmail.com
              </a>{" "}
              with your account email, the amount, and the transaction ID
              (TrxID). We refund unused credit on request, and the refund is
              sent back by the same Send Money method (bKash, Rocket or
              Nagad) you used to pay. We do not promise a fixed refund
              deadline — each request is checked by hand — but we answer every
              request. Unused wallet balance is not refunded when an account
              is closed for misuse (see section 9).
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">6. The AI assistant</h2>
            <p className="mt-2 leading-relaxed">
              The AI assistant drafts replies from the products, prices, and
              stock you enter. It must not invent prices: if a price is not
              in your product list, it says so instead of guessing. You can
              turn the AI off for any chat from the Inbox and answer yourself.
              The AI is a helper, not a salesperson — you are responsible for
              the orders you confirm, the prices you charge, and the
              deliveries you make. The AI can make mistakes; always check an
              order before you confirm it to a customer.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">7. Acceptable use</h2>
            <p className="mt-2 leading-relaxed">
              You must not use the service to:
            </p>
            <ul className="list-disc pl-6 mt-2 space-y-1 leading-relaxed">
              <li>Send spam, bulk unsolicited messages, or scams.</li>
              <li>
                Commit fraud, sell illegal goods, or mislead customers about
                price, stock, or delivery.
              </li>
              <li>
                Impersonate another person or business, or connect a Page,
                account or channel you do not own or manage.
              </li>
              <li>Harass, threaten, or abuse anyone.</li>
              <li>
                Break the rules of Meta, Google, TikTok, WhatsApp, or any
                courier you use through the service.
              </li>
              <li>
                Try to break, overload, or gain unauthorised access to the
                service or another seller&rsquo;s workspace.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold">8. Your responsibilities</h2>
            <ul className="list-disc pl-6 mt-2 space-y-1 leading-relaxed">
              <li>
                <strong>Your accounts:</strong> only connect Facebook Pages,
                Instagram accounts, WhatsApp numbers, TikTok accounts and
                YouTube channels that you own or are authorised to manage.
                You are responsible for keeping your login safe and for
                everything done under your account.
              </li>
              <li>
                <strong>Platform rules:</strong> your Page, account and
                channel must follow the rules of Meta, Google, TikTok and
                WhatsApp. If a platform limits or removes your Page or
                channel, the service cannot restore it.
              </li>
              <li>
                <strong>Your shop:</strong> you are responsible for your
                products, prices, stock, orders, deliveries and customer
                service. Couriers (Steadfast and Pathao) deliver under their
                own terms; we only book the parcel for you.
              </li>
              <li>
                <strong>Your customers&rsquo; data:</strong> you may only use
                a buyer&rsquo;s name, phone number and address to fulfil
                their order. Do not share or sell buyer data to anyone else.
                How we handle that data is explained in the{" "}
                <Link className="text-[#0051F6] underline" href="/privacy">
                  Privacy Policy
                </Link>
                .
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold">
              9. Suspension and termination
            </h2>
            <p className="mt-2 leading-relaxed">
              We may suspend or close an account that misuses the service
              (for example spam, fraud, or impersonation), breaks these terms,
              or breaks a platform&rsquo;s rules. We will tell you why when we
              can. You can stop using the service at any time; your data is
              deleted as explained in the{" "}
              <Link className="text-[#0051F6] underline" href="/privacy">
                Privacy Policy
              </Link>{" "}
              and on the{" "}
              <Link className="text-[#0051F6] underline" href="/data-deletion">
                Data Deletion page
              </Link>
              . Unused wallet balance is not refunded when an account is
              closed for misuse.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">
              10. Availability and liability
            </h2>
            <p className="mt-2 leading-relaxed">
              The service is provided &ldquo;as is&rdquo;. We work to keep it
              running, but Facebook, Instagram, WhatsApp, TikTok, YouTube,
              couriers and AI providers can change their services, limit
              access, or go down, and we cannot promise the service will
              always be available or error-free. Some channels need approval
              from Meta, Google or TikTok before they can connect, and that
              approval is outside our control.
            </p>
            <p className="mt-2 leading-relaxed">
              To the maximum extent allowed by law, our total liability for
              any claim about the service is limited to the fees you paid us
              in the 3 months before the claim. We are not liable for lost
              sales, lost profits, or damage caused by a platform outage, a
              courier delay, or an AI reply you did not check.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">11. Changes to these terms</h2>
            <p className="mt-2 leading-relaxed">
              These terms may change as the service grows (for example when a
              live payment gateway or new channels are added). The
              &ldquo;Last updated&rdquo; date above will change, and major
              changes will be announced in the dashboard. If you keep using
              the service after a change, you accept the new terms.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">12. Governing law</h2>
            <p className="mt-2 leading-relaxed">
              These terms are governed by the laws of Bangladesh.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">13. Contact</h2>
            <p className="mt-2 leading-relaxed">
              YEARBITO is operated by Year Media. Questions about these
              terms: email us at{" "}
              <a
                className="text-[#0051F6] underline"
                href="mailto:info.yearmedia@gmail.com"
              >
                info.yearmedia@gmail.com
              </a>{" "}
              or contact us through the{" "}
              <Link className="text-[#0051F6] underline" href="/contact">
                Contact page
              </Link>
              .
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
