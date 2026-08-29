"use client";


import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { putBuilderProductFeatureFlags } from "@/lib/api";
import { useProduct } from "../productContext";

export default function ProductFeatureFlagsPage() {
  const params = useParams<{ productId: string }>();
  const { product, loading, refetch } = useProduct();
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  const [newKey, setNewKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (product) setFlags(product.product_config.featureFlags ?? {});
  }, [product]);

  async function persist(next: Record<string, boolean>) {
    setSaving(true);
    setError(null);
    try {
      await putBuilderProductFeatureFlags(params.productId, next);
      setFlags(next);
      await refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  function toggle(key: string) {
    void persist({ ...flags, [key]: !flags[key] });
  }

  function addFlag() {
    const key = newKey.trim();
    if (!key || key in flags) return;
    setNewKey("");
    void persist({ ...flags, [key]: false });
  }

  function removeFlag(key: string) {
    const next = { ...flags };
    delete next[key];
    void persist(next);
  }

  if (loading || !product) return <div className="text-center py-12 text-gray-400">Loading…</div>;

  const entries = Object.entries(flags);

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-500">
        Toggle capabilities for this product&apos;s end users, independent of the platform&apos;s
        own rollout flags.
      </p>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3">{error}</div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
        {entries.length === 0 && (
          <p className="text-sm text-gray-400 p-5 text-center">No feature flags yet.</p>
        )}
        {entries.map(([key, value]) => (
          <div key={key} className="flex items-center justify-between px-5 py-3">
            <span className="text-sm font-mono text-gray-800">{key}</span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => toggle(key)}
                disabled={saving}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${
                  value ? "bg-brand-600" : "bg-gray-200"
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    value ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
              <button
                type="button"
                onClick={() => removeFlag(key)}
                disabled={saving}
                className="text-xs text-red-500 hover:underline disabled:opacity-50"
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="flex gap-3">
        <input
          type="text"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          placeholder="new_flag_name"
          className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-brand-500 outline-none"
        />
        <button
          type="button"
          onClick={addFlag}
          disabled={saving || !newKey.trim()}
          className="px-4 py-2 bg-brand-600 hover:bg-brand-700 disabled:bg-brand-300 text-white text-sm font-semibold rounded-lg transition-colors"
        >
          + Add flag
        </button>
      </div>
    </div>
  );
}
