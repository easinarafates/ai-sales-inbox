/**
 * AI sales agent — processBatch.
 *
 * RULES (from AI.pdf):
 * - The agent NEVER writes business data to the DB directly. All product /
 *   order / ticket / lead / coupon / stock / shipment reads and writes go
 *   through tools.ts (runTool). The only writes this file makes itself are
 *   its own outgoing reply message and its own ai_usage_ledger + wallet
 *   bookkeeping — the agent's own audit trail, not business data.
 * - It NEVER states a price, stock level, discount or delivery time except
 *   from a tool result or the product list in its prompt (same DB data, read
 *   in processBatch). Unknown questions go to a human (low confidence).
 * - Phase 2 plug points (NOT built here): courier booking / live tracking
 *   (shipments table + track_parcel tool), follow-up engine (followups
 *   table), post scheduling, WhatsApp/TikTok channels. See the stubs in
 *   tools.ts and the channel platform list.
 *
 * DEMO MODE (no key, or provider call fails):
 * - Gemini: a real key is configured in apps/api/.env (AI_MODEL in config,
 *   now gemini-3.5-flash — gemini-2.5-flash returns 404 "no longer
 *   available to new users" for this key, and gemini-2.0-flash no longer
 *   exists). The current key generates fine (verified 2026-11-07); the
 *   old key was blocked by billing (HTTP 403 "free tier is not available
 *   for this project"). If a Gemini call fails, the agent falls back to Groq.
 * - Groq (AI_PROVIDER=groq): free tier, no card — key from console.groq.com.
 *   Groq replies cost 0 paisa. If the key is missing/invalid or Groq
 *   returns 429, the agent falls back to the same demo mode.
 * - Multi-provider (apps/api/src/ai-agent/providers.ts): each workspace
 *   picks Groq / OpenAI (ChatGPT) / Gemini / Claude on the AI Providers
 *   settings page. A chosen provider that fails falls back to Groq and the
 *   ledger records fallback_from, so a fallback is never passed off as the
 *   chosen provider. Providers with no key are never selectable as live.
 * Demo replies are built ONLY from product/knowledge rows (via tools),
 * clearly labelled "[ডেমো AI — আসল Gemini নয়]", charged at the flat
 * 10 paisa in ai_usage_ledger like any other reply when over the plan's
 * included limit — and 0 paisa when inside it (see the subscription gate
 * in processBatch). Prices/stock are never invented.
 */
import { pool, query, queryOne } from '../db/pool';
import { checkAiReplyAllowance, UPGRADE_NOTICE, type AiReplyAllowance } from '../subscriptions/service';
import { buildUserPrompt, SYSTEM_PROMPT, type AgentContext } from './prompts';
import { getCustomerOrderSummary, isOrderStatusQuestion, type CustomerOrderSummary } from '../orders/customer-memory';
import { deliveryChargeSummaryText, getDeliveryChargeRules, resolveDeliveryCharge } from '../delivery-charges/service';
import { addressingLine, genderSalutation, normalizeCustomerGender, type CustomerGender } from '../customers/gender';
import { runTool, type ToolDb } from './tools';
import {
  callAiForWorkspace,
  callProvider,
  resolveWorkspaceAi,
  type AiCallOutcome,
  type WorkspaceAiChoice,
} from './providers';
import { computeAiCostPaisa } from './pricing';
import { deliverOutgoingMessage, deliverOutgoingImageMessage, type DeliveryResult } from '../channels/meta-send';
import { detectAnger, detectGibberish, detectOffTopic, escalateConversation, isCantAnswerReply } from '../inbox/escalation';
import {
  BENGALI_PRODUCT_ALIASES,
  detectAcknowledgment,
  acknowledgmentKind,
  detectCancelRequest,
  detectFastReplyQuestion,
  detectGreeting,
  detectProductListRequest,
  detectShopLocation,
  looksLikeShowRequest,
  matchShowProduct,
  ROMANIZED_PRODUCT_ALIASES,
} from './detect-intent';
import { extractOrderNumber, requestOrderCancellation } from '../orders/cancel';
import { analyseCustomerImage, transcribeCustomerAudio, uploadMediaToBlob } from './media';
import { renderInvoiceImageForOrder } from '../orders/invoice-image';

/** Flat MVP estimate per AI reply (paisa). Real per-token pricing plugs in here later. Must stay under the 20-paisa gate. */
const AI_REPLY_COST_PAISA = 10;
/** Below this confidence the AI does not reply — it hands off to a human. */
const CONFIDENCE_THRESHOLD = 0.6;

/** The provider call result, from the unified dispatcher (providers.ts). */
type AiCallResult = AiCallOutcome;

export interface BatchedMessage {
  body: string;
  senderId?: string;
  platformMessageId?: string;
  /** Blob URL of a customer photo / voice note (messages.media_url). */
  mediaUrl?: string | null;
  /** 'image' | 'audio' | 'video' | null (messages.media_type). */
  mediaType?: string | null;
}

export interface ProcessBatchResult {
  replied: boolean;
  reason: string;
  confidence?: number;
  costPaisa?: number;
}

interface GeminiReply {
  reply: string;
  confidence: number;
  toolCalls: { tool: string; args: Record<string, unknown> }[];
}

// Adapter so tools can use the pool while the agent itself never calls pool directly for business data.
const toolDb: ToolDb = {
  async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
    const result = await pool.query(text, params as never[]);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  },
};

function parseGeminiReply(text: string): GeminiReply | null {
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text) as Partial<GeminiReply>;
    if (typeof parsed.reply === 'string') {
      return {
        reply: parsed.reply,
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.7,
        toolCalls: Array.isArray(parsed.toolCalls) ? parsed.toolCalls : [],
      };
    }
  } catch {
    // Not JSON — fall through to plain-text handling below.
  }
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as Partial<GeminiReply>;
      if (typeof parsed.reply === 'string') {
        return {
          reply: parsed.reply,
          confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.7,
          toolCalls: Array.isArray(parsed.toolCalls) ? parsed.toolCalls : [],
        };
      }
    } catch {
      // ignore
    }
  }
  // Plain-text reply (model ignored the JSON instruction): use it as-is with
  // a middling confidence — it still must pass the threshold check below.
  return { reply: text.trim(), confidence: 0.7, toolCalls: [] };
}

// ---------------------------------------------------------------------------
// Anti-hallucination guard (deterministic, prompt-independent).
//
// The system prompt tells the model never to invent a price, but a model
// can still ignore the prompt — and a plain-text (non-JSON) reply bypasses
// tool grounding entirely. So before ANY live reply is sent, the reply
// text itself is checked: every currency-marked amount in it (৳…, …টাকা,
// "price/dam …123") must match a real number from the DB — a product
// price, an open-order total, a knowledge-book amount, or an amount from
// a tool result this turn (e.g. a just-created order's bill total).
// If any amount is invented:
//  - empty catalog → the safe Bengali empty-catalog reply (never a price);
//  - products exist → a reply listing the REAL catalog prices, so the
//    customer still gets a true answer instead of a made-up one.
// Returns the (possibly replaced) reply. Only currency-marked amounts
// are checked — bare numbers (quantities, phone digits) are untouched.
// ---------------------------------------------------------------------------

/** Reply sent when the shop has no products and the customer asks a price. */
export const EMPTY_CATALOG_REPLY =
  'আসসালামু আলাইকুম! কোন প্রোডাক্টের দাম জানতে চান, নামটা লিখে জানাবেন? দোকানে এখনো কোনো প্রোডাক্ট যোগ করা হয়নি, তাই এখন কোনো দাম বলতে পারছি না — প্রোডাক্টের নাম জানালে দোকানের মালিক দাম জানিয়ে দেবেন। ধন্যবাদ!';

function bnDigitsToAscii(s: string): string {
  return s.replace(/[০-৯]/g, (d) => String('০১২৩৪৫৬৭৮৯'.indexOf(d)));
}

/** All currency-marked amounts in a text, as taka numbers (৳1500 → 1500). */
export function extractPriceAmounts(text: string): number[] {
  const amounts: number[] = [];
  const patterns = [
    /৳\s*([০-৯0-9][০-৯0-9,]*\.?[০-৯0-9]*)/g,
    /([০-৯0-9][০-৯0-9,]*\.?[০-৯0-9]*)\s*টাকা/g,
    /(?:price|দাম)[^০-৯0-9\n]{0,25}([০-৯0-9][০-৯0-9,]*\.?[০-৯0-9]*)/gi,
    /\b(?:tk|bdt)\s*\.?\s*([০-৯0-9][০-৯0-9,]*\.?[০-৯0-9]*)/gi,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const n = Number(bnDigitsToAscii(m[1]).replace(/,/g, ''));
      if (Number.isFinite(n) && n > 0) amounts.push(n);
    }
  }
  return amounts;
}

/**
 * Real amounts a tool returned this turn (bill totals in billText, numeric
 * totalPaisa/pricePaisa fields in paisa → taka). Walked structurally, NOT
 * by stringifying the JSON — a raw stringify would also match the key
 * name "pricePaisa" followed by the raw paisa number (150000), which
 * would wrongly allow a ৳150,000 reply.
 */
function toolResultAmountsFrom(results: { tool: string; result: unknown }[]): number[] {
  const amounts: number[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') amounts.push(...extractPriceAmounts(v));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if ((k === 'totalPaisa' || k === 'pricePaisa') && typeof val === 'number') amounts.push(val / 100);
        else walk(val);
      }
    }
  };
  results.forEach((r) => walk(r.result));
  return amounts;
}

/**
 * Deterministic reply from READ-ONLY product tool results (search_products,
 * check_stock, send_product_cards). Used ONLY when the second provider call
 * fails or is unparseable and the model's draft reply states no price —
 * so a "checking…" placeholder is never sent when the real data is already
 * in hand. Every amount comes from the DB via the tools, so the
 * hallucination guard below still validates it. Returns null when the
 * results carry no product rows (e.g. create_order) — then the draft reply
 * stands and the order flow is untouched.
 *
 * Addressing follows the customer's stored gender (same rule as the AI
 * prompt): male → "স্যার" at the start and the end, female → "ম্যাডাম",
 * unknown → neutral, no স্যার/ম্যাডাম at all. The product lines and the
 * "অর্ডার করতে চাইলে জানাবেন।" ending are unchanged, so the
 * deterministic-reply shape the verifiers recognise stays intact.
 */
