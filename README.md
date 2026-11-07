# AI সেলস ইনবক্স প্ল্যাটফর্ম — ফেজ ১ + ফেজ ২ + ফেজ ৩ (ফুল সাইট)

বাংলাদেশের Facebook / Instagram বিক্রেতাদের জন্য AI সেলস ইনবক্স SaaS।
সব চ্যাট এক ইনবক্সে আসবে, AI কাস্টমারের সাথে কথা বলে অর্ডার পর্যন্ত নিয়ে যাবে।
মাসিক ফি নেই — খরচ শুধু AI যতটুকু কাজ করে ততটুকু, ফ্রি ক্রেডিট দিয়ে শুরু।

> **ফেজ ১ (MVP) + ফেজ ২ + ফেজ ৩-এর বানানো যায় এমন সবকিছু এখানে আছে।**
> সাথে সাবস্ক্রিপশন (প্ল্যান/ট্রায়াল/সীমা), পোস্ট অ্যাট্রিবিউশন, কুরিয়ার
> স্টাব + ম্যানুয়াল টপ-আপ, TikTok DM গেট, আসল এমবেডিং প্রোভাইডার,
> Chrome এক্সটেনশন ও Meta App Review প্যাক (ডেটা মুছে ফেলার এন্ডপয়েন্টসহ)।
> বাকি আছে শুধু প্ল্যাটফর্মের অনুমোদন লাগে এমন জিনিস (Meta/WhatsApp/TikTok),
> কুরিয়ার ও গেটওয়ের আসল চাবি, আর ৫টি আসল দোকানে পরীক্ষা।
> বিস্তারিত [RUNNING.md](./RUNNING.md)-এ।

## কী বানানো হয়েছে

