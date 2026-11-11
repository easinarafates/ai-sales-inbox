/**
 * Production schema bootstrap — YEARBITO Phase 2 billing (migration 35).
 *
 * WHY THIS FILE EXISTS: the API auto-applies the .sql migrations on boot
 * ONLY in local PGlite mode. On real Postgres (production Neon) the
 * documented path is `psql "$DATABASE_URL" -f ...` (see RUNNING.md §7)
 * — but in this environment the production DATABASE_URL cannot be read
 * at all: the runtime redacts secret values from `vercel env pull`
 * (the pulled file literally contains DATABASE_URL="[SENSITIVE]"), so
 * no operator step here can run psql against Neon. The API itself must
 * therefore apply the migration on boot.
 *
 * WHY EMBEDDED SQL: Vercel's serverless bundle only includes files the
 * function imports — the .sql migration files are NOT in the bundle —
 * so the runner cannot read them from disk at runtime. The SQL below
 * is an exact copy of apps/api/src/db/migrations/35-yearbito-billing.sql
 * (verified mechanically: see scripts/check-migration-35-embedded.mjs).
 * SOURCE OF TRUTH is the .sql file — if it ever changes, regenerate
 * this constant from it; do not edit the SQL here by hand.
 *
 * SAFETY: the SQL is fully idempotent (ADD COLUMN IF NOT EXISTS /
 * CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS), so running
 * it on every cold start is safe, and concurrent cold starts are safe
 * (Postgres serialises the DDL). It runs ONCE per process (module flag)
 * and never blocks a request for long; if it fails, the error is logged
 * loudly and the API keeps serving — the billing endpoints then fail
 * honestly until the schema is applied, and the next request retries
 * (with a 60s cooldown so a persistent failure does not spam the DB).
 */
import { pool } from './pool';
import { isPgliteMode } from './pglite';

const MIGRATION_35_SQL = `-- 35-yearbito-billing.sql — YEARBITO new billing model (Phase 2).
--
-- The old plans (ছোট ৳৪৯৯ / মাঝারি ৳৯৯৯ / বড় ৳১৯৯৯, migration 04)
-- are NO LONGER SOLD, but their rows stay in \`plans\` and existing
-- workspace_subscriptions keep working until their period ends
-- (grandfathered). The new model has three separate components:
--   1. Post Schedule subscription (schedule_subscriptions): 1 scheduled
--      post/day is FREE; more needs a subscription — BD ৳100/month,
--      ৳1000/year; Intl $1/month, $10/year. No lifetime plan.
--   2. Pay-as-you-go AI credit: AI replies deduct a FLAT 23 paisa
--      from the wallet (config PAYG_REPLY_COST_PAISA); the provider's
--      real per-token cost is still recorded per reply in
--      ai_usage_ledger.provider_cost_paisa for transparency, but the
--      wallet charge is the flat price (no new table — the existing
--      ai_usage_ledger + wallet_transactions already record it).
--   3. Reply package: bought upfront at 22 paisa/reply (config
--      REPLY_PACKAGE_PRICE_PAISA); credits live on the workspace
--      (reply_credits) and are consumed BEFORE pay-as-you-go.
-- Idempotent: safe to re-run on every start (same pattern as the other
-- migrations). Loads on local PGlite (auto-run on boot) and on Neon
-- Postgres with psql — load it into Neon BEFORE the next API deploy.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS reply_credits INT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS schedule_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  billing_cycle TEXT NOT NULL, -- monthly | yearly
  currency TEXT NOT NULL DEFAULT 'BDT', -- BDT | USD
  price_paisa BIGINT NOT NULL DEFAULT 0, -- what the wallet was actually charged (USD plans are converted at USD_TO_BDT_PAISA)
  status TEXT NOT NULL DEFAULT 'active', -- active | cancelled
  current_period_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  current_period_end TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sched_subs_workspace ON schedule_subscriptions(workspace_id, created_at DESC);

-- Which ledger rows were paid with a reply-package credit (cost 0, no
-- wallet deduction) instead of wallet money / an included plan reply.
ALTER TABLE ai_usage_ledger ADD COLUMN IF NOT EXISTS package_credit_used BOOLEAN NOT NULL DEFAULT FALSE;
`;

