"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { authApi, clearToken, getToken } from "@/lib/api";
import { ownerApi } from "@/lib/api-owner";
import { setupApi } from "@/lib/api-new-features";
import { useI18n } from "@/lib/i18n";
import Icon, { type IconName } from "@/components/Icon";

/**
 * Sidebar per the final UI/UX design spec (270px, Lucide-style outline
 * icons, active item purple with white text). Restyled 2026-11-11 at
 * the user's request: Deep Navy #0F172A background (brand navy) with
 * light text, instead of the original white. The logo at the top links
 * to /dashboard from anywhere. Day / Night modes (2026-11-11): the
 * `theme` prop picks navy (night, default) or white (day); the header
 * sun/moon button toggles it, remembered in localStorage.
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
 * - Settings: Billing, Plans (+ Team, Guide, owner-only Owner Panel,
 *   kept reachable). Setup is FIRST at the top of the menu while
 *   incomplete (with "x of 7 done"), and moves into this Settings
 *   section once complete (Task 15). AI Providers shows only to the
 *   workspace owner (Task 14).
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

const AI_AUTOMATION_BASE: NavItem[] = [
  { href: "/teach", icon: "teach", labelEn: "Teach AI", labelBn: "শেখানো" },
  { href: "/saved-replies", icon: "savedReplies", labelEn: "Saved Replies", labelBn: "সেভ করা উত্তর" },
  { href: "/ai-providers", icon: "aiProviders", labelEn: "AI Providers", labelBn: "AI প্রোভাইডার", key: "aiProviders" },
  { href: "/ai-manager", icon: "aiProviders", labelEn: "AI Sales Manager", labelBn: "এআই সেলস ম্যানেজার", key: "aiManager" },
  { href: "/website-chat", icon: "websiteChat", labelEn: "Website Chat", labelBn: "ওয়েবসাইট চ্যাট" },
];

const SETTINGS_BASE: NavItem[] = [
  { href: "/billing", icon: "billing", labelEn: "Billing", labelBn: "বিলিং" },
  { href: "/plans", icon: "plans", labelEn: "Plans", labelBn: "প্ল্যান" },
  { href: "/team", icon: "customers", labelEn: "Team", labelBn: "টিম" },
  { href: "/guide", icon: "guide", labelEn: "Guide", labelBn: "গাইড" },
];

// Task 15 — Setup sits FIRST at the top of the menu while it is
// incomplete, showing "x of 7 done". Once complete it moves inside
// the Settings section below (labelled Setup), so the top of the menu
// is free again. The /setup route itself never disappears.
const SETUP_ITEM: NavItem = { href: "/setup", icon: "settings", labelEn: "Setup", labelBn: "সেটআপ" };

const OWNER_ITEM: NavItem = { href: "/owner", icon: "shield", labelEn: "Owner Panel", labelBn: "ওনার প্যানেল" };

export default function Sidebar({ mobileOpen = false, onClose, theme = "night" }: { mobileOpen?: boolean; onClose?: () => void; theme?: "day" | "night" }) {
  const pathname = usePathname();
  const router = useRouter();
  const { t } = useI18n();
  // Day / Night sidebar modes (2026-11-11, user request): "night" is the
  // dark navy sidebar, "day" is a light-blue tinted sidebar (#EBF1FE)
  // so it still reads as a menu bar against the white content. The
  // choice lives in AppShell (localStorage) and arrives here as `theme`.
  const dark = theme === "night";
  const c = {
    aside: dark ? "border-white/10 bg-[#0F172A] text-slate-200" : "border-[#D6E4FE] bg-[#EBF1FE] text-slate-800",
    divider: dark ? "border-white/10" : "border-[#D6E4FE]",
    heading: dark ? "text-slate-500" : "text-slate-500",
    item: dark ? "text-slate-300 hover:bg-white/10" : "text-slate-700 hover:bg-[#D6E4FE]",
    title: dark ? "text-white" : "text-slate-900",
    sub: dark ? "text-slate-400" : "text-slate-500",
    hoverBtn: dark ? "hover:bg-white/10" : "hover:bg-[#D6E4FE]",
    accentText: dark ? "text-sky-400" : "text-brand",
    setupText: dark ? "text-sky-400" : "text-[#0051F6]",
    dot: dark ? "bg-slate-500" : "bg-slate-400",
    card: dark ? "border-white/10 bg-white/5" : "border-[#D6E4FE] bg-white",
    plan: dark ? "text-green-400" : "text-green-600",
  };
  const [isOwner, setIsOwner] = useState(false);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [planName, setPlanName] = useState<string | null>(null);
  const [cardOpen, setCardOpen] = useState(false);
  // Task 14 — the caller's workspace role ('owner' | 'admin' | 'member').
  // AI Providers is shown only to the workspace owner (the API enforces
  // it with 403 too). While the role is still loading (null) the item
  // stays visible — it disappears only once we KNOW the user is not
  // the owner, so owners never see a flash of a missing menu item.
  const [workspaceRole, setWorkspaceRole] = useState<string | null>(null);
  // Task 15 — setup progress drives where Setup sits in the menu.
  const [setupDone, setSetupDone] = useState<number | null>(null);
  const [setupTotal, setSetupTotal] = useState<number | null>(null);

  // Owner Panel link is visible only to the platform owner; the bottom
  // workspace card shows the real workspace name + plan when known.
  useEffect(() => {
    if (!getToken()) return;
    ownerApi.me().then((m) => setIsOwner(m.isOwner)).catch(() => undefined);
    authApi.me().then((m) => {
      if (m.workspace?.name) setWorkspaceName(m.workspace.name);
      const plan = m.subscription?.planName ?? m.subscription?.planSlug ?? null;
      if (plan) setPlanName(plan);
      if (m.role) setWorkspaceRole(m.role);
    }).catch(() => undefined);
    setupApi.progress().then((d) => {
      setSetupDone(d.progress.completedCount);
      setSetupTotal(d.progress.totalSteps);
    }).catch(() => undefined);
  }, []);

  const logout = () => {
    // Real server-side logout first (revokes this token), then clear
    // the browser token. If the server call fails, still clear locally
    // and leave — a failed revoke is logged server-side.
    authApi.logout().catch(() => undefined).finally(() => {
      clearToken();
      router.push("/login");
    });
  };

  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");
  // Task 15: setup is complete only when every step is done. Until the
  // progress loads we assume incomplete, so Setup stays at the top.
  const setupComplete = setupDone !== null && setupTotal !== null && setupDone >= setupTotal;
  // Task 14: AI Providers is PLATFORM-owner only (user decision
  // 2026-11-11 — a shop owner IS the customer and must never see which
  // model answers them). Hide it unless the platform-owner flag
  // (ownerApi.me → isOwner) says so. AI Sales Manager stays
  // workspace-owner only (hidden for member/admin).
  const aiAutomation = AI_AUTOMATION_BASE.filter((item) => {
    if (item.key === "aiProviders") return isOwner;
    if (item.key === "aiManager") return workspaceRole !== "member" && workspaceRole !== "admin";
    return true;
  });
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
            ? "bg-accent font-medium text-white shadow-sm"
            : "font-medium " + c.item
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
      <p className={`px-3 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wider ${c.heading}`}>
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
        className={`fixed inset-y-0 left-0 z-40 flex w-[270px] shrink-0 flex-col border-r ${c.aside} transition-transform duration-200 md:sticky md:top-0 md:h-screen md:translate-x-0 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className={`flex items-center gap-3 border-b ${c.divider} px-4 py-4`}>
          <Link href="/dashboard" onClick={onClose} className="flex min-w-0 flex-1 items-center gap-3" aria-label={t("nav.goDashboard", "Go to Dashboard", "ড্যাশবোর্ডে যান")}>
            <img src="/logo.png" alt="YEARBITO" className="h-10 w-10 shrink-0 rounded-xl object-cover shadow-sm" />
            <span className="min-w-0">
              <p className={`truncate text-[15px] font-bold leading-tight ${c.title}`}>{t("app.name", "YEARBITO", "YEARBITO")}</p>
              <p className={`truncate text-[11px] ${c.sub}`}>{t("app.taglineShort", "Your Ideas, Amplified.", "Your Ideas, Amplified.")}</p>
            </span>
          </Link>
          <button
            onClick={onClose}
            aria-label={t("nav.closeMenu", "Close menu", "মেনু বন্ধ করুন")}
            className={`ml-auto rounded-lg p-1.5 ${c.sub} ${c.hoverBtn} md:hidden`}
          >
            <Icon name="x" className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4" onClick={onClose}>
          {/* Task 15 — Setup FIRST at the top of the menu while it is
              incomplete, with its progress ("3 of 7 done"). Once
              complete it moves into the Settings section below. */}
          {!setupComplete && (
            <div className="space-y-1">
              {renderItem(SETUP_ITEM)}
              <p className={`px-3 text-xs font-medium ${c.setupText}`}>
                {setupDone !== null && setupTotal !== null
                  ? t("nav.setupProgress", `${setupDone} of ${setupTotal} steps done`, `${setupDone} / ${setupTotal} ধাপ শেষ`)
                  : t("nav.setupStart", "Finish setup to go live", "লাইভ করতে সেটআপ শেষ করুন")}
              </p>
            </div>
          )}

          {/* Main Navigation — no heading, like the reference. */}
          <div className="space-y-1">{MAIN_NAV.map((item) => renderItem(item))}</div>

          <div className={`border-t ${c.divider} pt-4`}>
            {sectionHeading("Marketing", "মার্কেটিং", "nav.sectionMarketing")}
            <div className="space-y-1">{MARKETING.map((item) => renderItem(item))}</div>
          </div>

          <div className={`border-t ${c.divider} pt-4`}>
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
                  postsActive ? c.accentText : c.item
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
                          ? "bg-accent font-medium text-white shadow-sm"
                          : "font-medium " + c.item
                      }`}
                    >
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${isActive(item.href) ? "bg-white" : c.dot}`} aria-hidden="true" />
                      <span className="truncate">{t(`nav.${item.href.replace(/\//g, "")}`, item.labelEn, item.labelBn)}</span>
                    </Link>
                  ))}
                </div>
              )}
              {CONTENT_EXTRA.map((item) => renderItem(item))}
            </div>
          </div>

          <div className={`border-t ${c.divider} pt-4`}>
            {sectionHeading("AI & Automation", "AI ও অটোমেশন", "nav.sectionAi")}
            <div className="space-y-1">{aiAutomation.map((item) => renderItem(item))}</div>
          </div>

          <div className={`border-t ${c.divider} pt-4`}>
            {sectionHeading("Settings", "সেটিংস", "nav.sectionSettings")}
            <div className="space-y-1">
              {SETTINGS_BASE.map((item) => renderItem(item))}
              {/* Task 15 — once setup is complete it lives here, under
                  Settings, instead of at the top of the menu. */}
              {setupComplete && renderItem(SETUP_ITEM)}
              {isOwner && renderItem(OWNER_ITEM)}
            </div>
          </div>
        </nav>

        {/* Bottom workspace card — real workspace name + plan when known,
            spec labels as fallback. Opens a small menu with Log out. */}
        <div className={`border-t ${c.divider} p-3`}>
          <button
            type="button"
            onClick={() => setCardOpen(!cardOpen)}
            aria-expanded={cardOpen}
            className={`flex w-full items-center gap-3 rounded-[10px] border ${c.card} px-3 py-2.5 text-left shadow-sm transition-colors ${c.hoverBtn}`}
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-bold text-white">AI</span>
            <span className="min-w-0 flex-1">
              <span className={`block truncate text-sm font-bold ${c.title}`}>
                {workspaceName ?? t("app.workspace", "YEARBITO Workspace", "YEARBITO ওয়ার্কস্পেস")}
              </span>
              <span className={`block text-xs font-medium ${c.plan}`}>
                {planName ?? t("app.proPlan", "Pro Plan", "প্রো প্ল্যান")}
              </span>
            </span>
            <Icon name="chevronDown" className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${cardOpen ? "rotate-180" : ""}`} />
          </button>
          {cardOpen && (
            <button
              onClick={logout}
              className={`mt-2 flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-sm font-medium ${c.item} transition-colors`}
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
