import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router, type Response } from 'express';
import { del, put } from '@vercel/blob';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { query, queryOne } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';
import { checkProductLimit } from '../subscriptions/service';

export const productsRouter = Router();
productsRouter.use(requireAuth);

/**
 * Product photos — multiple photos per product.
 *
 * Storage follows the scheduled-post media pattern (no new storage path):
 * - Vercel: the browser uploads straight to Vercel Blob via a client
 *   token (POST /api/products/upload-token + @vercel/blob/client), then
 *   registers the Blob URL with POST /api/products/:id/images {url}.
 *   This bypasses the API function's 4.5 MB request-body cap.
 * - Fallback (local dev / no Blob token): POST /:id/images also accepts
 *   a base64 file ({fileBase64, fileName, mimeType}); on Vercel it goes
 *   to Blob, locally to disk under uploads/ (served at /api/uploads/<file>
 *   by the scheduling router's static route — same known limitation as
 *   scheduled-post media: local disk URLs need an auth token to view).
 * - The photo URLs are stored in product_images (embedding left NULL —
 *   image-match works without a key and never fakes embeddings).
 * - Limits: at most 10 photos per product, each at most 25 MB, images only.
 */
const MAX_PRODUCT_IMAGES = 10;
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

interface ProductImageRow {
  id: string;
  url: string;
  created_at: string;
}

interface ProductRow {
  id: string;
  name: string;
  price_paisa: number;
  size: string | null;
  stock: number;
  description: string | null;
  images?: ProductImageRow[];
}

/** Attach each product's photos (one query for the whole list). */
async function attachImages(workspaceId: string, products: ProductRow[]): Promise<void> {
  if (products.length === 0) return;
  const ids = products.map((p) => p.id);
  const { rows } = await query<{ product_id: string; id: string; url: string; created_at: string }>(
    workspaceId,
    `SELECT product_id, id, url, created_at FROM product_images
     WHERE workspace_id = $1 AND product_id = ANY($2::uuid[])
     ORDER BY created_at ASC`,
    [workspaceId, ids],
  );
  const byProduct = new Map<string, ProductImageRow[]>();
  for (const r of rows) {
    const list = byProduct.get(r.product_id) ?? [];
    list.push({ id: r.id, url: r.url, created_at: r.created_at });
    byProduct.set(r.product_id, list);
  }
  for (const p of products) p.images = byProduct.get(p.id) ?? [];
}

async function productExists(workspaceId: string, productId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    workspaceId,
    'SELECT id FROM products WHERE workspace_id = $1 AND id = $2',
    [workspaceId, productId],
  );
  return !!row;
}

/**
 * POST /api/products/upload-token — client token for direct
 * browser→Vercel Blob upload (Vercel only). Same shape as the
 * scheduled-posts token route, images only. Locally (no
 * BLOB_READ_WRITE_TOKEN) this returns 503 and the web falls back to
 * the base64 /:id/images endpoint.
 */
productsRouter.post('/upload-token', async (req: AuthRequest, res: Response) => {
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
        console.log('[blob] product photo upload completed:', blob.url);
      },
    });
    res.status(200).json(jsonResponse);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

productsRouter.get('/', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rows } = await query<ProductRow>(
    workspaceId,
    'SELECT id, name, price_paisa, size, stock, description FROM products WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 200',
    [workspaceId],
  );
  await attachImages(workspaceId, rows);
  res.json({ products: rows });
});

productsRouter.post('/', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { name, pricePaisa, size, stock, description } = (req.body ?? {}) as {
    name?: string;
    pricePaisa?: number;
    size?: string;
    stock?: number;
    description?: string;
  };
  if (!name || typeof pricePaisa !== 'number' || pricePaisa < 0) {
    res.status(400).json({ error: 'name and a non-negative pricePaisa are required' });
    return;
  }
  // Subscription limit: this plan allows only so many products.
  const productLimit = await checkProductLimit(workspaceId);
  if (!productLimit.canAdd) {
    res.status(402).json({ error: productLimit.message });
    return;
  }
  const { rows } = await query<ProductRow>(
    workspaceId,
    `INSERT INTO products (workspace_id, name, price_paisa, size, stock, description)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, price_paisa, size, stock, description`,
    [workspaceId, name, pricePaisa, size ?? null, stock ?? 0, description ?? null],
  );
  const product = rows[0];
  product.images = [];
  res.status(201).json({ product });
});

