// API helpers for the AI Providers settings page (multi-provider AI:
// Groq / OpenAI ChatGPT / Gemini / Claude). Uses the shared `api` client
// from ./api — nothing here edits that file.
import { api } from "./api";

export type AiProviderStatus = "connected" | "key_missing" | "blocked";

export interface AiProviderInfo {
  id: string;
  name: string;
  models: string[];
  defaultModel: string;
  status: AiProviderStatus;
  blockedReason?: string | null;
  mock?: boolean;
  costNote: string;
}

export interface AiCurrentChoice {
  provider: string;
  model: string;
  explicit: boolean;
}

export interface AiUsageRow {
  id: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_paisa: number;
  provider_cost_paisa: number;
  fallback_from?: string | null;
  included_in_plan: boolean;
  created_at: string;
}

export interface AiProvidersData {
  providers: AiProviderInfo[];
  current: AiCurrentChoice;
  recentUsage: AiUsageRow[];
}

export interface AiSelectResult {
  current: AiCurrentChoice;
  providers: AiProviderInfo[];
  warning?: string;
  reset?: boolean;
}

export const aiProvidersApi = {
  get: () => api.get<AiProvidersData>("/api/ai-providers"),
  select: (provider: string, model?: string) =>
    api.post<AiSelectResult>("/api/ai-providers/select", { provider, model }),
  resetToSystem: () =>
    api.post<AiSelectResult>("/api/ai-providers/select", { provider: "system" }),
};
