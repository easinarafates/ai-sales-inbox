"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  asArray,
  getToken,
  inboxApi,
  orderTotalPaisa,
  type Conversation,
  type ConversationDetail,
  type Message,
} from "@/lib/api";
import { useI18n } from "@/lib/i18n";

function convName(c: Conversation, unknownLabel: string): string {
  return (
    c.customer?.name ||
    c.customerName ||
    c.customer_name ||
    (typeof c.customer === "string" ? c.customer : "") ||
    unknownLabel
  );
}

function convChannel(c: Conversation): string {
  return c.channel || c.channelType || c.channel_type || "Messenger";
}

function convPicture(c: Conversation): string {
  const fromCustomer =
    (typeof c.customer === "object" && c.customer
      ? (c.customer.picture_url as string | undefined) || (c.customer.pictureUrl as string | undefined)
      : "") || "";
  return fromCustomer || c.customer_picture_url || c.customerPictureUrl || "";
}

/** Customer avatar: real photo when Meta gave us one, initials otherwise. */
function CustomerAvatar({ name, pictureUrl, sizeClass }: { name: string; pictureUrl?: string; sizeClass?: string }) {
  const cls = sizeClass ?? "h-10 w-10";
  if (pictureUrl) {
    return <img src={pictureUrl} alt={name} className={`${cls} shrink-0 rounded-full object-cover`} />;
  }
  return (
    <span className={`${cls} flex shrink-0 items-center justify-center rounded-full bg-brand/10 font-bold text-brand-dark`}>
      {name.trim().charAt(0) || "?"}
    </span>
  );
}

function msgText(m: Message): string {
  return m.body || m.text || m.content || "";
}

function msgSender(m: Message): string {
  // Backend sends direction: 'in' (customer) | 'out' (shop / AI).
  if (m.direction === "out") {
    // Demo-AI replies are labelled in their text; show them as AI.
    if ((m.body || m.text || "").startsWith("[ডেমো AI")) return "ai";
    return "agent";
  }
  if (m.direction === "in") return "customer";
  return (m.senderType || m.sender_type || m.sender || m.role || "customer") as string;
}

function aiModeOf(c: Conversation): boolean | null {
  if (typeof c.mode === "string") return c.mode === "ai";
  if (typeof c.aiMode === "boolean") return c.aiMode;
  if (typeof c.ai_mode === "boolean") return c.ai_mode;
  if (typeof c.isAiHandled === "boolean") return c.isAiHandled;
  return null;
}

