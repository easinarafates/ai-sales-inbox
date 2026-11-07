import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router, type Response } from 'express';
import { del, put } from '@vercel/blob';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { pool, query, queryOne } from '../db/pool';
import { inferGenderFromName } from './gender';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';
import { checkProductLimit } from '../subscriptions/service';

/** Customers (Phase 2): search, full profile, and merging duplicate profiles. */
export const customersRouter = Router();
customersRouter.use(requireAuth);

/**
 * Customer photos — the shop owner can upload a photo for a customer
 * from the Inbox (POST /:id/photo). Storage follows the product-photo
 * pattern (no new storage path): direct browser→Vercel Blob via a
 * client token (POST /api/customers/upload-token), then register the
 * Blob URL; base64 fallback stores in Blob on Vercel, on disk locally.
 * The photo is marked picture_source='manual' (migration 18) so the
 * Meta profile refresh never overwrites or clears it — see
 * channels/meta-profile.ts. Limits: one photo per customer, images
 * only (jpeg/png/gif/webp), at most 25 MB.
 */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024; // 25 MB
const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const IMAGE_MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};
const IMAGE_URL_EXT = /\.(jpe?g|png|gif|webp)(\?.*)?$/i;

const UPLOAD_DIR = path.resolve(process.cwd(), 'uploads');
if (!process.env.VERCEL) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

interface CustomerRow {
  id: string;
  name: string | null;
  phone: string | null;
  address: string | null;
  gender: string | null;
  /** True once the owner corrected the name by hand — the Meta refresh must never overwrite it. */
  name_manually_set: boolean | null;
  picture_url: string | null;
  picture_source: string | null;
  channel_identities: unknown;
  created_at: string;
  updated_at: string;
}

/**
 * GET /api/customers?q= — search by name or phone (empty q lists all).
 * BUYERS ONLY: a customer appears here only if they have at least one
 * order. People who only messaged (never ordered) — including the shop
 * owner testing the page and the page itself — belong in the Inbox,
 * not in the Customers list.
 */
const BUYERS_ONLY = `EXISTS (SELECT 1 FROM orders o WHERE o.workspace_id = customers.workspace_id AND o.customer_id = customers.id)`;

/** GET /api/customers?q= — search by name or phone (empty q lists all). */
customersRouter.get('/customers', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!q) {
    const { rows } = await query<CustomerRow>(
      workspaceId,
      `SELECT id, name, phone, address, gender, name_manually_set, picture_url, picture_source, channel_identities, created_at, updated_at FROM customers WHERE workspace_id = $1 AND ${BUYERS_ONLY} ORDER BY created_at DESC LIMIT 200`,
      [workspaceId],
    );
    res.json({ customers: rows });
    return;
  }
  const like = `%${q}%`;
  const { rows } = await query<CustomerRow>(
    workspaceId,
    `SELECT id, name, phone, address, gender, name_manually_set, picture_url, picture_source, channel_identities, created_at, updated_at FROM customers
     WHERE workspace_id = $1 AND ${BUYERS_ONLY} AND (name ILIKE $2 OR phone ILIKE $2)
     ORDER BY created_at DESC LIMIT 200`,
    [workspaceId, like],
  );
  res.json({ customers: rows });
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GET /api/customers/:id — profile + identities, conversations, orders, notes. */
customersRouter.get('/customers/:id', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  // A non-UUID id (e.g. /customers/merge hitting this route) must be a 400,
  // never a DB error — an invalid uuid used to crash the whole API process.
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: 'Customer id is not valid' });
    return;
  }
  const customer = await queryOne<CustomerRow>(
    workspaceId,
    'SELECT id, name, phone, address, gender, name_manually_set, picture_url, picture_source, channel_identities, created_at, updated_at FROM customers WHERE workspace_id = $1 AND id = $2',
    [workspaceId, req.params.id],
  );
  if (!customer) {
    res.status(404).json({ error: 'Customer not found' });
    return;
  }
  const { rows: conversations } = await query(
    workspaceId,
    `SELECT id, channel_id, status, mode, created_at, updated_at FROM conversations
     WHERE workspace_id = $1 AND customer_id = $2 ORDER BY updated_at DESC LIMIT 100`,
    [workspaceId, req.params.id],
  );
  const { rows: orders } = await query(
    workspaceId,
    `SELECT id, conversation_id, source, status, payment_status, total_paisa, created_at FROM orders
     WHERE workspace_id = $1 AND customer_id = $2 ORDER BY created_at DESC LIMIT 100`,
    [workspaceId, req.params.id],
  );
  const { rows: notes } = await query(
    workspaceId,
    `SELECT id, conversation_id, author_id, body, created_at FROM notes
     WHERE workspace_id = $1 AND customer_id = $2 ORDER BY created_at DESC LIMIT 100`,
    [workspaceId, req.params.id],
  );
  res.json({
    customer,
    identities: customer.channel_identities,
    conversations,
    orders,
    notes,
  });
});

