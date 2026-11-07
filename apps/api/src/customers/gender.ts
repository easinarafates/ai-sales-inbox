/**
 * Gender inference from a customer's NAME — the only signal available.
 *
 * Meta gives NO gender field for Page-scoped customers (PSID routes are
 * blocked anyway) and NO photo, so gender can only come from the name.
 * It is NEVER guessed from a photo (none is available).
 *
 * Conservative by design: only clearly gendered Bangladeshi/Bengali and
 * common English names are recognised. Anything else — unisex names
 * (নূর / Noor), unfamiliar names, initials, one-letter names — returns
 * 'unknown', and the AI then uses neutral "আপনি" only, never স্যার/ম্যাডাম.
 *
 * Matching is whole-token only (never substring): "সুমন" must not match
 * inside another word. The first token (given name) decides; a strong
 * prefix (মোঃ / মোহাম্মদ / আব্দুল / Md.) or a strong suffix (বেগম →
 * female, -উদ্দিন → male) decides when the given name itself is unknown.
 * A name carrying both a male and a female marker is 'unknown' — a
 * conflict is never resolved by guessing.
 *
 * The stored gender is only auto-filled while it is 'unknown'. A gender
 * the shop owner sets by hand in the Inbox is final — the inference never
 * overwrites it (see webhooks/routes.ts + channels/meta-profile.ts).
 */

export type CustomerGender = 'male' | 'female' | 'unknown';

export function isCustomerGender(value: unknown): value is CustomerGender {
  return value === 'male' || value === 'female' || value === 'unknown';
}

export function normalizeCustomerGender(value: unknown): CustomerGender {
  return isCustomerGender(value) ? value : 'unknown';
}

/** The respectful address the AI uses for this gender, or null when unknown. */
export function genderSalutation(gender: CustomerGender): 'স্যার' | 'ম্যাডাম' | null {
  if (gender === 'male') return 'স্যার';
  if (gender === 'female') return 'ম্যাডাম';
  return null;
}

/** One line for the AI prompt, telling it exactly how to address the customer. */
export function addressingLine(gender: CustomerGender): string {
  if (gender === 'male') return 'সম্বোধন: স্যার — পুরো উত্তরে কাস্টমারকে "স্যার" বলে সম্বোধন করো।';
  if (gender === 'female') return 'সম্বোধন: ম্যাডাম — পুরো উত্তরে কাস্টমারকে "ম্যাডাম" বলে সম্বোধন করো।';
  return 'সম্বোধন: জানা নেই — শুধু "আপনি" বলো, "স্যার" বা "ম্যাডাম" একদম ব্যবহার করো না।';
}

// Strong prefixes: a name starting with one of these is male.
const MALE_PREFIXES = new Set([
  'মোঃ', 'মো', 'মোহাম্মদ', 'মোহাম্মাদ', 'মোহাম্মদ', 'মুহাম্মদ', 'মুহাম্মাদ',
  'আব্দুল', 'আবদুল', 'আব্দুর', 'আবদুর',
  'md', 'mohammad', 'mohammed', 'mohamed', 'muhammad', 'muhammed', 'abdul', 'abdur',
]);

// Strong suffixes (last token).
const FEMALE_SUFFIXES = new Set(['বেগম', 'begum']);
const MALE_SUFFIXES = new Set(['উদ্দিন', 'uddin']);

