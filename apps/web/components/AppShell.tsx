"use client";
import { usePathname } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import { LanguageToggle, useI18n } from "@/lib/i18n";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { t } = useI18n();
  const isAuthPage = pathname === "/login" || pathname === "/signup" || pathname === "/" || pathname === "/privacy";
  if (isAuthPage) {
    return <main className="min-h-screen">{children}</main>;
  }
  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar />
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="sticky top-0 z-10 bg-white/95 backdrop-blur border-b border-orange-100 px-6 py-3 flex items-center justify-between gap-3">
          <p className="font-bold text-slate-800 truncate">
            {t("app.name", "AI Sales Inbox", "AI সেলস ইনবক্স")}
          </p>
          <LanguageToggle />
        </header>
        <main className="flex-1 p-6 max-w-6xl w-full mx-auto">{children}</main>
      </div>
    </div>
  );
}
