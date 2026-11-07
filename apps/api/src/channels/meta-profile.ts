/**
 * Customer name + photo from the Meta Graph API.
 *
 * The Meta webhook saves only the sender PSID, so the Inbox showed
 * "Unknown" for every customer. On first sight of a sender (Messenger
 * or Instagram) we fetch the profile with the channel's Page token and
 * store the name + picture URL on the customer row, so the Inbox can
 * show a real name and avatar.
 *
 * Messenger: GET /{psid}?fields=first_name,last_name,profile_pic
 * Instagram: GET /{ig-user-id}?fields=name,username,profile_picture_url
 * (Both are Graph v21.0 — GRAPH_BASE is imported from meta-oauth.ts so
 * the version stays in one place. META_GRAPH_BASE_URL overrides the
 * base for offline testing only; production always uses
 * graph.facebook.com.)
 *
 * Honesty / safety rules:
 * - Best-effort only: a failed fetch (Graph error, empty response,
 *   timeout, no token) returns null and NEVER throws — the incoming
 *   message and the AI reply must never be blocked by a profile lookup.
 * - Fetch only on first sight (or when the stored name/picture is
 *   missing) — never on every message.
 * - Only missing fields are filled in; a stored name/picture is never
 *   overwritten.
 * - Tokens are never put in a URL or a log line (Bearer header only).
 */
import { fetchWithTimeout } from '../ai-agent/http';
import { GRAPH_BASE } from './meta-oauth';
import { query } from '../db/pool';

export interface MetaProfile {
  name: string | null;
  pictureUrl: string | null;
}

function profileGraphBase(): string {
  const override = (process.env.META_GRAPH_BASE_URL ?? '').replace(/\/$/, '');
  return override || GRAPH_BASE;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Fetch one sender's profile from Graph. Never throws — every failure
 * is returned as null (the caller falls back to "Unknown").
 */
export async function fetchMetaProfile(input: {
  platform: 'messenger' | 'instagram';
  /** Messenger: customer PSID. Instagram: IG-scoped user ID. */
  senderId: string;
  /** Page access token (Bearer). */
  pageToken: string;
}): Promise<MetaProfile | null> {
  const fields =
    input.platform === 'instagram'
      ? 'name,username,profile_picture_url'
      : 'first_name,last_name,profile_pic';
  const url = `${profileGraphBase()}/${encodeURIComponent(input.senderId)}?fields=${encodeURIComponent(fields)}`;
  try {
    const res = await fetchWithTimeout(
      url,
      { headers: { Authorization: `Bearer ${input.pageToken}` } },
      8000,
    );
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!data || typeof data !== 'object') return null;
    if (input.platform === 'instagram') {
      const name = asNonEmptyString(data.name) ?? asNonEmptyString(data.username);
      const pictureUrl = asNonEmptyString(data.profile_picture_url);
      if (!name && !pictureUrl) return null;
      return { name, pictureUrl };
    }
    const first = asNonEmptyString(data.first_name);
    const last = asNonEmptyString(data.last_name);
    const name = [first, last].filter(Boolean).join(' ') || null;
    const pic = data.profile_pic as { url?: unknown } | string | undefined;
    const pictureUrl =
      typeof pic === 'string' ? asNonEmptyString(pic) : pic && typeof pic === 'object' ? asNonEmptyString(pic.url) : null;
    if (!name && !pictureUrl) return null;
    return { name, pictureUrl };
  } catch {
    return null;
  }
}

/**
 * Fill in a customer's missing name/picture from Graph, best-effort.
 * Skips the fetch entirely when the customer already has both, or when
 * there is no Page token. Never throws — a failure is logged by the
 * caller and the message flow continues.
 */
export async function enrichCustomerProfileIfNeeded(input: {
  workspaceId: string;
  platform: 'messenger' | 'instagram';
  senderId: string;
  customerId: string;
  customerName: string | null;
  customerPictureUrl: string | null;
  pageToken: string | null;
}): Promise<void> {
  if (!input.pageToken) return;
  if (input.customerName && input.customerPictureUrl) return;
  const profile = await fetchMetaProfile({
    platform: input.platform,
    senderId: input.senderId,
    pageToken: input.pageToken,
  });
  if (!profile) return;
  const name = input.customerName ?? profile.name;
  const pictureUrl = input.customerPictureUrl ?? profile.pictureUrl;
  if (name === input.customerName && pictureUrl === input.customerPictureUrl) return;
  await query(
    input.workspaceId,
    'UPDATE customers SET name = $1, picture_url = $2, updated_at = now() WHERE workspace_id = $3 AND id = $4',
    [name, pictureUrl, input.workspaceId, input.customerId],
  );
}
