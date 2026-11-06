"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getToken } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

export default function HomePage() {
  const router = useRouter();
  const { t } = useI18n();
  useEffect(() => {
    router.replace(getToken() ? "/inbox" : "/login");
  }, [router]);
  return <p className="p-8 text-center text-slate-500">{t("home.loading", "Loading…", "লোড হচ্ছে…")}</p>;
}
