/**
 * Bangladesh geography for order addresses + delivery charges.
 *
 * Two jobs share this data:
 *  - Address completeness (requirement A): an order address is only
 *    "complete enough to deliver" when it names a district AND an
 *    upazila/area detail. "Dhaka" alone is not enough.
 *  - Delivery charges (requirement C): the charge for an address depends
 *    on its district (a district rule wins) or on inside/outside Dhaka.
 *
 * District names are matched in English (lowercase, whole word) and in
 * Bengali script (substring — Bengali district names are distinctive).
 * Well-known Dhaka areas (Dhanmondi, Gulshan, …) imply Dhaka district.
 */

/** All 64 districts — [english (lowercase), bengali]. Alternate common spellings included. */
export const BANGLADESH_DISTRICTS: [string, string][] = [
  ['bagerhat', 'বাগেরহাট'],
  ['bandarban', 'বান্দরবান'],
  ['barguna', 'বরগুনা'],
  ['barishal', 'বরিশাল'],
  ['barisal', 'বরিশাল'],
  ['bhola', 'ভোলা'],
  ['bogura', 'বগুড়া'],
  ['bogra', 'বগুড়া'],
  ['brahmanbaria', 'ব্রাহ্মণবাড়িয়া'],
  ['chandpur', 'চাঁদপুর'],
  ['chattogram', 'চট্টগ্রাম'],
  ['chittagong', 'চট্টগ্রাম'],
  ['chuadanga', 'চুয়াডাঙ্গা'],
  ["cox's bazar", 'কক্সবাজার'],
  ['coxsbazar', 'কক্সবাজার'],
  ['cumilla', 'কুমিল্লা'],
  ['comilla', 'কুমিল্লা'],
  ['dhaka', 'ঢাকা'],
  ['dinajpur', 'দিনাজপুর'],
  ['faridpur', 'ফরিদপুর'],
  ['feni', 'ফেনী'],
  ['gaibandha', 'গাইবান্ধা'],
  ['gazipur', 'গাজীপুর'],
  ['gopalganj', 'গোপালগঞ্জ'],
  ['habiganj', 'হবিগঞ্জ'],
  ['jamalpur', 'জামালপুর'],
  ['jashore', 'যশোর'],
  ['jessore', 'যশোর'],
  ['jhalokati', 'ঝালকাঠি'],
  ['jhenaidah', 'ঝিনাইদহ'],
  ['joypurhat', 'জয়পুরহাট'],
  ['khagrachari', 'খাগড়াছড়ি'],
  ['khulna', 'খুলনা'],
  ['kishoreganj', 'কিশোরগঞ্জ'],
  ['kurigram', 'কুড়িগ্রাম'],
  ['kushtia', 'কুষ্টিয়া'],
  ['lakshmipur', 'লক্ষ্মীপুর'],
  ['lalmonirhat', 'লালমনিরহাট'],
  ['madaripur', 'মাদারীপুর'],
  ['magura', 'মাগুরা'],
  ['manikganj', 'মানিকগঞ্জ'],
  ['meherpur', 'মেহেরপুর'],
  ['moulvibazar', 'মৌলভীবাজার'],
  ['munshiganj', 'মুন্সিগঞ্জ'],
  ['mymensingh', 'ময়মনসিংহ'],
  ['naogaon', 'নওগাঁ'],
  ['narail', 'নড়াইল'],
  ['narayanganj', 'নারায়ণগঞ্জ'],
  ['narsingdi', 'নরসিংদী'],
  ['natore', 'নাটোর'],
  ['netrokona', 'নেত্রকোনা'],
  ['nilphamari', 'নীলফামারী'],
  ['noakhali', 'নোয়াখালী'],
  ['pabna', 'পাবনা'],
  ['panchagarh', 'পঞ্চগড়'],
  ['patuakhali', 'পটুয়াখালী'],
  ['pirojpur', 'পিরোজপুর'],
  ['rajbari', 'রাজবাড়ী'],
  ['rajshahi', 'রাজশাহী'],
  ['rangamati', 'রাঙামাটি'],
  ['rangpur', 'রংপুর'],
  ['satkhira', 'সাতক্ষীরা'],
  ['shariatpur', 'শরীয়তপুর'],
  ['sherpur', 'শেরপুর'],
  ['sirajganj', 'সিরাজগঞ্জ'],
  ['sunamganj', 'সুনামগঞ্জ'],
  ['sylhet', 'সিলেট'],
  ['tangail', 'টাঙ্গাইল'],
  ['thakurgaon', 'ঠাকুরগাঁও'],
];

