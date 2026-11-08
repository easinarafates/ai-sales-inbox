/**
 * Owner notifications (2026-11-08) — the header bell's real data.
 *
 * Before this, the bell was a static "No new notifications" placeholder.
 * Now, when a customer is escalated to Waiting (anger / off-topic), a
 * notification row is created here so the owner actually sees it:
 * "কাস্টমার রেগে গিয়েছে, আপনি একে সামলান" with the customer name and
 * the conversation id (the bell links to /inbox?conversation=<id>).
 *
 * Only the escalation path creates rows (see inbox/escalation.ts) — the
 * bell never invents one.
 */
import { query } from '../db/pool';

export interface NotificationInput {
  type: 'angry_customer' | 'off_topic' | 'cancel_request';
  title: string;
  body: string;
  conversationId?: string | null;
  customerId?: string | null;
  /** The order this notification is about (cancel requests only). */
  orderId?: string | null;
}

export async function createNotification(
  workspaceId: string,
  input: NotificationInput,
): Promise<string | null> {
  try {
    const { rows } = await query<{ id: string }>(
      workspaceId,
      `INSERT INTO notifications (workspace_id, type, title, body, conversation_id, customer_id, order_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        workspaceId,
        input.type,
        input.title,
        input.body,
        input.conversationId ?? null,
        input.customerId ?? null,
        input.orderId ?? null,
      ],
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    // A notification must never break the escalation/reply path.
    console.error('[notifications] create failed:', (err as Error).message);
    return null;
  }
}
