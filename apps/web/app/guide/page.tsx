"use client";
import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import { imageMatchApi } from "@/lib/api-new-features";

// Written step-by-step guides (Worker B). These are TEXT guides, not
// videos — the page says so honestly and never fakes a video player.
const GUIDES: { id: string; en: string; bn: string; stepsEn: string[]; stepsBn: string[] }[] = [
  {
    id: "photo",
    en: "Find a product from a photo",
    bn: "ছবি দিয়ে প্রোডাক্ট খুঁজুন",
    stepsEn: [
      "Ask the customer to send the product photo in the chat.",
      "Paste the photo link in the photo search box below and press Search.",
      "If a product matches, check its real price and stock before you reply.",
      "If it says photo recognition is not available yet, ask the customer for the product name instead.",
    ],
    stepsBn: [
      "কাস্টমারকে চ্যাটে প্রোডাক্টের ছবি পাঠাতে বলুন।",
      "নিচের ছবি খোঁজার বাক্সে ছবির লিংক বসিয়ে খুঁজুন চাপুন।",
      "প্রোডাক্ট মিললে উত্তর দেওয়ার আগে আসল দাম ও স্টক দেখে নিন।",
      "যদি বলে ছবি দিয়ে খোঁজা এখনো চালু হয়নি, তাহলে কাস্টমারের কাছে প্রোডাক্টের নাম জানতে চান।",
    ],
  },
  {
    id: "voice",
    en: "Take an order from a voice note",
    bn: "ভয়েস নোট থেকে অর্ডার নিন",
    stepsEn: [
      "When a customer sends a voice note, write down what they said (transcript).",
      "The AI reads the transcript and makes a DRAFT order — it is not confirmed yet.",
      "Check the draft: product, quantity and price must match your shop.",
      "Confirm the draft with the customer before you approve it.",
    ],
    stepsBn: [
      "কাস্টমার ভয়েস নোট পাঠালে তিনি কী বলেছেন, তা লিখে নিন (ট্রান্সক্রিপ্ট)।",
      "AI সেই লেখা পড়ে একটি খসড়া (ড্রাফট) অর্ডার বানায় — এটা এখনো নিশ্চিত নয়।",
      "খসড়াটি মিলিয়ে দেখুন: প্রোডাক্ট, সংখ্যা ও দাম আপনার দোকানের সাথে মিলতে হবে।",
      "অনুমোদন করার আগে কাস্টমারের সাথে নিশ্চিত হয়ে নিন।",
    ],
  },
  {
    id: "handover",
    en: "Take over a chat from the AI (handover)",
    bn: "AI-এর কাছ থেকে চ্যাট নিজে নিন (হ্যান্ডওভার)",
    stepsEn: [
      "Open the chat in the inbox.",
      "Choose handover for 1 hour or 4 hours — the AI pauses for that long.",
      "Reply to the customer yourself.",
      "When the time ends, the chat goes back to the AI by itself, or press Return to AI earlier.",
    ],
    stepsBn: [
      "ইনবক্সে চ্যাটটি খুলুন।",
      "১ ঘণ্টা বা ৪ ঘণ্টার জন্য হ্যান্ডওভার বেছে নিন — ততক্ষণ AI থেমে থাকবে।",
      "কাস্টমারকে নিজে উত্তর দিন।",
      "সময় শেষ হলে চ্যাট নিজে থেকেই AI-এর কাছে ফিরে যাবে, অথবা আগেই Return to AI চাপুন।",
    ],
  },
  {
    id: "saved",
    en: "Use saved replies",
    bn: "সেভ করা উত্তর ব্যবহার করুন",
    stepsEn: [
      "Go to Saved replies and write the answers you send again and again.",
      "Give each one a clear title, like Delivery charge.",
      "In the inbox, pick the saved reply and send it with one tap.",
    ],
    stepsBn: [
      "Saved replies-এ গিয়ে বারবার পাঠানো উত্তরগুলো লিখে রাখুন।",
      "প্রতিটির পরিষ্কার শিরোনাম দিন, যেমন: ডেলিভারি চার্জ।",
      "ইনবক্সে সেভ করা উত্তরটি বেছে এক ক্লিকে পাঠান।",
    ],
  },
  {
    id: "comments",
    en: "Moderate comments",
    bn: "কমেন্ট যাচাই করুন",
    stepsEn: [
      "Open Comments to see every comment that needs checking.",
      "Answer the good questions, hide rude or spam comments, and mark done when finished.",
      "Answered comments show your reply so the team can see what was said.",
    ],
    stepsBn: [
      "Comments খুলে যাচাই করার মতো সব কমেন্ট দেখুন।",
      "ভালো প্রশ্নের উত্তর দিন, খারাপ বা স্প্যাম কমেন্ট লুকান, শেষ হলে Done করুন।",
      "উত্তর দেওয়া কমেন্টে আপনার উত্তর দেখা যায়, যাতে টিম বুঝতে পারে কী বলা হয়েছে।",
    ],
  },
  {
    id: "team",
    en: "Invite your team",
    bn: "টিমকে আমন্ত্রণ জানান",
    stepsEn: [
      "Go to Team and enter the person's email.",
      "Copy the invite link that appears — no email is sent automatically.",
      "Send the link to the person yourself, for example on WhatsApp.",
    ],
    stepsBn: [
      "Team-এ গিয়ে ব্যক্তির ইমেইল লিখুন।",
      "যে আমন্ত্রণের লিংক আসবে, সেটি কপি করুন — নিজে থেকে কোনো ইমেইল যাবে না।",
      "লিংকটি নিজে পাঠান, যেমন WhatsApp-এ।",
    ],
  },
  {
    id: "website",
    en: "Add chat to your website",
    bn: "ওয়েবসাইটে চ্যাট যোগ করুন",
    stepsEn: [
      "Open Website chat and copy the snippet.",
      "Paste it before the closing </body> tag of your website.",
      "Visitors can now chat, and their messages appear in your inbox.",
    ],
    stepsBn: [
      "Website chat খুলে কোডটি কপি করুন।",
      "আপনার ওয়েবসাইটের </body> ট্যাগের আগে এটি বসান।",
      "এখন ভিজিটররা চ্যাট করতে পারবে, আর তাদের মেসেজ আপনার ইনবক্সে আসবে।",
    ],
  },
  {
    id: "setup",
    en: "Finish the 7-step setup",
    bn: "৭ ধাপের সেটআপ শেষ করুন",
    stepsEn: [
      "Open Setup and finish each step in order.",
      "On the last step you get a 5-digit test code.",
      "Enter the code to verify — then your shop is live.",
    ],
    stepsBn: [
      "Setup খুলে একে একে প্রতিটি ধাপ শেষ করুন।",
      "শেষ ধাপে ৫ অঙ্কের একটি টেস্ট কোড পাবেন।",
      "কোডটি লিখে যাচাই করুন — তারপর আপনার দোকান লাইভ হবে।",
    ],
  },
  {
    id: "followups",
    en: "Follow up hot leads first",
    bn: "গরম লিডদের আগে ফলো-আপ করুন",
    stepsEn: [
      "Mark a lead hot when the customer is ready to buy soon.",
      "Hot follow-ups are sent before warm ones.",
      "Stop after 3 follow-ups with no reply — the lead has gone cold.",
    ],
    stepsBn: [
      "কাস্টমার শীঘ্রই কিনতে চাইলে লিডটিকে hot করুন।",
      "গরম (hot) ফলো-আপ আগে পাঠানো হয়, তারপর ঠান্ডা (warm)।",
      "৩ বার ফলো-আপের পরও উত্তর না এলে থামুন — লিডটি ঠান্ডা হয়ে গেছে।",
    ],
  },
];