let migrationPromise: Promise<void> | null = null;
let lastAttemptAt = 0;
const RETRY_COOLDOWN_MS = 60 * 1000;

const MIGRATION_36_SQL = `-- 36-product-variants-main-images-coupons.sql — YEARBITO Tasks 6 + 11.
--
-- Task 6 — Product main images + variants:
--   * product_images.is_main: a product has 1–2 MAIN images (shown in the
--     list and sent to customers by default); the rest (up to 10 total)
--     are additional photos, sent only when the customer asks for them.
--     Backfill: each product's earliest photo becomes its main photo, so
--     existing products keep exactly the photo the AI already sends
--     (the earliest one) — no behaviour change for gd_arafat.
--   * products.variant_type + products.variants: the owner FIRST picks a
--     variant TYPE (size / kg / weight / colour / piece / custom), THEN
--     adds values with a price (and optional stock) each, e.g.
--     type=size → M ৳400, L ৳450. variants is JSONB:
--     [{ "value": "M", "price_paisa": 40000, "stock": 10 }, ...].
--     Existing products keep their plain \`size\` column as-is; a product
--     with no variants works exactly as before (base price_paisa).
-- Task 11 — Coupon product selection + min order:
--   * coupons.product_id: NULL = applies to any product (as today);
--     set = the coupon applies ONLY to orders containing that product.
--   * coupons.min_order_paisa: minimum order subtotal (paisa) for the
--     coupon to apply; 0 = no minimum (as today). The task lists min
--     order as an existing coupon field, but no column existed — this
--     adds it, defaulting to 0 so every existing coupon is unaffected.
-- Idempotent: safe to re-run (same pattern as the other migrations).
-- Loads on local PGlite (auto-run on boot) and on Neon Postgres — the
-- embedded copy in apps/api/src/db/migrate-prod.ts MUST match this file
-- exactly (see scripts/check-migration-36-embedded.mjs).
ALTER TABLE product_images ADD COLUMN IF NOT EXISTS is_main BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill: the earliest photo of each product is its main photo.
UPDATE product_images pi SET is_main = TRUE
WHERE pi.id IN (
  SELECT DISTINCT ON (product_id) id FROM product_images ORDER BY product_id, created_at ASC
);

ALTER TABLE products ADD COLUMN IF NOT EXISTS variant_type TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS variants JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE coupons ADD COLUMN IF NOT EXISTS product_id UUID REFERENCES products(id) ON DELETE SET NULL;
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS min_order_paisa BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_coupons_product ON coupons(workspace_id, product_id);
`;

let migration36Promise: Promise<void> | null = null;
let last36AttemptAt = 0;

const MIGRATION_37_SQL = `-- 37-yearbito-tasks-789.sql — YEARBITO Tasks 7 + 8 + 9.
--
-- Task 8 — Courier: delivery charge by DISTRICT (64 districts).
--   * workspaces.business_district: the district the BUSINESS is in
--     (lowercase English, e.g. 'magura'). NULL until the owner picks
--     one on the Courier page — until then the old Dhaka-based
--     behaviour applies, so no customer is ever charged differently
--     by surprise.
--   * delivery_charge_rules scopes are renamed to match the doc:
--     'inside_dhaka' → 'inside_district' (charge inside the
--     business's own district) and 'outside_dhaka' → 'outside_district'
--     (charge everywhere else). The AMOUNTS are preserved exactly —
--     the UPDATE only renames the scope, so a shop that charged ৳100 /
--     ৳130 keeps charging ৳100 / ৳130. Per-district rules ('district'
--     scope) are untouched.
--   * The service still accepts the old scope names on read (defensive
--     normalisation), so a workspace whose rules were never migrated
--     still resolves charges the old way.
-- Idempotent: safe to re-run (same pattern as the other migrations).
-- The embedded copy in apps/api/src/db/migrate-prod.ts MUST match this
-- file exactly (see scripts/check-migration-37-embedded.mjs).
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS business_district TEXT;

-- Widen the scope CHECK, rename the two base zones, re-add the CHECK.
ALTER TABLE delivery_charge_rules DROP CONSTRAINT IF EXISTS delivery_charge_rules_scope_check;
UPDATE delivery_charge_rules SET scope = 'inside_district' WHERE scope = 'inside_dhaka';
UPDATE delivery_charge_rules SET scope = 'outside_district' WHERE scope = 'outside_dhaka';
ALTER TABLE delivery_charge_rules ADD CONSTRAINT delivery_charge_rules_scope_check
  CHECK (scope IN ('inside_district', 'outside_district', 'district'));
`;

