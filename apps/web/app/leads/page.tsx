"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  asArrayOf,
  followupsApi,
  getToken,
  leadsApi,
  type Followup,
  type Lead,
} from "@/lib/api";
import { useI18n } from "@/lib/i18n";

function toInputValue(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 16);
}

export default function LeadsPage() {
  const router = useRouter();
  const { t, fmtDate, fmtNum } = useI18n();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [followups, setFollowups] = useState<Followup[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState("");

  // Lead form
  const [customerId, setCustomerId] = useState("");
  const [need, setNeed] = useState("");
  const [followUpAt, setFollowUpAt] = useState("");
  const [callAt, setCallAt] = useState("");
  const [outcome, setOutcome] = useState("");
  const [editing, setEditing] = useState<Lead | null>(null);

  // Follow-up form
  const [fuLeadId, setFuLeadId] = useState("");
  const [fuCustomerId, setFuCustomerId] = useState("");
  const [fuMessage, setFuMessage] = useState("");
  const [fuSendAt, setFuSendAt] = useState("");
  const [fuStatus, setFuStatus] = useState("");

  const loadLeads = useCallback(async () => {
    try {
      const data = await leadsApi.list();
      setLeads(asArrayOf<Lead>(data, ["leads"]));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("leads.loadFailed", "Could not load leads.", "লিড লোড করা যায়নি।"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  const loadFollowups = useCallback(async (status?: string) => {
    try {
      const data = await followupsApi.list(status || undefined);
      setFollowups(asArrayOf<Followup>(data, ["followups"]));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("leads.followupsLoadFailed", "Could not load follow-ups.", "ফলো-আপ লোড করা যায়নি।"));
    }
  }, [t]);

  useEffect(() => {
    if (!getToken()) { router.push("/login"); return; }
    loadLeads();
    loadFollowups();
  }, [loadLeads, loadFollowups, router]);

  const submitLead = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      if (editing) {
        await leadsApi.update(editing.id, {
          need: need || undefined,
          followUpAt: followUpAt ? new Date(followUpAt).toISOString() : undefined,
          callAt: callAt ? new Date(callAt).toISOString() : undefined,
          outcome: outcome || undefined,
        });
        setEditing(null);
      } else {
        await leadsApi.create({
          customerId: customerId.trim(),
          need: need || undefined,
          followUpAt: followUpAt ? new Date(followUpAt).toISOString() : undefined,
          callAt: callAt ? new Date(callAt).toISOString() : undefined,
        });
      }
      setCustomerId(""); setNeed(""); setFollowUpAt(""); setCallAt(""); setOutcome("");
      await loadLeads();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("leads.saveFailed", "Could not save the lead.", "লিড সংরক্ষণ করা যায়নি।"));
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (l: Lead) => {
    setEditing(l);
    setCustomerId(l.customerId || l.customer_id || "");
    setNeed(l.need || "");
    setFollowUpAt(toInputValue(l.followUpAt || l.follow_up_at));
    setCallAt(toInputValue(l.callAt || l.call_at));
    setOutcome(l.outcome || "");
  };

  const submitFollowup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      await followupsApi.create({
        leadId: fuLeadId || undefined,
        customerId: fuCustomerId.trim() || undefined,
        message: fuMessage.trim(),
        sendAt: fuSendAt ? new Date(fuSendAt).toISOString() : new Date().toISOString(),
      });
      setFuLeadId(""); setFuCustomerId(""); setFuMessage(""); setFuSendAt("");
      await loadFollowups(fuStatus || undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("leads.followupFailed", "Could not create the follow-up.", "ফলো-আপ তৈরি করা যায়নি।"));
    } finally {
      setSaving(false);
    }
  };

  const sendNow = async (id: string) => {
    setError("");
    try {
      await followupsApi.sendNow(id);
      await loadFollowups(fuStatus || undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("leads.sendNowFailed", "Could not send now.", "এখনই পাঠানো যায়নি।"));
    }
  };

  const runDue = async () => {
    setError("");
    setRunResult("");
    setRunning(true);
    try {
      const res = await followupsApi.runDue();
      setRunResult(`${t("leads.runResultPrefix", "Due follow-ups:", "সময় হওয়া ফলো-আপ:")} ${fmtNum(res.processed)} ${t("leads.runResultProcessed", "processed,", "টি প্রসেস করা হয়েছে,")} ${fmtNum(res.sent)} ${t("leads.runResultSent", "sent.", "টি পাঠানো হয়েছে।")}`);
      await loadFollowups(fuStatus || undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("leads.runDueFailed", "Could not run due follow-ups.", "সময় হওয়া ফলো-আপ চালানো যায়নি।"));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">{t("leads.title", "Leads", "লিড")}</h1>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}
      {runResult && <p className="bg-teal-50 text-teal-700 text-sm p-3 rounded-lg mb-4">{runResult}</p>}

      <form onSubmit={submitLead} className="card p-4 mb-6 grid grid-cols-1 md:grid-cols-2 gap-3">
        <h2 className="font-bold md:col-span-2">{editing ? t("leads.editTitle", "Edit lead", "লিড এডিট করুন") : t("leads.addTitle", "Add a new lead", "নতুন লিড যোগ করুন")}</h2>
        <input required={!editing} value={customerId} onChange={(e) => setCustomerId(e.target.value)} placeholder={t("leads.customerIdPlaceholder", "Customer ID *", "কাস্টমার ID *")} className="border rounded-lg px-3 py-2" />
        <input value={need} onChange={(e) => setNeed(e.target.value)} placeholder={t("leads.needPlaceholder", "What they want (e.g. red sari, size M)", "কী চায় (যেমন: লাল শাড়ি, সাইজ M)")} className="border rounded-lg px-3 py-2" />
        <label className="text-sm text-slate-500">{t("leads.followUpTime", "Follow-up time", "ফলো-আপের সময়")}<input type="datetime-local" value={followUpAt} onChange={(e) => setFollowUpAt(e.target.value)} className="w-full border rounded-lg px-3 py-2 bg-white mt-1" /></label>
        <label className="text-sm text-slate-500">{t("leads.callTime", "Call time", "কলের সময়")}<input type="datetime-local" value={callAt} onChange={(e) => setCallAt(e.target.value)} className="w-full border rounded-lg px-3 py-2 bg-white mt-1" /></label>
        {editing && (
          <input value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder={t("leads.outcomePlaceholder", "Result (e.g. ordered / not interested)", "ফলাফল (যেমন: অর্ডার করেছে / আগ্রহী নয়)")} className="border rounded-lg px-3 py-2 md:col-span-2" />
        )}
        <div className="md:col-span-2 flex gap-2">
          <button disabled={saving} className="bg-brand text-white py-2 px-6 rounded-lg hover:bg-brand-dark disabled:opacity-50">
            {saving ? t("leads.saving", "Saving…", "সংরক্ষণ হচ্ছে…") : editing ? t("leads.updateButton", "Update", "আপডেট করুন") : t("leads.saveButton", "Add lead", "লিড যোগ করুন")}
          </button>
          {editing && (
            <button type="button" onClick={() => { setEditing(null); setCustomerId(""); setNeed(""); setFollowUpAt(""); setCallAt(""); setOutcome(""); }} className="bg-slate-200 px-4 py-2 rounded-lg">{t("common.cancel", "Cancel", "বাতিল")}</button>
          )}
        </div>
      </form>

      {loading ? <p className="text-slate-500">{t("common.loading", "Loading…", "লোড হচ্ছে…")}</p> : leads.length === 0 ? (
        <p className="text-slate-500 card p-6 mb-6">{t("leads.empty", "No leads.", "কোনো লিড নেই।")}</p>
      ) : (
        <div className="card overflow-x-auto mb-6">
          <table className="w-full text-sm">
            <thead><tr className="table-head border-b text-left text-slate-500"><th className="p-3">{t("leads.thCustomer", "Customer", "কাস্টমার")}</th><th className="p-3">{t("leads.thNeed", "Need", "চাহিদা")}</th><th className="p-3">{t("leads.thFollowUp", "Follow-up", "ফলো-আপ")}</th><th className="p-3">{t("leads.thCall", "Call", "কল")}</th><th className="p-3">{t("leads.thOutcome", "Result", "ফলাফল")}</th><th className="p-3"></th></tr></thead>
            <tbody>
              {leads.map((l) => (
                <tr key={l.id} className="border-b transition-colors hover:bg-orange-50">
                  <td className="p-3">{l.customer?.name || l.customerId || l.customer_id || "—"}</td>
                  <td className="p-3">{l.need || "—"}</td>
                  <td className="p-3">{fmtDate(l.followUpAt || l.follow_up_at)}</td>
                  <td className="p-3">{fmtDate(l.callAt || l.call_at)}</td>
                  <td className="p-3">{l.outcome || "—"}</td>
                  <td className="p-3 text-right"><button onClick={() => startEdit(l)} className="text-brand-dark underline text-sm">{t("leads.edit", "Edit", "এডিট")}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="text-xl font-bold mb-3">{t("leads.followupsTitle", "Follow-ups", "ফলো-আপ")}</h2>
      <form onSubmit={submitFollowup} className="card p-4 mb-4 grid grid-cols-1 md:grid-cols-2 gap-3">
        <h3 className="font-bold md:col-span-2">{t("leads.newFollowupTitle", "Create a new follow-up", "নতুন ফলো-আপ তৈরি করুন")}</h3>
        <select value={fuLeadId} onChange={(e) => setFuLeadId(e.target.value)} className="border rounded-lg px-3 py-2 bg-white">
          <option value="">{t("leads.pickLead", "Pick a lead (optional)", "লিড বাছুন (ঐচ্ছিক)")}</option>
          {leads.map((l) => (
            <option key={l.id} value={l.id}>{l.customer?.name || l.id} — {l.need || ""}</option>
          ))}
        </select>
        <input value={fuCustomerId} onChange={(e) => setFuCustomerId(e.target.value)} placeholder={t("leads.customerIdNoLead", "Customer ID (if no lead)", "কাস্টমার ID (লিড না থাকলে)")} className="border rounded-lg px-3 py-2" />
        <textarea required value={fuMessage} onChange={(e) => setFuMessage(e.target.value)} placeholder={t("leads.messagePlaceholder", "Message *", "মেসেজ *")} className="border rounded-lg px-3 py-2 md:col-span-2" rows={2} />
        <input type="datetime-local" value={fuSendAt} onChange={(e) => setFuSendAt(e.target.value)} className="border rounded-lg px-3 py-2 bg-white" />
        <button disabled={saving} className="bg-brand text-white py-2 rounded-lg hover:bg-brand-dark disabled:opacity-50">
          {saving ? t("leads.creating", "Creating…", "তৈরি হচ্ছে…") : t("leads.createFollowup", "Create follow-up", "ফলো-আপ তৈরি করুন")}
        </button>
      </form>

      <div className="flex flex-wrap gap-2 mb-4">
        <select value={fuStatus} onChange={(e) => { setFuStatus(e.target.value); loadFollowups(e.target.value || undefined); }} className="border rounded-lg px-3 py-2 bg-white">
          <option value="">{t("leads.allFollowups", "All follow-ups", "সব ফলো-আপ")}</option>
          <option value="pending">{t("leads.fuPending", "Pending", "অপেক্ষমাণ")}</option>
          <option value="sent">{t("leads.fuSent", "Sent", "পাঠানো")}</option>
          <option value="due">{t("leads.fuDue", "Due", "সময় হয়েছে")}</option>
        </select>
        <button onClick={runDue} disabled={running} className="bg-blue-600 text-white px-4 py-2 rounded-lg disabled:opacity-50">
          {running ? t("leads.runningDue", "Running…", "চালানো হচ্ছে…") : t("leads.runDue", "Send due follow-ups", "সময় হওয়া ফলো-আপ পাঠান")}
        </button>
      </div>

      {followups.length === 0 ? (
        <div className="empty-state">{t("leads.emptyFollowups", "No follow-ups.", "কোনো ফলো-আপ নেই।")}</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="table-head border-b text-left text-slate-500"><th className="p-3">{t("leads.thMessage", "Message", "মেসেজ")}</th><th className="p-3">{t("leads.thSendAt", "Send time", "পাঠানোর সময়")}</th><th className="p-3">{t("leads.thStatus", "Status", "স্ট্যাটাস")}</th><th className="p-3"></th></tr></thead>
            <tbody>
              {followups.map((f) => (
                <tr key={f.id} className="border-b transition-colors hover:bg-orange-50">
                  <td className="p-3">{f.message || "—"}</td>
                  <td className="p-3">{fmtDate(f.sendAt || f.send_at)}</td>
                  <td className="p-3">{f.status || "—"}</td>
                  <td className="p-3 text-right">
                    {f.status !== "sent" && (
                      <button onClick={() => sendNow(f.id)} className="text-brand-dark underline text-sm">{t("leads.sendNow", "Send now", "এখনই পাঠান")}</button>
                    )}
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
