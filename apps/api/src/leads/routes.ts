import { Router, type Response } from 'express';
import { query } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';

export const leadsRouter = Router();
leadsRouter.use(requireAuth);

const LEAD_COLUMNS = 'id, customer_id, need, follow_up_at, call_at, outcome, warmth, created_at, updated_at';

function isValidDate(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Date.parse(value));
}

function isWarmth(value: unknown): value is 'hot' | 'warm' {
  return value === 'hot' || value === 'warm';
}

/** GET /api/leads?warmth=hot|warm */
leadsRouter.get('/leads', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const warmth = typeof req.query.warmth === 'string' ? req.query.warmth : null;
  if (warmth && !isWarmth(warmth)) {
    res.status(400).json({ error: 'warmth must be hot or warm' });
    return;
  }
  const { rows } = await query(
    workspaceId,
    `SELECT ${LEAD_COLUMNS} FROM leads WHERE workspace_id = $1
       AND ($2::text IS NULL OR warmth = $2)
     ORDER BY created_at DESC LIMIT 200`,
    [workspaceId, warmth],
  );
  res.json({ leads: rows });
});

/** POST /api/leads {customerId, need?, followUpAt?, callAt?, warmth?} */
leadsRouter.post('/leads', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { customerId, need, followUpAt, callAt, warmth } = (req.body ?? {}) as {
    customerId?: string;
    need?: string;
    followUpAt?: string;
    callAt?: string;
    warmth?: string;
  };
  if (!customerId) {
    res.status(400).json({ error: 'customerId is required' });
    return;
  }
  if (warmth !== undefined && !isWarmth(warmth)) {
    res.status(400).json({ error: 'warmth must be hot or warm' });
    return;
  }
  if (followUpAt !== undefined && followUpAt !== null && !isValidDate(followUpAt)) {
    res.status(400).json({ error: 'followUpAt সঠিক তারিখ নয়' });
    return;
  }
  if (callAt !== undefined && callAt !== null && !isValidDate(callAt)) {
    res.status(400).json({ error: 'callAt সঠিক তারিখ নয়' });
    return;
  }
  const customer = await query(
    workspaceId,
    'SELECT id FROM customers WHERE workspace_id = $1 AND id = $2',
    [workspaceId, customerId],
  );
  if (customer.rowCount === 0) {
    res.status(400).json({ error: 'Customer not found' });
    return;
  }
  const { rows } = await query(
    workspaceId,
    `INSERT INTO leads (workspace_id, customer_id, need, follow_up_at, call_at, warmth)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${LEAD_COLUMNS}`,
    [workspaceId, customerId, need?.trim() || null, followUpAt ?? null, callAt ?? null, warmth ?? 'warm'],
  );
  res.status(201).json({ lead: rows[0] });
});

/** PATCH /api/leads/:id {need?, followUpAt?, callAt?, outcome?, warmth?} */
leadsRouter.patch('/leads/:id', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { need, followUpAt, callAt, outcome, warmth } = (req.body ?? {}) as {
    need?: string;
    followUpAt?: string | null;
    callAt?: string | null;
    outcome?: string;
    warmth?: string;
  };
  if (warmth !== undefined && !isWarmth(warmth)) {
    res.status(400).json({ error: 'warmth must be hot or warm' });
    return;
  }
  if (followUpAt !== undefined && followUpAt !== null && !isValidDate(followUpAt)) {
    res.status(400).json({ error: 'followUpAt সঠিক তারিখ নয়' });
    return;
  }
  if (callAt !== undefined && callAt !== null && !isValidDate(callAt)) {
    res.status(400).json({ error: 'callAt সঠিক তারিখ নয়' });
    return;
  }
  const sets: string[] = [];
  const params: unknown[] = [workspaceId];
  const add = (clause: string, value: unknown): void => {
    params.push(value);
    sets.push(`${clause} = $${params.length}`);
  };
  if (need !== undefined) add('need', need?.trim() || null);
  if (followUpAt !== undefined) add('follow_up_at', followUpAt ?? null);
  if (callAt !== undefined) add('call_at', callAt ?? null);
  if (outcome !== undefined) add('outcome', outcome?.trim() || null);
  if (warmth !== undefined) add('warmth', warmth);
  if (sets.length === 0) {
    const existing = await query(
      workspaceId,
      `SELECT ${LEAD_COLUMNS} FROM leads WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, req.params.id],
    );
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }
    res.json({ lead: existing.rows[0] });
    return;
  }
  params.push(req.params.id);
  const { rows } = await query(
    workspaceId,
    `UPDATE leads SET ${sets.join(', ')}, updated_at = now()
     WHERE workspace_id = $1 AND id = $${params.length} RETURNING ${LEAD_COLUMNS}`,
    params,
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Lead not found' });
    return;
  }
  res.json({ lead: rows[0] });
});
