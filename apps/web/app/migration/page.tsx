"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  asArrayOf,
  getToken,
  migrationApi,
  type MigrationImport,
  type MigrationType,
} from "@/lib/api";
import { useI18n } from "@/lib/i18n";

const TYPE_KEYS: Record<MigrationType, string> = {
  customers: "migration.typeCustomers",
  products: "migration.typeProducts",
  orders: "migration.typeOrders",
};
const TYPE_FALLBACK: Record<MigrationType, [string, string]> = {
  customers: ["Customers", "কাস্টমার"],
  products: ["Products", "প্রোডাক্ট"],
  orders: ["Orders", "অর্ডার"],
};

export default function MigrationPage() {
  const router = useRouter();
  const { t, fmtDate, fmtNum } = useI18n();
  const [imports, setImports] = useState<MigrationImport[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [type, setType] = useState<MigrationType>("customers");
  const [csv, setCsv] = useState("");
  const [result, setResult] = useState<{ imported: number; failed: number; errors?: string[] } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const typeLabel = (ty: string) => {
    const fb = TYPE_FALLBACK[ty as MigrationType] || [ty, ty];
    return t(TYPE_KEYS[ty as MigrationType] || "", fb[0], fb[1]);
  };

  const load = useCallback(async () => {
    try {
      const data = await migrationApi.listImports();
      setImports(asArrayOf<MigrationImport>(data, ["imports"]));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("migration.loadFailed", "Could not load import history.", "ইমপোর্টের ইতিহাস লোড করা যায়নি।"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!getToken()) { router.push("/login"); return; }
    load();
  }, [load, router]);

  const onFile = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setCsv(String(reader.result || ""));
    };
    reader.onerror = () => setError(t("migration.readFailed", "Could not read the file.", "ফাইল পড়া যায়নি।"));
    reader.readAsText(file);
  };

  const doImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!csv.trim()) {
      setError(t("migration.csvEmpty", "Write the CSV or pick a file.", "CSV লিখুন বা ফাইল বাছুন।"));
      return;
    }
    setError("");
    setResult(null);
    setImporting(true);
    try {
      const res = await migrationApi.importCsv(type, csv);
      setResult(res);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("migration.importFailed", "Could not import.", "ইমপোর্ট করা যায়নি।"));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">{t("migration.title", "Migration", "মাইগ্রেশন")}</h1>
      {error && <p className="bg-red-50 text-red-700 text-sm p-3 rounded-lg mb-4">{error}</p>}

      <form onSubmit={doImport} className="card p-4 mb-6 space-y-3">
        <h2 className="font-bold">{t("migration.importTitle", "Import CSV", "CSV ইমপোর্ট করুন")}</h2>
        <div className="flex flex-wrap gap-2 items-center">
          <label className="text-sm text-slate-500">{t("migration.whatToImport", "What to import?", "কী ইমপোর্ট করবেন?")}</label>
          <select value={type} onChange={(e) => setType(e.target.value as MigrationType)} className="border rounded-lg px-3 py-2 bg-white">
            {(Object.keys(TYPE_KEYS) as MigrationType[]).map((ty) => (
              <option key={ty} value={ty}>{typeLabel(ty)}</option>
            ))}
          </select>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => onFile(e.target.files?.[0])}
            className="text-sm"
          />
        </div>
        <textarea
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          placeholder={t("migration.csvPlaceholder", "Write the CSV here or pick a file — the first line will have the column names, e.g.:\nname,phone,address\nRahim,01700000000,Dhaka", "CSV এখানে লিখুন বা ফাইল বাছুন — প্রথম লাইনে কলামের নাম থাকবে, যেমন:\nname,phone,address\nরহিম,01700000000,ঢাকা")}
          className="w-full border rounded-lg px-3 py-2 font-mono text-sm"
          rows={8}
        />
        <button disabled={importing} className="bg-brand text-white py-2 px-6 rounded-lg hover:bg-brand-dark disabled:opacity-50">
          {importing ? t("migration.importing", "Importing…", "ইমপোর্ট হচ্ছে…") : t("migration.importButton", "Import", "ইমপোর্ট করুন")}
        </button>
      </form>

      {result && (
        <div className={`rounded-xl shadow p-4 mb-6 ${result.failed > 0 ? "bg-amber-50" : "bg-teal-50"}`}>
          <h3 className="font-bold mb-2">{t("migration.resultTitle", "Import result", "ইমপোর্টের ফলাফল")}</h3>
          <p className="text-sm">{t("migration.success", "✅ Successful:", "✅ সফল:")} {fmtNum(result.imported)}{t("common.countSuffix", "", "টি")} • {t("migration.failed", "❌ Failed:", "❌ ব্যর্থ:")} {fmtNum(result.failed)}{t("common.countSuffix", "", "টি")}</p>
          {(result.errors || []).length > 0 && (
            <ul className="text-sm text-red-700 mt-2 list-disc pl-5">
              {result.errors!.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <h2 className="text-xl font-bold mb-3">{t("migration.historyTitle", "Import history", "ইমপোর্টের ইতিহাস")}</h2>
      {loading ? <p className="text-slate-500">{t("common.loading", "Loading…", "লোড হচ্ছে…")}</p> : imports.length === 0 ? (
        <div className="empty-state">{t("migration.empty", "No imports yet.", "এখনো কোনো ইমপোর্ট হয়নি।")}</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="table-head border-b text-left text-slate-500"><th className="p-3">{t("migration.thType", "Type", "ধরন")}</th><th className="p-3">{t("migration.thSuccess", "Successful", "সফল")}</th><th className="p-3">{t("migration.thFailed", "Failed", "ব্যর্থ")}</th><th className="p-3">{t("migration.thDate", "Date", "তারিখ")}</th></tr></thead>
            <tbody>
              {imports.map((imp) => (
                <tr key={imp.id} className="border-b transition-colors hover:bg-orange-50">
                  <td className="p-3">{typeLabel(imp.type as MigrationType)}</td>
                  <td className="p-3">{imp.imported != null ? fmtNum(imp.imported) : "—"}</td>
                  <td className="p-3">{imp.failed != null ? fmtNum(imp.failed) : "—"}</td>
                  <td className="p-3">{fmtDate(imp.createdAt || imp.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
