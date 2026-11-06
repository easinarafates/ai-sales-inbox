# Module A — Phase 2 Backend Core: API Contract

> সব রুটে JWT `requireAuth` লাগে; প্রতিটি কোয়েরি `workspace_id` দিয়ে ফিল্টার করে।
> দাম, স্টক ও ছাড় শুধু ডাটাবেজের টেবিল থেকে আসে — কখনো বানিয়ে বলা হয় না।
> এই রাউটারগুলো কোঅর্ডিনেটর `/api`-তে মাউন্ট করবে
> (`couponsRouter`, `customersRouter`, `commentsRouter`); নিচের সব পাথ `/api`-র সাপেক্ষে।

## চ্যানেল — WhatsApp / TikTok (অনুমোদন-নির্ভর)

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/channels` | `{platform: 'whatsapp' \| 'tiktok', externalId, displayName?, token?}` | অনুমোদন থাকলে `201 {channel}` (status `connected`); অনুমোদন না থাকলে `201 {channel, status: 'pending_approval', approvalRequired: true, message}` — চ্যানেলটি `pending_approval` অবস্থায় সেভ হয়। টোকেন কখনো ফেরত দেওয়া হয় না (এনক্রিপ্ট করে রাখা হয়)। |

অনুমোদন পড়া হয় env থেকে: `WHATSAPP_APPROVED === 'true'`, `TIKTOK_COMMENTS_APPROVED === 'true'`।
কোডে কমেন্ট আছে — কোঅর্ডিনেটর এগুলো কনফিগে সরাবে। Phase 1 প্ল্যাটফর্ম
(`messenger`, `facebook_comment`, `instagram`, `webchat`) আগের মতোই কাজ করে।

## ওয়েবহুক — WhatsApp / TikTok

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/webhooks/whatsapp` | query: `hub.mode=subscribe`, `hub.verify_token`, `hub.challenge` | টোকেন মিললে `200` + challenge; না মিললে `403`। টোকেন: `WHATSAPP_VERIFY_TOKEN` অথবা `META_VERIFY_TOKEN`। |
| POST | `/api/webhooks/whatsapp` | WhatsApp Cloud API আকার: `entry[].changes[].value.messages[]` (`from`, `text.body`, `id`); `value.metadata.phone_number_id` দিয়ে চ্যানেল চেনা হয় (`external_id`) | সবসময় `200`। ডুপ্লিকেট `webhook_events` দিয়ে আটকানো হয়; নতুন মেসেজে কাস্টমার (platform `whatsapp`) + কনভারসেশন তৈরি হয়ে কিউতে যায়। |
| POST | `/api/webhooks/tiktok` | ফ্ল্যাট `{postId, commentId, userId, userName?, text}` অথবা TikTok-স্টাইল `entry[].changes[].value` / `entry[].comments[]` / `data[]` | `200 {accepted}`; ভুল পেলোডে `400`। ডুপ্লিকেট `webhook_events` দিয়ে আটকানো হয়; কমেন্ট `comments` টেবিলে সেভ হয়, কাস্টমার (platform `tiktok`) + কনভারসেশন তৈরি হয়ে কিউতে যায়। চ্যানেল খুঁজতে `scheduled_posts.platform_post_id = postId` ব্যবহার করা হয়। |

## কুপন — `apps/api/src/coupons/routes.ts`

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/coupons` | — | `{coupons: [{id, code, type, value, expires_at, created_at, updated_at}]}` |
| POST | `/api/coupons` | `{code, type: 'percent' \| 'amount' \| 'free_delivery', value, expiresAt?}` | `201 {coupon}`; ভুল type/value-তে `400`; একই কোড থাকলে `409` |
| PATCH | `/api/coupons/:id` | `{code?, type?, value?, expiresAt?}` | `{coupon}`; না পেলে `404` |
| DELETE | `/api/coupons/:id` | — | `{deleted: true}`; না পেলে `404` |
| POST | `/api/coupons/validate` | `{code, subtotalPaisa}` | `{valid, discountPaisa, freeDelivery?, type?, value?, message?}` — কুপন না থাকলে / মেয়াদ শেষ হলে `valid: false` + বাংলা message। |
| POST | `/api/orders/:id/apply-coupon` | `{code}` | `{order: {id, total_paisa, discount_paisa}, coupon: {id, code, type, value}}` — শুধু `pending`/`on_hold` অর্ডারে; `coupon_redemptions` রো + `order_events` নোট লেখা হয়। অন্য স্ট্যাটাসে `400`, কুপন না থাকলে `404`, একই কুপন দুইবার বসালে `409`। |

**ছাড়ের হিসাব (শুধু `coupons` টেবিল থেকে):** `percent` → `floor(subtotal * value / 100)`;
`amount` → `min(value, subtotal)`; `free_delivery` → `discountPaisa 0`, `freeDelivery true`।
নতুন মোট = `max(0, subtotal − discount)`; subtotal আসে `order_items` (`quantity × price_paisa`) থেকে।

## প্রোডাক্ট / স্টক — `apps/api/src/products/routes.ts` + `stock.ts`

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/products/low-stock?threshold=5` | query `threshold` (ডিফল্ট 5) | `{products, threshold}` — `stock <= threshold` প্রোডাক্টগুলো |
| POST | `/api/products/:id/adjust-stock` | `{delta, reason?}` | `{product}` — স্টক কখনো ০-এর নিচে যায় না; প্রতিটি পরিবর্তন `stock_adjustments` টেবিলে লেখা হয়। প্রোডাক্ট না থাকলে `404`। |

