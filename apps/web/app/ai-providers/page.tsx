"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { ApiError, api, getToken } from "@/lib/api";
import {
  aiProvidersApi,
  type AiProviderInfo,
  type AiProvidersData,
} from "@/lib/api-ai-providers";

// Live statuses from the API (the shared lib type still knows only the
// old three — the new ones arrive over JSON, so widen locally).
type ProviderStatus =
  | "connected"
  | "key_missing"
  | "no_credits"
  | "quota_exhausted"
  | "blocked"
  | "unknown";

interface ProviderInfoExt extends Omit<AiProviderInfo, "status"> {
  status: ProviderStatus;
  keyPresent: boolean;
  canReply: boolean;
  isDefault: boolean;
  statusDetail?: string | null;
  probe?: string;
  checkedAt?: string | null;
  envVar?: string;
}

interface ProvidersDataExt extends Omit<AiProvidersData, "providers"> {
  providers: ProviderInfoExt[];
  defaultProvider?: string;
  probedAt?: string;
}

interface SelectResultExt {
  current: AiProvidersData["current"];
  providers: ProviderInfoExt[];
  warning?: string;
  canReply?: boolean;
  selectedStatus?: ProviderStatus;
  reset?: boolean;
}

interface CheckKeyResult {
  provider: string;
  keyWorks: boolean;
  status: ProviderStatus;
  detail?: string | null;
  replyReady: boolean;
  envVar?: string;
  note?: string;
}

