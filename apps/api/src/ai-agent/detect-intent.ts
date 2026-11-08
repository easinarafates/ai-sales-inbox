/**
 * Deterministic customer-intent detectors (2026-11-08) — no AI call, no
 * credit. Used by processBatch BEFORE the provider call, like the anger
 * and off-topic checks:
 *
 * - Fast-reply question ("তুমি এত দ্রুত রিপ্লাই দিচ্ছ কেন?"): the AI
 *   must NEVER answer "আমি AI বলে দ্রুত উত্তর দিই" — it deflects as a
 *   human shop assistant ("স্যার, আপনার সেবা দেওয়ার জন্য আমরা সবসময়
 *   দ্রুত উত্তর দেওয়ার চেষ্টা করি।"). NOT off-topic and NOT escalated.
 * - Product-list request ("কি কি প্রোডাক্ট আছে?"): the AI must NOT
 *   list everything in one text message — the agent sends one photo
 *   message per product instead, then asks which one they like.
 * - Single-product show request ("জিন্সটা দেখাও"): the agent sends
 *   that product's photo + details + price.
 *
 * All three are conservative by design: they only fire on clear
 * matches, so a normal price question ("জিন্সের দাম কত?") or an
 * availability question ("টি-শার্ট আছে?") always flows to the LLM.
 */

// Bengali product words customers use, mapped to the English names
// shops usually store (products are often named "Shirt"/"Jeans" while
// customers ask "শার্ট"/"জিন্স"). Shared with the demo-mode matcher in
// agent.ts — matching is substring-based, so Bengali inflections
// ("শার্টের", "জিন্সের") still match.
export const BENGALI_PRODUCT_ALIASES: [bengali: string, english: string][] = [
  ['জিন্স', 'jeans'],
  ['জিনস', 'jeans'],
  ['শার্ট', 'shirt'],
  ['টিশার্ট', 't-shirt'],
  ['প্যান্ট', 'pants'],
  ['শাড়ি', 'saree'],
  ['পাঞ্জাবি', 'panjabi'],
  ['কুর্তি', 'kurti'],
];

// Romanized-Bengali (Banglish) product words, as customers actually type
// them ("jins er dam koto", "shart ase?"). Same shape as the Bengali
// aliases so the show/list matchers treat Banglish like Bengali — a
// Banglish product question must find the product, and a Banglish
// "ছবি দেন" must ask which product, exactly like the Bengali one.
export const ROMANIZED_PRODUCT_ALIASES: [romanized: string, english: string][] = [
  ['jins', 'jeans'],
  ['jinz', 'jeans'],
  ['jeans', 'jeans'],
  ['shart', 'shirt'],
  ['shirt', 'shirt'],
  ['tishart', 't-shirt'],
  ['t-shart', 't-shirt'],
  ['tshirt', 't-shirt'],
  ['pant', 'pants'],
  ['shari', 'saree'],
  ['saree', 'saree'],
  ['panjabi', 'panjabi'],
  ['kurti', 'kurti'],
];

// ---------------------------------------------------------------------------
// Greeting detection (2026-11-08) — "Hi" / "হ্যালো" / সালাম.
//
// A greeting is NOT a new conversation when the chat is already underway:
// the agent answers a REPEAT greeting contextually ("স্যার, আপনি কি
// প্রোডাক্টটা নেবেন, নাকি নতুন করে কিছু বলতে চাচ্ছেন?") instead of a
// fresh generic welcome. detectGreeting only says the message IS a
// greeting; agent.ts decides first-vs-repeat from the conversation's
// outgoing history. Conservative: the whole message must be (or start
// with) a greeting — "Hi, jeans er dam koto?" is a price question, not
// a greeting, because it carries a product word.
// ---------------------------------------------------------------------------

const GREETING_PATTERNS = [
  // NOTE: no \b after Bengali words — \b is an ASCII word boundary and
  // never matches after a Bengali letter. The lookahead (?=$|[\s,!.?])
  // ends the greeting at a space, punctuation or end-of-string instead,
  // so "সালাম" matches but "সালামি" does not.
  /^(আসসালামু আলাইকুম|আসসালামু|সালাম|আদাব|হ্যালো|হাই)(?=$|[\s,!.?])/,
  /^(hi|hello|hey|hii+|helo|hlo|salam|salaam|assalamualaikum|assalamu alaikum|good morning|good afternoon|good evening)\b/i,
];