/**
 * PATCH /api/customers/:id { gender?, name? } — correct the customer's
 * gender and/or display name by hand from the Inbox (ছেলে / মেয়ে /
 * জানা নেই; নাম ঠিক করা). The AI addresses the customer as "স্যার"
 * (male) or "ম্যাডাম" (female) throughout its replies, or neutral
 * "আপনি" when 'unknown'. A hand-set gender is final: the name-based
 * inference never overwrites it. Correcting the name sets
 * name_manually_set, and the automatic Meta profile refresh must NEVER
 * overwrite a manually set name with the Facebook-returned name again
 * (see channels/meta-profile.ts). The name is stored exactly as typed —
 * English stays English, Bengali stays Bengali, never translated or
 * transliterated. When the name is corrected while the gender is still
 * unknown, the gender is re-inferred from the new name (a hand-set
 * gender is never re-inferred). The customer must belong to the caller's
 * workspace (404 otherwise). Anything else in the body is ignored.
 */
customersRouter.patch('/customers/:id', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: 'Customer id is not valid' });
    return;
  }
  const { gender, name } = (req.body ?? {}) as { gender?: unknown; name?: unknown };
  if (gender !== undefined && gender !== 'male' && gender !== 'female' && gender !== 'unknown') {
    res.status(400).json({ error: "gender must be 'male', 'female' or 'unknown'" });
    return;
  }
  let newName: string | null = null;
  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 200) {
      res.status(400).json({ error: 'name must be a non-empty string (max 200 characters)' });
      return;
    }
    newName = name.trim();
  }
  if (gender === undefined && newName === null) {
    res.status(400).json({ error: 'nothing to update — send gender and/or name' });
    return;
  }
  const existing = await queryOne<{ gender: string | null }>(
    workspaceId,
    'SELECT gender FROM customers WHERE workspace_id = $1 AND id = $2',
    [workspaceId, req.params.id],
  );
  if (!existing) {
    res.status(404).json({ error: 'Customer not found' });
    return;
  }
  const newGender =
    gender !== undefined
      ? (gender as string)
      : newName !== null && (existing.gender ?? 'unknown') === 'unknown'
        ? inferGenderFromName(newName)
        : undefined;
  const sets: string[] = [];
  const params: unknown[] = [];
  if (newGender !== undefined) {
    params.push(newGender);
    sets.push(`gender = $${params.length}`);
  }
  if (newName !== null) {
    params.push(newName);
    sets.push(`name = $${params.length}`);
    sets.push('name_manually_set = TRUE');
  }
  params.push(workspaceId, req.params.id);
  const { rows } = await query<CustomerRow>(
    workspaceId,
    `UPDATE customers SET ${sets.join(', ')}, updated_at = now()
     WHERE workspace_id = $${params.length - 1} AND id = $${params.length}
     RETURNING id, name, phone, address, gender, name_manually_set, picture_url, picture_source, channel_identities, created_at, updated_at`,
    params,
  );
  if (!rows[0]) {
    res.status(404).json({ error: 'Customer not found' });
    return;
  }
  res.json({ customer: rows[0] });
});

/**
 * POST /api/customers/upload-token — client token for direct
 * browser→Vercel Blob upload (Vercel only). Same shape as the
 * product-photos token route, images only. Locally (no
 * BLOB_READ_WRITE_TOKEN) this returns 503 and the web falls back to
 * the base64 :id/photo endpoint.
 */
