import { config } from '../config';
import { fetchWithTimeout } from './http';
import type { GeminiResult } from './gemini';

/**
 * Groq — free AI provider (no credit card; key is active on signup).
 * OpenAI-compatible chat completions endpoint, same return shape as
 * callGemini ({ text, inputTokens, outputTokens }) so the agent can use
 * either provider through one interface.
 *
 * Free-tier limits (Groq docs, console.groq.com/docs/rate-limits):
 * chat models openai/gpt-oss-20b, openai/gpt-oss-120b, qwen/qwen3.8-27b —
 * 30 requests/min, 1,000 requests/day, 8,000 tokens/min, 200,000 tokens/day.
 * Cost is 0 paisa: the ledger records the reply with provider 'groq'.
 *
 * Returns null when no GROQ_API_KEY is configured; throws on API errors
 * (including 401 invalid key and 429 rate limit) so the agent falls back
 * to its labelled local demo mode.
 */
export async function callGroq(prompt: string, model?: string): Promise<GeminiResult | null> {
  if (!config.groqApiKey) return null;
  const url = 'https://api.groq.com/openai/v1/chat/completions';
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.groqApiKey}`,
    },
    body: JSON.stringify({
      model: model ?? config.groqModel,
      messages: [
        {
          role: 'system',
          content:
            'You are a helpful Bengali sales assistant. Always reply with JSON only: {"reply": "...", "confidence": 0.0-1.0, "toolCalls": []}. Write the reply text in Bengali.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Groq API error ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = data.choices?.[0]?.message?.content ?? '';
  return {
    text,
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  };
}
