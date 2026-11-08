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
import { createNotification } from '../notifications/service';

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
  'তুমি কি মানুষ', 'তুমি কি রোবট', 'তুমি কি এআই', 'তুমি কি ai', 'তুমি কি বট',
  'আপনি কি রোবট', 'আপনি কি এআই', 'আপনি কি ai',
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
  'are you human', 'are you a robot', 'are you a bot', 'are you a chatbot',
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
    if (reason === 'angry_customer' || reason === 'off_topic') {
      // OWNER NOTIFICATION (2026-11-08): the header bell shows this —
      // "কাস্টমার রেগে গিয়েছে, আপনি একে সামলান" — with the customer
      // name and the conversation. Created only when the escalation
      // actually happened (rows.length > 0), so it can never duplicate.
      // ai_unsure / cant_answer get no bell row (they already make a ticket).
      const owner = await query<{ customer_id: string | null; customer_name: string | null }>(
        workspaceId,
        `SELECT c.customer_id, cu.name AS customer_name
         FROM conversations c LEFT JOIN customers cu ON cu.id = c.customer_id
         WHERE c.workspace_id = $1 AND c.id = $2`,
        [workspaceId, conversationId],
      ).catch(() => ({ rows: [] as { customer_id: string | null; customer_name: string | null }[] }));
      const name = owner.rows[0]?.customer_name ?? 'একজন কাস্টমার';
      if (reason === 'angry_customer') {
        await createNotification(workspaceId, {
          type: 'angry_customer',
          title: 'কাস্টমার রেগে গিয়েছে',
          body: `${name} রেগে গিয়েছে — আপনি একে সামলান। চ্যাটটি Waiting-এ আছে।`,
          conversationId,
          customerId: owner.rows[0]?.customer_id ?? null,
        });
      } else {
        await createNotification(workspaceId, {
          type: 'off_topic',
          title: 'কাস্টমার বিষয়ের বাইরে প্রশ্ন করছে',
          body: `${name} দোকানের বাইরের বিষয়ে প্রশ্ন করছে — চ্যাটটি Waiting-এ আছে, আপনি দেখে নিন।`,
          conversationId,
          customerId: owner.rows[0]?.customer_id ?? null,
        });
      }
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Gibberish detection (2026-11-08) — deterministic, pre-AI, ZERO token.
//
// The owner asked: when a customer types gibberish ("হিজিবিজি") over and
// over, the AI must NOT burn a token on every one. It replies ONCE per
// episode ("স্যার, আমি আপনার কথাটি বুঝতে পারিনি, কষ্ট করে আবার বলবেন")
// and then IGNORES further gibberish silently until the customer writes
// something meaningful. The "once" state lives on the conversation
// (gibberish_warned, migration 27) — see ai-agent/agent.ts.
//
// Conservative by design, in layers so a real message can never match:
//  1. The literal word "হিজিবিজি" (Bengali for "gibberish") is gibberish.
//  2. Bengali script is always a real message — never gibberish.
//  3. No letters at all (digits / emoji / punctuation only) is not
//     gibberish — a phone number, a quantity, or a 👍 is meaningful.
//  4. Any RECOGNISED word saves the message — a generous allowlist of
//     Banglish + English words customers actually use (greetings,
//     products, price, order, delivery, "Ata", "Hi", "ok", ...).
//  5. Any WORD-LIKE token saves it — 3+ letters with ≥25% vowels is a
//     real word or a name ("Rahim", "random", "kemon"); random typing
//     ("asdfgh", "ksdjfhs") has almost no vowels.
// Only a message with no recognised word and no word-like token —
// keyboard mash ("asdf", "qwerty", "zxcv"), consonant soup, or a
// repeated character ("aaaa", "zzzz") — is gibberish. Banglish, short
// replies, product words, numbers and greetings can never match.
// ---------------------------------------------------------------------------

/** Words customers actually type (Banglish + English) — any one of these saves a message from the gibberish guard. */
const GIBBERISH_ALLOWLIST = new Set([
  // Greetings / politeness.
  'hi', 'hello', 'hey', 'yo', 'salam', 'salaam', 'assalamualaikum', 'alaikum', 'walaikum',
  'good', 'morning', 'afternoon', 'evening', 'bye', 'thanks', 'thank', 'please', 'plz',
  'sorry', 'dhonnobad', 'dhonnobadh', 'shukriya',
  // Products.
  'jeans', 'jean', 'jins', 'jinz', 'shirt', 'shart', 'tshirt', 't-shirt', 'tishart',
  'pant', 'pants', 'paant', 'shari', 'saree', 'panjabi', 'kurti', 'product', 'products',
  'dokan', 'shop',
  // Price / stock / order / delivery / payment.
  'price', 'dam', 'daam', 'koto', 'taka', 'tk', 'stock', 'ase', 'ache', 'ashe', 'nai', 'nei',
  'order', 'delivery', 'dhaka', 'courier', 'parcel', 'payment', 'cash', 'bkash', 'nogod',
  'nagad', 'rocket', 'cod', 'address', 'thikana', 'phone', 'number', 'nam', 'name',
  'size', 'colour', 'color', 'rong', 'lal', 'nil', 'shobuj', 'holud', 'shada', 'kalo',
  // Verbs / intent.
  'chai', 'nibo', 'niben', 'dibo', 'diben', 'kinte', 'kinbo', 'nite', 'pathan',
  'pathaben', 'korbo', 'korben', 'hobe', 'parbo', 'parben', 'lagbe', 'lagbo', 'dekhbo',
  'dekhan', 'dekhao', 'dekhte', 'chobi', 'chhobi', 'photo', 'pic', 'picture', 'show',
  // Pronouns / questions / small words.
  'ami', 'apni', 'tumi', 'amar', 'apnar', 'tomar', 'ki', 'keno', 'kokhon', 'kothay',
  'kothai', 'kobe', 'kore', 'thik', 'bhalo', 'valo', 'kemon', 'kemn', 'aso', 'asen',
  'ata', 'eta', 'oita', 'eita', 'ar', 'abar', 'ekta', 'ek', 'dui', 'tin', 'char',
  'ha', 'na', 'hya', 'bhai', 'vai', 'apu', 'apa', 'sir', 'madam', 'mem',
  'ok', 'okk', 'okay', 'k', 'hm', 'hmm', 'haha', 'hehe', 'yes', 'no',
]);

/** Keyboard-mash fragments — a message containing one is gibberish. */
const KEYBOARD_MASH = [
  'asdf', 'qwer', 'wert', 'erty', 'rtyu', 'tyui', 'yuio', 'sdfg', 'dfgh',
  'fghj', 'ghjk', 'hjkl', 'zxcv', 'xcvb', 'cvbn', 'vbnm', 'qwerty', 'asdfgh', 'zxcvbn',
];

/**
 * Is this message gibberish / meaningless typing? Deterministic and
 * conservative — see the layers above. Returns false for every real
 * message: Bengali, Banglish, greetings, short replies, product words,
 * numbers, emoji-only.
 */
export function detectGibberish(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  if (!t) return false;
  // The literal word for "gibberish" is gibberish.
  if (t.includes('হিজিবিজি')) return true;
  // Bengali script is always a real message.
  if (/[\u0980-\u09FF]/.test(t)) return false;
  // No letters at all (digits / emoji / punctuation) is not gibberish.
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length === 0) return false;
  // One character repeated (aaaa, zzzz, qqqq) is gibberish — no real
  // word is a single repeated letter. (Checked before the word-like
  // test below, which would call "aaaa" word-like: it is all vowels.)
  if (letters.length >= 3 && new Set(letters.toLowerCase()).size === 1) return true;
  const lower = t.toLowerCase();
  // Keyboard mash anywhere → gibberish.
  if (KEYBOARD_MASH.some((frag) => lower.includes(frag))) return true;
  const words = lower.split(/[^a-z]+/).filter(Boolean);
  if (words.length === 0) return false;
  // Any recognised word saves the message.
  if (words.some((w) => GIBBERISH_ALLOWLIST.has(w))) return false;
  // Any word-like token (3+ letters, ≥25% vowels) is a real word/name.
  const wordLike = (w: string): boolean => {
    if (w.length < 3) return false;
    const vowels = (w.match(/[aeiou]/g) || []).length;
    return vowels / w.length >= 0.25;
  };
  if (words.some(wordLike)) return false;
  // Nothing recognisable and nothing word-like → gibberish.
  return true;
}
