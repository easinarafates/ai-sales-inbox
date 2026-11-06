# Vercel-এ AI সেলস ইনবক্স — যাচাই রিপোর্ট

> তারিখ: ২০২৬-১১-০৬। উদ্দেশ্য: cPanel বন্ধ থাকায় Vercel-এ চালানো যায় কি না দেখা।
> কিছুই ডেপ্লয় করা হয়নি, কোনো অ্যাকাউন্ট খোলা হয়নি, কোডে হাত দেওয়া হয়নি — শুধু যাচাই।

---

## সারাংশ (সহজ বাংলায়)

**উত্তর: হ্যাঁ, Vercel-এ চালানো যাবে — কিন্তু কিছু বদলাতে হবে।** সাইটটা নতুন করে বানাতে হবে না।

**যা এমনিই চলবে:**
- **ওয়েবসাইট (Next.js)** — কোনো বদল ছাড়াই Vercel-এ চলবে। এটা Vercel-এর নিজের জিনিস, তাই সবচেয়ে সহজ।
- **ডেটাবেজের কোড** — আসল Postgres-এর রাস্তা কোডে আগেই আছে, শুধু ঠিকানাটা বদলাতে হবে।

**যা বদলাতে হবে (মাঝারি কাজ, প্রায় ১ দিনের কাজ):**
1. **ছবি/ভিডিও আপলোড** — এখন ফাইল সার্ভারের ডিস্কে জমা হয়; Vercel-এ ডিস্কে জমা থাকে না। Vercel Blob নামে ফাইল রাখার জায়গা ব্যবহার করতে হবে।
2. **ডেটাবেজ** — এখন ফাইলে থাকা ছোট ডেটাবেজ (PGlite); Vercel-এ Neon নামে ফ্রি অনলাইন ডেটাবেজ লাগবে।
3. **সময়মতো পোস্ট/ফলো-আপ চালানো** — এখন সার্ভার নিজে প্রতি মিনিটে চেক করে; Vercel-এ সার্ভার সবসময় চলে না। ফ্রি উপায়ে GitHub Actions দিয়ে প্রতি ৫ মিনিটে চেক করাতে হবে (নয়তো Pro নিতে হবে)।
4. **AI উত্তর দেওয়া** — মেসেজ এলে এখন পেছনে উত্তর তৈরি হয়; Vercel-এ সেটা মাঝপথে মরে যেতে পারে। ছোট একটা বদল (`waitUntil`) বা QStash নামে ফ্রি লাইন (queue) লাগবে।

**ফ্রি-তে চলবে কি? — পরীক্ষার জন্য হ্যাঁ, বিক্রির জন্য না।**
- Vercel-এর ফ্রি প্ল্যান (Hobby) শুধু **নিজের পরীক্ষার** জন্য। দোকানদারদের কাছে বিক্রি শুরু করলেই Pro লাগবে — **২০ ডলার/মাস** (Vercel-এর নিয়ম)।
- ফ্রি-তে একটা ফাঁদ আছে: সময়মতো পোস্টের কাজ ফ্রি Vercel দিয়ে দিনে মাত্র ১ বার চলে — তাই GitHub Actions (ফ্রি) দিয়ে প্রতি ৫ মিনিটে চালাতে হবে।
- ফ্রি সীমা পার হলে টাকা কাটে না, কিন্তু সেই জিনিসটা ৩০ দিন বন্ধ থাকে।

**মালিকের যা লাগবে:**
1. একটা **ফ্রি Vercel অ্যাকাউন্ট** (ইমেইল/GitHub দিয়ে, কার্ড লাগে না)।
2. একটা **ফ্রি Neon অ্যাকাউন্ট** (ডেটাবেজের জন্য, কার্ড লাগে না)।
3. ডোমেইনের DNS বদলাতে হবে: `yearmedia.xyz` Vercel-এর দিকে ঘোরাতে হবে (নিচে ঠিক কী বদলাতে হবে লেখা আছে)। পুরনো SiteChai হোস্টিং-এ কিছুই বদলাবে না — শুধু ঠিকানা বদলাবে, ফিরিয়ে নেওয়া যাবে।
4. ⚠️ **একটা জিনিস যাচাই করা যায়নি:** ডোমেইনের DNS কোথা থেকে চালানো হয়, তা এখান থেকে জানা যায়নি। DNS যদি SiteChai-এর cPanel-এ থাকে, তাহলে সেই একই ব্লকের জন্য DNS-ও বদলানো যাবে না — তখন SiteChai সাপোর্ট বা ডোমেইন কেনার জায়গা থেকে বদলাতে হবে।

**খরচ (বড় হলে):** পরীক্ষার সময় ০ টাকা। বিক্রি শুরু করলে মোটামুটি **২৫–৩৫ ডলার/মাস** (Vercel Pro ২০ + ডেটাবেজ ~৫–১০ + ফাইল প্রায় ফ্রি)। হাজার হাজার ব্যবহারকারী হলে ব্যবহার অনুযায়ী বাড়বে।

