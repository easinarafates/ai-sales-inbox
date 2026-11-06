import { Router, type Response } from 'express';
import { query, queryOne } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';
import { callAiForWorkspace } from '../ai-agent/providers';

/**
 * Agent Desk (Worker B): versioned plain-words instructions for the AI.
 * - Create a draft version, list versions, test a draft against a question
 *   with Groq WITHOUT publishing, publish a version, revert to the
 *   previously published version.
 * Only one version is 'published' at a time; the previously published one
 * keeps its published_at timestamp so revert() can find it.
 */
export const agentDeskRouter = Router();
agentDeskRouter.use(requireAuth);

const COLUMNS = 'id, version, body, status, published_at, created_at, updated_at';

async function activeVersion(workspaceId: string) {
  return queryOne(
    workspaceId,
    `SELECT ${COLUMNS} FROM agent_desk_instructions
     WHERE workspace_id = $1 AND status = 'published' ORDER BY version DESC LIMIT 1`,
    [workspaceId],
  );
}

/** GET /api/agent-desk/instructions — versions (latest first) + active version. */
agentDeskRouter.get('/agent-desk/instructions', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rows } = await query(
    workspaceId,
    `SELECT ${COLUMNS} FROM agent_desk_instructions WHERE workspace_id = $1 ORDER BY version DESC LIMIT 100`,
    [workspaceId],
  );
  const active = await activeVersion(workspaceId);
  res.json({ instructions: rows, active: active ?? null });
});

/** POST /api/agent-desk/instructions {body} — create a draft version. */
agentDeskRouter.post('/agent-desk/instructions', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { body } = (req.body ?? {}) as { body?: string };
  if (!body?.trim()) {
    res.status(400).json({ error: 'body is required' });
    return;
  }
  const latest = await queryOne<{ version: number }>(
    workspaceId,
    'SELECT MAX(version) AS version FROM agent_desk_instructions WHERE workspace_id = $1',
    [workspaceId],
  );
  const version = Number(latest?.version ?? 0) + 1;
  const { rows } = await query(
    workspaceId,
    `INSERT INTO agent_desk_instructions (workspace_id, version, body, status)
     VALUES ($1, $2, $3, 'draft') RETURNING ${COLUMNS}`,
    [workspaceId, version, body.trim()],
  );
  res.status(201).json({ instruction: rows[0] });
});

/**
 * POST /api/agent-desk/test {question} — run the workspace's CHOSEN AI
 * provider (Groq / OpenAI / Gemini / Claude, with Groq fallback) with the
 * DRAFT instructions (or the active version when there is no draft) and
 * return the answer WITHOUT publishing anything. No version status
 * changes. The response names the provider that actually answered.
 */
agentDeskRouter.post('/agent-desk/test', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { question } = (req.body ?? {}) as { question?: string };
  if (!question?.trim()) {
    res.status(400).json({ error: 'question is required' });
    return;
  }
  const draft = await queryOne(
    workspaceId,
    `SELECT ${COLUMNS} FROM agent_desk_instructions
     WHERE workspace_id = $1 AND status = 'draft' ORDER BY version DESC LIMIT 1`,
    [workspaceId],
  );
  const target = draft ?? (await activeVersion(workspaceId));
  if (!target) {
    res.status(400).json({ error: 'No instructions yet — write a draft first' });
    return;
  }
  let answer: string | null = null;
  let provider: string | null = null;
  let model: string | null = null;
  let fallbackFrom: string | null = null;
  try {
    const result = await callAiForWorkspace(
      workspaceId,
      `You are the shop's AI sales assistant. Follow these shop instructions exactly:\n${target.body}\n\n` +
        `Customer question: ${question.trim()}\n` +
        `Answer in Bengali, in one short reply. If the instructions do not cover the question, say so honestly instead of inventing an answer.`,
    );
    if (result) {
      answer = result.text.trim();
      provider = result.provider;
      model = result.model;
      fallbackFrom = result.fallbackFrom ?? null;
      try {
        const parsed = JSON.parse(answer) as { reply?: string };
        if (parsed.reply) answer = parsed.reply.trim();
      } catch {
        // Plain-text reply — use as-is.
      }
    }
  } catch (err) {
    console.error('[agent-desk] AI test failed:', (err as Error).message);
  }
  res.json({
    answer,
    aiAvailable: answer !== null,
    provider,
    model,
    fallbackFrom,
    versionId: target.id,
    version: target.version,
    status: target.status,
    published: false,
    note:
      answer === null
        ? 'AI is not available right now (no provider key or all providers failed) — nothing was published.'
        : fallbackFrom
          ? `Answered by Groq instead of ${fallbackFrom} (chosen provider failed) — nothing was published.`
          : undefined,
  });
});

/** POST /api/agent-desk/publish {versionId} — activate a version. */
agentDeskRouter.post('/agent-desk/publish', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { versionId } = (req.body ?? {}) as { versionId?: string };
  if (!versionId) {
    res.status(400).json({ error: 'versionId is required' });
    return;
  }
  const target = await queryOne(
    workspaceId,
    `SELECT ${COLUMNS} FROM agent_desk_instructions WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, versionId],
  );
  if (!target) {
    res.status(404).json({ error: 'Instruction version not found' });
    return;
  }
  await query(
    workspaceId,
    `UPDATE agent_desk_instructions SET status = 'archived', updated_at = now()
     WHERE workspace_id = $1 AND status = 'published'`,
    [workspaceId],
  );
  const { rows } = await query(
    workspaceId,
    `UPDATE agent_desk_instructions
     SET status = 'published', published_at = now(), updated_at = now()
     WHERE workspace_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
    [workspaceId, versionId],
  );
  res.json({ instruction: rows[0] });
});

/**
 * POST /api/agent-desk/revert — restore the previously published version
 * (the latest archived version that was published before). 400 if there
 * is nothing to revert to.
 */
agentDeskRouter.post('/agent-desk/revert', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const previous = await queryOne(
    workspaceId,
    `SELECT ${COLUMNS} FROM agent_desk_instructions
     WHERE workspace_id = $1 AND status = 'archived' AND published_at IS NOT NULL
     ORDER BY published_at DESC LIMIT 1`,
    [workspaceId],
  );
  if (!previous) {
    res.status(400).json({ error: 'No previously published version to revert to' });
    return;
  }
  await query(
    workspaceId,
    `UPDATE agent_desk_instructions SET status = 'archived', updated_at = now()
     WHERE workspace_id = $1 AND status = 'published'`,
    [workspaceId],
  );
  const { rows } = await query(
    workspaceId,
    `UPDATE agent_desk_instructions
     SET status = 'published', published_at = now(), updated_at = now()
     WHERE workspace_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
    [workspaceId, previous.id],
  );
  res.json({ instruction: rows[0], revertedToVersion: previous.version });
});
