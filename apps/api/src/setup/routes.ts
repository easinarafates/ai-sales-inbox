import { Router, type Response } from 'express';
import { query, queryOne } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';

/**
 * Setup wizard — 7 steps, computed from REAL workspace state (Task 15,
 * fake-completion fix, 2026-11-11).
 *
 * THE BUG: POST /api/setup/complete-step used to append ANY step to
 * setup_progress.completed_steps on a bare click, with no check at all —
 * the Setup page had a "Complete step" button per step, so clicking
 * Courier / Invite Your Team / Go Live marked them Done even though the
 * owner never did the task. GET /api/setup/progress then just read that
 * stored flag back, and the Sidebar moved Setup into Settings once all
 * seven flags were set.
 *
 * THE FIX: completion is now COMPUTED from real state on every read —
 * the stored completed_steps array is never trusted. Each step:
 * - facebook:      a channels row, platform messenger/facebook_comment,
 *                  status='connected' (a real connected Facebook Page).
 * - business:      the workspace has a real business name AND a business
 *                  district (workspaces.name + workspaces.business_district).
 *                  Name alone cannot count: signup always sets a name, so
 *                  a fresh workspace would wrongly show this done.
 *                  The district is set on the Courier/delivery-charges
 *                  settings (PUT /api/delivery-charges {businessDistrict}).
 * - products:      >= 1 row in products for the workspace.
 * - notifications: the signed-in user has a phone saved (users.phone,
 *                  migration 40; set on the Profile page).
 * - courier:       a courier_credentials row with verified_at NOT NULL —
 *                  keys saved AND passed the read-only verify check
 *                  (POST /api/courier/credentials/:provider/verify).
 *                  Keys saved but never verified do NOT count.
 * - team:          >= 1 row in team_invites (an invite was created — the
 *                  link is the invite) OR a second member joined
 *                  (members row for someone other than the requester;
 *                  the owner row created at signup does not count).
 * - go-live:       the 5-digit test code was actually verified
 *                  (setup_progress.test_code_verified).
 *
 * Clicking a step in the UI now only NAVIGATES to where the task is
 * really done (Channels / Profile / Products / Courier / Team) — it
 * never marks anything done. POST /api/setup/complete-step now exists
 * ONLY to issue the go-live test code, and only when the other six
 * steps are really done; every other step is rejected with 400 and the
 * current real progress. The stored completed_steps array is
 * self-healing: on each read it is overwritten with the real set, so
 * any flags faked by the old click behaviour are cleared from the DB.
 *
 * Response shape is unchanged (steps/completedCount/totalSteps/
 * testCodeVerified/testCode/goLive) so the Sidebar — which moves Setup
 * into Settings only when completedCount >= totalSteps — follows the
 * real state with no change on its side.
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

type SetupStep = (typeof SETUP_STEPS)[number];

type SetupRow = {
  workspace_id: string;
  completed_steps: string[];
  test_code: string | null;
  test_code_verified: boolean;
  updated_at: string;
};

type RealState = Record<SetupStep, boolean>;

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

/** Compute every step from real workspace state — never from stored flags. */
async function computeRealState(
  workspaceId: string,
  userId: string | undefined,
  row: SetupRow,
): Promise<RealState> {
  const { rows } = await query<{ step: SetupStep; done: boolean }>(
    workspaceId,
    `SELECT 'facebook' AS step, EXISTS(
       SELECT 1 FROM channels
       WHERE workspace_id = $1 AND platform IN ('messenger', 'facebook_comment')
         AND status = 'connected'
     ) AS done
     UNION ALL
     SELECT 'business' AS step, EXISTS(
       SELECT 1 FROM workspaces
       WHERE id = $1 AND NULLIF(BTRIM(name), '') IS NOT NULL
         AND NULLIF(BTRIM(business_district), '') IS NOT NULL
     ) AS done
     UNION ALL
     SELECT 'products' AS step, EXISTS(
       SELECT 1 FROM products WHERE workspace_id = $1
     ) AS done
     UNION ALL
     SELECT 'notifications' AS step, CASE WHEN $2::uuid IS NULL THEN FALSE ELSE EXISTS(
       SELECT 1 FROM users WHERE id = $2::uuid AND NULLIF(BTRIM(phone), '') IS NOT NULL
     ) END AS done
     UNION ALL
     SELECT 'courier' AS step, EXISTS(
       SELECT 1 FROM courier_credentials
       WHERE workspace_id = $1 AND verified_at IS NOT NULL
     ) AS done
     UNION ALL
     SELECT 'team' AS step, (
       EXISTS(SELECT 1 FROM team_invites WHERE workspace_id = $1)
       OR EXISTS(SELECT 1 FROM members WHERE workspace_id = $1 AND user_id <> $2::uuid)
     ) AS done`,
    [workspaceId, userId ?? null],
  );
  const state = Object.fromEntries(
    SETUP_STEPS.map((s) => [s, false]),
  ) as RealState;
  for (const r of rows) state[r.step] = r.done === true;
  // go-live is the only step whose record lives in setup_progress itself:
  // the 5-digit test code must actually have been verified.
  state['go-live'] = row.test_code_verified === true;
  return state;
}

