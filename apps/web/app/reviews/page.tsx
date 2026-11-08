"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  asArrayOf,
  getToken,
  reviewsApi,
  type ReviewItem,
} from "@/lib/api";
import { useI18n } from "@/lib/i18n";

export default function ReviewsPage() {
  const router = useRouter();
  const { t, fmtDate, fmtNum } = useI18n();
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await reviewsApi.list();
      setReviews(asArrayOf<ReviewItem>(data, ["reviews"]));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("reviews.loadFailed", "Could not load reviews.", "রিভিউ লোড করা যায়নি।"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!getToken()) { router.push("/login"); return; }
    load();
  }, [load, router]);

  return (
    <div>
      <h1 className="page-title">{t("reviews.title", "Reviews", "রিভিউ")}</h1>
      <p className="text-sm text-slate-500 card p-4 mb-4">
        {t("reviews.hint", "💡 To ask a customer for a review, go to the order page and use the “Ask for review” button. Here you only see review requests and received reviews.", "💡 কাস্টমারকে রিভিউ চাইতে হলে অর্ডারের পেজে গিয়ে “রিভিউ চান” বোতামটি ব্যবহার করুন। এখানে শুধু রিভিউর অনুরোধ ও পাওয়া রিভিউ দেখা যায়।")}
      </p>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}

      {loading ? (<div className="space-y-2"><div className="skeleton h-12" /><div className="skeleton h-12" /><div className="skeleton h-12" /></div>) : reviews.length === 0 ? (
        <div className="empty-state">{t("reviews.empty", "No review requests or reviews.", "কোনো রিভিউ অনুরোধ বা রিভিউ নেই।")}</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="table-head border-b text-left text-slate-500"><th className="p-3">{t("reviews.thOrder", "Order", "অর্ডার")}</th><th className="p-3">{t("reviews.thCustomer", "Customer", "কাস্টমার")}</th><th className="p-3">{t("reviews.thStatus", "Status", "স্ট্যাটাস")}</th><th className="p-3">{t("reviews.thRating", "Rating", "রেটিং")}</th><th className="p-3">{t("reviews.thComment", "Comment", "মন্তব্য")}</th><th className="p-3">{t("reviews.thDate", "Date", "তারিখ")}</th></tr></thead>
            <tbody>
              {reviews.map((r) => (
                <tr key={r.id} className="border-b transition-colors hover:bg-orange-50">
                  <td className="p-3">{r.orderNumber || r.order_number || r.orderId || r.order_id || "—"}</td>
                  <td className="p-3">{r.customer?.name || r.customerName || r.customer_name || "—"}</td>
                  <td className="p-3">{r.status || "—"}</td>
                  <td className="p-3">{r.rating != null ? `${fmtNum(r.rating)} ⭐` : "—"}</td>
                  <td className="p-3">{r.comment || r.text || "—"}</td>
                  <td className="p-3">{fmtDate(r.createdAt || r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