let migration37Promise: Promise<void> | null = null;
let last37AttemptAt = 0;

const MIGRATION_38_SQL = `-- 38-tasks-3-14-15-16-17.sql — YEARBITO Tasks 3 + 14 + 15 + 16 + 17.
--
-- Task 3 — Login/logout: JWTs are stateless, so "logout" used to clear
-- only the browser token — a copied token stayed valid for 30 days.
-- revoked_tokens records the jti of tokens logged out via
-- POST /api/auth/logout; requireAuth rejects them. Rows expire with
-- the token (expires_at) and are pruned best-effort on logout.
-- No other schema change is needed for this batch:
--   * Task 14 (AI Providers owner-only) is enforced in code against
--     the existing members.role column — no new column.
--   * Task 15 (Setup) uses the existing setup_progress table (07/08).
--   * Task 16 (Team invites) uses the existing team_invites table
--     (08); accepting an invite only flips status to 'accepted' and
--     inserts the normal users + members rows.
--   * Task 17 (Guide) is a web-only placeholder — no schema.
-- Idempotent: safe to re-run (same pattern as migrations 35–37).
-- The embedded copy in apps/api/src/db/migrate-prod.ts MUST match this
-- file exactly (see scripts/check-migration-38-embedded.mjs).

CREATE TABLE IF NOT EXISTS revoked_tokens (
  jti TEXT PRIMARY KEY,
  user_id UUID,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires ON revoked_tokens(expires_at);
`;

let migration38Promise: Promise<void> | null = null;
let last38AttemptAt = 0;

const MIGRATION_39_SQL = `-- 39-ai-prompt-cache.sql — Gemini 24h prompt caching (2026-11-11).
--
-- The sales agent's prompt has a STABLE prefix (system prompt + shop
-- context: knowledge + delivery charges + products, ~3,517 tokens) that
-- is identical for every reply of a shop, and a VARIABLE suffix (this
-- customer, history, new messages). The stable prefix can live in a
-- Gemini explicit cachedContent (TTL 24h), priced at the cached-input
-- rate ($0.03/1M instead of $0.30/1M for gemini-3.5-flash-lite).
--
--   * ai_usage_ledger.cached_input_tokens: tokens of a reply served
--     from a prompt cache (explicit or implicit), so provider_cost_paisa
--     can be computed with the discounted cached rate (pricing.ts).
--   * ai_prompt_caches: one explicit-cache record per workspace —
--     the Gemini cache name, the SHA-256 of the cached stable context
--     (a price/product/knowledge change changes the hash, so the next
--     reply drops the stale cache and recreates it), its token count,
--     expiry, and last use (caches idle > 2h are deleted on load, so a
--     quiet shop stops paying the $1.00/1M-tokens/hour storage cost).
--
-- Break-even (see ai-agent/gemini-cache.ts): storage for a 3,517-token
-- prefix costs ~1,029 paisa/day; each cached reply saves ~11.6 paisa —
-- so explicit caching only pays past ~89 replies/day per shop. Cache
-- creation is therefore volume-gated in code (>= 4 AI replies in the
-- last 60 minutes); the table alone never creates a cache.
--
-- Idempotent: safe to re-run (same pattern as migrations 35–38).
-- The embedded copy in apps/api/src/db/migrate-prod.ts MUST match this
-- file exactly (see scripts/check-migration-39-embedded.mjs).
ALTER TABLE ai_usage_ledger ADD COLUMN IF NOT EXISTS cached_input_tokens INT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS ai_prompt_caches (
  workspace_id UUID PRIMARY KEY,
  cache_name TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  token_count INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_prompt_caches_expires ON ai_prompt_caches(expires_at);
`;

