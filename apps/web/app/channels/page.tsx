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
  type FacebookPage,
  type SalesChannel,
} from "@/lib/api";
import { useI18n } from "@/lib/i18n";

// Display labels for every platform value the API can return.
const PLATFORM_KEYS: Record<string, string> = {
  messenger: "channels.platformFacebook",
  facebook_comment: "channels.platformFacebook",
  instagram: "channels.platformInstagram",
  website: "channels.platformWebsite",
  webchat: "channels.platformWebsite",
  whatsapp: "channels.platformWhatsapp",
  tiktok: "channels.platformTiktok",
  tiktok_dm: "channels.platformTiktok",
};
const PLATFORM_FALLBACK: Record<string, [string, string]> = {
  messenger: ["Facebook Page", "Facebook পেজ"],
  facebook_comment: ["Facebook Page", "Facebook পেজ"],
  instagram: ["Instagram", "Instagram"],
  website: ["Website live chat", "ওয়েবসাইট লাইভ চ্যাট"],
  webchat: ["Website live chat", "ওয়েবসাইট লাইভ চ্যাট"],
  whatsapp: ["WhatsApp", "WhatsApp"],
  tiktok: ["TikTok", "TikTok"],
  tiktok_dm: ["TikTok", "TikTok"],
};

// Manual form options: select value → API platform value.
// Facebook is OAuth-only now (the old "facebook_page" option sent a
// platform the API never accepted, so it always failed).
const MANUAL_OPTIONS: { value: string; api: string }[] = [
  { value: "instagram", api: "instagram" },
  { value: "website", api: "webchat" },
  { value: "whatsapp", api: "whatsapp" },
  { value: "tiktok", api: "tiktok" },
];

