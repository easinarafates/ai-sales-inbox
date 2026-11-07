import { pool, query, queryOne } from '../db/pool';

/**
 * Follow-up engine (Module B, Phase 2 — PDF section 4, "ফলো-আপ ও লিড").
 *
 * Smart rules (PDF: "AI ঠিক করে কাকে কখন কী বলবে ও কখন থামবে"):
 *  1. STOP if the customer replied after the last follow-up was sent —
 *     they are already talking to us; another nudge would be spam.
 *  2. STOP after 3 follow-ups with no reply at all — the lead has gone
 *     cold; further messages only annoy them and risk a Meta policy
 *     complaint. The follow-up is marked 'stopped', never deleted, so the
 *     team can still see it and restart it by hand.
 *
 * Delivery: the message is saved as an 'out' message in the customer's
 * open conversation (a new open conversation is created if none exists),
 * exactly like a team reply in the inbox. HONEST STUB — the actual send to
 * Messenger/Instagram via the Meta Graph API is not wired yet (live page
 * token + approval pending, same as every other outbound send in Phase 1);
 * the message is stored and visible in the inbox, but it is NOT delivered
 * to the customer. Such follow-ups are marked 'logged' (never 'sent') until
 * a real Graph send exists, and the UI must say so.
 *
 * NOTE on schema: the followups table has no customer_id column — the
 * customer is reached through followups.lead_id -> leads.customer_id.
 * Routes that accept a bare customerId resolve (or create) a lead for
 * that customer first, so every follow-up always has a lead.
 */

export interface FollowupRow {
  id: string;
  lead_id: string | null;
  message: string | null;
  send_at: string | null;
  status: string;
  warmth: string;
  created_at: string;
  updated_at: string;
  customer_id?: string | null;
}

const FOLLOWUP_COLUMNS = 'id, lead_id, message, send_at, status, warmth, created_at, updated_at';
const MAX_NO_REPLY_FOLLOWUPS = 3;

async function customerIdForFollowup(
  workspaceId: string,
  followup: FollowupRow,
): Promise<string | null> {
  if (!followup.lead_id) return null;
  const lead = await queryOne<{ customer_id: string | null }>(
    workspaceId,
    'SELECT customer_id FROM leads WHERE workspace_id = $1 AND id = $2',
    [workspaceId, followup.lead_id],
  );
  return lead?.customer_id ?? null;
}

async function findOrCreateOpenConversation(
  workspaceId: string,
  customerId: string,
): Promise<string> {
  const existing = await queryOne<{ id: string }>(
    workspaceId,
    `SELECT id FROM conversations WHERE workspace_id = $1 AND customer_id = $2
     AND status = 'open' ORDER BY updated_at DESC LIMIT 1`,
    [workspaceId, customerId],
  );
  if (existing) return existing.id;
  const { rows } = await query<{ id: string }>(
    workspaceId,
    `INSERT INTO conversations (workspace_id, channel_id, customer_id, status, mode)
     VALUES ($1, NULL, $2, 'open', 'ai') RETURNING id`,
    [workspaceId, customerId],
  );
  return rows[0].id;
}

interface CustomerReplyState {
  sentFollowups: { id: string; updated_at: string; created_at: string }[];
  repliedAfterLastSent: boolean;
  noReplyStreak: number;
}

