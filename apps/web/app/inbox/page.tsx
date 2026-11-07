"use client";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
import Icon, { type IconName } from "@/components/Icon";

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
  "bg-green-100 text-green-700",
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
  webchat: { label: "WEBCHAT", cls: "bg-green-100 text-green-800" },
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

/**
 * Conversation status mapping (backend values → spec labels). The API
 * stores open / done / snoozed / waiting; the design calls them Open /
 * Closed / Pending / Waiting. Pending = snoozed (waiting for attention),
 * Closed = done. Waiting is its own status: the AI escalated the chat
 * (angry customer / off-topic question / couldn't answer) and a human
 * must take over.
 */
function statusOf(c: Conversation): "open" | "pending" | "closed" | "waiting" {
  const s = String(c.status || "").toLowerCase();
  if (s === "done" || s === "closed") return "closed";
  if (s === "waiting") return "waiting";
  if (s === "snoozed" || s === "pending") return "pending";
  return "open";
}

/** Why a conversation is waiting — shown as a badge in the list + thread. */
function waitingReason(c: Conversation): { en: string; bn: string } | null {
  if (statusOf(c) !== "waiting") return null;
  const r = String((c as { escalation_reason?: unknown }).escalation_reason || "");
  if (r === "angry_customer") return { en: "Customer is angry", bn: "কাস্টমার রেগে গেছেন" };
  if (r === "cant_answer") return { en: "AI couldn't answer", bn: "AI উত্তর দিতে পারেনি" };
  if (r === "ai_unsure") return { en: "AI wasn't sure how to answer", bn: "AI উত্তর বুঝতে পারেনি" };
  if (r === "off_topic") return { en: "Off-topic question", bn: "বিষয়ের বাইরে" };
  return { en: "Needs a human", bn: "মানুষের উত্তর দরকার" };
}

