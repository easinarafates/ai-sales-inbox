"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { authApi, setToken } from "@/lib/api";
import { LanguageToggle, useI18n } from "@/lib/i18n";

export default function SignupPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

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
    <div className="min-h-screen flex items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-md bg-white rounded-xl shadow p-8 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">{t("app.name", "AI Sales Inbox", "AI সেলস ইনবক্স")}</h1>
            <p className="text-slate-500 text-sm">{t("auth.signupSubtitle", "Open a new account — start with free credit", "নতুন অ্যাকাউন্ট খুলুন — ফ্রি ক্রেডিট দিয়ে শুরু করুন")}</p>
          </div>
          <LanguageToggle />
        </div>
        {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg">{error}</p>}
        <div>
          <label className="block text-sm font-medium mb-1">{t("auth.yourName", "Your name", "আপনার নাম")}</label>
          <input required value={name} onChange={(e) => setName(e.target.value)} className="w-full border rounded-lg px-3 py-2" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">{t("auth.businessName", "Business name", "ব্যবসার নাম")}</label>
          <input required value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} className="w-full border rounded-lg px-3 py-2" placeholder={t("auth.businessNamePlaceholder", "e.g. My Shop", "যেমন: আমার শপ")} />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">{t("auth.email", "Email", "ইমেইল")}</label>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="w-full border rounded-lg px-3 py-2" placeholder="you@example.com" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">{t("auth.password", "Password", "পাসওয়ার্ড")}</label>
          <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} className="w-full border rounded-lg px-3 py-2" placeholder={t("auth.passwordPlaceholder", "At least 6 characters", "কমপক্ষে ৬ অক্ষর")} />
        </div>
        <button disabled={loading} className="w-full bg-brand text-white py-2 rounded-lg hover:bg-brand-dark disabled:opacity-50">
          {loading ? t("auth.creatingAccount", "Creating account…", "অ্যাকাউন্ট তৈরি হচ্ছে…") : t("auth.signup", "Sign up", "সাইন আপ")}
        </button>
        <p className="text-sm text-center text-slate-500">
          {t("auth.hasAccount", "Already have an account?", "ইতিমধ্যে অ্যাকাউন্ট আছে?")}{" "}
          <Link href="/login" className="text-brand-dark underline">{t("auth.loginLink", "Log in", "লগইন করুন")}</Link>
        </p>
      </form>
    </div>
  );
}
