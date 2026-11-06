"use client";
import { useCallback, useEffect, useState } from "react";
import {
  TOPUP_METHODS,
  topupAmountPaisa,
  topupApi,
  topupTransactionId,
  type TopupMethod,
  type TopupRequest,
} from "@/lib/topup";
import { useI18n } from "@/lib/i18n";

const METHOD_KEYS: Record<string, string> = {
  bkash: "topup.methodBkash",
  nagad: "topup.methodNagad",
  bank: "topup.methodBank",
  manual: "topup.methodManual",
};
const METHOD_FALLBACK: Record<string, [string, string]> = {
  bkash: ["bKash (Send Money)", "বিকাশ (Send Money)"],
  nagad: ["Nagad (Send Money)", "নগদ (Send Money)"],
  bank: ["Bank transfer", "ব্যাংক ট্রান্সফার"],
  manual: ["By hand (cash/other)", "হাতে (ক্যাশ/অন্যান্য)"],
};
const STATUS_KEYS: Record<string, string> = {
  pending: "topupStatus.pending",
  approved: "topupStatus.approved",
  rejected: "topupStatus.rejected",
};
const STATUS_FALLBACK: Record<string, [string, string]> = {
  pending: ["Waiting for checking", "যাচাইয়ের অপেক্ষায়"],
  approved: ["Approved", "অনুমোদিত"],
  rejected: ["Cancelled", "বাতিল"],
};

/**
 * Top-up section for the Billing page — mount it inside
 * apps/web/app/billing/page.tsx (see courier/integration-notes.md).
 * Manual flow, NO payment gateway: the shop pays by hand (bKash/Nagad/bank),
 * submits amount + method + transaction id, and a workspace member
 * approves/rejects. Approval credits the wallet by the exact amount.
 */
