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
 *   GET /{page-id}/conversations?user_id={psid}&fields=participants{name,picture{url}}
 *   and take the participant whose id matches the sender. That endpoint
 *   returns the real name even when the direct read is blocked.
 *
 * LIVE PROBE RESULTS (2026-11-07, two real Page tokens, v21.0 + v27.0):
 * - Direct PSID read fails 400 #100/33 for the test sender on BOTH
 *   tokens (gd_arafat's 01:38 token and the fresh OUR TEAM token) — even
 *   `?fields=id`. debug_token confirms both tokens DO have
 *   pages_messaging granted for Halal Chic, so this is not a scope
 *   problem. Meta's bug portal notes phone-number-registered users are
 *   "not yet queryable by the API" — the test sender registered by phone.
 * - The conversations/messages edges return the name but STRIP the
 *   `picture` field entirely for page-scoped users (all of
 *   `picture`, `picture{url}`, `picture.type(large)` return 200 with no
 *   picture key, for the customer AND the Page participant). So for this
 *   sender Meta gives no photo on any route — picture_url stays NULL
 *   and the Inbox shows the initials avatar. This is a platform limit,
 *   not a code bug.
 * - The Page's OWN picture DOES work (GET /{page-id}?fields=picture)
 *   — but it is the Page's photo, never a customer's, so it is never
 *   stored as a customer photo.
 * - GET /{psid}/picture?redirect=false was ALSO probed live (2026-11-07,
 *   both Page tokens, v21.0 + v27.0): 400 GraphMethodException #100/33
 *   on every attempt — the same object-access block as the direct PSID
 *   read. It adds nothing beyond the paths above, so it is NOT wired in
 *   as a fallback for the PAGE token; do not re-probe it for this sender.
 *   (It IS tried with the USER token below — a different credential.)
 * - GET /{psid}/ids_for_apps was ALSO probed live (2026-11-07, both
 *   Page tokens, v21.0): 400 GraphMethodException #100/33 on every
 *   attempt. The PSID object cannot be loaded at all with a Page token,
 *   so the sender cannot be matched to the Facebook user who connected
 *   the Page this way. NOT wired in; do not re-probe it.
 *
 * USER TOKEN (migration 20) — the remaining automatic route. The
 * Facebook OAuth connect flow now stores the connecting Page admin's
 * long-lived USER token (encrypted) + app-scoped user ID on the channel
 * row. When the Page-token paths above yield no photo, the same three
 * routes are retried with the user token (direct read, conversations
 * participants, /{psid}/picture) — a different credential may return
 * what the Page token cannot. No user token is stored for channels
 * connected before this change; they get one only on the next reconnect.
 * LIVE STATUS (2026-11-07): no user token exists yet for any channel,
 * so the user-token routes have NOT been tried live — they are wired
 * and covered by the verifier's stub, and the first real attempt will
 * happen on the first message after a Page is reconnected. If Meta
 * blocks the PSID for the user token too, the photo stays NULL.
 *
 * OWNER PHOTO — when the sender IS the Page owner (the workspace's
 * marked owner_psid), GET /me/picture?redirect=false with the stored
 * user token returns the owner's own Facebook photo directly, without
 * ever needing the PSID to load. That is the route that can give the
 * test sender (the owner himself) his original photo. It only runs
 * for the marked owner, never for other customers.
 *
 * The pipeline below already stores a photo whenever Graph returns
 * one, so other (e.g. email-registered) customers' photos WILL show
 * automatically when Meta returns them — no code change needed for
 * that. The Inbox initials avatar uses a per-customer colour so
 * customers stay recognisable even without a photo.
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
 * - A MANUALLY uploaded photo (picture_source='manual', set by the shop
 *   owner from the Inbox) is never overwritten or cleared by a Meta
 *   refresh — the refresh skips the picture fill entirely for these
 *   customers, even when Graph returns a different photo or none at
 *   all. A Meta photo is stored with picture_source='meta'.
 * - Tokens are never put in a URL or a log line (Bearer header only).
 * - A photo is used only when Graph actually returns one; never invent
 *   a photo URL — the Inbox falls back to initials.
 */
import { fetchWithTimeout } from '../ai-agent/http';
import { GRAPH_BASE } from './meta-oauth';
import { inferGenderFromName } from '../customers/gender';
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
 * `label` ('page' | 'user') only marks which token was used, for logs.
 */
async function fetchMessengerDirect(senderId: string, token: string, label: string): Promise<MetaProfile | null> {
  const url = `${profileGraphBase()}/${encodeURIComponent(senderId)}?fields=${encodeURIComponent('first_name,last_name,profile_pic')}`;
  let res: Awaited<ReturnType<typeof fetchWithTimeout>>;
  try {
    res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } }, 8000);
  } catch (err) {
    console.warn(`[meta-profile] direct read (${label} token) failed for ${senderId}: ${(err as Error).message}`);
    return null;
  }
  if (!res.ok) {
    const data = await readJson(res);
    console.warn(`[meta-profile] direct read (${label} token) failed for ${senderId}: HTTP ${res.status} ${graphErrorDetail(data)}`);
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
 * &fields=participants{name,picture{url}}. The conversations endpoint returns
 * the participant's real name even when the direct PSID read is blocked
 * (GraphMethodException #100/33). NOTE (live probe 2026-11-07): Meta strips
 * the picture field for page-scoped users on this edge, so for senders
 * like our test customer the participant carries a name but no picture —
 * the code below then stores the name and leaves picture_url NULL.
 * Participants may be a plain array or a Graph edge object { data: [...] } — both shapes are handled.
 */
async function fetchMessengerViaConversations(
  senderId: string,
  pageId: string,
  token: string,
  label: string,
): Promise<MetaProfile | null> {
  const url = `${profileGraphBase()}/${encodeURIComponent(pageId)}/conversations?user_id=${encodeURIComponent(senderId)}&fields=${encodeURIComponent('participants{name,picture{url}}')}`;
  let res: Awaited<ReturnType<typeof fetchWithTimeout>>;
  try {
    res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } }, 8000);
  } catch (err) {
    console.warn(`[meta-profile] conversations fallback (${label} token) failed for ${senderId}: ${(err as Error).message}`);
    return null;
  }
  if (!res.ok) {
    const data = await readJson(res);
    console.warn(`[meta-profile] conversations fallback (${label} token) failed for ${senderId}: HTTP ${res.status} ${graphErrorDetail(data)}`);
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
 * GET /{psid}/picture?redirect=false — returns the photo URL, or null.
 * A silhouette (is_silhouette=true) is Meta's placeholder, not a real
 * photo, so it is ignored. NOTE: with the PAGE token this endpoint is
 * 400 #100/33 for the test sender (live probe 2026-11-07) — it is only
 * called here with the USER token, where it may behave differently.
 */
async function fetchMessengerPicture(senderId: string, token: string, label: string): Promise<string | null> {
  const url = `${profileGraphBase()}/${encodeURIComponent(senderId)}/picture?redirect=false`;
  let res: Awaited<ReturnType<typeof fetchWithTimeout>>;
  try {
    res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } }, 8000);
  } catch (err) {
    console.warn(`[meta-profile] picture read (${label} token) failed for ${senderId}: ${(err as Error).message}`);
    return null;
  }
  if (!res.ok) {
    const data = await readJson(res);
    console.warn(`[meta-profile] picture read (${label} token) failed for ${senderId}: HTTP ${res.status} ${graphErrorDetail(data)}`);
    return null;
  }
  const data = await readJson(res);
  const pic = (data?.data ?? null) as { url?: unknown; is_silhouette?: unknown } | null;
  if (pic?.is_silhouette === true) return null;
  return asNonEmptyString(pic?.url);
}

