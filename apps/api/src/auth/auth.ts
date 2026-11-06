import type { NextFunction, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import type { AuthRequest, JwtPayload } from '../types';

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: '30d' });
}

/** JWT middleware: extracts userId + workspaceId from `Authorization: Bearer <token>`. */
export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) {
    res.status(401).json({ error: 'Missing Authorization Bearer token' });
    return;
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret) as JwtPayload;
    if (!payload.userId || !payload.workspaceId) throw new Error('Invalid token payload');
    req.userId = payload.userId;
    req.workspaceId = payload.workspaceId;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/** Helper for handlers: workspaceId is guaranteed present after requireAuth. */
export function getWorkspaceId(req: AuthRequest): string {
  if (!req.workspaceId) throw new Error('Missing workspaceId — requireAuth not applied');
  return req.workspaceId;
}
