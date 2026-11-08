"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { asArrayOf, customersApi, getToken, usageApi, type Customer, type CustomerUsage } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

export default function CustomersPage() {
  const router = useRouter();
  const { t, fmtTaka, fmtNum } = useI18n();
  const [customers, setCustomers] = useState<Customer[]>([]);
  // Per-customer AI usage (real sums from ai_usage_ledger, provider cost
  // only) — keyed by customer id. A customer with no AI replies has no
  // row here, and the table shows ৳0.00 for them, never a blank.
  const [usageByCustomer, setUsageByCustomer] = useState<Record<string, CustomerUsage>>({});
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (query?: string) => {
    setLoading(true);
    try {
      const data = await customersApi.list(query || undefined);
      setCustomers(asArrayOf<Customer>(data, ["customers"]));
      try {
        const usage = await usageApi.list();
        const map: Record<string, CustomerUsage> = {};
        for (const u of usage.byCustomer ?? []) map[u.customerId] = u;
        setUsageByCustomer(map);
      } catch {
        /* usage stays empty — the table shows ৳0.00, never a crash */
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("customers.loadFailed", "Could not load customers.", "কাস্টমার লোড করা যায়নি।"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!getToken()) { router.push("/login"); return; }
    load();
  }, [load, router]);

  return (
    <div>
      <h1 className="page-title">{t("customers.title", "Customers", "কাস্টমার")}</h1>
      <p className="page-subtitle">{t("customers.subtitle", "Everyone who has messaged your shop.", "যারা আপনার শপে মেসেজ করেছে, সবাই।")}</p>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}

      <div className="flex gap-2 mb-4">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && load(q.trim())}
          placeholder={t("customers.searchPlaceholder", "Search — name, phone…", "খুঁজুন — নাম, ফোন…")}
          className="flex-1 border rounded-lg px-3 py-2 bg-white"
        />
        <button onClick={() => load(q.trim())} className="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700">{t("common.search", "Search", "খুঁজুন")}</button>
      </div>

      {loading ? (<div className="space-y-2"><div className="skeleton h-12" /><div className="skeleton h-12" /><div className="skeleton h-12" /></div>) : customers.length === 0 ? (
        <div className="empty-state">{t("customers.empty", "No customers found.", "কোনো কাস্টমার পাওয়া যায়নি।")}</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="table-head border-b text-left text-slate-500"><th className="p-3">{t("customers.thName", "Name", "নাম")}</th><th className="p-3">{t("customers.thPhone", "Phone", "ফোন")}</th><th className="p-3">{t("customers.thAddress", "Address", "ঠিকানা")}</th><th className="p-3">{t("customers.thTotalSpent", "Total spent", "মোট খরচ")}</th><th className="p-3">{t("customers.thOrders", "Orders", "অর্ডার")}</th><th className="p-3">{t("customers.thAiCost", "AI cost", "AI খরচ")}</th><th className="p-3"></th></tr></thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id} className="border-b transition-colors hover:bg-orange-50">
                  <td className="p-3 font-medium">{c.name || t("common.unknown", "Unknown", "অজানা")}</td>
                  <td className="p-3">{c.phone || "—"}</td>
                  <td className="p-3">{c.address || "—"}</td>
                  <td className="p-3 font-medium">{fmtTaka(Number(c.total_spent_paisa ?? c.totalSpentPaisa ?? 0))}</td>
                  <td className="p-3">{c.order_count ?? c.orderCount ?? 0}</td>
                  <td className="p-3">
                    {(() => {
                      const u = usageByCustomer[c.id];
                      const tokens = (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0);
                      return (
                        <>
                          <span className="font-medium">{fmtTaka(u?.costPaisa ?? 0)}</span>
                          <span className="block text-xs text-slate-400">
                            {u && u.replies > 0
                              ? `${fmtNum(tokens)} ${t("inbox.aiUsageTokens", "tokens", "টোকেন")} · ${u.replies} ${t("inbox.aiUsageReplies", "replies", "উত্তর")}`
                              : t("inbox.noAiReplies", "No AI replies yet", "AI এখনো উত্তর দেয়নি")}
                          </span>
                        </>
                      );
                    })()}
                  </td>
                  <td className="p-3 text-right"><Link href={`/customers/${c.id}`} className="text-brand-dark underline">{t("customers.profileLink", "Profile", "প্রোফাইল")}</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
