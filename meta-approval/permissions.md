# অনুমতি (Permissions) — AI Sales Inbox

> **সততার নোট (আগে পড়ুন):** কোডে Meta-র অনুমতির নাম (যেমন
> `pages_messaging`) কোথাও লেখা নেই। নিচের তালিকাটা কোড আসলে যা করে,
> সেটা দেখে বানানো হয়েছে — webhook-এ আসা ইভেন্ট (`apps/api/src/webhooks/routes.ts`)
> আর কোডের মন্তব্যে লেখা পরিকল্পিত Graph API কল (`apps/api/src/ai-agent/agent.ts`-এ
> লেখা আছে: `POST /{page-id}/messages` আর `POST /{ig-user-id}/messages`;
> `apps/api/src/scheduling/publisher.ts`-এ লেখা আছে: Facebook/Instagram পোস্ট
> প্রকাশে অনুমোদিত Page টোকেনসহ Graph API কল লাগবে)।
>
> প্রতিটি অনুমতির পাশে লেখা আছে সেটা **"কোড থেকে নিশ্চিত"** নাকি
> **"অনুমান — জমা দেওয়ার আগে যাচাই করুন"**। অনুমান লেখা অনুমতিগুলো
> Meta-র অফিসিয়াল ডকুমেন্টেশনে ওই কাজের জন্য যেটা লাগে, সেটাই লেখা হয়েছে।

প্রতিটি অনুমতির নিচে **"Meta-কে যা লিখবেন (ইংরেজি)"** অংশটা App Review-এর
ফর্মে হুবহু কপি-পেস্ট করবেন। বাংলা অংশ নিজের বোঝার জন্য।

---

## ১. `pages_messaging` — ✅ কোড থেকে নিশ্চিত

**কী কাজে লাগে:** বিক্রেতার Facebook Page-এ আসা Messenger মেসেজ পড়া ও
সেই মেসেজের উত্তর পাঠানো।

**কোডে কোথায়:** `webhooks/routes.ts` — `entry.messaging[]` ইভেন্ট পড়ে
(`message.text`); `ai-agent/agent.ts` — উত্তরের জন্য পরিকল্পিত কল
`POST /{page-id}/messages` (এখন stub — লগে লেখা হয়, অনুমোদন পেলে আসল
পাঠানো চালু হবে)।

**Meta-কে যা লিখবেন (ইংরেজি):**

> Our app provides a unified inbox for online sellers. When a buyer sends a
> message to a seller's Facebook Page, we receive it via webhook and show it
> in the seller's inbox. Our AI sales assistant drafts a reply using only the
> seller's own product catalogue (real prices and stock), and the seller or
> the AI sends the reply back to the buyer through the Messenger API. Without
> this permission, sellers cannot receive or answer their Page messages in
> our app at all.

**বাংলা ব্যাখ্যা:** ক্রেতা Page-এ মেসেজ করলে সেটা ইনবক্সে আসে, AI বা
বিক্রেতা তার উত্তর দেয়। এই অনুমতি না থাকলে Messenger-এর কিছুই চলবে না —
ইনবক্স খালি থাকবে।

**এই অনুমতি না থাকলে যা বন্ধ হয়ে যাবে:** Messenger ইনবক্স, AI-এর Messenger
উত্তর, Messenger থেকে অর্ডার নেওয়া — সব।

---

## ২. `instagram_basic` — ✅ কোড থেকে নিশ্চিত

**কী কাজে লাগে:** বিক্রেতার Instagram অ্যাকাউন্টের পরিচয় (অ্যাকাউন্ট ID,
নাম) পড়া — যাতে Instagram থেকে আসা মেসেজ সঠিক বিক্রেতার ইনবক্সে যায়।
Instagram মেসেজিং চালাতে Meta-র নিয়মে এই বেসিক অনুমতিটা
`instagram_manage_messages`-এর সাথে লাগে।

