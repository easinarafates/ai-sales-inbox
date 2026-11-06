"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { asArrayOf, customersApi, getToken, type Customer } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

export default function CustomersPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (query?: string) => {
    setLoading(true);
    try {
      const data = await customersApi.list(query || undefined);
      setCustomers(asArrayOf<Customer>(data, ["customers"]));
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
      <h1 className="text-2xl font-bold mb-4">{t("customers.title", "Customers", "কাস্টমার")}</h1>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}

      <div className="flex gap-2 mb-4">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && load(q.trim())}
          placeholder={t("customers.searchPlaceholder", "Search — name, phone…", "খুঁজুন — নাম, ফোন…")}
          className="flex-1 border rounded-lg px-3 py-2 bg-white"
        />
        <button onClick={() => load(q.trim())} className="bg-teal-600 text-white px-4 py-2 rounded-lg hover:bg-teal-700">{t("common.search", "Search", "খুঁজুন")}</button>
      </div>

      {loading ? <p className="text-slate-500">{t("common.loading", "Loading…", "লোড হচ্ছে…")}</p> : customers.length === 0 ? (
        <p className="text-slate-500 bg-white rounded-xl shadow p-6">{t("customers.empty", "No customers found.", "কোনো কাস্টমার পাওয়া যায়নি।")}</p>
      ) : (
        <div className="bg-white rounded-xl shadow overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b text-left text-slate-500"><th className="p-3">{t("customers.thName", "Name", "নাম")}</th><th className="p-3">{t("customers.thPhone", "Phone", "ফোন")}</th><th className="p-3">{t("customers.thAddress", "Address", "ঠিকানা")}</th><th className="p-3"></th></tr></thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id} className="border-b hover:bg-orange-50">
                  <td className="p-3 font-medium">{c.name || t("common.unknown", "Unknown", "অজানা")}</td>
                  <td className="p-3">{c.phone || "—"}</td>
                  <td className="p-3">{c.address || "—"}</td>
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
