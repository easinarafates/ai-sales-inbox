"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  asArrayOf,
  getToken,
  teachApi,
  type KnowledgeItem,
  type UnansweredQuestion,
} from "@/lib/api";
import { useI18n } from "@/lib/i18n";

export default function TeachPage() {
  const router = useRouter();
  const { t, fmtDate, fmtNum } = useI18n();
  const [unanswered, setUnanswered] = useState<UnansweredQuestion[]>([]);
  const [knowledge, setKnowledge] = useState<KnowledgeItem[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Teach form (per question)
  const [teachId, setTeachId] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");

  // Knowledge create/edit
  const [kTitle, setKTitle] = useState("");
  const [kBody, setKBody] = useState("");
  const [editing, setEditing] = useState<KnowledgeItem | null>(null);

  // Plain-language change box
  const [changeItemId, setChangeItemId] = useState("");
  const [instruction, setInstruction] = useState("");
  const [preview, setPreview] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [lastVersion, setLastVersion] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const [u, k] = await Promise.all([teachApi.unanswered(), teachApi.knowledgeList()]);
      setUnanswered(asArrayOf<UnansweredQuestion>(u, ["unanswered"]));
      setKnowledge(asArrayOf<KnowledgeItem>(k, ["knowledgeItems", "knowledge", "items"]));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("teach.loadFailed", "Could not load teaching information.", "শেখানোর তথ্য লোড করা যায়নি।"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!getToken()) { router.push("/login"); return; }
    load();
  }, [load, router]);

  const submitTeach = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!teachId || !answer.trim()) return;
    setError("");
    setSaving(true);
    try {
      await teachApi.teach(teachId, answer.trim());
      setTeachId(null);
      setAnswer("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("teach.teachFailed", "Could not teach the answer.", "উত্তর শেখানো যায়নি।"));
    } finally {
      setSaving(false);
    }
  };

  const submitKnowledge = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      if (editing) {
        await teachApi.knowledgeUpdate(editing.id, { title: kTitle || undefined, body: kBody });
        setEditing(null);
      } else {
        await teachApi.knowledgeCreate({ title: kTitle || undefined, body: kBody });
      }
      setKTitle(""); setKBody("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("teach.saveFailed", "Could not save the knowledge.", "জ্ঞান সংরক্ষণ করা যায়নি।"));
    } finally {
      setSaving(false);
    }
  };

  const deleteKnowledge = async (id: string) => {
    if (!confirm(t("teach.deleteConfirm", "Delete this information?", "এই তথ্যটি মুছে ফেলবেন?"))) return;
    setError("");
    try {
      await teachApi.knowledgeDelete(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("teach.deleteFailed", "Could not delete.", "মোছা যায়নি।"));
    }
  };

  const doPreview = async () => {
    if (!instruction.trim()) return;
    setError("");
    setPreview("");
    setPreviewing(true);
    try {
      const res = await teachApi.previewChange(changeItemId || undefined, instruction.trim());
      setPreview(res.preview || res.newBody || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("teach.previewFailed", "Could not make the preview.", "প্রিভিউ বানানো যায়নি।"));
    } finally {
      setPreviewing(false);
    }
  };

  const applyPreview = async () => {
    if (!changeItemId || !preview) return;
    setError("");
    setSaving(true);
    try {
      const res = await teachApi.applyChange(changeItemId, preview);
      if (res.versionId) {
        setLastVersion((prev) => ({ ...prev, [changeItemId]: res.versionId as string }));
      }
      setPreview("");
      setInstruction("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("teach.applyFailed", "Could not apply the change.", "বদল প্রয়োগ করা যায়নি।"));
    } finally {
      setSaving(false);
    }
  };

  const rollback = async (itemId: string) => {
    const versionId = lastVersion[itemId];
    if (!versionId) return;
    setError("");
    try {
      await teachApi.rollback(itemId, versionId);
      setLastVersion((prev) => {
        const next = { ...prev };
        delete next[itemId];
        return next;
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("teach.rollbackFailed", "Could not go back to the earlier version.", "আগের অবস্থায় ফেরানো যায়নি।"));
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">{t("teach.title", "Teach AI", "শেখানো")}</h1>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}

      {/* Unanswered questions */}
      <h2 className="text-xl font-bold mb-3">{t("teach.unansweredTitle", "Questions the AI could not answer", "AI যে প্রশ্নের উত্তর দিতে পারেনি")}</h2>
      {loading ? <p className="text-slate-500">{t("common.loading", "Loading…", "লোড হচ্ছে…")}</p> : unanswered.length === 0 ? (
        <p className="text-slate-500 card p-6 mb-6">{t("teach.noUnanswered", "No unanswered questions.", "কোনো উত্তর না দেওয়া প্রশ্ন নেই।")}</p>
      ) : (
        <div className="space-y-3 mb-6">
          {unanswered.map((q) => (
            <div key={q.id} className="card p-4">
              <p className="font-medium">{q.question}</p>
              <p className="text-xs text-slate-500 mt-1">
                {q.count ? `${fmtNum(q.count)} ${t("teach.timesAsked", "times asked", "বার জিজ্ঞেস করা হয়েছে")}` : ""} • {fmtDate(q.createdAt || q.created_at)}
                {q.taught ? t("teach.taught", " • ✅ Taught", " • ✅ শেখানো হয়েছে") : ""}
              </p>
              {teachId === q.id ? (
                <form onSubmit={submitTeach} className="mt-3 space-y-2">
                  <textarea required value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={t("teach.answerPlaceholder", "Write the correct answer…", "সঠিক উত্তর লিখুন…")} className="w-full border rounded-lg px-3 py-2" rows={3} />
                  <div className="flex gap-2">
                    <button disabled={saving} className="bg-brand text-white px-4 py-2 rounded-lg text-sm hover:bg-brand-dark disabled:opacity-50">
                      {saving ? t("teach.teaching", "Teaching…", "শেখানো হচ্ছে…") : t("teach.teachButton", "Teach answer", "উত্তর শেখান")}
                    </button>
                    <button type="button" onClick={() => { setTeachId(null); setAnswer(""); }} className="bg-slate-200 px-4 py-2 rounded-lg text-sm">{t("common.cancel", "Cancel", "বাতিল")}</button>
                  </div>
                </form>
              ) : (
                <button onClick={() => { setTeachId(q.id); setAnswer(""); }} className="mt-3 bg-brand text-white px-4 py-2 rounded-lg text-sm hover:bg-brand-dark">
                  {t("teach.teachButton", "Teach answer", "উত্তর শেখান")}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Knowledge book */}
      <h2 className="text-xl font-bold mb-3">{t("teach.bookTitle", "Knowledge Book", "জ্ঞানের বই (Knowledge Book)")}</h2>
      <form onSubmit={submitKnowledge} className="card p-4 mb-4 space-y-3">
        <h3 className="font-bold">{editing ? t("teach.editInfo", "Edit information", "তথ্য এডিট করুন") : t("teach.addInfo", "Add new information", "নতুন তথ্য যোগ করুন")}</h3>
        <input value={kTitle} onChange={(e) => setKTitle(e.target.value)} placeholder={t("teach.titlePlaceholder", "Title (optional)", "শিরোনাম (ঐচ্ছিক)")} className="w-full border rounded-lg px-3 py-2" />
        <textarea required value={kBody} onChange={(e) => setKBody(e.target.value)} placeholder={t("teach.bodyPlaceholder", "Write the information / answer… *", "তথ্য / উত্তর লিখুন… *")} className="w-full border rounded-lg px-3 py-2" rows={3} />
        <div className="flex gap-2">
          <button disabled={saving} className="bg-brand text-white px-4 py-2 rounded-lg hover:bg-brand-dark disabled:opacity-50">
            {saving ? t("teach.saving", "Saving…", "সংরক্ষণ হচ্ছে…") : editing ? t("teach.updateButton", "Update", "আপডেট করুন") : t("teach.addButton", "Add", "যোগ করুন")}
          </button>
          {editing && (
            <button type="button" onClick={() => { setEditing(null); setKTitle(""); setKBody(""); }} className="bg-slate-200 px-4 py-2 rounded-lg">{t("common.cancel", "Cancel", "বাতিল")}</button>
          )}
        </div>
      </form>

      {knowledge.length === 0 ? (
        <p className="text-slate-500 card p-6 mb-6">{t("teach.bookEmpty", "Nothing in the Knowledge Book yet.", "জ্ঞানের বইয়ে এখনো কিছু নেই।")}</p>
      ) : (
        <div className="space-y-3 mb-6">
          {knowledge.map((k) => (
            <div key={k.id} className="card p-4">
              {k.title && <p className="font-bold">{k.title}</p>}
              <p className="text-sm whitespace-pre-wrap">{k.body || "—"}</p>
              <div className="flex gap-2 mt-3">
                <button onClick={() => { setEditing(k); setKTitle(k.title || ""); setKBody(k.body || ""); }} className="bg-teal-600 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-teal-700">{t("common.edit", "Edit", "এডিট")}</button>
                <button onClick={() => deleteKnowledge(k.id)} className="bg-red-50 text-red-700 px-3 py-1.5 rounded-lg text-sm">{t("common.delete", "Delete", "মুছুন")}</button>
                {lastVersion[k.id] && (
                  <button onClick={() => rollback(k.id)} className="bg-amber-100 text-amber-800 px-3 py-1.5 rounded-lg text-sm">{t("teach.rollback", "Go back to the earlier version", "আগের সংস্করণে ফেরত যান")}</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Plain-language change box */}
      <div className="card p-4">
        <h2 className="font-bold mb-3">{t("teach.changeTitle", "Change it like this — give an instruction in simple words", "এভাবে বদলাও — সহজ ভাষায় নির্দেশ দিন")}</h2>
        <div className="space-y-3">
          <select value={changeItemId} onChange={(e) => { setChangeItemId(e.target.value); setPreview(""); }} className="w-full border rounded-lg px-3 py-2 bg-white">
            <option value="">{t("teach.pickInfo", "Pick which information to change", "কোন তথ্য বদলাবেন বাছুন")}</option>
            {knowledge.map((k) => (
              <option key={k.id} value={k.id}>{k.title || k.body?.slice(0, 60) || k.id}</option>
            ))}
          </select>
          <textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder={t("teach.instructionPlaceholder", "e.g. change the delivery charge from 60 taka to 80 taka", "যেমন: ডেলিভারি চার্জ ৬০ টাকা থেকে ৮০ টাকা করে দাও")} className="w-full border rounded-lg px-3 py-2" rows={2} />
          <div className="flex gap-2">
            <button onClick={doPreview} disabled={previewing || !instruction.trim()} className="bg-blue-600 text-white px-4 py-2 rounded-lg disabled:opacity-50">
              {previewing ? t("teach.previewing", "Making preview…", "প্রিভিউ বানানো হচ্ছে…") : t("teach.previewButton", "See preview", "প্রিভিউ দেখুন")}
            </button>
            {preview && (
              <button onClick={applyPreview} disabled={saving || !changeItemId} className="bg-brand text-white px-4 py-2 rounded-lg hover:bg-brand-dark disabled:opacity-50">
                {saving ? t("teach.applying", "Applying…", "প্রয়োগ হচ্ছে…") : t("teach.applyButton", "Apply", "প্রয়োগ করুন")}
              </button>
            )}
          </div>
          {preview && (
            <div className="bg-orange-50 border rounded-lg p-3">
              <p className="text-sm font-medium mb-1">{t("teach.previewLabel", "Preview:", "প্রিভিউ:")}</p>
              <p className="text-sm whitespace-pre-wrap">{preview}</p>
            </div>
          )}
          <p className="text-xs text-slate-500">{t("teach.rollbackNote", "After applying, you can go back to the earlier version in one click (the “Go back to the earlier version” button will show next to the information).", "প্রয়োগের পর এক ক্লিকে আগের সংস্করণে ফিরে যেতে পারবেন (তথ্যের পাশে “আগের সংস্করণে ফেরত যান” বোতাম দেখাবে)।")}</p>
        </div>
      </div>
    </div>
  );
}
