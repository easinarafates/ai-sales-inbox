"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { authApi, getToken, setToken } from "@/lib/api";
import { LanguageToggle, useI18n } from "@/lib/i18n";
import PasswordInput from "@/components/PasswordInput";

function SignupForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Task 16 — team-invite acceptance: /signup?invite=<token> joins the
  // invited shop with the invited role. The invited email is fixed by
  // the invite and cannot be changed here.
  const inviteToken = searchParams.get("invite") ?? "";
  const [invite, setInvite] = useState<{ email: string; role: string; workspaceName: string } | null>(null);
  const [inviteError, setInviteError] = useState("");
  const [inviteLoading, setInviteLoading] = useState(Boolean(inviteToken));

  useEffect(() => {
    if (!inviteToken) return;
    authApi
      .inviteInfo(inviteToken)
      .then((info) => {
        setInvite(info);
        setEmail(info.email);
      })
      .catch((err) => {
        setInviteError(err instanceof Error ? err.message : t("auth.inviteInvalid", "This invite link is invalid, revoked, or already used.", "এই আমন্ত্রণের লিংকটি ভুল, বাতিল, বা ইতিমধ্যে ব্যবহার করা হয়েছে।"));
      })
      .finally(() => setInviteLoading(false));
  }, [inviteToken, t]);

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
      if (invite) {
        const res = await authApi.acceptInvite({ token: inviteToken, name, password });
        setToken(res.token);
        localStorage.setItem("user", JSON.stringify(res.user));
        localStorage.setItem("workspace", JSON.stringify(res.workspace));
        router.push("/inbox");
        return;
      }
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
            <img src="/logo.png" alt="YEARBITO" className="h-11 w-11 shrink-0 rounded-xl object-cover shadow-sm" />
            <div className="min-w-0">
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">{t("app.name", "YEARBITO", "YEARBITO")}</h1>
              <p className="text-sm text-slate-500">
                {invite
                  ? t("auth.inviteSubtitle", "You were invited to join a shop", "একটি দোকানে যোগ দিতে আপনাকে আমন্ত্রণ জানানো হয়েছে")
                  : t("auth.signupSubtitle", "Open a new account — start with free credit", "নতুন অ্যাকাউন্ট খুলুন — ফ্রি ক্রেডিট দিয়ে শুরু করুন")}
              </p>
              <p className="text-sm font-semibold text-brand">{t("landing.tagline", "Your Ideas, Amplified.", "Your Ideas, Amplified.")}</p>
            </div>
          </div>
          <LanguageToggle />
        </div>
        {inviteLoading && <p className="text-sm text-slate-500">{t("auth.inviteLoading", "Checking your invite…", "আপনার আমন্ত্রণ যাচাই করা হচ্ছে…")}</p>}
        {inviteError && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{inviteError}</p>}
        {invite && (
          <p className="rounded-lg bg-[#EBF1FE] p-3 text-sm text-slate-700">
            {t("auth.inviteFor", "You are joining", "আপনি যোগ দিচ্ছেন")} <strong>{invite.workspaceName}</strong> {t("auth.inviteAs", "as", "হিসেবে")} <strong>{invite.role}</strong>.
          </p>
        )}
        {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">{t("auth.yourName", "Your name", "আপনার নাম")}</label>
          <input required value={name} onChange={(e) => setName(e.target.value)} className="w-full" />
        </div>
        {!invite && (
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">{t("auth.businessName", "Business name", "ব্যবসার নাম")}</label>
            <input required value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} className="w-full" placeholder={t("auth.businessNamePlaceholder", "e.g. My Shop", "যেমন: আমার শপ")} />
          </div>
        )}
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">{t("auth.email", "Email", "ইমেইল")}</label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            readOnly={Boolean(invite)}
            className="w-full disabled:bg-slate-50"
            placeholder="you@example.com"
          />
          {invite && <p className="text-xs text-slate-400 mt-1">{t("auth.inviteEmailFixed", "This email was set by the invite and cannot be changed.", "এই ইমেইলটি আমন্ত্রণে দেওয়া হয়েছে, বদলানো যাবে না।")}</p>}
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">{t("auth.password", "Password", "পাসওয়ার্ড")}</label>
          <PasswordInput required minLength={8} value={password} onChange={setPassword} placeholder={t("auth.passwordPlaceholder", "At least 8 characters", "কমপক্ষে ৮ অক্ষর")} autoComplete="new-password" />
        </div>
        <button disabled={loading || inviteLoading || (Boolean(inviteToken) && !invite)} className="w-full rounded-lg bg-brand py-2.5 font-medium text-white shadow-sm transition hover:bg-brand-dark disabled:opacity-50">
          {loading
            ? t("auth.creatingAccount", "Creating account…", "অ্যাকাউন্ট তৈরি হচ্ছে…")
            : invite
              ? t("auth.joinShop", "Join the shop", "দোকানে যোগ দিন")
              : t("auth.signup", "Sign up", "সাইন আপ করুন")}
        </button>
        {!invite && (
          <p className="text-center text-xs text-slate-500">
            {t("auth.agreeTerms", "By signing up, you agree to our", "সাইন আপ করলে আপনি আমাদের")}{" "}
            <Link href="/terms" className="font-medium text-brand-dark underline hover:text-brand">{t("auth.termsLink", "Terms of Service", "ব্যবহারের শর্ত")}</Link>{" "}
            {t("auth.and", "and", "এবং")}{" "}
            <Link href="/privacy" className="font-medium text-brand-dark underline hover:text-brand">{t("auth.privacyLink", "Privacy Policy", "প্রাইভেসি পলিসি")}</Link>
            {t("auth.agreeEnd", ".", " মেনে নিচ্ছেন।")}
          </p>
        )}
        <p className="text-center text-sm text-slate-500">
          {t("auth.hasAccount", "Already have an account?", "ইতিমধ্যে অ্যাকাউন্ট আছে?")}{" "}
          <Link href="/login" className="font-medium text-brand-dark underline hover:text-brand">{t("auth.loginLink", "Log in", "লগইন করুন")}</Link>
        </p>
        <p className="text-center text-sm text-slate-500">
          <Link href="/" className="text-green-700 underline hover:text-green-800">← {t("landing.backHome", "Back to home", "হোমে ফিরুন")}</Link>
        </p>
      </form>
    </div>
  );
}

export default function SignupPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-background p-4"><p className="text-sm text-slate-500">Loading…</p></div>}>
      <SignupForm />
    </Suspense>
  );
}
