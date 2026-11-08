/**
 * Auto re-engagement follow-up (2026-11-08).
 *
 * A customer who messaged (showed interest, e.g. asked about a product)
 * but did NOT order gets ONE follow-up after a configurable delay
 * (default 2 days, 1-3). Rules:
 *  - at most ONCE per customer per interest episode (unique index on
 *    (workspace_id, customer_id, episode_key); the episode is the last
 *    incoming message at scheduling time — a new message starts a new
 *    episode);
 *  - NEVER for angry/waiting customers, the owner, or customers who
 *    already ordered (checked at schedule AND at send time);
 *  - sent by the system via the cron sweep, not by the AI chat.
 *
 * META 24H RULE (honest): Messenger/Instagram only allow sending within
 * 24 hours of the customer's last message (error 551 after that). The
 * window is checked BEFORE any send: if it has expired, the row is
 * marked 'window_expired' and NO message is sent or faked — the owner
 * sees it in the follow-up report and can message by hand. No message
 * tag is used (a re-engagement nudge does not qualify for one).
 * Webchat has no 24h window (saving IS the delivery), so those send.
 */
import { pool, query, queryOne } from '../db/pool';
import { deliverOutgoingMessage } from '../channels/meta-send';
import { genderSalutation, normalizeCustomerGender, type CustomerGender } from '../customers/gender';

export interface AutoFollowupSettings {
  enabled: boolean;
  delayDays: number;
}

export interface AutoFollowupRow {
  id: string;
  customer_id: string;
  conversation_id: string;
  customer_name: string | null;
  episode_key: string;
  message: string;
  status: string;
  scheduled_for: string;
  sent_at: string | null;
  reason: string | null;
  created_at: string;
}

const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_SILENCE_DAYS = 30;

function clampDelay(days: unknown): number {
  const n = typeof days === 'number' ? days : Number(days ?? 2);
  if (!Number.isFinite(n)) return 2;
  return Math.min(3, Math.max(1, Math.floor(n)));
}

export async function getAutoFollowupSettings(workspaceId: string): Promise<AutoFollowupSettings> {
  const row = await queryOne<{ auto_followup_enabled: boolean | null; auto_followup_delay_days: number | null }>(
    workspaceId,
    'SELECT auto_followup_enabled, auto_followup_delay_days FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  return {
    enabled: row?.auto_followup_enabled !== false,
    delayDays: clampDelay(row?.auto_followup_delay_days ?? 2),
  };
}

export async function updateAutoFollowupSettings(
  workspaceId: string,
  patch: { enabled?: boolean; delayDays?: number },
): Promise<AutoFollowupSettings> {
  const current = await getAutoFollowupSettings(workspaceId);
  const enabled = typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled;
  const delayDays = patch.delayDays !== undefined ? clampDelay(patch.delayDays) : current.delayDays;
  await query(
    workspaceId,
    'UPDATE workspaces SET auto_followup_enabled = $2, auto_followup_delay_days = $3, updated_at = now() WHERE id = $1',
    [workspaceId, enabled, delayDays],
  );
  return { enabled, delayDays };
}

/** The re-engagement text, addressed correctly (স্যার/ম্যাডাম/neutral). */
export function buildFollowupMessage(gender: CustomerGender, productName: string | null): string {
  const sal = genderSalutation(normalizeCustomerGender(gender));
  const open = sal ? `${sal}, ` : '';
  if (productName) {
    return `${open}আপনি ${productName}-এর কথা জিজ্ঞেস করেছিলেন — নিতে যাচ্ছেন? জানালে আমরা অর্ডারটা করে দিচ্ছি।`;
  }
  return `${open}আপনি কি প্রোডাক্ট নিতে যাচ্ছেন? আপনি তো প্রোডাক্ট নেওয়ার জন্য বলেছিলেন।`;
}

interface Candidate {
  customer_id: string;
  conversation_id: string;
  customer_name: string | null;
  customer_gender: string | null;
  channel_platform: string | null;
  last_incoming_id: string;
  last_incoming_at: string;
  product_name: string | null;
}

