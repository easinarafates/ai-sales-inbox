"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { getToken } from "@/lib/api";
import { commentsApi, type ModeratedComment } from "@/lib/api-new-features";

const STATUS_OPTIONS = ["", "to_check", "answered", "hidden", "done"];

export default function CommentsPage() {
  const { t, fmtDate } = useI18n();
  const router = useRouter();
  const [comments, setComments] = useState<ModeratedComment[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");
  const [answerText, setAnswerText] = useState<Record<string, string>>({});
  const [newBody, setNewBody] = useState("");
  const [newPostId, setNewPostId] = useState("");

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
    <div className="bg-[#fff8f3] min-h-screen -m-6 p-6">
      <h1 className="text-2xl font-bold mb-1">{t("commentsTitle", "Comments", "কমেন্ট")}</h1>
      <p className="text-sm text-slate-500 mb-4">{t("commentsSub", "Check, answer, hide or finish post comments here.", "পোস্টের কমেন্ট এখানে যাচাই করুন, উত্তর দিন, লুকান বা শেষ করুন।")}</p>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}

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
        className="bg-white rounded-xl shadow p-4 mb-6 grid gap-3"
      >
        <h2 className="font-bold">{t("cLogTitle", "Log a comment by hand", "হাতে একটি কমেন্ট লিখুন")}</h2>
        <input value={newPostId} onChange={(e) => setNewPostId(e.target.value)} placeholder={t("cPostIdPh", "Post ID (optional)", "পোস্ট আইডি (ঐচ্ছিক)")} className="border rounded-lg px-3 py-2" />
        <input required value={newBody} onChange={(e) => setNewBody(e.target.value)} placeholder={t("cBodyPh", "Comment text…", "কমেন্টের লেখা…")} className="border rounded-lg px-3 py-2" />
        <button className="bg-[#ff6a4d] hover:bg-[#e04e33] text-white rounded-lg px-4 py-2 w-fit">{t("add", "Add", "যোগ করুন")}</button>
      </form>

      {loading ? (
        <p className="text-slate-500">{t("loading", "Loading…", "লোড হচ্ছে…")}</p>
      ) : comments.length === 0 ? (
        <p className="text-slate-500">{t("commentsEmpty", "No comments here yet.", "এখানে এখনো কোনো কমেন্ট নেই।")}</p>
      ) : (
        <div className="grid gap-3">
          {comments.map((c) => (
            <div key={c.id} className="bg-white rounded-xl shadow p-4">
              <div className="flex justify-between gap-2 flex-wrap">
                <span className="text-xs bg-[#ff6a4d]/10 text-[#ff6a4d] rounded-full px-2 py-1 h-fit">{statusLabel(c.status)}</span>
                <span className="text-xs text-slate-400">{fmtDate(c.created_at)}</span>
              </div>
              <p className="mt-2 text-sm">{c.body}</p>
              {c.platform_post_id && <p className="text-xs text-slate-400 mt-1">{t("cPost", "Post:", "পোস্ট:")} {c.platform_post_id}</p>}
              {c.reply_text && (
                <p className="text-sm bg-teal-600/5 border border-teal-600/20 rounded-lg p-2 mt-2">
                  {t("cYourReply", "Your reply:", "আপনার উত্তর:")} {c.reply_text}
                </p>
              )}
              <div className="flex gap-2 mt-3">
                <input
                  value={answerText[c.id] ?? ""}
                  onChange={(e) => setAnswerText((p) => ({ ...p, [c.id]: e.target.value }))}
                  placeholder={t("cAnswerPh", "Write a reply…", "উত্তর লিখুন…")}
                  className="border rounded-lg px-3 py-1 text-sm flex-1"
                />
                <button
                  disabled={!(answerText[c.id] ?? "").trim()}
                  onClick={() => act(() => commentsApi.answer(c.id, answerText[c.id] ?? "").then(() => setAnswerText((p) => ({ ...p, [c.id]: "" }))), "cAnswerFail", "Could not send the reply.", "উত্তর পাঠানো যায়নি।")}
                  className="bg-[#ff6a4d] hover:bg-[#e04e33] text-white text-sm rounded-lg px-3 py-1 disabled:opacity-50"
                >
                  {t("cAnswer", "Answer", "উত্তর দিন")}
                </button>
                <button onClick={() => act(() => commentsApi.hide(c.id), "cHideFail", "Could not hide the comment.", "কমেন্ট লুকানো যায়নি।")} className="text-sm border rounded-lg px-3 py-1">
                  {t("cHide", "Hide", "লুকান")}
                </button>
                <button onClick={() => act(() => commentsApi.markDone(c.id), "cDoneFail", "Could not mark done.", "শেষ করা যায়নি।")} className="text-sm border border-teal-600 text-teal-600 rounded-lg px-3 py-1">
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
    </div>
  );
}
