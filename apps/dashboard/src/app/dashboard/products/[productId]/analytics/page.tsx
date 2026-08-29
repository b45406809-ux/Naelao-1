"use client";


import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { getBuilderProductAnalytics, getBuilderProductRevenue } from "@/lib/api";
import type { BuilderProductAnalytics, BuilderProductRevenue } from "@/lib/api";

function centsToDisplay(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

function StatCard({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-xl font-bold ${muted ? "text-gray-500" : "text-gray-900"}`}>{value}</p>
    </div>
  );
}

export default function ProductAnalyticsPage() {
  const params = useParams<{ productId: string }>();
  const [analytics, setAnalytics] = useState<BuilderProductAnalytics | null>(null);
  const [revenue, setRevenue] = useState<BuilderProductRevenue | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [a, r] = await Promise.all([
        getBuilderProductAnalytics(params.productId),
        getBuilderProductRevenue(params.productId),
      ]);
      setAnalytics(a);
      setRevenue(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load analytics");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.productId]);

  if (loading) return <div className="text-center py-12 text-gray-400">Loading…</div>;
  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Usage</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <StatCard label="Daily active users" value={String(analytics?.dau ?? 0)} />
          <StatCard label="Monthly active users" value={String(analytics?.mau ?? 0)} />
          <StatCard label="Total users" value={String(analytics?.total_users ?? 0)} />
        </div>
        {analytics?.credits_consumed === null && (
          <p className="text-xs text-gray-400 mt-2">
            Credits consumed isn&apos;t available yet — this requires platform-wide usage
            aggregation not yet wired up.
          </p>
        )}
      </div>

      <div>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
          {revenue?.period} · Revenue
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatCard label="Gross revenue" value={centsToDisplay(revenue?.gross_revenue_cents ?? 0)} />
          <StatCard label="Naelao fee" value={centsToDisplay(revenue?.naelao_fee_cents ?? 0)} muted />
          <StatCard label="Net revenue" value={centsToDisplay(revenue?.net_revenue_cents ?? 0)} />
          <StatCard label="Orders" value={String(revenue?.order_count ?? 0)} muted />
        </div>
      </div>
    </div>
  );
}
