# AI সেলস ইনবক্স — cPanel-এ অস্থায়ী ডেপ্লয়মেন্ট প্ল্যান

> **এটা অস্থায়ী ব্যবস্থা।** সাইটটা শুধু চালু করে দেখার জন্য — yearmedia.xyz-এ চলবে। ফাইনাল হলে সব নতুন করে করা হবে (নিচে ৭ নম্বরে দেখুন)। এই প্ল্যানে কোনো গোপন চাবি/পাসওয়ার্ড লেখা নেই — চাবিগুলো ডেপ্লয়ের সময় লোকাল `.env` থেকে কপি করতে হবে।

---

## ১. সারসংক্ষেপ — কী হচ্ছে

- **ডোমেইন:** `yearmedia.xyz` (ওয়েবসাইট) + `api.yearmedia.xyz` (API/সার্ভার)
- **হোস্টিং:** শেয়ার্ড cPanel (LiteSpeed সার্ভার)
- **দুটো Node অ্যাপ চলবে:** একটা ওয়েব (Next.js), একটা API (Express)
- **ডেটাবেজ:** PGlite — ফাইলে থাকা ছোট Postgres, আলাদা ডেটাবেজ সার্ভার লাগবে না
- **Redis/Worker:** চলবে না — দরকারও নেই (নিচে ৩ নম্বরে ব্যাখ্যা আছে)
- **AI:** Groq (ফ্রি) — লোকাল `.env` থেকে চাবি কপি করতে হবে

---

## ২. বিল্ড যাচাই — আজ (২০২৬-১১-০৬) পরীক্ষা করে দেখা হয়েছে ✅

| পরীক্ষা | ফল |
|---|---|
| API বিল্ড (`npm run build` — TypeScript) | ✅ পরিষ্কার, কোনো এরর নেই |
| ওয়েব বিল্ড (`next build`, `NEXT_PUBLIC_API_URL=https://api.yearmedia.xyz`) | ✅ পরিষ্কার — ৩৯টা পেজ তৈরি হয়েছে |
| API চালু পরীক্ষা (খালি নতুন ডেটাবেজ দিয়ে) | ✅ `/api/health` → `{"status":"ok"}` |
| প্রথম চালুতে ডেটাবেজ তৈরি | ✅ `schema.sql` থেকে ২৬টা টেবিল + ১২টা মাইগ্রেশন নিজে থেকেই বসেছে |
| সাইনআপ পরীক্ষা (নতুন দোকান) | ✅ অ্যাকাউন্ট খুলেছে, ৳৫০ ফ্রি ক্রেডিট পেয়েছে |

**কোডে কোনো বদল লাগেনি।** বিল্ড দুটোই প্রথম চেষ্টায় পাস করেছে।

---

## ৩. অস্থায়ী আর্কিটেকচার — cPanel-এ কীভাবে চলবে

```
ইন্টারনেট
   │
   ├─ yearmedia.xyz ──────► Node অ্যাপ ১: ওয়েব (Next.js, apps/web)
   │                          └─ API-কে ডাকে: https://api.yearmedia.xyz
   │
   └─ api.yearmedia.xyz ──► Node অ্যাপ ২: API (Express, apps/api/dist)
                              ├─ ডেটাবেজ: PGlite ফাইল (.pglite-data ফোল্ডার)
                              ├─ ছবি/ভিডিও: uploads/ ফোল্ডার (লোকাল ফাইল)
                              ├─ AI উত্তর: Groq (ফ্রি, ইন্টারনেটে কল যায়)
                              └─ ৬০ সেকেন্ডে একবার নিজে চেক করে:
                                 শিডিউল করা পোস্ট / ফলো-আপ / হস্তান্তর / মালিকের খরচ কাটা
```

**Redis আর আলাদা Worker লাগবে না কেন?**
- কোডে আগে থেকেই ব্যবস্থা আছে: Redis না পেলে API নিজেই মেসেজের উত্তর দেয় (একই ৩ সেকেন্ডের নিয়মে)।
- শিডিউল করা পোস্ট, ফলো-আপ, হস্তান্তর — API নিজে ৬০ সেকেন্ডে একবার চালায়।
- তাই cPanel-এ শুধু এই দুটো অ্যাপ চালালেই মূল কাজগুলো চলবে।

