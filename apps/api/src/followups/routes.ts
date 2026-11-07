import { Router, type Response } from 'express';
import { query, queryOne } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';
import { processDueFollowups, sendFollowup } from './engine';

export const followupsRouter = Router();
followupsRouter.use(requireAuth);

const FOLLOWUP_COLUMNS = 'f.id, f.lead_id, f.message, f.send_at, f.status, f.warmth, f.created_at, f.updated_at';

function isValidDate(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Date.parse(value));
}

function isWarmth(value: unknown): value is 'hot' | 'warm' {
  return value === 'hot' || value === 'warm';
}

async function loadFollowup(workspaceId: string, followupId: string) {
  return queryOne(
    workspaceId,
    `SELECT ${FOLLOWUP_COLUMNS}, l.customer_id FROM followups f
     LEFT JOIN leads l ON l.id = f.lead_id
     WHERE f.workspace_id = $1 AND f.id = $2`,
    [workspaceId, followupId],
  );
}

/**
 * Resolve a lead for a customer: latest lead wins. If the customer has no
 * lead yet, create one — the followups table reaches the customer only
 * through leads (see engine.ts header).
 */
async function resolveLeadId(workspaceId: string, customerId: string): Promise<string> {
  const existing = await queryOne<{ id: string }>(
    workspaceId,
    `SELECT id FROM leads WHERE workspace_id = $1 AND customer_id = $2
     ORDER BY created_at DESC LIMIT 1`,
    [workspaceId, customerId],
  );
  if (existing) return existing.id;
  const { rows } = await query<{ id: string }>(
    workspaceId,
    'INSERT INTO leads (workspace_id, customer_id) VALUES ($1, $2) RETURNING id',
    [workspaceId, customerId],
  );
  return rows[0].id;
}

/** GET /api/followups?status=&warmth=hot|warm — hot leads sort first. */
followupsRouter.get('/followups', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const warmth = typeof req.query.warmth === 'string' ? req.query.warmth : null;
  if (warmth && !isWarmth(warmth)) {
    res.status(400).json({ error: 'warmth must be hot or warm' });
    return;
  }
  const { rows } = await query(
    workspaceId,
    `SELECT ${FOLLOWUP_COLUMNS}, l.customer_id, l.warmth AS lead_warmth FROM followups f
     LEFT JOIN leads l ON l.id = f.lead_id
     WHERE f.workspace_id = $1 AND ($2::text IS NULL OR f.status = $2)
       AND ($3::text IS NULL OR f.warmth = $3)
     ORDER BY CASE WHEN f.warmth = 'hot' THEN 0 ELSE 1 END,
       f.send_at ASC NULLS LAST, f.created_at DESC LIMIT 200`,
    [workspaceId, status, warmth],
  );
  res.json({ followups: rows });
});

/** POST /api/followups {leadId?, customerId?, message, sendAt, warmth?} */
followupsRouter.post('/followups', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { leadId, customerId, message, sendAt, warmth } = (req.body ?? {}) as {
    leadId?: string;
    customerId?: string;
    message?: string;
    sendAt?: string;
    warmth?: string;
  };
  if (!message || !message.trim()) {
    res.status(400).json({ error: 'message is required' });
    return;
  }
  if (!isValidDate(sendAt)) {
    res.status(400).json({ error: 'sendAt সঠিক তারিখ নয়' });
    return;
  }
  if (warmth !== undefined && !isWarmth(warmth)) {
    res.status(400).json({ error: 'warmth must be hot or warm' });
    return;
  }
  if (!leadId && !customerId) {
    res.status(400).json({ error: 'leadId বা customerId — অন্তত একটি লাগবে' });
    return;
  }
  let resolvedLeadId: string | null = null;
  let resolvedCustomerId: string | null = null;
  if (leadId) {
    const lead = await queryOne<{ id: string; customer_id: string | null }>(
      workspaceId,
      'SELECT id, customer_id FROM leads WHERE workspace_id = $1 AND id = $2',
      [workspaceId, leadId],
    );
    if (!lead) {
      res.status(400).json({ error: 'Lead not found' });
      return;
    }
    resolvedLeadId = lead.id;
    resolvedCustomerId = lead.customer_id;
    if (customerId && customerId !== lead.customer_id) {
      res.status(400).json({ error: 'leadId ও customerId মিলছে না' });
      return;
    }
  } else if (customerId) {
    const customer = await query(
      workspaceId,
      'SELECT id FROM customers WHERE workspace_id = $1 AND id = $2',
      [workspaceId, customerId],
    );
    if (customer.rowCount === 0) {
      res.status(400).json({ error: 'Customer not found' });
      return;
    }
    resolvedCustomerId = customerId;
    resolvedLeadId = await resolveLeadId(workspaceId, customerId);
  }
  const { rows } = await query(
    workspaceId,
    `INSERT INTO followups (workspace_id, lead_id, message, send_at, status, warmth)
     VALUES ($1, $2, $3, $4, 'scheduled', $5) RETURNING id, lead_id, message, send_at, status, warmth, created_at, updated_at`,
    [workspaceId, resolvedLeadId, message.trim(), sendAt, warmth ?? 'warm'],
  );
  res.status(201).json({ followup: { ...rows[0], customer_id: resolvedCustomerId } });
});