/** Product / shop words — a message carrying one is a question, not a bare greeting. */
const GREETING_EXCLUSION = /দাম|টাকা|প্রোডাক্ট|পণ্য|জিন্স|শার্ট|প্যান্ট|অর্ডার|ডেলিভারি|স্টক|ছবি|price|jeans|shirt|pant|order|delivery|stock|photo|product/i;

/** Is this message (only) a greeting? */
export function detectGreeting(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  if (!t) return false;
  if (GREETING_EXCLUSION.test(t)) return false;
  return GREETING_PATTERNS.some((re) => re.test(t));
}

// ---------------------------------------------------------------------------
// "Why do you reply so fast?" — deflect, never admit being an AI.
// Every pattern needs a speed word AND a reply/answer word, so a
// delivery-speed question ("দ্রুত ডেলিভারি দিবেন?") never matches.
// ---------------------------------------------------------------------------

const FAST_REPLY_PATTERNS = [
  /দ্রুত.*(রিপ্লাই|উত্তর)/,
  /এত.*(দ্রুত|তাড়াতাড়ি|ফাস্ট).*(রিপ্লাই|উত্তর)/,
  /(রিপ্লাই|উত্তর).*এত.*(দ্রুত|তাড়াতাড়ি|ফাস্ট)/,
  /তাড়াতাড়ি.*(রিপ্লাই|উত্তর)/,
  /ফাস্ট.*(রিপ্লাই|উত্তর)/,
  /(রিপ্লাই|উত্তর).*ফাস্ট/,
  /কেন.*(দ্রুত|তাড়াতাড়ি|ফাস্ট).*(রিপ্লাই|উত্তর)/,
  /why.*fast/i,
  /fast.*(reply|answer|respond)/i,
  /(reply|answer|respond).*fast/i,
  /reply so (fast|quick)/i,
  /answer so (fast|quick)/i,
];

/** Is this message asking why the shop replies so fast? */
export function detectFastReplyQuestion(text: string | null | undefined): boolean {
  if (!text) return false;
  return FAST_REPLY_PATTERNS.some((re) => re.test(text));
}

// ---------------------------------------------------------------------------
// "What products do you have?" — list request, answered with a clean TEXT
// list (one product per line). Includes Banglish (Romanized Bengali):
// "ki ki product ase" must hit the free deterministic list flow, not
// fall through to a token-costly LLM call.
// ---------------------------------------------------------------------------

const LIST_REQUEST_PATTERNS = [
  /কি কি প্রোডাক্ট|কী কী প্রোডাক্ট|কি কি পণ্য|কী কী পণ্য/,
  /সব প্রোডাক্ট|সব পণ্য|সকল প্রোডাক্ট/,
  /কোন কোন প্রোডাক্ট|কোন কোন পণ্য/,
  /প্রোডাক্টগুলো|পণ্যগুলো/,
  /কি কি আছে|কী কী আছে/,
  /তোমাদের (কাছে )?কি আছে/,
  /ki ki product/i,
  /ki ki ponno/i,
  /ki ki ase/i,
  /sob product/i,
  /kon kon product/i,
  /product (gulo|gula|guli)/i,
  /tomader kache ki ase/i,
  /what products/i,
  /show (me )?(all |your )?products/i,
  /all products/i,
  /product list/i,
  /what do you (sell|have)/i,
];

/** Is this message asking for the full product list? */
export function detectProductListRequest(text: string | null | undefined): boolean {
  if (!text) return false;
  return LIST_REQUEST_PATTERNS.some((re) => re.test(text));
}

// ---------------------------------------------------------------------------
// "Where is your shop?" — answered with ONE line from the knowledge book
// ("আমাদের দোকান মাগুরায়।"), never a paragraph. "সব" is the customer's
// word for "shop" ("তোমাদের সব কোথায়" → "আমাদের সব মাগুরাত").
// ---------------------------------------------------------------------------

const SHOP_LOCATION_PATTERNS = [
  /দোকান (কোথায়|কোথাই|কই|কোথায় আছে|কোথায় অবস্থিত)/,
  /সব (কোথায়|কই|কোথায় আছে)/,
  /তোমাদের (দোকান|সব) (কোথায়|কই)/,
  /দোকানটি (কোথায়|কই)/,
  /দোকানের (ঠিকানা|অবস্থান|লোকেশন)/,
  /শপ (কোথায়|কই)/,
  /shop (kothay|kothai|koi|location|address|where)/i,
  /where is (your |the )?(shop|store)/i,
  /tomader (dokan|shop|sob) (kothay|koi)/i,
  /dokan (kothay|koi)/i,
  /sob (kothay|koi)/i,
];

