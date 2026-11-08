"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  customersApi,
  getToken,
  orderItemsOf,
  orderTotalPaisa,
  usageApi,
  type CustomerDetail,
  type UsageSummary,
} from "@/lib/api";
import { useI18n } from "@/lib/i18n";

export default function CustomerDetailPage() {
  const params = useParams();
  const id = String(params.id || "");
  const router = useRouter();
  const { t, fmtDate, fmtTaka, fmtNum } = useI18n();
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  // Per-customer AI usage (real sums from ai_usage_ledger, provider cost
  // only). Null until loaded; a customer with no AI replies gets an
  // empty byCustomer list and the card shows 0 honestly.
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [mergeId, setMergeId] = useState("");
  const [merging, setMerging] = useState(false);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await customersApi.get(id);
      setDetail(data);
      try {
        setUsage(await usageApi.list({ customerId: id }));
      } catch {
        /* usage stays null — the card shows 0, never a crash */
      }
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

  if (loading) return (
    <div className="space-y-3">
      <div className="skeleton h-8 w-48" />
      <div className="skeleton h-24" />
      <div className="skeleton h-24" />
    </div>
  );

  const c = detail?.customer;

  return (
    <div>
      <Link href="/customers" className="text-brand-dark underline text-sm">{t("customers.allCustomersLink", "← All customers", "← সব কাস্টমার")}</Link>
      <h1 className="page-title">{t("customers.detailTitle", "Customer profile", "কাস্টমার প্রোফাইল")}</h1>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}
      {notice && <p className="bg-green-50 text-green-700 text-sm p-3 rounded-lg mb-4">{notice}</p>}
      {!c && !loading && <div className="empty-state">{t("customers.notFound", "Customer not found.", "কাস্টমার পাওয়া যায়নি।")}</div>}
      {c && (
        <div className="space-y-4">
          <div className="card p-4">
            <h2 className="font-bold text-lg">{c.name || t("common.unknown", "Unknown", "অজানা")}</h2>
            <p className="text-sm"><span className="text-slate-500">{t("common.phone", "Phone", "ফোন")}:</span> {c.phone || "—"}</p>
            <p className="text-sm"><span className="text-slate-500">{t("common.address", "Address", "ঠিকানা")}:</span> {c.address || "—"}</p>
            <p className="text-sm"><span className="text-slate-500">{t("common.id", "ID", "ID")}:</span> {c.id}</p>
          </div>

          {/* Spending summary — computed from the customer's REAL order rows
              (total spent excludes cancelled/returned orders). */}
          {detail?.summary && (
            <div className="card p-4">
              <h3 className="font-bold mb-2">{t("customers.spendingTitle", "Spending summary", "খরচের হিসাব")}</h3>
              <p className="text-2xl font-bold text-brand-dark">{fmtTaka(detail.summary.totalSpentPaisa)}</p>
              <p className="text-xs text-slate-500 mb-3">{t("customers.totalSpentNote", "Total spent (cancelled / returned orders excluded)", "মোট খরচ (বাতিল / ফেরত অর্ডার বাদে)")}</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
                <div className="border rounded-lg p-2"><p className="text-slate-500 text-xs">{t("customers.ordersCount", "Orders", "অর্ডার")}</p><p className="font-bold">{detail.summary.orderCount}</p></div>
                <div className="border rounded-lg p-2"><p className="text-slate-500 text-xs">{t("customers.deliveredCount", "Delivered", "ডেলিভারি হয়েছে")}</p><p className="font-bold">{detail.summary.deliveredCount}</p></div>
                <div className="border rounded-lg p-2"><p className="text-slate-500 text-xs">{t("customers.cancelledCount", "Cancelled", "বাতিল")}</p><p className="font-bold">{detail.summary.cancelledCount}</p></div>
                <div className="border rounded-lg p-2"><p className="text-slate-500 text-xs">{t("customers.returnedCount", "Returned", "ফেরত")}</p><p className="font-bold">{detail.summary.returnedCount}</p></div>
              </div>
              <p className="text-sm mt-3"><span className="text-slate-500">{t("customers.lastOrder", "Last order:", "শেষ অর্ডার:")}</span> {detail.summary.lastOrderAt ? fmtDate(detail.summary.lastOrderAt) : "—"}</p>
            </div>
          )}

          {/* AI usage — real sums from ai_usage_ledger (provider cost
              only), rolled up across this customer's chats. A customer
              with no AI replies shows 0 honestly, never a blank. */}
          <div className="card p-4">
            <h3 className="font-bold mb-2">{t("customers.aiUsageTitle", "AI usage", "AI ব্যবহার")}</h3>
            <p className="text-xs text-slate-500 mb-3">{t("customers.aiUsageNote", "Tokens used and the real cost of AI replies to this customer.", "এই কাস্টমারকে AI যত উত্তর দিয়েছে, তার টোকেন ও আসল খরচ।")}</p>
            {(() => {
              const total = usage?.byCustomer?.[0];
              const tokens = (total?.inputTokens ?? 0) + (total?.outputTokens ?? 0);
              return (
                <>
                  <p className="text-2xl font-bold text-brand-dark">{fmtTaka(total?.costPaisa ?? 0)}</p>
                  <p className="text-sm text-slate-600 mb-3">
                    {total && total.replies > 0
                      ? `${fmtNum(tokens)} ${t("inbox.aiUsageTokens", "tokens", "টোকেন")} · ${total.replies} ${t("inbox.aiUsageReplies", "replies", "উত্তর")}`
                      : `${t("inbox.noAiReplies", "No AI replies yet", "AI এখনো উত্তর দেয়নি")} — 0 ${t("inbox.aiUsageTokens", "tokens", "টোকেন")} · ${fmtTaka(0)}`}
                  </p>
                  {(usage?.byConversation ?? []).length > 0 && (
                    <>
                      <p className="text-sm font-bold text-slate-900 mb-1">{t("customers.aiUsagePerChat", "Per chat", "প্রতি চ্যাটে")}</p>
                      <ul className="text-sm space-y-1">
                        {(usage?.byConversation ?? []).map((u) => (
                          <li key={u.conversationId} className="border rounded-lg p-2 flex justify-between gap-2">
                            <span>
                              {fmtNum(u.inputTokens + u.outputTokens)} {t("inbox.aiUsageTokens", "tokens", "টোকেন")} · {u.replies}{" "}
                              {t("inbox.aiUsageReplies", "replies", "উত্তর")} •{" "}
                              <Link href={`/inbox?conversation=${u.conversationId}`} className="text-brand-dark underline">
                                {t("common.viewInInbox", "View in inbox", "ইনবক্সে দেখুন")}
                              </Link>
                            </span>
                            <span className="font-medium shrink-0">{fmtTaka(u.costPaisa)}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </>
              );
            })()}
          </div>

          {/* What the customer ordered — product names + quantities + amounts. */}
          <div className="card p-4">
            <h3 className="font-bold mb-2">{t("customers.productsOrdered", "Products ordered", "যেসব পণ্য অর্ডার করেছে")}</h3>
            {(!detail?.productsOrdered || detail.productsOrdered.length === 0) ? (
              <p className="text-sm text-slate-500">{t("customers.noProductsOrdered", "No products ordered yet.", "এখনো কোনো পণ্য অর্ডার করেনি।")}</p>
            ) : (
              <ul className="text-sm space-y-1">
                {detail.productsOrdered.map((p, i) => (
                  <li key={`${p.productId || p.productName}-${i}`} className="border rounded-lg p-2 flex justify-between gap-2">
                    <span>{p.productName} <span className="text-slate-500">× {p.quantity}{p.orderCount > 1 ? ` • ${p.orderCount} ${t("customers.ordersWord", "orders", "টি অর্ডারে")}` : ""}</span></span>
                    <span className="font-medium shrink-0">{fmtTaka(p.amountPaisa)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card p-4">
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

          <div className="card p-4">
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

          <div className="card p-4">
            <h3 className="font-bold mb-2">{t("customers.orders", "Orders", "অর্ডার")}</h3>
            {(!detail?.orders || detail.orders.length === 0) ? (
              <p className="text-sm text-slate-500">{t("customers.noOrders", "No orders.", "কোনো অর্ডার নেই।")}</p>
            ) : (
              <ul className="text-sm space-y-2">
                {detail.orders.map((o) => {
                  const items = orderItemsOf(o);
                  return (
                    <li key={o.id} className="border rounded-lg p-2">
                      <div className="flex justify-between gap-2">
                        <span>{o.orderNumber || o.order_number || o.id} • {o.status || "—"} • {fmtDate(o.createdAt || o.created_at)}</span>
                        <span className="font-medium shrink-0">{fmtTaka(orderTotalPaisa(o))}</span>
                      </div>
                      {items.length > 0 && (
                        <ul className="mt-1 pl-3 text-slate-600 space-y-0.5">
                          {items.map((it, i) => (
                            <li key={it.id || i}>
                              {it.productName || it.product_name || it.name || t("customers.unknownProduct", "Unknown product", "অজানা পণ্য")} × {it.quantity ?? it.qty ?? 1} — {fmtTaka((it.pricePaisa ?? it.price_paisa ?? it.price ?? 0) * (it.quantity ?? it.qty ?? 1))}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="card p-4">
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

          <form onSubmit={merge} className="card p-4">
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
              <button disabled={merging} className="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 disabled:opacity-50">
                {merging ? t("customers.merging", "Merging…", "মার্জ হচ্ছে…") : t("customers.mergeButton", "Merge", "মার্জ করুন")}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
