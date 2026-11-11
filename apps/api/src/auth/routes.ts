import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import jwt from 'jsonwebtoken';
import path from 'node:path';
import { Router, type Response } from 'express';
import { del, put } from '@vercel/blob';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { config } from '../config';
import { isMailerConfigured, sendMail } from '../mailer';
import { pool, query, queryOne } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, isWorkspaceOwner, requireAuth, signToken } from './auth';
import { checkFixedWindow, clearFailures, clientIp, isBlocked, recordFailure } from '../utils/rate-limit';

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
  // H3: at most 5 signup attempts per IP per hour — stops mass fake-account creation.
  if (!checkFixedWindow(`signup-ip:${clientIp(req)}`, 5, 60 * 60 * 1000)) {
    res.status(429).json({ error: 'Too many signup attempts — try again later.' });
    return;
  }
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
        "INSERT INTO wallet_transactions (workspace_id, type, amount_paisa, description) VALUES ($1, 'topup', $2, 'Free credit on signup')",
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
  // H3: 5 failed logins per (IP + email), or 30 per IP, inside 15
  // minutes → locked out for 15 minutes. Before this fix there was no
  // limit at all — a password could be guessed forever.
  // PLUS a per-email bucket (10 failures in 15 min): the IP keys alone
  // cannot stop an attacker who rotates IPs (live-verified 2026-11-11:
  // 16 failures from rotating egress IPs never hit one IP bucket).
  // 10 (not 5) so a single bad actor cannot cheaply lock a real user
  // out of their own account by failing 5 logins on purpose.
  const loginKey = `login:${clientIp(req)}:${normalizeEmail(email)}`;
  const loginIpKey = `login-ip:${clientIp(req)}`;
  const loginEmailKey = `login-email:${normalizeEmail(email)}`;
  if (isBlocked(loginKey) || isBlocked(loginIpKey) || isBlocked(loginEmailKey)) {
    res.status(429).json({ error: 'অনেকবার ভুল চেষ্টা হয়েছে — ১৫ মিনিট পর আবার চেষ্টা করুন। (Too many failed login attempts — try again in 15 minutes.)' });
    return;
  }
  const { rows } = await pool.query(
    'SELECT id, workspace_id, email, name, password_hash, is_owner, account_status FROM users WHERE email = $1',
    [normalizeEmail(email)],
  );
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash as string))) {
    recordFailure(loginKey);
    recordFailure(loginIpKey, 30);
    recordFailure(loginEmailKey, 10);
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }
  // A correct password clears the failure count — a user who mistyped
  // then remembered must not stay locked out.
  clearFailures(loginKey);
  clearFailures(loginEmailKey);
  // Owner Panel account status (migration 45): a blocked account cannot
  // log in at all; a soft-deleted account cannot log in either. Both
  // get a clear Bengali message. A restricted account CAN log in —
  // only its AI replies and post scheduling are disabled.
  if (user.account_status === 'blocked') {
    res.status(403).json({ error: 'আপনার অ্যাকাউন্টটি ব্লক করা হয়েছে' });
    return;
  }
  if (user.account_status === 'deleted') {
    res.status(403).json({ error: 'আপনার অ্যাকাউন্টটি মুছে ফেলা হয়েছে — নতুন অ্যাকাউন্ট খুলতে প্ল্যাটফর্মের মালিকের সাথে যোগাযোগ করুন।' });
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
 * POST /api/auth/logout — real server-side logout (Task 3).
 *
 * JWTs are stateless, so clearing the browser token alone left a
 * copied token valid for 30 days. This route records the token's jti
 * in revoked_tokens (migration 38); requireAuth rejects revoked
 * tokens, so the session stops working immediately — server-side, not
 * just in this browser. The client must still delete its stored token
 * (clearToken) — the server cannot reach into the browser. Tokens
 * issued before jti support have no jti to revoke; they expire on
 * their own (30 days max). Logout never fails the request: if the
 * token has no jti, the reply still says logged out (the client
 * clears its token either way).
 */
authRouter.post('/logout', requireAuth, async (req: AuthRequest, res: Response) => {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const decoded = token ? (jwt.decode(token) as { jti?: string; exp?: number } | null) : null;
  const jti = req.tokenJti ?? decoded?.jti;
  if (jti) {
    const expiresAt = decoded?.exp
      ? new Date(decoded.exp * 1000).toISOString()
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    try {
      await pool.query(
        'INSERT INTO revoked_tokens (jti, user_id, expires_at) VALUES ($1, $2, $3) ON CONFLICT (jti) DO NOTHING',
        [jti, req.userId ?? null, expiresAt],
      );
      // Best-effort prune of rows whose tokens already expired.
      await pool.query('DELETE FROM revoked_tokens WHERE expires_at < now()').catch(() => undefined);
    } catch (err) {
      console.error('[auth/logout] could not revoke token:', (err as Error).message);
      res.status(500).json({ error: 'Logout failed — please clear your browser token and try again.' });
      return;
    }
  }
  res.json({ message: 'Logged out — this session no longer works.', revoked: Boolean(jti) });
});

/**
 * Team-invite acceptance (Task 16) — PUBLIC routes. Until this batch
 * nothing accepted invite tokens at all: the team page created invites
 * and showed a link, but /signup ignored ?invite= and there was no
 * endpoint to join with a token.
 *
 * GET /api/auth/invite/:token — what the signup page shows before the
 * person creates their account: the invited email, role and shop name.
 * Only pending invites answer; anything else is 404 (same reply for
 * unknown / revoked / accepted tokens, so tokens cannot be probed).
 *
 * POST /api/auth/accept-invite {token, name, password} — creates the
 * user IN the invited workspace with the invited role (member/admin),
 * marks the invite accepted, and returns a login token. The invited
 * email is fixed by the invite (it cannot be changed here) and must
 * not already have an account — an already-registered email gets 409
 * and must log in instead (the owner can revoke + re-invite a
 * different email). No free credit is added: the workspace already
 * has its own balance.
 */
authRouter.get('/invite/:token', async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `SELECT i.email, i.role, w.name AS workspace_name
     FROM team_invites i JOIN workspaces w ON w.id = i.workspace_id
     WHERE i.token = $1 AND i.status = 'pending'`,
    [req.params.token],
  );
  const invite = rows[0];
  if (!invite) {
    res.status(404).json({ error: 'This invite link is invalid, revoked, or already used.' });
    return;
  }
  res.json({ email: invite.email, role: invite.role, workspaceName: invite.workspace_name });
});

