"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { getToken } from "@/lib/api";
import { ownerApi, type OwnerExpense } from "@/lib/api-owner";

const CATEGORIES = ["hosting", "domain", "ai", "ads", "other"] as const;

export default function OwnerExpensesPage() {
  const { t, fmtTaka } = useI18n();
  const router = useRouter();
  const [expenses, setExpenses] = useState<OwnerExpense[]>([]);
  const [totals, setTotals] = useState<Record<string, number>>({});
  const [monthTotal, setMonthTotal] = useState(0);
  const [month, setMonth] = useState("");
  const [isOwner, setIsOwner] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [category, setCategory] = useState<string>("hosting");
  const [amountTaka, setAmountTaka] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async (m?: string) => {
    try {
      const me = await ownerApi.me();
      setIsOwner(me.isOwner);
      if (!me.isOwner) return;
      const d = await ownerApi.expenses(m);
      setExpenses(d.expenses);
      setTotals(d.totalsByCategory);
      setMonthTotal(d.monthTotalPaisa);
      setMonth(d.month);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ownerLoadFail", "Could not load the Owner Panel.", "ওনার প্যানেল লোড করা যায়নি।"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!getToken()) { router.push("/login"); return; }
    load();
  }, [load, router]);

  const add = async () => {
    setError("");
    const amountPaisa = Math.round(Number(amountTaka) * 100);
    if (!Number.isFinite(amountPaisa) || amountPaisa <= 0) {
      setError(t("ownerExpenseAmountError", "Enter an amount in Taka (more than 0).", "টাকার অঙ্ক দিন (০-এর বেশি)।"));
      return;
    }
    setSaving(true);
    try {
      await ownerApi.addExpense({ date, category, amountPaisa, note });
      setAmountTaka("");
      setNote("");
      await load(month || undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ownerExpenseAddFail", "Could not record the expense.", "খরচটি লেখা যায়নি।"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    setError("");
    try {
      await ownerApi.deleteExpense(id);
      await load(month || undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ownerExpenseDeleteFail", "Could not delete the expense.", "খরচটি মোছা যায়নি।"));
    }
  };

  const categoryLabel = (c: string) =>
    c === "hosting" ? t("ownerExpHosting", "Hosting", "হোস্টিং")
    : c === "domain" ? t("ownerExpDomain", "Domain", "ডোমেইন")
    : c === "ai" ? t("ownerExpAi", "AI", "AI")
    : c === "ads" ? t("ownerExpAds", "Ads", "বিজ্ঞাপন")
    : t("ownerExpOther", "Other", "অন্যান্য");

  return (
    <div className="bg-[#FFF1EA] min-h-screen -m-6 p-6">
      <h1 className="text-2xl font-bold mb-1">{t("ownerExpensesTitle", "Expenses", "খরচ")}</h1>
      <p className="text-sm text-slate-500 mb-4">
        {t(
          "ownerExpensesSub",
          "Record business expenses. Expenses are your own bookkeeping — they are NOT deducted from the owner wallet automatically.",
          "ব্যবসার খরচ লিখে রাখুন। খরচ শুধু আপনার হিসাব — এটা ওনার ওয়ালেট থেকে নিজে নিজে কাটা হয় না।"
        )}
      </p>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}
      {loading ? (
        <p className="text-slate-500">{t("loading", "Loading…", "লোড হচ্ছে…")}</p>
      ) : isOwner === false ? (
        <p className="text-slate-500">{t("ownerOnly", "Owner only", "শুধু মালিকের জন্য")}</p>
      ) : (
        <>
          <div className="card p-4 mb-6">
            <h2 className="font-bold mb-3">{t("ownerExpenseAdd", "Add a new expense", "নতুন খরচ লিখুন")}</h2>
            <div className="grid gap-2 sm:grid-cols-2">
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="border rounded-lg px-3 py-2 text-sm" aria-label={t("ownerColDate", "Date", "তারিখ")} />
              <select value={category} onChange={(e) => setCategory(e.target.value)} className="border rounded-lg px-3 py-2 text-sm" aria-label={t("ownerExpCategory", "Category", "খাত")}>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>{categoryLabel(c)}</option>
                ))}
              </select>
              <input value={amountTaka} onChange={(e) => setAmountTaka(e.target.value)} placeholder={t("ownerExpenseAmountPh", "Amount in Taka (e.g. 650)", "টাকার অঙ্ক (যেমন ৬৫০)")} className="border rounded-lg px-3 py-2 text-sm" inputMode="decimal" />
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("ownerExpenseNotePh", "Note (optional)", "মন্তব্য (ঐচ্ছিক)")} className="border rounded-lg px-3 py-2 text-sm" />
            </div>
            <button
              onClick={add}
              disabled={saving || !date || !amountTaka.trim()}
              className="mt-3 bg-[#FF5B2E] hover:bg-[#E8491F] text-white text-sm rounded-lg px-4 py-2 disabled:opacity-50"
            >
              {saving ? t("saving", "Saving…", "সেভ হচ্ছে…") : t("ownerExpenseAddBtn", "Record expense", "খরচ লিখুন")}
            </button>
          </div>

          <div className="flex gap-2 items-center mb-3 flex-wrap">
            <label className="text-sm text-slate-500">{t("ownerExpMonth", "Month", "মাস")}:</label>
            <input type="month" value={month} onChange={(e) => load(e.target.value || undefined)} className="border rounded-lg px-3 py-1 text-sm" />
            <span className="text-sm font-bold">{t("ownerExpMonthTotal", "Month total", "মাসের মোট")}: {fmtTaka(monthTotal)}</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
            {CATEGORIES.map((c) => (
              <div key={c} className="card p-3">
                <p className="text-xs text-slate-500">{categoryLabel(c)}</p>
                <p className="font-bold">{fmtTaka(totals[c] ?? 0)}</p>
              </div>
            ))}
          </div>

          {expenses.length === 0 ? (
            <p className="text-slate-500">{t("ownerExpEmpty", "No expenses this month.", "এই মাসে কোনো খরচ নেই।")}</p>
          ) : (
            <div className="card overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b">
                    <th className="p-3">{t("ownerColDate", "Date", "তারিখ")}</th>
                    <th className="p-3">{t("ownerExpCategory", "Category", "খাত")}</th>
                    <th className="p-3">{t("ownerColAmount", "Amount", "টাকা")}</th>
                    <th className="p-3">{t("ownerColNote", "Note", "মন্তব্য")}</th>
                    <th className="p-3">{t("ownerColActions", "Actions", "কাজ")}</th>
                  </tr>
                </thead>
                <tbody>
                  {expenses.map((e) => (
                    <tr key={e.id} className="border-b last:border-0">
                      <td className="p-3 whitespace-nowrap">{e.date}</td>
                      <td className="p-3">{categoryLabel(e.category)}</td>
                      <td className="p-3">{fmtTaka(e.amountPaisa)}</td>
                      <td className="p-3">{e.note ?? "—"}</td>
                      <td className="p-3">
                        <button onClick={() => remove(e.id)} className="text-sm border border-red-200 text-red-600 rounded-lg px-2 py-1">{t("common.delete", "Delete", "মুছুন")}</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
