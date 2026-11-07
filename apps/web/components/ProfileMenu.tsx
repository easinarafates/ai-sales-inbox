"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  authApi,
  clearToken,
  formatDate,
  formatTaka,
  getToken,
  profileApi,
  type SubscriptionInfo,
  type User,
  type Workspace,
} from "@/lib/api";
import { useI18n } from "@/lib/i18n";

const MAX_PHOTO_BYTES = 25 * 1024 * 1024; // 25 MB — same limit as product photos.

function initials(user: User): string {
  const fromName = (user.name ?? "").trim();
  if (fromName) return fromName.charAt(0).toUpperCase();
  return (user.email ?? "?").charAt(0).toUpperCase();
}

/**
 * Top-right Profile menu in the header.
 *
 * Shows the shop (workspace) name, the user's email and current plan /
 * trial, and the user's profile photo — pick a new one (Blob upload,
 * same pattern as product photos) or remove it. The photo shows in the
 * header avatar as soon as it is set; with no photo the header shows
 * the user's initials. Log out clears the token; when logged out the
 * menu offers a Log in link instead.
 */
export default function ProfileMenu() {
  const { t } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);

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

  const onPickPhoto = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    if (!file.type.startsWith("image/")) {
      setError(t("profile.photoUploadFailed", "Could not upload the photo.", "ছবি আপলোড করা যায়নি।"));
      return;
    }
    if (file.size > MAX_PHOTO_BYTES) {
      setError(t("profile.photoTooLarge", "Each photo must be 25 MB or smaller.", "ছবি ২৫ MB-এর বেশি হতে পারবে না।"));
      return;
    }
    setUploading(true);
    try {
      const updated = await profileApi.uploadPhoto(file);
      setUser(updated);
    } catch {
      setError(t("profile.photoUploadFailed", "Could not upload the photo.", "ছবি আপলোড করা যায়নি।"));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const onRemovePhoto = async () => {
    setError("");
    setUploading(true);
    try {
      const updated = await profileApi.removePhoto();
      setUser(updated);
    } catch {
      setError(t("profile.photoRemoveFailed", "Could not remove the photo.", "ছবি সরানো যায়নি।"));
    } finally {
      setUploading(false);
    }
  };

  const loggedIn = !!user;
  const avatarUrl = user?.avatarUrl ?? null;

  const planLine = subscription?.planName ?? subscription?.planSlug ?? null;
  const trialLine =
    subscription?.status === "trial"
      ? subscription.periodEnd
        ? `${t("profile.trial", "Trial", "ট্রায়াল")} · ${t("profile.trialEnds", "Trial ends", "ট্রায়াল শেষ")} ${formatDate(subscription.periodEnd)}`
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

                <div className="space-y-1 border-b border-orange-100 py-3 text-sm text-slate-700">
                  {planLine && (
                    <p className="flex justify-between gap-2">
                      <span className="text-slate-500">{t("profile.plan", "Plan", "প্ল্যান")}</span>
                      <span className="font-medium">{planLine}</span>
                    </p>
                  )}
                  {trialLine && (
                    <p className="flex justify-between gap-2">
                      <span className="text-slate-500">{t("profile.trial", "Trial", "ট্রায়াল")}</span>
                      <span className="font-medium">{trialLine}</span>
                    </p>
                  )}
                  {typeof workspace?.balance_paisa === "number" && (
                    <p className="flex justify-between gap-2">
                      <span className="text-slate-500">{t("profile.balance", "Balance", "ব্যালেন্স")}</span>
                      <span className="font-medium">{formatTaka(workspace.balance_paisa)}</span>
                    </p>
                  )}
                </div>

                <div className="space-y-2 py-3">
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    aria-label={t("profile.changePhoto", "Change photo", "ছবি বদলান")}
                    onChange={(e) => void onPickPhoto(e.target.files?.[0])}
                  />
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    disabled={uploading}
                    className="w-full rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-dark disabled:opacity-50"
                  >
                    {uploading
                      ? t("profile.uploading", "Uploading…", "আপলোড হচ্ছে…")
                      : t("profile.changePhoto", "Change photo", "ছবি বদলান")}
                  </button>
                  {avatarUrl && (
                    <button
                      type="button"
                      onClick={() => void onRemovePhoto()}
                      disabled={uploading}
                      className="w-full rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-orange-50 disabled:opacity-50"
                    >
                      {t("profile.removePhoto", "Remove photo", "ছবি সরান")}
                    </button>
                  )}
                  {error && <p className="text-xs text-red-600">{error}</p>}
                </div>

                <button
                  type="button"
                  onClick={logout}
                  className="w-full rounded-lg bg-orange-50 px-4 py-2 text-left text-sm font-medium text-slate-700 transition-colors hover:bg-orange-100"
                >
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
        </>
      )}
    </div>
  );
}
