# AI সেলস ইনবক্স — Vercel-এ ডেপ্লয় (অস্থায়ী চালু করার জন্য)

> তারিখ: ২০২৬-১১-০৬। মালিক Vercel বেছে নিয়েছেন ("হ্যাঁ, Vercel-এ বসাও")।
> cPanel বন্ধ (SiteChai-এর ফায়ারওয়াল ব্রাউজারকে আটকাচ্ছে), তাই Vercel-ই এখনকার রাস্তা।
> **এখনো কিছুই ডেপ্লয় করা হয়নি, কোনো অ্যাকাউন্ট খোলা হয়নি, DNS বদলানো হয়নি** — শুধু কোড Vercel-এর উপযোগী করা হয়েছে আর যাচাই করা হয়েছে।

---

## সারাংশ (সহজ বাংলায়)

**কী বদলেছে:**
1. **ওয়েবসাইট (Next.js)** — কোনো বদল লাগেনি, Vercel-এ এমনিই চলবে।
2. **সার্ভার (API)** — Vercel-এর Serverless Function হিসেবে চলবে (একটা নতুন শুরুর ফাইল যোগ হয়েছে)।
3. **ডেটাবেজ** — ফাইলে থাকা ছোট ডেটাবেজের (PGlite) বদলে Neon নামে ফ্রি অনলাইন ডেটাবেজ ব্যবহার হবে। কোডে কোনো বদল লাগেনি — ঠিকানা বদলালেই হবে।
4. **ছবি/ভিডিও আপলোড** — এখন ব্রাউজার থেকে সরাসরি Vercel Blob-এ যাবে (আগে সার্ভারের ডিস্কে যেত)। লোকাল পরীক্ষায় আগের মতোই ডিস্কে যাবে, কিছু ভাঙেনি।
5. **সময়মতো পোস্ট / ফলো-আপ / হস্তান্তর / মালিকের খরচ কাটা** — Vercel-এ সার্ভার সবসময় চলে না, তাই একটা নতুন `/api/cron/sweep` ঠিকানা বানানো হয়েছে। ফ্রি GitHub Actions প্রতি ৫ মিনিটে ওই ঠিকানায় ডাক দেবে।
6. **AI উত্তর** — মেসেজ এলে এখন `waitUntil` দিয়ে উত্তর তৈরি শেষ হওয়া পর্যন্ত ফাংশন বাঁচিয়ে রাখা হবে (আগে মাঝপথে মরে যেতে পারত)।

**লোকাল পরীক্ষায় কিছুই ভাঙেনি:** PGlite মোড, ডিস্কে আপলোড, ৬০ সেকেন্ডের সুইপ — সব আগের মতোই চলে।

**খরচ:** পরীক্ষার সময় **০ টাকা** (Vercel Hobby + Neon ফ্রি + Blob ফ্রি + GitHub Actions ফ্রি)। বিক্রি শুরু করলে Vercel Pro লাগবে (~২০ ডলার/মাস, মোট ~২৫–৩৫ ডলার/মাস)।

---

## DNS তদন্ত — গুরুত্বপূর্ণ ফল (২০২৬-১১-০৬)

RDAP রেকর্ড (CentralNic, `.xyz` রেজিস্ট্রি) থেকে পাওয়া গেছে:

| বিষয় | ফল |
|---|---|
| ডোমেইন | `yearmedia.xyz` |
| রেজিস্ট্রার | **Purple IT Ltd** |
| নেমসার্ভার | **ns1.sitechai.com, ns2.sitechai.com** |
| নিবন্ধন / মেয়াদ | ২০২৬-০৭-২০ / ২০২৭-০৭-২০ |
| অবস্থা | `client transfer prohibited` (লক করা — ট্রান্সফার বন্ধ) |

**এর মানে:** ডোমেইনের DNS **SiteChai-এর নেমসার্ভারেই** থাকে — তাই DNS রেকর্ড বদলাতে প্রায় নিশ্চিতভাবে SiteChai-এর cPanel (Zone Editor) লাগবে, আর সেই cPanel-ই এখন ফায়ারওয়ালের জন্য বন্ধ। **DNS বদলানোর জন্য SiteChai সাপোর্টকে বলতে হবে** (অথবা রেজিস্ট্রার Purple IT-এর প্যানেল থেকে নেমসার্ভার বদলে Cloudflare-এর মতো ফ্রি DNS-এ নিয়ে যেতে হবে — সেটা মালিকের সিদ্ধান্ত)।

