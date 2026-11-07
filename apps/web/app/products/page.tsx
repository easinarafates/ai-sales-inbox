"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { asArray, getToken, productsApi, productPricePaisa, type Product } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

const MAX_PHOTOS = 10;
const MAX_PHOTO_BYTES = 25 * 1024 * 1024; // 25 MB

interface SelectedPhoto {
  file: File;
  preview: string;
}

export default function ProductsPage() {
  const router = useRouter();
  const { t, fmtTaka, fmtNum } = useI18n();
  const [products, setProducts] = useState<Product[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [priceTaka, setPriceTaka] = useState("");
  const [size, setSize] = useState("");
  const [stock, setStock] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [photos, setPhotos] = useState<SelectedPhoto[]>([]);
  const [photoError, setPhotoError] = useState("");
  const [uploadingPhotos, setUploadingPhotos] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  // Revoke preview URLs only when the component unmounts.
  const photosRef = useRef<SelectedPhoto[]>([]);
  photosRef.current = photos;
  useEffect(() => () => { photosRef.current.forEach((p) => URL.revokeObjectURL(p.preview)); }, []);

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

  const onPickPhotos = (files: FileList | null) => {
    if (!files) return;
    setPhotoError("");
    const picked = Array.from(files);
    const valid: SelectedPhoto[] = [];
    for (const file of picked) {
      if (!file.type.startsWith("image/")) {
        setPhotoError(t("products.invalidPhotoType", "Only image files (jpg / png / gif / webp) are allowed.", "শুধু ছবির ফাইল (jpg / png / gif / webp) দেওয়া যায়।"));
        continue;
      }
      if (file.size > MAX_PHOTO_BYTES) {
        setPhotoError(`${file.name}: ${t("products.photoTooLarge", "Each photo must be 25 MB or smaller.", "প্রতিটি ছবি ২৫ MB বা তার ছোট হতে হবে।")}`);
        continue;
      }
      valid.push({ file, preview: URL.createObjectURL(file) });
    }
    if (valid.length === 0) return;
    setPhotos((prev) => {
      const room = MAX_PHOTOS - prev.length;
      if (room <= 0) {
        setPhotoError(t("products.photosHint", "Up to 10 photos (jpg / png / gif / webp, max 25 MB each).", "সর্বোচ্চ ১০টি ছবি (jpg / png / gif / webp, প্রতিটি সর্বোচ্চ ২৫ MB)।"));
        valid.forEach((v) => URL.revokeObjectURL(v.preview));
        return prev;
      }
      const kept = valid.slice(0, room);
      valid.slice(room).forEach((v) => URL.revokeObjectURL(v.preview));
      return [...prev, ...kept];
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removePickedPhoto = (index: number) => {
    setPhotos((prev) => {
      URL.revokeObjectURL(prev[index].preview);
      return prev.filter((_, i) => i !== index);
    });
  };

  const clearPickedPhotos = () => {
    photos.forEach((p) => URL.revokeObjectURL(p.preview));
    setPhotos([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const addProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setNotice("");
    setPhotoError("");
    setSaving(true);
    try {
      const pricePaisa = Math.round(parseFloat(priceTaka || "0") * 100);
      let productId: string | undefined;
      if (editingId) {
        const updated = await productsApi.update(editingId, {
          name: name.trim(),
          pricePaisa,
          size: size || null,
          stock: stock ? parseInt(stock, 10) : 0,
          description: description || null,
        });
        productId = (updated as { product?: Product }).product?.id ?? (updated as Product).id ?? editingId;
        setNotice(t("products.updated", "Product updated.", "প্রোডাক্ট বদলানো হয়েছে।"));
      } else {
        const created = await productsApi.create({
          name: name.trim(),
          pricePaisa,
          size: size || undefined,
          stock: stock ? parseInt(stock, 10) : undefined,
          description: description || undefined,
        });
        productId = (created as { product?: Product }).product?.id ?? (created as Product).id;
      }
      // Upload the picked photos one by one (multiple photos per product).
      const failed: string[] = [];
      if (productId && photos.length > 0) {
        for (let i = 0; i < photos.length; i++) {
          setUploadingPhotos(i + 1);
          try {
            await productsApi.uploadImage(productId, photos[i].file);
          } catch (err) {
            failed.push(photos[i].file.name);
          }
        }
        setUploadingPhotos(0);
      }
      setName(""); setPriceTaka(""); setSize(""); setStock(""); setDescription("");
      setEditingId(null);
      clearPickedPhotos();
      await load();
      if (failed.length > 0) {
        setPhotoError(`${t("products.photoUploadFailed", "Some photos could not be uploaded.", "কিছু ছবি আপলোড হয়নি।")} ${failed.join(", ")}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : (editingId
        ? t("products.updateFailed", "Could not update the product.", "প্রোডাক্ট বদলানো যায়নি।")
        : t("products.addFailed", "Could not add the product.", "প্রোডাক্ট যোগ করা যায়নি।")));
    } finally {
      setSaving(false);
      setUploadingPhotos(0);
    }
  };

  const startEdit = (p: Product) => {
    setError("");
    setNotice("");
    setEditingId(p.id);
    setName(p.name);
    setPriceTaka(String(productPricePaisa(p) / 100));
    setSize(p.size || "");
    setStock(p.stock != null ? String(p.stock) : "");
    setDescription(p.description || "");
    setPhotos([]);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setName(""); setPriceTaka(""); setSize(""); setStock(""); setDescription("");
    clearPickedPhotos();
  };

  const deleteProduct = async (p: Product) => {
    if (!window.confirm(t("products.deleteConfirm", "Delete this product? Its photos will be deleted too.", "এই প্রোডাক্টটি মুছে ফেলবেন? এর ছবিগুলোও মুছে যাবে।"))) return;
    setError("");
    setNotice("");
    try {
      await productsApi.delete(p.id);
      if (editingId === p.id) cancelEdit();
      setNotice(t("products.deleted", "Product deleted.", "প্রোডাক্ট মুছে ফেলা হয়েছে।"));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("products.deleteFailed", "Could not delete the product.", "প্রোডাক্ট মোছা যায়নি।"));
    }
  };

  return (
    <div>
      <h1 className="page-title">{t("products.title", "Products", "প্রোডাক্ট")}</h1>
      <p className="page-subtitle">{t("products.subtitle", "Products the AI shows and sells for you.", "AI যে প্রোডাক্টগুলো দেখায় আর বিক্রি করে।")}</p>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}
      {notice && <p className="bg-teal-50 text-teal-800 text-sm p-3 rounded-lg mb-4">{notice}</p>}

      <div className="flex gap-2 mb-4">
        <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} placeholder={t("products.searchPlaceholder", "Search products…", "প্রোডাক্ট খুঁজুন…")} className="flex-1 border rounded-lg px-3 py-2 bg-white" />
        <button onClick={search} className="bg-teal-600 text-white px-4 py-2 rounded-lg hover:bg-teal-700">{t("common.search", "Search", "খুঁজুন")}</button>
      </div>

      <form onSubmit={addProduct} className="card p-4 mb-6 grid grid-cols-1 md:grid-cols-2 gap-3">
        <h2 className="font-bold md:col-span-2">{editingId ? t("products.editTitle", "Edit product", "প্রোডাক্ট বদলান") : t("products.addTitle", "Add a new product", "নতুন প্রোডাক্ট যোগ করুন")}</h2>
        <input required value={name} onChange={(e) => setName(e.target.value)} placeholder={t("products.namePlaceholder", "Product name *", "প্রোডাক্টের নাম *")} className="border rounded-lg px-3 py-2" />
        <input required type="number" min="0" step="0.01" value={priceTaka} onChange={(e) => setPriceTaka(e.target.value)} placeholder={t("products.pricePlaceholder", "Price (৳) *", "দাম (৳) *")} className="border rounded-lg px-3 py-2" />
        <input value={size} onChange={(e) => setSize(e.target.value)} placeholder={t("products.sizePlaceholder", "Size (e.g. M / 1kg)", "সাইজ (যেমন: M / 1kg)")} className="border rounded-lg px-3 py-2" />
        <input type="number" min="0" value={stock} onChange={(e) => setStock(e.target.value)} placeholder={t("products.stockPlaceholder", "Stock", "স্টক")} className="border rounded-lg px-3 py-2" />
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("products.descPlaceholder", "Description", "বিবরণ")} className="border rounded-lg px-3 py-2 md:col-span-2" />

        <div className="md:col-span-2">
          <label className="font-medium text-sm">{t("products.photosLabel", "Product photos", "প্রোডাক্টের ছবি")}</label>
          <p className="text-xs text-slate-500 mb-2">{t("products.photosHint", "Up to 10 photos (jpg / png / gif / webp, max 25 MB each).", "সর্বোচ্চ ১০টি ছবি (jpg / png / gif / webp, প্রতিটি সর্বোচ্চ ২৫ MB)।")}</p>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            multiple
            onChange={(e) => onPickPhotos(e.target.files)}
            className="block w-full text-sm border rounded-lg px-3 py-2 bg-white"
          />
          {photos.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {photos.map((p, i) => (
                <div key={`${p.file.name}-${i}`} className="relative w-20 h-20">
                  <img src={p.preview} alt={p.file.name} className="w-20 h-20 object-cover rounded-lg border" />
                  <button
                    type="button"
                    onClick={() => removePickedPhoto(i)}
                    aria-label={t("products.removePhoto", "Remove photo", "ছবি সরান")}
                    className="absolute -top-2 -right-2 bg-red-600 text-white rounded-full w-5 h-5 text-xs leading-none"
                  >×</button>
                </div>
              ))}
            </div>
          )}
          {uploadingPhotos > 0 && (
            <p className="text-sm text-slate-500 mt-2">
              {t("products.uploadingPhotos", "Uploading photos…", "ছবি আপলোড হচ্ছে…")} {uploadingPhotos}/{photos.length}
            </p>
          )}
          {photoError && <p className="text-sm text-red-700 mt-2">{photoError}</p>}
        </div>

        <div className="flex gap-2 md:col-span-2">
          <button disabled={saving} className="flex-1 bg-brand text-white py-2 rounded-lg hover:bg-brand-dark disabled:opacity-50">{saving ? t("products.adding", "Adding…", "যোগ হচ্ছে…") : editingId ? t("products.saveEdit", "Save changes", "বদল সেভ করুন") : t("products.addButton", "Add product", "প্রোডাক্ট যোগ করুন")}</button>
          {editingId && (
            <button type="button" onClick={cancelEdit} className="px-4 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50">{t("products.cancelEdit", "Cancel", "বাতিল")}</button>
          )}
        </div>
      </form>

      {loading ? (<div className="space-y-2"><div className="skeleton h-12" /><div className="skeleton h-12" /><div className="skeleton h-12" /></div>) : products.length === 0 ? (
        <div className="empty-state">{t("products.empty", "No products yet. Add one from the form above.", "কোনো প্রোডাক্ট নেই। উপরের ফর্ম থেকে যোগ করুন।")}</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="table-head border-b text-left text-slate-500"><th className="p-3">{t("products.thPhoto", "Photo", "ছবি")}</th><th className="p-3">{t("products.thName", "Name", "নাম")}</th><th className="p-3">{t("products.thPrice", "Price", "দাম")}</th><th className="p-3">{t("products.thSize", "Size", "সাইজ")}</th><th className="p-3">{t("products.thStock", "Stock", "স্টক")}</th><th className="p-3"></th></tr></thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id} className="border-b transition-colors hover:bg-orange-50">
                  <td className="p-3">
                    {p.images && p.images.length > 0 ? (
                      <img src={p.images[0].url} alt={p.name} className="w-12 h-12 object-cover rounded-lg border" />
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="p-3 font-medium">{p.name}</td>
                  <td className="p-3">{fmtTaka(productPricePaisa(p))}</td>
                  <td className="p-3">{p.size || "—"}</td>
                  <td className="p-3">{p.stock != null ? fmtNum(p.stock) : "—"}</td>
                  <td className="p-3 text-right whitespace-nowrap">
                    <button onClick={() => startEdit(p)} className="text-teal-700 underline mr-2">{t("products.edit", "Edit", "বদলান")}</button>
                    <button onClick={() => deleteProduct(p)} className="text-red-700 underline mr-2">{t("products.delete", "Delete", "মুছুন")}</button>
                    <Link href={`/products/${p.id}`} className="text-brand-dark underline">{t("products.detailsLink", "Details", "বিস্তারিত")}</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