| অংশ | বিবরণ |
|---|---|
| `schema.sql` | PostgreSQL + pgvector স্কিমা — **২৬টি টেবিল**। প্রতিটি টেবিলে `workspace_id` আছে, প্রতিটি কোয়েরি সেটা দিয়ে ফিল্টার করে। |
| `apps/api/src/db/migrations/` | ফেজ ২/৩ মাইগ্রেশন: `01-phase2-core.sql` (কুপন রিডেম্পশন, স্টক অ্যাডজাস্টমেন্ট), `02-phase2-engagement.sql` (নলেজ ভার্সন, পাবলিশ লগ), `03-phase3.sql` (ব্রডকাস্ট, বুকিং, রিভিউ, মাইগ্রেশন, ফিচার অনুরোধ), `04-subscriptions.sql` (প্ল্যান, সাবস্ক্রিপশন), `05-post-attribution.sql` (পোস্ট → চ্যাট → অর্ডার লিংক), `06-courier-topup.sql` (শিপমেন্ট কলাম + টপ-আপ অনুরোধ), `07-data-deletion.sql` (ডেটা মুছে ফেলার অনুরোধের রেকর্ড)। PGlite লোকাল চালায় API চালু হওয়ার সময় নিজে থেকেই লাগায়; আসল Postgres-এ `psql -f` দিয়ে চালাতে হয়। |
| `apps/api/src/subscriptions/` | সাবস্ক্রিপশন: ৩টি প্ল্যান (**প্রস্তাবিত দাম** — ছোট ৳৪৯৯ / মাঝারি ৳৯৯৯ / বড় ৳১৯৯৯ প্রতি মাস; মালিকের চূড়ান্ত দাম নয়), ১৪ দিনের ফ্রি ট্রায়াল, AI উত্তরের সংখ্যা + চ্যানেল + প্রোডাক্টের সীমা (সীমা শেষে ৪০২ + বাংলা বার্তা; মেয়াদ শেষে AI বন্ধ + টিকেট; ওভারেজে ১০ পয়সা)। পরীক্ষার সহায়ক রুট ডিফল্ট বন্ধ — শুধু `ALLOW_SUBSCRIPTION_TEST_HOOKS=true` দিয়ে চালু হয়। |
| `apps/api/src/courier/` + `apps/api/src/billing/topup.ts` | কুরিয়ার বুকিং + ট্র্যাকিং (**স্টাব** — আসল বুকিংয়ের জন্য Pathao/Steadfast/RedX চাবি লাগবে) ও ম্যানুয়াল টপ-আপ (অনুরোধ → অনুমোদন/বাতিল, অনুমোদনে ওয়ালেটে টাকা যোগ হয়)। |
| `apps/api/src/webhooks/tiktok-dm.ts` + `apps/api/src/webhooks/meta.ts` | TikTok DM webhook (অনুমোদন না থাকলে ৪০৩, কিছু সেভ হয় না; চ্যানেল `tiktok_dm` হিসেবে `pending_approval`) ও Meta ডেটা মুছে ফেলার callback (`POST /api/meta/data-deletion` — `signed_request` HMAC-SHA256 যাচাই, `{url, confirmation_code}` উত্তর)। |
| `apps/api/src/ai-agent/embeddings-openai.ts` | আসল এমবেডিং প্রোভাইডার (OpenAI-সামঞ্জস্যপূর্ণ, multimodal/CLIP) — `EMBEDDING_PROVIDER=openai-compatible` + URL/চাবি/মডেল থাকলে ছবি দিয়ে আসল খোঁজা চলে, নইলে stub (ভুয়া মিল কখনো নয়)। |
| `chrome-extension/` | Chrome এক্সটেনশন (Manifest v3, পপআপ, কনটেন্ট স্ক্রিপ্ট, বাংলা README) — Chrome-এ unpacked হিসেবে লোড করে ব্যবহার করা যায়। |
| `meta-approval/` | Meta App Review প্যাক: প্রাইভেসি পলিসি (বাংলা/ইংরেজি), অনুমতির তালিকা, চেকলিস্ট, স্ক্রিনকাস্ট স্ক্রিপ্ট, ডেটা মুছে ফেলার নিয়ম। জমা দেওয়ার কাজটি আরাফাত নিজে করবেন। |
| `infra/` | Docker Compose: PostgreSQL (pgvector/pg16), Redis 7, Minio (S3-সামঞ্জস্যপূর্ণ স্টোরেজ) + `.env.example` |
| `apps/api/` | Node.js + TypeScript + Express API (পোর্ট 4000): অথ, চ্যানেল, ওয়েবহুক, ইনবক্স, প্রোডাক্ট, অর্ডার, টিকেট, বিলিং, নলেজ বুক |
| `apps/api/src/ai-agent/` | AI এজেন্ট: Gemini/Groq কল, কনফিডেন্স স্কোর, **১১টি টুল** (ছবি মেলানোসহ), প্র্যাকটিস মোড |
| `apps/api/src/scheduling/` + `followups/` + `leads/` + `analytics/` | ফেজ ২: পোস্ট শিডিউল + প্রকাশক (৩ বার চেষ্টা, TikTok অডিট গেট), ফলো-আপ ইঞ্জিন, লিড, অ্যানালিটিক্স |
| `apps/api/src/coupons/` + `customers/` + `comments/` | ফেজ ২: কুপন, সব চ্যানেলের একই কাস্টমার (মার্জসহ), কমেন্ট ক্যারোসেল |
| `apps/api/src/broadcasts/` + `bookings/` + `reviews/` + `migration/` + `feature-requests/` | ফেজ ৩: ২৪ ঘণ্টার ব্রডকাস্ট, রিসেপশনিস্ট বুকিং, রিভিউ অনুরোধ, CSV মাইগ্রেশন, ফিচার অনুরোধ |
| `workers/queue/` | Redis + BullMQ: মেসেজ কিউ, একই কাস্টমারের ৩ সেকেন্ডের ভেতরের মেসেজ এক ব্যাচে জোড়া (ডিবাউন্স); `scheduled-posts` কিউ + ৬০ সেকেন্ডের সুইপ |
| `apps/web/` | Next.js 14 + Tailwind ড্যাশবোর্ড (পোর্ট 3000): লগইন/সাইনআপ, ইনবক্স, প্রোডাক্ট, অর্ডার, টিকেট, বিলিং + চ্যানেল, কুপন, কাস্টমার, শিডিউল, লিড, অ্যানালিটিক্স, শেখানো, ব্রডকাস্ট, বুকিং, রিভিউ, মাইগ্রেশন, ফিচার অনুরোধ, প্ল্যান (`/plans`), কুরিয়ার (`/courier`) — বাংলা UI |

## টেক স্ট্যাক

- ফ্রন্টএন্ড: Next.js 14 + Tailwind CSS
- ব্যাকএন্ড: Node.js (TypeScript) + Express
- ডাটাবেস: PostgreSQL + pgvector, কিউ/ক্যাশ: Redis + BullMQ
- ফাইল স্টোরেজ: S3-সামঞ্জস্যপূর্ণ (Minio লোকালে)
- AI মডেল: Gemini — মডেলের নাম **শুধু** `apps/api/src/config/index.ts`-এ আছে
  (`AI_MODEL`, ডিফল্ট `gemini-3.5-flash`)। এজেন্ট কোডে মডেলের নাম হার্ডকোড করা নেই।

