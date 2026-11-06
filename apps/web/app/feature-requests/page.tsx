"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  asArrayOf,
  featureRequestsApi,
  getToken,
  type FeatureRequest,
} from "@/lib/api";
import { useI18n } from "@/lib/i18n";

const STATUS_OPTIONS = ["open", "planned", "in_progress", "done", "rejected"];
const STATUS_KEYS: Record<string, string> = {
  open: "frStatus.open",
  planned: "frStatus.planned",
  in_progress: "frStatus.in_progress",
  done: "frStatus.done",
  rejected: "frStatus.rejected",
};
const STATUS_FALLBACK: Record<string, [string, string]> = {
  open: ["Open", "খোলা"],
  planned: ["Planned", "পরিকল্পনায়"],
  in_progress: ["In progress", "কাজ চলছে"],
  done: ["Done", "সম্পন্ন"],
  rejected: ["Cancelled", "বাতিল"],
};

export default function FeatureRequestsPage() {
  const router = useRouter();
  const { t, fmtDate } = useI18n();
  const [requests, setRequests] = useState<FeatureRequest[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");

  const statusLabel = (s: string) => {
    const fb = STATUS_FALLBACK[s] || [s, s];
    return t(STATUS_KEYS[s] || "", fb[0], fb[1]);
  };

  const load = useCallback(async () => {
    try {
      const data = await featureRequestsApi.list();
      setRequests(asArrayOf<FeatureRequest>(data, ["featureRequests"]));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("featureRequests.loadFailed", "Could not load requests.", "অনুরোধ লোড করা যায়নি।"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!getToken()) { router.push("/login"); return; }
    load();
  }, [load, router]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      await featureRequestsApi.create({ title: title.trim(), details: details.trim() || undefined });
      setTitle(""); setDetails("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("featureRequests.createFailed", "Could not send the request.", "অনুরোধ পাঠানো যায়নি।"));
    } finally {
      setSaving(false);
    }
  };

  const changeStatus = async (id: string, status: string) => {
    setError("");
    try {
      await featureRequestsApi.update(id, status);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("featureRequests.statusFailed", "Could not change the status.", "স্ট্যাটাস বদলানো যায়নি।"));
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">{t("featureRequests.title", "Feature Requests", "অনুরোধ")}</h1>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}

      <form onSubmit={create} className="card p-4 mb-6 space-y-3">
        <h2 className="font-bold">{t("featureRequests.createTitle", "Send a new feature request", "নতুন ফিচারের অনুরোধ পাঠান")}</h2>
        <input required value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("featureRequests.titlePlaceholder", "What feature do you want? *", "কী ফিচার চান? *")} className="w-full border rounded-lg px-3 py-2" />
        <textarea value={details} onChange={(e) => setDetails(e.target.value)} placeholder={t("featureRequests.detailsPlaceholder", "Write the details (optional)", "বিস্তারিত লিখুন (ঐচ্ছিক)")} className="w-full border rounded-lg px-3 py-2" rows={3} />
        <button disabled={saving} className="bg-brand text-white py-2 px-6 rounded-lg hover:bg-brand-dark disabled:opacity-50">
          {saving ? t("featureRequests.sending", "Sending…", "পাঠানো হচ্ছে…") : t("featureRequests.sendButton", "Send request", "অনুরোধ পাঠান")}
        </button>
      </form>

      {loading ? <p className="text-slate-500">{t("common.loading", "Loading…", "লোড হচ্ছে…")}</p> : requests.length === 0 ? (
        <div className="empty-state">{t("featureRequests.empty", "No requests.", "কোনো অনুরোধ নেই।")}</div>
      ) : (
        <div className="space-y-3">
          {requests.map((r) => (
            <div key={r.id} className="card p-4">
              <div className="flex flex-wrap justify-between gap-2">
                <h3 className="font-bold">{r.title}</h3>
                <span className="text-xs text-slate-400">{fmtDate(r.createdAt || r.created_at)}</span>
              </div>
              {r.details && <p className="text-sm text-slate-600 whitespace-pre-wrap mt-1">{r.details}</p>}
              <div className="flex items-center gap-2 mt-3">
                <span className="text-sm text-slate-500">{t("featureRequests.statusLabel", "Status:", "স্ট্যাটাস:")}</span>
                <select
                  value={r.status || "open"}
                  onChange={(e) => changeStatus(r.id, e.target.value)}
                  className="border rounded-lg px-2 py-1.5 text-sm bg-white"
                >
                  {STATUS_OPTIONS.map((s) => (
                    <option key={s} value={s}>{statusLabel(s)}</option>
                  ))}
                </select>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
