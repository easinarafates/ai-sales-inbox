import type { Metadata } from "next";
import "./globals.css";
import AppShell from "@/components/AppShell";
import { LanguageProvider } from "@/lib/i18n";

export const metadata: Metadata = {
  title: "AI সেলস ইনবক্স",
  description: "বাংলাদেশি বিক্রেতাদের জন্য AI সেলস ইনবক্স — Messenger, Facebook, Instagram এক জায়গায়।",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <LanguageProvider>
          <AppShell>{children}</AppShell>
        </LanguageProvider>
      </body>
    </html>
  );
}
