/**
 * Courier API credentials store (migration 32, 2026-11-08).
 *
 * The shop owner enters Steadfast / Pathao merchant keys on the Courier
 * page. They are stored per workspace in courier_credentials, encrypted
 * with the same AES-256-GCM helper as channel tokens (db/crypto.ts), and
 * are NEVER returned in plain text — reads return only masked hasSet
 * flags. DB credentials take precedence over env vars (env stays as a
 * fallback for shops that already set STEADFAST_API_KEY / PATHAO_*).
 *
 * Only Steadfast + Pathao are supported here — the user will use only
 * those two. RedX / Sundarban have no credential fields and stay
 * honestly "not connected".
 *
 * Owner-only: PUT/GET/verify require the caller to be the workspace
 * owner (members.role = 'owner') or a platform owner (users.is_owner).
 * A team member must never be able to read or replace the shop's keys.
 */
import type { NextFunction, Response } from 'express';
import { pool, query, queryOne } from '../db/pool';
import { decryptToken, encryptToken } from '../db/crypto';
import { config } from '../config';
import { getWorkspaceId } from '../auth/auth';
import type { AuthRequest } from '../types';
import {
  PathaoCourierProvider,
  SteadfastCourierProvider,
  providerForName,
  type CourierProvider,
  type PathaoCreds,
  type SteadfastCreds,
} from './provider';

export type CourierCredentialProvider = 'steadfast' | 'pathao';

export const CREDENTIAL_PROVIDERS: CourierCredentialProvider[] = ['steadfast', 'pathao'];

export interface CredentialFieldDef {
  key: string;
  label: string;
  labelBn: string;
  type: 'text' | 'password';
  required: boolean;
  help?: string;
  helpBn?: string;
}

/** Field definitions per provider — the single source of truth for the
 * API validation AND the Courier page form. Pathao needs its merchant
 * login (email + password) because its token endpoint is the OAuth 2.0
 * password grant, plus the store id (pickup location). */
export const CREDENTIAL_FIELDS: Record<CourierCredentialProvider, CredentialFieldDef[]> = {
  steadfast: [
    { key: 'apiKey', label: 'Api-Key', labelBn: 'Api-Key', type: 'password', required: true, help: 'From the Steadfast merchant panel (portal.packzy.com → API)', helpBn: 'Steadfast মার্চেন্ট প্যানেল থেকে (portal.packzy.com → API)' },
    { key: 'secretKey', label: 'Secret-Key', labelBn: 'Secret-Key', type: 'password', required: true, help: 'From the Steadfast merchant panel (portal.packzy.com → API)', helpBn: 'Steadfast মার্চেন্ট প্যানেল থেকে (portal.packzy.com → API)' },
  ],
  pathao: [
    { key: 'clientId', label: 'Client ID', labelBn: 'Client ID', type: 'text', required: true, help: 'Merchant API Credentials section of the Pathao merchant panel', helpBn: 'Pathao মার্চেন্ট প্যানেলের Merchant API Credentials অংশ থেকে' },
    { key: 'clientSecret', label: 'Client Secret', labelBn: 'Client Secret', type: 'password', required: true, help: 'Merchant API Credentials section of the Pathao merchant panel', helpBn: 'Pathao মার্চেন্ট প্যানেলের Merchant API Credentials অংশ থেকে' },
    { key: 'username', label: 'Merchant email', labelBn: 'মার্চেন্ট ইমেইল', type: 'text', required: true, help: 'Your Pathao merchant login email (used for the OAuth password grant)', helpBn: 'আপনার Pathao মার্চেন্ট লগইন ইমেইল' },
    { key: 'password', label: 'Merchant password', labelBn: 'মার্চেন্ট পাসওয়ার্ড', type: 'password', required: true, help: 'Your Pathao merchant login password (used for the OAuth password grant)', helpBn: 'আপনার Pathao মার্চেন্ট লগইন পাসওয়ার্ড' },
    { key: 'storeId', label: 'Store ID', labelBn: 'স্টোর ID', type: 'text', required: false, help: 'Pickup store — press Verify to list your stores, then pick one', helpBn: 'পিকআপের স্টোর — "যাচাই করুন" চাপলে আপনার স্টোরের তালিকা আসবে' },
    { key: 'baseUrl', label: 'Base URL (optional)', labelBn: 'Base URL (ঐচ্ছিক)', type: 'text', required: false, help: 'Leave empty for live (https://api-hermes.pathao.com); sandbox is https://courier-api-sandbox.pathao.com', helpBn: 'খালি রাখলে লাইভ (https://api-hermes.pathao.com); স্যান্ডবক্স: https://courier-api-sandbox.pathao.com' },
  ],
};