/** Well-known Dhaka areas — mentioning one implies Dhaka district. */
export const DHAKA_AREAS: [string, string][] = [
  ['dhanmondi', 'ধানমন্ডি'],
  ['gulshan', 'গুলশান'],
  ['banani', 'বনানী'],
  ['mirpur', 'মিরপুর'],
  ['uttara', 'উত্তরা'],
  ['mohammadpur', 'মোহাম্মদপুর'],
  ['badda', 'বাড্ডা'],
  ['jatrabari', 'যাত্রাবাড়ী'],
  ['khilgaon', 'খিলগাঁও'],
  ['malibagh', 'মালিবাগ'],
  ['rampura', 'রামপুরা'],
  ['bashundhara', 'বসুন্ধরা'],
  ['baridhara', 'বারিধারা'],
  ['tejgaon', 'তেজগাঁও'],
  ['lalbagh', 'লালবাগ'],
  ['shyamoli', 'শ্যামলী'],
  ['adabor', 'আদাবর'],
  ['motijheel', 'মতিঝিল'],
  ['farmgate', 'ফার্মগেট'],
  ['panthapath', 'পান্থপথ'],
  ['azimpur', 'আজিমপুর'],
  ['wari', 'ওয়ারী'],
  ['keraniganj', 'কেরানীগঞ্জ'],
  ['savar', 'সাভার'],
  ['ashulia', 'আশুলিয়া'],
  ['tongi', 'টঙ্গী'],
];

/** Words that mark an area/upazila detail (house, road, village, …). */
const AREA_KEYWORDS_EN = [
  'house', 'road', 'sector', 'block', 'lane', 'flat', 'plot', 'village', 'bazar', 'bazaar',
  'thana', 'upazila', 'upazilla', 'holding', 'moholla', 'para', 'union', 'apartment',
];
const AREA_KEYWORDS_BN = [
  'বাসা', 'বাড়ি', 'হোল্ডিং', 'রোড', 'সড়ক', 'গলি', 'সেক্টর', 'ব্লক', 'মহল্লা', 'পাড়া',
  'গ্রাম', 'ইউনিয়ন', 'থানা', 'উপজেলা', 'বাজার', 'মোড়', 'লেন', 'ফ্ল্যাট', 'প্লট',
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\']/g, '\\$&');
}

/** Whole-word match for an English name inside a lowercased address. */
function hasEnglishName(lower: string, name: string): boolean {
  return new RegExp(`(^|[^a-z])${escapeRegExp(name)}(?![a-z])`).test(lower);
}

/**
 * The district named in an address, as the canonical lowercase English
 * name — or null when no district is named. A Dhaka area (Dhanmondi, …)
 * counts as 'dhaka'.
 */
export function findDistrictInAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const lower = address.toLowerCase();
  for (const [en, bn] of BANGLADESH_DISTRICTS) {
    if (hasEnglishName(lower, en) || address.includes(bn)) return en;
  }
  for (const [en, bn] of DHAKA_AREAS) {
    if (hasEnglishName(lower, en) || address.includes(bn)) return 'dhaka';
  }
  return null;
}

/** True when the address is in Dhaka (district named, or a Dhaka area). */
export function isDhakaAddress(address: string | null | undefined): boolean {
  return findDistrictInAddress(address) === 'dhaka';
}

export type MissingAddressPiece = 'district' | 'area';

export interface AddressCompleteness {
  complete: boolean;
  /** Which pieces are missing, in the order to ask for them. */
  missing: MissingAddressPiece[];
  /** The district found, if any (canonical lowercase English). */
  district: string | null;
  /**
   * True when the address is ONLY a city/district name with nothing else
   * (e.g. "Dhaka", "মাগুরা") — no upazila/area/house/road at all. The
   * AI then asks for the FULL address, not just one missing piece.
   */
  bareDistrict: boolean;
}

/**
 * Is an address complete enough to deliver?
 * Complete = a district is named AND an upazila/area detail is present.
 * An area detail is: an area keyword (বাসা/রোড/গ্রাম/house/road/…), or
 * 2+ comma-separated parts, or 5+ words. "Dhaka" alone fails (no area);
 * "বাসা ১২, রোড ৫, ধানমন্ডি" passes (Dhanmondi implies Dhaka district,
 * and বাসা/রোড give the area detail).
 */
