-- সাবস্ক্রিপশন মাইগ্রেশন (04-subscriptions.sql).
-- Plain Postgres; CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS only.
-- PGlite লোকাল মোডে API চালু হওয়ার সময় নিজে থেকেই লাগায়; আসল Postgres-এ:
--   psql "$DATABASE_URL" -f apps/api/src/db/migrations/04-subscriptions.sql
-- Every table is workspace-scoped: all queries filter by workspace_id.
-- plans টেবিলটি গ্লোবাল (সব ওয়ার্কস্পেসের জন্য একই প্ল্যানের তালিকা)।

CREATE TABLE IF NOT EXISTS plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name_bn TEXT NOT NULL,
  price_paisa BIGINT NOT NULL DEFAULT 0,
  included_ai_replies INT NOT NULL DEFAULT 0,
  max_channels INT,
  max_products INT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  plan_id UUID NOT NULL REFERENCES plans(id),
  status TEXT NOT NULL DEFAULT 'trial', -- trial | active | past_due | cancelled | expired
  current_period_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  current_period_end TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ws_subs_workspace ON workspace_subscriptions(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ws_subs_plan ON workspace_subscriptions(plan_id);

-- প্রতিটি AI রিপ্লাই প্ল্যানের অন্তর্ভুক্ত ছিল কি না, তা লেজারে চিহ্নিত থাকে।
ALTER TABLE ai_usage_ledger ADD COLUMN IF NOT EXISTS included_in_plan BOOLEAN NOT NULL DEFAULT FALSE;

-- প্রস্তাবিত প্ল্যান (SUGGESTED ONLY — মালিকের সিদ্ধান্ত নয়; দাম বদলাতে চাইলে
-- মালিক জানালেই বদলে দেওয়া হবে। দাম: ছোট ৳৪৯৯, মাঝারি ৳৯৯৯, বড় ৳১৯৯৯/মাস।
-- NULL মানে সীমাহীন।)
INSERT INTO plans (slug, name_bn, price_paisa, included_ai_replies, max_channels, max_products)
VALUES
  ('choto', 'ছোট', 49900, 500, 1, 100),
  ('majhari', 'মাঝারি', 99900, 2000, 3, 500),
  ('boro', 'বড়', 199900, 8000, NULL, NULL)
ON CONFLICT (slug) DO NOTHING;
