# Module C — Contract (Phase 2 image matching + Phase 3 backend)

> মালিক: Module C. এই ফাইলের রাউটগুলো `/api`-তে মাউন্ট করা হয় (coordinator
> `index.ts`-এ মাউন্ট করে)। সব রাউটে JWT `requireAuth` আছে; প্রতিটি কোয়েরি
> `query(workspaceId, ...)` দিয়ে `workspace_id` দিয়ে ফিল্টার করে। দাম/স্টক/
> ছাড় কখনো বানিয়ে বলা হয় না — শুধু টেবিল থেকে আসে।

## Image matching — `match_product_by_image` টুল

- ফাইল: `apps/api/src/ai-agent/image-match.ts`,
  `apps/api/src/ai-agent/tools-image-match.ts`
- টুলের নাম (coordinator রেজিস্টার করে): `match_product_by_image`
- আর্গুমেন্ট: `{ imageRef | imageUrl | url, limit? }` (ডিফল্ট limit ৩)
- ফলাফল: `{ available, matches: [{ productId, name, pricePaisa, stock, score }], uncertain, message? }`
- মিল: কাস্টমারের ছবির এমবেডিং বনাম `product_images.embedding` — কোসাইন
  সিমিলারিটি, JS-এ হিসাব। সেরা স্কোর **০.৭৫-এর নিচে হলে `uncertain: true`**
  — তখন সেরা ২–৩টি দেখিয়ে কাস্টমারকে নিশ্চিত করতে বলতে হবে (বাংলা মেসেজ
  ফলাফলে থাকে)।
- **স্টাব:** কোনো এমবেডিং প্রোভাইডার এখনো যুক্ত হয়নি।
  `StubEmbeddingProvider` সবসময় `null` দেয় এবং লগ করে
  `[image-match] no embedding provider configured — set EMBEDDING_PROVIDER`।
  তখন ফলাফল `{ available: false, matches: [], message: 'ছবি দিয়ে খোঁজা এখনো
  চালু হয়নি — এমবেডিং সার্ভিস লাগবে।' }`। ভেক্টর বা মিল কখনো বানানো হয় না।
  আসল প্রোভাইডার এলে শুধু `getEmbeddingProvider()` বদলাতে হবে।
- এমবেডিং পার্স করা হয় ডিফেন্সিভভাবে: আসল Postgres-এ (pgvector) ভেক্টর,
  PGlite লোকাল মোডে TEXT হিসেবে JSON স্ট্রিং — দুটোই চলে; পার্স না হলে সেই
  রো বাদ যায়।

## Broadcasts — `broadcastsRouter` (মাউন্ট: `/api`)

| রাউট | কাজ |
|---|---|
| `GET /broadcasts` | `{ broadcasts }` — নতুন আগে |
| `POST /broadcasts` `{title, message, offerText?, couponCode?}` | ২০১ `{ broadcast }`, স্ট্যাটাস `draft` |
| `POST /broadcasts/:id/send` | নিচের ২৪ ঘণ্টা নিয়ম মেনে পাঠায়; `{ broadcast, sent, skipped }` |
| `GET /broadcasts/:id` | `{ broadcast, recipients }` (নাম/ফোনসহ) |

### ২৪ ঘণ্টা নিয়ম (কঠোর — Meta মেসেজিং নীতি)

`send` শুধু সেই কাস্টমারদের পাঠায় যাদের **গত ২৪ ঘণ্টায় একটি ইনবাউন্ড
মেসেজ** এসেছে — SQL-এ জোর করে: `messages.direction = 'in' AND
messages.created_at >= now() - interval '24 hours'`। উইন্ডোর বাইরের
কাস্টমারদের কখনো মেসেজ যায় না; তাদের সংখ্যা `skipped`-এ ফেরত যায়
(`skipped` = মোট কাস্টমার − যোগ্য কাস্টমার)। ইতিমধ্যে পাঠানো ব্রডকাস্ট
আবার পাঠাতে গেলে ৪০০ আসে।

### স্টাব (অনুমোদন লাগবে)

আসল Meta Graph API-তে মেসেজ পাঠানো হয় **না**। `send` শুধু
`broadcast_recipients` রো বানায় (`queued` → `sent`), লগে লেখে
`[broadcast-stub] ... (STUB — not really sent; real Meta send needs
approval)` এবং ব্রডকাস্টের স্ট্যাটাস `sent` + `sent_at` বসায়। আসল পাঠানো
চালু করতে Meta অনুমোদন + লাইভ পেজ টোকেন লাগবে।

## Bookings (রিসেপশনিস্ট মোড) — `bookingsRouter` (মাউন্ট: `/api`)

| রাউট | কাজ |
|---|---|
| `GET /bookings?date=&status=` | `{ bookings }` |
| `POST /bookings` `{customerId, service, date, time, advanceTxId?, advancePaisa?, notes?}` | ২০১ `{ booking }`, স্ট্যাটাস `confirmed` (কাস্টমার এই workspace-এ না থাকলে ৪০০) |
| `PATCH /bookings/:id` `{status?, advanceTxId?, advancePaisa?}` | `{ booking }`; status: `confirmed \| cancelled \| completed` |
| `GET /bookings/reminders-due` | আগামীকালের `confirmed` বুকিং, যাদের `reminder_sent=false` |
| `POST /bookings/:id/remind` | `reminder_sent=true` করে; কাস্টমারের সর্বশেষ কনভারসেশনে আউটবাউন্ড রিমাইন্ডার মেসেজ রো বানায়; `{ booking }` (ইতিমধ্যে পাঠানো থাকলে `{ booking, alreadySent: true }`) |