**যা যা লাগবে (Node ভার্সন):** Node **20** (সবচেয়ে ভালো)। কমপক্ষে **18.17**। 22-ও চলবে। cPanel-এর Node সিলেক্টরে যা আছে, তার মধ্যে 20 বেছে নিন।

---

## ৪. ডেপ্লয় করার ধাপ — cPanel লগইন পেলেই (এখনো লগইন নেই, তাই কিছু করা হয়নি)

### ধাপ ০ — আগে যা লাগবে
- [ ] cPanel লগইন (ইউজারনেম/পাসওয়ার্ড — নিরাপদ কার্ডে দিতে হবে, চ্যাটে নয়)
- [ ] cPanel-এ **Terminal** আছে কি না দেখে নেওয়া (থাকলে কাজ অনেক সহজ হবে)
- [ ] Node সিলেক্টরে 20 (বা 18.17+) আছে কি না দেখে নেওয়া

### ধাপ ১ — সাবডোমেইন বানানো
1. cPanel → **Subdomains** → `api` লিখে `api.yearmedia.xyz` বানান।
2. cPanel → **SSL/TLS Status** → `yearmedia.xyz` আর `api.yearmedia.xyz` — দুটোতেই **AutoSSL** চালু করুন (ফ্রি, https-এর জন্য)।

### ধাপ ২ — ফাইল আপলোড
1. নিজের কম্পিউটারে (লোকাল) এই দুটো বিল্ড আবার করে নিন:
   ```bash
   cd workspace/ai-sales-inbox/apps/api && npm run build
   cd ../web && NEXT_PUBLIC_API_URL=https://api.yearmedia.xyz npm run build
   ```
   ⚠️ **খেয়াল:** ওয়েবের ঠিকানা (`NEXT_PUBLIC_API_URL`) বিল্ডের সময় ভেতরে বসে যায়। API-র ঠিকানা বদলালে ওয়েব আবার বিল্ড করে আপলোড করতে হবে।
2. এই ফাইলগুলো zip করে cPanel **File Manager** দিয়ে আপলোড করুন, `~/ai-sales-inbox/` ফোল্ডারে extract করুন:
   - `schema.sql` (রুটে)
   - `apps/api/dist/` (বিল্ড করা API)
   - `apps/api/package.json`
   - `apps/api/src/db/migrations/` (১২টা SQL ফাইল — প্রথম চালুতে ডেটাবেজ বানাতে লাগবে)
   - `apps/web/.next/` (বিল্ড করা ওয়েব)
   - `apps/web/package.json`
   - `apps/web/server.js` (নিচের ধাপ ৩-এর ফাইল)
   - `apps/web/next.config.js`, `apps/web/public/` (যদি থাকে)
3. **আপলোড করবেন না:** `node_modules` (অনেক বড় — API ৮২ MB, ওয়েব ৩৪১ MB), `.pglite-data` (লোকাল পরীক্ষার ডেটা — সার্ভারে নতুন ডেটাবেজ হবে), `.env` ফাইল (চাবি cPanel-এ বসবে, ফাইলে নয়)।

### ধাপ ৩ — ওয়েবের `server.js` ফাইল (নতুন ফাইল, ডেপ্লয়ের সময় বানাতে হবে)
`apps/web/server.js` — cPanel `node server.js` দিয়ে চালাবে:
```js
// cPanel Node app starter — Next.js production server (wrapper).
const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');

const port = parseInt(process.env.PORT, 10) || 3000;
const app = next({ dev: false, dir: __dirname });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  createServer((req, res) => {
    const parsedUrl = parse(req.url, true);
    handle(req, res, parsedUrl);
  }).listen(port, () => {
    console.log(`Web ready on port ${port}`);
  });
});
```

