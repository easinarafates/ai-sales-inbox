// Scheduling API helpers (Worker C) — Post Schedule upgrades.
// Uses the shared API_URL / token helpers from ./api (do not edit api.ts).
import { API_URL, ApiError, getToken } from "./api";

export type MediaType = "image" | "video" | "text";

export interface ScheduledPost {
  id: string;
  caption?: string | null;
  mediaUrls?: string[];
  media_urls?: string[];
  mediaType?: MediaType;
  media_type?: MediaType;
  platforms?: string[];
  scheduledAt?: string;
  scheduled_at?: string;
  status?: string;
  platformPostId?: string;
  platform_post_id?: string;
  createdAt?: string;
  created_at?: string;
  [key: string]: unknown;
}

export interface DayCounts {
  [date: string]: number;
}

export const MAX_POSTS_PER_DAY = 15;
export const WINDOW_DAYS = 7;

export function postMediaType(p: ScheduledPost): MediaType {
  return p.mediaType || p.media_type || "text";
}

export function postMediaUrls(p: ScheduledPost): string[] {
  return p.mediaUrls || p.media_urls || [];
}

/** Resolve a media URL to an absolute URL the browser can play/show. */
export function resolveMediaUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("/")) return `${API_URL}${url}`;
  return url;
}

export function isVideoUrl(url: string): boolean {
  return /\.(mp4|webm|mov|avi|mkv)(\?.*)?$/i.test(url);
}

/**
 * Fetch a (relative) upload URL with the auth token and return a blob
 * object URL for <img> / <video> previews. Needed because <img> and
 * <video> tags cannot send an Authorization header, and /api/uploads
 * currently sits behind the API's auth (see the note in
 * apps/api/src/scheduling/routes.ts — truly public serving needs a
 * one-line change in apps/api/src/index.ts by the coordinator).
 */