স্টাব: রিমাইন্ডার মেসেজ রো ডাটাবেজে বসে + লগ হয় (`[booking-reminder-stub]`),
কিন্তু আসল Meta পাঠানো হয় না — সেটার জন্য Meta অনুমোদন লাগবে।

## Reviews — `reviewsRouter` (মাউন্ট: `/api`)

| রাউট | কাজ |
|---|---|
| `POST /orders/:id/request-review` | `review_requests` রো বানায় (`status: 'requested'`), ২০১ `{ reviewRequest }`; অর্ডার না থাকলে ৪০৪ |
| `GET /reviews` | `{ reviews }` — অর্ডারের মোট টাকা ও কাস্টমারের নামসহ জয়েন |

স্টাব: রিভিউ চাওয়ার মেসেজ শুধু লগ হয় (`[review-request-stub]`) — আসল
পাঠানো হয় না; Meta অনুমোদন লাগবে।

## Migration — `migrationRouter` (মাউন্ট: `/api`)

| রাউট | কাজ |
|---|---|
| `POST /migration/import` `{type: 'customers' \| 'products' \| 'orders', csv: string}` | `{ imported, failed, errors: [{row, error}], importId }` |
| `GET /migration/imports` | `{ imports }` — আগের ইমপোর্টগুলো, নতুন আগে |

- CSV পার্সার হাতে লেখা (কোনো নতুন ডিপেন্ডেন্সি নেই): কোট করা ফিল্ড, `""`
  এস্কেপ, কোটের ভেতর কমা/নতুন লাইন, CRLF, হেডার রো।
- কলাম: Customers — `name,phone,address`; Products —
  `name,price_paisa,size,stock,description`; Orders —
  `customer_phone,product_name,quantity`।
- Orders-এ দাম **শুধু products টেবিল থেকে** নেওয়া হয় — CSV-এর দাম কখনো
  ব্যবহার হয় না। কাস্টমার (ফোন দিয়ে) বা প্রোডাক্ট (নাম দিয়ে) না মিললে সেই
  রো `failed`-এ যায়, বাকিগুলো চলতে থাকে।
- প্রতিটি ইমপোর্ট `migration_imports`-এ জমা হয় (মোট/সফল/ব্যর্থ + errors JSON)।

## Feature requests — `featureRequestsRouter` (মাউন্ট: `/api`)

| রাউট | কাজ |
|---|---|
| `GET /feature-requests` | `{ featureRequests }` |
| `POST /feature-requests` `{title, details}` | ২০১ `{ featureRequest }`, স্ট্যাটাস `open` |
| `PATCH /feature-requests/:id` `{status}` | `{ featureRequest }`; status: `open \| in_progress \| done \| rejected` |

## Analytics (posts + lost sales) — `postsAnalyticsRouter` (মাউন্ট: `/api`)

| রাউট | কাজ |
|---|---|
| `GET /analytics/posts` | `{ posts: [{ postId, caption, platforms, comments, chats, orders }] }` — কমেন্ট সংখ্যা আসল (`comments.platform_post_id` দিয়ে); `chats`/`orders` এখন ০ (নিচে দেখুন) |
| `GET /analytics/lost-sales` | `{ reasons: [{ reason, count }], total }` — `tickets.reason` + `unanswered_questions` গ্রুপ করে; কিছু না থাকলে খালি লিস্ট + বাংলা নোট |

সীমা: স্কিমায় পোস্ট থেকে কনভারসেশন/অর্ডারে যাওয়ার কোনো লিংক নেই
(কমেন্টে `conversation_id` নেই, মেসেজে পোস্ট আইডি নেই), তাই প্রতি পোস্টের
চ্যাট/অর্ডার এখনো মাপা যায় না — সংখ্যা বানানো হয় না, ০ ফেরত যায়। লিংক
যোগ হলে (scheduling/comments মডিউল) এই ফাইলের এক জায়গায় বদলাতে হবে।

## ডাটাবেজ

- `apps/api/src/db/migrations/03-phase3.sql` — শুধু `CREATE TABLE IF NOT
  EXISTS`: `broadcasts`, `broadcast_recipients`, `bookings`,
  `review_requests`, `migration_imports`, `feature_requests`।
- `schema.sql` ছোঁয়া হয়নি (২৬ টেবিল আগের মতোই)।

## যা অনুমোদন-নির্ভর (এই মডিউলে বানানো হয়নি)

1. **Meta অনুমোদন** (Developer অ্যাপ, App Review, Business Verification) —
   ছাড়া ব্রডকাস্ট/রিমাইন্ডার/রিভিউ-রিকোয়েস্টের আসল পাঠানো যাবে না।
2. **এমবেডিং সার্ভিস** (`EMBEDDING_PROVIDER`) — ছাড়া ছবি দিয়ে প্রোডাক্ট
   মেলানো `available: false` থাকবে।
3. **ক্রোম এক্সটেনশন** — বানানো হয়নি, শুধু পরিকল্পনা:
   `docs/chrome-extension-plan.md`।
