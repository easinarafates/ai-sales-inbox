import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Refund Policy — YEARBITO",
  description:
    "Refund Policy for YEARBITO — how refunds work for wallet top-ups, card payments, subscriptions and reply packages, and how to ask for one.",
};

export default function RefundPage() {
  return (
    <main className="min-h-screen bg-white text-slate-800">
      <div className="max-w-3xl mx-auto px-5 py-10">
        <p className="text-sm font-semibold tracking-wide text-[#0051F6] uppercase">
          YEARBITO
        </p>
        <h1 className="text-3xl font-bold mt-2">Refund Policy</h1>
        <p className="text-sm text-slate-500 mt-2">
          Last updated: 11 November 2026 · Operated by Year Media · Website:{" "}
          <a
            className="text-[#0051F6] underline"
            href="https://yearbito.store"
          >
            yearbito.store
          </a>
        </p>

        <div className="mt-6 rounded-2xl border border-orange-200 bg-[#EBF1FE] p-5">
          <p className="font-semibold text-slate-800">সংক্ষেপে (বাংলায়)</p>
          <p className="mt-1 leading-relaxed text-slate-700">
            ভুল করে টাকা পাঠালে বা অব্যবহৃত ক্রেডিট ফেরত চাইলে আমাদের লিখুন —
            আমরা হাতে যাচাই করে ফেরত দিই। বিকাশ/রকেট/নগদে পাঠানো টাকা সেই একই
            মাধ্যমে ফেরত যায়; কার্ডে পেমেন্ট করলে সেই কার্ডেই ফেরত যায়।
            সাবস্ক্রিপশন বাতিল করলে মেয়াদ শেষ পর্যন্ত চালু থাকে, মাঝপথের
            দিনের টাকা ফেরত হয় না। অপব্যবহারের কারণে অ্যাকাউন্ট বন্ধ হলে
            ফেরত দেওয়া হয় না।
          </p>
        </div>

        <div className="mt-8 space-y-8 bg-white rounded-2xl border border-orange-100 shadow-sm p-6 sm:p-8">
          <section>
            <h2 className="text-xl font-bold">1. How to ask for a refund</h2>
            <p className="mt-2 leading-relaxed">
              Write to us at{" "}
              <a
                className="text-[#0051F6] underline"
                href="mailto:info.yearmedia@gmail.com"
              >
                info.yearmedia@gmail.com
              </a>{" "}
              with your account email, the amount, and the transaction ID
              (TrxID for bKash / Rocket / Nagad, or the payment receipt for
              a card payment). We check every request by hand and answer
              every request. We do not promise a fixed refund deadline —
              each request is checked manually.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">
              2. Wallet top-ups (bKash, Rocket, Nagad)
            </h2>
            <p className="mt-2 leading-relaxed">
              If you sent money by mistake, or you have unused wallet
              credit and want it back, we refund it on request. The refund
              is sent back by the same Send Money method (bKash, Rocket or
              Nagad) you used to pay.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">
              3. Card payments (international)
            </h2>
            <p className="mt-2 leading-relaxed">
              If you paid by card, the refund is sent back to the same card
              you paid with. Card refunds are processed through our payment
              provider and may take a few working days to appear on your
              statement, depending on your bank.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">
              4. Subscriptions (Post Schedule)
            </h2>
            <p className="mt-2 leading-relaxed">
              You can cancel a Post Schedule subscription at any time from
              the Plans page. The subscription stays active until the end
              of the period you already paid for, and it does not renew.
              We do not refund the unused days of a subscription period
              that has already started.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">5. Reply packages</h2>
            <p className="mt-2 leading-relaxed">
              Reply packages are credit you buy in advance. If you have
              unused replies left in a package and want a refund, write to
              us (see section 1) — we refund the unused replies at the
              price you paid for them.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">6. No refund for misuse</h2>
            <p className="mt-2 leading-relaxed">
              Unused wallet balance and unused reply packages are not
              refunded when an account is closed for misuse (see the Terms
              of Service). Wallet balance is used only inside the service
              (plans and AI replies) and cannot be withdrawn as cash.
            </p>
            <p className="mt-2 leading-relaxed">
              If anything on this page conflicts with the{" "}
              <Link className="text-[#0051F6] underline" href="/terms">
                Terms of Service
              </Link>
              , the Terms of Service apply. Questions? Write to{" "}
              <a
                className="text-[#0051F6] underline"
                href="mailto:info.yearmedia@gmail.com"
              >
                info.yearmedia@gmail.com
              </a>
              .
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
