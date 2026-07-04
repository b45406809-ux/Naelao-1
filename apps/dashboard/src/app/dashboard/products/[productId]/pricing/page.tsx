"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { updateBuilderProductPricing } from "@/lib/api";
import type { PricingPlan, CreditPack } from "@/lib/api";
import { useProduct } from "../productContext";

function centsToDisplay(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(cents / 100);
}

function randomId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function ProductPricingPage() {
  const params = useParams<{ productId: string }>();
  const { product, loading, refetch } = useProduct();
  const [plans, setPlans] = useState<PricingPlan[]>([]);
  const [creditPacks, setCreditPacks] = useState<CreditPack[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (product) {
      setPlans(product.product_config.pricingConfig?.plans ?? []);
      setCreditPacks(product.product_config.pricingConfig?.creditPacks ?? []);
    }
  }, [product]);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateBuilderProductPricing(params.productId, { plans, creditPacks });
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

  const membershipModel = product.product_config.membershipModel ?? "team";
  if (membershipModel === "team") {
    return (
      <div className="bg-white rounded-xl border border-dashed border-gray-300 p-12 text-center">
        <p className="text-gray-500">
          Subscription plans and credit packs are for products where end users create their own
          businesses. Switch this product to Tenant or Hybrid mode in{" "}
          <span className="font-medium">Configuration → Product Mode</span> to configure pricing.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Subscription Plans</h2>
            <p className="text-xs text-gray-400 mt-1">A business subscribes to one of these plans as a whole.</p>
          </div>
          <button
            type="button"
            onClick={() => setPlans((p) => [...p, { id: randomId("plan"), name: "New Plan", priceCents: 0, interval: "month" }])}
            className="px-3 py-1.5 text-sm font-medium text-brand-700 border border-brand-200 rounded-lg hover:bg-brand-50"
          >
            + Add plan
          </button>
        </div>

        {plans.length === 0 && <p className="text-sm text-gray-400 py-4 text-center">No plans yet.</p>}

        <div className="space-y-3">
          {plans.map((plan, i) => (
            <div key={plan.id} className="border border-gray-200 rounded-lg p-4 grid grid-cols-2 sm:grid-cols-5 gap-3 items-end">
              <div className="col-span-2 sm:col-span-1">
                <label className="block text-xs font-medium text-gray-500 mb-1">Name</label>
                <input
                  type="text"
                  value={plan.name}
                  onChange={(e) => setPlans((p) => p.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                  className="w-full px-2 py-1.5 border border-gray-300 rounded-lg text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Price (cents)</label>
                <input
                  type="number"
                  min={0}
                  value={plan.priceCents}
                  onChange={(e) => setPlans((p) => p.map((x, j) => (j === i ? { ...x, priceCents: Number(e.target.value) } : x)))}
                  className="w-full px-2 py-1.5 border border-gray-300 rounded-lg text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Interval</label>
                <select
                  value={plan.interval}
                  onChange={(e) => setPlans((p) => p.map((x, j) => (j === i ? { ...x, interval: e.target.value as "month" | "year" } : x)))}
                  className="w-full px-2 py-1.5 border border-gray-300 rounded-lg text-sm bg-white"
                >
                  <option value="month">Monthly</option>
                  <option value="year">Yearly</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Credits/mo</label>
                <input
                  type="number"
                  min={0}
                  value={plan.creditAllowance ?? ""}
                  onChange={(e) => {
                    const { creditAllowance: _drop, ...rest } = plan;
                    const next = e.target.value === "" ? rest : { ...rest, creditAllowance: Number(e.target.value) };
                    setPlans((p) => p.map((x, j) => (j === i ? next : x)));
                  }}
                  placeholder="—"
                  className="w-full px-2 py-1.5 border border-gray-300 rounded-lg text-sm"
                />
              </div>
              <div className="flex items-center justify-between gap-2">
                {plan.lsVariantId ? (
                  <span className="text-xs px-2 py-1 rounded-full bg-green-50 text-green-700">Provisioned</span>
                ) : (
                  <span className="text-xs px-2 py-1 rounded-full bg-yellow-50 text-yellow-700">Not provisioned</span>
                )}
                <button
                  type="button"
                  onClick={() => setPlans((p) => p.filter((_, j) => j !== i))}
                  className="text-xs text-red-600 hover:underline"
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Credit Packs</h2>
            <p className="text-xs text-gray-400 mt-1">One-time purchases an end user buys for their own credit balance.</p>
          </div>
          <button
            type="button"
            onClick={() => setCreditPacks((p) => [...p, { id: randomId("pack"), name: "New Pack", credits: 1000, priceCents: 0 }])}
            className="px-3 py-1.5 text-sm font-medium text-brand-700 border border-brand-200 rounded-lg hover:bg-brand-50"
          >
            + Add pack
          </button>
        </div>

        {creditPacks.length === 0 && <p className="text-sm text-gray-400 py-4 text-center">No credit packs yet.</p>}

        <div className="space-y-3">
          {creditPacks.map((pack, i) => (
            <div key={pack.id} className="border border-gray-200 rounded-lg p-4 grid grid-cols-2 sm:grid-cols-4 gap-3 items-end">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Name</label>
                <input
                  type="text"
                  value={pack.name}
                  onChange={(e) => setCreditPacks((p) => p.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                  className="w-full px-2 py-1.5 border border-gray-300 rounded-lg text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Credits</label>
                <input
                  type="number"
                  min={0}
                  value={pack.credits}
                  onChange={(e) => setCreditPacks((p) => p.map((x, j) => (j === i ? { ...x, credits: Number(e.target.value) } : x)))}
                  className="w-full px-2 py-1.5 border border-gray-300 rounded-lg text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Price (cents)</label>
                <input
                  type="number"
                  min={0}
                  value={pack.priceCents}
                  onChange={(e) => setCreditPacks((p) => p.map((x, j) => (j === i ? { ...x, priceCents: Number(e.target.value) } : x)))}
                  className="w-full px-2 py-1.5 border border-gray-300 rounded-lg text-sm"
                />
              </div>
              <div className="flex items-center justify-between gap-2">
                {pack.lsVariantId ? (
                  <span className="text-xs px-2 py-1 rounded-full bg-green-50 text-green-700">Provisioned</span>
                ) : (
                  <span className="text-xs px-2 py-1 rounded-full bg-yellow-50 text-yellow-700">Not provisioned</span>
                )}
                <button
                  type="button"
                  onClick={() => setCreditPacks((p) => p.filter((_, j) => j !== i))}
                  className="text-xs text-red-600 hover:underline"
                >
                  Remove
                </button>
              </div>
              <p className="col-span-2 sm:col-span-4 text-xs text-gray-400">{centsToDisplay(pack.priceCents)} for {pack.credits} credits</p>
            </div>
          ))}
        </div>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3">{error}</div>}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="px-5 py-2 bg-brand-600 hover:bg-brand-700 disabled:bg-brand-300 text-white text-sm font-semibold rounded-lg transition-colors"
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
        {saved && <span className="text-sm text-green-600">Saved — new plans/packs were provisioned on Lemon Squeezy.</span>}
      </div>
    </div>
  );
}
