/**
 * Delivery charge rules (requirement C, 2026-11-08; district model,
 * Task 8, 2026-11-11).
 *
 * The shop OWNER sets the delivery charge on the Courier page:
 *  - the business's OWN district (workspaces.business_district — one
 *    of the 64 districts; NULL until the owner picks one),
 *  - an "inside district" charge (customer in the same district as
 *    the business) and an "outside district" charge (everywhere else).
 * Defaults are the values the owner taught the AI (inside ৳100,
 * outside ৳130) — seeded lazily the first time a workspace has no
 * rules, so new shops start with the same charges.
 *
 * Migration 37 renamed the two base scopes from 'inside_dhaka' /
 * 'outside_dhaka' to 'inside_district' / 'outside_district' (amounts
 * preserved). Old scope names are still accepted on read and on save
 * (normalised here), so a workspace whose rows were never migrated
 * still resolves charges correctly.
 *
 * Resolution for an address:
 *  1. a district-scoped rule for the district named in the address wins;
 *  2. else, when the business district IS set: the customer's district
 *     == the business district → inside charge, otherwise outside;
 *  3. else (no business district yet): the old behaviour — inside when
 *     the address is in Dhaka (district or area), else outside;
 *  4. when the address is empty/unclear, outside.
 */

import { canonicalDistrictName, findDistrictInAddress, isCanonicalDistrict, isDhakaAddress } from '../orders/bangladesh';
import { invalidateWorkspacePromptCache } from '../ai-agent/gemini-cache';

export type DeliveryChargeScope = 'inside_district' | 'outside_district' | 'district';
/** Pre-migration scope names (migration 37 renamed them) — read/saved as the new names. */
export type LegacyDeliveryChargeScope = 'inside_dhaka' | 'outside_dhaka';

export interface DeliveryChargeRule {
  id: string;
  scope: DeliveryChargeScope;
  /** District (lowercase English, e.g. 'magura') for district rules; null for the base zones. */
  district: string | null;
  chargePaisa: number;
}

