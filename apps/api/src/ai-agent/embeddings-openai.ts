/**
 * OpenAI-compatible embeddings provider (TikTok DM / image-search module).
 *
 * Implements the EmbeddingProvider interface from image-match.ts against
 * any HTTP API that speaks the OpenAI `/embeddings` shape:
 *   POST {base}/embeddings  { model, input }  →  { data: [{ embedding: [...] }] }
 * with a Bearer API key.
 *
 * Image search needs a MULTIMODAL / CLIP-style endpoint that accepts an
 * image URL (or image ref) as `input` — e.g. Jina AI `jina-clip-v2`,
 * Voyage `voyage-multimodal-3`, or a self-hosted CLIP server exposing an
 * OpenAI-compatible API. A text-only embeddings endpoint will return an
 * error for image input, and then embedImage() honestly returns null
 * (image search stays unavailable) instead of faking a vector.
 *
 * Rules (same as the stub):
 * - NEVER log the API key (only whether one is configured).
 * - NEVER invent an embedding: any network error, non-2xx status, or
 *   malformed response → null.
 * - No provider URL or key is hard-coded here — everything comes from env
 *   via config (EMBEDDING_API_URL / EMBEDDING_API_KEY / EMBEDDING_MODEL).
 */
import { config } from '../config';
import type { EmbeddingProvider } from './image-match';

export interface OpenAICompatibleEmbeddingOptions {
  apiUrl: string;
  apiKey: string;
  model: string;
}

const FETCH_TIMEOUT_MS = 10_000;

function embeddingsEndpoint(apiUrl: string): string {
  const base = apiUrl.replace(/\/+$/, '');
  return base.endsWith('/embeddings') ? base : `${base}/embeddings`;
}

/** A vector is usable only if it is a non-empty array of finite numbers. */
function validVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(opts?: Partial<OpenAICompatibleEmbeddingOptions>) {
    this.apiUrl = opts?.apiUrl ?? config.embeddingApiUrl;
    this.apiKey = opts?.apiKey ?? config.embeddingApiKey;
    this.model = opts?.model ?? config.embeddingModel;
  }

  /** True only when URL + key + model are all configured. */
  isConfigured(): boolean {
    return Boolean(this.apiUrl && this.apiKey && this.model);
  }

  private async embed(input: string, kind: 'text' | 'image'): Promise<number[] | null> {
    if (!this.isConfigured()) {
      console.log('[embeddings] openai-compatible provider is not configured (need EMBEDDING_API_URL + EMBEDDING_API_KEY + EMBEDDING_MODEL)');
      return null;
    }
    if (!input) return null;
    const url = embeddingsEndpoint(this.apiUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input }),
        signal: controller.signal,
      });
      if (!res.ok) {
        // Log the status only — never the response body (it must never
        // contain the key, and it adds nothing the operator can act on).
        console.log(`[embeddings] ${kind} embedding request failed: HTTP ${res.status}`);
        return null;
      }
      const data = (await res.json()) as { data?: { embedding?: unknown }[] };
      const embedding = data?.data?.[0]?.embedding;
      if (!validVector(embedding)) {
        console.log('[embeddings] provider returned no usable embedding vector');
        return null;
      }
      return embedding;
    } catch (err) {
      console.log(`[embeddings] ${kind} embedding request failed: ${(err as Error).message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Embed an image by its URL / storage ref.
   * The endpoint must accept an image URL as `input` (multimodal/CLIP
   * endpoint). Text-only endpoints error out → null, never a fake vector.
   */
  async embedImage(ref: string): Promise<number[] | null> {
    return this.embed(ref, 'image');
  }

  /** Embed text (for future text+image hybrid search). */
  async embedText(text: string): Promise<number[] | null> {
    return this.embed(text, 'text');
  }
}