/** PATCH /api/followups/:id {message?, sendAt?, status?, warmth?} */
followupsRouter.patch('/followups/:id', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { message, sendAt, status, warmth } = (req.body ?? {}) as {
    message?: string;
    sendAt?: string | null;
    status?: string;
    warmth?: string;
  };
  if (sendAt !== undefined && sendAt !== null && !isValidDate(sendAt)) {
    res.status(400).json({ error: 'sendAt সঠিক তারিখ নয়' });
    return;
  }
  if (warmth !== undefined && !isWarmth(warmth)) {
    res.status(400).json({ error: 'warmth must be hot or warm' });
    return;
  }
  if (
    status !== undefined &&
    !['scheduled', 'sent', 'logged', 'stopped', 'cancelled', 'failed'].includes(status)
  ) {
    res.status(400).json({ error: 'status সঠিক নয়' });
    return;
  }
  const sets: string[] = [];
  const params: unknown[] = [workspaceId];
  const add = (clause: string, value: unknown): void => {
    params.push(value);
    sets.push(`${clause} = $${params.length}`);
  };
  if (message !== undefined) add('message', message?.trim() || null);
  if (sendAt !== undefined) add('send_at', sendAt ?? null);
  if (status !== undefined) add('status', status);
  if (warmth !== undefined) add('warmth', warmth);
  if (sets.length === 0) {
    const existing = await loadFollowup(workspaceId, req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Follow-up not found' });
      return;
    }
    res.json({ followup: existing });
    return;
  }
  params.push(req.params.id);
  const { rows } = await query(
    workspaceId,
    `UPDATE followups SET ${sets.join(', ')}, updated_at = now()
     WHERE workspace_id = $1 AND id = $${params.length}
     RETURNING id, lead_id, message, send_at, status, warmth, created_at, updated_at`,
    params,
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Follow-up not found' });
    return;
  }
  res.json({ followup: rows[0] });
});

/** POST /api/followups/:id/send-now — send immediately (smart stop rules still apply). */
followupsRouter.post('/followups/:id/send-now', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const existing = await loadFollowup(workspaceId, req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'Follow-up not found' });
    return;
  }
  if (existing.status === 'sent') {
    res.status(400).json({ error: 'এই ফলো-আপটি ইতিমধ্যে পাঠানো হয়েছে' });
    return;
  }
  if (existing.status === 'logged') {
    res.status(400).json({ error: 'এই ফলো-আপটি ইতিমধ্যে লগ করা হয়েছে — আসল পাঠানো এখনো চালু হয়নি' });
    return;
  }
  const result = await sendFollowup(workspaceId, req.params.id);
  if (!result.followup) {
    res.status(404).json({ error: 'Follow-up not found' });
    return;
  }
  res.json({ followup: result.followup, stopped: result.stopped, reason: result.reason ?? null });
});

/** POST /api/followups/run — manual trigger: process every due follow-up now. */
followupsRouter.post('/followups/run', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const result = await processDueFollowups(workspaceId);
  res.json(result);
});
