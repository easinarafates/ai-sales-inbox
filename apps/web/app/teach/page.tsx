"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  API_URL,
  asArrayOf,
  getToken,
  teachApi,
  type KnowledgeItem,
  type UnansweredQuestion,
} from "@/lib/api";
import { useI18n } from "@/lib/i18n";

/** A product found by Page Read, awaiting owner review. */
interface PageReadItem {
  id: string;
  name: string;
  price_paisa: number | null;
  description: string | null;
  photo_url: string | null;
  source_post_url: string | null;
  post_created_at: string | null;
  status: string;
  created_at: string;
}

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
  const [previewAi, setPreviewAi] = useState<boolean | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [openVersions, setOpenVersions] = useState<string | null>(null);
  const [versions, setVersions] = useState<Record<string, { id: string; body: string; createdAt?: string; created_at?: string }[]>>({});

  // Page Read ("পেজ পড়ুন") — learn old products from the Facebook Page
  const [pageReadItems, setPageReadItems] = useState<PageReadItem[]>([]);
  const [pageReading, setPageReading] = useState(false);
  const [pageReadResult, setPageReadResult] = useState("");
  const [pageReadError, setPageReadError] = useState("");
  const [editName, setEditName] = useState<Record<string, string>>({});
  const [editPrice, setEditPrice] = useState<Record<string, string>>({});
  const [editDesc, setEditDesc] = useState<Record<string, string>>({});

  const pageReadFetch = async (path: string, options: RequestInit = {}) => {
    const res = await fetch(`${API_URL}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getToken()}`,
        ...(options.headers as Record<string, string> | undefined),
      },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.errorBn || data?.error || "পেজ পড়া যায়নি।");
    return data;
  };

  const loadPageRead = useCallback(async () => {
    try {
      const data = await pageReadFetch("/api/knowledge/page-read?status=pending");
      setPageReadItems(asArrayOf<PageReadItem>(data, ["items"]));
    } catch {
      // Members (non-owners) cannot see the review list — not an error here.
      setPageReadItems([]);
    }
  }, []);

  const doPageRead = async () => {
    setPageReadError("");
    setPageReadResult("");
    setPageReading(true);
    try {
      const data = await pageReadFetch("/api/knowledge/page-read", { method: "POST", body: JSON.stringify({}) });
      setPageReadResult(data.message || `${data.postsScanned}টি পোস্ট পড়া হয়েছে, ${data.inserted}টি নতুন পণ্য পাওয়া গেছে।`);
      await loadPageRead();
    } catch (err) {
      setPageReadError(err instanceof Error ? err.message : "পেজটি পড়া যায়নি।");
    } finally {
      setPageReading(false);
    }
  };

  const confirmPageRead = async (item: PageReadItem) => {
    setPageReadError("");
    try {
      const priceText = (editPrice[item.id] ?? "").trim();
      const pricePaisa = priceText === "" ? null : Math.round(parseFloat(priceText.replace(/[০-৯]/g, (d) => String("০১২৩৪৫৬৭৮৯".indexOf(d)))) * 100);
      await pageReadFetch(`/api/knowledge/page-read/${item.id}/confirm`, {
        method: "POST",
        body: JSON.stringify({
          name: (editName[item.id] ?? item.name).trim(),
          pricePaisa,
          description: editDesc[item.id] ?? item.description ?? "",
          photoUrl: item.photo_url,
        }),
      });
      setPageReadResult(`“${item.name}” AI-কে শেখানো হয়েছে — এটি পুরোনো পণ্য হিসেবে সংরক্ষিত হয়েছে, স্টক নিশ্চিত না হওয়া পর্যন্ত AI এটিকে স্টকে আছে বলবে না।`);
      await loadPageRead();
      await load();
    } catch (err) {
      setPageReadError(err instanceof Error ? err.message : "নিশ্চিত করা যায়নি।");
    }
  };

  const rejectPageRead = async (item: PageReadItem) => {
    if (!confirm(`“${item.name}” বাতিল করবেন?`)) return;
    setPageReadError("");
    try {
      await pageReadFetch(`/api/knowledge/page-read/${item.id}/reject`, { method: "POST", body: JSON.stringify({}) });
      await loadPageRead();
    } catch (err) {
      setPageReadError(err instanceof Error ? err.message : "বাতিল করা যায়নি।");
    }
  };

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
    loadPageRead();
  }, [load, loadPageRead, router]);

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
    setPreviewAi(null);
    setPreviewing(true);
    try {
      const res = await teachApi.previewChange(changeItemId || undefined, instruction.trim());
      setPreview(res.preview || res.newBody || "");
      // The API says plainly when the AI could not answer (aiGenerated:
      // false) — then the preview is just the current text, unchanged.
      setPreviewAi(res.aiGenerated ?? true);
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
      setPreview("");
      setPreviewAi(null);
      setInstruction("");
      await load();
      if (res.versionId) setOpenVersions(changeItemId);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("teach.applyFailed", "Could not apply the change.", "বদল প্রয়োগ করা যায়নি।"));
    } finally {
      setSaving(false);
    }
  };

  const loadVersions = async (itemId: string) => {
    try {
      const list = await teachApi.listVersions(itemId);
      setVersions((prev) => ({ ...prev, [itemId]: list }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("teach.rollbackFailed", "Could not go back to the earlier version.", "আগের অবস্থায় ফেরানো যায়নি।"));
    }
  };

  const toggleVersions = async (itemId: string) => {
    if (openVersions === itemId) {
      setOpenVersions(null);
      return;
    }
    setOpenVersions(itemId);
    if (!versions[itemId]) await loadVersions(itemId);
  };

  const rollback = async (itemId: string, versionId: string) => {
    if (!versionId) return;
    setError("");
    try {
      await teachApi.rollback(itemId, versionId);
      await loadVersions(itemId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("teach.rollbackFailed", "Could not go back to the earlier version.", "আগের অবস্থায় ফেরানো যায়নি।"));
    }
  };

  return (
    <div>
      <h1 className="page-title">{t("teach.title", "Teach AI", "শেখানো")}</h1>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}

      {/* Unanswered questions */}
      <h2 className="text-xl font-bold mb-3">{t("teach.unansweredTitle", "Questions the AI could not answer", "AI যে প্রশ্নের উত্তর দিতে পারেনি")}</h2>
      {loading ? (<div className="space-y-2"><div className="skeleton h-12" /><div className="skeleton h-12" /><div className="skeleton h-12" /></div>) : unanswered.length === 0 ? (
        <div className="empty-state mb-6">{t("teach.noUnanswered", "No unanswered questions.", "কোনো উত্তর না দেওয়া প্রশ্ন নেই।")}</div>
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

      {/* Page Read — "পেজ পড়ুন": learn old products from the Facebook Page */}
      <div className="card p-4 mb-6 border-2" style={{ borderColor: "#0051F6" }}>
        <h2 className="text-xl font-bold mb-2">📖 পেজ পড়ুন — পুরোনো পণ্য শেখান</h2>
        <p className="text-sm text-slate-600 mb-3">
          পেজের পুরোনো পোস্টগুলো পড়ে AI আগের বিক্রি হওয়া পণ্যগুলো চিনবে — যেগুলো ওয়েবসাইটের পণ্য তালিকায় নেই। নিচে দেখে প্রতিটি পণ্য নিশ্চিত করুন; নিশ্চিত না করা পর্যন্ত AI এগুলো শিখবে না। নিশ্চিত করা পণ্য “পুরোনো পণ্য — স্টকে আছে কিনা নিশ্চিত নয়” হিসেবে সংরক্ষিত হয়, তাই AI কখনোই পুরোনো পণ্য স্টকে আছে বলে দাবি করবে না।
        </p>
        {pageReadError && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-3">{pageReadError}</p>}
        {pageReadResult && <p className="bg-green-50 text-green-800 text-sm p-3 rounded-lg mb-3">{pageReadResult}</p>}
        <button onClick={doPageRead} disabled={pageReading} className="text-white px-5 py-2.5 rounded-lg text-sm font-bold disabled:opacity-50" style={{ background: "linear-gradient(90deg,#0051F6,#8B35F6)" }}>
          {pageReading ? "পেজ পড়া হচ্ছে… ⏳" : "📖 পেজ পড়ুন"}
        </button>
        {pageReadItems.length === 0 ? (
          <p className="text-sm text-slate-500 mt-3">পর্যালোচনার অপেক্ষায় কোনো পণ্য নেই। পেজ পড়লে পাওয়া পণ্যগুলো এখানে দেখাবে।</p>
        ) : (
          <div className="space-y-3 mt-4">
            {pageReadItems.map((item) => (
              <div key={item.id} className="border rounded-lg p-3 bg-white">
                <div className="flex gap-3">
                  {item.photo_url && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.photo_url} alt={item.name} className="w-20 h-20 object-cover rounded-lg shrink-0" />
                  )}
                  <div className="flex-1 space-y-2">
                    <input
                      value={editName[item.id] ?? item.name}
                      onChange={(e) => setEditName((p) => ({ ...p, [item.id]: e.target.value }))}
                      className="w-full border rounded-lg px-3 py-1.5 font-bold"
                      placeholder="পণ্যের নাম"
                    />
                    <div className="flex gap-2 items-center">
                      <label className="text-sm text-slate-600 shrink-0">দাম (টাকা)</label>
                      <input
                        value={editPrice[item.id] ?? (item.price_paisa != null ? String(item.price_paisa / 100) : "")}
                        onChange={(e) => setEditPrice((p) => ({ ...p, [item.id]: e.target.value }))}
                        className="w-32 border rounded-lg px-3 py-1.5"
                        placeholder="দাম নেই"
                        inputMode="decimal"
                      />
                      {item.price_paisa == null && <span className="text-xs text-amber-700 bg-amber-100 rounded px-2 py-1">পোস্টে দাম ছিল না — দাম বানিয়ে লেখা হয়নি</span>}
                    </div>
                    <textarea
                      value={editDesc[item.id] ?? item.description ?? ""}
                      onChange={(e) => setEditDesc((p) => ({ ...p, [item.id]: e.target.value }))}
                      className="w-full border rounded-lg px-3 py-1.5 text-sm"
                      rows={2}
                      placeholder="বিবরণ"
                    />
                    {item.source_post_url && (
                      <a href={item.source_post_url} target="_blank" rel="noreferrer" className="text-xs text-blue-700 underline">মূল পোস্ট দেখুন</a>
                    )}
                  </div>
                </div>
                <div className="flex gap-2 mt-3">
                  <button onClick={() => confirmPageRead(item)} className="text-white px-4 py-2 rounded-lg text-sm font-bold" style={{ background: "#0051F6" }}>✅ নিশ্চিত করুন — AI শিখবে</button>
                  <button onClick={() => rejectPageRead(item)} className="bg-red-50 text-red-700 px-4 py-2 rounded-lg text-sm">✖ বাতিল</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

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
        <div className="empty-state mb-6">{t("teach.bookEmpty", "Nothing in the Knowledge Book yet.", "জ্ঞানের বইয়ে এখনো কিছু নেই।")}</div>
      ) : (
        <div className="space-y-3 mb-6">
          {knowledge.map((k) => (
            <div key={k.id} className="card p-4">
              {k.title && <p className="font-bold">{k.title}</p>}
              <p className="text-sm whitespace-pre-wrap">{k.body || "—"}</p>
              <div className="flex gap-2 mt-3">
                <button onClick={() => { setEditing(k); setKTitle(k.title || ""); setKBody(k.body || ""); }} className="bg-green-600 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-green-700">{t("common.edit", "Edit", "এডিট")}</button>
                <button onClick={() => deleteKnowledge(k.id)} className="bg-red-50 text-red-700 px-3 py-1.5 rounded-lg text-sm">{t("common.delete", "Delete", "মুছুন")}</button>
                <button onClick={() => toggleVersions(k.id)} className="bg-amber-100 text-amber-800 px-3 py-1.5 rounded-lg text-sm">{t("teach.versionsTitle", "Earlier versions", "আগের সংস্করণগুলো")}</button>
              </div>
              {openVersions === k.id && (
                <div className="mt-3 border-t pt-3">
                  {(versions[k.id] ?? []).length === 0 ? (
                    <p className="text-sm text-slate-500">{t("teach.noVersions", "No earlier versions yet.", "এখনো আগের কোনো সংস্করণ নেই।")}</p>
                  ) : (
                    <ul className="space-y-2">
                      {versions[k.id].map((v) => (
                        <li key={v.id} className="bg-orange-50 border rounded-lg p-3">
                          <p className="text-sm whitespace-pre-wrap">{v.body}</p>
                          <button onClick={() => rollback(k.id, v.id)} className="mt-2 text-sm text-amber-800 underline">{t("teach.rollbackTo", "Go back to this version", "এই সংস্করণে ফেরত যান")}</button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
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
              {previewAi === false && (
                <p className="text-sm text-amber-800 bg-amber-100 rounded-lg p-2 mb-2">{t("teach.previewNotAi", "The AI could not answer right now, so this preview is your current text, unchanged.", "AI এখন উত্তর দিতে পারছে না, তাই এই প্রিভিউতে আপনার বর্তমান লেখাটাই অপরিবর্তিত আছে।")}</p>
              )}
              <p className="text-sm whitespace-pre-wrap">{preview}</p>
            </div>
          )}
          <p className="text-xs text-slate-500">{t("teach.rollbackNote", "Earlier versions are saved automatically — open “Earlier versions” next to any information to go back.", "আগের সংস্করণগুলো নিজে নিজে সেভ থাকে — কোনো তথ্যের পাশে “আগের সংস্করণগুলো” খুলে ফিরে যেতে পারবেন।")}</p>
        </div>
      </div>
    </div>
  );
}
