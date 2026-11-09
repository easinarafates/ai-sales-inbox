import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy — AI Sales Inbox",
  description:
    "Privacy Policy for AI Sales Inbox — what data we collect from sellers and buyers (Facebook, Instagram, WhatsApp, TikTok, YouTube), how it is used, how long we keep it, and how to ask for deletion.",
};

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-white text-slate-800">
      <div className="max-w-3xl mx-auto px-5 py-10">
        <p className="text-sm font-semibold tracking-wide text-[#FF5B2E] uppercase">
          AI Sales Inbox
        </p>
        <h1 className="text-3xl font-bold mt-2">Privacy Policy</h1>
        <p className="text-sm text-slate-500 mt-2">
          Last updated: 9 November 2026 · Operated by Year Media · Website:{" "}
          <a
            className="text-[#FF5B2E] underline"
            href="https://ai-sales-inbox-web.vercel.app"
          >
            ai-sales-inbox-web.vercel.app
          </a>
        </p>

        <div className="mt-6 rounded-2xl border border-orange-200 bg-[#FFF1EA] p-5">
          <p className="font-semibold text-slate-800">সংক্ষেপে (বাংলায়)</p>
          <p className="mt-1 leading-relaxed text-slate-700">
            আমরা শুধু আপনার দোকান চালাতে যা দরকার তাই সংগ্রহ করি — আপনার
            অ্যাকাউন্টের তথ্য, আপনার পেজ বা চ্যানেলের মেসেজ, কাস্টমারের
            নাম-ফোন-ঠিকানা (অর্ডার ডেলিভারির জন্য), আর পেমেন্টের TrxID।
            আমরা আপনার ডেটা বিক্রি করি না, কার্ডের তথ্য রাখি না। আপনার ডেটা
            মুছতে চাইলে info.yearmedia@gmail.com-এ লিখুন, অথবা{" "}
            <Link className="text-[#FF5B2E] underline" href="/data-deletion">
              Data Deletion পেজ
            </Link>{" "}
            দেখুন।
          </p>
        </div>

        <div className="mt-8 space-y-8 bg-white rounded-2xl border border-orange-100 shadow-sm p-6 sm:p-8">
          <section>
            <h2 className="text-xl font-bold">1. What this app does</h2>
            <p className="mt-2 leading-relaxed">
              AI Sales Inbox is a software service (SaaS) for online sellers
              in Bangladesh who sell on Facebook, Instagram, WhatsApp, TikTok
              and YouTube. It brings a seller&rsquo;s messages and comments
              from those channels into one inbox, lets an AI sales assistant
              answer customers, show products, and take orders, and lets the
              seller manage orders, coupons, stock, scheduled posts, couriers
              and billing from one dashboard.
            </p>
            <p className="mt-2 leading-relaxed">
              The app is used by sellers (our customers). The people who
              message a seller&rsquo;s Page or channel — the buyers — are not
              our direct users; their messages reach us only because the
              seller connected their Page or channel to our app.
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
                the seller creates — including the amount and transaction ID
                (TrxID) the seller submits for a manual bKash, Rocket or
                Nagad Send Money top-up.
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
              2.3 Data from YouTube (via Google&rsquo;s APIs)
            </h3>
            <p className="mt-2 leading-relaxed">
              When a seller connects their YouTube channel, and only with the
              scopes the seller approves on Google&rsquo;s consent screen
              (read channel and videos, upload videos, reply to comments), we
              receive:
            </p>
            <ul className="list-disc pl-6 mt-2 space-y-1 leading-relaxed">
              <li>
                The Google account&rsquo;s name and email address used for the
                connection, and the channel&rsquo;s ID, name and handle.
              </li>
              <li>
                The channel&rsquo;s videos (titles, descriptions, video IDs)
                and comments on those videos (comment text, commenter name and
                channel ID) so the seller can read and reply to them.
              </li>
              <li>
                The access and refresh tokens needed to upload videos and
                reply to comments on the seller&rsquo;s behalf. Tokens are
                stored encrypted and are never shown to anyone.
              </li>
            </ul>
            <p className="mt-2 leading-relaxed">
              We do not collect the seller&rsquo;s Google password, and we do
              not read or store videos or comments from channels the seller
              has not connected.
            </p>
            <h3 className="font-semibold mt-4">
              2.4 Data from TikTok (via TikTok&rsquo;s APIs)
            </h3>
            <p className="mt-2 leading-relaxed">
              When a seller connects their TikTok account, and only with the
              scopes the seller approves, we receive:
            </p>
            <ul className="list-disc pl-6 mt-2 space-y-1 leading-relaxed">
              <li>
                The TikTok account&rsquo;s open ID, username and display name.
              </li>
              <li>
                The account&rsquo;s videos (video IDs, titles) and comments on
                those videos, so the seller can read and reply to them, and
                schedule video posts.
              </li>
              <li>
                Direct messages sent to the seller&rsquo;s TikTok Business
                account (where the seller has Business Messaging access), so
                they appear in the seller&rsquo;s inbox and can be replied to.
              </li>
              <li>
                The access tokens needed for these actions. Tokens are stored
                encrypted and are never shown to anyone.
              </li>
            </ul>
            <h3 className="font-semibold mt-4">
              2.5 Data from WhatsApp (via Meta&rsquo;s WhatsApp Business API)
            </h3>
            <p className="mt-2 leading-relaxed">
              When a seller connects their WhatsApp Business number, and only
              with the seller&rsquo;s approval, we receive:
            </p>
            <ul className="list-disc pl-6 mt-2 space-y-1 leading-relaxed">
              <li>
                The WhatsApp Business phone number ID and display name.
              </li>
              <li>
                Messages customers send to that number (text and images) and
                the sender&rsquo;s phone number and profile name, so they
                appear in the seller&rsquo;s inbox and can be replied to.
              </li>
              <li>
                The access token needed to send replies. Tokens are stored
                encrypted and are never shown to anyone.
              </li>
            </ul>
            <h3 className="font-semibold mt-4">
              2.6 Data buyers give while ordering
            </h3>
            <p className="mt-2 leading-relaxed">
              When a buyer places an order through chat, the AI assistant asks
              only for what is needed to deliver the order: name, phone
              number, and delivery address. This information is stored with
              the order and shown to the seller. When the seller books a
              courier, the buyer&rsquo;s name, phone number and address are
              shared with the courier (Steadfast or Pathao) so the parcel can
              be delivered.
            </p>
            <h3 className="font-semibold mt-4">
              2.7 Cookies and browser storage
            </h3>
            <p className="mt-2 leading-relaxed">
              We store a login token in your browser&rsquo;s local storage so
              you stay signed in to the dashboard. We do not use third-party
              advertising cookies, and we do not track you across other
              websites.
            </p>
            <h3 className="font-semibold mt-4">2.8 Data we do not collect</h3>
            <ul className="list-disc pl-6 mt-2 space-y-1 leading-relaxed">
              <li>
                We do not collect full payment card numbers or CVV. Wallet
                top-ups are confirmed manually by our team; no live payment
                gateway is connected yet.
              </li>
              <li>
                We do not collect the passwords of any Facebook, Instagram,
                Google, TikTok or WhatsApp account.
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
                <strong>Messages and comments (Facebook, Instagram, WhatsApp,
                TikTok, YouTube):</strong> show them in the seller&rsquo;s
                unified inbox; let the AI assistant reply; let the seller
                reply.
              </li>
              <li>
                <strong>Buyer name, phone, address:</strong> create and
                deliver orders; contact the buyer about their order; book a
                courier.
              </li>
              <li>
                <strong>Product data:</strong> show product cards in chat;
                check price and stock before answering.
              </li>
              <li>
                <strong>Videos and scheduled posts:</strong> publish the
                seller&rsquo;s scheduled videos and posts to the channels the
                seller connected, only when the seller scheduled them.
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
                Pages, accounts and channels.
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
                When a seller asks us to delete their data, we delete their
                workspace data (messages, customers, orders, products,
                tokens) within <strong>30 days</strong> of the request.
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
                order details are shown to the seller whose Page or channel
                the buyer messaged. That is the purpose of the app.
              </li>
              <li>
                <strong>AI providers:</strong> message text and product data
                are sent to the AI provider configured in the dashboard
                (Google Gemini by default) so the AI can draft a reply. The
                AI provider does not receive the seller&rsquo;s password or
                access tokens.
              </li>
              <li>
                <strong>Meta Platforms, Inc.:</strong> messages and comments
                are received from and sent back through Meta&rsquo;s Graph
                API and webhooks (Facebook, Instagram, WhatsApp).
              </li>
              <li>
                <strong>Google (YouTube):</strong> channel, video and comment
                data are received from and sent back through Google&rsquo;s
                YouTube Data API.
              </li>
              <li>
                <strong>TikTok:</strong> account, video, comment and message
                data are received from and sent back through TikTok&rsquo;s
                APIs.
              </li>
              <li>
                <strong>Couriers (Steadfast and Pathao):</strong> when the
                seller books a delivery, the buyer&rsquo;s name, phone number
                and delivery address are shared with the courier so the parcel
                can be delivered.
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
              Full instructions are on the{" "}
              <Link className="text-[#FF5B2E] underline" href="/data-deletion">
                Data Deletion page
              </Link>
              .
            </p>
            <p className="mt-2 leading-relaxed">
              <strong>Sellers:</strong> write to us through the{" "}
              <Link className="text-[#FF5B2E] underline" href="/contact">
                Contact page
              </Link>{" "}
              with the subject &ldquo;Delete my data&rdquo; and the email
              address you signed up with. We delete your workspace data
              within 30 days and confirm when it is done.
            </p>
            <p className="mt-2 leading-relaxed">
              <strong>Buyers:</strong> if you messaged a seller&rsquo;s Page
              or channel and want your messages or order details deleted,
              use Facebook&rsquo;s own flow — go to{" "}
              <strong>
                Facebook Settings → Apps and Websites → AI Sales Inbox →
                Remove
              </strong>
              , then follow the data deletion link provided there. Meta sends
              the request to our system automatically and we delete your
              messages, conversations and customer record within 30 days.
              You can also tell the seller the name of the Page you messaged,
              your name, and what you want deleted (messages / order details
              / everything).
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">7. Security</h2>
            <ul className="list-disc pl-6 mt-2 space-y-1 leading-relaxed">
              <li>
                Page, channel and account access tokens are encrypted at rest
                (AES-256-GCM).
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
            <h2 className="text-xl font-bold">9. Your rights</h2>
            <p className="mt-2 leading-relaxed">
              You can ask us what personal data we hold about you, ask us to
              correct it, or ask us to delete it (see section 6). Sellers can
              also disconnect a Page, account or channel at any time from the
              Channels page — disconnecting stops new messages from arriving,
              and the stored data for that channel is deleted when you ask us
              to delete it.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">10. Changes to this policy</h2>
            <p className="mt-2 leading-relaxed">
              If we change this policy, we will update the &ldquo;Last
              updated&rdquo; date above and notify sellers by email. The
              current version is always at{" "}
              <a
                className="text-[#FF5B2E] underline"
                href="https://ai-sales-inbox-web.vercel.app/privacy"
              >
                ai-sales-inbox-web.vercel.app/privacy
              </a>
              .
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold">11. Contact</h2>
            <p className="mt-2 leading-relaxed">
              AI Sales Inbox is operated by Year Media. Questions about this
              policy or about your data: email us at{" "}
              <a
                className="text-[#FF5B2E] underline"
                href="mailto:info.yearmedia@gmail.com"
              >
                info.yearmedia@gmail.com
              </a>
              , or contact us through the{" "}
              <Link className="text-[#FF5B2E] underline" href="/contact">
                Contact page
              </Link>
              . You can also visit{" "}
              <a
                className="text-[#FF5B2E] underline"
                href="https://ai-sales-inbox-web.vercel.app"
              >
                ai-sales-inbox-web.vercel.app
              </a>
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