let migration39Promise: Promise<void> | null = null;
let last39AttemptAt = 0;

/**
 * Ensure the AI prompt-cache schema exists (real Postgres only).
 * Same pattern as ensureTasks314151617Schema above.
 */
export function ensureAiPromptCacheSchema(): Promise<void> {
  if (isPgliteMode()) return Promise.resolve();
  const now = Date.now();
  if (!migration39Promise && now - last39AttemptAt < RETRY_COOLDOWN_MS) {
    return Promise.resolve();
  }
  if (!migration39Promise) {
    last39AttemptAt = now;
    migration39Promise = (async () => {
      try {
        await pool.query(MIGRATION_39_SQL);
        console.log('[db] migration 39 (ai-prompt-cache) applied/verified');
      } catch (err) {
        console.error('[db] migration 39 FAILED — cached_input_tokens will error until it is applied:', (err as Error).message);
        migration39Promise = null;
      }
    })();
  }
  return migration39Promise;
}

let migration40Promise: Promise<void> | null = null;
let last40AttemptAt = 0;

const MIGRATION_40_SQL = `-- 40-user-phone.sql — profile phone number (2026-11-11).
--
-- The Profile page lets the user change their phone number (the number
-- is editable; the email is the login identity and stays locked).
-- The users table had no phone column, so PATCH /api/profile could not
-- store one.
--
-- Idempotent: safe to re-run (same pattern as migrations 35–39).
-- The embedded copy in apps/api/src/db/migrate-prod.ts MUST match this
-- file exactly.
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
`;

/**
 * Ensure the users.phone column exists (real Postgres only).
 * Same pattern as ensureAiPromptCacheSchema above.
 */
export function ensureUserPhoneSchema(): Promise<void> {
  if (isPgliteMode()) return Promise.resolve();
  const now = Date.now();
  if (!migration40Promise && now - last40AttemptAt < RETRY_COOLDOWN_MS) {
    return Promise.resolve();
  }
  if (!migration40Promise) {
    last40AttemptAt = now;
    migration40Promise = (async () => {
      try {
        await pool.query(MIGRATION_40_SQL);
        console.log('[db] migration 40 (user-phone) applied/verified');
      } catch (err) {
        console.error('[db] migration 40 FAILED — profile phone will error until it is applied:', (err as Error).message);
        migration40Promise = null;
      }
    })();
  }
  return migration40Promise;
}

let migration41Promise: Promise<void> | null = null;
let last41AttemptAt = 0;

const MIGRATION_41_SQL = `-- 41-page-read.sql — Page Read (Feature 2): AI learns the whole Facebook page (2026-11-11).
--
-- The Halal Chic Page has OLD products sold long ago that are NOT in the
-- website's product list. When a customer sends a screenshot of an old
-- product, the AI does not recognise it. "পেজ পড়ুন" (Read Page) fetches
-- the Page's post history via the Graph API with the stored Page token,
-- extracts candidate products with Gemini Lite, and stores them here as
-- PENDING items. Nothing goes live in the AI's knowledge until the owner
-- reviews and confirms each item (POST /api/knowledge/page-read/:id/confirm
-- copies it into knowledge_items with the old-product wording and marks
-- this row 'confirmed'). Rejected rows stay as 'rejected' so a re-read
-- does not surface the same product again.
--
-- Idempotent: safe to re-run (same pattern as migrations 35–40).
-- NOTE: on real Postgres (Neon) this file must be applied with psql OR
-- embedded in apps/api/src/db/migrate-prod.ts (migration 41) before the
-- next API deploy — the Vercel bundle does not include .sql files.
-- Local PGlite applies it from disk automatically on boot.
CREATE TABLE IF NOT EXISTS page_read_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  name TEXT NOT NULL,
  price_paisa INT, -- NULL = the post stated no price; NEVER invent one
  description TEXT,
  photo_url TEXT,
  source_post_id TEXT,
  source_post_url TEXT,
  post_created_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | rejected
  knowledge_id UUID, -- knowledge_items row created on confirm
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_page_read_products_workspace_status
  ON page_read_products (workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_page_read_products_source_post
  ON page_read_products (workspace_id, source_post_id);
`;

