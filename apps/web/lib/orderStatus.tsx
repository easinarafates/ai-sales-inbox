import type { Lang } from "@/lib/i18n";

/**
 * Order statuses (order management, 2026-11-08). The owner picks ANY of
 * these manually in the detail panel — no forward-only flow.
 * pending (অপেক্ষমাণ) · on_hold (হোল্ডে) · approved (অনুমোদিত) ·
 * processing (প্রস্তুত হচ্ছে) · ready (রেডি) · ready_to_ship (পাঠাতে প্রস্তুত) ·
 * in_transit (কুরিয়ারে / পথে) · delivered (ডেলিভারি হয়েছে) ·
 * cancelled (বাতিল) · returned (রিটার্ন) · damaged (ক্ষতিগ্রস্ত) ·
 * in_store (স্টোরে আছে).
 */
export const ORDER_STATUSES = [
  "pending", "on_hold", "approved", "processing", "ready", "ready_to_ship",
  "in_transit", "delivered", "cancelled", "returned", "damaged", "in_store",
] as const;
export const ORDER_STATUS_BN: Record<string, string> = {
  pending: "অপেক্ষমাণ", on_hold: "হোল্ডে", approved: "অনুমোদিত", processing: "প্রস্তুত হচ্ছে",
  ready: "রেডি", ready_to_ship: "পাঠাতে প্রস্তুত", in_transit: "কুরিয়ারে", delivered: "ডেলিভারি হয়েছে",
  cancelled: "বাতিল", returned: "রিটার্ন", damaged: "ক্ষতিগ্রস্ত", in_store: "স্টোরে আছে",
};
export const ORDER_STATUS_EN: Record<string, string> = {
  pending: "Pending", on_hold: "On hold", approved: "Approved", processing: "Preparing",
  ready: "Ready", ready_to_ship: "Ready to ship", in_transit: "In courier", delivered: "Delivered",
  cancelled: "Cancelled", returned: "Returned", damaged: "Damaged", in_store: "In store",
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
    ready: "bg-teal-100 text-teal-800", ready_to_ship: "bg-cyan-100 text-cyan-800",
    in_transit: "bg-violet-100 text-violet-800", delivered: "bg-green-100 text-green-800",
    cancelled: "bg-red-100 text-red-800", returned: "bg-orange-100 text-orange-800",
    damaged: "bg-rose-100 text-rose-800", in_store: "bg-stone-200 text-stone-700",
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

/** Who talked to the customer — the AI agent or a human on the team. */
export function handledByLabel(handledBy: string | undefined, lang: Lang = "en"): string {
  if (handledBy === "agent") return lang === "bn" ? "এজেন্ট (মানুষ)" : "Agent (human)";
  if (handledBy === "ai") return lang === "bn" ? "এআই এজেন্ট" : "AI agent";
  return "—";
}

export const PAYMENT_METHODS = ["cod", "advance", "fifty_fifty"] as const;
export const PAYMENT_METHOD_BN: Record<string, string> = {
  cod: "ক্যাশ অন ডেলিভারি", advance: "অ্যাডভান্স পেমেন্ট", fifty_fifty: "৫০% অ্যাডভান্স, ৫০% ডেলিভারিতে",
};
export const PAYMENT_METHOD_EN: Record<string, string> = {
  cod: "Cash on Delivery", advance: "Advance payment", fifty_fifty: "50% advance, 50% on delivery",
};

export function paymentMethodLabel(method: string | undefined, lang: Lang = "en"): string {
  if (!method) return lang === "bn" ? "ক্যাশ অন ডেলিভারি" : "Cash on Delivery";
  const map = lang === "bn" ? PAYMENT_METHOD_BN : PAYMENT_METHOD_EN;
  return map[method] || method;
}
