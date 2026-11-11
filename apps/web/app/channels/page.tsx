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
  whatsappNumberLabel,
  whatsappNumbersOf,
  type FacebookPage,
  type InstagramPage,
  type SalesChannel,
  type WhatsappAccount,
} from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { PlatformLogo } from "@/components/PlatformLogo";

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
  youtube: "channels.platformYoutube",
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

// Manual add (ID + token) was removed (YEARBITO Task 10): every channel
// now connects only through its own "Connect" button below. The API
// create route stays for the WhatsApp manual fallback form.

// One connect card per channel. Facebook, Instagram and WhatsApp connect
// through the same Meta app (separate login endpoints, own scopes);
// TikTok connects through TikTok Login Kit and YouTube through Google
// OAuth — all five are real flows; a missing app key shows a Bengali
// "not set up yet" message, never a fake connected state.
type OAuthKind = "facebook" | "instagram" | "whatsapp" | "tiktok" | "youtube";
const OAUTH_KINDS: OAuthKind[] = ["facebook", "instagram", "whatsapp", "tiktok", "youtube"];
const META_KINDS: OAuthKind[] = ["facebook", "instagram", "whatsapp"];
const OAUTH_CARDS: Record<OAuthKind, { title: string; desc: string; button: string; opening: string; color: string; platforms: string[] }> = {
  facebook: {
    title: "channels.facebookTitle",
    desc: "channels.facebookDesc",
    button: "channels.facebookButton",
    opening: "channels.facebookOpening",
    color: "#1877F2",
    platforms: ["messenger", "facebook_comment"],
  },
  instagram: {
    title: "channels.instagramTitle",
    desc: "channels.instagramDesc",
    button: "channels.instagramButton",
    opening: "channels.instagramOpening",
    color: "#E1306C",
    platforms: ["instagram"],
  },
  whatsapp: {
    title: "channels.whatsappTitle",
    desc: "channels.whatsappDesc",
    button: "channels.whatsappButton",
    opening: "channels.whatsappOpening",
    color: "#128C7E",
    platforms: ["whatsapp"],
  },
  tiktok: {
    title: "channels.tiktokTitle",
    desc: "channels.tiktokDesc",
    button: "channels.tiktokButton",
    opening: "channels.tiktokOpening",
    color: "#000000",
    platforms: ["tiktok", "tiktok_dm"],
  },
  youtube: {
    title: "channels.youtubeTitle",
    desc: "channels.youtubeDesc",
    button: "channels.youtubeButton",
    opening: "channels.youtubeOpening",
    color: "#FF0000",
    platforms: ["youtube"],
  },
};

// Website is not an OAuth flow: it is the embeddable chat widget for the
// shop's own website (see /website-chat). It gets its own card in the
// same grid, with a button that opens the snippet page.
const WEBSITE_CARD = {
  title: "channels.websiteTitle",
  desc: "channels.websiteDesc",
  button: "channels.websiteButton",
  color: "#0051F6",
  platforms: ["webchat", "website"],
};

