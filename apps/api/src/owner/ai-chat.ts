/**
 * Owner AI chat — "AI Sales Manager" / "এআই সেলস ম্যানেজার" (2026-11-11).
 * Mounted at /api/owner/ai-chat (see apps/api/src/index.ts — mounted
 * BEFORE /api/owner, because the Owner Panel router's requireOwner
 * platform-owner gate would otherwise 403 every workspace owner here).
 *
 * The shop OWNER asks the AI about the shop's day in plain Bengali —
 * "আজকে কতগুলো অর্ডার হয়েছে?", "কত টাকা খরচ হয়েছে?" — and the AI
 * answers from the workspace's REAL database numbers, never invented
 * ones. Every reply is computed server-side first (orders, ledger,
 * wallet, top products for TODAY, Asia/Dhaka day) and handed to
 * Gemini (gemini-3.5-flash-lite ONLY, config.aiModel) as context.
 *
 * Access: requireAuth + requireWorkspaceOwner (Task 14 pattern, same as
 * AI Providers) — members/admins get 403. This is NOT the platform-owner
 * gate (owner/ownerAuth.ts): a shop owner is not a platform owner.
 *
 * Honesty rules:
 * - The stats block IS the truth. If a number is 0 the context says 0
 *   and the reply must say 0. The prompt forbids inventing numbers.
 * - If Gemini is unavailable (no key / error / timeout) the route does
 *   NOT fail: it answers with a deterministic Bengali reply built
 *   straight from the same stats (buildStatsReply), so the owner still
 *   gets the true numbers. `usedGemini` in the response says which path
 *   answered.
 * - The chat's own AI cost is recorded honestly in ai_usage_ledger like
 *   other replies (provider_cost_paisa = the real Gemini token cost,
 *   computed by pricing.ts; 0 when the deterministic fallback answered
 *   because no AI call happened). cost_paisa is 0: the owner's own chat
 *   is NOT a customer reply, so it never deducts from the wallet and
 *   never consumes a reply-package credit. conversation_id is NULL —
 *   this is not a customer conversation. The row is visible on the
 *   Billing page (usage list) with its real provider/model/cost.
 * - Pricing is untouched; the Groq fallback for CUSTOMER replies is
 *   untouched (this router never touches agent.ts).
 *
 * Endpoints (all owner-only):
 * - GET  /api/owner/ai-chat — last 50 messages, oldest first.
 * - POST /api/owner/ai-chat {message} — save + answer. Returns
 *   {reply, stats, aiCostPaisa, usedGemini, ledgerId}.
 * - POST /api/owner/ai-chat/_test/seed — verifier-only seed (orders +
 *   ledger rows + wallet balance). 404 unless ALLOW_OWNER_TEST_HOOKS.
 */
import { Router, type Response } from 'express';
import { config } from '../config';
import { pool, query } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth, requireWorkspaceOwner } from '../auth/auth';
import { callGeminiMultimodal } from '../ai-agent/gemini';
import { computeAiCostPaisa } from '../ai-agent/pricing';

export const ownerAiChatRouter = Router();
ownerAiChatRouter.use(requireAuth);
ownerAiChatRouter.use(requireWorkspaceOwner);

// ---------------------------------------------------------------------------
// Stats — real workspace numbers for TODAY (Asia/Dhaka day)
// ---------------------------------------------------------------------------

export interface OwnerChatStats {
  /** YYYY-MM-DD in Asia/Dhaka. */
  date: string;
  ordersTodayCount: number;
  ordersTodayValuePaisa: number;
  ordersTodayByStatus: { status: string; count: number; valuePaisa: number }[];
  /** Currently pending orders (any date — pending is a live state). */
  pendingCount: number;
  pendingValuePaisa: number;
  /** AI replies today = ai_usage_ledger rows created today (one row = one AI reply). */
  aiRepliesToday: number;
  /** Customer messages received today (messages.direction = 'in'). */
  customerMessagesToday: number;
  /** AI/outbound messages sent today (messages.direction = 'out'). */
  aiMessagesToday: number;
  /** SUM(provider_cost_paisa) from ai_usage_ledger today. */
  aiCostTodayPaisa: number;
  aiCostTodayTaka: number;
  walletBalancePaisa: number;
  walletBalanceTaka: number;
  topProductsToday: { name: string; quantity: number; valuePaisa: number }[];
}

/** Start of today in Asia/Dhaka, as a UTC instant (for timestamptz compares). */
export function dhakaDayStart(now = new Date()): { start: Date; date: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '01';
  const y = Number(get('year'));
  const m = Number(get('month'));
  const d = Number(get('day'));
  return {
    start: new Date(Date.UTC(y, m - 1, d, 0, 0, 0)),
    date: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
  };
}

