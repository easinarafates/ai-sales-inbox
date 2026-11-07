"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { asArray, getToken, inboxApi, ticketsApi, type Conversation, type Ticket } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

const TICKET_STATUSES = ["open", "in_progress", "resolved", "closed"];
const TICKET_STATUS_KEYS: Record<string, string> = {
  open: "ticketStatus.open",
  in_progress: "ticketStatus.in_progress",
  resolved: "ticketStatus.resolved",
  closed: "ticketStatus.closed",
};
const TICKET_STATUS_FALLBACK: Record<string, [string, string]> = {
  open: ["Open", "খোলা"],
  in_progress: ["In progress", "চলছে"],
  resolved: ["Resolved", "সমাধান হয়েছে"],
  closed: ["Closed", "বন্ধ"],
};

export default function TicketsPage() {
  const router = useRouter();
  const { t, fmtDate } = useI18n();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const conversationLabel = (c: Conversation) =>
    c.customerName || c.customer_name || c.customer?.name || c.customerId || c.customer_id || c.id.slice(0, 8);

  const ticketLabel = (s: string) => {
    const fb = TICKET_STATUS_FALLBACK[s] || [s, s];
    return t(TICKET_STATUS_KEYS[s] || "", fb[0], fb[1]);
  };

  const load = useCallback(async () => {
    try {
      const data = await ticketsApi.list();
      setTickets(asArray(data));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("tickets.loadFailed", "Could not load tickets.", "টিকেট লোড করা যায়নি।"));
    } finally {
      setLoading(false);
    }
    try {
      setConversations(asArray(await inboxApi.list()));
    } catch {
      setConversations([]);
    }
  }, [t]);

  useEffect(() => {
    if (!getToken()) { router.push("/login"); return; }
    load();
  }, [load, router]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(""); setSaving(true);
    try {
      await ticketsApi.create({ conversationId: conversationId.trim() || undefined, reason: reason.trim() });
      setConversationId(""); setReason("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("tickets.createFailed", "Could not create the ticket.", "টিকেট তৈরি করা যায়নি।"));
    } finally { setSaving(false); }
  };

  const changeStatus = async (id: string, status: string) => {
    setError("");
    try {
      await ticketsApi.update(id, { status });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("tickets.statusFailed", "Could not change the status.", "স্ট্যাটাস বদলানো যায়নি।"));
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">{t("tickets.title", "Support Tickets", "সাপোর্ট টিকেট")}</h1>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}

      <form onSubmit={create} className="card p-4 mb-6 grid grid-cols-1 md:grid-cols-3 gap-3">
        <h2 className="font-bold md:col-span-3">{t("tickets.createTitle", "Create a new ticket", "নতুন টিকেট তৈরি করুন")}</h2>
        <label className="text-sm">
          {t("tickets.conversationLabel", "Conversation", "কথোপকথন")}
          <select value={conversationId} onChange={(e) => setConversationId(e.target.value)} className="block w-full border rounded-lg px-3 py-2 bg-white mt-1">
            <option value="">{t("tickets.pickConversation", "Choose a conversation", "একটি কথোপকথন বেছে নিন")}</option>
            {conversations.map((c) => (
              <option key={c.id} value={c.id}>{conversationLabel(c)}</option>
            ))}
          </select>
          {conversations.length === 0 && (
            <span className="text-xs text-slate-500">{t("tickets.noConversations", "No conversations yet — connect a Page first.", "এখনো কোনো কথোপকথন নেই — আগে একটি পেজ যুক্ত করুন।")}</span>
          )}
        </label>
        <input required value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("tickets.reasonPlaceholder", "Reason (e.g. wants a refund) *", "কারণ (যেমন: রিফান্ড চান) *")} className="border rounded-lg px-3 py-2" />
        <button disabled={saving} className="bg-brand text-white py-2 rounded-lg hover:bg-brand-dark disabled:opacity-50">{saving ? t("tickets.creating", "Creating…", "তৈরি হচ্ছে…") : t("tickets.createButton", "Create ticket", "টিকেট তৈরি করুন")}</button>
      </form>

      {loading ? <p className="text-slate-500">{t("common.loading", "Loading…", "লোড হচ্ছে…")}</p> : tickets.length === 0 ? (
        <div className="empty-state">{t("tickets.empty", "No tickets.", "কোনো টিকেট নেই।")}</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="table-head border-b text-left text-slate-500"><th className="p-3">{t("tickets.thId", "ID", "ID")}</th><th className="p-3">{t("tickets.thReason", "Reason", "কারণ")}</th><th className="p-3">{t("tickets.thStatus", "Status", "স্ট্যাটাস")}</th><th className="p-3">{t("tickets.thDate", "Date", "তারিখ")}</th><th className="p-3">{t("tickets.thChange", "Change", "বদলান")}</th></tr></thead>
            <tbody>
              {tickets.map((tk) => (
                <tr key={tk.id} className="border-b transition-colors hover:bg-orange-50">
                  <td className="p-3 font-mono text-xs">{tk.id.slice(0, 8)}</td>
                  <td className="p-3">{tk.reason || "—"}</td>
                  <td className="p-3">{ticketLabel(tk.status || "")}</td>
                  <td className="p-3 text-slate-500">{fmtDate(tk.createdAt || tk.created_at)}</td>
                  <td className="p-3">
                    <select value={tk.status || "open"} onChange={(e) => changeStatus(tk.id, e.target.value)} className="border rounded-lg px-2 py-1 bg-white">
                      {TICKET_STATUSES.map((s) => <option key={s} value={s}>{ticketLabel(s)}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
