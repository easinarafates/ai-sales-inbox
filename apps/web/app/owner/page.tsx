"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useI18n, formatTakaLocale } from "@/lib/i18n";
import { api, getToken } from "@/lib/api";
import { ownerApi, type OwnerOverview } from "@/lib/api-owner";

type ManageUserStatus = "active" | "blocked" | "restricted" | "deleted";
interface ManageUser {
  id: string;
  email: string;
  name: string | null;
  workspaceId: string;
  workspaceName: string;
  role: string;
  isOwner: boolean;
  status: ManageUserStatus;
  createdAt: string;
}
interface OwnerSubscriptionRow {
  id: string;
  kind: "plan" | "schedule";
  workspaceId: string;
  workspaceName: string;
  planName: string;
  pricePaisa: number;
  status: string;
  effectiveStatus: string;
  periodStart: string;
  periodEnd: string;
  createdAt: string;
}
interface PendingTopupRow {
  id: string;
  workspaceId: string;
  workspaceName: string;
  amountPaisa: number;
  method: string;
  transactionId: string;
  status: string;
  requestedByEmail: string | null;
  createdAt: string;
  purpose?: { kind: string; slug?: string; replies?: number } | null;
}

function purposeLabel(p?: { kind: string; slug?: string; replies?: number } | null): string {
  if (!p) return "ওয়ালেট টপ-আপ";
  if (p.kind === "schedule") {
    const slug = p.slug ?? "";
    if (slug.includes("yearly")) return slug.includes("usd") ? "শিডিউল — Premium (বছর, Intl)" : "শিডিউল — Premium (বছর)";
    return slug.includes("usd") ? "শিডিউল — Pro (মাস, Intl)" : "শিডিউল — Pro (মাস)";
  }
  if (p.kind === "package") return `রিপ্লাই প্যাকেজ — ${p.replies ?? "?"}টি`;
  return "ওয়ালেট টপ-আপ";
}
interface AuditRow {
  id: string;
  actorEmail: string;
  targetEmail: string | null;
  action: string;
  detail: string | null;
  createdAt: string;
}

const USER_STATUS_BN: Record<ManageUserStatus, string> = {
  active: "চালু",
  blocked: "ব্লক",
  restricted: "সীমিত",
  deleted: "মোছা হয়েছে",
};

