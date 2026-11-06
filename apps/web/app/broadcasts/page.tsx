"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  asArrayOf,
  broadcastsApi,
  getToken,
  type Broadcast,
} from "@/lib/api";
import { useI18n } from "@/lib/i18n";

export default function BroadcastsPage() {
  const router = useRouter();
  const { t, fmtDate, fmtNum } = useI18n();
  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [offerText, setOfferText] = useState("");
  const [couponCode, setCouponCode] = useState("");
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ broadcast: Broadcast; recipients?: unknown[] } | null>(null);
  const [sendResult, setSendResult] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await broadcastsApi.list();
      setBroadcasts(asArrayOf<Broadcast>(data, ["broadcasts"]));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("broadcasts.loadFailed", "Could not load broadcasts.", "ব্রডকাস্ট লোড করা যায়নি।"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!getToken()) { router.push("/login"); return; }
    load();
  }, [load, router]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      await broadcastsApi.create({
        title: title.trim(),
        message: message.trim(),
        offerText: offerText.trim() || undefined,
        couponCode: couponCode.trim() || undefined,
      });
      setTitle(""); setMessage(""); setOfferText(""); setCouponCode("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("broadcasts.createFailed", "Could not create the broadcast.", "ব্রডকাস্ট তৈরি করা যায়নি।"));
    } finally {
      setSaving(false);
    }
  };

  const send = async (id: string) => {
    if (!confirm(t("broadcasts.sendConfirm", "Send this broadcast? Only customers who messaged in the last 24 hours will get it.", "এই ব্রডকাস্টটি পাঠাবেন? শুধু গত ২৪ ঘণ্টায় মেসেজ করা কাস্টমাররাই পাবেন।"))) return;
    setError("");
    setSendResult("");
    setSendingId(id);
    try {
      const res = await broadcastsApi.send(id);
      setSendResult(`${t("broadcasts.sendResultSent", "Sent to", "পাঠানো হয়েছে:")} ${fmtNum(res.sent)} ${t("broadcasts.sendResultSkipped", "people, skipped", "জনকে, বাদ গেছে:")} ${fmtNum(res.skipped)} ${t("broadcasts.people", "people", "জন")}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("broadcasts.sendFailed", "Could not send the broadcast.", "ব্রডকাস্ট পাঠানো যায়নি।"));
    } finally {
      setSendingId(null);
    }
  };

  const openDetail = async (id: string) => {
    setError("");
    try {
      const data = await broadcastsApi.get(id);
      setDetail(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("broadcasts.detailFailed", "Could not show details.", "বিস্তারিত দেখা যায়নি।"));
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">{t("broadcasts.title", "Broadcasts", "ব্রডকাস্ট")}</h1>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}
      {sendResult && <p className="bg-teal-50 text-teal-700 text-sm p-3 rounded-lg mb-4">{sendResult}</p>}

      <form onSubmit={create} className="card p-4 mb-6 space-y-3">
        <h2 className="font-bold">{t("broadcasts.createTitle", "Create a new broadcast", "নতুন ব্রডকাস্ট তৈরি করুন")}</h2>
        <input required value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("broadcasts.titlePlaceholder", "Title *", "শিরোনাম *")} className="w-full border rounded-lg px-3 py-2" />
        <textarea required value={message} onChange={(e) => setMessage(e.target.value)} placeholder={t("broadcasts.messagePlaceholder", "Message *", "মেসেজ *")} className="w-full border rounded-lg px-3 py-2" rows={3} />
        <input value={offerText} onChange={(e) => setOfferText(e.target.value)} placeholder={t("broadcasts.offerPlaceholder", "Offer (optional, e.g. Eid offer — 10% off all saris)", "অফার (ঐচ্ছিক, যেমন: ঈদ অফার — সব শাড়িতে ১০% ছাড়)")} className="w-full border rounded-lg px-3 py-2" />
        <input value={couponCode} onChange={(e) => setCouponCode(e.target.value)} placeholder={t("broadcasts.couponPlaceholder", "Coupon code (optional)", "কুপন কোড (ঐচ্ছিক)")} className="w-full border rounded-lg px-3 py-2" />
        <p className="text-sm bg-amber-50 text-amber-800 p-3 rounded-lg">
          {t("broadcasts.rule24h", "⚠️ Only customers who messaged in the last 24 hours will get the broadcast. Nobody else will be sent it.", "⚠️ ব্রডকাস্ট শুধু সেই কাস্টমাররাই পাবেন যারা গত ২৪ ঘণ্টায় মেসেজ করেছেন। এর বাইরে কাউকে পাঠানো হবে না।")}
        </p>
        <button disabled={saving} className="bg-brand text-white py-2 px-6 rounded-lg hover:bg-brand-dark disabled:opacity-50">
          {saving ? t("broadcasts.creating", "Creating…", "তৈরি হচ্ছে…") : t("broadcasts.createButton", "Create broadcast", "ব্রডকাস্ট তৈরি করুন")}
        </button>
      </form>

      {loading ? <p className="text-slate-500">{t("common.loading", "Loading…", "লোড হচ্ছে…")}</p> : broadcasts.length === 0 ? (
        <div className="empty-state">{t("broadcasts.empty", "No broadcasts.", "কোনো ব্রডকাস্ট নেই।")}</div>
      ) : (
        <div className="space-y-3">
          {broadcasts.map((b) => (
            <div key={b.id} className="card p-4">
              <div className="flex justify-between gap-2">
                <h3 className="font-bold">{b.title || t("broadcasts.titleFallback", "Broadcast", "ব্রডকাস্ট")}</h3>
                <span className="text-xs text-slate-400 shrink-0">{fmtDate(b.createdAt || b.created_at)}</span>
              </div>
              <p className="text-sm whitespace-pre-wrap mt-1">{b.message || ""}</p>
              {(b.offerText || b.offer_text) && <p className="text-sm text-teal-700 mt-1">🎁 {b.offerText || b.offer_text}</p>}
              {(b.couponCode || b.coupon_code) && <p className="text-sm mt-1">{t("broadcasts.couponLabel", "Coupon:", "কুপন:")} <b>{b.couponCode || b.coupon_code}</b></p>}
              {b.status && <p className="text-xs text-slate-500 mt-1">{t("broadcasts.statusLabel", "Status:", "স্ট্যাটাস:")} {b.status}</p>}
              {(b.sent != null || b.skipped != null) && (
                <p className="text-sm mt-1">{t("broadcasts.sentLine", "Sent:", "পাঠানো:")} {fmtNum(b.sent ?? 0)} {t("broadcasts.people", "people", "জন")} • {t("broadcasts.skippedLine", "skipped:", "বাদ গেছে:")} {fmtNum(b.skipped ?? 0)} {t("broadcasts.people", "people", "জন")}</p>
              )}
              <div className="flex gap-2 mt-3">
                <button onClick={() => send(b.id)} disabled={sendingId === b.id} className="bg-brand text-white px-4 py-2 rounded-lg text-sm hover:bg-brand-dark disabled:opacity-50">
                  {sendingId === b.id ? t("broadcasts.sending", "Sending…", "পাঠানো হচ্ছে…") : t("broadcasts.sendButton", "Send", "পাঠান")}
                </button>
                <button onClick={() => openDetail(b.id)} className="bg-teal-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-teal-700">{t("broadcasts.detailButton", "Details", "বিস্তারিত")}</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {detail && (
        <div className="card p-4 mt-6">
          <div className="flex justify-between">
            <h3 className="font-bold">{t("broadcasts.detailTitle", "Details —", "বিস্তারিত —")} {detail.broadcast.title || t("broadcasts.titleFallback", "Broadcast", "ব্রডকাস্ট")}</h3>
            <button onClick={() => setDetail(null)} className="text-sm text-slate-500 underline">{t("common.close", "Close", "বন্ধ করুন")}</button>
          </div>
          <p className="text-sm mt-2">{t("broadcasts.sentCount", "Sent:", "পাঠানো:")} {detail.broadcast.sent != null ? fmtNum(detail.broadcast.sent) : "—"} {t("broadcasts.people", "people", "জন")} • {t("broadcasts.skippedCount", "skipped:", "বাদ গেছে:")} {detail.broadcast.skipped != null ? fmtNum(detail.broadcast.skipped) : "—"} {t("broadcasts.people", "people", "জন")}</p>
          <p className="text-sm mt-2">{t("broadcasts.recipients", "Recipients:", "প্রাপক:")} {fmtNum(detail.recipients ? detail.recipients.length : 0)} {t("broadcasts.people", "people", "জন")}</p>
          {(detail.recipients || []).length > 0 && (
            <pre className="text-xs bg-orange-50 rounded-lg p-3 mt-2 overflow-x-auto">
              {JSON.stringify(detail.recipients, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