/**
 * Ensure the page_read_products table exists (real Postgres only).
 * Same pattern as ensureUserPhoneSchema above.
 */
export function ensurePageReadSchema(): Promise<void> {
  if (isPgliteMode()) return Promise.resolve();
  const now = Date.now();
  if (!migration41Promise && now - last41AttemptAt < RETRY_COOLDOWN_MS) {
    return Promise.resolve();
  }
  if (!migration41Promise) {
    last41AttemptAt = now;
    migration41Promise = (async () => {
      try {
        await pool.query(MIGRATION_41_SQL);
        console.log('[db] migration 41 (page-read) applied/verified');
      } catch (err) {
        console.error('[db] migration 41 FAILED — page-read products will error until it is applied:', (err as Error).message);
        migration41Promise = null;
      }
    })();
  }
  return migration41Promise;
}

let migration42Promise: Promise<void> | null = null;
let last42AttemptAt = 0;

const MIGRATION_42_SQL = `-- 42-owner-ai-chat.sql — Owner AI chat history ("AI Sales Manager", 2026-11-11).
--
-- The shop owner chats with the AI about the shop's REAL numbers
-- (orders/replies/cost today). Each turn is stored per workspace so the
-- page loads past messages on open. One row per message (user or
-- assistant); the API pairs them by created_at order.
--
-- Idempotent: safe to re-run (same pattern as migrations 35–40).
-- NOTE: the embedded copy in apps/api/src/db/migrate-prod.ts must be
-- added by the coordinator before deploy (migrate-prod.ts is owned by
-- another worker) — PGlite applies this file automatically on boot.
CREATE TABLE IF NOT EXISTS owner_ai_chats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  user_id UUID,
  role TEXT NOT NULL, -- 'user' | 'assistant'
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_owner_ai_chats_workspace_created
  ON owner_ai_chats (workspace_id, created_at);
`;

/**
 * Ensure the owner_ai_chats table exists (real Postgres only).
 * Same pattern as ensureUserPhoneSchema above.
 */
export function ensureOwnerAiChatSchema(): Promise<void> {
  if (isPgliteMode()) return Promise.resolve();
  const now = Date.now();
  if (!migration42Promise && now - last42AttemptAt < RETRY_COOLDOWN_MS) {
    return Promise.resolve();
  }
  if (!migration42Promise) {
    last42AttemptAt = now;
    migration42Promise = (async () => {
      try {
        await pool.query(MIGRATION_42_SQL);
        console.log('[db] migration 42 (owner-ai-chat) applied/verified');
      } catch (err) {
        console.error('[db] migration 42 FAILED — owner AI chat will error until it is applied:', (err as Error).message);
        migration42Promise = null;
      }
    })();
  }
  return migration42Promise;
}

let migration46Promise: Promise<void> | null = null;
let last46AttemptAt = 0;

const MIGRATION_46_SQL = `-- 46-topup-purpose.sql — checkout purpose on manual top-up requests (2026-11-11).
--
-- The checkout page lets a shop pay for a specific product by hand
-- (bKash / Nagad / Rocket / bank + TrxID): the request carries a purpose
-- so approval DELIVERS the product instead of only crediting the wallet.
-- purpose is a JSON string:
--   {"kind":"schedule","slug":"schedule-monthly-bdt"}
--   {"kind":"package","replies":500}
--   {"kind":"payg"}
--   null = plain wallet top-up (the old TopupSection flow).
--
-- Idempotent: safe to re-run (same pattern as migrations 35–40).
-- The embedded copy in apps/api/src/db/migrate-prod.ts MUST match this
-- file exactly.
ALTER TABLE topup_requests ADD COLUMN IF NOT EXISTS purpose TEXT;
`;

