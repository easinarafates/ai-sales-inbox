"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import {
  asArray,
  getToken,
  productsApi,
  type Product,
} from "@/lib/api";
import {
  MAX_POSTS_PER_DAY,
  fetchAuthedMediaUrl,
  isVideoUrl,
  postMediaType,
  postMediaUrls,
  resolveMediaUrl,
  schedulingApi,
  type DayCounts,
  type MediaType,
  type ScheduledPost,
} from "@/lib/api-scheduling";
import { instagramApi, youtubeApi, type InstagramStatus, type YoutubeStatus } from "@/lib/api-social";

// Facebook, Instagram, YouTube and TikTok can actually publish (see
// publisher.ts). Instagram takes image or video posts; YouTube +
// TikTok take video posts only (the API rejects text/image).
// Messenger/WhatsApp are message channels, never post platforms, so
// they are not offered at all.
const PLATFORM_OPTIONS = ["facebook", "instagram", "youtube", "tiktok"];
const STATUS_OPTIONS = ["scheduled", "draft", "published", "cancelled"];

function dhakaDateStr(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function next7Days(): string[] {
  const out: string[] = [];
  const now = Date.now();
  for (let i = 0; i < 7; i++) {
    out.push(dhakaDateStr(new Date(now + i * 24 * 60 * 60 * 1000)));
  }
  return out;
}

function weekdayOf(date: string): number {
  return new Date(`${date}T12:00:00+06:00`).getDay();
}

function postDate(p: ScheduledPost): string {
  return (p.scheduledAt || p.scheduled_at || p.createdAt || p.created_at || "").slice(0, 10);
}

function toTimeValue(iso?: string | null): string {
  if (!iso) return "09:00";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "09:00";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Dhaka",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

/**
 * Image / video preview. Public (https) links play directly; local
 * /api/uploads/... files are fetched with the auth token as a blob
 * because <img>/<video> tags cannot send an Authorization header
 * (see fetchAuthedMediaUrl).
 */
function MediaPreview({ url, alt }: { url: string; alt: string }) {
  const { t } = useI18n();
  const [src, setSrc] = useState(url.startsWith("/") ? "" : resolveMediaUrl(url));
  useEffect(() => {
    if (!url.startsWith("/")) return;
    let alive = true;
    let obj = "";
    fetchAuthedMediaUrl(url)
      .then((o) => {
        if (alive) {
          obj = o;
          setSrc(o);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      if (obj) URL.revokeObjectURL(obj);
    };
  }, [url]);
  if (!src) {
    return <div className="skeleton h-32 w-full" />;
  }
  return isVideoUrl(url) ? (
    <video src={src} controls className="max-h-64 rounded-lg w-full" />
  ) : (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} className="max-h-64 rounded-lg" />
  );
}

export default function SchedulePage() {
  const router = useRouter();
  const { t, lang, fmtDate } = useI18n();
  const [posts, setPosts] = useState<ScheduledPost[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [counts, setCounts] = useState<DayCounts>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");

  const weekDays = useMemo(() => next7Days(), []);
  const [selectedDay, setSelectedDay] = useState(() => dhakaDateStr(new Date()));

  // Create form
  const [caption, setCaption] = useState("");
  const [mediaType, setMediaType] = useState<MediaType>("text");
  const [mediaUrl, setMediaUrl] = useState("");
  const [mediaUrlInput, setMediaUrlInput] = useState("");
  const [platforms, setPlatforms] = useState<string[]>(["facebook"]);
  const [time, setTime] = useState("09:00");
  const [productIds, setProductIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  // Auto caption
  const [captionOptions, setCaptionOptions] = useState<string[]>([]);
  const [captionLoading, setCaptionLoading] = useState(false);
  const [captionAi, setCaptionAi] = useState(false);
  const [captionAnalysis, setCaptionAnalysis] = useState("");

  // YouTube quota / reconnect hint (shown when YouTube is selected).
  const [ytStatus, setYtStatus] = useState<YoutubeStatus | null>(null);

  // Instagram reconnect hint (shown when Instagram is selected and the
  // connected account was linked without the publish permission).
  const [igStatus, setIgStatus] = useState<InstagramStatus | null>(null);

  // Edit form
  const [editing, setEditing] = useState<ScheduledPost | null>(null);
  const [editCaption, setEditCaption] = useState("");
  const [editDay, setEditDay] = useState("");
  const [editTime, setEditTime] = useState("09:00");

  const weekdayLabel = (date: string): string => {
    const keys = [
      ["weekday_sun", "Sun", "রবি"],
      ["weekday_mon", "Mon", "সোম"],
      ["weekday_tue", "Tue", "মঙ্গল"],
      ["weekday_wed", "Wed", "বুধ"],
      ["weekday_thu", "Thu", "বৃহ"],
      ["weekday_fri", "Fri", "শুক্র"],
      ["weekday_sat", "Sat", "শনি"],
    ] as const;
    const [key, en, bn] = keys[weekdayOf(date)];
    return t(key, en, bn);
  };

  const load = useCallback(async () => {
    try {
      const data = await schedulingApi.list({
        status: statusFilter || undefined,
      });
      setPosts(Array.isArray(data.posts) ? data.posts : []);
      setCounts(data.counts || {});
    } catch (err) {
      setError(err instanceof Error ? err.message : t("load_failed", "Could not load scheduled posts.", "শিডিউল করা পোস্ট লোড করা যায়নি।"));
    } finally {
      setLoading(false);
    }
  }, [statusFilter, t]);

  useEffect(() => {
    if (!getToken()) {
      router.push("/login");
      return;
    }
    load();
    productsApi.list().then((d) => setProducts(asArray(d))).catch(() => undefined);
    youtubeApi.status().then(setYtStatus).catch(() => undefined);
    instagramApi.status().then(setIgStatus).catch(() => undefined);
  }, [load, router]);

  const selectedCount = counts[selectedDay] ?? 0;
  const dayFull = selectedCount >= MAX_POSTS_PER_DAY;

  const filteredPosts = useMemo(
    () => posts.filter((p) => postDate(p) === selectedDay),
    [posts, selectedDay]
  );

  const togglePlatform = (p: string) => {
    // Facebook must stay selected: at least one platform is required and
    // it is the only one that can publish right now.
    if (p === "facebook") return;
    setPlatforms((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) {
      setError(t("upload_type_error", "Only images or videos can be uploaded.", "শুধু ছবি বা ভিডিও আপলোড করা যায়।"));
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      setError(t("upload_size_error", "File must be 25 MB or smaller.", "ফাইল 25 MB-এর বেশি হতে পারবে না।"));
      return;
    }
    setUploading(true);
    try {
      const res = await schedulingApi.uploadFile(file);
      setMediaUrl(res.url);
      setMediaType(res.mediaType);
      setNotice(t("upload_done", "Media uploaded.", "মিডিয়া আপলোড হয়েছে।"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("upload_failed", "Upload failed.", "আপলোড করা যায়নি।"));
    } finally {
      setUploading(false);
    }
  };

  const addMediaUrl = async () => {
    const url = mediaUrlInput.trim();
    if (!url) return;
    setError("");
    setUploading(true);
    try {
      const res = await schedulingApi.uploadUrl(url);
      setMediaUrl(res.url);
      setMediaType(res.mediaType);
      setNotice(t("upload_done", "Media uploaded.", "মিডিয়া আপলোড হয়েছে।"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("upload_failed", "Upload failed.", "আপলোড করা যায়নি।"));
    } finally {
      setUploading(false);
    }
  };

  const autoCaption = async () => {
    setError("");
    setCaptionLoading(true);
    setCaptionAnalysis("");
    try {
      const res = await schedulingApi.autoCaption({
        productIds: productIds.length ? productIds : undefined,
        topic: caption.trim() || undefined,
        lang,
        mediaUrls: mediaUrl ? [mediaUrl] : undefined,
      });
      setCaptionOptions(res.options || []);
      setCaptionAi(res.aiGenerated);
      if (res.mediaAnalysis?.analysis) {
        setCaptionAnalysis(res.mediaAnalysis.analysis);
      }
      if (!res.aiGenerated) {
        setNotice(t("caption_template_note", "AI did not answer, so template captions from your real product data are shown.", "AI উত্তর দেয়নি, তাই আপনার আসল প্রোডাক্টের তথ্য দিয়ে সাধারণ ক্যাপশন দেখানো হচ্ছে।"));
      } else if (res.note) {
        setNotice(res.note);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("caption_failed", "Could not make a caption.", "ক্যাপশন বানানো যায়নি।"));
    } finally {
      setCaptionLoading(false);
    }
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (dayFull) return;
    setError("");
    setNotice("");
    setSaving(true);
    try {
      const scheduledAt = new Date(`${selectedDay}T${time}:00+06:00`).toISOString();
      await schedulingApi.create({
        caption: caption.trim(),
        mediaUrls: mediaUrl ? [mediaUrl] : undefined,
        mediaType,
        platforms,
        scheduledAt,
        productIds: productIds.length ? productIds : undefined,
      });
      setCaption("");
      setMediaUrl("");
      setMediaUrlInput("");
      setMediaType("text");
      setProductIds([]);
      setPlatforms(["facebook"]);
      setCaptionOptions([]);
      setNotice(t("scheduled_done", "Post scheduled.", "পোস্ট শিডিউল হয়েছে।"));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("schedule_failed", "Could not schedule the post.", "পোস্ট শিডিউল করা যায়নি।"));
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (p: ScheduledPost) => {
    setEditing(p);
    setEditCaption(p.caption || "");
    setEditDay(postDate(p) || selectedDay);
    setEditTime(toTimeValue(p.scheduledAt || p.scheduled_at));
  };

  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setError("");
    try {
      const scheduledAt = new Date(`${editDay}T${editTime}:00+06:00`).toISOString();
      await schedulingApi.update(editing.id, {
        caption: editCaption.trim(),
        scheduledAt,
      });
      setEditing(null);
      setNotice(t("updated_done", "Post updated.", "পোস্ট আপডেট হয়েছে।"));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("update_failed", "Could not update the post.", "পোস্ট আপডেট করা যায়নি।"));
    }
  };

  const remove = async (p: ScheduledPost) => {
    if (!confirm(t("delete_confirm", "Delete / cancel this post?", "এই পোস্টটি বাতিল/মুছে ফেলবেন?"))) return;
    setError("");
    try {
      if (p.status === "draft") {
        await schedulingApi.remove(p.id);
      } else {
        await schedulingApi.cancel(p.id);
      }
      setNotice(t("cancelled_done", "Post cancelled.", "পোস্ট বাতিল হয়েছে।"));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("delete_failed", "Could not delete the post.", "পোস্ট মোছা যায়নি।"));
    }
  };

  const publishNow = async (id: string) => {
    setError("");
    try {
      await schedulingApi.publishNow(id);
      // Publishing frees the day's slot, so a new post can take its place.
      setNotice(t("published_done", "Post published — its slot is now free for a new post.", "পোস্ট প্রকাশ হয়েছে — ওই দিনের স্লটটি এখন খালি, নতুন পোস্ট যোগ করা যাবে।"));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("publish_failed", "Could not publish now.", "এখনই প্রকাশ করা যায়নি।"));
    }
  };

  const statusLabel = (s?: string): string => {
    switch (s) {
      case "scheduled":
        return t("status_scheduled", "Scheduled", "শিডিউল করা");
      case "draft":
        return t("status_draft", "Draft", "খসড়া");
      case "published":
        return t("status_published", "Published", "প্রকাশিত");
      case "cancelled":
        return t("status_cancelled", "Cancelled", "বাতিল");
      case "publishing":
        return t("status_publishing", "Publishing", "প্রকাশ হচ্ছে");
      case "failed":
        return t("status_failed", "Failed", "ব্যর্থ");
      default:
        return s || "";
    }
  };

  const mediaTypeLabel = (m: MediaType): string => {
    if (m === "video") return t("type_video", "Video", "ভিডিও");
    if (m === "image") return t("type_image", "Image", "ছবি");
    return t("type_text", "Text", "লেখা");
  };

  return (
    <div>
      <h1 className="page-title">
        {t("page_title", "Post Schedule", "পোস্ট শিডিউল")}
      </h1>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}
      {notice && <p className="bg-green-50 text-green-700 text-sm p-3 rounded-lg mb-4">{notice}</p>}

      {/* 7-day calendar */}
      <div className="card p-4 mb-6">
        <h2 className="font-bold mb-1">{t("calendar_title", "Next 7 days", "আগামী ৭ দিন")}</h2>
        <p className="text-sm text-slate-500 mb-3">
          {t("calendar_note", "Max 15 scheduled posts per day. Publishing a post frees its slot.", "প্রতিদিন সর্বোচ্চ ১৫টি পোস্ট শিডিউল করা যায়। পোস্ট প্রকাশ হলে স্লট খালি হয়।")}
        </p>
        <div className="grid grid-cols-7 gap-2 text-center text-sm">
          {weekDays.map((date) => {
            const count = counts[date] ?? 0;
            const full = count >= MAX_POSTS_PER_DAY;
            const selected = selectedDay === date;
            return (
              <button
                key={date}
                type="button"
                onClick={() => setSelectedDay(date)}
                className={`rounded-lg py-2 border ${
                  selected
                    ? "bg-[#FF5B2E] text-white border-[#FF5B2E]"
                    : full
                      ? "bg-red-50 border-red-200 text-red-700"
                      : count
                        ? "bg-orange-50 border-orange-200 hover:bg-orange-100"
                        : "hover:bg-slate-50"
                }`}
              >
                <span className="block font-medium">{weekdayLabel(date)}</span>
                <span className="block">{Number(date.slice(-2))}</span>
                <span className="block text-xs">
                  {count}/{MAX_POSTS_PER_DAY}
                </span>
                {full && (
                  <span className="block text-xs font-medium">
                    {t("day_full", "Full", "ভর্তি")}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {dayFull && (
          <p className="text-sm text-red-700 bg-red-50 rounded-lg p-3 mt-3">
            {t("day_full_note", "This day is full (15/15). Publish or cancel a post to free a slot, or pick another day.", "এই দিনটি ভর্তি (১৫/১৫)। স্লট খালি করতে একটি পোস্ট প্রকাশ বা বাতিল করুন, অথবা অন্য দিন বেছে নিন।")}
          </p>
        )}
      </div>

      {/* Create form */}
      <form onSubmit={create} className="card p-4 mb-6 space-y-3">
        <h2 className="font-bold">{t("create_title", "Schedule a new post", "নতুন পোস্ট শিডিউল করুন")}</h2>

        <div className="flex flex-wrap gap-2">
          {(["image", "video", "text"] as MediaType[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMediaType(m)}
              className={`px-4 py-2 rounded-lg text-sm ${
                mediaType === m
                  ? "bg-[#FF5B2E] text-white"
                  : "bg-slate-100 hover:bg-slate-200"
              }`}
            >
              {mediaTypeLabel(m)}
            </button>
          ))}
        </div>

        <textarea
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          placeholder={t("caption_placeholder", "Write a caption…", "ক্যাপশন লিখুন…")}
          className="w-full border rounded-lg px-3 py-2"
          rows={3}
        />

        {mediaType !== "text" && (
          <div className="space-y-2">
            <label className="block text-sm font-medium">
              {mediaType === "video"
                ? t("upload_video_label", "Upload a video", "ভিডিও আপলোড করুন")
                : t("upload_image_label", "Upload an image", "ছবি আপলোড করুন")}
            </label>
            <input
              type="file"
              accept={mediaType === "video" ? "video/*" : "image/*"}
              onChange={(e) => onFile(e.target.files?.[0])}
              className="block w-full text-sm"
            />
            <div className="flex gap-2">
              <input
                type="url"
                value={mediaUrlInput}
                onChange={(e) => setMediaUrlInput(e.target.value)}
                placeholder={t("media_url_placeholder", "Or paste an image/video link…", "অথবা ছবি/ভিডিওর লিংক দিন…")}
                className="flex-1 border rounded-lg px-3 py-2"
              />
              <button
                type="button"
                onClick={addMediaUrl}
                disabled={uploading}
                className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm disabled:opacity-50"
              >
                {t("add_link", "Add link", "লিংক যোগ করুন")}
              </button>
            </div>
            {uploading && <p className="text-sm text-slate-500">{t("uploading", "Uploading…", "আপলোড হচ্ছে…")}</p>}
            {mediaUrl && (
              <div className="mt-2">
                <MediaPreview url={mediaUrl} alt={t("media_preview_alt", "Media preview", "মিডিয়ার প্রিভিউ")} />
                <button
                  type="button"
                  onClick={() => { setMediaUrl(""); setMediaUrlInput(""); setCaptionAnalysis(""); setCaptionOptions([]); }}
                  className="text-sm text-red-700 underline mt-1"
                >
                  {t("remove_media", "Remove media", "মিডিয়া সরান")}
                </button>
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={autoCaption}
            disabled={captionLoading}
            className="bg-[#FF5B2E] hover:bg-[#E8491F] text-white px-4 py-2 rounded-lg text-sm disabled:opacity-50"
          >
            {captionLoading
              ? t("caption_loading", "Making captions…", "ক্যাপশন বানানো হচ্ছে…")
              : t("caption_button", "Auto caption", "অটো ক্যাপশন")}
          </button>
          {captionAi && (
            <span className="text-xs text-green-600 self-center">
              {t("caption_ai_note", "Made by AI from your real product data.", "আপনার আসল প্রোডাক্টের তথ্য দিয়ে AI বানিয়েছে।")}
            </span>
          )}
        </div>
        {captionAnalysis && (
          <div className="text-sm bg-green-50 border border-green-200 rounded-lg px-3 py-2">
            <span className="font-medium">{t("caption_media_seen", "AI saw in your media:", "AI আপনার ছবি/ভিডিওতে দেখলো:")}</span>{" "}
            {captionAnalysis}
          </div>
        )}
        {captionOptions.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">{t("caption_options_title", "Pick a caption:", "ক্যাপশন বেছে নিন:")}</p>
            {captionOptions.map((opt, i) => (
              <button
                key={i}
                type="button"
                onClick={() => { setCaption(opt); setCaptionOptions([]); setCaptionAnalysis(""); }}
                className="block w-full text-left text-sm bg-orange-50 hover:bg-orange-100 border border-orange-200 rounded-lg px-3 py-2 whitespace-pre-wrap"
              >
                {opt}
              </button>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-3">
          <span className="text-sm text-slate-500 self-center">{t("platforms_label", "Platforms:", "প্ল্যাটফর্ম:")}</span>
          {PLATFORM_OPTIONS.map((p) => (
            <label key={p} className="text-sm flex items-center gap-1">
              <input type="checkbox" checked={platforms.includes(p)} onChange={() => togglePlatform(p)} /> {p}
            </label>
          ))}
        </div>
        <p className="text-xs text-slate-500">{t("schedule.onlyFacebook", "Facebook, Instagram, YouTube and TikTok posts can be published — Instagram takes image or video posts; YouTube and TikTok take video posts only.", "ফেসবুক, Instagram, YouTube আর TikTok পোস্ট প্রকাশ করা যায় — Instagram-এ ছবি বা ভিডিও পোস্ট হয়; YouTube আর TikTok-এ শুধু ভিডিও পোস্ট হয়।")}</p>
        {platforms.includes("instagram") && igStatus && (
          <p className="text-xs text-slate-500">
            {!igStatus.connected
              ? t("schedule.igNotConnected", "Instagram is not connected yet — connect it on the Channels page first.", "Instagram এখনো যুক্ত হয়নি — প্রথমে Channels পেজ থেকে Instagram যুক্ত করুন।")
              : igStatus.needsReconnectForPublish
                ? t("schedule.igReconnect", "Instagram is connected without the publish permission — reconnect Instagram on the Channels page to allow posting.", "Instagram প্রকাশের অনুমতি ছাড়া যুক্ত আছে — পোস্ট করতে Channels পেজ থেকে Instagram আবার যুক্ত করুন।")
                : t("schedule.igReady", "Instagram is connected and ready to publish.", "Instagram যুক্ত আছে — পোস্ট প্রকাশ করা যাবে।")}
          </p>
        )}
        {platforms.includes("youtube") && ytStatus && (
          <p className="text-xs text-slate-500">
            {ytStatus.needsReconnectForUpload
              ? t("schedule.ytReconnect", "YouTube is connected read-only — reconnect YouTube on the Channels page to allow video uploads.", "YouTube শুধু পড়ার অনুমতি নিয়ে যুক্ত আছে — ভিডিও আপলোড করতে Channels পেজ থেকে YouTube আবার যুক্ত করুন।")
              : t("schedule.ytQuota", "YouTube uploads today: {n}/{max} (daily quota 10,000 units, one upload ~1,600).", "আজ YouTube আপলোড: {n}/{max} (দৈনিক কোটা ১০,০০০ ইউনিট, এক আপলোড ~১,৬০০)।").replace("{n}", String(ytStatus.quota.uploadsToday)).replace("{max}", String(ytStatus.quota.maxUploadsPerDay))}
          </p>
        )}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <label className="text-sm">
            {t("date_label", "Date", "তারিখ")}
            <select
              value={selectedDay}
              onChange={(e) => setSelectedDay(e.target.value)}
              className="block w-full border rounded-lg px-3 py-2 bg-white mt-1"
            >
              {weekDays.map((d) => (
                <option key={d} value={d} disabled={(counts[d] ?? 0) >= MAX_POSTS_PER_DAY}>
                  {d} ({weekdayLabel(d)}) — {counts[d] ?? 0}/{MAX_POSTS_PER_DAY}
                  {(counts[d] ?? 0) >= MAX_POSTS_PER_DAY ? ` (${t("day_full", "Full", "ভর্তি")})` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            {t("time_label", "Time", "সময়")}
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="block w-full border rounded-lg px-3 py-2 bg-white mt-1"
            />
          </label>
          <label className="text-sm">
            {t("product_label", "Product (optional)", "প্রোডাক্ট (ঐচ্ছিক)")}
            <select
              value={productIds[0] || ""}
              onChange={(e) => setProductIds(e.target.value ? [e.target.value] : [])}
              className="block w-full border rounded-lg px-3 py-2 bg-white mt-1"
            >
              <option value="">{t("product_none", "No product", "কোনো প্রোডাক্ট নয়")}</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
        </div>
        <button
          disabled={saving || uploading || dayFull}
          className="bg-[#FF5B2E] hover:bg-[#E8491F] text-white py-2 px-6 rounded-lg disabled:opacity-50"
        >
          {saving
            ? t("scheduling", "Scheduling…", "শিডিউল হচ্ছে…")
            : dayFull
              ? t("day_full_button", "This day is full", "এই দিনটি ভর্তি")
              : t("schedule_button", "Schedule post", "শিডিউল করুন")}
        </button>
      </form>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-4">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="border rounded-lg px-3 py-2 bg-white">
          <option value="">{t("filter_all_status", "All statuses", "সব স্ট্যাটাস")}</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>{statusLabel(s)}</option>
          ))}
        </select>
        <span className="text-sm text-slate-500 self-center">
          {t("showing_day", "Showing posts for", "দেখানো হচ্ছে")} {selectedDay} ({selectedCount}/{MAX_POSTS_PER_DAY})
        </span>
      </div>

      {loading ? (
        <div className="space-y-3">
          <div className="skeleton h-16" />
          <div className="skeleton h-16" />
        </div>
      ) : filteredPosts.length === 0 ? (
        <div className="empty-state">
          {t("no_posts_day", "No posts on this day yet.", "এই দিনে এখনো কোনো পোস্ট নেই।")}
        </div>
      ) : (
        <div className="space-y-3">
          {filteredPosts.map((p) => {
            const urls = postMediaUrls(p);
            const first = urls[0];
            const isVideo = postMediaType(p) === "video" || (first ? isVideoUrl(first) : false);
            return (
              <div key={p.id} className="card p-4">
                {editing?.id === p.id ? (
                  <form onSubmit={saveEdit} className="space-y-3">
                    <textarea value={editCaption} onChange={(e) => setEditCaption(e.target.value)} className="w-full border rounded-lg px-3 py-2" rows={3} />
                    <div className="flex flex-wrap gap-2">
                      <select value={editDay} onChange={(e) => setEditDay(e.target.value)} className="border rounded-lg px-3 py-2 bg-white">
                        {weekDays.map((d) => (
                          <option key={d} value={d}>{d} ({weekdayLabel(d)})</option>
                        ))}
                      </select>
                      <input type="time" value={editTime} onChange={(e) => setEditTime(e.target.value)} className="border rounded-lg px-3 py-2 bg-white" />
                      <button className="bg-[#FF5B2E] hover:bg-[#E8491F] text-white px-4 py-2 rounded-lg text-sm">
                        {t("save_button", "Save", "সংরক্ষণ")}
                      </button>
                      <button type="button" onClick={() => setEditing(null)} className="bg-slate-200 px-4 py-2 rounded-lg text-sm">
                        {t("cancel_button", "Cancel", "বাতিল")}
                      </button>
                    </div>
                  </form>
                ) : (
                  <>
                    {first && (
                      <div className="mb-2">
                        <MediaPreview url={first} alt={t("media_preview_alt", "Media preview", "মিডিয়ার প্রিভিউ")} />
                      </div>
                    )}
                    <p className="text-sm whitespace-pre-wrap">{p.caption || "—"}</p>
                    {p.status === "failed" && (p.lastError || (p as Record<string, unknown>).last_error) && (
                      <p className="text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg p-2 mt-2">
                        {(p.lastError as string) || ((p as Record<string, unknown>).last_error as string)}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2 mt-2 text-xs">
                      <span className="bg-orange-100 text-[#FF5B2E] px-2 py-0.5 rounded">{mediaTypeLabel(postMediaType(p))}</span>
                      {(p.platforms || []).map((pl) => (
                        <span key={pl} className="bg-slate-100 px-2 py-0.5 rounded">{pl}</span>
                      ))}
                      {p.status && <span className="bg-blue-100 text-blue-800 px-2 py-0.5 rounded">{statusLabel(p.status)}</span>}
                      <span className="text-slate-500">{fmtDate(p.scheduledAt || p.scheduled_at)}</span>
                    </div>
                    <div className="flex flex-wrap gap-2 mt-3">
                      <button onClick={() => startEdit(p)} className="bg-slate-800 text-white px-3 py-1.5 rounded-lg text-sm">
                        {t("edit_button", "Edit", "এডিট")}
                      </button>
                      {p.status !== "published" && p.status !== "cancelled" && (
                        <button onClick={() => publishNow(p.id)} className="bg-[#FF5B2E] hover:bg-[#E8491F] text-white px-3 py-1.5 rounded-lg text-sm">
                          {t("publish_now_button", "Publish now", "এখনই প্রকাশ করুন")}
                        </button>
                      )}
                      <button onClick={() => remove(p)} className="bg-red-50 text-red-700 px-3 py-1.5 rounded-lg text-sm">
                        {p.status === "draft"
                          ? t("delete_button", "Delete", "মুছুন")
                          : t("cancel_post_button", "Cancel post", "পোস্ট বাতিল করুন")}
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
