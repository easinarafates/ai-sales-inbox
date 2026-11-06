import { Router, type Response } from 'express';
import { query, queryOne } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';

/**
 * Setup wizard (Worker B): 7 steps — facebook page, business info,
 * products, notifications, courier, team, go live. Per-step completion is
 * stored per workspace. The go-live step issues a random 5-digit test code
 * (stored); verify-test checks it. Completing go-live requires the other
 * six steps first and a verified test code.
 */
export const setupRouter = Router();
setupRouter.use(requireAuth);

export const SETUP_STEPS = [
  'facebook',
  'business',
  'products',
  'notifications',
  'courier',
  'team',
  'go-live',
] as const;

type SetupRow = {
  workspace_id: string;
  completed_steps: string[];
  test_code: string | null;
  test_code_verified: boolean;
  updated_at: string;
};

async function getOrCreateProgress(workspaceId: string): Promise<SetupRow> {
  const existing = await queryOne<SetupRow>(
    workspaceId,
    'SELECT workspace_id, completed_steps, test_code, test_code_verified, updated_at FROM setup_progress WHERE workspace_id = $1',
    [workspaceId],
  );
  if (existing) return existing;
  const { rows } = await query<SetupRow>(
    workspaceId,
    `INSERT INTO setup_progress (workspace_id, completed_steps)
     VALUES ($1, '{}') RETURNING workspace_id, completed_steps, test_code, test_code_verified, updated_at`,
    [workspaceId],
  );
  return rows[0];
}

function progressView(row: SetupRow, includeTestCode: boolean) {
  const completed = new Set(row.completed_steps ?? []);
  return {
    steps: SETUP_STEPS.map((step) => ({ step, completed: completed.has(step) })),
    completedCount: SETUP_STEPS.filter((s) => completed.has(s)).length,
    totalSteps: SETUP_STEPS.length,
    testCodeVerified: row.test_code_verified,
    // The test code is shown to the workspace owner only, right after the
    // go-live step issues it — never to anyone else.
    testCode: includeTestCode ? row.test_code : undefined,
    goLive: completed.has('go-live'),
  };
}

/** GET /api/setup/progress */
setupRouter.get('/setup/progress', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const row = await getOrCreateProgress(workspaceId);
  res.json({ progress: progressView(row, false) });
});

/**
 * POST /api/setup/complete-step {step}
 * For 'go-live': requires the other six steps, then issues a random
 * 5-digit test code (returned once so the owner can enter it) — the step
 * itself completes only after verify-test succeeds.
 */
setupRouter.post('/setup/complete-step', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { step } = (req.body ?? {}) as { step?: string };
  if (!step || !(SETUP_STEPS as readonly string[]).includes(step)) {
    res.status(400).json({ error: `step must be one of: ${SETUP_STEPS.join(', ')}` });
    return;
  }
  const row = await getOrCreateProgress(workspaceId);
  const completed = new Set(row.completed_steps ?? []);
  if (step === 'go-live') {
    const missing = SETUP_STEPS.filter((s) => s !== 'go-live' && !completed.has(s));
    if (missing.length > 0) {
      res.status(400).json({ error: 'Complete the other steps first', missingSteps: missing });
      return;
    }
    if (completed.has('go-live') && row.test_code_verified) {
      res.json({ progress: progressView(row, false), message: 'Go-live is already complete.' });
      return;
    }
    const testCode = String(Math.floor(10000 + Math.random() * 90000));
    const { rows } = await query<SetupRow>(
      workspaceId,
      `UPDATE setup_progress SET test_code = $1, test_code_verified = FALSE, updated_at = now()
       WHERE workspace_id = $2
       RETURNING workspace_id, completed_steps, test_code, test_code_verified, updated_at`,
      [testCode, workspaceId],
    );
    res.json({
      progress: progressView(rows[0], true),
      testCode,
      message: 'Test code issued — enter this 5-digit code to verify and go live.',
    });
    return;
  }
  if (completed.has(step)) {
    res.json({ progress: progressView(row, false) });
    return;
  }
  const { rows } = await query<SetupRow>(
    workspaceId,
    `UPDATE setup_progress
     SET completed_steps = array_append(completed_steps, $1), updated_at = now()
     WHERE workspace_id = $2
     RETURNING workspace_id, completed_steps, test_code, test_code_verified, updated_at`,
    [step, workspaceId],
  );
  res.json({ progress: progressView(rows[0], false) });
});

/**
 * POST /api/setup/verify-test {code} — wrong code is rejected (400,
 * verified:false); the right code marks the test verified AND completes
 * the go-live step.
 */
setupRouter.post('/setup/verify-test', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { code } = (req.body ?? {}) as { code?: string };
  if (!code || typeof code !== 'string') {
    res.status(400).json({ error: 'code is required', verified: false });
    return;
  }
  const row = await getOrCreateProgress(workspaceId);
  if (!row.test_code || row.test_code !== code.trim()) {
    res.status(400).json({ verified: false, error: 'Wrong test code — try again.' });
    return;
  }
  const completed = new Set(row.completed_steps ?? []);
  completed.add('go-live');
  const { rows } = await query<SetupRow>(
    workspaceId,
    `UPDATE setup_progress
     SET test_code_verified = TRUE, completed_steps = $1, updated_at = now()
     WHERE workspace_id = $2
     RETURNING workspace_id, completed_steps, test_code, test_code_verified, updated_at`,
    [Array.from(completed), workspaceId],
  );
  res.json({ verified: true, progress: progressView(rows[0], false) });
});