function statusBadge(p: ProviderInfoExt, t: (k: string, en: string, bn: string) => string) {
  if (p.status === "connected") {
    return (
      <span className="text-xs font-bold bg-green-600/10 text-green-600 border border-green-600/30 rounded-full px-2 py-0.5">
        {p.isDefault
          ? t("aiProvDefaultOn", "On • Default", "চালু আছে • ডিফল্ট")
          : t("aiProvConnected", "Connected", "চালু আছে")}
      </span>
    );
  }
  if (p.status === "no_credits") {
    return (
      <span className="text-xs font-bold bg-amber-50 text-amber-700 border border-amber-300 rounded-full px-2 py-0.5">
        {t("aiProvNoCredits", "Key set, no credits — cannot reply", "কী আছে, ক্রেডিট নেই — উত্তর দিতে পারবে না")}
      </span>
    );
  }
  if (p.status === "quota_exhausted") {
    return (
      <span className="text-xs font-bold bg-amber-50 text-amber-700 border border-amber-300 rounded-full px-2 py-0.5">
        {t("aiProvQuotaOut", "Free limit used up", "ফ্রি লিমিট শেষ")}
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
  if (p.status === "unknown") {
    return (
      <span className="text-xs font-bold bg-slate-100 text-slate-500 border border-slate-200 rounded-full px-2 py-0.5">
        {t("aiProvUnknown", "Could not check just now", "যাচাই করা যায়নি")}
      </span>
    );
  }
  return (
    <span className="text-xs font-bold bg-slate-100 text-slate-500 border border-slate-200 rounded-full px-2 py-0.5">
      {t("aiProvNoKey", "No key set", "কী দেওয়া হয়নি")}
    </span>
  );
}

export default function AiProvidersPage() {
  const { t, fmtDate, fmtTaka, lang } = useI18n();
  const router = useRouter();
  const [data, setData] = useState<ProvidersDataExt | null>(null);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState("");
  const [models, setModels] = useState<Record<string, string>>({});
  // Task 14 — AI Provider settings are owner-only (API returns 403 for
  // members/admins). Show that plainly instead of a generic load error.
  const [notOwner, setNotOwner] = useState(false);
  // Claude key check (one-off paste — the key is never stored).
  const [claudeKey, setClaudeKey] = useState("");
  const [checkingKey, setCheckingKey] = useState(false);
  const [keyCheck, setKeyCheck] = useState<CheckKeyResult | null>(null);

  const load = useCallback(async (refresh = false) => {
    try {
      const d = refresh
        ? await api.get<ProvidersDataExt>("/api/ai-providers?refresh=1")
        : ((await aiProvidersApi.get()) as unknown as ProvidersDataExt);
      setData(d);
      const initial: Record<string, string> = {};
      for (const p of d.providers) initial[p.id] = d.current.provider === p.id ? d.current.model : p.defaultModel;
      setModels(initial);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setNotOwner(true);
      } else {
        setError(err instanceof Error ? err.message : t("aiProvLoadFail", "Could not load AI providers.", "AI প্রোভাইডার লোড করা যায়নি।"));
      }
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!getToken()) { router.push("/login"); return; }
    load();
  }, [load, router]);

  const refreshStatus = async () => {
    setError("");
    setRefreshing(true);
    try {
      await load(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("aiProvLoadFail", "Could not load AI providers.", "AI প্রোভাইডার লোড করা যায়নি।"));
    } finally {
      setRefreshing(false);
    }
  };

  const choose = async (providerId: string) => {
    setError("");
    setWarning("");
    setSaving(providerId);
    try {
      const res = (await aiProvidersApi.select(providerId, models[providerId])) as unknown as SelectResultExt;
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

  const checkClaudeKey = async () => {
    setError("");
    setKeyCheck(null);
    setCheckingKey(true);
    try {
      const res = await api.post<CheckKeyResult>("/api/ai-providers/check-key", {
        provider: "claude",
        apiKey: claudeKey.trim(),
      });
      setKeyCheck(res);
      setClaudeKey("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("aiProvKeyCheckFail", "Could not check the key.", "চাবি যাচাই করা যায়নি।"));
    } finally {
      setCheckingKey(false);
    }
  };

  const currentName = data
    ? data.providers.find((p) => p.id === data.current.provider)?.name ?? data.current.provider
    : "";
  const currentInfo = data ? data.providers.find((p) => p.id === data.current.provider) : undefined;
  const currentBroken = !!currentInfo && !currentInfo.canReply;

  return (
    <div>
      <h1 className="page-title">{t("aiProvTitle", "AI Providers", "AI প্রোভাইডার")}</h1>
      {data && (
        <p className="page-subtitle">
          {t(
            "aiProvSub",
            "Four AI models are listed here — Gemini answers your customers by default. You can pick another one, but if it has no key or no credits it will not be able to reply, and you will see a clear warning instead of a silent switch.",
            "এখানে চারটি AI মডেল আছে — ডিফল্টভাবে Gemini আপনার কাস্টমারদের উত্তর দেয়। চাইলে অন্যটাও বেছে নিতে পারেন, কিন্তু সেটার চাবি বা ক্রেডিট না থাকলে সেটা উত্তর দিতে পারবে না — তখন পরিষ্কার সতর্কবার্তা দেখবেন, চুপচাপ বদলে যাবে না।"
          )}
        </p>
      )}
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}
      {warning && <p className="bg-amber-50 text-amber-700 text-sm p-3 rounded-lg mb-4">⚠️ {warning}</p>}

      {notOwner && (
        <div className="card p-4">
          <p className="font-bold">{t("aiProvOwnerOnly", "Only the platform owner can see this", "এটা শুধু প্ল্যাটফর্মের মালিক দেখতে পারেন")}</p>
          <p className="text-sm text-slate-500 mt-1">
            {t(
              "aiProvOwnerOnlySub",
              "AI provider settings are visible only in the platform owner's account.",
              "AI প্রোভাইডারের সেটিংস শুধু প্ল্যাটফর্মের মালিকের অ্যাকাউন্টে দেখা যায়।"
            )}
          </p>
        </div>
      )}

      {loading ? (
        <div className="space-y-2"><div className="skeleton h-12" /><div className="skeleton h-12" /><div className="skeleton h-12" /></div>
      ) : data ? (
        <>
          <div className={`border rounded-xl p-4 mb-6 ${currentBroken ? "bg-amber-50 border-amber-300" : "bg-green-600/10 border-green-600/30"}`}>
            <p className={`font-bold ${currentBroken ? "text-amber-700" : "text-green-600"}`}>
              {t("aiProvCurrent", "Currently answering", "এখন উত্তর দিচ্ছে")} — {currentName} · {data.current.model}
            </p>
            <p className="text-sm mt-1">
              {data.current.explicit
                ? t("aiProvExplicit", "You chose this provider.", "আপনি এই প্রোভাইডারটি বেছে নিয়েছেন।")
                : t("aiProvSystemDefault", "System default (you have not picked one yet).", "সিস্টেমের ডিফল্ট (আপনি এখনো কোনোটা বেছে নেননি)।")}
            </p>
            {currentBroken && currentInfo && (
              <p className="text-sm text-amber-700 font-bold mt-2">
                ⚠️ {currentInfo.name} {t("aiProvCurrentBroken", "cannot reply right now", "এখন উত্তর দিতে পারবে না")}
                {currentInfo.statusDetail ? ` — ${currentInfo.statusDetail}` : ""}
                {t("aiProvCurrentBrokenHint", " Customers will get the backup answer or a labelled demo reply. Switch back to Gemini (default) to be safe.", " কাস্টমাররা ব্যাকআপ উত্তর বা ডেমো উত্তর পাবেন। নিরাপদে থাকতে Gemini-তে (ডিফল্ট) ফিরে যান।")}
              </p>
            )}
            <div className="flex gap-2 mt-3 flex-wrap">
              {data.current.explicit && (
                <button
                  onClick={resetToSystem}
                  disabled={saving === "system"}
                  className="border border-green-600 text-green-600 rounded-lg px-3 py-1 text-sm disabled:opacity-50"
                >
                  {saving === "system"
                    ? t("saving", "Saving…", "সেভ হচ্ছে…")
                    : t("aiProvReset", "Use system default", "সিস্টেমের ডিফল্ট ব্যবহার করুন")}
                </button>
              )}
              <button
                onClick={refreshStatus}
                disabled={refreshing}
                className="border rounded-lg px-3 py-1 text-sm disabled:opacity-50"
              >
                {refreshing
                  ? t("aiProvChecking", "Checking…", "যাচাই হচ্ছে…")
                  : t("aiProvRefresh", "Check status again", "স্ট্যাটাস আবার যাচাই করুন")}
              </button>
            </div>
            {data.probedAt && (
              <p className="text-xs text-slate-400 mt-2">
                {t("aiProvCheckedAt", "Status checked at", "স্ট্যাটাস যাচাই করা হয়েছে")} {fmtDate(data.probedAt)}
              </p>
            )}
          </div>

          <div className="grid gap-3 mb-6">
            {data.providers.map((p) => {
              const isCurrent = data.current.provider === p.id;
              const selectedModel = models[p.id] ?? p.defaultModel;
              return (
                <div key={p.id} className="card p-4">
                  <div className="flex justify-between gap-2 flex-wrap items-center">
                    <span className="font-bold text-lg">
                      {p.name}
                      {p.isDefault && (
                        <span className="ml-2 text-xs font-bold bg-[#0051F6]/10 text-[#0051F6] border border-[#0051F6]/30 rounded-full px-2 py-0.5">
                          {t("aiProvDefault", "Default", "ডিফল্ট")}
                        </span>
                      )}
                    </span>
                    {statusBadge(p, t)}
                  </div>
                  <p className="text-sm text-slate-500 mt-1">{p.costNote}</p>
                  {p.statusDetail && p.status !== "connected" && (
                    <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2 mt-2">{p.statusDetail}</p>
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
                  {p.status === "no_credits" && (
                    <p className="text-sm text-slate-500 mt-2">
                      {t(
                        "aiProvNoCreditsHint",
                        "The key is there, but the account has run out of credits. Top up the provider account and it can answer again — choosing it now will not get replies.",
                        "চাবি আছে, কিন্তু অ্যাকাউন্টের ক্রেডিট শেষ। প্রোভাইডারের অ্যাকাউন্টে ক্রেডিট ভরলে আবার উত্তর দিতে পারবে — এখন বেছে নিলে উত্তর আসবে না।"
                      )}
                    </p>
                  )}
                  {p.mock && (
                    <p className="text-sm text-slate-500 mt-2">
                      {t("aiProvMock", "Test mock is on for this provider (no real API call).", "এই প্রোভাইডারের জন্য পরীক্ষার মক চালু আছে (আসল API-তে কল যাবে না)।")}
                    </p>
                  )}
                  {p.id === "claude" && (
                    <div className="mt-3 border-t pt-3">
                      <p className="text-sm font-bold">
                        {t("aiProvClaudeKeyTitle", "Claude key (optional)", "Claude-এর চাবি (ঐচ্ছিক)")}
                      </p>
                      <p className="text-xs text-slate-500 mt-1">
                        {t(
                          "aiProvClaudeKeyHint",
                          "If you ever want to use Claude, paste its key here to check whether it works. The key is not saved here — it is used for this one check only. For live replies the same key must also be added in the server settings (ANTHROPIC_API_KEY).",
                          "কখনো Claude ব্যবহার করতে চাইলে এখানে তার চাবি বসিয়ে যাচাই করতে পারেন — চাবিটি এখানে সেভ হয় না, শুধু এই একবারের যাচাইয়ে ব্যবহার হয়। লাইভ উত্তরের জন্য একই চাবি সার্ভারের সেটিংসেও (ANTHROPIC_API_KEY) বসাতে হবে।"
                        )}
                      </p>
                      <div className="flex gap-2 mt-2 flex-wrap">
                        <input
                          type="password"
                          value={claudeKey}
                          onChange={(e) => setClaudeKey(e.target.value)}
                          placeholder="sk-ant-…"
                          autoComplete="off"
                          className="border rounded-lg px-3 py-2 text-sm flex-1 min-w-52"
                          aria-label={t("aiProvClaudeKeyTitle", "Claude key (optional)", "Claude-এর চাবি (ঐচ্ছিক)")}
                        />
                        <button
                          onClick={checkClaudeKey}
                          disabled={!claudeKey.trim() || checkingKey}
                          className="border rounded-lg px-3 py-2 text-sm disabled:opacity-50"
                        >
                          {checkingKey
                            ? t("aiProvChecking", "Checking…", "যাচাই হচ্ছে…")
                            : t("aiProvCheckKey", "Check the key", "চাবি যাচাই করুন")}
                        </button>
                      </div>
                      {keyCheck && (
                        <p className={`text-sm mt-2 p-2 rounded-lg border ${keyCheck.keyWorks ? "bg-green-600/10 text-green-600 border-green-600/30" : "bg-red-50 text-red-700 border-red-200"}`}>
                          {keyCheck.keyWorks
                            ? t("aiProvKeyWorks", "This key works.", "এই চাবিটি কাজ করে।")
                            : `${t("aiProvKeyFails", "This key does not work", "এই চাবিটি কাজ করে না")}${keyCheck.detail ? ` — ${keyCheck.detail}` : ""}`}
                          {keyCheck.note ? ` ${keyCheck.note}` : ""}
                        </p>
                      )}
                    </div>
                  )}
                  <div className="flex gap-2 mt-3 flex-wrap items-center">
                    {p.models.length > 1 && (
                      <label className="text-sm flex items-center gap-1">
                        <span className="text-slate-500">{t("aiProvModel", "Model", "মডেল")}:</span>
                        <select
                          value={selectedModel}
                          onChange={(e) => setModels({ ...models, [p.id]: e.target.value })}
                          className="border rounded-lg px-3 py-2 text-sm"
                          aria-label={t("aiProvModel", "Model", "মডেল")}
                        >
                          {p.models.map((m) => (
                            <option key={m} value={m}>{m}</option>
                          ))}
                        </select>
                      </label>
                    )}
                    {p.models.length === 1 && (
                      <span className="text-sm text-slate-500">
                        {t("aiProvModel", "Model", "মডেল")}: {p.models[0]}
                      </span>
                    )}
                    <button
                      onClick={() => choose(p.id)}
                      disabled={saving === p.id || (isCurrent && selectedModel === data.current.model)}
                      className="bg-[#0051F6] hover:bg-[#003EC9] text-white text-sm rounded-lg px-3 py-2 disabled:opacity-50"
                    >
                      {isCurrent && selectedModel === data.current.model
                        ? t("aiProvInUse", "In use", "ব্যবহার হচ্ছে")
                        : saving === p.id
                          ? t("saving", "Saving…", "সেভ হচ্ছে…")
                          : isCurrent
                            ? t("aiProvUseModel", "Use this model", "এই মডেলটি ব্যবহার করুন")
                            : t("aiProvUse", "Use this AI", "এই AI ব্যবহার করুন")}
                    </button>
                    {!p.canReply && (
                      <span className="text-xs text-amber-700">
                        {t("aiProvWillWarn", "Choosing it shows a warning — it cannot reply yet.", "বেছে নিলে সতর্কবার্তা দেখাবে — এটা এখনো উত্তর দিতে পারবে না।")}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <h2 className="font-bold mb-3">{t("aiProvUsageTitle", "Recent AI replies", "সাম্প্রতিক AI উত্তরগুলো")}</h2>
          {data.recentUsage.length === 0 ? (
            <div className="empty-state">{t("aiProvUsageEmpty", "No AI replies yet.", "এখনো কোনো AI উত্তর দেওয়া হয়নি।")}</div>
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
              "Wallet charge is flat: package replies are free (already paid), pay-as-you-go replies cost 23 paisa each. The provider cost shown per reply is what Gemini itself charged us.",
              "ওয়ালেট থেকে কাটা ফ্ল্যাট: প্যাকেজের রিপ্লাই ফ্রি (আগেই কেনা), pay-as-you-go রিপ্লাই ২৩ পয়সা করে। প্রতি রিপ্লাইয়ে দেখানো প্রোভাইডার খরচ হলো Gemini নিজে আমাদের কাছে যা নিলো।"
            )}
          </p>
          <p className="text-xs text-slate-400 mt-1">
            {lang === "bn"
              ? "চাবি কোথায় পাবেন: Gemini — aistudio.google.com; OpenAI — platform.openai.com; Claude — console.anthropic.com; Groq — console.groq.com।"
              : "Where to get the key: Gemini — aistudio.google.com; OpenAI — platform.openai.com; Claude — console.anthropic.com; Groq — console.groq.com."}
          </p>
        </>
      ) : null}
    </div>
  );
}
