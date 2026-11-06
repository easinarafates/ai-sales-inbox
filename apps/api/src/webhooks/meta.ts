/**
 * Meta data-deletion callback — POST /api/meta/data-deletion.
 *
 * Required before App Review (see meta-approval/data-deletion.md):
 * when a user removes the app (Facebook Settings → Apps and Websites →
 * AI Sales Inbox → Remove), Meta POSTs a `signed_request` here.
 *
 * Flow (Meta's rules):
 *  1. Verify `signed_request` with HMAC-SHA256 + META_APP_SECRET.
 *     NEVER delete anything on an unverified request.
 *  2. The payload carries the Facebook user id (`user_id`).
 *  3. Find every customer whose `channel_identities` contains that
 *     Facebook sender id (any workspace — the request has no workspace
 *     context), and delete their data: messages → conversations →
 *     customer row; orders are anonymised (customer/conversation links
 *     removed, totals kept for accounting) rather than deleted.
 *  4. Answer within 10s with { url, confirmation_code } — the deletion
 *     itself happens synchronously here (it is a few deletes), and the
 *     request is recorded in `data_deletion_requests` (migration 07)
 *     so GET /api/meta/data-deletion/status?confirmation_code=...
 *     can report the outcome.
 *
 * If META_APP_SECRET is not configured the endpoint answers 503 and
 * deletes nothing (a callback that cannot be verified must not act).
 */
import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { config } from '../config';
import { pool } from '../db/pool';

export const metaRouter = Router();

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64');
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Verify a Meta signed_request. Format: base64url(HMAC-SHA256(payload,
 * appSecret)) + '.' + base64url(JSON payload). Returns the decoded
 * payload on success, null on any failure (bad shape, bad signature,
 * bad JSON, wrong algorithm).
 */
export function verifySignedRequest(signedRequest: string, appSecret: string): Record<string, unknown> | null {
  if (!signedRequest || !appSecret) return null;
  const parts = signedRequest.split('.');
  if (parts.length !== 2) return null;
  const [encodedSig, encodedPayload] = parts;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (payload.algorithm && String(payload.algorithm).toUpperCase() !== 'HMAC-SHA256') return null;
  const expected = crypto.createHmac('sha256', appSecret).update(encodedPayload).digest();
  let actual: Buffer;
  try {
    actual = base64UrlDecode(encodedSig);
  } catch {
    return null;
  }
  if (actual.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(actual, expected)) return null;
  return payload;
}

interface DeleteCounts {
  customers: number;
  conversations: number;
  messages: number;
  ordersAnonymised: number;
}

/** Delete one Facebook user's data across all workspaces. */
async function deleteFacebookUserData(facebookUserId: string): Promise<DeleteCounts> {
  const counts: DeleteCounts = { customers: 0, conversations: 0, messages: 0, ordersAnonymised: 0 };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: customers } = await client.query(
      `SELECT id FROM customers WHERE channel_identities @> $1::jsonb`,
      [JSON.stringify([{ senderId: facebookUserId }])],
    );
    for (const customer of customers as { id: string }[]) {
      const customerId = customer.id as string;
      const { rows: convs } = await client.query(
        'SELECT id FROM conversations WHERE customer_id = $1',
        [customerId],
      );
      const convIds = (convs as { id: string }[]).map((c) => c.id);
      if (convIds.length > 0) {
        // post_attributions + notes reference conversations (no cascade).
        await client.query('DELETE FROM post_attributions WHERE conversation_id = ANY($1::uuid[])', [convIds]);
        await client.query('DELETE FROM notes WHERE conversation_id = ANY($1::uuid[])', [convIds]);
        const msg = await client.query(
          'DELETE FROM messages WHERE conversation_id = ANY($1::uuid[])',
          [convIds],
        );
        counts.messages += msg.rowCount ?? 0;
        // Tickets keep no personal fields — just unlink them.
        await client.query(
          'UPDATE tickets SET conversation_id = NULL, customer_id = NULL WHERE customer_id = $1',
          [customerId],
        );
        // Orders: anonymise (unlink customer + conversation, keep totals
        // for accounting) instead of deleting order history.
        const ord = await client.query(
          'UPDATE orders SET customer_id = NULL, conversation_id = NULL WHERE customer_id = $1 OR conversation_id = ANY($2::uuid[])',
          [customerId, convIds],
        );
        counts.ordersAnonymised += ord.rowCount ?? 0;
        const conv = await client.query(
          'DELETE FROM conversations WHERE customer_id = $1',
          [customerId],
        );
        counts.conversations += conv.rowCount ?? 0;
      } else {
        await client.query(
          'UPDATE tickets SET customer_id = NULL WHERE customer_id = $1',
          [customerId],
        );
        const ord = await client.query(
          'UPDATE orders SET customer_id = NULL WHERE customer_id = $1',
          [customerId],
        );
        counts.ordersAnonymised += ord.rowCount ?? 0;
      }
      // Leads (and their follow-ups) belong to the customer.
      const { rows: leads } = await client.query(
        'SELECT id FROM leads WHERE customer_id = $1',
        [customerId],
      );
      for (const lead of leads as { id: string }[]) {
        await client.query('DELETE FROM followups WHERE lead_id = $1', [lead.id]);
      }
      await client.query('DELETE FROM leads WHERE customer_id = $1', [customerId]);
      await client.query('DELETE FROM notes WHERE customer_id = $1', [customerId]);
      const del = await client.query('DELETE FROM customers WHERE id = $1', [customerId]);
      counts.customers += del.rowCount ?? 0;
    }
    await client.query('COMMIT');
    return counts;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** POST /api/meta/data-deletion — Meta's data-deletion callback. Public (Meta calls it). */