**কোডে কোথায়:** `webhooks/routes.ts` — `body.object === 'instagram'` হলে
ইভেন্ট Instagram হিসেবে চেনা হয়; চ্যানেল Instagram অ্যাকাউন্ট ID দিয়ে
খোঁজা হয় (`findChannelByExternalId('instagram', ...)`); `channels/routes.ts` —
`platform: instagram` চ্যানেল হিসেবে যুক্ত হয়।

**Meta-কে যা লিখবেন (ইংরেজি):**

> Our app connects a seller's Instagram account so their Instagram direct
> messages appear in the same inbox as their Facebook messages. We use
> instagram_basic only to identify the connected Instagram account (account
> ID and name) so incoming messages are routed to the correct seller's
> workspace. We do not read the seller's feed, followers, or media. Without
> it, Instagram messaging cannot work, because the app cannot identify which
> Instagram account a message belongs to.

**বাংলা ব্যাখ্যা:** Instagram অ্যাকাউন্টটা চেনার জন্য — কোন মেসেজ কোন
বিক্রেতার, সেটা বোঝার জন্য। ফিড বা ফলোয়ার পড়া হয় না।

**এই অনুমতি না থাকলে যা বন্ধ হয়ে যাবে:** Instagram ইনবক্স পুরোপুরি।

---

## ৩. `instagram_manage_messages` — ✅ কোড থেকে নিশ্চিত

**কী কাজে লাগে:** বিক্রেতার Instagram-এ আসা ডাইরেক্ট মেসেজ পড়া ও তার
উত্তর পাঠানো।

**কোডে কোথায়:** `webhooks/routes.ts` — Instagram `entry.messaging[]`
ইভেন্ট পড়ে; `ai-agent/agent.ts` — উত্তরের জন্য পরিকল্পিত কল
`POST /{ig-user-id}/messages` (এখন stub — অনুমোদন পেলে আসল পাঠানো চালু হবে)।

**Meta-কে যা লিখবেন (ইংরেজি):**

> When a buyer sends a direct message to a seller's Instagram account, we
> receive it via webhook and show it in the seller's unified inbox. Our AI
> sales assistant drafts a reply using only the seller's own product
> catalogue (real prices and stock), and the reply is sent back to the buyer
> through the Instagram messaging API. Without this permission, sellers
> cannot receive or answer Instagram direct messages in our app.

**বাংলা ব্যাখ্যা:** Instagram-এ ক্রেতার মেসেজ পড়া ও উত্তর দেওয়া — ঠিক
Messenger-এর মতো।

**এই অনুমতি না থাকলে যা বন্ধ হয়ে যাবে:** Instagram মেসেজ পড়া ও উত্তর,
Instagram থেকে অর্ডার নেওয়া — সব।

---

## ৪. `pages_read_engagement` — ✅ কোড থেকে নিশ্চিত

**কী কাজে লাগে:** বিক্রেতার Facebook Page-এর পোস্টে করা কমেন্ট পড়া —
যাতে কমেন্টে করা প্রশ্নের (যেমন "দাম কত?") উত্তর ইনবক্স থেকে দেওয়া যায়।

**কোডে কোথায়:** `webhooks/routes.ts` — `entry.changes[]`-এ `field === 'feed'`
আর `value.item === 'comment'` হলে কমেন্ট `comments` টেবিলে রাখা হয় আর
কনভারসেশনে মেসেজ হিসেবে সেভ হয়।

**Meta-কে যা লিখবেন (ইংরেজি):**

> Sellers in Bangladesh get many questions as comments on their Facebook
> Page posts (for example "what is the price?"). We receive these comments
> via webhook, store them, and show them in the seller's inbox as a
> conversation, so the seller or the AI assistant can reply. We only read
> comments on Pages the seller connected. Without this permission, comments
> never reach the inbox and sellers miss buyers who ask questions publicly
> instead of messaging.

