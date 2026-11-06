import { pool, query } from '../db/pool';

/**
 * Human handover auto-return sweep (Worker B).
 *
 * Same polling-sweep pattern as processDueFollowups in followups/engine.ts:
 * no Redis dependency. Conversations in human mode whose handover timer
 * (handover_until) has passed are handed back to the AI (mode='ai',
 * handed_to='ai', handover_until cleared). The API runs this every 60s in
 * PGlite mode (see apps/api/src/index.ts); the BullMQ worker should call
 * it in its 60s sweep too (one import + one call in workers/queue/src/worker.ts).
 */
export async function processDueHandovers(workspaceId?: string): Promise<{
  processed: number;
  returned: number;
}> {
  if (workspaceId) return processDueForWorkspace(workspaceId);
  const { rows: workspaces } = await pool.query<{ workspace_id: string }>(
    `SELECT DISTINCT workspace_id FROM conversations
     WHERE mode = 'human' AND handover_until IS NOT NULL AND handover_until <= now()`,
  );
  const total = { processed: 0, returned: 0 };
  for (const { workspace_id } of workspaces) {
    const r = await processDueForWorkspace(workspace_id);
    total.processed += r.processed;
    total.returned += r.returned;
  }
  return total;
}

async function processDueForWorkspace(workspaceId: string): Promise<{
  processed: number;
  returned: number;
}> {
  const { rows } = await query<{ id: string }>(
    workspaceId,
    `SELECT id FROM conversations
     WHERE workspace_id = $1 AND mode = 'human'
       AND handover_until IS NOT NULL AND handover_until <= now()`,
    [workspaceId],
  );
  let returned = 0;
  for (const { id } of rows) {
    const { rowCount } = await query(
      workspaceId,
      `UPDATE conversations
       SET mode = 'ai', handed_to = 'ai', handover_until = NULL, updated_at = now()
       WHERE workspace_id = $1 AND id = $2 AND mode = 'human'`,
      [workspaceId, id],
    );
    returned += rowCount;
  }
  return { processed: rows.length, returned };
}
