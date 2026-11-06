import type { Request } from 'express';

/** Request after the JWT auth middleware has run. */
export interface AuthRequest extends Request {
  userId?: string;
  workspaceId?: string;
  /** True when the caller passed the owner gate (requireOwner). */
  isOwner?: boolean;
}

export interface JwtPayload {
  userId: string;
  workspaceId: string;
  /** Platform-owner flag (informational; requireOwner re-checks the DB). */
  isOwner?: boolean;
  /**
   * Short-lived, single-purpose tokens (Facebook OAuth state / page-pick
   * session) carry a purpose. requireAuth rejects them — they must never
   * work as API auth tokens, even though they are signed with the same
   * JWT secret and carry a userId + workspaceId.
   */
  purpose?: string;
}
