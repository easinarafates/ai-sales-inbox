"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { getToken } from "@/lib/api";
import { ownerApi, type OwnerShop, type OwnerShopDetail } from "@/lib/api-owner";

export default function OwnerShopsPage() {
  const { t, fmtDate, fmtTaka } = useI18n();
  const router = useRouter();
  const [shops, setShops] = useState<OwnerShop[]>([]);
  const [detail, setDetail] = useState<OwnerShopDetail | null>(null);
  const [isOwner, setIsOwner] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const me = await ownerApi.me();
      setIsOwner(me.isOwner);
      if (!me.isOwner) return;
      const d = await ownerApi.shops();
      setShops(d.shops);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ownerLoadFail", "Could not load the Owner Panel.", "ওনার প্যানেল লোড করা যায়নি।"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!getToken()) { router.push("/login"); return; }
    load();
  }, [load, router]);

  const openDetail = async (id: string) => {
    setError("");
    try {
      const d = await ownerApi.shop(id);
      setDetail(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ownerShopDetailFail", "Could not load the shop.", "দোকানটি লোড করা যায়নি।"));
    }
  };

  const toggleSuspend = async (shop: OwnerShop) => {
    setError("");
    setMessage("");
    setBusy(shop.id);
    try {
      const res = shop.suspended ? await ownerApi.activateShop(shop.id) : await ownerApi.suspendShop(shop.id);
      setMessage(res.message);
      await load();
      if (detail?.shop.id === shop.id) await openDetail(shop.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ownerShopToggleFail", "Could not change the shop status.", "দোকানের অবস্থা বদলানো যায়নি।"));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="bg-[#fff8f3] min-h-screen -m-6 p-6">
      <h1 className="text-2xl font-bold mb-1">{t("ownerShopsTitle", "Shop accounts", "দোকানের অ্যাকাউন্ট")}</h1>
      <p className="text-sm text-slate-500 mb-4">
        {t(
          "ownerShopsSub",
          "Every shop on your platform. Suspending a shop blocks its users from logging in until you re-activate it.",
          "আপনার প্ল্যাটফর্মের সব দোকান। কোনো দোকান বন্ধ করলে তার ব্যবহারকারীরা আর লগইন করতে পারবে না, যতক্ষণ না আপনি আবার চালু করেন।"
        )}
      </p>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}
      {message && <p className="bg-teal-50 text-teal-700 text-sm p-3 rounded-lg mb-4">{message}</p>}
      {loading ? (
        <p className="text-slate-500">{t("loading", "Loading…", "লোড হচ্ছে…")}</p>
      ) : isOwner === false ? (
        <p className="text-slate-500">{t("ownerOnly", "Owner only", "শুধু মালিকের জন্য")}</p>
      ) : (
        <>
          <div className="bg-white rounded-xl shadow overflow-x-auto mb-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b">
                  <th className="p-3">{t("ownerColShop", "Shop", "দোকান")}</th>
                  <th className="p-3">{t("ownerColOwner", "Owner", "মালিক")}</th>
                  <th className="p-3">{t("ownerColPlan", "Plan", "প্ল্যান")}</th>
                  <th className="p-3">{t("ownerColBalance", "Wallet", "ওয়ালেট")}</th>
                  <th className="p-3">{t("ownerColJoined", "Joined", "যোগ দিয়েছে")}</th>
                  <th className="p-3">{t("ownerColStatus", "Status", "অবস্থা")}</th>
                  <th className="p-3">{t("ownerColActions", "Actions", "কাজ")}</th>
                </tr>
              </thead>
              <tbody>
                {shops.map((s) => (
                  <tr key={s.id} className="border-b last:border-0">
                    <td className="p-3 font-bold">{s.name}</td>
                    <td className="p-3">{s.ownerName ?? "—"}<br /><span className="text-xs text-slate-500">{s.ownerEmail ?? ""}</span></td>
                    <td className="p-3">{s.planName ?? "—"}{s.planStatus ? ` (${s.planStatus})` : ""}</td>
                    <td className="p-3">{fmtTaka(s.balancePaisa)}</td>
                    <td className="p-3 whitespace-nowrap">{fmtDate(s.joinedAt)}</td>
                    <td className="p-3">
                      {s.suspended ? (
                        <span className="text-xs font-bold bg-red-50 text-red-700 border border-red-200 rounded-full px-2 py-0.5">{t("ownerSuspended", "Suspended", "বন্ধ")}</span>
                      ) : (
                        <span className="text-xs font-bold bg-teal-600/10 text-teal-600 border border-teal-600/30 rounded-full px-2 py-0.5">{t("ownerActive", "Active", "চালু")}</span>
                      )}
                    </td>
                    <td className="p-3 whitespace-nowrap">
                      <button onClick={() => openDetail(s.id)} className="text-sm text-[#e04e33] underline mr-2">{t("ownerView", "View", "দেখুন")}</button>
                      <button
                        onClick={() => toggleSuspend(s)}
                        disabled={busy === s.id}
                        className="text-sm border border-slate-300 rounded-lg px-2 py-1 disabled:opacity-50"
                      >
                        {s.suspended
                          ? t("ownerActivate", "Activate", "চালু করুন")
                          : t("ownerSuspend", "Suspend", "বন্ধ করুন")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {shops.length === 0 && <p className="text-slate-500">{t("ownerNoShops", "No shops yet.", "এখনো কোনো দোকান নেই।")}</p>}

          {detail && (
            <div className="bg-white rounded-xl shadow p-4">
              <h2 className="font-bold text-lg mb-2">{detail.shop.name}</h2>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-sm mb-4">
                <p>{t("ownerColOwner", "Owner", "মালিক")}: <b>{detail.shop.ownerName ?? "—"}</b><br /><span className="text-slate-500">{detail.shop.ownerEmail ?? ""}</span></p>
                <p>{t("ownerColBalance", "Wallet", "ওয়ালেট")}: <b>{fmtTaka(detail.shop.balancePaisa)}</b></p>
                <p>{t("ownerColOrders", "Orders", "অর্ডার")}: <b>{detail.totals.orders}</b></p>
                <p>{t("ownerColChats", "Chats", "চ্যাট")}: <b>{detail.totals.conversations}</b></p>
                <p>{t("ownerColAiReplies", "AI replies", "AI উত্তর")}: <b>{detail.totals.aiReplies}</b></p>
                <p>{t("ownerColApiCost", "AI cost", "AI খরচ")}: <b>{fmtTaka(detail.totals.apiCostPaisa)}</b></p>
                <p>{t("ownerColJoined", "Joined", "যোগ দিয়েছে")}: <b>{fmtDate(detail.shop.joinedAt)}</b></p>
                <p>{t("ownerColStatus", "Status", "অবস্থা")}: <b>{detail.shop.suspended ? t("ownerSuspended", "Suspended", "বন্ধ") : t("ownerActive", "Active", "চালু")}</b></p>
              </div>
              <h3 className="font-bold mb-2">{t("ownerSubscriptions", "Subscriptions", "সাবস্ক্রিপশন")}</h3>
              {detail.subscriptions.length === 0 ? (
                <p className="text-sm text-slate-500">{t("ownerNoSubs", "No subscription yet.", "এখনো কোনো সাবস্ক্রিপশন নেই।")}</p>
              ) : (
                <ul className="text-sm space-y-1">
                  {detail.subscriptions.map((s, i) => (
                    <li key={i}>{s.planName} — {s.status} — {fmtTaka(s.planPricePaisa)} — {fmtDate(s.periodStart)} → {fmtDate(s.periodEnd)}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
