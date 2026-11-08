/**
 * Driver for the auto re-engagement follow-up (order management).
 * Usage: npx tsx ../../scripts/auto-followup-driver.ts <workspaceId>
 * with USE_PGLITE=true + PGLITE_DATA_DIR pointing at the verifier boot's
 * data dir. Builds six backdated scenarios directly in the DB, runs the
 * scheduler twice (no duplicates) and the processor twice (no double
 * send), and prints the outcome as JSON — the verifier checks it.
 *
 * Scenarios (all "last message 2 days + 1h ago", delay = 2 days):
 *  1. webchat, interested (asked about Jeans, got a price), no orders
 *     → scheduled once + SENT once (webchat has no 24h window).
 *  2. messenger, interested, no orders → scheduled + WINDOW_EXPIRED
 *     (2 days > 24h window), NO message sent, honest reason.
 *  3. webchat, WAITING/angry customer → never scheduled.
 *  4. webchat, customer who already ORDERED → never scheduled.
 *  5. webchat, "Hi" only (no product interest) → never scheduled.
 *  6. the OWNER (workspace owner_psid) → never scheduled.
 */
import { randomBytes } from 'node:crypto';
import { pool } from '../apps/api/src/db/pool';
import { encryptToken } from '../apps/api/src/db/crypto';
import {
  processDueAutoFollowups,
  scheduleAutoFollowups,
} from '../apps/api/src/followups/auto';

const TWO_DAYS_AGO = new Date(Date.now() - (2 * 24 + 1) * 60 * 60 * 1000);

