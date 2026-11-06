# সাবস্ক্রিপশন — ইন্টিগ্রেশন নোট (ইন্টিগ্রেটর এজেন্টের জন্য)

এই মডিউলের কোড তৈরি, কিন্তু নিচের লাইনগুলো শেয়ার্ড ফাইলে বসানো বাকি —
কারণ সেগুলো অন্য মডিউলের ফাইল, এই মডিউল এজেন্ট সেগুলো ছোঁয়নি।
প্রতিটি ব্লক হুবহু কপি-পেস্ট করলেই চলবে।

> দামগুলো **প্রস্তাবিত দাম** (ছোট ৳৪৯৯ / মাঝারি ৳৯৯৯ / বড় ৳১৯৯৯/মাস) —
> মালিকের সিদ্ধান্ত নয়। দাম বদলাতে হলে শুধু `plans` টেবিলের সিড
> (`04-subscriptions.sql`) আর `apps/api/src/config/index.ts`-এর
> `suggestedPlans` বদলাতে হয়।

## ১. রাউটার মাউন্ট — `apps/api/src/index.ts`

ইমপোর্টগুলোর সাথে (Phase 2/3 রাউটারের পাশে) যোগ করুন:

```ts
import { subscriptionsRouter } from './subscriptions/routes';
```

মাউন্টগুলোর সাথে যোগ করুন (Phase 2/3 মাউন্টের পাশে):

```ts
app.use('/api', subscriptionsRouter); // /api/subscriptions/* (plans, current, subscribe, upgrade, downgrade, cancel, renew)
```

## ২. ন্যাভ লিংক — `apps/web/components/Sidebar.tsx`

`NAV` অ্যারের ভেতরে, Billing-এর পরের লাইনে যোগ করুন:

```ts
{ href: "/plans", label: "প্ল্যান", sub: "Plans" },
```

## ৩. বিলিং পেজে সাবস্ক্রিপশন কার্ড — `apps/web/app/billing/page.tsx`

(এই ফাইলটি এই মডিউল এজেন্ট সম্পাদনা করেনি; কার্ডটি আলাদা ফাইলে তৈরি:
`apps/web/components/SubscriptionSummary.tsx`।)

ফাইলের উপরে ইমপোর্ট যোগ করুন:

```tsx
import SubscriptionSummary from "@/components/SubscriptionSummary";
```

আর `<h1 ...>বিলিং ও ওয়ালেট ...</h1>`-এর ঠিক নিচে, `{error && ...}` লাইনের আগে বসান:

```tsx
<SubscriptionSummary />
```

## ৪. সাইনআপে ট্রায়াল — `apps/api/src/auth/routes.ts` (ঐচ্ছিক, সুপারিশকৃত)

**না করলেও চলে:** `getCurrentSubscription` / AI গেট প্রথম ডাকেই ট্রায়াল
বানিয়ে নেয় (lazy — `ensureTrialSubscription`)। তবে সাইনআপের সময়ই
ট্রায়াল শুরু করতে চাইলে, `signup`-এ ফ্রি ক্রেডিটের `wallet_transactions`
INSERT-এর পরে, `COMMIT`-এর আগে যোগ করুন:

```ts
import { ensureTrialSubscription } from '../subscriptions/service';
// ... free-credit INSERT-এর পরে:
await ensureTrialSubscription(workspaceId);
```

(`ensureTrialSubscription` idempotent — আগে থেকে থাকলে কিছু করে না।)

## ৫. সীমা প্রয়োগ — চ্যানেল ও প্রোডাক্ট রুটে ২ লাইন করে

### `apps/api/src/channels/routes.ts` — `POST /` হ্যান্ডলারে, dupe-চেকের পরে, INSERT-এর আগে:

```ts
import { checkChannelLimit } from '../subscriptions/service';
// ... dupe-চেকের পরে:
const channelLimit = await checkChannelLimit(workspaceId);
if (!channelLimit.canAdd) {
  res.status(402).json({ error: channelLimit.message });
  return;
}
```