customersRouter.post('/customers/upload-token', async (req: AuthRequest, res: Response) => {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    res.status(503).json({ error: 'Blob storage is not configured (BLOB_READ_WRITE_TOKEN missing)' });
    return;
  }
  try {
    const jsonResponse = await handleUpload({
      body: req.body as HandleUploadBody,
      request: req as unknown as Request,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: IMAGE_MIMES,
        maximumSizeInBytes: MAX_IMAGE_BYTES,
        addRandomSuffix: true,
      }),
      onUploadCompleted: async ({ blob }) => {
        console.log('[blob] customer photo upload completed:', blob.url);
      },
    });
    res.status(200).json(jsonResponse);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** Resolve one uploaded photo to a stored URL. Returns the URL or sends a 400 and returns null. */
async function resolvePhotoUrl(
  req: { body?: unknown },
  res: Response,
): Promise<string | null> {
  const { url, fileBase64, fileName, mimeType } = (req.body ?? {}) as {
    url?: string;
    fileBase64?: string;
    fileName?: string;
    mimeType?: string;
  };
  if (typeof url === 'string' && url.trim()) {
    const trimmed = url.trim();
    if (trimmed.length > 2048) {
      res.status(400).json({ error: 'ছবির লিংকটি অনেক বড়' });
      return null;
    }
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      res.status(400).json({ error: 'ছবির লিংকটি সঠিক নয় (invalid URL)' });
      return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      res.status(400).json({ error: 'ছবির লিংক http(s) হতে হবে' });
      return null;
    }
    const declaredMime = typeof mimeType === 'string' ? mimeType.trim() : '';
    if (!IMAGE_URL_EXT.test(parsed.pathname) && !IMAGE_MIMES.includes(declaredMime)) {
      res.status(400).json({ error: 'শুধু ছবির লিংক (jpg/png/gif/webp) দেওয়া যায়' });
      return null;
    }
    return parsed.toString();
  }
  if (typeof fileBase64 === 'string' && fileBase64.trim() !== '') {
    let mime = typeof mimeType === 'string' ? mimeType.trim() : '';
    let b64 = fileBase64.trim();
    const dataUrlMatch = b64.match(/^data:([^;,]+);base64,(.+)$/);
    if (dataUrlMatch) {
      mime = dataUrlMatch[1];
      b64 = dataUrlMatch[2];
    }
    if (!IMAGE_MIMES.includes(mime)) {
      res.status(400).json({ error: 'শুধু ছবি (jpg/png/gif/webp) আপলোড করা যায়' });
      return null;
    }
    const ext = IMAGE_MIME_EXT[mime];
    if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) {
      res.status(400).json({ error: 'fileBase64 সঠিক base64 নয়' });
      return null;
    }
    const buf = Buffer.from(b64.replace(/\s/g, ''), 'base64');
    if (buf.length === 0) {
      res.status(400).json({ error: 'খালি ফাইল আপলোড করা যাবে না' });
      return null;
    }
    if (buf.length > MAX_IMAGE_BYTES) {
      res.status(400).json({ error: 'ছবি 25 MB-এর বেশি হতে পারবে না (max 25 MB)' });
      return null;
    }
    const stored = `${randomUUID()}${ext}`;
    // Vercel: store in Blob (public URL). The API function has a 4.5 MB
    // request-body cap, so large files should use the direct
    // browser→Blob path (/api/customers/upload-token) instead.
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      try {
        const blob = await put(stored, buf, { access: 'public', contentType: mime });
        return blob.url;
      } catch (err) {
        res.status(500).json({ error: `ছবি সংরক্ষণ করা যায়নি: ${(err as Error).message}` });
        return null;
      }
    }
    // Local / cPanel fallback: disk storage under uploads/.
    try {
      fs.writeFileSync(path.join(UPLOAD_DIR, stored), buf);
    } catch (err) {
      res.status(500).json({ error: `ছবি সংরক্ষণ করা যায়নি: ${(err as Error).message}` });
      return null;
    }
    return `/api/uploads/${stored}`;
  }
  void fileName; // original name is not kept (random UUID name instead)
  res.status(400).json({ error: 'url বা fileBase64 — একটি দিতে হবে' });
  return null;
}