/** Is this message asking where the shop is? */
export function detectShopLocation(text: string | null | undefined): boolean {
  if (!text) return false;
  return SHOP_LOCATION_PATTERNS.some((re) => re.test(text));
}

// ---------------------------------------------------------------------------
// "Show me the jeans" — single-product photo request.
// A show word (দেখাও / ছবি / photo / show …) AND exactly one catalog
// product named (Bengali alias or English name). Two products matching
// ("শার্ট" matches both Shirt and T-shirt) is ambiguous — returns null
// so the LLM asks which one.
// ---------------------------------------------------------------------------

const SHOW_WORDS = /দেখাও|দেখান|ছবি|দেখতে চাই|দেখতে|দেখি|dekhao|dekhan|dekhte|dekhi|chobi|chhobi|photo|picture|show|pic/i;

/** Text-only pre-check: might this be a show request? (Needs the catalog to confirm.) */
export function looksLikeShowRequest(text: string | null | undefined): boolean {
  if (!text) return false;
  return SHOW_WORDS.test(text);
}

export interface CatalogProduct {
  id: string;
  name: string;
}

/** The single product the customer wants to see, or null. Longest-match
 * wins: a generic word is a substring of a specific one ("শার্ট" inside
 * "টি-শার্ট", "shirt" inside "t-shirt"), so the product whose matched
 * alias is longest is the one the customer meant. An alias whose English
 * word IS the product's name beats one that is only part of a longer
 * name, so "শার্ট"/"shart" picks the Shirt (the T-shirt is
 * "টি-শার্ট"/"tishart"). A genuine tie at the top is ambiguous —
 * returns null so the LLM asks which one. */
export function matchShowProduct(
  text: string | null | undefined,
  products: CatalogProduct[],
): CatalogProduct | null {
  if (!text || products.length === 0) return null;
  if (!SHOW_WORDS.test(text)) return null;
  const lower = text.toLowerCase();
  // Hyphens split Bengali words ("টি-শার্ট" vs the alias "টিশার্ট").
  const squished = lower.replace(/-/g, '');
  const scored = products
    .map((p) => {
      const nameLower = p.name.toLowerCase();
      const nameSquished = nameLower.replace(/-/g, '');
      let best = 0;
      const consider = (hit: boolean, len: number) => {
        if (hit && len > best) best = len;
      };
      consider(lower.includes(nameLower), nameLower.length);
      consider(squished.includes(nameSquished), nameSquished.length);
      for (const [bn, en] of [...BENGALI_PRODUCT_ALIASES, ...ROMANIZED_PRODUCT_ALIASES]) {
        if (!nameLower.includes(en)) continue;
        // Exact: the alias's English word IS the product's name (e.g.
        // "shart"→"shirt" for the product named "Shirt"). Partial: it is
        // only part of a longer name (e.g. "shart"→"shirt" inside
        // "T-shirt"). An exact alias match wins over a partial one, so
        // "শার্ট"/"shart" picks the Shirt — the T-shirt is
        // "টি-শার্ট"/"tishart".
        const enSquished = en.replace(/-/g, '');
        const exact = enSquished.length > 0 && enSquished === nameSquished;
        const bonus = exact ? 100 : 0;
        consider(lower.includes(bn), bn.length + bonus);
        consider(squished.includes(bn), bn.length + bonus);
      }
      return { product: p, best };
    })
    .filter((s) => s.best > 0);
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.best - a.best);
  if (scored.length > 1 && scored[0].best === scored[1].best) return null;
  return scored[0].product;
}

// ---------------------------------------------------------------------------
// Order-cancellation request detection (2026-11-08, user report).
//
// The AI must NEVER cancel an order on its own — a cancel ask creates a
// PENDING request for the owner to approve (see orders/cancel.ts). This
// detector catches clear cancel asks deterministically (no AI call), so
// the professional reply + request + owner notification are guaranteed.
// Conservative: a cancel word AND an order word, a cancel word with a
// request verb ("ক্যান্সেল করুন", "cancel koro"), or the bare word
// ("cancel", "ক্যান্সেল") alone. A coupon context ("কুপন বাতিল") is
// NOT an order cancel. Vague intent ("আমি আর নিতে চাই না") is left to
// the LLM + the request_order_cancellation tool (prompt rule 16).
// ---------------------------------------------------------------------------

