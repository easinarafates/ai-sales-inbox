"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { getToken } from "@/lib/api";
import { commentsApi, type ModeratedComment } from "@/lib/api-new-features";
import { tiktokApi, youtubeApi, type SocialComment, type SocialVideo } from "@/lib/api-social";

const STATUS_OPTIONS = ["", "to_check", "answered", "hidden", "done"];

/** Live YouTube / TikTok comments (fetched from the platform, never faked). */
function SocialCommentsPanel({ platform }: { platform: "youtube" | "tiktok" }) {
  const { t, fmtDate } = useI18n();
  const [videos, setVideos] = useState<SocialVideo[]>([]);
  const [videoId, setVideoId] = useState("");
  const [comments, setComments] = useState<SocialComment[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [replyText, setReplyText] = useState<Record<string, string>>({});
  const [repliedIds, setRepliedIds] = useState<Record<string, boolean>>({});

  const loadComments = useCallback(async (vid: string) => {
    if (!vid) return;
    setLoading(true);
    setError("");
    try {
      const data = platform === "youtube"
        ? await youtubeApi.comments(vid)
        : await tiktokApi.comments(vid);
      setComments(data.comments ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("socialCommentsFail", "Could not load comments from the platform.", "প্ল্যাটফর্ম থেকে কমেন্ট আনা যায়নি।"));
      setComments([]);
    } finally {
      setLoading(false);
    }
  }, [platform, t]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    (platform === "youtube" ? youtubeApi.videos() : tiktokApi.videos())
      .then((d) => {
        if (!alive) return;
        const list = d.videos ?? [];
        setVideos(list);
        if (list[0]) {
          setVideoId(list[0].id);
          loadComments(list[0].id);
        } else {
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : t("socialVideosFail", "Could not load videos — is the channel connected?", "ভিডিও আনা যায়নি — চ্যানেলটি কি যুক্ত আছে?"));
        setLoading(false);
      });
    return () => { alive = false; };
  }, [platform, loadComments, t]);

  const reply = async (c: SocialComment) => {
    const text = (replyText[c.commentId] ?? "").trim();
    if (!text) return;
    setError("");
    try {
      if (platform === "youtube") await youtubeApi.reply(c.commentId, text);
      else await tiktokApi.reply(videoId, c.commentId, text);
      setRepliedIds((p) => ({ ...p, [c.commentId]: true }));
      setReplyText((p) => ({ ...p, [c.commentId]: "" }));
      await loadComments(videoId);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("socialReplyFail", "Could not send the reply.", "উত্তর পাঠানো যায়নি।"));
    }
  };

  return (
    <div>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}
      <div className="flex gap-2 mb-4 flex-wrap">
        <select
          value={videoId}
          onChange={(e) => { setVideoId(e.target.value); loadComments(e.target.value); }}
          className="border rounded-lg px-3 py-2 bg-white"
        >
          <option value="">{t("socialPickVideo", "Pick a video", "ভিডিও বেছে নিন")}</option>
          {videos.map((v) => (
            <option key={v.id} value={v.id}>{v.title || v.id}</option>
          ))}
        </select>
        <button onClick={() => loadComments(videoId)} disabled={!videoId} className="text-sm border rounded-lg px-3 py-2 bg-white disabled:opacity-50">
          {t("refresh", "Refresh", "আবার আনুন")}
        </button>
      </div>
      {loading ? (
        <div className="space-y-2"><div className="skeleton h-12" /><div className="skeleton h-12" /><div className="skeleton h-12" /></div>
      ) : !videoId ? (
        <div className="empty-state">{t("socialNoVideos", "No videos found — connect the channel on the Channels page first.", "কোনো ভিডিও পাওয়া যায়নি — প্রথমে Channels পেজ থেকে চ্যানেলটি যুক্ত করুন।")}</div>
      ) : comments.length === 0 ? (
        <div className="empty-state">{t("socialNoComments", "No comments on this video yet.", "এই ভিডিওতে এখনো কোনো কমেন্ট নেই।")}</div>
      ) : (
        <div className="grid gap-3">
          {comments.map((c) => (
            <div key={c.commentId} className="card p-4">
              <div className="flex justify-between gap-2 flex-wrap">
                <span className="text-sm font-bold">{c.author}</span>
                <span className="text-xs text-slate-400">{c.publishedAt ? fmtDate(c.publishedAt) : ""}</span>
              </div>
              <p className="mt-2 text-sm">{c.text}</p>
              <p className="text-xs text-slate-400 mt-1">
                {t("socialLikes", "Likes:", "লাইক:")} {c.likeCount}
                {c.replyCount > 0 ? ` • ${t("socialReplies", "Replies:", "উত্তর:")} ${c.replyCount}` : ""}
              </p>
              {(c.replies ?? []).map((r) => (
                <p key={r.commentId} className="text-sm bg-slate-50 border rounded-lg p-2 mt-2 ml-4">
                  <span className="font-bold">{r.author}:</span> {r.text}
                </p>
              ))}
              {repliedIds[c.commentId] && (
                <p className="text-sm text-green-700 mt-2">{t("socialReplied", "Reply sent ✓", "উত্তর পাঠানো হয়েছে ✓")}</p>
              )}
              <div className="flex flex-wrap gap-2 mt-3">
                <input
                  value={replyText[c.commentId] ?? ""}
                  onChange={(e) => setReplyText((p) => ({ ...p, [c.commentId]: e.target.value }))}
                  placeholder={t("cAnswerPh", "Write a reply…", "উত্তর লিখুন…")}
                  className="border rounded-lg px-3 py-1 text-sm flex-1"
                />
                <button
                  disabled={!(replyText[c.commentId] ?? "").trim()}
                  onClick={() => reply(c)}
                  className="bg-[#FF5B2E] hover:bg-[#E8491F] text-white text-sm rounded-lg px-3 py-1 disabled:opacity-50"
                >
                  {t("cAnswer", "Answer", "উত্তর দিন")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function CommentsPage() {
  const { t, fmtDate } = useI18n();
  const router = useRouter();
  const [comments, setComments] = useState<ModeratedComment[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");
  const [answerText, setAnswerText] = useState<Record<string, string>>({});
  const [likedIds, setLikedIds] = useState<Record<string, boolean>>({});
  const [newBody, setNewBody] = useState("");
  const [newPostId, setNewPostId] = useState("");
  const [tab, setTab] = useState<"facebook" | "youtube" | "tiktok">("facebook");

  const load = useCallback(async () => {
    try {
      const data = await commentsApi.list(statusFilter || undefined);
      setComments(data.comments ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("commentsLoadFail", "Could not load comments.", "কমেন্ট লোড করা যায়নি।"));
    } finally {
      setLoading(false);
    }
  }, [statusFilter, t]);

  useEffect(() => {
    if (!getToken()) { router.push("/login"); return; }
    load();
  }, [load, router]);

  const act = async (fn: () => Promise<unknown>, failKey: string, failEn: string, failBn: string) => {
    setError("");
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t(failKey, failEn, failBn));
    }
  };

  const statusLabel = (s: string) =>
    s === "to_check" ? t("cToCheck", "To check", "যাচাই করতে হবে")
    : s === "answered" ? t("cAnswered", "Answered", "উত্তর দেওয়া হয়েছে")
    : s === "hidden" ? t("cHidden", "Hidden", "লুকানো")
    : s === "done" ? t("cDone", "Done", "শেষ")
    : s;

  return (
    <div>
      <h1 className="page-title">{t("commentsTitle", "Comments", "কমেন্ট")}</h1>
      <p className="page-subtitle">{t("commentsSub", "Check, answer, hide or finish post comments here.", "পোস্টের কমেন্ট এখানে যাচাই করুন, উত্তর দিন, লুকান বা শেষ করুন।")}</p>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}

      <div className="flex gap-2 mb-4">
        {(["facebook", "youtube", "tiktok"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`text-sm rounded-lg px-4 py-2 ${tab === k ? "bg-[#FF5B2E] text-white" : "bg-white border"}`}
          >
            {k === "facebook" ? "Facebook" : k === "youtube" ? "YouTube" : "TikTok"}
          </button>
        ))}
      </div>

      {tab !== "facebook" ? (
        <SocialCommentsPanel platform={tab} />
      ) : (
      <>
      <div className="flex gap-2 mb-4">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="border rounded-lg px-3 py-2 bg-white">
          <option value="">{t("cAll", "All statuses", "সব অবস্থা")}</option>
          {STATUS_OPTIONS.slice(1).map((s) => (
            <option key={s} value={s}>{statusLabel(s)}</option>
          ))}
        </select>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          act(() => commentsApi.create({ body: newBody, platformPostId: newPostId || undefined }).then(() => { setNewBody(""); setNewPostId(""); }), "commentsCreateFail", "Could not add the comment.", "কমেন্ট যোগ করা যায়নি।");
        }}
        className="card p-4 mb-6 grid gap-3"
      >
        <h2 className="font-bold">{t("cLogTitle", "Log a comment by hand", "হাতে একটি কমেন্ট লিখুন")}</h2>
        <input value={newPostId} onChange={(e) => setNewPostId(e.target.value)} placeholder={t("cPostIdPh", "Post ID (optional)", "পোস্ট আইডি (ঐচ্ছিক)")} className="border rounded-lg px-3 py-2" />
        <input required value={newBody} onChange={(e) => setNewBody(e.target.value)} placeholder={t("cBodyPh", "Comment text…", "কমেন্টের লেখা…")} className="border rounded-lg px-3 py-2" />
        <button className="bg-[#FF5B2E] hover:bg-[#E8491F] text-white rounded-lg px-4 py-2 w-fit">{t("add", "Add", "যোগ করুন")}</button>
      </form>

      {loading ? (
        <div className="space-y-2"><div className="skeleton h-12" /><div className="skeleton h-12" /><div className="skeleton h-12" /></div>
      ) : comments.length === 0 ? (
        <div className="empty-state">{t("commentsEmpty", "No comments here yet.", "এখানে এখনো কোনো কমেন্ট নেই।")}</div>
      ) : (
        <div className="grid gap-3">
          {comments.map((c) => (
            <div key={c.id} className="card p-4">
              <div className="flex justify-between gap-2 flex-wrap">
                <span className="text-xs bg-[#FF5B2E]/10 text-[#FF5B2E] rounded-full px-2 py-1 h-fit">{statusLabel(c.status)}</span>
                <span className="text-xs text-slate-400">{fmtDate(c.created_at)}</span>
              </div>
              <p className="mt-2 text-sm">{c.body}</p>
              {c.platform_post_id && <p className="text-xs text-slate-400 mt-1">{t("cPost", "Post:", "পোস্ট:")} {c.platform_post_id}</p>}
              {c.reply_text && (
                <p className="text-sm bg-green-600/5 border border-green-600/20 rounded-lg p-2 mt-2">
                  {t("cYourReply", "Your reply:", "আপনার উত্তর:")} {c.reply_text}
                </p>
              )}
              <div className="flex flex-wrap gap-2 mt-3">
                <input
                  value={answerText[c.id] ?? ""}
                  onChange={(e) => setAnswerText((p) => ({ ...p, [c.id]: e.target.value }))}
                  placeholder={t("cAnswerPh", "Write a reply…", "উত্তর লিখুন…")}
                  className="border rounded-lg px-3 py-1 text-sm flex-1"
                />
                <button
                  disabled={!(answerText[c.id] ?? "").trim()}
                  onClick={() => act(() => commentsApi.answer(c.id, answerText[c.id] ?? "").then(() => setAnswerText((p) => ({ ...p, [c.id]: "" }))), "cAnswerFail", "Could not send the reply.", "উত্তর পাঠানো যায়নি।")}
                  className="bg-[#FF5B2E] hover:bg-[#E8491F] text-white text-sm rounded-lg px-3 py-1 disabled:opacity-50"
                >
                  {t("cAnswer", "Answer", "উত্তর দিন")}
                </button>
                <button onClick={() => act(() => commentsApi.hide(c.id), "cHideFail", "Could not hide the comment.", "কমেন্ট লুকানো যায়নি।")} className="text-sm border rounded-lg px-3 py-1">
                  {t("cHide", "Hide", "লুকান")}
                </button>
                {c.platform_comment_id && (
                  <button
                    onClick={() => act(() => commentsApi.like(c.id).then(() => setLikedIds((p) => ({ ...p, [c.id]: true }))), "cLikeFail", "Could not like the comment.", "কমেন্টে লাইক দেওয়া যায়নি।")}
                    disabled={likedIds[c.id]}
                    className="text-sm border rounded-lg px-3 py-1 disabled:opacity-50"
                  >
                    {likedIds[c.id]
                      ? t("cLiked", "Liked ✓", "লাইক দেওয়া হয়েছে ✓")
                      : t("cLike", "👍 Like", "👍 লাইক")}
                  </button>
                )}
                <button onClick={() => act(() => commentsApi.markDone(c.id), "cDoneFail", "Could not mark done.", "শেষ করা যায়নি।")} className="text-sm border border-green-600 text-green-600 rounded-lg px-3 py-1">
                  {t("cMarkDone", "Mark done", "শেষ করুন")}
                </button>
                <button
                  onClick={() => { if (confirm(t("cDeleteConfirm", "Delete this comment?", "এই কমেন্টটি মুছে ফেলবেন?"))) act(() => commentsApi.remove(c.id), "cDeleteFail", "Could not delete the comment.", "কমেন্ট মোছা যায়নি।"); }}
                  className="text-sm border border-red-200 text-red-600 rounded-lg px-3 py-1"
                >
                  {t("delete", "Delete", "মুছুন")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      </>
      )}
    </div>
  );
}
