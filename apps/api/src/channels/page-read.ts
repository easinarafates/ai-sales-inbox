/**
 * Page Read (Feature 2) — learn the whole Facebook Page.
 *
 * The Halal Chic Page has OLD products sold long ago that are NOT in the
 * website's product list. POST /api/knowledge/page-read fetches the Page's
 * post history with the stored Page token (server-side, never the
 * facebook-cli connector), extracts candidate products with Gemini Lite
 * (Gemini Lite via config.aiModel — the model name is never hardcoded), and stores
 * them as PENDING page_read_products rows. The owner reviews each one
 * before it goes live in the AI's knowledge book.
 *
 * Honesty rules:
 * - A price is recorded ONLY when the post states one. A post with no
 *   price yields pricePaisa = null — never an invented price.
 * - A confirmed item's knowledge body says plainly that it is an OLD
 *   product that may be out of stock, and the AI must ask the owner /
 *   check stock instead of claiming it is in stock.
 * - Graph auth/scope failures (the live Page token predates the
 *   pages_read_engagement scope) surface as PageReadAuthError so the
 *   route can tell the owner to reconnect the Page — never a fake read.
 */
import { callGemini } from '../ai-agent/gemini';
import { fetchWithTimeout } from '../ai-agent/http';
import { graphBase } from './meta-oauth';

/** Bengali message shown when the Page must be reconnected. */
export const PAGE_READ_RECONNECT_MESSAGE =
  'পেজটি পড়া যায়নি — Facebook পেজটি আবার সংযুক্ত করতে হবে। Channels পেজে গিয়ে “Login with Facebook” দিয়ে পেজটি আবার সংযুক্ত করুন।';

/** Graph call failed because the token lacks the scope / is invalid. */
export class PageReadAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageReadAuthError';
  }
}

/** Graph call failed for another reason (network, Meta error, …). */
export class PageReadGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageReadGraphError';
  }
}

export interface PagePostAttachment {
  media_type?: string;
  media?: { image?: { src?: string } };
  url?: string;
  description?: string;
}

export interface PagePost {
  id: string;
  message?: string;
  created_time?: string;
  attachments?: { data?: PagePostAttachment[] };
}

export interface ExtractedProduct {
  name: string;
  /** Taka * 100, or null when the post states no price — NEVER invented. */
  pricePaisa: number | null;
  description: string;
  photoUrl: string | null;
  sourcePostId: string;
  sourcePostUrl: string | null;
  postCreatedAt: string | null;
}

export interface PageReadProductRow {
  id: string;
  name: string;
  price_paisa: number | null;
  description: string | null;
  photo_url: string | null;
  source_post_id: string | null;
  source_post_url: string | null;
  post_created_at: string | null;
  status: string;
  knowledge_id: string | null;
  created_at: string;
}

/** Bengali digits → Latin digits, so ৳৬০০ parses as 600. */
export function bengaliToLatinDigits(s: string): string {
  return s.replace(/[০-৯]/g, (d) => String('০১২৩৪৫৬৭৮৯'.indexOf(d)));
}