authRouter.post('/accept-invite', async (req: AuthRequest, res: Response) => {
  const { token, name, password } = (req.body ?? {}) as { token?: string; name?: string; password?: string };
  if (!token || !password) {
    res.status(400).json({ error: 'token and password are required' });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: 'password must be at least 8 characters' });
    return;
  }
  // Same abuse guard as signup: at most 5 accept attempts per IP/hour.
  if (!checkFixedWindow(`accept-invite-ip:${clientIp(req)}`, 5, 60 * 60 * 1000)) {
    res.status(429).json({ error: 'Too many attempts — try again later.' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: inviteRows } = await client.query(
      `SELECT i.id, i.workspace_id, i.email, i.role, w.name AS workspace_name
       FROM team_invites i JOIN workspaces w ON w.id = i.workspace_id
       WHERE i.token = $1 AND i.status = 'pending' FOR UPDATE`,
      [token],
    );
    const invite = inviteRows[0];
    if (!invite) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'This invite link is invalid, revoked, or already used.' });
      return;
    }
    const existing = await client.query('SELECT id FROM users WHERE email = $1', [invite.email]);
    if (existing.rowCount && existing.rowCount > 0) {
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'This email already has an account — please log in instead.' });
      return;
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await client.query(
      'INSERT INTO users (workspace_id, email, password_hash, name) VALUES ($1, $2, $3, $4) RETURNING id, email, name',
      [invite.workspace_id, invite.email, passwordHash, name?.trim() || null],
    );
    const userId = user.rows[0].id as string;
    await client.query('INSERT INTO members (workspace_id, user_id, role) VALUES ($1, $2, $3)', [
      invite.workspace_id,
      userId,
      invite.role,
    ]);
    await client.query(
      "UPDATE team_invites SET status = 'accepted', updated_at = now() WHERE id = $1",
      [invite.id],
    );
    await client.query('COMMIT');
    const authToken = signToken({ userId, workspaceId: invite.workspace_id as string });
    res.status(201).json({
      token: authToken,
      user: user.rows[0],
      workspace: { id: invite.workspace_id, name: invite.workspace_name },
      role: invite.role,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('[auth/accept-invite]', err);
    res.status(500).json({ error: 'Could not accept the invite' });
  } finally {
    client.release();
  }
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
 * DELIVERY: the reset link is emailed when a Resend mailer is configured
 * (src/mailer.ts — env RESEND_API_KEY, optional RESEND_FROM). When no
 * mailer is configured the link is stored but NOT sent: the route logs
 * "no mailer configured" and the reply carries mailerConfigured=false
 * so the UI can say so honestly instead of claiming an email went out.
 * The token is stored only as a SHA-256 hash and is deliberately NEVER
 * returned in the response: returning it would let anyone reset
 * anyone's password. Send failures are logged and never fail the
 * request — the reply stays the same generic message either way.
 */
authRouter.post('/forgot-password', async (req: AuthRequest, res: Response) => {
  const { email } = (req.body ?? {}) as { email?: string };
  if (!email) {
    res.status(400).json({ error: 'email is required' });
    return;
  }
  const normalisedEmail = normalizeEmail(email);
  // H3: at most 10 reset requests per IP and 5 per email per hour —
  // stops reset-email flooding. The reply stays the same generic
  // message either way (a 429 only says "too many tries", never
  // whether the email has an account).
  if (
    !checkFixedWindow(`forgot-ip:${clientIp(req)}`, 10, 60 * 60 * 1000) ||
    !checkFixedWindow(`forgot-email:${normalisedEmail}`, 5, 60 * 60 * 1000)
  ) {
    res.status(429).json({ error: 'Too many password-reset requests — try again later.' });
    return;
  }
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
      // The reset link goes out by email when a Resend mailer is
      // configured (see src/mailer.ts — env RESEND_API_KEY, optional
      // RESEND_FROM). When no mailer is configured the link is stored but
      // NOT sent — the honest fallback: log it and send nothing, never
      // claim an email went out. A send failure is logged the same way
      // and never fails the request (the reply stays generic either way).
      // The token is deliberately NEVER returned in the response:
      // returning it would let anyone reset anyone's password.
      const resetLink = `${config.webAppUrl}/reset-password?token=${token}`;
      if (isMailerConfigured()) {
        try {
          const messageId = await sendMail({
            to: normalisedEmail,
            subject: 'AI Sales Inbox — পাসওয়ার্ড রিসেট লিংক / Password reset link',
            text: [
              'আসসালামু আলাইকুম,',
              '',
              'আপনার AI Sales Inbox অ্যাকাউন্টের পাসওয়ার্ড বদলাতে নিচের লিংকে ক্লিক করুন। লিংকটি ১ ঘণ্টা পর্যন্ত কাজ করবে।',
              resetLink,
              '',
              'আপনি এই অনুরোধ না করে থাকলে এই ইমেইলটি উপেক্ষা করুন — আপনার পাসওয়ার্ড বদলাবে না।',
              '',
              '---',
              'Hello,',
              '',
              'To reset your AI Sales Inbox password, click the link below. The link works for 1 hour.',
              resetLink,
              '',
              'If you did not request this, please ignore this email — your password will not change.',
            ].join('\n'),
          });
          console.log(`[auth/forgot-password] reset link emailed to ${normalisedEmail}${messageId ? ` (resend id: ${messageId})` : ''}`);
        } catch (err) {
          console.error('[auth/forgot-password] failed to send reset email:', (err as Error).message);
        }
      } else {
        console.log(
          `[auth/forgot-password] reset requested for user ${user.id as string} — no mailer configured, link NOT sent`,
        );
      }
    }
  } catch (err) {
    console.error('[auth/forgot-password]', err);
  }
  // mailerConfigured says only whether this platform has an SMTP mailer
  // set up — it never depends on whether the email has an account, so
  // the reply still reveals nothing about who is registered. The UI
  // uses it to show the honest message ("check your inbox" vs "no
  // email was sent — email delivery isn't set up yet").
  res.json({ message: RESET_GENERIC_MESSAGE, mailerConfigured: isMailerConfigured() });
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
  // H3: at most 10 reset attempts per IP per hour — stops reset-token guessing.
  if (!checkFixedWindow(`reset-ip:${clientIp(req)}`, 10, 60 * 60 * 1000)) {
    res.status(429).json({ error: 'Too many password-reset attempts — try again later.' });
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
  const user = await queryOne<{ id: string; email: string; name: string | null; avatar_url: string | null; phone: string | null; account_status: string | null }>(
    workspaceId,
    'SELECT id, email, name, avatar_url, phone, account_status FROM users WHERE workspace_id = $1 AND id = $2',
    [workspaceId, req.userId],
  );
  const workspace = await queryOne<{
    id: string;
    name: string;
    balance_paisa: number;
    ai_enabled: boolean;
    practice_mode: boolean;
    restricted: boolean;
  }>(
    workspaceId,
    'SELECT id, name, balance_paisa, ai_enabled, practice_mode, restricted FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  if (!user || !workspace) {
    res.status(404).json({ error: 'User or workspace not found' });
    return;
  }
  // Current plan / trial (if any) — the header Profile menu shows it.
  // A workspace without a subscription row simply gets subscription: null.
  const subscription = await queryOne<{
    plan_name: string | null;
    plan_slug: string | null;
    status: string | null;
    current_period_end: string | null;
  }>(
    workspaceId,
    `SELECT p.name_bn AS plan_name, p.slug AS plan_slug, s.status, s.current_period_end
     FROM workspace_subscriptions s JOIN plans p ON p.id = s.plan_id
     WHERE s.workspace_id = $1 ORDER BY s.created_at DESC LIMIT 1`,
    [workspaceId],
  );
  // Workspace role (members.role: 'owner' | 'admin' | 'member') — the
  // sidebar uses it to hide owner-only items (Task 14: AI Providers).
  // NOT the platform-owner flag (users.is_owner).
  const memberRow = await queryOne<{ role: string }>(
    workspaceId,
    'SELECT role FROM members WHERE workspace_id = $1 AND user_id = $2',
    [workspaceId, req.userId],
  );
  res.json({
    user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatar_url ?? null, phone: user.phone ?? null, accountStatus: user.account_status ?? 'active' },
    role: memberRow?.role ?? 'member',
    workspace: { ...workspace, restricted: workspace.restricted === true },
    subscription: subscription
      ? {
          planName: subscription.plan_name,
          planSlug: subscription.plan_slug,
          status: subscription.status,
          periodEnd: subscription.current_period_end,
        }
      : null,
  });
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

/**
 * Profile photo — the header Profile menu (POST /api/profile/photo).
 *
 * Storage follows the product-photo pattern (no new storage path):
 * - Vercel: the browser uploads straight to Vercel Blob via a client
 *   token (POST /api/profile/upload-token + @vercel/blob/client), then
 *   registers the Blob URL with POST /api/profile/photo {url}. This
 *   bypasses the API function's 4.5 MB request-body cap.
 * - Fallback (local dev / no Blob token): POST /api/profile/photo also
 *   accepts a base64 file ({fileBase64, fileName, mimeType}); on Vercel
 *   it goes to Blob, locally to disk under uploads/ (same limitation as
 *   scheduled-post media: local disk URLs need an auth token to view).
 * - The URL is stored on users.avatar_url (migration 21). NULL means
 *   "no photo yet" and the header shows the user's initials instead —
 *   a photo is never invented.
 * - Limits: one photo per user, images only, at most 25 MB.
 */
const MAX_PROFILE_PHOTO_BYTES = 25 * 1024 * 1024; // 25 MB
const PROFILE_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const PROFILE_IMAGE_MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};
const PROFILE_IMAGE_URL_EXT = /\.(jpe?g|png|gif|webp)(\?.*)?$/i;