/**
 * Self-heal the stored flag array: overwrite it with the real set so
 * flags faked by the old click-to-complete behaviour are cleared from
 * the DB. The read result never depends on this write succeeding.
 */
async function healStoredFlags(workspaceId: string, row: SetupRow, state: RealState): Promise<void> {
  const real = SETUP_STEPS.filter((s) => state[s]);
  const stored = new Set(row.completed_steps ?? []);
  if (real.length === stored.size && real.every((s) => stored.has(s))) return;
  try {
    await query(
      workspaceId,
      'UPDATE setup_progress SET completed_steps = $1, updated_at = now() WHERE workspace_id = $2',
      [real, workspaceId],
    );
  } catch (err) {
    console.error('[setup] failed to heal stored completed_steps:', (err as Error).message);
  }
}

function progressView(state: RealState, row: SetupRow, includeTestCode: boolean) {
  const steps = SETUP_STEPS.map((step) => ({ step, completed: state[step] }));
  return {
    steps,
    completedCount: steps.filter((s) => s.completed).length,
    totalSteps: SETUP_STEPS.length,
    testCodeVerified: row.test_code_verified,
    // The test code is shown to the workspace owner only, right after the
    // go-live step issues it — never to anyone else.
    testCode: includeTestCode ? row.test_code ?? undefined : undefined,
    goLive: state['go-live'],
  };
}

async function realProgress(req: AuthRequest) {
  const workspaceId = getWorkspaceId(req);
  const row = await getOrCreateProgress(workspaceId);
  const state = await computeRealState(workspaceId, req.userId, row);
  await healStoredFlags(workspaceId, row, state);
  return { workspaceId, row, state };
}

/** GET /api/setup/progress — real computed state, never stored flags. */
setupRouter.get('/setup/progress', async (req: AuthRequest, res: Response) => {
  const { row, state } = await realProgress(req);
  res.json({ progress: progressView(state, row, false) });
});

/**
 * POST /api/setup/complete-step {step}
 *
 * The old behaviour — marking ANY step done on a bare click — is gone.
 * The ONLY step this endpoint still serves is 'go-live': it issues the
 * random 5-digit test code, and only when the other six steps are
 * REALLY done (computed from state, not flags). Every other step is
 * rejected: those complete automatically when the underlying task is
 * really done (connect a Page, add a product, save a phone, ...).
 * The go-live step itself completes only after verify-test succeeds.
 */
setupRouter.post('/setup/complete-step', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { step } = (req.body ?? {}) as { step?: string };
  if (!step || !(SETUP_STEPS as readonly string[]).includes(step)) {
    res.status(400).json({ error: `step must be one of: ${SETUP_STEPS.join(', ')}` });
    return;
  }
  const { row, state } = await realProgress(req);
  if (step !== 'go-live') {
    res.status(400).json({
      error:
        'Setup steps complete automatically when the task is really done — clicking never marks a step done. Go to the linked page and do the task.',
      progress: progressView(state, row, false),
    });
    return;
  }
  const missing = SETUP_STEPS.filter((s) => s !== 'go-live' && !state[s]);
  if (missing.length > 0) {
    res.status(400).json({
      error: 'Complete the other steps first',
      missingSteps: missing,
      progress: progressView(state, row, false),
    });
    return;
  }
  if (state['go-live'] && row.test_code_verified) {
    res.json({ progress: progressView(state, row, false), message: 'Go-live is already complete.' });
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
  const fresh = await computeRealState(workspaceId, req.userId, rows[0]);
  res.json({
    progress: progressView(fresh, rows[0], true),
    testCode,
    message: 'Test code issued — enter this 5-digit code to verify and go live.',
  });
});

/**
 * POST /api/setup/verify-test {code} — wrong code is rejected (400,
 * verified:false); the right code marks the test verified AND completes
 * the go-live step. Also re-checks the other six steps are still really
 * done, so a code issued earlier cannot go live after the shop regressed.
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
  const state = await computeRealState(workspaceId, req.userId, row);
  const missing = SETUP_STEPS.filter((s) => s !== 'go-live' && !state[s]);
  if (missing.length > 0) {
    res.status(400).json({
      verified: false,
      error: 'Complete the other steps first',
      missingSteps: missing,
    });
    return;
  }
  const { rows } = await query<SetupRow>(
    workspaceId,
    `UPDATE setup_progress
     SET test_code_verified = TRUE, updated_at = now()
     WHERE workspace_id = $1
     RETURNING workspace_id, completed_steps, test_code, test_code_verified, updated_at`,
    [workspaceId],
  );
  const fresh = await computeRealState(workspaceId, req.userId, rows[0]);
  await healStoredFlags(workspaceId, rows[0], fresh);
  res.json({ verified: true, progress: progressView(fresh, rows[0], false) });
});