// Given names — Bengali script.
const MALE_NAMES_BN = new Set([
  'রহিম', 'রহীম', 'করিম', 'করীম', 'সাকিব', 'শাকিব', 'তানভীর', 'তানবীর',
  'আরিফ', 'আরিফ', 'হাসান', 'হোসেন', 'হুসাইন', 'হোসাইন', 'রাকিব', 'ইমন',
  'সুমন', 'রানা', 'রুবেল', 'জাহিদ', 'নাঈম', 'নাইম', 'ফাহিম', 'তামিম',
  'রিফাত', 'সিয়াম', 'অনিক', 'শুভ', 'হৃদয়', 'মাহমুদ', 'মাহবুব', 'কামাল',
  'জামাল', 'জালাল', 'সালাম', 'আলম', 'ইসলাম', 'ফরহাদ', 'ফারহান', 'ইমরান',
  'শাহরিয়ার', 'মেহেদী', 'আসিফ', 'সাব্বির', 'নাসির', 'ইউসুফ', 'ওমর', 'আলি',
  'রাফি', 'তানিম', 'জয়', 'রবি', 'সজীব', 'সোহাগ', 'রাসেল', 'শামীম',
  'মিজান', 'লিটন', 'বাবুল', 'আনিস', 'মনির', 'শরিফ', 'তারেক', 'মাসুদ',
  'রেজাউল', 'শফিক', 'আতিক', 'রকি', 'নয়ন', 'পলাশ', 'সোহেল', 'মামুন',
  'কবির', 'হাবিব', 'নাজমুল', 'সাইফুল', 'আবু', 'বকর', 'ওসমান', 'ইব্রাহিম',
  'ইসমাইল', 'মোস্তফা', 'মনজুর', 'রফিক', 'শফিকুল', 'মাহফুজ', 'তৌহিদ',
  'রাকিবুল', 'আরিফুল', 'আশরাফুল', 'নজরুল', 'জাকির', 'সেলিম', 'আজিজ',
  'আব্দুল্লাহ', 'আবদুল্লাহ', 'রায়হান', 'সোহান', 'তুষার', 'অপু', 'রাহাত',
  'সাজ্জাদ', 'মেহরাব', 'জুনায়েদ', 'আরমান', 'রাব্বি', 'শান্ত', 'ফয়সাল',
  'নাবিল', 'রিয়াদ', 'সাকিল', 'জুবায়ের', 'তানজিদ', 'হামিদ', 'বিলাল',
  'সাদ্দাম', 'রেজা', 'শাহিন', 'পারভেজ', 'ইকবাল', 'জাহাঙ্গীর', 'সোহান',
  'তৌফিক', 'রাসেল', 'ফারুক', 'সাইফ', 'আরাফাত', 'ইমতিয়াজ', 'নাহিদ',
  'সাদিক', 'তালহা', 'মারুফ', 'জসিম', 'দেলোয়ার', 'হানিফ', 'করিমুল',
]);

const FEMALE_NAMES_BN = new Set([
  'ফাতেমা', 'ফাতিমা', 'আয়েশা', 'আয়শা', 'নুসরাত', 'সাদিয়া', 'রিয়া',
  'তানিয়া', 'মিম', 'আফরিন', 'জান্নাত', 'খাদিজা', 'মরিয়ম', 'রোকেয়া',
  'শারমিন', 'ফারজানা', 'সুমাইয়া', 'তাসনিম', 'লামিয়া', 'নাদিয়া', 'রিমা',
  'সুমি', 'নিপা', 'পলি', 'মুক্তা', 'শিলা', 'রিনা', 'মিনা', 'হাসিনা',
  'সেলিনা', 'পারভীন', 'নাজমা', 'শাহনাজ', 'রেহানা', 'সালমা', 'আসমা',
  'হালিমা', 'জরিনা', 'আনিকা', 'ইশরাত', 'মাহিয়া', 'তানজিলা', 'রাফিয়া',
  'সানজিদা', 'প্রিয়া', 'পূজা', 'অর্পিতা', 'মেঘলা', 'বৃষ্টি', 'তৃষা',
  'তৃষ্ণা', 'রাবেয়া', 'আমিনা', 'জামিলা', 'সাবিনা', 'ফারহানা', 'তানজিনা',
  'মৌসুমী', 'মৌ', 'রুমা', 'রুনা', 'লাকী', 'মাহমুদা', 'আফসানা', 'রোজিনা',
  'শাহিদা', 'নাসরিন', 'ইয়াসমিন', 'মিতু', 'রিতু', 'নিতু', 'পপি', 'শান্তা',
  'মুনা', 'হেনা', 'রেখা', 'চাঁদনী', 'সাথী', 'লিপি', 'ডলি', 'ঝুমা',
  'রুমকি', 'সোনিয়া', 'সামিয়া', 'তাহমিনা', 'তাহমিদা', 'রাজিয়া', 'সালেহা',
  'আফরোজা', 'নাজনীন', 'শবনম', 'রুবিনা', 'ফারিয়া', 'অন্তরা', 'নিশি',
  'পূর্নিমা', 'রূপা', 'স্বর্ণা', 'তানহা', 'মারিয়া', 'সোফিয়া', 'জারা',
]);

