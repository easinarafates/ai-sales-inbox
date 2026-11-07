import { config } from '../config';
import { fetchWithTimeout } from './http';

export interface GeminiResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  fileData?: { mimeType: string; fileUri: string };
}

/**
 * Multimodal Gemini call (text + image/video parts). Same key/model
 * handling as callGemini, but the caller supplies the parts — used for
 * media analysis (scheduled-post auto-caption). Returns null when no
 * GEMINI_API_KEY is configured; throws on API errors so the caller can
 * fall back honestly. `json: true` asks for a JSON object reply.
 */
export async function callGeminiMultimodal(
  parts: GeminiPart[],
  opts?: { model?: string; json?: boolean; timeoutMs?: number },
): Promise<GeminiResult | null> {
  if (!config.geminiApiKey) return null;
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${opts?.model ?? config.aiModel}:generateContent` +
    `?key=${encodeURIComponent(config.geminiApiKey)}`;
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: opts?.json
          ? { temperature: 0.3, responseMimeType: 'application/json' }
          : { temperature: 0.3 },
      }),
    },
    opts?.timeoutMs,
  );
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

/**
 * Upload a file (image/video) to the Gemini File API (resumable upload)
 * and wait until it is ACTIVE. Needed for media too big for an inline
 * request (Gemini caps inline data at ~20 MB per request) — on Vercel
 * there is no ffmpeg, so frame extraction is not an option. Returns the
 * file URI to reference in a generateContent fileData part. Throws on
 * upload/processing failure; the caller falls back honestly.
 */
export async function uploadGeminiFile(
  bytes: Buffer,
  mimeType: string,
  displayName: string,
): Promise<{ name: string; uri: string; mimeType: string }> {
  if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY is not configured');
  const key = encodeURIComponent(config.geminiApiKey);
  const start = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${key}`,
    {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(bytes.length),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { displayName } }),
    },
    30000,
  );
  if (!start.ok) {
    const detail = await start.text().catch(() => '');
    throw new Error(`Gemini file upload start failed ${start.status}: ${detail.slice(0, 200)}`);
  }
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('Gemini file upload start returned no upload URL');
  const upload = await fetchWithTimeout(
    uploadUrl,
    {
      method: 'PUT',
      headers: {
        'X-Goog-Upload-Command': 'upload, finalize',
        'X-Goog-Upload-Offset': '0',
        'Content-Type': mimeType,
      },
      body: new Uint8Array(bytes),
    },
    120000,
  );
  if (!upload.ok) {
    const detail = await upload.text().catch(() => '');
    throw new Error(`Gemini file upload failed ${upload.status}: ${detail.slice(0, 200)}`);
  }
  const uploaded = (await upload.json()) as {
    file?: { name?: string; uri?: string; mimeType?: string; state?: string };
  };
  const name = uploaded.file?.name ?? '';
  const uri = uploaded.file?.uri ?? '';
  if (!name || !uri) throw new Error('Gemini file upload returned no file URI');
  // Video files need processing before they can be used — poll until ACTIVE.
  const deadline = Date.now() + 90000;
  for (;;) {
    const get = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/${name}?key=${key}`,
      { method: 'GET' },
      20000,
    );
    if (!get.ok) {
      const detail = await get.text().catch(() => '');
      throw new Error(`Gemini file status check failed ${get.status}: ${detail.slice(0, 200)}`);
    }
    const file = (await get.json()) as { state?: string; mimeType?: string };
    if (file.state === 'ACTIVE') return { name, uri, mimeType: file.mimeType ?? mimeType };
    if (file.state === 'FAILED') throw new Error('Gemini file processing failed (state FAILED)');
    if (Date.now() > deadline) throw new Error('Gemini file processing timed out (90s)');
    await new Promise((r) => setTimeout(r, 2000));
  }
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