function parsePriceTaka(text: string): number | null {
  const m = text.match(/(?:৳|টাকা|Tk\.?|BDT)\s*([০-৯0-9][০-৯0-9,]*)/);
  if (!m) return null;
  const n = Number(bengaliToLatinDigits(m[1]).replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function cleanName(raw: string): string {
  return raw
    .replace(/(?:৳|টাকা|Tk\.?|BDT)\s*[০-৯0-9][০-৯0-9,]*/g, '')
    .replace(/#\S+/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    // Filler words sellers put around the name ("নতুন শার্ট মাত্র" → "শার্ট").
    .replace(/^(নতুন|নিউ|new)\s+/i, '')
    .replace(/\s+(মাত্র|শুধুমাত্র|only)$/i, '')
    .trim()
    .slice(0, 80);
}

function photoUrlOf(post: PagePost): string | null {
  const atts = post.attachments?.data ?? [];
  for (const a of atts) {
    const src = a.media?.image?.src;
    if (src) return src;
    if (a.url) return a.url;
  }
  return null;
}

/**
 * Deterministic fallback extractor (no AI key / Gemini failed).
 * Name = first line of the post, price = only when the post states one.
 * Used ONLY when Gemini Lite is unavailable — the response says so
 * (extraction: 'regex-fallback') instead of pretending AI read the page.
 */
export function extractProductsRegex(posts: PagePost[]): ExtractedProduct[] {
  const out: ExtractedProduct[] = [];
  for (const post of posts) {
    const message = (post.message ?? '').trim();
    if (!message) continue;
    const firstLine = message.split('\n')[0].trim();
    const name = cleanName(firstLine);
    if (!name || name.length < 2) continue;
    const priceTaka = parsePriceTaka(message);
    out.push({
      name,
      pricePaisa: priceTaka === null ? null : priceTaka * 100,
      description: message.slice(0, 300),
      photoUrl: photoUrlOf(post),
      sourcePostId: post.id,
      sourcePostUrl: `https://www.facebook.com/${post.id}`,
      postCreatedAt: post.created_time ?? null,
    });
  }
  return out;
}

const GEMINI_EXTRACT_PROMPT = `তুমি একটি ফেসবুক পেজের পুরোনো পোস্ট থেকে পণ্যের তালিকা বানাচ্ছ। নিচের পোস্টগুলো পড়ে যেসব পোস্টে কোনো পণ্য বিক্রির কথা আছে, সেগুলো থেকে পণ্য বের করো।

কঠোর নিয়ম:
- দাম (price_taka) শুধু তখনই দাও যখন পোস্টে দাম স্পষ্ট লেখা আছে (যেমন ৳৬০০ বা ৬০০ টাকা)। পোস্টে দাম না থাকলে price_taka হবে null — কখনো দাম বানিয়ে লিখো না।
- পণ্য নয় এমন পোস্ট (শুভেচ্ছা, দোয়া, ঘোষণা, ছবি ছাড়া সাধারণ লেখা) বাদ দাও।
- নাম সংক্ষিপ্ত রাখো (পণ্যের নামটুকুই), বিবরণ ১-২ লাইন।
- শুধু JSON দাও, আর কিছু নয়: {"products": [{"name": "...", "price_taka": 600, "description": "..."}]}

পোস্ট:
`;

type AiCall = (prompt: string) => Promise<{ text: string } | null>;

/** One Gemini extraction pass over a chunk of posts. Returns [] on any failure. */
async function extractChunkWithGemini(posts: PagePost[], aiCall: AiCall): Promise<ExtractedProduct[]> {
  const lines = posts
    .map((p, i) => `[${i}] id=${p.id} date=${p.created_time ?? ''}\n${(p.message ?? '').slice(0, 500)}`)
    .join('\n---\n');
  let result: { text: string } | null = null;
  try {
    result = await aiCall(`${GEMINI_EXTRACT_PROMPT}${lines}`);
  } catch (err) {
    console.error('[page-read] Gemini extraction failed:', (err as Error).message);
    return [];
  }
  if (!result || !result.text.trim()) return [];
  try {
    const cleaned = result.text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned) as {
      products?: { name?: string; price_taka?: number | null; description?: string }[];
    };
    const byId = new Map(posts.map((p, i) => [i, p]));
    return (parsed.products ?? [])
      .filter((p) => typeof p?.name === 'string' && p.name.trim().length >= 2)
      .map((p, i) => {
        // Match the product back to its post by order; fall back to the
        // chunk's first post when Gemini reorders (source is indicative).
        const post = byId.get(i) ?? posts[0];
        const priceTaka =
          typeof p.price_taka === 'number' && Number.isFinite(p.price_taka) && p.price_taka > 0
            ? Math.round(p.price_taka)
            : null;
        return {
          name: p.name!.trim().slice(0, 80),
          pricePaisa: priceTaka === null ? null : priceTaka * 100,
          description: (p.description ?? '').trim().slice(0, 300),
          photoUrl: photoUrlOf(post),
          sourcePostId: post.id,
          sourcePostUrl: `https://www.facebook.com/${post.id}`,
          postCreatedAt: post.created_time ?? null,
        };
      });
  } catch (err) {
    console.error('[page-read] Gemini extraction JSON parse failed:', (err as Error).message);
    return [];
  }
}

/**
 * Extract candidate products from Page posts.
 * Gemini Lite first (chunked, 40 posts per call); when Gemini is
 * unavailable (no key) or returns nothing usable, the deterministic
 * regex fallback runs so the owner still gets a list — the caller
 * reports which path was used. `aiCall` is injectable for unit tests.
 */
export async function extractProductsFromPosts(
  posts: PagePost[],
  aiCall: AiCall = callGemini,
): Promise<{ products: ExtractedProduct[]; extraction: 'gemini' | 'regex-fallback' }> {
  const withMessage = posts.filter((p) => (p.message ?? '').trim());
  if (withMessage.length === 0) return { products: [], extraction: 'regex-fallback' };
  const geminiProducts: ExtractedProduct[] = [];
  for (let i = 0; i < withMessage.length; i += 40) {
    geminiProducts.push(...(await extractChunkWithGemini(withMessage.slice(i, i + 40), aiCall)));
  }
  if (geminiProducts.length > 0) return { products: geminiProducts, extraction: 'gemini' };
  return { products: extractProductsRegex(withMessage), extraction: 'regex-fallback' };
}

/**
 * Fetch the Page's post history from the Graph API.
 * `/{page-id}/posts` with message, created_time and attachments, paged
 * until `maxPosts` (default 300, clamped 10–500) or the history ends.
 * META_GRAPH_BASE_URL overrides the Graph base for offline testing only
 * (same rule as meta-oauth.ts / meta-send.ts); production always uses
 * graph.facebook.com. Throws PageReadAuthError on auth/scope failures
 * (Graph codes 190/200/10/102 or HTTP 401/403) and PageReadGraphError
 * otherwise. Never returns fake posts.
 */
export async function fetchPagePosts(
  pageId: string,
  pageToken: string,
  maxPosts = 300,
): Promise<PagePost[]> {
  const limit = Math.min(500, Math.max(10, maxPosts));
  const posts: PagePost[] = [];
  let after: string | null = null;
  const fields = 'message,created_time,attachments{media,media_type,url,description}';
  for (;;) {
    const url = new URL(`${graphBase()}/${encodeURIComponent(pageId)}/posts`);
    url.searchParams.set('fields', fields);
    url.searchParams.set('limit', '100');
    if (after) url.searchParams.set('after', after);
    let res: Response;
    try {
      res = await fetchWithTimeout(
        url.toString(),
        { method: 'GET', headers: { Authorization: `Bearer ${pageToken}` } },
        20000,
      );
    } catch (err) {
      throw new PageReadGraphError(`Facebook-এর সাথে সংযোগ করা যায়নি: ${(err as Error).message}`);
    }
    const data = (await res.json().catch(() => null)) as {
      data?: PagePost[];
      paging?: { cursors?: { after?: string }; next?: string };
      error?: { message?: string; code?: number };
    } | null;
    if (!res.ok) {
      const code = data?.error?.code;
      const msg = data?.error?.message ?? `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403 || code === 190 || code === 200 || code === 10 || code === 102) {
        throw new PageReadAuthError(
          `${PAGE_READ_RECONNECT_MESSAGE} (Facebook বলেছে: ${msg})`,
        );
      }
      throw new PageReadGraphError(`Facebook পেজ পড়তে ব্যর্থ হয়েছে: ${msg}`);
    }
    const page = data?.data ?? [];
    posts.push(...page);
    after = data?.paging?.cursors?.after ?? null;
    if (posts.length >= limit || !after || page.length === 0) break;
  }
  return posts.slice(0, limit);
}

/**
 * Knowledge-book body for a confirmed old product. This is what the AI
 * actually reads (agent.ts loads knowledge_items into the stable prompt),
 * so the wording must carry the guard itself: old product, stock unsure,
 * never invent a price, ask the owner. The agent is NOT changed — the
 * wording does the work.
 */
export function buildOldProductKnowledgeBody(item: {
  name: string;
  price_paisa: number | null;
  description: string | null;
  photo_url: string | null;
  source_post_url: string | null;
  /** True when the owner edited the price at confirm time. */
  priceEdited?: boolean;
}): string {
  const lines = [
    '[পুরোনো পণ্য — পেজের পুরোনো পোস্ট থেকে শেখা]',
    `পণ্য: ${item.name}`,
  ];
  if (item.description) lines.push(`বিবরণ: ${item.description}`);
  if (item.price_paisa !== null && item.price_paisa !== undefined) {
    lines.push(
      item.priceEdited
        ? `দাম: ৳${(item.price_paisa / 100).toLocaleString('en-IN')} (মালিকের দেওয়া দাম — পুরোনো পোস্টের দাম থেকে বদলানো হয়েছে)`
        : `দাম: ৳${(item.price_paisa / 100).toLocaleString('en-IN')} (পুরোনো পোস্টে এই দাম ছিল — এখন দাম একই নাও হতে পারে)`,
    );
  } else {
    lines.push('দাম: পুরোনো পোস্টে দাম লেখা ছিল না — দাম বানিয়ে বলা যাবে না, দাম জানতে চাইলে মালিককে জিজ্ঞেস করতে হবে।');
  }
  if (item.photo_url) lines.push(`ছবি: ${item.photo_url}`);
  if (item.source_post_url) lines.push(`মূল পোস্ট: ${item.source_post_url}`);
  lines.push(
    'সতর্কতা: এটি আগের (পুরোনো) পণ্য — এখন স্টকে আছে কিনা নিশ্চিত নয়। কাস্টমার এই পণ্য চাইলে কখনোই "স্টকে আছে" বলা যাবে না, দাম বানিয়ে বলা যাবে না। বলো এটি আগের পণ্য, এখন স্টকে আছে কিনা আর দাম কত তা মালিককে জিজ্ঞেস করে জানানো হবে, এবং বিষয়টি মালিকের কাছে পাঠাও।',
  );
  return lines.join('\n');
}
