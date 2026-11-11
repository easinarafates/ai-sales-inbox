"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { getToken } from "@/lib/api";
import { ownerApi, type OwnerWallet, type OwnerCard, type OwnerDeposit } from "@/lib/api-owner";

export default function OwnerWalletPage() {
  const { t, fmtDate, fmtTaka } = useI18n();
  const router = useRouter();
  const [wallet, setWallet] = useState<OwnerWallet | null>(null);
  const [cards, setCards] = useState<OwnerCard[]>([]);
  const [deposits, setDeposits] = useState<OwnerDeposit[]>([]);
  const [isOwner, setIsOwner] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [threshold, setThreshold] = useState("");
  const [depAmount, setDepAmount] = useState("");
  const [depMethod, setDepMethod] = useState("bkash");
  const [depTrx, setDepTrx] = useState("");
  const [depCardId, setDepCardId] = useState("");
  const [cardBrand, setCardBrand] = useState("");
  const [cardLast4, setCardLast4] = useState("");
  const [cardExpMonth, setCardExpMonth] = useState("");
  const [cardExpYear, setCardExpYear] = useState("");

  const load = useCallback(async () => {
    try {
      const me = await ownerApi.me();
      setIsOwner(me.isOwner);
      if (!me.isOwner) return;
      const [w, c, d] = await Promise.all([ownerApi.wallet(), ownerApi.cards(), ownerApi.deposits()]);
      setWallet(w);
      setCards(c.cards);
      setDeposits(d.deposits);
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

  const saveThreshold = async () => {
    setError("");
    setMessage("");
    const paisa = Math.round(Number(threshold) * 100);
    if (!Number.isFinite(paisa) || paisa < 0) {
      setError(t("ownerThresholdError", "Enter a warning amount in Taka (0 or more).", "সতর্কতার টাকার অঙ্ক দিন (০ বা বেশি)।"));
      return;
    }
    setBusy("threshold");
    try {
      const w = await ownerApi.setThreshold(paisa);
      setWallet((prev) => (prev ? { ...prev, lowBalanceThresholdPaisa: w.lowBalanceThresholdPaisa, lowBalance: w.lowBalance } : prev));
      setThreshold("");
      setMessage(t("ownerThresholdSaved", "Warning amount saved.", "সতর্কতার অঙ্ক সেভ হয়েছে।"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ownerThresholdFail", "Could not save the warning amount.", "সতর্কতার অঙ্ক সেভ করা যায়নি।"));
    } finally {
      setBusy("");
    }
  };

  const runSweep = async () => {
    setError("");
    setMessage("");
    setBusy("sweep");
    try {
      const r = await ownerApi.sweep();
      setMessage(
        t("ownerSweepDone", "Auto-deduction ran.", "অটো-কাটা চালানো হয়েছে।") +
          ` ${r.deductedRows} ${t("ownerSweepRows", "replies", "উত্তর")} · ${fmtTaka(r.totalPaisa)}`
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ownerSweepFail", "Could not run the auto-deduction.", "অটো-কাটা চালানো যায়নি।"));
    } finally {
      setBusy("");
    }
  };

  const addCard = async () => {
    setError("");
    setMessage("");
    if (!/^\d{4}$/.test(cardLast4)) {
      setError(t("ownerCardLast4Error", "Last 4 digits must be exactly 4 digits.", "শেষ ৪ সংখ্যা ঠিক ৪ সংখ্যার হতে হবে।"));
      return;
    }
    setBusy("card");
    try {
      await ownerApi.addCard({
        brand: cardBrand,
        last4: cardLast4,
        expMonth: cardExpMonth ? Number(cardExpMonth) : undefined,
        expYear: cardExpYear ? Number(cardExpYear) : undefined,
      });
      setCardBrand("");
      setCardLast4("");
      setCardExpMonth("");
      setCardExpYear("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ownerCardAddFail", "Could not save the card.", "কার্ডটি সেভ করা যায়নি।"));
    } finally {
      setBusy("");
    }
  };

  const removeCard = async (id: string) => {
    if (!window.confirm(t("owner.removeCardConfirm", "Remove this card?", "এই কার্ডটি সরাবেন?"))) return;
    setError("");
    setMessage("");
    setBusy(`card-${id}`);
    try {
      await ownerApi.deleteCard(id);
      setMessage(t("owner.cardRemoved", "Card removed.", "কার্ড সরানো হয়েছে।"));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ownerCardAddFail", "Could not save the card.", "কার্ডটি সেভ করা যায়নি।"));
    } finally {
      setBusy("");
    }
  };

  const setDefaultCard = async (id: string) => {
    setError("");
    setMessage("");
    setBusy(`card-${id}`);
    try {
      await ownerApi.setDefaultCard(id);
      setMessage(t("owner.defaultCardSet", "Primary card set.", "প্রধান কার্ড ঠিক করা হয়েছে।"));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ownerCardAddFail", "Could not save the card.", "কার্ডটি সেভ করা যায়নি।"));
    } finally {
      setBusy("");
    }
  };

  // Owner wallet history types, translated (never show the raw DB value).
  const txTypeLabel = (type: string) =>
    type === "deposit" ? t("ownerTxDeposit", "Deposit", "জমা")
    : type === "topup" ? t("billing.txTopup", "Top-up", "টপ-আপ")
    : type === "ai_cost" ? t("ownerTxAiCost", "AI cost cut", "AI খরচ কাটা")
    : type === "ai_charge" ? t("billing.txAiCharge", "AI reply cost", "AI উত্তরের খরচ")
    : type === "subscription_charge" ? t("billing.txSubscription", "Subscription", "সাবস্ক্রিপশন")
    : type || "—";

  const addDeposit = async () => {
    setError("");
    setMessage("");
    const amountPaisa = Math.round(Number(depAmount) * 100);
    if (!Number.isFinite(amountPaisa) || amountPaisa <= 0) {
      setError(t("ownerDepositAmountError", "Enter a deposit amount in Taka (more than 0).", "জমার টাকার অঙ্ক দিন (০-এর বেশি)।"));
      return;
    }
    setBusy("deposit");
    try {
      const res = await ownerApi.addDeposit({
        amountPaisa,
        method: depMethod,
        transactionId: depMethod === "card" ? undefined : depTrx,
        cardId: depMethod === "card" ? depCardId : undefined,
      });
      setMessage(res.message);
      setDepAmount("");
      setDepTrx("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ownerDepositAddFail", "Could not record the deposit.", "জমাটি লেখা যায়নি।"));
    } finally {
      setBusy("");
    }
  };

  const approveDeposit = async (id: string) => {
    setError("");
    setMessage("");
    setBusy(`approve-${id}`);
    try {
      const res = await ownerApi.approveDeposit(id);
      setMessage(res.message);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ownerDepositApproveFail", "Could not approve the deposit.", "জমাটি অনুমোদন করা যায়নি।"));
    } finally {
      setBusy("");
    }
  };

  const rejectDeposit = async (id: string) => {
    setError("");
    setMessage("");
    setBusy(`reject-${id}`);
    try {
      await ownerApi.rejectDeposit(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ownerDepositRejectFail", "Could not reject the deposit.", "জমাটি বাতিল করা যায়নি।"));
    } finally {
      setBusy("");
    }
  };

  return (
    <div>
      <h1 className="page-title">{t("ownerWalletTitle", "Owner wallet", "ওনার ওয়ালেট")}</h1>
      <p className="page-subtitle">
        {t(
          "ownerWalletSub",
          "Your own money for paying AI providers. AI reply costs are deducted from here automatically. Deposits are requests you approve by hand — no live payment gateway is connected yet, so no real card is charged automatically.",
          "AI প্রোভাইডারদের টাকা দেওয়ার জন্য আপনার নিজের টাকা। AI উত্তরের খরচ এখান থেকে নিজে নিজে কাটা হয়। জমা মানে অনুরোধ — আপনি হাতে যাচাই করে অনুমোদন দেবেন। এখনো কোনো লাইভ পেমেন্ট গেটওয়ে যুক্ত হয়নি, তাই কার্ড থেকে নিজে নিজে টাকা কাটা হবে না।"
        )}
      </p>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}
      {message && <p className="bg-green-50 text-green-700 text-sm p-3 rounded-lg mb-4">{message}</p>}
      {loading ? (
        <div className="space-y-2"><div className="skeleton h-12" /><div className="skeleton h-12" /><div className="skeleton h-12" /></div>
      ) : isOwner === false ? (
        <p className="text-slate-500">{t("ownerOnly", "Owner only", "শুধু মালিকের জন্য")}</p>
      ) : wallet ? (
        <>
          <div className="card p-4 mb-6">
            <p className="text-sm text-slate-500">{t("ownerWalletBalance", "Owner wallet", "ওনার ওয়ালেট")}</p>
            <p className="text-3xl font-bold">{fmtTaka(wallet.balancePaisa)}</p>
            {wallet.lowBalance && (
              <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2 mt-2">
                {t(
                  "ownerLowBalance",
                  "Your owner wallet is low — AI provider costs are deducted from it automatically. Top it up below.",
                  "আপনার ওনার ওয়ালেটে টাকা কম — AI-এর খরচ এখান থেকে নিজে নিজে কাটা হয়। নিচে থেকে টাকা জমা করুন।"
                )}
              </p>
            )}
            <div className="flex gap-2 mt-3 flex-wrap items-center">
              <input
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                placeholder={`${t("ownerLowAt", "Warn below", "কম হলে সতর্ক")} ${fmtTaka(wallet.lowBalanceThresholdPaisa)}`}
                className="border rounded-lg px-3 py-2 text-sm"
                inputMode="decimal"
              />
              <button onClick={saveThreshold} disabled={busy === "threshold" || !threshold.trim()} className="border border-[#0051F6] text-[#003EC9] text-sm rounded-lg px-3 py-2 disabled:opacity-50">
                {t("ownerThresholdSave", "Save warning amount", "সতর্কতার অঙ্ক সেভ করুন")}
              </button>
              <button onClick={runSweep} disabled={busy === "sweep"} className="border border-slate-300 text-sm rounded-lg px-3 py-2 disabled:opacity-50">
                {busy === "sweep" ? t("ownerSweeping", "Running…", "চলছে…") : t("ownerSweepNow", "Deduct AI costs now", "এখনই AI খরচ কাটুন")}
              </button>
            </div>
          </div>

          <div className="card p-4 mb-6">
            <h2 className="font-bold mb-3">{t("ownerDepositTitle", "Deposit money", "টাকা জমা করুন")}</h2>
            <div className="grid gap-2 sm:grid-cols-2">
              <input value={depAmount} onChange={(e) => setDepAmount(e.target.value)} placeholder={t("ownerDepositAmountPh", "Amount in Taka (e.g. 5000)", "টাকার অঙ্ক (যেমন ৫০০০)")} className="border rounded-lg px-3 py-2 text-sm" inputMode="decimal" />
              <select value={depMethod} onChange={(e) => setDepMethod(e.target.value)} className="border rounded-lg px-3 py-2 text-sm" aria-label={t("ownerDepositMethod", "Method", "মাধ্যম")}>
                <option value="bkash">bKash</option>
                <option value="nagad">Nagad</option>
                <option value="bank">{t("ownerBankTypeBank", "Bank", "ব্যাংক")}</option>
                <option value="card">{t("ownerDepositCard", "Card on file", "সেভ করা কার্ড")}</option>
              </select>
              {depMethod === "card" ? (
                <select value={depCardId} onChange={(e) => setDepCardId(e.target.value)} className="border rounded-lg px-3 py-2 text-sm" aria-label={t("ownerDepositCard", "Card on file", "সেভ করা কার্ড")}>
                  <option value="">{t("ownerDepositPickCard", "Pick a card", "কার্ড বেছে নিন")}</option>
                  {cards.map((c) => (
                    <option key={c.id} value={c.id}>{c.masked}</option>
                  ))}
                </select>
              ) : (
                <input value={depTrx} onChange={(e) => setDepTrx(e.target.value)} placeholder={t("ownerDepositTrxPh", "Transaction ID (TrxID)", "লেনদেন আইডি (TrxID)")} className="border rounded-lg px-3 py-2 text-sm" />
              )}
            </div>
            <button
              onClick={addDeposit}
              disabled={busy === "deposit" || !depAmount.trim() || (depMethod === "card" ? !depCardId : !depTrx.trim())}
              className="mt-3 bg-[#0051F6] hover:bg-[#003EC9] text-white text-sm rounded-lg px-4 py-2 disabled:opacity-50"
            >
              {busy === "deposit" ? t("saving", "Saving…", "সেভ হচ্ছে…") : t("ownerDepositBtn", "Record deposit request", "জমার অনুরোধ লিখুন")}
            </button>
            <p className="text-xs text-slate-400 mt-2">
              {t(
                "ownerDepositNote",
                "This only records the request. After you verify the payment, approve it below and the wallet will be credited. Nothing is charged automatically.",
                "এটা শুধু অনুরোধ লেখা হয়। টাকা পেয়েছেন যাচাই করে নিচে অনুমোদন দিলে ওয়ালেটে টাকা যোগ হবে। নিজে নিজে কিছু কাটা হবে না।"
              )}
            </p>
          </div>

          <div className="card p-4 mb-6">
            <h2 className="font-bold mb-3">{t("ownerDepositsTitle", "Deposit requests", "জমার অনুরোধ")}</h2>
            {deposits.length === 0 ? (
              <p className="text-sm text-slate-500">{t("ownerDepositsEmpty", "No deposits yet.", "এখনো কোনো জমা নেই।")}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left border-b">
                      <th className="p-2">{t("ownerColDate", "Date", "তারিখ")}</th>
                      <th className="p-2">{t("ownerColAmount", "Amount", "টাকা")}</th>
                      <th className="p-2">{t("ownerDepositMethod", "Method", "মাধ্যম")}</th>
                      <th className="p-2">{t("ownerColStatus", "Status", "অবস্থা")}</th>
                      <th className="p-2">{t("ownerColActions", "Actions", "কাজ")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {deposits.map((d) => (
                      <tr key={d.id} className="border-b last:border-0">
                        <td className="p-2 whitespace-nowrap">{fmtDate(d.createdAt)}</td>
                        <td className="p-2">{fmtTaka(d.amountPaisa)}</td>
                        <td className="p-2">{d.method}{d.transactionId ? ` · ${d.transactionId}` : ""}</td>
                        <td className="p-2">{d.status}</td>
                        <td className="p-2 whitespace-nowrap">
                          {d.status === "pending" && (
                            <>
                              <button onClick={() => approveDeposit(d.id)} disabled={busy === `approve-${d.id}`} className="text-sm bg-[#0051F6] text-white rounded-lg px-2 py-1 mr-1 disabled:opacity-50">{t("ownerApprove", "Approve", "অনুমোদন")}</button>
                              <button onClick={() => rejectDeposit(d.id)} disabled={busy === `reject-${d.id}`} className="text-sm border border-red-200 text-red-600 rounded-lg px-2 py-1 disabled:opacity-50">{t("ownerReject", "Reject", "বাতিল")}</button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="card p-4 mb-6">
            <h2 className="font-bold mb-3">{t("ownerCardsTitle", "Cards on file", "সেভ করা কার্ড")}</h2>
            <p className="text-xs text-slate-500 mb-3">
              {t(
                "ownerCardsNote",
                "Only the brand and last 4 digits are stored. Full card numbers and CVV are never kept.",
                "শুধু কার্ডের নাম আর শেষ ৪ সংখ্যা রাখা হয়। পুরো কার্ড নম্বর আর CVV কখনো রাখা হয় না।"
              )}
            </p>
            <div className="grid gap-2 sm:grid-cols-4 mb-3">
              <input value={cardBrand} onChange={(e) => setCardBrand(e.target.value)} placeholder={t("ownerCardBrandPh", "Brand (e.g. Visa)", "কার্ডের নাম (যেমন Visa)")} className="border rounded-lg px-3 py-2 text-sm" />
              <input value={cardLast4} onChange={(e) => setCardLast4(e.target.value)} placeholder={t("ownerCardLast4Ph", "Last 4 digits", "শেষ ৪ সংখ্যা")} className="border rounded-lg px-3 py-2 text-sm" inputMode="numeric" maxLength={4} />
              <input value={cardExpMonth} onChange={(e) => setCardExpMonth(e.target.value)} placeholder={t("ownerCardExpMonthPh", "Expiry month (1–12)", "মেয়াদের মাস (১–১২)")} className="border rounded-lg px-3 py-2 text-sm" inputMode="numeric" />
              <input value={cardExpYear} onChange={(e) => setCardExpYear(e.target.value)} placeholder={t("ownerCardExpYearPh", "Expiry year", "মেয়াদের বছর")} className="border rounded-lg px-3 py-2 text-sm" inputMode="numeric" />
            </div>
            <button onClick={addCard} disabled={busy === "card" || !cardBrand.trim() || !cardLast4.trim()} className="bg-[#0051F6] hover:bg-[#003EC9] text-white text-sm rounded-lg px-4 py-2 disabled:opacity-50">
              {busy === "card" ? t("saving", "Saving…", "সেভ হচ্ছে…") : t("ownerCardAddBtn", "Save card", "কার্ড সেভ করুন")}
            </button>
            {cards.length > 0 && (
              <ul className="mt-3 text-sm space-y-1">
                {cards.map((c) => (
                  <li key={c.id} className="flex justify-between gap-2">
                    <span>{c.masked}{c.expMonth && c.expYear ? ` · ${c.expMonth}/${c.expYear}` : ""}{c.isDefault ? ` · ${t("ownerPrimary", "Primary", "প্রধান")}` : ""}</span>
                    <span className="flex gap-2 shrink-0">
                      {!c.isDefault && (
                        <button onClick={() => setDefaultCard(c.id)} disabled={busy === `card-${c.id}`} className="text-green-700 underline disabled:opacity-50">{t("owner.setDefaultCard", "Make primary", "প্রধান করুন")}</button>
                      )}
                      <button onClick={() => removeCard(c.id)} disabled={busy === `card-${c.id}`} className="text-red-700 underline disabled:opacity-50">{t("owner.removeCard", "Remove", "সরান")}</button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card p-4">
            <h2 className="font-bold mb-3">{t("ownerTxTitle", "Wallet history", "ওয়ালেটের হিসাব")}</h2>
            {wallet.transactions.length === 0 ? (
              <p className="text-sm text-slate-500">{t("ownerTxEmpty", "No wallet movements yet.", "এখনো ওয়ালেটে কোনো লেনদেন নেই।")}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left border-b">
                      <th className="p-2">{t("ownerColDate", "Date", "তারিখ")}</th>
                      <th className="p-2">{t("ownerColType", "Type", "ধরন")}</th>
                      <th className="p-2">{t("ownerColAmount", "Amount", "টাকা")}</th>
                      <th className="p-2">{t("ownerColNote", "Note", "মন্তব্য")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wallet.transactions.map((tx) => (
                      <tr key={tx.id} className="border-b last:border-0">
                        <td className="p-2 whitespace-nowrap">{fmtDate(tx.createdAt)}</td>
                        <td className="p-2">{txTypeLabel(tx.type)}{tx.provider ? ` · ${tx.provider}` : ""}</td>
                        <td className={`p-2 ${tx.amountPaisa < 0 ? "text-red-600" : "text-green-600"}`}>
                          {tx.amountPaisa < 0 ? "−" : "+"}{fmtTaka(Math.abs(tx.amountPaisa))}
                        </td>
                        <td className="p-2">
                          {tx.type === "ai_cost" && tx.shopName ? (
                            <>
                              {tx.shopName}{" — "}{t("ownerColShopPaid", "Shop paid", "দোকান দিয়েছে")} {fmtTaka(tx.shopChargePaisa ?? 0)}{", "}
                              {t("ownerColProfit", "Profit", "লাভ")} <span className={(tx.profitPaisa ?? 0) < 0 ? "text-red-600" : "text-green-700"}>{fmtTaka(tx.profitPaisa ?? 0)}</span>
                            </>
                          ) : (tx.note ?? "—")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