async function getReplyState(
  workspaceId: string,
  customerId: string,
): Promise<CustomerReplyState> {
  const { rows: sentFollowups } = await query<{ id: string; updated_at: string; created_at: string }>(
    workspaceId,
    `SELECT f.id, f.updated_at, f.created_at FROM followups f
     JOIN leads l ON l.id = f.lead_id
     WHERE f.workspace_id = $1 AND l.customer_id = $2 AND f.status IN ('sent', 'logged')
     ORDER BY f.updated_at ASC`,
    [workspaceId, customerId],
  );
  if (sentFollowups.length === 0) {
    return { sentFollowups, repliedAfterLastSent: false, noReplyStreak: 0 };
  }
  const firstSentAt = sentFollowups[0].updated_at;
  const lastSentAt = sentFollowups[sentFollowups.length - 1].updated_at;
  // Any inbound message from this customer after the last sent follow-up?
  const repliedAfterLast = await queryOne<{ c: string }>(
    workspaceId,
    `SELECT COUNT(*) AS c FROM messages m
     JOIN conversations co ON co.id = m.conversation_id
     WHERE m.workspace_id = $1 AND co.customer_id = $2
       AND m.direction = 'in' AND m.created_at > $3`,
    [workspaceId, customerId, lastSentAt],
  );
  // Inbound replies since the first follow-up of the current streak:
  // none at all means every follow-up so far went unanswered.
  const repliedSinceFirst = await queryOne<{ c: string }>(
    workspaceId,
    `SELECT COUNT(*) AS c FROM messages m
     JOIN conversations co ON co.id = m.conversation_id
     WHERE m.workspace_id = $1 AND co.customer_id = $2
       AND m.direction = 'in' AND m.created_at > $3`,
    [workspaceId, customerId, firstSentAt],
  );
  const noReplyStreak =
    Number(repliedSinceFirst?.c ?? 0) === 0 ? sentFollowups.length : 0;
  return {
    sentFollowups,
    repliedAfterLastSent: Number(repliedAfterLast?.c ?? 0) > 0,
    noReplyStreak,
  };
}

async function markFollowup(
  workspaceId: string,
  followupId: string,
  status: string,
): Promise<FollowupRow | null> {
  return queryOne<FollowupRow>(
    workspaceId,
    `UPDATE followups SET status = $1, updated_at = now()
     WHERE workspace_id = $2 AND id = $3 RETURNING ${FOLLOWUP_COLUMNS}`,
    [status, workspaceId, followupId],
  );
}

/**
 * Send one follow-up (shared by the due-sweep and send-now): applies the
 * smart stop rules first, then saves the 'out' message and marks 'logged'.
 * Nothing is delivered to the customer until a real Graph send exists —
 * the status is 'logged', never 'sent'. Returns the updated row, or null
 * if the follow-up does not exist.
 */
