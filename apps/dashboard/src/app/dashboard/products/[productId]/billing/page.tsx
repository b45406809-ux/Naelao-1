"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { getBuilderBilling, getBuilderBillingHistory, getBuilderProductRevenue } from "@/lib/api";
import type { BuilderBillingPeriod, BuilderProductRevenue } from "@/lib/api";
import PaymentsAccountCard from "./PaymentsAccountCard";

function centsToDisplay(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

export default function ProductBillingPage() {
  const params = useParams<{ productId: string }>();
  const [revenue, setRevenue] = useState<BuilderProductRevenue | null>(null);
  const [current, setCurrent] = useState<BuilderBillingPeriod | null>(null);
  const [history, setHistory] = useState<BuilderBillingPeriod[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [r, c, h] = await Promise.all([
          getBuilderProductRevenue(params.productId),
          getBuilderBilling(),
          getBuilderBillingHistory(),
        ]);
        setRevenue(r);
        setCurrent(c);
        setHistory(h);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load billing");
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, [params.productId]);

  if (loading) return <div className="text-center py-12 text-gray-400">Loading…</div>;
  if (error) {
    return <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3">{error}</div>;
  }

  return (
    <div className="space-y-6">
      {/* Business Wallet: the product's own auto-provisioned Whop sub-merchant wallet (a
          NaelaoProduct IS a space, so the product id is the space id the wallet routes expect). */}
      <PaymentsAccountCard spaceId={params.productId} />

      <div>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
          This product&apos;s revenue — {revenue?.period}
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <p className="text-xs text-gray-500 mb-1">Gross revenue</p>
            <p className="text-xl font-bold text-gray-900">{centsToDisplay(revenue?.gross_revenue_cents ?? 0)}</p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <p className="text-xs text-gray-500 mb-1">Naelao fee</p>
            <p className="text-xl font-bold text-gray-500">{centsToDisplay(revenue?.naelao_fee_cents ?? 0)}</p>
          </div>
          <div className="rounded-xl border border-brand-200 bg-brand-50 p-4">
            <p className="text-xs text-gray-500 mb-1">Net revenue</p>
            <p className="text-xl font-bold text-brand-700">{centsToDisplay(revenue?.net_revenue_cents ?? 0)}</p>
          </div>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
            Your account&apos;s wholesale statement — {current?.period}
          </h2>
        </div>
        <p className="text-xs text-gray-400 mb-3">
          This is your overall wholesale bill with Naelao across ALL your products, not specific
          to this one — reseller billing is tracked at the account level.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <p className="text-xs text-gray-500 mb-1">Retail</p>
            <p className="text-lg font-bold text-gray-900">{centsToDisplay(current?.retail ?? 0)}</p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <p className="text-xs text-gray-500 mb-1">Wholesale</p>
            <p className="text-lg font-bold text-gray-500">{centsToDisplay(current?.wholesale ?? 0)}</p>
          </div>
          <div className="rounded-xl border border-brand-200 bg-brand-50 p-4">
            <p className="text-xs text-gray-500 mb-1">Margin</p>
            <p className="text-lg font-bold text-brand-700">{centsToDisplay(current?.margin ?? 0)}</p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <p className="text-xs text-gray-500 mb-1">Events</p>
            <p className="text-lg font-bold text-gray-500">{current?.events ?? 0}</p>
          </div>
        </div>
      </div>

      {history.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">History</h2>
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="text-left px-6 py-3 font-semibold text-gray-600">Period</th>
                  <th className="text-left px-6 py-3 font-semibold text-gray-600">Retail</th>
                  <th className="text-left px-6 py-3 font-semibold text-gray-600">Wholesale</th>
                  <th className="text-left px-6 py-3 font-semibold text-gray-600">Margin</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {history.map((h) => (
                  <tr key={h.period}>
                    <td className="px-6 py-3 font-medium text-gray-900">{h.period}</td>
                    <td className="px-6 py-3 text-gray-700">{centsToDisplay(h.retail)}</td>
                    <td className="px-6 py-3 text-gray-500">{centsToDisplay(h.wholesale)}</td>
                    <td className="px-6 py-3 text-brand-700">{centsToDisplay(h.margin)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
