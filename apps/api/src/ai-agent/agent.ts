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
 *   from a tool result. Unknown questions go to a human (low confidence).
 * - Phase 2 plug points (NOT built here): courier booking / live tracking
 *   (shipments table + track_parcel tool), follow-up engine (followups
 *   table), post scheduling, WhatsApp/TikTok channels. See the stubs in
 *   tools.ts and the channel platform list.
 *
 * DEMO MODE (no key, or provider call fails):
 * - Gemini: a real key is configured in apps/api/.env (AI_MODEL in config,
 *   now gemini-2.5-flash — gemini-2.0-flash no longer exists). BUT generation
 *   is currently BLOCKED by billing: the Google Cloud project returns
 *   HTTP 403 "The Gemini API free tier is not available for this project"
 *   (and gemini-2.5-flash itself returns 404 "no longer available to new
 *   users", suggesting gemini-3.8-flash). Until billing is enabled on that
 *   project, every Gemini call fails and the agent falls back to Groq.
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
import { runTool, type ToolDb } from './tools';
import {
  callAiForWorkspace,
  callProvider,
  resolveWorkspaceAi,
  type AiCallOutcome,
  type WorkspaceAiChoice,
} from './providers';
import { computeAiCostPaisa } from './pricing';
import { deliverOutgoingMessage, type DeliveryResult } from '../channels/meta-send';

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

export function guardReplyAgainstHallucination(
  reply: string,
  ctx: AgentContext,
  toolResultAmounts: number[] = [],
): { reply: string; replaced: boolean; invented: number[] } {
  const amounts = extractPriceAmounts(reply);
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
      `দামের ব্যাপারে নিশ্চিত তথ্য দিচ্ছি — আমাদের প্রোডাক্টগুলো:\n${list}\nকোনটি সম্পর্কে জানতে চান? নামটি লিখে জানান।`,
    replaced: true,
    invented,
  };
}

