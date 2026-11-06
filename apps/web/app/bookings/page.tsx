"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  asArrayOf,
  bookingAdvancePaisa,
  bookingsApi,
  getToken,
  type Booking,
} from "@/lib/api";
import { useI18n } from "@/lib/i18n";

const STATUS_OPTIONS = ["", "pending", "confirmed", "completed", "cancelled"];
const STATUS_KEYS: Record<string, string> = {
  pending: "bookingStatus.pending",
  confirmed: "bookingStatus.confirmed",
  completed: "bookingStatus.completed",
  cancelled: "bookingStatus.cancelled",
};
const STATUS_FALLBACK: Record<string, [string, string]> = {
  pending: ["Pending", "অপেক্ষমাণ"],
  confirmed: ["Confirmed", "নিশ্চিত"],
  completed: ["Completed", "সম্পন্ন"],
  cancelled: ["Cancelled", "বাতিল"],
};

export default function BookingsPage() {
  const router = useRouter();
  const { t, fmtDate, fmtTaka } = useI18n();
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [reminders, setReminders] = useState<Booking[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dateFilter, setDateFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  // Create form
  const [customerId, setCustomerId] = useState("");
  const [service, setService] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [advanceTxId, setAdvanceTxId] = useState("");
  const [advancePaisa, setAdvancePaisa] = useState("");
  const [notes, setNotes] = useState("");

  const statusLabel = (s: string) => {
    const fb = STATUS_FALLBACK[s] || [s, s];
    return t(STATUS_KEYS[s] || "", fb[0], fb[1]);
  };

  const load = useCallback(async () => {
    try {
      const data = await bookingsApi.list({
        date: dateFilter || undefined,
        status: statusFilter || undefined,
      });
      setBookings(asArrayOf<Booking>(data, ["bookings"]));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("bookings.loadFailed", "Could not load bookings.", "বুকিং লোড করা যায়নি।"));
    } finally {
      setLoading(false);
    }
  }, [dateFilter, statusFilter, t]);

  const loadReminders = useCallback(async () => {
    try {
      const data = await bookingsApi.remindersDue();
      setReminders(asArrayOf<Booking>(data, ["bookings"]));
    } catch {
      setReminders([]);
    }
  }, []);

  useEffect(() => {
    if (!getToken()) { router.push("/login"); return; }
    load();
    loadReminders();
  }, [load, loadReminders, router]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      await bookingsApi.create({
        customerId: customerId.trim(),
        service: service.trim(),
        date,
        time,
        advanceTxId: advanceTxId.trim() || undefined,
        advancePaisa: advancePaisa ? Math.round(parseFloat(advancePaisa) * 100) : undefined,
        notes: notes.trim() || undefined,
      });
      setCustomerId(""); setService(""); setDate(""); setTime(""); setAdvanceTxId(""); setAdvancePaisa(""); setNotes("");
      await load();
      await loadReminders();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("bookings.createFailed", "Could not create the booking.", "বুকিং তৈরি করা যায়নি।"));
    } finally {
      setSaving(false);
    }
  };

  const changeStatus = async (id: string, status: string) => {
    setError("");
    try {
      await bookingsApi.update(id, { status });
      await load();
      await loadReminders();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("bookings.statusFailed", "Could not change the status.", "স্ট্যাটাস বদলানো যায়নি।"));
    }
  };

  const remind = async (id: string) => {
    setError("");
    try {
      await bookingsApi.remind(id);
      await loadReminders();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("bookings.remindFailed", "Could not send the reminder.", "রিমাইন্ডার পাঠানো যায়নি।"));
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">{t("bookings.title", "Bookings", "বুকিং")}</h1>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}

      {/* Reminders due */}
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-6">
        <h2 className="font-bold mb-2">{t("bookings.remindersTitle", "⏰ Time to send reminders", "⏰ রিমাইন্ডার দেওয়ার সময় হয়েছে")}</h2>
        {reminders.length === 0 ? (
          <p className="text-sm text-slate-500">{t("bookings.noReminders", "No reminders due right now.", "এখন কোনো রিমাইন্ডার বাকি নেই।")}</p>
        ) : (
          <ul className="space-y-2">
            {reminders.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 bg-white rounded-lg p-3 text-sm">
                <span>{b.customer?.name || b.customerId || b.customer_id || t("common.customer", "Customer", "কাস্টমার")} • {b.service || ""} • {b.date || ""} {b.time || ""}</span>
                <button onClick={() => remind(b.id)} className="bg-amber-600 text-white px-3 py-1.5 rounded-lg text-sm">{t("bookings.remindButton", "Remind", "রিমাইন্ড করুন")}</button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <form onSubmit={create} className="card p-4 mb-6 grid grid-cols-1 md:grid-cols-2 gap-3">
        <h2 className="font-bold md:col-span-2">{t("bookings.createTitle", "New booking", "নতুন বুকিং")}</h2>
        <input required value={customerId} onChange={(e) => setCustomerId(e.target.value)} placeholder={t("bookings.customerIdPlaceholder", "Customer ID *", "কাস্টমার ID *")} className="border rounded-lg px-3 py-2" />
        <input required value={service} onChange={(e) => setService(e.target.value)} placeholder={t("bookings.servicePlaceholder", "Service (e.g. henna / photoshoot) *", "সার্ভিস (যেমন: মেহেদি / ফটোশুট) *")} className="border rounded-lg px-3 py-2" />
        <input required type="date" value={date} onChange={(e) => setDate(e.target.value)} className="border rounded-lg px-3 py-2 bg-white" />
        <input required type="time" value={time} onChange={(e) => setTime(e.target.value)} className="border rounded-lg px-3 py-2 bg-white" />
        <input value={advanceTxId} onChange={(e) => setAdvanceTxId(e.target.value)} placeholder={t("bookings.advanceTxPlaceholder", "Advance transaction ID (optional)", "অগ্রিমের ট্রানজাকশন ID (ঐচ্ছিক)")} className="border rounded-lg px-3 py-2" />
        <input type="number" min="0" step="0.01" value={advancePaisa} onChange={(e) => setAdvancePaisa(e.target.value)} placeholder={t("bookings.advancePlaceholder", "Advance money (৳)", "অগ্রিম টাকা (৳)")} className="border rounded-lg px-3 py-2" />
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t("bookings.notesPlaceholder", "Notes (optional)", "নোট (ঐচ্ছিক)")} className="border rounded-lg px-3 py-2 md:col-span-2" rows={2} />
        <button disabled={saving} className="bg-brand text-white py-2 rounded-lg md:col-span-2 hover:bg-brand-dark disabled:opacity-50">
          {saving ? t("bookings.creating", "Booking…", "বুকিং হচ্ছে…") : t("bookings.createButton", "Book", "বুকিং করুন")}
        </button>
      </form>

      <div className="flex flex-wrap gap-2 mb-4">
        <input type="date" value={dateFilter} onChange={(e) => setDateFilter(e.target.value)} className="border rounded-lg px-3 py-2 bg-white" />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="border rounded-lg px-3 py-2 bg-white">
          <option value="">{t("common.allStatus", "All statuses", "সব স্ট্যাটাস")}</option>
          {STATUS_OPTIONS.filter(Boolean).map((s) => (
            <option key={s} value={s}>{statusLabel(s)}</option>
          ))}
        </select>
      </div>

      {loading ? <p className="text-slate-500">{t("common.loading", "Loading…", "লোড হচ্ছে…")}</p> : bookings.length === 0 ? (
        <div className="empty-state">{t("bookings.empty", "No bookings found.", "কোনো বুকিং পাওয়া যায়নি।")}</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="table-head border-b text-left text-slate-500"><th className="p-3">{t("bookings.thCustomer", "Customer", "কাস্টমার")}</th><th className="p-3">{t("bookings.thService", "Service", "সার্ভিস")}</th><th className="p-3">{t("bookings.thDateTime", "Date & time", "তারিখ ও সময়")}</th><th className="p-3">{t("bookings.thAdvance", "Advance", "অগ্রিম")}</th><th className="p-3">{t("bookings.thStatus", "Status", "স্ট্যাটাস")}</th><th className="p-3"></th></tr></thead>
            <tbody>
              {bookings.map((b) => (
                <tr key={b.id} className="border-b transition-colors hover:bg-orange-50">
                  <td className="p-3">{b.customer?.name || b.customerId || b.customer_id || "—"}</td>
                  <td className="p-3">{b.service || "—"}</td>
                  <td className="p-3">{b.date || ""} {b.time || ""}<br /><span className="text-xs text-slate-400">{fmtDate(b.createdAt || b.created_at)}</span></td>
                  <td className="p-3">
                    {fmtTaka(bookingAdvancePaisa(b))}
                    {(b.advanceTxId || b.advance_tx_id) && <span className="block text-xs text-slate-400">{b.advanceTxId || b.advance_tx_id}</span>}
                  </td>
                  <td className="p-3">{b.status ? statusLabel(b.status) : "—"}</td>
                  <td className="p-3 text-right">
                    <select value={b.status || ""} onChange={(e) => e.target.value && changeStatus(b.id, e.target.value)} className="border rounded-lg px-2 py-1.5 text-sm bg-white">
                      <option value="">{t("bookings.changePlaceholder", "Change…", "বদলান…")}</option>
                      {STATUS_OPTIONS.filter(Boolean).map((s) => (
                        <option key={s} value={s}>{statusLabel(s)}</option>
                      ))}
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