/**
 * The Page owner's own photo: GET /me/picture?redirect=false with the
 * stored USER token. Needs no PSID at all, so it works even when Meta
 * refuses to load the sender's PSID object. Only ever called for the
 * workspace's marked owner (owner_psid). A silhouette is ignored.
 */
async function fetchOwnerPicture(userToken: string): Promise<string | null> {
  const url = `${profileGraphBase()}/me/picture?redirect=false`;
  let res: Awaited<ReturnType<typeof fetchWithTimeout>>;
  try {
    res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${userToken}` } }, 8000);
  } catch (err) {
    console.warn(`[meta-profile] owner picture read failed: ${(err as Error).message}`);
    return null;
  }
  if (!res.ok) {
    const data = await readJson(res);
    console.warn(`[meta-profile] owner picture read failed: HTTP ${res.status} ${graphErrorDetail(data)}`);
    return null;
  }
  const data = await readJson(res);
  const pic = (data?.data ?? null) as { url?: unknown; is_silhouette?: unknown } | null;
  if (pic?.is_silhouette === true) return null;
  return asNonEmptyString(pic?.url);
}

/**
 * Fetch one sender's profile from Graph. Never throws — every failure
 * is returned as null (the caller falls back to "Unknown") and logged.
 */
export async function fetchMetaProfile(input: {
  platform: 'messenger' | 'instagram';
  /** Messenger: customer PSID. Instagram: IG-scoped user ID. */
  senderId: string;
  /** Page access token (Bearer). Null when the channel has none. */
  pageToken: string | null;
  /**
   * Messenger: the Page ID (channel external_id) — needed for the
   * conversations-endpoint fallback when the direct PSID read is
   * blocked. Instagram: the Page ID (channel source_id); unused today.
   */
  pageId?: string | null;
  /**
   * The connecting Facebook user's long-lived token (migration 20).
   * When the Page-token routes yield no photo, the same routes are
   * retried with this token — a different credential may return what
   * the Page token cannot. Null for channels connected before the
   * token was stored (until the next reconnect).
   */
  userToken?: string | null;
}): Promise<MetaProfile | null> {
  // Results are MERGED across attempts, not short-circuited: a
  // name-only hit (e.g. the Page-token conversations fallback, which
  // returns a name but strips the picture) must not stop the
  // user-token attempts that could still provide the photo. Stops
  // early only once both a name and a picture are known.
  let best: MetaProfile | null = null;
  const consider = (p: MetaProfile | null): void => {
    if (!p) return;
    best = { name: best?.name ?? p.name, pictureUrl: best?.pictureUrl ?? p.pictureUrl };
  };
  const needMore = (): boolean => !best || !best.name || !best.pictureUrl;
  if (input.platform === 'messenger') {
    if (input.pageToken) {
      consider(await fetchMessengerDirect(input.senderId, input.pageToken, 'page'));
      if (input.pageId && needMore()) {
        consider(await fetchMessengerViaConversations(input.senderId, input.pageId, input.pageToken, 'page'));
      }
    }
    // USER-token retry (migration 20): the Page token cannot load some
    // senders at all (400 #100/33 on every PSID route). The admin's own
    // token is worth one attempt on the same three routes.
    if (input.userToken && input.userToken !== input.pageToken) {
      if (needMore()) consider(await fetchMessengerDirect(input.senderId, input.userToken, 'user'));
      if (input.pageId && needMore()) {
        consider(await fetchMessengerViaConversations(input.senderId, input.pageId, input.userToken, 'user'));
      }
      if (needMore()) {
        const uPic = await fetchMessengerPicture(input.senderId, input.userToken, 'user');
        if (uPic) consider({ name: null, pictureUrl: uPic });
      }
    }
    return best;
  }
  const fields = 'name,username,profile_picture_url';
  // Page token first, then the user token when it differs (and when
  // there is no Page token at all, the user token alone).
  const attempts = [input.pageToken, input.userToken].filter(
    (t, i, arr): t is string => !!t && arr.indexOf(t) === i,
  );
  for (const token of attempts) {
    const url = `${profileGraphBase()}/${encodeURIComponent(input.senderId)}?fields=${encodeURIComponent(fields)}`;
    try {
      const res = await fetchWithTimeout(
        url,
        { headers: { Authorization: `Bearer ${token}` } },
        8000,
      );
      if (!res.ok) {
        const data = await readJson(res);
        console.warn(`[meta-profile] IG read failed for ${input.senderId}: HTTP ${res.status} ${graphErrorDetail(data)}`);
        continue;
      }
      const data = await readJson(res);
      if (!data) continue;
      const name = asNonEmptyString(data.name) ?? asNonEmptyString(data.username);
      const pictureUrl = asNonEmptyString(data.profile_picture_url);
      if (!name && !pictureUrl) continue;
      consider({ name, pictureUrl });
      if (!needMore()) break;
    } catch (err) {
      console.warn(`[meta-profile] IG read failed for ${input.senderId}: ${(err as Error).message}`);
    }
  }
  return best;
}

/**
 * Fill in a customer's missing name/picture from Graph, best-effort.
 * Skips the fetch entirely when the customer already has both, or when
 * there is no token at all. Never throws — a failure is logged by the
 * caller and the message flow continues.
 *
 * Order of attempts (Messenger): Page-token direct read → Page-token
 * conversations fallback → user-token direct read → user-token
 * conversations fallback → user-token /{psid}/picture → (owner only)
 * /me/picture with the user token. The first route that returns a
 * picture wins; a name is filled from whichever route returns one.
 *
 * Manual-photo protection: when picture_source is 'manual' the stored
 * picture is the shop owner's upload — the refresh never touches it
 * (not even when Graph returns a different photo or no photo). Only
 * the name is still filled in when missing. A photo Graph returns for
 * a customer with no photo yet is stored with picture_source='meta'.
 */
export async function enrichCustomerProfileIfNeeded(input: {
  workspaceId: string;
  platform: 'messenger' | 'instagram';
  senderId: string;
  customerId: string;
  customerName: string | null;
  /** True once the owner corrected the name by hand (migration 23) — the Meta refresh must NEVER overwrite it with the Facebook-returned name again. */
  customerNameManuallySet?: boolean | null;
  /** Stored gender ('male' | 'female' | 'unknown' | null) — only filled when 'unknown'/null, and only from a name that was just filled. A hand-set gender is never overwritten. */
  customerGender?: string | null;
  customerPictureUrl: string | null;
  /** 'manual' = shop-owner upload (never overwritten); 'meta' = from Graph; null = no photo yet. */
  customerPictureSource?: string | null;
  pageToken: string | null;
  /** The connecting user's long-lived token (migration 20) — null until the Page is reconnected. */
  userToken?: string | null;
  /** The workspace's marked owner PSID (workspaces.owner_psid) — null when nobody is marked. */
  ownerPsid?: string | null;
  /** Messenger: the Page ID — enables the conversations-endpoint fallback. */
  pageId?: string | null;
}): Promise<void> {
  if (!input.pageToken && !input.userToken) return;
  const pictureIsManual = input.customerPictureSource === 'manual';
  // A manually set name is final: the refresh never even considers
  // filling the name for this customer, so the Facebook-returned name
  // can never overwrite the owner's correction on a later message.
  const nameManuallySet = input.customerNameManuallySet === true;
  const needName = !input.customerName && !nameManuallySet;
  const needPicture = !input.customerPictureUrl && !pictureIsManual;
  if (!needName && !needPicture) return;
  const profile = await fetchMetaProfile({
    platform: input.platform,
    senderId: input.senderId,
    pageToken: input.pageToken,
    pageId: input.pageId ?? null,
    userToken: input.userToken ?? null,
  });
  // Manual name: kept exactly as the owner typed it — the Graph name is
  // ignored entirely, even if the stored name were ever missing.
  let name = nameManuallySet ? input.customerName : (input.customerName ?? profile?.name ?? null);
  let pictureUrl = pictureIsManual
    ? input.customerPictureUrl
    : (input.customerPictureUrl ?? profile?.pictureUrl ?? null);
  // Owner route: when the sender IS the Page owner, /me/picture with
  // the user token is the owner's own Facebook photo — no PSID lookup
  // needed, so it works even when Meta refuses to load the PSID.
  if (
    needPicture &&
    !pictureUrl &&
    input.userToken &&
    input.ownerPsid &&
    input.senderId === input.ownerPsid
  ) {
    const ownerPic = await fetchOwnerPicture(input.userToken);
    if (ownerPic) pictureUrl = ownerPic;
  }
  const pictureSource = pictureIsManual
    ? 'manual'
    : !input.customerPictureUrl && pictureUrl
      ? 'meta'
      : (input.customerPictureSource ?? null);
  // Gender: only when the name was JUST filled (it was missing before)
  // and the stored gender is still 'unknown'/null. A name the customer
  // already had does not re-trigger this — the gender for it was set at
  // creation or by the backfill — and a hand-set gender is never touched.
  const nameWasFilled = !nameManuallySet && name !== input.customerName && !!name;
  const genderUnknown = !input.customerGender || input.customerGender === 'unknown';
  const gender = nameWasFilled && genderUnknown ? inferGenderFromName(name) : (input.customerGender ?? 'unknown');
  if (name === input.customerName && pictureUrl === input.customerPictureUrl && pictureSource === (input.customerPictureSource ?? null) && gender === (input.customerGender ?? 'unknown')) return;
  await query(
    input.workspaceId,
    'UPDATE customers SET name = $1, picture_url = $2, picture_source = $3, gender = $4, updated_at = now() WHERE workspace_id = $5 AND id = $6',
    [name, pictureUrl, pictureSource, gender, input.workspaceId, input.customerId],
  );
}
