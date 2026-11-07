"use client";
import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { authApi } from "@/lib/api";
import { LanguageToggle, useI18n } from "@/lib/i18n";

function ResetPasswordForm() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get("token") || "";
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (password !== confirm) {
      setError(t("auth.passwordsNoMatch", "The two passwords do not match.", "দুটো পাসওয়ার্ড মিলছে না।"));
      return;
    }
    setLoading(true);
    try {
      await authApi.resetPassword({ token, password });
      setDone(true);
      setTimeout(() => router.push("/login"), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.invalidResetLink", "This reset link is invalid or has expired — please request a new one.", "এই রিসেট লিংকটি ভুল বা মেয়াদ শেষ — নতুন লিংক চেয়ে নাও।"));
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
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">{t("auth.resetPassword", "Reset password", "পাসওয়ার্ড বদলাও")}</h1>
              <p className="text-sm text-slate-500">{t("auth.newPassword", "New password", "নতুন পাসওয়ার্ড")}</p>
            </div>
          </div>
          <LanguageToggle />
        </div>
        {!token ? (
          <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
            {t("auth.invalidResetLink", "This reset link is invalid or has expired — please request a new one.", "এই রিসেট লিংকটি ভুল বা মেয়াদ শেষ — নতুন লিংক চেয়ে নাও।")}
          </p>
        ) : done ? (
          <p className="rounded-lg bg-teal-50 p-3 text-sm text-teal-700">
            {t("auth.resetDone", "Password changed — you can now log in with your new password.", "পাসওয়ার্ড বদলে গেছে — এখন নতুন পাসওয়ার্ড দিয়ে লগইন করতে পারবে।")}
          </p>
        ) : (
          <>
            {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">{t("auth.newPassword", "New password", "নতুন পাসওয়ার্ড")}</label>
              <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} className="w-full" placeholder="••••••••" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">{t("auth.confirmPassword", "Confirm new password", "নতুন পাসওয়ার্ড আবার লেখো")}</label>
              <input type="password" required minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} className="w-full" placeholder="••••••••" />
            </div>
            <button disabled={loading} className="w-full rounded-lg bg-brand py-2.5 font-medium text-white shadow-sm transition hover:bg-brand-dark disabled:opacity-50">
              {loading ? t("auth.resetting", "Resetting…", "বদলানো হচ্ছে…") : t("auth.resetPassword", "Reset password", "পাসওয়ার্ড বদলাও")}
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

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPasswordForm />
    </Suspense>
  );
}