/** GET /api/products/search?q= — text search (name/description). */
productsRouter.get('/search', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!q) {
    res.json({ products: [] });
    return;
  }
  const like = `%${q}%`;
  const { rows } = await query<ProductRow>(
    workspaceId,
    `SELECT id, name, price_paisa, size, stock, description FROM products
     WHERE workspace_id = $1 AND (name ILIKE $2 OR description ILIKE $2)
     ORDER BY name ASC LIMIT 50`,
    [workspaceId, like],
  );
  await attachImages(workspaceId, rows);
  res.json({ products: rows });
});

/**
 * POST /api/products/search-voice {transcript} — voice-search stub.
 * Phase 1 has no speech-to-text service; the caller (web app) supplies the
 * transcript and it is used as a plain text query. A real STT provider plugs
 * in here in a later phase.
 */
productsRouter.post('/search-voice', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { transcript } = (req.body ?? {}) as { transcript?: string };
  if (!transcript || !transcript.trim()) {
    res.status(400).json({ error: 'transcript is required' });
    return;
  }
  const like = `%${transcript.trim()}%`;
  const { rows } = await query<ProductRow>(
    workspaceId,
    `SELECT id, name, price_paisa, size, stock, description FROM products
     WHERE workspace_id = $1 AND (name ILIKE $2 OR description ILIKE $2)
     ORDER BY name ASC LIMIT 50`,
    [workspaceId, like],
  );
  await attachImages(workspaceId, rows);
  res.json({ transcript: transcript.trim(), products: rows });
});

/** GET /api/products/low-stock?threshold=5 — products with stock <= threshold. */
productsRouter.get('/low-stock', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const raw = typeof req.query.threshold === 'string' ? Number(req.query.threshold) : 5;
  const threshold = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 5;
  const { rows } = await query<ProductRow>(
    workspaceId,
    `SELECT id, name, price_paisa, size, stock, description FROM products
     WHERE workspace_id = $1 AND stock <= $2 ORDER BY stock ASC, name ASC LIMIT 200`,
    [workspaceId, threshold],
  );
  await attachImages(workspaceId, rows);
  res.json({ products: rows, threshold });
});

/**
 * POST /api/products/:id/adjust-stock {delta, reason} — manual stock change.
 * Stock never goes below 0; every change is recorded in stock_adjustments.
 */
productsRouter.post('/:id/adjust-stock', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { delta, reason } = (req.body ?? {}) as { delta?: number; reason?: string };
  if (typeof delta !== 'number' || !Number.isInteger(delta)) {
    res.status(400).json({ error: 'delta (integer) is required' });
    return;
  }
  const { rows } = await query<ProductRow>(
    workspaceId,
    `UPDATE products SET stock = GREATEST(0, stock + $2), updated_at = now()
     WHERE workspace_id = $1 AND id = $3
     RETURNING id, name, price_paisa, size, stock, description`,
    [workspaceId, delta, req.params.id],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Product not found' });
    return;
  }
  await query(
    workspaceId,
    `INSERT INTO stock_adjustments (workspace_id, product_id, delta, reason)
     VALUES ($1, $2, $3, $4)`,
    [workspaceId, req.params.id, delta, reason ?? null],
  );
  await attachImages(workspaceId, rows);
  res.json({ product: rows[0] });
});

productsRouter.get('/:id', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const product = await queryOne<ProductRow>(
    workspaceId,
    'SELECT id, name, price_paisa, size, stock, description FROM products WHERE workspace_id = $1 AND id = $2',
    [workspaceId, req.params.id],
  );
  if (!product) {
    res.status(404).json({ error: 'Product not found' });
    return;
  }
  await attachImages(workspaceId, [product]);
  res.json({ product });
});

/**
 * PATCH /api/products/:id — update name / price / size / stock / description.
 * Only the fields sent are changed; price must stay non-negative.
 */
