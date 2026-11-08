/**
 * Instagram publishing — the real Instagram Graph API publish flow
 * (Graph v21.0, Page access token stored on the 'instagram' channel row).
 *
 * Flow:
 *  1. Create a media container: POST /{ig-user-id}/media
 *     - image (1): {image_url, caption}
 *     - images (>1): one child container per image ({image_url,
 *       is_carousel_item: true}), then a parent container
 *       {media_type: 'CAROUSEL', children: '<id>,<id>', caption}
 *     - video (reel): {media_type: 'VIDEO', video_url, caption}
 *  2. Wait for the container to finish processing (video containers
 *     need it; image containers are usually FINISHED at once):
 *     GET /{container-id}?fields=status_code, polled up to ~60s.
 *  3. Publish it: POST /{ig-user-id}/media_publish
 *     {creation_id} → {id: "<the real Instagram media id>"}.
 *
 * A post counts as published ONLY when step 3 returns a real media id.
 * Media URLs must be publicly reachable (Vercel Blob URLs are; local
 * /api/uploads URLs are NOT — they need an auth token).
 *
 * Scope: publishing needs instagram_content_publish on the token. A
 * channel connected BEFORE that scope was added carries only the old
 * scopes (or NULL scopes on pre-migration rows) — hasPublishScope()
 * reads the granted scopes stored at connect time (migration 34) and
 * the publisher fails honestly with a "reconnect Instagram" message
 * instead of a cryptic Graph 403, exactly like the YouTube read-only
 * case. Never throws — every failure is returned as { ok: false, ... }.
 * Tokens are never put in a URL or a log line (Bearer header only).
 */
import { fetchWithTimeout } from '../ai-agent/http';
import { graphBase } from './meta-oauth';
import { queryOne } from '../db/pool';

export const INSTAGRAM_PUBLISH_SCOPE = 'instagram_content_publish';

export interface InstagramChannelRow {
  id: string;
  platform: string;
  external_id: string;
  display_name: string | null;
  token_encrypted: string | null;
  scopes: string | null;
  source_id: string | null;
}

/** The workspace's connected Instagram channel (most recent first). Null when none. */
export async function getInstagramChannel(workspaceId: string): Promise<InstagramChannelRow | null> {
  return queryOne<InstagramChannelRow>(
    workspaceId,
    `SELECT id, platform, external_id, display_name, token_encrypted, scopes, source_id FROM channels
     WHERE workspace_id = $1 AND platform = 'instagram' AND status = 'connected'
       AND token_encrypted IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`,
    [workspaceId],
  );
}

/** True when the stored granted scopes include instagram_content_publish. NULL scopes = connected before the scope existed = cannot publish. */
export function hasInstagramPublishScope(channel: { scopes: string | null } | null): boolean {
  if (!channel?.scopes) return false;
  return channel.scopes.split(/[\s,]+/).includes(INSTAGRAM_PUBLISH_SCOPE);
}

/** Bengali + English message telling the owner to reconnect Instagram so the publish scope is granted. */
export function instagramReconnectMessage(): string {
  return 'এই Instagram অ্যাকাউন্টটি পোস্ট প্রকাশের অনুমতি (instagram_content_publish) ছাড়া যুক্ত হয়েছে — পোস্ট করতে Channels পেজ থেকে Instagram আবার যুক্ত (reconnect) করুন, যাতে প্রকাশের অনুমতি আসে (Instagram was connected without the publish permission — reconnect Instagram on the Channels page to grant it)';
}

export interface InstagramPublishResult {
  ok: boolean;
  /** Instagram's real media id — never a stub id. */
  mediaId?: string;
  error?: string;
  code?: number;
  /** True when Graph refused for a missing permission — the owner must reconnect. */
  needsReconnect?: boolean;
}

interface GraphData {
  id?: string;
  status_code?: string;
  error?: { message?: string; code?: number; error_subcode?: number };
}

async function graphPost(
  url: string,
  pageToken: string,
  body: Record<string, unknown>,
  timeoutMs = 30000,
): Promise<{ ok: boolean; data: GraphData | null; error?: string; code?: number }> {
  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${pageToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );
    const data = (await res.json().catch(() => null)) as GraphData | null;
    if (!res.ok) {
      return {
        ok: false,
        data,
        error: data?.error?.message ?? `Instagram Graph request failed (HTTP ${res.status})`,
        code: data?.error?.code,
      };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, data: null, error: (err as Error).message };
  }
}

