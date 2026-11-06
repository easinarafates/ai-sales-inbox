"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { authApi, setToken } from "@/lib/api";
import { LanguageToggle, useI18n } from "@/lib/i18n";

export default function LoginPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

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
    <div className="min-h-screen flex items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-md bg-white rounded-xl shadow p-8 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">{t("app.name", "AI Sales Inbox", "AI সেলস ইনবক্স")}</h1>
            <p className="text-slate-500 text-sm">{t("auth.loginSubtitle", "Log in to your account", "লগইন করুন")}</p>
          </div>
          <LanguageToggle />
        </div>
        {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg">{error}</p>}
        <div>
          <label className="block text-sm font-medium mb-1">{t("auth.email", "Email", "ইমেইল")}</label>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="w-full border rounded-lg px-3 py-2" placeholder="you@example.com" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">{t("auth.password", "Password", "পাসওয়ার্ড")}</label>
          <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} className="w-full border rounded-lg px-3 py-2" placeholder="••••••••" />
        </div>
        <button disabled={loading} className="w-full bg-brand text-white py-2 rounded-lg hover:bg-brand-dark disabled:opacity-50">
          {loading ? t("auth.loggingIn", "Logging in…", "লগইন হচ্ছে…") : t("auth.login", "Log in", "লগইন")}
        </button>
        <p className="text-sm text-center text-slate-500">
          {t("auth.noAccount", "No account yet?", "অ্যাকাউন্ট নেই?")}{" "}
          <Link href="/signup" className="text-brand-dark underline">{t("auth.signupLink", "Sign up", "সাইন আপ করুন")}</Link>
        </p>
      </form>
    </div>
  );
}
