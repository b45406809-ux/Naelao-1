"use client";

export const runtime = "edge";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { configureBuilderProductDomain, getBuilderProductDomain } from "@/lib/api";
import type { BuilderProductDomain } from "@/lib/api";
import { useProduct } from "../productContext";
import { productShellDisplay } from "@/lib/product-url";

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  not_configured: { label: "Not configured", color: "bg-gray-100 text-gray-500" },
  pending_dns: { label: "Pending DNS", color: "bg-yellow-50 text-yellow-700" },
  active: { label: "Active", color: "bg-green-100 text-green-700" },
};

export default function ProductDomainPage() {
  const params = useParams<{ productId: string }>();
  const { product, loading: productLoading } = useProduct();
  const [domain, setDomain] = useState<BuilderProductDomain | null>(null);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const d = await getBuilderProductDomain(params.productId);
      setDomain(d);
    } catch {
      setDomain(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.productId]);

  async function handleConfigure() {
    if (!input.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const d = await configureBuilderProductDomain(params.productId, input.trim());
      setDomain(d);
      setInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to configure domain");
    } finally {
      setSaving(false);
    }
  }

  async function handleCheckStatus() {
    setChecking(true);
    try {
      await refresh();
    } finally {
      setChecking(false);
    }
  }

  if (productLoading || loading || !product) return <div className="text-center py-12 text-gray-400">Loading…</div>;

  const status = domain?.status ?? "not_configured";
  const statusInfo = STATUS_LABELS[status] ?? { label: status, color: "bg-gray-100 text-gray-500" };

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Custom Domain</h2>
          <span className={`text-xs px-2.5 py-0.5 rounded-full font-medium ${statusInfo.color}`}>{statusInfo.label}</span>
        </div>
        <p className="text-xs text-gray-400 mb-4">
          By default your product is served at{" "}
          <span className="font-mono">{productShellDisplay(product.product_slug) ?? "no address yet"}</span>.
          Add your own domain so it appears under your brand instead.
        </p>

        {domain?.custom_domain && (
          <div className="mb-4 flex items-center justify-between rounded-lg border border-gray-200 px-4 py-3">
            <span className="font-mono text-sm text-gray-800">{domain.custom_domain}</span>
            <button
              type="button"
              onClick={() => void handleCheckStatus()}
              disabled={checking}
              className="text-sm text-brand-600 hover:underline disabled:text-gray-400"
            >
              {checking ? "Checking…" : "Check status"}
            </button>
          </div>
        )}

        {status !== "active" && (
          <div className="flex gap-2 mb-4">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="shop.yourbrand.com"
              className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 outline-none"
            />
            <button
              type="button"
              onClick={() => void handleConfigure()}
              disabled={saving || !input.trim()}
              className="px-4 py-2 bg-brand-600 hover:bg-brand-700 disabled:bg-brand-300 text-white text-sm font-semibold rounded-lg transition-colors"
            >
              {saving ? "Saving…" : domain?.custom_domain ? "Update" : "Connect domain"}
            </button>
          </div>
        )}

        {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 mb-4 text-sm">{error}</div>}

        {domain?.dns && status !== "active" && (
          <div className="border-t border-gray-100 pt-4">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">DNS records to add</h3>
            <p className="text-xs text-gray-400 mb-3">
              Add these records at your domain registrar. It may take a few minutes to a few hours to propagate —
              use "Check status" above once you've added them.
            </p>
            <div className="space-y-2">
              <div className="grid grid-cols-3 gap-2 text-xs font-mono bg-gray-50 rounded-lg px-3 py-2">
                <span className="text-gray-500">{domain.dns.type}</span>
                <span className="text-gray-800 truncate">{domain.dns.name}</span>
                <span className="text-gray-800 truncate">{domain.dns.value}</span>
              </div>
              {(domain.validation_records ?? []).map((record, i) => {
                const r = record as { txt_name?: string; txt_value?: string };
                if (!r.txt_name) return null;
                return (
                  <div key={i} className="grid grid-cols-3 gap-2 text-xs font-mono bg-gray-50 rounded-lg px-3 py-2">
                    <span className="text-gray-500">TXT</span>
                    <span className="text-gray-800 truncate">{r.txt_name}</span>
                    <span className="text-gray-800 truncate">{r.txt_value}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {status === "active" && (
          <p className="text-sm text-green-700">Your custom domain is live and serving traffic.</p>
        )}
      </div>
    </div>
  );
}
