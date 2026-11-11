"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useI18n } from "@/lib/i18n";
import { getToken } from "@/lib/api";
import { setupApi, type SetupProgress } from "@/lib/api-new-features";

// Task 15 fake-completion fix (2026-11-11): a step used to be marked Done
// by clicking its "Complete step" button — POST /api/setup/complete-step
// appended the step to a stored flag with no check at all, so Courier /
// Invite Your Team / Go Live showed Done even though the owner never did
// the task. Now each step is computed server-side from real state, and
// clicking a step ONLY navigates to the page where the task is really
// done. The only button that still calls the API is Go Live's "Get test
// code", which the server issues only when the other six steps are
// really done; the step itself completes only after the 5-digit code
// is verified.
const STEP_INFO: { step: string; en: string; bn: string; href: string }[] = [
  { step: "facebook", en: "Connect your Facebook page", bn: "ফেসবুক পেজ যুক্ত করুন", href: "/channels" },
  { step: "business", en: "Business info", bn: "ব্যবসার তথ্য", href: "/profile#business" },
  { step: "products", en: "Add products", bn: "প্রোডাক্ট যোগ করুন", href: "/products" },
  { step: "notifications", en: "Phone notifications", bn: "ফোনে নোটিফিকেশন", href: "/profile" },
  { step: "courier", en: "Courier", bn: "কুরিয়ার", href: "/courier" },
  { step: "team", en: "Invite your team", bn: "টিমকে আমন্ত্রণ জানান", href: "/team" },
  { step: "go-live", en: "Go live", bn: "লাইভ করুন", href: "/setup" },
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

  // Go Live only: ask the server for the 5-digit test code. The server
  // issues it only when the other six steps are really done; nothing
  // here marks any step done.
  const requestTestCode = async () => {
    setError("");
    setBusy("go-live");
    try {
      const res = await setupApi.completeStep("go-live");
      setProgress(res.progress);
      if (res.testCode) {
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
  const otherSixDone = progress?.steps.filter((s) => s.step !== "go-live").every((s) => s.completed) ?? false;

  return (
    <div>
      <h1 className="page-title">{t("setupTitle", "Setup wizard", "সেটআপ উইজার্ড")}</h1>
      <p className="page-subtitle">{t("setupSub", "Seven steps to get your shop live.", "দোকান লাইভ করতে সাতটি ধাপ।")}</p>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}
      {loading ? (
        <div className="space-y-2"><div className="skeleton h-12" /><div className="skeleton h-12" /><div className="skeleton h-12" /></div>
      ) : (
        <>
          <p className="mb-4 font-bold text-[#0051F6]">
            {t("setupCount", `${progress?.completedCount ?? 0} of ${progress?.totalSteps ?? 7} steps done`, `${progress?.completedCount ?? 0} / ${progress?.totalSteps ?? 7} ধাপ শেষ`)}
          </p>
          <div className="grid gap-3">
            {STEP_INFO.map((s, i) => {
              const isDone = done(s.step);
              return (
                <div key={s.step} className="card p-4 flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-3">
                    <span className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-white ${isDone ? "bg-green-600" : "bg-[#0051F6]"}`}>
                      {isDone ? "✓" : i + 1}
                    </span>
                    <div>
                      <p className="font-bold">{t(`setupStep_${s.step}`, s.en, s.bn)}</p>
                      {s.step === "go-live" && (
                        <p className="text-xs text-slate-500">{t("setupGoLiveHint", "Finishing this step gives you a 5-digit test code to enter.", "এই ধাপ শেষ করলে ৫ অঙ্কের একটি টেস্ট কোড পাবেন।")}</p>
                      )}
                      {s.step === "go-live" && !isDone && !otherSixDone && (
                        <p className="text-xs text-slate-500">{t("setupGoLiveBlocked", "Complete the other steps first.", "আগে বাকি ধাপগুলো শেষ করুন।")}</p>
                      )}
                    </div>
                  </div>
                  {isDone ? (
                    <span className="text-green-600 font-bold text-sm">{t("done", "Done", "শেষ")}</span>
                  ) : s.step === "go-live" ? (
                    <button disabled={busy === "go-live" || !otherSixDone} onClick={requestTestCode} className="bg-[#0051F6] hover:bg-[#003EC9] text-white text-sm rounded-lg px-4 py-2 disabled:opacity-50">
                      {busy === "go-live" ? t("setupWorking", "Working…", "কাজ হচ্ছে…") : t("setupGetCode", "Get test code", "টেস্ট কোড নিন")}
                    </button>
                  ) : (
                    <Link href={s.href} className="bg-[#0051F6] hover:bg-[#003EC9] text-white text-sm rounded-lg px-4 py-2 inline-block">
                      {t("setupGoToStep", "Go to step", "ধাপে যান")}
                    </Link>
                  )}
                </div>
              );
            })}
          </div>

          {testCode && (
            <div className="card p-4 mt-6">
              <h2 className="font-bold">{t("setupTestTitle", "Your test code", "আপনার টেস্ট কোড")}</h2>
              <p className="text-3xl font-bold tracking-[0.5em] text-[#0051F6] my-3">{testCode}</p>
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

          {/* Task 14 — the website-chat embed snippet, linked from
              Settings so the owner finds it without hunting. */}
          <div className="card p-4 mt-6">
            <h2 className="font-bold">{t("setupWebsiteChatTitle", "Add chat to your website", "ওয়েবসাইটে চ্যাট যোগ করুন")}</h2>
            <p className="text-sm text-slate-500 mt-1 mb-3">
              {t(
                "setupWebsiteChatSub",
                "Copy the one-line snippet and paste it into your own website — visitors can then chat and their messages appear in your inbox.",
                "এক লাইনের কোডটি কপি করে আপনার ওয়েবসাইটে বসান — ভিজিটররা চ্যাট করতে পারবে, আর তাদের মেসেজ আপনার ইনবক্সে আসবে।"
              )}
            </p>
            <Link href="/website-chat" className="bg-[#0051F6] hover:bg-[#003EC9] text-white text-sm rounded-lg px-4 py-2 inline-block">
              {t("setupWebsiteChatBtn", "Get the chat snippet", "চ্যাটের কোডটি নিন")}
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
