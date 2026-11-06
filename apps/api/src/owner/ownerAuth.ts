/**
 * Platform-owner gate (Owner Panel, migration 11).
 *
 * The owner is a platform-wide role, distinct from a shop owner (the
 * `owner` role in members, which is per-workspace). Only a platform owner
 * can open /api/owner/* — shop owners see only their own workspace.
 *
 * requireOwner verifies the JWT, then re-checks users.is_owner in the DB
 * on every call: the token claim alone is never trusted, so a demoted
 * owner loses access immediately.
 */
import type { NextFunction, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { pool } from '../db/pool';
import type { AuthRequest, JwtPayload } from '../types';

export async function requireOwner(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) {
    res.status(401).json({ error: 'Missing Authorization Bearer token' });
    return;
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret) as JwtPayload;
    if (!payload.userId) throw new Error('Invalid token payload');
    const { rows } = await pool.query(
      'SELECT id, is_owner FROM users WHERE id = $1',
      [payload.userId],
    );
    const user = rows[0] as { id: string; is_owner: boolean } | undefined;
    if (!user || !user.is_owner) {
      res.status(403).json({ error: 'Owner access only — এই পেজ শুধু প্ল্যাটফর্মের মালিকের জন্য।' });
      return;
    }
    req.userId = payload.userId;
    req.workspaceId = payload.workspaceId;
    req.isOwner = true;
    next();
  } catch (err) {
    // A bad/expired token is routine (401, quiet). A DB failure is not —
    // log it so a broken owner check is visible.
    if ((err as Error).name !== 'JsonWebTokenError' && (err as Error).name !== 'TokenExpiredError') {
      console.error('[owner] requireOwner failed:', (err as Error).message);
    }
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
