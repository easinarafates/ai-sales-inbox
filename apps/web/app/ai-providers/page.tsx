"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { getToken } from "@/lib/api";
import {
  aiProvidersApi,
  type AiProviderInfo,
  type AiProvidersData,
} from "@/lib/api-ai-providers";

function statusBadge(p: AiProviderInfo, t: (k: string, en: string, bn: string) => string) {
  if (p.status === "connected") {
    return (
      <span className="text-xs font-bold bg-teal-600/10 text-teal-600 border border-teal-600/30 rounded-full px-2 py-0.5">
        {t("aiProvConnected", "Connected", "যুক্ত আছে")}
      </span>
    );
  }
  if (p.status === "blocked") {
    return (
      <span className="text-xs font-bold bg-amber-50 text-amber-700 border border-amber-300 rounded-full px-2 py-0.5">
        {t("aiProvBlocked", "Blocked", "বন্ধ আছে")}
      </span>
    );
  }
  return (
    <span className="text-xs font-bold bg-slate-100 text-slate-500 border border-slate-200 rounded-full px-2 py-0.5">
      {t("aiProvNotConnected", "Not connected", "যুক্ত হয়নি")}
    </span>
  );
}

export default function AiProvidersPage() {
  const { t, fmtDate, fmtTaka, lang } = useI18n();
  const router = useRouter();
  const [data, setData] = useState<AiProvidersData | null>(null);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState("");
  const [models, setModels] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const d = await aiProvidersApi.get();
      setData(d);
      const initial: Record<string, string> = {};
      for (const p of d.providers) initial[p.id] = d.current.provider === p.id ? d.current.model : p.defaultModel;
      setModels(initial);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("aiProvLoadFail", "Could not load AI providers.", "AI প্রোভাইডার লোড করা যায়নি।"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!getToken()) { router.push("/login"); return; }
    load();
  }, [load, router]);

  const choose = async (providerId: string) => {
    setError("");
    setWarning("");
    setSaving(providerId);
    try {
      const res = await aiProvidersApi.select(providerId, models[providerId]);
      if (res.warning) setWarning(res.warning);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("aiProvSaveFail", "Could not change the AI provider.", "AI প্রোভাইডার বদলানো যায়নি।"));
    } finally {
      setSaving("");
    }
  };

  const resetToSystem = async () => {
    setError("");
    setWarning("");
    setSaving("system");
    try {
      await aiProvidersApi.resetToSystem();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("aiProvSaveFail", "Could not change the AI provider.", "AI প্রোভাইডার বদলানো যায়নি।"));
    } finally {
      setSaving("");
    }
  };

  const currentName = data
    ? data.providers.find((p) => p.id === data.current.provider)?.name ?? data.current.provider
    : "";

  return (
    <div className="bg-[#fff8f3] min-h-screen -m-6 p-6">
      <h1 className="text-2xl font-bold mb-1">{t("aiProvTitle", "AI Providers", "AI প্রোভাইডার")}</h1>
      <p className="text-sm text-slate-500 mb-4">
        {t(
          "aiProvSub",
          "Choose which AI answers your customers: Groq (free), ChatGPT, Gemini or Claude. If the chosen AI fails, Groq answers instead and the switch is recorded honestly.",
          "কোন AI আপনার কাস্টমারের উত্তর দেবে তা বেছে নিন: Groq (ফ্রি), ChatGPT, Gemini বা Claude। বেছে নেওয়া AI না চললে Groq উত্তর দেবে, আর সেটা হিসেবে লেখা থাকবে।"
        )}
      </p>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}
      {warning && <p className="bg-amber-50 text-amber-700 text-sm p-3 rounded-lg mb-4">{warning}</p>}

      {loading ? (
        <p className="text-slate-500">{t("loading", "Loading…", "লোড হচ্ছে…")}</p>
      ) : data ? (
        <>
          <div className="bg-teal-600/10 border border-teal-600/30 rounded-xl p-4 mb-6">
            <p className="font-bold text-teal-600">
              {t("aiProvCurrent", "Currently answering", "এখন উত্তর দিচ্ছে")} — {currentName} · {data.current.model}
            </p>
            <p className="text-sm mt-1">
              {data.current.explicit
                ? t("aiProvExplicit", "You chose this provider.", "আপনি এই প্রোভাইডারটি বেছে নিয়েছেন।")
                : t("aiProvSystemDefault", "System default (you have not picked one yet).", "সিস্টেমের ডিফল্ট (আপনি এখনো কোনোটা বেছে নেননি)।")}
            </p>
            {data.current.explicit && (
              <button
                onClick={resetToSystem}
                disabled={saving === "system"}
                className="mt-3 border border-teal-600 text-teal-600 rounded-lg px-3 py-1 text-sm disabled:opacity-50"
              >
                {saving === "system"
                  ? t("saving", "Saving…", "সেভ হচ্ছে…")
                  : t("aiProvReset", "Use system default", "সিস্টেমের ডিফল্ট ব্যবহার করুন")}
              </button>
            )}
          </div>

          <div className="grid gap-3 mb-6">
            {data.providers.map((p) => {
              const isCurrent = data.current.provider === p.id;
              return (
                <div key={p.id} className="card p-4">
                  <div className="flex justify-between gap-2 flex-wrap items-center">
                    <span className="font-bold text-lg">{p.name}</span>
                    {statusBadge(p, t)}
                  </div>
                  <p className="text-sm text-slate-500 mt-1">{p.costNote}</p>
                  {p.status === "blocked" && p.blockedReason && (
                    <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2 mt-2">{p.blockedReason}</p>
                  )}
                  {p.status === "key_missing" && (
                    <p className="text-sm text-slate-500 mt-2">
                      {t(
                        "aiProvKeyMissing",
                        "No API key is set for this provider, so it cannot answer yet. Add the key in the server settings, then choose it here.",
                        "এই প্রোভাইডারের API চাবি বসানো হয়নি, তাই এটা এখনো উত্তর দিতে পারবে না। সার্ভারের সেটিংসে চাবি বসান, তারপর এখানে বেছে নিন।"
                      )}
                    </p>
                  )}
                  {p.mock && (
                    <p className="text-sm text-slate-500 mt-2">
                      {t("aiProvMock", "Test mock is on for this provider (no real API call).", "এই প্রোভাইডারের জন্য পরীক্ষার মক চালু আছে (আসল API-তে কল যাবে না)।")}
                    </p>
                  )}
                  <div className="flex gap-2 mt-3 flex-wrap items-center">
                    {p.models.length > 1 && (
                      <select
                        value={models[p.id] ?? p.defaultModel}
                        onChange={(e) => setModels({ ...models, [p.id]: e.target.value })}
                        className="border rounded-lg px-3 py-2 text-sm"
                        aria-label={t("aiProvModel", "Model", "মডেল")}
                      >
                        {p.models.map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    )}
                    {p.models.length === 1 && (
                      <span className="text-sm text-slate-500">
                        {t("aiProvModel", "Model", "মডেল")}: {p.models[0]}
                      </span>
                    )}
                    <button
                      onClick={() => choose(p.id)}
                      disabled={p.status === "key_missing" || saving === p.id || isCurrent}
                      className="bg-[#ff6a4d] hover:bg-[#e04e33] text-white text-sm rounded-lg px-3 py-2 disabled:opacity-50"
                    >
                      {isCurrent
                        ? t("aiProvInUse", "In use", "ব্যবহার হচ্ছে")
                        : saving === p.id
                          ? t("saving", "Saving…", "সেভ হচ্ছে…")
                          : t("aiProvUse", "Use this AI", "এই AI ব্যবহার করুন")}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <h2 className="font-bold mb-3">{t("aiProvUsageTitle", "Recent AI replies", "সাম্প্রতিক AI উত্তরগুলো")}</h2>
          {data.recentUsage.length === 0 ? (
            <p className="text-slate-500">{t("aiProvUsageEmpty", "No AI replies yet.", "এখনো কোনো AI উত্তর দেওয়া হয়নি।")}</p>
          ) : (
            <div className="card overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b">
                    <th className="p-3">{t("aiProvColWhen", "When", "কখন")}</th>
                    <th className="p-3">{t("aiProvColProvider", "AI", "AI")}</th>
                    <th className="p-3">{t("aiProvColModel", "Model", "মডেল")}</th>
                    <th className="p-3">{t("aiProvColTokens", "Tokens", "টোকেন")}</th>
                    <th className="p-3">{t("aiProvColWallet", "Wallet charge", "ওয়ালেট থেকে কাটা")}</th>
                    <th className="p-3">{t("aiProvColRealCost", "AI cost", "AI-এর খরচ")}</th>
                    <th className="p-3">{t("aiProvColFallback", "Fallback", "বদলি")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentUsage.map((r) => (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="p-3 whitespace-nowrap">{fmtDate(r.created_at)}</td>
                      <td className="p-3">{r.provider}</td>
                      <td className="p-3">{r.model || "—"}</td>
                      <td className="p-3">{Number(r.input_tokens ?? 0) + Number(r.output_tokens ?? 0)}</td>
                      <td className="p-3">{fmtTaka(Number(r.cost_paisa ?? 0))}</td>
                      <td className="p-3">{fmtTaka(Number(r.provider_cost_paisa ?? 0))}</td>
                      <td className="p-3">{r.fallback_from ? `${r.fallback_from} → ${r.provider}` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-slate-400 mt-3">
            {t(
              "aiProvCostNote",
              "Wallet charge follows your plan (included replies are free, overage is the flat 10 paisa). AI cost is what the provider itself charged — Groq is always ৳0.",
              "ওয়ালেট থেকে কাটা আপনার প্ল্যান অনুযায়ী হয় (প্ল্যানের ভেতরের উত্তর ফ্রি, বাড়তি উত্তর ১০ পয়সা)। AI-এর খরচ হলো প্রোভাইডার নিজে যা নিলো — Groq সবসময় ৳০।"
            )}
          </p>
          <p className="text-xs text-slate-400 mt-1">
            {lang === "bn"
              ? "চাবি কোথায় পাবেন: Groq — console.groq.com (ফ্রি), ChatGPT — platform.openai.com, Gemini — aistudio.google.com, Claude — console.anthropic.com।"
              : "Where to get keys: Groq — console.groq.com (free), ChatGPT — platform.openai.com, Gemini — aistudio.google.com, Claude — console.anthropic.com."}
          </p>
        </>
      ) : null}
    </div>
  );
}
