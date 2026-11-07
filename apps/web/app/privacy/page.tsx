import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy — AI Sales Inbox",
  description:
    "Privacy Policy for AI Sales Inbox — what data we collect from sellers and buyers, how it is used, how long we keep it, and how to ask for deletion.",
};

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-[#fff8f3] text-slate-800">
      <div className="max-w-3xl mx-auto px-5 py-10">
        <p className="text-sm font-semibold tracking-wide text-[#ff6a4d] uppercase">
          AI Sales Inbox
        </p>
        <h1 className="text-3xl font-bold mt-2">Privacy Policy</h1>
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
            <h2 className="text-xl font-bold">1. What this app does</h2>
            <p className="mt-2 leading-relaxed">
              AI Sales Inbox is a software service (SaaS) for online sellers
              in Bangladesh who sell on Facebook and Instagram. It brings a
              seller&rsquo;s Facebook Page messages, Facebook post comments,
              and Instagram direct messages into one inbox, lets an AI sales
              assistant answer customers, show products, and take orders, and
              lets the seller manage orders, coupons, stock, and billing from
              one dashboard.
            </p>
            <p className="mt-2 leading-relaxed">
              The app is used by sellers (our customers). The people who
              message a seller&rsquo;s Page — the buyers — are not our direct
              users; their messages reach us only because the seller connected
              their Page to our app.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">2. Data we collect</h2>
            <h3 className="font-semibold mt-4">
              2.1 Data from sellers (people who sign up)
            </h3>
            <ul className="list-disc pl-6 mt-2 space-y-1 leading-relaxed">
              <li>
                Name, email address, password (stored as a secure hash, never
                in plain text), business name.
              </li>
              <li>
                Products the seller adds: product names, descriptions, prices,
                stock, photos.
              </li>
              <li>
                Orders, coupons, scheduled posts, and billing/wallet records
                the seller creates.
              </li>
            </ul>
            <h3 className="font-semibold mt-4">
              2.2 Data from Facebook and Instagram (via Meta&rsquo;s APIs)
            </h3>
            <p className="mt-2 leading-relaxed">
              When a seller connects their Facebook Page or Instagram account,
              and only with the permissions the seller approves, we receive:
            </p>
            <ul className="list-disc pl-6 mt-2 space-y-1 leading-relaxed">
              <li>
                <strong>Page messages (Messenger):</strong> the text of
                messages buyers send to the seller&rsquo;s Page, the
                sender&rsquo;s Facebook user ID and name, and the Page ID.
              </li>
              <li>
                <strong>Facebook comments:</strong> comments on the
                seller&rsquo;s Page posts — comment text, comment ID, the
                commenter&rsquo;s name and Facebook user ID, and the post ID.
              </li>
              <li>
                <strong>Instagram direct messages:</strong> the text of
                messages sent to the seller&rsquo;s Instagram account, the
                sender&rsquo;s Instagram user ID and name.
              </li>
              <li>
                <strong>Page and account identifiers:</strong> Page ID,
                Instagram account ID, and the access tokens needed to receive
                and reply to messages. Access tokens are stored encrypted
                (AES-256-GCM) and are never shown to anyone.
              </li>
            </ul>
            <p className="mt-2 leading-relaxed">
              We do <strong>not</strong> collect buyers&rsquo; Facebook
              passwords, private friend lists, or any data from Pages or
              accounts the seller has not connected.
            </p>
            <h3 className="font-semibold mt-4">
              2.3 Data buyers give while ordering
            </h3>
            <p className="mt-2 leading-relaxed">
              When a buyer places an order through chat, the AI assistant asks
              only for what is needed to deliver the order: name, phone
              number, and delivery address. This information is stored with
              the order and shown to the seller.
            </p>
            <h3 className="font-semibold mt-4">2.4 Data we do not collect</h3>
            <ul className="list-disc pl-6 mt-2 space-y-1 leading-relaxed">
              <li>
                We do not collect full payment card numbers or CVV. The
                shop owner may save a card&rsquo;s brand and last 4 digits
                only (shown in the Owner Panel as &ldquo;Cards on
                file&rdquo;). Wallet top-ups are confirmed manually by our
                team; no live payment gateway is connected yet.
              </li>
              <li>
                We do not sell any personal data to anyone, and we do not use
                buyers&rsquo; messages for advertising.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold">3. Why we use the data</h2>
            <ul className="list-disc pl-6 mt-2 space-y-1 leading-relaxed">
              <li>
                <strong>Page messages, comments, Instagram messages:</strong>{" "}
                show them in the seller&rsquo;s unified inbox; let the AI
                assistant reply; let the seller reply.
              </li>
              <li>
                <strong>Buyer name, phone, address:</strong> create and
                deliver orders; contact the buyer about their order.
              </li>
              <li>
                <strong>Product data:</strong> show product cards in chat;
                check price and stock before answering.
              </li>
              <li>
                <strong>Seller account data:</strong> log in; manage the
                seller&rsquo;s workspace and team.
              </li>
              <li>
                <strong>Wallet and AI-usage records:</strong> charge the
                seller per AI reply (as shown in the dashboard); keep a
                billing ledger.
              </li>
              <li>
                <strong>Access tokens:</strong> receive messages and send
                replies on the seller&rsquo;s behalf, only for connected
                Pages/accounts.
              </li>
            </ul>
            <p className="mt-2 leading-relaxed">
              The AI assistant only answers from the seller&rsquo;s own
              product data (price and stock from the product table). It never
              invents prices, stock, or discounts. If it is not confident
              about an answer, it hands the chat to a human.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">4. How long we keep data</h2>
            <ul className="list-disc pl-6 mt-2 space-y-1 leading-relaxed">
              <li>
                Chat messages, comments, orders, and customer records are kept
                while the seller&rsquo;s workspace is active, so the seller
                can see order history and past conversations.
              </li>
              <li>
                When a seller deletes their workspace, or asks us to delete
                their data, we delete their workspace data (messages,
                customers, orders, products, tokens) within{" "}
                <strong>30 days</strong> of the request.
              </li>
              <li>
                Billing/ledger records needed for accounting may be kept
                longer in anonymised form (without names, phone numbers, or
                addresses).
              </li>
              <li>
                A buyer can ask for their own messages and order details to
                be deleted (see section 6). We delete them within{" "}
                <strong>30 days</strong>.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold">5. Who we share data with</h2>
            <ul className="list-disc pl-6 mt-2 space-y-1 leading-relaxed">
              <li>
                <strong>The seller:</strong> a buyer&rsquo;s messages and
                order details are shown to the seller whose Page the buyer
                messaged. That is the purpose of the app.
              </li>
              <li>
                <strong>AI providers:</strong> message text and product data
                are sent to our AI provider (currently Gemini) so the AI can
                draft a reply. The AI provider does not receive the
                seller&rsquo;s password or access tokens.
              </li>
              <li>
                <strong>Meta Platforms, Inc.:</strong> messages are received
                from and sent back through Meta&rsquo;s Graph API and
                webhooks.
              </li>
              <li>
                We do not share data with advertisers, data brokers, or any
                other third party.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold">
              6. How to ask for deletion (buyers and sellers)
            </h2>
            <p className="mt-2 leading-relaxed">
              <strong>Sellers:</strong> contact us through the
              dashboard support (Tickets) with the subject{" "}
              &ldquo;Delete my data&rdquo; and the email address you signed up
              with.
            </p>
            <p className="mt-2 leading-relaxed">
              <strong>Buyers:</strong> if you messaged a seller&rsquo;s Page
              and want your messages or order details deleted, contact us
              through the dashboard support (Tickets) and tell us the name of
              the Facebook Page you messaged, your Facebook name, and what
              you want deleted (messages / order details / everything).
            </p>
            <p className="mt-2 leading-relaxed">
              You can also use Facebook&rsquo;s own flow: go to{" "}
              <strong>
                Facebook Settings → Apps and Websites → AI Sales Inbox →
                Remove
              </strong>
              , then follow the data deletion link provided there. We will
              confirm when the deletion is done, within 30 days.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">7. Security</h2>
            <ul className="list-disc pl-6 mt-2 space-y-1 leading-relaxed">
              <li>
                Page access tokens are encrypted at rest (AES-256-GCM).
              </li>
              <li>Passwords are stored as hashes, never in plain text.</li>
              <li>
                Each seller&rsquo;s data is separated by workspace; one seller
                cannot see another seller&rsquo;s inbox, orders, or customers.
              </li>
              <li>Access to our servers is limited to our team.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold">8. Children&rsquo;s data</h2>
            <p className="mt-2 leading-relaxed">
              The app is for sellers running a business. It is not directed
              at children under 13, and we do not knowingly collect data from
              children.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">9. Changes to this policy</h2>
            <p className="mt-2 leading-relaxed">
              If we change this policy, we will update the &ldquo;Last
              updated&rdquo; date above and notify sellers by email. The
              current version is always at{" "}
              <a
                className="text-[#0f766e] underline"
                href="https://ai-sales-inbox-web.vercel.app/privacy"
              >
                ai-sales-inbox-web.vercel.app/privacy
              </a>
              .
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">10. Contact</h2>
            <p className="mt-2 leading-relaxed">
              Questions about this policy or about your data: contact us
              through the AI Sales Inbox dashboard (Support / Tickets), or
              visit{" "}
              <a
                className="text-[#0f766e] underline"
                href="https://ai-sales-inbox-web.vercel.app"
              >
                ai-sales-inbox-web.vercel.app
              </a>
              . Our support email address is being set up and will be listed
              here once it is ready.
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