---

## Technical details (English)

### 1. Web app — `apps/web` — ✅ Vercel-ready as-is

- Next.js `14.2.5`, `next.config.js` is minimal (`reactStrictMode` only, no `output: 'standalone'`, no rewrites).
- No Route Handlers (`app/**/route.ts` — none), no Server Actions (`use server` — none), no `middleware.ts`, no `fs` usage, no `next/image` remote patterns.
- Only env var: `NEXT_PUBLIC_API_URL` (`apps/web/lib/api.ts`) — set to `https://api.yearmedia.xyz` at build time (baked into the build, same as the cPanel plan).
- `apps/web/server.js` is a cPanel-only wrapper (`next({dev:false})` + `http.createServer`). Vercel ignores it — Vercel builds with `next build` and serves with its own infrastructure. No change needed; leave the file (harmless) or delete it later.
- **Verdict: deploy as-is.** Vercel project with Root Directory `apps/web`.

### 2. API — `apps/api` — ⚠️ needs adaptation (small–medium, no rewrite)

The codebase is already shaped well for serverless: `src/index.ts` does `export default app` and only calls `app.listen()` under `if (require.main === module)`. Vercel's official Express guide (vercel.com/kb/guide/ship-a-express-app-on-vercel, updated 2026-10-14) auto-detects an Express app from a default-exported app in a recognized entry file (`app`/`index`/`server` at project root or under `src/`). `src/index.ts` already qualifies, but the certain path is an explicit entry (see change #1).

