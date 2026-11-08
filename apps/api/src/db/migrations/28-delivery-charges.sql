-- Migration 28: delivery charge rules (2026-11-08, user requirement C).
-- The shop OWNER sets delivery charges per zone (inside Dhaka, outside
-- Dhaka, or per district) in the website; the AI + order totals use these
-- configured charges instead of the hardcoded ৳100/৳130.
-- scope: 'inside_dhaka' | 'outside_dhaka' | 'district'
-- district: the district name (lowercase English, e.g. 'magura') for
-- district-scoped rules; NULL for the two base zones.
-- Defaults (inside Dhaka ৳100, outside Dhaka ৳130) are seeded lazily by
-- the service when a workspace has no rules yet — not here, so new
-- workspaces get them automatically.
CREATE TABLE IF NOT EXISTS delivery_charge_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('inside_dhaka', 'outside_dhaka', 'district')),
  district TEXT,
  charge_paisa INTEGER NOT NULL CHECK (charge_paisa >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, scope, district)
);
CREATE INDEX IF NOT EXISTS idx_delivery_charge_rules_workspace
  ON delivery_charge_rules (workspace_id);