const CANCEL_WORDS = ['ক্যান্সেল', 'ক্যানসেল', 'বাতিল', 'cancel', 'batil', 'cancle'];
const CANCEL_ORDER_WORDS = ['অর্ডার', 'order'];
const CANCEL_REQUEST_VERBS = ['করুন', 'করো', 'চাই', 'দিন', 'দেন', 'koro', 'korun', 'chai', 'please', 'plz'];

/** Is this message asking to cancel an order? */
export function detectCancelRequest(text: string | null | undefined): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  // A coupon context is not an order cancel ("কুপন বাতিল").
  if (lower.includes('কুপন') || lower.includes('coupon')) return false;
  const hasCancel = CANCEL_WORDS.some((w) => lower.includes(w));
  if (!hasCancel) return false;
  const hasOrder = CANCEL_ORDER_WORDS.some((w) => lower.includes(w));
  const hasVerb = CANCEL_REQUEST_VERBS.some((w) => lower.includes(w));
  if (hasOrder || hasVerb) return true;
  // The bare word alone ("cancel", "ক্যান্সেল") is a cancel ask.
  const bare = lower.trim().replace(/[.!?।,\s]+$/g, '');
  return CANCEL_WORDS.includes(bare);
}

// ---------------------------------------------------------------------------
// Acknowledgment detection (2026-11-08, user report).
//
// When a customer says just "OK" / "ঠিক আছে" / "হ্যাঁ" / "ধন্যবাদ", the
// AI used to ask "স্যার, আপনি ওকে বলছেন, আপনি কি কিছু বলতে যাচ্ছেন?" —
// unprofessional. An acknowledgment gets a SHORT polite reply and
// nothing more: no question, no product push. This detector fires only
// when the WHOLE message is an acknowledgment (a trailing salutation —
// "ধন্যবাদ স্যার", "ওকে স্যার" — is stripped first). "হ্যাঁ, জিন্স নিবো"
// or "ঠিক আছে, দাম কত?" carry more content and are NOT acknowledgments.
// ---------------------------------------------------------------------------

const ACK_PHRASES = new Set([
  // Bengali.
  'ঠিক আছে', 'ঠিকাছে', 'ঠিক', 'হ্যাঁ', 'হ্যা', 'হাঁ', 'জি', 'জ্বি',
  'আচ্ছা', 'বুঝেছি', 'বুঝলাম', 'ধন্যবাদ', 'ওকে', 'হুম', 'হম',
  'আচ্ছা ঠিক আছে', 'ঠিক আছে ধন্যবাদ', 'শুকরিয়া',
  // Banglish / English.
  'ok', 'okk', 'okay', 'thik ache', 'thik ase', 'thik ace', 'ha', 'hya',
  'yeah', 'yes', 'thanks', 'thank you', 'thank u', 'got it', 'understood',
  'alright', 'fine', 'hmm', 'hm', 'ji', 'accha', 'bujhlam', 'bujhesi',
  'dhonnobad', 'shukriya',
]);

const ACK_THANKS_PHRASES = new Set([
  'ধন্যবাদ', 'thanks', 'thank you', 'thank u', 'dhonnobad', 'shukriya', 'শুকরিয়া',
]);

function normalizeAcknowledgment(text: string): string {
  let t = text.trim().toLowerCase();
  t = t.replace(/[.!?।,]+$/g, '').trim();
  // A trailing salutation ("ধন্যবাদ স্যার", "ওকে স্যার") is still just an acknowledgment.
  t = t.replace(/[\s,]+(স্যার|ম্যাডাম|sir|madam)$/u, '').trim();
  return t.replace(/\s+/g, ' ');
}

/** Is this message ONLY an acknowledgment (OK / ঠিক আছে / হ্যাঁ / ধন্যবাদ)? */
export function detectAcknowledgment(text: string | null | undefined): boolean {
  if (!text) return false;
  return ACK_PHRASES.has(normalizeAcknowledgment(text));
}

/** 'thanks' for a thank-you ("ধন্যবাদ" / "thanks"), 'ack' for the rest. */
export function acknowledgmentKind(text: string | null | undefined): 'thanks' | 'ack' {
  if (!text) return 'ack';
  return ACK_THANKS_PHRASES.has(normalizeAcknowledgment(text)) ? 'thanks' : 'ack';
}
