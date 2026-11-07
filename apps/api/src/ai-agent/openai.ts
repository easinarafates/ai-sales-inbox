import { config } from '../config';
import { fetchWithTimeout } from './http';
import type { GeminiResult } from './gemini';

/**
 * OpenAI — ChatGPT (chat completions API).
 * Same return shape as callGemini/callGroq ({ text, inputTokens,
 * outputTokens }) so the agent can use any provider through one interface.
 *
 * Paid per token (see apps/api/src/ai-agent/pricing.ts for the rates used
 * in cost accounting — the wallet charge itself stays the subscription
 * overage rule; the provider's real token cost is recorded in the ledger
 * as provider_cost_paisa). Default model gpt-5-mini (config OPENAI_MODEL;
 * gpt-4o-mini / gpt-4o are also selectable). Returns null when no
 * OPENAI_API_KEY is configured; throws on API errors so the agent falls
 * back to Groq.
 */
export async function callOpenAI(prompt: string, model?: string): Promise<GeminiResult | null> {
  if (!config.openaiApiKey) return null;
  const res = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.openaiApiKey}`,
    },
    body: JSON.stringify({
      model: model ?? config.openaiModel,
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
    throw new Error(`OpenAI API error ${res.status}: ${detail.slice(0, 300)}`);
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
