"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { authApi, clearToken, getToken } from "@/lib/api";
import { ownerApi } from "@/lib/api-owner";
import { useI18n } from "@/lib/i18n";
import Icon, { type IconName } from "@/components/Icon";

/**
 * Sidebar per the final UI/UX design spec (white #FFFFFF, primary orange
 * #FF5B2E, 270px, Lucide-style outline icons, active item orange with
 * white text). Sections follow the spec exactly:
 *
 * - Main Navigation: Dashboard, Inbox, Products, Orders, Customers
 *   (+ Courier, kept reachable — grouped here after Orders).
 * - Marketing: Channels, Coupons, Leads. (The spec's Campaigns item has
 *   no page — Broadcasts were removed earlier — so it is not listed;
 *   listing it would be a dead link. See the redesign report.)
 * - Content & Analytics: Posts & Analytics (expandable parent with
 *   Schedule / Post Analysis / Analytics sub-items), Reviews, Comments.
 * - AI & Automation: Teach AI, Saved Replies, AI Providers
 *   (+ Website Chat, kept reachable).
 * - Settings: Billing, Plans, Settings (= the Setup wizard route)
 *   (+ Team, Guide, owner-only Owner Panel, kept reachable).
 *
 * No page was removed — every one of the 22 previous routes is still
 * linked from this sidebar. Labels use the i18n t() fallbacks, so the
 * menu reads English or Bengali.
 */

type NavItem = {
  href: string;
  icon: IconName;
  labelEn: string;
  labelBn: string;
  key?: string;
};

type Section = {
  id: string;
  headingEn: string | null;
  headingBn: string | null;
  headingKey?: string;
  items: NavItem[];
};

const MAIN_NAV: NavItem[] = [
  { href: "/dashboard", icon: "dashboard", labelEn: "Dashboard", labelBn: "ড্যাশবোর্ড" },
  { href: "/inbox", icon: "inbox", labelEn: "Inbox", labelBn: "ইনবক্স" },
  { href: "/products", icon: "box", labelEn: "Products", labelBn: "প্রোডাক্ট" },
  { href: "/orders", icon: "orders", labelEn: "Orders", labelBn: "অর্ডার" },
  { href: "/courier", icon: "courier", labelEn: "Courier", labelBn: "কুরিয়ার" },
  { href: "/customers", icon: "customers", labelEn: "Customers", labelBn: "কাস্টমার" },
];

const MARKETING: NavItem[] = [
  { href: "/channels", icon: "channels", labelEn: "Channels", labelBn: "চ্যানেল" },
  { href: "/coupons", icon: "coupons", labelEn: "Coupons", labelBn: "কুপন" },
  { href: "/leads", icon: "leads", labelEn: "Leads", labelBn: "লিড" },
];

const POSTS_SUB: NavItem[] = [
  { href: "/schedule", icon: "schedule", labelEn: "Schedule", labelBn: "শিডিউল" },
  { href: "/post-analysis", icon: "chartBar", labelEn: "Post Analysis", labelBn: "পোস্ট বিশ্লেষণ" },
  { href: "/analytics", icon: "chartLine", labelEn: "Analytics", labelBn: "অ্যানালিটিক্স" },
];

const CONTENT_EXTRA: NavItem[] = [
  { href: "/reviews", icon: "reviews", labelEn: "Reviews", labelBn: "রিভিউ" },
  { href: "/comments", icon: "comments", labelEn: "Comments", labelBn: "কমেন্ট" },
];

const AI_AUTOMATION: NavItem[] = [
  { href: "/teach", icon: "teach", labelEn: "Teach AI", labelBn: "শেখানো" },
  { href: "/saved-replies", icon: "savedReplies", labelEn: "Saved Replies", labelBn: "সেভ করা উত্তর" },
  { href: "/ai-providers", icon: "aiProviders", labelEn: "AI Providers", labelBn: "AI প্রোভাইডার" },
  { href: "/website-chat", icon: "websiteChat", labelEn: "Website Chat", labelBn: "ওয়েবসাইট চ্যাট" },
];