export function assessAddressCompleteness(address: string | null | undefined): AddressCompleteness {
  const district = findDistrictInAddress(address);
  const text = (address ?? '').trim();
  const lower = text.toLowerCase();
  const hasAreaKeyword =
    AREA_KEYWORDS_EN.some((k) => hasEnglishName(lower, k)) || AREA_KEYWORDS_BN.some((k) => text.includes(k));
  const commaParts = text.split(',').map((p) => p.trim()).filter(Boolean).length;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const hasArea = hasAreaKeyword || commaParts >= 2 || wordCount >= 5;
  const missing: MissingAddressPiece[] = [];
  if (!district) missing.push('district');
  if (!hasArea) missing.push('area');
  // Bare district: only the city/district name, nothing else — no area
  // keyword, no comma, at most 2 words (e.g. "Dhaka", "মাগুরা",
  // "Cox's Bazar"). The AI asks for the FULL address in that case.
  const bareDistrict = district !== null && !hasArea && commaParts <= 1 && wordCount <= 2;
  return { complete: missing.length === 0, missing, district, bareDistrict };
}

/** Bengali name for a missing piece, for the one-line ask. */
export function missingPieceLabel(piece: MissingAddressPiece): string {
  return piece === 'district' ? 'জেলা' : 'উপজেলা/এলাকার বিস্তারিত';
}

/** The one short line the AI asks for the missing piece(s). */
export function missingAddressAskLine(missing: MissingAddressPiece[]): string {
  const label = missing.map(missingPieceLabel).join(' আর ');
  return `স্যার, আপনি ${label} লিখতে ভুলে গেছেন, একটু কষ্ট করে আবার বলেন।`;
}

/** The one short line the AI asks when the address is only a district name. */
export function fullAddressAskLine(): string {
  return 'স্যার, শুধু জেলার নাম দিলে ডেলিভারি করা যাবে না — পুরো ঠিকানাটা দিন (জেলা + উপজেলা + এলাকা + বাসা/রোড নম্বর বা ল্যান্ডমার্ক)।';
}

// ---------------------------------------------------------------------------
// Bangladeshi mobile numbers (refinement of requirement A).
// A valid number is 11 digits starting with 01. The customer may type it
// with the country code (+880 / 880) or with spaces/dashes — those are
// stripped first. 10 digits, 8 digits, or a number not starting with 01
// is INVALID: the AI says so politely and asks for the correct 11-digit
// number. Never auto-correct a wrong number, and never confirm an order
// with one.
// ---------------------------------------------------------------------------

/**
 * Normalize a Bangladeshi mobile number to its 11-digit 01XXXXXXXXX form,
 * or null when it is not a valid Bangladeshi mobile number.
 */
export function normalizeBdPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let d = String(phone).replace(/[^\d]/g, '');
  if (d.startsWith('880') && d.length === 13) d = `0${d.slice(3)}`;
  if (d.startsWith('88') && d.length === 12) d = `0${d.slice(2)}`;
  return /^01\d{9}$/.test(d) ? d : null;
}

/** True when the given phone is a valid Bangladeshi mobile number. */
export function isValidBdPhone(phone: string | null | undefined): boolean {
  return normalizeBdPhone(phone) !== null;
}

/** The one short line the AI asks when the phone number is not correct. */
export function invalidPhoneAskLine(): string {
  return 'স্যার, আপনার দেওয়া ফোন নম্বরটি সঠিক নয় — বাংলাদেশি মোবাইল নম্বর ১১ সংখ্যার হয় এবং ০১ দিয়ে শুরু হয়। সঠিক নম্বরটি আবার দিন।';
}

// ---------------------------------------------------------------------------
// Light address verification (refinement of requirement A).
// A curated list of well-known upazilas (sub-districts) — a simple local
// lookup, never a live API. It is a SUBSET, not exhaustive, so the check
// is LIGHT: an unmatched place name only earns a polite "please
// double-check" prompt, never a hard block. The order still goes through
// once the customer confirms the place (placeConfirmed).
// ---------------------------------------------------------------------------

