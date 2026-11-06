"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { getToken } from "@/lib/api";
import { websiteChatApi } from "@/lib/api-new-features";

export default function WebsiteChatPage() {
  const { t } = useI18n();
  const router = useRouter();
  const [publicKey, setPublicKey] = useState("");
  const [snippet, setSnippet] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await websiteChatApi.settings();
      setPublicKey(data.publicKey);
      setSnippet(data.snippet);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("chatLoadFail", "Could not load the chat settings.", "চ্যাট সেটিংস লোড করা যায়নি।"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!getToken()) { router.push("/login"); return; }
    load();
  }, [load, router]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(t("chatCopyFail", "Could not copy — copy the snippet by hand.", "কপি করা যায়নি — কোডটি হাতে কপি করুন।"));
    }
  };

  return (
    <div className="bg-[#fff8f3] min-h-screen -m-6 p-6">
      <h1 className="text-2xl font-bold mb-1">{t("chatTitle", "Website chat", "ওয়েবসাইট চ্যাট")}</h1>
      <p className="text-sm text-slate-500 mb-4">{t("chatSub", "Add a chat box to your own website. Visitor messages appear in your inbox.", "আপনার ওয়েবসাইটে একটি চ্যাট বাক্স যোগ করুন। ভিজিটরের মেসেজ আপনার ইনবক্সে আসবে।")}</p>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}
      {loading ? (
        <p className="text-slate-500">{t("loading", "Loading…", "লোড হচ্ছে…")}</p>
      ) : (
        <>
          <div className="bg-white rounded-xl shadow p-4 mb-6">
            <h2 className="font-bold mb-2">{t("chatSnippetTitle", "Copy-paste snippet", "কপি-পেস্ট করার কোড")}</h2>
            <p className="text-sm text-slate-500 mb-3">{t("chatSnippetSub", "Paste this one line before the closing </body> tag of your website.", "আপনার ওয়েবসাইটের </body> ট্যাগের আগে এই এক লাইন বসান।")}</p>
            <pre className="bg-[#fff8f3] border rounded-lg p-3 text-sm break-all whitespace-pre-wrap">{snippet}</pre>
            <button onClick={copy} className="bg-[#ff6a4d] hover:bg-[#e04e33] text-white rounded-lg px-4 py-2 mt-3">
              {copied ? t("copied", "Copied!", "কপি হয়েছে!") : t("copySnippet", "Copy snippet", "কোড কপি করুন")}
            </button>
            <p className="text-xs text-slate-500 mt-3">
              {t("chatKeyNote", "Your public key identifies your shop only. It cannot log in or read any data.", "আপনার পাবলিক কী শুধু আপনার দোকানকে চেনে। এটা দিয়ে লগইন বা কোনো তথ্য পড়া যায় না।")}
            </p>
            <p className="text-xs text-slate-400 mt-1">{t("chatKeyLabel", "Public key:", "পাবলিক কী:")} {publicKey}</p>
          </div>
          <div className="bg-white rounded-xl shadow p-4">
            <h2 className="font-bold mb-2">{t("chatHowTitle", "How it works", "এটা কীভাবে কাজ করে")}</h2>
            <ol className="list-decimal list-inside text-sm text-slate-600 grid gap-1">
              <li>{t("chatHow1", "A visitor opens the chat box on your website and writes a message.", "ভিজিটর আপনার ওয়েবসাইটে চ্যাট বাক্স খুলে মেসেজ লেখে।")}</li>
              <li>{t("chatHow2", "The message appears as a new conversation in your inbox.", "মেসেজটি আপনার ইনবক্সে নতুন চ্যাট হিসেবে আসে।")}</li>
              <li>{t("chatHow3", "You or the AI reply from the inbox, like any other chat.", "অন্য চ্যাটের মতো ইনবক্স থেকেই আপনি বা AI উত্তর দেন।")}</li>
            </ol>
          </div>
        </>
      )}
    </div>
  );
}
