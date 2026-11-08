/**
 * Steadfast shipment status check + customer notification.
 *
 * Runs in the cron sweep (every 5 minutes, see cron/routes.ts) and on
 * demand via POST /api/courier/check-status.
 *
 * For every Steadfast shipment that has a real consignment id and is not
 * in a terminal status (delivered / partial_delivered / cancelled), it
 * asks Steadfast for the live status (GET /status_by_cid/{id}).
 * On a status CHANGE it updates the shipment row — and, only when the new
 * status is one the customer must know about (delivered, partial
 * delivered, cancelled, hold), it sends the customer a real Messenger
 * message with the status + tracking code via deliverOutgoingMessage()
 * (real Graph send — never a fake message).
 *
 * HONEST LIMITS (do not "fix" by inventing data):
 * - Steadfast publishes NO "out for delivery" status and NO arrival-date
 *   ETA in its API doc, so there is no day-before-arrival trigger. The
 *   trigger is the status change itself.
 * - The Messenger message can only deliver inside Meta's 24-hour
 *   messaging window; outside it the send fails honestly (windowExpired)
 *   and the attempt is logged on the message row. The notification is
 *   attempted once per status change (last_notified_status) so a failed
 *   send is not retried every 5 minutes.
 * - A shipment is checked only while Steadfast keys are configured; with
 *   no keys there can be no real consignment to check.
 */
import { pool, query, queryOne } from '../db/pool';
import { SteadfastCourierProvider } from './provider';
import { providerForWorkspace } from './credentials';
import { deliverOutgoingMessage } from '../channels/meta-send';

/** Terminal statuses — Steadfast will not change them again; stop checking. */
const TERMINAL_STATUSES = new Set(['delivered', 'partial_delivered', 'cancelled']);

/** Statuses worth a customer message (Bengali label for the message text). */
const NOTIFY_STATUSES: Record<string, string> = {
  delivered: 'ডেলিভারি হয়েছে',
  partial_delivered: 'আংশিক ডেলিভারি হয়েছে',
  cancelled: 'বাতিল হয়েছে',
  hold: 'আপাতত আটকে আছে',
};

export interface ShipmentCheckSummary {
  checked: number;
  changed: number;
  notified: number;
  failed: number;
  errors: string[];
}

interface DueShipmentRow {
  id: string;
  order_id: string;
  provider_booking_id: string;
  tracking_number: string | null;
  status: string | null;
  last_notified_status: string | null;
  conversation_id: string | null;
  customer_name: string | null;
  customer_gender: string | null;
}

function salutation(gender: string | null): string {
  if (gender === 'male') return 'স্যার';
  if (gender === 'female') return 'ম্যাডাম';
  return 'আপনি';
}

function trackingMessage(status: string, orderId: string, trackingCode: string | null, gender: string | null): string {
  const sal = salutation(gender);
  const shortId = orderId.slice(0, 8);
  const code = trackingCode ? ` ট্র্যাকিং নম্বর: ${trackingCode}।` : '';
  switch (status) {
    case 'delivered':
      return `${sal}, আপনার অর্ডার ${shortId}-এর পার্সেলটি ডেলিভারি হয়েছে।${code} ধন্যবাদ।`;
    case 'partial_delivered':
      return `${sal}, আপনার অর্ডার ${shortId}-এর পার্সেলটি আংশিক ডেলিভারি হয়েছে।${code} বাকি অংশের জন্য আমাদের মেসেজ করুন।`;
    case 'cancelled':
      return `${sal}, দুঃখিত — আপনার অর্ডার ${shortId}-এর পার্সেলটি বাতিল হয়েছে।${code} বিস্তারিত জানতে আমাদের মেসেজ করুন।`;
    case 'hold':
      return `${sal}, আপনার অর্ডার ${shortId}-এর পার্সেলটি আপাতত আটকে আছে।${code} আমরা খোঁজ নিচ্ছি, জানানো হবে।`;
    default:
      return `${sal}, আপনার অর্ডার ${shortId}-এর পার্সেলের অবস্থা: ${NOTIFY_STATUSES[status] ?? status}।${code}`;
  }
}