export async function fetchAuthedMediaUrl(url: string): Promise<string> {
  const token = getToken();
  const res = await fetch(`${API_URL}${url}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    throw new ApiError(res.status, `Could not load media (${res.status})`);
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { ...options, headers });
  } catch {
    throw new ApiError(
      0,
      "Server connection failed — is the API (http://localhost:4000) running?"
    );
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg =
      (data as { message?: string; error?: string } | null)?.message ||
      (data as { message?: string; error?: string } | null)?.error ||
      `Request failed (${res.status})`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export interface ScheduledListResponse {
  posts: ScheduledPost[];
  counts: DayCounts;
  maxPerDay: number;
  windowDays: number;
}

/**
 * Base64 JSON upload (local dev / cPanel fallback). The file is read as
 * base64 in the browser and sent as JSON to POST /api/scheduled-posts/
 * upload, which stores it on disk and returns /api/uploads/<file>.
 * Works up to 25 MB locally; on Vercel the function body cap is 4.5 MB,
 * so the Blob path above is preferred there.
 */
function uploadFileBase64(file: File): Promise<{
  url: string;
  mediaType: MediaType;
  mimeType: string;
  sizeBytes: number;
}> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the file."));
    reader.onload = async () => {
      try {
        const dataUrl = String(reader.result || "");
        const res = await request<{
          url: string;
          mediaType: MediaType;
          mimeType: string;
          sizeBytes: number;
        }>("/api/scheduled-posts/upload", {
          method: "POST",
          body: JSON.stringify({
            fileBase64: dataUrl,
            fileName: file.name,
            mimeType: file.type,
          }),
        });
        resolve(res);
      } catch (err) {
        reject(err);
      }
    };
    reader.readAsDataURL(file);
  });
}

export const schedulingApi = {
  list: (params?: { status?: string; platform?: string }) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set("status", params.status);
    if (params?.platform) qs.set("platform", params.platform);
    const s = qs.toString();
    return request<ScheduledListResponse>(`/api/scheduled-posts${s ? `?${s}` : ""}`);
  },
  calendar: (month: string) =>
    request<{
      month: string;
      days: Record<string, ScheduledPost[]>;
      counts: DayCounts;
      maxPerDay: number;
      windowDays: number;
    }>(`/api/scheduled-posts/calendar?month=${encodeURIComponent(month)}`),
  create: (body: {
    caption: string;
    mediaUrls?: string[];
    mediaType?: MediaType;
    platforms: string[];
    scheduledAt?: string;
    productIds?: string[];
  }) => request<{ post: ScheduledPost }>("/api/scheduled-posts", {
    method: "POST",
    body: JSON.stringify(body),
  }),
  update: (id: string, body: {
    caption?: string;
    mediaUrls?: string[];
    mediaType?: MediaType;
    scheduledAt?: string | null;
    status?: string;
  }) => request<{ post: ScheduledPost }>(`/api/scheduled-posts/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  }),
  remove: (id: string) =>
    request<{ deleted: boolean }>(`/api/scheduled-posts/${id}`, { method: "DELETE" }),
  cancel: (id: string) =>
    request<{ post: ScheduledPost }>(`/api/scheduled-posts/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "cancelled" }),
    }),
  schedule: (id: string, scheduledAt: string) =>
    request<{ post: ScheduledPost }>(`/api/scheduled-posts/${id}/schedule`, {
      method: "POST",
      body: JSON.stringify({ scheduledAt }),
    }),
  publishNow: (id: string) =>
    request<{ post: ScheduledPost }>(`/api/scheduled-posts/${id}/publish-now`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  attachProduct: (id: string, productId: string) =>
    request<unknown>(`/api/scheduled-posts/${id}/attach-product`, {
      method: "POST",
      body: JSON.stringify({ productId }),
    }),
  aiCaption: (id: string, productIds?: string[]) =>
    request<{ caption: string; aiGenerated?: boolean }>(
      `/api/scheduled-posts/${id}/ai-caption`,
      { method: "POST", body: JSON.stringify({ productIds }) }
    ),
  /** Auto caption generator — 2–3 options from real product data.
   * Pass mediaUrls when media is attached: Gemini vision analyzes the
   * image/video and its caption comes first, with mediaAnalysis
   * describing what the AI saw. Without media, text-only captions. */
  autoCaption: (body: { productIds?: string[]; topic?: string; lang?: "en" | "bn"; mediaUrls?: string[] }) =>
    request<{ options: string[]; aiGenerated: boolean; note?: string; mediaAnalysis?: { analysis: string; mediaType: MediaType } }>(
      "/api/scheduled-posts/auto-caption",
      { method: "POST", body: JSON.stringify(body) }
    ),
  /**
   * Upload a media file. Vercel path (preferred): the file goes straight
   * from the browser to Vercel Blob via @vercel/blob/client, using a
   * client token from POST /api/scheduled-posts/upload-token — this
   * bypasses the API function's 4.5 MB request-body cap, so the full
   * 25 MB limit works. If Blob is not configured (local dev / cPanel —
   * the token route answers 503), it falls back to the base64 JSON
   * upload below. Returns the servable URL (a public Blob URL on
   * Vercel, /api/uploads/<file> locally).
   */
  uploadFile: async (file: File) => {
    const token = getToken();
    try {
      const { upload } = await import("@vercel/blob/client");
      const blob = await upload(file.name, file, {
        access: "public",
        handleUploadUrl: `${API_URL}/api/scheduled-posts/upload-token`,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      return {
        url: blob.url,
        mediaType: (file.type.startsWith("video/") ? "video" : "image") as MediaType,
        mimeType: file.type,
        sizeBytes: file.size,
      };
    } catch (err) {
      // Blob unavailable (token route 503 locally / on cPanel, or any
      // Blob failure): fall back to the base64 API upload.
      console.warn("[scheduling] Blob upload unavailable, falling back to base64 upload:", err);
      return uploadFileBase64(file);
    }
  },
  /** Register an existing image/video URL as post media. */
  uploadUrl: (mediaUrl: string) =>
    request<{ url: string; mediaType: MediaType; mimeType: string | null }>(
      "/api/scheduled-posts/upload",
      { method: "POST", body: JSON.stringify({ mediaUrl }) }
    ),
};