const taka = (paisa: number): number => Math.round(paisa) / 100;

export async function computeOwnerChatStats(workspaceId: string): Promise<OwnerChatStats> {
  const { start, date } = dhakaDayStart();
  const dayIso = start.toISOString();

  const ordersToday = await query<{ count: string; total: string }>(
    workspaceId,
    `SELECT COUNT(*) AS count, COALESCE(SUM(total_paisa), 0) AS total
     FROM orders WHERE workspace_id = $1 AND created_at >= $2`,
    [workspaceId, dayIso],
  );
  const byStatus = await query<{ status: string; count: string; total: string }>(
    workspaceId,
    `SELECT status, COUNT(*) AS count, COALESCE(SUM(total_paisa), 0) AS total
     FROM orders WHERE workspace_id = $1 AND created_at >= $2
     GROUP BY status ORDER BY count DESC`,
    [workspaceId, dayIso],
  );
  const pending = await query<{ count: string; total: string }>(
    workspaceId,
    `SELECT COUNT(*) AS count, COALESCE(SUM(total_paisa), 0) AS total
     FROM orders WHERE workspace_id = $1 AND status = 'pending'`,
    [workspaceId],
  );
  const ledgerToday = await query<{ replies: string; cost: string }>(
    workspaceId,
    `SELECT COUNT(*) AS replies, COALESCE(SUM(provider_cost_paisa), 0) AS cost
     FROM ai_usage_ledger WHERE workspace_id = $1 AND created_at >= $2`,
    [workspaceId, dayIso],
  );
  const messagesToday = await query<{ direction: string; count: string }>(
    workspaceId,
    `SELECT direction, COUNT(*) AS count FROM messages
     WHERE workspace_id = $1 AND created_at >= $2 GROUP BY direction`,
    [workspaceId, dayIso],
  );
  const wallet = await query<{ balance_paisa: number }>(
    workspaceId,
    'SELECT balance_paisa FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  const topProducts = await query<{ name: string | null; quantity: string; value: string }>(
    workspaceId,
    `SELECT p.name AS name, SUM(oi.quantity) AS quantity,
            SUM(oi.quantity * oi.price_paisa) AS value
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     LEFT JOIN products p ON p.id = oi.product_id
     WHERE oi.workspace_id = $1 AND o.created_at >= $2
     GROUP BY p.name ORDER BY value DESC LIMIT 5`,
    [workspaceId, dayIso],
  );

  const msgCount = (dir: string): number =>
    Number(messagesToday.rows.find((r) => r.direction === dir)?.count ?? 0);
  const aiCost = Number(ledgerToday.rows[0]?.cost ?? 0);
  const balance = Number(wallet.rows[0]?.balance_paisa ?? 0);

  return {
    date,
    ordersTodayCount: Number(ordersToday.rows[0]?.count ?? 0),
    ordersTodayValuePaisa: Number(ordersToday.rows[0]?.total ?? 0),
    ordersTodayByStatus: byStatus.rows.map((r) => ({
      status: r.status,
      count: Number(r.count),
      valuePaisa: Number(r.total),
    })),
    pendingCount: Number(pending.rows[0]?.count ?? 0),
    pendingValuePaisa: Number(pending.rows[0]?.total ?? 0),
    aiRepliesToday: Number(ledgerToday.rows[0]?.replies ?? 0),
    customerMessagesToday: msgCount('in'),
    aiMessagesToday: msgCount('out'),
    aiCostTodayPaisa: aiCost,
    aiCostTodayTaka: taka(aiCost),
    walletBalancePaisa: balance,
    walletBalanceTaka: taka(balance),
    topProductsToday: topProducts.rows.map((r) => ({
      name: r.name ?? '—',
      quantity: Number(r.quantity),
      valuePaisa: Number(r.value),
    })),
  };
}

// ---------------------------------------------------------------------------
// Reply text — Gemini first, deterministic stats reply as the honest fallback
// ---------------------------------------------------------------------------

/** Bengali digits, so the owner reads the numbers in his own script. */
export function bn(n: number): string {
  return String(n).replace(/[0-9]/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)]);
}

