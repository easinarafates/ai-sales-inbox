import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Contact — AI Sales Inbox",
  description:
    "Contact AI Sales Inbox — support details will be listed here once they are ready.",
};

export default function ContactPage() {
  return (
    <main className="min-h-screen bg-[#FFF1EA] text-slate-800">
      <div className="max-w-3xl mx-auto px-5 py-10">
        <p className="text-sm font-semibold tracking-wide text-[#FF5B2E] uppercase">
          AI Sales Inbox
        </p>
        <h1 className="text-3xl font-bold mt-2">Contact us</h1>
        <p className="text-sm text-slate-500 mt-2">
          We answer support requests through the dashboard.
        </p>

        <div className="mt-8 space-y-8 bg-white rounded-2xl border border-orange-100 shadow-sm p-6 sm:p-8">
          <section>
            <h2 className="text-xl font-bold">Support (fastest)</h2>
            <p className="mt-2 leading-relaxed">
              Our support channel is being set up and will be listed here
              once it is ready. If you already have an account, you can
              keep using the dashboard in the meantime.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">Email</h2>
            <p className="mt-2 leading-relaxed">
              Our support email address is being set up and will be listed
              here once it is ready.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">Data deletion requests</h2>
            <p className="mt-2 leading-relaxed">
              To ask for your data to be deleted, use Facebook&rsquo;s own
              flow — Facebook Settings → Apps and Websites → AI Sales
              Inbox → Remove — then follow the data deletion link provided
              there. Details are in the{" "}
              <Link className="text-[#0f766e] underline" href="/privacy">
                Privacy Policy
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
