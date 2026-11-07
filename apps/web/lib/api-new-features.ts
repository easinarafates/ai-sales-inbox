// API helpers for the Worker B features (saved replies, comments
// moderation, Agent Desk, team, website chat, setup, image match,
// handover, voice notes, follow-up warmth). Uses the shared `api` client
// from ./api — nothing here edits that file.
import { api, API_URL } from "./api";

export { API_URL };

export interface SavedReply {
  id: string;
  title: string;
  body: string;
  channel?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ModeratedComment {
  id: string;
  platform_post_id?: string | null;
  platform_comment_id?: string | null;
  body?: string | null;
  replied: boolean;
  status: string;
  reply_text?: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentInstruction {
  id: string;
  version: number;
  body: string;
  status: string;
  published_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface TeamInvite {
  id: string;
  email: string;
  role: string;
  token: string;
  status: string;
  inviteLink?: string;
  created_at: string;
}

export interface TeamMember {
  id: string;
  user_id: string;
  role: string;
  email?: string | null;
  name?: string | null;
  created_at: string;
}

export interface SetupProgress {
  steps: { step: string; completed: boolean }[];
  completedCount: number;
  totalSteps: number;
  testCodeVerified: boolean;
  testCode?: string;
  goLive: boolean;
}

export interface HandoverStatus {
  conversationId: string;
  mode: string;
  handedTo: string;
  handoverUntil?: string | null;
  handoverStartedAt?: string | null;
  active: boolean;
  expiresInSeconds: number;
}

export interface VoiceNote {
  id: string;
  conversation_id: string;
  transcript?: string | null;
  duration_sec?: number | null;
  audio_ref?: string | null;
  status: string;
  extracted?: Record<string, unknown> | null;
  order_id?: string | null;
  created_at: string;
}

export const savedRepliesApi = {
  list: (channel?: string) =>
    api.get<{ savedReplies: SavedReply[] }>(
      `/api/saved-replies${channel ? `?channel=${encodeURIComponent(channel)}` : ""}`
    ),
  create: (body: { title: string; body: string; channel?: string }) =>
    api.post<{ savedReply: SavedReply }>("/api/saved-replies", body),
  update: (id: string, body: { title?: string; body?: string; channel?: string | null }) =>
    api.patch<{ savedReply: SavedReply }>(`/api/saved-replies/${id}`, body),
  remove: (id: string) => api.del<{ deleted: boolean }>(`/api/saved-replies/${id}`),
};

export const commentsApi = {
  list: (status?: string) =>
    api.get<{ comments: ModeratedComment[] }>(
      `/api/comments${status ? `?status=${encodeURIComponent(status)}` : ""}`
    ),
  create: (body: { platformPostId?: string; platformCommentId?: string; body: string }) =>
    api.post<{ comment: ModeratedComment }>("/api/comments", body),
  answer: (id: string, text: string) =>
    api.post<{ comment: ModeratedComment }>(`/api/comments/${id}/answer`, { text }),
  hide: (id: string) => api.post<{ comment: ModeratedComment }>(`/api/comments/${id}/hide`, {}),
  like: (id: string) =>
    api.post<{ liked: boolean; alreadyLiked?: boolean }>(`/api/comments/${id}/like`, {}),
  markDone: (id: string) =>
    api.post<{ comment: ModeratedComment }>(`/api/comments/${id}/mark-done`, {}),
  remove: (id: string) => api.del<{ deleted: boolean }>(`/api/comments/${id}`),
};

export const agentDeskApi = {
  list: () =>
    api.get<{ instructions: AgentInstruction[]; active: AgentInstruction | null }>(
      "/api/agent-desk/instructions"
    ),
  createDraft: (body: string) =>
    api.post<{ instruction: AgentInstruction }>("/api/agent-desk/instructions", { body }),
  test: (question: string) =>
    api.post<{
      answer: string | null;
      aiAvailable: boolean;
      versionId: string;
      version: number;
      status: string;
      published: boolean;
      note?: string;
      provider?: string;
      model?: string;
      fallbackFrom?: string | null;
    }>("/api/agent-desk/test", { question }),
  publish: (versionId: string) =>
    api.post<{ instruction: AgentInstruction }>("/api/agent-desk/publish", { versionId }),
  revert: () =>
    api.post<{ instruction: AgentInstruction; revertedToVersion: number }>(
      "/api/agent-desk/revert",
      {}
    ),
};

export const teamApi = {
  list: () =>
    api.get<{ invites: TeamInvite[]; members: TeamMember[] }>("/api/team/invites"),
  invite: (email: string, role?: string) =>
    api.post<{ invite: TeamInvite; note?: string }>("/api/team/invites", { email, role }),
  revoke: (id: string) =>
    api.post<{ invite: TeamInvite }>(`/api/team/invites/${id}/revoke`, {}),
};

export const websiteChatApi = {
  settings: () =>
    api.get<{ publicKey: string; snippet: string; note?: string }>(
      "/api/website-chat/settings"
    ),
};

export const setupApi = {
  progress: () => api.get<{ progress: SetupProgress }>("/api/setup/progress"),
  completeStep: (step: string) =>
    api.post<{
      progress: SetupProgress;
      testCode?: string;
      message?: string;
      missingSteps?: string[];
    }>("/api/setup/complete-step", { step }),
  verifyTest: (code: string) =>
    api.post<{ verified: boolean; progress: SetupProgress }>("/api/setup/verify-test", {
      code,
    }),
};

export const imageMatchApi = {
  match: (imageRef: string) =>
    api.post<{
      available: boolean;
      matches: {
        productId: string;
        name: string;
        pricePaisa: number;
        stock: number;
        score: number;
      }[];
      uncertain: boolean;
      message?: string;
    }>("/api/image-match", { imageRef }),
};

export const handoverApi = {
  status: (conversationId: string) =>
    api.get<{ handover: HandoverStatus }>(`/api/inbox/${conversationId}/handover`),
  handover: (conversationId: string, durationHours: 1 | 4) =>
    api.post<{ handover: HandoverStatus }>(`/api/inbox/${conversationId}/handover`, {
      durationHours,
    }),
  returnToAi: (conversationId: string) =>
    api.post<{ handover: HandoverStatus }>(`/api/inbox/${conversationId}/return-to-ai`, {}),
};

export const voiceNotesApi = {
  list: (conversationId: string) =>
    api.get<{ voiceNotes: VoiceNote[] }>(`/api/inbox/${conversationId}/voice-notes`),
  create: (conversationId: string, body: { transcript?: string; durationSec?: number; audioRef?: string }) =>
    api.post<{
      voiceNote: VoiceNote;
      extracted: Record<string, unknown> | null;
      draftOrder: Record<string, unknown> | null;
      aiAvailable?: boolean;
      note?: string;
    }>(`/api/inbox/${conversationId}/voice-note`, body),
};

export const followupsWarmthApi = {
  list: (warmth?: string) =>
    api.get<{ followups: Record<string, unknown>[] }>(
      `/api/followups${warmth ? `?warmth=${encodeURIComponent(warmth)}` : ""}`
    ),
};