/**
 * Ensure the topup_requests.purpose column exists (real Postgres only).
 * Same pattern as ensureUserPhoneSchema above.
 */
export function ensureTopupPurposeSchema(): Promise<void> {
  if (isPgliteMode()) return Promise.resolve();
  const now = Date.now();
  if (!migration46Promise && now - last46AttemptAt < RETRY_COOLDOWN_MS) {
    return Promise.resolve();
  }
  if (!migration46Promise) {
    last46AttemptAt = now;
    migration46Promise = (async () => {
      try {
        await pool.query(MIGRATION_46_SQL);
        console.log('[db] migration 46 (topup-purpose) applied/verified');
      } catch (err) {
        console.error('[db] migration 46 FAILED — checkout purpose will error until it is applied:', (err as Error).message);
        migration46Promise = null;
      }
    })();
  }
  return migration46Promise;
}

let migration45Promise: Promise<void> | null = null;
let last45AttemptAt = 0;

const MIGRATION_45_SQL = `-- 45-owner-panel-manage.sql — Owner Panel user + subscription management (2026-11-11).
--
-- Feature 5: the platform owner can block / restrict / delete user
-- accounts and approve / cancel subscriptions from /owner.
--
-- users.account_status — 'active' | 'blocked' | 'restricted' | 'deleted'
--   * blocked: cannot log in at all (auth/routes.ts login returns 403
--     with "আপনার অ্যাকাউন্টটি ব্লক করা হয়েছে").
--   * restricted: CAN log in, but AI replies and post scheduling are
--     disabled (read-only). Enforced per-workspace via
--     workspaces.restricted (see below) — checkAiReplyAllowance refuses
--     the reply and the schedule-post endpoints refuse the post.
--   * deleted: SOFT delete — the row stays (data recoverable), login
--     is refused, deleted_at records when it happened. Nothing is hard
--     deleted by the Owner Panel.
-- workspaces.restricted — enforcement flag for restrict. It lives on
--   the workspace because AI replies and scheduling are workspace-level
--   (the webhook has no per-user context): restricting one account
--   restricts that account's whole shop. Cleared on unrestrict, unless
--   another user of the same workspace is still restricted.
-- owner_audit_log — every owner management action (who, when, target,
--   action) so nothing happens silently.
--
-- LIMIT (honest): JWTs are stateless — blocking/deleting does NOT
-- revoke tokens already issued (their jti values are not stored
-- anywhere to revoke). A blocked user's existing session keeps working
-- until the token expires (30 days) or they log out (logout revokes
-- that token via revoked_tokens, migration 38). Login is refused
-- immediately, which is the part that matters for a blocked account.
--
-- Idempotent: safe to re-run (same pattern as migrations 35–40).
-- NOTE: like migrations 41/42, this file is NOT embedded in
-- apps/api/src/db/migrate-prod.ts — PGlite loads every *.sql file in
-- this folder on API start, but production (Neon) needs this file
-- applied (psql / coordinator step) before the next API deploy, or
-- login will 500 on the missing account_status column.
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS restricted BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS owner_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID,
  actor_email TEXT NOT NULL,
  target_user_id UUID,
  target_email TEXT,
  target_workspace_id UUID,
  action TEXT NOT NULL, -- block | unblock | restrict | unrestrict | delete | approve_subscription | cancel_subscription | approve_topup | reject_topup
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_owner_audit_log_created ON owner_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_owner_audit_log_target ON owner_audit_log(target_user_id, created_at DESC);
`;

/**
 * Ensure the Owner Panel management schema exists (real Postgres only).
 * Same pattern as ensureUserPhoneSchema above.
 */
export function ensureOwnerPanelManageSchema(): Promise<void> {
  if (isPgliteMode()) return Promise.resolve();
  const now = Date.now();
  if (!migration45Promise && now - last45AttemptAt < RETRY_COOLDOWN_MS) {
    return Promise.resolve();
  }
  if (!migration45Promise) {
    last45AttemptAt = now;
    migration45Promise = (async () => {
      try {
        await pool.query(MIGRATION_45_SQL);
        console.log('[db] migration 45 (owner-panel-manage) applied/verified');
      } catch (err) {
        console.error('[db] migration 45 FAILED — Owner Panel user management will error until it is applied:', (err as Error).message);
        migration45Promise = null;
      }
    })();
  }
  return migration45Promise;
}

