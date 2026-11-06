"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { getToken } from "@/lib/api";
import { agentDeskApi, type AgentInstruction } from "@/lib/api-new-features";

export default function AgentDeskPage() {
  const { t, fmtDate } = useI18n();
  const router = useRouter();
  const [versions, setVersions] = useState<AgentInstruction[]>([]);
  const [active, setActive] = useState<AgentInstruction | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [body, setBody] = useState("");
  const [question, setQuestion] = useState("");
  const [testAnswer, setTestAnswer] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testNote, setTestNote] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await agentDeskApi.list();
      setVersions(data.instructions ?? []);
      setActive(data.active ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("deskLoadFail", "Could not load instructions.", "নির্দেশনা লোড করা যায়নি।"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!getToken()) { router.push("/login"); return; }
    load();
  }, [load, router]);

  const createDraft = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      await agentDeskApi.createDraft(body);
      setBody("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("deskSaveFail", "Could not save the draft.", "খসড়া সেভ করা যায়নি।"));
    } finally {
      setSaving(false);
    }
  };

  const test = async (e: React.FormEvent) => {
    e.preventDefault();
    setTestAnswer(null);
    setTestNote("");
    setTesting(true);
    setError("");
    try {
      const res = await agentDeskApi.test(question);
      setTestAnswer(res.answer);
      if (!res.aiAvailable) setTestNote(t("deskAiOff", "AI is not available right now — nothing was published.", "এখন AI চালু নেই — কিছু প্রকাশ করা হয়নি।"));
      else setTestNote(t("deskTestNote", "This is only a test — nothing was published.", "এটি শুধু পরীক্ষা — কিছু প্রকাশ করা হয়নি।"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("deskTestFail", "Could not test the instructions.", "নির্দেশনা পরীক্ষা করা যায়নি।"));
    } finally {
      setTesting(false);
    }
  };

  const act = async (fn: () => Promise<unknown>, failEn: string, failBn: string) => {
    setError("");
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("deskActFail", failEn, failBn));
    }
  };

  return (
    <div className="bg-[#fff8f3] min-h-screen -m-6 p-6">
      <h1 className="text-2xl font-bold mb-1">{t("deskTitle", "Agent Desk", "এজেন্ট ডেস্ক")}</h1>
      <p className="text-sm text-slate-500 mb-4">{t("deskSub", "Tell the AI how to talk to your customers, in plain words. Test a draft before you publish it.", "সাধারণ ভাষায় AI-কে বলুন কাস্টমারের সাথে কীভাবে কথা বলবে। প্রকাশ করার আগে খসড়া পরীক্ষা করুন।")}</p>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}

      {active && (
        <div className="bg-teal-600/10 border border-teal-600/30 rounded-xl p-4 mb-6">
          <p className="font-bold text-teal-600">{t("deskActive", "Currently published", "এখন প্রকাশিত আছে")} — v{active.version}</p>
          <p className="text-sm whitespace-pre-wrap mt-1">{active.body}</p>
        </div>
      )}

      <form onSubmit={createDraft} className="bg-white rounded-xl shadow p-4 mb-6 grid gap-3">
        <h2 className="font-bold">{t("deskNew", "Write new instructions (draft)", "নতুন নির্দেশনা লিখুন (খসড়া)")}</h2>
        <textarea required value={body} onChange={(e) => setBody(e.target.value)} rows={5} placeholder={t("deskBodyPh", "E.g. Always greet politely in Bengali. Never promise a delivery time we cannot keep. If the customer asks for a discount, offer at most 5%…", "যেমন: সবসময় বাংলায় ভদ্রভাবে সালাম দিন। যা দিতে পারবেন না, এমন ডেলিভারির সময়ের কথা বলবেন না। কাস্টমার ছাড় চাইলে সর্বোচ্চ ৫% দিন…")} className="border rounded-lg px-3 py-2" />
        <button disabled={saving} className="bg-[#ff6a4d] hover:bg-[#e04e33] text-white rounded-lg px-4 py-2 w-fit disabled:opacity-50">
          {saving ? t("saving", "Saving…", "সেভ হচ্ছে…") : t("deskSaveDraft", "Save as draft", "খসড়া হিসেবে সেভ করুন")}
        </button>
      </form>

      <form onSubmit={test} className="bg-white rounded-xl shadow p-4 mb-6 grid gap-3">
        <h2 className="font-bold">{t("deskTestTitle", "Test the draft", "খসড়া পরীক্ষা করুন")}</h2>
        <p className="text-sm text-slate-500">{t("deskTestSub", "Ask a question the way a customer would. The AI answers using the draft — nothing is published.", "কাস্টমারের মতো করে একটি প্রশ্ন করুন। AI খসড়া দিয়ে উত্তর দেবে — কিছু প্রকাশ হবে না।")}</p>
        <input required value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={t("deskQPh", "Customer question, e.g. What is the delivery charge?", "কাস্টমারের প্রশ্ন, যেমন: ডেলিভারি চার্জ কত?")} className="border rounded-lg px-3 py-2" />
        <button disabled={testing} className="bg-teal-600 hover:bg-teal-700 text-white rounded-lg px-4 py-2 w-fit disabled:opacity-50">
          {testing ? t("deskTesting", "Testing…", "পরীক্ষা হচ্ছে…") : t("deskTest", "Test", "পরীক্ষা করুন")}
        </button>
        {testAnswer && (
          <div className="bg-[#fff8f3] border rounded-lg p-3">
            <p className="font-bold text-sm">{t("deskAnswer", "AI test answer:", "AI-এর পরীক্ষামূলক উত্তর:")}</p>
            <p className="text-sm whitespace-pre-wrap mt-1">{testAnswer}</p>
          </div>
        )}
        {testNote && <p className="text-sm text-slate-500">{testNote}</p>}
      </form>

      <h2 className="font-bold mb-3">{t("deskVersions", "Versions", "সংস্করণগুলো")}</h2>
      {loading ? (
        <p className="text-slate-500">{t("loading", "Loading…", "লোড হচ্ছে…")}</p>
      ) : versions.length === 0 ? (
        <p className="text-slate-500">{t("deskEmpty", "No instructions yet — write your first draft above.", "এখনো কোনো নির্দেশনা নেই — উপরে প্রথম খসড়াটি লিখুন।")}</p>
      ) : (
        <div className="grid gap-3">
          {versions.map((v) => (
            <div key={v.id} className="bg-white rounded-xl shadow p-4">
              <div className="flex justify-between gap-2 flex-wrap">
                <span className="font-bold">v{v.version} · {v.status === "published" ? t("deskPublished", "Published", "প্রকাশিত") : v.status === "draft" ? t("deskDraft", "Draft", "খসড়া") : t("deskArchived", "Archived", "আর্কাইভ")}</span>
                <span className="text-xs text-slate-400">{fmtDate(v.created_at)}</span>
              </div>
              <p className="text-sm text-slate-600 whitespace-pre-wrap mt-1">{v.body}</p>
              <div className="flex gap-2 mt-3">
                {v.status !== "published" && (
                  <button onClick={() => act(() => agentDeskApi.publish(v.id), "Could not publish this version.", "এই সংস্করণটি প্রকাশ করা যায়নি।")} className="bg-[#ff6a4d] hover:bg-[#e04e33] text-white text-sm rounded-lg px-3 py-1">
                    {t("deskPublish", "Publish", "প্রকাশ করুন")}
                  </button>
                )}
              </div>
            </div>
          ))}
          <button
            onClick={() => act(() => agentDeskApi.revert(), "Could not revert.", "আগের সংস্করণে ফেরা যায়নি।")}
            className="border border-teal-600 text-teal-600 rounded-lg px-4 py-2 w-fit"
          >
            {t("deskRevert", "Revert to the previous published version", "আগে প্রকাশিত সংস্করণে ফিরে যান")}
          </button>
        </div>
      )}
    </div>
  );
}