**বাংলা ব্যাখ্যা:** পোস্টের কমেন্ট পড়ে ইনবক্সে আনা — কমেন্টে "দাম কত?"
লিখলে বিক্রেতা সেটার উত্তর দিতে পারেন।

**এই অনুমতি না থাকলে যা বন্ধ হয়ে যাবে:** কমেন্ট ইনবক্স, কমেন্ট থেকে
কনভারসেশন, কমেন্টের প্রোডাক্ট ক্যারোসেল।

---

## ৫. `pages_manage_posts` — ✅ কোড থেকে নিশ্চিত (পোস্ট প্রকাশের জন্য)

**কী কাজে লাগে:** বিক্রেতা ড্যাশবোর্ডে বানিয়ে শিডিউল করা পোস্ট সময় হলে
তার Facebook Page-এ প্রকাশ করা।

**কোডে কোথায়:** `scheduling/publisher.ts` — শিডিউল করা পোস্ট প্রকাশের
কোড (এখন stub — মন্তব্যে লেখা আছে আসল প্রকাশে অনুমোদিত Page টোকেনসহ
Meta Graph API কল লাগবে); `scheduling/routes.ts` — `publish-now` এন্ডপয়েন্ট।

**Meta-কে যা লিখবেন (ইংরেজি):**

> Sellers create posts (caption, photo, linked products) in our dashboard
> and schedule them for a date and time. At the scheduled time our app
> publishes the post to the seller's own Facebook Page through the Graph
> API, using the Page token the seller provided. Posts are only published to
> Pages the seller connected, and only posts the seller created and
> scheduled. Without this permission, scheduled Facebook posts cannot be
> published and sellers must post manually.

**বাংলা ব্যাখ্যা:** শিডিউল করা পোস্ট সময় হলে Page-এ প্রকাশ করা। বিক্রেতা
নিজে যা বানিয়েছে, শুধু সেটাই প্রকাশ হয়।

**এই অনুমতি না থাকলে যা বন্ধ হয়ে যাবে:** Facebook-এ পোস্ট শিডিউল ও প্রকাশ।

---

## ৬. `instagram_content_publish` — ⚠️ অনুমান — জমা দেওয়ার আগে যাচাই করুন

**কী কাজে লাগে:** শিডিউল করা পোস্ট বিক্রেতার Instagram অ্যাকাউন্টে প্রকাশ করা।

**কেন এটা অনুমান:** কোডে `scheduling/routes.ts`-এ পোস্টের প্ল্যাটফর্ম হিসেবে
`instagram` বেছে নেওয়া যায়, আর `publisher.ts`-এ লেখা আছে Instagram-এ
আসল প্রকাশে Graph API কল লাগবে — কিন্তু কোডে এই অনুমতির নাম কোথাও লেখা
নেই। Instagram-এ মিডিয়া প্রকাশ করতে Meta-র নিয়মে এই অনুমতিটাই লাগে
(`instagram_basic`-এর সাথে)। আবেদন জমা দেওয়ার সময় Meta-র ডকুমেন্টেশনে
একবার মিলিয়ে নেবেন।

**Meta-কে যা লিখবেন (ইংরেজি):**

> Sellers create posts (caption, photo, linked products) in our dashboard
> and schedule them for a date and time. At the scheduled time our app
> publishes the post to the seller's own Instagram account through the
> Instagram Graph API, using the account the seller connected. Posts are
> only published to accounts the seller connected, and only posts the seller
> created and scheduled. Without this permission, scheduled Instagram posts
> cannot be published (Facebook posts use pages_manage_posts).

**বাংলা ব্যাখ্যা:** শিডিউল করা পোস্ট সময় হলে Instagram-এ প্রকাশ করা।

**এই অনুমতি না থাকলে যা বন্ধ হয়ে যাবে:** Instagram-এ পোস্ট শিডিউল ও প্রকাশ
(Facebook পোস্ট চলবে, Instagram পোস্ট চলবে না)।

