import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router, type Response } from 'express';
import { del, put } from '@vercel/blob';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { config } from '../config';
import { isMailerConfigured, sendMail } from '../mailer';
import { pool, query, queryOne } from '../db/pool';
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
  const user = await queryOne<{ id: string; email: string; name: string | null; avatar_url: string | null }>(
    workspaceId,
    'SELECT id, email, name, avatar_url FROM users WHERE workspace_id = $1 AND id = $2',
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
  res.json({
    user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatar_url ?? null },
    workspace,
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

  const { rows } = await query<{ id: string; email: string; name: string | null; avatar_url: string | null }>(
    workspaceId,
    `UPDATE users SET avatar_url = $1, updated_at = now()
     WHERE workspace_id = $2 AND id = $3
     RETURNING id, email, name, avatar_url`,
    [finalUrl, workspaceId, req.userId],
  );
  const user = rows[0];
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json({ user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatar_url ?? null } });
});

/**
 * DELETE /api/profile/photo — remove the logged-in user's profile
 * photo (back to the initials avatar). The DB row is always cleared;
 * the Blob object is deleted best-effort (a Blob failure never fails
 * the request).
 */
profileRouter.delete('/photo', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rows } = await query<{ id: string; email: string; name: string | null; avatar_url: string | null }>(
    workspaceId,
    `UPDATE users SET avatar_url = NULL, updated_at = now()
     WHERE workspace_id = $1 AND id = $2
     RETURNING id, email, name, avatar_url`,
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
  res.json({ user: { id: user.id, email: user.email, name: user.name, avatarUrl: null } });
});