### ধাপ ৪ — Terminal দিয়ে প্যাকেজ ইনস্টল
cPanel **Terminal** খুলে:
```bash
cd ~/ai-sales-inbox/apps/api && npm install --omit=dev
cd ~/ai-sales-inbox/apps/web && npm install --omit=dev
```
(টার্মিনাল না থাকলে `node_modules` zip করে আপলোড করতে হবে — ধীর কিন্তু চলবে।)

### ধাপ ৫ — Node অ্যাপ ১: API (`api.yearmedia.xyz`)
cPanel → **Setup Node.js App** → **Create Application**:
| সেটিং | মান |
|---|---|
| Node.js version | 20 (বা 18.17+) |
| Application mode | Production |
| Application root | `ai-sales-inbox` |
| Application URL | `api.yearmedia.xyz` |
| Application startup file | `apps/api/dist/index.js` |

তারপর **Environment variables**-এ এগুলো বসান (মানগুলো লোকাল `apps/api/.env` থেকে কপি করুন — মান এখানে লেখা হয়নি):

| নাম | মান |
|---|---|
| `DATABASE_URL` | `pglite://./.pglite-data` |
| `JWT_SECRET` | নতুন র‍্যান্ডম (Terminal-এ `openssl rand -hex 32` চালিয়ে বানান) |
| `TOKEN_ENCRYPTION_KEY` | নতুন র‍্যান্ডম ৬৪ অক্ষরের hex (`openssl rand -hex 32`) |
| `AI_PROVIDER` | `groq` |
| `GROQ_API_KEY` | লোকাল `.env` থেকে কপি |
| `GROQ_MODEL` | `openai/gpt-oss-20b` |
| `OWNER_SETUP_TOKEN` | নতুন র‍্যান্ডম (মালিক বানানোর সময় লাগবে, কাউকে দেবেন না) |
| `META_APP_ID` / `META_APP_SECRET` / `META_VERIFY_TOKEN` | Meta অ্যাপ তৈরি হলে বসাবেন — এখন ফাঁকা রাখলেও চলবে |

**বসাবেন না:** `PORT` (cPanel নিজে দেয়), `REDIS_URL` (দিলে ফলব্যাক নষ্ট হতে পারে — ফাঁকা রাখুন), `SEED_DEMO`, `ALLOW_SUBSCRIPTION_TEST_HOOKS`, `ALLOW_OWNER_TEST_HOOKS`, `AI_MOCK_PROVIDERS` (এগুলো শুধু পরীক্ষার জন্য, প্রোডাকশনে কখনো নয়)।

### ধাপ ৬ — Node অ্যাপ ২: ওয়েব (`yearmedia.xyz`)
cPanel → **Setup Node.js App** → **Create Application**:
| সেটিং | মান |
|---|---|
| Node.js version | 20 (বা 18.17+) |
| Application mode | Production |
| Application root | `ai-sales-inbox/apps/web` |
| Application URL | `yearmedia.xyz` |
| Application startup file | `server.js` |

Environment variable: কিছু লাগবে না (API-র ঠিকানা বিল্ডের সময় বসে গেছে)।

> **.htaccess / প্রক্সি লাগবে না।** cPanel-এর Node অ্যাপ ডোমেইনটাকে সরাসরি Node-এর সাথে যুক্ত করে — আলাদা rewrite নিয়ম লিখতে হয় না। `public_html`-এ কিছু বসাতে হবে না।

### ধাপ ৭ — যাচাই (সব ঠিক আছে কি না)
1. `https://api.yearmedia.xyz/api/health` খুলুন → `{"status":"ok",...}` দেখাতে হবে।
2. `https://yearmedia.xyz/login` খুলুন → লগইন পেজ আসতে হবে।
3. নতুন অ্যাকাউন্ট খুলুন (সাইনআপ) → ঢুকতে হবে, ৳৫০ ফ্রি ক্রেডিট দেখাতে হবে।
4. একটা ছবি আপলোড করে দেখুন (পোস্ট শিডিউল → ছবি) → প্রিভিউ আসতে হবে।
5. মালিক বানানো (একবারই): সাইনআপ করা ইমেইল দিয়ে `POST https://api.yearmedia.xyz/api/owner/setup` কল করুন, সাথে `OWNER_SETUP_TOKEN`। তারপর ড্যাশবোর্ডে **মালিক** মেনু আসবে।
6. Meta webhook ঠিকানা (পরে Meta অ্যাপে বসাতে হবে): `https://api.yearmedia.xyz/api/webhooks/meta`