export type StoredCredentials = Record<string, string>;

interface CredentialRow {
  provider: string;
  credentials_encrypted: string;
  verified_at: string | null;
  updated_at: string;
}

/** Decrypt one stored row. Returns null when the row is missing or corrupt
 * (a corrupt row is treated as "no keys" — never crash the request). */
function decryptRow(row: CredentialRow | null): StoredCredentials | null {
  if (!row) return null;
  try {
    const parsed = JSON.parse(decryptToken(row.credentials_encrypted)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const out: StoredCredentials = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

/** Raw stored credentials for one provider (DB only, decrypted). */
export async function getStoredCredentials(
  workspaceId: string,
  provider: CourierCredentialProvider,
): Promise<{ credentials: StoredCredentials | null; verifiedAt: string | null }> {
  const row = await queryOne<CredentialRow>(
    workspaceId,
    'SELECT provider, credentials_encrypted, verified_at, updated_at FROM courier_credentials WHERE workspace_id = $1 AND provider = $2',
    [workspaceId, provider],
  );
  return { credentials: decryptRow(row), verifiedAt: row?.verified_at ?? null };
}

/** Env fallback credentials (never logged, never returned to the client). */
export function envCredentials(provider: CourierCredentialProvider): StoredCredentials {
  if (provider === 'steadfast') {
    return {
      apiKey: config.courier.steadfast.apiKey || '',
      secretKey: config.courier.steadfast.secretKey || '',
      baseUrl: config.courier.steadfast.baseUrl || '',
    };
  }
  return {
    clientId: config.courier.pathao.clientId || '',
    clientSecret: config.courier.pathao.clientSecret || '',
    username: config.courier.pathao.username || '',
    password: config.courier.pathao.password || '',
    storeId: config.courier.pathao.storeId || '',
    baseUrl: config.courier.pathao.baseUrl || '',
  };
}

function requiredKeys(provider: CourierCredentialProvider): string[] {
  return CREDENTIAL_FIELDS[provider].filter((f) => f.required).map((f) => f.key);
}

/** Resolved credentials for a provider: DB first, env fallback. Returns
 * null unless ALL required fields are present. `source` tells the caller
 * (and the UI) where the working keys came from. */
export async function resolveCourierCredentials(
  workspaceId: string,
  provider: CourierCredentialProvider,
): Promise<{ credentials: StoredCredentials; source: 'db' | 'env' } | null> {
  const { credentials: stored } = await getStoredCredentials(workspaceId, provider);
  const required = requiredKeys(provider);
  const complete = (c: StoredCredentials | null): c is StoredCredentials =>
    !!c && required.every((k) => typeof c[k] === 'string' && c[k].trim() !== '');
  if (complete(stored)) return { credentials: stored, source: 'db' };
  const env = envCredentials(provider);
  if (complete(env)) return { credentials: env, source: 'env' };
  return null;
}

/** Masked status for the UI — field names + hasSet flags ONLY. A secret
 * value never leaves the server through this shape. */
export interface MaskedCredentialStatus {
  provider: CourierCredentialProvider;
  /** 'db' = keys saved on the Courier page, 'env' = server env vars,
   * 'none' = no usable keys anywhere. */
  source: 'db' | 'env' | 'none';
  hasKeys: boolean;
  /** True only after a successful read-only verify check. */
  verified: boolean;
  verifiedAt: string | null;
  fields: { key: string; label: string; labelBn: string; type: 'text' | 'password'; required: boolean; hasSet: boolean; help?: string; helpBn?: string }[];
}

export async function maskedStatus(
  workspaceId: string,
  provider: CourierCredentialProvider,
): Promise<MaskedCredentialStatus> {
  const { credentials: stored, verifiedAt } = await getStoredCredentials(workspaceId, provider);
  const env = envCredentials(provider);
  const hasDb = !!stored && requiredKeys(provider).every((k) => stored[k]?.trim());
  const hasEnv = requiredKeys(provider).every((k) => env[k]?.trim());
  const source: 'db' | 'env' | 'none' = hasDb ? 'db' : hasEnv ? 'env' : 'none';
  const effective = hasDb ? stored! : env;
  return {
    provider,
    source,
    hasKeys: hasDb || hasEnv,
    verified: !!verifiedAt,
    verifiedAt,
    fields: CREDENTIAL_FIELDS[provider].map((f) => ({
      key: f.key,
      label: f.label,
      labelBn: f.labelBn,
      type: f.type,
      required: f.required,
      hasSet: !!effective[f.key]?.trim(),
      help: f.help,
      helpBn: f.helpBn,
    })),
  };
}

/** Save (insert or replace) credentials for a provider. Fields sent with a
 * non-empty value overwrite the stored ones; fields left out or empty KEEP
 * their stored value (so the owner can add just the Pathao store_id
 * without retyping every secret). Unknown fields are ignored. After the
 * merge all required fields must be present, otherwise 400. Saving clears
 * any previous verification (new keys must be verified again). Returns the
 * masked status. */
export async function saveCourierCredentials(
  workspaceId: string,
  provider: CourierCredentialProvider,
  credentials: StoredCredentials,
): Promise<MaskedCredentialStatus> {
  const { credentials: existing } = await getStoredCredentials(workspaceId, provider);
  const cleaned: StoredCredentials = { ...(existing ?? {}) };
  for (const field of CREDENTIAL_FIELDS[provider]) {
    const value = credentials[field.key];
    if (typeof value === 'string' && value.trim() !== '') cleaned[field.key] = value.trim();
  }
  const missing = requiredKeys(provider).filter((k) => !cleaned[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required field(s): ${missing.join(', ')}`);
  }
  const encrypted = encryptToken(JSON.stringify(cleaned));
  await query(
    workspaceId,
    `INSERT INTO courier_credentials (workspace_id, provider, credentials_encrypted, verified_at, updated_at)
     VALUES ($1, $2, $3, NULL, now())
     ON CONFLICT (workspace_id, provider) DO UPDATE
       SET credentials_encrypted = EXCLUDED.credentials_encrypted, verified_at = NULL, updated_at = now()`,
    [workspaceId, provider, encrypted],
  );
  return maskedStatus(workspaceId, provider);
}

/** Mark a provider verified (after a successful read-only check) or clear it. */
export async function setCredentialsVerified(
  workspaceId: string,
  provider: CourierCredentialProvider,
  verified: boolean,
): Promise<void> {
  await query(
    workspaceId,
    'UPDATE courier_credentials SET verified_at = $1, updated_at = now() WHERE workspace_id = $2 AND provider = $3',
    [verified ? new Date().toISOString() : null, workspaceId, provider],
  );
}

/** Provider instance wired with this workspace's resolved credentials
 * (DB first, env fallback). Used by booking, tracking and status checks
 * so keys entered in the UI are actually used. */
export async function providerForWorkspace(
  workspaceId: string,
  name: string,
): Promise<CourierProvider> {
  if (name === 'steadfast') {
    const resolved = await resolveCourierCredentials(workspaceId, 'steadfast');
    const creds: SteadfastCreds = resolved ? { apiKey: resolved.credentials.apiKey, secretKey: resolved.credentials.secretKey } : {};
    return new SteadfastCourierProvider(creds);
  }
  if (name === 'pathao') {
    const resolved = await resolveCourierCredentials(workspaceId, 'pathao');
    const creds: PathaoCreds = resolved
      ? {
          clientId: resolved.credentials.clientId,
          clientSecret: resolved.credentials.clientSecret,
          username: resolved.credentials.username,
          password: resolved.credentials.password,
          storeId: resolved.credentials.storeId,
          baseUrl: resolved.credentials.baseUrl,
        }
      : {};
    return new PathaoCourierProvider(creds);
  }
  return providerForName(name);
}

/** Owner-only gate for the credentials endpoints. The caller must be the
 * workspace owner (members.role = 'owner', set at signup) or a platform
 * owner (users.is_owner). Anyone else gets 403 — a team member must never
 * read or replace the shop's courier keys. */
export async function requireWorkspaceOwner(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = getWorkspaceId(req);
    const member = await queryOne<{ role: string }>(
      workspaceId,
      'SELECT role FROM members WHERE workspace_id = $1 AND user_id = $2',
      [workspaceId, req.userId],
    );
    if (member?.role === 'owner') {
      next();
      return;
    }
    const user = await pool.query('SELECT is_owner FROM users WHERE id = $1', [req.userId]);
    if (user.rows[0]?.is_owner === true) {
      next();
      return;
    }
    res.status(403).json({ error: 'Only the workspace owner can manage courier API keys.' });
  } catch (err) {
    console.error('[courier/credentials] owner check failed:', (err as Error).message);
    res.status(500).json({ error: 'Could not check owner permission.' });
  }
}
