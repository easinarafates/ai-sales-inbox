/**
 * Order identity + delivery-zone helpers (order management, 2026-11-08).
 *
 * - nextOrderNumber: the human order number (ASI-0001, ASI-0002, ...),
 *   sequential per workspace, incremented atomically so two orders created
 *   at the same moment never share a number. Gaps are fine (a failed
 *   insert after the increment just skips a number); uniqueness is what
 *   matters, and the DB has a UNIQUE (workspace_id, order_number) index.
 * - newInvoiceToken: unguessable token for the public invoice link
 *   (/invoice/<token>). The token IS the auth — never log it, never put
 *   it in a list response; only the single-order detail + the customer
 *   message carry it.
 * - zoneOfAddress: district + inside/outside Dhaka, from the delivery
 *   address (the same district detection the delivery-charge rules use).
 * - deliveryEstimateText: the estimated delivery window as a Bengali
 *   date range. Steadfast publishes NO arrival ETA, so this is an
 *   estimate only (inside Dhaka 1–2 days, outside 2–4 days) and the
 *   invoice labels it as such — never a promised date.
 */
import crypto from 'node:crypto';
import { BANGLADESH_DISTRICTS, findDistrictInAddress, isDhakaAddress } from './bangladesh';

export interface DbLike {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
}

export async function nextOrderNumber(db: DbLike, workspaceId: string): Promise<string> {
  const { rows } = await db.query<{ last_number: number }>(
    `INSERT INTO workspace_order_counters (workspace_id, last_number) VALUES ($1, 1)
     ON CONFLICT (workspace_id) DO UPDATE
       SET last_number = workspace_order_counters.last_number + 1, updated_at = now()
     RETURNING last_number`,
    [workspaceId],
  );
  return `ASI-${String(rows[0].last_number).padStart(4, '0')}`;
}

export function newInvoiceToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

export interface OrderZone {
  /** Canonical lowercase English district, or null when none is named. */
  district: string | null;
  /** True when the address is in Dhaka (district or a known Dhaka area). */
  insideDhaka: boolean;
  /** Bengali zone label for the detail panel / invoice. */
  label: string;
}

const DISTRICT_BN: Record<string, string> = Object.fromEntries(BANGLADESH_DISTRICTS);

export function zoneOfAddress(address: string | null | undefined): OrderZone {
  const district = findDistrictInAddress(address);
  const insideDhaka = isDhakaAddress(address);
  // Bengali label: the district name when one is named ("মাগুরা",
  // "ঢাকা"), else "ঢাকার বাইরে" when no district could be read.
  const label = district ? (DISTRICT_BN[district] ?? district) : 'ঢাকার বাইরে';
  return { district, insideDhaka, label };
}

/** Bengali day-month ("৯ নভেম্বর") for a date, Asia/Dhaka calendar day. */
function bnDayMonth(d: Date): string {
  return new Intl.DateTimeFormat('bn-BD', { day: 'numeric', month: 'long', timeZone: 'Asia/Dhaka' }).format(d);
}

/**
 * Estimated delivery window from the order date, as a Bengali range.
 * Inside Dhaka: order date +1 to +2 days. Outside: +2 to +4 days.
 * The caller labels it an estimate — Steadfast publishes no ETA.
 */
export function deliveryEstimateText(orderCreatedAt: string | Date, insideDhaka: boolean): string {
  const from = new Date(orderCreatedAt);
  const start = new Date(from);
  const end = new Date(from);
  if (insideDhaka) {
    start.setDate(start.getDate() + 1);
    end.setDate(end.getDate() + 2);
  } else {
    start.setDate(start.getDate() + 2);
    end.setDate(end.getDate() + 4);
  }
  return `${bnDayMonth(start)} – ${bnDayMonth(end)}`;
}