// Given names — romanized (lowercase).
const MALE_NAMES_EN = new Set([
  'rahim', 'karim', 'sakib', 'shakib', 'tanvir', 'tanveer', 'arif',
  'hasan', 'hassan', 'hossain', 'hussain', 'husain', 'rakib', 'imon',
  'emon', 'sumon', 'rana', 'rubel', 'zahid', 'nayeem', 'naim', 'fahim',
  'tamim', 'rifat', 'siyam', 'anik', 'shuvo', 'hridoy', 'mahmud',
  'mahbub', 'kamal', 'jamal', 'jalal', 'salam', 'alam', 'islam', 'farhad',
  'farhan', 'imran', 'shahriar', 'mehedi', 'asif', 'sabbir', 'nasir',
  'yusuf', 'omar', 'ali', 'rafi', 'tanim', 'joy', 'robi', 'sojib',
  'sohag', 'rasel', 'shamim', 'mizan', 'liton', 'babul', 'anis', 'monir',
  'sharif', 'tarek', 'masud', 'rezaul', 'shafiq', 'atik', 'rocky',
  'nayan', 'polash', 'sohel', 'mamun', 'kabir', 'habib', 'nazmul',
  'saiful', 'abu', 'bakar', 'osman', 'ibrahim', 'ismail', 'mostafa',
  'manjur', 'rafiq', 'shafiqul', 'mahfuz', 'touhid', 'rakibul', 'ariful',
  'ashraf', 'ashraful', 'nazrul', 'zakir', 'selim', 'aziz', 'abdullah',
  'raihan', 'sohan', 'tushar', 'apu', 'rahat', 'sajjad', 'mehrab',
  'junaid', 'arman', 'rabbi', 'shanto', 'faisal', 'nabil', 'riyad',
  'sakil', 'jubayer', 'tanjid', 'hamid', 'bilal', 'saddam', 'reza',
  'shahin', 'parvez', 'iqbal', 'jahangir', 'toufiq', 'faruk', 'saif',
  'arafat', 'imtiaz', 'nahid', 'sadik', 'talha', 'maruf', 'jasim',
  'delwar', 'hanif', 'karimul', 'easin',
]);

const FEMALE_NAMES_EN = new Set([
  'fatema', 'fatima', 'ayesha', 'aisha', 'nusrat', 'sadia', 'ria',
  'tania', 'mim', 'afrin', 'jannat', 'khadija', 'mariam', 'rokeya',
  'sharmin', 'farzana', 'sumaiya', 'tasnim', 'lamia', 'nadia', 'rima',
  'sumi', 'nipa', 'poly', 'mukta', 'shila', 'rina', 'mina', 'hasina',
  'selina', 'parvin', 'parveen', 'nazma', 'shahnaz', 'rehana', 'salma',
  'asma', 'halima', 'zarina', 'anika', 'ishrat', 'mahiya', 'tanzila',
  'rafia', 'sanjida', 'priya', 'puja', 'arpita', 'meghla', 'brishti',
  'trisha', 'trishna', 'rabia', 'amina', 'jamila', 'sabina', 'farhana',
  'tanzina', 'mousumi', 'mou', 'ruma', 'runa', 'lucky', 'mahmuda',
  'afsana', 'rozina', 'shahida', 'nasrin', 'yasmin', 'mitu', 'ritu',
  'nitu', 'popy', 'shanta', 'muna', 'hena', 'rekha', 'chandni', 'sathi',
  'lipi', 'dolly', 'jhuma', 'rumki', 'sonia', 'samia', 'tahmina',
  'tahmida', 'razia', 'saleha', 'afroza', 'naznin', 'shabnam', 'rubina',
  'faria', 'antara', 'nishi', 'purnima', 'rupa', 'swarna', 'tanha',
  'maria', 'sofia', 'zara',
]);

/** Split a name into whole tokens (Bengali + romanized). */
function tokenize(name: string): string[] {
  return name
    .trim()
    .toLowerCase()
    .split(/[\s,.\-।/()]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Infer gender from a name. Conservative: returns 'unknown' unless a
 * whole token is a clearly gendered given name, prefix, or suffix.
 */
export function inferGenderFromName(name: string | null | undefined): CustomerGender {
  if (!name || !name.trim()) return 'unknown';
  const tokens = tokenize(name);
  if (tokens.length === 0) return 'unknown';

  const first = tokens[0];
  const last = tokens[tokens.length - 1];

  // Strong prefix (মোঃ / মোহাম্মদ / আব্দুল / Md. …) → male.
  if (MALE_PREFIXES.has(first)) return 'male';
  // Strong suffix: বেগম → female; -উদ্দিন → male.
  if (FEMALE_SUFFIXES.has(last)) return 'female';
  if (MALE_SUFFIXES.has(last) || last.endsWith('উদ্দিন') || last.endsWith('uddin')) return 'male';

  // Whole-token given-name match. The first token decides; a later token
  // only counts when the first is unrecognised. A conflict is 'unknown'.
  let found: CustomerGender = 'unknown';
  for (const token of tokens) {
    const male =
      MALE_NAMES_BN.has(token) || MALE_NAMES_EN.has(token);
    const female =
      FEMALE_NAMES_BN.has(token) || FEMALE_NAMES_EN.has(token);
    if (male && female) return 'unknown';
    if (male) {
      if (found === 'female') return 'unknown';
      found = 'male';
    } else if (female) {
      if (found === 'male') return 'unknown';
      found = 'female';
    }
  }
  return found;
}