⚠️ স্যান্ডবক্সের `dig`/`nslookup` এখানে ভরসাযোগ্য নয় — লোকাল রিজলভার `198.18.x.x` ঠিকানা বানিয়ে দেয় (আগে `198.18.85.65`, পরে `198.18.106.52` — দুটোই কৃত্রিম)। উপরের RDAP তথ্যই আসল।

---

## পরের ধাপ (অ্যাকাউন্ট / ডেপ্লয় / DNS)

### ১. অ্যাকাউন্ট খুলুন (সব ফ্রি, কার্ড লাগে না)
1. **Vercel** — vercel.com-এ ফ্রি অ্যাকাউন্ট (ইমেইল / GitHub / Google দিয়ে)।
2. **Neon** — neon.tech-এ ফ্রি অ্যাকাউন্ট → নতুন Postgres প্রজেক্ট বানান → **pooled** কানেকশন স্ট্রিং নিন (হোস্টে `-pooler` থাকবে)।
3. **GitHub** — github.com-এ ফ্রি অ্যাকাউন্ট (শুধু ৫ মিনিটের শিডিউলারের জন্য)।

### ২. Neon-এ ডেটাবেজ তৈরি (একবারই)
Neon SQL Editor বা লোকাল `psql` দিয়ে, এই ক্রমে চালান:
1. `apps/api/schema.sql` (২৬টা টেবিল)
2. `apps/api/src/db/migrations/`-এর ১২টা SQL ফাইল (০১–১২, ক্রমানুসারে)

### ৩. Vercel-এ দুটো প্রজেক্ট বানান
| প্রজেক্ট | Root Directory | ডোমেইন |
|---|---|---|
| `web` | `apps/web` | `yearmedia.xyz` |
| `api` | `apps/api` | `api.yearmedia.xyz` |

ডেপ্লয়: Vercel CLI থেকে (`vercel` কমান্ড — git লাগে না) বা GitHub-এ কোড তুলে vercel.com/new থেকে import করে।

### ৪. Env vars (Vercel ড্যাশবোর্ডে বসাতে হবে — মান এখানে লেখা নেই)

**API প্রজেক্টে (৯টি):**
| নাম | কোথা থেকে |
|---|---|
| `DATABASE_URL` | Neon-এর pooled কানেকশন স্ট্রিং (`postgres://...`) |
| `JWT_SECRET` | লোকাল `apps/api/.env` থেকে কপি |
| `TOKEN_ENCRYPTION_KEY` | লোকাল `apps/api/.env` থেকে কপি |
| `AI_PROVIDER` | `groq` |
| `GROQ_API_KEY` | লোকাল `apps/api/.env` থেকে কপি |
| `GROQ_MODEL` | `openai/gpt-oss-20b` |
| `OWNER_SETUP_TOKEN` | `deploy/DEPLOY-ENV.txt` থেকে কপি (নতুন তৈরি করা টোকেন) |
| `CRON_SECRET` | **নতুন** শক্ত র‍্যান্ডম টোকেন বানান (`openssl rand -hex 32`) |
| `BLOB_READ_WRITE_TOKEN` | Vercel-এ Blob Store লিঙ্ক করলেই নিজে থেকে বসে |

**বসাবেন না:** `REDIS_URL`, `PORT`, `SEED_DEMO`, `ALLOW_SUBSCRIPTION_TEST_HOOKS`, `ALLOW_OWNER_TEST_HOOKS`, `AI_MOCK_PROVIDERS`।

**Web প্রজেক্টে (১টি):** `NEXT_PUBLIC_API_URL=https://api.yearmedia.xyz` (বিল্ডের সময় ভেতরে বসে যায় — API ঠিকানা বদলালে ওয়েব আবার বিল্ড করতে হবে)।

