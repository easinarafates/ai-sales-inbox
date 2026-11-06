"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { getToken } from "@/lib/api";
import { teamApi, type TeamInvite, type TeamMember } from "@/lib/api-new-features";

export default function TeamPage() {
  const { t, fmtDate } = useI18n();
  const router = useRouter();
  const [invites, setInvites] = useState<TeamInvite[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [copied, setCopied] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await teamApi.list();
      setInvites(data.invites ?? []);
      setMembers(data.members ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("teamLoadFail", "Could not load the team.", "টিম লোড করা যায়নি।"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!getToken()) { router.push("/login"); return; }
    load();
  }, [load, router]);

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      await teamApi.invite(email.trim(), role);
      setEmail("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("teamInviteFail", "Could not create the invite.", "আমন্ত্রণ তৈরি করা যায়নি।"));
    } finally {
      setSaving(false);
    }
  };

  const copyLink = async (link: string, id: string) => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(id);
      setTimeout(() => setCopied(""), 2000);
    } catch {
      setError(t("teamCopyFail", "Could not copy — copy the link by hand.", "কপি করা যায়নি — লিংকটি হাতে কপি করুন।"));
    }
  };

  return (
    <div className="bg-[#fff8f3] min-h-screen -m-6 p-6">
      <h1 className="text-2xl font-bold mb-1">{t("teamTitle", "Team", "টিম")}</h1>
      <p className="text-sm text-slate-500 mb-4">{t("teamSub", "Invite people to help in your shop. No email is sent — share the invite link yourself.", "দোকানে সাহায্যের জন্য লোকদের আমন্ত্রণ জানান। কোনো ইমেইল পাঠানো হয় না — আমন্ত্রণের লিংকটি নিজে শেয়ার করুন।")}</p>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}

      <form onSubmit={invite} className="card p-4 mb-6 grid gap-3">
        <h2 className="font-bold">{t("teamInviteTitle", "Invite a team member", "টিমের সদস্যকে আমন্ত্রণ জানান")}</h2>
        <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t("teamEmailPh", "Email address", "ইমেইল ঠিকানা")} className="border rounded-lg px-3 py-2" />
        <select value={role} onChange={(e) => setRole(e.target.value)} className="border rounded-lg px-3 py-2 bg-white">
          <option value="member">{t("teamRoleMember", "Member", "সদস্য")}</option>
          <option value="admin">{t("teamRoleAdmin", "Admin", "অ্যাডমিন")}</option>
        </select>
        <button disabled={saving} className="bg-[#ff6a4d] hover:bg-[#e04e33] text-white rounded-lg px-4 py-2 w-fit disabled:opacity-50">
          {saving ? t("teamInviting", "Inviting…", "আমন্ত্রণ জানানো হচ্ছে…") : t("teamInviteBtn", "Create invite", "আমন্ত্রণ তৈরি করুন")}
        </button>
        <p className="text-xs text-slate-500">{t("teamNoEmail", "No email will be sent. The invite link appears below — copy it and send it yourself.", "কোনো ইমেইল পাঠানো হবে না। আমন্ত্রণের লিংক নিচে দেখা যাবে — কপি করে নিজে পাঠান।")}</p>
      </form>

      <h2 className="font-bold mb-3">{t("teamInvites", "Invites", "আমন্ত্রণগুলো")}</h2>
      {loading ? (
        <p className="text-slate-500">{t("loading", "Loading…", "লোড হচ্ছে…")}</p>
      ) : invites.length === 0 ? (
        <p className="text-slate-500 mb-6">{t("teamNoInvites", "No invites yet.", "এখনো কোনো আমন্ত্রণ নেই।")}</p>
      ) : (
        <div className="grid gap-3 mb-6">
          {invites.map((inv) => (
            <div key={inv.id} className="card p-4">
              <div className="flex justify-between gap-2 flex-wrap">
                <span className="font-bold">{inv.email}</span>
                <span className="text-xs bg-[#ff6a4d]/10 text-[#ff6a4d] rounded-full px-2 py-1 h-fit">{inv.status} · {inv.role}</span>
              </div>
              <p className="text-xs text-slate-400 mt-1">{fmtDate(inv.created_at)}</p>
              {inv.inviteLink && (
                <p className="text-sm break-all bg-[#fff8f3] rounded-lg p-2 mt-2">{inv.inviteLink}</p>
              )}
              <div className="flex gap-2 mt-3">
                {inv.inviteLink && inv.status === "pending" && (
                  <button onClick={() => copyLink(inv.inviteLink as string, inv.id)} className="bg-teal-600 hover:bg-teal-700 text-white text-sm rounded-lg px-3 py-1">
                    {copied === inv.id ? t("copied", "Copied!", "কপি হয়েছে!") : t("copyLink", "Copy link", "লিংক কপি করুন")}
                  </button>
                )}
                {inv.status === "pending" && (
                  <button
                    onClick={async () => { try { await teamApi.revoke(inv.id); await load(); } catch (err) { setError(err instanceof Error ? err.message : t("teamRevokeFail", "Could not revoke the invite.", "আমন্ত্রণ বাতিল করা যায়নি।")); } }}
                    className="text-sm border border-red-200 text-red-600 rounded-lg px-3 py-1"
                  >
                    {t("teamRevoke", "Revoke", "বাতিল করুন")}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <h2 className="font-bold mb-3">{t("teamMembers", "Members", "সদস্যরা")}</h2>
      {members.length === 0 ? (
        <p className="text-slate-500">{t("teamNoMembers", "No members yet.", "এখনো কোনো সদস্য নেই।")}</p>
      ) : (
        <div className="grid gap-3">
          {members.map((m) => (
            <div key={m.id} className="card p-4 flex justify-between gap-2 flex-wrap">
              <span className="font-bold">{m.name ?? m.email ?? m.user_id}</span>
              <span className="text-sm text-slate-500">{m.email} · {m.role}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