export async function sendFollowup(
  workspaceId: string,
  followupId: string,
): Promise<{ followup: FollowupRow | null; stopped: boolean; reason?: string }> {
  const followup = await queryOne<FollowupRow>(
    workspaceId,
    `SELECT ${FOLLOWUP_COLUMNS} FROM followups WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, followupId],
  );
  if (!followup) return { followup: null, stopped: false };
  if (!followup.message || !followup.message.trim()) {
    const failed = await markFollowup(workspaceId, followupId, 'failed');
    return { followup: failed, stopped: false, reason: 'খালি মেসেজ' };
  }
  const customerId = await customerIdForFollowup(workspaceId, followup);
  if (!customerId) {
    const failed = await markFollowup(workspaceId, followupId, 'failed');
    return { followup: failed, stopped: false, reason: 'কাস্টমার পাওয়া যায়নি' };
  }

  const state = await getReplyState(workspaceId, customerId);
  if (state.repliedAfterLastSent) {
    const stopped = await markFollowup(workspaceId, followupId, 'stopped');
    return {
      followup: stopped,
      stopped: true,
      reason: 'কাস্টমার শেষ ফলো-আপের পর উত্তর দিয়েছেন — আর বিরক্ত করা হবে না',
    };
  }
  if (state.noReplyStreak >= MAX_NO_REPLY_FOLLOWUPS) {
    const stopped = await markFollowup(workspaceId, followupId, 'stopped');
    return {
      followup: stopped,
      stopped: true,
      reason: `${MAX_NO_REPLY_FOLLOWUPS} বার ফলো-আপের পরও উত্তর আসেনি — লিড ঠান্ডা হয়ে গেছে`,
    };
  }

  const conversationId = await findOrCreateOpenConversation(workspaceId, customerId);
  // HONEST STUB (see header): saved as an outbound inbox message only;
  // the real Meta Graph API send is not wired yet. Mark 'logged', never 'sent'.
  await query(
    workspaceId,
    `INSERT INTO messages (workspace_id, conversation_id, direction, type, body)
     VALUES ($1, $2, 'out', 'text', $3)`,
    [workspaceId, conversationId, followup.message.trim()],
  );
  await query(
    workspaceId,
    'UPDATE conversations SET updated_at = now() WHERE workspace_id = $1 AND id = $2',
    [workspaceId, conversationId],
  );
  const logged = await markFollowup(workspaceId, followupId, 'logged');
  return { followup: logged, stopped: false };
}

async function processDueForWorkspace(workspaceId: string): Promise<{
  processed: number;
  sent: number;
  logged: number;
  stopped: number;
  failed: number;
}> {
  // Hot leads go first: the sweep sends hot follow-ups before warm ones
  // due at the same time (Worker B — hot/warm split).
  const { rows: due } = await query<{ id: string }>(
    workspaceId,
    `SELECT id FROM followups
     WHERE workspace_id = $1 AND status = 'scheduled' AND send_at <= now()
     ORDER BY CASE WHEN warmth = 'hot' THEN 0 ELSE 1 END, send_at ASC`,
    [workspaceId],
  );
  let processed = 0;
  let sent = 0;
  let logged = 0;
  let stopped = 0;
  let failed = 0;
  for (const { id } of due) {
    processed++;
    try {
      const result = await sendFollowup(workspaceId, id);
      if (!result.followup) failed++;
      else if (result.stopped) stopped++;
      else if (result.followup.status === 'sent') sent++;
      else if (result.followup.status === 'logged') logged++;
      else failed++;
    } catch (err) {
      failed++;
      console.error(`[followups] follow-up ${id} failed:`, (err as Error).message);
    }
  }
  return { processed, sent, logged, stopped, failed };
}

/**
 * Process every due follow-up (send_at <= now, status 'scheduled').
 * With a workspaceId, only that workspace; without one, sweeps all
 * workspaces that have due follow-ups (worker / manual trigger).
 */
export async function processDueFollowups(workspaceId?: string): Promise<{
  processed: number;
  sent: number;
  logged: number;
  stopped: number;
  failed: number;
}> {
  if (workspaceId) return processDueForWorkspace(workspaceId);
  const { rows: workspaces } = await pool.query<{ workspace_id: string }>(
    `SELECT DISTINCT workspace_id FROM followups
     WHERE status = 'scheduled' AND send_at <= now()`,
  );
  const total = { processed: 0, sent: 0, logged: 0, stopped: 0, failed: 0 };
  for (const { workspace_id } of workspaces) {
    const r = await processDueForWorkspace(workspace_id);
    total.processed += r.processed;
    total.sent += r.sent;
    total.logged += r.logged;
    total.stopped += r.stopped;
    total.failed += r.failed;
  }
  return total;
}

/**
 * Suggested next follow-up time for a customer: last interaction
 * (their latest message, in or out) + 2 days. Falls back to the lead's
 * follow_up_at, then to now + 2 days when there is no history at all.
 */
export async function suggestFollowUpAt(
  workspaceId: string,
  customerId: string,
): Promise<Date> {
  const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
  const lastMessage = await queryOne<{ last_at: string | null }>(
    workspaceId,
    `SELECT MAX(m.created_at) AS last_at FROM messages m
     JOIN conversations co ON co.id = m.conversation_id
     WHERE m.workspace_id = $1 AND co.customer_id = $2`,
    [workspaceId, customerId],
  );
  if (lastMessage?.last_at) {
    return new Date(new Date(lastMessage.last_at).getTime() + TWO_DAYS_MS);
  }
  const lead = await queryOne<{ follow_up_at: string | null }>(
    workspaceId,
    `SELECT follow_up_at FROM leads WHERE workspace_id = $1 AND customer_id = $2
     ORDER BY created_at DESC LIMIT 1`,
    [workspaceId, customerId],
  );
  if (lead?.follow_up_at) return new Date(lead.follow_up_at);
  return new Date(Date.now() + TWO_DAYS_MS);
}
