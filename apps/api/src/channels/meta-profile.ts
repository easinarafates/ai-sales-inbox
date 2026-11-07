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
 *   — Meta blocks the direct PSID read for many apps (400
 *   GraphMethodException #100/33), so on failure we fall back to
 *   GET /{page-id}/conversations?user_id={psid}&fields=participants{name,picture}
 *   and take the participant whose id matches the sender. That endpoint
 *   returns the real name even when the direct read is blocked.
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
 * - Failures are LOGGED (status + Graph error, never the token) so a
 *   broken profile fetch is visible in the Vercel logs instead of
 *   failing silently and leaving every customer "Unknown".
 * - Fetch only on first sight (or when the stored name/picture is
 *   missing) — never on every message.
 * - Only missing fields are filled in; a stored name/picture is never
 *   overwritten.
 * - Tokens are never put in a URL or a log line (Bearer header only).
 * - A photo is used only when Graph actually returns one; never invent
 *   a photo URL — the Inbox falls back to initials.
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

function graphErrorDetail(data: Record<string, unknown> | null): string {
  const err = data?.error as { message?: unknown; code?: unknown; error_subcode?: unknown } | undefined;
  if (!err || typeof err !== 'object') return 'no error body';
  const parts = [
    typeof err.message === 'string' ? err.message : '',
    err.code !== undefined ? `code ${String(err.code)}` : '',
    err.error_subcode !== undefined ? `subcode ${String(err.error_subcode)}` : '',
  ].filter(Boolean);
  return parts.join(' ') || 'unknown Graph error';
}

async function readJson(res: { json: () => Promise<unknown> }): Promise<Record<string, unknown> | null> {
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return data && typeof data === 'object' ? data : null;
}

function pictureFromGraphPic(pic: unknown): string | null {
  if (typeof pic === 'string') return asNonEmptyString(pic);
  if (pic && typeof pic === 'object') {
    const data = (pic as { data?: unknown }).data;
    if (data && typeof data === 'object') return asNonEmptyString((data as { url?: unknown }).url);
    return asNonEmptyString((pic as { url?: unknown }).url);
  }
  return null;
}

/**
 * Messenger direct read: GET /{psid}?fields=first_name,last_name,profile_pic.
 * Returns null on any failure (Meta blocks this read for many apps).
 */
async function fetchMessengerDirect(senderId: string, pageToken: string): Promise<MetaProfile | null> {
  const url = `${profileGraphBase()}/${encodeURIComponent(senderId)}?fields=${encodeURIComponent('first_name,last_name,profile_pic')}`;
  let res: Awaited<ReturnType<typeof fetchWithTimeout>>;
  try {
    res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${pageToken}` } }, 8000);
  } catch (err) {
    console.warn(`[meta-profile] direct read failed for ${senderId}: ${(err as Error).message}`);
    return null;
  }
  if (!res.ok) {
    const data = await readJson(res);
    console.warn(`[meta-profile] direct read failed for ${senderId}: HTTP ${res.status} ${graphErrorDetail(data)}`);
    return null;
  }
  const data = await readJson(res);
  if (!data) return null;
  const first = asNonEmptyString(data.first_name);
  const last = asNonEmptyString(data.last_name);
  const name = [first, last].filter(Boolean).join(' ') || null;
  const pictureUrl = pictureFromGraphPic(data.profile_pic);
  if (!name && !pictureUrl) return null;
  return { name, pictureUrl };
}

/**
 * Messenger fallback: GET /{page-id}/conversations?user_id={psid}
 * &fields=participants{name,picture}. The conversations endpoint returns
 * the participant's real name even when the direct PSID read is blocked
 * (GraphMethodException #100/33). Participants may be a plain array or
 * a Graph edge object { data: [...] } — both shapes are handled.
 */
async function fetchMessengerViaConversations(
  senderId: string,
  pageId: string,
  pageToken: string,
): Promise<MetaProfile | null> {
  const url = `${profileGraphBase()}/${encodeURIComponent(pageId)}/conversations?user_id=${encodeURIComponent(senderId)}&fields=${encodeURIComponent('participants{name,picture}')}`;
  let res: Awaited<ReturnType<typeof fetchWithTimeout>>;
  try {
    res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${pageToken}` } }, 8000);
  } catch (err) {
    console.warn(`[meta-profile] conversations fallback failed for ${senderId}: ${(err as Error).message}`);
    return null;
  }
  if (!res.ok) {
    const data = await readJson(res);
    console.warn(`[meta-profile] conversations fallback failed for ${senderId}: HTTP ${res.status} ${graphErrorDetail(data)}`);
    return null;
  }
  const data = await readJson(res);
  const threads = Array.isArray(data?.data) ? (data!.data as unknown[]) : [];
  for (const thread of threads) {
    const t = thread as { participants?: unknown };
    const rawParts = t?.participants;
    const parts = Array.isArray(rawParts)
      ? rawParts
      : rawParts && typeof rawParts === 'object' && Array.isArray((rawParts as { data?: unknown }).data)
        ? ((rawParts as { data: unknown[] }).data as unknown[])
        : [];
    for (const p of parts) {
      const participant = p as { id?: unknown; name?: unknown; picture?: unknown };
      if (String(participant?.id ?? '') !== senderId) continue;
      const name = asNonEmptyString(participant.name);
      const pictureUrl = pictureFromGraphPic(participant.picture);
      if (!name && !pictureUrl) return null;
      return { name, pictureUrl };
    }
  }
  console.warn(`[meta-profile] conversations fallback: no participant matched ${senderId}`);
  return null;
}