const SETTINGS_BASE: NavItem[] = [
  { href: "/billing", icon: "billing", labelEn: "Billing", labelBn: "বিলিং" },
  { href: "/plans", icon: "plans", labelEn: "Plans", labelBn: "প্ল্যান" },
  { href: "/setup", icon: "settings", labelEn: "Settings", labelBn: "সেটিংস" },
  { href: "/team", icon: "customers", labelEn: "Team", labelBn: "টিম" },
  { href: "/guide", icon: "guide", labelEn: "Guide", labelBn: "গাইড" },
];

const OWNER_ITEM: NavItem = { href: "/owner", icon: "shield", labelEn: "Owner Panel", labelBn: "ওনার প্যানেল" };

export default function Sidebar({ mobileOpen = false, onClose }: { mobileOpen?: boolean; onClose?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const { t } = useI18n();
  const [isOwner, setIsOwner] = useState(false);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [planName, setPlanName] = useState<string | null>(null);
  const [cardOpen, setCardOpen] = useState(false);

  // Owner Panel link is visible only to the platform owner; the bottom
  // workspace card shows the real workspace name + plan when known.
  useEffect(() => {
    if (!getToken()) return;
    ownerApi.me().then((m) => setIsOwner(m.isOwner)).catch(() => undefined);
    authApi.me().then((m) => {
      if (m.workspace?.name) setWorkspaceName(m.workspace.name);
      const plan = m.subscription?.planName ?? m.subscription?.planSlug ?? null;
      if (plan) setPlanName(plan);
    }).catch(() => undefined);
  }, []);

  const logout = () => {
    clearToken();
    router.push("/login");
  };

  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");
  const postsActive = POSTS_SUB.some((item) => isActive(item.href));
  const [postsOpen, setPostsOpen] = useState(false);
  // The Posts & Analytics group opens automatically when one of its
  // pages is active; the owner can also open/close it by hand.
  const postsExpanded = postsOpen || postsActive;

  const renderItem = (item: NavItem, opts?: { indent?: boolean }) => {
    const active = isActive(item.href);
    return (
      <Link
        key={item.href}
        href={item.href}
        aria-current={active ? "page" : undefined}
        className={`flex items-center gap-3 rounded-[10px] px-3 py-2.5 text-sm transition-colors ${
          opts?.indent ? "ml-4 pl-3" : ""
        } ${
          active
            ? "bg-brand font-medium text-white shadow-sm"
            : "font-medium text-slate-700 hover:bg-orange-50"
        }`}
      >
        <Icon name={item.icon} className="h-5 w-5 shrink-0" />
        <span className="truncate">{t(`nav.${item.href.replace(/\//g, "") || "home"}`, item.labelEn, item.labelBn)}</span>
      </Link>
    );
  };

  const sectionHeading = (en: string | null, bn: string | null, key?: string) => {
    if (!en) return null;
    return (
      <p className="px-3 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        {key ? t(key, en, bn ?? en) : en}
      </p>
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
        className={`fixed inset-y-0 left-0 z-40 flex w-[270px] shrink-0 flex-col border-r border-[#eeeeee] bg-white text-slate-800 transition-transform duration-200 md:sticky md:top-0 md:h-screen md:translate-x-0 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center gap-3 border-b border-[#eeeeee] px-4 py-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand text-sm font-bold text-white shadow-sm">AI</span>
          <span className="min-w-0">
            <p className="truncate text-[15px] font-bold leading-tight text-slate-900">{t("app.name", "AI Sales Inbox", "AI সেলস ইনবক্স")}</p>
            <p className="truncate text-[11px] text-slate-500">{t("app.taglineShort", "AI Chat, Sales & Customer Support", "AI চ্যাট, সেলস ও কাস্টমার সাপোর্ট")}</p>
          </span>
          <button
            onClick={onClose}
            aria-label={t("nav.closeMenu", "Close menu", "মেনু বন্ধ করুন")}
            className="ml-auto rounded-lg p-1.5 text-slate-500 hover:bg-orange-50 md:hidden"
          >
            <Icon name="x" className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4" onClick={onClose}>
          {/* Main Navigation — no heading, like the reference. */}
          <div className="space-y-1">{MAIN_NAV.map((item) => renderItem(item))}</div>

          <div className="border-t border-[#eeeeee] pt-4">
            {sectionHeading("Marketing", "মার্কেটিং", "nav.sectionMarketing")}
            <div className="space-y-1">{MARKETING.map((item) => renderItem(item))}</div>
          </div>

          <div className="border-t border-[#eeeeee] pt-4">
            {sectionHeading("Content & Analytics", "কনটেন্ট ও বিশ্লেষণ", "nav.sectionContent")}
            <div className="space-y-1">
              {/* Posts & Analytics — expandable parent; its three pages
                  are sub-items, auto-expanded when one is active. */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setPostsOpen(!postsExpanded);
                }}
                aria-expanded={postsExpanded}
                className={`flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-sm font-medium transition-colors ${
                  postsActive ? "text-brand" : "text-slate-700 hover:bg-orange-50"
                }`}
              >
                <Icon name="posts" className="h-5 w-5 shrink-0" />
                <span className="flex-1 truncate text-left">{t("nav.postsAnalytics", "Posts & Analytics", "পোস্ট ও বিশ্লেষণ")}</span>
                <Icon name="chevronDown" className={`h-4 w-4 shrink-0 transition-transform ${postsExpanded ? "rotate-180" : ""}`} />
              </button>
              {postsExpanded && (
                <div className="space-y-1 pb-1">
                  {POSTS_SUB.map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      aria-current={isActive(item.href) ? "page" : undefined}
                      className={`flex items-center gap-3 rounded-[10px] py-2 pl-11 pr-3 text-sm transition-colors ${
                        isActive(item.href)
                          ? "bg-brand font-medium text-white shadow-sm"
                          : "font-medium text-slate-700 hover:bg-orange-50"
                      }`}
                    >
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${isActive(item.href) ? "bg-white" : "bg-slate-300"}`} aria-hidden="true" />
                      <span className="truncate">{t(`nav.${item.href.replace(/\//g, "")}`, item.labelEn, item.labelBn)}</span>
                    </Link>
                  ))}
                </div>
              )}
              {CONTENT_EXTRA.map((item) => renderItem(item))}
            </div>
          </div>

          <div className="border-t border-[#eeeeee] pt-4">
            {sectionHeading("AI & Automation", "AI ও অটোমেশন", "nav.sectionAi")}
            <div className="space-y-1">{AI_AUTOMATION.map((item) => renderItem(item))}</div>
          </div>

          <div className="border-t border-[#eeeeee] pt-4">
            {sectionHeading("Settings", "সেটিংস", "nav.sectionSettings")}
            <div className="space-y-1">
              {SETTINGS_BASE.map((item) => renderItem(item))}
              {isOwner && renderItem(OWNER_ITEM)}
            </div>
          </div>
        </nav>

        {/* Bottom workspace card — real workspace name + plan when known,
            spec labels as fallback. Opens a small menu with Log out. */}
        <div className="border-t border-[#eeeeee] p-3">
          <button
            type="button"
            onClick={() => setCardOpen(!cardOpen)}
            aria-expanded={cardOpen}
            className="flex w-full items-center gap-3 rounded-[10px] border border-[#eeeeee] bg-white px-3 py-2.5 text-left shadow-sm transition-colors hover:bg-orange-50"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-bold text-white">AI</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-bold text-slate-900">
                {workspaceName ?? t("app.workspace", "AI Sales Workspace", "AI সেলস ওয়ার্কস্পেস")}
              </span>
              <span className="block text-xs font-medium text-green-600">
                {planName ?? t("app.proPlan", "Pro Plan", "প্রো প্ল্যান")}
              </span>
            </span>
            <Icon name="chevronDown" className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${cardOpen ? "rotate-180" : ""}`} />
          </button>
          {cardOpen && (
            <button
              onClick={logout}
              className="mt-2 flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-orange-50"
            >
              <Icon name="logout" className="h-5 w-5 shrink-0" />
              {t("nav.logout", "Log out", "লগআউট")}
            </button>
          )}
        </div>
      </aside>
    </>
  );
}
