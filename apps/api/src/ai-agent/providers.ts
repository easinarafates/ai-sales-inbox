/**
 * Unified AI provider interface — Groq / OpenAI (ChatGPT) / Gemini / Claude.
 *
 * Every provider returns the same contract the sales agent already uses:
 * { text, inputTokens, outputTokens } where text is a Bengali JSON reply
 * ({"reply", "confidence", "toolCalls"}). Prices/stock still come ONLY
 * from the products table via tools — the provider never invents them.
 *
 * Rules:
 * - A provider with no API key returns null (never a fake reply).
 * - A provider call that throws (401/403/429/5xx) lets the caller fall
 *   back to Groq (the free working provider). The fallback is recorded in
 *   the ledger (fallback_from) and logged — never silent.
 * - Gemini's key exists but generation is BLOCKED on this Google Cloud
 *   project (HTTP 403 "free tier is not available", needs billing): the
 *   status endpoint reports it as blocked with that reason, and the
 *   dispatcher still tries it first when chosen (billing may have been
 *   enabled since) — on failure it falls back to Groq.
 * - Test-only mocks (AI_MOCK_PROVIDERS env, e.g. "openai,claude") make a
 *   provider answer with a canned deterministic reply WITHOUT calling the
 *   real API, so the verifier can test dispatch/fallback/cost math
 *   without spending money or needing a key. OFF by default.
 */
import { config } from '../config';
import { queryOne } from '../db/pool';
import { callGemini, type GeminiResult } from './gemini';
import { callGroq } from './groq';
import { callOpenAI } from './openai';
import { callClaude } from './claude';

export type AiProviderId = 'groq' | 'openai' | 'gemini' | 'claude';

export const AI_PROVIDERS: AiProviderId[] = ['groq', 'openai', 'gemini', 'claude'];

export function isAiProviderId(value: unknown): value is AiProviderId {
  return typeof value === 'string' && (AI_PROVIDERS as string[]).includes(value);
}

export interface AiCallOutcome extends GeminiResult {
  provider: AiProviderId;
  model: string;
  /** The provider the workspace chose, when Groq served the reply instead. */
  fallbackFrom?: AiProviderId | null;
}

export type AiProviderStatus = 'connected' | 'key_missing' | 'blocked';

export interface AiProviderInfo {
  id: AiProviderId;
  name: string;
  models: string[];
  defaultModel: string;
  status: AiProviderStatus;
  blockedReason?: string | null;
  /** Test-only mock is active for this provider (no real API call made). */
  mock?: boolean;
  /** Human-readable cost note (Bengali) for the settings page. */
  costNote: string;
}

/** Canned reply used ONLY by the test mock (never a live answer).
 * Token counts (20,000 in / 10,000 out) are deliberately large so the
 * verifier can assert cost math exactly: gpt-6-luna $0.10/$0.50 gives
 * (0.02 x 0.10 + 0.01 x 0.50) x 12200 = 85 paisa; claude-sonnet-5-5
 * $2/$10 gives (0.02 x 2 + 0.01 x 10) x 12200 = 1708 paisa. */
const MOCK_REPLY =
  '{"reply": "দাম জানতে চেয়েছেন — প্রোডাক্টের দাম টুল থেকে দেখে জানাচ্ছি।", "confidence": 0.9, "toolCalls": []}';

