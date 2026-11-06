"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { getToken } from "@/lib/api";
import { ownerApi, type ApiCosts } from "@/lib/api-owner";

export default function OwnerApiCostsPage() {
  const { t, fmtTaka, fmtNum } = useI18n();
  const router = useRouter();
  const [data, setData] = useState<ApiCosts | null>(null);
  const [isOwner, setIsOwner] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<"7d" | "30d" | "month">("30d");

  const load = useCallback(async () => {
    try {
      const me = await ownerApi.me();
      setIsOwner(me.isOwner);
      if (!me.isOwner) return;
      const d = await ownerApi.apiCosts(period);
      setData(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ownerLoadFail", "Could not load the Owner Panel.", "ওনার প্যানেল লোড করা যায়নি।"));
    } finally {
      setLoading(false);
    }
  }, [period, t]);

  useEffect(() => {
    if (!getToken()) { router.push("/login"); return; }
    load();
  }, [load, router]);

  const providerName = (p: string) =>
    p === "groq" ? "Groq"
    : p === "openai" ? "ChatGPT (OpenAI)"
    : p === "gemini" ? "Gemini"
    : p === "claude" ? "Claude"
    : p;

  return (
    <div className="bg-[#fff8f3] min-h-screen -m-6 p-6">
      <h1 className="text-2xl font-bold mb-1">{t("ownerApiCostsTitle", "API costs", "API খরচ")}</h1>
      <p className="text-sm text-slate-500 mb-4">
        {t(
          "ownerApiCostsSub",
          "Which AI cost how much. These are the providers' real token costs from the usage ledger — nothing is estimated or invented. Groq is always ৳0.",
          "কোন AI-তে কত খরচ হলো। এগুলো প্রোভাইডারদের আসল টোকেন খরচ, হিসাবের খাতা থেকে নেওয়া — কিছু অনুমান করা হয়নি। Groq সবসময় ৳০।"
        )}
      </p>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}
      {loading ? (
        <p className="text-slate-500">{t("loading", "Loading…", "লোড হচ্ছে…")}</p>
      ) : isOwner === false ? (
        <p className="text-slate-500">{t("ownerOnly", "Owner only", "শুধু মালিকের জন্য")}</p>
      ) : data ? (
        <>
          <div className="flex gap-2 mb-4">
            {(["7d", "30d", "month"] as const).map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`text-sm rounded-lg px-3 py-1 border ${period === p ? "bg-[#ff6a4d] text-white border-[#ff6a4d]" : "border-slate-300"}`}
              >
                {p === "month" ? t("ownerPeriodMonth", "This month", "এই মাস") : p === "7d" ? `7 ${t("ownerDays", "days", "দিন")}` : `30 ${t("ownerDays", "days", "দিন")}`}
              </button>
            ))}
          </div>

          <div className="bg-white rounded-xl shadow p-4 mb-6">
            <p className="text-sm text-slate-500">{t("ownerApiTotal", "Total AI cost", "মোট AI খরচ")}</p>
            <p className="text-2xl font-bold">{fmtTaka(data.totalProviderCostPaisa)}</p>
            <p className="text-xs text-slate-400">{t("ownerApiSince", "Since", "থেকে")} {data.since.slice(0, 10)}</p>
          </div>

          <h2 className="font-bold mb-3">{t("ownerApiByProvider", "By AI provider", "AI অনুযায়ী")}</h2>
          {data.byProvider.length === 0 ? (
            <p className="text-slate-500 mb-6">{t("ownerApiEmpty", "No AI replies in this period.", "এই সময়ে কোনো AI উত্তর দেওয়া হয়নি।")}</p>
          ) : (
            <div className="grid gap-3 mb-6">
              {data.byProvider.map((p) => (
                <div key={p.provider} className="bg-white rounded-xl shadow p-4">
                  <div className="flex justify-between gap-2 flex-wrap">
                    <span className="font-bold">{providerName(p.provider)}</span>
                    <span className="font-bold">{fmtTaka(p.providerCostPaisa)}</span>
                  </div>
                  <p className="text-sm text-slate-500 mt-1">
                    {fmtNum(p.replies)} {t("ownerApiReplies", "replies", "উত্তর")} · {t("ownerApiWalletCharge", "shops were charged", "দোকান থেকে কাটা")} {fmtTaka(p.walletChargePaisa)}
                  </p>
                </div>
              ))}
            </div>
          )}

          <h2 className="font-bold mb-3">{t("ownerApiByShop", "By shop", "দোকান অনুযায়ী")}</h2>
          {data.byShop.length === 0 ? (
            <p className="text-slate-500">{t("ownerApiEmpty", "No AI replies in this period.", "এই সময়ে কোনো AI উত্তর দেওয়া হয়নি।")}</p>
          ) : (
            <div className="bg-white rounded-xl shadow overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b">
                    <th className="p-3">{t("ownerColShop", "Shop", "দোকান")}</th>
                    <th className="p-3">{t("ownerApiReplies", "Replies", "উত্তর")}</th>
                    <th className="p-3">{t("ownerColApiCost", "AI cost", "AI খরচ")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byShop.map((s) => (
                    <tr key={s.workspaceId} className="border-b last:border-0">
                      <td className="p-3 font-bold">{s.shopName}</td>
                      <td className="p-3">{fmtNum(s.replies)}</td>
                      <td className="p-3">{fmtTaka(s.providerCostPaisa)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-slate-400 mt-3">{data.note}</p>
        </>
      ) : null}
    </div>
  );
}
