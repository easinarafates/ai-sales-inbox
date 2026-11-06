import { Router, type Response } from 'express';
import { query } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';
import { callGroq } from '../ai-agent/groq';

export const knowledgeRouter = Router();
knowledgeRouter.use(requireAuth);

/** GET /api/knowledge — the AI knowledge book. */
knowledgeRouter.get('/knowledge', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rows } = await query(
    workspaceId,
    'SELECT id, title, body, created_at FROM knowledge_items WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 200',
    [workspaceId],
  );
  res.json({ knowledgeItems: rows });
});

knowledgeRouter.post('/knowledge', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { title, body } = (req.body ?? {}) as { title?: string; body?: string };
  if (!body || !body.trim()) {
    res.status(400).json({ error: 'body is required' });
    return;
  }
  const { rows } = await query(
    workspaceId,
    'INSERT INTO knowledge_items (workspace_id, title, body) VALUES ($1, $2, $3) RETURNING id, title, body, created_at',
    [workspaceId, title ?? null, body.trim()],
  );
  res.status(201).json({ knowledgeItem: rows[0] });
});

knowledgeRouter.patch('/knowledge/:id', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { title, body } = (req.body ?? {}) as { title?: string; body?: string };
  const { rows } = await query(
    workspaceId,
    `UPDATE knowledge_items SET title = COALESCE($1, title), body = COALESCE($2, body), updated_at = now()
     WHERE workspace_id = $3 AND id = $4 RETURNING id, title, body, created_at`,
    [title ?? null, body ?? null, workspaceId, req.params.id],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Knowledge item not found' });
    return;
  }
  res.json({ knowledgeItem: rows[0] });
});

knowledgeRouter.delete('/knowledge/:id', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rowCount } = await query(
    workspaceId,
    'DELETE FROM knowledge_items WHERE workspace_id = $1 AND id = $2',
    [workspaceId, req.params.id],
  );
  if (rowCount === 0) {
    res.status(404).json({ error: 'Knowledge item not found' });
    return;
  }
  res.json({ deleted: true });
});

/** GET /api/unanswered — questions the AI could not answer (for the owner to fill in). */
knowledgeRouter.get('/unanswered', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rows } = await query(
    workspaceId,
    'SELECT id, question, count, taught, created_at, updated_at FROM unanswered_questions WHERE workspace_id = $1 ORDER BY count DESC, updated_at DESC LIMIT 200',
    [workspaceId],
  );
  res.json({ unanswered: rows });
});

/**
 * AI teaching tools (Module B, Phase 2 — PDF section 4, "AI-কে শেখানো").
 * Plain-language change -> AI preview -> owner approves -> saved, with the
 * previous body kept in knowledge_versions so one click rolls back.
 * Preview NEVER saves anything; apply saves the old body as a version first.
 */

/** Extract the reply text from a callGroq result (JSON {"reply": ...} or plain text). */
function groqReplyText(result: { text: string } | null): string | null {
  if (!result) return null;
  const text = result.text.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as { reply?: string };
    if (parsed.reply) return parsed.reply.trim();
  } catch {
    // Plain-text reply — use it as-is.
  }
  return text;
}

/** POST /api/unanswered/:id/teach {answer} — teach the AI an answer it lacked. */
knowledgeRouter.post('/unanswered/:id/teach', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { answer } = (req.body ?? {}) as { answer?: string };
  if (!answer || !answer.trim()) {
    res.status(400).json({ error: 'answer is required' });
    return;
  }
  const { rows: unanswered } = await query<{ id: string; question: string }>(
    workspaceId,
    'SELECT id, question FROM unanswered_questions WHERE workspace_id = $1 AND id = $2',
    [workspaceId, req.params.id],
  );
  if (unanswered.length === 0) {
    res.status(404).json({ error: 'Unanswered question not found' });
    return;
  }
  const { rows } = await query(
    workspaceId,
    `INSERT INTO knowledge_items (workspace_id, title, body)
     VALUES ($1, $2, $3) RETURNING id, title, body, created_at`,
    [workspaceId, unanswered[0].question, answer.trim()],
  );
  await query(
    workspaceId,
    'UPDATE unanswered_questions SET taught = TRUE, updated_at = now() WHERE workspace_id = $1 AND id = $2',
    [workspaceId, req.params.id],
  );
  res.status(201).json({ knowledgeItem: rows[0] });
});

/**
 * POST /api/knowledge/preview-change {knowledgeId?, instruction}
 * Rewrites the knowledge body per the plain-language instruction and returns
 * {preview} WITHOUT saving anything. Without a knowledgeId, drafts a new
 * knowledge text from the instruction alone. Without an AI key, returns the
 * current body (or the instruction) as the preview and says so.
 */