function deterministicProductReply(
  results: { tool: string; result: unknown }[],
  gender: CustomerGender = 'unknown',
): string | null {
  // Photos already sent (send_product_photos): the customer has the
  // pictures — never list the products again in text. One photo → its
  // details; several → just ask which one they like.
  const photoSent: { name: string; pricePaisa: number; stock: number; description: string | null }[] = [];
  for (const { tool, result } of results) {
    if (tool !== 'send_product_photos') continue;
    const r = result as { sent?: unknown } | null;
    if (!r || !Array.isArray(r.sent)) continue;
    for (const s of r.sent as Record<string, unknown>[]) {
      if (s && typeof s.name === 'string' && typeof s.pricePaisa === 'number') {
        photoSent.push({
          name: s.name,
          pricePaisa: Number(s.pricePaisa),
          stock: Number((s.stock as number | undefined) ?? 0),
          description: typeof s.description === 'string' ? (s.description as string) : null,
        });
      }
    }
  }
  if (photoSent.length === 1) {
    const p = photoSent[0];
    const body =
      `${p.name}\nদাম: ৳${p.pricePaisa / 100}\nস্টক: ${p.stock > 0 ? `${p.stock}টি আছে ✅` : 'শেষ হয়ে গেছে ❌'}` +
      (p.description ? `\n${p.description}` : '') +
      '\nঅর্ডার করতে চাইলে নাম, ফোন নম্বর ও ঠিকানা জানান।';
    if (gender === 'male') return `স্যার, ${body}\nধন্যবাদ, স্যার।`;
    if (gender === 'female') return `ম্যাডাম, ${body}\nধন্যবাদ, ম্যাডাম।`;
    return `${body}\nধন্যবাদ।`;
  }
  if (photoSent.length > 1) {
    const q = 'আমাদের এই প্রোডাক্টগুলো আছে — আপনি কোন প্রোডাক্টে আগ্রহী? নামটা লিখে জানান।';
    if (gender === 'male') return `স্যার, ${q}\nধন্যবাদ, স্যার।`;
    if (gender === 'female') return `ম্যাডাম, ${q}\nধন্যবাদ, ম্যাডাম।`;
    return `${q}\nধন্যবাদ।`;
  }
  const seen = new Map<string, { name: string; price: number; stock: number }>();
  for (const { tool, result } of results) {
    const r = result as Record<string, unknown> | null;
    if (!r || typeof r !== 'object') continue;
    if (tool === 'search_products' || tool === 'check_stock') {
      const prods = Array.isArray(r.products) ? (r.products as Record<string, unknown>[]) : [];
      for (const p of prods) {
        if (p && typeof p.name === 'string' && typeof p.price_paisa === 'number') {
          seen.set(String(p.id ?? p.name), { name: p.name, price: Number(p.price_paisa) / 100, stock: Number(p.stock ?? 0) });
        }
      }
    } else if (tool === 'send_product_cards') {
      const cards = Array.isArray(r.cards) ? (r.cards as Record<string, unknown>[]) : [];
      for (const c of cards) {
        if (c && typeof c.name === 'string' && typeof c.pricePaisa === 'number') {
          seen.set(String(c.productId ?? c.name), { name: c.name, price: Number(c.pricePaisa) / 100, stock: Number(c.stock ?? 0) });
        }
      }
    }
  }
  if (seen.size === 0) return null;
  const lines = [...seen.values()].map((p) => `${p.name} — দাম ৳${p.price}, স্টক ${p.stock}টি আছে।`);
  const body = lines.join('\n') + '\nঅর্ডার করতে চাইলে জানাবেন।';
  if (gender === 'male') return `স্যার, আপনার প্রশ্নের উত্তর দিচ্ছি:\n${body}\nধন্যবাদ, স্যার।`;
  if (gender === 'female') return `ম্যাডাম, আপনার প্রশ্নের উত্তর দিচ্ছি:\n${body}\nধন্যবাদ, ম্যাডাম।`;
  return `আপনার প্রশ্নের উত্তর দিচ্ছি:\n${body}\nধন্যবাদ।`;
}

export function guardReplyAgainstHallucination(
  reply: string,
  ctx: AgentContext,
  toolResultAmounts: number[] = [],
): { reply: string; replaced: boolean; invented: number[] } {  const amounts = extractPriceAmounts(reply);
  if (amounts.length === 0) return { reply, replaced: false, invented: [] };
  const allowed = new Set<number>();
  for (const p of ctx.products) allowed.add(p.pricePaisa / 100);
  for (const o of ctx.openOrders) allowed.add(o.totalPaisa / 100);
  for (const k of ctx.knowledge) {
    for (const a of extractPriceAmounts(`${k.title ?? ''} ${k.body}`)) allowed.add(a);
  }
  for (const a of toolResultAmounts) allowed.add(a);
  const invented = amounts.filter((a) => ![...allowed].some((x) => Math.abs(x - a) < 0.01));
  if (invented.length === 0) return { reply, replaced: false, invented: [] };
  if (ctx.products.length === 0) {
    return { reply: EMPTY_CATALOG_REPLY, replaced: true, invented };
  }
  const list = ctx.products
    .slice(0, 5)
    .map((p) => `• ${p.name} — ৳${(p.pricePaisa / 100).toLocaleString('en-IN')}`)
    .join('\n');
  return {
    reply:
      // Just the list — nothing more (prompt rule 0/10). The model
      // invented a price, so the safe reply is the real catalog list;
      // no trailing question, no extra line.
      `দামের ব্যাপারে নিশ্চিত তথ্য দিচ্ছি — আমাদের প্রোডাক্টগুলো:\n${list}`,
    replaced: true,
    invented,
  };
}

// ---------------------------------------------------------------------------
// Brevity guard (2026-11-08, user report: the AI gives VERY LONG answers).
//
// The system prompt tells the model to be short (prompt rule 0), but a
// model can still ramble — so before ANY live (LLM) reply is sent, its
// length is enforced deterministically: keep the first complete
// sentences up to ~450 chars, always keeping sentences that carry a
// price (৳/টাকা) or the invoice/confirmation lines (essential info),
// hard-capped at ~700 chars. Short replies pass through untouched.
// Applied ONLY to LLM replies — never to the deterministic order
// confirmation (sent earlier, returns before this point) and never to
// the deterministic handlers (already short by construction).
// ---------------------------------------------------------------------------

/** Shorten an LLM reply to the fewest complete sentences that answer the question. */
export function shortenReply(reply: string, maxChars = 450): { reply: string; shortened: boolean } {
  const text = reply.trim();
  if (text.length <= 350) return { reply: text, shortened: false };
  const HARD_CAP = 700;
  // Essential lines are never dropped: prices, the invoice link, and the
  // order-confirmation header/number (a confirmation must stay complete).
  const isEssential = (seg: string): boolean =>
    /৳|টাকা|ইনভয়েস|অর্ডার কনফার্ম|অর্ডার নম্বর/.test(seg);
  const segments: string[] = [];
  for (const line of text.split(/\n+/)) {
    const l = line.trim();
    if (!l) continue;
    // Split a long line into sentences (Bengali danda / ? / !).
    const parts = l.split(/(?<=[।?!])\s+/u).map((s) => s.trim()).filter(Boolean);
    segments.push(...parts);
  }
  if (segments.length === 0) return { reply: text, shortened: false };
  let out = '';
  let shortened = false;
  // The first price/confirmation line is always kept (a reply must never
  // lose the price that answers the question), even if it pushes the
  // total slightly past the budget — but only the FIRST one, or a
  // rambling reply would keep every price line and stay long.
  let keptEssential = false;
  for (const seg of segments) {
    const sep = out ? '\n' : '';
    if (out.length + sep.length + seg.length <= maxChars) {
      out += sep + seg;
      if (isEssential(seg)) keptEssential = true;
    } else if (isEssential(seg) && !keptEssential && out.length + sep.length + seg.length <= HARD_CAP) {
      out += sep + seg;
      keptEssential = true;
    } else {
      shortened = true;
    }
  }
  if (!out) {
    // The first segment alone is too long — keep it, cut at a word boundary.
    const first = segments[0];
    const cut = first.slice(0, maxChars);
    const lastSpace = cut.lastIndexOf(' ');
    out = (lastSpace > 100 ? cut.slice(0, lastSpace) : cut).trim() + '…';
    shortened = true;
  }
  return { reply: out.trim(), shortened };
}

async function recordUnanswered(workspaceId: string, question: string): Promise<void> {  const q = question.trim().slice(0, 500);  if (!q) return;
  // No unique constraint on (workspace_id, question) in schema.sql, so
  // upsert manually instead of ON CONFLICT.
  const existing = await queryOne<{ id: string }>(
    workspaceId,
    'SELECT id FROM unanswered_questions WHERE workspace_id = $1 AND question = $2',
    [workspaceId, q],
  ).catch(() => null);
  if (existing) {
    await query(
      workspaceId,
      'UPDATE unanswered_questions SET count = count + 1, updated_at = now() WHERE workspace_id = $1 AND id = $2',
      [workspaceId, existing.id],
    ).catch((err) => console.error('[agent] recordUnanswered failed:', (err as Error).message));
  } else {
    await query(
      workspaceId,
      'INSERT INTO unanswered_questions (workspace_id, question, count) VALUES ($1, $2, 1)',
      [workspaceId, q],
    ).catch((err) => console.error('[agent] recordUnanswered failed:', (err as Error).message));
  }
}

/**
 * Channel send — REAL Meta Graph API send (Messenger + Instagram) via
 * deliverOutgoingMessage. The reply is saved first, then delivered; the
 * returned result says honestly whether the customer received it.
 * Demo-mode replies (liveSend: false) are saved only — a labelled
 * "[ডেমো AI]" reply is never sent to a real customer. Webchat is
 * delivered by saving (the website widget reads it from the DB).
 * A failed send must not be charged — callers check result.sent first.
 */
async function sendChannelMessage(
  workspaceId: string,
  conversationId: string,
  channelPlatform: string | null,
  reply: string,
  opts: { liveSend?: boolean } = {},
): Promise<DeliveryResult> {
  console.log(`[agent:send:${channelPlatform ?? 'unknown'}] seen ✓ typing… reply: ${reply.slice(0, 200)}`);
  const result = await deliverOutgoingMessage(workspaceId, conversationId, reply, opts);
  if (!result.sent) {
    console.error(`[agent:send] delivery failed for conv ${conversationId}: ${result.error ?? 'unknown'}`);
  }
  return result;
}

/**
 * After an order is confirmed, send the extras — best-effort, never
 * blocking the confirmation (which already went out):
 *
 * 1. INVOICE IMAGE (2026-11-08, user demand): render the invoice as a
 *    PNG (headless Chromium, correct Bengali) and send it as a Messenger
 *    image attachment, right after the confirmation text. A render or
 *    upload failure is logged honestly — the confirmation + invoice LINK
 *    already reached the customer, and a broken image is never sent.
 * 2. ONE short suggestion: if the shop has another product besides the
 *    one just ordered, one line — "স্যার, আপনি কি আর কোনো প্রোডাক্ট
 *    নিতে চাচ্ছেন? আমাদের কাছে X ও আছে।" — and nothing more. No
 *    suggestion when there is no other product.
 */
