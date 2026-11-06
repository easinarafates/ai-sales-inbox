"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { getToken } from "@/lib/api";
import { savedRepliesApi, type SavedReply } from "@/lib/api-new-features";

export default function SavedRepliesPage() {
  const { t } = useI18n();
  const router = useRouter();
  const [replies, setReplies] = useState<SavedReply[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [channel, setChannel] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await savedRepliesApi.list();
      setReplies(data.savedReplies ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("savedLoadFail", "Could not load saved replies.", "সেভ করা উত্তর লোড করা যায়নি।"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!getToken()) { router.push("/login"); return; }
    load();
  }, [load, router]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      if (editingId) {
        await savedRepliesApi.update(editingId, { title, body, channel: channel || null });
        setEditingId(null);
      } else {
        await savedRepliesApi.create({ title, body, channel: channel || undefined });
      }
      setTitle(""); setBody(""); setChannel("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("savedSaveFail", "Could not save the reply.", "উত্তরটি সেভ করা যায়নি।"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm(t("savedDeleteConfirm", "Delete this saved reply?", "এই সেভ করা উত্তরটি মুছে ফেলবেন?"))) return;
    try {
      await savedRepliesApi.remove(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("savedDeleteFail", "Could not delete the reply.", "উত্তরটি মোছা যায়নি।"));
    }
  };

  return (
    <div className="bg-[#fff8f3] min-h-screen -m-6 p-6">
      <h1 className="text-2xl font-bold mb-1">{t("savedTitle", "Saved replies", "সেভ করা উত্তর")}</h1>
      <p className="text-sm text-slate-500 mb-4">{t("savedSub", "Write answers once, then send them in the inbox with one tap.", "একবার উত্তর লিখুন, তারপর ইনবক্সে এক ক্লিকে পাঠান।")}</p>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}

      <form onSubmit={save} className="bg-white rounded-xl shadow p-4 mb-6 grid gap-3">
        <h2 className="font-bold">{editingId ? t("savedEdit", "Edit saved reply", "সেভ করা উত্তর সম্পাদনা করুন") : t("savedNew", "New saved reply", "নতুন সেভ করা উত্তর")}</h2>
        <input required value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("savedTitlePh", "Title, e.g. Delivery charge", "শিরোনাম, যেমন: ডেলিভারি চার্জ")} className="border rounded-lg px-3 py-2" />
        <textarea required value={body} onChange={(e) => setBody(e.target.value)} placeholder={t("savedBodyPh", "Reply text…", "উত্তরের লেখা…")} className="border rounded-lg px-3 py-2" rows={3} />
        <select value={channel} onChange={(e) => setChannel(e.target.value)} className="border rounded-lg px-3 py-2 bg-white">
          <option value="">{t("savedAllChannels", "All channels", "সব চ্যানেল")}</option>
          <option value="messenger">Messenger</option>
          <option value="instagram">Instagram</option>
          <option value="whatsapp">WhatsApp</option>
          <option value="website">Website</option>
        </select>
        <div className="flex gap-2">
          <button disabled={saving} className="bg-[#ff6a4d] hover:bg-[#e04e33] text-white rounded-lg px-4 py-2 disabled:opacity-50">
            {saving ? t("saving", "Saving…", "সেভ হচ্ছে…") : t("save", "Save", "সেভ করুন")}
          </button>
          {editingId && (
            <button type="button" onClick={() => { setEditingId(null); setTitle(""); setBody(""); setChannel(""); }} className="border rounded-lg px-4 py-2">
              {t("cancel", "Cancel", "বাতিল")}
            </button>
          )}
        </div>
      </form>

      {loading ? (
        <p className="text-slate-500">{t("loading", "Loading…", "লোড হচ্ছে…")}</p>
      ) : replies.length === 0 ? (
        <p className="text-slate-500">{t("savedEmpty", "No saved replies yet.", "এখনো কোনো সেভ করা উত্তর নেই।")}</p>
      ) : (
        <div className="grid gap-3">
          {replies.map((r) => (
            <div key={r.id} className="bg-white rounded-xl shadow p-4">
              <div className="flex justify-between gap-2">
                <h3 className="font-bold">{r.title}</h3>
                {r.channel && <span className="text-xs bg-teal-600/10 text-teal-600 rounded-full px-2 py-1 h-fit">{r.channel}</span>}
              </div>
              <p className="text-sm text-slate-600 whitespace-pre-wrap mt-1">{r.body}</p>
              <div className="flex gap-2 mt-3">
                <button
                  onClick={() => { setEditingId(r.id); setTitle(r.title); setBody(r.body); setChannel(r.channel ?? ""); }}
                  className="text-sm border rounded-lg px-3 py-1"
                >
                  {t("edit", "Edit", "সম্পাদনা")}
                </button>
                <button onClick={() => remove(r.id)} className="text-sm border border-red-200 text-red-600 rounded-lg px-3 py-1">
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