### `apps/api/src/products/routes.ts` — `POST /` হ্যান্ডলারে, ভ্যালিডেশনের পরে, INSERT-এর আগে:

```ts
import { checkProductLimit } from '../subscriptions/service';
// ... name/pricePaisa ভ্যালিডেশনের পরে:
const productLimit = await checkProductLimit(workspaceId);
if (!productLimit.canAdd) {
  res.status(402).json({ error: productLimit.message });
  return;
}
```

> সীমার নিয়ম: চ্যানেলে শুধু `connected` চ্যানেল গোনা হয়
> (`pending_approval` গোনা হয় না — সেগুলো এখনো লাইভ নয়), তাই
> ট্রায়ালের (ছোট, সর্বোচ্চ ১টি) ওয়ার্কস্পেসেও Messenger + WhatsApp +
> TikTok একসাথে যুক্ত করা যায় — পুরোনো e2e ভেরিফায়ার ভাঙে না।
> প্রোডাক্টে সব প্রোডাক্ট গোনা হয় (ছোট: ১০০টি)।

## ৬. আসল Postgres-এ মাইগ্রেশন

```bash
psql "$DATABASE_URL" -f apps/api/src/db/migrations/04-subscriptions.sql
```

(PGlite লোকাল মোডে API চালু হওয়ার সময় নিজে থেকেই লাগায় — কিছু করতে হয় না।)

## ৭. হোম পেজে পাবলিক প্রাইসিং — করা হয়নি

`apps/web/app/page.tsx` কোনো পাবলিক ল্যান্ডিং পেজ নয় — শুধু রিডাইরেক্ট
(লগইন থাকলে `/inbox`, নইলে `/login`)। তাই সেখানে প্রাইসিং সেকশন বসানো
হয়নি, আর হোম পেজের কাঠামো বদলানো হয়নি। প্ল্যান দেখা/কেনা যায়
`/plans` পেজে (ড্যাশবোর্ডের ভেতরে)।

## ৮. পরীক্ষার সহায়ক রুট (শুধু নিজের ওয়ার্কস্পেস — নিরাপদ, তবে চাইলে তোলা যায়)

- `POST /api/subscriptions/test/expire-current` — নিজের চলতি প্ল্যানের মেয়াদ শেষ করে।
- `POST /api/subscriptions/test/simulate-usage {count}` — নিজের লেজারে count-টি ব্যবহার লেখে।

দুটোই শুধু নিজের ক্ষতি করতে পারে (নিজের মেয়াদ শেষ / নিজের ব্যবহার বাড়ানো),
অন্যের ডেটা ছোঁয় না, কোনো টাকা বাড়ায় না। `scripts/verify-subscriptions.mjs`
এগুলো দিয়ে মেয়াদোত্তীর্ণ ও ওভারেজ পরীক্ষা করে (৫০০টি আসল AI কল ছাড়াই)।
**গেট করা (২০২৬-১১-০৫ ইন্টিগ্রেশন):** ডিফল্ট বন্ধ — ফ্ল্যাগ ছাড়া দুটো
রুটই 404 দেয়। চালু করতে API-টি এভাবে চালান:
`ALLOW_SUBSCRIPTION_TEST_HOOKS=true ./scripts/run-local.sh` (শুধু লোকাল
যাচাইয়ের জন্য; প্রোডাকশনে কখনো চালু করবেন না)। ফ্ল্যাগটি
`apps/api/src/config/index.ts`-এ `allowSubscriptionTestHooks`।
প্রোডাকশনে তুলে ফেলতে চাইলে `routes.ts`-এর শেষের ২টি রুট আর
`service.ts`-এর `*ForTest` ফাংশন ২টি মুছে ফেললেই হবে।

## ৯. যাচাই

```bash
cd apps/api && npx tsc --noEmit
cd apps/web && npx tsc --noEmit
node scripts/verify-subscriptions.mjs   # API :4000 + ওয়েব :3000 চালু থাকতে হবে
node scripts/verify-e2e.mjs             # পুরোনো ৭৩টি চেক — ভাঙেনি কি না দেখতে
```
