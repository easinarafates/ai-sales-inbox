import type { Lang } from "@/lib/i18n";

export const ORDER_STATUSES = ["pending", "on_hold", "approved", "processing", "ready_to_ship", "in_transit", "delivered"] as const;
export const ORDER_STATUS_BN: Record<string, string> = {
  pending: "অপেক্ষমাণ", on_hold: "হোল্ডে", approved: "অনুমোদিত", processing: "প্রস্তুত হচ্ছে",
  ready_to_ship: "পাঠাতে প্রস্তুত", in_transit: "পথে", delivered: "ডেলিভারি হয়েছে",
};
export const ORDER_STATUS_EN: Record<string, string> = {
  pending: "Pending", on_hold: "On hold", approved: "Approved", processing: "Preparing",
  ready_to_ship: "Ready to ship", in_transit: "In transit", delivered: "Delivered",
};

export function orderStatusLabel(status: string | undefined, lang: Lang = "en"): string {
  if (!status) return "—";
  const map = lang === "bn" ? ORDER_STATUS_BN : ORDER_STATUS_EN;
  return map[status] || status;
}

export function statusBadge(status?: string, lang: Lang = "en") {
  const colors: Record<string, string> = {
    pending: "bg-yellow-100 text-yellow-800", on_hold: "bg-slate-200 text-slate-700",
    approved: "bg-blue-100 text-blue-800", processing: "bg-indigo-100 text-indigo-800",
    ready_to_ship: "bg-cyan-100 text-cyan-800", in_transit: "bg-violet-100 text-violet-800",
    delivered: "bg-green-100 text-green-800",
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded ${colors[status || ""] || "bg-slate-100"}`}>
      {orderStatusLabel(status, lang)}
    </span>
  );
}

/** Where the order came from — 'ai' (AI chat), 'team' (created by the team), or a channel name. */
export function orderSourceLabel(source: string | undefined, lang: Lang = "en"): string {
  const s = (source ?? "").toLowerCase();
  if (s === "ai") return lang === "bn" ? "এআই" : "AI";
  if (s === "team") return lang === "bn" ? "দল" : "Team";
  if (!s) return "—";
  return s.charAt(0).toUpperCase() + s.slice(1);
}