function StatCard({
  icon,
  iconCls,
  value,
  label,
}: {
  icon: IconName;
  iconCls: string;
  value: number;
  label: string;
}) {
  return (
    <div className="card flex items-center gap-3 p-4">
      <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${iconCls}`}>
        <Icon name={icon} className="h-6 w-6" />
      </span>
      <span className="min-w-0">
        <span className="block text-2xl font-bold leading-none text-slate-900">{value}</span>
        <span className="mt-1 block truncate text-sm text-slate-500">{label}</span>
      </span>
    </div>
  );
}

function InboxPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
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
  const [compact, setCompact] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Real stat counts, computed from the full unfiltered list (never from
  // the search-filtered list, so searching never changes the cards).
  const [stats, setStats] = useState({ total: 0, open: 0, pending: 0, closed: 0, waiting: 0 });

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

  const loadStats = useCallback(async () => {
    try {
      const all = asArray(await inboxApi.list());
      const counts = { total: all.length, open: 0, pending: 0, closed: 0, waiting: 0 };
      for (const c of all) counts[statusOf(c)] += 1;
      setStats(counts);
    } catch {
      /* stats stay at their last good values; the list error surfaces */
    }
  }, []);

  useEffect(() => {
    if (!getToken()) {
      router.push("/login");
      return;
    }
    loadList();
    loadStats();
  }, [loadList, loadStats, router]);

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

  // Deep link from an order ("View chat in Inbox"): /inbox?conversation=<id>
  // opens that thread directly. Guarded so it runs once per link, not on
  // every render (openThread is re-created each render).
  const openedParamRef = useRef<string | null>(null);
  const conversationParam = searchParams.get("conversation");
  useEffect(() => {
    if (conversationParam && openedParamRef.current !== conversationParam) {
      openedParamRef.current = conversationParam;
      void openThread(conversationParam);
    }
  }, [conversationParam, openThread]);

  const refreshThread = useCallback(async () => {
    if (!selectedId) return;
    try {
      setSelected(await inboxApi.get(selectedId));
    } catch {
      /* keep current thread visible */
    }
  }, [selectedId]);

  // Auto-refresh: new customer messages and AI replies appear without a
  // manual reload. Polls the list + stats + the open thread every 5s
  // while the tab is visible; pauses when the tab is hidden, and
  // refreshes once when it becomes visible again.
  useEffect(() => {
    if (!getToken()) return;
    const tick = () => {
      if (document.hidden) return;
      loadList();
      loadStats();
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
  }, [loadList, loadStats, refreshThread]);

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

  // Status tabs (spec): All / Open / Pending / Closed / Waiting. They
  // drive the same status filter the search dropdown uses. Waiting is
  // the auto-escalation tab — angry customers, off-topic questions, and
  // questions the AI could not answer land here for a human. Its
  // Bengali label is deliberately NOT "অপেক্ষমাণ" (that is Pending) —
  // it is "মানুষের অপেক্ষায়" (waiting for a human).
  const activeTab = status === "" ? "all" : status === "open" ? "open" : status === "snoozed" ? "pending" : status === "waiting" ? "waiting" : "closed";
  const setTab = (tab: "all" | "open" | "pending" | "closed" | "waiting") => {
    setStatus(tab === "all" ? "" : tab === "open" ? "open" : tab === "pending" ? "snoozed" : tab === "waiting" ? "waiting" : "done");
  };
  const TABS: { id: "all" | "open" | "pending" | "closed" | "waiting"; labelEn: string; labelBn: string; count: number }[] = [
    { id: "all", labelEn: "All", labelBn: "সব", count: stats.total },
    { id: "open", labelEn: "Open", labelBn: "খোলা", count: stats.open },
    { id: "pending", labelEn: "Pending", labelBn: "অপেক্ষমাণ", count: stats.pending },
    { id: "closed", labelEn: "Closed", labelBn: "বন্ধ", count: stats.closed },
    { id: "waiting", labelEn: "Waiting", labelBn: "মানুষের অপেক্ষায়", count: stats.waiting },
  ];

  return (
    <div>
      {/* Welcome banner — light orange, like the reference. */}
      <div className="relative mb-4 overflow-hidden rounded-xl bg-orange-50 px-5 py-5 sm:px-6">
        <div className="relative flex items-start gap-4">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-brand text-white shadow-sm">
            <Icon name="inbox" className="h-6 w-6" />
          </span>
          <span className="min-w-0">
            <span className="block text-xl font-bold text-slate-900">
              {t("inbox.bannerTitle", "Customer Inbox", "কাস্টমার ইনবক্স")}
            </span>
            <span className="mt-0.5 block text-sm text-slate-600">
              {t("inbox.bannerSubtitle", "All your customer chats, comments and reviews in one place with AI support.", "তোমার সব কাস্টমার চ্যাট, কমেন্ট আর রিভিউ এক জায়গায় — AI সাপোর্টসহ।")}
            </span>
          </span>
        </div>
        {/* Envelope illustration (inline SVG, no external image). */}
        <svg viewBox="0 0 140 100" className="pointer-events-none absolute -right-2 -top-1 hidden h-24 w-32 text-[#FFD9C7] sm:block" aria-hidden="true">
          <rect x="10" y="22" width="120" height="72" rx="10" fill="currentColor" />
          <path d="M14 30 L70 66 L126 30" fill="none" stroke="#FFB59F" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      {/* Four stat cards — real counts from the API. */}
      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon="inbox" iconCls="bg-green-100 text-green-600" value={stats.total} label={t("inbox.statTotal", "Total Conversations", "মোট কথোপকথন")} />
        <StatCard icon="comments" iconCls="bg-violet-100 text-violet-600" value={stats.open} label={t("inbox.statOpen", "Open", "খোলা")} />
        <StatCard icon="clock" iconCls="bg-orange-100 text-brand" value={stats.pending} label={t("inbox.statPending", "Pending", "অপেক্ষমাণ")} />
        <StatCard icon="checkCircle" iconCls="bg-green-100 text-green-600" value={stats.closed} label={t("inbox.statClosed", "Closed", "বন্ধ")} />
      </div>

      {error && <p className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      {/* Search section — white card, green Search button. */}
      <div className="card mb-4 p-4">
        <p className="mb-3 text-sm font-bold text-slate-900">{t("inbox.searchLabel", "Search chats", "চ্যাট খুঁজুন")}</p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
              <Icon name="search" className="h-4 w-4" />
            </span>
            <input
              ref={searchInputRef}
              id="inbox-search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("inbox.searchPlaceholder", "Search by name, phone, order number, or message...", "নাম, ফোন, অর্ডার নম্বর বা মেসেজ দিয়ে খুঁজুন…")}
              className="w-full pl-9"
            />
          </div>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="sm:w-44" aria-label={t("inbox.statusFilter", "Filter by status", "স্ট্যাটাস দিয়ে ফিল্টার")}>
            <option value="">{t("common.allStatus", "All Statuses", "সব স্ট্যাটাস")}</option>
            <option value="open">{t("inbox.statusOpen", "Open", "খোলা")}</option>
            <option value="snoozed">{t("inbox.statusPending", "Pending", "অপেক্ষমাণ")}</option>
            <option value="done">{t("inbox.statusDone", "Closed", "বন্ধ")}</option>
            <option value="waiting">{t("inbox.statusWaiting", "Waiting", "মানুষের অপেক্ষায়")}</option>
          </select>
          <button onClick={loadList} className="btn-green shrink-0">{t("common.search", "Search", "খুঁজুন")}</button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Conversation list */}
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between gap-2 border-b border-[#eeeeee] px-4 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="text-base font-bold text-slate-900">{t("inbox.conversations", "Conversations", "কথোপকথন")}</h2>
              {stats.open > 0 && (
                <span className="shrink-0 rounded-full bg-orange-50 px-2 py-0.5 text-xs font-bold text-brand">
                  {stats.open} {t("inbox.newBadge", "New", "নতুন")}
                </span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                onClick={() => searchInputRef.current?.focus()}
                aria-label={t("inbox.filter", "Filter conversations", "কথোপকথন ফিল্টার করুন")}
                title={t("inbox.filter", "Filter conversations", "কথোপকথন ফিল্টার করুন")}
                className="rounded-lg p-2 text-slate-500 transition-colors hover:bg-orange-50 hover:text-slate-900"
              >
                <Icon name="filter" className="h-4 w-4" />
              </button>
              <button
                onClick={() => setCompact(!compact)}
                aria-label={t("inbox.toggleDensity", "Toggle compact list", "কমপ্যাক্ট তালিকা চালু/বন্ধ")}
                title={t("inbox.toggleDensity", "Toggle compact list", "কমপ্যাক্ট তালিকা চালু/বন্ধ")}
                aria-pressed={compact}
                className={`rounded-lg p-2 transition-colors hover:bg-orange-50 hover:text-slate-900 ${compact ? "bg-orange-50 text-brand" : "text-slate-500"}`}
              >
                <Icon name="list" className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Status tabs with real counts. */}
          <div className="flex flex-wrap gap-1 border-b border-[#eeeeee] px-3 py-2">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setTab(tab.id)}
                aria-pressed={activeTab === tab.id}
                className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                  activeTab === tab.id ? "bg-orange-50 text-brand" : "text-slate-500 hover:bg-slate-50 hover:text-slate-800"
                }`}
              >
                {t(`inbox.tab${tab.id}`, tab.labelEn, tab.labelBn)} ({tab.count})
              </button>
            ))}
          </div>

          <div className="divide-y divide-[#eeeeee]">
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
                className={`flex w-full gap-3 text-left transition-colors hover:bg-orange-50 ${compact ? "p-2.5" : "p-4"} ${selectedId === c.id ? "bg-orange-50 ring-1 ring-inset ring-orange-200" : ""}`}
              >
                <CustomerAvatar name={convName(c, unknownLabel)} pictureUrl={convPicture(c)} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-medium text-slate-900">{convName(c, unknownLabel)}</span>
                      <ChannelBadge conversation={c} />
                    </span>
                    <span className="shrink-0 text-xs text-slate-400">{fmtDate(c.updatedAt || c.updated_at || c.lastMessageAt || c.last_message_at)}</span>
                  </span>
                  <span className="block truncate text-sm text-slate-500">{c.lastMessage || c.last_message || ""}</span>
                  {(() => {
                    const reason = waitingReason(c);
                    if (!reason) return null;
                    return (
                      <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-800">
                        {t("inbox.waitingBadge", "Needs a human", "মানুষের উত্তর দরকার")} — {t("inbox.waitingReason", reason.en, reason.bn)}
                      </span>
                    );
                  })()}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Thread + customer panel */}
        <div className="space-y-4 lg:col-span-2">
          {!selected && (
            <div className="card flex min-h-[480px] flex-col items-center justify-center p-10 text-center">
              {/* Chat illustration (inline SVG, no external image). */}
              <svg viewBox="0 0 220 130" className="mb-4 h-28 w-44" aria-hidden="true">
                <rect x="118" y="18" width="88" height="58" rx="16" fill="#FFE3D6" />
                <circle cx="142" cy="47" r="5" fill="#fff" />
                <circle cx="162" cy="47" r="5" fill="#fff" />
                <circle cx="182" cy="47" r="5" fill="#fff" />
                <path d="M118 62 L104 76 L128 76 Z" fill="#FFE3D6" />
                <rect x="14" y="38" width="100" height="64" rx="16" fill="#FF5B2E" />
                <circle cx="42" cy="70" r="6" fill="#fff" />
                <circle cx="64" cy="70" r="6" fill="#fff" />
                <circle cx="86" cy="70" r="6" fill="#fff" />
                <path d="M40 102 L28 116 L52 116 Z" fill="#FF5B2E" />
                <path d="M196 8 l10 -6 M206 18 l12 -2" stroke="#FF5B2E" strokeWidth="3" strokeLinecap="round" />
              </svg>
              <h2 className="text-xl font-bold text-slate-900">
                {t("inbox.selectConversation", "Select a conversation", "একটি কথোপকথন বেছে নিন")}
              </h2>
              <p className="mt-2 max-w-sm text-sm text-slate-500">
                {t("inbox.selectConversationHint", "Choose a chat from the left to view messages, reply and manage the conversation.", "বাম দিক থেকে একটি চ্যাট বেছে নিন — মেসেজ দেখুন, উত্তর দিন আর কথোপকথন পরিচালনা করুন।")}
              </p>
            </div>
          )}
          {selected && (
            <>
              <div className="card p-4">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#eeeeee] pb-3">
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
                        <h2 className="text-lg font-bold text-slate-900">{selected.customer?.name || convName(selected.conversation, unknownLabel)}</h2>
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
                          className="rounded-lg border px-2 py-1 text-sm"
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
                          className="w-44 rounded-lg border px-2 py-1 text-sm"
                        />
                        <button
                          onClick={saveName}
                          disabled={nameSaving || !nameDraft.trim() || nameDraft.trim() === (selected.customer?.name || "")}
                          className="rounded-lg bg-green-600 px-3 py-1 text-sm text-white transition hover:bg-green-700 disabled:opacity-50"
                        >
                          {nameSaving ? t("inbox.saving", "Saving…", "সংরক্ষণ হচ্ছে…") : t("inbox.save", "Save", "সংরক্ষণ")}
                        </button>
                        {selected.customer?.name_manually_set && (
                          <span className="text-xs text-green-700">
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
                      className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50 ${aiMode ? "bg-green-600" : "bg-slate-300"}`}
                    >
                      <span
                        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${aiMode ? "left-[22px]" : "left-0.5"}`}
                      />
                    </button>
                    <span className={`text-xs font-medium ${aiMode ? "text-green-700" : aiMode === false ? "text-amber-700" : "text-slate-500"}`}>
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

                {/* Waiting banner — this chat escalated to a human (angry
                    customer / AI couldn't answer). The AI is stopped
                    (mode stays 'human'). The owner clears it here:
                    Back to Open (keeps human mode — he handles it) or
                    Done. */}
                {(() => {
                  const reason = selected ? waitingReason(selected.conversation) : null;
                  if (!reason) return null;
                  return (
                    <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3">
                      <p className="text-sm font-bold text-amber-900">
                        {t("inbox.waitingBanner", "Needs a human — the AI has stopped replying here.", "মানুষের উত্তর দরকার — এখানে AI উত্তর দেওয়া বন্ধ করেছে।")}
                      </p>
                      <p className="mt-0.5 text-sm text-amber-800">
                        {t("inbox.waitingBannerReason", "Reason", "কারণ")}: {t("inbox.waitingReason", reason.en, reason.bn)}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button
                          onClick={() => doAction(() => inboxApi.reopen(selectedId!), t("inbox.reopenFailed", "Moving back to Open failed", "খোলা অবস্থায় ফেরানো ব্যর্থ"))}
                          className="rounded-lg bg-amber-600 px-3 py-2 text-sm text-white transition hover:bg-amber-700"
                        >
                          {t("inbox.reopen", "Back to Open", "খোলা অবস্থায় ফেরান")}
                        </button>
                        <button
                          onClick={() => doAction(() => inboxApi.done(selectedId!), t("inbox.markDoneFailed", "Marking done failed", "সম্পন্ন করা ব্যর্থ"))}
                          className="rounded-lg bg-blue-600 px-3 py-2 text-sm text-white transition hover:bg-blue-700"
                        >
                          {t("inbox.markDone", "Done", "সম্পন্ন")}
                        </button>
                      </div>
                      <p className="mt-2 text-xs text-amber-700">
                        {t("inbox.waitingBannerNote", "Back to Open keeps the AI off — you handle this chat. Turn the AI back on with the switch above when you're ready.", "খোলা অবস্থায় ফেরালেও AI বন্ধই থাকবে — এই চ্যাট আপনি নিজে দেখবেন। প্রস্তুত হলে উপরের সুইচ দিয়ে AI আবার চালু করুন।")}
                      </p>
                    </div>
                  );
                })()}

                <div className="max-h-[420px] space-y-3 overflow-y-auto py-4">
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
                          <p className={`mt-1 text-[11px] ${isMe ? "text-orange-100" : "text-slate-400"}`}>
                            {isAi ? t("inbox.ai", "AI", "AI") : isMe ? t("inbox.you", "You", "আপনি") : t("inbox.customer", "Customer", "কাস্টমার")} • {fmtDate(m.createdAt || m.created_at)}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <form onSubmit={sendReply} className="flex gap-2 border-t border-[#eeeeee] pt-3">
                  <input
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    placeholder={t("inbox.replyPlaceholder", "Write a reply…", "উত্তর লিখুন…")}
                    className="flex-1 rounded-lg border px-3 py-2"
                  />
                  <button disabled={sending} className="rounded-lg bg-brand px-4 py-2 text-white hover:bg-brand-dark disabled:opacity-50">
                    {sending ? t("inbox.sending", "Sending…", "পাঠানো হচ্ছে…") : t("inbox.send", "Send", "পাঠান")}
                  </button>
                </form>

                <div className="mt-3 flex flex-wrap gap-2">
                  <div className="flex gap-2">
                    <input
                      value={assignUserId}
                      onChange={(e) => setAssignUserId(e.target.value)}
                      placeholder={t("inbox.assignPlaceholder", "Team member's User ID", "টিম সদস্যের User ID")}
                      className="w-44 rounded-lg border px-3 py-2 text-sm"
                    />
                    <button
                      onClick={() => assignUserId.trim() && doAction(() => inboxApi.assign(selectedId!, assignUserId.trim()), t("inbox.assignFailed", "Assign failed", "অ্যাসাইন ব্যর্থ"))}
                      className="rounded-lg bg-green-600 px-3 py-2 text-sm text-white hover:bg-green-700"
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
                <h3 className="mb-2 font-bold text-slate-900">{t("inbox.profile", "Customer profile", "কাস্টমার প্রোফাইল")}</h3>
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
                  <p className="mt-2 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">
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

                <h4 className="mb-2 mt-4 text-sm font-bold text-slate-900">{t("inbox.openOrders", "Open orders", "খোলা অর্ডার")}</h4>
                {(!selected.openOrders || selected.openOrders.length === 0) && (
                  <p className="text-sm text-slate-500">{t("inbox.noOpenOrders", "No open orders.", "কোনো খোলা অর্ডার নেই।")}</p>
                )}
                {(selected.openOrders || []).map((o) => (
                  <div key={o.id} className="mb-2 flex justify-between rounded-lg border border-[#eeeeee] p-2 text-sm">
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

/** useSearchParams needs a Suspense boundary (Next.js App Router rule). */
export default function InboxPageWrapper() {
  return (
    <Suspense fallback={<p className="text-slate-500">Loading…</p>}>
      <InboxPage />
    </Suspense>
  );
}
