"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { bn, en } from "./i18n-dict";

export type Lang = "en" | "bn";
export const LANG_STORAGE_KEY = "ai-inbox-lang";

const LOCALES: Record<Lang, string> = { en: "en-US", bn: "bn-BD" };

/** Locale-aware date formatting (Asia/Dhaka). Latin digits in EN, Bengali digits in BN. */
export function formatDateLocale(value: string | null | undefined, lang: Lang): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat(LOCALES[lang], {
    timeZone: "Asia/Dhaka",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

/** Locale-aware Taka formatting from paisa. */
export function formatTakaLocale(paisa: number | null | undefined, lang: Lang): string {
  if (paisa == null || Number.isNaN(paisa)) return "৳0";
  return `৳${new Intl.NumberFormat(LOCALES[lang], {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(paisa / 100)}`;
}

/** Locale-aware plain number formatting. */
export function formatNumberLocale(n: number | null | undefined, lang: Lang): string {
  return new Intl.NumberFormat(LOCALES[lang]).format(n ?? 0);
}

export type TranslateFn = (key: string, fallbackEn: string, fallbackBn?: string) => string;

export interface I18nValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: TranslateFn;
  /** Locale-aware formatters bound to the current language. */
  fmtDate: (value: string | null | undefined) => string;
  fmtTaka: (paisa: number | null | undefined) => string;
  fmtNum: (n: number | null | undefined) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>("en");

  useEffect(() => {
    try {
      const saved = localStorage.getItem(LANG_STORAGE_KEY);
      if (saved === "en" || saved === "bn") setLangState(saved);
    } catch {
      /* localStorage unavailable — keep default English */
    }
  }, []);

  useEffect(() => {
    try {
      document.documentElement.lang = lang;
    } catch {
      /* no DOM — ignore */
    }
  }, [lang]);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(LANG_STORAGE_KEY, l);
    } catch {
      /* localStorage unavailable — keep in-memory only */
    }
  }, []);

  const value = useMemo<I18nValue>(() => {
    const dict = lang === "en" ? en : bn;
    const t: TranslateFn = (key, fallbackEn, fallbackBn) => {
      const hit = dict[key];
      if (hit !== undefined) return hit;
      return lang === "en" ? fallbackEn : fallbackBn ?? fallbackEn;
    };
    return {
      lang,
      setLang,
      t,
      fmtDate: (v) => formatDateLocale(v, lang),
      fmtTaka: (p) => formatTakaLocale(p, lang),
      fmtNum: (n) => formatNumberLocale(n, lang),
    };
  }, [lang, setLang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    // Safe fallback for pages rendered outside the provider (e.g. during
    // static prerender): English, with a no-op setLang.
    const t: TranslateFn = (key, fallbackEn, fallbackBn) => en[key] ?? fallbackEn;
    return {
      lang: "en",
      setLang: () => {},
      t,
      fmtDate: (v) => formatDateLocale(v, "en"),
      fmtTaka: (p) => formatTakaLocale(p, "en"),
      fmtNum: (n) => formatNumberLocale(n, "en"),
    };
  }
  return ctx;
}

/** EN / বাংলা toggle used in the top bar and on the login page. */
export function LanguageToggle() {
  const { lang, setLang } = useI18n();
  return (
    <div
      className="inline-flex rounded-lg border border-slate-200 bg-white overflow-hidden"
      role="group"
      aria-label="Language / ভাষা"
    >
      <button
        type="button"
        onClick={() => setLang("en")}
        aria-pressed={lang === "en"}
        className={`px-3 py-1.5 text-sm font-medium ${lang === "en" ? "bg-brand text-white" : "text-slate-600 hover:bg-orange-50"}`}
      >
        EN
      </button>
      <button
        type="button"
        onClick={() => setLang("bn")}
        aria-pressed={lang === "bn"}
        className={`px-3 py-1.5 text-sm font-medium ${lang === "bn" ? "bg-brand text-white" : "text-slate-600 hover:bg-orange-50"}`}
      >
        বাংলা
      </button>
    </div>
  );
}