const PROFILE_UPLOAD_DIR = path.resolve(process.cwd(), 'uploads');
if (!process.env.VERCEL) {
  fs.mkdirSync(PROFILE_UPLOAD_DIR, { recursive: true });
}

export const profileRouter = Router();
profileRouter.use(requireAuth);

/**
 * POST /api/profile/upload-token — client token for direct
 * browser→Vercel Blob upload (Vercel only). Same shape as the
 * product-photo token route, images only. Locally (no
 * BLOB_READ_WRITE_TOKEN) this returns 503 and the web falls back to
 * the base64 /api/profile/photo endpoint.
 */
profileRouter.post('/upload-token', async (req: AuthRequest, res: Response) => {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    res.status(503).json({ error: 'Blob storage is not configured (BLOB_READ_WRITE_TOKEN missing)' });
    return;
  }
  try {
    const jsonResponse = await handleUpload({
      body: req.body as HandleUploadBody,
      request: req as unknown as Request,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: PROFILE_IMAGE_MIMES,
        maximumSizeInBytes: MAX_PROFILE_PHOTO_BYTES,
        addRandomSuffix: true,
      }),
      onUploadCompleted: async ({ blob }) => {
        console.log('[blob] profile photo upload completed:', blob.url);
      },
    });
    res.status(200).json(jsonResponse);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/**
 * POST /api/profile/photo — set the logged-in user's profile photo.
 * Body (one of the two):
 * - { url } — an already-uploaded image URL (e.g. a public Blob URL
 *   from the direct browser→Blob upload via POST /api/profile/upload-token).
 * - { fileBase64, fileName?, mimeType? } — a base64 image (data: URL or
 *   raw base64); stored in Blob on Vercel, on disk locally.
 * Images only (jpeg/png/gif/webp), at most 25 MB. Returns the user
 * with the new avatarUrl.
 */
