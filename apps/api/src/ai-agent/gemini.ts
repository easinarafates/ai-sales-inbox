import { config } from '../config';
import { fetchWithTimeout } from './http';

export interface GeminiResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/**
 * Calls Gemini (model name comes from config only — never hardcoded here).
 * Returns null when no GEMINI_API_KEY is configured; the agent then uses a
 * safe Bengali fallback reply and hands the chat to a human.
 */
export async function callGemini(prompt: string, model?: string): Promise<GeminiResult | null> {
  if (!config.geminiApiKey) return null;
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model ?? config.aiModel}:generateContent` +
    `?key=${encodeURIComponent(config.geminiApiKey)}`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, responseMimeType: 'application/json' },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Gemini API error ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = (await res.json()) as GeminiResponse;
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  return {
    text,
    inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
  };
}