async function sendOrderConfirmationExtras(
  workspaceId: string,
  conversationId: string,
  channelPlatform: string | null,
  orderId: string,
  orderedProductIds: string[],
  products: { id: string; name: string }[],
  gender: CustomerGender,
  opts: { liveSend?: boolean } = {},
): Promise<void> {
  // 1) Invoice image.
  try {
    const rendered = await renderInvoiceImageForOrder(toolDb, workspaceId, orderId);
    if (rendered) {
      const blobUrl = await uploadMediaToBlob(rendered.png, 'image/png', `invoice-${rendered.orderNumber}.png`);
      if (blobUrl) {
        const img = await deliverOutgoingImageMessage(workspaceId, conversationId, blobUrl, { liveSend: opts.liveSend });
        if (!img.sent) console.error('[agent] invoice image delivery failed:', img.error ?? 'unknown');
      } else {
        console.error('[agent] invoice image upload failed (no Blob URL) for order', orderId);
      }
    } else {
      console.error('[agent] invoice image render failed for order', orderId);
    }
  } catch (err) {
    console.error('[agent] invoice image send failed:', (err as Error).message);
  }
  // 2) One short suggestion (only when another product exists).
  const other = products.find((p) => !orderedProductIds.includes(p.id));
  if (other) {
    const sal = genderSalutation(gender);
    const suggestion = sal
      ? `${sal}, আপনি কি আর কোনো প্রোডাক্ট নিতে চাচ্ছেন? আমাদের কাছে ${other.name} ও আছে।`
      : `আপনি কি আর কোনো প্রোডাক্ট নিতে চাচ্ছেন? আমাদের কাছে ${other.name} ও আছে।`;
    await sendChannelMessage(workspaceId, conversationId, channelPlatform, suggestion, { liveSend: opts.liveSend }).catch(
      (err) => console.error('[agent] suggestion send failed:', (err as Error).message),
    );
  }
}

/** Deduct the reply cost; returns false if the balance ran out mid-flight.
 * Groq replies cost 0 paisa when inside the plan (free tier + included);
 * over the plan's included replies they cost the flat 10 paisa overage
 * (any provider). Gemini/demo replies cost the flat 10 paisa when over
 * the limit, 0 when included. The provider AND the included_in_plan flag
 * are recorded in ai_usage_ledger with each entry, along with the model,
 * the provider's REAL token cost (providerCostPaisa — Groq always 0,
 * paid providers = tokens x the rates in pricing.ts) and fallbackFrom
 * when Groq answered instead of the workspace's chosen provider.
 * cost_paisa stays the WALLET deduction (unchanged billing rule);
 * provider_cost_paisa is the provider's own cost, for honest reporting. */