/** The exact stats block Gemini sees — plain numbers, no decoration. */
export function statsBlock(stats: OwnerChatStats): string {
  const statusLine =
    stats.ordersTodayByStatus.length > 0
      ? stats.ordersTodayByStatus.map((s) => `${s.status}: ${s.count}টি`).join(', ')
      : 'কোনো অর্ডার নেই';
  const topLine =
    stats.topProductsToday.length > 0
      ? stats.topProductsToday.map((p) => `${p.name} (${p.quantity}টি, ৳${taka(p.valuePaisa)})`).join(', ')
      : 'কোনো পণ্য বিক্রি হয়নি';
  return [
    `আজকের তারিখ (ঢাকা): ${stats.date}`,
    `আজকের সব অর্ডার মিলিয়ে: ${stats.ordersTodayCount}টি অর্ডার, মোট মূল্য ${stats.ordersTodayValuePaisa} পয়সা (৳${taka(stats.ordersTodayValuePaisa)})`,
    `আজকের অর্ডারের অবস্থা ভাগ করে: ${statusLine}`,
    `পেন্ডিং অবস্থায় থাকা অর্ডার (আজকের + আগের সব দিনের): ${stats.pendingCount}টি অর্ডার, সেগুলোর মোট মূল্য ${stats.pendingValuePaisa} পয়সা (৳${taka(stats.pendingValuePaisa)})`,
    `আজ AI উত্তর: ${stats.aiRepliesToday}টি (ledger), আজ কাস্টমার মেসেজ: ${stats.customerMessagesToday}টি, আজ AI মেসেজ: ${stats.aiMessagesToday}টি`,
    `আজ AI খরচ: ${stats.aiCostTodayPaisa} পয়সা (৳${taka(stats.aiCostTodayPaisa)})`,
    `ওয়ালেট ব্যালেন্স: ${stats.walletBalancePaisa} পয়সা (৳${taka(stats.walletBalancePaisa)})`,
    `আজকের সেরা পণ্য: ${topLine}`,
  ].join('\n');
}

/**
 * Deterministic Bengali reply built straight from the stats — used when
 * Gemini is unavailable, so the owner still gets the true numbers
 * instead of an error. Every sentence states the real number (0 when 0);
 * nothing is invented. Keyword-matched to the question; anything else
 * gets the full-day summary.
 */
export function buildStatsReply(message: string, stats: OwnerChatStats): string {
  const m = message.toLowerCase();
  const ordersLine = `আজ ${bn(stats.ordersTodayCount)}টি অর্ডার হয়েছে, মোট ৳${bn(Math.round(taka(stats.ordersTodayValuePaisa) * 100) / 100)} (${bn(stats.ordersTodayValuePaisa)} পয়সা)।`;
  const costLine = `আজ AI খরচ হয়েছে ${bn(stats.aiCostTodayPaisa)} পয়সা (৳${bn(taka(stats.aiCostTodayPaisa))})।`;
  const pendingLine = `পেন্ডিং অর্ডার ${bn(stats.pendingCount)}টি, মোট ৳${bn(taka(stats.pendingValuePaisa))}।`;
  const repliesLine = `আজ AI উত্তর দিয়েছে ${bn(stats.aiRepliesToday)}টি, কাস্টমার মেসেজ এসেছে ${bn(stats.customerMessagesToday)}টি।`;
  const walletLine = `ওয়ালেট ব্যালেন্স ৳${bn(taka(stats.walletBalancePaisa))} (${bn(stats.walletBalancePaisa)} পয়সা)।`;
  const topLine =
    stats.topProductsToday.length > 0
      ? `আজকের সেরা পণ্য: ${stats.topProductsToday.map((p) => `${p.name} (${bn(p.quantity)}টি, ৳${bn(taka(p.valuePaisa))})`).join(', ')}।`
      : 'আজ এখনো কোনো পণ্য বিক্রি হয়নি।';
  if (m.includes('পেন্ডিং')) return pendingLine;
  if (m.includes('অর্ডার')) return ordersLine;
  if (m.includes('রিপ্লাই') || m.includes('উত্তর') || m.includes('মেসেজ')) return repliesLine;
  if (m.includes('ওয়ালেট') || m.includes('ব্যালেন্স')) return walletLine;
  if (m.includes('পণ্য') || m.includes('প্রোডাক্ট') || m.includes('সেরা') || m.includes('বিক্রি')) return topLine;
  return `আজকের হিসাব (${stats.date}): ${ordersLine} ${costLine} ${pendingLine} ${repliesLine} ${walletLine} ${topLine}`;
}

interface ChatRow {
  id: string;
  role: string;
  content: string;
  created_at: string;
}