function mockProviders(): Set<string> {
  return new Set(
    config.aiMockProviders
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function isMockProvider(provider: AiProviderId): boolean {
  return mockProviders().has(provider);
}

function mockResult(provider: AiProviderId, model: string): AiCallOutcome {
  return { text: MOCK_REPLY, inputTokens: 20000, outputTokens: 10000, provider, model };
}

/** Model lists (defaults come from config — never hardcoded elsewhere). */
export function providerModels(provider: AiProviderId): string[] {
  const unique = (...models: string[]): string[] => [...new Set(models)];
  switch (provider) {
    case 'groq':
      return unique(config.groqModel, 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b');
    case 'openai':
      // gpt-6-luna is the verified current model on OpenAI's pricing page;
      // gpt-4o-mini / gpt-4o stay selectable (secondary sources report
      // both are removed from the API on 2027-01-14).
      return unique(config.openaiModel, 'gpt-6-luna', 'gpt-4o-mini', 'gpt-4o');
    case 'gemini':
      return [config.aiModel];
    case 'claude':
      return unique(config.claudeModel, 'claude-haiku-5-5');
  }
}

export function providerDefaultModel(provider: AiProviderId): string {
  return providerModels(provider)[0];
}

function providerName(provider: AiProviderId): string {
  switch (provider) {
    case 'groq':
      return 'Groq';
    case 'openai':
      return 'ChatGPT (OpenAI)';
    case 'gemini':
      return 'Gemini (Google)';
    case 'claude':
      return 'Claude (Anthropic)';
  }
}

function providerCostNote(provider: AiProviderId): string {
  switch (provider) {
    case 'groq':
      return 'ফ্রি — প্রতি রিপ্লাই ৳০ (ফ্রি টিয়ার: দিনে ১,০০০ উত্তর)';
    case 'openai':
      return 'পেইড — টোকেন হিসেবে খরচ (gpt-6-luna: $0.10 / $0.50 প্রতি ১০ লাখ টোকেন)';
    case 'gemini':
      return 'পেইড — টোকেন হিসেবে খরচ; এই প্রজেক্টে এখন ব্লকড (বিলিং লাগবে)';
    case 'claude':
      return 'পেইড — টোকেন হিসেবে খরচ (Claude Sonnet 5.5: $2 / $10 প্রতি ১০ লাখ টোকেন)';
  }
}

/**
 * Status of one provider: 'connected' (key present, or test mock),
 * 'key_missing' (no key — never selectable as live), or 'blocked'
 * (Gemini: key present but Google blocks generation on this project
 * until billing is enabled — HTTP 403).
 */
export function providerInfo(provider: AiProviderId): AiProviderInfo {
  const mock = isMockProvider(provider);
  const keyPresent =
    provider === 'groq'
      ? !!config.groqApiKey
      : provider === 'openai'
        ? !!config.openaiApiKey
        : provider === 'gemini'
          ? !!config.geminiApiKey
          : !!config.anthropicApiKey;
  let status: AiProviderStatus = 'key_missing';
  let blockedReason: string | null = null;
  if (mock) {
    status = 'connected';
  } else if (keyPresent) {
    if (provider === 'gemini') {
      status = 'blocked';
      blockedReason =
        'Google এই প্রজেক্টে ফ্রি ব্যবহার বন্ধ করেছে (HTTP 403 — বিলিং চালু করতে হবে, কমপক্ষে $30)। বিলিং চালু না হওয়া পর্যন্ত Gemini উত্তর দেবে না, Groq দিয়ে চলবে।';
    } else {
      status = 'connected';
    }
  }
  return {
    id: provider,
    name: providerName(provider),
    models: providerModels(provider),
    defaultModel: providerDefaultModel(provider),
    status,
    blockedReason,
    mock: mock || undefined,
    costNote: providerCostNote(provider),
  };
}

export function allProviderInfo(): AiProviderInfo[] {
  return AI_PROVIDERS.map(providerInfo);
}

/**
 * Call one provider directly. Returns null when it is not configured
 * (no key and no mock); throws on API errors so the caller can fall back.
 */
export async function callProvider(
  provider: AiProviderId,
  prompt: string,
  model?: string,
): Promise<AiCallOutcome | null> {
  const resolvedModel = model ?? providerDefaultModel(provider);
  if (isMockProvider(provider)) return mockResult(provider, resolvedModel);
  let result: GeminiResult | null;
  switch (provider) {
    case 'groq':
      result = await callGroq(prompt, resolvedModel);
      break;
    case 'openai':
      result = await callOpenAI(prompt, resolvedModel);
      break;
    case 'gemini':
      result = await callGemini(prompt, resolvedModel);
      break;
    case 'claude':
      result = await callClaude(prompt, resolvedModel);
      break;
  }
  return result ? { ...result, provider, model: resolvedModel } : null;
}

export interface WorkspaceAiChoice {
  provider: AiProviderId;
  model: string;
  /** True when the owner picked this explicitly; false = system default. */
  explicit: boolean;
}

/**
 * The workspace's AI choice: explicit ai_provider/ai_model columns win;
 * NULL columns mean "system default" (AI_PROVIDER env, default groq in
 * this repo's .env). An invalid stored value falls back to the env default
 * instead of crashing. Pass the already-loaded workspace row when the
 * caller has it, to avoid a second query.
 */
export async function resolveWorkspaceAi(
  workspaceId: string,
  preloaded?: { ai_provider?: string | null; ai_model?: string | null },
): Promise<WorkspaceAiChoice> {
  const envProvider: AiProviderId = isAiProviderId(config.aiProvider) ? config.aiProvider : 'groq';
  const row =
    preloaded ??
    (await queryOne<{ ai_provider: string | null; ai_model: string | null }>(
      workspaceId,
      'SELECT ai_provider, ai_model FROM workspaces WHERE id = $1',
      [workspaceId],
    ).catch(() => null));
  if (row && isAiProviderId(row.ai_provider)) {
    const provider = row.ai_provider;
    const model = row.ai_model?.trim()
      ? row.ai_model.trim()
      : providerDefaultModel(provider);
    return { provider, model, explicit: true };
  }
  return { provider: envProvider, model: providerDefaultModel(envProvider), explicit: false };
}

/**
 * The agent's entry point: call the workspace's chosen provider, and on
 * any failure (no key, or an API error like Gemini's 403) fall back to
 * Groq. The outcome names the provider that ACTUALLY answered and, when
 * it was a fallback, which provider was chosen (fallbackFrom) — the
 * ledger records both, so a fallback is never passed off as the chosen
 * provider. Returns null only when nothing could answer (then the agent
 * uses its labelled local demo mode, as before).
 */
export async function callAiForWorkspace(
  workspaceId: string,
  prompt: string,
  choice?: WorkspaceAiChoice,
): Promise<AiCallOutcome | null> {
  const resolved = choice ?? (await resolveWorkspaceAi(workspaceId));
  try {
    const result = await callProvider(resolved.provider, prompt, resolved.model);
    if (result) return result;
    console.error(
      `[ai] provider ${resolved.provider} not configured (no key) — falling back to groq`,
    );
  } catch (err) {
    console.error(
      `[ai] provider ${resolved.provider} failed (${(err as Error).message}) — falling back to groq`,
    );
  }
  if (resolved.provider !== 'groq') {
    try {
      const fallback = await callProvider('groq', prompt);
      if (fallback) return { ...fallback, fallbackFrom: resolved.provider };
    } catch (err) {
      console.error(`[ai] groq fallback also failed: ${(err as Error).message}`);
    }
  }
  return null;
}
