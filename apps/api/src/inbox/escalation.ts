/**
 * Automatic escalation to a 'Waiting' status (2026-11-07).
 *
 * The owner asked for a "Waiting" tab in the Inbox: when a customer gets
 * angry, or says something the AI cannot understand, the conversation
 * must move there by itself so a human takes over — the AI must stop
 * replying until the owner clears it.
 *
 * Detection is deterministic and explainable — no new ML model, no new
 * API calls:
 *  - Anger: a curated, conservative keyword list (Bengali + English,
 *    incl. common Romanized Bengali). A plain 'refund' request or a
 *    normal complaint ("দাম বেশি") is NOT anger and never escalates.
 *  - Unsure: the agent's existing low-confidence handoff (confidence <
 *    CONFIDENCE_THRESHOLD in ai-agent/agent.ts) — no second system.
 *  - Can't answer: the AI's own can't-answer / fallback reply, matched
 *    on the canonical phrases the prompt itself uses.
 *
 * Escalation sets status='waiting' AND mode='human' (AI stops), records
 * handover_started_at + handed_to='human' so the existing handover state
 * agrees, and stores WHY (escalation_reason) + WHEN (escalated_at).
 * It never fires twice for the same conversation and never fires when
 * the owner is already handling it (mode already 'human').
 */
import { query } from '../db/pool';

export type EscalationReason = 'ai_unsure' | 'angry_customer' | 'cant_answer';

/** Bengali anger stems — substring match (covers inflections: রাগ → রাগী/রাগান্বিত, ঠক → ঠকবাজ). */
const BENGALI_ANGER_STEMS = [
  'রাগ', // angry / anger
  'বিরক্ত', // annoyed / irritated (covers বিরক্তিকর)
  'বাজে', // bad / rubbish
  'ফালতু', // useless / worthless
  'ধোকা', // deceit
  'প্রতারণ', // fraud (covers প্রতারণা/প্রতারক)
  'চিটার', // cheater
  'ঠক', // cheated (covers ঠকবাজ/ঠকানো)
  'খারাপ', // bad
  'জঘন্য', // horrible / disgusting
];

/** English + Romanized-Bengali anger words — whole-word match only, so "cheat" never fires inside another word. */
const ANGER_WORDS = [
  'angry', 'furious', 'frustrated',
  'cheat', 'cheated', 'cheating', 'fraud', 'fraudulent',
  'scam', 'scammer', 'scammed', 'worst', 'useless', 'terrible', 'horrible',
  // Romanized Bengali, as customers actually type it.
  'rag', 'baje', 'faltu', 'dhoka', 'thok', 'kharap',
];

const ANGER_WORD_RE = new RegExp(`\\b(${ANGER_WORDS.join('|')})\\b`, 'i');

/**
 * Does this customer message read as angry / frustrated? Conservative
 * by design: only the listed words trigger it. A plain refund request,
 * a price complaint, or a normal question never matches.
 */
export function detectAnger(text: string | null | undefined): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  if (BENGALI_ANGER_STEMS.some((stem) => lower.includes(stem))) return true;
  return ANGER_WORD_RE.test(text);
}

/** The canonical can't-answer phrases the prompt itself tells the AI to use. */
const CANT_ANSWER_RE = /জানি না|বুঝতে পারছি না|উত্তর (আমার কাছে )?নেই|I don'?t know|I don'?t understand/i;

/** Is this AI reply a can't-answer / fallback reply? */
export function isCantAnswerReply(text: string | null | undefined): boolean {
  if (!text) return false;
  return CANT_ANSWER_RE.test(text);
}

/**
 * Move a conversation to 'waiting' and stop the AI (mode='human').
 * Returns true when it actually changed something — false when the
 * conversation was already waiting or the owner is already handling it
 * (mode already 'human'), so an escalation can never fire twice.
 */
export async function escalateConversation(
  workspaceId: string,
  conversationId: string,
  reason: EscalationReason,
): Promise<boolean> {
  const { rows } = await query<{ id: string }>(
    workspaceId,
    `UPDATE conversations
     SET status = 'waiting', mode = 'human', handed_to = 'human',
         handover_until = NULL, handover_started_at = now(),
         escalation_reason = $1, escalated_at = now(), updated_at = now()
     WHERE workspace_id = $2 AND id = $3
       AND status <> 'waiting' AND mode = 'ai'
     RETURNING id`,
    [reason, workspaceId, conversationId],
  );
  if (rows.length > 0) {
    console.log(`[escalation] conversation ${conversationId} → waiting (${reason})`);
    return true;
  }
  return false;
}