profileRouter.post('/photo', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { url, fileBase64, fileName, mimeType } = (req.body ?? {}) as {
    url?: string;
    fileBase64?: string;
    fileName?: string;
    mimeType?: string;
  };

  let finalUrl: string | null = null;

  if (typeof url === 'string' && url.trim()) {
    const trimmed = url.trim();
    if (trimmed.length > 2048) {
      res.status(400).json({ error: 'ছবির লিংকটি অনেক বড়' });
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      res.status(400).json({ error: 'ছবির লিংকটি সঠিক নয় (invalid URL)' });
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      res.status(400).json({ error: 'ছবির লিংক http(s) হতে হবে' });
      return;
    }
    const declaredMime = typeof mimeType === 'string' ? mimeType.trim() : '';
    if (!PROFILE_IMAGE_URL_EXT.test(parsed.pathname) && !PROFILE_IMAGE_MIMES.includes(declaredMime)) {
      res.status(400).json({ error: 'শুধু ছবির লিংক (jpg/png/gif/webp) দেওয়া যায়' });
      return;
    }
    finalUrl = parsed.toString();
  } else if (typeof fileBase64 === 'string' && fileBase64.trim() !== '') {
    let mime = typeof mimeType === 'string' ? mimeType.trim() : '';
    let b64 = fileBase64.trim();
    const dataUrlMatch = b64.match(/^data:([^;,]+);base64,(.+)$/);
    if (dataUrlMatch) {
      mime = dataUrlMatch[1];
      b64 = dataUrlMatch[2];
    }
    if (!PROFILE_IMAGE_MIMES.includes(mime)) {
      res.status(400).json({ error: 'শুধু ছবি (jpg/png/gif/webp) আপলোড করা যায়' });
      return;
    }
    const ext = PROFILE_IMAGE_MIME_EXT[mime];
    if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) {
      res.status(400).json({ error: 'fileBase64 সঠিক base64 নয়' });
      return;
    }
    const buf = Buffer.from(b64.replace(/\s/g, ''), 'base64');
    if (buf.length === 0) {
      res.status(400).json({ error: 'খালি ফাইল আপলোড করা যাবে না' });
      return;
    }
    if (buf.length > MAX_PROFILE_PHOTO_BYTES) {
      res.status(400).json({ error: 'ছবি 25 MB-এর বেশি হতে পারবে না (max 25 MB)' });
      return;
    }
    const stored = `profile-${crypto.randomUUID()}${ext}`;
    // Vercel: store in Blob (public URL). The API function has a 4.5 MB
    // request-body cap, so large files should use the direct
    // browser→Blob path (/api/profile/upload-token) instead.
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      try {
        const blob = await put(stored, buf, { access: 'public', contentType: mime });
        finalUrl = blob.url;
      } catch (err) {
        res.status(500).json({ error: `ছবি সংরক্ষণ করা যায়নি: ${(err as Error).message}` });
        return;
      }
    } else {
      // Local / cPanel fallback: disk storage under uploads/.
      try {
        fs.writeFileSync(path.join(PROFILE_UPLOAD_DIR, stored), buf);
      } catch (err) {
        res.status(500).json({ error: `ছবি সংরক্ষণ করা যায়নি: ${(err as Error).message}` });
        return;
      }
      finalUrl = `/api/uploads/${stored}`;
    }
    void fileName; // original name is not kept (random UUID name instead)
  } else {
    res.status(400).json({ error: 'url বা fileBase64 — একটি দিতে হবে' });
    return;
  }

  const { rows } = await query<{ id: string; email: string; name: string | null; avatar_url: string | null; phone: string | null }>(
    workspaceId,
    `UPDATE users SET avatar_url = $1, updated_at = now()
     WHERE workspace_id = $2 AND id = $3
     RETURNING id, email, name, avatar_url, phone`,
    [finalUrl, workspaceId, req.userId],
  );
  const user = rows[0];
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json({ user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatar_url ?? null, phone: user.phone ?? null } });
});