export default function InboxPage() {
  const router = useRouter();
  const { t, fmtDate, fmtTaka } = useI18n();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<ConversationDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [reply, setReply] = useState("");
  const [assignUserId, setAssignUserId] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);

  const loadList = useCallback(async () => {
    try {
      const data = await inboxApi.list({ q: q || undefined, status: status || undefined });
      setConversations(asArray(data));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("inbox.loadFailed", "Could not load the inbox.", "ইনবক্স লোড করা যায়নি।"));
    } finally {
      setLoading(false);
    }
  }, [q, status, t]);

  useEffect(() => {
    if (!getToken()) {
      router.push("/login");
      return;
    }
    loadList();
  }, [loadList, router]);

  const openThread = async (id: string) => {
    setSelectedId(id);
    setError("");
    try {
      const detail = await inboxApi.get(id);
      setSelected(detail);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("inbox.openFailed", "Could not open the chat.", "চ্যাট খোলা যায়নি।"));
    }
  };

  const refreshThread = async () => {
    if (!selectedId) return;
    try {
      setSelected(await inboxApi.get(selectedId));
    } catch {
      /* keep current thread visible */
    }
  };

  const sendReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedId || !reply.trim()) return;
    setSending(true);
    setError("");
    try {
      await inboxApi.reply(selectedId, reply.trim());
      setReply("");
      await refreshThread();
      await loadList();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("inbox.replyFailed", "Could not send the reply.", "রিপ্লাই পাঠানো যায়নি।"));
    } finally {
      setSending(false);
    }
  };

  const doAction = async (fn: () => Promise<unknown>, label: string) => {
    if (!selectedId) return;
    setError("");
    try {
      await fn();
      await refreshThread();
      await loadList();
    } catch (err) {
      setError(`${label}: ${err instanceof Error ? err.message : ""}`);
    }
  };

  const aiMode = selected ? aiModeOf(selected.conversation) : null;
  const unknownLabel = t("common.unknownCustomer", "Unknown customer", "অজানা কাস্টমার");

  return (
    <div>
      <h1 className="page-title">{t("inbox.title", "Inbox", "ইনবক্স")}</h1>
      <p className="page-subtitle">{t("inbox.subtitle", "All your customer chats in one place.", "সব কাস্টমারের চ্যাট এক জায়গায়।")}</p>

      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}

      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("inbox.searchPlaceholder", "Search — name, phone, order number, chat words…", "খুঁজুন — নাম, ফোন, অর্ডার নম্বর, চ্যাটের শব্দ…")}
          className="flex-1"
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="sm:w-44">
          <option value="">{t("common.allStatus", "All statuses", "সব স্ট্যাটাস")}</option>
          <option value="open">{t("inbox.statusOpen", "Open", "খোলা")}</option>
          <option value="done">{t("inbox.statusDone", "Done", "সম্পন্ন")}</option>
          <option value="snoozed">{t("inbox.statusSnoozed", "Snoozed", "স্নুজ করা")}</option>
        </select>
        <button onClick={loadList} className="shrink-0 rounded-lg bg-teal-600 px-4 py-2 text-white shadow-sm transition hover:bg-teal-700">{t("common.search", "Search", "খুঁজুন")}</button>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Conversation list */}
        <div className="divide-y rounded-xl border border-orange-100/70 bg-white shadow">
          {loading && (
            <div className="space-y-3 p-4">
              <div className="skeleton h-12" />
              <div className="skeleton h-12" />
              <div className="skeleton h-12" />
            </div>
          )}
          {!loading && conversations.length === 0 && (
            <div className="empty-state m-4">{t("inbox.noChats", "No chats found.", "কোনো চ্যাট পাওয়া যায়নি।")}</div>
          )}
          {conversations.map((c) => (
            <button
              key={c.id}
              onClick={() => openThread(c.id)}
              className={`flex w-full gap-3 p-4 text-left transition-colors hover:bg-orange-50 ${selectedId === c.id ? "bg-orange-50 ring-1 ring-inset ring-orange-200" : ""}`}
            >
              <CustomerAvatar name={convName(c, unknownLabel)} pictureUrl={convPicture(c)} />
              <span className="min-w-0 flex-1">
                <span className="flex justify-between gap-2">
                  <span className="truncate font-medium">{convName(c, unknownLabel)}</span>
                  <span className="shrink-0 text-xs text-slate-400">{fmtDate(c.updatedAt || c.updated_at || c.lastMessageAt || c.last_message_at)}</span>
                </span>
                <span className="block truncate text-sm text-slate-500">{c.lastMessage || c.last_message || ""}</span>
                <span className="mt-1 flex gap-2">
                  <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">{convChannel(c)}</span>
                  {c.status && <span className="rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-800">{c.status}</span>}
                </span>
              </span>
            </button>
          ))}
        </div>

        {/* Thread + customer panel */}
        <div className="lg:col-span-2 space-y-4">
          {!selected && (
            <div className="empty-state p-10">
              {t("inbox.pickChat", "Pick a chat from the left.", "বাম দিক থেকে একটি চ্যাট বেছে নিন।")}
            </div>
          )}
          {selected && (
            <>
              <div className="card p-4">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
                  <div className="flex items-center gap-3">
                    <CustomerAvatar
                      name={selected.customer?.name || convName(selected.conversation, unknownLabel)}
                      pictureUrl={
                        selected.customer?.picture_url || selected.customer?.pictureUrl || convPicture(selected.conversation)
                      }
                      sizeClass="h-12 w-12"
                    />
                    <div>
                      <h2 className="font-bold text-lg">{selected.customer?.name || convName(selected.conversation, unknownLabel)}</h2>
                      <p className="text-sm text-slate-500">
                        {convChannel(selected.conversation)}
                        {selected.customer?.phone ? ` • ${selected.customer.phone}` : ""}
                      </p>
                    </div>
                  </div>
                  <span
                    className={`text-xs font-medium px-3 py-1 rounded-full ${
                      aiMode ? "bg-teal-100 text-teal-800" : aiMode === false ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-600"
                    }`}
                  >
                    {aiMode === true ? t("inbox.aiModeOn", "🤖 AI mode — AI is replying", "🤖 AI মোড — AI উত্তর দিচ্ছে") : aiMode === false ? t("inbox.aiModeOff", "🧑 Human handling — AI is off", "🧑 মানুষ নিচ্ছে — AI বন্ধ") : t("inbox.aiModeUnknown", "AI mode: unknown", "AI মোড: অজানা")}
                  </span>
                </div>

                <div className="space-y-3 overflow-y-auto py-4 max-h-[420px] scroll-smooth">
                  {selected.messages.length === 0 && <p className="text-sm text-slate-500">{t("inbox.noMessages", "No messages yet.", "এখনো কোনো মেসেজ নেই।")}</p>}
                  {selected.messages.map((m) => {
                    const sender = msgSender(m).toLowerCase();
                    const isMe = sender.includes("agent") || sender.includes("business") || sender.includes("owner") || sender.includes("shop") || sender.includes("admin") || sender === "me";
                    const isAi = sender.includes("ai");
                    return (
                      <div key={m.id} className={`flex ${isMe || isAi ? "justify-end" : "justify-start"}`}>
                        <div className={`max-w-[75%] rounded-xl px-3 py-2 text-sm shadow-sm ${isMe ? "bg-brand text-white" : isAi ? "bg-violet-100 text-violet-900" : "bg-slate-100"}`}>
                          <p>{msgText(m)}</p>
                          <p className={`text-[11px] mt-1 ${isMe ? "text-orange-100" : "text-slate-400"}`}>
                            {isAi ? t("inbox.ai", "AI", "AI") : isMe ? t("inbox.you", "You", "আপনি") : t("inbox.customer", "Customer", "কাস্টমার")} • {fmtDate(m.createdAt || m.created_at)}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <form onSubmit={sendReply} className="flex gap-2 pt-3 border-t">
                  <input
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    placeholder={t("inbox.replyPlaceholder", "Write a reply…", "উত্তর লিখুন…")}
                    className="flex-1 border rounded-lg px-3 py-2"
                  />
                  <button disabled={sending} className="bg-brand text-white px-4 py-2 rounded-lg hover:bg-brand-dark disabled:opacity-50">
                    {sending ? t("inbox.sending", "Sending…", "পাঠানো হচ্ছে…") : t("inbox.send", "Send", "পাঠান")}
                  </button>
                </form>

                <div className="flex flex-wrap gap-2 mt-3">
                  <div className="flex gap-2">
                    <input
                      value={assignUserId}
                      onChange={(e) => setAssignUserId(e.target.value)}
                      placeholder={t("inbox.assignPlaceholder", "Team member's User ID", "টিম সদস্যের User ID")}
                      className="border rounded-lg px-3 py-2 text-sm w-44"
                    />
                    <button
                      onClick={() => assignUserId.trim() && doAction(() => inboxApi.assign(selectedId!, assignUserId.trim()), t("inbox.assignFailed", "Assign failed", "অ্যাসাইন ব্যর্থ"))}
                      className="bg-teal-600 text-white px-3 py-2 rounded-lg text-sm hover:bg-teal-700"
                    >
                      {t("inbox.assign", "Assign", "অ্যাসাইন")}
                    </button>
                  </div>
                  <button onClick={() => doAction(() => inboxApi.done(selectedId!), t("inbox.markDoneFailed", "Marking done failed", "সম্পন্ন করা ব্যর্থ"))} className="rounded-lg bg-blue-600 px-3 py-2 text-sm text-white transition hover:bg-blue-700">
                    {t("inbox.markDone", "Done", "সম্পন্ন")}
                  </button>
                  <button
                    onClick={() => doAction(() => inboxApi.dot(selectedId!), t("inbox.dotFailed", "Dot (.) failed", "ডট (.) ব্যর্থ"))}
                    className="rounded-lg bg-amber-500 px-3 py-2 text-sm text-white transition hover:bg-amber-600"
                    title={t("inbox.dotTitle", "When the owner sends '.', AI stops and a human takes over; sending '.' again returns to AI", "মালিক '.' পাঠালে AI থামবে ও মানুষ নেবে; আবার '.' পাঠালে AI-তে ফিরবে")}
                  >
                    {t("inbox.dot", "Dot (.)", "ডট (.)")} — {aiMode === false ? t("inbox.dotReturnToAi", "Back to AI", "AI-তে ফেরত") : t("inbox.dotHumanTakeover", "Human takes over", "মানুষ নেবে")}
                  </button>
                </div>
              </div>

              {/* Customer profile + open orders */}
              <div className="card p-4">
                <h3 className="font-bold mb-2">{t("inbox.profile", "Customer profile", "কাস্টমার প্রোফাইল")}</h3>
                <div className="mb-2 flex items-center gap-3">
                  <CustomerAvatar
                    name={selected.customer?.name || unknownLabel}
                    pictureUrl={selected.customer?.picture_url || selected.customer?.pictureUrl}
                    sizeClass="h-14 w-14"
                  />
                  <p className="font-medium">{selected.customer?.name || "—"}</p>
                </div>
                <p className="text-sm"><span className="text-slate-500">{t("common.name", "Name", "নাম")}:</span> {selected.customer?.name || "—"}</p>
                <p className="text-sm"><span className="text-slate-500">{t("common.phone", "Phone", "ফোন")}:</span> {selected.customer?.phone || "—"}</p>
                <p className="text-sm"><span className="text-slate-500">{t("common.address", "Address", "ঠিকানা")}:</span> {selected.customer?.address || "—"}</p>

                <h4 className="font-bold mt-4 mb-2 text-sm">{t("inbox.openOrders", "Open orders", "খোলা অর্ডার")}</h4>
                {(!selected.openOrders || selected.openOrders.length === 0) && (
                  <p className="text-sm text-slate-500">{t("inbox.noOpenOrders", "No open orders.", "কোনো খোলা অর্ডার নেই।")}</p>
                )}
                {(selected.openOrders || []).map((o) => (
                  <div key={o.id} className="text-sm border rounded-lg p-2 mb-2 flex justify-between">
                    <span>{o.orderNumber || o.order_number || o.id} • {o.status || "—"}</span>
                    <span className="font-medium">{fmtTaka(orderTotalPaisa(o))}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
