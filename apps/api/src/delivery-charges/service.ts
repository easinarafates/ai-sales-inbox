/**
 * Delivery charge rules (requirement C, 2026-11-08).
 *
 * The shop OWNER sets the delivery charge per zone in the website; the
 * AI + order totals use these configured charges, never the old hardcoded
 * ৳100/৳130. Defaults (inside Dhaka ৳100, outside Dhaka ৳130) are the
 * values the owner taught the AI — they are seeded lazily the first time
 * a workspace has no rules, so new shops start with the same charges.
 *
 * Resolution for an address:
 *  1. a district-scoped rule for the district named in the address wins;
 *  2. else inside-Dhaka when the address is in Dhaka (district or area);
 *  3. else outside-Dhaka; 4. when the address is empty/unclear, outside.
 */

import { findDistrictInAddress, isDhakaAddress } from '../orders/bangladesh';

export type DeliveryChargeScope = 'inside_dhaka' | 'outside_dhaka' | 'district';

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

/** The defaults the owner taught the AI (৳100 inside Dhaka, ৳130 outside). */
export const DEFAULT_DELIVERY_CHARGES: { scope: DeliveryChargeScope; district: string | null; chargePaisa: number }[] = [
  { scope: 'inside_dhaka', district: null, chargePaisa: 10000 },
  { scope: 'outside_dhaka', district: null, chargePaisa: 13000 },
];

export const INSIDE_DHAKA_LABEL = 'ঢাকার ভেতরে';
export const OUTSIDE_DHAKA_LABEL = 'ঢাকার বাইরে';

function toRule(row: { id: string; scope: string; district: string | null; charge_paisa: number }): DeliveryChargeRule {
  return {
    id: row.id,
    scope: row.scope as DeliveryChargeScope,
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
    if (r.scope !== 'inside_dhaka' && r.scope !== 'outside_dhaka' && r.scope !== 'district') {
      throw new Error(`Invalid delivery-charge scope: ${String(r.scope)}`);
    }
    const district = r.scope === 'district' ? (typeof r.district === 'string' ? r.district.trim().toLowerCase() : '') : null;
    if (r.scope === 'district' && !district) throw new Error('A district rule needs a district name');
    const charge = Math.floor(Number(r.chargePaisa));
    if (!Number.isFinite(charge) || charge < 0) throw new Error('Delivery charge must be ৳0 or more');
    const key = `${r.scope}:${district ?? ''}`;
    if (seen.has(key)) throw new Error(`Duplicate delivery-charge rule: ${key}`);
    seen.add(key);
    cleaned.push({ scope: r.scope as DeliveryChargeScope, district, chargePaisa: charge });
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
  return getDeliveryChargeRules(db, workspaceId);
}

/** The charge (paisa) + zone label for an address, from the configured rules. */
export function resolveDeliveryCharge(
  rules: DeliveryChargeRule[],
  address: string | null | undefined,
): { chargePaisa: number; zone: string } {
  const inside = rules.find((r) => r.scope === 'inside_dhaka');
  const outside = rules.find((r) => r.scope === 'outside_dhaka');
  const district = findDistrictInAddress(address);
  if (district) {
    const districtRule = rules.find((r) => r.scope === 'district' && (r.district ?? '').toLowerCase() === district);
    if (districtRule) return { chargePaisa: districtRule.chargePaisa, zone: district };
  }
  if (isDhakaAddress(address)) {
    return { chargePaisa: inside?.chargePaisa ?? 10000, zone: INSIDE_DHAKA_LABEL };
  }
  return { chargePaisa: outside?.chargePaisa ?? 13000, zone: OUTSIDE_DHAKA_LABEL };
}

/** One Bengali line for the AI prompt: the charges it must quote. */
export function deliveryChargeSummaryText(rules: DeliveryChargeRule[]): string {
  const inside = rules.find((r) => r.scope === 'inside_dhaka');
  const outside = rules.find((r) => r.scope === 'outside_dhaka');
  const districts = rules.filter((r) => r.scope === 'district');
  const parts = [
    `${INSIDE_DHAKA_LABEL} ৳${((inside?.chargePaisa ?? 10000) / 100).toLocaleString('en-IN')}`,
    `${OUTSIDE_DHAKA_LABEL} ৳${((outside?.chargePaisa ?? 13000) / 100).toLocaleString('en-IN')}`,
  ];
  for (const d of districts) {
    parts.push(`${d.district} জেলা ৳${(d.chargePaisa / 100).toLocaleString('en-IN')}`);
  }
  return `ডেলিভারি চার্জ (দোকানের নির্ধারিত — এই অঙ্কই বলবে, বানাবে না): ${parts.join(', ')}।`;
}