metaRouter.post('/data-deletion', async (req: Request, res: Response) => {
  const appSecret = config.meta.appSecret;
  if (!appSecret) {
    res.status(503).json({ error: 'Data deletion is not configured (META_APP_SECRET missing) — no data was deleted.' });
    return;
  }
  const { signed_request: signedRequest } = (req.body ?? {}) as { signed_request?: string };
  if (!signedRequest || typeof signedRequest !== 'string') {
    res.status(400).json({ error: 'signed_request is required.' });
    return;
  }
  const payload = verifySignedRequest(signedRequest, appSecret);
  if (!payload) {
    res.status(403).json({ error: 'Invalid signed_request — signature verification failed.' });
    return;
  }
  const facebookUserId = String(payload.user_id ?? payload.userId ?? '');
  if (!facebookUserId) {
    res.status(400).json({ error: 'signed_request has no user_id.' });
    return;
  }
  const confirmationCode = `DEL-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
  try {
    const counts = await deleteFacebookUserData(facebookUserId);
    await pool.query(
      `INSERT INTO data_deletion_requests
         (confirmation_code, facebook_user_id, status, customers_deleted, conversations_deleted, messages_deleted, orders_anonymised)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        confirmationCode,
        facebookUserId,
        counts.customers > 0 ? 'completed' : 'not_found',
        counts.customers,
        counts.conversations,
        counts.messages,
        counts.ordersAnonymised,
      ],
    );
    const baseUrl = process.env.APP_URL ?? `${req.protocol}://${req.get('host') ?? 'localhost:4000'}`;
    res.json({
      url: `${baseUrl}/data-deletion/status?confirmation_code=${confirmationCode}`,
      confirmation_code: confirmationCode,
    });
  } catch (err) {
    console.error('[meta/data-deletion]', err);
    res.status(500).json({ error: 'Data deletion failed — please try again or contact support.' });
  }
});

/** GET /api/meta/data-deletion/status?confirmation_code=... — status page for the URL in the callback response. */
metaRouter.get('/data-deletion/status', async (req: Request, res: Response) => {
  const code = String(req.query.confirmation_code ?? '');
  if (!code) {
    res.status(400).json({ error: 'confirmation_code is required.' });
    return;
  }
  const { rows } = await pool.query(
    `SELECT confirmation_code, status, customers_deleted, conversations_deleted,
            messages_deleted, orders_anonymised, created_at
       FROM data_deletion_requests WHERE confirmation_code = $1`,
    [code],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'No deletion request found for this confirmation code.' });
    return;
  }
  const r = rows[0] as Record<string, unknown>;
  res.json({
    confirmation_code: r.confirmation_code,
    status: r.status,
    message:
      r.status === 'completed'
        ? 'আপনার তথ্য মুছে ফেলা হয়েছে (Your data has been deleted).'
        : 'এই Facebook অ্যাকাউন্টের কোনো তথ্য আমাদের কাছে পাওয়া যায়নি (No data was found for this Facebook account).',
    customers_deleted: r.customers_deleted,
    conversations_deleted: r.conversations_deleted,
    messages_deleted: r.messages_deleted,
    orders_anonymised: r.orders_anonymised,
    requested_at: r.created_at,
  });
});