/** Well-known upazilas — [english (lowercase), bengali]. */
export const BANGLADESH_UPAZILAS: [string, string][] = [
  ['dhamrai', 'ধামরাই'], ['dohar', 'দোহার'], ['keraniganj', 'কেরানীগঞ্জ'],
  ['nawabganj', 'নবাবগঞ্জ'], ['savar', 'সাভার'], ['ashulia', 'আশুলিয়া'],
  ['tongi', 'টঙ্গী'], ['kaliakair', 'কালিয়াকৈর'], ['kapasia', 'কাপাসিয়া'],
  ['sreepur', 'শ্রীপুর'], ['kaliganj', 'কালীগঞ্জ'], ['arai hazar', 'আড়াইহাজার'],
  ['araihazar', 'আড়াইহাজার'], ['bandar', 'বন্দর'], ['rupganj', 'রূপগঞ্জ'],
  ['sonargaon', 'সোনারগাঁও'], ['belabo', 'বেলাবো'], ['monohardi', 'মনোহরদী'],
  ['palash', 'পলাশ'], ['raipura', 'রায়পুরা'], ['shibpur', 'শিবপুর'],
  ['daulatpur', 'দৌলতপুর'], ['ghior', 'ঘিওর'], ['harirampur', 'হরিরামপুর'],
  ['saturia', 'সাটুরিয়া'], ['shibalaya', 'শিবালয়'], ['singair', 'সিঙ্গাইর'],
  ['gazaria', 'গজারিয়া'], ['lohajang', 'লৌহজং'], ['sirajdikhan', 'সিরাজদিখান'],
  ['sreenagar', 'শ্রীনগর'], ['tongibari', 'টংগিবাড়ী'], ['alfadanga', 'আলফাডাঙ্গা'],
  ['bhanga', 'ভাঙ্গা'], ['boalmari', 'বোয়ালমারী'], ['charbhadrasan', 'চরভদ্রাসন'],
  ['madhukhali', 'মধুখালী'], ['nagarkanda', 'নগরকান্দা'], ['sadarpur', 'সদরপুর'],
  ['saltha', 'সালথা'], ['kashiani', 'কাশিয়ানী'], ['kotalipara', 'কোটালীপাড়া'],
  ['muksudpur', 'মুকসুদপুর'], ['tungipara', 'টুঙ্গিপাড়া'], ['kalkini', 'কালকিনি'],
  ['rajoir', 'রাজৈর'], ['shibchar', 'শিবচর'], ['bhedarganj', 'ভেদরগঞ্জ'],
  ['damudya', 'ডামুড্যা'], ['gosairhat', 'গোসাইরহাট'], ['naria', 'নড়িয়া'],
  ['zajira', 'জাজিরা'], ['baliakandi', 'বালিয়াকান্দি'], ['goalandaghat', 'গোয়ালন্দঘাট'],
  ['pangsha', 'পাংশা'], ['kalukhali', 'কালুখালী'], ['austagram', 'অষ্টগ্রাম'],
  ['bajitpur', 'বাজিতপুর'], ['bhairab', 'ভৈরব'], ['hossainpur', 'হোসেনপুর'],
  ['itna', 'ইটনা'], ['karimganj', 'করিমগঞ্জ'], ['katiadi', 'কটিয়াদী'],
  ['kuliarchar', 'কুলিয়ারচর'], ['mithamain', 'মিঠামইন'], ['nikli', 'নিকলী'],
  ['pakundia', 'পাকুন্দিয়া'], ['tarail', 'তাড়াইল'], ['basail', 'বাসাইল'],
  ['bhuapur', 'ভূঞাপুর'], ['delduar', 'দেলদুয়ার'], ['ghatail', 'ঘাটাইল'],
  ['gopalpur', 'গোপালপুর'], ['kalihati', 'কালিহাতী'], ['madhupur', 'মধুপুর'],
  ['mirzapur', 'মির্জাপুর'], ['nagarpur', 'নাগরপুর'], ['sakhipur', 'সখিপুর'],
  ['dhanbari', 'ধনবাড়ী'], ['anwara', 'আনোয়ারা'], ['banshkhali', 'বাঁশখালী'],
  ['boalkhali', 'বোয়ালখালী'], ['chandanaish', 'চন্দনাইশ'], ['fatikchhari', 'ফটিকছড়ি'],
  ['hathazari', 'হাটহাজারী'], ['lohagara', 'লোহাগাড়া'], ['mirsarai', 'মীরসরাই'],
  ['patiya', 'পটিয়া'], ['rangunia', 'রাঙ্গুনিয়া'], ['raozan', 'রাউজান'],
  ['sandwip', 'সন্দ্বীপ'], ['satkania', 'সাতকানিয়া'], ['sitakunda', 'সীতাকুণ্ড'],
  ['chakaria', 'চকরিয়া'], ['kutubdia', 'কুতুবদিয়া'], ['maheshkhali', 'মহেশখালী'],
  ['pekua', 'পেকুয়া'], ['ramu', 'রামু'], ['teknaf', 'টেকনাফ'],
  ['ukhia', 'উখিয়া'], ['barura', 'বরুড়া'], ['brahmanpara', 'ব্রাহ্মণপাড়া'],
  ['burichang', 'বুড়িচং'], ['chandina', 'চান্দিনা'], ['chauddagram', 'চৌদ্দগ্রাম'],
  ['daudkandi', 'দাউদকান্দি'], ['debidwar', 'দেবীদ্বার'], ['homna', 'হোমনা'],
  ['laksam', 'লাকসাম'], ['muradnagar', 'মুরাদনগর'], ['nangalkot', 'নাঙ্গলকোট'],
  ['titas', 'তিতাস'], ['akhaura', 'আখাউড়া'], ['ashuganj', 'আশুগঞ্জ'],
  ['bancharampur', 'বাঞ্ছারামপুর'], ['kasba', 'কসবা'], ['nabinagar', 'নবীনগর'],
  ['nasirnagar', 'নাসিরনগর'], ['sarail', 'সরাইল'], ['faridganj', 'ফরিদগঞ্জ'],
  ['haimchar', 'হাইমচর'], ['hajiganj', 'হাজীগঞ্জ'], ['kachua', 'কচুয়া'],
  ['matlab', 'মতলব'], ['shahrasti', 'শাহরাস্তি'], ['chhagalnaiya', 'ছাগলনাইয়া'],
  ['daganbhuiyan', 'দাগনভূঞা'], ['fulgazi', 'ফুলগাজী'], ['parshuram', 'পরশুরাম'],
  ['sonagazi', 'সোনাগাজী'], ['kamalnagar', 'কমলনগর'], ['raipur', 'রায়পুর'],
  ['ramganj', 'রামগঞ্জ'], ['ramgati', 'রামগতি'], ['begumganj', 'বেগমগঞ্জ'],
  ['chatkhil', 'চাটখিল'], ['companiganj', 'কোম্পানীগঞ্জ'], ['hatiya', 'হাতিয়া'],
  ['senbag', 'সেনবাগ'], ['sonaimuri', 'সোনাইমুড়ী'], ['subarnachar', 'সুবর্ণচর'],
  ['dighinala', 'দীঘিনালা'], ['mahalchari', 'মহালছড়ি'], ['manikchari', 'মানিকছড়ি'],
  ['matiranga', 'মাটিরাঙ্গা'], ['panchari', 'পানছড়ি'], ['ramgarh', 'রামগড়'],
  ['baghaichari', 'বাঘাইছড়ি'], ['barkal', 'বরকল'], ['belaichari', 'বিলাইছড়ি'],
  ['kaptai', 'কাপ্তাই'], ['langadu', 'লংগদু'], ['naniarchar', 'নানিয়ারচর'],
  ['rajasthali', 'রাজস্থলী'], ['alikadam', 'আলীকদম'], ['lama', 'লামা'],
  ['naikhongchhari', 'নাইক্ষ্যংছড়ি'], ['rowangchhari', 'রোয়াংছড়ি'], ['ruma', 'রুমা'],
  ['thanchi', 'থানচি'], ['batiaghata', 'বটিয়াঘাটা'], ['dacope', 'দাকোপ'],
  ['dumuria', 'ডুমুরিয়া'], ['dighalia', 'দিঘলিয়া'], ['koyra', 'কয়রা'],
  ['paikgachha', 'পাইকগাছা'], ['phultala', 'ফুলতলা'], ['rupsa', 'রূপসা'],
  ['terokhada', 'তেরখাদা'], ['chitalmari', 'চিতলমারী'], ['fakirhat', 'ফকিরহাট'],
  ['mollahat', 'মোল্লাহাট'], ['mongla', 'মোংলা'], ['morrelganj', 'মোড়েলগঞ্জ'],
  ['rampal', 'রামপাল'], ['sharankhola', 'শরণখোলা'], ['abhaynagar', 'অভয়নগর'],
  ['bagherpara', 'বাঘেরপাড়া'], ['chaugachha', 'চৌগাছা'], ['jhikargachha', 'ঝিকরগাছা'],
  ['keshabpur', 'কেশবপুর'], ['manirampur', 'মণিরামপুর'], ['sharsha', 'শার্শা'],
  ['assasuni', 'আশাশুনি'], ['debhata', 'দেবহাটা'], ['kalaroa', 'কলারোয়া'],
  ['shyamnagar', 'শ্যামনগর'], ['tala', 'তালা'], ['bheramara', 'ভেড়ামারা'],
  ['khoksa', 'খোকসা'], ['kumarkhali', 'কুমারখালী'], ['mirpur', 'মিরপুর'],
  ['alamdanga', 'আলমডাঙ্গা'], ['damurhuda', 'দামুড়হুদা'], ['jibannagar', 'জীবননগর'],
  ['harinakunda', 'হরিণাকুণ্ড'], ['kotchandpur', 'কোটচাঁদপুর'], ['maheshpur', 'মহেশপুর'],
  ['shailkupa', 'শৈলকুপা'], ['mohammadpur', 'মোহাম্মদপুর'], ['shalikha', 'শালিখা'],
  ['sreepur', 'শ্রীপুর'], ['kalia', 'কালিয়া'], ['lohagara', 'লোহাগড়া'],
  ['gangni', 'গাংনী'], ['mujibnagar', 'মুজিবনগর'], ['bagha', 'বাঘা'],
  ['bagmara', 'বাগমারা'], ['charghat', 'চারঘাট'], ['durgapur', 'দুর্গাপুর'],
  ['godagari', 'গোদাগাড়ী'], ['mohanpur', 'মোহনপুর'], ['paba', 'পবা'],
  ['puthia', 'পুঠিয়া'], ['tanore', 'তানোর'], ['adamdighi', 'আদমদীঘি'],
  ['dhunat', 'ধুনট'], ['dupchanchia', 'দুপচাঁচিয়া'], ['gabtali', 'গাবতলী'],
  ['kahaloo', 'কাহালু'], ['nandigram', 'নন্দীগ্রাম'], ['sariakandi', 'সারিয়াকান্দি'],
  ['sherpur', 'শেরপুর'], ['shibganj', 'শিবগঞ্জ'], ['sonatala', 'সোনাতলা'],
  ['atgharia', 'আটঘরিয়া'], ['bera', 'বেড়া'], ['bhangura', 'ভাঙ্গুড়া'],
  ['chatmohar', 'চাটমোহর'], ['ishwardi', 'ঈশ্বরদী'], ['santhia', 'সাঁথিয়া'],
  ['sujanagar', 'সুজানগর'], ['belkuchi', 'বেলকুচি'], ['chauhali', 'চৌহালী'],
  ['kamarkhanda', 'কামারখন্দ'], ['kazipur', 'কাজিপুর'], ['raiganj', 'রায়গঞ্জ'],
  ['shahjadpur', 'শাহজাদপুর'], ['tarash', 'তাড়াশ'], ['ullahpara', 'উল্লাপাড়া'],
  ['atrai', 'আত্রাই'], ['badalgachhi', 'বদলগাছী'], ['dhamoirhat', 'ধামইরহাট'],
  ['manda', 'মান্দা'], ['mohadevpur', 'মহাদেবপুর'], ['niamatpur', 'নিয়ামতপুর'],
  ['patnitala', 'পত্নীতলা'], ['porsha', 'পোরশা'], ['raninagar', 'রানীনগর'],
  ['sapahar', 'সাপাহার'], ['bagatipara', 'বাগাতিপাড়া'], ['baraigram', 'বড়াইগ্রাম'],
  ['gurudaspur', 'গুরুদাসপুর'], ['lalpur', 'লালপুর'], ['singra', 'সিংড়া'],
  ['akkelpur', 'আক্কেলপুর'], ['kalai', 'কালাই'], ['khetlal', 'খেতলাল'],
  ['panchbibi', 'পাঁচবিবি'], ['bholahat', 'ভোলাহাট'], ['gomastapur', 'গোমস্তাপুর'],
  ['nachole', 'নাচোল'], ['agailjhara', 'আগৈলঝাড়া'], ['babuganj', 'বাবুগঞ্জ'],
  ['bakerganj', 'বাকেরগঞ্জ'], ['banaripara', 'বানারীপাড়া'], ['gaurnadi', 'গৌরনদী'],
  ['hizla', 'হিজলা'], ['mehendiganj', 'মেহেন্দিগঞ্জ'], ['muladi', 'মুলাদী'],
  ['wazirpur', 'উজিরপুর'], ['burhanuddin', 'বোরহানউদ্দিন'], ['char fasson', 'চরফ্যাশন'],
  ['daulatkhan', 'দৌলতখান'], ['lalmohan', 'লালমোহন'], ['manpura', 'মনপুরা'],
  ['tazumuddin', 'তজুমদ্দিন'], ['bauphal', 'বাউফল'], ['dashmina', 'দশমিনা'],
  ['dumki', 'ডুমকি'], ['galachipa', 'গলাচিপা'], ['kalapara', 'কলাপাড়া'],
  ['mirzaganj', 'মির্জাগঞ্জ'], ['rangabali', 'রাঙ্গাবালী'], ['bhandaria', 'ভান্ডারিয়া'],
  ['kawkhali', 'কাউখালী'], ['mathbaria', 'মঠবাড়িয়া'], ['nazirpur', 'নাজিরপুর'],
  ['nesarabad', 'নেছারাবাদ'], ['zianagar', 'জিয়ানগর'], ['amtali', 'আমতলী'],
  ['bamna', 'বামনা'], ['betagi', 'বেতাগী'], ['patharghata', 'পাথরঘাটা'],
  ['taltali', 'তালতলী'], ['kathalia', 'কাঠালিয়া'], ['nalchity', 'নলছিটি'],
  ['rajapur', 'রাজাপুর'], ['balaganj', 'বালাগঞ্জ'], ['beanibazar', 'বিয়ানীবাজার'],
  ['bishwanath', 'বিশ্বনাথ'], ['dakshin surma', 'দক্ষিণ সুরমা'], ['fenchuganj', 'ফেঞ্চুগঞ্জ'],
  ['golapganj', 'গোলাপগঞ্জ'], ['gowainghat', 'গোয়াইনঘাট'], ['jaintiapur', 'জৈন্তাপুর'],
  ['kanaighat', 'কানাইঘাট'], ['zakiganj', 'জকিগঞ্জ'], ['ajmiriganj', 'আজমিরীগঞ্জ'],
  ['bahubal', 'বাহুবল'], ['baniachong', 'বানিয়াচং'], ['chunarughat', 'চুনারুঘাট'],
  ['lakhai', 'লাখাই'], ['madhabpur', 'মাধবপুর'], ['nabiganj', 'নবীগঞ্জ'],
  ['barlekha', 'বড়লেখা'], ['juri', 'জুড়ী'], ['kamalganj', 'কমলগঞ্জ'],
  ['kulaura', 'কুলাউড়া'], ['rajnagar', 'রাজনগর'], ['sreemangal', 'শ্রীমঙ্গল'],
  ['bishwambharpur', 'বিশ্বম্ভরপুর'], ['chhatak', 'ছাতক'], ['derai', 'দিরাই'],
  ['dharampasha', 'ধর্মপাশা'], ['dowarabazar', 'দোয়ারাবাজার'], ['jagannathpur', 'জগন্নাথপুর'],
  ['jamalganj', 'জামালগঞ্জ'], ['sullah', 'সুল্লা'], ['tahirpur', 'তাহিরপুর'],
  ['badarganj', 'বদরগঞ্জ'], ['gangachara', 'গংগাচড়া'], ['kaunia', 'কাউনিয়া'],
  ['mithapukur', 'মিঠাপুকুর'], ['pirgachha', 'পীরগাছা'], ['pirganj', 'পীরগঞ্জ'],
  ['taraganj', 'তারাগঞ্জ'], ['birampur', 'বিরামপুর'], ['birganj', 'বীরগঞ্জ'],
  ['bochaganj', 'বোচাগঞ্জ'], ['chirirbandar', 'চিরিরবন্দর'], ['fulbari', 'ফুলবাড়ী'],
  ['ghoraghat', 'ঘোড়াঘাট'], ['hakimpur', 'হাকিমপুর'], ['kaharole', 'কাহারোল'],
  ['khansama', 'খানসামা'], ['parbatipur', 'পার্বতীপুর'], ['fulchhari', 'ফুলছড়ি'],
  ['gobindaganj', 'গোবিন্দগঞ্জ'], ['palashbari', 'পলাশবাড়ী'], ['sadullapur', 'সাদুল্লাপুর'],
  ['saghata', 'সাঘাটা'], ['sundarganj', 'সুন্দরগঞ্জ'], ['bhurungamari', 'ভূরুঙ্গামারী'],
  ['char rajibpur', 'চর রাজিবপুর'], ['chilmari', 'চিলমারী'], ['nageshwari', 'নাগেশ্বরী'],
  ['rajarhat', 'রাজারহাট'], ['roumari', 'রৌমারী'], ['ulipur', 'উলিপুর'],
  ['aditmari', 'আদিতমারী'], ['hatibandha', 'হাতীবান্ধা'], ['patgram', 'পাটগ্রাম'],
  ['dimla', 'ডিমলা'], ['domar', 'ডোমার'], ['jaldhaka', 'জলঢাকা'],
  ['kishoreganj', 'কিশোরগঞ্জ'], ['saidpur', 'সৈয়দপুর'], ['atwari', 'আটোয়ারী'],
  ['boda', 'বোদা'], ['debiganj', 'দেবীগঞ্জ'], ['tetulia', 'তেতুলিয়া'],
  ['baliadangi', 'বালিয়াডাঙ্গী'], ['haripur', 'হরিপুর'], ['ranisankail', 'রাণীশংকৈল'],
];

