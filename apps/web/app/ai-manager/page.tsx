"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { ApiError, api, getToken } from "@/lib/api";

/**
 * AI Sales Manager / এআই সেলস ম্যানেজার — the shop owner chats with the
 * AI about the shop's REAL numbers for today (orders, replies, AI cost,
 * wallet, pending orders, top products). Every answer comes from the
 * database via POST /api/owner/ai-chat; the AI never invents numbers.
 *
 * Owner-only (same Task 14 pattern as AI Providers): the API returns
 * 403 for members/admins, and this page says so plainly instead of
 * showing a generic load error. The sidebar hides the item for
 * non-owners too (Sidebar.tsx filters owner-only items by role).
 */

interface ChatMessage {
  id: string;
  role: string;
  content: string;
  createdAt: string;
}

interface ChatReply {
  reply: string;
  stats?: unknown;
  aiCostPaisa?: number;
  usedGemini?: boolean;
  ledgerId?: string | null;
}

const EXAMPLE_QUESTIONS = [
  "আজকে কতগুলো অর্ডার হয়েছে?",
  "আজকে কত টাকা খরচ হয়েছে?",
  "পেন্ডিং অর্ডার কতগুলো?",
];

export default function AiManagerPage() {
  const { t } = useI18n();
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  // Owner-only page (Task 14 pattern): a 403 means "member/admin".
  const [notOwner, setNotOwner] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.get<{ messages: ChatMessage[] }>("/api/owner/ai-chat");
      setMessages(d.messages ?? []);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setNotOwner(true);
      } else {
        setError(err instanceof Error ? err.message : t("aiMgrLoadFail", "Could not load the chat.", "চ্যাট লোড করা যায়নি।"));
      }
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!getToken()) {
      router.push("/login");
      return;
    }
    load();
  }, [load, router]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, sending]);

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setError("");
    setSending(true);
    // Show the owner's message immediately; the AI reply appends below.
    const tempId = `local-${Date.now()}`;
    setMessages((prev) => [...prev, { id: tempId, role: "user", content: trimmed, createdAt: new Date().toISOString() }]);
    setInput("");
    try {
      const res = await api.post<ChatReply>("/api/owner/ai-chat", { message: trimmed });
      setMessages((prev) => [
        ...prev.filter((m) => m.id !== tempId),
        { id: `local-u-${Date.now()}`, role: "user", content: trimmed, createdAt: new Date().toISOString() },
        { id: `local-a-${Date.now()}`, role: "assistant", content: res.reply, createdAt: new Date().toISOString() },
      ]);
    } catch (err) {
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      if (err instanceof ApiError && err.status === 403) {
        setNotOwner(true);
      } else {
        setError(err instanceof Error ? err.message : t("aiMgrSendFail", "Could not send the message.", "মেসেজ পাঠানো যায়নি।"));
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <div>
      <h1 className="page-title">{t("aiMgrTitle", "AI Sales Manager", "এআই সেলস ম্যানেজার")}</h1>
      <p className="page-subtitle">
        {t(
          "aiMgrSub",
          "Ask about your shop's real numbers for today — orders, replies, AI cost, wallet balance. The AI answers from your actual data, never from guesses.",
          "আজকের আসল হিসাব জিজ্ঞেস করুন — অর্ডার, রিপ্লাই, AI খরচ, ওয়ালেট ব্যালেন্স। AI আপনার আসল ডাটা থেকে উত্তর দেয়, অনুমান করে নয়।"
        )}
      </p>

      {notOwner && (
        <div className="card p-4">
          <p className="font-bold">{t("aiMgrOwnerOnly", "Only the shop owner can see this", "এটা শুধু দোকানের মালিক দেখতে পারেন")}</p>
          <p className="text-sm text-slate-500 mt-1">
            {t("aiMgrOwnerOnlySub", "Members of the team cannot open the AI Sales Manager.", "টিমের সদস্যরা এআই সেলস ম্যানেজার খুলতে পারবেন না।")}
          </p>
        </div>
      )}

      {!notOwner && (
        <>
          {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}
          {loading ? (
            <p className="text-sm text-slate-500">{t("aiMgrLoading", "Loading…", "লোড হচ্ছে…")}</p>
          ) : (
            <div className="card p-4">
              <div ref={listRef} className="max-h-[55vh] overflow-y-auto space-y-3 pr-1">
                {messages.length === 0 && (
                  <p className="text-sm text-slate-500">
                    {t(
                      "aiMgrEmpty",
                      "No questions yet. Try one of the examples below — for example, how many orders came in today.",
                      "এখনো কোনো প্রশ্ন করা হয়নি। নিচের উদাহরণ থেকে একটা চাপুন — যেমন, আজ কতগুলো অর্ডার হয়েছে।"
                    )}
                  </p>
                )}
                {messages.map((m) => (
                  <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-[85%] whitespace-pre-wrap rounded-xl px-3 py-2 text-sm ${
                        m.role === "user" ? "bg-[#0051F6] text-white" : "bg-slate-100 text-slate-900"
                      }`}
                    >
                      {m.content}
                    </div>
                  </div>
                ))}
                {sending && (
                  <div className="flex justify-start">
                    <div className="rounded-xl bg-slate-100 px-3 py-2 text-sm text-slate-500">
                      {t("aiMgrThinking", "AI লিখছে…", "AI লিখছে…")}
                    </div>
                  </div>
                )}
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                {EXAMPLE_QUESTIONS.map((q) => (
                  <button
                    key={q}
                    onClick={() => send(q)}
                    disabled={sending}
                    className="rounded-full border border-[#D6E4FE] bg-white px-3 py-1.5 text-xs font-bold text-[#0051F6] hover:bg-[#EBF1FE] disabled:opacity-50"
                  >
                    {q}
                  </button>
                ))}
              </div>

              <form
                className="mt-3 flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  send(input);
                }}
              >
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={t("aiMgrPlaceholder", "আজকে কতগুলো অর্ডার হয়েছে?", "আজকে কতগুলো অর্ডার হয়েছে?")}
                  className="min-w-0 flex-1 rounded-lg border border-[#eeeeee] bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-[#0051F6]"
                />
                <button
                  type="submit"
                  disabled={sending || !input.trim()}
                  className="rounded-lg bg-[#0051F6] px-4 py-2 text-sm font-bold text-white hover:bg-[#003EC9] disabled:opacity-50"
                >
                  {t("aiMgrSend", "Send", "পাঠান")}
                </button>
              </form>
            </div>
          )}
        </>
      )}
    </div>
  );
}
