/**
 * GET /api/delivery-charges — the shop's delivery charge rules.
 * PUT /api/delivery-charges { rules: [{ scope, district?, chargePaisa }] }
 *   — replace the rules (owner settings save; base zones are always kept).
 *
 * Workspace-scoped (requireAuth + getWorkspaceId), like the other shop
 * settings (AI Providers). The AI reads the same rules through the
 * service — never the hardcoded ৳100/৳130.
 */
import { Router, type Response } from 'express';
import { pool, query } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';
import { getDeliveryChargeRules, setDeliveryChargeRules, type DeliveryChargeInput } from './service';

export const deliveryChargesRouter = Router();
deliveryChargesRouter.use(requireAuth);

deliveryChargesRouter.get('/', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const db = { query: (text: string, params?: unknown[]) => query(workspaceId, text, params ?? []) };
  const rules = await getDeliveryChargeRules(db, workspaceId);
  res.json({ rules });
});

deliveryChargesRouter.put('/', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const body = (req.body ?? {}) as { rules?: unknown };
  if (!Array.isArray(body.rules)) {
    res.status(400).json({ error: 'rules must be an array of { scope, district?, chargePaisa }' });
    return;
  }
  const input = body.rules as DeliveryChargeInput[];
  // The save is transactional (DELETE + INSERT on one connection) so a
  // failed save can never leave the workspace half-configured.
  const client = await pool.connect();
  try {
    const db = { query: (text: string, params?: unknown[]) => client.query(text, params as never[]) };
    const rules = await setDeliveryChargeRules(db, workspaceId, input);
    res.json({ rules });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  } finally {
    client.release();
  }
});