export default function OwnerDashboardPage() {
  const { t, fmtDate, fmtTaka, fmtNum, lang } = useI18n();
  const router = useRouter();
  const [data, setData] = useState<OwnerOverview | null>(null);
  const [isOwner, setIsOwner] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState<7 | 30>(30);

  // ---- Feature 5: user + subscription management ----
  const [users, setUsers] = useState<ManageUser[]>([]);
  const [subs, setSubs] = useState<OwnerSubscriptionRow[]>([]);
  const [pendingTopups, setPendingTopups] = useState<PendingTopupRow[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [manageMsg, setManageMsg] = useState("");
  const [manageLoading, setManageLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ManageUser | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState("");

  const loadManage = useCallback(async () => {
    setManageLoading(true);
    try {
      const [u, s, a] = await Promise.all([
        api.get<{ users: ManageUser[] }>("/api/owner/users"),
        api.get<{ subscriptions: OwnerSubscriptionRow[]; pendingTopups: PendingTopupRow[] }>("/api/owner/subscriptions"),
        api.get<{ auditLog: AuditRow[] }>("/api/owner/audit-log"),
      ]);
      setUsers(u.users ?? []);
      setSubs(s.subscriptions ?? []);
      setPendingTopups(s.pendingTopups ?? []);
      setAudit((a.auditLog ?? []).slice(0, 10));
    } catch (err) {
      setManageMsg(err instanceof Error ? err.message : "ব্যবহারকারী / সাবস্ক্রিপশন লোড করা যায়নি।");
    } finally {
      setManageLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOwner) loadManage();
  }, [isOwner, loadManage]);

  async function userAction(u: ManageUser, action: "block" | "unblock" | "restrict" | "unrestrict") {
    const labels: Record<typeof action, string> = {
      block: `“${u.email}” অ্যাকাউন্টটি ব্লক করবেন? ব্লক করলে এই অ্যাকাউন্ট দিয়ে আর লগইন করা যাবে না।`,
      unblock: `“${u.email}” অ্যাকাউন্টের ব্লক তুলে নেবেন?`,
      restrict: `“${u.email}” অ্যাকাউন্টটি সীমিত করবেন? সীমিত করলে লগইন করা যাবে, কিন্তু AI উত্তর আর পোস্ট শিডিউল বন্ধ থাকবে (শুধু পড়া যাবে)।`,
      unrestrict: `“${u.email}” অ্যাকাউন্টের সীমা তুলে নেবেন? AI উত্তর আর পোস্ট শিডিউল আবার চালু হবে।`,
    };
    if (!window.confirm(labels[action])) return;
    setManageMsg("");
    try {
      const res = await api.post<{ user: ManageUser; message: string }>(`/api/owner/users/${u.id}/${action}`, {});
      setManageMsg(res.message || "হয়ে গেছে।");
      await loadManage();
    } catch (err) {
      setManageMsg(err instanceof Error ? err.message : "কাজটি করা যায়নি।");
    }
  }

  async function deleteUser() {
    if (!deleteTarget) return;
    setManageMsg("");
    try {
      const res = await api.post<{ user: ManageUser; message: string }>(`/api/owner/users/${deleteTarget.id}/delete`, { confirm: deleteConfirm });
      setManageMsg(res.message || "অ্যাকাউন্ট মুছে ফেলা হয়েছে।");
      setDeleteTarget(null);
      setDeleteConfirm("");
      await loadManage();
    } catch (err) {
      setManageMsg(err instanceof Error ? err.message : "অ্যাকাউন্ট মোছা যায়নি।");
    }
  }

  async function subAction(s: OwnerSubscriptionRow, action: "approve" | "cancel") {
    if (action === "approve") {
      if (!window.confirm(`“${s.workspaceName}”-এর “${s.planName}” সাবস্ক্রিপশনটি অনুমোদন করবেন? এটি আবার চালু (active) হয়ে যাবে।`)) return;
    } else {
      const end = s.periodEnd ? s.periodEnd.slice(0, 10) : "";
      if (!window.confirm(`“${s.workspaceName}”-এর “${s.planName}” সাবস্ক্রিপশনটি বাতিল করবেন? বাতিল হলেও মেয়াদ শেষ (${end}) পর্যন্ত চালু থাকবে — এখনই বন্ধ হবে না।`)) return;
    }
    setManageMsg("");
    try {
      const res = await api.post<{ subscription: OwnerSubscriptionRow; message: string }>(
        `/api/owner/subscriptions/${s.id}/${action}`,
        { kind: s.kind }
      );
      setManageMsg(res.message || "হয়ে গেছে।");
      await loadManage();
    } catch (err) {
      setManageMsg(err instanceof Error ? err.message : "কাজটি করা যায়নি।");
    }
  }

  async function approveTopup(tp: PendingTopupRow) {
    if (!window.confirm(`“${tp.workspaceName}”-এর ${fmtTaka(tp.amountPaisa)} (${purposeLabel(tp.purpose)} — ${tp.method}, TrxID ${tp.transactionId}) অনুমোদন করবেন? অনুমোদন করলে ওয়ালেটে টাকা যোগ হবে, আর প্যাকেজ/সাবস্ক্রিপশন হলে সেটা সাথে সাথে চালু হবে।`)) return;
    setManageMsg("");
    try {
      const res = await api.post<{ topupRequest: unknown; message: string; delivery?: { ok: boolean; message: string } | null }>(`/api/billing/topup/${tp.id}/approve`, { workspaceId: tp.workspaceId });
      setManageMsg(res.delivery?.message ? `${res.message} ${res.delivery.message}` : (res.message || "টপ-আপ অনুমোদন করা হয়েছে।"));
      await loadManage();
    } catch (err) {
      setManageMsg(err instanceof Error ? err.message : "টপ-আপ অনুমোদন করা যায়নি।");
    }
  }

  const load = useCallback(async () => {
    try {
      const me = await ownerApi.me();
      setIsOwner(me.isOwner);
      if (!me.isOwner) return;
      const d = await ownerApi.overview(days);
      setData(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ownerLoadFail", "Could not load the Owner Panel.", "ওনার প্যানেল লোড করা যায়নি।"));
    } finally {
      setLoading(false);
    }
  }, [days, t]);

  useEffect(() => {
    if (!getToken()) { router.push("/login"); return; }
    load();
  }, [load, router]);

  const card = "card p-4";
  const cardTitle = "text-sm text-slate-500";
  const cardValue = "text-2xl font-bold mt-1";

  // Recent cost cuts table ONLY: money always as "৳X.XX" with Western
  // digits, in both languages (the locale-aware fmtTaka renders Bengali
  // digits such as "৳০.১৬" in the Bengali UI, which reads like paisa).
  const fmtTakaWest = (paisa: number | null | undefined) => formatTakaLocale(paisa, "en");
  // Token display for one deduction row: "ইন ৩,৬১৫ · আউট ৪৪" (bn) /
  // "3,615 in · 44 out" (en). No token data at all → "—", never invented;
  // one side missing → "—" for that side only.
  const tokenText = (d: { inputTokens: number | null; outputTokens: number | null }) => {
    if (d.inputTokens == null && d.outputTokens == null) return "—";
    const inStr = d.inputTokens == null ? "—" : fmtNum(d.inputTokens);
    const outStr = d.outputTokens == null ? "—" : fmtNum(d.outputTokens);
    const inLabel = t("ownerTokensIn", "in", "ইন");
    const outLabel = t("ownerTokensOut", "out", "আউট");
    return lang === "bn"
      ? `${inLabel} ${inStr} · ${outLabel} ${outStr}`
      : `${inStr} ${inLabel} · ${outStr} ${outLabel}`;
  };

  return (
    <div>
      <h1 className="page-title">{t("ownerTitle", "Owner Panel", "ওনার প্যানেল")}</h1>
      <p className="page-subtitle">
        {t(
          "ownerSub",
          "Your whole business in one place — shops, subscriptions, money in, AI costs, and your wallet.",
          "আপনার পুরো ব্যবসা এক জায়গায় — দোকান, সাবস্ক্রিপশন, আয়, AI-এর খরচ আর আপনার ওয়ালেট।"
        )}
      </p>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}
      {loading ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          <div className="skeleton h-24" />
          <div className="skeleton h-24" />
          <div className="skeleton h-24" />
        </div>
      ) : isOwner === false ? (
        <div className="card p-6">
          <p className="font-bold text-lg">{t("ownerOnly", "Owner only", "শুধু মালিকের জন্য")}</p>
          <p className="text-sm text-slate-500 mt-1">
            {t(
              "ownerOnlyText",
              "This page is only for the platform owner. Shop owners see only their own shop.",
              "এই পেজ শুধু প্ল্যাটফর্মের মালিকের জন্য। দোকানের মালিকরা শুধু নিজের দোকান দেখতে পায়।"
            )}
          </p>
        </div>
      ) : data ? (
        <>
          {data.ownerWallet.lowBalance && (
            <p className="bg-amber-50 text-amber-700 border border-amber-300 text-sm p-3 rounded-lg mb-4">
              {t(
                "ownerLowBalance",
                "Your owner wallet is low — AI provider costs are deducted from it automatically. Top it up from the Wallet page.",
                "আপনার ওনার ওয়ালেটে টাকা কম — AI-এর খরচ এখান থেকে নিজে নিজে কাটা হয়। Wallet পেজ থেকে টাকা জমা করুন।"
              )}
            </p>
          )}
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
            <div className={card}>
              <p className={cardTitle}>{t("ownerShops", "Shops", "দোকান")}</p>
              <p className={cardValue}>{fmtNum(data.shops.total)}</p>
              <p className="text-xs text-slate-500">{fmtNum(data.shops.active)} {t("ownerShopsActive", "active", "চালু")}</p>
            </div>
            <div className={card}>
              <p className={cardTitle}>{t("ownerActiveSubs", "Active subscriptions", "চালু সাবস্ক্রিপশন")}</p>
              <p className={cardValue}>{fmtNum(data.activeSubscriptions)}</p>
              <p className="text-xs text-slate-500">
                {t("ownerExpectedMrr", "Expected / month", "প্রতি মাসে আশা")} {fmtTaka(data.expectedMonthlyRevenuePaisa)}
              </p>
            </div>
            <div className={card}>
              <p className={cardTitle}>{t("ownerRevenueMonth", "Revenue this month", "এই মাসের আয়")}</p>
              <p className={cardValue}>{fmtTaka(data.revenueThisMonthPaisa)}</p>
              <p className="text-xs text-slate-500">{fmtNum(data.revenueThisMonthCharges)} {t("ownerPayments", "payments", "পেমেন্ট")}</p>
            </div>
            <div className={card}>
              <p className={cardTitle}>{t("ownerApiSpendMonth", "AI cost this month", "এই মাসে AI-এর খরচ")}</p>
              <p className={cardValue}>{fmtTaka(data.apiSpendThisMonthPaisa)}</p>
              <p className="text-xs text-slate-500">
                {t("ownerApiSpendTotal", "All time", "সব মিলিয়ে")} {fmtTaka(data.apiSpendTotalPaisa)}
              </p>
            </div>
            <div className={card}>
              <p className={cardTitle}>{t("ownerWalletBalance", "Owner wallet", "ওনার ওয়ালেট")}</p>
              <p className={cardValue}>{fmtTaka(data.ownerWallet.balancePaisa)}</p>
              <p className="text-xs text-slate-500">
                {t("ownerLowAt", "Warn below", "কম হলে সতর্ক")} {fmtTaka(data.ownerWallet.lowBalanceThresholdPaisa)}
              </p>
            </div>
            <div className={card}>
              <p className={cardTitle}>{t("ownerProfitMonth", "Revenue − AI cost (this month)", "আয় − AI খরচ (এই মাসে)")}</p>
              <p className={cardValue}>{fmtTaka(data.revenueThisMonthPaisa - data.apiSpendThisMonthPaisa)}</p>
              <p className="text-xs text-slate-500">{t("ownerProfitNote", "Before hosting and other expenses.", "হোস্টিং ও অন্যান্য খরচের আগের হিসাব।")}</p>
            </div>
          </div>

          <div className="flex gap-2 mb-4">
            <Link href="/owner/shops" className="bg-brand hover:bg-brand-dark text-white text-sm rounded-lg px-3 py-2 shadow-sm transition">{t("ownerShops", "Shops", "দোকান")}</Link>
            <Link href="/owner/bank-accounts" className="border border-brand bg-white text-brand-dark text-sm rounded-lg px-3 py-2 shadow-sm transition hover:bg-orange-50">{t("ownerBankAccounts", "Bank accounts", "ব্যাংক অ্যাকাউন্ট")}</Link>
            <Link href="/owner/expenses" className="border border-brand bg-white text-brand-dark text-sm rounded-lg px-3 py-2 shadow-sm transition hover:bg-orange-50">{t("ownerExpenses", "Expenses", "খরচ")}</Link>
            <Link href="/owner/api-costs" className="border border-brand bg-white text-brand-dark text-sm rounded-lg px-3 py-2 shadow-sm transition hover:bg-orange-50">{t("ownerApiCosts", "API costs", "API খরচ")}</Link>
            <Link href="/owner/wallet" className="border border-brand bg-white text-brand-dark text-sm rounded-lg px-3 py-2 shadow-sm transition hover:bg-orange-50">{t("ownerWallet", "Wallet", "ওয়ালেট")}</Link>
          </div>

          <div className="flex gap-2 mb-3">
            <button onClick={() => setDays(7)} className={`text-sm rounded-lg px-3 py-1 border transition ${days === 7 ? "bg-brand text-white border-brand" : "border-slate-300 bg-white hover:bg-orange-50"}`}>7 {t("ownerDays", "days", "দিন")}</button>
            <button onClick={() => setDays(30)} className={`text-sm rounded-lg px-3 py-1 border transition ${days === 30 ? "bg-brand text-white border-brand" : "border-slate-300 bg-white hover:bg-orange-50"}`}>30 {t("ownerDays", "days", "দিন")}</button>
          </div>
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="table-head text-left border-b">
                  <th className="p-3">{t("ownerColDate", "Date", "তারিখ")}</th>
                  <th className="p-3">{t("ownerColRevenue", "Revenue", "আয়")}</th>
                  <th className="p-3">{t("ownerColApiCost", "AI cost", "AI খরচ")}</th>
                  <th className="p-3">{t("ownerColNet", "Net", "নিট")}</th>
                </tr>
              </thead>
              <tbody>
                {data.trend.map((row) => (
                  <tr key={row.date} className="border-b last:border-0 transition-colors hover:bg-orange-50">
                    <td className="p-3 whitespace-nowrap">{fmtDate(row.date)}</td>
                    <td className="p-3">{fmtTaka(row.revenuePaisa)}</td>
                    <td className="p-3">{fmtTaka(row.apiCostPaisa)}</td>
                    <td className="p-3">{fmtTaka(row.revenuePaisa - row.apiCostPaisa)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-400 mt-3">
            {t(
              "ownerRevenueNote",
              "Revenue counts real subscription payments (money shops paid from their wallets). AI cost is what the AI providers really charged, from the usage ledger.",
              "আয় মানে দোকানগুলো সত্যিকারে যে সাবস্ক্রিপশনের টাকা দিয়েছে। AI খরচ মানে AI প্রোভাইডাররা আসলে যা নিয়েছে, হিসাবের খাতা থেকে নেওয়া।"
            )}
          </p>

          {(data.recentDeductions ?? []).length > 0 && (
            <>
              <h2 className="font-bold text-lg mt-8 mb-2">{t("ownerRecentDeductions", "Recent cost cuts — your money going out", "সাম্প্রতিক খরচ কাটা — আপনার টাকা যাচ্ছে")}</h2>
              <p className="text-sm text-slate-600 mb-3">
                {t(
                  "ownerDeductionNote",
                  "Every time a shop's credit is cut for an AI reply, your owner wallet is cut by the reply's AI cost at the same time. The cost is counted at the standard API rate — even while the provider's free tier charges ৳0, this is the money leaving your side, so the real cost is never hidden.",
                  "দোকানের ক্রেডিট কাটলেই সাথে সাথে আপনার ওনার ওয়ালেট থেকেও সেই রিপ্লাইয়ের AI খরচ কাটে। খরচটা স্ট্যান্ডার্ড API রেটে ধরা হয় — ফ্রি টিয়ারে প্রোভাইডার ৳০ নিলেও আপনার দিক থেকে এই টাকাটাই যাচ্ছে, যাতে আসল খরচ কখনো লুকানো না থাকে।"
                )}
              </p>
              <div className="card overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="table-head text-left border-b">
                      <th className="p-3">{t("ownerColDate", "Date", "তারিখ")}</th>
                      <th className="p-3">{t("ownerColShop", "Shop", "দোকান")}</th>
                      <th className="p-3">{t("ownerColShopPaid", "Shop paid", "দোকান দিয়েছে")}</th>
                      <th className="p-3">{t("ownerColYourCost", "Your cost cut", "আপনার খরচ কাটা")}</th>
                      <th className="p-3">{t("ownerColProfit", "Profit", "লাভ")}</th>
                      <th className="p-3">{t("ownerColTokens", "Tokens", "টোকেন")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.recentDeductions ?? []).map((d) => (
                      <tr key={d.id} className="border-b last:border-0 transition-colors hover:bg-orange-50">
                        <td className="p-3 whitespace-nowrap">{fmtDate(d.createdAt)}</td>
                        <td className="p-3">{d.shopName}{d.provider ? ` · ${d.provider}` : ""}</td>
                        <td className="p-3">{fmtTakaWest(d.shopChargePaisa)}</td>
                        <td className="p-3 text-red-600">−{fmtTakaWest(d.ownerCostPaisa)}</td>
                        <td className={`p-3 ${d.profitPaisa < 0 ? "text-red-600" : "text-green-700"}`}>{fmtTakaWest(d.profitPaisa)}</td>
                        <td className="p-3 whitespace-nowrap">{tokenText(d)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* ---- Feature 5: user management ---- */}
          <h2 className="font-bold text-lg mt-8 mb-2">{t("ownerUsers", "Users", "ব্যবহারকারী")}</h2>
          <p className="text-sm text-slate-600 mb-3">
            সব অ্যাকাউন্ট — ব্লক করলে লগইন বন্ধ, সীমিত করলে লগইন চালু থাকবে কিন্তু AI উত্তর আর পোস্ট শিডিউল বন্ধ থাকবে, মোছা মানে সফট ডিলিট (ডেটা থাকে, লগইন বন্ধ)।
          </p>
          {manageMsg && <p className="bg-blue-50 text-blue-800 text-sm p-3 rounded-lg mb-3">{manageMsg}</p>}
          {manageLoading ? (
            <div className="skeleton h-24" />
          ) : (
            <div className="card overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="table-head text-left border-b">
                    <th className="p-3">নাম</th>
                    <th className="p-3">ইমেইল</th>
                    <th className="p-3">দোকান</th>
                    <th className="p-3">যোগদান</th>
                    <th className="p-3">অবস্থা</th>
                    <th className="p-3">কাজ</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id} className="border-b last:border-0 transition-colors hover:bg-orange-50">
                      <td className="p-3">{u.name ?? "—"}{u.isOwner ? " 👑" : ""}</td>
                      <td className="p-3">{u.email}</td>
                      <td className="p-3">{u.workspaceName}</td>
                      <td className="p-3 whitespace-nowrap">{fmtDate(u.createdAt)}</td>
                      <td className="p-3">
                        <span className={`text-xs font-bold rounded-full px-2 py-1 ${u.status === "active" ? "bg-green-100 text-green-800" : u.status === "blocked" ? "bg-red-100 text-red-800" : u.status === "restricted" ? "bg-amber-100 text-amber-800" : "bg-slate-200 text-slate-700"}`}>
                          {USER_STATUS_BN[u.status]}
                        </span>
                      </td>
                      <td className="p-3 whitespace-nowrap">
                        {!u.isOwner && u.status !== "deleted" && (
                          <>
                            {u.status === "blocked" ? (
                              <button onClick={() => userAction(u, "unblock")} className="text-xs bg-green-600 text-white rounded px-2 py-1 mr-1">আনব্লক</button>
                            ) : u.status === "restricted" ? (
                              <button onClick={() => userAction(u, "unrestrict")} className="text-xs bg-green-600 text-white rounded px-2 py-1 mr-1">সীমা তুলুন</button>
                            ) : (
                              <>
                                <button onClick={() => userAction(u, "block")} className="text-xs bg-red-600 text-white rounded px-2 py-1 mr-1">ব্লক</button>
                                <button onClick={() => userAction(u, "restrict")} className="text-xs bg-amber-600 text-white rounded px-2 py-1 mr-1">সীমিত</button>
                              </>
                            )}
                            <button onClick={() => { setDeleteTarget(u); setDeleteConfirm(""); }} className="text-xs border border-red-300 text-red-700 rounded px-2 py-1">মুছুন</button>
                          </>
                        )}
                        {u.isOwner && <span className="text-xs text-slate-400">মালিকের অ্যাকাউন্ট</span>}
                      </td>
                    </tr>
                  ))}
                  {users.length === 0 && (
                    <tr><td className="p-3 text-slate-500" colSpan={6}>কোনো ব্যবহারকারী পাওয়া যায়নি।</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
          {deleteTarget && (
            <div className="card p-4 mt-3 border-red-300">
              <p className="font-bold text-red-700">“{deleteTarget.email}” অ্যাকাউন্টটি মুছে ফেলবেন?</p>
              <p className="text-sm text-slate-600 mt-1">এটি সফট ডিলিট — ডেটা থেকে যাবে, কিন্তু এই অ্যাকাউন্ট দিয়ে আর লগইন করা যাবে না। নিশ্চিত করতে নিচে অ্যাকাউন্টের ইমেইলটি হুবহু টাইপ করুন (অথবা DELETE লিখুন)।</p>
              <div className="flex gap-2 mt-3">
                <input
                  value={deleteConfirm}
                  onChange={(e) => setDeleteConfirm(e.target.value)}
                  placeholder={deleteTarget.email}
                  className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm"
                />
                <button onClick={deleteUser} className="bg-red-600 text-white text-sm rounded-lg px-3 py-2">মুছে ফেলুন</button>
                <button onClick={() => { setDeleteTarget(null); setDeleteConfirm(""); }} className="border border-slate-300 text-sm rounded-lg px-3 py-2">বাতিল</button>
              </div>
            </div>
          )}

          {/* ---- Feature 5: subscription management ---- */}
          <h2 className="font-bold text-lg mt-8 mb-2">{t("ownerSubscriptions", "Subscriptions", "সাবস্ক্রিপশন")}</h2>
          <p className="text-sm text-slate-600 mb-3">
            সব দোকানের সাবস্ক্রিপশন। বাতিল করলে মেয়াদ শেষ পর্যন্ত চালু থাকবে — এখনই বন্ধ হবে না। বকেয়া (past_due) সাবস্ক্রিপশন অনুমোদন করলে আবার চালু হয়ে যাবে।
          </p>
          {manageLoading ? (
            <div className="skeleton h-24" />
          ) : (
            <div className="card overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="table-head text-left border-b">
                    <th className="p-3">দোকান</th>
                    <th className="p-3">প্ল্যান</th>
                    <th className="p-3">দাম</th>
                    <th className="p-3">অবস্থা</th>
                    <th className="p-3">মেয়াদ শেষ</th>
                    <th className="p-3">কাজ</th>
                  </tr>
                </thead>
                <tbody>
                  {subs.map((s) => (
                    <tr key={`${s.kind}-${s.id}`} className="border-b last:border-0 transition-colors hover:bg-orange-50">
                      <td className="p-3">{s.workspaceName}</td>
                      <td className="p-3">{s.planName}{s.kind === "schedule" ? "" : " (পুরনো প্ল্যান)"}</td>
                      <td className="p-3">{fmtTaka(s.pricePaisa)}</td>
                      <td className="p-3">{s.effectiveStatus === "active" ? "চালু" : s.effectiveStatus === "trial" ? "ট্রায়াল" : s.effectiveStatus === "past_due" ? "বকেয়া" : s.effectiveStatus === "cancelled" ? "বাতিল (মেয়াদ পর্যন্ত চালু)" : s.effectiveStatus === "expired" ? "মেয়াদোত্তীর্ণ" : s.effectiveStatus}</td>
                      <td className="p-3 whitespace-nowrap">{fmtDate(s.periodEnd)}</td>
                      <td className="p-3 whitespace-nowrap">
                        {s.status === "past_due" && (
                          <button onClick={() => subAction(s, "approve")} className="text-xs bg-green-600 text-white rounded px-2 py-1 mr-1">অনুমোদন</button>
                        )}
                        {(s.status === "active" || s.status === "trial") && s.effectiveStatus !== "expired" && (
                          <button onClick={() => subAction(s, "cancel")} className="text-xs bg-red-600 text-white rounded px-2 py-1">বাতিল</button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {subs.length === 0 && (
                    <tr><td className="p-3 text-slate-500" colSpan={6}>কোনো সাবস্ক্রিপশন পাওয়া যায়নি।</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {pendingTopups.length > 0 && (
            <>
              <h3 className="font-bold mt-6 mb-2">অনুমোদনের অপেক্ষায় টপ-আপ</h3>
              <p className="text-sm text-slate-600 mb-3">দোকানগুলো হাতে টাকা পাঠিয়ে TrxID জমা দিয়েছে — অনুমোদন করলে ওয়ালেটে টাকা যোগ হবে।</p>
              <div className="card overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="table-head text-left border-b">
                      <th className="p-3">দোকান</th>
                      <th className="p-3">কী জন্য</th>
                      <th className="p-3">টাকা</th>
                      <th className="p-3">মাধ্যম</th>
                      <th className="p-3">TrxID</th>
                      <th className="p-3">জমা দিয়েছে</th>
                      <th className="p-3">কাজ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pendingTopups.map((tp) => (
                      <tr key={tp.id} className="border-b last:border-0 transition-colors hover:bg-orange-50">
                        <td className="p-3">{tp.workspaceName}</td>
                        <td className="p-3">{purposeLabel(tp.purpose)}</td>
                        <td className="p-3">{fmtTaka(tp.amountPaisa)}</td>
                        <td className="p-3">{tp.method}</td>
                        <td className="p-3">{tp.transactionId}</td>
                        <td className="p-3">{tp.requestedByEmail ?? "—"}</td>
                        <td className="p-3">
                          <button onClick={() => approveTopup(tp)} className="text-xs bg-green-600 text-white rounded px-2 py-1">অনুমোদন</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {audit.length > 0 && (
            <>
              <h3 className="font-bold mt-6 mb-2">সাম্প্রতিক কাজ (অডিট)</h3>
              <div className="card overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="table-head text-left border-b">
                      <th className="p-3">তারিখ</th>
                      <th className="p-3">কে করেছে</th>
                      <th className="p-3">কাজ</th>
                      <th className="p-3">বিস্তারিত</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.map((a) => (
                      <tr key={a.id} className="border-b last:border-0">
                        <td className="p-3 whitespace-nowrap">{fmtDate(a.createdAt)}</td>
                        <td className="p-3">{a.actorEmail}</td>
                        <td className="p-3">{a.action}{a.targetEmail ? ` → ${a.targetEmail}` : ""}</td>
                        <td className="p-3">{a.detail ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      ) : null}
    </div>
  );
}
