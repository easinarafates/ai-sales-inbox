"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { getToken, productsApi, productPricePaisa, type Product, type ProductImage } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

const MAX_PHOTOS = 10;
const MAX_PHOTO_BYTES = 25 * 1024 * 1024; // 25 MB

export default function ProductDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { t, fmtDate, fmtTaka, fmtNum } = useI18n();
  const id = params.id as string;
  const [product, setProduct] = useState<Product | null>(null);
  const [images, setImages] = useState<ProductImage[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [photoError, setPhotoError] = useState("");
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState("");
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editPriceTaka, setEditPriceTaka] = useState("");
  const [editSize, setEditSize] = useState("");
  const [editStock, setEditStock] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadImages = useCallback(async () => {
    try {
      setImages(await productsApi.listImages(id));
    } catch {
      // The product payload already carries images; a list failure is not fatal.
    }
  }, [id]);

  useEffect(() => {
    if (!getToken()) { router.push("/login"); return; }
    productsApi.get(id)
      .then((p) => { setProduct(p); setImages(p.images ?? []); })
      .catch((err) => setError(err instanceof Error ? err.message : t("products.loadDetailFailed", "Product not found.", "প্রোডাক্ট পাওয়া যায়নি।")))
      .finally(() => setLoading(false));
  }, [id, router, t]);

  const onPickPhotos = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setPhotoError("");
    const picked = Array.from(files);
    const room = MAX_PHOTOS - images.length;
    if (room <= 0) {
      setPhotoError(t("products.photosHint", "Up to 10 photos (jpg / png / gif / webp, max 25 MB each).", "সর্বোচ্চ ১০টি ছবি (jpg / png / gif / webp, প্রতিটি সর্বোচ্চ ২৫ MB)।"));
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setUploading(true);
    const failed: string[] = [];
    for (const file of picked.slice(0, room)) {
      if (!file.type.startsWith("image/")) { failed.push(file.name); continue; }
      if (file.size > MAX_PHOTO_BYTES) { failed.push(file.name); continue; }
      try {
        await productsApi.uploadImage(id, file);
      } catch {
        failed.push(file.name);
      }
    }
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
    await loadImages();
    if (failed.length > 0) {
      setPhotoError(`${t("products.photoUploadFailed", "Some photos could not be uploaded.", "কিছু ছবি আপলোড হয়নি।")} ${failed.join(", ")}`);
    }
  };

  const startEdit = () => {
    if (!product) return;
    setEditName(product.name);
    setEditPriceTaka(String(productPricePaisa(product) / 100));
    setEditSize(product.size || "");
    setEditStock(product.stock != null ? String(product.stock) : "");
    setEditDescription(product.description || "");
    setEditing(true);
  };

  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!product) return;
    setError("");
    setNotice("");
    setSavingEdit(true);
    try {
      const updated = await productsApi.update(product.id, {
        name: editName.trim(),
        pricePaisa: Math.round(parseFloat(editPriceTaka || "0") * 100),
        size: editSize || null,
        stock: editStock ? parseInt(editStock, 10) : 0,
        description: editDescription || null,
      });
      const p = (updated as { product?: Product }).product ?? (updated as Product);
      setProduct(p);
      setEditing(false);
      setNotice(t("products.updated", "Product updated.", "প্রোডাক্ট বদলানো হয়েছে।"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("products.updateFailed", "Could not update the product.", "প্রোডাক্ট বদলানো যায়নি।"));
    } finally {
      setSavingEdit(false);
    }
  };

  const deleteProduct = async () => {
    if (!product) return;
    if (!window.confirm(t("products.deleteConfirm", "Delete this product? Its photos will be deleted too.", "এই প্রোডাক্টটি মুছে ফেলবেন? এর ছবিগুলোও মুছে যাবে।"))) return;
    try {
      await productsApi.delete(product.id);
      router.push("/products");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("products.deleteFailed", "Could not delete the product.", "প্রোডাক্ট মোছা যায়নি।"));
    }
  };

  const removePhoto = async (imageId: string) => {
    if (!window.confirm(t("products.deletePhotoConfirm", "Remove this photo?", "এই ছবিটি সরাবেন?"))) return;
    setPhotoError("");
    setDeletingId(imageId);
    try {
      await productsApi.deleteImage(id, imageId);
      setImages((prev) => prev.filter((img) => img.id !== imageId));
    } catch (err) {
      setPhotoError(err instanceof Error ? err.message : t("products.deletePhotoFailed", "Could not remove the photo.", "ছবি সরানো যায়নি।"));
    } finally {
      setDeletingId("");
    }
  };

  if (loading) return (
    <div className="space-y-3">
      <div className="skeleton h-8 w-48" />
      <div className="skeleton h-24" />
      <div className="skeleton h-24" />
    </div>
  );
  if (error) return <div><p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg">{error}</p><Link href="/products" className="text-brand-dark underline text-sm">{t("products.backToList", "← Back to product list", "← প্রোডাক্ট তালিকায় ফিরুন")}</Link></div>;
  if (!product) return <p className="text-slate-500">{t("products.detailNotFound", "Product not found.", "প্রোডাক্ট পাওয়া যায়নি।")}</p>;

  return (
    <div>
      <Link href="/products" className="text-brand-dark underline text-sm">{t("products.listLink", "← Product list", "← প্রোডাক্ট তালিকা")}</Link>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mt-3 max-w-2xl">{error}</p>}
      {notice && <p className="bg-green-50 text-green-800 text-sm p-3 rounded-lg mt-3 max-w-2xl">{notice}</p>}
      <div className="card p-6 mt-3 max-w-2xl">
        <h1 className="page-title">{product.name}</h1>
        <p className="text-3xl font-bold text-brand-dark mt-2">{fmtTaka(productPricePaisa(product))}</p>
        <dl className="mt-4 space-y-2 text-sm">
          <div className="flex gap-2"><dt className="text-slate-500 w-24">{t("common.size", "Size", "সাইজ")}:</dt><dd>{product.size || "—"}</dd></div>
          <div className="flex gap-2"><dt className="text-slate-500 w-24">{t("common.stock", "Stock", "স্টক")}:</dt><dd>{product.stock != null ? fmtNum(product.stock) : "—"}</dd></div>
          <div className="flex gap-2"><dt className="text-slate-500 w-24">{t("common.description", "Description", "বিবরণ")}:</dt><dd>{product.description || "—"}</dd></div>
          <div className="flex gap-2"><dt className="text-slate-500 w-24">{t("common.created", "Created", "তৈরি")}:</dt><dd>{fmtDate(product.createdAt || product.created_at)}</dd></div>
          <div className="flex gap-2"><dt className="text-slate-500 w-24">{t("common.id", "ID", "ID")}:</dt><dd className="break-all text-slate-500">{product.id}</dd></div>
        </dl>

        {editing ? (
          <form onSubmit={saveEdit} className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-3 border-t pt-4">
            <h2 className="font-bold sm:col-span-2">{t("products.editTitle", "Edit product", "প্রোডাক্ট বদলান")}</h2>
            <input required value={editName} onChange={(e) => setEditName(e.target.value)} placeholder={t("products.namePlaceholder", "Product name *", "প্রোডাক্টের নাম *")} className="border rounded-lg px-3 py-2" />
            <input required type="number" min="0" step="0.01" value={editPriceTaka} onChange={(e) => setEditPriceTaka(e.target.value)} placeholder={t("products.pricePlaceholder", "Price (৳) *", "দাম (৳) *")} className="border rounded-lg px-3 py-2" />
            <input value={editSize} onChange={(e) => setEditSize(e.target.value)} placeholder={t("products.sizePlaceholder", "Size (e.g. M / 1kg)", "সাইজ (যেমন: M / 1kg)")} className="border rounded-lg px-3 py-2" />
            <input type="number" min="0" value={editStock} onChange={(e) => setEditStock(e.target.value)} placeholder={t("products.stockPlaceholder", "Stock", "স্টক")} className="border rounded-lg px-3 py-2" />
            <textarea value={editDescription} onChange={(e) => setEditDescription(e.target.value)} placeholder={t("products.descPlaceholder", "Description", "বিবরণ")} className="border rounded-lg px-3 py-2 sm:col-span-2" />
            <div className="flex gap-2 sm:col-span-2">
              <button disabled={savingEdit} className="bg-brand text-white px-4 py-2 rounded-lg hover:bg-brand-dark disabled:opacity-50">{savingEdit ? t("products.adding", "Adding…", "যোগ হচ্ছে…") : t("products.saveEdit", "Save changes", "বদল সেভ করুন")}</button>
              <button type="button" onClick={() => setEditing(false)} className="px-4 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50">{t("products.cancelEdit", "Cancel", "বাতিল")}</button>
            </div>
          </form>
        ) : (
          <div className="mt-6 flex gap-2 border-t pt-4">
            <button onClick={startEdit} className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-green-700">{t("products.edit", "Edit", "বদলান")}</button>
            <button onClick={deleteProduct} className="bg-red-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-red-700">{t("products.delete", "Delete", "মুছুন")}</button>
          </div>
        )}
        <div className="mt-6">
          <h2 className="font-bold">{t("products.photosLabel", "Product photos", "প্রোডাক্টের ছবি")}</h2>
          <p className="text-xs text-slate-500 mb-2">{t("products.photosHint", "Up to 10 photos (jpg / png / gif / webp, max 25 MB each).", "সর্বোচ্চ ১০টি ছবি (jpg / png / gif / webp, প্রতিটি সর্বোচ্চ ২৫ MB)।")}</p>
          {images.length === 0 ? (
            <p className="text-sm text-slate-500">{t("products.noPhotos", "No photos yet.", "এখনো কোনো ছবি নেই।")}</p>
          ) : (
            <div className="flex flex-wrap gap-2 mt-2">
              {images.map((img) => (
                <div key={img.id} className="relative w-28 h-28">
                  <img src={img.url} alt={product.name} className="w-28 h-28 object-cover rounded-lg border" />
                  <button
                    type="button"
                    disabled={deletingId === img.id}
                    onClick={() => removePhoto(img.id)}
                    aria-label={t("products.removePhoto", "Remove photo", "ছবি সরান")}
                    className="absolute -top-2 -right-2 bg-red-600 text-white rounded-full w-6 h-6 text-sm leading-none disabled:opacity-50"
                  >×</button>
                </div>
              ))}
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            multiple
            disabled={uploading}
            onChange={(e) => onPickPhotos(e.target.files)}
            className="block w-full text-sm border rounded-lg px-3 py-2 bg-white mt-3 disabled:opacity-50"
          />
          {uploading && <p className="text-sm text-slate-500 mt-2">{t("products.uploadingPhotos", "Uploading photos…", "ছবি আপলোড হচ্ছে…")}</p>}
          {photoError && <p className="text-sm text-red-700 mt-2">{photoError}</p>}
        </div>
      </div>
    </div>
  );
}
