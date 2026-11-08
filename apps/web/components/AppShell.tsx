"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import ProfileMenu from "@/components/ProfileMenu";
import Icon from "@/components/Icon";
import { LanguageToggle, useI18n } from "@/lib/i18n";
import { api, formatDate } from "@/lib/api";

/**
 * App shell per the final UI/UX design spec: fixed 270px sidebar on the
 * left; top header 55–65px, white with a subtle bottom border — current
 * page title on the left, notification bell, help icon, language toggle
 * and profile avatar on the right.
 *
 * The bell is WIRED (2026-11-08): it polls GET /api/notifications and
 * shows the real escalation alerts (angry customer / off-topic) with an
 * unread dot. Tapping a notification marks it read and opens its
 * conversation in the Inbox. When there are none it honestly says so.
 */

interface BellNotification {
  id: string;
  type: string;
  title: string;
  body: string;
  conversation_id: string | null;
  customer_name: string | null;
  is_read: boolean;
  created_at: string;
}
const TITLES: Record<string, { en: string; bn: string }> = {
  "/dashboard": { en: "Dashboard", bn: "ড্যাশবোর্ড" },
  "/inbox": { en: "Inbox", bn: "ইনবক্স" },
  "/products": { en: "Products", bn: "প্রোডাক্ট" },
  "/orders": { en: "Orders", bn: "অর্ডার" },
  "/customers": { en: "Customers", bn: "কাস্টমার" },
  "/courier": { en: "Courier", bn: "কুরিয়ার" },
  "/channels": { en: "Channels", bn: "চ্যানেল" },
  "/coupons": { en: "Coupons", bn: "কুপন" },
  "/leads": { en: "Leads", bn: "লিড" },
  "/schedule": { en: "Schedule", bn: "শিডিউল" },
  "/post-analysis": { en: "Post Analysis", bn: "পোস্ট বিশ্লেষণ" },
  "/analytics": { en: "Analytics", bn: "অ্যানালিটিক্স" },
  "/reviews": { en: "Reviews", bn: "রিভিউ" },
  "/comments": { en: "Comments", bn: "কমেন্ট" },
  "/teach": { en: "Teach AI", bn: "AI শেখানো" },
  "/saved-replies": { en: "Saved Replies", bn: "সেভ করা উত্তর" },
  "/ai-providers": { en: "AI Providers", bn: "AI প্রোভাইডার" },
  "/website-chat": { en: "Website Chat", bn: "ওয়েবসাইট চ্যাট" },
  "/billing": { en: "Billing", bn: "বিলিং" },
  "/plans": { en: "Plans", bn: "প্ল্যান" },
  "/setup": { en: "Settings", bn: "সেটিংস" },
  "/team": { en: "Team", bn: "টিম" },
  "/guide": { en: "Guide", bn: "গাইড" },
  "/owner": { en: "Owner Panel", bn: "ওনার প্যানেল" },
};

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const [notifications, setNotifications] = useState<BellNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const bellRef = useRef<HTMLDivElement>(null);

  // Bell feed: real notifications from the API (escalation alerts).
  // Polled every 30s so an angry-customer alert appears without a
  // refresh; a failed fetch just leaves the last list in place.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await api.get<{ notifications: BellNotification[]; unreadCount: number }>("/api/notifications?limit=20");
        if (cancelled) return;
        setNotifications(data.notifications ?? []);
        setUnreadCount(data.unreadCount ?? 0);
      } catch {
        // Offline / logged out — the bell stays as it was.
      }
    };
    load();
    const timer = setInterval(load, 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const openNotification = async (n: BellNotification) => {
    setBellOpen(false);
    try {
      await api.post(`/api/notifications/${n.id}/read`);
      setNotifications((prev) => prev.map((x) => (x.id === n.id ? { ...x, is_read: true } : x)));
      setUnreadCount((c) => Math.max(0, c - (n.is_read ? 0 : 1)));
    } catch {
      // Mark-read failed — still open the conversation.
    }
    if (n.conversation_id) router.push(`/inbox?conversation=${n.conversation_id}`);
  };

  // Close the bell dropdown when the user taps anywhere else.
  useEffect(() => {
    if (!bellOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) setBellOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [bellOpen]);

  const isAuthPage =
    pathname === "/login" ||
    pathname === "/signup" ||
    pathname === "/" ||
    pathname === "/privacy" ||
    pathname === "/forgot-password" ||
    pathname === "/reset-password" ||
    pathname.startsWith("/invoice");
  if (isAuthPage) {
    return <main className="min-h-screen">{children}</main>;
  }

  const title = TITLES[pathname] ?? TITLES[Object.keys(TITLES).find((k) => pathname.startsWith(k + "/")) ?? ""] ?? { en: "AI Sales Inbox", bn: "AI সেলস ইনবক্স" };

  return (
    <div className="flex min-h-screen bg-white">
      <Sidebar mobileOpen={menuOpen} onClose={() => setMenuOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-[60px] items-center justify-between gap-3 border-b border-[#eeeeee] bg-white px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <button
              onClick={() => setMenuOpen(true)}
              aria-label={t("nav.openMenu", "Open menu", "মেনু খুলুন")}
              className="rounded-lg p-2 text-slate-700 hover:bg-orange-50 md:hidden"
            >
              <Icon name="menu" className="h-5 w-5" />
            </button>
            <h1 className="truncate text-lg font-bold text-slate-900">{t(`header.title.${pathname.replace(/\//g, "") || "home"}`, title.en, title.bn)}</h1>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="relative" ref={bellRef}>
              <button
                onClick={() => setBellOpen(!bellOpen)}
                aria-label={t("header.notifications", "Notifications", "নোটিফিকেশন")}
                aria-expanded={bellOpen}
                className="relative rounded-full p-2 text-slate-600 transition-colors hover:bg-orange-50 hover:text-slate-900"
              >
                <Icon name="bell" className="h-5 w-5" />
                {unreadCount > 0 && (
                  <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#ff5b2e] px-1 text-[10px] font-bold text-white">
                    {unreadCount > 9 ? "9+" : unreadCount}
                  </span>
                )}
              </button>
              {bellOpen && (
                <div className="absolute right-0 top-11 w-80 max-w-[90vw] rounded-xl border border-[#eeeeee] bg-white shadow-lg">
                  <p className="border-b border-[#eeeeee] px-4 py-3 text-sm font-bold text-slate-900">
                    {t("header.notifications", "Notifications", "নোটিফিকেশন")}
                  </p>
                  {notifications.length === 0 ? (
                    <p className="px-4 py-3 text-sm text-slate-500">
                      {t("header.noNotifications", "No new notifications.", "কোনো নতুন নোটিফিকেশন নেই।")}
                    </p>
                  ) : (
                    <ul className="max-h-96 overflow-y-auto">
                      {notifications.map((n) => (
                        <li key={n.id}>
                          <button
                            onClick={() => openNotification(n)}
                            className={`block w-full px-4 py-3 text-left hover:bg-orange-50 ${n.is_read ? "" : "bg-[#fff1ea]"}`}
                          >
                            <p className="text-sm font-bold text-slate-900">{n.title}</p>
                            <p className="mt-0.5 text-sm text-slate-600">{n.body}</p>
                            <p className="mt-1 text-xs text-slate-400">{formatDate(n.created_at)}</p>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
            <Link
              href="/guide"
              aria-label={t("header.help", "Help", "সাহায্য")}
              className="rounded-full p-2 text-slate-600 transition-colors hover:bg-orange-50 hover:text-slate-900"
            >
              <Icon name="help" className="h-5 w-5" />
            </Link>
            <LanguageToggle />
            <ProfileMenu />
          </div>
        </header>
        <main className="w-full flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