export interface DeliveryChargeDb {
  /** Non-generic on purpose: the pool helper, a ToolDb and a pg client all
   * satisfy this (their generic query defaults to Record rows). */
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** The defaults the owner taught the AI (inside ৳100, outside ৳130). */
export const DEFAULT_DELIVERY_CHARGES: { scope: DeliveryChargeScope; district: string | null; chargePaisa: number }[] = [
  { scope: 'inside_district', district: null, chargePaisa: 10000 },
  { scope: 'outside_district', district: null, chargePaisa: 13000 },
];

export const INSIDE_DISTRICT_LABEL = 'আপনার জেলার ভেতরে';
export const OUTSIDE_DISTRICT_LABEL = 'জেলার বাইরে';
/** Kept for callers that still render the old Dhaka wording. */
export const INSIDE_DHAKA_LABEL = 'ঢাকার ভেতরে';
export const OUTSIDE_DHAKA_LABEL = 'ঢাকার বাইরে';

/** Normalise a stored/input scope: old Dhaka names become the district names. */
export function normalizeDeliveryChargeScope(scope: string): DeliveryChargeScope | null {
  if (scope === 'inside_district' || scope === 'inside_dhaka') return 'inside_district';
  if (scope === 'outside_district' || scope === 'outside_dhaka') return 'outside_district';
  if (scope === 'district') return 'district';
  return null;
}

function toRule(row: { id: string; scope: string; district: string | null; charge_paisa: number }): DeliveryChargeRule {
  return {
    id: row.id,
    scope: normalizeDeliveryChargeScope(row.scope) ?? 'outside_district',
    district: row.district,
    chargePaisa: Number(row.charge_paisa),
  };
}

/** Load a workspace's rules, seeding the defaults on first use. */
export async function getDeliveryChargeRules(db: DeliveryChargeDb, workspaceId: string): Promise<DeliveryChargeRule[]> {
  const { rows } = await db.query(
    'SELECT id, scope, district, charge_paisa FROM delivery_charge_rules WHERE workspace_id = $1 ORDER BY scope, district',
    [workspaceId],
  );
  const typed = rows as unknown as { id: string; scope: string; district: string | null; charge_paisa: number }[];
  if (typed.length > 0) return typed.map(toRule);
  // First use: seed the defaults (the charges the owner taught the AI).
  for (const d of DEFAULT_DELIVERY_CHARGES) {
    await db.query(
      `INSERT INTO delivery_charge_rules (workspace_id, scope, district, charge_paisa)
       VALUES ($1, $2, $3, $4) ON CONFLICT (workspace_id, scope, district) DO NOTHING`,
      [workspaceId, d.scope, d.district, d.chargePaisa],
    );
  }
  const seeded = await db.query(
    'SELECT id, scope, district, charge_paisa FROM delivery_charge_rules WHERE workspace_id = $1 ORDER BY scope, district',
    [workspaceId],
  );
  return (seeded.rows as unknown as { id: string; scope: string; district: string | null; charge_paisa: number }[]).map(toRule);
}

/** The business's own district (canonical lowercase English, e.g. 'magura'), or null until the owner picks one. */
export async function getBusinessDistrict(db: DeliveryChargeDb, workspaceId: string): Promise<string | null> {
  const { rows } = await db.query(
    'SELECT business_district FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  const v = (rows[0] as { business_district?: string | null } | undefined)?.business_district ?? null;
  return typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null;
}

/** Save the business's own district (null/'' clears it). Throws on an unknown district name. */
export async function setBusinessDistrict(
  db: DeliveryChargeDb,
  workspaceId: string,
  district: string | null | undefined,
): Promise<string | null> {
  const clean = typeof district === 'string' && district.trim() ? district.trim().toLowerCase() : null;
  if (clean !== null && !isCanonicalDistrict(clean)) {
    throw new Error(`Unknown district: ${district}`);
  }
  await db.query(
    'UPDATE workspaces SET business_district = $1, updated_at = now() WHERE id = $2',
    [clean, workspaceId],
  );
  // The business district changes the delivery-charge line in the AI's
  // cached prompt prefix.
  await invalidateWorkspacePromptCache(workspaceId);
  return clean;
}

export interface DeliveryChargeInput {
  scope: string;
  district?: string | null;
  chargePaisa: number;
}

/** Replace a workspace's rules wholesale (owner settings save). */
export async function setDeliveryChargeRules(
  db: DeliveryChargeDb,
  workspaceId: string,
  input: DeliveryChargeInput[],
): Promise<DeliveryChargeRule[]> {
  const cleaned: { scope: DeliveryChargeScope; district: string | null; chargePaisa: number }[] = [];
  const seen = new Set<string>();
  for (const r of input) {
    const scope = normalizeDeliveryChargeScope(r.scope);
    if (!scope) {
      throw new Error(`Invalid delivery-charge scope: ${String(r.scope)}`);
    }
    const district = scope === 'district' ? (typeof r.district === 'string' ? r.district.trim().toLowerCase() : '') : null;
    if (scope === 'district' && !district) throw new Error('A district rule needs a district name');
    const charge = Math.floor(Number(r.chargePaisa));
    if (!Number.isFinite(charge) || charge < 0) throw new Error('Delivery charge must be ৳0 or more');
    const key = `${scope}:${district ?? ''}`;
    if (seen.has(key)) throw new Error(`Duplicate delivery-charge rule: ${key}`);
    seen.add(key);
    cleaned.push({ scope, district, chargePaisa: charge });
  }
  // The two base zones must always exist — a save without them would leave
  // the AI with no charge to quote. Fill any missing base zone with the default.
  for (const d of DEFAULT_DELIVERY_CHARGES) {
    if (!cleaned.some((c) => c.scope === d.scope)) cleaned.push(d);
  }
  await db.query('BEGIN');
  try {
    await db.query('DELETE FROM delivery_charge_rules WHERE workspace_id = $1', [workspaceId]);
    for (const c of cleaned) {
      await db.query(
        'INSERT INTO delivery_charge_rules (workspace_id, scope, district, charge_paisa) VALUES ($1, $2, $3, $4)',
        [workspaceId, c.scope, c.district, c.chargePaisa],
      );
    }
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
  // Delivery charges are part of the AI's cached prompt prefix — the
  // new charges must be quoted in the very next reply.
  await invalidateWorkspacePromptCache(workspaceId);
  return getDeliveryChargeRules(db, workspaceId);
}

/** The charge (paisa) + zone label for an address, from the configured rules. */
export function resolveDeliveryCharge(
  rules: DeliveryChargeRule[],
  address: string | null | undefined,
  businessDistrict?: string | null,
): { chargePaisa: number; zone: string } {
  const inside = rules.find((r) => normalizeDeliveryChargeScope(r.scope) === 'inside_district');
  const outside = rules.find((r) => normalizeDeliveryChargeScope(r.scope) === 'outside_district');
  const district = canonicalDistrictName(findDistrictInAddress(address));
  if (district) {
    const districtRule = rules.find((r) => r.scope === 'district' && canonicalDistrictName(r.district) === district);
    if (districtRule) return { chargePaisa: districtRule.chargePaisa, zone: district };
  }
  const business = typeof businessDistrict === 'string' && businessDistrict.trim()
    ? businessDistrict.trim().toLowerCase()
    : null;
  if (business) {
    // District model (Task 8): same district as the business → inside
    // charge; anywhere else (including an unreadable address) → outside.
    if (district === business) {
      return { chargePaisa: inside?.chargePaisa ?? 10000, zone: INSIDE_DISTRICT_LABEL };
    }
    return { chargePaisa: outside?.chargePaisa ?? 13000, zone: OUTSIDE_DISTRICT_LABEL };
  }
  // No business district picked yet — the old Dhaka behaviour, so
  // nothing a customer is charged changes until the owner chooses.
  if (isDhakaAddress(address)) {
    return { chargePaisa: inside?.chargePaisa ?? 10000, zone: INSIDE_DHAKA_LABEL };
  }
  return { chargePaisa: outside?.chargePaisa ?? 13000, zone: OUTSIDE_DHAKA_LABEL };
}

/** One Bengali line for the AI prompt: the charges it must quote. */
export function deliveryChargeSummaryText(rules: DeliveryChargeRule[], businessDistrict?: string | null): string {
  const inside = rules.find((r) => normalizeDeliveryChargeScope(r.scope) === 'inside_district');
  const outside = rules.find((r) => normalizeDeliveryChargeScope(r.scope) === 'outside_district');
  const districts = rules.filter((r) => r.scope === 'district');
  const business = typeof businessDistrict === 'string' && businessDistrict.trim()
    ? businessDistrict.trim().toLowerCase()
    : null;
  const insideLabel = business ? `${INSIDE_DISTRICT_LABEL} (${business})` : INSIDE_DHAKA_LABEL;
  const outsideLabel = business ? OUTSIDE_DISTRICT_LABEL : OUTSIDE_DHAKA_LABEL;
  const parts = [
    `${insideLabel} ৳${((inside?.chargePaisa ?? 10000) / 100).toLocaleString('en-IN')}`,
    `${outsideLabel} ৳${((outside?.chargePaisa ?? 13000) / 100).toLocaleString('en-IN')}`,
  ];
  for (const d of districts) {
    parts.push(`${d.district} জেলা ৳${(d.chargePaisa / 100).toLocaleString('en-IN')}`);
  }
  return `ডেলিভারি চার্জ (দোকানের নির্ধারিত — এই অঙ্কই বলবে, বানাবে না): ${parts.join(', ')}।`;
}
