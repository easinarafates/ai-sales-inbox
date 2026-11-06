"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { asArray, getToken, productsApi, productPricePaisa, type Product } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

export default function ProductsPage() {
  const router = useRouter();
  const { t, fmtTaka, fmtNum } = useI18n();
  const [products, setProducts] = useState<Product[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [priceTaka, setPriceTaka] = useState("");
  const [size, setSize] = useState("");
  const [stock, setStock] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await productsApi.list();
      setProducts(asArray(data));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("products.loadFailed", "Could not load products.", "প্রোডাক্ট লোড করা যায়নি।"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!getToken()) { router.push("/login"); return; }
    load();
  }, [load, router]);

  const search = async () => {
    if (!q.trim()) { load(); return; }
    setError("");
    try {
      const data = await productsApi.search(q.trim());
      setProducts(asArray(data));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("products.searchFailed", "Search failed.", "সার্চ ব্যর্থ হয়েছে।"));
    }
  };

  const addProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      await productsApi.create({
        name: name.trim(),
        pricePaisa: Math.round(parseFloat(priceTaka || "0") * 100),
        size: size || undefined,
        stock: stock ? parseInt(stock, 10) : undefined,
        description: description || undefined,
      });
      setName(""); setPriceTaka(""); setSize(""); setStock(""); setDescription("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("products.addFailed", "Could not add the product.", "প্রোডাক্ট যোগ করা যায়নি।"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">{t("products.title", "Products", "প্রোডাক্ট")}</h1>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}

      <div className="flex gap-2 mb-4">
        <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} placeholder={t("products.searchPlaceholder", "Search products…", "প্রোডাক্ট খুঁজুন…")} className="flex-1 border rounded-lg px-3 py-2 bg-white" />
        <button onClick={search} className="bg-teal-600 text-white px-4 py-2 rounded-lg hover:bg-teal-700">{t("common.search", "Search", "খুঁজুন")}</button>
      </div>

      <form onSubmit={addProduct} className="card p-4 mb-6 grid grid-cols-1 md:grid-cols-2 gap-3">
        <h2 className="font-bold md:col-span-2">{t("products.addTitle", "Add a new product", "নতুন প্রোডাক্ট যোগ করুন")}</h2>
        <input required value={name} onChange={(e) => setName(e.target.value)} placeholder={t("products.namePlaceholder", "Product name *", "প্রোডাক্টের নাম *")} className="border rounded-lg px-3 py-2" />
        <input required type="number" min="0" step="0.01" value={priceTaka} onChange={(e) => setPriceTaka(e.target.value)} placeholder={t("products.pricePlaceholder", "Price (৳) *", "দাম (৳) *")} className="border rounded-lg px-3 py-2" />
        <input value={size} onChange={(e) => setSize(e.target.value)} placeholder={t("products.sizePlaceholder", "Size (e.g. M / 1kg)", "সাইজ (যেমন: M / 1kg)")} className="border rounded-lg px-3 py-2" />
        <input type="number" min="0" value={stock} onChange={(e) => setStock(e.target.value)} placeholder={t("products.stockPlaceholder", "Stock", "স্টক")} className="border rounded-lg px-3 py-2" />
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("products.descPlaceholder", "Description", "বিবরণ")} className="border rounded-lg px-3 py-2 md:col-span-2" />
        <button disabled={saving} className="bg-brand text-white py-2 rounded-lg md:col-span-2 hover:bg-brand-dark disabled:opacity-50">{saving ? t("products.adding", "Adding…", "যোগ হচ্ছে…") : t("products.addButton", "Add product", "প্রোডাক্ট যোগ করুন")}</button>
      </form>

      {loading ? (<div className="space-y-2"><div className="skeleton h-12" /><div className="skeleton h-12" /><div className="skeleton h-12" /></div>) : products.length === 0 ? (
        <div className="empty-state">{t("products.empty", "No products yet. Add one from the form above.", "কোনো প্রোডাক্ট নেই। উপরের ফর্ম থেকে যোগ করুন।")}</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="table-head border-b text-left text-slate-500"><th className="p-3">{t("products.thName", "Name", "নাম")}</th><th className="p-3">{t("products.thPrice", "Price", "দাম")}</th><th className="p-3">{t("products.thSize", "Size", "সাইজ")}</th><th className="p-3">{t("products.thStock", "Stock", "স্টক")}</th><th className="p-3"></th></tr></thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id} className="border-b transition-colors hover:bg-orange-50">
                  <td className="p-3 font-medium">{p.name}</td>
                  <td className="p-3">{fmtTaka(productPricePaisa(p))}</td>
                  <td className="p-3">{p.size || "—"}</td>
                  <td className="p-3">{p.stock != null ? fmtNum(p.stock) : "—"}</td>
                  <td className="p-3 text-right"><Link href={`/products/${p.id}`} className="text-brand-dark underline">{t("products.detailsLink", "Details", "বিস্তারিত")}</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