/**
 * DELETE /api/profile/photo — remove the logged-in user's profile
 * photo (back to the initials avatar). The DB row is always cleared;
 * the Blob object is deleted best-effort (a Blob failure never fails
 * the request).
 */
profileRouter.delete('/photo', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rows } = await query<{ id: string; email: string; name: string | null; avatar_url: string | null; phone: string | null }>(
    workspaceId,
    `UPDATE users SET avatar_url = NULL, updated_at = now()
     WHERE workspace_id = $1 AND id = $2
     RETURNING id, email, name, avatar_url, phone`,
    [workspaceId, req.userId],
  );
  const user = rows[0];
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  const oldUrl = (req.body as { url?: string } | undefined)?.url;
  if (process.env.BLOB_READ_WRITE_TOKEN && typeof oldUrl === 'string' && oldUrl.includes('blob.vercel-storage.com')) {
    try {
      await del(oldUrl);
    } catch (err) {
      console.warn('[profile] Blob delete failed (avatar already cleared):', (err as Error).message);
    }
  }
  res.json({ user: { id: user.id, email: user.email, name: user.name, avatarUrl: null, phone: user.phone ?? null } });
});

/**
 * PATCH /api/profile — change the logged-in user's display name and
 * phone number (Profile page). Body: { name, phone? }. Name only —
 * email is the login identity and is LOCKED, never changed here
 * (user decision 2026-11-11). Phone: an 11-digit Bangladeshi mobile
 * starting with 01 (same rule as customer order phones); empty/null
 * clears it. When `phone` is absent the stored number is left alone.
 * Returns the updated user.
 */
