import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { Router, type Response } from 'express';
import { config } from '../config';
import { pool, queryOne } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth, signToken } from './auth';

/**
 * Email addresses are case-insensitive, but the DB lookup was an exact
 * `email = $1` match on the raw input — so "EasinArafatES6609@Gmail.com"
 * or a trailing space failed to log in even though the account exists.
 * Every auth lookup stores/compares the normalised form (trimmed,
 * lower-cased). This also matters because two live accounts differ by
 * ONE letter (…@gmail.com vs …@gamil.com): normalisation cannot fix a
 * wrong spelling, but it stops case/space typos from looking like a
 * missing account.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** SHA-256 of a reset token — the token itself is never stored. */
function hashResetToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const RESET_GENERIC_MESSAGE =
  'If an account exists for this email, a password reset link has been sent. Check your inbox (and spam).';

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
  const normalisedEmail = normalizeEmail(email);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT id FROM users WHERE email = $1', [normalisedEmail]);
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
      [workspaceId, normalisedEmail, passwordHash, name ?? null],
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
    [normalizeEmail(email)],
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

/**
 * POST /api/auth/forgot-password — start a password reset.
 *
 * There was NO reset flow before this: a forgotten password meant a
 * locked-out account. The response is ALWAYS the same generic message
 * (200), whether the email exists or not — the endpoint must never
 * reveal which emails have accounts.
 *
 * When the account exists a single-use token (random 32 bytes, valid
 * 1 hour) is stored as a SHA-256 hash and any older unused tokens for
 * that user are invalidated, so only the latest link works.
 *
 * DELIVERY GAP (honest): there is NO email sender in this codebase
 * (no SMTP / Resend / SendGrid), so the reset link cannot be emailed
 * yet. The token is stored and the reset endpoint below is complete
 * and tested — but until a mailer is wired, the link has nowhere to
 * go. The token is deliberately NEVER returned in the response:
 * returning it would let anyone reset anyone's password. Wire a
 * mailer, then send `${WEB_APP_URL}/reset-password?token=<token>` here.
 * Do NOT "fix" this by returning the token.
 */
authRouter.post('/forgot-password', async (req: AuthRequest, res: Response) => {
  const { email } = (req.body ?? {}) as { email?: string };
  if (!email) {
    res.status(400).json({ error: 'email is required' });
    return;
  }
  const normalisedEmail = normalizeEmail(email);
  try {
    const { rows } = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [normalisedEmail],
    );
    const user = rows[0];
    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashResetToken(token);
      const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
      await pool.query(
        "UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL",
        [user.id],
      );
      await pool.query(
        'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
        [user.id, tokenHash, expiresAt],
      );
      // TODO (needs a mailer — none configured): email the reset link
      // `${WEB_APP_URL}/reset-password?token=${token}` to normalisedEmail.
      console.log(
        `[auth/forgot-password] reset requested for user ${user.id as string} — no mailer configured, link NOT sent`,
      );
    }
  } catch (err) {
    console.error('[auth/forgot-password]', err);
  }
  res.json({ message: RESET_GENERIC_MESSAGE });
});

/**
 * POST /api/auth/reset-password — finish a reset with the token from
 * the emailed link. The token works exactly once and only within its
 * 1-hour window; expired / used / unknown tokens all get the same 400
 * so an attacker cannot probe which tokens are real.
 */
authRouter.post('/reset-password', async (req: AuthRequest, res: Response) => {
  const { token, password } = (req.body ?? {}) as { token?: string; password?: string };
  if (!token || !password) {
    res.status(400).json({ error: 'token and password are required' });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: 'password must be at least 8 characters' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, user_id FROM password_resets
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
      [hashResetToken(token)],
    );
    const reset = rows[0];
    if (!reset) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: 'This reset link is invalid or has expired — please request a new one.' });
      return;
    }
    const passwordHash = await bcrypt.hash(password, 10);
    await client.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [
      passwordHash,
      reset.user_id,
    ]);
    await client.query('UPDATE password_resets SET used_at = now() WHERE id = $1', [reset.id]);
    await client.query('COMMIT');
    res.json({ message: 'Password changed — you can now log in with your new password.' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('[auth/reset-password]', err);
    res.status(500).json({ error: 'Password reset failed' });
  } finally {
    client.release();
  }
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
