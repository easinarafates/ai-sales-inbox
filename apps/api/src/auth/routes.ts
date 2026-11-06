import bcrypt from 'bcryptjs';
import { Router, type Response } from 'express';
import { config } from '../config';
import { pool, queryOne } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth, signToken } from './auth';

export const authRouter = Router();

interface SignupBody {
  name?: string;
  email?: string;
  password?: string;
  workspaceName?: string;
}

/**
 * POST /api/auth/signup — creates workspace + user + owner member and tops up
 * the free credit (FREE_CREDIT_PAISA) in one transaction.
 */
authRouter.post('/signup', async (req: AuthRequest, res: Response) => {
  const { name, email, password, workspaceName } = (req.body ?? {}) as SignupBody;
  if (!email || !password || !workspaceName) {
    res.status(400).json({ error: 'email, password and workspaceName are required' });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: 'password must be at least 8 characters' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rowCount && existing.rowCount > 0) {
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'Email already registered' });
      return;
    }
    const freeCredit = config.freeCreditPaisa;
    const ws = await client.query(
      'INSERT INTO workspaces (name, balance_paisa, ai_enabled, practice_mode) VALUES ($1, $2, TRUE, TRUE) RETURNING id',
      [workspaceName, freeCredit],
    );
    const workspaceId = ws.rows[0].id as string;
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await client.query(
      'INSERT INTO users (workspace_id, email, password_hash, name) VALUES ($1, $2, $3, $4) RETURNING id, email, name',
      [workspaceId, email, passwordHash, name ?? null],
    );
    const userId = user.rows[0].id as string;
    await client.query(
      'INSERT INTO members (workspace_id, user_id, role) VALUES ($1, $2, $3)',
      [workspaceId, userId, 'owner'],
    );
    if (freeCredit > 0) {
      await client.query(
        "INSERT INTO wallet_transactions (workspace_id, type, amount_paisa) VALUES ($1, 'topup', $2)",
        [workspaceId, freeCredit],
      );
    }
    await client.query('COMMIT');
    const token = signToken({ userId, workspaceId });
    res.status(201).json({
      token,
      user: user.rows[0],
      workspace: { id: workspaceId, name: workspaceName, balancePaisa: freeCredit, practiceMode: true },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('[auth/signup]', err);
    res.status(500).json({ error: 'Signup failed' });
  } finally {
    client.release();
  }
});

authRouter.post('/login', async (req: AuthRequest, res: Response) => {
  const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: 'email and password are required' });
    return;
  }
  const { rows } = await pool.query(
    'SELECT id, workspace_id, email, name, password_hash, is_owner FROM users WHERE email = $1',
    [email],
  );
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash as string))) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }
  // Suspended shops cannot log in (set from the Owner Panel).
  const ws = await pool.query(
    'SELECT suspended FROM workspaces WHERE id = $1',
    [user.workspace_id],
  );
  if (ws.rows[0]?.suspended === true) {
    res.status(403).json({ error: 'This shop is suspended — contact the platform owner.' });
    return;
  }
  const token = signToken({
    userId: user.id as string,
    workspaceId: user.workspace_id as string,
    isOwner: user.is_owner === true,
  });
  res.json({
    token,
    user: { id: user.id, email: user.email, name: user.name, isOwner: user.is_owner === true },
    workspaceId: user.workspace_id,
  });
});

authRouter.get('/me', requireAuth, async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const user = await queryOne<{ id: string; email: string; name: string | null }>(
    workspaceId,
    'SELECT id, email, name FROM users WHERE workspace_id = $1 AND id = $2',
    [workspaceId, req.userId],
  );
  const workspace = await queryOne<{
    id: string;
    name: string;
    balance_paisa: number;
    ai_enabled: boolean;
    practice_mode: boolean;
  }>(
    workspaceId,
    'SELECT id, name, balance_paisa, ai_enabled, practice_mode FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  if (!user || !workspace) {
    res.status(404).json({ error: 'User or workspace not found' });
    return;
  }
  res.json({ user, workspace });
});

/**
 * POST /api/workspaces/:id/go-live — one click out of practice mode.
 * The :id must match the workspace in the caller's token.
 */
export const workspacesRouter = Router();
workspacesRouter.post('/:id/go-live', requireAuth, async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  if (req.params.id !== workspaceId) {
    res.status(403).json({ error: 'Cannot go live for another workspace' });
    return;
  }
  const { rows } = await pool.query(
    'UPDATE workspaces SET practice_mode = FALSE, updated_at = now() WHERE id = $1 RETURNING id, name, practice_mode',
    [workspaceId],
  );
  res.json({ workspace: rows[0] });
});
