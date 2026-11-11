"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  authApi,
  clearToken,
  formatDateShort,
  formatTaka,
  getToken,
  type SubscriptionInfo,
  type User,
  type Workspace,
} from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import Icon from "@/components/Icon";

function initials(user: User): string {
  const fromName = (user.name ?? "").trim();
  if (fromName) return fromName.charAt(0).toUpperCase();
  return (user.email ?? "?").charAt(0).toUpperCase();
}

/**
 * Top-right Profile menu in the header.
 *
 * Shows the shop (workspace) name, the user's email and current plan /
 * trial, and the user's profile photo. The photo itself is display-only
 * here — changing it happens on the /profile page (Change only, no
 * Remove). Links to the Profile page and the Business Information
 * section (both on /profile). Log out asks "are you sure?" first;
 * when logged out the menu offers a Log in link instead.
 */
export default function ProfileMenu() {
  const { t } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);
  const [confirmLogout, setConfirmLogout] = useState(false);

  const load = useCallback(async () => {
    if (!getToken()) {
      setUser(null);
      setWorkspace(null);
      setSubscription(null);
      return;
    }
    try {
      const me = await authApi.me();
      setUser(me.user);
      setWorkspace(me.workspace);
      setSubscription(me.subscription ?? null);
    } catch {
      setUser(null);
      setWorkspace(null);
      setSubscription(null);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Close the menu with Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open ]);

  const logout = () => {
    clearToken();
    setOpen(false);
    router.push("/login");
  };

  const loggedIn = !!user;
  const avatarUrl = user?.avatarUrl ?? null;

  const planLine = subscription?.planName ?? subscription?.planSlug ?? null;
  const trialLine =
    subscription?.status === "trial"
      ? subscription.periodEnd
        ? `${t("profile.trialEnds", "Trial ends", "ট্রায়াল শেষ")} ${formatDateShort(subscription.periodEnd)}`
        : t("profile.trial", "Trial", "ট্রায়াল")
      : subscription?.status ?? null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t("profile.openMenu", "Open profile menu", "প্রোফাইল মেনু খুলুন")}
        aria-expanded={open}
        className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full bg-brand text-sm font-bold text-white shadow-sm transition hover:bg-brand-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
      >
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
        ) : loggedIn && user ? (
          initials(user)
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5" aria-hidden="true">
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" />
          </svg>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="absolute right-0 top-full z-50 mt-2 w-72 rounded-xl border border-orange-100 bg-white p-4 shadow-lg">
            {loggedIn && user ? (
              <>
                <div className="flex items-center gap-3 border-b border-orange-100 pb-3">
                  <span className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand text-lg font-bold text-white">
                    {avatarUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
                    ) : (
                      initials(user)
                    )}
                  </span>
                  <span className="min-w-0">
                    <p className="truncate text-sm font-bold text-slate-800">
                      {workspace?.name ?? user.name ?? user.email}
                    </p>
                    <p className="truncate text-xs text-slate-500">{user.email}</p>
                    {user.name && workspace?.name && (
                      <p className="truncate text-xs text-slate-500">{user.name}</p>
                    )}
                  </span>
                </div>

                {/* Plan / Trial / Balance — each row has a small tinted
                    icon tile and the plan name shows as a pill, so the
                    account summary reads like a professional card. */}
                <div className="space-y-2 border-b border-orange-100 py-3 text-sm">
                  {planLine && (
                    <p className="flex items-center gap-2.5">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#EBF1FE] text-brand">
                        <Icon name="tag" className="h-4 w-4" />
                      </span>
                      <span className="text-slate-500">{t("profile.plan", "Plan", "প্ল্যান")}</span>
                      <span className="ml-auto rounded-full bg-[#EBF1FE] px-2.5 py-0.5 text-xs font-semibold text-brand">
                        {planLine}
                      </span>
                    </p>
                  )}
                  {trialLine && (
                    <p className="flex items-center gap-2.5">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#F3EAFE] text-accent-dark">
                        <Icon name="clock" className="h-4 w-4" />
                      </span>
                      <span className="shrink-0 text-slate-500">{t("profile.trial", "Trial", "ট্রায়াল")}</span>
                      <span className="ml-auto text-right font-medium text-slate-700">{trialLine}</span>
                    </p>
                  )}
                  {typeof workspace?.balance_paisa === "number" && (
                    <p className="flex items-center gap-2.5">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-green-100 text-green-600">
                        <Icon name="wallet" className="h-4 w-4" />
                      </span>
                      <span className="text-slate-500">{t("profile.balance", "Balance", "ব্যালেন্স")}</span>
                      <span className="ml-auto font-medium text-slate-700">{formatTaka(workspace.balance_paisa)}</span>
                    </p>
                  )}
                </div>

                <div className="space-y-1 border-b border-orange-100 py-2">
                  <Link
                    href="/profile"
                    onClick={() => setOpen(false)}
                    className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-orange-50"
                  >
                    <Icon name="user" className="h-4 w-4 shrink-0 text-slate-400" />
                    {t("profile.viewProfile", "Profile", "প্রোফাইল")}
                  </Link>
                  <Link
                    href="/profile#business"
                    onClick={() => setOpen(false)}
                    className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-orange-50"
                  >
                    <Icon name="briefcase" className="h-4 w-4 shrink-0 text-slate-400" />
                    {t("profile.businessInfo", "Business Information", "বিজনেস ইনফরমেশন")}
                  </Link>
                </div>

                <button
                  type="button"
                  onClick={() => setConfirmLogout(true)}
                  className="flex w-full items-center gap-2 rounded-lg bg-orange-50 px-4 py-2 text-left text-sm font-medium text-slate-700 transition-colors hover:bg-orange-100"
                >
                  <Icon name="logout" className="h-4 w-4 shrink-0 text-slate-400" />
                  {t("profile.logout", "Log out", "লগআউট")}
                </button>
              </>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-slate-600">
                  {t("profile.notLoggedIn", "Not logged in", "লগইন করা নেই")}
                </p>
                <Link
                  href="/login"
                  onClick={() => setOpen(false)}
                  className="block rounded-lg bg-brand px-4 py-2 text-center text-sm font-medium text-white transition hover:bg-brand-dark"
                >
                  {t("profile.login", "Log in", "লগইন")}
                </Link>
              </div>
            )}
          </div>

          {/* Log out confirmation — asks "are you sure?" first (2026-11-11, user request). */}
          {confirmLogout && (
            <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={t("profile.logoutConfirmTitle", "Log out?", "লগআউট করবেন?")}>
              <div className="absolute inset-0 bg-black/50" onClick={() => setConfirmLogout(false)} aria-hidden="true" />
              <div className="relative w-full max-w-xs rounded-xl border border-[#eeeeee] bg-white p-5 shadow-xl">
                <h3 className="text-base font-bold text-slate-900">{t("profile.logoutConfirmTitle", "Log out?", "লগআউট করবেন?")}</h3>
                <p className="mt-1 text-sm text-slate-600">{t("profile.logoutConfirmBody", "Are you sure you want to log out?", "আপনি কি নিশ্চিত লগআউট করতে চান?")}</p>
                <div className="mt-4 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirmLogout(false)}
                    className="flex-1 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-orange-50"
                  >
                    {t("profile.cancel", "Cancel", "বাতিল")}
                  </button>
                  <button
                    type="button"
                    onClick={logout}
                    className="flex-1 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-700"
                  >
                    {t("profile.logoutConfirmYes", "Yes, log out", "হ্যাঁ, লগআউট করুন")}
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
