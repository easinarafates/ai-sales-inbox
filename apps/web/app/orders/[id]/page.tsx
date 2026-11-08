"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { getToken, ordersApi, type Order } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import OrderDetailPanel from "@/components/OrderDetailPanel";

/**
 * Order detail page — the same panel as the slide-over on the Orders
 * list, rendered as a full page for deep links. All actions (status,
 * payment, courier, receipt, contacts) live in OrderDetailPanel.
 */
export default function OrderDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { t } = useI18n();
  const id = params.id as string;
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setOrder(await ordersApi.get(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("orders.loadDetailFailed", "Order not found.", "অর্ডার পাওয়া যায়নি।"));
    } finally {
      setLoading(false);
    }
  }, [id, t]);

  useEffect(() => {
    if (!getToken()) { router.push("/login"); return; }
    load();
  }, [load, router]);

  if (loading) return <p className="text-slate-500">{t("common.loading", "Loading…", "লোড হচ্ছে…")}</p>;
  if (error && !order) return <div><p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg">{error}</p><Link href="/orders" className="text-brand-dark underline text-sm">{t("orders.backToList", "← Back to order list", "← অর্ডার তালিকায় ফিরুন")}</Link></div>;
  if (!order) return <p className="text-slate-500">{t("orders.detailNotFound", "Order not found.", "অর্ডার পাওয়া যায়নি।")}</p>;

  return (
    <div>
      <Link href="/orders" className="text-brand-dark underline text-sm">{t("orders.listLink", "← Order list", "← অর্ডার তালিকা")}</Link>
      <div className="mt-3">
        <OrderDetailPanel
          order={order}
          shipment={(order as Order & { shipment?: unknown }).shipment as never}
          onOrderChange={setOrder}
        />
      </div>
    </div>
  );
}