export default function GuidePage() {
  const { t, fmtTaka } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  const [imageRef, setImageRef] = useState("");
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState<{ available: boolean; matches: { productId: string; name: string; pricePaisa: number; stock: number; score: number }[]; uncertain: boolean; message?: string } | null>(null);
  const [searchError, setSearchError] = useState("");

  const searchPhoto = async (e: React.FormEvent) => {
    e.preventDefault();
    setSearching(true);
    setSearchError("");
    setResult(null);
    try {
      const res = await imageMatchApi.match(imageRef.trim());
      setResult(res);
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : t("guidePhotoFail", "Photo search failed.", "ছবি খোঁজা যায়নি।"));
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="bg-[#FFF1EA] min-h-screen -m-6 p-6">
      <h1 className="text-2xl font-bold mb-1">{t("guideTitle", "Guide", "গাইড")}</h1>
      <p className="text-sm text-slate-500 mb-4">{t("guideSub", "Written step-by-step guides for every feature. These are written guides, not videos.", "প্রতিটি ফিচারের জন্য লেখা ধাপে ধাপে গাইড। এগুলো লেখা গাইড, ভিডিও নয়।")}</p>

      <div className="card p-4 mb-6">
        <h2 className="font-bold">{t("guidePhotoTitle", "Try photo search", "ছবি দিয়ে খুঁজে দেখুন")}</h2>
        <p className="text-sm text-slate-500 mb-3">{t("guidePhotoSub", "Paste a product photo link to find the matching product.", "মিলে যাওয়া প্রোডাক্ট খুঁজতে ছবির লিংক বসান।")}</p>
        <form onSubmit={searchPhoto} className="flex gap-2 flex-wrap">
          <input required value={imageRef} onChange={(e) => setImageRef(e.target.value)} placeholder="https://… / photo link" className="border rounded-lg px-3 py-2 flex-1 min-w-[220px]" />
          <button disabled={searching} className="bg-[#FF5B2E] hover:bg-[#E8491F] text-white rounded-lg px-4 py-2 disabled:opacity-50">
            {searching ? t("guideSearching", "Searching…", "খোঁজা হচ্ছে…") : t("guideSearch", "Search", "খুঁজুন")}
          </button>
        </form>
        {searchError && <p className="text-red-600 text-sm mt-3">{searchError}</p>}
        {result && !result.available && (
          <p className="bg-amber-50 text-amber-800 text-sm p-3 rounded-lg mt-3">
            {t("guidePhotoUnavailable", "Photo recognition is not available yet — it needs an embeddings service. Ask the customer for the product name instead.", "ছবি দিয়ে খোঁজা এখনো চালু হয়নি — এমবেডিং সার্ভিস লাগবে। কাস্টমারের কাছে প্রোডাক্টের নাম জানতে চান।")}
          </p>
        )}
        {result && result.available && result.matches.length === 0 && (
          <p className="text-sm mt-3">{result.message ?? t("guideNoMatch", "No matching product found.", "মিলে যাওয়া প্রোডাক্ট পাওয়া যায়নি।")}</p>
        )}
        {result && result.available && result.matches.length > 0 && (
          <div className="grid gap-2 mt-3">
            {result.uncertain && <p className="text-sm text-amber-700">{t("guideUncertain", "These are the closest matches — please confirm with the customer which one they want.", "এগুলো সবচেয়ে কাছের মিল — কাস্টমার কোনটি চান, তা নিশ্চিত হয়ে নিন।")}</p>}
            {result.matches.map((m) => (
              <div key={m.productId} className="border rounded-lg p-3 flex justify-between gap-2">
                <span className="font-bold">{m.name}</span>
                <span className="text-sm">{fmtTaka(m.pricePaisa)} · {t("guideStock", "Stock:", "স্টক:")} {m.stock}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-3">
        {GUIDES.map((g) => {
          const isOpen = open === g.id;
          return (
            <div key={g.id} className="card p-4">
              <button onClick={() => setOpen(isOpen ? null : g.id)} className="w-full text-left flex justify-between gap-2">
                <span className="font-bold">{t(`guide_${g.id}`, g.en, g.bn)}</span>
                <span className="text-[#FF5B2E]">{isOpen ? "−" : "+"}</span>
              </button>
              {isOpen && (
                <ol className="list-decimal list-inside text-sm text-slate-600 grid gap-1 mt-3">
                  {g.stepsEn.map((s, i) => (
                    <li key={i}>{t(`guide_${g.id}_step${i + 1}`, s, g.stepsBn[i] ?? s)}</li>
                  ))}
                </ol>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
