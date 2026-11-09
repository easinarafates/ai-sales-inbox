import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Contact — AI Sales Inbox",
  description:
    "Contact AI Sales Inbox, operated by Year Media — support email, what to include in your message, and how to ask for your data to be deleted.",
};

export default function ContactPage() {
  return (
    <main className="min-h-screen bg-white text-slate-800">
      <div className="max-w-3xl mx-auto px-5 py-10">
        <p className="text-sm font-semibold tracking-wide text-[#FF5B2E] uppercase">
          AI Sales Inbox
        </p>
        <h1 className="text-3xl font-bold mt-2">Contact us</h1>
        <p className="text-sm text-slate-500 mt-2">
          AI Sales Inbox is operated by Year Media.
        </p>

        <div className="mt-6 rounded-2xl border border-orange-200 bg-[#FFF1EA] p-5">
          <p className="font-semibold text-slate-800">সংক্ষেপে (বাংলায়)</p>
          <p className="mt-1 leading-relaxed text-slate-700">
            যেকোনো সাহায্যের জন্য info.yearmedia@gmail.com-এ মেইল করুন —
            আপনার অ্যাকাউন্টের ইমেইল আর দোকানের নাম লিখে কী সমস্যা জানান।
            ডেটা মুছতে চাইলে &ldquo;Delete my data&rdquo; লিখে পাঠান।
          </p>
        </div>

        <div className="mt-8 space-y-8 bg-white rounded-2xl border border-orange-100 shadow-sm p-6 sm:p-8">
          <section>
            <h2 className="text-xl font-bold">Support email</h2>
            <p className="mt-2 leading-relaxed">
              Email us at{" "}
              <a
                className="text-[#FF5B2E] underline"
                href="mailto:info.yearmedia@gmail.com"
              >
                info.yearmedia@gmail.com
              </a>
              . We answer support questions, billing and top-up questions,
              and data deletion requests at this address.
            </p>
            <p className="mt-2 leading-relaxed">
              If you already have an account, you can also sign in to the
              dashboard and use the Guide page for help with the service.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">What to include in your message</h2>
            <p className="mt-2 leading-relaxed">
              To help us answer quickly, please include:
            </p>
            <ul className="list-disc pl-6 mt-2 space-y-1 leading-relaxed">
              <li>The email address you signed up with.</li>
              <li>Your business / shop name.</li>
              <li>
                What you need help with — for a top-up question, include the
                amount and the transaction ID (TrxID); for an order question,
                include the order number (for example ASI-0001).
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold">Data deletion requests</h2>
            <p className="mt-2 leading-relaxed">
              To ask for your data to be deleted, email{" "}
              <a
                className="text-[#FF5B2E] underline"
                href="mailto:info.yearmedia@gmail.com"
              >
                info.yearmedia@gmail.com
              </a>{" "}
              with the subject &ldquo;Delete my data&rdquo; and the email
              address you signed up with, or see the{" "}
              <Link className="text-[#FF5B2E] underline" href="/data-deletion">
                Data Deletion page
              </Link>
              . You can also use Facebook&rsquo;s own flow — Facebook
              Settings → Apps and Websites → AI Sales Inbox → Remove — then
              follow the data deletion link provided there. Details are in the{" "}
              <Link className="text-[#FF5B2E] underline" href="/privacy">
                Privacy Policy
              </Link>
              .
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">More information</h2>
            <p className="mt-2 leading-relaxed">
              Read the{" "}
              <Link className="text-[#FF5B2E] underline" href="/about">
                About page
              </Link>
              , the{" "}
              <Link className="text-[#FF5B2E] underline" href="/terms">
                Terms of Service
              </Link>{" "}
              and the{" "}
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