/**
 * Fetch one sender's profile from Graph. Never throws — every failure
 * is returned as null (the caller falls back to "Unknown") and logged.
 */
export async function fetchMetaProfile(input: {
  platform: 'messenger' | 'instagram';
  /** Messenger: customer PSID. Instagram: IG-scoped user ID. */
  senderId: string;
  /** Page access token (Bearer). */
  pageToken: string;
  /**
   * Messenger: the Page ID (channel external_id) — needed for the
   * conversations-endpoint fallback when the direct PSID read is
   * blocked. Instagram: the Page ID (channel source_id); unused today.
   */
  pageId?: string | null;
}): Promise<MetaProfile | null> {
  if (input.platform === 'messenger') {
    const direct = await fetchMessengerDirect(input.senderId, input.pageToken);
    if (direct) return direct;
    if (input.pageId) {
      const viaConversations = await fetchMessengerViaConversations(input.senderId, input.pageId, input.pageToken);
      if (viaConversations) return viaConversations;
    }
    return null;
  }
  const fields = 'name,username,profile_picture_url';
  const url = `${profileGraphBase()}/${encodeURIComponent(input.senderId)}?fields=${encodeURIComponent(fields)}`;
  try {
    const res = await fetchWithTimeout(
      url,
      { headers: { Authorization: `Bearer ${input.pageToken}` } },
      8000,
    );
    if (!res.ok) {
      const data = await readJson(res);
      console.warn(`[meta-profile] IG read failed for ${input.senderId}: HTTP ${res.status} ${graphErrorDetail(data)}`);
      return null;
    }
    const data = await readJson(res);
    if (!data) return null;
    const name = asNonEmptyString(data.name) ?? asNonEmptyString(data.username);
    const pictureUrl = asNonEmptyString(data.profile_picture_url);
    if (!name && !pictureUrl) return null;
    return { name, pictureUrl };
  } catch (err) {
    console.warn(`[meta-profile] IG read failed for ${input.senderId}: ${(err as Error).message}`);
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
  /** Messenger: the Page ID — enables the conversations-endpoint fallback. */
  pageId?: string | null;
}): Promise<void> {
  if (!input.pageToken) return;
  if (input.customerName && input.customerPictureUrl) return;
  const profile = await fetchMetaProfile({
    platform: input.platform,
    senderId: input.senderId,
    pageToken: input.pageToken,
    pageId: input.pageId ?? null,
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
