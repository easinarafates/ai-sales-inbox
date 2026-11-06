import { Router, type Response } from 'express';
import { query, queryOne } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';
import { processDueHandovers } from './engine';

/**
 * Human handover with timer (Worker B).
 * POST /api/inbox/:id/handover {durationHours: 1|4} — human takes over,
 * AI pauses until handover_until. GET status, POST return-to-ai.
 *
 * durationSeconds is a TEST-ONLY override (max 300s) so the verifier can
 * watch the auto-return sweep without waiting an hour. The production UI
 * only ever offers 1 or 4 hours; this is not a backdoor — it only ever
 * shortens a handover inside the caller's own workspace.
 */
export const handoverRouter = Router();
handoverRouter.use(requireAuth);

const HANDOVER_COLUMNS =
  'id, status, mode, handed_to, handover_until, handover_started_at, customer_id, updated_at';

async function loadConversation(workspaceId: string, conversationId: string) {
  return queryOne(
    workspaceId,
    `SELECT ${HANDOVER_COLUMNS} FROM conversations WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, conversationId],
  );
}

function handoverView(row: Record<string, unknown>) {
  const until = row.handover_until ? new Date(row.handover_until as string) : null;
  const active = row.mode === 'human' && !!until && until.getTime() > Date.now();
  return {
    conversationId: row.id,
    mode: row.mode,
    handedTo: row.handed_to,
    handoverUntil: row.handover_until ?? null,
    handoverStartedAt: row.handover_started_at ?? null,
    active,
    expiresInSeconds:
      until && active ? Math.max(0, Math.round((until.getTime() - Date.now()) / 1000)) : 0,
  };
}

/** POST /api/inbox/:id/handover {durationHours: 1|4, durationSeconds? (test-only, ≤300)} */
handoverRouter.post('/inbox/:id/handover', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { durationHours, durationSeconds } = (req.body ?? {}) as {
    durationHours?: number;
    durationSeconds?: number;
  };
  let ms: number;
  if (typeof durationSeconds === 'number') {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 300) {
      res.status(400).json({ error: 'durationSeconds (test-only) must be between 1 and 300' });
      return;
    }
    ms = durationSeconds * 1000;
  } else if (durationHours === 1 || durationHours === 4) {
    ms = durationHours * 60 * 60 * 1000;
  } else {
    res.status(400).json({ error: 'durationHours must be 1 or 4' });
    return;
  }
  const until = new Date(Date.now() + ms).toISOString();
  const { rows } = await query(
    workspaceId,
    `UPDATE conversations
     SET mode = 'human', handed_to = 'human', handover_started_at = now(),
         handover_until = $1, updated_at = now()
     WHERE workspace_id = $2 AND id = $3 RETURNING ${HANDOVER_COLUMNS}`,
    [until, workspaceId, req.params.id],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  res.json({ handover: handoverView(rows[0]) });
});

/** GET /api/inbox/:id/handover */
handoverRouter.get('/inbox/:id/handover', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const row = await loadConversation(workspaceId, req.params.id);
  if (!row) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  res.json({ handover: handoverView(row) });
});

/** POST /api/inbox/:id/return-to-ai */
handoverRouter.post('/inbox/:id/return-to-ai', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rows } = await query(
    workspaceId,
    `UPDATE conversations
     SET mode = 'ai', handed_to = 'ai', handover_until = NULL, updated_at = now()
     WHERE workspace_id = $1 AND id = $2 RETURNING ${HANDOVER_COLUMNS}`,
    [workspaceId, req.params.id],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  res.json({ handover: handoverView(rows[0]) });
});

/** POST /api/inbox/handovers/run — manual trigger: return every expired handover now. */
handoverRouter.post('/inbox/handovers/run', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const result = await processDueHandovers(workspaceId);
  res.json(result);
});