### ৫. GitHub Actions শিডিউলার
কোডে `.github/workflows/cron-sweep.yml` তৈরি আছে — প্রতি ৫ মিনিটে `POST https://api.yearmedia.xyz/api/cron/sweep` ডাকবে। GitHub রিপোতে **Secret** হিসেবে `CRON_SECRET` বসাতে হবে (৪ নম্বর ধাপের টোকেনের সাথে একই মান)।

### ৬. DNS বদল (যেখানেই DNS চালানো হয়)
| Type | Name | Value |
|---|---|---|
| A | `@` (apex) | `76.76.21.21` |
| CNAME | `www` | `cname.vercel-dns.com` |
| CNAME | `api` | `cname.vercel-dns.com` |

SSL নিজে থেকে চালু হবে (Let's Encrypt)। পুরনো SiteChai হোস্টিং-এ কিছুই বদলাবে না — শুধু ঠিকানা বদলাবে; ফিরিয়ে নিতে চাইলে DNS আবার `198.18.85.65`-তে ঘুরিয়ে দিলেই হবে।

⚠️ **DNS-এর বাধা:** DNS SiteChai-এর নেমসার্ভারে (উপরে দেখুন)। SiteChai সাপোর্টকে রেকর্ড বদলে দিতে বলুন, অথবা রেজিস্ট্রার থেকে নেমসার্ভার বদলান।

### ৭. যাচাই (ডেপ্লয়ের পর)
1. `https://yearmedia.xyz/login` খুলুন → লগইন পেজ আসতে হবে।
2. `https://api.yearmedia.xyz/api/health` → `{"status":"ok",...}` দেখাতে হবে।
3. সাইনআপ করুন → ৳৫০ ফ্রি ক্রেডিট পেতে হবে।
4. মালিক বানানো (একবারই): সাইনআপ করা ইমেইল দিয়ে `POST https://api.yearmedia.xyz/api/owner/setup` কল করুন, সাথে `OWNER_SETUP_TOKEN`। তারপর ড্যাশবোর্ডে **মালিক** মেনু আসবে।

---

## যাচাই (২০২৬-১১-০৬, কোড বদলের পর)

- API বিল্ড (`npm run build` / tsc): ✅ পরিষ্কার, কোনো এরর নেই।
- Web বিল্ড (`next build`, `NEXT_PUBLIC_API_URL=https://api.yearmedia.xyz`): ✅ পরিষ্কার — ৩৯টা পেজ।
- API node_modules: ১০২ MB (Vercel-এর ২৫০ MB সীমার নিচে)।
- লোকাল স্মোক টেস্ট (PGlite মোড): `/api/health` → ok; সাইনআপ কাজ করেছে (টোকেন + ওয়ার্কস্পেস); `/api/cron/sweep` চাবি ছাড়া ৪০১ দেয় (ঠিক আচরণ)।
- ৯টা ভেরিফায়ার (`scripts/verify-*.mjs`): **৪৫০/৪৫০ পাস** — আগের মোটের সমান, কোনো রিগ্রেশন নেই।
  | ভেরিফায়ার | ফল |
  |---|---|
  | `verify-e2e.mjs` | ৭৩/৭৩ |
  | `verify-subscriptions.mjs` | ৪৩/৪৩ (শুধু `ALLOW_SUBSCRIPTION_TEST_HOOKS=true` দিয়ে API চালালে — ভেরিফায়ারের নিজের নির্দেশ; ফ্ল্যাগ ছাড়া হুক ৪০৪ দেয়, সেটা গেটের কাজ, বাগ নয়) |
  | `verify-post-attribution.mjs` | ১৬/১৬ |
  | `verify-courier-topup.mjs` | ২৪/২৪ |
  | `verify-tiktok-embeddings.mjs` | ৬১/৬১ (প্রথম দৌড়ে harness-এ একবার ক্ষণিকের `fetch failed` হয়েছিল; কোনো কোড বদল ছাড়াই আবার চালালে ৬১/৬১ পাস — transient) |
  | `verify-new-features.mjs` | ৭৫/৭৫ |
  | `verify-scheduling-upgrades.mjs` | ২১/২১ |
  | `verify-ai-providers.mjs` | ৫৩/৫৩ |
  | `verify-owner-panel.mjs` | ৮৪/৮৪ |
- যাচাইয়ের সময় একটা সেটআপ ভুল ধরা পড়েছিল (রিপোর্টে লেখা আছে): প্রথম দৌড়ে API ভুল `DATABASE_URL` (লোকাল `.env`-এর আসল Postgres ঠিকানা) দিয়ে চালানো হয়েছিল, তাই e2e মাঝপথে থেমে গিয়েছিল; `run-local.sh`-এর মতো `DATABASE_URL=pglite://../.pglite-data` দিয়ে চালালে সব ঠিক হয়। আর পুরনো smoke-test-এর একটা API প্রসেস পোর্ট ৪০০০ ধরে রেখেছিল — সেটা বন্ধ করা হয়েছে। যাচাই শেষে পরীক্ষার সার্ভারগুলো বন্ধ করা হয়েছে।

---

## Technical details (English)

### Files changed for Vercel
| File | Change |
|---|---|
| `apps/api/api/index.ts` (NEW) | Vercel function entry: re-exports the built Express app (`import app from '../dist/index.js'; export default app;`) |
| `apps/api/vercel.json` (NEW) | Rewrite all paths to `/api/index` |
| `apps/api/src/index.ts` | `fs.mkdirSync` + `/uploads` static mount now only run when `process.env.VERCEL` is unset (local/cPanel disk fallback preserved); mounts `cronRouter` before the auth routers |
| `apps/api/src/cron/routes.ts` (NEW) | `GET/POST /api/cron/sweep`, guarded by `CRON_SECRET` (header `x-cron-secret`, `Authorization: Bearer`, or `?secret=`); runs `processDueScheduledPosts`, `processDueFollowups`, `processDueHandovers`, `processOwnerWalletDeductions` regardless of DB mode |
| `.github/workflows/cron-sweep.yml` (NEW) | GitHub Actions, every 5 min, `curl` the sweep endpoint with `secrets.CRON_SECRET` |
| `apps/api/src/scheduling/routes.ts` | Top-level `mkdirSync` + `/uploads` static mount guarded by `!process.env.VERCEL`; base64 upload uses Blob `put()` when `BLOB_READ_WRITE_TOKEN` is set, disk fallback otherwise (verifier contract `/api/uploads/<file>` preserved locally); NEW `POST /scheduled-posts/upload-token` (auth-protected `handleUpload`, image/video types only, 25 MB max, random suffix) |
| `apps/api/src/queue/client.ts` | `void processInProcess(...)` → `waitUntil(processInProcess(...))` from `@vercel/functions` (verified safe locally: no-op outside Vercel, promise still runs) |
| `apps/web/lib/api-scheduling.ts` | `uploadFile()` now uploads directly browser→Blob (`upload()` from `@vercel/blob/client`, `Authorization` header via `headers` option); falls back to the base64 API upload when Blob is unavailable (local/cPanel) |
| `apps/api/package.json` | Added `@vercel/blob`, `@vercel/functions` |
| `apps/web/package.json` | Added `@vercel/blob` |

### Not changed
- `apps/api/src/db/pool.ts` — verified: real Postgres via `pg` Pool when `DATABASE_URL` is `postgres://`. No code change.
- `apps/web` otherwise — Vercel-ready as-is; `server.js` (cPanel wrapper) left in place, harmless.
- `workers/queue/` (BullMQ) — not deployed; no Redis needed.
- No `REDIS_URL`, `PORT`, or test hooks set anywhere.

### Known limits of this Vercel setup (honest)
- Hobby (free) is **personal/non-commercial use only** — selling to shops needs Pro ($20/mo).
- Hobby cron runs at most once/day — that is why GitHub Actions does the 5-min sweep.
- Function request bodies cap at 4.5 MB — large uploads must use the direct Blob path (the web does this automatically).
- `waitUntil` is best-effort (no retries). If AI replies ever vanish on Vercel, the robust fix is Upstash QStash (free 1,000 msg/day) — NOT added now.
- PGlite is gone on Vercel: the local test data in `apps/.pglite-data` does NOT carry over — Neon starts empty; the owner setup step (step 7.4) must be done again on the live site.
- Uploads: Blob URLs are public by design (random names, unguessable). Old `/api/uploads/*` URLs from the cPanel plan will not exist on Vercel.