/** "সদর" (the district town) is a real upazila everywhere — never flag it. */
const SADAR_WORDS = ['সদর', 'sadar'];

/** A place name is known when it is a district, a Dhaka area, or an upazila. */
function isKnownPlaceName(name: string): boolean {
  const lower = name.toLowerCase().trim();
  if (!lower) return true;
  if (SADAR_WORDS.some((w) => lower.includes(w))) return true;
  for (const [en, bn] of BANGLADESH_DISTRICTS) {
    if (hasEnglishName(lower, en) || name.includes(bn)) return true;
  }
  for (const [en, bn] of DHAKA_AREAS) {
    if (hasEnglishName(lower, en) || name.includes(bn)) return true;
  }
  for (const [en, bn] of BANGLADESH_UPAZILAS) {
    if (hasEnglishName(lower, en) || name.includes(bn)) return true;
  }
  return false;
}

/**
 * Light address verification: the place names in an address that do NOT
 * match any real district / Dhaka area / upazila in the local lists.
 *
 * Only the "administrative" parts are checked: a bare place name, or a
 * part labelled জেলা/district, উপজেলা/upazila, থানা/thana, ইউনিয়ন/union.
 * House/road/village/neighbourhood details (বাসা, রোড, গ্রাম, মহল্লা,
 * পাড়া, বাজার, house, road, village, …) are NOT checked — they are far
 * too granular to list, so they never flag. A part that is only
 * numbers/keywords is skipped.
 *
 * Returns the unknown place names (as written). Empty = everything
 * matches. This is a LIGHT check: the caller asks the customer to
 * double-check the name; it never blocks the order on its own.
 */