## লোকালে চালানো

> **Docker ছাড়া চালাতে চাইলে** (সহজ উপায়): `./scripts/run-local.sh` — বিস্তারিত দেখুন [RUNNING.md](./RUNNING.md)। নিচের ধাপগুলো Docker দিয়ে চালানোর নিয়ম।

### ১. ডাটাবেস ও কিউ চালু করা

```bash
docker compose -f infra/docker-compose.yml up -d
# Postgres: localhost:5432, Redis: localhost:6379, Minio: localhost:9000 (কনসোল 9001)
```

### ২. স্কিমা চালানো

```bash
psql "postgres://ai_inbox:ai_inbox_dev@localhost:5432/ai_inbox" -f schema.sql
```

### ৩. Environment

```bash
cp infra/.env.example apps/api/.env
cp infra/.env.example workers/queue/.env
cp apps/web/.env.example apps/web/.env.local
# তারপর apps/api/.env-এ আসল মান বসান: JWT_SECRET, TOKEN_ENCRYPTION_KEY
# (openssl rand -hex 32), GEMINI_API_KEY — নিচে "আসল কী লাগবে" দেখুন
```

### ৪. API চালানো

```bash
cd apps/api
npm install
npm run build
npm start          # পোর্ট 4000 — http://localhost:4000/api/health
# ডেভেলপমেন্টে: npm run dev
```

ডেমো ডাটা (ঐচ্ছিক, শুধু টেস্টের জন্য):

```bash
SEED_DEMO=true npm run seed
```

### ৫. Worker চালানো (আলাদা টার্মিনালে)

```bash
cd workers/queue
npm install
npm run build
npm start          # BullMQ worker: inbox-messages কিউ প্রসেস করে
# ডেভেলপমেন্টে: npm run dev
```

### ৬. ওয়েব ড্যাশবোর্ড চালানো (আলাদা টার্মিনালে)

```bash
cd apps/web
npm install
npm run build
npm start          # পোর্ট 3000 — http://localhost:3000
# ডেভেলপমেন্টে: npm run dev
```

## প্রতিটি ফেজ ১ ফিচার কীভাবে টেস্ট করবেন

1. **সাইনআপ / ওয়ার্কস্পেস:** http://localhost:3000/signup — নাম, ইমেইল, পাসওয়ার্ড, ব্যবসার নাম দিন। সাইনআপে **৫০০০ পয়সা (৳৫০) ফ্রি ক্রেডিট** যোগ হয়।
2. **চ্যানেল সংযোগ:** API-তে `POST /api/channels` — `platform: messenger | facebook_comment | instagram | webchat`, `externalId`, `token`। টোকেন AES-256-GCM দিয়ে এনক্রিপ্ট করে রাখা হয়।
3. **ওয়েব লাইভ চ্যাট (চাবি ছাড়াই টেস্ট করা যায়):** `POST /api/webhooks/webchat` — `WEBCHAT_SECRET` হেডারসহ মেসেজ পাঠালে কাস্টমার + কনভারসেশন তৈরি হয়ে কিউতে যায়।
4. **ইউনিফাইড ইনবক্স:** ড্যাশবোর্ডের ইনবক্স পেজে সার্চ করুন — নাম, ফোন, অর্ডার নম্বর বা চ্যাটের যেকোনো শব্দ দিয়ে। চ্যাট খুলে উত্তর দিন, টিমমেটকে অ্যাসাইন করুন, "সম্পন্ন" করুন।
5. **ডট (.) দিয়ে মানুষ নেওয়া:** ইনবক্সে ডট বাটন — একবার চাপলে AI সরে যায় (মানুষ নেয়), আবার চাপলে AI ফেরে। API: `POST /api/inbox/:id/dot`।
6. **প্রোডাক্ট:** প্রোডাক্ট পেজে প্রোডাক্ট যোগ করুন (নাম, দাম, স্টক)। টেক্সট সার্চ: `GET /api/products/search?q=...`। ভয়েস সার্চ এখন ট্রান্সক্রিপ্ট-টেক্সট স্টাব।
7. **অর্ডার:** ইনবক্স বা API থেকে অর্ডার তৈরি করুন — দাম শুধু প্রোডাক্ট টেবিল থেকে নেওয়া হয়। অর্ডার ধাপ: `pending → on_hold → approved → processing → ready_to_ship → in_transit → delivered`। পেমেন্ট ধাপ আলাদা: `unpaid / paid`। অর্ডার ডিটেইল পেজে বাংলা বিল দেখা যায়।
8. **AI এজেন্ট (প্র্যাকটিস মোড):** নতুন ওয়ার্কস্পেসে `practice_mode=true` থাকে — AI শুধু মালিকের টেস্ট মেসেজের উত্তর দেয়। ড্যাশবোর্ড/ API `POST /api/workspaces/:id/go-live` — এক ক্লিকে লাইভ।
9. **টিকেট:** অভিযোগ এলে AI নিজে টিকেট খোলে (কনফিডেন্স কম হলে) বা ড্যাশবোর্ড থেকে টিকেট তৈরি করে স্ট্যাটাস বদলান।
10. **বিলিং:** বিলিং পেজে ব্যালেন্স (৳), ওয়ালেট লেনদেন ও প্রতি AI রিপ্লাইয়ের খরচ (`ai_usage_ledger`) দেখা যায়। বর্তমান হিসাব: প্রতি রিপ্লাই ফ্ল্যাট **১০ পয়সা**। ব্যালেন্স শেষ হলে AI থামে, ইনবক্স চলতে থাকে।