### ধাপ ৮ — ব্যাকআপের নিয়ম (অস্থায়ী সেটআপে এটা জরুরি)
- সপ্তাহে একবার File Manager থেকে এই দুটো ফোল্ডার ডাউনলোড করে রাখুন:
  - `~/ai-sales-inbox/.pglite-data/` (সব দোকান/অর্ডার/চ্যাটের ডেটা)
  - `~/ai-sales-inbox/uploads/` (আপলোড করা ছবি/ভিডিও)
- শেয়ার্ড হোস্টিং-এ অটো ব্যাকআপের ভরসা নেই — ফোল্ডার মুছে গেলে ডেটা ফিরবে না।

---

## ৫. এই অস্থায়ী সেটআপের সীমাবদ্ধতা — সত্যি কথা

| বিষয় | অবস্থা |
|---|---|
| **Redis / আলাদা Worker** | নেই। API নিজেই উত্তর দেয় (৩ সেকেন্ডের নিয়ম একই)। কিন্তু API বন্ধ/রিস্টার্ট হলে সেই মুহূর্তে আটকে থাকা উত্তর হারাতে পারে — কিউতে জমা থাকবে না। |
| **ডেটাবেজ** | PGlite ফাইল-ডেটাবেজ। একটাই প্রসেস খুলতে পারে। হাজার হাজার দোকান/ভারী চাপ সামলাবে না। ব্যাকআপ হাতে নিতে হবে। |
| **ছবি খোঁজা (এমবেডিং)** | চাবি ছাড়া স্টাব — ছবি দিয়ে প্রোডাক্ট খোঁজা কাজ করবে না (আগের মতোই)। |
| **কুরিয়ার** | স্টাব — আসল ট্র্যাকিং নম্বর আসবে না, যতক্ষণ Pathao/Steadfast/RedX-এর চাবি না বসে। |
| **বিকাশ/নগদ** | লাইভ নয় — ম্যানুয়াল টপ-আপ (টাকা পাঠিয়ে ট্রানজাকশন আইডি জমা) চলবে। |
| **WhatsApp / TikTok** | অনুমোদন ছাড়া `pending_approval` — মেসেজ আসবে না (আগের মতোই)। |
| **Meta / Facebook** | ওয়েবহুক ঠিকানা তৈরি হবে, কিন্তু Meta অনুমোদন না হওয়া পর্যন্ত আসল পেজের মেসেজ আসবে না। |
| **আপলোড** | সর্বোচ্চ ২৫ MB। ফাইল সার্ভারের ডিস্কে থাকে — CDN/S3 নেই। |
| **AI সীমা** | Groq ফ্রি: দিনে ১০০০ উত্তর। এর বেশি হলে উত্তর থেমে যাবে। |
| **সার্ভার বন্ধ হওয়া** | কিছু শেয়ার্ড হোস্ট অনেকক্ষণ কেউ না ঢুকলে Node অ্যাপ থামিয়ে দেয় — তখন শিডিউল করা পোস্ট/ফলো-আপ থেমে থাকবে, কেউ ঢুকলে আবার চালু হবে। |
| **স্কেল** | অল্প কিছু দোকান দিয়ে চালু করে দেখার জন্য ঠিক আছে। হাজার হাজার ইউজারের জন্য নয়। |

**যা যা আগের মতোই পুরো কাজ করবে:** সাইনআপ/লগইন, দোকান, প্রোডাক্ট, অর্ডার, ইনবক্সে AI উত্তর (Groq), কুপন, সাবস্ক্রিপশন, পোস্ট শিডিউল (ভিডিও/ছবি, দিনে ১৫টা), ফলো-আপ, হস্তান্তর, সেভ করা উত্তর, Agent Desk, টিম, মালিক প্যানেল, বিলিং/ওয়ালেট (ম্যানুয়াল টপ-আপ)।