| Piece | File(s) | On Vercel | Verdict |
|---|---|---|---|
| Express app entry | `apps/api/src/index.ts` (default export; listen gated) | Vercel wraps the exported app as one Function | ✅ works, add explicit entry (change #1) |
| DB: PGlite (file DB) | `apps/api/src/db/pglite.ts`, `pool.ts` | Serverless filesystem is ephemeral + read-only (except `/tmp`); PGlite data would not persist; each cold start would rebuild an empty DB | ❌ needs hosted Postgres (change #3) |
| DB: real Postgres path | `apps/api/src/db/pool.ts` (`new Pool({connectionString})` when `DATABASE_URL` is `postgres://`) | Already exists — switch is config-only | ✅ no code change |
| Uploads (disk) | `apps/api/src/scheduling/routes.ts:34,368` (`fs.mkdirSync`, `fs.writeFileSync` to `uploads/`); `apps/api/src/index.ts:65-67` (static `/uploads`) | Disk writes don't persist; `mkdirSync` at import time throws on read-only FS and would crash the function on cold start; request body cap 4.5 MB kills the 25 MB base64 upload path | ❌ needs Blob rework (changes #2, #4, #5) |
| In-process sweep (60s) | `apps/api/src/index.ts:150-172` (`setInterval`, PGlite mode only) | No always-on process — never runs | ❌ needs cron endpoint + scheduler (change #6) |
| AI reply (in-process fallback) | `apps/api/src/queue/client.ts` (`void processInProcess(...)` fire-and-forget after webhook 200) | Unowned promises are frozen/killed after the response on serverless — AI replies would silently vanish sometimes | ❌ needs `waitUntil` or QStash (change #7) |
| BullMQ worker / Redis | `workers/queue/`, `apps/api/src/queue/` | No worker process on Vercel; Redis optional in code (falls back in-process) | ✅ simply not deployed; no Redis needed |
| Webhooks (Meta/TikTok) | `apps/api/src/webhooks/routes.ts` (`await enqueueMessage(...)` then 200) | Returns 200 fast; AI work is async (see #7) | ✅ works once #7 is fixed |
| Config / env | `apps/api/src/config/index.ts` | `DATABASE_URL`, `JWT_SECRET`, `TOKEN_ENCRYPTION_KEY` are `required()` at import — must exist in Vercel dashboard or functions crash on cold start | ⚠️ env checklist (change #8) |
| AI provider timeout | `config.aiProviderTimeoutMs` default 20000 ms | Fluid compute Hobby max duration is 300 s — not a problem | ✅ fine |
| S3 config | `apps/api/src/config/index.ts:105-108` | Defined but never used anywhere (no S3 code) | ✅ ignore |
| PGlite dependency | `apps/api/package.json` (`@electric-sql/pglite`) | Never imported in real-Postgres mode, but still bundled (function bundle limit 250 MB uncompressed; API `node_modules` is 82 MB) | ⚠️ verify bundle size at deploy; optional cleanup |

### 3. Concrete change list (files)

1. **NEW `apps/api/api/index.ts`** (certain path; alternative: rely on Vercel's Express auto-detection of `src/index.ts`):
   ```ts
   import app from '../dist/index.js';
   export default app;
   ```
   Plus **NEW `apps/api/vercel.json`** (rewrites so every path hits the function; `maxDuration` optional — Fluid default is already 300 s on Hobby). Vercel project Root Directory: `apps/api`. Build command: `npm run build` (`tsc` → `dist/`).
2. **`apps/api/src/index.ts:65-67`** — remove or guard `fs.mkdirSync(UPLOAD_DIR)` and the `express.static('/uploads')` mount (read-only FS throws at import). Upload serving moves to Blob URLs.
3. **Database → Neon (no code change):** set `DATABASE_URL` to the Neon **pooled** connection string (`-pooler` host; `pg` Pool default max 10 connections per instance — pooled endpoint protects Neon's connection limit). One-time ops: load `schema.sql` + the 12 files in `apps/api/src/db/migrations/` into Neon once (psql from local machine or Neon SQL editor). Neon supports `pgvector` and `pgcrypto`, so the full schema works and image embeddings become real (today PGlite stores them as TEXT stub).
4. **`apps/api/src/scheduling/routes.ts`** — replace the `fileBase64` disk branch (`fs.writeFileSync`, line 368) with Vercel Blob `put()` (`@vercel/blob`); keep the existing `mediaUrl` branch (it already accepts an external URL as-is — a Blob URL flows through it). Remove `fs.mkdirSync` (line 34) and the `/uploads` static mount (line 35). **Medium change.**
5. **`apps/web/lib/api-scheduling.ts` — `uploadFile()` (~lines 191–218)** — replace FileReader→base64→JSON POST with direct browser→Blob upload (`upload()` from `@vercel/blob/client`, token from a small new API route). The web then stores the returned Blob URL as the post's media. **Medium change.**
6. **NEW cron endpoint** — e.g. `apps/api/src/cron/routes.ts`, `GET/POST /api/cron/sweep`, guarded by `CRON_SECRET`, calling the same four functions the 60 s sweep calls today (`processDueScheduledPosts`, `processDueFollowups`, `processDueHandovers`, `processOwnerWalletDeductions`) **regardless of DB mode** (today they only run in PGlite mode — `src/index.ts:151`). **Small change.** Scheduling: Hobby Vercel Cron runs at most **once per day** (see limits) — not enough for timed posts. Use **GitHub Actions (free, every 5 min)** to call the endpoint, or Vercel **Pro** ($20/mo) for every-minute cron.
7. **`apps/api/src/queue/client.ts`** — replace `void processInProcess(...)` with `waitUntil(processInProcess(...))` from `@vercel/functions` (add dependency). Best-effort, no retries, must finish within max duration (300 s — plenty; Groq replies are ~1–3 s). **Small change, must be live-tested** (waitUntil inside an Express handler on Vercel). Robust alternative: **Upstash QStash** (free 1,000 msg/day, then $1/100K) — webhook publishes to QStash, QStash calls a processing endpoint with retries. **Medium change, more reliable.**
8. **Env vars in Vercel dashboard** (API project): same 7 as `deploy/DEPLOY-ENV.txt` (`DATABASE_URL` → Neon URL instead of `pglite://…`, `JWT_SECRET`, `TOKEN_ENCRYPTION_KEY`, `AI_PROVIDER`, `GROQ_API_KEY`, `GROQ_MODEL`, `OWNER_SETUP_TOKEN`) + `CRON_SECRET` (new) + `BLOB_READ_WRITE_TOKEN` (auto-created when a Blob store is linked). Do NOT set `REDIS_URL`, `PORT`, or test hooks. Web project: only `NEXT_PUBLIC_API_URL=https://api.yearmedia.xyz`.
9. **Optional cleanup:** remove `@electric-sql/pglite` (+ `bullmq`, `ioredis` if unused) from `apps/api/package.json` to slim the function bundle; `workers/queue/` is not deployed at all.
10. **No git repo exists** (verified: no `.git` in `~/workspace/ai-sales-inbox/`). Deploy options: (a) **Vercel CLI** `vercel` from the local machine — no git needed; (b) `git init` + push to GitHub + import at vercel.com/new (needs a GitHub account).

### 4. Architecture on Vercel (recommended)

- **Two Vercel projects:** (1) `web` — Root Directory `apps/web`, domain `yearmedia.xyz`; (2) `api` — Root Directory `apps/api`, domain `api.yearmedia.xyz`.
- **Neon Postgres** (free) — one project, pooled connection string in the API env.
- **Vercel Blob** (free allowance) — one store linked to the API project.
- **GitHub Actions** (free) — every 5 min `curl` the cron endpoint with `CRON_SECRET` (or Vercel Pro cron).
- **No Redis, no worker process, no PGlite.**

### 5. Vercel limits that matter (checked 2026-11-06)

| Limit | Hobby (free) | Pro ($20/seat/mo) | Source |
|---|---|---|---|
| Function max duration (Fluid compute, default for new projects) | 300 s | 800 s (1800 s beta) | vercel.com/docs/functions/limitations (updated 2026-08-24) |
| Request/response body | 4.5 MB max (else 413) | same | same |
| Function invocations | 1,000,000 / mo | 1,000,000 included, then $0.60/1M | vercel.com/docs/limits |
| Bandwidth | 100 GB / mo | 1 TB, then Flat Rate CDN | vercel.com/pricing |
| Fluid Active CPU | 4 h / mo | metered | vercel.com/docs/limits |
| Memory | 2 GB / 1 vCPU | up to 4 GB / 2 vCPU | vercel.com/docs/functions/limitations |
| Cron jobs | 100/project, **at most once per day each**, fires anywhere within the scheduled hour (UTC) | 40/project, every minute | vercel.com/docs/cron-jobs/usage-and-pricing |
| Blob | 1 GB storage, 10 GB transfer/mo, 10k simple ops, 2k advanced ops | $0.023/GB-mo, $0.05/GB transfer | vercel.com/docs/vercel-blob/usage-and-pricing |
| Commercial use | ❌ **personal, non-commercial only** | ✅ allowed | vercel.com/pricing FAQ |
| Over-limit behaviour (Hobby) | feature blocked for 30 days, no billing | billed usage | vercel.com/docs/limits |

### 6. Free tiers of the other pieces (checked 2026-11-06)

| Service | Free tier | Paid step |
|---|---|---|
| **Neon Postgres** (recommended) | 1 GB storage/project (20 GB account total), 100 CU-hours/mo, autoscale to 2 CU, scale-to-zero after 5 min idle, 5 GB egress, no card | Launch: usage-based, $0.106/CU-hour + $0.35/GB-mo, no monthly minimum |
| Supabase (alternative) | 500 MB DB, 1 GB file storage, 2 active projects, pauses after 1 week idle | Pro from $25/mo |
| **Vercel Blob** | 1 GB storage, 10 GB transfer/mo | $0.023/GB-mo + $0.05/GB transfer |
| **Upstash QStash** (optional, robust queue) | 1,000 messages/day | $1 per 100K messages |
| **GitHub Actions** (external scheduler) | 2,000 min/mo (private repos; public repos free) — a 5-min curl uses ~a few min/day | — |

### 7. Custom domain — `yearmedia.xyz`

- In Vercel dashboard, add the domain to each project. DNS records to set (wherever the domain's DNS is managed):
  | Type | Name | Value |
  |---|---|---|
  | A | `@` (apex) | `76.76.21.21` |
  | CNAME | `www` | `cname.vercel-dns.com` |
  | CNAME | `api` | `cname.vercel-dns.com` |
- SSL is automatic (Let's Encrypt) once DNS propagates (usually minutes, up to 24 h).
- **Old SiteChai hosting stays untouched** — no files deleted or changed there. Only DNS records change, so the site loads from Vercel instead. Revert any time by pointing DNS back to SiteChai (`198.18.85.65`).
- ⚠️ **Unverified:** the sandbox DNS could not return NS/SOA records for `yearmedia.xyz`, so where DNS is managed is unknown. If DNS lives in SiteChai cPanel (Zone Editor), the same firewall block that stops cPanel also stops DNS edits — then the owner must ask SiteChai support to change the records, or change them at the domain registrar's panel.

### 8. Cost estimate

| Phase | Monthly cost |
|---|---|
| Temporary test (Hobby + Neon free + Blob free + GitHub Actions free) | **$0** |
| Selling to shops (Vercel Pro $20 + Neon ~$5–10 + Blob ~$0–1) | **~$25–35** |
| Thousands of users | Pro $20 + metered usage (functions, bandwidth, Neon compute, Blob) — roughly $50–200+ depending on traffic; cannot be precise in advance |

### 9. What is needed from the owner

1. A **free Vercel account** (sign up with email, GitHub or Google — no card for Hobby).
2. A **free Neon account** (no card) — or Supabase if preferred.
3. (Only if QStash is chosen) a **free Upstash account**; (only if GitHub Actions scheduler is chosen) a **free GitHub account**.
4. Access to wherever `yearmedia.xyz` DNS is managed (registrar panel or SiteChai) to change the 3 records above.
5. Decision: temporary test on Hobby (free, non-commercial) with GitHub Actions scheduler, or go straight to Pro ($20/mo) for every-minute cron + commercial use.

### 10. Honest comparison (one line)

cPanel, once reachable, runs everything **as-is with zero code changes**; Vercel needs ~1 day of adaptation work (changes #1–#8 above) plus free accounts — but Vercel is not blocked by any firewall and is the better long-term home for a Next.js app.
