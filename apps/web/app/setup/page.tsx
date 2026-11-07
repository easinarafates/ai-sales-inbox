"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { getToken } from "@/lib/api";
import { setupApi, type SetupProgress } from "@/lib/api-new-features";

const STEP_INFO: { step: string; en: string; bn: string }[] = [
  { step: "facebook", en: "Connect your Facebook page", bn: "ফেসবুক পেজ যুক্ত করুন" },
  { step: "business", en: "Business info", bn: "ব্যবসার তথ্য" },
  { step: "products", en: "Add products", bn: "প্রোডাক্ট যোগ করুন" },
  { step: "notifications", en: "Phone notifications", bn: "ফোনে নোটিফিকেশন" },
  { step: "courier", en: "Courier", bn: "কুরিয়ার" },
  { step: "team", en: "Invite your team", bn: "টিমকে আমন্ত্রণ জানান" },
  { step: "go-live", en: "Go live", bn: "লাইভ করুন" },
];

export default function SetupPage() {
  const { t } = useI18n();
  const router = useRouter();
  const [progress, setProgress] = useState<SetupProgress | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [testCode, setTestCode] = useState("");
  const [verifyCode, setVerifyCode] = useState("");
  const [verifyMsg, setVerifyMsg] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await setupApi.progress();
      setProgress(data.progress);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("setupLoadFail", "Could not load setup progress.", "সেটআপের অগ্রগতি লোড করা যায়নি।"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!getToken()) { router.push("/login"); return; }
    load();
  }, [load, router]);

  const complete = async (step: string) => {
    setError("");
    setBusy(step);
    try {
      const res = await setupApi.completeStep(step);
      setProgress(res.progress);
      if (step === "go-live" && res.testCode) {
        setTestCode(res.testCode);
        setVerifyMsg(t("setupCodeIssued", "Your test code is below. Enter it to verify and go live.", "আপনার টেস্ট কোড নিচে দেওয়া আছে। যাচাই করে লাইভ করতে সেটি লিখুন।"));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("setupStepFail", "Could not complete this step.", "এই ধাপটি সম্পন্ন করা যায়নি।"));
    } finally {
      setBusy("");
    }
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    setVerifyMsg("");
    setError("");
    try {
      const res = await setupApi.verifyTest(verifyCode.trim());
      setProgress(res.progress);
      setVerifyMsg(t("setupVerified", "Verified! Your shop is now live.", "যাচাই হয়েছে! আপনার দোকান এখন লাইভ।"));
      setTestCode("");
      setVerifyCode("");
    } catch (err) {
      setVerifyMsg(err instanceof Error ? err.message : t("setupWrongCode", "Wrong test code — try again.", "ভুল টেস্ট কোড — আবার চেষ্টা করুন।"));
    }
  };

  const done = (step: string) => progress?.steps.find((s) => s.step === step)?.completed ?? false;

  return (
    <div className="bg-[#FFF1EA] min-h-screen -m-6 p-6">
      <h1 className="page-title">{t("setupTitle", "Setup wizard", "সেটআপ উইজার্ড")}</h1>
      <p className="page-subtitle">{t("setupSub", "Seven steps to get your shop live.", "দোকান লাইভ করতে সাতটি ধাপ।")}</p>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}
      {loading ? (
        <p className="text-slate-500">{t("loading", "Loading…", "লোড হচ্ছে…")}</p>
      ) : (
        <>
          <p className="mb-4 font-bold text-[#FF5B2E]">
            {t("setupCount", `${progress?.completedCount ?? 0} of ${progress?.totalSteps ?? 7} steps done`, `${progress?.completedCount ?? 0} / ${progress?.totalSteps ?? 7} ধাপ শেষ`)}
          </p>
          <div className="grid gap-3">
            {STEP_INFO.map((s, i) => {
              const isDone = done(s.step);
              return (
                <div key={s.step} className="card p-4 flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-3">
                    <span className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-white ${isDone ? "bg-green-600" : "bg-[#FF5B2E]"}`}>
                      {isDone ? "✓" : i + 1}
                    </span>
                    <div>
                      <p className="font-bold">{t(`setupStep_${s.step}`, s.en, s.bn)}</p>
                      {s.step === "go-live" && (
                        <p className="text-xs text-slate-500">{t("setupGoLiveHint", "Finishing this step gives you a 5-digit test code to enter.", "এই ধাপ শেষ করলে ৫ অঙ্কের একটি টেস্ট কোড পাবেন।")}</p>
                      )}
                    </div>
                  </div>
                  {isDone ? (
                    <span className="text-green-600 font-bold text-sm">{t("done", "Done", "শেষ")}</span>
                  ) : (
                    <button disabled={busy === s.step} onClick={() => complete(s.step)} className="bg-[#FF5B2E] hover:bg-[#E8491F] text-white text-sm rounded-lg px-4 py-2 disabled:opacity-50">
                      {busy === s.step ? t("setupWorking", "Working…", "কাজ হচ্ছে…") : t("setupComplete", "Complete step", "ধাপটি শেষ করুন")}
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {testCode && (
            <div className="card p-4 mt-6">
              <h2 className="font-bold">{t("setupTestTitle", "Your test code", "আপনার টেস্ট কোড")}</h2>
              <p className="text-3xl font-bold tracking-[0.5em] text-[#FF5B2E] my-3">{testCode}</p>
              <p className="text-sm text-slate-500 mb-3">{verifyMsg || t("setupEnterCode", "Enter the code below to verify.", "যাচাই করতে নিচে কোডটি লিখুন।")}</p>
              <form onSubmit={verify} className="flex gap-2">
                <input required value={verifyCode} onChange={(e) => setVerifyCode(e.target.value)} placeholder="12345" maxLength={5} className="border rounded-lg px-3 py-2 w-32" />
                <button className="bg-green-600 hover:bg-green-700 text-white rounded-lg px-4 py-2">{t("setupVerify", "Verify", "যাচাই করুন")}</button>
              </form>
            </div>
          )}
          {!testCode && verifyMsg && (
            <p className="bg-green-600/10 text-green-600 text-sm p-3 rounded-lg mt-6">{verifyMsg}</p>
          )}
          {progress?.goLive && (
            <p className="bg-green-600/10 text-green-600 font-bold p-4 rounded-xl mt-6">{t("setupLive", "Your shop is live! 🎉", "আপনার দোকান লাইভ! 🎉")}</p>
          )}
        </>
      )}
    </div>
  );
}