## আসল কী লাগবে, আর কী স্টাব

| জিনিস | অবস্থা |
|---|---|
| Groq API কী (`GROQ_API_KEY`, `AI_PROVIDER=groq`) | **চলছে — ফ্রি, আসল উত্তর দেয়।** চাবি বসানো আছে; প্রতি উত্তরে ০ পয়সা, ওয়ালেট কমে না। মডেল `openai/gpt-oss-20b`। চাবি না থাকলে বা Groq বন্ধ থাকলে "ডেমো AI" লেবেলসহ স্থানীয় উত্তরে চলে যায় (১০ পয়সা/উত্তর)। |
| Gemini API কী (`GEMINI_API_KEY`) | **চাবি আছে, উত্তর দেয়।** নতুন চাবি দিয়ে `gemini-3.5-flash` মডেল আসল উত্তর দেয় (২০২৬-১১-০৭ যাচাই করা)। পুরনো চাবিতে Google-এর ফ্রি ব্যবহার বন্ধ ছিল; `gemini-2.5-flash` নতুন ব্যবহারকারীদের জন্য বন্ধ (404)। ডিফল্ট AI এখনো Groq (ফ্রি), Gemini/ChatGPT শুধু অপশন হিসেবে আছে। |
| Meta Developer অ্যাপ + App Review + Business Verification | **লাগবে, প্রথম সপ্তাহেই আবেদন করুন** — অনুমোদনে কয়েক সপ্তাহ লাগতে পারে। এ ছাড়া Messenger/Instagram লাইভ যাবে না। |
| Meta পেজ টোকেন দিয়ে মেসেজ পাঠানো | **স্টাব** — এজেন্ট সীন/টাইপিং লগ করে ও আউটগোয়িং মেসেজ সেভ করে, কিন্তু Meta Graph API-তে আসল পাঠানো এখনো যুক্ত হয়নি (লাইভ পেজ টোকেন + অনুমোদন লাগবে)। শিডিউল করা পোস্টের আসল প্রকাশও একই কারণে স্টাব (`stub-<uuid>` আইডি)। |
| WhatsApp Cloud API অনুমোদন (`WHATSAPP_APPROVED`) | **লাগবে** — না পাওয়া পর্যন্ত WhatsApp চ্যানেল `pending_approval` থাকে; webhook যাচাই কাজ করে। |
| TikTok API অনুমোদন + পোস্ট অডিট (`TIKTOK_COMMENTS_APPROVED`, `TIKTOK_SCHEDULING_AUDITED`) | **লাগবে** — অডিট না পাস করলে TikTok পোস্ট শুধু প্রাইভেট দেখাবে, তাই অ্যাপ প্রকাশই করে না। TikTok DM-এর জন্য আলাদা অনুমোদন লাগবে (`TIKTOK_DM_APPROVED`) — না পাওয়া পর্যন্ত DM চ্যানেল `pending_approval`, DM এলে ৪০৩। |
| ছবি দিয়ে প্রোডাক্ট মেলানো (`EMBEDDING_PROVIDER=openai-compatible` + `EMBEDDING_API_URL`/`EMBEDDING_API_KEY`/`EMBEDDING_MODEL`) | **চাবি থাকলে চলে, না থাকলে স্টাব** — embedding সার্ভিসের চাবি লাগবে (multimodal/CLIP এন্ডপয়েন্ট)। এখন চাবি নেই, তাই ছবি পাঠালে AI "ছবি দিয়ে খোঁজা চালু হয়নি" বলে, ভুয়া মিল দেখায় না। |
| Chrome এক্সটেনশন | **বানানো হয়েছে** (`chrome-extension/`, Manifest v3) — Chrome-এ unpacked হিসেবে লোড করে ব্যবহার করা যায়। |
| ভয়েস সার্চ | **স্টাব** — ট্রান্সক্রিপ্ট টেক্সট হিসেবে সার্চ হয়, কোনো STT প্রোভাইডার যুক্ত নয়। |
| পেমেন্ট গেটওয়ে (bKash/Nagad/কার্ড) | **লাইভ গেটওয়ে নেই** — ম্যানুয়াল টপ-আপ চলে (অনুরোধ → টিমের অনুমোদন → ওয়ালেটে টাকা)। লাইভ গেটওয়ের জন্য bKash/Nagad মার্চেন্টের তথ্য লাগবে। |
| কুরিয়ার বুকিং/ট্র্যাকিং | **স্টাব** — বুকিং লোকালে সেভ হয়, ট্র্যাকিং নম্বর আসে না। আসল বুকিংয়ের জন্য Pathao/Steadfast/RedX মার্চেন্ট অ্যাকাউন্ট + API চাবি লাগবে। |
| সাবস্ক্রিপশন প্ল্যানের দাম | **প্রস্তাবিত দাম** (ছোট ৳৪৯৯ / মাঝারি ৳৯৯৯ / বড় ৳১৯৯৯ প্রতি মাস) — মালিকের চূড়ান্ত সিদ্ধান্ত নয়; বদলাতে চাইলে `plans` টেবিলের সিড (`04-subscriptions.sql`) আর `config/index.ts`-এর `suggestedPlans` বদলাতে হয়। |
| কুপন | **কাজ করে** — শতাংশ/টাকা/ফ্রি ডেলিভারি কুপন বানানো, যাচাই ও অর্ডারে লাগানো যায়। ছাড় কখনো বানিয়ে বলা হয় না। |
| পার্সেল ট্র্যাকিং | `shipments` টেবিলে থাকলে দেখায়, না থাকলে "এখনো সংযুক্ত নয়" জানায় — কুরিয়ার বুকিং এখনো আসেনি। |

