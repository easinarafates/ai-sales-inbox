"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  asArray,
  customersApi,
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

function convPicture(c: Conversation): string {
  const fromCustomer =
    (typeof c.customer === "object" && c.customer
      ? (c.customer.picture_url as string | undefined) || (c.customer.pictureUrl as string | undefined)
      : "") || "";
  return fromCustomer || c.customer_picture_url || c.customerPictureUrl || "";
}

/** Distinct initials-avatar colour per customer (name hash → palette), so
 *  customers stay recognisable even when Meta gives no photo. Meta does
 *  not return a photo for some senders (e.g. phone-registered accounts —
 *  see meta-profile.ts); the colour is only a fallback, never a photo. */
const AVATAR_COLORS = [
  "bg-rose-100 text-rose-700",
  "bg-amber-100 text-amber-700",
  "bg-emerald-100 text-emerald-700",
  "bg-sky-100 text-sky-700",
  "bg-violet-100 text-violet-700",
  "bg-orange-100 text-orange-700",
  "bg-teal-100 text-teal-700",
  "bg-indigo-100 text-indigo-700",
];

function avatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length] ?? AVATAR_COLORS[0] ?? "bg-slate-100 text-slate-700";
}

/** Customer avatar: real photo when Meta gave us one, coloured initials otherwise. */
function CustomerAvatar({ name, pictureUrl, sizeClass }: { name: string; pictureUrl?: string; sizeClass?: string }) {
  const cls = sizeClass ?? "h-10 w-10";
  if (pictureUrl) {
    return <img src={pictureUrl} alt={name} className={`${cls} shrink-0 rounded-full object-cover`} />;
  }
  return (
    <span className={`${cls} flex shrink-0 items-center justify-center rounded-full ${avatarColor(name)} font-bold`}>
      {name.trim().charAt(0) || "?"}
    </span>
  );
}

/** Source badge: which channel the chat came in on (the conversation's
 *  channel platform — never guessed). Shown next to the customer name
 *  in the list and in the thread header, like the competitor's inbox. */
const CHANNEL_BADGE: Record<string, { label: string; cls: string }> = {
  messenger: { label: "MESSENGER", cls: "bg-blue-100 text-blue-800" },
  instagram: { label: "INSTAGRAM", cls: "bg-pink-100 text-pink-800" },
  whatsapp: { label: "WHATSAPP", cls: "bg-green-100 text-green-800" },
  tiktok: { label: "TIKTOK", cls: "bg-slate-800 text-white" },
  webchat: { label: "WEBCHAT", cls: "bg-teal-100 text-teal-800" },
  facebook_comment: { label: "COMMENT", cls: "bg-sky-100 text-sky-800" },
};

