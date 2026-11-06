"use client";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { getToken, productsApi, productPricePaisa, type Product } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

export default function ProductDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { t, fmtDate, fmtTaka, fmtNum } = useI18n();
  const id = params.id as string;
  const [product, setProduct] = useState<Product | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getToken()) { router.push("/login"); return; }
    productsApi.get(id)
      .then((p) => setProduct(p))
      .catch((err) => setError(err instanceof Error ? err.message : t("products.loadDetailFailed", "Product not found.", "প্রোডাক্ট পাওয়া যায়নি।")))
      .finally(() => setLoading(false));
  }, [id, router, t]);

  if (loading) return <p className="text-slate-500">{t("common.loading", "Loading…", "লোড হচ্ছে…")}</p>;
  if (error) return <div><p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg">{error}</p><Link href="/products" className="text-brand-dark underline text-sm">{t("products.backToList", "← Back to product list", "← প্রোডাক্ট তালিকায় ফিরুন")}</Link></div>;
  if (!product) return <p className="text-slate-500">{t("products.detailNotFound", "Product not found.", "প্রোডাক্ট পাওয়া যায়নি।")}</p>;

  return (
    <div>
      <Link href="/products" className="text-brand-dark underline text-sm">{t("products.listLink", "← Product list", "← প্রোডাক্ট তালিকা")}</Link>
      <div className="card p-6 mt-3 max-w-2xl">
        <h1 className="text-2xl font-bold">{product.name}</h1>
        <p className="text-3xl font-bold text-brand-dark mt-2">{fmtTaka(productPricePaisa(product))}</p>
        <dl className="mt-4 space-y-2 text-sm">
          <div className="flex gap-2"><dt className="text-slate-500 w-24">{t("common.size", "Size", "সাইজ")}:</dt><dd>{product.size || "—"}</dd></div>
          <div className="flex gap-2"><dt className="text-slate-500 w-24">{t("common.stock", "Stock", "স্টক")}:</dt><dd>{product.stock != null ? fmtNum(product.stock) : "—"}</dd></div>
          <div className="flex gap-2"><dt className="text-slate-500 w-24">{t("common.description", "Description", "বিবরণ")}:</dt><dd>{product.description || "—"}</dd></div>
          <div className="flex gap-2"><dt className="text-slate-500 w-24">{t("common.created", "Created", "তৈরি")}:</dt><dd>{fmtDate(product.createdAt || product.created_at)}</dd></div>
          <div className="flex gap-2"><dt className="text-slate-500 w-24">{t("common.id", "ID", "ID")}:</dt><dd className="break-all text-slate-500">{product.id}</dd></div>
        </dl>
      </div>
    </div>
  );
}
