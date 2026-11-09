import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Data Deletion — AI Sales Inbox",
  description:
    "How to ask AI Sales Inbox to delete your data — for sellers who signed up and for buyers who messaged a seller's Page or channel.",
};

export default function DataDeletionPage() {
  return (
    <main className="min-h-screen bg-white text-slate-800">
      <div className="max-w-3xl mx-auto px-5 py-10">
        <p className="text-sm font-semibold tracking-wide text-[#FF5B2E] uppercase">
          AI Sales Inbox
        </p>
        <h1 className="text-3xl font-bold mt-2">Data Deletion</h1>
        <p className="text-sm text-slate-500 mt-2">
          Last updated: 9 November 2026 · Operated by Year Media
        </p>

        <div className="mt-6 rounded-2xl border border-orange-200 bg-[#FFF1EA] p-5">
          <p className="font-semibold text-slate-800">সংক্ষেপে (বাংলায়)</p>
          <p className="mt-1 leading-relaxed text-slate-700">
            আপনার ডেটা মুছতে চাইলে info.yearmedia@gmail.com-এ
            &ldquo;Delete my data&rdquo; লিখে আপনার অ্যাকাউন্টের ইমেইলসহ
            মেইল করুন — ৩০ দিনের মধ্যে আপনার মেসেজ, অর্ডার, কাস্টমার রেকর্ড
            আর টোকেন মুছে দেওয়া হবে। ফেসবুক থেকে অ্যাপ সরালেও (Facebook
            Settings → Apps and Websites → AI Sales Inbox → Remove)
            একইভাবে মুছে দেওয়া হয়।
          </p>
        </div>

        <div className="mt-8 space-y-8 bg-white rounded-2xl border border-orange-100 shadow-sm p-6 sm:p-8">
          <section>
            <h2 className="text-xl font-bold">What this page is</h2>
            <p className="mt-2 leading-relaxed">
              This page explains how to ask us to delete your personal data
              from AI Sales Inbox — whether you are a seller who signed up for
              an account, or a buyer who messaged one of our sellers&rsquo;
              Facebook Pages or channels. We delete requested data within{" "}
              <strong>30 days</strong> and confirm when it is done. Full
              details are in the{" "}
              <Link className="text-[#FF5B2E] underline" href="/privacy">
                Privacy Policy
              </Link>
              .
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">
              If you are a seller (you signed up)
            </h2>
            <p className="mt-2 leading-relaxed">
              Email us at{" "}
              <a
                className="text-[#FF5B2E] underline"
                href="mailto:info.yearmedia@gmail.com"
              >
                info.yearmedia@gmail.com
              </a>{" "}
              with the subject &ldquo;Delete my data&rdquo; and include the
              email address you signed up with. You can also write to us
              through the{" "}
              <Link className="text-[#FF5B2E] underline" href="/contact">
                Contact page
              </Link>
              . We will delete your workspace data — messages, customers,
              orders, products, scheduled posts and channel access tokens —
              within 30 days and confirm by email when it is done.
            </p>
            <p className="mt-2 leading-relaxed">
              You can also disconnect a Page, account or channel at any time
              from the Channels page in the dashboard. Disconnecting stops new
              messages from arriving; the data already stored is deleted when
              you ask us to delete it.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">
              If you are a buyer (you messaged a seller&rsquo;s Page)
            </h2>
            <p className="mt-2 leading-relaxed">
              The fastest way is Facebook&rsquo;s own flow:
            </p>
            <ol className="list-decimal pl-6 mt-2 space-y-1 leading-relaxed">
              <li>
                Go to <strong>Facebook Settings → Apps and Websites</strong>.
              </li>
              <li>
                Find <strong>AI Sales Inbox</strong> and choose{" "}
                <strong>Remove</strong>.
              </li>
              <li>
                Follow the data deletion link shown there. Facebook sends the
                request to our system automatically, and we delete your
                messages, conversations and customer record within 30 days.
                Facebook also gives you a confirmation code and a status link
                for the request.
              </li>
            </ol>
            <p className="mt-2 leading-relaxed">
              You can also tell the seller directly: the name of the Facebook
              Page you messaged, your Facebook name, and what you want deleted
              (messages / order details / everything). The seller can pass the
              request to us.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">What gets deleted</h2>
            <ul className="list-disc pl-6 mt-2 space-y-1 leading-relaxed">
              <li>Chat messages and comments you sent to a seller.</li>
              <li>
                Your customer record (name, phone number, delivery address).
              </li>
              <li>Your orders and order details.</li>
              <li>
                Access tokens for the Page, account or channel you connected
                (sellers).
              </li>
            </ul>
            <p className="mt-2 leading-relaxed">
              Billing records needed for accounting may be kept longer in
              anonymised form — without names, phone numbers, or addresses —
              so no one can be identified from them.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">Questions</h2>
            <p className="mt-2 leading-relaxed">
              Questions about deletion: email us at{" "}
              <a
                className="text-[#FF5B2E] underline"
                href="mailto:info.yearmedia@gmail.com"
              >
                info.yearmedia@gmail.com
              </a>
              , contact us through the{" "}
              <Link className="text-[#FF5B2E] underline" href="/contact">
                Contact page
              </Link>{" "}
              or read the{" "}
              <Link className="text-[#FF5B2E] underline" href="/privacy">
                Privacy Policy
              </Link>
              .
            </p>
          </section>
        </div>

        <p className="text-center text-sm text-slate-500 mt-8">
          <Link className="text-[#FF5B2E] underline" href="/login">
            Back to AI Sales Inbox
          </Link>
        </p>
      </div>
    </main>
  );
}
