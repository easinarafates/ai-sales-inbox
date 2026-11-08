"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { publicInvoiceApi, type PublicInvoice } from "@/lib/api";
import { formatTaka } from "@/lib/api";
import { orderStatusLabel } from "@/lib/orderStatus";

/**
 * Public invoice page — the link the customer clicks to view their order.
 * NO login (the token in the URL is the auth). Renders in Bengali: this is
 * the customer's receipt (order number, items, charges, payment method,
 * delivery estimate). A Print button lets the customer print / save it.
 */
export default function InvoicePage() {
  const params = useParams();
  const token = params.token as string;
  const [inv, setInv] = useState<PublicInvoice | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) return;
    publicInvoiceApi.get(token)
      .then(setInv)
      .catch(() => setError("এই ইনভয়েসটি পাওয়া যায়নি — লিংকটি ঠিক আছে কি না দেখুন।"))
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) return <main className="min-h-screen flex items-center justify-center"><p className="text-slate-500">লোড হচ্ছে…</p></main>;
  if (error || !inv) {
    return (
      <main className="min-h-screen flex items-center justify-center p-6">
        <div className="card p-6 max-w-md text-center">
          <p className="text-red-700">{error || "ইনভয়েস পাওয়া যায়নি।"}</p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#f7f5f3] p-4 sm:p-8 print:bg-white print:p-0">
      <div className="max-w-xl mx-auto bg-white rounded-2xl shadow-sm border border-[#eeeeee] p-6 sm:p-8 print:shadow-none print:border-0 print:rounded-none">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-[#FF5B2E]">{inv.shopName}</h1>
            <p className="text-sm text-slate-500 mt-1">ইনভয়েস / রসিদ</p>
          </div>
          <span className="text-xs px-2 py-1 rounded bg-green-100 text-green-800">অর্ডার কনফার্ম করা হয়েছে ✅</span>
        </div>

        <div className="mt-6 space-y-1 text-sm">
          <p><span className="text-slate-500">অর্ডার নম্বর:</span> <b>{inv.orderNumber || "—"}</b></p>
          <p><span className="text-slate-500">তারিখ:</span> {new Date(inv.createdAt).toLocaleString("bn-BD", { timeZone: "Asia/Dhaka" })}</p>
          <p><span className="text-slate-500">স্ট্যাটাস:</span> {orderStatusLabel(inv.status, "bn")}</p>
        </div>

        <div className="mt-6 border-t pt-4 space-y-1 text-sm">
          <p><span className="text-slate-500">নাম:</span> {inv.customerName || "—"}</p>
          <p><span className="text-slate-500">ফোন:</span> {inv.customerPhone || "—"}</p>
          <p><span className="text-slate-500">ডেলিভারি ঠিকানা:</span> {inv.deliveryAddress || "—"}</p>
          <p><span className="text-slate-500">জোন:</span> {inv.zone}{inv.insideDhaka ? " (ঢাকার ভেতরে)" : " (ঢাকার বাইরে)"}</p>
        </div>

        <table className="w-full text-sm mt-6">
          <thead><tr className="border-b text-left text-slate-500"><th className="py-2">আইটেম</th><th className="py-2 text-right">পরিমাণ</th><th className="py-2 text-right">দাম</th><th className="py-2 text-right">মোট</th></tr></thead>
          <tbody>
            {inv.items.map((it, i) => (
              <tr key={i} className="border-b">
                <td className="py-2">{it.name}</td>
                <td className="py-2 text-right">{it.quantity}</td>
                <td className="py-2 text-right">{formatTaka(it.pricePaisa)}</td>
                <td className="py-2 text-right">{formatTaka(it.lineTotalPaisa)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-4 space-y-1 text-sm">
          <p className="flex justify-between"><span className="text-slate-500">পণ্যের মোট:</span> <span>{formatTaka(inv.totalPaisa)}</span></p>
          <p className="flex justify-between"><span className="text-slate-500">ডেলিভারি চার্জ:</span> <span>{formatTaka(inv.deliveryChargePaisa)}</span></p>
          <p className="flex justify-between font-bold text-lg"><span>সর্বমোট:</span> <span>{inv.grandTotalText}</span></p>
        </div>

        <div className="mt-6 border-t pt-4 space-y-1 text-sm">
          <p><span className="text-slate-500">পেমেন্ট:</span> {inv.paymentMethodLabel}</p>
          <p><span className="text-slate-500">আনুমানিক ডেলিভারি:</span> {inv.deliveryEstimate}</p>
          <p className="text-xs text-slate-400 mt-2">ডেলিভারির তারিখ আনুমানিক — কুরিয়ারের উপর নির্ভর করে একটু এদিক-সেদিক হতে পারে।</p>
        </div>

        <button onClick={() => window.print()} className="mt-6 w-full bg-[#FF5B2E] text-white py-2.5 rounded-lg print:hidden">
          প্রিন্ট / সংরক্ষণ করুন
        </button>
      </div>
    </main>
  );
}
