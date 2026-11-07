"use client";
import { useState } from "react";
import Link from "next/link";
import { authApi } from "@/lib/api";
import { LanguageToggle, useI18n } from "@/lib/i18n";

export default function ForgotPasswordPage() {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await authApi.forgotPassword({ email });
      // The API always answers the same way (even for unknown emails),
      // so this screen never reveals whether the email has an account.
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.signupFailed", "Something went wrong.", "কিছু একটা ভুল হয়েছে।"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <form onSubmit={submit} className="w-full max-w-md space-y-4 rounded-2xl border border-orange-100 bg-white p-8 shadow-lg">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand text-base font-bold text-white shadow-sm">AI</span>
            <div className="min-w-0">
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">{t("auth.forgotPassword", "Forgot password?", "পাসওয়ার্ড ভুলে গেছো?")}</h1>
              <p className="text-sm text-slate-500">{t("auth.forgotSubtitle", "Enter the email you signed up with. Email delivery isn't set up yet, so a reset link can't be emailed right now.", "যে ইমেইল দিয়ে সাইন আপ করেছিলে সেটা লেখো। ইমেইল পাঠানো এখনো চালু হয়নি, তাই এখন রিসেট লিংক ইমেইলে যাবে না।")}</p>
            </div>
          </div>
          <LanguageToggle />
        </div>
        {sent ? (
          <p className="rounded-lg bg-teal-50 p-3 text-sm text-teal-700">
            {t("auth.resetLinkSent", "Request saved. No email was sent — email delivery isn't set up yet. To reset your password, please contact the site owner.", "অনুরোধ জমা হয়েছে। কোনো ইমেইল পাঠানো হয়নি — ইমেইল পাঠানো এখনো চালু হয়নি। পাসওয়ার্ড বদলাতে সাইটের মালিকের সাথে যোগাযোগ করো।")}
          </p>
        ) : (
          <>
            {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">{t("auth.email", "Email", "ইমেইল")}</label>
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="w-full" placeholder="you@example.com" />
            </div>
            <button disabled={loading} className="w-full rounded-lg bg-brand py-2.5 font-medium text-white shadow-sm transition hover:bg-brand-dark disabled:opacity-50">
              {loading ? t("auth.sending", "Sending…", "পাঠানো হচ্ছে…") : t("auth.sendResetLink", "Send reset link", "রিসেট লিংক পাঠাও")}
            </button>
          </>
        )}
        <p className="text-center text-sm text-slate-500">
          <Link href="/login" className="font-medium text-brand-dark underline hover:text-brand">{t("auth.backToLogin", "Back to log in", "লগইনে ফিরে যাও")}</Link>
        </p>
      </form>
    </div>
  );
}
