# Privacy Policy — AI Sales Inbox

**Last updated:** [DATE HERE — যেদিন ওয়েবসাইটে তুলবেন, সেই তারিখ বসান]
**App name:** AI Sales Inbox
**Contact email:** [OWNER EMAIL HERE]
**Website:** [APP URL HERE]

---

## 1. What this app does

AI Sales Inbox is a software service (SaaS) for online sellers in Bangladesh
who sell on Facebook and Instagram. It brings a seller's Facebook Page
messages, Facebook post comments, and Instagram direct messages into one
inbox, lets an AI sales assistant answer customers, show products, and take
orders, and lets the seller manage orders, coupons, stock, and billing from
one dashboard.

The app is used by sellers (our customers). The people who message a seller's
Page — the buyers — are not our direct users; their messages reach us only
because the seller connected their Page to our app.

## 2. Data we collect

### 2.1 Data from sellers (people who sign up)

- Name, email address, password (stored as a secure hash, never in plain text),
  business name.
- Products the seller adds: product names, descriptions, prices, stock, photos.
- Orders, coupons, scheduled posts, and billing/wallet records the seller creates.

### 2.2 Data from Facebook and Instagram (via Meta's APIs)

When a seller connects their Facebook Page or Instagram account, and only
with the permissions the seller approves, we receive:

- **Page messages (Messenger):** the text of messages buyers send to the
  seller's Page, the sender's Facebook user ID and name, and the Page ID.
- **Facebook comments:** comments on the seller's Page posts — comment text,
  comment ID, the commenter's name and Facebook user ID, and the post ID.
- **Instagram direct messages:** the text of messages sent to the seller's
  Instagram account, the sender's Instagram user ID and name.
- **Page and account identifiers:** Page ID, Instagram account ID, and the
  access tokens needed to receive and reply to messages. Access tokens are
  stored encrypted (AES-256-GCM) and are never shown to anyone.

We do **not** collect buyers' Facebook passwords, private friend lists,
or any data from Pages or accounts the seller has not connected.

### 2.3 Data buyers give while ordering

When a buyer places an order through chat, the AI assistant asks only for
what is needed to deliver the order: name, phone number, and delivery
address. This information is stored with the order and shown to the seller.

### 2.4 Data we do not collect

- We do not collect payment card numbers. Wallet top-ups are confirmed
  manually by our team; no card data passes through the app.
- We do not sell any personal data to anyone, and we do not use buyers'
  messages for advertising.

## 3. Why we use the data

| Data | Purpose |
|---|---|
| Page messages, comments, Instagram messages | Show them in the seller's unified inbox; let the AI assistant reply; let the seller reply |
| Buyer name, phone, address | Create and deliver orders; contact the buyer about their order |
| Product data | Show product cards in chat; check price and stock before answering |
| Seller account data | Log in; manage the seller's workspace and team |
| Wallet and AI-usage records | Charge the seller per AI reply (as shown in the dashboard); keep a billing ledger |
| Access tokens | Receive messages and send replies on the seller's behalf, only for connected Pages/accounts |

The AI assistant only answers from the seller's own product data (price and
stock from the product table). It never invents prices, stock, or discounts.
If it is not confident about an answer, it hands the chat to a human and
opens a support ticket.

## 4. How long we keep data

- Chat messages, comments, orders, and customer records are kept while the
  seller's workspace is active, so the seller can see order history and
  past conversations.
- When a seller deletes their workspace, or asks us to delete their data,
  we delete their workspace data (messages, customers, orders, products,
  tokens) within **30 days** of the request.
- Billing/ledger records needed for accounting may be kept longer in
  anonymised form (without names, phone numbers, or addresses).
- A buyer can ask for their own messages and order details to be deleted
  (see section 6). We delete them within **30 days**.

## 5. Who we share data with

- **The seller:** a buyer's messages and order details are shown to the
  seller whose Page the buyer messaged. That is the purpose of the app.
- **AI providers:** message text and product data are sent to our AI provider
  (currently Groq — `openai/gpt-oss-20b` — free tier; previously Gemini) so
  the AI can draft a reply. The AI provider does not receive the seller's
  password or access tokens.
- **Meta Platforms, Inc.:** messages are received from and sent back through
  Meta's Graph API and webhooks.
- We do not share data with advertisers, data brokers, or any other third
  party.

## 6. How to ask for deletion (buyers and sellers)

**Sellers:** delete your workspace from the dashboard (Settings), or email
us at [OWNER EMAIL HERE] with the subject "Delete my data" and the email
address you signed up with.

**Buyers:** if you messaged a seller's Page and want your messages or order
details deleted, email us at [OWNER EMAIL HERE] with:
- the name of the Facebook Page you messaged — `[FACEBOOK PAGE NAME HERE]`
  (write the actual Page name),
- your Facebook name,
- what you want deleted (messages / order details / everything).

You can also use Facebook's own flow: go to **Facebook Settings →
Apps and Websites → AI Sales Inbox → Remove**, then follow the data
deletion link we provide there (see `data-deletion.md`). We will confirm
by email when the deletion is done, within 30 days.

## 7. Security

- Page access tokens are encrypted at rest (AES-256-GCM).
- Passwords are stored as hashes, never in plain text.
- Each seller's data is separated by workspace; one seller cannot see
  another seller's inbox, orders, or customers.
- Access to our servers is limited to our team.

## 8. Children's data

The app is for sellers running a business. It is not directed at children
under 13, and we do not knowingly collect data from children.

## 9. Changes to this policy

If we change this policy, we will update the "Last updated" date above
and notify sellers by email. The current version is always at
[APP URL HERE]/privacy.

## 10. Contact

Questions about this policy or about your data:

- Email: [OWNER EMAIL HERE]
- Website: [APP URL HERE]
- Business name: [BUSINESS NAME HERE]
- Address: [BUSINESS ADDRESS HERE]