async function recordUnanswered(workspaceId: string, question: string): Promise<void> {  const q = question.trim().slice(0, 500);
  if (!q) return;
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
): Promise<ProcessBatchResult> {
  const text = batchedMessages.map((m) => m.body).join(' ');
  const keywords = demoKeywords(text);

  // Match products by keyword (Bengali inflections included: "শাড়ির"
  // contains "শাড়ি"). Data comes from the DB rows, never invented.
  const matched = products.filter((p) =>
    keywords.some(
      (kw) => p.name.includes(kw) || kw.includes(p.name) || p.name.includes(kw.slice(0, 4)),
    ),
  );

  let reply: string;
  let confidence = 0.9;

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
      reply =
        `${DEMO_LABEL}আপনার অর্ডার তৈরি হয়েছে! ✅\n` +
        `${String(created.billText ?? '')}\nশীঘ্রই আমরা আপনার সাথে যোগাযোগ করবো। ধন্যবাদ!`;
    } else {
      reply = `${DEMO_LABEL}দুঃখিত, অর্ডারটি তৈরি করা যায়নি। একজন মানুষ শীঘ্রই আপনাকে সাহায্য করবে।`;
      confidence = 0.5;
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
    }
  }

  // Demo-mode replies are labelled "[ডেমো AI]" — saved only, never sent
  // to a real customer (see sendChannelMessage). The charge below is the
  // pre-existing demo-mode behaviour (the reply is saved in the inbox and
  // the owner is billed for the AI work as before).
  await sendChannelMessage(workspaceId, conversationId, channelPlatform, reply, { liveSend: false });
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
  const workspace = await queryOne<{
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
  );
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

  const conversation = await queryOne<{
    id: string;
    mode: string;
    customer_id: string | null;
    channel_id: string | null;
  }>(
    workspaceId,
    'SELECT id, mode, customer_id, channel_id FROM conversations WHERE workspace_id = $1 AND id = $2',
    [workspaceId, conversationId],
  );
  if (!conversation) return { replied: false, reason: 'conversation_not_found' };
  if (conversation.mode !== 'ai') return { replied: false, reason: 'human_mode' };

  const customer = conversation.customer_id
    ? await queryOne<{ id: string; name: string | null; phone: string | null; channel_identities: unknown }>(
        workspaceId,
        'SELECT id, name, phone, channel_identities FROM customers WHERE workspace_id = $1 AND id = $2',
        [workspaceId, conversation.customer_id],
      )
    : null;

  // Practice mode: only answer the owner's test messages. A test customer is
  // marked with {"is_test": true} in channel_identities (set by the owner /
  // seed data). Everyone else is left for a human.
  if (workspace.practice_mode && !isTestCustomer(customer?.channel_identities)) {
    return { replied: false, reason: 'practice_mode_non_test' };
  }

  const channel = conversation.channel_id
    ? await queryOne<{ platform: string }>(
        workspaceId,
        'SELECT platform FROM channels WHERE workspace_id = $1 AND id = $2',
        [workspaceId, conversation.channel_id],
      )
    : null;

  // --- Subscription gate (before any AI work) ---
  // Active plan + under the included limit → reply free (0 paisa).
  // Active + over the limit → 10 paisa overage while the wallet lasts.
  // Expired plan, or over-limit with an empty wallet → NO AI reply.
  // Instead the customer gets a Bengali upgrade notice (saved as the
  // outgoing message, so the inbox shows it) and the team gets a ticket.
  // Never silently fail, never silently reply.
  const allowance = await checkAiReplyAllowance(workspaceId);
  if (!allowance.allowed) {
    await sendChannelMessage(workspaceId, conversationId, channel?.platform ?? null, UPGRADE_NOTICE);
    await runTool(toolDb, workspaceId, 'create_ticket', {
      conversationId,
      customerId: customer?.id ?? '',
      reason: `সাবস্ক্রিপশন বন্ধ — AI উত্তর দেয়নি: ${allowance.reasonBn} (প্ল্যান নবায়ন করতে হবে।)`,
    });
    return { replied: false, reason: 'subscription_blocked', confidence: 0 };
  }

  const { rows: historyRows } = await query<{ direction: string; body: string | null }>(
    workspaceId,
    `SELECT direction, body FROM messages WHERE workspace_id = $1 AND conversation_id = $2
     ORDER BY created_at DESC LIMIT 20`,
    [workspaceId, conversationId],
  );
  const { rows: openOrders } = await query<{ id: string; status: string; total_paisa: number }>(
    workspaceId,
    `SELECT id, status, total_paisa FROM orders
     WHERE workspace_id = $1 AND conversation_id = $2 AND status <> 'delivered' ORDER BY created_at DESC LIMIT 5`,
    [workspaceId, conversationId],
  );
  const { rows: knowledge } = await query<{ title: string | null; body: string }>(
    workspaceId,
    'SELECT title, body FROM knowledge_items WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 10',
    [workspaceId],
  );
  const { rows: products } = await query<{ id: string; name: string; price_paisa: number; stock: number }>(
    workspaceId,
    'SELECT id, name, price_paisa, stock FROM products WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 20',
    [workspaceId],
  );

  const ctx: AgentContext = {
    customerName: customer?.name ?? null,
    customerPhone: customer?.phone ?? null,
    history: [...historyRows].reverse(),
    openOrders: openOrders.map((o) => ({ id: o.id, status: o.status, totalPaisa: Number(o.total_paisa) })),
    knowledge,
    products: products.map((p) => ({ id: p.id, name: p.name, pricePaisa: Number(p.price_paisa), stock: Number(p.stock) })),
    messages: batchedMessages.map((m) => m.body),
  };

  const prompt = `${SYSTEM_PROMPT}\n\n${buildUserPrompt(ctx)}`;

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
    const secondPrompt =
      `${prompt}\n\nটুলের ফলাফল (শুধু এখানকার তথ্য ব্যবহার করো, বানিয়ে কিছু বলো না):\n` +
      JSON.stringify(results, null, 2) +
      '\n\nএবার চূড়ান্ত JSON উত্তর দাও: {"reply": "...", "confidence": 0.0-1.0, "toolCalls": []}';
    try {
      const second = await callProvider(provider, secondPrompt, ai.model);
      if (second) {
        const secondParsed = parseGeminiReply(second.text);
        if (secondParsed) {
          parsed = secondParsed;
          inputTokens += second.inputTokens;
          outputTokens += second.outputTokens;
        }
      }
    } catch (err) {
      console.error(`[agent] second ${provider} call failed:`, (err as Error).message);
    }
  }

  if (!parsed || !parsed.reply) {
    await runTool(toolDb, workspaceId, 'create_ticket', {
      conversationId,
      customerId: customer?.id ?? '',
      reason: 'AI returned an empty/unparseable reply',
    });
    await recordUnanswered(workspaceId, batchedMessages.map((m) => m.body).join(' '));
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
