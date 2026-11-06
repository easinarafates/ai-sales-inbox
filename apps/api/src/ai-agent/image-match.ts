/**
 * Image product matching (Phase 2) — pluggable embedding provider.
 *
 * A customer's photo is embedded, then compared (cosine similarity, in JS)
 * against the stored embeddings of product_images. Matches come ONLY from
 * the tables — a product or price is never invented.
 *
 * No embedding provider is configured yet, so the stub below always returns
 * null and matchProductsByImage reports the feature as unavailable. A real
 * provider (e.g. a hosted embedding API) plugs in by implementing
 * EmbeddingProvider and wiring it here — no other file changes.
 */
import { config } from '../config';
import { query } from '../db/pool';
import { OpenAICompatibleEmbeddingProvider } from './embeddings-openai';

export interface EmbeddingProvider {
  /** Embed an image (URL or storage ref). Returns null when unavailable. */
  embedImage(ref: string): Promise<number[] | null>;
  /** Embed text (for future text+image hybrid search). */
  embedText(text: string): Promise<number[] | null>;
}

/**
 * Stub provider: no embedding service is configured.
 * NEVER fakes a vector or a match — returns null and logs once per call.
 */
export class StubEmbeddingProvider implements EmbeddingProvider {
  async embedImage(_ref: string): Promise<number[] | null> {
    console.log('[image-match] no embedding provider configured — set EMBEDDING_PROVIDER');
    return null;
  }

  async embedText(_text: string): Promise<number[] | null> {
    console.log('[image-match] no embedding provider configured — set EMBEDDING_PROVIDER');
    return null;
  }
}

/**
 * The active provider.
 * - EMBEDDING_PROVIDER=openai-compatible AND EMBEDDING_API_URL +
 *   EMBEDDING_API_KEY + EMBEDDING_MODEL are all set → the real provider.
 * - Anything else (unset, 'stub', or incomplete config) → the stub, which
 *   honestly reports available:false ("ছবি দিয়ে খোঁজা এখনো চালু হয়নি")
 *   and never fakes a match. The ≥0.75 certain-only rule in
 *   matchProductsByImage() is unchanged.
 */
export function getEmbeddingProvider(): EmbeddingProvider {
  const kind = (config.embeddingProvider || 'stub').trim().toLowerCase();
  if (kind === 'openai-compatible' || kind === 'openai') {
    const provider = new OpenAICompatibleEmbeddingProvider();
    if (provider.isConfigured()) return provider;
    console.log(
      '[image-match] EMBEDDING_PROVIDER=openai-compatible but EMBEDDING_API_URL / EMBEDDING_API_KEY / EMBEDDING_MODEL is incomplete — using the stub (image search unavailable)',
    );
    return new StubEmbeddingProvider();
  }
  // If EMBEDDING_PROVIDER names something other than the stub, say so
  // loudly and still return the stub — never fake a match.
  if (kind !== 'stub') {
    console.log(
      `[image-match] embedding provider "${config.embeddingProvider}" is not implemented yet — using the stub (image search unavailable)`,
    );
  }
  return new StubEmbeddingProvider();
}

export interface ImageMatch {
  productId: string;
  name: string;
  pricePaisa: number;
  stock: number;
  /** Cosine similarity, 0–1. */
  score: number;
}

export interface ImageMatchResult {
  available: boolean;
  matches: ImageMatch[];
  uncertain: boolean;
  message?: string;
}

/** A match is shown as "certain" only at this similarity or above (PDF §5). */
const CERTAIN_THRESHOLD = 0.75;

/**
 * Parse a stored embedding defensively.
 * - Real Postgres + pgvector: the driver may return a string like
 *   "[0.1,0.2,...]" or a number array.
 * - PGlite (local): the embedding column is stored as TEXT, so it arrives
 *   as a JSON string.
 * Anything else (or an unparseable row) is skipped, never guessed.
 */
export function parseEmbedding(raw: unknown): number[] | null {
  try {
    if (Array.isArray(raw)) {
      const nums = raw.map(Number);
      return nums.length > 0 && nums.every((n) => Number.isFinite(n)) ? nums : null;
    }
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (!trimmed) return null;
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const nums = parsed.map(Number);
        return nums.length > 0 && nums.every((n) => Number.isFinite(n)) ? nums : null;
      }
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

interface ProductImageRow {
  product_id: string;
  embedding: unknown;
  name: string;
  price_paisa: number;
  stock: number;
}

/**
 * Match products by a customer image.
 * - No embedding provider → { available: false, ... } with a Bengali note.
 * - Otherwise the top matches by cosine similarity, best first. When the
 *   best score is below 0.75 the result is marked uncertain and the caller
 *   should show the top 2–3 and ask the customer to confirm (PDF §5).
 */
export async function matchProductsByImage(
  workspaceId: string,
  imageRef: string,
  limit = 3,
): Promise<ImageMatchResult> {
  const provider = getEmbeddingProvider();
  const queryEmbedding = await provider.embedImage(imageRef);
  if (!queryEmbedding) {
    return {
      available: false,
      matches: [],
      uncertain: true,
      message: 'ছবি দিয়ে খোঁজা এখনো চালু হয়নি — এমবেডিং সার্ভিস লাগবে।',
    };
  }

  const { rows } = await query<ProductImageRow>(
    workspaceId,
    `SELECT pi.product_id, pi.embedding, p.name, p.price_paisa, p.stock
     FROM product_images pi
     JOIN products p ON p.id = pi.product_id AND p.workspace_id = $1
     WHERE pi.workspace_id = $1 AND pi.embedding IS NOT NULL`,
    [workspaceId],
  );

  // A product may have several images — keep its best score only.
  const bestByProduct = new Map<string, ImageMatch>();
  for (const row of rows) {
    const embedding = parseEmbedding(row.embedding);
    if (!embedding) continue; // skip unparseable rows
    const score = cosineSimilarity(queryEmbedding, embedding);
    const existing = bestByProduct.get(row.product_id);
    if (!existing || score > existing.score) {
      bestByProduct.set(row.product_id, {
        productId: row.product_id,
        name: row.name,
        pricePaisa: Number(row.price_paisa),
        stock: Number(row.stock),
        score,
      });
    }
  }

  const matches = [...bestByProduct.values()].sort((a, b) => b.score - a.score).slice(0, Math.max(1, limit));
  if (matches.length === 0) {
    return {
      available: true,
      matches: [],
      uncertain: true,
      message: 'এই ছবির সাথে মিলে এমন প্রোডাক্ট পাওয়া যায়নি। প্রোডাক্টের নাম লিখে জানালে খুঁজে দেব।',
    };
  }

  const uncertain = (matches[0] as ImageMatch).score < CERTAIN_THRESHOLD;
  return {
    available: true,
    matches,
    uncertain,
    message: uncertain
      ? 'এই ছবির সাথে সবচেয়ে কাছের প্রোডাক্টগুলো নিচে দিলাম — কোনটি আপনার দরকার, জানাবেন কি?'
      : undefined,
  };
}
