"use client";
import { useState } from "react";
import { usePathname } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import { LanguageToggle, useI18n } from "@/lib/i18n";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const isAuthPage = pathname === "/login" || pathname === "/signup" || pathname === "/" || pathname === "/privacy";
  if (isAuthPage) {
    return <main className="min-h-screen">{children}</main>;
  }
  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar mobileOpen={menuOpen} onClose={() => setMenuOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-orange-100 bg-white/95 px-4 py-3 backdrop-blur sm:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <button
              onClick={() => setMenuOpen(true)}
              aria-label={t("nav.openMenu", "Open menu", "মেনু খুলুন")}
              className="rounded-lg px-2.5 py-1 text-xl leading-none text-slate-700 hover:bg-orange-50 md:hidden"
            >
              ☰
            </button>
            <p className="truncate font-bold text-slate-800">
              {t("app.name", "AI Sales Inbox", "AI সেলস ইনবক্স")}
            </p>
          </div>
          <LanguageToggle />
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
