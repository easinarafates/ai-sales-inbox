"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  asArrayOf,
  channelDisplayName,
  channelNeedsApproval,
  channelPlatform,
  getToken,
  salesChannelsApi,
  type SalesChannel,
} from "@/lib/api";
import { useI18n } from "@/lib/i18n";

const PLATFORM_KEYS: Record<string, string> = {
  facebook_page: "channels.platformFacebook",
  instagram: "channels.platformInstagram",
  website: "channels.platformWebsite",
  whatsapp: "channels.platformWhatsapp",
  tiktok: "channels.platformTiktok",
};
const PLATFORM_FALLBACK: Record<string, [string, string]> = {
  facebook_page: ["Facebook Page", "Facebook পেজ"],
  instagram: ["Instagram", "Instagram"],
  website: ["Website live chat", "ওয়েবসাইট লাইভ চ্যাট"],
  whatsapp: ["WhatsApp", "WhatsApp"],
  tiktok: ["TikTok", "TikTok"],
};

export default function ChannelsPage() {
  const router = useRouter();
  const { t, fmtDate } = useI18n();
  const [channels, setChannels] = useState<SalesChannel[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [platform, setPlatform] = useState("facebook_page");
  const [externalId, setExternalId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [token, setToken] = useState("");
  const [notice, setNotice] = useState("");

  const platformLabel = (value: string) => {
    const fb = PLATFORM_FALLBACK[value] || [value, value];
    return t(PLATFORM_KEYS[value] || "", fb[0], fb[1]);
  };

  const load = useCallback(async () => {
    try {
      const data = await salesChannelsApi.list();
      setChannels(asArrayOf<SalesChannel>(data, ["channels"]));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("channels.loadFailed", "Could not load channels.", "চ্যানেল লোড করা যায়নি।"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!getToken()) { router.push("/login"); return; }
    load();
  }, [load, router]);

  const needsApproval = platform === "whatsapp" || platform === "tiktok";

  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setNotice("");
    setSaving(true);
    try {
      const res = await salesChannelsApi.create({
        platform,
        externalId: externalId.trim(),
        displayName: displayName.trim() || undefined,
        token: token.trim() || undefined,
      });
      const ch = (res as { channel?: SalesChannel }).channel ?? (res as SalesChannel);
      if (channelNeedsApproval(ch)) {
        setNotice(t("channels.pendingApproval", "This channel is waiting for approval — it will start once approved.", "এই চ্যানেলটি অনুমোদনের জন্য অপেক্ষমাণ — অনুমোদন পেলে চালু হবে।"));
      } else {
        setNotice(t("channels.added", "Channel added.", "চ্যানেল যুক্ত হয়েছে।"));
      }
      setExternalId(""); setDisplayName(""); setToken("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("channels.addFailed", "Could not add the channel.", "চ্যানেল যুক্ত করা যায়নি।"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">{t("channels.title", "Channels", "চ্যানেল")}</h1>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}
      {notice && <p className="bg-teal-50 text-teal-700 text-sm p-3 rounded-lg mb-4">{notice}</p>}

      <form onSubmit={connect} className="bg-white rounded-xl shadow p-4 mb-6 grid grid-cols-1 md:grid-cols-2 gap-3">
        <h2 className="font-bold md:col-span-2">{t("channels.addTitle", "Add a new channel", "নতুন চ্যানেল যুক্ত করুন")}</h2>
        <select value={platform} onChange={(e) => setPlatform(e.target.value)} className="border rounded-lg px-3 py-2 bg-white">
          {Object.keys(PLATFORM_KEYS).map((value) => (
            <option key={value} value={value}>{platformLabel(value)}</option>
          ))}
        </select>
        <input required value={externalId} onChange={(e) => setExternalId(e.target.value)} placeholder={t("channels.externalIdPlaceholder", "Page / account ID *", "পেজ / অ্যাকাউন্ট ID *")} className="border rounded-lg px-3 py-2" />
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={t("channels.displayNamePlaceholder", "Display name (e.g. Rongdhonu Fashion)", "দেখানোর নাম (যেমন: রঙধনু ফ্যাশন)")} className="border rounded-lg px-3 py-2" />
        <input value={token} onChange={(e) => setToken(e.target.value)} placeholder={t("channels.tokenPlaceholder", "Token (if any)", "টোকেন (যদি থাকে)")} className="border rounded-lg px-3 py-2" />
        {needsApproval && (
          <p className="md:col-span-2 text-sm bg-amber-50 text-amber-800 p-3 rounded-lg">
            {t("channels.approvalWarning", "⚠️ This platform needs approval — after adding, it will wait for approval.", "⚠️ এই প্ল্যাটফর্মের জন্য অনুমোদন লাগবে — যুক্ত করার পর অনুমোদনের অপেক্ষায় থাকবে।")}
          </p>
        )}
        <button disabled={saving} className="bg-brand text-white py-2 rounded-lg md:col-span-2 hover:bg-brand-dark disabled:opacity-50">
          {saving ? t("channels.adding", "Adding…", "যুক্ত হচ্ছে…") : t("channels.addButton", "Add channel", "চ্যানেল যুক্ত করুন")}
        </button>
      </form>

      {loading ? <p className="text-slate-500">{t("common.loading", "Loading…", "লোড হচ্ছে…")}</p> : channels.length === 0 ? (
        <p className="text-slate-500 bg-white rounded-xl shadow p-6">{t("channels.empty", "No channels added yet. Add one from the form above.", "কোনো চ্যানেল যুক্ত নেই। উপরের ফর্ম থেকে যুক্ত করুন।")}</p>
      ) : (
        <div className="bg-white rounded-xl shadow overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b text-left text-slate-500"><th className="p-3">{t("channels.thPlatform", "Platform", "প্ল্যাটফর্ম")}</th><th className="p-3">{t("channels.thName", "Name", "নাম")}</th><th className="p-3">{t("channels.thStatus", "Status", "স্ট্যাটাস")}</th><th className="p-3">{t("channels.thAdded", "Added", "যুক্ত হয়েছে")}</th></tr></thead>
            <tbody>
              {channels.map((c) => (
                <tr key={c.id} className="border-b hover:bg-orange-50">
                  <td className="p-3 font-medium">{platformLabel(channelPlatform(c))}</td>
                  <td className="p-3">{channelDisplayName(c)}</td>
                  <td className="p-3">
                    <span className={`text-xs px-2 py-0.5 rounded ${channelNeedsApproval(c) ? "bg-amber-100 text-amber-800" : c.status === "active" ? "bg-teal-100 text-teal-800" : "bg-slate-100 text-slate-600"}`}>
                      {channelNeedsApproval(c) ? t("channels.needsApproval", "Needs approval", "অনুমোদন লাগবে") : c.status || "—"}
                    </span>
                  </td>
                  <td className="p-3 text-slate-500">{fmtDate(c.createdAt || c.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