function publicMessage(row: ChatRow) {
  return { id: row.id, role: row.role, content: row.content, createdAt: row.created_at };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** GET /api/owner/ai-chat — history for this workspace, oldest first. */
ownerAiChatRouter.get('/', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rows } = await query<ChatRow>(
    workspaceId,
    `SELECT id, role, content, created_at FROM owner_ai_chats
     WHERE workspace_id = $1 ORDER BY created_at ASC, id ASC LIMIT 50`,
    [workspaceId],
  );
  res.json({ messages: rows.map(publicMessage) });
});

/** POST /api/owner/ai-chat {message} — ask the AI about today's real numbers. */
ownerAiChatRouter.post('/', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { message } = (req.body ?? {}) as { message?: string };
  if (!message || typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ error: 'message is required' });
    return;
  }
  if (message.trim().length > 2000) {
    res.status(400).json({ error: 'message must be 2000 characters or less' });
    return;
  }
  const text = message.trim();

  // Stats FIRST — computed before the reply is recorded, so this reply's
  // own ledger row never inflates the "today" numbers it reports.
  const stats = await computeOwnerChatStats(workspaceId);

  const userRow = await query<{ id: string }>(
    workspaceId,
    `INSERT INTO owner_ai_chats (workspace_id, user_id, role, content)
     VALUES ($1, $2, 'user', $3) RETURNING id`,
    [workspaceId, req.userId ?? null, text],
  );
  void userRow;

  // Recent history for context (last 10 turns, oldest first).
  const { rows: historyRows } = await query<ChatRow>(
    workspaceId,
    `SELECT role, content FROM owner_ai_chats
     WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC LIMIT 10`,
    [workspaceId],
  );
  const historyText = [...historyRows]
    .reverse()
    .map((r) => `${r.role === 'user' ? 'মালিক' : 'AI'}: ${r.content}`)
    .join('\n');

  const prompt = [
    'তুমি YEARBITO-র "AI Sales Manager" — দোকানের মালিকের সহকারী। সহজ বাংলায়, ছোট করে উত্তর দাও।',
    'নিচের হিসাবটাই আসল সত্য — এটা ডাটাবেস থেকে নেওয়া। এই সংখ্যার বাইরে কোনো সংখ্যা বানাবে না, অনুমান করবে না। কোনো সংখ্যা ০ হলে সোজা ০ বলবে। টাকার অঙ্ক বললে পয়সা আর টাকা দুটোই বলবে (যেমন: ৩০ পয়সা, ৳০.৩০) — পয়সার অঙ্কটা ঠিক যেমন দেওয়া আছে তেমনই লিখবে, নিজে গুণ-ভাগ করে নতুন অঙ্ক বানাবে না। অর্ডার নিয়ে প্রশ্ন হলে শুধু সংখ্যা নয়, মোট মূল্যও (পয়সা আর টাকা) বলবে — "আজকের সব অর্ডার মিলিয়ে" লাইনের মোট মূল্যটাই বলবে, পেন্ডিং লাইনের মূল্যটা নয়। খরচ নিয়ে প্রশ্ন হলে পয়সা আর টাকা দুটোই বলবে; পেন্ডিং নিয়ে প্রশ্ন হলে সংখ্যার সাথে সেগুলোর মোট মূল্যও বলবে।',
    '',
    statsBlock(stats),
    '',
    'আগের কথা:',
    historyText || '(কোনো আগের কথা নেই)',
    '',
    `মালিকের প্রশ্ন: ${text}`,
  ].join('\n');

  let reply = '';
  let usedGemini = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  try {
    // Plain-text call (NOT the JSON-mode callGemini — this chat answers
    // in prose). Gemini gemini-3.5-flash-lite ONLY, via config.aiModel.
    const result = await callGeminiMultimodal([{ text: prompt }]);
    if (result && result.text.trim()) {
      reply = result.text.trim();
      usedGemini = true;
      inputTokens = result.inputTokens;
      outputTokens = result.outputTokens;
      cachedInputTokens = result.cachedInputTokens;
    }
  } catch (err) {
    console.error('[owner/ai-chat] Gemini failed, using stats reply:', (err as Error).message);
  }
  if (!usedGemini) {
    // No key / Gemini error / empty reply — answer from the stats
    // directly instead of failing. The numbers are still the true ones.
    reply = buildStatsReply(text, stats);
  }

  // Record this chat's own AI cost honestly in the ledger (see header:
  // provider cost real, wallet charge 0 — never a customer reply).
  const providerCostPaisa = usedGemini
    ? computeAiCostPaisa('gemini', config.aiModel, inputTokens, outputTokens, cachedInputTokens)
    : 0;
  const ledger = await pool.query<{ id: string }>(
    `INSERT INTO ai_usage_ledger
       (workspace_id, conversation_id, input_tokens, output_tokens, cost_paisa,
        provider, included_in_plan, model, provider_cost_paisa, fallback_from, cached_input_tokens)
     VALUES ($1, NULL, $2, $3, 0, $4, FALSE, $5, $6, $7, $8) RETURNING id`,
    [
      workspaceId,
      inputTokens,
      outputTokens,
      usedGemini ? 'gemini' : 'demo',
      usedGemini ? config.aiModel : '',
      providerCostPaisa,
      usedGemini ? null : 'owner_chat_stats_fallback',
      cachedInputTokens,
    ],
  );
  await query(
    workspaceId,
    `INSERT INTO owner_ai_chats (workspace_id, user_id, role, content)
     VALUES ($1, $2, 'assistant', $3)`,
    [workspaceId, req.userId ?? null, reply],
  );

  res.json({
    reply,
    stats,
    aiCostPaisa: providerCostPaisa,
    usedGemini,
    ledgerId: ledger.rows[0]?.id ?? null,
  });
});