function ChannelBadge({ conversation }: { conversation: Conversation }) {
  const raw = String(conversation.channel || conversation.channelType || conversation.channel_type || "messenger").toLowerCase();
  const badge = CHANNEL_BADGE[raw] ?? { label: raw.toUpperCase(), cls: "bg-slate-100 text-slate-700" };
  return <span className={`shrink-0 rounded px-2 py-0.5 text-[11px] font-bold tracking-wide ${badge.cls}`}>{badge.label}</span>;
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

  const refreshThread = useCallback(async () => {
    if (!selectedId) return;
    try {
      setSelected(await inboxApi.get(selectedId));
    } catch {
      /* keep current thread visible */
    }
  }, [selectedId]);

  // Auto-refresh: new customer messages and AI replies appear without a
  // manual reload. Polls the list + the open thread every 5s while the
  // tab is visible; pauses when the tab is hidden, and refreshes once
  // when it becomes visible again.
  useEffect(() => {
    if (!getToken()) return;
    const tick = () => {
      if (document.hidden) return;
      loadList();
      refreshThread();
    };
    const timer = setInterval(tick, 5000);
    const onVisible = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadList, refreshThread]);

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
  const ownerMarked = selected ? Boolean(selected.ownerMarked) : false;
  const unknownLabel = t("common.unknownCustomer", "Unknown customer", "অজানা কাস্টমার");

  // AI উত্তর ON/OFF switch (top of the open conversation). ON = mode
  // 'ai' (the AI auto-replies); OFF = mode 'human' (the owner replies
  // himself). Same mode the Messenger '.' command writes.
  const toggleAiMode = () => {
    if (!selectedId || aiMode === null) return;
    doAction(
      () => inboxApi.setMode(selectedId, aiMode ? "human" : "ai"),
      t("inbox.aiToggleFailed", "AI switch failed", "AI সুইচ ব্যর্থ"),
    );
  };

  const markOwner = () => {
    if (!selectedId) return;
    doAction(
      () => inboxApi.markOwner(selectedId),
      t("inbox.markOwnerFailed", "Marking owner failed", "মালিক চিহ্নিত করা ব্যর্থ"),
    );
  };

  const [nameDraft, setNameDraft] = useState("");
  const [nameSaving, setNameSaving] = useState(false);
  const customerIdForName = selected?.customer?.id;
  // The draft follows the open thread only — not the 5s auto-refresh —
  // so typing is never clobbered while the thread reloads.
  useEffect(() => {
    setNameDraft(selected?.customer?.name ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerIdForName]);
  // The name stays exactly as it is on Facebook unless the owner
  // corrects it here; a corrected name is flagged and the Meta refresh
  // never overwrites it. English stays English, Bengali stays Bengali —
  // never translated or transliterated.
  const saveName = async () => {
    const customerId = selected?.customer?.id;
    const trimmed = nameDraft.trim();
    if (!customerId || nameSaving || !trimmed || trimmed === (selected.customer?.name || "")) return;
    setNameSaving(true);
    setError("");
    try {
      await customersApi.updateName(customerId, trimmed);
      await refreshThread();
    } catch (err) {
      setError(`${t("inbox.nameFailed", "Saving the name failed", "নাম সংরক্ষণ ব্যর্থ")}: ${err instanceof Error ? err.message : ""}`);
    } finally {
      setNameSaving(false);
    }
  };

  const [genderSaving, setGenderSaving] = useState(false);
  const customerGender =
    selected?.customer?.gender === "male" || selected?.customer?.gender === "female"
      ? selected.customer.gender
      : "unknown";
  // Gender-aware addressing: the AI calls a male customer "স্যার" and a
  // female customer "ম্যাডাম" throughout its replies (unknown → neutral
  // "আপনি"). The owner can correct the inferred gender here; the stored
  // value drives all future replies, and the name inference never
  // overwrites a hand-set value.
  const changeGender = async (gender: "male" | "female" | "unknown") => {
    const customerId = selected?.customer?.id;
    if (!customerId || genderSaving) return;
    setGenderSaving(true);
    setError("");
    try {
      await customersApi.updateGender(customerId, gender);
      await refreshThread();
    } catch (err) {
      setError(`${t("inbox.genderFailed", "Saving gender failed", "লিঙ্গ সংরক্ষণ ব্যর্থ")}: ${err instanceof Error ? err.message : ""}`);
    } finally {
      setGenderSaving(false);
    }
  };

  return (
    <div>
      <h1 className="page-title">{t("inbox.title", "Inbox", "ইনবক্স")}</h1>
      <p className="page-subtitle">{t("inbox.subtitle", "All your customer chats in one place.", "সব কাস্টমারের চ্যাট এক জায়গায়।")}</p>

      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}

      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-3">
        <div className="flex-1">
          <label htmlFor="inbox-search" className="mb-1 block text-sm font-medium text-slate-700">{t("inbox.searchLabel", "Search chats", "চ্যাট খুঁজুন")}</label>
          <input
            id="inbox-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("inbox.searchPlaceholder", "Search — name, phone, order number, chat words…", "খুঁজুন — নাম, ফোন, অর্ডার নম্বর, চ্যাটের শব্দ…")}
            className="w-full"
          />
        </div>
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
            <div className="empty-state m-4">
              <p>{t("inbox.noChats", "No chats found.", "কোনো চ্যাট পাওয়া যায়নি।")}</p>
              <p className="mt-1 text-xs">{t("inbox.noChatsHint", "No chats yet — connect your Facebook Page from Channels (or finish the Setup wizard) and new customer messages will appear here.", "এখনো কোনো চ্যাট নেই — Channels থেকে ফেসবুক পেজ যুক্ত করুন (বা Setup উইজার্ড শেষ করুন), তাহলে কাস্টমারের নতুন মেসেজ এখানে আসবে।")}</p>
            </div>
          )}
          {conversations.map((c) => (
            <button
              key={c.id}
              onClick={() => openThread(c.id)}
              className={`flex w-full gap-3 p-4 text-left transition-colors hover:bg-orange-50 ${selectedId === c.id ? "bg-orange-50 ring-1 ring-inset ring-orange-200" : ""}`}
            >
              <CustomerAvatar name={convName(c, unknownLabel)} pictureUrl={convPicture(c)} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium">{convName(c, unknownLabel)}</span>
                    <ChannelBadge conversation={c} />
                  </span>
                  <span className="shrink-0 text-xs text-slate-400">{fmtDate(c.updatedAt || c.updated_at || c.lastMessageAt || c.last_message_at)}</span>
                </span>
                <span className="block truncate text-sm text-slate-500">{c.lastMessage || c.last_message || ""}</span>
                {c.status && (
                  <span className="mt-1 flex gap-2">
                    <span className="rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-800">{c.status}</span>
                  </span>
                )}
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
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="font-bold text-lg">{selected.customer?.name || convName(selected.conversation, unknownLabel)}</h2>
                        <ChannelBadge conversation={selected.conversation} />
                      </div>
                      {selected.customer?.phone && (
                        <p className="text-sm text-slate-500">{selected.customer.phone}</p>
                      )}
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
                        <span className="text-slate-500">{t("inbox.addressAs", "Address as", "সম্বোধন")}:</span>
                        <span className="font-medium">
                          {customerGender === "male"
                            ? t("inbox.genderMaleShort", "Sir", "স্যার")
                            : customerGender === "female"
                              ? t("inbox.genderFemaleShort", "Madam", "ম্যাডাম")
                              : t("inbox.genderUnknownShort", "Unknown", "জানা নেই")}
                        </span>
                        <select
                          value={customerGender}
                          disabled={genderSaving}
                          onChange={(e) => changeGender(e.target.value as "male" | "female" | "unknown")}
                          aria-label={t("inbox.genderChange", "Change how the AI addresses this customer", "AI এই কাস্টমারকে কী বলে ডাকবে তা বদলান")}
                          className="border rounded-lg px-2 py-1 text-sm"
                        >
                          <option value="male">{t("inbox.genderMale", "Sir (male)", "স্যার (ছেলে)")}</option>
                          <option value="female">{t("inbox.genderFemale", "Madam (female)", "ম্যাডাম (মেয়ে)")}</option>
                          <option value="unknown">{t("inbox.genderUnknown", "Unknown", "জানা নেই")}</option>
                        </select>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
                        <span className="text-slate-500">{t("inbox.nameLabel", "Name", "নাম")}:</span>
                        <input
                          value={nameDraft}
                          onChange={(e) => setNameDraft(e.target.value)}
                          aria-label={t("inbox.nameEdit", "Edit the customer's name", "কাস্টমারের নাম ঠিক করুন")}
                          className="border rounded-lg px-2 py-1 text-sm w-44"
                        />
                        <button
                          onClick={saveName}
                          disabled={nameSaving || !nameDraft.trim() || nameDraft.trim() === (selected.customer?.name || "")}
                          className="rounded-lg bg-teal-600 px-3 py-1 text-sm text-white transition hover:bg-teal-700 disabled:opacity-50"
                        >
                          {nameSaving ? t("inbox.saving", "Saving…", "সংরক্ষণ হচ্ছে…") : t("inbox.save", "Save", "সংরক্ষণ")}
                        </button>
                        {selected.customer?.name_manually_set && (
                          <span className="text-xs text-teal-700">
                            {t("inbox.nameManual", "Set by hand — Facebook won't overwrite it", "হাতে ঠিক করা — ফেসবুক আর বদলাতে পারবে না")}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{t("inbox.aiReply", "AI reply", "AI উত্তর")}</span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={aiMode === true}
                      disabled={aiMode === null}
                      onClick={toggleAiMode}
                      title={t("inbox.aiToggleTitle", "ON: the AI auto-replies. OFF: you reply yourself. Messenger '.' does the same.", "চালু: AI নিজে উত্তর দেবে। বন্ধ: আপনি নিজে উত্তর দেবেন। Messenger-এ '.' লিখলেও একই কাজ হবে।")}
                      className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50 ${aiMode ? "bg-teal-600" : "bg-slate-300"}`}
                    >
                      <span
                        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${aiMode ? "left-[22px]" : "left-0.5"}`}
                      />
                    </button>
                    <span className={`text-xs font-medium ${aiMode ? "text-teal-700" : aiMode === false ? "text-amber-700" : "text-slate-500"}`}>
                      {aiMode === true
                        ? t("inbox.aiModeOnShort", "On — AI is replying", "চালু — AI উত্তর দিচ্ছে")
                        : aiMode === false
                          ? t("inbox.aiModeOffShort", "Off — you reply", "বন্ধ — আপনি উত্তর দিচ্ছেন")
                          : t("inbox.aiModeUnknown", "AI mode: unknown", "AI মোড: অজানা")}
                    </span>
                  </div>
                </div>
                <p className="pt-2 text-xs text-slate-500">
                  {t(
                    "inbox.dotHint",
                    "Type '.' in Messenger to turn the AI on/off — page owner only. The switch or '.' cancels a timed handover.",
                    "Messenger-এ '.' লিখলে AI চালু/বন্ধ হয় — শুধু পেজের মালিকের জন্য। সুইচ বা '.' চাপলে টাইমার হ্যান্ডওভার বাতিল হয়ে যায়।",
                  )}
                </p>

                <div className="space-y-3 overflow-y-auto py-4 max-h-[420px] scroll-smooth">
                  {selected.messages.length === 0 && <p className="text-sm text-slate-500">{t("inbox.noMessages", "No messages yet.", "এখনো কোনো মেসেজ নেই।")}</p>}
                  {selected.messages.map((m) => {
                    const sender = msgSender(m).toLowerCase();
                    const isMe = sender.includes("agent") || sender.includes("business") || sender.includes("owner") || sender.includes("shop") || sender.includes("admin") || sender === "me";
                    const isAi = sender.includes("ai");
                    return (
                      <div key={m.id} className={`flex items-end gap-2 ${isMe || isAi ? "justify-end" : "justify-start"}`}>
                        {!isMe && !isAi && (
                          <CustomerAvatar
                            name={selected.customer?.name || convName(selected.conversation, unknownLabel)}
                            pictureUrl={selected.customer?.picture_url || selected.customer?.pictureUrl || convPicture(selected.conversation)}
                            sizeClass="h-8 w-8"
                          />
                        )}
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
                {/* Owner marking for Messenger dot commands: only the
                    sender marked here may toggle the AI with '.' / '.on' /
                    '.off' from a personal account. A random customer
                    typing '.' is ignored silently. */}
                {ownerMarked ? (
                  <p className="mt-2 rounded-lg bg-teal-50 px-3 py-2 text-sm text-teal-800">
                    ✓ {t("inbox.ownerMarked", "Marked as the page owner — '.' in Messenger toggles the AI for this chat.", "পেজের মালিক হিসেবে চিহ্নিত — Messenger-এ '.' লিখলে এই চ্যাটের AI চালু/বন্ধ হবে।")}
                  </p>
                ) : (
                  <button
                    onClick={markOwner}
                    className="mt-2 rounded-lg bg-slate-100 px-3 py-2 text-sm transition hover:bg-slate-200"
                  >
                    {t("inbox.markOwner", "This customer is me (the page owner)", "এই কাস্টমারটিই আমি (পেজের মালিক)")}
                  </button>
                )}

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