---

## ৬. ফাইনাল সেটআপে যা লাগবে (পরে নতুন করে করার সময়)

- **VPS** (যেমন DigitalOcean/Hostinger VPS) — Node, Postgres, Redis, Worker আলাদা করে চালানো যাবে।
- **আসল Postgres** (+ pgvector — ছবি দিয়ে প্রোডাক্ট খোঁজার জন্য) আর **Redis** (BullMQ কিউ + Worker)।
- **PM2 / systemd** দিয়ে API, Worker, Web আলাদা সার্ভিস হিসেবে চালানো + অটো-রিস্টার্ট।
- **S3-স্টোরেজ** (ছবি/ভিডিওর জন্য) + নিয়মিত অটো ব্যাকআপ।
- **Meta App Review + Business Verification** (আসল Facebook পেজ যুক্ত করতে)।
- **কুরিয়ার চাবি, বিকাশ/নগদ মার্চেন্ট, WhatsApp/TikTok অনুমোদন, চার AI-এর চাবি** — পাবলিশের সময়।

---

## ৭. English technical summary

**Stack:** Next.js 14.2.5 web (`apps/web`, `next start` via `server.js` wrapper, port from `PORT` env) + Express API (`apps/api`, `tsc` → `node dist/index.js`, port from `PORT` env). DB: PGlite file-based Postgres (auto-loads `schema.sql` — 26 tables — + 12 migrations from `apps/api/src/db/migrations` on first query; single-process only). Queue: BullMQ/Redis optional — API falls back to in-process processing with the same 3s debounce, and runs a 60s in-process sweep for due scheduled posts / follow-ups / handovers / owner wallet deductions. Uploads: local files under `uploads/`, served at `/uploads/*`. CORS: open (`cors()`). Web → API via `NEXT_PUBLIC_API_URL` (baked in at build time — rebuild web if the API origin changes).

**Node:** >= 18.17 required (Next 14.2.5 + PGlite 0.5.15); recommend Node 20 LTS. Verified locally on Node 24.22.1: API `tsc` clean, web `next build` clean (39 pages), fresh-PGlite smoke test passed (health ok, signup ok, 5000 paisa credit, 26 tables + 12 migrations auto-applied).

**cPanel layout:** two "Setup Node.js App" applications sharing one uploaded repo copy at `~/ai-sales-inbox/`: API app (root `ai-sales-inbox`, startup `apps/api/dist/index.js`, domain `api.yearmedia.xyz`) and web app (root `ai-sales-inbox/apps/web`, startup `server.js`, domain `yearmedia.xyz`). Env vars set in the cPanel UI (no `.env` file on the server). Do not set `PORT` (Passenger provides it) or `REDIS_URL` (leave unset so the in-process fallback engages). Never set `SEED_DEMO`, `ALLOW_SUBSCRIPTION_TEST_HOOKS`, `ALLOW_OWNER_TEST_HOOKS`, `AI_MOCK_PROVIDERS` in production. No `.htaccess` proxy needed — Passenger binds each domain directly to its Node app. Enable AutoSSL for both domains. Upload via File Manager zip (exclude `node_modules`, `.pglite-data`, `.env`); run `npm install --omit=dev` in `apps/api` and `apps/web` via cPanel Terminal. Back up `.pglite-data/` and `uploads/` manually — no managed backups on shared hosting.

**Known limits (temporary):** no queue persistence (in-process only — a restart can drop a pending AI reply); PGlite single-process file DB, no pgvector (image-match stays stub); courier stub; bKash/Nagad manual top-up only; WhatsApp/TikTok `pending_approval` until approved; Meta approval still pending; Groq free tier 1,000 replies/day; 25 MB upload cap; possible idle-stop of Node apps by the host (scheduled posts/follow-ups pause until next request). Final setup should be a VPS with real Postgres + pgvector, Redis + BullMQ worker, PM2/systemd, S3 storage, and automated backups.
