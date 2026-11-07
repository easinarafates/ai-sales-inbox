"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  analyticsApi,
  asArrayOf,
  channelsApi,
  formatDate,
  getToken,
  type Channel,
  type PagePostAnalysis,
} from "@/lib/api";
import { useI18n } from "@/lib/i18n";

/**
 * Post analysis — real data from the connected Facebook Page, read live
 * from Meta Graph (likes, comments, shares + the top comments). Nothing
 * here is invented: a Page with no posts shows an honest empty state,
 * and a Graph denial shows the error instead of fake numbers.
 */
export default function PostAnalysisPage() {
  const router = useRouter();
  const { t, lang } = useI18n();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelId, setChannelId] = useState<string>("");
  const [data, setData] = useState<PagePostAnalysis | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [likedIds, setLikedIds] = useState<Record<string, boolean>>({});

  const likePost = async (postId: string) => {
    setError("");
    try {
      await analyticsApi.likePagePost(postId);
      setLikedIds((p) => ({ ...p, [postId]: true }));
      // Update just this post's counts in place — reloading the whole page
      // would blank it behind a loading spinner.
      setData((prev) =>
        prev
          ? {
              ...prev,
              posts: prev.posts.map((p) =>
                p.id === postId ? { ...p, likes: p.likes + 1, engagement: p.engagement + 1 } : p,
              ),
              totals: { ...prev.totals, likes: prev.totals.likes + 1, engagement: prev.totals.engagement + 1 },
            }
          : prev,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : t("pa.likeFailed", "Could not like the post.", "পোস্টে লাইক দেওয়া যায়নি।"));
    }
  };

  const load = useCallback(async (cid?: string) => {
    setLoading(true);
    setError("");
    try {
      const res = await analyticsApi.pagePosts(cid || undefined);
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("pa.loadFailed", "Could not load post analysis.", "পোস্ট বিশ্লেষণ লোড করা যায়নি।"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!getToken()) { router.push("/login"); return; }
    channelsApi.list()
      .then((res) => {
        const list = asArrayOf<Channel>(res, ["channels"]);
        const pages = list.filter((c) => ((c.platform as string) ?? (c.type as string)) === "messenger");
        setChannels(pages);
        const first = pages[0]?.id ?? "";
        setChannelId(first);
        load(first || undefined);
      })
      .catch(() => load(undefined));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  const onChannelChange = (id: string) => {
    setChannelId(id);
    load(id || undefined);
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">{t("pa.title", "Post analysis", "পোস্ট বিশ্লেষণ")}</h1>
      <p className="text-sm text-slate-500 mb-4">
        {t("pa.sub", "Real posts from your connected Facebook Page — engagement, top comments and what to do next.", "আপনার যুক্ত Facebook পেজের আসল পোস্ট — এনগেজমেন্ট, সেরা কমেন্ট আর পরের করণীয়।")}
      </p>

      {channels.length > 1 && (
        <div className="mb-4">
          <label className="text-sm text-slate-600 mr-2">{t("pa.page", "Page:", "পেজ:")}</label>
          <select
            value={channelId}
            onChange={(e) => onChannelChange(e.target.value)}
            className="border rounded-lg px-3 py-2 bg-white"
          >
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {(c.display_name as string) || (c.name as string) || c.id}
              </option>
            ))}
          </select>
        </div>
      )}

      {loading && (
        <div className="bg-white rounded-xl border p-6 text-slate-500">
          {t("pa.loading", "Reading your Page posts from Facebook…", "Facebook থেকে আপনার পেজের পোস্ট পড়া হচ্ছে…")}
        </div>
      )}

      {!loading && error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-4">
          <p className="font-medium">{t("pa.errorTitle", "Could not read posts from Facebook.", "Facebook থেকে পোস্ট পড়া যায়নি।")}</p>
          <p className="text-sm mt-1">{error}</p>
          <p className="text-sm mt-2">
            {t("pa.errorHint", "Check that the Page is still connected (Channels page) and that the app has the pages_read_engagement permission.", "পেজটি এখনো যুক্ত আছে কি না দেখুন (Channels পেজ) আর অ্যাপের pages_read_engagement অনুমতি আছে কি না।")}
          </p>
        </div>
      )}

      {!loading && !error && data && (
        <div className="space-y-4">
          {data.page && (
            <p className="text-sm text-slate-600">
              {t("pa.pageName", "Page:", "পেজ:")} <span className="font-medium">{data.page.name}</span>
              {data.fetchedAt && (
                <span className="text-slate-400"> · {formatDate(data.fetchedAt)}</span>
              )}
            </p>
          )}

          {data.posts.length === 0 ? (
            <div className="bg-white rounded-xl border p-6 text-slate-600">
              {data.message || t("pa.empty", "No posts found for this Page yet.", "এই পেজে এখনো কোনো পোস্ট পাওয়া যায়নি।")}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                {([
                  ["pa.totalPosts", "Posts", "পোস্ট", data.totals.posts],
                  ["pa.totalLikes", "Likes", "লাইক", data.totals.likes],
                  ["pa.totalComments", "Comments", "কমেন্ট", data.totals.comments],
                  ["pa.totalShares", "Shares", "শেয়ার", data.totals.shares],
                  ["pa.totalEngagement", "Engagement", "এনগেজমেন্ট", data.totals.engagement],
                ] as const).map(([key, en, bn, value]) => (
                  <div key={key} className="bg-white rounded-xl border p-4">
                    <p className="text-xs text-slate-500">{t(key, en, bn)}</p>
                    <p className="text-2xl font-bold">{value}</p>
                  </div>
                ))}
              </div>

              {data.suggestions.length > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                  <p className="font-medium mb-2">{t("pa.suggestions", "What to do next", "পরের করণীয়")}</p>
                  <ul className="list-disc pl-5 space-y-1 text-sm text-slate-700">
                    {data.suggestions.map((s, i) => (
                      <li key={i}>{lang === "bn" ? s.bn : s.en}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="space-y-3">
                {data.posts.map((p, i) => (
                  <div key={p.id} className={`bg-white rounded-xl border p-4 ${i === 0 ? "ring-2 ring-orange-200" : ""}`}>
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-sm whitespace-pre-wrap break-words">{p.message || t("pa.noCaption", "(no caption)", "(ক্যাপশন নেই)")}</p>
                      {i === 0 && (
                        <span className="shrink-0 text-xs font-medium bg-orange-100 text-orange-700 rounded-full px-2 py-1">
                          {t("pa.topPost", "Top post", "সেরা পোস্ট")}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-400 mt-2">
                      {p.createdTime ? formatDate(p.createdTime) : ""}
                      {p.permalinkUrl && (
                        <> · <a href={p.permalinkUrl} target="_blank" rel="noreferrer" className="text-blue-600 underline">
                          {t("pa.viewOnFacebook", "View on Facebook", "Facebook-এ দেখুন")}
                        </a></>
                      )}
                    </p>
                    <p className="text-sm text-slate-600 mt-2">
                      👍 {p.likes} · 💬 {p.comments} · 🔁 {p.shares} · ✨ {p.engagement}
                      <span className="text-slate-400"> · </span>
                      {t("pa.inInbox", "in Inbox:", "ইনবক্সে:")} {p.commentsInInbox}
                      {p.unansweredInInbox > 0 && (
                        <span className="ml-2 text-xs font-medium bg-red-100 text-red-700 rounded-full px-2 py-0.5">
                          {p.unansweredInInbox} {t("pa.unanswered", "unanswered", "উত্তর বাকি")}
                        </span>
                      )}
                    </p>
                    <button
                      onClick={() => likePost(p.id)}
                      disabled={likedIds[p.id]}
                      className="mt-2 text-sm border rounded-lg px-3 py-1 disabled:opacity-50"
                    >
                      {likedIds[p.id]
                        ? t("pa.liked", "Liked ✓", "লাইক দেওয়া হয়েছে ✓")
                        : t("pa.like", "👍 Like as Page", "👍 পেজ হিসেবে লাইক")}
                    </button>
                  </div>
                ))}
              </div>

              {data.topComments.length > 0 && (
                <div className="bg-white rounded-xl border p-4">
                  <p className="font-medium mb-3">{t("pa.topComments", "What buyers are saying", "ক্রেতারা যা বলছে")}</p>
                  <ul className="space-y-2">
                    {data.topComments.map((c, i) => (
                      <li key={i} className="text-sm border-b last:border-0 pb-2 last:pb-0">
                        <span className="font-medium">{c.author}:</span> {c.text}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