export function findUnknownPlaceNames(address: string | null | undefined): string[] {
  const text = (address ?? '').trim();
  if (!text) return [];
  // Detail keywords: the part is a street/house/village/neighbourhood
  // detail, not an administrative place name — never verify it.
  const DETAIL_KEYWORDS_BN = ['বাসা', 'বাড়ি', 'হোল্ডিং', 'রোড', 'সড়ক', 'গলি', 'সেক্টর', 'ব্লক', 'ফ্ল্যাট', 'প্লট', 'গ্রাম', 'মহল্লা', 'পাড়া', 'বাজার', 'মোড়', 'লেন'];
  const DETAIL_KEYWORDS_EN = ['house', 'road', 'sector', 'block', 'lane', 'flat', 'plot', 'village', 'apartment', 'holding'];
  const unknown: string[] = [];
  const segments = text.split(',').map((s) => s.trim()).filter(Boolean);
  for (const seg of segments) {
    const lowerSeg = seg.toLowerCase();
    if (DETAIL_KEYWORDS_BN.some((k) => seg.includes(k))) continue;
    if (DETAIL_KEYWORDS_EN.some((k) => hasEnglishName(lowerSeg, k))) continue;
    // Strip numbers and administrative labels; what is left is the place name.
    let place = seg.replace(/[\d০-৯]+/g, ' ').replace(/নং|no\.?|নম্বর/g, ' ');
    place = place.replace(/জেলা|district|উপজেলা|upazila|থানা|thana|ইউনিয়ন|union/gi, ' ');
    place = place.replace(/[.\-–—/]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!place) continue;
    if (!isKnownPlaceName(place)) unknown.push(place);
  }
  return [...new Set(unknown)];
}

/** The one short line the AI asks when a place name does not match. */
export function unknownPlaceAskLine(places: string[]): string {
  const label = places.join(', ');
  return `স্যার, ঠিকানায় "${label}" জায়গাটা মিলছে না — একটু মিলিয়ে দেখবেন কি, নামটা ঠিক আছে তো?`;
}