async function main() {
  // The verifier reuses one fixed PGlite data dir across runs, and
  // idx_orders_invoice_token is globally unique — so the order's token
  // must be fresh per run, never hardcoded.
  const orderToken = randomBytes(16).toString('hex');
  const [workspaceId] = process.argv.slice(2);
  if (!workspaceId) {
    console.error('usage: auto-followup-driver.ts <workspaceId>');
    process.exit(2);
  }
  const q = async <T,>(text: string, params: unknown[] = []): Promise<T[]> => {
    const r = await pool.query(text, params);
    return r.rows as T[];
  };
  const webchat = await q<{ id: string }>(
    `SELECT id FROM channels WHERE workspace_id = $1 AND platform = 'webchat' ORDER BY created_at DESC LIMIT 1`,
    [workspaceId],
  );
  const webchatChannelId = webchat[0]?.id ?? null;
  if (!webchatChannelId) {
    console.error('no webchat channel in workspace');
    process.exit(2);
  }
  // A messenger channel for the window-expired scenario (its token is
  // never used — the 24h window check short-circuits before any send).
  const msgCh = await q<{ id: string }>(
    `INSERT INTO channels (workspace_id, platform, external_id, display_name, token_encrypted, status)
     VALUES ($1, 'messenger', 'test-page-auto', 'Test Page', $2, 'connected') RETURNING id`,
    [workspaceId, encryptToken('dummy-page-token-for-auto-followup-test')],
  );
  const messengerChannelId = msgCh[0].id;

  // The owner, for the owner-exclusion scenario.
  await pool.query(`UPDATE workspaces SET owner_psid = $2 WHERE id = $1`, [workspaceId, 'owner-test-psid']);

  async function makeCustomer(
    name: string,
    gender: string,
    platform: 'webchat' | 'messenger',
    senderId: string,
    opts: {
      waiting?: boolean;
      hasOrder?: boolean;
      interested?: boolean;
      greetingOnly?: boolean;
    } = {},
  ): Promise<{ customerId: string; conversationId: string; lastIncomingId: string }> {
    const channelId = platform === 'webchat' ? webchatChannelId : messengerChannelId;
    const cust = await q<{ id: string }>(
      // NOTE: primary_identity is a GENERATED column (platform:senderId
      // from channel_identities[0]) — it is never inserted directly.
      `INSERT INTO customers (workspace_id, name, gender, channel_identities)
       VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
      [
        workspaceId,
        name,
        gender,
        JSON.stringify([{ platform, senderId }]),
      ],
    );
    const customerId = cust[0].id;
    const conv = await q<{ id: string }>(
      `INSERT INTO conversations (workspace_id, channel_id, customer_id, status, mode, escalation_reason)
       VALUES ($1, $2, $3, $4, 'ai', $5) RETURNING id`,
      [workspaceId, channelId, customerId, opts.waiting ? 'waiting' : 'open', opts.waiting ? 'angry_customer' : null],
    );
    const conversationId = conv[0].id;
    // Incoming message (the interest), 2 days + 1h ago.
    const incomingBody = opts.greetingOnly ? 'Hi' : 'Jeans er dam koto';
    const incoming = await q<{ id: string }>(
      `INSERT INTO messages (workspace_id, conversation_id, direction, type, body, created_at)
       VALUES ($1, $2, 'in', 'text', $3, $4) RETURNING id`,
      [workspaceId, conversationId, incomingBody, TWO_DAYS_AGO.toISOString()],
    );
    const lastIncomingId = incoming[0].id;
    if (opts.interested) {
      // The AI answered with product info + a price (the interest signal).
      await pool.query(
        `INSERT INTO messages (workspace_id, conversation_id, direction, type, body, created_at)
         VALUES ($1, $2, 'out', 'text', $3, $4)`,
        [workspaceId, conversationId, 'Jeans — ৳৫০০, স্টকে আছে।', TWO_DAYS_AGO.toISOString()],
      );
    } else if (opts.greetingOnly) {
      await pool.query(
        `INSERT INTO messages (workspace_id, conversation_id, direction, type, body, created_at)
         VALUES ($1, $2, 'out', 'text', $3, $4)`,
        [workspaceId, conversationId, 'হ্যালো! স্বাগতম।', TWO_DAYS_AGO.toISOString()],
      );
    }
    if (opts.hasOrder) {
      await pool.query(
        `INSERT INTO orders (workspace_id, customer_id, conversation_id, source, status, payment_status, payment_method,
                            total_paisa, delivery_charge_paisa, handled_by, order_number, invoice_token,
                            customer_name, customer_phone, delivery_address)
         VALUES ($1, $2, $3, 'team', 'pending', 'unpaid', 'cod', 50000, 10000, 'agent', 'ASI-9001', $5, $4, '01700000001', 'House 1, Dhaka')`,
        [workspaceId, customerId, conversationId, name, orderToken],
      );
    }
    return { customerId, conversationId, lastIncomingId };
  }

  const s1 = await makeCustomer('Followup Webchat', 'male', 'webchat', 'af-wc-1', { interested: true });
  const s2 = await makeCustomer('Followup Messenger', 'female', 'messenger', 'af-msg-1', { interested: true });
  const s3 = await makeCustomer('Followup Waiting', 'male', 'webchat', 'af-wait-1', { interested: true, waiting: true });
  const s4 = await makeCustomer('Followup Ordered', 'male', 'webchat', 'af-ord-1', { interested: true, hasOrder: true });
  const s5 = await makeCustomer('Followup Hi Only', 'male', 'webchat', 'af-hi-1', { greetingOnly: true });
  const s6 = await makeCustomer('Followup Owner', 'male', 'messenger', 'owner-test-psid', { interested: true });

  // Schedule twice — the second run must schedule nothing (once per episode).
  const sched1 = await scheduleAutoFollowups(workspaceId);
  const sched2 = await scheduleAutoFollowups(workspaceId);
  // Process twice — the second run must process nothing (no double send).
  const proc1 = await processDueAutoFollowups(workspaceId);
  const proc2 = await processDueAutoFollowups(workspaceId);

  const rows = await q<{
    customer_id: string;
    status: string;
    reason: string | null;
    message: string;
  }>(
    `SELECT customer_id, status, reason, message FROM auto_followups WHERE workspace_id = $1 ORDER BY created_at`,
    [workspaceId],
  );
  const byCustomer: Record<string, { status: string; reason: string | null; message: string }> = {};
  for (const r of rows) byCustomer[r.customer_id] = { status: r.status, reason: r.reason, message: r.message };
  // How many 'out' messages were actually written for the webchat customer
  // (the follow-up send) — the messenger customer must have none.
  const outCounts = await q<{ customer_id: string; n: string }>(
    `SELECT co.customer_id, COUNT(*)::text AS n FROM messages m
     JOIN conversations co ON co.id = m.conversation_id
     WHERE m.workspace_id = $1 AND m.direction = 'out' AND m.created_at > $2
     GROUP BY co.customer_id`,
    [workspaceId, new Date(Date.now() - 60 * 60 * 1000).toISOString()],
  );
  const outByCustomer: Record<string, number> = {};
  for (const r of outCounts) outByCustomer[r.customer_id] = Number(r.n);

  console.log(JSON.stringify({
    sched1,
    sched2,
    proc1,
    proc2,
    rows: rows.map((r) => ({ customerId: r.customer_id, status: r.status, reason: r.reason, message: r.message })),
    byCustomer,
    outByCustomer,
    ids: { s1: s1.customerId, s2: s2.customerId, s3: s3.customerId, s4: s4.customerId, s5: s5.customerId, s6: s6.customerId },
  }));
  await pool.end().catch(() => undefined);
  process.exit(0);
}

main().catch((err) => {
  console.error('DRIVER FAILED:', (err as Error).message);
  console.error((err as Error).stack ?? '');
  process.exit(1);
});
