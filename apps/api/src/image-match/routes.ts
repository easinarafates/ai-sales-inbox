import { Router, type Response } from 'express';
import { query } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';
import { matchProductsByImage } from '../ai-agent/image-match';

/**
 * Photo recognition (Worker B).
 * POST /api/image-match {imageRef|imageUrl, limit?}
 * Uses the EXISTING embeddings wiring (image-match.ts). When no embeddings
 * provider is configured it honestly returns {available:false} — it NEVER
 * fakes a match or invents a product.
 */
export const imageMatchRouter = Router();
imageMatchRouter.use(requireAuth);

imageMatchRouter.post('/image-match', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { imageRef, imageUrl, limit } = (req.body ?? {}) as {
    imageRef?: string;
    imageUrl?: string;
    limit?: number;
  };
  const ref = (typeof imageRef === 'string' && imageRef.trim()) || (typeof imageUrl === 'string' && imageUrl.trim()) || '';
  if (!ref) {
    res.status(400).json({ error: 'imageRef (or imageUrl) is required' });
    return;
  }
  const result = await matchProductsByImage(workspaceId, ref, typeof limit === 'number' ? limit : 3);
  res.json(result);
});