profileRouter.patch('/', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { name, phone } = (req.body ?? {}) as { name?: unknown; phone?: unknown };
  if (typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'নাম দিতে হবে' });
    return;
  }
  const trimmed = name.trim();
  if (trimmed.length > 100) {
    res.status(400).json({ error: 'নাম ১০০ অক্ষরের বেশি হতে পারবে না' });
    return;
  }
  // Phone is optional; when present it must be a valid 11-digit 01 number.
  let phoneValue: string | null | undefined;
  if (phone !== undefined) {
    if (phone === null || (typeof phone === 'string' && phone.trim() === '')) {
      phoneValue = null;
    } else if (typeof phone === 'string') {
      const digits = phone.replace(/[\s-]/g, '');
      if (!/^01[3-9]\d{8}$/.test(digits)) {
        res.status(400).json({ error: 'সঠিক ১১ সংখ্যার মোবাইল নম্বর দিন (01 দিয়ে শুরু)' });
        return;
      }
      phoneValue = digits;
    } else {
      res.status(400).json({ error: 'সঠিক ১১ সংখ্যার মোবাইল নম্বর দিন (01 দিয়ে শুরু)' });
      return;
    }
  }
  const params: unknown[] = [trimmed];
  let setClause = 'name = $1';
  if (phoneValue !== undefined) {
    params.push(phoneValue);
    setClause += `, phone = $${params.length}`;
  }
  params.push(workspaceId, req.userId);
  const { rows } = await query<{ id: string; email: string; name: string | null; avatar_url: string | null; phone: string | null }>(
    workspaceId,
    `UPDATE users SET ${setClause}, updated_at = now()
     WHERE workspace_id = $${params.length - 1} AND id = $${params.length}
     RETURNING id, email, name, avatar_url, phone`,
    params as never,
  );
  const user = rows[0];
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json({ user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatar_url ?? null, phone: user.phone ?? null } });
});

/**
 * PATCH /api/profile/workspace — rename the workspace (business name,
 * shown in the sidebar card and the Profile page's Business
 * Information section). Owner-only: members get 403. Body: { name }.
 */
profileRouter.patch('/workspace', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const owner = await isWorkspaceOwner(workspaceId, req.userId ?? '');
  if (!owner) {
    res.status(403).json({ error: 'Only the workspace owner can change the business name' });
    return;
  }
  const { name } = (req.body ?? {}) as { name?: unknown };
  if (typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'ব্যবসার নাম দিতে হবে' });
    return;
  }
  const trimmed = name.trim();
  if (trimmed.length > 100) {
    res.status(400).json({ error: 'ব্যবসার নাম ১০০ অক্ষরের বেশি হতে পারবে না' });
    return;
  }
  const { rows } = await query<{ id: string; name: string | null }>(
    workspaceId,
    `UPDATE workspaces SET name = $1, updated_at = now()
     WHERE id = $2
     RETURNING id, name`,
    [trimmed, workspaceId],
  );
  const workspace = rows[0];
  if (!workspace) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }
  res.json({ workspace: { id: workspace.id, name: workspace.name } });
});