/** Best-effort delete of a replaced/removed Blob photo (never fails the request). */
async function deleteBlobPhotoBestEffort(url: string | null): Promise<void> {
  if (!url || !process.env.BLOB_READ_WRITE_TOKEN || !url.includes('blob.vercel-storage.com')) return;
  try {
    await del(url);
  } catch (err) {
    console.warn('[customers] Blob delete failed (row already updated):', (err as Error).message);
  }
}

/**
 * POST /api/customers/:id/photo — set a customer's photo (manual upload
 * from the Inbox). Body (one of the two):
 * - { url } — an already-uploaded image URL (e.g. a public Blob URL from
 *   the direct browser→Blob upload via POST /api/customers/upload-token).
 * - { fileBase64, fileName?, mimeType? } — a base64 image (data: URL or
 *   raw base64); stored in Blob on Vercel, on disk locally.
 * The photo is stored with picture_source='manual' (migration 18), so
 * the Meta profile refresh never overwrites it. Replacing a manual
 * photo is allowed (the owner chose a new one); a Meta photo is also
 * replaced by a manual one. The customer must belong to the caller's
 * workspace (404 otherwise).
 */
customersRouter.post('/customers/:id/photo', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: 'Customer id is not valid' });
    return;
  }
  const existing = await queryOne<{ picture_url: string | null }>(
    workspaceId,
    'SELECT picture_url FROM customers WHERE workspace_id = $1 AND id = $2',
    [workspaceId, req.params.id],
  );
  if (!existing) {
    res.status(404).json({ error: 'Customer not found' });
    return;
  }
  const finalUrl = await resolvePhotoUrl(req, res);
  if (!finalUrl) return; // resolvePhotoUrl already sent the 400/500
  const { rows } = await query<CustomerRow>(
    workspaceId,
    `UPDATE customers SET picture_url = $1, picture_source = 'manual', updated_at = now()
     WHERE workspace_id = $2 AND id = $3
     RETURNING id, name, phone, address, gender, name_manually_set, picture_url, picture_source, channel_identities, created_at, updated_at`,
    [finalUrl, workspaceId, req.params.id],
  );
  if (existing.picture_url && existing.picture_url !== finalUrl) {
    await deleteBlobPhotoBestEffort(existing.picture_url);
  }
  res.json({ customer: rows[0] });
});

/**
 * DELETE /api/customers/:id/photo — remove a customer's photo (manual
 * or Meta). Back to the initials avatar; a later Meta refresh may fill
 * a photo again (picture_source is cleared, so the refresh is allowed
 * to). The customer must belong to the caller's workspace (404
 * otherwise). No photo → 200 with the customer unchanged.
 */
customersRouter.delete('/customers/:id/photo', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: 'Customer id is not valid' });
    return;
  }
  const existing = await queryOne<{ picture_url: string | null }>(
    workspaceId,
    'SELECT picture_url FROM customers WHERE workspace_id = $1 AND id = $2',
    [workspaceId, req.params.id],
  );
  if (!existing) {
    res.status(404).json({ error: 'Customer not found' });
    return;
  }
  const { rows } = await query<CustomerRow>(
    workspaceId,
    `UPDATE customers SET picture_url = NULL, picture_source = NULL, updated_at = now()
     WHERE workspace_id = $1 AND id = $2
     RETURNING id, name, phone, address, gender, name_manually_set, picture_url, picture_source, channel_identities, created_at, updated_at`,
    [workspaceId, req.params.id],
  );
  await deleteBlobPhotoBestEffort(existing.picture_url);
  res.json({ customer: rows[0] });
});

interface Identity {
  platform: string;
  senderId: string;
  name?: string | null;
}

/**
 * POST /api/customers/merge {keepCustomerId, mergeCustomerId}
 * One transaction: re-point conversations, orders, tickets, leads (and
 * notes) to the kept customer, merge channel identities deduped by
 * platform+senderId, fill in missing name/phone/address, delete the merged row.
 */