knowledgeRouter.post('/knowledge/preview-change', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { knowledgeId, instruction } = (req.body ?? {}) as {
    knowledgeId?: string;
    instruction?: string;
  };
  if (!instruction || !instruction.trim()) {
    res.status(400).json({ error: 'instruction is required' });
    return;
  }
  let currentBody: string | null = null;
  if (knowledgeId) {
    const { rows } = await query<{ body: string }>(
      workspaceId,
      'SELECT body FROM knowledge_items WHERE workspace_id = $1 AND id = $2',
      [workspaceId, knowledgeId],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Knowledge item not found' });
      return;
    }
    currentBody = rows[0].body;
  }
  const prompt = currentBody
    ? `নিচের ব্যবসার তথ্যটি এই নির্দেশ অনুযায়ী বদলে নতুন সংস্করণ লেখো। বাংলায় লেখো, দাম/স্টক/ছাড় বানিয়ে লিখো না — যা জানা নেই, তা বদলিয়ো না। শুধু নতুন লেখাটি দাও।\n\nনির্দেশ: ${instruction.trim()}\n\nবর্তমান লেখা:\n${currentBody}`
    : `নিচের নির্দেশ অনুযায়ী ব্যবসার নলেজ বুকের জন্য একটি ছোট তথ্য লেখো (বাংলায়)। দাম/স্টক/ছাড় বানিয়ে লিখো না।\n\nনির্দেশ: ${instruction.trim()}`;
  try {
    const preview = groqReplyText(await callGroq(prompt));
    if (preview) {
      res.json({ preview, aiGenerated: true });
      return;
    }
  } catch (err) {
    console.error('[knowledge] preview-change AI failed:', (err as Error).message);
  }
  res.json({
    preview: currentBody ?? instruction.trim(),
    aiGenerated: false,
    note: 'AI চাবি বসানো নেই বা AI উত্তর দিচ্ছে না, তাই কিছু বদলানো হয়নি — এটা শুধু বর্তমান লেখা।',
  });
});

/**
 * POST /api/knowledge/apply-change {knowledgeId, newBody}
 * Saves the previous body into knowledge_versions, then updates.
 */
knowledgeRouter.post('/knowledge/apply-change', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { knowledgeId, newBody } = (req.body ?? {}) as {
    knowledgeId?: string;
    newBody?: string;
  };
  if (!knowledgeId || !newBody || !newBody.trim()) {
    res.status(400).json({ error: 'knowledgeId and newBody are required' });
    return;
  }
  const { rows: current } = await query<{ id: string; title: string | null; body: string }>(
    workspaceId,
    'SELECT id, title, body FROM knowledge_items WHERE workspace_id = $1 AND id = $2',
    [workspaceId, knowledgeId],
  );
  if (current.length === 0) {
    res.status(404).json({ error: 'Knowledge item not found' });
    return;
  }
  const { rows: versions } = await query<{ id: string }>(
    workspaceId,
    `INSERT INTO knowledge_versions (workspace_id, knowledge_id, body)
     VALUES ($1, $2, $3) RETURNING id`,
    [workspaceId, knowledgeId, current[0].body],
  );
  const { rows } = await query(
    workspaceId,
    `UPDATE knowledge_items SET body = $1, updated_at = now()
     WHERE workspace_id = $2 AND id = $3 RETURNING id, title, body, created_at`,
    [newBody.trim(), workspaceId, knowledgeId],
  );
  res.json({ knowledgeItem: rows[0], versionId: versions[0].id });
});

/**
 * POST /api/knowledge/:id/rollback {versionId}
 * Restores the body from a knowledge_versions row. The current body is
 * saved as a new version first, so a rollback can itself be rolled back.
 */
knowledgeRouter.post('/knowledge/:id/rollback', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { versionId } = (req.body ?? {}) as { versionId?: string };
  if (!versionId) {
    res.status(400).json({ error: 'versionId is required' });
    return;
  }
  const { rows: versions } = await query<{ id: string; body: string }>(
    workspaceId,
    `SELECT id, body FROM knowledge_versions
     WHERE workspace_id = $1 AND id = $2 AND knowledge_id = $3`,
    [workspaceId, versionId, req.params.id],
  );
  if (versions.length === 0) {
    res.status(404).json({ error: 'Knowledge version not found' });
    return;
  }
  const { rows: current } = await query<{ body: string }>(
    workspaceId,
    'SELECT body FROM knowledge_items WHERE workspace_id = $1 AND id = $2',
    [workspaceId, req.params.id],
  );
  if (current.length === 0) {
    res.status(404).json({ error: 'Knowledge item not found' });
    return;
  }
  await query(
    workspaceId,
    `INSERT INTO knowledge_versions (workspace_id, knowledge_id, body)
     VALUES ($1, $2, $3)`,
    [workspaceId, req.params.id, current[0].body],
  );
  const { rows } = await query(
    workspaceId,
    `UPDATE knowledge_items SET body = $1, updated_at = now()
     WHERE workspace_id = $2 AND id = $3 RETURNING id, title, body, created_at`,
    [versions[0].body, workspaceId, req.params.id],
  );
  res.json({ knowledgeItem: rows[0] });
});