async function processDueForWorkspace(workspaceId: string, provider: SteadfastCourierProvider): Promise<ShipmentCheckSummary> {
  const summary: ShipmentCheckSummary = { checked: 0, changed: 0, notified: 0, failed: 0, errors: [] };
  const { rows } = await query<DueShipmentRow>(
    workspaceId,
    `SELECT s.id, s.order_id, s.provider_booking_id, s.tracking_number, s.status,
            s.last_notified_status, o.conversation_id, c.name AS customer_name, c.gender AS customer_gender
     FROM shipments s
     JOIN orders o ON o.id = s.order_id AND o.workspace_id = $1
     LEFT JOIN customers c ON c.id = o.customer_id AND c.workspace_id = $1
     WHERE s.workspace_id = $1 AND s.courier = 'steadfast' AND s.provider_booking_id IS NOT NULL
     ORDER BY s.created_at DESC LIMIT 200`,
    [workspaceId],
  );
  for (const shipment of rows) {
    const current = (shipment.status ?? '').toLowerCase();
    if (TERMINAL_STATUSES.has(current)) continue;
    summary.checked += 1;
    let live: string;
    try {
      live = (await provider.getStatusByConsignmentId(shipment.provider_booking_id)).toLowerCase();
    } catch (err) {
      summary.failed += 1;
      summary.errors.push(`shipment ${shipment.id.slice(0, 8)}: ${(err as Error).message}`);
      continue;
    }
    await query(
      workspaceId,
      'UPDATE shipments SET last_checked_at = now() WHERE workspace_id = $1 AND id = $2',
      [workspaceId, shipment.id],
    ).catch((err) => console.error('[shipment-check] last_checked_at failed:', (err as Error).message));
    if (live === current) continue;
    await query(
      workspaceId,
      'UPDATE shipments SET status = $1, updated_at = now() WHERE workspace_id = $2 AND id = $3',
      [live, workspaceId, shipment.id],
    );
    summary.changed += 1;
    if (!NOTIFY_STATUSES[live] || shipment.last_notified_status === live) continue;
    if (!shipment.conversation_id) {
      summary.errors.push(`shipment ${shipment.id.slice(0, 8)}: no conversation to notify`);
      continue;
    }
    const text = trackingMessage(live, shipment.order_id, shipment.tracking_number, shipment.customer_gender);
    const result = await deliverOutgoingMessage(workspaceId, shipment.conversation_id, text);
    // Attempted once per status change — record it even when the send
    // failed (e.g. Meta 24h window expired) so the sweep does not retry
    // every 5 minutes and spam failed rows. The failed attempt is visible
    // in the Inbox on the message row.
    await query(
      workspaceId,
      'UPDATE shipments SET last_notified_status = $1 WHERE workspace_id = $2 AND id = $3',
      [live, workspaceId, shipment.id],
    ).catch((err) => console.error('[shipment-check] last_notified_status failed:', (err as Error).message));
    if (result.sent) {
      summary.notified += 1;
    } else {
      summary.failed += 1;
      summary.errors.push(
        `shipment ${shipment.id.slice(0, 8)}: notify failed (${result.error ?? 'send failed'}${result.windowExpired ? ', 24h window expired' : ''})`,
      );
    }
  }
  return summary;
}

/** Check all due Steadfast shipments (every workspace, or one when given). */
export async function processDueShipmentChecks(workspaceId?: string): Promise<ShipmentCheckSummary> {
  const total: ShipmentCheckSummary = { checked: 0, changed: 0, notified: 0, failed: 0, errors: [] };
  const merge = (r: ShipmentCheckSummary): void => {
    total.checked += r.checked;
    total.changed += r.changed;
    total.notified += r.notified;
    total.failed += r.failed;
    total.errors.push(...r.errors);
  };
  // Each workspace's shipments are checked with THAT workspace's stored
  // Steadfast keys (DB first, env fallback) — keys entered in the UI are
  // actually used here, not just at booking time.
  if (workspaceId) {
    const provider = (await providerForWorkspace(workspaceId, 'steadfast')) as SteadfastCourierProvider;
    merge(await processDueForWorkspace(workspaceId, provider));
    return total;
  }
  const { rows: workspaces } = await pool.query<{ workspace_id: string }>(
    `SELECT DISTINCT workspace_id FROM shipments
     WHERE courier = 'steadfast' AND provider_booking_id IS NOT NULL
       AND (status IS NULL OR status NOT IN ('delivered', 'partial_delivered', 'cancelled'))`,
  );
  for (const { workspace_id } of workspaces) {
    try {
      const provider = (await providerForWorkspace(workspace_id, 'steadfast')) as SteadfastCourierProvider;
      merge(await processDueForWorkspace(workspace_id, provider));
    } catch (err) {
      total.failed += 1;
      total.errors.push(`workspace ${workspace_id.slice(0, 8)}: ${(err as Error).message}`);
    }
  }
  return total;
}
