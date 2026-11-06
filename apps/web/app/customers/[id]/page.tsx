"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  customersApi,
  getToken,
  orderTotalPaisa,
  type CustomerDetail,
} from "@/lib/api";
import { useI18n } from "@/lib/i18n";

export default function CustomerDetailPage() {
  const params = useParams();
  const id = String(params.id || "");
  const router = useRouter();
  const { t, fmtDate, fmtTaka } = useI18n();
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [mergeId, setMergeId] = useState("");
  const [merging, setMerging] = useState(false);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await customersApi.get(id);
      setDetail(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("customers.detailLoadFailed", "Could not load the customer profile.", "কাস্টমার প্রোফাইল লোড করা যায়নি।"));
    } finally {
      setLoading(false);
    }
  }, [id, t]);

  useEffect(() => {
    if (!getToken()) { router.push("/login"); return; }
    load();
  }, [load, router]);

  const merge = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mergeId.trim() || mergeId.trim() === id) {
      setError(t("customers.mergeNeedOther", "Enter another customer's ID.", "অন্য একজন কাস্টমারের ID দিন।"));
      return;
    }
    setError("");
    setNotice("");
    setMerging(true);
    try {
      await customersApi.merge(id, mergeId.trim());
      setNotice(t("customers.merged", "The two customers have been merged.", "দুটি কাস্টমার এক করা হয়েছে।"));
      setMergeId("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("customers.mergeFailed", "Could not merge.", "মার্জ করা যায়নি।"));
    } finally {
      setMerging(false);
    }
  };

  if (loading) return <p className="text-slate-500">{t("common.loading", "Loading…", "লোড হচ্ছে…")}</p>;

  const c = detail?.customer;

  return (
    <div>
      <Link href="/customers" className="text-brand-dark underline text-sm">{t("customers.allCustomersLink", "← All customers", "← সব কাস্টমার")}</Link>
      <h1 className="text-2xl font-bold my-4">{t("customers.detailTitle", "Customer profile", "কাস্টমার প্রোফাইল")}</h1>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}
      {notice && <p className="bg-teal-50 text-teal-700 text-sm p-3 rounded-lg mb-4">{notice}</p>}
      {!c && !loading && <p className="text-slate-500 bg-white rounded-xl shadow p-6">{t("customers.notFound", "Customer not found.", "কাস্টমার পাওয়া যায়নি।")}</p>}
      {c && (
        <div className="space-y-4">
          <div className="bg-white rounded-xl shadow p-4">
            <h2 className="font-bold text-lg">{c.name || t("common.unknown", "Unknown", "অজানা")}</h2>
            <p className="text-sm"><span className="text-slate-500">{t("common.phone", "Phone", "ফোন")}:</span> {c.phone || "—"}</p>
            <p className="text-sm"><span className="text-slate-500">{t("common.address", "Address", "ঠিকানা")}:</span> {c.address || "—"}</p>
            <p className="text-sm"><span className="text-slate-500">{t("common.id", "ID", "ID")}:</span> {c.id}</p>
          </div>

          <div className="bg-white rounded-xl shadow p-4">
            <h3 className="font-bold mb-2">{t("customers.identities", "Identity on all channels", "সব চ্যানেলের পরিচয়")}</h3>
            {(!detail?.identities || detail.identities.length === 0) ? (
              <p className="text-sm text-slate-500">{t("customers.noIdentities", "No channel identity found.", "কোনো চ্যানেল পরিচয় পাওয়া যায়নি।")}</p>
            ) : (
              <ul className="text-sm space-y-1">
                {detail.identities.map((it, i) => (
                  <li key={it.id || i} className="border rounded-lg p-2">
                    {it.platform || it.channel || t("customers.channelFallback", "Channel", "চ্যানেল")} • {it.displayName || it.display_name || it.externalId || it.external_id || "—"}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="bg-white rounded-xl shadow p-4">
            <h3 className="font-bold mb-2">{t("customers.chats", "Chats", "চ্যাট")}</h3>
            {(!detail?.conversations || detail.conversations.length === 0) ? (
              <p className="text-sm text-slate-500">{t("customers.noChats", "No chats.", "কোনো চ্যাট নেই।")}</p>
            ) : (
              <ul className="text-sm space-y-1">
                {detail.conversations.map((conv) => (
                  <li key={conv.id} className="border rounded-lg p-2 flex justify-between gap-2">
                    <span>{conv.lastMessage || conv.last_message || t("customers.chats", "Chats", "চ্যাট")} • {conv.channel || conv.channelType || conv.channel_type || ""}</span>
                    <Link href={`/inbox`} className="text-brand-dark underline shrink-0">{t("common.viewInInbox", "View in inbox", "ইনবক্সে দেখুন")}</Link>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="bg-white rounded-xl shadow p-4">
            <h3 className="font-bold mb-2">{t("customers.orders", "Orders", "অর্ডার")}</h3>
            {(!detail?.orders || detail.orders.length === 0) ? (
              <p className="text-sm text-slate-500">{t("customers.noOrders", "No orders.", "কোনো অর্ডার নেই।")}</p>
            ) : (
              <ul className="text-sm space-y-1">
                {detail.orders.map((o) => (
                  <li key={o.id} className="border rounded-lg p-2 flex justify-between gap-2">
                    <span>{o.orderNumber || o.order_number || o.id} • {o.status || "—"} • {fmtDate(o.createdAt || o.created_at)}</span>
                    <span className="font-medium">{fmtTaka(orderTotalPaisa(o))}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="bg-white rounded-xl shadow p-4">
            <h3 className="font-bold mb-2">{t("customers.notes", "Notes", "নোট")}</h3>
            {(!detail?.notes || detail.notes.length === 0) ? (
              <p className="text-sm text-slate-500">{t("customers.noNotes", "No notes.", "কোনো নোট নেই।")}</p>
            ) : (
              <ul className="text-sm space-y-1">
                {detail.notes.map((n, i) => (
                  <li key={n.id || i} className="border rounded-lg p-2">
                    {n.body || n.text || ""} <span className="text-slate-400">• {fmtDate(n.createdAt || n.created_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <form onSubmit={merge} className="bg-white rounded-xl shadow p-4">
            <h3 className="font-bold mb-2">{t("customers.mergeTitle", "Merge duplicate customers", "ডুপ্লিকেট কাস্টমার এক করুন (মার্জ)")}</h3>
            <p className="text-sm text-slate-500 mb-3">
              {t("customers.mergeHelp", "This profile will be kept; all information of the customer with the ID below will be added to it.", "এই প্রোফাইলটি রাখা হবে; নিচের ID-র কাস্টমারের সব তথ্য এতে যুক্ত হবে।")}
            </p>
            <div className="flex gap-2">
              <input
                required
                value={mergeId}
                onChange={(e) => setMergeId(e.target.value)}
                placeholder={t("customers.mergePlaceholder", "ID of the customer to merge", "মার্জ করবেন এমন কাস্টমারের ID")}
                className="flex-1 border rounded-lg px-3 py-2"
              />
              <button disabled={merging} className="bg-teal-600 text-white px-4 py-2 rounded-lg hover:bg-teal-700 disabled:opacity-50">
                {merging ? t("customers.merging", "Merging…", "মার্জ হচ্ছে…") : t("customers.mergeButton", "Merge", "মার্জ করুন")}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