/**
 * Find customers due for ONE re-engagement follow-up:
 *  - messaged (has an incoming message) and showed product interest
 *    (the AI sent them product info with a price, or they named a
 *    product from the catalog);
 *  - has NO orders;
 *  - conversation is not waiting/angry (status != 'waiting', no
 *    escalation_reason) and the customer is not the owner;
 *  - last incoming message is at least `delayDays` old (and at most 30
 *    days — ancient leads are not resurrected);
 *  - no auto_followup row exists yet for the current episode
 *    (episode = the last incoming message id).
 */
export async function findReengagementCandidates(
  workspaceId: string,
  delayDays: number,
): Promise<Candidate[]> {
  const delayMs = delayDays * 24 * 60 * 60 * 1000;
  const dueBefore = new Date(Date.now() - delayMs).toISOString();
  const oldest = new Date(Date.now() - MAX_SILENCE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { rows } = await query<Candidate>(
    workspaceId,
    `SELECT
       c.id AS customer_id,
       conv.id AS conversation_id,
       c.name AS customer_name,
       c.gender AS customer_gender,
       ch.platform AS channel_platform,
       last_in.id AS last_incoming_id,
       last_in.created_at AS last_incoming_at,
       (
         SELECT p.name FROM products p
         WHERE p.workspace_id = $1
           AND EXISTS (
             SELECT 1 FROM messages m2
             WHERE m2.workspace_id = $1 AND m2.conversation_id = conv.id
               AND m2.direction = 'in' AND m2.body ILIKE '%' || p.name || '%'
           )
         ORDER BY p.created_at DESC LIMIT 1
       ) AS product_name
     FROM customers c
     JOIN conversations conv ON conv.customer_id = c.id AND conv.workspace_id = $1
     JOIN LATERAL (
       SELECT m.id, m.created_at FROM messages m
       WHERE m.workspace_id = $1 AND m.conversation_id = conv.id AND m.direction = 'in'
       ORDER BY m.created_at DESC LIMIT 1
     ) last_in ON true
     LEFT JOIN channels ch ON ch.id = conv.channel_id AND ch.workspace_id = $1
     WHERE c.workspace_id = $1
       AND conv.status <> 'waiting'
       AND conv.escalation_reason IS NULL
       AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.workspace_id = $1 AND o.customer_id = c.id)
       AND NOT EXISTS (
         SELECT 1 FROM workspaces w
         WHERE w.id = $1 AND w.owner_psid IS NOT NULL
           AND c.primary_identity IN ('messenger:' || w.owner_psid, 'facebook_comment:' || w.owner_psid)
       )
       AND last_in.created_at <= $2
       AND last_in.created_at >= $3
       AND NOT EXISTS (
         SELECT 1 FROM auto_followups af
         WHERE af.workspace_id = $1 AND af.customer_id = c.id AND af.episode_key = last_in.id::text  -- episode_key is TEXT, message id is UUID
       )
       AND (
         EXISTS (
           SELECT 1 FROM messages m3
           WHERE m3.workspace_id = $1 AND m3.conversation_id = conv.id
             AND m3.direction = 'out' AND m3.body LIKE '%৳%'
         )
         OR EXISTS (
           SELECT 1 FROM products p
           WHERE p.workspace_id = $1
             AND EXISTS (
               SELECT 1 FROM messages m4
               WHERE m4.workspace_id = $1 AND m4.conversation_id = conv.id
                 AND m4.direction = 'in' AND m4.body ILIKE '%' || p.name || '%'
             )
         )
       )
     ORDER BY last_in.created_at ASC`,
    [workspaceId, dueBefore, oldest],
  );
  return rows;
}

/**
 * Schedule one follow-up per due candidate (once per episode — the unique
 * index makes a re-run a no-op for the same episode). Returns how many
 * were newly scheduled.
 */
export async function scheduleAutoFollowups(workspaceId: string): Promise<{ scheduled: number; skipped: number }> {
  const settings = await getAutoFollowupSettings(workspaceId);
  if (!settings.enabled) return { scheduled: 0, skipped: 0 };
  const candidates = await findReengagementCandidates(workspaceId, settings.delayDays);
  let scheduled = 0;
  for (const cand of candidates) {
    const message = buildFollowupMessage(
      normalizeCustomerGender(cand.customer_gender),
      cand.product_name,
    );
    const scheduledFor = new Date(
      new Date(cand.last_incoming_at).getTime() + settings.delayDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    const { rowCount } = await query(
      workspaceId,
      `INSERT INTO auto_followups
         (workspace_id, customer_id, conversation_id, episode_key, message, status, scheduled_for)
       VALUES ($1, $2, $3, $4, $5, 'scheduled', $6)
       ON CONFLICT (workspace_id, customer_id, episode_key) DO NOTHING`,
      [workspaceId, cand.customer_id, cand.conversation_id, cand.last_incoming_id, message, scheduledFor],
    );
    if ((rowCount ?? 0) > 0) scheduled++;
  }
  return { scheduled, skipped: candidates.length - scheduled };
}

async function markAutoFollowup(
  workspaceId: string,
  id: string,
  status: string,
  reason?: string | null,
  sentAt?: boolean,
): Promise<void> {
  await query(
    workspaceId,
    `UPDATE auto_followups SET status = $2, reason = $3,
       sent_at = CASE WHEN $4 THEN now() ELSE sent_at END,
       updated_at = now()
     WHERE workspace_id = $1 AND id = $5`,
    [workspaceId, status, reason ?? null, sentAt === true, id],
  );
}

/**
 * Process due auto follow-ups (scheduled_for <= now). For each row:
 *  1. re-validate (still no orders, not waiting/angry, not the owner) —
 *     otherwise mark 'skipped';
 *  2. check the Meta 24h window for Messenger/Instagram (last incoming
 *     message within 24h). Expired → mark 'window_expired', NO send, NO
 *     faked message — the owner sees it in the report;
 *  3. window open (or webchat, which has no window) → real send via
 *     deliverOutgoingMessage; 'sent' on success, 'failed' with the
 *     reason on failure.
 */
export async function processDueAutoFollowups(workspaceId?: string): Promise<{
  processed: number;
  sent: number;
  windowExpired: number;
  skipped: number;
  failed: number;
}> {
  const total = { processed: 0, sent: 0, windowExpired: 0, skipped: 0, failed: 0 };
  const scopes: string[] = workspaceId
    ? [workspaceId]
    : (
        await pool.query<{ workspace_id: string }>(
          `SELECT DISTINCT workspace_id FROM auto_followups WHERE status = 'scheduled' AND scheduled_for <= now()`,
        )
      ).rows.map((r) => r.workspace_id);
  for (const wsId of scopes) {
    const { rows: due } = await query<{ id: string; customer_id: string; conversation_id: string; message: string }>(
      wsId,
      `SELECT id, customer_id, conversation_id, message FROM auto_followups
       WHERE workspace_id = $1 AND status = 'scheduled' AND scheduled_for <= now()
       ORDER BY scheduled_for ASC`,
      [wsId],
    );
    for (const row of due) {
      total.processed++;
      try {
        // Re-validate at send time (the customer may have ordered,
        // escalated, or replied since scheduling).
        const state = await queryOne<{
          has_order: boolean;
          is_waiting: boolean;
          is_owner: boolean;
          platform: string | null;
          last_incoming_at: string | null;
        }>(
          wsId,
          `SELECT
             EXISTS (SELECT 1 FROM orders o WHERE o.workspace_id = $1 AND o.customer_id = $2) AS has_order,
             EXISTS (SELECT 1 FROM conversations co WHERE co.workspace_id = $1 AND co.id = $3 AND (co.status = 'waiting' OR co.escalation_reason IS NOT NULL)) AS is_waiting,
             EXISTS (SELECT 1 FROM workspaces w JOIN customers c ON c.id = $2 AND c.workspace_id = $1 WHERE w.id = $1 AND w.owner_psid IS NOT NULL AND c.primary_identity IN ('messenger:' || w.owner_psid, 'facebook_comment:' || w.owner_psid)) AS is_owner,
             ch.platform AS platform,
             (SELECT MAX(m.created_at) FROM messages m WHERE m.workspace_id = $1 AND m.conversation_id = $3 AND m.direction = 'in') AS last_incoming_at
           FROM conversations co
           LEFT JOIN channels ch ON ch.id = co.channel_id AND ch.workspace_id = $1
           WHERE co.workspace_id = $1 AND co.id = $3`,
          [wsId, row.customer_id, row.conversation_id],
        );
        if (!state) {
          await markAutoFollowup(wsId, row.id, 'skipped', 'conversation_not_found');
          total.skipped++;
          continue;
        }
        if (state.has_order) {
          await markAutoFollowup(wsId, row.id, 'skipped', 'customer_ordered_since');
          total.skipped++;
          continue;
        }
        if (state.is_waiting) {
          await markAutoFollowup(wsId, row.id, 'skipped', 'customer_waiting_or_angry');
          total.skipped++;
          continue;
        }
        if (state.is_owner) {
          await markAutoFollowup(wsId, row.id, 'skipped', 'owner_customer');
          total.skipped++;
          continue;
        }
        // Meta 24h window (Messenger/Instagram only — webchat has none).
        const platform = state.platform ?? '';
        if ((platform === 'messenger' || platform === 'instagram') && state.last_incoming_at) {
          const lastIn = new Date(state.last_incoming_at).getTime();
          if (Date.now() - lastIn > WINDOW_MS) {
            await markAutoFollowup(
              wsId,
              row.id,
              'window_expired',
              'could not be sent — 24h window expired (Messenger only allows sending within 24 hours of the customer\u2019s last message)',
            );
            total.windowExpired++;
            continue;
          }
        }
        const result = await deliverOutgoingMessage(wsId, row.conversation_id, row.message);
        if (result.sent) {
          await markAutoFollowup(wsId, row.id, 'sent', null, true);
          total.sent++;
        } else if (result.windowExpired) {
          await markAutoFollowup(
            wsId,
            row.id,
            'window_expired',
            `could not be sent — 24h window expired (${result.error ?? 'Meta error 551'})`,
          );
          total.windowExpired++;
        } else {
          await markAutoFollowup(wsId, row.id, 'failed', result.error ?? 'send_failed');
          total.failed++;
        }
      } catch (err) {
        total.failed++;
        console.error(`[auto-followup] ${row.id} failed:`, (err as Error).message);
        await markAutoFollowup(wsId, row.id, 'failed', (err as Error).message.slice(0, 200)).catch(() => undefined);
      }
    }
  }
  return total;
}

/** Schedule + process for one workspace (what the cron sweep runs). */
export async function runAutoFollowups(workspaceId?: string): Promise<{
  scheduled: number;
  processed: number;
  sent: number;
  windowExpired: number;
  skipped: number;
  failed: number;
}> {
  const out = { scheduled: 0, processed: 0, sent: 0, windowExpired: 0, skipped: 0, failed: 0 };
  const scopes: string[] = workspaceId
    ? [workspaceId]
    : (
        await pool.query<{ id: string }>(
          `SELECT id FROM workspaces WHERE COALESCE(auto_followup_enabled, TRUE) = TRUE`,
        )
      ).rows.map((r) => r.id);
  for (const wsId of scopes) {
    const s = await scheduleAutoFollowups(wsId);
    out.scheduled += s.scheduled;
  }
  const p = await processDueAutoFollowups(workspaceId);
  return { ...out, ...p };
}

/** Owner report: every auto follow-up with its honest status + reason. */
export async function listAutoFollowups(workspaceId: string, limit = 50): Promise<AutoFollowupRow[]> {
  const { rows } = await query<AutoFollowupRow>(
    workspaceId,
    `SELECT af.id, af.customer_id, af.conversation_id, c.name AS customer_name,
            af.episode_key, af.message, af.status, af.scheduled_for, af.sent_at,
            af.reason, af.created_at
     FROM auto_followups af
     LEFT JOIN customers c ON c.id = af.customer_id AND c.workspace_id = $1
     WHERE af.workspace_id = $1
     ORDER BY af.created_at DESC LIMIT $2`,
    [workspaceId, Math.min(200, Math.max(1, limit))],
  );
  return rows;
}
