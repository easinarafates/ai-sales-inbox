"use client";
import type { AnalyticsPost } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

/**
 * Per-post sales — post attribution table.
 *
 * Shows real numbers from GET /api/analytics/posts: comments, chats,
 * orders. A 0 on a post is a real 0 — nothing has come from that post yet
 * (numbers are never made up).
 *
 * Usage (see apps/api/src/analytics/integration-notes.md):
 *   import PostAttributionTable from "./PostAttributionTable";
 *   <PostAttributionTable posts={posts} />
 * where posts is the list from analyticsApi.posts().
 */
export default function PostAttributionTable({ posts }: { posts: AnalyticsPost[] }) {
  const { t, fmtNum } = useI18n();
  return (
    <div className="card p-4 mb-6 overflow-x-auto">
      <h2 className="font-bold mb-3">{t("analytics.postsTitle", "Sales per post", "প্রতি পোস্টের হিসাব")}</h2>
      {posts.length === 0 ? (
        <p className="text-sm text-slate-500">{t("analytics.postsEmpty", "No post information.", "কোনো পোস্টের তথ্য নেই।")}</p>
      ) : (
        <>
          <table className="w-full text-sm">
            <thead>
              <tr className="table-head border-b text-left text-slate-500">
                <th className="p-3">{t("analytics.postsThPost", "Post", "পোস্ট")}</th>
                <th className="p-3">{t("analytics.postsThPlatform", "Platform", "প্ল্যাটফর্ম")}</th>
                <th className="p-3">{t("analytics.postsThComments", "Comments", "কমেন্ট")}</th>
                <th className="p-3">{t("analytics.postsThChats", "Chats", "চ্যাট")}</th>
                <th className="p-3">{t("analytics.postsThOrders", "Orders", "অর্ডার")}</th>
              </tr>
            </thead>
            <tbody>
              {posts.map((p, i) => (
                <tr key={p.postId || p.post_id || i} className="border-b transition-colors hover:bg-orange-50">
                  <td className="p-3">{p.caption || p.postId || p.post_id || "—"}</td>
                  <td className="p-3">{(p.platforms || []).join(", ") || "—"}</td>
                  <td className="p-3">{fmtNum(p.comments ?? 0)}</td>
                  <td className="p-3">{fmtNum(p.chats ?? 0)}</td>
                  <td className="p-3">{fmtNum(p.orders ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-slate-500 mt-3">
            {t("analytics.postsFootnote", "Chats = chats started from a comment on that post; Orders = orders from those chats. 0 means nothing has come from that post yet.", "চ্যাট = ওই পোস্টের কমেন্ট থেকে শুরু হওয়া চ্যাট; অর্ডার = ওই চ্যাট থেকে আসা অর্ডার। ০ মানে ওই পোস্ট থেকে এখনো কিছু আসেনি।")}
          </p>
        </>
      )}
    </div>
  );
}
