import { Router, type Response } from 'express';
import { query, queryOne } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';

export const analyticsRouter = Router();
analyticsRouter.use(requireAuth);

/**
 * Analytics overview (Module B, Phase 2 — PDF section 4, "অ্যানালিটিক্স").
 *
 * Ranges are Bangladesh (Asia/Dhaka) calendar days: Dhaka is UTC+6 all
 * year (no DST), so day bounds are computed in +06:00.
 * - today: Dhaka midnight -> now; yesterday: Dhaka yesterday -> Dhaka today
 * - 7d / 30d: rolling window ending now.
 *
 * Definitions:
 * - aiHandledPct: share of conversations in range with mode='ai' and NO
 *   ticket attached (the AI handled them end-to-end).
 * - humanHandoverCount: conversations currently in mode='human' whose
 *   updated_at falls in range (proxy — the schema keeps no mode-change
 *   history) + tickets created in range.
 * - avgCostPaisa: average cost_paisa per row in ai_usage_ledger in range
 *   (0 when there are no AI replies yet). Real ledger costs only — never
 *   estimated or invented.
 * - orderSource: orders in range grouped by source; anything outside
 *   ai | product_page | team | website (including NULL) counts as other.
 */

type RangeKey = 'today' | 'yesterday' | '7d' | '30d';

/** Start of the Dhaka calendar day containing `d` (as a UTC instant). */
function dhakaDayStart(d: Date): Date {
  const dhaka = new Date(d.getTime() + 6 * 60 * 60 * 1000);
  const midnightUtc = Date.UTC(
    dhaka.getUTCFullYear(),
    dhaka.getUTCMonth(),
    dhaka.getUTCDate(),
  );
  return new Date(midnightUtc - 6 * 60 * 60 * 1000);
}

function rangeWindow(range: RangeKey): { start: Date; end: Date } {
  const now = new Date();
  if (range === 'today') return { start: dhakaDayStart(now), end: now };
  if (range === 'yesterday') {
    const todayStart = dhakaDayStart(now);
    return { start: new Date(todayStart.getTime() - 24 * 60 * 60 * 1000), end: todayStart };
  }
  const days = range === '30d' ? 30 : 7;
  return { start: new Date(now.getTime() - days * 24 * 60 * 60 * 1000), end: now };
}

/** GET /api/analytics/overview?range=today|yesterday|7d|30d */
analyticsRouter.get('/analytics/overview', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const rawRange = typeof req.query.range === 'string' ? req.query.range : '7d';
  const range: RangeKey =
    rawRange === 'today' || rawRange === 'yesterday' || rawRange === '7d' || rawRange === '30d'
      ? rawRange
      : '7d';
  const { start, end } = rangeWindow(range);
  const startIso = start.toISOString();
  const endIso = end.toISOString();

  const conversationsRow = await queryOne<{ c: string }>(
    workspaceId,
    `SELECT COUNT(*) AS c FROM conversations
     WHERE workspace_id = $1 AND created_at >= $2 AND created_at < $3`,
    [workspaceId, startIso, endIso],
  );
  const ordersRow = await queryOne<{ c: string }>(
    workspaceId,
    `SELECT COUNT(*) AS c FROM orders
     WHERE workspace_id = $1 AND created_at >= $2 AND created_at < $3`,
    [workspaceId, startIso, endIso],
  );
  const aiHandledRow = await queryOne<{ c: string }>(
    workspaceId,
    `SELECT COUNT(*) AS c FROM conversations co
     WHERE co.workspace_id = $1 AND co.created_at >= $2 AND co.created_at < $3
       AND co.mode = 'ai'
       AND NOT EXISTS (
         SELECT 1 FROM tickets t
         WHERE t.workspace_id = $1 AND t.conversation_id = co.id
       )`,
    [workspaceId, startIso, endIso],
  );
  const humanModeRow = await queryOne<{ c: string }>(
    workspaceId,
    `SELECT COUNT(*) AS c FROM conversations
     WHERE workspace_id = $1 AND mode = 'human'
       AND updated_at >= $2 AND updated_at < $3`,
    [workspaceId, startIso, endIso],
  );
  const ticketsRow = await queryOne<{ c: string }>(
    workspaceId,
    `SELECT COUNT(*) AS c FROM tickets
     WHERE workspace_id = $1 AND created_at >= $2 AND created_at < $3`,
    [workspaceId, startIso, endIso],
  );
  const avgCostRow = await queryOne<{ avg: string | null }>(
    workspaceId,
    `SELECT AVG(cost_paisa) AS avg FROM ai_usage_ledger
     WHERE workspace_id = $1 AND created_at >= $2 AND created_at < $3`,
    [workspaceId, startIso, endIso],
  );
  const { rows: sourceRows } = await query<{ source: string | null; c: string }>(
    workspaceId,
    `SELECT source, COUNT(*) AS c FROM orders
     WHERE workspace_id = $1 AND created_at >= $2 AND created_at < $3
     GROUP BY source`,
    [workspaceId, startIso, endIso],
  );

  const conversations = Number(conversationsRow?.c ?? 0);
  const orders = Number(ordersRow?.c ?? 0);
  const aiHandled = Number(aiHandledRow?.c ?? 0);
  const aiHandledPct =
    conversations === 0 ? 0 : Math.round((aiHandled / conversations) * 100);
  const humanHandoverCount =
    Number(humanModeRow?.c ?? 0) + Number(ticketsRow?.c ?? 0);
  const avgCostPaisa = Math.round(Number(avgCostRow?.avg ?? 0) * 100) / 100;

  const orderSource: { ai: number; product_page: number; team: number; website: number; other: number } = {
    ai: 0,
    product_page: 0,
    team: 0,
    website: 0,
    other: 0,
  };
  for (const row of sourceRows) {
    const n = Number(row.c);
    if (row.source === 'ai') orderSource.ai += n;
    else if (row.source === 'product_page') orderSource.product_page += n;
    else if (row.source === 'team') orderSource.team += n;
    else if (row.source === 'website') orderSource.website += n;
    else orderSource.other += n;
  }

  res.json({
    range,
    conversations,
    orders,
    aiHandledPct,
    humanHandoverCount,
    avgCostPaisa,
    orderSource,
  });
});