export default function ChannelsPage() {
  const router = useRouter();
  const { t, fmtDate } = useI18n();
  const [channels, setChannels] = useState<SalesChannel[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  // Meta OAuth flows (Facebook / Instagram / WhatsApp) + TikTok / YouTube.
  const [oauthBusy, setOauthBusy] = useState<OAuthKind | "">("");
  const [setupStatus, setSetupStatus] = useState<{ metaConfigured: boolean; whatsappConfigIdConfigured: boolean; tiktokConfigured: boolean; youtubeConfigured: boolean } | null>(null);
  // WhatsApp manual Cloud API connect (verified phone-number ID + token).
  const [waManualPhoneId, setWaManualPhoneId] = useState("");
  const [waManualToken, setWaManualToken] = useState("");
  const [waManualWabaId, setWaManualWabaId] = useState("");
  const [waManualBusy, setWaManualBusy] = useState(false);
  // The manual form is long (3 inputs + button) and stretched the
  // WhatsApp card far taller than its row-mates, leaving a big empty
  // gap under the Facebook/Instagram cards — so it sits behind a
  // toggle, collapsed by default. The form itself is unchanged.
  const [waManualOpen, setWaManualOpen] = useState(false);
  const [picker, setPicker] = useState<{ kind: OAuthKind; session: string; account: string } | null>(null);
  const [pickItems, setPickItems] = useState<FacebookPage[] | InstagramPage[] | WhatsappAccount[] | null>(null);
  const [connectingId, setConnectingId] = useState("");

  const platformLabel = (value: string) => {
    const fb = PLATFORM_FALLBACK[value] || [value, value];
    return t(PLATFORM_KEYS[value] || "", fb[0], fb[1]);
  };

  // Error text for an OAuth redirect (?<kind>=error&reason=...). The
  // account name (when Meta told us which account was used) is filled
  // into the message so the user knows which account failed and why.
  const oauthError = (kind: OAuthKind, reason: string, account = "", page = "") => {
    switch (reason) {
      case "bad_state":
        return t("channels.oauthErrorBadState", "The login session expired — please try again.", "লগইনের মেয়াদ শেষ হয়ে গেছে — আবার চেষ্টা করুন।");
      case "cancelled":
        return t("channels.oauthErrorCancelled", "Login was cancelled.", "লগইন বাতিল করা হয়েছে।");
      case "config":
        if (kind === "tiktok") {
          return t("channels.tiktokSetupNeeded", "TikTok is not set up yet — the owner must add the TikTok app's Client Key and Client Secret first (developers.tiktok.com → create an app, turn on Login Kit).", "TikTok এখনো সেটআপ হয়নি — মালিককে প্রথমে TikTok অ্যাপের Client Key আর Client Secret দিতে হবে (developers.tiktok.com-এ গিয়ে অ্যাপ বানিয়ে Login Kit চালু করুন)।");
        }
        if (kind === "youtube") {
          return t("channels.youtubeSetupNeeded", "YouTube is not set up yet — the owner must add the Google OAuth Client ID and Client Secret first (Google Cloud Console → OAuth client, YouTube Data API v3 on).", "YouTube এখনো সেটআপ হয়নি — মালিককে প্রথমে Google OAuth-এর Client ID আর Client Secret দিতে হবে (Google Cloud Console-এ OAuth ক্লায়েন্ট বানিয়ে YouTube Data API v3 চালু করুন)।");
        }
        return t("channels.oauthErrorConfig", "Login is not set up yet — the Meta app has not been connected. Please contact the platform owner.", "লগইন এখনো সেটআপ হয়নি — Meta অ্যাপ যুক্ত করা হয়নি। মালিকের সাথে যোগাযোগ করুন।");
      case "verify_failed":
        return t("channels.oauthErrorVerifyFailed", "The account was found, but its profile could not be read — please try again.", "অ্যাকাউন্টটি পাওয়া গেছে, কিন্তু প্রোফাইলটি পড়া যায়নি — আবার চেষ্টা করুন।");
      case "exchange_failed":
        return t("channels.oauthErrorExchangeFailed", "The login could not be finished — please try again.", "লগইন শেষ করা যায়নি — আবার চেষ্টা করুন।");
      case "ig_verify_failed":
        return t("channels.instagramErrorVerifyFailed", "The Instagram account was found, but its profile could not be read — check that the Instagram account is a Business or Creator account linked to the Page, then try again.", "Instagram অ্যাকাউন্টটি পাওয়া গেছে, কিন্তু প্রোফাইলটি পড়া যায়নি — Instagram অ্যাকাউন্টটি Business বা Creator কি না আর পেজের সাথে যুক্ত কি না দেখে আবার চেষ্টা করুন।");
      case "limit":
        return t("channels.oauthErrorLimit", "Your plan's channel limit is full — upgrade your plan to connect another account.", "তোমার প্ল্যানের চ্যানেল সীমা শেষ — আরেকটি অ্যাকাউন্ট যুক্ত করতে প্ল্যান বড় করুন।");
      case "already_connected":
        return t("channels.oauthErrorAlready", "This account is already connected.", "এই অ্যাকাউন্টটি আগেই যুক্ত আছে।");
      case "no_pages": {
        const key = kind === "instagram" ? "channels.instagramErrorNoPagesAccount" : "channels.facebookErrorNoPagesAccount";
        if (!account) {
          return t("channels.facebookErrorNoPages", "No Facebook Page was found on this account — log in with the Facebook account that owns your Page, and when Facebook asks, make sure you allow access to your Pages.", "এই অ্যাকাউন্টে কোনো Facebook পেজ পাওয়া যায়নি — তোমার পেজটি যে অ্যাকাউন্টের, সেটা দিয়ে লগইন করুন, আর Facebook অনুমতি চাইলে পেজের অনুমতিটা দেবেন।");
        }
        return t(
          key,
          `No Facebook Page was found on the Facebook account "${account}" — that account has no Page. Log in with the Facebook account that owns your Page and try again.`,
          `Facebook অ্যাকাউন্ট "${account}"-এ কোনো পেজ পাওয়া যায়নি — ওই অ্যাকাউন্টে কোনো পেজ নেই। তোমার পেজটি যে Facebook অ্যাকাউন্টের, সেটা দিয়ে লগইন করে আবার চেষ্টা করুন।`,
        ).replace("{account}", account);
      }
      case "ig_not_linked": {
        if (page) {
          return t(
            "channels.instagramErrorNoIg",
            `The Facebook Page "${page}" has no Instagram account linked. Link an Instagram Business or Creator account to that Page in Meta Business Suite, then try again.`,
            `Facebook পেজ "${page}"-এর সাথে কোনো Instagram অ্যাকাউন্ট যুক্ত নেই। Meta Business Suite-এ ওই পেজের সাথে একটি Instagram Business বা Creator অ্যাকাউন্ট যুক্ত করে আবার চেষ্টা করুন।`,
          ).replace("{page}", page);
        }
        return t("channels.instagramErrorNoIgGeneric", "None of your Facebook Pages has an Instagram account linked. Link an Instagram Business or Creator account to a Page in Meta Business Suite, then try again.", "তোমার কোনো Facebook পেজের সাথেই Instagram অ্যাকাউন্ট যুক্ত নেই। Meta Business Suite-এ একটি পেজের সাথে Instagram Business বা Creator অ্যাকাউন্ট যুক্ত করে আবার চেষ্টা করুন।");
      }
      case "no_waba": {
        if (account) {
          return t(
            "channels.whatsappErrorNoWaba",
            `No WhatsApp Business account was found on the Facebook account "${account}". Create a WhatsApp Business account in Meta Business Suite first, then try again.`,
            `Facebook অ্যাকাউন্ট "${account}"-এ কোনো WhatsApp Business অ্যাকাউন্ট পাওয়া যায়নি। প্রথমে Meta Business Suite-এ একটি WhatsApp Business অ্যাকাউন্ট বানান, তারপর আবার চেষ্টা করুন।`,
          ).replace("{account}", account);
        }
        return t("channels.whatsappErrorNoWabaGeneric", "No WhatsApp Business account was found on this Facebook account. Create a WhatsApp Business account in Meta Business Suite first, then try again.", "এই Facebook অ্যাকাউন্টে কোনো WhatsApp Business অ্যাকাউন্ট পাওয়া যায়নি। প্রথমে Meta Business Suite-এ একটি WhatsApp Business অ্যাকাউন্ট বানান, তারপর আবার চেষ্টা করুন।");
      }
      default:
        return t("channels.oauthErrorGeneric", "Login failed — please try again.", "লগইন হয়নি — আবার চেষ্টা করুন।");
    }
  };

  // Backwards-compatible alias: the Facebook-only error path.
  const fbError = (reason: string, account = "") => oauthError("facebook", reason, account);

  const load = useCallback(async () => {
    // A failed picker load leaves its error in state; clear it here so a
    // plain page load never shows a stale "could not load the accounts"
    // banner from an earlier attempt. (A redirect error set after this
    // call in the same effect still wins — it runs after load().)
    setError("");
    try {
      const data = await salesChannelsApi.list();
      setChannels(asArrayOf<SalesChannel>(data, ["channels"]));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("channels.loadFailed", "Could not load channels.", "চ্যানেল লোড করা যায়নি।"));
    } finally {
      setLoading(false);
    }
    try {
      setSetupStatus(await salesChannelsApi.setupStatus());
    } catch {
      // Setup status is a hint only — a failure here must never block the page.
      setSetupStatus(null);
    }
  }, [t]);

  const loadPickItems = useCallback(async (kind: OAuthKind, session: string) => {
    try {
      if (kind === "facebook") {
        const data = await salesChannelsApi.facebookPages(session);
        setPickItems(data.pages ?? []);
      } else if (kind === "instagram") {
        const data = await salesChannelsApi.instagramPages(session);
        setPickItems(data.pages ?? []);
      } else {
        const data = await salesChannelsApi.whatsappAccounts(session);
        setPickItems(data.wabas ?? []);
      }
    } catch (err) {
      // Surface the API's own message: it distinguishes "no WhatsApp
      // Business account" (no_waba, shown in the picker), "the login did
      // not grant the WhatsApp permission" (wa_scope_missing) and an
      // expired session from a generic load failure. Swallowing it into
      // one generic line hid the real cause live (2026-11-09).
      setError(err instanceof Error && err.message ? err.message : t("channels.oauthLoadFailed", "Could not load the accounts — please try again.", "অ্যাকাউন্টগুলো লোড করা যায়নি — আবার চেষ্টা করুন।"));
      setPicker(null);
    }
  }, [t]);

  // Handle the redirect back from Meta (?<kind>=connected|pick|error).
  useEffect(() => {
    if (!getToken()) { router.push("/login"); return; }
    load();
    const params = new URLSearchParams(window.location.search);
    let handled = false;
    for (const kind of OAUTH_KINDS) {
      const val = params.get(kind);
      if (!val) continue;
      handled = true;
      const account = params.get("account") || "";
      if (val === "connected") {
        const name = params.get("name");
        const connectedKey =
          kind === "instagram" ? "channels.instagramConnected" : kind === "whatsapp" ? "channels.whatsappConnected" : kind === "tiktok" ? "channels.tiktokConnected" : kind === "youtube" ? "channels.youtubeConnected" : "channels.facebookConnected";
        const connectedText =
          kind === "instagram"
            ? t(connectedKey, "Instagram account connected.", "Instagram অ্যাকাউন্ট যুক্ত হয়েছে।")
            : kind === "whatsapp"
              ? t(connectedKey, "WhatsApp number connected.", "WhatsApp নম্বর যুক্ত হয়েছে।")
              : kind === "tiktok"
                ? t(connectedKey, "TikTok account connected.", "TikTok অ্যাকাউন্ট যুক্ত হয়েছে।")
                : kind === "youtube"
                  ? t(connectedKey, "YouTube channel connected.", "YouTube চ্যানেল যুক্ত হয়েছে।")
                  : t(connectedKey, "Facebook Page connected.", "Facebook পেজ যুক্ত হয়েছে।");
        setNotice(`${connectedText}${name ? ` ${name}` : ""}`);
        load();
      } else if (val === "pick") {
        const session = params.get("session") || "";
        if (!session) {
          setError(oauthError(kind, ""));
          continue;
        }
        setPicker({ kind, session, account });
        loadPickItems(kind, session);
      } else if (val === "error") {
        setError(oauthError(kind, params.get("reason") || "", account, params.get("page") || ""));
      }
    }
    // Clean the URL so a refresh does not re-run the flow.
    if (handled) router.replace("/channels", { scroll: false });
  }, [load, loadPickItems, router, t]);

  const loginWithFacebook = async () => loginWith("facebook");

  // reauthenticate: force Facebook to ask for credentials again so the
  // user can log in with a DIFFERENT Facebook account. Without it
  // Facebook silently re-uses the account signed in on facebook.com and
  // the Page picker never appears.
  const loginWith = async (kind: OAuthKind, reauthenticate = false) => {
    setError("");
    setNotice("");
    setOauthBusy(kind);
    try {
      // TikTok / YouTube have their own authorize URLs (no Facebook login).
      if (kind === "tiktok") {
        const { url } = await salesChannelsApi.tiktokLogin();
        window.location.href = url;
        return;
      }
      if (kind === "youtube") {
        const { url } = await salesChannelsApi.youtubeLogin();
        window.location.href = url;
        return;
      }
      const opts = reauthenticate ? { reauthenticate: true } : undefined;
      const { url } =
        kind === "facebook"
          ? await salesChannelsApi.facebookLogin(opts)
          : kind === "instagram"
            ? await salesChannelsApi.instagramLogin(opts)
            : await salesChannelsApi.whatsappLogin(opts);
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : oauthError(kind, ""));
      setOauthBusy("");
    }
  };

  const connectWhatsappManually = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setNotice("");
    setWaManualBusy(true);
    try {
      await salesChannelsApi.whatsappManualConnect({
        phoneNumberId: waManualPhoneId.trim(),
        token: waManualToken.trim(),
        ...(waManualWabaId.trim() ? { wabaId: waManualWabaId.trim() } : {}),
      });
      setWaManualPhoneId("");
      setWaManualToken("");
      setWaManualWabaId("");
      setNotice(t("channels.whatsappManualConnected", "WhatsApp number connected.", "WhatsApp নম্বর যুক্ত হয়েছে।"));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : oauthError("whatsapp", ""));
    } finally {
      setWaManualBusy(false);
    }
  };

  const connectPickedPage = async (pageId: string, pageName: string) => {
    if (!picker) return;
    setError("");
    setNotice("");
    setConnectingId(pageId);
    try {
      await salesChannelsApi.facebookConnect({ session: picker.session, pageId });
      setPicker(null);
      setPickItems(null);
      setNotice(`${t("channels.facebookConnected", "Facebook Page connected.", "Facebook পেজ যুক্ত হয়েছে।")} ${pageName}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : oauthError("facebook", ""));
    } finally {
      setConnectingId("");
    }
  };

  const connectPickedInstagram = async (pageId: string, username: string) => {
    if (!picker) return;
    setError("");
    setNotice("");
    setConnectingId(pageId);
    try {
      await salesChannelsApi.instagramConnect({ session: picker.session, pageId });
      setPicker(null);
      setPickItems(null);
      setNotice(`${t("channels.instagramConnected", "Instagram account connected.", "Instagram অ্যাকাউন্ট যুক্ত হয়েছে।")} ${username}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : oauthError("instagram", ""));
    } finally {
      setConnectingId("");
    }
  };

  const connectPickedWhatsapp = async (wabaId: string, phoneNumberId: string, displayNumber: string) => {
    if (!picker) return;
    setError("");
    setNotice("");
    setConnectingId(phoneNumberId);
    try {
      await salesChannelsApi.whatsappConnect({ session: picker.session, wabaId, phoneNumberId });
      setPicker(null);
      setPickItems(null);
      setNotice(`${t("channels.whatsappConnected", "WhatsApp number connected.", "WhatsApp নম্বর যুক্ত হয়েছে।")} ${displayNumber}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : oauthError("whatsapp", ""));
    } finally {
      setConnectingId("");
    }
  };

  const connectedOf = (kind: OAuthKind) =>
    channels.filter((c) => OAUTH_CARDS[kind].platforms.includes(channelPlatform(c)));

  // Website chat: the widget auto-creates a "webchat" channel row on the
  // first visitor message, so a connected badge means visitors can
  // already reach the inbox from the shop's website.
  const websiteConnected = channels.filter((c) =>
    WEBSITE_CARD.platforms.includes(channelPlatform(c)),
  );

  const pickerTitle =
    picker?.kind === "instagram"
      ? t("channels.instagramPickTitle", "Choose an Instagram account", "একটি Instagram অ্যাকাউন্ট বেছে নিন")
      : picker?.kind === "whatsapp"
        ? t("channels.whatsappPickTitle", "Choose a WhatsApp number", "একটি WhatsApp নম্বর বেছে নিন")
        : t("channels.facebookPickTitle", "Choose a Facebook Page", "একটি Facebook পেজ বেছে নিন");
  const pickerHint =
    picker?.kind === "instagram"
      ? t("channels.instagramPickHint", "Pick the Instagram account linked to your Page for this shop.", "এই দোকানের জন্য পেজের সাথে যুক্ত Instagram অ্যাকাউন্টটি বেছে নাও।")
      : picker?.kind === "whatsapp"
        ? t("channels.whatsappPickHint", "Pick the WhatsApp Business number for this shop.", "এই দোকানের WhatsApp Business নম্বরটি বেছে নাও।")
        : t("channels.facebookPickHint", "Your Facebook account has more than one Page — pick the one for this shop.", "তোমার Facebook অ্যাকাউন্টে একাধিক পেজ আছে — এই দোকানের জন্য একটা বেছে নাও।");

  // WhatsApp picker rows: one row per phone number, grouped by account.
  const waRows =
    picker?.kind === "whatsapp" && Array.isArray(pickItems)
      ? (pickItems as WhatsappAccount[]).flatMap((w) =>
          whatsappNumbersOf(w).map((n) => ({ waba: w, number: n })),
        )
      : [];

  return (
    <div>
      <h1 className="page-title">{t("channels.title", "Channels", "চ্যানেল")}</h1>
      <p className="page-subtitle">{t("channels.subtitle", "Connect your Facebook Page, Instagram, WhatsApp, TikTok, YouTube and your own website.", "ফেসবুক পেজ, ইনস্টাগ্রাম, WhatsApp, TikTok, YouTube আর আপনার নিজের ওয়েবসাইট যুক্ত করুন।")}</p>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}
      {notice && <p className="bg-green-50 text-green-700 text-sm p-3 rounded-lg mb-4">{notice}</p>}

      <h2 className="font-bold mb-3">{t("channels.connectTitle", "Connect a channel", "চ্যানেল যুক্ত করুন")}</h2>
      <p className="text-sm text-slate-600 mb-4">{t("channels.connectDesc", "Connect each place your customers message you — Facebook, Instagram, WhatsApp, TikTok, YouTube or your own website.", "তোমার কাস্টমাররা যেখান থেকে মেসেজ দেয়, সেটা যুক্ত করো — Facebook, Instagram, WhatsApp, TikTok, YouTube বা তোমার নিজের ওয়েবসাইট।")}</p>

      {/* Uniform cards: each card is a flex column with the connect button
          pinned to the bottom (order-4 + mt-auto); the conditional extras
          (amber setup notes order-1, switch-account hint order-2, WhatsApp
          manual toggle order-3) render above it so all six buttons line up
          and no card ends up taller/shorter than its row-mates. */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mb-6">
        {OAUTH_KINDS.map((kind) => {
          const card = OAUTH_CARDS[kind];
          const connected = connectedOf(kind);
          return (
            <div key={kind} className="card card-hover p-4 flex flex-col h-full">
              <div className="flex items-center gap-2 mb-1">
                <PlatformLogo platform={kind} size={32} />
                <h3 className="font-bold">
                  {t(card.title, kind === "facebook" ? "Connect Facebook Page" : kind === "instagram" ? "Connect Instagram" : kind === "whatsapp" ? "Connect WhatsApp" : kind === "tiktok" ? "Connect TikTok" : "Connect YouTube", kind === "facebook" ? "Facebook পেজ যুক্ত করুন" : kind === "instagram" ? "Instagram যুক্ত করুন" : kind === "whatsapp" ? "WhatsApp যুক্ত করুন" : kind === "tiktok" ? "TikTok যুক্ত করুন" : "YouTube যুক্ত করুন")}
                </h3>
              </div>
              <p className="text-sm text-slate-600 mt-1 mb-3 min-h-[2.5rem]">
                {t(card.desc, kind === "facebook" ? "Connect the Facebook Page that should receive your shop's messages — no Page ID or token to type." : kind === "instagram" ? "Connect the Instagram account linked to your Page — Instagram messages will arrive in your inbox." : kind === "whatsapp" ? "Connect your WhatsApp Business number — customer WhatsApp messages will arrive in your inbox." : kind === "tiktok" ? "Connect your TikTok account — your TikTok profile will be verified before it is stored." : "Connect your YouTube channel — the channel will be verified before it is stored.", kind === "facebook" ? "তোমার দোকানের মেসেজ যে পেজে আসবে সেটা যুক্ত করো — পেজ ID বা টোকেন টাইপ করতে হবে না।" : kind === "instagram" ? "তোমার পেজের সাথে যুক্ত Instagram অ্যাকাউন্টটি যুক্ত করো — Instagram-এর মেসেজ ইনবক্সে আসবে।" : kind === "whatsapp" ? "তোমার WhatsApp Business নম্বরটি যুক্ত করো — কাস্টমারের WhatsApp মেসেজ ইনবক্সে আসবে।" : kind === "tiktok" ? "তোমার TikTok অ্যাকাউন্টটি যুক্ত করো — যুক্ত করার আগে প্রোফাইলটি যাচাই করা হবে।" : "তোমার YouTube চ্যানেলটি যুক্ত করো — যুক্ত করার আগে চ্যানেলটি যাচাই করা হবে।")}
              </p>
              {/* WhatsApp connects via Facebook Login (WABA OAuth) — that
                  stays as a small secondary note only; the card leads
                  with the WhatsApp Business number. */}
              {kind === "whatsapp" && (
                <p className="text-xs text-slate-500 -mt-1 mb-3">
                  {t("channels.whatsappNote", "Sign-in happens with Facebook, because WhatsApp Business is part of Meta.", "লগইন Facebook দিয়ে হবে, কারণ WhatsApp Business Meta-এরই অংশ।")}
                </p>
              )}
              {connected.length > 0 && (
                <p className="text-sm mb-3">
                  <span className="bg-green-100 text-green-800 text-xs px-2 py-0.5 rounded">{t("channels.connected", "Connected", "যুক্ত আছে")}</span>{" "}
                  <span className="text-slate-600">{connected.map((c) => channelDisplayName(c)).join(", ")}</span>
                </p>
              )}
              <button
                onClick={kind === "facebook" ? loginWithFacebook : () => loginWith(kind)}
                disabled={oauthBusy !== ""}
                className="order-4 mt-auto self-start rounded-lg px-4 py-2 text-white shadow-sm transition hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: card.color }}
              >
                {oauthBusy === kind
                  ? t(card.opening, "Opening…", "খুলছে…")
                  : t(card.button, kind === "facebook" ? "Facebook Connect" : kind === "instagram" ? "Instagram Connect" : kind === "whatsapp" ? "WhatsApp Connect" : kind === "tiktok" ? "TikTok Connect" : "YouTube Connect", kind === "facebook" ? "Facebook Connect" : kind === "instagram" ? "Instagram Connect" : kind === "whatsapp" ? "WhatsApp Connect" : kind === "tiktok" ? "TikTok Connect" : "YouTube Connect")}
              </button>
              {/* TikTok / YouTube need the owner's app keys first — say so
                  on the card instead of letting the button fail silently. */}
              {kind === "whatsapp" && setupStatus && !setupStatus.whatsappConfigIdConfigured && (
                <p className="order-1 text-xs bg-amber-50 text-amber-800 p-2 rounded-lg mt-3">
                  {t("channels.whatsappSetupNeeded", "One-click connect needs Embedded Signup — the owner must create the WhatsApp Embedded Signup config in the Meta app dashboard and set WHATSAPP_CONFIG_ID first. Until then, the manual form below (phone-number ID + permanent token) works without it.", "এক ক্লিকে যুক্ত করতে Embedded Signup লাগবে — মালিককে প্রথমে Meta অ্যাপে WhatsApp → Embedded Signup থেকে Configuration ID বানিয়ে WHATSAPP_CONFIG_ID বসাতে হবে। ততক্ষণ নিচের ম্যানুয়াল ফর্মটি (ফোন নম্বরের ID + স্থায়ী টোকেন) কাজ করবে।")}
                </p>
              )}
              {kind === "tiktok" && setupStatus && !setupStatus.tiktokConfigured && (
                <p className="order-1 text-xs bg-amber-50 text-amber-800 p-2 rounded-lg mt-3">
                  {t("channels.tiktokSetupNeeded", "TikTok is not set up yet — the owner must add the TikTok app's Client Key and Client Secret first (developers.tiktok.com → create an app, turn on Login Kit).", "TikTok এখনো সেটআপ হয়নি — মালিককে প্রথমে TikTok অ্যাপের Client Key আর Client Secret দিতে হবে (developers.tiktok.com-এ গিয়ে অ্যাপ বানিয়ে Login Kit চালু করুন)।")}
                </p>
              )}
              {kind === "youtube" && setupStatus && !setupStatus.youtubeConfigured && (
                <p className="order-1 text-xs bg-amber-50 text-amber-800 p-2 rounded-lg mt-3">
                  {t("channels.youtubeSetupNeeded", "YouTube is not set up yet — the owner must add the Google OAuth Client ID and Client Secret first (Google Cloud Console → OAuth client, YouTube Data API v3 on).", "YouTube এখনো সেটআপ হয়নি — মালিককে প্রথমে Google OAuth-এর Client ID আর Client Secret দিতে হবে (Google Cloud Console-এ OAuth ক্লায়েন্ট বানিয়ে YouTube Data API v3 চালু করুন)।")}
                </p>
              )}
              {/* WhatsApp manual fallback: verified phone-number ID + token.
                  Collapsed by default (toggle) — the inline form made this
                  card ~500px taller than the others and left a large empty
                  gap under the Facebook/Instagram cards. Same form, same
                  handler, just hidden until the user opens it. */}
              {kind === "whatsapp" && (
                <div className="order-3 mt-4 border-t pt-3">
                  <button
                    type="button"
                    onClick={() => setWaManualOpen((v) => !v)}
                    aria-expanded={waManualOpen}
                    className="flex w-full items-center justify-between text-sm font-medium text-slate-700 hover:text-brand-dark"
                  >
                    <span>{t("channels.whatsappManualTitle", "Or connect manually (Cloud API)", "অথবা ম্যানুয়ালি যুক্ত করুন (Cloud API)")}</span>
                    <span aria-hidden="true" className="text-base leading-none">{waManualOpen ? "▾" : "▸"}</span>
                  </button>
                  {waManualOpen && (
                    <form onSubmit={connectWhatsappManually} className="space-y-2 pt-2">
                      <p className="text-xs text-slate-500">{t("channels.whatsappManualHint", "If Facebook login does not list your number, paste the phone-number ID and a permanent access token from Meta Business Suite — the number is verified before it is stored. No test message is sent.", "Facebook লগইনে নম্বর না দেখালে, Meta Business Suite থেকে ফোন নম্বরের ID আর স্থায়ী অ্যাক্সেস টোকেন বসান — যুক্ত করার আগে নম্বরটি যাচাই করা হবে। কোনো টেস্ট মেসেজ পাঠানো হবে না।")}</p>
                      <input required value={waManualPhoneId} onChange={(e) => setWaManualPhoneId(e.target.value)} placeholder={t("channels.whatsappManualPhoneId", "Phone-number ID", "ফোন নম্বরের ID")} className="border rounded-lg px-3 py-2 w-full text-sm" />
                      <input required value={waManualToken} onChange={(e) => setWaManualToken(e.target.value)} placeholder={t("channels.whatsappManualToken", "Permanent access token", "স্থায়ী অ্যাক্সেস টোকেন")} className="border rounded-lg px-3 py-2 w-full text-sm" type="password" />
                      <input value={waManualWabaId} onChange={(e) => setWaManualWabaId(e.target.value)} placeholder={t("channels.whatsappManualWabaId", "WhatsApp Business Account ID (optional)", "WhatsApp Business অ্যাকাউন্ট ID (যদি থাকে)")} className="border rounded-lg px-3 py-2 w-full text-sm" />
                      <button disabled={waManualBusy} className="bg-brand text-white px-3 py-2 rounded-lg text-sm hover:bg-brand-dark disabled:opacity-50 w-full">
                        {waManualBusy ? t("channels.whatsappManualConnecting", "Verifying…", "যাচাই হচ্ছে…") : t("channels.whatsappManualButton", "Verify & connect number", "যাচাই করে নম্বর যুক্ত করুন")}
                      </button>
                    </form>
                  )}
                </div>
              )}
              {META_KINDS.includes(kind) && (
                <>
                  <p className="order-2 text-xs text-slate-500 mt-3">
                    {t("channels.switchAccountHint", "Facebook always uses the account signed in on facebook.com. To use another account, tap below — Facebook will ask you to log in again — or log out / switch accounts on facebook.com first.", "Facebook সবসময় facebook.com-এ যে অ্যাকাউন্টে লগইন করা আছে সেটাই ব্যবহার করে। অন্য অ্যাকাউন্ট ব্যবহার করতে নিচে চাপ দাও — Facebook আবার লগইন চাইবে — অথবা আগে facebook.com-এ গিয়ে লগআউট / অ্যাকাউন্ট বদলে নাও।")}
                  </p>
                  <button
                    onClick={() => loginWith(kind, true)}
                    disabled={oauthBusy !== ""}
                    className="order-2 mt-1 self-start text-xs font-medium text-brand-dark underline hover:text-brand disabled:opacity-50"
                  >
                    {t("channels.switchAccount", "Use a different Facebook account", "অন্য Facebook অ্যাকাউন্ট ব্যবহার করো")}
                  </button>
                </>
              )}
            </div>
          );
        })}
        {/* Website chat: not an OAuth flow — the button opens the
            copy-paste snippet page (/website-chat). The "Connected"
            badge appears once a webchat channel row exists (the widget
            creates one on the first visitor message). */}
        <div className="card card-hover p-4 flex flex-col h-full">
          <div className="flex items-center gap-2 mb-1">
            <PlatformLogo platform="website" size={32} />
            <h3 className="font-bold">
              {t(WEBSITE_CARD.title, "Connect Website", "ওয়েবসাইট যুক্ত করুন")}
            </h3>
          </div>
          <p className="text-sm text-slate-600 mt-1 mb-3 min-h-[2.5rem]">
            {t(WEBSITE_CARD.desc, "Add a chat box to your own website — visitor messages will arrive in your inbox.", "আপনার নিজের ওয়েবসাইটে একটি চ্যাট বাক্স বসান — ভিজিটরের মেসেজ আপনার ইনবক্সে আসবে।")}
          </p>
          {websiteConnected.length > 0 && (
            <p className="text-sm mb-3">
              <span className="bg-green-100 text-green-800 text-xs px-2 py-0.5 rounded">{t("channels.connected", "Connected", "যুক্ত আছে")}</span>{" "}
              <span className="text-slate-600">{websiteConnected.map((c) => channelDisplayName(c)).join(", ")}</span>
            </p>
          )}
          <button
            onClick={() => router.push("/website-chat")}
            className="mt-auto self-start rounded-lg px-4 py-2 text-white shadow-sm transition hover:opacity-90"
            style={{ backgroundColor: WEBSITE_CARD.color }}
          >
            {t(WEBSITE_CARD.button, "Website Connect", "Website Connect")}
          </button>
        </div>
      </div>

      {picker && (
        <div className="card p-4 mb-6">
          <h2 className="font-bold">{pickerTitle}</h2>
          <p className="text-sm text-slate-600 mt-1 mb-1">{pickerHint}</p>
          {picker.account && (
            <p className="text-sm text-slate-500 mb-3">
              {t("channels.loggedInAs", "Logged in as {account}", "{account} হিসেবে লগইন করা আছে").replace("{account}", picker.account)}
            </p>
          )}
          {pickItems === null ? (
            <div className="skeleton h-12" />
          ) : picker.kind === "whatsapp" ? (
            waRows.length === 0 ? (
              <p className="text-slate-500">{oauthError("whatsapp", "no_waba", picker.account)}</p>
            ) : (
              <ul className="divide-y">
                {waRows.map(({ waba, number }) => (
                  <li key={number.id} className="flex items-center gap-3 py-2">
                    <span className="w-10 h-10 rounded-full bg-green-100 text-green-700 flex items-center justify-center font-bold">{whatsappNumberLabel(number).slice(0, 1)}</span>
                    <span className="flex-1 min-w-0">
                      <span className="block font-medium truncate">{whatsappNumberLabel(number)}</span>
                      <span className="block text-xs text-slate-500 truncate">{waba.name}</span>
                    </span>
                    <button disabled={connectingId !== ""} onClick={() => connectPickedWhatsapp(waba.id, number.id, whatsappNumberLabel(number))} className="bg-brand text-white px-3 py-1.5 rounded-lg text-sm hover:bg-brand-dark disabled:opacity-50 shrink-0">
                      {connectingId === number.id ? t("channels.whatsappConnecting", "Connecting…", "যুক্ত হচ্ছে…") : t("channels.whatsappPickButton", "Connect this number", "এই নম্বরটি যুক্ত করুন")}
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : picker.kind === "instagram" ? (
            (pickItems as InstagramPage[]).length === 0 ? (
              <p className="text-slate-500">{oauthError("instagram", "no_pages", picker.account)}</p>
            ) : (
              <ul className="divide-y">
                {(pickItems as InstagramPage[]).map((p) => (
                  <li key={p.id} className="flex items-center gap-3 py-2">
                    {p.instagram?.picture ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.instagram.picture} alt="" className="w-10 h-10 rounded-full object-cover" />
                    ) : p.picture ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.picture} alt="" className="w-10 h-10 rounded-full object-cover" />
                    ) : (
                      <span className="w-10 h-10 rounded-full bg-pink-100 text-pink-700 flex items-center justify-center font-bold">{p.name.slice(0, 1)}</span>
                    )}
                    <span className="flex-1 min-w-0">
                      <span className="block font-medium truncate">{p.instagram ? `@${p.instagram.username}` : p.name}</span>
                      <span className="block text-xs text-slate-500 truncate">
                        {p.instagram ? p.name : t("channels.instagramNoLinked", "No Instagram linked", "Instagram যুক্ত নেই")}
                      </span>
                    </span>
                    <button disabled={connectingId !== "" || !p.instagram} onClick={() => p.instagram && connectPickedInstagram(p.id, p.instagram.username)} className="bg-brand text-white px-3 py-1.5 rounded-lg text-sm hover:bg-brand-dark disabled:opacity-50 shrink-0">
                      {connectingId === p.id ? t("channels.instagramConnecting", "Connecting…", "যুক্ত হচ্ছে…") : t("channels.instagramPickButton", "Connect this account", "এই অ্যাকাউন্টটি যুক্ত করুন")}
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : (pickItems as FacebookPage[]).length === 0 ? (
            <p className="text-slate-500">{fbError("no_pages", picker.account)}</p>
          ) : (
            <ul className="divide-y">
              {(pickItems as FacebookPage[]).map((p) => (
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
                  <button disabled={connectingId !== ""} onClick={() => connectPickedPage(p.id, p.name)} className="bg-brand text-white px-3 py-1.5 rounded-lg text-sm hover:bg-brand-dark disabled:opacity-50 shrink-0">
                    {connectingId === p.id ? t("channels.facebookConnecting", "Connecting…", "যুক্ত হচ্ছে…") : t("channels.facebookPickButton", "Connect this Page", "এই পেজটি যুক্ত করুন")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {loading ? (<div className="space-y-2"><div className="skeleton h-12" /><div className="skeleton h-12" /><div className="skeleton h-12" /></div>) : channels.length === 0 ? (
        <div className="empty-state">{t("channels.empty", "No channels connected yet — tap Connect on a card above.", "কোনো চ্যানেল যুক্ত নেই — উপরের একটি কার্ডে Connect চাপুন।")}</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="table-head border-b text-left text-slate-500"><th className="p-3">{t("channels.thPlatform", "Platform", "প্ল্যাটফর্ম")}</th><th className="p-3">{t("channels.thName", "Name", "নাম")}</th><th className="p-3">{t("channels.thStatus", "Status", "স্ট্যাটাস")}</th><th className="p-3">{t("channels.thAdded", "Added", "যুক্ত হয়েছে")}</th></tr></thead>
            <tbody>
              {channels.map((c) => (
                <tr key={c.id} className="border-b transition-colors hover:bg-orange-50">
                  <td className="p-3 font-medium">{platformLabel(channelPlatform(c))}</td>
                  <td className="p-3">{channelDisplayName(c)}</td>
                  <td className="p-3">
                    <span className={`text-xs px-2 py-0.5 rounded ${channelNeedsApproval(c) ? "bg-amber-100 text-amber-800" : c.status === "active" ? "bg-green-100 text-green-800" : "bg-slate-100 text-slate-600"}`}>
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
