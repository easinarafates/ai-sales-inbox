"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  asArrayOf,
  couponDiscountPaisa,
  couponsApi,
  getToken,
  type Coupon,
  type CouponType,
  type CouponValidateResult,
} from "@/lib/api";
import { useI18n } from "@/lib/i18n";

const TYPE_KEYS: Record<string, string> = {
  percent: "coupons.typePercent",
  amount: "coupons.typeAmount",
  free_delivery: "coupons.typeFreeDelivery",
};
const TYPE_FALLBACK: Record<string, [string, string]> = {
  percent: ["Percentage off (%)", "শতাংশ ছাড় (%)"],
  amount: ["Off in Taka", "টাকায় ছাড়"],
  free_delivery: ["Free delivery", "ফ্রি ডেলিভারি"],
};

export default function CouponsPage() {
  const router = useRouter();
  const { t, fmtDate, fmtTaka, fmtNum } = useI18n();
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [code, setCode] = useState("");
  const [type, setType] = useState<CouponType>("percent");
  const [value, setValue] = useState("");
  const [expiresAt, setExpiresAt] = useState("");

  // Validate tester
  const [testCode, setTestCode] = useState("");
  const [testSubtotal, setTestSubtotal] = useState("");
  const [testResult, setTestResult] = useState<CouponValidateResult | null>(null);
  const [testing, setTesting] = useState(false);

  const typeLabel = (ty: string) => {
    const fb = TYPE_FALLBACK[ty] || [ty, ty];
    return t(TYPE_KEYS[ty] || "", fb[0], fb[1]);
  };

  const load = useCallback(async () => {
    try {
      const data = await couponsApi.list();
      setCoupons(asArrayOf<Coupon>(data, ["coupons"]));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("coupons.loadFailed", "Could not load coupons.", "কুপন লোড করা যায়নি।"));
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
      await couponsApi.create({
        code: code.trim().toUpperCase(),
        type,
        /**
   * Amount-type coupons are entered in Taka in the UI; the backend stores
   * value in paisa (like prices). Percent stays as-is (10 = 10%).
   */
  value: type === "amount" ? Math.round(parseFloat(value || "0") * 100) : parseFloat(value || "0"),
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
      });
      setCode(""); setValue(""); setExpiresAt("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("coupons.createFailed", "Could not create the coupon.", "কুপন তৈরি করা যায়নি।"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm(t("coupons.deleteConfirm", "Delete this coupon?", "এই কুপনটি মুছে ফেলবেন?"))) return;
    setError("");
    try {
      await couponsApi.remove(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("coupons.deleteFailed", "Could not delete the coupon.", "কুপন মোছা যায়নি।"));
    }
  };

  const testValidate = async (e: React.FormEvent) => {
    e.preventDefault();
    setTestResult(null);
    setTesting(true);
    setError("");
    try {
      const res = await couponsApi.validate(
        testCode.trim().toUpperCase(),
        Math.round(parseFloat(testSubtotal || "0") * 100)
      );
      setTestResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("coupons.validateFailed", "Could not check.", "যাচাই করা যায়নি।"));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">{t("coupons.title", "Coupons", "কুপন")}</h1>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}

      <form onSubmit={create} className="bg-white rounded-xl shadow p-4 mb-6 grid grid-cols-1 md:grid-cols-2 gap-3">
        <h2 className="font-bold md:col-span-2">{t("coupons.createTitle", "Create a new coupon", "নতুন কুপন তৈরি করুন")}</h2>
        <input required value={code} onChange={(e) => setCode(e.target.value)} placeholder={t("coupons.codePlaceholder", "Coupon code (e.g. EID10) *", "কুপন কোড (যেমন: EID10) *")} className="border rounded-lg px-3 py-2" />
        <select value={type} onChange={(e) => setType(e.target.value as CouponType)} className="border rounded-lg px-3 py-2 bg-white">
          <option value="percent">{typeLabel("percent")}</option>
          <option value="amount">{typeLabel("amount")}</option>
          <option value="free_delivery">{typeLabel("free_delivery")}</option>
        </select>
        <input required={type !== "free_delivery"} type="number" min="0" step="0.01" value={value} onChange={(e) => setValue(e.target.value)} placeholder={type === "percent" ? t("coupons.valuePercentPlaceholder", "Value (e.g. 10 = 10%)", "মান (যেমন: 10 = ১০%)") : t("coupons.valueAmountPlaceholder", "Value (Taka)", "মান (টাকা)")} className="border rounded-lg px-3 py-2" />
        <input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className="border rounded-lg px-3 py-2 bg-white" />
        <button disabled={saving} className="bg-brand text-white py-2 rounded-lg md:col-span-2 hover:bg-brand-dark disabled:opacity-50">
          {saving ? t("coupons.creating", "Creating…", "তৈরি হচ্ছে…") : t("coupons.createButton", "Create coupon", "কুপন তৈরি করুন")}
        </button>
      </form>

      {/* Validate tester */}
      <form onSubmit={testValidate} className="bg-white rounded-xl shadow p-4 mb-6">
        <h2 className="font-bold mb-3">{t("coupons.testTitle", "Check a coupon", "কুপন যাচাই করে দেখুন")}</h2>
        <div className="flex flex-wrap gap-2">
          <input required value={testCode} onChange={(e) => setTestCode(e.target.value)} placeholder={t("coupons.testCodePlaceholder", "Coupon code", "কুপন কোড")} className="border rounded-lg px-3 py-2 flex-1 min-w-40" />
          <input required type="number" min="0" step="0.01" value={testSubtotal} onChange={(e) => setTestSubtotal(e.target.value)} placeholder={t("coupons.testSubtotalPlaceholder", "Order total (৳)", "অর্ডারের মোট (৳)")} className="border rounded-lg px-3 py-2 w-44" />
          <button disabled={testing} className="bg-teal-600 text-white px-4 py-2 rounded-lg hover:bg-teal-700 disabled:opacity-50">
            {testing ? t("coupons.testing", "Checking…", "যাচাই হচ্ছে…") : t("coupons.testButton", "Check", "যাচাই করুন")}
          </button>
        </div>
        {testResult && (
          <p className={`mt-3 text-sm p-3 rounded-lg ${testResult.valid ? "bg-teal-50 text-teal-800" : "bg-red-50 text-red-700"}`}>
            {testResult.valid
              ? `${t("coupons.validPrefix", "✅ This coupon applies — discount:", "✅ কুপনটি প্রযোজ্য — ছাড়:")} ${fmtTaka(couponDiscountPaisa(testResult))}${testResult.freeDelivery || testResult.free_delivery ? t("coupons.validFreeDelivery", " + free delivery", " + ফ্রি ডেলিভারি") : ""}`
              : `${t("coupons.invalidPrefix", "❌ ", "❌ ")}${testResult.message || t("coupons.invalidDefault", "This coupon does not apply.", "কুপনটি প্রযোজ্য নয়।")}`}
          </p>
        )}
      </form>

      {loading ? <p className="text-slate-500">{t("common.loading", "Loading…", "লোড হচ্ছে…")}</p> : coupons.length === 0 ? (
        <p className="text-slate-500 bg-white rounded-xl shadow p-6">{t("coupons.empty", "No coupons yet. Create one from the form above.", "কোনো কুপন নেই। উপরের ফর্ম থেকে তৈরি করুন।")}</p>
      ) : (
        <div className="bg-white rounded-xl shadow overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b text-left text-slate-500"><th className="p-3">{t("coupons.thCode", "Code", "কোড")}</th><th className="p-3">{t("coupons.thType", "Type", "ধরন")}</th><th className="p-3">{t("coupons.thValue", "Value", "মান")}</th><th className="p-3">{t("coupons.thExpiry", "Expiry", "মেয়াদ")}</th><th className="p-3"></th></tr></thead>
            <tbody>
              {coupons.map((c) => (
                <tr key={c.id} className="border-b hover:bg-orange-50">
                  <td className="p-3 font-medium">{c.code}</td>
                  <td className="p-3">{typeLabel(c.type || "")}</td>
                  <td className="p-3">{c.type === "percent" ? `${c.value != null ? fmtNum(c.value) : "—"}%` : c.type === "free_delivery" ? t("common.freeDelivery", "Free delivery", "ফ্রি ডেলিভারি") : fmtTaka(c.value ?? 0)}</td>
                  <td className="p-3">{fmtDate(c.expiresAt || c.expires_at)}</td>
                  <td className="p-3 text-right">
                    <button onClick={() => remove(c.id)} className="text-red-600 underline text-sm">{t("coupons.delete", "Delete", "মুছুন")}</button>
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