/**
 * Ensure the Tasks 3 + 14 + 15 + 16 + 17 schema exists (real Postgres only).
 * Same pattern as ensureTasks789Schema above.
 */
export function ensureTasks314151617Schema(): Promise<void> {
  if (isPgliteMode()) return Promise.resolve();
  const now = Date.now();
  if (!migration38Promise && now - last38AttemptAt < RETRY_COOLDOWN_MS) {
    return Promise.resolve();
  }
  if (!migration38Promise) {
    last38AttemptAt = now;
    migration38Promise = (async () => {
      try {
        await pool.query(MIGRATION_38_SQL);
        console.log('[db] migration 38 (tasks-3-14-15-16-17) applied/verified');
      } catch (err) {
        console.error('[db] migration 38 FAILED — logout revocation will error until it is applied:', (err as Error).message);
        migration38Promise = null;
      }
    })();
  }
  return migration38Promise;
}

/**
 * Ensure the Tasks 7 + 8 + 9 schema exists (real Postgres only).
 * Same pattern as ensurePhase2BillingSchema above.
 */
export function ensureTasks789Schema(): Promise<void> {
  if (isPgliteMode()) return Promise.resolve();
  const now = Date.now();
  if (!migration37Promise && now - last37AttemptAt < RETRY_COOLDOWN_MS) {
    return Promise.resolve();
  }
  if (!migration37Promise) {
    last37AttemptAt = now;
    migration37Promise = (async () => {
      try {
        await pool.query(MIGRATION_37_SQL);
        console.log('[db] migration 37 (yearbito-tasks-789) applied/verified');
      } catch (err) {
        console.error('[db] migration 37 FAILED — business-district charges will error until it is applied:', (err as Error).message);
        migration37Promise = null;
      }
    })();
  }
  return migration37Promise;
}

/**
 * Ensure the Tasks 6 + 11 schema exists (real Postgres only).
 * Same pattern as ensurePhase2BillingSchema above.
 */
export function ensureProductVariantsSchema(): Promise<void> {
  if (isPgliteMode()) return Promise.resolve();
  const now = Date.now();
  if (!migration36Promise && now - last36AttemptAt < RETRY_COOLDOWN_MS) {
    return Promise.resolve();
  }
  if (!migration36Promise) {
    last36AttemptAt = now;
    migration36Promise = (async () => {
      try {
        await pool.query(MIGRATION_36_SQL);
        console.log('[db] migration 36 (product-variants-main-images-coupons) applied/verified');
      } catch (err) {
        console.error('[db] migration 36 FAILED — variants/main-images/coupon-product endpoints will error until it is applied:', (err as Error).message);
        migration36Promise = null;
      }
    })();
  }
  return migration36Promise;
}

/**
 * Ensure the Phase 2 billing schema exists (real Postgres only).
 * PGlite mode returns immediately — the PGlite adapter applies the
 * .sql files itself on boot. Safe to call on every request: after the
 * first successful run it is a resolved-promise await (microseconds).
 */
export function ensurePhase2BillingSchema(): Promise<void> {
  if (isPgliteMode()) return Promise.resolve();
  const now = Date.now();
  if (!migrationPromise && now - lastAttemptAt < RETRY_COOLDOWN_MS) {
    return Promise.resolve();
  }
  if (!migrationPromise) {
    lastAttemptAt = now;
    migrationPromise = (async () => {
      try {
        await pool.query(MIGRATION_35_SQL);
        console.log('[db] migration 35 (yearbito-billing) applied/verified');
      } catch (err) {
        // Keep serving (inbox/orders stay up); billing endpoints fail
        // honestly until the schema lands. Reset so a later request
        // retries after the cooldown.
        console.error('[db] migration 35 FAILED — billing endpoints will error until it is applied:', (err as Error).message);
        migrationPromise = null;
      }
    })();
  }
  return migrationPromise;
}