// ---------------------------------------------------------------------------
// Test hook (env-gated, verifier only)
// ---------------------------------------------------------------------------

/**
 * POST /api/owner/ai-chat/_test/seed — seed today's test data so the
 * verifier can check the AI reports REAL numbers: orders (with optional
 * product lines for the top-products stat), ledger rows (known
 * provider_cost_paisa) and the wallet balance. 404 unless
 * ALLOW_OWNER_TEST_HOOKS=true. Same pattern as the owner _test/seed-ledger
 * hook. All rows are created "today" (now), so they land in the Dhaka-day
 * stats.
 */
ownerAiChatRouter.post('/_test/seed', async (req: AuthRequest, res: Response) => {
  if (!config.allowOwnerTestHooks) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const workspaceId = getWorkspaceId(req);
  const body = (req.body ?? {}) as {
    walletBalancePaisa?: number;
    orders?: {
      totalPaisa?: number;
      status?: string;
      productName?: string;
      productPricePaisa?: number;
      quantity?: number;
    }[];
    ledger?: { providerCostPaisa?: number; provider?: string; costPaisa?: number; model?: string }[];
  };
  if (typeof body.walletBalancePaisa === 'number') {
    await pool.query('UPDATE workspaces SET balance_paisa = $1 WHERE id = $2', [
      Math.trunc(body.walletBalancePaisa),
      workspaceId,
    ]);
  }
  let ordersInserted = 0;
  for (const o of body.orders ?? []) {
    const total = Math.trunc(o.totalPaisa ?? 0);
    const status = typeof o.status === 'string' && o.status.trim() ? o.status.trim() : 'pending';
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO orders (workspace_id, customer_id, source, status, total_paisa)
       VALUES ($1, NULL, 'owner_ai_chat_test', $2, $3) RETURNING id`,
      [workspaceId, status, total],
    );
    ordersInserted += 1;
    if (typeof o.productName === 'string' && o.productName.trim()) {
      const price = Math.trunc(o.productPricePaisa ?? total);
      const qty = Math.max(1, Math.trunc(o.quantity ?? 1));
      const prod = await pool.query<{ id: string }>(
        `INSERT INTO products (workspace_id, name, price_paisa, stock)
         VALUES ($1, $2, $3, 100) RETURNING id`,
        [workspaceId, o.productName.trim(), price],
      );
      await pool.query(
        `INSERT INTO order_items (workspace_id, order_id, product_id, quantity, price_paisa)
         VALUES ($1, $2, $3, $4, $5)`,
        [workspaceId, rows[0].id, prod.rows[0].id, qty, price],
      );
    }
  }
  let ledgerInserted = 0;
  for (const l of body.ledger ?? []) {
    await pool.query(
      `INSERT INTO ai_usage_ledger
         (workspace_id, conversation_id, input_tokens, output_tokens, cost_paisa,
          provider, included_in_plan, model, provider_cost_paisa)
       VALUES ($1, NULL, 0, 0, $2, $3, FALSE, $4, $5)`,
      [
        workspaceId,
        Math.trunc(l.costPaisa ?? 0),
        typeof l.provider === 'string' ? l.provider : 'gemini',
        typeof l.model === 'string' ? l.model : config.aiModel,
        Math.trunc(l.providerCostPaisa ?? 0),
      ],
    );
    ledgerInserted += 1;
  }
  res.json({ seeded: { ordersInserted, ledgerInserted } });
});