export default function TopupSection() {
  const { t, fmtDate, fmtTaka } = useI18n();
  const [requests, setRequests] = useState<TopupRequest[]>([]);
  const [amountTaka, setAmountTaka] = useState("");
  const [method, setMethod] = useState<TopupMethod>("bkash");
  const [transactionId, setTransactionId] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const methodLabel = (m: string) => {
    const fb = METHOD_FALLBACK[m] || [m, m];
    return t(METHOD_KEYS[m] || "", fb[0], fb[1]);
  };
  const statusLabel = (s: string) => {
    const fb = STATUS_FALLBACK[s] || [s, s];
    return t(STATUS_KEYS[s] || "", fb[0], fb[1]);
  };

  const load = useCallback(async () => {
    try {
      setRequests(await topupApi.list());
    } catch (err) {
      setError(err instanceof Error ? err.message : t("topup.loadFailed", "Could not load top-up requests.", "টপ-আপের অনুরোধ লোড করা যায়নি।"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  const submitRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setNotice("");
    setSaving(true);
    try {
      const amountPaisa = Math.round(parseFloat(amountTaka || "0") * 100);
      const res = await topupApi.request({ amountPaisa, method, transactionId: transactionId.trim() });
      setNotice(res.message || t("topup.submitted", "Top-up request submitted — it will be approved after checking.", "টপ-আপের অনুরোধ জমা হয়েছে — যাচাই করে অনুমোদন দেওয়া হবে।"));
      setAmountTaka("");
      setTransactionId("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("topup.requestFailed", "Could not submit the request.", "অনুরোধ জমা দেওয়া যায়নি।"));
    } finally {
      setSaving(false);
    }
  };

  const approve = async (id: string) => {
    setError("");
    setNotice("");
    try {
      const res = await topupApi.approve(id);
      setNotice(res.message || t("topup.approved", "Approved — money has been added to the balance.", "অনুমোদন করা হয়েছে — ব্যালেন্সে টাকা যোগ হয়েছে।"));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("topup.approveFailed", "Could not approve.", "অনুমোদন করা যায়নি।"));
    }
  };

  const reject = async (id: string) => {
    setError("");
    setNotice("");
    try {
      const res = await topupApi.reject(id, rejectReason.trim() || undefined);
      setNotice(res.message || t("topup.rejected", "The request has been cancelled.", "অনুরোধটি বাতিল করা হয়েছে।"));
      setRejectingId(null);
      setRejectReason("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("topup.rejectFailed", "Could not cancel.", "বাতিল করা যায়নি।"));
    }
  };

  if (loading) return <p className="text-slate-500">{t("common.loading", "Loading…", "লোড হচ্ছে…")}</p>;

  return (
    <div>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}
      {notice && <p className="bg-teal-50 text-teal-800 text-sm p-3 rounded-lg mb-4">{notice}</p>}

      <h2 className="font-bold mb-2">{t("topup.title", "Add money (top-up) — checked by hand", "টাকা জমা দিন (টপ-আপ) — হাতে যাচাই করে")}</h2>
      <form onSubmit={submitRequest} className="bg-white rounded-xl shadow p-4 mb-6 flex flex-wrap gap-2 items-end">
        <div className="flex-1 min-w-40">
          <label className="block text-sm font-medium mb-1">{t("topup.amount", "Amount (৳)", "পরিমাণ (৳)")}</label>
          <input
            required
            type="number"
            min="1"
            step="0.01"
            value={amountTaka}
            onChange={(e) => setAmountTaka(e.target.value)}
            placeholder={t("topup.amountPlaceholder", "e.g. 500", "যেমন: 500")}
            className="w-full border rounded-lg px-3 py-2"
          />
        </div>
        <div className="flex-1 min-w-40">
          <label className="block text-sm font-medium mb-1">{t("topup.method", "Payment method", "পেমেন্টের মাধ্যম")}</label>
          <select value={method} onChange={(e) => setMethod(e.target.value as TopupMethod)} className="w-full border rounded-lg px-3 py-2 bg-white">
            {TOPUP_METHODS.map((m) => (
              <option key={m.value} value={m.value}>
                {methodLabel(m.value)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex-1 min-w-52">
          <label className="block text-sm font-medium mb-1">{t("topup.trxId", "Transaction ID (TrxID)", "লেনদেন আইডি (TrxID)")}</label>
          <input
            required
            value={transactionId}
            onChange={(e) => setTransactionId(e.target.value)}
            placeholder={t("topup.trxPlaceholder", "e.g. 9HX7K2LMNP", "যেমন: 9HX7K2LMNP")}
            className="w-full border rounded-lg px-3 py-2"
          />
        </div>
        <button disabled={saving} className="bg-brand text-white px-5 py-2 rounded-lg hover:bg-brand-dark disabled:opacity-50">
          {saving ? t("topup.submitting", "Submitting…", "জমা হচ্ছে…") : t("topup.submit", "Submit request", "অনুরোধ জমা দিন")}
        </button>
        <p className="text-xs text-slate-500 w-full">
          {t("topup.howItWorks", "First send money by hand to bKash/Nagad/bank, then enter the transaction ID here. Money is added to the balance only after it is checked and approved. A live gateway (bKash/Nagad merchant) is not connected yet.", "প্রথমে বিকাশ/নগদ/ব্যাংকে হাতে টাকা পাঠান, তারপর এখানে লেনদেন আইডি দিন। যাচাই করে অনুমোদন দিলে তবেই ব্যালেন্সে টাকা যোগ হবে। লাইভ গেটওয়ে (বিকাশ/নগদ মার্চেন্ট) এখনো যুক্ত হয়নি।")}
        </p>
      </form>

      <h2 className="font-bold mb-2">{t("topup.requestsTitle", "Top-up requests", "টপ-আপের অনুরোধ")}</h2>
      {requests.length === 0 ? (
        <p className="text-slate-500 bg-white rounded-xl shadow p-6">{t("topup.empty", "No top-up requests yet.", "এখনো কোনো টপ-আপের অনুরোধ নেই।")}</p>
      ) : (
        <div className="bg-white rounded-xl shadow overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-slate-500">
                <th className="p-3">{t("topup.thDate", "Date", "তারিখ")}</th>
                <th className="p-3">{t("topup.thMethod", "Method", "মাধ্যম")}</th>
                <th className="p-3">{t("topup.thTrx", "Transaction ID", "লেনদেন আইডি")}</th>
                <th className="p-3 text-right">{t("topup.thAmount", "Amount", "পরিমাণ")}</th>
                <th className="p-3">{t("topup.thStatus", "Status", "অবস্থা")}</th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id} className="border-b">
                  <td className="p-3">{fmtDate(r.createdAt || r.created_at)}</td>
                  <td className="p-3">{methodLabel(r.method || "")}</td>
                  <td className="p-3">{topupTransactionId(r)}</td>
                  <td className="p-3 text-right">{fmtTaka(topupAmountPaisa(r))}</td>
                  <td className="p-3">
                    {statusLabel(r.status || "pending")}
                    {r.status === "rejected" && r.reason ? ` — ${r.reason}` : ""}
                  </td>
                  <td className="p-3 text-right">
                    {r.status === "pending" && (
                      <span className="inline-flex gap-2">
                        <button onClick={() => approve(r.id)} className="bg-brand text-white px-3 py-1 rounded-lg text-xs hover:bg-brand-dark">
                          {t("topup.approve", "Approve", "অনুমোদন করুন")}
                        </button>
                        {rejectingId === r.id ? (
                          <span className="inline-flex gap-1 items-center">
                            <input
                              value={rejectReason}
                              onChange={(e) => setRejectReason(e.target.value)}
                              placeholder={t("topup.rejectReasonPlaceholder", "Reason for cancelling", "বাতিলের কারণ")}
                              className="border rounded-lg px-2 py-1 text-xs w-36"
                            />
                            <button onClick={() => reject(r.id)} className="bg-red-600 text-white px-3 py-1 rounded-lg text-xs">
                              {t("topup.confirmReject", "Cancel", "বাতিল করুন")}
                            </button>
                          </span>
                        ) : (
                          <button onClick={() => setRejectingId(r.id)} className="bg-slate-200 px-3 py-1 rounded-lg text-xs">
                            {t("topup.reject", "Cancel", "বাতিল")}
                          </button>
                        )}
                      </span>
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
