"use client";
import { useState } from "react";
import { useI18n } from "@/lib/i18n";

type PasswordInputProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  minLength?: number;
  autoComplete?: string;
};

/**
 * Password field with a show/hide (eye) toggle. The toggle is a plain
 * button (type="button") so tapping it never submits the form, and it
 * carries an accessible label that flips with the state. The input keeps
 * the site-wide look; the eye sits inside the field on the right with
 * enough padding that typed text never runs underneath it.
 */
export default function PasswordInput({
  value,
  onChange,
  placeholder,
  required,
  minLength,
  autoComplete,
}: PasswordInputProps) {
  const { t } = useI18n();
  const [show, setShow] = useState(false);

  return (
    <div className="relative">
      <input
        type={show ? "text" : "password"}
        required={required}
        minLength={minLength}
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full pr-10"
        placeholder={placeholder}
      />
      <button
        type="button"
        aria-label={show ? t("auth.hidePassword", "Hide password", "পাসওয়ার্ড লুকাও") : t("auth.showPassword", "Show password", "পাসওয়ার্ড দেখাও")}
        title={show ? t("auth.hidePassword", "Hide password", "পাসওয়ার্ড লুকাও") : t("auth.showPassword", "Show password", "পাসওয়ার্ড দেখাও")}
        onClick={() => setShow((s) => !s)}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:text-slate-600 focus-visible:text-slate-700"
      >
        {show ? (
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
            <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
            <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.59 9.59 0 0 0 5.39-1.61" />
            <line x1="2" y1="2" x2="22" y2="22" />
          </svg>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
      </button>
    </div>
  );
}
