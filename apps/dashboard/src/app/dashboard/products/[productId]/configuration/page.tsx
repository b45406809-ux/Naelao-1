"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { updateBuilderProduct } from "@/lib/api";
import type { BuilderProductConfig } from "@/lib/api";
import { useProduct } from "../productContext";

export default function ProductConfigurationPage() {
  const params = useParams<{ productId: string }>();
  const { product, loading, refetch } = useProduct();
  const [form, setForm] = useState<BuilderProductConfig>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (product) setForm(product.product_config);
  }, [product]);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateBuilderProduct(params.productId, { product_config: form });
      await refetch();
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  if (loading || !product) return <div className="text-center py-12 text-gray-400">Loading…</div>;

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-4">Branding</h2>
        <div className="space-y-3">
          <div className="flex items-center gap-4">
            <input
              type="color"
              value={form.branding?.brandColor ?? "#4f46e5"}
              onChange={(e) => setForm((f) => ({ ...f, branding: { ...f.branding, brandColor: e.target.value } }))}
              className="h-10 w-16 border border-gray-300 rounded-lg cursor-pointer"
            />
            <div
              className="flex-1 h-10 rounded-lg flex items-center px-4 text-white text-sm font-semibold"
              style={{ backgroundColor: form.branding?.brandColor ?? "#4f46e5" }}
            >
              Preview
            </div>
          </div>
          <input
            type="text"
            value={form.branding?.logoUrl ?? ""}
            onChange={(e) => setForm((f) => ({ ...f, branding: { ...f.branding, logoUrl: e.target.value } }))}
            placeholder="Logo URL"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 outline-none"
          />
          <textarea
            value={form.branding?.productDescription ?? ""}
            onChange={(e) => setForm((f) => ({ ...f, branding: { ...f.branding, productDescription: e.target.value } }))}
            placeholder="Description"
            rows={2}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 outline-none resize-none"
          />
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-4">Sign-in</h2>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={form.authProvider?.requireAdminApproval ?? false}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                authProvider: { provider: f.authProvider?.provider ?? "naelao-native", ...f.authProvider, requireAdminApproval: e.target.checked },
              }))
            }
            className="rounded border-gray-300 text-brand-600 focus:ring-brand-500"
          />
          Require my approval before a new sign-up can use the product
        </label>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-4">Pricing</h2>
        <p className="text-sm text-gray-700 capitalize">
          Model: <span className="font-medium">{form.pricingConfig?.model ?? "free"}</span>
        </p>
        <p className="text-xs text-gray-400 mt-1">
          Changing the pricing model requires care since it affects existing customers — contact
          support to migrate.
        </p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3">{error}</div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="px-5 py-2 bg-brand-600 hover:bg-brand-700 disabled:bg-brand-300 text-white text-sm font-semibold rounded-lg transition-colors"
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
        {saved && <span className="text-sm text-green-600">Saved.</span>}
      </div>
    </div>
  );
}
