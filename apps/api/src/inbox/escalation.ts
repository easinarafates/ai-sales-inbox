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
 *  - Off-topic: a curated phrase list (Bengali + English + Romanized)
 *    for questions clearly outside the shop's scope — personal
 *    questions about the AI ("তুমি ছেলে নাকি মেয়ে?") and unrelated
 *    topics (weather, sports, politics, jokes, songs, movies, news,
 *    trivia). Checked BEFORE any AI call, like anger, so no reply goes
 *    out and no credit is burned. Greetings and every shop question
 *    never match (a shop-scope guard runs first — see detectOffTopic).
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

export type EscalationReason = 'ai_unsure' | 'angry_customer' | 'cant_answer' | 'off_topic';

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

// ---------------------------------------------------------------------------
// Off-topic detection (2026-11-08): the owner asked the AI to stop
// answering questions outside the shop's scope — personal questions
// about the AI ("তুমি ছেলে নাকি মেয়ে?"), weather, sports, politics,
// jokes, songs, movies, news, trivia. Like anger, this runs BEFORE any
// AI call, so the chat escalates to Waiting with NO reply and NO credit
// burned. Conservative by design, in two layers:
//  1. A SHOP-SCOPE GUARD runs first: anything mentioning products,
//     price, orders, delivery, payment, or the shop itself is IN scope
//     and can never be off-topic. This is what keeps "বিয়ের জন্য শার্ট
//     লাগবে" (wedding shirt), "ছেলেদের টি-শার্ট আছে?" (boys' t-shirts),
//     "আমার নাম রহিম, অর্ডার করতে চাই" (customer giving their own
//     name), "আমার বাড়ি ঢাকা, ডেলিভারি দিবেন?" (delivery address) and
//     "বৃষ্টির জন্য ডেলিভারি দেরি হবে?" in scope.
//  2. The phrase lists below are deliberately specific — possessive +
//     noun ("তোমার নাম", never bare "নাম"; "তুমি ছেলে", never bare
//     "ছেলে") — so a bare word inside a shop question cannot match.
// Greetings (সালাম, হাই, hello, আসসালামু আলাইকুম) match nothing here
// and still get the AI's short greeting reply.
// ---------------------------------------------------------------------------

/** Words that prove the message is about the shop — never off-topic. */
const SHOP_SCOPE_SIGNALS = [
  // Bengali: products, price, orders, delivery, payment, shop.
  'দাম', 'টাকা', 'ডেলিভারি', 'অর্ডার', 'ক্যাশ', 'বিকাশ', 'নগদ', 'রকেট',
  'ঠিকানা', 'স্টক', 'ছাড়', 'কুরিয়ার', 'টি-শার্ট', 'টিশার্ট', 'শার্ট',
  'প্যান্ট', 'জিন্স', 'দোকান', 'প্রোডাক্ট', 'পণ্য', 'সাইজ', 'কালার',
  'রঙ', 'পেমেন্ট', 'পার্সেল', 'ট্র্যাকিং',
  // English / Romanized.
  'price', 'delivery', 'order', 'cash', 'bkash', 'stock', 'discount',
  'courier', 't-shirt', 'tshirt', 'shirt', 'pant', 'jeans', 'shop',
  'product', 'size', 'color', 'colour', 'payment', 'parcel', 'tracking',
];

/** Bengali off-topic phrases — substring match (phrases are specific enough). */
const BENGALI_OFF_TOPIC_PHRASES = [
  // Personal questions about the AI.
  'ছেলে নাকি মেয়ে', 'ছেলে না মেয়ে',
  'তুমি ছেলে', 'তুমি মেয়ে', 'তুমি কি ছেলে', 'তুমি কি মেয়ে',
  'আপনি ছেলে', 'আপনি মেয়ে',
  'তোমার নাম', 'আপনার নাম',
  'তোমার বয়স', 'আপনার বয়স',
  'তোমার বাড়ি', 'আপনার বাড়ি',
  'তুমি কি বিয়ে', 'বিয়ে করেছ', 'তোমার বউ', 'আপনার বউ',
  'তোমার স্বামী', 'আপনার স্বামী',
  'তুমি কি মানুষ', 'তুমি কি রোবট', 'তুমি কি এআই',
  // Unrelated topics.
  'আবহাওয়া', 'তাপমাত্রা',
  'ক্রিকেট', 'ফুটবল', 'খেলার খবর', 'খেলার ফলাফল',
  'রাজনীতি', 'নির্বাচন',
  'কৌতুক', 'জোকস', 'গান',
  'সিনেমা', 'মুভি',
  'আজকের খবর', 'দেশের খবর', 'বিশ্বের খবর',
  'রাজধানী', 'প্রধানমন্ত্রী',
];

/** Romanized-Bengali off-topic phrases, as customers actually type them. */
const ROMANIZED_OFF_TOPIC_PHRASES = [
  'chele naki meye', 'chele na meye', 'tumi chele', 'tumi meye',
  'tomar nam', 'tomar boyos', 'tomar boyosh',
  'tumi ki manush', 'tumi ki robot', 'tumi ki ai',
  'tumi ki biye', 'biye korecho',
  'abohawa', 'gan shunao', 'gan gao',
];

/** English off-topic phrases — substring match on the lowercased text. */
const ENGLISH_OFF_TOPIC_PHRASES = [
  'are you a boy', 'are you a girl', 'are you male', 'are you female',
  'boy or girl',
  'what is your name', "what's your name", 'whats your name', 'your name',
  'how old are you', 'your age',
  'where do you live',
  'are you married', 'do you have a boyfriend', 'do you have a girlfriend',
  'your husband', 'your wife',
  'are you human', 'are you a robot', 'are you a bot',
  'are you ai', 'are you an ai', 'are you real',
  'tell me a joke', 'sing a song', 'sing me a song',
  'what is the weather', "what's the weather", 'whats the weather',
  'who won', 'latest news', 'breaking news', 'today news',
  'capital of', 'prime minister', 'who is the president',
];

/** English off-topic single words — whole-word match only. 'weather' is
 * safe here because the shop-scope guard above runs first ("will the
 * weather delay my delivery?" mentions delivery, so it stays in scope). */
const ENGLISH_OFF_TOPIC_WORDS = [
  'weather', 'cricket', 'football', 'politics', 'election',
  'movie', 'film', 'joke', 'song', 'horoscope', 'lottery',
];

const OFF_TOPIC_WORD_RE = new RegExp(`\\b(${ENGLISH_OFF_TOPIC_WORDS.join('|')})\\b`, 'i');

/**
 * Is this customer message clearly outside the shop's scope? The
 * shop-scope guard runs first, then the curated phrase lists. Greetings
 * and every shop question (products, price, stock, orders, delivery,
 * location, payment) return false.
 */
export function detectOffTopic(text: string | null | undefined): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  if (SHOP_SCOPE_SIGNALS.some((signal) => lower.includes(signal))) return false;
  if (BENGALI_OFF_TOPIC_PHRASES.some((phrase) => lower.includes(phrase))) return true;
  if (ROMANIZED_OFF_TOPIC_PHRASES.some((phrase) => lower.includes(phrase))) return true;
  if (ENGLISH_OFF_TOPIC_PHRASES.some((phrase) => lower.includes(phrase))) return true;
  return OFF_TOPIC_WORD_RE.test(text);
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
