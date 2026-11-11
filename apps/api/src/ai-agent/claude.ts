import { config } from '../config';
import { fetchWithTimeout } from './http';
import type { GeminiResult } from './gemini';

/**
 * Anthropic — Claude (Messages API).
 * Same return shape as callGemini/callGroq/callOpenAI
 * ({ text, inputTokens, outputTokens }) so the agent can use any provider
 * through one interface.
 *
 * Paid per token (see apps/api/src/ai-agent/pricing.ts for the rates used
 * in cost accounting). Default model is config.claudeModel
 * (claude-sonnet-5-5 — the current Sonnet model; claude-sonnet-4-5 is
 * deprecated and retires 2026-11-30). The agent prompt arrives
 * as one combined string, so it is sent as the user message with a short
 * JSON-only system instruction; the full prompt text still reaches the
 * model. Returns null when no ANTHROPIC_API_KEY is configured; throws on
 * API errors so the agent falls back to Groq.
 */
export async function callClaude(prompt: string, model?: string): Promise<GeminiResult | null> {
  if (!config.anthropicApiKey) return null;
  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Bearer is the primary auth form on Anthropic's API overview;
      // x-api-key is also accepted — both carry the same key.
      Authorization: `Bearer ${config.anthropicApiKey}`,
      'x-api-key': config.anthropicApiKey,
      'anthropic-version': '2026-10-21',
    },
    body: JSON.stringify({
      model: model ?? config.claudeModel,
      max_tokens: 1024,
      system:
        'You are a helpful Bengali sales assistant. Always reply with JSON only: {"reply": "...", "confidence": 0.0-1.0, "toolCalls": []}. Write the reply text in Bengali.',
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Claude API error ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    content?: { type?: string; text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = (data.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
  return {
    text,
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
    // Claude prompt caching is not wired here — nothing is ever cached.
    cachedInputTokens: 0,
  };
}