## AI এজেন্টের কড়া নিয়ম (প্ল্যানের সেকশন ৫)

- AI সরাসরি ডাটাবেসে লেখে না — শুধু এই ১১টি টুল কল করতে পারে: `search_products`, `send_product_cards`, `create_order`, `update_order`, `apply_coupon`, `check_stock`, `track_parcel`, `create_ticket`, `create_lead`, `search_knowledge`, `match_product_by_image` (ছবি মেলানো — embedding সার্ভিস না থাকলে "চালু নেই" বলে)।
- অর্ডার হলে স্টক নিজে থেকে কমে (AI অর্ডার ও হাতে অর্ডার — দুটোতেই); স্টক ০ হলে টিমের জন্য নোট লেখা হয়।
- দাম, স্টক, ডিসকাউন্ট, ডেলিভারির সময় **কখনো বানিয়ে বলা যাবে না** — শুধু টুলের ফলাফল থেকে।
- কনফিডেন্স ০–১ স্কোরে; **০.৬-এর নিচে হলে উত্তর না দিয়ে মানুষের কাছে টিকেট** যায়।
- উত্তর দিতে না পারা প্রশ্ন `unanswered_questions`-এ জমা হয়।
- কনফার্মের পরের অর্ডার বদলাতে চাইলে AI নিজে বদলায় না — অনুরোধ লিখে টিমকে দেয়।

## ফেজ ১ গেট চেকলিস্ট (আসল দোকানে যাওয়ার আগে)