export default function ChannelsPage() {
  const router = useRouter();
  const { t, fmtDate } = useI18n();
  const [channels, setChannels] = useState<SalesChannel[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [platform, setPlatform] = useState("instagram");
  const [externalId, setExternalId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [token, setToken] = useState("");
  const [notice, setNotice] = useState("");
  // "Login with Facebook" flow.
  const [fbBusy, setFbBusy] = useState(false);
  const [fbPicking, setFbPicking] = useState(false);
  const [fbPages, setFbPages] = useState<FacebookPage[] | null>(null);
  const [fbSession, setFbSession] = useState("");
  const [fbConnecting, setFbConnecting] = useState("");

  const platformLabel = (value: string) => {
    const fb = PLATFORM_FALLBACK[value] || [value, value];
    return t(PLATFORM_KEYS[value] || "", fb[0], fb[1]);
  };

  const fbError = (reason: string) => {
    switch (reason) {
      case "bad_state":
        return t("channels.facebookErrorBadState", "The Facebook login session expired — please try again.", "Facebook লগইনের মেয়াদ শেষ হয়ে গেছে — আবার চেষ্টা করুন।");
      case "no_pages":
        return t("channels.facebookErrorNoPages", "No Facebook Page was found on this account — create a Page first, then try again.", "এই অ্যাকাউন্টে কোনো Facebook পেজ পাওয়া যায়নি — আগে একটি পেজ বানান, তারপর আবার চেষ্টা করুন।");
      case "limit":
        return t("channels.facebookErrorLimit", "Your plan's channel limit is full — upgrade your plan to connect another Page.", "তোমার প্ল্যানের চ্যানেল সীমা শেষ — আরেকটি পেজ যুক্ত করতে প্ল্যান বড় করুন।");
      case "already_connected":
        return t("channels.facebookErrorAlready", "This Facebook Page is already connected.", "এই Facebook পেজটি আগেই যুক্ত আছে।");
      case "cancelled":
        return t("channels.facebookErrorCancelled", "Facebook login was cancelled.", "Facebook লগইন বাতিল করা হয়েছে।");
      case "config":
        return t("channels.facebookErrorConfig", "Facebook login is not set up yet — the Meta app has not been connected. Please contact the platform owner.", "Facebook লগইন এখনো সেটআপ হয়নি — Meta অ্যাপ যুক্ত করা হয়নি। মালিকের সাথে যোগাযোগ করুন।");
      default:
        return t("channels.facebookErrorGeneric", "Facebook login failed — please try again.", "Facebook লগইন হয়নি — আবার চেষ্টা করুন।");
    }
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

  const loadFbPages = useCallback(async (session: string) => {
    try {
      const data = await salesChannelsApi.facebookPages(session);
      setFbPages(data.pages ?? []);
    } catch {
      setError(t("channels.facebookLoadPagesFailed", "Could not load your Facebook Pages — please try again.", "তোমার Facebook পেজগুলো লোড করা যায়নি — আবার চেষ্টা করুন।"));
      setFbPicking(false);
    }
  }, [t]);

  // Handle the redirect back from Facebook (?facebook=connected|pick|error).
  useEffect(() => {
    if (!getToken()) { router.push("/login"); return; }
    load();
    const params = new URLSearchParams(window.location.search);
    const fb = params.get("facebook");
    if (!fb) return;
    // Clean the URL so a refresh does not re-run the flow.
    router.replace("/channels", { scroll: false });
    if (fb === "connected") {
      const name = params.get("name");
      setNotice(`${t("channels.facebookConnected", "Facebook Page connected.", "Facebook পেজ যুক্ত হয়েছে।")}${name ? ` ${name}` : ""}`);
      load();
    } else if (fb === "pick") {
      const session = params.get("session") || "";
      if (!session) {
        setError(fbError(""));
        return;
      }
      setFbSession(session);
      setFbPicking(true);
      loadFbPages(session);
    } else if (fb === "error") {
      setError(fbError(params.get("reason") || ""));
    }
  }, [load, loadFbPages, router, t]);

  const loginWithFacebook = async () => {
    setError("");
    setNotice("");
    setFbBusy(true);
    try {
      const { url } = await salesChannelsApi.facebookLogin();
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : fbError(""));
      setFbBusy(false);
    }
  };

  const connectPickedPage = async (pageId: string, pageName: string) => {
    setError("");
    setNotice("");
    setFbConnecting(pageId);
    try {
      await salesChannelsApi.facebookConnect({ session: fbSession, pageId });
      setFbPicking(false);
      setFbPages(null);
      setFbSession("");
      setNotice(`${t("channels.facebookConnected", "Facebook Page connected.", "Facebook পেজ যুক্ত হয়েছে।")} ${pageName}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : fbError(""));
    } finally {
      setFbConnecting("");
    }
  };

  const needsApproval = platform === "whatsapp" || platform === "tiktok";

  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setNotice("");
    setSaving(true);
    try {
      const apiPlatform = MANUAL_OPTIONS.find((o) => o.value === platform)?.api ?? platform;
      const res = await salesChannelsApi.create({
        platform: apiPlatform,
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

      <div className="bg-white rounded-xl shadow p-4 mb-6">
        <h2 className="font-bold">{t("channels.facebookTitle", "Connect Facebook Page", "Facebook পেজ যুক্ত করুন")}</h2>
        <p className="text-sm text-slate-600 mt-1 mb-3">{t("channels.facebookDesc", "Log in with Facebook and pick the Page that should receive your shop's messages — no Page ID or token to type.", "Facebook দিয়ে লগইন করে যে পেজে তোমার দোকানের মেসেজ আসবে সেটা বেছে নাও — পেজ ID বা টোকেন টাইপ করতে হবে না।")}</p>
        <button onClick={loginWithFacebook} disabled={fbBusy} className="bg-[#1877F2] text-white px-4 py-2 rounded-lg hover:opacity-90 disabled:opacity-50">
          {fbBusy ? t("channels.facebookOpening", "Opening Facebook…", "Facebook খুলছে…") : t("channels.facebookButton", "Login with Facebook", "Facebook দিয়ে লগইন করুন")}
        </button>
      </div>

      {fbPicking && (
        <div className="bg-white rounded-xl shadow p-4 mb-6">
          <h2 className="font-bold">{t("channels.facebookPickTitle", "Choose a Facebook Page", "একটি Facebook পেজ বেছে নিন")}</h2>
          <p className="text-sm text-slate-600 mt-1 mb-3">{t("channels.facebookPickHint", "Your Facebook account has more than one Page — pick the one for this shop.", "তোমার Facebook অ্যাকাউন্টে একাধিক পেজ আছে — এই দোকানের জন্য একটা বেছে নাও।")}</p>
          {fbPages === null ? (
            <p className="text-slate-500">{t("common.loading", "Loading…", "লোড হচ্ছে…")}</p>
          ) : fbPages.length === 0 ? (
            <p className="text-slate-500">{fbError("no_pages")}</p>
          ) : (
            <ul className="divide-y">
              {fbPages.map((p) => (
                <li key={p.id} className="flex items-center gap-3 py-2">
                  {p.picture ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.picture} alt="" className="w-10 h-10 rounded-full object-cover" />
                  ) : (
                    <span className="w-10 h-10 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center font-bold">{p.name.slice(0, 1)}</span>
                  )}
                  <span className="flex-1 min-w-0">
                    <span className="block font-medium truncate">{p.name}</span>
                    {p.category && <span className="block text-xs text-slate-500 truncate">{p.category}</span>}
                  </span>
                  <button disabled={!!fbConnecting} onClick={() => connectPickedPage(p.id, p.name)} className="bg-brand text-white px-3 py-1.5 rounded-lg text-sm hover:bg-brand-dark disabled:opacity-50 shrink-0">
                    {fbConnecting === p.id ? t("channels.facebookConnecting", "Connecting…", "যুক্ত হচ্ছে…") : t("channels.facebookPickButton", "Connect this Page", "এই পেজটি যুক্ত করুন")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <form onSubmit={connect} className="bg-white rounded-xl shadow p-4 mb-6 grid grid-cols-1 md:grid-cols-2 gap-3">
        <h2 className="font-bold md:col-span-2">{t("channels.addTitle", "Add a new channel", "নতুন চ্যানেল যুক্ত করুন")}</h2>
        <select value={platform} onChange={(e) => setPlatform(e.target.value)} className="border rounded-lg px-3 py-2 bg-white">
          {MANUAL_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{platformLabel(opt.value)}</option>
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
