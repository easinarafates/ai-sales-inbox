# Post attribution — integration notes (ইন্টিগ্রেটরের জন্য)

Post-to-order analytics gap fix: `post_attributions` table links a scheduled
post → the conversation a comment started → the order from that conversation.
`GET /api/analytics/posts` now returns REAL chats/orders per post (0 only when
truly unattributed — never invented).

## 1. Database migration — real Postgres only (PGlite: automatic, nothing to do)

Local PGlite mode applies every file in `apps/api/src/db/migrations/` on API
start (see `apps/api/src/db/pglite.ts`), so `05-post-attribution.sql` is
already applied locally. On real Postgres, run:

```bash
psql "$DATABASE_URL" -f apps/api/src/db/migrations/05-post-attribution.sql
```

## 2. Router mount — NOTHING to add

`postsAnalyticsRouter` (`GET /api/analytics/posts`, `GET /api/analytics/lost-sales`)
was already mounted in `apps/api/src/index.ts` (`app.use('/api', postsAnalyticsRouter)`).
No new mount needed. The attribution writes were added in place (additive only,
existing behaviour unchanged):
- `apps/api/src/webhooks/routes.ts` — Facebook comment + TikTok comment flows
  record the attribution when the comment becomes a conversation.
- `apps/api/src/comments/routes.ts` — comment-reply handler records it as a
  safety net (idempotent) if the webhook missed it.
- `apps/api/src/orders/routes.ts` — team order creation stamps `order_id`.
- `apps/api/src/ai-agent/tools.ts` — AI `create_order` tool stamps `order_id`.
- New shared helpers: `apps/api/src/analytics/attribution.ts`.

## 3. Dashboard wiring — paste into `apps/web/app/analytics/page.tsx`

The Analytics page already has a posts section (inline table titled
"প্রতি পোস্টের হিসাব"). Replace that inline table with the new component
(file already written: `apps/web/app/analytics/PostAttributionTable.tsx`).
Only these two edits:

```tsx
// 1) Add this import at the top of apps/web/app/analytics/page.tsx:
import PostAttributionTable from "./PostAttributionTable";
```

```tsx
// 2) Replace the whole <div className="bg-white rounded-xl shadow p-4 mb-6 overflow-x-auto">
//    block whose <h2> is "প্রতি পোস্টের হিসাব" (the posts table) with:
<PostAttributionTable posts={posts} />
```

No change to `apps/web/lib/api.ts` is needed — `analyticsApi.posts()` already
returns the fixed endpoint, and `AnalyticsPost` already has
`comments` / `chats` / `orders`.

## 4. Verify

```bash
node scripts/verify-post-attribution.mjs
# Needs the API on :4000 (API_URL env can point elsewhere, e.g. API_URL=http://localhost:4001).
# Asserts: attributed post shows comments ≥ 1, chats ≥ 1, orders ≥ 1;
# a control post with no comments shows 0 / 0 / 0.
```