customersRouter.post('/customers/merge', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { keepCustomerId, mergeCustomerId } = (req.body ?? {}) as {
    keepCustomerId?: string;
    mergeCustomerId?: string;
  };
  if (!keepCustomerId || !mergeCustomerId) {
    res.status(400).json({ error: 'keepCustomerId and mergeCustomerId are required' });
    return;
  }
  if (keepCustomerId === mergeCustomerId) {
    res.status(400).json({ error: 'keepCustomerId and mergeCustomerId must be different' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const keepRes = await client.query(
      'SELECT id, name, phone, address, picture_url, picture_source, channel_identities FROM customers WHERE workspace_id = $1 AND id = $2',
      [workspaceId, keepCustomerId],
    );
    const mergeRes = await client.query(
      'SELECT id, name, phone, address, picture_url, picture_source, channel_identities FROM customers WHERE workspace_id = $1 AND id = $2',
      [workspaceId, mergeCustomerId],
    );
    if (keepRes.rowCount === 0 || mergeRes.rowCount === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Customer not found in this workspace' });
      return;
    }
    const keep = keepRes.rows[0] as { id: string; name: string | null; phone: string | null; address: string | null; picture_url: string | null; picture_source: string | null; name_manually_set: boolean | null; channel_identities: Identity[] };
    const merge = mergeRes.rows[0] as { id: string; name: string | null; phone: string | null; address: string | null; picture_url: string | null; picture_source: string | null; name_manually_set: boolean | null; channel_identities: Identity[] };

    // Merge identities, deduped by platform+senderId (kept customer's win ties).
    const seen = new Set<string>();
    const mergedIdentities: Identity[] = [];
    for (const ident of [...(keep.channel_identities ?? []), ...(merge.channel_identities ?? [])]) {
      const key = `${ident.platform}:${ident.senderId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      mergedIdentities.push(ident);
    }

    // One open chat per customer per channel (migration 16): if both
    // customers have an OPEN conversation on the same channel, re-pointing
    // the merged one's would violate the unique index. Close the merged
    // customer's colliding open chats first (their messages stay in
    // history as a done chat); the kept customer's open chat stays open.
    await client.query(
      `UPDATE conversations c SET status = 'done'
       WHERE c.workspace_id = $1 AND c.customer_id = $2 AND c.status = 'open'
         AND EXISTS (
           SELECT 1 FROM conversations k
           WHERE k.workspace_id = $1 AND k.customer_id = $3 AND k.status = 'open'
             AND k.channel_id IS NOT DISTINCT FROM c.channel_id
         )`,
      [workspaceId, mergeCustomerId, keepCustomerId],
    );

    for (const table of ['conversations', 'orders', 'tickets', 'leads', 'notes']) {
      await client.query(
        `UPDATE ${table} SET customer_id = $1 WHERE workspace_id = $2 AND customer_id = $3`,
        [keepCustomerId, workspaceId, mergeCustomerId],
      );
    }
    // A photo is never lost in a merge: the kept customer's photo wins;
    // if it has none, the merged customer's photo (manual or Meta) moves
    // over with its source, so a manual photo still survives later
    // Meta refreshes. Same for a manually set name: if the kept customer
    // has no name, the merged customer's name moves over WITH its manual
    // flag, so the Meta refresh still cannot overwrite it afterwards.
    await client.query(
      `UPDATE customers
       SET channel_identities = $1::jsonb,
           name = COALESCE(name, $2), phone = COALESCE(phone, $3), address = COALESCE(address, $4),
           picture_url = COALESCE(picture_url, $5),
           picture_source = CASE WHEN picture_url IS NULL THEN $6 ELSE picture_source END,
           name_manually_set = CASE WHEN name IS NULL THEN $9 ELSE name_manually_set END,
           updated_at = now()
       WHERE workspace_id = $7 AND id = $8`,
      [JSON.stringify(mergedIdentities), merge.name, merge.phone, merge.address, merge.picture_url, merge.picture_source, workspaceId, keepCustomerId, merge.name_manually_set ?? false],
    );
    await client.query('DELETE FROM customers WHERE workspace_id = $1 AND id = $2', [workspaceId, mergeCustomerId]);
    await client.query('COMMIT');
    const customer = await queryOne<CustomerRow>(
      workspaceId,
      'SELECT id, name, phone, address, gender, name_manually_set, picture_url, picture_source, channel_identities, created_at, updated_at FROM customers WHERE workspace_id = $1 AND id = $2',
      [workspaceId, keepCustomerId],
    );
    res.json({ customer });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('[customers/merge]', err);
    res.status(500).json({ error: 'Customer merge failed' });
  } finally {
    client.release();
  }
});