productsRouter.patch('/:id', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { name, pricePaisa, size, stock, description } = (req.body ?? {}) as {
    name?: string;
    pricePaisa?: number;
    size?: string | null;
    stock?: number;
    description?: string | null;
  };
  const sets: string[] = [];
  const params: unknown[] = [workspaceId, req.params.id];
  const push = (sql: string, value: unknown) => {
    params.push(value);
    sets.push(`${sql} = $${params.length}`);
  };
  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'name must not be empty' });
      return;
    }
    push('name', name.trim());
  }
  if (pricePaisa !== undefined) {
    if (typeof pricePaisa !== 'number' || pricePaisa < 0) {
      res.status(400).json({ error: 'pricePaisa must be a non-negative number' });
      return;
    }
    push('price_paisa', pricePaisa);
  }
  if (size !== undefined) push('size', size ?? null);
  if (stock !== undefined) {
    if (typeof stock !== 'number' || stock < 0) {
      res.status(400).json({ error: 'stock must be a non-negative number' });
      return;
    }
    push('stock', stock);
  }
  if (description !== undefined) push('description', description ?? null);
  if (sets.length === 0) {
    res.status(400).json({ error: 'nothing to update' });
    return;
  }
  const { rows } = await query<ProductRow>(
    workspaceId,
    `UPDATE products SET ${sets.join(', ')}, updated_at = now()
     WHERE workspace_id = $1 AND id = $2
     RETURNING id, name, price_paisa, size, stock, description`,
    params,
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Product not found' });
    return;
  }
  const product = rows[0];
  await attachImages(workspaceId, [product]);
  res.json({ product });
});

/**
 * DELETE /api/products/:id — delete the product and its photos.
 * No foreign key points at products (verified against the live schema),
 * so nothing else references it; product_images rows are removed too.
 */
productsRouter.delete('/:id', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rows } = await query<{ id: string }>(
    workspaceId,
    'DELETE FROM products WHERE workspace_id = $1 AND id = $2 RETURNING id',
    [workspaceId, req.params.id],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Product not found' });
    return;
  }
  await query(workspaceId, 'DELETE FROM product_images WHERE workspace_id = $1 AND product_id = $2', [
    workspaceId,
    req.params.id,
  ]);
  res.json({ deleted: true });
});

/** GET /api/products/:id/images — list a product's photos. */
productsRouter.get('/:id/images', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  if (!(await productExists(workspaceId, req.params.id))) {
    res.status(404).json({ error: 'Product not found' });
    return;
  }
  const { rows } = await query<ProductImageRow>(
    workspaceId,
    'SELECT id, url, created_at FROM product_images WHERE workspace_id = $1 AND product_id = $2 ORDER BY created_at ASC',
    [workspaceId, req.params.id],
  );
  res.json({ images: rows });
});

/**
 * POST /api/products/:id/images — add ONE photo to a product.
 * Body (one of the two):
 * - { url } — an already-uploaded image URL (e.g. a public Blob URL from
 *   the direct browser→Blob upload via POST /api/products/upload-token).
 * - { fileBase64, fileName?, mimeType? } — a base64 image (data: URL or
 *   raw base64); stored in Blob on Vercel, on disk locally.
 * Images only (jpeg/png/gif/webp), at most 25 MB each, at most 10 photos
 * per product. The product must belong to the caller's workspace.
 */