**স্টক কমানোর ওয়্যারিং পয়েন্ট (কোঅর্ডিনেটরের জন্য):**
`apps/api/src/products/stock.ts` থেকে `decrementStockForOrderItems(db, workspaceId, orderId)` এক্সপোর্ট করা আছে।
`db` হলো AI টুলের `ToolDb`-র মতো কোয়েরি সারফেস (`query(text, params)`), তাই AI-র `create_order` টুলে
সরাসরি বসানো যায় — `tools.ts` ছোঁয়া হয়নি। ফাংশনটি `order_items` অনুযায়ী `products.stock` কমায়
(`GREATEST(0, stock − quantity)`) এবং যেসব প্রোডাক্টের স্টক ঠিক ০ হয়েছে, তাদের তালিকা
`[{id, name, stock: 0}]` ফেরত দেয়। HTTP অর্ডার তৈরিতে (`orders/routes.ts`, POST `/api/orders`)
একই ফাংশন একই ট্রানজাকশনে ডাকা হয়; কোনো প্রোডাক্ট ০ হলে `notes`-এ টিম নোট
(`স্টক শেষ হয়ে গেছে: <নাম> — এই প্রোডাক্টের স্টক এখন ০।`) + `order_events`-এ নোট লেখা হয়।

## কাস্টমার — `apps/api/src/customers/routes.ts`

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/customers?q=` | query `q` (নাম/ফোন) | `{customers}` — `q` না দিলে সব (সর্বোচ্চ 200) |
| GET | `/api/customers/:id` | — | `{customer, identities, conversations, orders, notes}` — `identities` = `channel_identities` |
| POST | `/api/customers/merge` | `{keepCustomerId, mergeCustomerId}` | `{customer}` (রাখা কাস্টমার) — **এক ট্রানজাকশনে:** `conversations`, `orders`, `tickets`, `leads` (এবং `notes`) রাখা কাস্টমারের দিকে ঘুরিয়ে দেওয়া হয়; `channel_identities` `platform+senderId` দিয়ে ডিডুপ করে জোড়া হয়; রাখা কাস্টমারের নাম/ফোন/ঠিকানা খালি থাকলে মিশিয়ে দেওয়া কাস্টমারেরটা বসে; শেষে মিশিয়ে দেওয়া রো মুছে ফেলা হয়। কাস্টমার না থাকলে `404`। |

## কমেন্ট — `apps/api/src/comments/routes.ts`

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/comments/:postId/carousel` | — | `{postId, cards: [{productId, name, pricePaisa, stock, description}]}` — প্রোডাক্ট আসে `post_products` + `scheduled_posts` (`platform_post_id = :postId`) থেকে। কোনো প্রোডাক্ট না থাকলে `{postId, cards: [], message: 'এই পোস্টের সাথে কোনো প্রোডাক্ট যুক্ত নেই।'}` |
| POST | `/api/comments/:id/reply` | `{text}` | `{comment, conversationId}` — কমেন্ট `replied=true` হয় এবং লিংক করা কনভারসেশনে `out` মেসেজ তৈরি হয়। কনভারসেশন খোঁজা হয় ওয়েবহুকে সেভ করা ইনবাউন্ড মেসেজ দিয়ে (`messages.platform_message_id = comments.platform_comment_id`)। চ্যাট না পেলে `404`। |

## মাইগ্রেশন

`apps/api/src/db/migrations/01-phase2-core.sql` — শুধু `CREATE TABLE IF NOT EXISTS`:
`coupon_redemptions` (id, workspace_id, coupon_id, order_id, discount_paisa, created_at, updated_at)
এবং `stock_adjustments` (id, workspace_id, product_id, delta, reason, created_at, updated_at)।
`schema.sql` (২৬ টেবিল) ছোঁয়া হয়নি।

## অনুমোদন-নির্ভর যা (এখনো লাইভ নয়)

- **WhatsApp:** WhatsApp Cloud API অনুমোদন + ফোন নম্বর যাচাই ছাড়া আসল মেসেজ আসবে না;
  চ্যানেল `pending_approval` থাকবে।
- **TikTok:** TikTok API অনুমোদন ছাড়া আসল কমেন্ট আসবে না; DM শুধু অনুমোদন পেলে (PDF সেকশন ৩)।
- আসল মেসেজ পাঠানো (Graph API) Phase 1-এর মতোই স্টাব — অনুমোদন পেলে যুক্ত করতে হবে।