- [ ] ৫টি বাস্তব ব্যবসায় টেস্ট করা হয়েছে
- [ ] AI উত্তরে ভুল দাম বা ভুল স্টক: **০ বার**
- [ ] গড় খরচ প্রতি রিপ্লাই: **২০ পয়সার নিচে**
- [ ] Meta অনুমোদন পাওয়া গেছে (Messenger, Instagram, Facebook কমেন্ট)
- [ ] ১০০০টি বাস্তব মেসেজ দিয়ে গড় খরচ মেপে দাম ঠিক করা হয়েছে

গেট না মিললে আসল দোকানে ব্যবহার শুরু করা যাবে না। ফেজ ২/৩-এর কোড বানানো শেষ —
এই গেটগুলো এখন আসল ব্যবহারের আগের শর্ত, ফেজ ২ শুরু করার শর্ত নয়।

## যাচাই (সব পাস)

```bash
./scripts/run-local.sh   # API :4000, ওয়েব :3000
node scripts/verify-e2e.mjs             # ৭৩/৭৩ পাস (ফেজ ১: ২৯, ফেজ ২/৩: ৪৪)
node scripts/verify-subscriptions.mjs   # ৪৩/৪৩ পাস (API-টি ALLOW_SUBSCRIPTION_TEST_HOOKS=true দিয়ে চালু করতে হয়)
node scripts/verify-post-attribution.mjs # ১৬/১৬ পাস
node scripts/verify-courier-topup.mjs   # ২৪/২৪ পাস
node scripts/verify-tiktok-embeddings.mjs # ৬১/৬১ পাস (TikTok DM + এমবেডিং + এক্সটেনশন)
# ডেটা মুছে ফেলার এন্ডপয়েন্ট (POST /api/meta/data-deletion): হাতে পরীক্ষা করা —
# ভুল সইয়ে ৪০৩, ঠিক সইয়ে ২০০ + confirmation_code, তথ্য মুছে যায়।
```

## ফাইল কাঠামো (সংক্ষেপে)

```
ai-sales-inbox/
├── schema.sql                  # ২৬টি টেবিল (PostgreSQL + pgvector)
├── phase-1-plan.md             # ফেজ ১ পরিকল্পনা ও টাস্ক তালিকা
├── README.md                   # এই ফাইল
├── RUNNING.md                  # চালানো, নতুন ফিচার, অনুমোদনের তালিকা (বাংলা)
├── docs/
│   └── chrome-extension-plan.md  # Chrome এক্সটেনশনের পরিকল্পনা (এক্সটেনশনটি এখন chrome-extension/-এ বানানো হয়েছে)
├── chrome-extension/           # Chrome এক্সটেনশন (Manifest v3, পপআপ, কনটেন্ট স্ক্রিপ্ট, বাংলা README)
├── meta-approval/              # Meta App Review প্যাক (প্রাইভেসি পলিসি, চেকলিস্ট, ডেটা মুছে ফেলার নিয়ম)
├── scripts/
│   ├── verify-e2e.mjs verify-subscriptions.mjs verify-post-attribution.mjs
│   ├── verify-courier-topup.mjs verify-tiktok-embeddings.mjs  # যাচাইয়ের স্ক্রিপ্ট
├── infra/
│   ├── docker-compose.yml      # postgres + redis + minio
│   └── .env.example
├── apps/
│   ├── api/                    # Express + TypeScript API
│   │   └── src/
│   │       ├── config/         # AI_MODEL এখানেই (আর কোথাও নয়)
│   │       ├── ai-agent/       # agent, gemini, groq, tools, prompts, image-match
│   │       ├── auth/ channels/ webhooks/ inbox/
│   │       ├── products/ orders/ tickets/ billing/ knowledge/
│   │       ├── coupons/ customers/ comments/   # ফেজ ২
│   │       ├── scheduling/ leads/ followups/ analytics/  # ফেজ ২
│   │       ├── broadcasts/ bookings/ reviews/ migration/ feature-requests/  # ফেজ ৩
│   │       ├── subscriptions/ courier/  # সাবস্ক্রিপশন, কুরিয়ার + ম্যানুয়াল টপ-আপ
│   │       ├── db/migrations/  # 01–07 — ফেজ ২/৩ + সাবস্ক্রিপশন/অ্যাট্রিবিউশন/কুরিয়ার/ডেটা-ডিলিশন
│   │       └── queue/          # BullMQ ক্লায়েন্ট (ডিবাউন্স)
│   └── web/                    # Next.js + Tailwind ড্যাশবোর্ড
└── workers/queue/              # BullMQ worker (inbox + scheduled-posts)
```
