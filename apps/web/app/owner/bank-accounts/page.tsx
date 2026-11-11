"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { getToken } from "@/lib/api";
import { ownerApi, type BankAccount } from "@/lib/api-owner";

export default function OwnerBankAccountsPage() {
  const { t } = useI18n();
  const router = useRouter();
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [isOwner, setIsOwner] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [bankName, setBankName] = useState("");
  const [accountHolder, setAccountHolder] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [branch, setBranch] = useState("");
  const [type, setType] = useState("bank");
  const [isPrimary, setIsPrimary] = useState(false);

  const load = useCallback(async () => {
    try {
      const me = await ownerApi.me();
      setIsOwner(me.isOwner);
      if (!me.isOwner) return;
      const d = await ownerApi.bankAccounts();
      setAccounts(d.bankAccounts);
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
    setSaving(true);
    try {
      await ownerApi.addBankAccount({ bankName, accountHolder, accountNumber, branch, type, isPrimary });
      setBankName("");
      setAccountHolder("");
      setAccountNumber("");
      setBranch("");
      setType("bank");
      setIsPrimary(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ownerBankAddFail", "Could not add the bank account.", "ব্যাংক অ্যাকাউন্ট যোগ করা যায়নি।"));
    } finally {
      setSaving(false);
    }
  };

  const makePrimary = async (id: string) => {
    setError("");
    try {
      await ownerApi.updateBankAccount(id, { isPrimary: true });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ownerBankUpdateFail", "Could not update the bank account.", "ব্যাংক অ্যাকাউন্ট বদলানো যায়নি।"));
    }
  };

  const remove = async (id: string) => {
    setError("");
    try {
      await ownerApi.deleteBankAccount(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ownerBankDeleteFail", "Could not delete the bank account.", "ব্যাংক অ্যাকাউন্ট মোছা যায়নি।"));
    }
  };

  return (
    <div>
      <h1 className="page-title">{t("ownerBankAccountsTitle", "Bank accounts", "ব্যাংক অ্যাকাউন্ট")}</h1>
      <p className="page-subtitle">
        {t(
          "ownerBankAccountsSub",
          "Accounts where subscription money is received. Account numbers are encrypted and only the last 4 digits are shown — the full number is never displayed.",
          "যেসব অ্যাকাউন্টে সাবস্ক্রিপশনের টাকা আসবে। অ্যাকাউন্ট নম্বর এনক্রিপ্ট করে রাখা হয়, শুধু শেষ ৪ সংখ্যা দেখানো হয় — পুরো নম্বর কখনো দেখানো হয় না।"
        )}
      </p>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}
      {loading ? (
        <div className="space-y-2"><div className="skeleton h-12" /><div className="skeleton h-12" /><div className="skeleton h-12" /></div>
      ) : isOwner === false ? (
        <p className="text-slate-500">{t("ownerOnly", "Owner only", "শুধু মালিকের জন্য")}</p>
      ) : (
        <>
          <div className="card p-4 mb-6">
            <h2 className="font-bold mb-3">{t("ownerBankAdd", "Add an account", "অ্যাকাউন্ট যোগ করুন")}</h2>
            <div className="grid gap-2 sm:grid-cols-2">
              <select value={type} onChange={(e) => setType(e.target.value)} className="border rounded-lg px-3 py-2 text-sm" aria-label={t("ownerBankType", "Type", "ধরন")}>
                <option value="bank">{t("ownerBankTypeBank", "Bank", "ব্যাংক")}</option>
                <option value="bkash">bKash</option>
                <option value="nagad">Nagad</option>
                <option value="rocket">Rocket</option>
              </select>
              <input value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder={t("ownerBankNamePh", "Bank name (e.g. Dutch-Bangla Bank)", "ব্যাংকের নাম (যেমন ডাচ-বাংলা ব্যাংক)")} className="border rounded-lg px-3 py-2 text-sm" />
              <input value={accountHolder} onChange={(e) => setAccountHolder(e.target.value)} placeholder={t("ownerBankHolderPh", "Account holder name", "অ্যাকাউন্টধারীর নাম")} className="border rounded-lg px-3 py-2 text-sm" />
              <input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} placeholder={t("ownerBankNumberPh", "Account / wallet number", "অ্যাকাউন্ট / ওয়ালেট নম্বর")} className="border rounded-lg px-3 py-2 text-sm" inputMode="numeric" />
              <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder={t("ownerBankBranchPh", "Branch (optional)", "শাখা (ঐচ্ছিক)")} className="border rounded-lg px-3 py-2 text-sm" />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} />
                {t("ownerBankPrimary", "Make this the primary account", "এটাকে প্রধান অ্যাকাউন্ট করুন")}
              </label>
            </div>
            <button
              onClick={add}
              disabled={saving || !bankName.trim() || !accountHolder.trim() || !accountNumber.trim()}
              className="mt-3 bg-[#0051F6] hover:bg-[#003EC9] text-white text-sm rounded-lg px-4 py-2 disabled:opacity-50"
            >
              {saving ? t("saving", "Saving…", "সেভ হচ্ছে…") : t("ownerBankAddBtn", "Add account", "অ্যাকাউন্ট যোগ করুন")}
            </button>
          </div>

          {accounts.length === 0 ? (
            <div className="empty-state">{t("ownerBankEmpty", "No bank accounts yet.", "এখনো কোনো ব্যাংক অ্যাকাউন্ট নেই।")}</div>
          ) : (
            <div className="grid gap-3">
              {accounts.map((a) => (
                <div key={a.id} className="card p-4">
                  <div className="flex justify-between gap-2 flex-wrap items-center">
                    <span className="font-bold">{a.bankName} {a.isPrimary && <span className="text-xs font-bold bg-green-600/10 text-green-600 border border-green-600/30 rounded-full px-2 py-0.5 ml-1">{t("ownerPrimary", "Primary", "প্রধান")}</span>}</span>
                    <span className="text-sm text-slate-500">{a.type === "bank" ? t("ownerBankTypeBank", "Bank", "ব্যাংক") : a.type}</span>
                  </div>
                  <p className="text-sm mt-1">{a.accountHolder} · {a.accountNumberMasked}</p>
                  {a.branch && <p className="text-sm text-slate-500">{t("ownerBankBranch", "Branch", "শাখা")}: {a.branch}</p>}
                  <div className="flex gap-2 mt-3">
                    {!a.isPrimary && (
                      <button onClick={() => makePrimary(a.id)} className="text-sm border border-slate-300 rounded-lg px-2 py-1">{t("ownerBankMakePrimary", "Make primary", "প্রধান করুন")}</button>
                    )}
                    <button onClick={() => remove(a.id)} className="text-sm border border-red-200 text-red-600 rounded-lg px-2 py-1">{t("common.delete", "Delete", "মুছুন")}</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
