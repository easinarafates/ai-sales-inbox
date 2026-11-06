import { Router, type Response } from 'express';
import { query, queryOne } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';
import { checkProductLimit } from '../subscriptions/service';

export const productsRouter = Router();
productsRouter.use(requireAuth);

interface ProductRow {
  id: string;
  name: string;
  price_paisa: number;
  size: string | null;
  stock: number;
  description: string | null;
}

productsRouter.get('/', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rows } = await query<ProductRow>(
    workspaceId,
    'SELECT id, name, price_paisa, size, stock, description FROM products WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 200',
    [workspaceId],
  );
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
  res.status(201).json({ product: rows[0] });
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
  res.json({ product });
});