async function graphGetStatus(
  containerId: string,
  pageToken: string,
): Promise<{ ok: boolean; status?: string; error?: string; code?: number }> {
  try {
    const url = new URL(`${graphBase()}/${encodeURIComponent(containerId)}`);
    url.searchParams.set('fields', 'status_code');
    const res = await fetchWithTimeout(
      url.toString(),
      { method: 'GET', headers: { Authorization: `Bearer ${pageToken}` } },
      15000,
    );
    const data = (await res.json().catch(() => null)) as GraphData | null;
    if (!res.ok) {
      return {
        ok: false,
        error: data?.error?.message ?? `Instagram container status check failed (HTTP ${res.status})`,
        code: data?.error?.code,
      };
    }
    return { ok: true, status: data?.status_code };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** True when a Graph error means the token lacks the publish permission (missing scope / insufficient permission). */
function isScopeError(error: string | undefined, code: number | undefined): boolean {
  if (code === 10 || code === 200) return true;
  const msg = (error ?? '').toLowerCase();
  return (
    msg.includes('instagram_content_publish') ||
    msg.includes('permission') ||
    msg.includes('not authorized') ||
    (msg.includes('requires') && msg.includes('scope'))
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Publish one Instagram post for real. mediaType 'image' (1+ images;
 * >1 becomes a carousel) or 'video' (one reel). Caption may be empty.
 * Returns { ok: true, mediaId } only when Graph's media_publish
 * returns a real media id.
 */
export async function publishInstagramPost(input: {
  igUserId: string;
  pageToken: string;
  caption: string | null;
  mediaUrls: string[];
  mediaType: string | null;
}): Promise<InstagramPublishResult> {
  const caption = (input.caption ?? '').trim();
  const urls = input.mediaUrls ?? [];
  const mediaType = input.mediaType ?? (urls.length > 0 ? 'image' : 'text');
  const base = graphBase();
  const igId = encodeURIComponent(input.igUserId);

  if (mediaType === 'text' || urls.length === 0) {
    return {
      ok: false,
      error: 'Instagram-এ শুধু ছবি বা ভিডিও পোস্ট করা যায় — এই পোস্টে মিডিয়া নেই (Instagram needs an image or a video)',
    };
  }
  for (const u of urls) {
    if (!u.startsWith('http://') && !u.startsWith('https://')) {
      return {
        ok: false,
        error: 'Instagram-এ প্রকাশ করতে মিডিয়ার লিংকটি পাবলিক হতে হবে — ছবি/ভিডিওটি আবার আপলোড করুন (Instagram media must be a public URL — re-upload the media)',
      };
    }
  }

  // 1) Create the media container.
  let containerId: string | null = null;
  if (mediaType === 'image' && urls.length === 1) {
    const r = await graphPost(`${base}/${igId}/media`, input.pageToken, {
      image_url: urls[0],
      caption,
    });
    if (!r.ok) {
      return {
        ok: false,
        error: r.error,
        code: r.code,
        needsReconnect: isScopeError(r.error, r.code),
      };
    }
    if (typeof r.data?.id !== 'string') {
      return { ok: false, error: 'Instagram did not return a media container id' };
    }
    containerId = r.data.id;
  } else if (mediaType === 'image') {
    // Carousel: one child container per image, then the parent.
    const childIds: string[] = [];
    for (const u of urls) {
      const r = await graphPost(`${base}/${igId}/media`, input.pageToken, {
        image_url: u,
        is_carousel_item: true,
      });
      if (!r.ok) {
        return {
          ok: false,
          error: r.error,
          code: r.code,
          needsReconnect: isScopeError(r.error, r.code),
        };
      }
      if (typeof r.data?.id !== 'string') {
        return { ok: false, error: 'Instagram did not return a media container id' };
      }
      childIds.push(r.data.id);
    }
    const r = await graphPost(`${base}/${igId}/media`, input.pageToken, {
      media_type: 'CAROUSEL',
      children: childIds.join(','),
      caption,
    });
    if (!r.ok) {
      return {
        ok: false,
        error: r.error,
        code: r.code,
        needsReconnect: isScopeError(r.error, r.code),
      };
    }
    if (typeof r.data?.id !== 'string') {
      return { ok: false, error: 'Instagram did not return a media container id' };
    }
    containerId = r.data.id;
  } else if (mediaType === 'video') {
    const r = await graphPost(
      `${base}/${igId}/media`,
      input.pageToken,
      { media_type: 'VIDEO', video_url: urls[0], caption },
      60000,
    );
    if (!r.ok) {
      return {
        ok: false,
        error: r.error,
        code: r.code,
        needsReconnect: isScopeError(r.error, r.code),
      };
    }
    if (typeof r.data?.id !== 'string') {
      return { ok: false, error: 'Instagram did not return a media container id' };
    }
    containerId = r.data.id;
  } else {
    return { ok: false, error: `Unsupported media type: ${mediaType}` };
  }

  // 2) Wait until the container is FINISHED (video containers process
  // server-side; publishing too early fails). Poll up to ~60s.
  let ready = false;
  let lastStatus: string | undefined;
  for (let i = 0; i < 20; i++) {
    const st = await graphGetStatus(containerId, input.pageToken);
    if (!st.ok) {
      return { ok: false, error: st.error, code: st.code };
    }
    lastStatus = st.status;
    if (st.status === 'FINISHED') {
      ready = true;
      break;
    }
    if (st.status === 'ERROR') {
      return { ok: false, error: 'Instagram মিডিয়াটি প্রসেস করতে পারেনি — ছবি/ভিডিওটির ফরম্যাট বা সাইজ যাচাই করুন (Instagram could not process this media — check its format/size)' };
    }
    await sleep(3000);
  }
  if (!ready) {
    return {
      ok: false,
      error: `Instagram মিডিয়া প্রসেস হতে বেশি সময় নিচ্ছে (status: ${lastStatus ?? 'unknown'}) — পরে আবার চেষ্টা করা হবে (Instagram media is still processing — will retry later)`,
    };
  }

  // 3) Publish the container — only this step's id counts as published.
  const pub = await graphPost(`${base}/${igId}/media_publish`, input.pageToken, {
    creation_id: containerId,
  });
  if (!pub.ok) {
    return {
      ok: false,
      error: pub.error,
      code: pub.code,
      needsReconnect: isScopeError(pub.error, pub.code),
    };
  }
  if (typeof pub.data?.id !== 'string') {
    return { ok: false, error: 'Instagram did not return a media id' };
  }
  return { ok: true, mediaId: pub.data.id };
}
