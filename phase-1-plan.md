# AI সেলস ইনবক্স প্ল্যাটফর্ম — ফেজ ১ (MVP) শুরুর ৩টি জিনিস

উৎস: AI.pdf সেকশন ২, ৭, ৯ ও ১১। শুধু ফেজ ১ বানানো হবে। ফেজ ২ ও ৩ এখন নয়, তবে কোড এমনভাবে লেখা হবে যাতে পরে যোগ করা যায়।

## ১. প্রজেক্টের ফোল্ডার কাঠামো

```
ai-sales-inbox/
├── apps/
│   ├── web/                  # Next.js + Tailwind — ড্যাশবোর্ড, প্রোডাক্ট পেজ, অর্ডার পেজ
│   │   ├── app/
│   │   │   ├── (auth)/       # সাইন আপ / লগইন
│   │   │   ├── inbox/        # ইউনিফাইড ইনবক্স
│   │   │   ├── products/     # প্রোডাক্ট ক্যাটালগ
│   │   │   ├── orders/       # অর্ডার তালিকা ও স্ট্যাটাস পেজ
│   │   │   ├── tickets/      # সাপোর্ট টিকেট
│   │   │   └── billing/      # ওয়ালেট, ফ্রি ক্রেডিট, খরচের লেজার
│   │   └── components/
│   └── api/                  # Node.js (TypeScript) + NestJS — API, Webhook, AI এজেন্ট
│       ├── src/
│       │   ├── config/       # AI মডেলের নাম এখানে: gemini-2.5-flash
│       │   ├── auth/
│       │   ├── workspaces/
│       │   ├── channels/     # Messenger, Facebook কমেন্ট, Instagram, ওয়েব লাইভ চ্যাট
│       │   ├── inbox/
│       │   ├── ai-agent/     # Gemini কল, কনফিডেন্স চেক, টুল কল
│       │   ├── products/
│       │   ├── orders/
│       │   ├── tickets/
│       │   ├── billing/      # wallet, ai_usage_ledger
│       │   └── webhooks/     # ডুপ্লিকেট মেসেজ আটকানো
│       └── test/
├── packages/
│   ├── db/                   # Prisma/Drizzle স্কিমা — schema.sql এখান থেকে আসবে
│   └── shared/               # টাইপ, কনস্ট্যান্ট
├── workers/
│   └── queue/                # Redis + BullMQ — মেসেজ কিউ, ডিবাউন্স, শিডিউল জব
├── infra/
│   ├── docker-compose.yml    # PostgreSQL + pgvector, Redis, S3-সামঞ্জস্যপূর্ণ স্টোরেজ
│   └── .env.example
├── schema.sql                # পূর্ণ ডাটাবেস স্কিমা (সেকশন ৭)
└── README.md
```

## ২. ডাটাবেস স্কিমা

`schema.sql` ফাইলে দেওয়া আছে — ২৭টি টেবিল:
workspaces, users, members, channels, customers, conversations, messages, comments, notes, products, product_images, knowledge_items, unanswered_questions, orders, order_items, order_events, coupons, shipments, leads, followups, tickets, scheduled_posts, post_products, ai_usage_ledger, wallet_transactions, webhook_events।

প্রতিটি টেবিলে `workspace_id`, `id`, `created_at`, `updated_at` আছে। চ্যানেলের টোকেন এনক্রিপ্ট করে রাখতে হবে। AI সরাসরি ডাটাবেসে লিখবে না — শুধু সেকশন ৫-এর টুলগুলো কল করতে পারবে।

## ৩. ফেজ ১ (MVP) — ছোট ছোট কাজের তালিকা

লক্ষ্য: একজন বিক্রেতা Facebook ও Instagram-এ AI দিয়ে অর্ডার নিতে পারবে। সময়: ৬–৮ সপ্তাহ।

### সপ্তাহ ১ — সেটআপ ও অনুমোদন
1. প্রজেক্ট সেটআপ, ফোল্ডার কাঠামো, Docker (Postgres + pgvector, Redis)
2. ডাটাবেস স্কিমা চালানো, মাইগ্রেশন
3. Meta Developer অ্যাপ, App Review ও Business Verification-এর আবেদন — প্রথম সপ্তাহেই
4. Gemini API কী, মডেলের নাম কনফিগে রাখা

### সপ্তাহ ২–৩ — অ্যাকাউন্ট ও ইনবক্স
5. সাইন আপ, লগইন, ওয়ার্কস্পেস, টিম সদস্য
6. Messenger, Facebook কমেন্ট, Instagram ও ওয়েব লাইভ চ্যাট সংযোগ
7. ইউনিফাইড ইনবক্স, সার্চ (নাম, ফোন, অর্ডার নম্বর, চ্যাটের শব্দ), অ্যাসাইন
8. চ্যাট "সম্পন্ন" করা, কাস্টমার প্রোফাইল, ডট (.) দিয়ে মানুষ নেওয়া ও ফেরা

### সপ্তাহ ৪–৫ — প্রোডাক্ট ও AI এজেন্ট
9. প্রোডাক্ট ক্যাটালগ, প্রোডাক্ট কার্ড, প্রোডাক্ট পেজ, টেক্সট ও ভয়েস সার্চ
10. AI এজেন্ট: মেসেজ ব্যাচ (ডিবাউন্স), সীন/টাইপিং, কনফিডেন্স স্কোর, নলেজ বুক
11. প্র্যাকটিস মোড — শুরুতে শুধু মালিকের টেস্ট মেসেজের উত্তর, এক ক্লিকে লাইভ
12. AI টুল: search_products, send_product_cards, create_order, update_order, apply_coupon, check_stock, track_parcel, create_ticket, create_lead, search_knowledge

### সপ্তাহ ৬ — অর্ডার ও বিলিং
13. অর্ডার তৈরি, চ্যাটে বিল, অর্ডার স্ট্যাটাস পেজ, অর্ডার ধাপ
14. সাপোর্ট টিকেট ও হ্যান্ডঅফ
15. ওয়ালেট, ফ্রি ক্রেডিট, প্রতি AI রিপ্লাইয়ের খরচ ai_usage_ledger-এ লেখা

### সপ্তাহ ৭–৮ — টেস্ট ও গেট
16. ৫টি বাস্তব ব্যবসায় টেস্ট
17. গেট: AI উত্তরে ভুল দাম বা ভুল স্টক ০ বার; গড় খরচ প্রতি রিপ্লাই ২০ পয়সার নিচে
18. গেট না মিললে ফেজ ২-তে যাওয়া যাবে না

## মনে রাখার ঝুঁকি
- Meta অনুমোদনে কয়েক সপ্তাহ লাগতে পারে — আবেদন দেরি করলে পুরো প্ল্যান আটকে যাবে।
- Gemini 2.0 Flash পুরোনো মডেল — মডেলের নাম কনফিগে রাখা, যাতে এক লাইনে বদলানো যায়।
- দাম, স্টক, ডিসকাউন্ট কখনো বানিয়ে বলা যাবে না — শুধু টুলের ফলাফল থেকে।
