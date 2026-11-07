"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { authApi, getToken, setToken } from "@/lib/api";
import { LanguageToggle, useI18n } from "@/lib/i18n";
import PasswordInput from "@/components/PasswordInput";

export default function SignupPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Already signed in? Go straight to the dashboard instead of showing
  // the signup form again.
  useEffect(() => {
    if (getToken()) router.replace("/inbox");
  }, [router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await authApi.signup({ name, email, password, workspaceName });
      setToken(res.token);
      localStorage.setItem("user", JSON.stringify(res.user));
      localStorage.setItem("workspace", JSON.stringify(res.workspace));
      router.push("/inbox");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.signupFailed", "Sign up failed.", "সাইন আপ ব্যর্থ হয়েছে।"));
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
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">{t("app.name", "AI Sales Inbox", "AI সেলস ইনবক্স")}</h1>
              <p className="text-sm text-slate-500">{t("auth.signupSubtitle", "Open a new account — start with free credit", "নতুন অ্যাকাউন্ট খুলুন — ফ্রি ক্রেডিট দিয়ে শুরু করুন")}</p>
            </div>
          </div>
          <LanguageToggle />
        </div>
        {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">{t("auth.yourName", "Your name", "আপনার নাম")}</label>
          <input required value={name} onChange={(e) => setName(e.target.value)} className="w-full" />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">{t("auth.businessName", "Business name", "ব্যবসার নাম")}</label>
          <input required value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} className="w-full" placeholder={t("auth.businessNamePlaceholder", "e.g. My Shop", "যেমন: আমার শপ")} />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">{t("auth.email", "Email", "ইমেইল")}</label>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="w-full" placeholder="you@example.com" />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">{t("auth.password", "Password", "পাসওয়ার্ড")}</label>
          <PasswordInput required minLength={8} value={password} onChange={setPassword} placeholder={t("auth.passwordPlaceholder", "At least 8 characters", "কমপক্ষে ৮ অক্ষর")} autoComplete="new-password" />
        </div>
        <button disabled={loading} className="w-full rounded-lg bg-brand py-2.5 font-medium text-white shadow-sm transition hover:bg-brand-dark disabled:opacity-50">
          {loading ? t("auth.creatingAccount", "Creating account…", "অ্যাকাউন্ট তৈরি হচ্ছে…") : t("auth.signup", "Sign up", "সাইন আপ")}
        </button>
        <p className="text-center text-sm text-slate-500">
          {t("auth.hasAccount", "Already have an account?", "ইতিমধ্যে অ্যাকাউন্ট আছে?")}{" "}
          <Link href="/login" className="font-medium text-brand-dark underline hover:text-brand">{t("auth.loginLink", "Log in", "লগইন করুন")}</Link>
        </p>
        <p className="text-center text-sm text-slate-500">
          <Link href="/" className="text-teal-700 underline hover:text-teal-800">← {t("landing.backHome", "Back to home", "হোমে ফিরুন")}</Link>
        </p>
      </form>
    </div>
  );
}
