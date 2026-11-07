"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { authApi, getToken, setToken } from "@/lib/api";
import { LanguageToggle, useI18n } from "@/lib/i18n";

export default function LoginPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Already signed in? Go straight to the dashboard instead of showing
  // the login form again.
  useEffect(() => {
    if (getToken()) router.replace("/inbox");
  }, [router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await authApi.login({ email, password });
      setToken(res.token);
      localStorage.setItem("user", JSON.stringify(res.user));
      localStorage.setItem("workspace", JSON.stringify(res.workspace));
      router.push("/inbox");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.loginFailed", "Log in failed.", "লগইন ব্যর্থ হয়েছে।"));
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
              <p className="text-sm text-slate-500">{t("auth.loginSubtitle", "Log in to your account", "লগইন করুন")}</p>
            </div>
          </div>
          <LanguageToggle />
        </div>
        {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">{t("auth.email", "Email", "ইমেইল")}</label>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="w-full" placeholder="you@example.com" />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">{t("auth.password", "Password", "পাসওয়ার্ড")}</label>
          <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} className="w-full" placeholder="••••••••" />
        </div>
        <div className="text-right">
          <Link href="/forgot-password" className="text-sm font-medium text-brand-dark underline hover:text-brand">{t("auth.forgotPassword", "Forgot password?", "পাসওয়ার্ড ভুলে গেছো?")}</Link>
        </div>
        <button disabled={loading} className="w-full rounded-lg bg-brand py-2.5 font-medium text-white shadow-sm transition hover:bg-brand-dark disabled:opacity-50">
          {loading ? t("auth.loggingIn", "Logging in…", "লগইন হচ্ছে…") : t("auth.login", "Log in", "লগইন")}
        </button>
        <p className="text-center text-sm text-slate-500">
          {t("auth.noAccount", "No account yet?", "অ্যাকাউন্ট নেই?")}{" "}
          <Link href="/signup" className="font-medium text-brand-dark underline hover:text-brand">{t("auth.signupLink", "Sign up", "সাইন আপ করুন")}</Link>
        </p>
        <p className="text-center text-xs text-slate-400">
          {t("auth.emailTip", "Use the exact email you signed up with — check the spelling (for example gmail vs gamil).", "সাইন আপের সময়ের হুবহু ইমেইলটা লেখো — বানান দেখে নাও (যেমন gmail নাকি gamil)।")}
        </p>
        <p className="text-center text-sm text-slate-500">
          <Link href="/" className="text-teal-700 underline hover:text-teal-800">← {t("landing.backHome", "Back to home", "হোমে ফিরুন")}</Link>
        </p>
      </form>
    </div>
  );
}
