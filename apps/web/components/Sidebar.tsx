"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { clearToken, getToken } from "@/lib/api";
import { ownerApi } from "@/lib/api-owner";
import { useI18n } from "@/lib/i18n";
import { EXTRA_NAV, type ExtraNavItem } from "@/components/NavExtra";

type NavItem = {
  href: string;
  key: string;
  labelEn: string;
  labelBn: string;
};

const NAV: NavItem[] = [
  { href: "/inbox", key: "nav.inbox", labelEn: "Inbox", labelBn: "ইনবক্স" },
  { href: "/products", key: "nav.products", labelEn: "Products", labelBn: "প্রোডাক্ট" },
  { href: "/orders", key: "nav.orders", labelEn: "Orders", labelBn: "অর্ডার" },
  { href: "/tickets", key: "nav.tickets", labelEn: "Tickets", labelBn: "টিকেট" },
  { href: "/billing", key: "nav.billing", labelEn: "Billing", labelBn: "বিলিং" },
  { href: "/plans", key: "nav.plans", labelEn: "Plans", labelBn: "প্ল্যান" },
  { href: "/courier", key: "nav.courier", labelEn: "Courier", labelBn: "কুরিয়ার" },
  { href: "/channels", key: "nav.channels", labelEn: "Channels", labelBn: "চ্যানেল" },
  { href: "/coupons", key: "nav.coupons", labelEn: "Coupons", labelBn: "কুপন" },
  { href: "/customers", key: "nav.customers", labelEn: "Customers", labelBn: "কাস্টমার" },
  { href: "/schedule", key: "nav.schedule", labelEn: "Schedule", labelBn: "শিডিউল" },
  { href: "/leads", key: "nav.leads", labelEn: "Leads", labelBn: "লিড" },
  { href: "/analytics", key: "nav.analytics", labelEn: "Analytics", labelBn: "অ্যানালিটিক্স" },
  { href: "/teach", key: "nav.teach", labelEn: "Teach AI", labelBn: "শেখানো" },
  { href: "/broadcasts", key: "nav.broadcasts", labelEn: "Broadcasts", labelBn: "ব্রডকাস্ট" },
  { href: "/bookings", key: "nav.bookings", labelEn: "Bookings", labelBn: "বুকিং" },
  { href: "/reviews", key: "nav.reviews", labelEn: "Reviews", labelBn: "রিভিউ" },
  { href: "/migration", key: "nav.migration", labelEn: "Migration", labelBn: "মাইগ্রেশন" },
  { href: "/feature-requests", key: "nav.feature-requests", labelEn: "Feature Requests", labelBn: "অনুরোধ" },
];

/** Slug for an extra nav item, used as its dictionary key: nav.<slug>. */
function extraSlug(item: ExtraNavItem): string {
  const slug = item.href
    .split("/")
    .filter(Boolean)
    .join("-");
  return slug || "home";
}

export default function Sidebar({ mobileOpen = false, onClose }: { mobileOpen?: boolean; onClose?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const { t } = useI18n();
  const [isOwner, setIsOwner] = useState(false);

  // The Owner Panel link must be visible only to the platform owner.
  useEffect(() => {
    if (!getToken()) return;
    ownerApi.me().then((m) => setIsOwner(m.isOwner)).catch(() => undefined);
  }, []);

  const logout = () => {
    clearToken();
    router.push("/login");
  };

  return (
    <>
      {/* Dimmed backdrop behind the drawer on small screens only. */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}
      {/* Slide-in drawer on mobile, static sidebar on md+ screens. */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col border-r border-orange-100 bg-white text-slate-800 transition-transform duration-200 md:sticky md:top-0 md:h-screen md:translate-x-0 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
      <div className="flex items-center gap-3 border-b border-orange-100 p-5">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand text-sm font-bold text-white shadow-sm">AI</span>
        <span className="min-w-0">
          <p className="truncate text-lg font-bold leading-tight">{t("app.name", "AI Sales Inbox", "AI সেলস ইনবক্স")}</p>
          <p className="truncate text-xs text-slate-500">{t("app.tagline", "AI Sales Inbox • Bangladesh", "AI Sales Inbox • বাংলাদেশ")}</p>
        </span>
        <button
          onClick={onClose}
          aria-label={t("nav.closeMenu", "Close menu", "মেনু বন্ধ করুন")}
          className="ml-auto rounded-lg px-2 py-1 text-xl text-slate-500 hover:bg-orange-50 md:hidden"
        >
          ×
        </button>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto p-3" onClick={onClose}>
        {NAV.map((item) => {
          const active = pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`block rounded-lg px-4 py-2.5 transition-colors ${active ? "bg-brand font-medium text-white shadow-sm" : "text-slate-700 hover:bg-orange-50"}`}
            >
              <span className="font-medium">{t(item.key, item.labelEn, item.labelBn)}</span>
            </Link>
          );
        })}
        {EXTRA_NAV.filter((item) => item.href !== "/owner" || isOwner).map((item) => {
          const active = pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`block rounded-lg px-4 py-2.5 transition-colors ${active ? "bg-brand font-medium text-white shadow-sm" : "text-slate-700 hover:bg-orange-50"}`}
            >
              <span className="font-medium">
                {t(`nav.${extraSlug(item)}`, item.labelEn, item.labelBn)}
              </span>
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-orange-100 p-4">
        <button
          onClick={logout}
          className="w-full rounded-lg bg-orange-50 px-4 py-2 text-left text-sm font-medium text-slate-700 transition-colors hover:bg-orange-100"
        >
          {t("nav.logout", "Log out", "লগআউট")}
        </button>
      </div>
      </aside>
    </>
  );
}