---

## ৭. `pages_manage_engagement` — ⚠️ অনুমান — জমা দেওয়ার আগে যাচাই করুন

**কী কাজে লাগে:** Facebook Page-এর পোস্টের কমেন্টের উত্তর Page হিসেবে
লেখা (কমেন্টে রিপ্লাই করা)।

**কেন এটা অনুমান:** কোডে কমেন্টের উত্তর দেওয়ার ফিচার আছে
(`comments/routes.ts` — `POST /api/comments/:id/reply`) — কিন্তু এখন সেটা
শুধু উত্তরটা ইনবক্সে 'out' মেসেজ হিসেবে সেভ করে; Facebook-এ আসল কমেন্ট
রিপ্লাই পাঠানোর Graph API কল এখনো কোডে বসানো হয়নি। তাই এই অনুমতিটা
আসল রিপ্লাই চালু করার সময় লাগবে। প্রথম আবেদনে এটা চাইলে Meta ভিডিওতে
আসল কমেন্ট রিপ্লাই দেখতে চাইতে পারে — তাই হয় (ক) আবেদনে এটা রাখুন আর
ভিডিওতে ইনবক্স থেকে কমেন্টের উত্তর দেখান, অথবা (খ) প্রথম আবেদনে এটা
বাদ দিয়ে শুধু কমেন্ট *পড়া* (`pages_read_engagement`) নিন, আর আসল
রিপ্লাই কোডে বসার পর এই অনুমতি আলাদা করে চান।

**Meta-কে যা লিখবেন (ইংরেজি):**

> When a buyer asks a question as a comment on a seller's Page post, the
> seller answers from our inbox. The reply is posted as a comment reply from
> the seller's own Page, so the buyer sees the answer under their comment.
> Without this permission, sellers can read comments in our inbox but cannot
> reply to them from the app — they must open Facebook separately for every
> comment.

**বাংলা ব্যাখ্যা:** কমেন্টের উত্তর Page হিসেবে কমেন্টে লেখা।

**এই অনুমতি না থাকলে যা বন্ধ হয়ে যাবে:** ইনবক্স থেকে কমেন্টের উত্তর
(কমেন্ট পড়া যাবে, উত্তর দেওয়া যাবে না)।

---

## আমরা যা চাইছি না (ইচ্ছা করে বাদ দেওয়া)

| অনুমতি | কেন চাইছি না |
|---|---|
| `email`, `public_profile` (Facebook লগইন) | বিক্রেতা ইমেইল+পাসওয়ার্ড দিয়ে লগইন করে; Facebook দিয়ে লগইন করাই না |
| `business_management` | অ্যাপ চালাতে Business অ্যাকাউন্ট ম্যানেজ করার দরকার নেই |
| `whatsapp_business_messaging` | WhatsApp আলাদা অনুমোদন (Cloud API) — এই Meta আবেদনের অংশ নয়; কোডে WhatsApp চ্যানেল `pending_approval` থাকে |
| `ads_read` / `ads_management` | অ্যাপ বিজ্ঞাপন চালায় না, বিজ্ঞাপনের তথ্য পড়ে না |
| `user_friends`, `user_posts` | ক্রেতাদের ব্যক্তিগত প্রোফাইল বা বন্ধুদের তথ্য পড়ি না |

---

## জমা দেওয়ার সময় মনে রাখবেন

- প্রতিটি অনুমতির ফর্মে উপরের ইংরেজি লেখাটা বসান।
- Screencast ভিডিওতে প্রতিটি অনুমতির কাজটা আলাদা করে দেখান
  (`screencast-script.md` দেখুন) — Meta ভিডিও দেখেই বোঝে অনুমতিটা সত্যিই
  লাগবে কি না।
- শুধু যা লাগবে তাই চান — বেশি অনুমতি চাইলে Meta সন্দেহ করে।