productsRouter.post('/:id/images', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const productId = req.params.id;
  if (!(await productExists(workspaceId, productId))) {
    res.status(404).json({ error: 'Product not found' });
    return;
  }
  const { rows: existing } = await query<{ n: string }>(
    workspaceId,
    'SELECT count(*) AS n FROM product_images WHERE workspace_id = $1 AND product_id = $2',
    [workspaceId, productId],
  );
  if (Number(existing[0]?.n ?? 0) >= MAX_PRODUCT_IMAGES) {
    res.status(400).json({ error: `একটি প্রোডাক্টে সর্বোচ্চ ${MAX_PRODUCT_IMAGES}টি ছবি যোগ করা যায়` });
    return;
  }

  const { url, fileBase64, fileName, mimeType } = (req.body ?? {}) as {
    url?: string;
    fileBase64?: string;
    fileName?: string;
    mimeType?: string;
  };

  let finalUrl: string | null = null;

  if (typeof url === 'string' && url.trim()) {
    const trimmed = url.trim();
    if (trimmed.length > 2048) {
      res.status(400).json({ error: 'ছবির লিংকটি অনেক বড়' });
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      res.status(400).json({ error: 'ছবির লিংকটি সঠিক নয় (invalid URL)' });
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      res.status(400).json({ error: 'ছবির লিংক http(s) হতে হবে' });
      return;
    }
    const declaredMime = typeof mimeType === 'string' ? mimeType.trim() : '';
    if (!IMAGE_URL_EXT.test(parsed.pathname) && !IMAGE_MIMES.includes(declaredMime)) {
      res.status(400).json({ error: 'শুধু ছবির লিংক (jpg/png/gif/webp) দেওয়া যায়' });
      return;
    }
    finalUrl = parsed.toString();
  } else if (typeof fileBase64 === 'string' && fileBase64.trim() !== '') {
    let mime = typeof mimeType === 'string' ? mimeType.trim() : '';
    let b64 = fileBase64.trim();
    const dataUrlMatch = b64.match(/^data:([^;,]+);base64,(.+)$/);
    if (dataUrlMatch) {
      mime = dataUrlMatch[1];
      b64 = dataUrlMatch[2];
    }
    if (!IMAGE_MIMES.includes(mime)) {
      res.status(400).json({ error: 'শুধু ছবি (jpg/png/gif/webp) আপলোড করা যায়' });
      return;
    }
    const ext = IMAGE_MIME_EXT[mime];
    if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) {
      res.status(400).json({ error: 'fileBase64 সঠিক base64 নয়' });
      return;
    }
    const buf = Buffer.from(b64.replace(/\s/g, ''), 'base64');
    if (buf.length === 0) {
      res.status(400).json({ error: 'খালি ফাইল আপলোড করা যাবে না' });
      return;
    }
    if (buf.length > MAX_IMAGE_BYTES) {
      res.status(400).json({ error: 'ছবি 25 MB-এর বেশি হতে পারবে না (max 25 MB)' });
      return;
    }
    const stored = `${randomUUID()}${ext}`;
    // Vercel: store in Blob (public URL). The API function has a 4.5 MB
    // request-body cap, so large files should use the direct
    // browser→Blob path (/api/products/upload-token) instead.
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      try {
        const blob = await put(stored, buf, { access: 'public', contentType: mime });
        finalUrl = blob.url;
      } catch (err) {
        res.status(500).json({ error: `ছবি সংরক্ষণ করা যায়নি: ${(err as Error).message}` });
        return;
      }
    } else {
      // Local / cPanel fallback: disk storage under uploads/.
      try {
        fs.writeFileSync(path.join(UPLOAD_DIR, stored), buf);
      } catch (err) {
        res.status(500).json({ error: `ছবি সংরক্ষণ করা যায়নি: ${(err as Error).message}` });
        return;
      }
      finalUrl = `/api/uploads/${stored}`;
    }
    void fileName; // original name is not kept (random UUID name instead)
  } else {
    res.status(400).json({ error: 'url বা fileBase64 — একটি দিতে হবে' });
    return;
  }

  const { rows } = await query<ProductImageRow>(
    workspaceId,
    `INSERT INTO product_images (workspace_id, product_id, url)
     VALUES ($1, $2, $3) RETURNING id, url, created_at`,
    [workspaceId, productId, finalUrl],
  );
  res.status(201).json({ image: rows[0] });
});

/**
 * DELETE /api/products/:id/images/:imageId — remove one photo.
 * The DB row is always deleted; the Blob object is deleted best-effort
 * (a Blob failure never fails the request).
 */
productsRouter.delete('/:id/images/:imageId', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rows } = await query<{ id: string; url: string }>(
    workspaceId,
    `DELETE FROM product_images
     WHERE workspace_id = $1 AND product_id = $2 AND id = $3
     RETURNING id, url`,
    [workspaceId, req.params.id, req.params.imageId],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Photo not found' });
    return;
  }
  const deleted = rows[0];
  if (process.env.BLOB_READ_WRITE_TOKEN && deleted.url.includes('blob.vercel-storage.com')) {
    try {
      await del(deleted.url);
    } catch (err) {
      console.warn('[products] Blob delete failed (row already removed):', (err as Error).message);
    }
  }
  res.json({ deleted: { id: deleted.id } });
});