async function chargeForReply(
  workspaceId: string,
  conversationId: string,
  inputTokens: number,
  outputTokens: number,
  costPaisa: number = AI_REPLY_COST_PAISA,
  provider: string = 'gemini',
  includedInPlan = false,
  opts: { model?: string; providerCostPaisa?: number; fallbackFrom?: string | null } = {},
): Promise<boolean> {
  const deducted = await query(
    workspaceId,
    'UPDATE workspaces SET balance_paisa = balance_paisa - $1, updated_at = now() WHERE id = $2 AND balance_paisa >= $1',
    [costPaisa, workspaceId],
  );
  if (deducted.rowCount === 0) return false;
  await query(
    workspaceId,
    `INSERT INTO ai_usage_ledger (workspace_id, conversation_id, input_tokens, output_tokens, cost_paisa, provider, included_in_plan, model, provider_cost_paisa, fallback_from)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      workspaceId,
      conversationId,
      inputTokens,
      outputTokens,
      costPaisa,
      provider,
      includedInPlan,
      opts.model ?? '',
      opts.providerCostPaisa ?? 0,
      opts.fallbackFrom ?? null,
    ],
  );
  await query(
    workspaceId,
    "INSERT INTO wallet_transactions (workspace_id, type, amount_paisa) VALUES ($1, 'ai_charge', $2)",
    [workspaceId, -costPaisa],
  );
  return true;
}

function isTestCustomer(channelIdentities: unknown): boolean {
  if (!Array.isArray(channelIdentities)) return false;
  return channelIdentities.some(
    (ident) =>
      ident !== null &&
      typeof ident === 'object' &&
      ((ident as Record<string, unknown>).is_test === true ||
        (ident as Record<string, unknown>).test === true),
  );
}

// ---------------------------------------------------------------------------
// Local demo mode (used when Gemini has no key, or its call fails — e.g.
// HTTP 403 because billing is not enabled on the Google Cloud project).
// Every word of the reply comes from product/knowledge rows in the DB;
// prices and stock are read from the tools, never invented. Every demo
// reply is labelled and charged at the flat 10 paisa like a real reply.
// ---------------------------------------------------------------------------

const DEMO_LABEL = '[ডেমো AI — আসল Gemini নয়] ';

function taka(paisa: number): string {
  return `৳${(paisa / 100).toLocaleString('en-IN')}`;
}

const DEMO_STOPWORDS = new Set([
  'দাম', 'কত', 'টাকা', 'আছে', 'কি', 'কী', 'আমার', 'একটা', 'একটি', 'চাই',
  'করতে', 'দিতে', 'নিতে', 'করে', 'হবে', 'কেমন', 'আপনার', 'আপনাদের', 'এই',
  'ওই', 'সেই', 'আর', 'বা', 'এবং', 'দিন', 'ডেলিভারি', 'কবে', 'কোথায়',
  'কোন', 'কোনটা', 'আসসালামু', 'আলাইকুম', 'হ্যালো', 'ভাই', 'আপু', 'স্যার',
  'ম্যাম', 'please', 'price', 'how', 'much', 'order', 'the', 'is', 'a',
  'an', 'to', 'me', 'i', 'want',
]);

function demoKeywords(text: string): string[] {
  // \p{M} (combining marks) must stay: Bengali vowel signs like া/ি are
  // marks, and splitting them off would shred words ("শাড়ি" → "শ","ড়","র").
  const words = text.split(/[^\p{L}\p{M}\p{N}]+/u).filter((w) => w.length >= 2);
  return [...new Set(words.filter((w) => !DEMO_STOPWORDS.has(w.toLowerCase())))];
}

const ORDER_INTENT = /অর্ডার|নিতে চাই|কিনতে চাই|অর্ডার করতে|অর্ডার দিতে|অর্ডার করব|order/i;

// (Bengali product aliases live in ai-agent/detect-intent.ts and are
// imported above — the demo matcher and the photo flows share them.)

interface DemoProduct {
  id: string;
  name: string;
  pricePaisa: number;
  stock: number;
}

async function runDemoReply(
  workspaceId: string,
  conversationId: string,
  customerId: string | null,
  channelPlatform: string | null,
  batchedMessages: BatchedMessage[],
  products: DemoProduct[],
  knowledge: { title: string | null; body: string }[],
  allowance: AiReplyAllowance,
  gender: CustomerGender = 'unknown',
  /** Requirement C: the owner's configured delivery charges (one Bengali line). */
  deliveryChargeSummary = '',
  /** Customer memory: the customer's REAL order history (for "আমার অর্ডারটা কোথায়"). */
  orderSummary: CustomerOrderSummary = { totalOrders: 0, pendingCount: 0, recent: [] },
): Promise<ProcessBatchResult> {
  const text = batchedMessages.map((m) => m.body).join(' ');
  const keywords = demoKeywords(text);

  // CUSTOMER MEMORY (2026-11-08): "আমার অর্ডারটা কোথায়" is a STATUS
  // question, not an order placement — it must be answered FIRST, before
  // the ORDER_INTENT branches below (which would otherwise try to create
  // a new order). The reply comes ONLY from the real order summary: the
  // ASI number + Bengali status, or an honest "no order yet".
  if (isOrderStatusQuestion(text)) {
    const sal = genderSalutation(gender);
    const open = sal ? `${sal}, ` : '';
    let orderReply: string;
    if (orderSummary.totalOrders === 0) {
      orderReply = `${DEMO_LABEL}${open}আপনার এখনো কোনো অর্ডার নেই। অর্ডার করতে চাইলে প্রোডাক্টের নাম লিখুন।`;
    } else if (orderSummary.recent.length === 1) {
      const o = orderSummary.recent[0];
      orderReply = `${DEMO_LABEL}${open}আপনার অর্ডার ${o.orderNumber} এখন ${o.statusBn} অবস্থায় আছে। মোট ৳${(o.totalPaisa / 100).toLocaleString('en-IN')}।`;
    } else {
      const lines = orderSummary.recent.map((o) => `• ${o.orderNumber} — ${o.statusBn}, মোট ৳${(o.totalPaisa / 100).toLocaleString('en-IN')}`).join('\n');
      orderReply = `${DEMO_LABEL}${open}আপনার অর্ডারগুলোর অবস্থা:\n${lines}`;
    }
    // The opening already carries the salutation (via `open`) — just add
    // the closing line, same as the other demo replies.
    const salutation = genderSalutation(gender);
    if (salutation) {
      orderReply = `${orderReply}\nধন্যবাদ, ${salutation}।`;
    } else if (!orderReply.includes('আপন')) {
      orderReply = `${orderReply}\nধন্যবাদ।`;
    }
    await sendChannelMessage(workspaceId, conversationId, channelPlatform, orderReply, { liveSend: false });
    const charged = await chargeForReply(
      workspaceId, conversationId, 0, 0, allowance.costPaisa, 'demo', allowance.mode === 'included',
    );
    return { replied: true, reason: 'demo_mode', confidence: 0.9, costPaisa: charged ? allowance.costPaisa : 0 };
  }

  // Match products by keyword (Bengali inflections included: "শাড়ির"
  // contains "শাড়ি"). Data comes from the DB rows, never invented.
  // Also matches via BENGALI_PRODUCT_ALIASES: a customer asking "শার্টের
  // দাম কত?" must find the product stored as "Shirt".
  const matched = products.filter((p) => {
    const nameLower = p.name.toLowerCase();
    return keywords.some((kw) => {
      const kwLower = kw.toLowerCase();
      if (nameLower.includes(kwLower) || kwLower.includes(nameLower) || nameLower.includes(kwLower.slice(0, 4))) return true;
      return [...BENGALI_PRODUCT_ALIASES, ...ROMANIZED_PRODUCT_ALIASES].some(
        ([alias, en]) => kwLower.includes(alias) && nameLower.includes(en),
      );
    });
  });

  let reply: string;
  let confidence = 0.9;
  // An order created in this demo reply gets the same extras as the live
  // path (invoice image + one short suggestion), sent after the
  // confirmation below (liveSend: false — saved, not sent to a customer).
  let demoCreatedOrder: { orderId: string; productId: string } | null = null;

  if (products.length === 0 && /দাম|price|কত|টাকা/i.test(text)) {
    // Empty catalog + price question: never invent a price, even in demo
    // mode — say plainly (in Bengali) that no products are added yet and
    // ask which product the customer means, so the owner can answer.
    reply = `${DEMO_LABEL}${EMPTY_CATALOG_REPLY}`;
  } else if (ORDER_INTENT.test(text) && matched.length === 1 && customerId) {
    const product = matched[0];
    const created = await runTool(toolDb, workspaceId, 'create_order', {
      customerId,
      conversationId,
      items: [{ productId: product.id, quantity: 1 }],
    });
    if (typeof created.orderId === 'string') {
      // Requirement B: the short confirmation (name, phone, address,
      // items, delivery charge, total, "অর্ডার কনফার্ম করা হলো") — the
      // exact text the tool built, not a reworded reply.
      reply =
        `${DEMO_LABEL}${String(created.confirmationText ?? created.billText ?? '')}`;
      demoCreatedOrder = { orderId: created.orderId, productId: product.id };
    } else {
      reply = `${DEMO_LABEL}দুঃখিত, অর্ডারটি তৈরি করা যায়নি। একজন মানুষ শীঘ্রই আপনাকে সাহায্য করবে।`;
      confidence = 0.5;
      // The AI could not complete the order — a human must take over.
      await escalateConversation(workspaceId, conversationId, 'cant_answer');
      await runTool(toolDb, workspaceId, 'create_ticket', {
        conversationId,
        customerId: customerId ?? '',
        reason: `Demo mode could not create the order: ${text.slice(0, 200)}`,
      });
    }
  } else if (ORDER_INTENT.test(text) && matched.length === 0) {
    const list = products.slice(0, 5).map((p) => `• ${p.name} — ${taka(p.pricePaisa)}`).join('\n');
    reply = `${DEMO_LABEL}কোন প্রোডাক্টের অর্ডার করতে চান? আমাদের প্রোডাক্টগুলো:\n${list || 'এখনো কোনো প্রোডাক্ট যোগ করা হয়নি।'}`;
  } else if (ORDER_INTENT.test(text) && matched.length > 1) {
    const list = matched.map((p) => `• ${p.name} — ${taka(p.pricePaisa)}`).join('\n');
    reply = `${DEMO_LABEL}কোনটির অর্ডার করতে চান?\n${list}\nনামটি লিখে জানান।`;
  } else if (matched.length === 1) {
    // Product card, built from the tool result (price/stock from the DB).
    const product = matched[0];
    const cards = await runTool(toolDb, workspaceId, 'send_product_cards', { productIds: [product.id] });
    const card = (cards.cards as { name: string; pricePaisa: number; stock: number; description: string | null }[] | undefined)?.[0];
    const name = card?.name ?? product.name;
    const price = Number(card?.pricePaisa ?? product.pricePaisa);
    const stock = Number(card?.stock ?? product.stock);
    reply =
      `${DEMO_LABEL}${name}\n` +
      `দাম: ${taka(price)}\n` +
      `স্টক: ${stock > 0 ? `${stock}টি আছে ✅` : 'শেষ হয়ে গেছে ❌'}` +
      (card?.description ? `\n${card.description}` : '') +
      `\nঅর্ডার করতে চাইলে "অর্ডার করতে চাই" লিখুন।`;
  } else if (matched.length > 1) {
    const list = matched.map((p) => `• ${p.name} — ${taka(p.pricePaisa)} (${p.stock > 0 ? 'স্টকে আছে' : 'স্টক শেষ'})`).join('\n');
    reply = `${DEMO_LABEL}আপনার প্রশ্নের সাথে মিলে এমন প্রোডাক্টগুলো:\n${list}\nকোনটি সম্পর্কে জানতে চান?`;
  } else {
    // Requirement C: a delivery-charge question is answered from the
    // owner's CONFIGURED charges, never the knowledge book (the taught
    // knowledge item goes stale when the owner changes the charges).
    const asksDeliveryCharge =
      (/ডেলিভারি/i.test(text) && /চার্জ|কত|টাকা/i.test(text)) ||
      (/delivery/i.test(text) && /charge|koto|cost|how much/i.test(text));
    if (asksDeliveryCharge && deliveryChargeSummary) {
      reply = `${DEMO_LABEL}${deliveryChargeSummary}`;
      confidence = 0.9;
    } else {
      // Knowledge book: answer only from a stored knowledge item.
      const hit = knowledge.find((k) =>
        keywords.some((kw) => (k.title ?? '').includes(kw) || k.body.includes(kw)),
      );
      if (hit) {
        reply = `${DEMO_LABEL}${hit.body}`;
        confidence = 0.8;
      } else {
        reply = `${DEMO_LABEL}দুঃখিত, এই প্রশ্নের উত্তর আমার কাছে নেই। একজন মানুষ শীঘ্রই আপনাকে উত্তর দেবে। ধন্যবাদ!`;
        confidence = 0.5;
        await recordUnanswered(workspaceId, text);
        await runTool(toolDb, workspaceId, 'create_ticket', {
          conversationId,
          customerId: customerId ?? '',
          reason: `Demo mode could not answer: ${text.slice(0, 200)}`,
        });
        // Can't-answer fallback reply — the chat needs a human.
        await escalateConversation(workspaceId, conversationId, 'cant_answer');
      }
    }
  }

  // Gender-aware addressing, same rule as the live prompt: the demo reply
  // is what the customer actually sees when every provider is down (for
  // webchat, saving IS the delivery), so it opens and closes with the same
  // salutation — "স্যার" / "ম্যাডাম" — and stays neutral when unknown.
  // The "[ডেমো AI]" label stays first, so the reply is still honestly
  // marked as a demo reply.
  const salutation = genderSalutation(gender);
  if (salutation) {
    const opened = reply.startsWith(DEMO_LABEL)
      ? DEMO_LABEL + `${salutation}, ` + reply.slice(DEMO_LABEL.length)
      : `${salutation}, ` + reply;
    reply = `${opened}\nধন্যবাদ, ${salutation}।`;
  } else {
    // Unknown gender: neutral "আপনি" addressing — never স্যার/ম্যাডাম.
    // ("আপনার প্রশ্নের উত্তর দিচ্ছি" is the আপনি-form; the "দুঃখিত" fallback
    // already contains "আপনাকে", so only the product replies need it.)
    if (!reply.includes('আপন')) {
      const opened = reply.startsWith(DEMO_LABEL)
        ? DEMO_LABEL + 'আপনার প্রশ্নের উত্তর দিচ্ছি:\n' + reply.slice(DEMO_LABEL.length)
        : 'আপনার প্রশ্নের উত্তর দিচ্ছি:\n' + reply;
      reply = `${opened}\nধন্যবাদ।`;
    }
  }

  // Demo-mode replies are labelled "[ডেমো AI]" — saved only, never sent
  // to a real customer (see sendChannelMessage). The charge below is the
  // pre-existing demo-mode behaviour (the reply is saved in the inbox and
  // the owner is billed for the AI work as before).
  await sendChannelMessage(workspaceId, conversationId, channelPlatform, reply, { liveSend: false });
  // Extras after a demo order confirmation (same as the live path):
  // the invoice IMAGE + one short suggestion (saved, not sent).
  if (demoCreatedOrder) {
    await sendOrderConfirmationExtras(
      workspaceId, conversationId, channelPlatform, demoCreatedOrder.orderId,
      [demoCreatedOrder.productId], products, gender, { liveSend: false },
    );
  }
  // Included in the plan → 0 paisa; over the limit → flat 10 paisa overage.
  const charged = await chargeForReply(
    workspaceId, conversationId, 0, 0, allowance.costPaisa, 'demo', allowance.mode === 'included',
  );
  return {
    replied: true,
    reason: 'demo_mode',
    confidence,
    costPaisa: charged ? allowance.costPaisa : 0,
  };
}

export async function processBatch(
  workspaceId: string,
  conversationId: string,
  batchedMessages: BatchedMessage[],
): Promise<ProcessBatchResult> {
  // Independent reads fired together: on Vercel each query is a
  // US→Singapore round-trip (~200ms), so sequential awaits cost
  // seconds across the reply path. Group 1 needs only the ids;
  // group 2 needs the conversation row (and runs only once the
  // workspace exists, so the allowance check never creates a trial
  // subscription for a bogus workspace); group 3 (context) runs only
  // after the subscription gate passes. All early-return semantics
  // and check order are unchanged.
  const [workspace, conversation] = await Promise.all([
    queryOne<{
      id: string;
      ai_enabled: boolean;
      balance_paisa: number;
      practice_mode: boolean;
      ai_provider: string | null;
      ai_model: string | null;
    }>(
      workspaceId,
      'SELECT id, ai_enabled, balance_paisa, practice_mode, ai_provider, ai_model FROM workspaces WHERE id = $1',
      [workspaceId],
    ),
    queryOne<{
      id: string;
      mode: string;
      customer_id: string | null;
      channel_id: string | null;
    }>(
      workspaceId,
      'SELECT id, mode, customer_id, channel_id FROM conversations WHERE workspace_id = $1 AND id = $2',
      [workspaceId, conversationId],
    ),
  ]);
  if (!workspace) return { replied: false, reason: 'workspace_not_found' };
  if (!workspace.ai_enabled) return { replied: false, reason: 'ai_disabled' };
  // The workspace's AI choice (explicit columns, else the system default).
  // Resolved once here so the demo-mode ticket below names the right
  // provider even when no AI call was made.
  const aiChoice: WorkspaceAiChoice = await resolveWorkspaceAi(workspaceId, {
    ai_provider: workspace.ai_provider,
    ai_model: workspace.ai_model,
  });
  // NOTE: no early balance check here — the subscription gate below decides.
  // Replies included in the plan are free (0 paisa) even with a 0 wallet
  // balance; only over-limit replies need wallet money (10 paisa).
  if (!conversation) return { replied: false, reason: 'conversation_not_found' };
  if (conversation.mode !== 'ai') return { replied: false, reason: 'human_mode' };

  // Voice note? Transcribe FIRST — before the anger / off-topic /
  // gibberish checks — so the transcript (the customer's actual words)
  // is what those checks and the LLM see. A failed transcription is
  // remembered (voiceFailed) and answered honestly AFTER the
  // subscription gate below (which owns sending + charging); the body
  // stays "[ভয়েস মেসেজ]" so the checks below cannot misfire on it.
  // Voice REPLY (the AI speaking back) is not built — the reply is text.
  let voiceFailed = false;
  let voiceNote = false;
  const audioMsg = [...batchedMessages].reverse().find((m) => m.mediaType === 'audio' && m.mediaUrl);
  if (audioMsg) {
    voiceNote = true;
    const transcript = await transcribeCustomerAudio(audioMsg.mediaUrl as string);
    if (transcript) {
      audioMsg.body = transcript;
    } else {
      voiceFailed = true;
    }
  }

  // Angry customer? Escalate FIRST — before any AI call, before the
  // subscription gate — so no AI reply goes out to an angry customer.
  // The chat moves to the Inbox "Waiting" tab (status='waiting',
  // mode='human') with the reason stored, plus a ticket + unanswered
  // record, so a human sees it and takes over. A plain refund request
  // or a normal complaint never matches the anger list (see
  // inbox/escalation.ts) and flows through normally.
  const batchedText = batchedMessages.map((m) => m.body).join(' ');
  if (detectAnger(batchedText)) {
    await escalateConversation(workspaceId, conversationId, 'angry_customer');
    await runTool(toolDb, workspaceId, 'create_ticket', {
      conversationId,
      customerId: conversation.customer_id ?? '',
      reason: `Angry customer — escalated to Waiting: ${batchedText.slice(0, 200)}`,
    });
    await recordUnanswered(workspaceId, batchedText);
    return { replied: false, reason: 'escalated_angry_customer' };
  }

  // Off-topic question? Escalate FIRST too — before any AI call, before
  // the subscription gate — so the AI never answers (and never burns
  // credit on) questions outside the shop's scope: personal questions
  // about the AI ("তুমি ছেলে নাকি মেয়ে?"), weather, sports, politics,
  // jokes, songs, movies, news, trivia. The chat moves to the Inbox
  // "Waiting" tab (status='waiting', mode='human') with the reason
  // stored, plus an unanswered record so the owner can see the question
  // in Teach AI. Greetings and every shop question (products, price,
  // orders, delivery, location, payment) never match the off-topic list
  // (see inbox/escalation.ts) and flow through normally.
  if (detectOffTopic(batchedText)) {
    await escalateConversation(workspaceId, conversationId, 'off_topic');
    await recordUnanswered(workspaceId, batchedText);
    return { replied: false, reason: 'escalated_off_topic' };
  }

  const [customer, channel, allowance] = await Promise.all([
    conversation.customer_id
      ? queryOne<{ id: string; name: string | null; phone: string | null; address: string | null; gender: string | null; channel_identities: unknown }>(
          workspaceId,
          'SELECT id, name, phone, address, gender, channel_identities FROM customers WHERE workspace_id = $1 AND id = $2',
          [workspaceId, conversation.customer_id],
        )
      : Promise.resolve(null),
    conversation.channel_id
      ? queryOne<{ platform: string }>(
          workspaceId,
          'SELECT platform FROM channels WHERE workspace_id = $1 AND id = $2',
          [workspaceId, conversation.channel_id],
        )
      : Promise.resolve(null),
    checkAiReplyAllowance(workspaceId),
  ]);

  // Practice mode: only answer the owner's test messages. A test customer is
  // marked with {"is_test": true} in channel_identities (set by the owner /
  // seed data). Everyone else is left for a human.
  if (workspace.practice_mode && !isTestCustomer(customer?.channel_identities)) {
    return { replied: false, reason: 'practice_mode_non_test' };
  }

  // --- Subscription gate (before any AI work) ---
  // Active plan + under the included limit → reply free (0 paisa).
  // Active + over the limit → 10 paisa overage while the wallet lasts.
  // Expired plan, or over-limit with an empty wallet → NO AI reply.
  // Instead the customer gets a Bengali upgrade notice (saved as the
  // outgoing message, so the inbox shows it) and the team gets a ticket.
  // Never silently fail, never silently reply.
  if (!allowance.allowed) {
    await sendChannelMessage(workspaceId, conversationId, channel?.platform ?? null, UPGRADE_NOTICE);
    await runTool(toolDb, workspaceId, 'create_ticket', {
      conversationId,
      customerId: customer?.id ?? '',
      reason: `সাবস্ক্রিপশন বন্ধ — AI উত্তর দেয়নি: ${allowance.reasonBn} (প্ল্যান নবায়ন করতে হবে।)`,
    });
    return { replied: false, reason: 'subscription_blocked', confidence: 0 };
  }

  // --- Deterministic replies that need NO AI call (no AI credit) ---
  // They run after the subscription gate (an expired plan still gets
  // the upgrade notice above, never photos) but before the provider
  // call. A sent reply is still charged the normal reply cost (0 when
  // included in the plan, else the flat overage) — the same rule as any
  // other reply; the saving is the AI provider cost, which is 0 here.
  const replyGender: CustomerGender = normalizeCustomerGender(customer?.gender);
  const chargeDeterministic = async (): Promise<number> => {
    const charged = await chargeForReply(
      workspaceId, conversationId, 0, 0, allowance.costPaisa, 'deterministic', allowance.mode === 'included',
    );
    return charged ? allowance.costPaisa : 0;
  };
  const latestText = batchedMessages.length > 0 ? (batchedMessages[batchedMessages.length - 1]?.body ?? '') : '';

  // Voice note that could not be transcribed — reply honestly, never
  // fake it. The customer is asked to write instead. (Voice reply —
  // the AI speaking back — is not built; the reply is text.)
  if (voiceFailed) {
    const sal = genderSalutation(replyGender);
    const reply = sal
      ? `${sal}, আপনার ভয়েস মেসেজটি শুনতে পারিনি। কষ্ট করে লিখে জানাবেন কি — কোন প্রোডাক্টটি চান?`
      : 'আপনার ভয়েস মেসেজটি শুনতে পারিনি। কষ্ট করে লিখে জানাবেন কি — কোন প্রোডাক্টটি চান?';
    const sent = await sendChannelMessage(workspaceId, conversationId, channel?.platform ?? null, reply);
    if (!sent.sent) return { replied: false, reason: 'send_failed', confidence: 0.7 };
    const cost = await chargeDeterministic();
    return { replied: true, reason: 'voice_unheard', confidence: 0.9, costPaisa: cost };
  }

  // LIKE / STICKER (2026-11-08, user report): a thumbs-up "like" is NOT
  // a product photo. It arrives as a sticker attachment (mediaType
  // 'sticker', body '[লাইক]'/'[স্টিকার]') and must NEVER run the photo
  // match / vision flow — that bug replied "আমাদের কাছে এই প্রোডাক্ট
  // নেই, তবে এই সিমিলার প্রোডাক্ট দেখতে পারেন" to a like. Reply
  // contextually and SHORTLY: if the previous chat was about a product,
  // a brief acknowledgment tied to it; otherwise a short "how can I
  // help you?". No product mention unless the chat was about one.
  const likeMsg = [...batchedMessages].reverse().find(
    (m) => m.mediaType === 'sticker' || m.body === '[লাইক]' || m.body === '[স্টিকার]',
  );
  if (likeMsg) {
    const { rows: lastOutRows } = await query<{ body: string | null }>(
      workspaceId,
      `SELECT body FROM messages WHERE workspace_id = $1 AND conversation_id = $2 AND direction = 'out' ORDER BY created_at DESC LIMIT 1`,
      [workspaceId, conversationId],
    );
    const { rows: likeProducts } = await query<{ name: string }>(
      workspaceId,
      'SELECT name FROM products WHERE workspace_id = $1',
      [workspaceId],
    );
    const lastOutBody = lastOutRows[0]?.body ?? '';
    const aboutProduct = likeProducts.some((p) => p.name && lastOutBody.includes(p.name));
    const lsal = genderSalutation(replyGender);
    const likeReply = aboutProduct
      ? lsal
        ? `${lsal}, ধন্যবাদ! কোন প্রোডাক্টটা নিতে চাচ্ছেন, নামটা লিখে জানান।`
        : 'ধন্যবাদ! কোন প্রোডাক্টটা নিতে চাচ্ছেন, নামটা লিখে জানান।'
      : lsal
        ? `${lsal}, কিভাবে আপনাকে সাহায্য করতে পারি?`
        : 'কিভাবে আপনাকে সাহায্য করতে পারি?';
    const lsent = await sendChannelMessage(workspaceId, conversationId, channel?.platform ?? null, likeReply);
    if (!lsent.sent) return { replied: false, reason: 'send_failed', confidence: 0.9 };
    const lcost = await chargeDeterministic();
    return { replied: true, reason: 'like_acknowledged', confidence: 0.95, costPaisa: lcost };
  }

  // SHOP LOCATION (2026-11-08): "দোকান কোথায়?" / "তোমাদের সব কোথায়?"
  // gets ONE line from the knowledge book ("আমাদের দোকান মাগুরায়।"),
  // never a paragraph. No AI call — the answer is a stored fact.
  if (detectShopLocation(latestText)) {
    const { rows: locRows } = await query<{ body: string }>(
      workspaceId,
      `SELECT body FROM knowledge_items WHERE workspace_id = $1
         AND (title ILIKE '%ঠিকানা%' OR title ILIKE '%অবস্থান%')
       ORDER BY created_at DESC LIMIT 1`,
      [workspaceId],
    );
    const locBody = locRows[0]?.body?.trim();
    if (locBody) {
      const ssal = genderSalutation(replyGender);
      const locReply = ssal ? `${ssal}, ${locBody}` : locBody;
      const ssent = await sendChannelMessage(workspaceId, conversationId, channel?.platform ?? null, locReply);
      if (!ssent.sent) return { replied: false, reason: 'send_failed', confidence: 0.9 };
      const scost = await chargeDeterministic();
      return { replied: true, reason: 'shop_location', confidence: 0.95, costPaisa: scost };
    }
    // No stored location — fall through to the LLM (knowledge + brevity guard).
  }

  // Gibberish guard (deterministic, pre-AI, ZERO token): a meaningless
  // message gets ONE "আমি আপনার কথাটি বুঝতে পারিনি" reply per episode,
  // then further gibberish is ignored silently — no reply, no charge,
  // no AI call — until the customer writes something meaningful (which
  // clears the flag). A normal message (Banglish, "Hi", "Ata", product
  // words) can never match detectGibberish (see inbox/escalation.ts).
  if (detectGibberish(latestText)) {
    const { rows: gwRows } = await query<{ gibberish_warned: boolean }>(
      workspaceId,
      'SELECT gibberish_warned FROM conversations WHERE workspace_id = $1 AND id = $2',
      [workspaceId, conversationId],
    );
    if (!gwRows[0]?.gibberish_warned) {
      const sal = genderSalutation(replyGender);
      const reply = sal
        ? `${sal}, আমি আপনার কথাটি বুঝতে পারিনি, কষ্ট করে আবার বলবেন।`
        : 'আমি আপনার কথাটি বুঝতে পারিনি, কষ্ট করে আবার বলবেন।';
      const sent = await sendChannelMessage(workspaceId, conversationId, channel?.platform ?? null, reply);
      if (!sent.sent) return { replied: false, reason: 'send_failed', confidence: 0.7 };
      await query(
        workspaceId,
        'UPDATE conversations SET gibberish_warned = TRUE, updated_at = now() WHERE workspace_id = $1 AND id = $2',
        [workspaceId, conversationId],
      );
      const cost = await chargeDeterministic();
      return { replied: true, reason: 'gibberish_once', confidence: 0.9, costPaisa: cost };
    }
    return { replied: false, reason: 'gibberish_ignored' };
  }
  // A meaningful message resets the episode — a future gibberish gets
  // its one reply again. (Only touches the row when the flag is set.)
  await query(
    workspaceId,
    'UPDATE conversations SET gibberish_warned = FALSE, updated_at = now() WHERE workspace_id = $1 AND id = $2 AND gibberish_warned = TRUE',
    [workspaceId, conversationId],
  );

  // Order cancellation — NEVER instant. A clear cancel ask creates a
  // PENDING cancel request for the owner to approve (orders/cancel.ts)
  // + an owner notification (bell + order view), and the customer gets
  // the professional reply ("আমরা প্রতিনিধির কাছে অর্ডার ক্যান্সেলের
  // জন্য অনুরোধ করছি"). The order itself stays in its current status.
  // Delivered / already-cancelled orders get an honest reply and NO
  // request. Runs before the LLM so the wording is guaranteed.
  const cancelMsg = [...batchedMessages].reverse().find((m) => detectCancelRequest(m.body));
  if (cancelMsg && customer?.id) {
    const outcome = await requestOrderCancellation(toolDb, workspaceId, {
      customerId: customer.id,
      conversationId,
      reason: cancelMsg.body,
      orderNumber: extractOrderNumber(cancelMsg.body),
    });
    const csent = await sendChannelMessage(workspaceId, conversationId, channel?.platform ?? null, outcome.replyText);
    if (!csent.sent) return { replied: false, reason: 'send_failed', confidence: 0.9 };
    const cost = await chargeDeterministic();
    return { replied: true, reason: `cancel_request_${outcome.outcome}`, confidence: 0.95, costPaisa: cost };
  }

  // Acknowledgment — "OK" / "ঠিক আছে" / "হ্যাঁ" / "ধন্যবাদ" gets a
  // SHORT polite reply and nothing more: no question ("আপনি কি কিছু
  // বলতে যাচ্ছেন?"), no product push. A bare "হ্যাঁ" after a yes/no
  // question is still just acknowledged — the customer says more when
  // they want to.
  if (detectAcknowledgment(latestText)) {
    const sal = genderSalutation(replyGender);
    const reply = acknowledgmentKind(latestText) === 'thanks'
      ? (sal ? `আপনাকেও ধন্যবাদ, ${sal}।` : 'আপনাকেও ধন্যবাদ।')
      : (sal ? `ঠিক আছে ${sal}, ধন্যবাদ।` : 'ঠিক আছে, ধন্যবাদ।');
    const asent = await sendChannelMessage(workspaceId, conversationId, channel?.platform ?? null, reply);
    if (!asent.sent) return { replied: false, reason: 'send_failed', confidence: 0.9 };
    const acost = await chargeDeterministic();
    return { replied: true, reason: 'acknowledged', confidence: 0.95, costPaisa: acost };
  }

  // Photo → product match (the CORE behaviour): the customer sent a photo
  // saying they want that product. Gemini vision matches it against the
  // REAL catalog (customer photo + product photos, see ai-agent/media.ts);
  // the reply is then built deterministically from the DB — a matched
  // product's name/price/stock, an out-of-stock note, or "not ours" with
  // similar products. No price or stock is ever invented (the hallucination
  // guard below also covers this reply). Vision unavailable → an honest
  // fallback, never a guessed match.
  const newestMedia = batchedMessages.length > 0 ? batchedMessages[batchedMessages.length - 1] : undefined;
  if (newestMedia?.mediaType === 'image' && newestMedia.mediaUrl) {
    const { rows: matchProducts } = await query<{
      id: string; name: string; price_paisa: number; stock: number; description: string | null; image_url: string | null;
    }>(
      workspaceId,
      `SELECT p.id, p.name, p.price_paisa, p.stock, p.description,
              (SELECT pi.url FROM product_images pi WHERE pi.workspace_id = $1 AND pi.product_id = p.id ORDER BY pi.created_at ASC LIMIT 1) AS image_url
       FROM products p WHERE p.workspace_id = $1 ORDER BY p.created_at ASC`,
      [workspaceId],
    );
    const outcome = await analyseCustomerImage(newestMedia.mediaUrl, matchProducts.map((p) => ({
      id: p.id, name: p.name, pricePaisa: Number(p.price_paisa), stock: Number(p.stock),
      description: p.description, imageUrl: p.image_url,
    })));
    const sal = genderSalutation(replyGender);
    if (!outcome) {
      const reply = sal
        ? `${sal}, আপনার ছবিটি দেখতে পারিনি। কষ্ট করে প্রোডাক্টের নাম লিখে জানাবেন?`
        : 'আপনার ছবিটি দেখতে পারিনি। কষ্ট করে প্রোডাক্টের নাম লিখে জানাবেন?';
      const sent = await sendChannelMessage(workspaceId, conversationId, channel?.platform ?? null, reply);
      if (!sent.sent) return { replied: false, reason: 'send_failed', confidence: 0.7 };
      const cost = await chargeDeterministic();
      return { replied: true, reason: 'photo_unseen', confidence: 0.9, costPaisa: cost };
    }
    const matched = outcome.matchedId ? matchProducts.find((p) => p.id === outcome.matchedId) : undefined;
    if (matched) {
      if (Number(matched.stock) > 0) {
        // In stock: the product's photo + name, price, details.
        if (matched.image_url) {
          await deliverOutgoingImageMessage(workspaceId, conversationId, matched.image_url);
        }
        const details =
          `${matched.name}\nদাম: ${taka(Number(matched.price_paisa))}\nস্টক: ${Number(matched.stock)}টি আছে ✅` +
          (matched.description ? `\n${matched.description}` : '') +
          '\nঅর্ডার করতে চাইলে নাম, ফোন নম্বর ও ঠিকানা জানান।';
        const body = sal ? `${sal}, এই প্রোডাক্টটি আমাদের কাছে আছে — ${details}\nধন্যবাদ, ${sal}।` : `এই প্রোডাক্টটি আমাদের কাছে আছে — ${details}\nধন্যবাদ।`;
        const dsent = await sendChannelMessage(workspaceId, conversationId, channel?.platform ?? null, body);
        if (!dsent.sent) return { replied: false, reason: 'send_failed', confidence: 0.95 };
        const cost = await chargeDeterministic();
        return { replied: true, reason: 'photo_matched_in_stock', confidence: 0.95, costPaisa: cost };
      }
      // Matched but out of stock — say so nicely, never invent a date.
      const reply = sal
        ? `${sal}, ${matched.name} এখন স্টক আউট হয়ে গেছে। খুব শীঘ্রই আসবে — আসলেই জানিয়ে দেবো। ততক্ষণে অন্য কোনো প্রোডাক্ট দেখতে চাইলে জানাবেন।`
        : `${matched.name} এখন স্টক আউট হয়ে গেছে। খুব শীঘ্রই আসবে — আসলেই জানিয়ে দেবো। ততক্ষণে অন্য কোনো প্রোডাক্ট দেখতে চাইলে জানাবেন।`;
      const sent = await sendChannelMessage(workspaceId, conversationId, channel?.platform ?? null, reply);
      if (!sent.sent) return { replied: false, reason: 'send_failed', confidence: 0.95 };
      const cost = await chargeDeterministic();
      return { replied: true, reason: 'photo_matched_out_of_stock', confidence: 0.95, costPaisa: cost };
    }
    // Not our product — say so, and offer the similar ones (the vision
    // match's similarIds, else the first few catalog products).
    const similar = (outcome.similarIds.length > 0
      ? outcome.similarIds.map((id) => matchProducts.find((p) => p.id === id)).filter((p): p is NonNullable<typeof p> => !!p)
      : matchProducts.slice(0, 3));
    const similarList = similar.length > 0
      ? similar.map((p) => `• ${p.name} — ${taka(Number(p.price_paisa))}`).join('\n')
      : '';
    const reply = sal
      ? `${sal}, আমাদের কাছে এই প্রোডাক্টটি নেই, তবে এই সিমিলার প্রোডাক্টগুলো দেখতে পারেন:\n${similarList}\nকোনটি সম্পর্কে জানতে চান?`
      : `আমাদের কাছে এই প্রোডাক্টটি নেই, তবে এই সিমিলার প্রোডাক্টগুলো দেখতে পারেন:\n${similarList}\nকোনটি সম্পর্কে জানতে চান?`;
    const sent = await sendChannelMessage(workspaceId, conversationId, channel?.platform ?? null, reply);
    if (!sent.sent) return { replied: false, reason: 'send_failed', confidence: 0.9 };
    const cost = await chargeDeterministic();
    return { replied: true, reason: 'photo_not_our_product', confidence: 0.9, costPaisa: cost };
  }

  // Repeat greeting: the customer greets again after the chat is already
  // underway (an outgoing reply exists) — do NOT send a fresh generic
  // welcome. Ask contextually what they want. A FIRST greeting (no
  // outgoing reply yet) falls through to the LLM for a normal welcome.
  if (detectGreeting(latestText)) {
    const { rows: outRows } = await query<{ n: string }>(
      workspaceId,
      "SELECT COUNT(*)::text AS n FROM messages WHERE workspace_id = $1 AND conversation_id = $2 AND direction = 'out'",
      [workspaceId, conversationId],
    );
    if (Number(outRows[0]?.n ?? 0) > 0) {
      const sal = genderSalutation(replyGender);
      const reply = sal
        ? `${sal}, আপনি কি প্রোডাক্টটা নেবেন, নাকি নতুন করে কিছু বলতে চাচ্ছেন?`
        : 'আপনি কি প্রোডাক্টটা নেবেন, নাকি নতুন করে কিছু বলতে চাচ্ছেন?';
      const sent = await sendChannelMessage(workspaceId, conversationId, channel?.platform ?? null, reply);
      if (!sent.sent) return { replied: false, reason: 'send_failed', confidence: 0.9 };
      const cost = await chargeDeterministic();
      return { replied: true, reason: 'repeat_greeting', confidence: 0.9, costPaisa: cost };
    }
  }

  // "Why do you reply so fast?" — deflect as a human shop assistant.
  // NEVER "আমি AI বলে দ্রুত উত্তর দিই". Not off-topic, not escalated.
  if (detectFastReplyQuestion(batchedText)) {
    const sal = genderSalutation(replyGender);
    const deflection = sal
      ? `${sal}, আপনার সেবা দেওয়ার জন্য আমরা সবসময় দ্রুত উত্তর দেওয়ার চেষ্টা করি।`
      : 'আপনার সেবা দেওয়ার জন্য আমরা সবসময় দ্রুত উত্তর দেওয়ার চেষ্টা করি।';
    const sent = await sendChannelMessage(workspaceId, conversationId, channel?.platform ?? null, deflection);
    if (!sent.sent) return { replied: false, reason: 'send_failed', confidence: 0.7 };
    const cost = await chargeDeterministic();
    return { replied: true, reason: 'deflected_fast_reply', confidence: 0.9, costPaisa: cost };
  }

  // Product photos / list — deterministic (no AI call).
  //
  // (1) Single product FIRST: "জিন্সটা দেখাও" → its photo + details.
  // (1b) Photo request WITHOUT a product ("ছবি দেন"): ask WHICH product
  //     they want to see — never send every photo unasked.
  // (2) List request ("কি কি প্রোডাক্ট আছে"): a CLEAN TEXT LIST, one
  //     product per line (name + price) — not a jumbled sentence and
  //     not a photo flood. Only when the NEWEST message asks for it, and
  //     only when it was not already the immediately-preceding reply
  //     (then a short pointer reply goes out instead).
  if (detectProductListRequest(batchedText) || looksLikeShowRequest(batchedText)) {
    const { rows: photoProducts } = await query<{
      id: string; name: string; price_paisa: number; stock: number; description: string | null; image_url: string | null;
    }>(
      workspaceId,
      `SELECT p.id, p.name, p.price_paisa, p.stock, p.description,
              (SELECT pi.url FROM product_images pi WHERE pi.workspace_id = $1 AND pi.product_id = p.id ORDER BY pi.created_at ASC LIMIT 1) AS image_url
       FROM products p WHERE p.workspace_id = $1 ORDER BY p.created_at ASC`,
      [workspaceId],
    );

    // (1) Single product FIRST: "জিন্সটা দেখাও" → its photo + details.
    const showProduct = matchShowProduct(batchedText, photoProducts);
    if (showProduct) {
      const p = photoProducts.find((x) => x.id === showProduct.id);
      if (p?.image_url) {
        const img = await deliverOutgoingImageMessage(workspaceId, conversationId, p.image_url);
        if (img.sent) {
          const sal = genderSalutation(replyGender);
          const details =
            `${p.name}\nদাম: ${taka(Number(p.price_paisa))}\nস্টক: ${Number(p.stock) > 0 ? `${Number(p.stock)}টি আছে ✅` : 'শেষ হয়ে গেছে ❌'}` +
            (p.description ? `\n${p.description}` : '') +
            '\nঅর্ডার করতে চাইলে নাম, ফোন নম্বর ও ঠিকানা জানান।';
          const body = sal ? `${sal}, ${details}\nধন্যবাদ, ${sal}।` : `${details}\nধন্যবাদ।`;
          const dsent = await sendChannelMessage(workspaceId, conversationId, channel?.platform ?? null, body);
          if (dsent.sent) {
            const cost = await chargeDeterministic();
            return { replied: true, reason: 'product_photo_sent', confidence: 0.95, costPaisa: cost };
          }
        }
      }
      // No photo or the send failed — fall through to the LLM path.
    }

    // (1b) Photo request without a product: ask which one they want.
    // (A list request is not a bare photo request — it goes to (2).)
    if (looksLikeShowRequest(latestText) && !detectProductListRequest(latestText)) {
      const sal = genderSalutation(replyGender);
      const ask = sal
        ? `${sal}, কোন প্রোডাক্টটি দেখতে চাচ্ছেন? নামটা লিখে জানান।`
        : 'কোন প্রোডাক্টটি দেখতে চাচ্ছেন? নামটা লিখে জানান।';
      const asent = await sendChannelMessage(workspaceId, conversationId, channel?.platform ?? null, ask);
      if (asent.sent) {
        const cost = await chargeDeterministic();
        return { replied: true, reason: 'ask_which_product_photo', confidence: 0.95, costPaisa: cost };
      }
      // Ask send failed — fall through to the LLM path.
    }

    // (2) The list, as a clean text list — one product per line.
    if (detectProductListRequest(latestText) && photoProducts.length > 0) {
      const { rows: lastOut } = await query<{ body: string | null }>(
        workspaceId,
        `SELECT body FROM messages WHERE workspace_id = $1 AND conversation_id = $2 AND direction = 'out' ORDER BY created_at DESC LIMIT 1`,
        [workspaceId, conversationId],
      );
      const lastBody = lastOut[0]?.body ?? '';
      const listJustSent = lastBody.includes('আমাদের প্রোডাক্টগুলো:') || lastBody.includes('আপনি কোন প্রোডাক্টে আগ্রহী?');
      if (!listJustSent) {
        const list = photoProducts
          .map((p) => `• ${p.name} — ${taka(Number(p.price_paisa))}${Number(p.stock) > 0 ? '' : ' (স্টক শেষ)'}`)
          .join('\n');
        // Just the list — nothing more (prompt rule 0/10). No trailing
        // question, no extra line: the customer asked for the list.
        const sal = genderSalutation(replyGender);
        const reply = sal
          ? `${sal}, আমাদের প্রোডাক্টগুলো:\n${list}`
          : `আমাদের প্রোডাক্টগুলো:\n${list}`;
        const lsent = await sendChannelMessage(workspaceId, conversationId, channel?.platform ?? null, reply);
        if (lsent.sent) {
          const cost = await chargeDeterministic();
          return { replied: true, reason: 'product_list_sent', confidence: 0.95, costPaisa: cost };
        }
        // List send failed — fall through to the LLM path.
      } else {
        // List was just sent — do NOT re-send it. Answer with a short
        // pointer instead (deterministic, so it can never escalate the
        // chat the way a can't-answer LLM reply would): the customer
        // just got the list above; ask which product they want to see.
        const sal2 = genderSalutation(replyGender);
        const pointer = sal2
          ? `${sal2}, প্রোডাক্টের তালিকাটা একটু আগেই পাঠিয়েছি — উপরে দেখতে পাবেন। কোন প্রোডাক্টটা দেখতে চান, নামটা লিখে জানান।`
          : 'প্রোডাক্টের তালিকাটা একটু আগেই পাঠিয়েছি — উপরে দেখতে পাবেন। কোন প্রোডাক্টটা দেখতে চান, নামটা লিখে জানান।';
        const psent = await sendChannelMessage(workspaceId, conversationId, channel?.platform ?? null, pointer);
        if (psent.sent) {
          const cost = await chargeDeterministic();
          return { replied: true, reason: 'list_already_sent', confidence: 0.95, costPaisa: cost };
        }
        // Pointer send failed — fall through to the LLM path.
      }
    }
  }

  const [{ rows: historyRows }, { rows: openOrders }, { rows: knowledge }, { rows: products }, deliveryRules, orderSummary] = await Promise.all([
    query<{ direction: string; body: string | null }>(
      workspaceId,
      `SELECT direction, body FROM messages WHERE workspace_id = $1 AND conversation_id = $2
       ORDER BY created_at DESC LIMIT 20`,
      [workspaceId, conversationId],
    ),
    query<{ id: string; status: string; total_paisa: number }>(
      workspaceId,
      `SELECT id, status, total_paisa FROM orders
       WHERE workspace_id = $1 AND conversation_id = $2 AND status <> 'delivered' ORDER BY created_at DESC LIMIT 5`,
      [workspaceId, conversationId],
    ),
    query<{ title: string | null; body: string }>(
      workspaceId,
      'SELECT title, body FROM knowledge_items WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 10',
      [workspaceId],
    ),
    query<{ id: string; name: string; price_paisa: number; stock: number }>(
      workspaceId,
      'SELECT id, name, price_paisa, stock FROM products WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 20',
      [workspaceId],
    ),
    // Requirement C: the owner's configured delivery charges (seeded with
    // the ৳100/৳130 defaults on first use). The AI quotes these, never a
    // hardcoded number.
    getDeliveryChargeRules(
      { query: (text: string, params?: unknown[]) => query(workspaceId, text, params ?? []) },
      workspaceId,
    ),
    // Customer memory: the customer's REAL order history (total, pending,
    // recent with ASI number + Bengali status) — the AI answers
    // "আমার অর্ডারটা কোথায়" from this, never invents one.
    (customer?.id
      ? getCustomerOrderSummary(
          { query: (text: string, params?: unknown[]) => query(workspaceId, text, params ?? []) },
          workspaceId,
          customer.id,
        )
      : Promise.resolve({ totalOrders: 0, pendingCount: 0, recent: [] } satisfies CustomerOrderSummary)),
  ]);

  // Gender-aware addressing: the stored gender (inferred from the name,
  // or set by hand in the Inbox) decides the salutation — "স্যার" for men,
  // "ম্যাডাম" for women, neutral "আপনি" when unknown. Never guessed.
  const customerGender: CustomerGender = normalizeCustomerGender(customer?.gender);
  const ctx: AgentContext = {
    customerName: customer?.name ?? null,
    customerPhone: customer?.phone ?? null,
    customerAddress: customer?.address ?? null,
    customerGender,
    history: [...historyRows].reverse(),
    openOrders: openOrders.map((o) => ({ id: o.id, status: o.status, totalPaisa: Number(o.total_paisa) })),
    orderSummary,
    knowledge,
    products: products.map((p) => ({ id: p.id, name: p.name, pricePaisa: Number(p.price_paisa), stock: Number(p.stock) })),
    messages: batchedMessages.map((m) => m.body),
    deliveryCharges: deliveryChargeSummaryText(deliveryRules),
  };

  // PRODUCT-PUSH LIMIT (2026-11-08): don't dump products at the customer
  // over and over. Count how many recent outgoing replies already
  // mentioned a product name; once it is 2+ and the new message is NOT
  // a product question, tell the model to stop pushing products and just
  // answer the question. The deterministic list flow above already
  // refuses to re-send the list consecutively — this covers the LLM.
  const productMentions = historyRows.filter(
    (m) => m.direction === 'out' && ctx.products.some((p) => (m.body ?? '').includes(p.name)),
  ).length;
  const isProductQuestion =
    detectProductListRequest(batchedText) ||
    looksLikeShowRequest(batchedText) ||
    /দাম|price|স্টক|stock|অর্ডার|order/i.test(batchedText);
  const productPushNote =
    productMentions >= 2 && !isProductQuestion
      ? 'এই চ্যাটে প্রোডাক্টের কথা ইতিমধ্যে ২ বার বলা হয়েছে — কাস্টমার আগ্রহ দেখায়নি। এবার প্রোডাক্টের কথা তুলো না; শুধু তার প্রশ্নের উত্তর দাও।'
      : '';
  const voicePromptNote = voiceNote
    ? 'নতুন মেসেজটি কাস্টমারের ভয়েস মেসেজ থেকে লেখায় রূপান্তর করা হয়েছে — উত্তর টেক্সটে (বাংলায়) দাও, ভয়েসে নয়।'
    : '';

  const prompt = `${SYSTEM_PROMPT}\n\n${buildUserPrompt(ctx)}${productPushNote ? `\n\n${productPushNote}` : ''}${voicePromptNote ? `\n\n${voicePromptNote}` : ''}`;

  let ai: AiCallResult | null = null;
  let aiError: string | null = null;
  try {
    // Unified dispatcher: the workspace's chosen provider, falling back to
    // Groq on any failure (the outcome names the provider that answered).
    ai = await callAiForWorkspace(workspaceId, prompt, aiChoice);
  } catch (err) {
    aiError = (err as Error).message;
    console.error(`[agent] ${aiChoice.provider} call failed — using labelled local demo mode:`, aiError);
  }

  // No API key, or the provider is unavailable (e.g. Gemini HTTP 403 —
  // billing not enabled; Groq HTTP 401/429 — bad key / rate limit):
  // clearly-labelled local demo mode. Replies come ONLY from
  // product/knowledge data via tools — never invented.
  if (!ai) {
    const result = await runDemoReply(
      workspaceId,
      conversationId,
      customer?.id ?? null,
      channel?.platform ?? null,
      batchedMessages,
      ctx.products,
      ctx.knowledge,
      allowance,
      customerGender,
      ctx.deliveryCharges ?? '',
      ctx.orderSummary,
    );
    // Alert a human that the real AI provider is down / not configured.
    await runTool(toolDb, workspaceId, 'create_ticket', {
      conversationId,
      customerId: customer?.id ?? '',
      reason: aiError
        ? `${aiChoice.provider} unavailable: ${aiError.slice(0, 200)}`
        : `${aiChoice.provider} API key not configured`,
    });
    return result;
  }

  const provider = ai.provider;
  // Included in the plan → 0 paisa; over the limit → flat 10 paisa overage
  // (the gate above already checked the wallet can cover it).
  const replyCost = allowance.mode === 'included' ? 0 : AI_REPLY_COST_PAISA;
  let parsed = parseGeminiReply(ai.text);
  let inputTokens = ai.inputTokens;
  let outputTokens = ai.outputTokens;

  // Execute any tool calls, then ask the SAME provider once more with the
  // tool results (the provider that answered first answers again).
  // Amounts the tools returned (e.g. a just-created order's bill total)
  // are real DB numbers, so the hallucination guard below must allow them.
  let toolResultAmounts: number[] = [];
  if (parsed && parsed.toolCalls.length > 0) {
    const results: { tool: string; result: unknown }[] = [];
    for (const call of parsed.toolCalls) {
      const args = { ...call.args, customerId: customer?.id ?? call.args.customerId, conversationId };
      const result = await runTool(toolDb, workspaceId, call.tool, args);
      results.push({ tool: call.tool, result });
    }
    toolResultAmounts = toolResultAmountsFrom(results);
    // Requirement B: a successful create_order gets the SHORT confirmation
    // message (name, phone, address, items, delivery charge, total,
    // "অর্ডার কনফার্ম করা হলো") sent deterministically — the exact text
    // the tool built, not a reworded LLM reply. Sending it here skips the
    // second LLM call (saves tokens) and guarantees the format. If the
    // send fails, fall through to the normal second-call path so the
    // customer still gets a reply.
    const createdOrder = results.find(
      (r) =>
        r.tool === 'create_order' &&
        typeof (r.result as Record<string, unknown> | null)?.orderId === 'string' &&
        typeof (r.result as Record<string, unknown> | null)?.confirmationText === 'string',
    );
    if (createdOrder) {
      const confirmationText = String((createdOrder.result as Record<string, unknown>).confirmationText);
      const confirmSent = await sendChannelMessage(workspaceId, conversationId, channel?.platform ?? null, confirmationText);
      if (confirmSent.sent) {
        const confirmProviderCostPaisa = computeAiCostPaisa(provider, ai.model, inputTokens, outputTokens);
        const charged = await chargeForReply(
          workspaceId, conversationId, inputTokens, outputTokens, replyCost, provider, allowance.mode === 'included',
          { model: ai.model, providerCostPaisa: confirmProviderCostPaisa, fallbackFrom: ai.fallbackFrom ?? null },
        );
        // Extras AFTER the confirmation (best-effort, never blocks it):
        // the invoice IMAGE, then ONE short product suggestion.
        const orderId = String((createdOrder.result as Record<string, unknown>).orderId);
        const createCall = parsed.toolCalls.find((c) => c.tool === 'create_order');
        const orderedIds = Array.isArray((createCall?.args as Record<string, unknown> | undefined)?.items)
          ? (((createCall?.args as Record<string, unknown>).items as Record<string, unknown>[]) ?? [])
              .map((it) => String(it.productId ?? ''))
              .filter(Boolean)
          : [];
        await sendOrderConfirmationExtras(
          workspaceId, conversationId, channel?.platform ?? null, orderId, orderedIds, ctx.products, customerGender,
        );
        return { replied: true, reason: 'order_confirmed', confidence: 0.95, costPaisa: charged ? replyCost : 0 };
      }
      // Confirmation send failed — fall through to the second LLM call.
    }
    // A request_order_cancellation tool call gets its exact professional
    // reply sent deterministically too — the wording ("আমরা প্রতিনিধির
    // কাছে অর্ডার ক্যান্সেলের জন্য অনুরোধ করছি") must reach the customer
    // verbatim, never reworded by the second LLM call.
    const cancelCall = results.find(
      (r) =>
        r.tool === 'request_order_cancellation' &&
        typeof (r.result as Record<string, unknown> | null)?.replyText === 'string',
    );
    if (cancelCall) {
      const replyText = String((cancelCall.result as Record<string, unknown>).replyText);
      const cancelSent = await sendChannelMessage(workspaceId, conversationId, channel?.platform ?? null, replyText);
      if (cancelSent.sent) {
        const cancelProviderCostPaisa = computeAiCostPaisa(provider, ai.model, inputTokens, outputTokens);
        const charged = await chargeForReply(
          workspaceId, conversationId, inputTokens, outputTokens, replyCost, provider, allowance.mode === 'included',
          { model: ai.model, providerCostPaisa: cancelProviderCostPaisa, fallbackFrom: ai.fallbackFrom ?? null },
        );
        return { replied: true, reason: 'cancel_request_created', confidence: 0.95, costPaisa: charged ? replyCost : 0 };
      }
      // Cancel reply send failed — fall through to the second LLM call.
    }
    // Second-call prompt is SHORT on purpose: the full prompt (~2700
    // tokens) doubles input tokens and burns quota on the follow-up, and
    // a 429/503 there used to send the model's placeholder reply as-is.
    // The draft reply + tool results + the customer's messages are all
    // the model needs to write the final answer.
    const secondPrompt =
      `${addressingLine(customerGender)}\n\n` +
      `কাস্টমারের মেসেজ:\n${batchedMessages.map((m) => m.body ?? '').join('\n')}\n\n` +
      `তোমার খসড়া উত্তর: ${parsed?.reply ?? ''}\n\n` +
      `টুলের ফলাফল (শুধু এখানকার তথ্য ব্যবহার করো, বানিয়ে কিছু বলো না):\n` +
      JSON.stringify(results) +
      '\n\nএবার চূড়ান্ত JSON উত্তর দাও: {"reply": "...", "confidence": 0.0-1.0, "toolCalls": []}';
    let secondOk = false;
    try {
      const second = await callProvider(provider, secondPrompt, ai.model);
      if (second) {
        const secondParsed = parseGeminiReply(second.text);
        if (secondParsed) {
          parsed = secondParsed;
          inputTokens += second.inputTokens;
          outputTokens += second.outputTokens;
          secondOk = true;
        }
      }
    } catch (err) {
      console.error(`[agent] second ${provider} call failed:`, (err as Error).message);
    }
    // Second call failed or unparseable: if the draft reply has no price
    // but the tools returned real product data, answer deterministically
    // from that data instead of sending a "checking…" placeholder.
    if (!secondOk && parsed && extractPriceAmounts(parsed.reply).length === 0) {
      const deterministic = deterministicProductReply(results, customerGender);
      if (deterministic) {
        parsed = { reply: deterministic, confidence: 0.95, toolCalls: [] };
      }
    }
  }

  if (!parsed || !parsed.reply) {
    await runTool(toolDb, workspaceId, 'create_ticket', {
      conversationId,
      customerId: customer?.id ?? '',
      reason: 'AI returned an empty/unparseable reply',
    });
    await recordUnanswered(workspaceId, batchedMessages.map((m) => m.body).join(' '));
    // No usable answer at all — a human must take over.
    await escalateConversation(workspaceId, conversationId, 'cant_answer');
    return { replied: false, reason: 'empty_reply_ticket_created', confidence: 0 };
  }

  // Low confidence: no customer reply, ticket + unanswered record, human takes over.
  if (parsed.confidence < CONFIDENCE_THRESHOLD) {
    await runTool(toolDb, workspaceId, 'create_ticket', {
      conversationId,
      customerId: customer?.id ?? '',
      reason: `Low confidence (${parsed.confidence}): ${batchedMessages.map((m) => m.body).join(' ')}`,
    });
    await recordUnanswered(workspaceId, batchedMessages.map((m) => m.body).join(' '));
    await escalateConversation(workspaceId, conversationId, 'ai_unsure');
    return { replied: false, reason: 'low_confidence_ticket_created', confidence: parsed.confidence };
  }

  // Deterministic anti-hallucination guard (prompt-independent): any
  // currency-marked amount in the reply that is not a real DB number is
  // replaced with a truthful reply before it can reach the customer.
  // This is what stops "Product price" + empty catalog from ever
  // producing an invented price, even if the model ignores the prompt.
  const guarded = guardReplyAgainstHallucination(parsed.reply, ctx, toolResultAmounts);
  if (guarded.replaced) {
    console.error(
      `[agent] hallucination guard: invented amounts [${guarded.invented.join(', ')}] — reply replaced before send`,
    );
    parsed = { ...parsed, reply: guarded.reply };
  }

  // Brevity guard (2026-11-08): the model can ramble despite prompt
  // rule 0 — cap its reply to the shortest complete sentences that
  // answer the question, always keeping prices and the invoice /
  // confirmation lines. The deterministic order confirmation never
  // reaches this point (it returns earlier), so it is never trimmed.
  const shortened = shortenReply(parsed.reply);
  if (shortened.shortened) {
    console.log(`[agent] brevity guard: trimmed reply ${parsed.reply.length} -> ${shortened.reply.length} chars`);
    parsed = { ...parsed, reply: shortened.reply };
  }

  // Send the reply for real (Meta Graph API). Only a delivered reply is
  // charged — an undelivered reply costs the shop nothing, so a failed
  // send returns here before chargeForReply runs.
  const sendResult = await sendChannelMessage(workspaceId, conversationId, channel?.platform ?? null, parsed.reply);
  if (!sendResult.sent) {
    return {
      replied: false,
      reason: sendResult.windowExpired ? 'send_failed_window_expired' : 'send_failed',
      confidence: parsed.confidence,
      costPaisa: 0,
    };
  }

  // The reply went out but it IS a can't-answer reply ("জানি না…") —
  // the customer was told a human will answer, so the chat belongs in
  // Waiting until a human actually does.
  if (isCantAnswerReply(parsed.reply)) {
    await escalateConversation(workspaceId, conversationId, 'cant_answer');
  }

  // Charge for the reply; stop AI if the balance ran out.
  // Included replies are logged at 0 paisa with included_in_plan=true;
  // overage replies at 10 paisa with included_in_plan=false. The ledger
  // also records the model, the provider's real token cost
  // (providerCostPaisa — recomputed here from the FINAL token counts,
  // Groq always 0) and fallbackFrom when Groq answered instead of the
  // workspace's chosen provider.
  const finalProviderCostPaisa = computeAiCostPaisa(provider, ai.model, inputTokens, outputTokens);
  const charged = await chargeForReply(
    workspaceId, conversationId, inputTokens, outputTokens, replyCost, provider, allowance.mode === 'included',
    { model: ai.model, providerCostPaisa: finalProviderCostPaisa, fallbackFrom: ai.fallbackFrom ?? null },
  );
  if (!charged) {
    return { replied: true, reason: 'replied_but_balance_exhausted_after_send', confidence: parsed.confidence, costPaisa: 0 };
  }
  return { replied: true, reason: 'ok', confidence: parsed.confidence, costPaisa: replyCost };
}
