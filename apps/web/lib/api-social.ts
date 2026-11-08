// YouTube + TikTok live API helpers — videos, comments, replies, status.
// Uses the shared API_URL / token helpers from ./api (do not edit api.ts).
import { API_URL, ApiError, getToken } from "./api";

export interface SocialVideo {
  id: string;
  title: string;
  description?: string;
  publishedAt?: string | null;
  thumbnail?: string | null;
  coverImageUrl?: string | null;
  shareUrl?: string | null;
  createTime?: number | null;
  viewCount?: number | null;
  likeCount?: number | null;
  commentCount?: number | null;
}

export interface SocialComment {
  commentId: string;
  videoId: string;
  videoTitle?: string | null;
  author: string;
  authorAvatar?: string | null;
  text: string;
  publishedAt: string | null;
  likeCount: number;
  replyCount: number;
  replies?: { commentId: string; author: string; text: string; publishedAt: string | null }[];
}

export interface YoutubeStatus {
  configured: boolean;
  connected: boolean;
  channelId: string | null;
  channelName: string | null;
  hasUploadScope: boolean;
  needsReconnectForUpload: boolean;
  quota: {
    dailyLimitUnits: number;
    uploadCostUnits: number;
    uploadsToday: number;
    unitsUsed: number;
    unitsRemaining: number;
    maxUploadsPerDay: number;
  };
}

export interface TiktokStatus {
  configured: boolean;
  connected: boolean;
  channelId: string | null;
  channelName: string | null;
  scopes: string | null;
  audited: boolean;
  dmApproved: boolean;
  businessMessagingConfigured: boolean;
}

export interface InstagramStatus {
  connected: boolean;
  channelId: string | null;
  channelName: string | null;
  scopes: string | null;
  hasPublishScope: boolean;
  needsReconnectForPublish: boolean;
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
    throw new ApiError(0, "Server connection failed — is the API running?");
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

export const youtubeApi = {
  status: () => request<YoutubeStatus>("/api/youtube/status"),
  videos: () => request<{ videos: SocialVideo[] }>("/api/youtube/videos"),
  comments: (videoId?: string) =>
    request<{ comments: SocialComment[] }>(
      `/api/youtube/comments${videoId ? `?videoId=${encodeURIComponent(videoId)}` : ""}`
    ),
  reply: (commentId: string, text: string) =>
    request<{ replied: boolean; replyId: string }>(
      `/api/youtube/comments/${encodeURIComponent(commentId)}/reply`,
      { method: "POST", body: JSON.stringify({ text }) }
    ),
};

export const tiktokApi = {
  status: () => request<TiktokStatus>("/api/tiktok/status"),
  videos: () => request<{ videos: SocialVideo[]; hasMore: boolean; cursor: number }>("/api/tiktok/videos"),
  comments: (videoId: string) =>
    request<{ comments: SocialComment[]; hasMore: boolean; cursor: number }>(
      `/api/tiktok/comments?videoId=${encodeURIComponent(videoId)}`
    ),
  replies: (commentId: string) =>
    request<{ comments: SocialComment[] }>(
      `/api/tiktok/comments/${encodeURIComponent(commentId)}/replies`
    ),
  reply: (videoId: string, commentId: string, text: string) =>
    request<{ replied: boolean; replyId: string }>("/api/tiktok/comments/reply", {
      method: "POST",
      body: JSON.stringify({ videoId, commentId, text }),
    }),
  dmConversations: () =>
    request<{ conversations: { conversationId: string; updateTime: string | null }[] }>(
      "/api/tiktok/dm/conversations"
    ),
  syncDms: () =>
    request<{ imported: number; conversations: number; threadsRead: number }>("/api/tiktok/dm/sync", {
      method: "POST",
      body: JSON.stringify({}),
    }),
};

export const instagramApi = {
  status: () => request<InstagramStatus>("/api/instagram/status"),
};
