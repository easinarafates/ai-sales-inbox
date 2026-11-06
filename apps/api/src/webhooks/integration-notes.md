# Integration notes — TikTok DM + real embeddings (integrator: paste these)

> এই ফাইলে যা যা আছে, তা **ইন্টিগ্রেটর** করবে। TikTok DM রাউটার, আসল
> embeddings প্রোভাইডার, আর Chrome এক্সটেনশন — এই তিনটির কোড বানানো
> শেষ। নিচের লাইনগুলো না বসানো পর্যন্ত TikTok DM-এর রুট চালু হবে না
> (404 আসবে) আর `tiktok_dm` চ্যানেল বানানো যাবে না (400 আসবে)।
> Embeddings-এর wiring (image-match → আসল প্রোভাইডার) আর config-এর
> নতুন ফ্ল্যাগগুলো **আগেই বসানো আছে** — সেগুলো আবার বসাতে হবে না।

## ১. Router mount — `apps/api/src/index.ts` (২ জায়গা)

**(ক) import-এর পাশে যোগ করুন** (webhooksRouter-এর import-এর ঠিক পরে):

```ts
import { tiktokDmRouter } from './webhooks/tiktok-dm';
```

**(খ) webhook mount-এর ঠিক পরে যোগ করুন:**

```ts
// Webhooks are public (Meta verifies with META_VERIFY_TOKEN; webchat with WEBCHAT_SECRET).
app.use('/api/webhooks', webhooksRouter);
app.use('/api/webhooks', tiktokDmRouter); // TikTok DM: GET/POST /api/webhooks/tiktok-dm
```

> রুট: `GET /api/webhooks/tiktok-dm` (verify handshake),
> `POST /api/webhooks/tiktok-dm` (DM receiver)। রাউটার নিজেই
> `TIKTOK_DM_APPROVED` গেট চেক করে — অনুমোদন না থাকলে POST 403 দেয়,
> কিছু সংরক্ষণ করে না।

## ২. Channel registration — `apps/api/src/channels/routes.ts` (২ জায়গা)

**(ক) `PLATFORMS`-এ যোগ করুন:**

```ts
const PLATFORMS = ['messenger', 'facebook_comment', 'instagram', 'webchat', 'whatsapp', 'tiktok', 'tiktok_dm'] as const;
```

**(খ) `APPROVAL_GATED`-এ যোগ করুন:**

```ts
const APPROVAL_GATED: Record<string, boolean> = {
  whatsapp: config.whatsappApproved,
  tiktok: config.tiktokCommentsApproved,
  tiktok_dm: config.tiktokDmApproved,
};
```

> এরপর `POST /api/channels { platform: 'tiktok_dm', ... }` অনুমোদন না
> থাকলে `pending_approval` দেবে (আর অনুমোদন থাকলে `connected`) —
> WhatsApp/TikTok কমেন্টের মতোই।

## ৩. Config — ইতিমধ্যে বসানো আছে (কিছু করতে হবে না)

`apps/api/src/config/index.ts`-এ এগুলো **আগেই যোগ করা হয়েছে**:

- `tiktokDmApproved` (`TIKTOK_DM_APPROVED === 'true'`, ডিফল্ট false)
- `tiktokDmVerifyToken` (`TIKTOK_DM_VERIFY_TOKEN`, না থাকলে `META_VERIFY_TOKEN`)
- `embeddingApiUrl` / `embeddingApiKey` / `embeddingModel`
  (`EMBEDDING_API_URL` / `EMBEDDING_API_KEY` / `EMBEDDING_MODEL`)

## ৪. Image-match wiring — ইতিমধ্যে বসানো আছে (কিছু করতে হবে না)

`apps/api/src/ai-agent/image-match.ts`-এর `getEmbeddingProvider()` এখন:

- `EMBEDDING_PROVIDER=openai-compatible` **আর** URL + key + model —
  তিনটিই থাকলে `OpenAICompatibleEmbeddingProvider`
  (`apps/api/src/ai-agent/embeddings-openai.ts`) ব্যবহার করে।
- নইলে (unset / `stub` / অসম্পূর্ণ কনফিগ) stub-ই থাকে —
  `available: false`, "ছবি দিয়ে খোঁজা এখনো চালু হয়নি"।
- `≥0.75` certain-only নিয়ম অপরিবর্তিত। চাবি কোথাও লগ হয় না।

## ৫. `.env`-এ যোগ করার মতো (আসল মান `.env`-এই থাকবে, কোডে নয়)

```env
# TikTok DM — TikTok অনুমোদন না দেওয়া পর্যন্ত false-ই রাখুন।
TIKTOK_DM_APPROVED=false
# ঐচ্ছিক: DM webhook-এর আলাদা verify token; না দিলে META_VERIFY_TOKEN চলে।
TIKTOK_DM_VERIFY_TOKEN=

# আসল ছবি-খোঁজা (image search) — তিনটিই লাগবে, নইলে stub চলবে।
EMBEDDING_PROVIDER=openai-compatible
EMBEDDING_API_URL=https://api.example.com/v1
EMBEDDING_API_KEY=
EMBEDDING_MODEL=
```

> `EMBEDDING_API_URL` হলো API base (শেষে `/embeddings` থাকলে সেটাই
> ব্যবহার হয়, না থাকলে যোগ করা হয়)। এন্ডপয়েন্টটি **multimodal/CLIP**
> হতে হবে — ছবির URL `input` হিসেবে নেয় এমন (যেমন Jina AI
> `jina-clip-v2`, Voyage `voyage-multimodal-3`, বা নিজের CLIP সার্ভার)।
> শুধু-টেক্সট এন্ডপয়েন্ট ছবিতে এরর দেবে, তখন stub-এর মতোই
> `available: false` আসবে — ভুয়া মিল কখনো দেখানো হবে না।

## ৬. DB migration — লাগবে না

TikTok DM নতুন টেবিল ব্যবহার করে না — `webhook_events`, `customers`,
`conversations`, `messages`, `channels` টেবিলই ব্যবহার করে।
`schema.sql` বা মাইগ্রেশনে কিছু যোগ করতে হবে না।

## ৭. Chrome এক্সটেনশন — ইন্টিগ্রেশন লাগে না

`chrome-extension/` নিজে থেকেই সম্পূর্ণ (manifest v3, popup, content
script, আইকন, বাংলা README)। ব্যবহারকারীকে শুধু unpacked হিসেবে লোড
করতে হবে — README-তে নিয়ম লেখা আছে। API-তে কিছু বসাতে হবে না।

## ৮. যাচাই (ইন্টিগ্রেশনের পর আবার চালান)

```bash
cd apps/api && npm run build
node scripts/verify-tiktok-embeddings.mjs   # API :4000 চালু থাকতে হবে
```

সব চেক পাস হলে: TikTok DM চ্যানেল `pending_approval`, অনুমোদন ছাড়া
DM 403, embeddings stub ডিফল্ট, আর এক্সটেনশনের সব ফাইল উপস্থিত।
