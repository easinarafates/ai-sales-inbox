"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { clearToken, getToken } from "@/lib/api";
import { ownerApi } from "@/lib/api-owner";
import { useI18n } from "@/lib/i18n";
import { EXTRA_NAV, type ExtraNavItem } from "@/components/NavExtra";

type SectionId = "shop" | "posts" | "teach" | "help" | "settings";

type NavItem = {
  href: string;
  key: string;
  labelEn: string;
  labelBn: string;
  section: SectionId;
};

/**
 * Sidebar sections — every menu item lives in exactly one section, and
 * each section has its own accent colour (dot + label) so the menu is
 * scannable at a glance instead of one flat coral list. The coral
 * #ff6a4d brand stays the active-item colour; the section colours only
 * mark the groups. No page was removed or renamed — this is regrouping
 * + visual distinction only.
 *
 * - Shop (দোকান, teal): the daily shop work — inbox, products, orders,
 *   customers, channels, coupons, leads, bookings, courier.
 * - Posts & Analytics (পোস্ট ও বিশ্লেষণ, coral): schedule, post analysis,
 *   analytics, comments, broadcasts, reviews.
 * - Teach AI (AI শেখানো, violet): teach, saved replies, agent desk,
 *   AI providers, website chat.
 * - Help (সাহায্য, sky): tickets, billing, plans, guide, feature requests.
 * - Settings (সেটিংস, amber): setup, team, migration, owner panel.
 */
const SECTIONS: {
  id: SectionId;
  key: string;
  labelEn: string;
  labelBn: string;
  labelClass: string;
  dotClass: string;
}[] = [
  { id: "shop", key: "nav.sectionShop", labelEn: "Shop", labelBn: "দোকান", labelClass: "text-teal-700", dotClass: "bg-teal-500" },
  { id: "posts", key: "nav.sectionPosts", labelEn: "Posts & Analytics", labelBn: "পোস্ট ও বিশ্লেষণ", labelClass: "text-brand", dotClass: "bg-brand" },
  { id: "teach", key: "nav.sectionTeach", labelEn: "Teach AI", labelBn: "AI শেখানো", labelClass: "text-violet-700", dotClass: "bg-violet-500" },
  { id: "help", key: "nav.sectionHelp", labelEn: "Help", labelBn: "সাহায্য", labelClass: "text-sky-700", dotClass: "bg-sky-500" },
  { id: "settings", key: "nav.sectionSettings", labelEn: "Settings", labelBn: "সেটিংস", labelClass: "text-amber-700", dotClass: "bg-amber-500" },
];

const NAV: NavItem[] = [
  { href: "/inbox", key: "nav.inbox", labelEn: "Inbox", labelBn: "ইনবক্স", section: "shop" },
  { href: "/products", key: "nav.products", labelEn: "Products", labelBn: "প্রোডাক্ট", section: "shop" },
  { href: "/orders", key: "nav.orders", labelEn: "Orders", labelBn: "অর্ডার", section: "shop" },
  { href: "/customers", key: "nav.customers", labelEn: "Customers", labelBn: "কাস্টমার", section: "shop" },
  { href: "/channels", key: "nav.channels", labelEn: "Channels", labelBn: "চ্যানেল", section: "shop" },
  { href: "/coupons", key: "nav.coupons", labelEn: "Coupons", labelBn: "কুপন", section: "shop" },
  { href: "/leads", key: "nav.leads", labelEn: "Leads", labelBn: "লিড", section: "shop" },
  { href: "/bookings", key: "nav.bookings", labelEn: "Bookings", labelBn: "বুকিং", section: "shop" },
  { href: "/courier", key: "nav.courier", labelEn: "Courier", labelBn: "কুরিয়ার", section: "shop" },
  { href: "/schedule", key: "nav.schedule", labelEn: "Schedule", labelBn: "শিডিউল", section: "posts" },
  { href: "/post-analysis", key: "nav.postAnalysis", labelEn: "Post analysis", labelBn: "পোস্ট বিশ্লেষণ", section: "posts" },
  { href: "/analytics", key: "nav.analytics", labelEn: "Analytics", labelBn: "অ্যানালিটিক্স", section: "posts" },
  { href: "/broadcasts", key: "nav.broadcasts", labelEn: "Broadcasts", labelBn: "ব্রডকাস্ট", section: "posts" },
  { href: "/reviews", key: "nav.reviews", labelEn: "Reviews", labelBn: "রিভিউ", section: "posts" },
  { href: "/teach", key: "nav.teach", labelEn: "Teach AI", labelBn: "শেখানো", section: "teach" },
  { href: "/tickets", key: "nav.tickets", labelEn: "Tickets", labelBn: "টিকেট", section: "help" },
  { href: "/billing", key: "nav.billing", labelEn: "Billing", labelBn: "বিলিং", section: "help" },
  { href: "/plans", key: "nav.plans", labelEn: "Plans", labelBn: "প্ল্যান", section: "help" },
  { href: "/feature-requests", key: "nav.feature-requests", labelEn: "Feature Requests", labelBn: "অনুরোধ", section: "help" },
  { href: "/migration", key: "nav.migration", labelEn: "Migration", labelBn: "মাইগ্রেশন", section: "settings" },
];

/** Slug for an extra nav item, used as its dictionary key: nav.<slug>. */
function extraSlug(item: ExtraNavItem): string {
  const slug = item.href
    .split("/")
    .filter(Boolean)
    .join("-");
  return slug || "home";
}

/** Extra items without an explicit section fall back to Settings. */
function extraSection(item: ExtraNavItem): SectionId {
  return item.section ?? "settings";
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

  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");

  const renderItem = (
    href: string,
    label: string,
    section: (typeof SECTIONS)[number],
    key: string,
  ) => {
    const active = isActive(href);
    return (
      <Link
        key={key}
        href={href}
        aria-current={active ? "page" : undefined}
        className={`block rounded-lg px-4 py-2.5 ${active ? "bg-brand font-medium text-white shadow-sm" : "text-slate-700 hover:bg-orange-50"}`}
      >
        <span className="flex items-center gap-2.5">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? "bg-white" : `${section.dotClass} opacity-80`}`}
            aria-hidden="true"
          />
          <span className="font-medium">{label}</span>
        </span>
      </Link>
    );
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
      <nav className="flex-1 space-y-4 overflow-y-auto p-3" onClick={onClose}>
        {SECTIONS.map((section) => {
          const core = NAV.filter((item) => item.section === section.id);
          const extras = EXTRA_NAV.filter(
            (item) => extraSection(item) === section.id && (item.href !== "/owner" || isOwner),
          );
          if (core.length === 0 && extras.length === 0) return null;
          return (
            <div key={section.id}>
              <p
                className={`flex items-center gap-2 px-2 pb-1.5 pt-1 text-[11px] font-bold uppercase tracking-wider ${section.labelClass}`}
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${section.dotClass}`} aria-hidden="true" />
                {t(section.key, section.labelEn, section.labelBn)}
              </p>
              <div className="space-y-1">
                {core.map((item) =>
                  renderItem(item.href, t(item.key, item.labelEn, item.labelBn), section, item.href),
                )}
                {extras.map((item) =>
                  renderItem(
                    item.href,
                    t(`nav.${extraSlug(item)}`, item.labelEn, item.labelBn),
                    section,
                    item.href,
                  ),
                )}
              </div>
            </div>
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
