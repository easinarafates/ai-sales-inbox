# Integration Notes — Courier Booking + Payment Top-Up

This module is **complete but NOT mounted yet**. A later integration agent
applies the paste-blocks below. Nothing in this module edits shared files.

Files built by this module (do not move them):
- `apps/api/src/db/migrations/06-courier-topup.sql` — extends `shipments`
  (adds `provider_booking_id`, `tracking_number`; the table itself already
  exists in `schema.sql`) + new `topup_requests` table.
- `apps/api/src/courier/provider.ts` — provider interface + stub + honest
  Pathao/Steadfast/RedX TODO stubs.
- `apps/api/src/courier/routes.ts` — `courierRouter`
  (`POST /api/courier/bookings`, `GET /api/courier/track/:trackingNumber`,
  `GET /api/courier/shipments`).
- `apps/api/src/billing/topup.ts` — `topupRouter`
  (`POST /api/billing/topup/request`, `GET /api/billing/topup/requests`,
  `POST /api/billing/topup/:id/approve`, `POST /api/billing/topup/:id/reject`).
- `apps/api/src/config/index.ts` — already edited by this module:
  `COURIER_PROVIDER`, `config.courier.{pathao,steadfast,redx}`,
  `config.bkash`, `config.nagad` (env names only, no credentials).
- `apps/web/lib/courier.ts` + `apps/web/lib/topup.ts` — typed fetch helpers.
- `apps/web/app/courier/page.tsx` — Courier dashboard page (Bengali).
- `apps/web/app/billing/topup-section.tsx` — top-up component (Bengali).

## 1. Mount the API routers — `apps/api/src/index.ts`

Add the imports next to the other Phase 2/3 router imports:

```ts
import { courierRouter } from './courier/routes';
import { topupRouter } from './billing/topup';
```

Add the mounts next to the other Phase 2/3 mounts (after the scheduling mount):

```ts
app.use('/api', courierRouter); // /api/courier/bookings, /api/courier/track/:trackingNumber, /api/courier/shipments
app.use('/api', topupRouter); // /api/billing/topup/request, /api/billing/topup/requests, /:id/approve, /:id/reject
```

## 2. Nav link — `apps/web/components/Sidebar.tsx`

Add one entry to the `NAV` array (after the Billing entry, or after Orders):

```ts
{ href: "/courier", label: "কুরিয়ার", sub: "Courier" },
```

## 3. Top-up section on the Billing page — `apps/web/app/billing/page.tsx`

Add the import at the top (next to the other imports):

```tsx
import TopupSection from "./topup-section";
```

Mount the component right after the existing top-up `<form>...</form>` block
(the one with `টপ-আপের পরিমাণ`), before the `<h2>প্রতি AI রিপ্লাইয়ের খরচ` heading:

```tsx
<TopupSection />
```

Note: the old form calls the Phase 1 direct `POST /api/billing/topup`
(instant credit, no review). Keep it or remove it — the new manual flow
(request → approve) is the one that matches "no gateway yet". If both stay,
label the old one clearly so the two flows are not confused.

## 4. Database — real Postgres

PGlite local mode applies this migration automatically on API start (it
loads every `*.sql` file in `apps/api/src/db/migrations/` in order).
For real Postgres, run:

```bash
psql "$DATABASE_URL" -f apps/api/src/db/migrations/06-courier-topup.sql
```

## 5. Environment (optional — defaults already work)

```bash
# Courier: stub (default) = local-only, no tracking number.
COURIER_PROVIDER=stub   # or: pathao | steadfast | redx (needs API keys, see §6)
# Gateway placeholders (names only — live gateway needs merchant credentials):
# BKASH_BASE_URL, BKASH_USERNAME, BKASH_PASSWORD, BKASH_APP_KEY, BKASH_APP_SECRET
# NAGAD_BASE_URL, NAGAD_MERCHANT_ID, NAGAD_PUBLIC_KEY, NAGAD_PRIVATE_KEY
```

## 6. What is still gated (do NOT claim these work)

- **Real courier booking / live tracking:** needs a merchant account + API
  keys for Pathao (`PATHAO_CLIENT_ID` / `PATHAO_CLIENT_SECRET` + username/
  password), Steadfast (`STEADFAST_API_KEY` / `STEADFAST_SECRET_KEY`), or
  RedX (`REDX_API_KEY`), AND the TODO API calls in
  `apps/api/src/courier/provider.ts` implemented (they currently throw
  `PROVIDER_NOT_CONFIGURED` / TODO errors honestly).
- **Live bKash/Nagad gateway:** needs merchant credentials from bKash
  (merchant dashboard: username/password/app key/app secret) and Nagad
  (merchant portal: merchant ID + public/private keys), plus the actual
  create-payment/execute/callback integration — only env-name placeholders
  exist today. The manual top-up flow (request → approve) works without any
  of this.
- **Approve permission:** any authenticated workspace member can approve/
  reject today (the members table only reliably has `owner` from signup).
  If a stricter owner/admin gate is wanted, enforce it in
  `apps/api/src/billing/topup.ts` (approve/reject handlers) and record it
  in `reviewed_by` (already stored).

## 7. Verify after integration

```bash
cd apps/api && npx tsc --noEmit
cd apps/web && npx tsc --noEmit
./scripts/run-local.sh   # API :4000, web :3000
node scripts/verify-courier-topup.mjs
node scripts/verify-e2e.mjs   # regression: 73/73 must still pass
```
