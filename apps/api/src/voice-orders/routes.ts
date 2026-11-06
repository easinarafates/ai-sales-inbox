import { Router, type Response } from 'express';
import { query, queryOne } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';
import { callGroq } from '../ai-agent/groq';

/**
 * Voice-note orders (Worker B).
 *
 * There is NO real audio transcription service (no money is spent), so:
 * - With a transcript: Groq (free) extracts the order intent and, when a
 *   real product name matches, a DRAFT order is created — status 'pending',
 *   source 'voice', NEVER confirmed, and NO stock is reserved/decremented
 *   until a human confirms it.
 * - Without a transcript: the note is stored honestly as
 *   "voice note received, transcript pending" — nothing is invented.
 */
export const voiceOrdersRouter = Router();
voiceOrdersRouter.use(requireAuth);

interface ExtractedOrder {
  product?: string | null;
  quantity?: number | null;
  name?: string | null;
  phone?: string | null;
  address?: string | null;
}

function bnDigitsToNumber(s: string): number {
  const ascii = s.replace(/[০-৯]/g, (d) => String('০১২৩৪৫৬৭৮৯'.indexOf(d)));
  const n = parseInt(ascii, 10);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Deterministic quantity from the transcript itself (ground truth, not AI):
 * "শাড়ি ২টি" / "শাড়ি 2টা" / "২ পিস শাড়ি" → 2. Bengali digits ০-৯ included.
 * Returns null when no quantity is written in the transcript.
 */
function parseQuantityFromTranscript(transcript: string, productName: string | null): number | null {
  const qtyUnit = '[০-৯0-9]+\\s*(?:টি|টা|খানা|পিস|pcs)?';
  if (productName) {
    const after = transcript.match(new RegExp(`${escapeRegExp(productName)}\\s*(${qtyUnit})`));
    if (after) {
      const n = bnDigitsToNumber(after[1]);
      if (Number.isFinite(n) && n >= 1 && n <= 100) return n;
    }
    const before = transcript.match(new RegExp(`(${qtyUnit})\\s*${escapeRegExp(productName)}`));
    if (before) {
      const n = bnDigitsToNumber(before[1]);
      if (Number.isFinite(n) && n >= 1 && n <= 100) return n;
    }
  }
  const anyQty = transcript.match(new RegExp(`([০-৯0-9]+)\\s*(?:টি|টা|খানা|পিস|pcs)`));
  if (anyQty) {
    const n = bnDigitsToNumber(anyQty[1]);
    if (Number.isFinite(n) && n >= 1 && n <= 100) return n;
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseGroqJson(text: string): ExtractedOrder | null {
  const tryParse = (s: string): ExtractedOrder | null => {
    try {
      const parsed = JSON.parse(s) as { reply?: string } & ExtractedOrder;
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.reply === 'string') {
          try {
            return JSON.parse(parsed.reply) as ExtractedOrder;
          } catch {
            return null;
          }
        }
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(text);
  if (direct) return direct;
  const match = text.match(/\{[\s\S]*\}/);
  return match ? tryParse(match[0]) : null;
}

/** POST /api/inbox/:id/voice-note {transcript?, durationSec?, audioRef?} */
voiceOrdersRouter.post('/inbox/:id/voice-note', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { transcript, durationSec, audioRef } = (req.body ?? {}) as {
    transcript?: string;
    durationSec?: number;
    audioRef?: string;
  };
  const conversation = await queryOne<{ id: string; customer_id: string | null }>(
    workspaceId,
    'SELECT id, customer_id FROM conversations WHERE workspace_id = $1 AND id = $2',
    [workspaceId, req.params.id],
  );
  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  const cleanTranscript = typeof transcript === 'string' && transcript.trim() ? transcript.trim() : null;
  const status = cleanTranscript ? 'received' : 'transcript_pending';

  const { rows } = await query(
    workspaceId,
    `INSERT INTO voice_notes (workspace_id, conversation_id, transcript, duration_sec, audio_ref, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, conversation_id, transcript, duration_sec, audio_ref, status, extracted, order_id, created_at`,
    [workspaceId, req.params.id, cleanTranscript, durationSec ?? null, audioRef ?? null, status],
  );
  const voiceNote = rows[0];

  // Show the voice note in the inbox thread (honest label when no transcript).
  await query(
    workspaceId,
    `INSERT INTO messages (workspace_id, conversation_id, direction, type, body)
     VALUES ($1, $2, 'in', 'voice', $3)`,
    [
      workspaceId,
      req.params.id,
      cleanTranscript ?? '🎤 ভয়েস নোট এসেছে — লেখা (ট্রান্সক্রিপ্ট) এখনো হয়নি।',
    ],
  );

  if (!cleanTranscript) {
    res.status(201).json({
      voiceNote,
      extracted: null,
      draftOrder: null,
      note: 'Voice note received, transcript pending — no order was created from it.',
    });
    return;
  }

  // Extract order intent with Groq (free). Prices/products are NEVER taken
  // from the AI — only the product NAME is matched against the real table.
  let extracted: ExtractedOrder | null = null;
  let aiAvailable = false;
  try {
    const result = await callGroq(
      `Extract order details from this Bengali voice-note transcript. Reply with JSON only, ` +
        `inside the "reply" field, in this exact shape: ` +
        `{"product": "<product name or null>", "quantity": <number or null>, ` +
        `"name": "<customer name or null>", "phone": "<phone or null>", "address": "<address or null>"}. ` +
        `Use null for anything not stated. Never invent a product, price or address.\n` +
        `Transcript: ${cleanTranscript}`,
    );
    if (result) {
      aiAvailable = true;
      extracted = parseGroqJson(result.text);
    }
  } catch (err) {
    console.error('[voice-note] Groq extraction failed:', (err as Error).message);
  }

  let draftOrder: Record<string, unknown> | null = null;
  // Match the product name against the REAL products table — first from
  // the Groq extraction, then (deterministic fallback) by finding a real
  // product name written in the transcript itself. Prices are never taken
  // from the AI or the transcript, only from the products table.
  let productName = extracted?.product?.trim() || null;
  if (!productName) {
    const { rows: products } = await query<{ name: string }>(
      workspaceId,
      'SELECT name FROM products WHERE workspace_id = $1 ORDER BY created_at ASC',
      [workspaceId],
    );
    const found = products.find((p) => p.name && cleanTranscript.includes(p.name));
    if (found) productName = found.name;
  }
  if (productName) {
    const product = await queryOne<{ id: string; price_paisa: number; stock: number }>(
      workspaceId,
      'SELECT id, price_paisa, stock FROM products WHERE workspace_id = $1 AND name ILIKE $2 ORDER BY created_at ASC LIMIT 1',
      [workspaceId, `%${productName}%`],
    );
    if (product && conversation.customer_id) {
      // Quantity: the transcript itself is ground truth ("শাড়ি ২টি" → 2);
      // Groq's extraction is only a fallback — it has misread Bengali digits.
      const transcriptQty = parseQuantityFromTranscript(cleanTranscript, productName);
      const quantity = Math.max(1, Math.floor(transcriptQty ?? extracted?.quantity ?? 1));
      const total = Number(product.price_paisa) * quantity;
      const { rows: orderRows } = await query(
        workspaceId,
        `INSERT INTO orders (workspace_id, customer_id, conversation_id, source, status, payment_status, total_paisa)
         VALUES ($1, $2, $3, 'voice', 'pending', 'unpaid', $4)
         RETURNING id, status, payment_status, total_paisa, source`,
        [workspaceId, conversation.customer_id, req.params.id, total],
      );
      draftOrder = orderRows[0];
      await query(
        workspaceId,
        `INSERT INTO order_items (workspace_id, order_id, product_id, quantity, price_paisa)
         VALUES ($1, $2, $3, $4, $5)`,
        [workspaceId, draftOrder.id, product.id, quantity, Number(product.price_paisa)],
      );
      await query(
        workspaceId,
        `INSERT INTO order_events (workspace_id, order_id, from_status, to_status, note)
         VALUES ($1, $2, NULL, 'pending', 'Voice-note draft — not confirmed, no stock reserved')`,
        [workspaceId, draftOrder.id],
      );
    }
  }

  const { rows: updated } = await query(
    workspaceId,
    `UPDATE voice_notes
     SET extracted = $1::jsonb, order_id = $2, status = 'processed', updated_at = now()
     WHERE workspace_id = $3 AND id = $4
     RETURNING id, conversation_id, transcript, duration_sec, audio_ref, status, extracted, order_id, created_at`,
    [extracted ? JSON.stringify(extracted) : null, draftOrder?.id ?? null, workspaceId, voiceNote.id],
  );
  res.status(201).json({
    voiceNote: updated[0] ?? voiceNote,
    extracted,
    draftOrder,
    aiAvailable,
    note: draftOrder
      ? 'Draft order created from the voice note — not confirmed, no stock reserved.'
      : 'No draft order: the product could not be matched to a real product in your shop.',
  });
});

/** GET /api/inbox/:id/voice-notes — list voice notes for a conversation. */
voiceOrdersRouter.get('/inbox/:id/voice-notes', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const conversation = await queryOne<{ id: string }>(
    workspaceId,
    'SELECT id FROM conversations WHERE workspace_id = $1 AND id = $2',
    [workspaceId, req.params.id],
  );
  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  const { rows } = await query(
    workspaceId,
    `SELECT id, conversation_id, transcript, duration_sec, audio_ref, status, extracted, order_id, created_at
     FROM voice_notes WHERE workspace_id = $1 AND conversation_id = $2 ORDER BY created_at DESC LIMIT 100`,
    [workspaceId, req.params.id],
  );
  res.json({ voiceNotes: rows });
});
