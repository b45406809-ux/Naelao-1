"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getNaelaoLaunchpadDashboard } from "@/lib/api";
import type { NaelaoLaunchpadDashboard } from "@/lib/api";

export default function LaunchpadPage() {
  const [dashboard, setDashboard] = useState<NaelaoLaunchpadDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getNaelaoLaunchpadDashboard().then(setDashboard).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : "Unable to load Launchpad");
    });
  }, []);

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Launchpad</h1>
        <p className="text-gray-500 mt-1">Naelao’s product and operating workspace.</p>
      </div>
      {error && <div role="alert" className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3">{error}</div>}
      {!error && !dashboard && <div className="text-center py-12 text-gray-400">Loading Launchpad…</div>}
      {dashboard?.product && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 flex items-center justify-between gap-4">
          <div>
            <h2 className="font-semibold text-gray-900">{dashboard.product.name}</h2>
            <p className="text-sm text-gray-500 mt-1">Status: <span className="capitalize">{dashboard.product.status}</span></p>
          </div>
          <Link href={`/dashboard/products/${encodeURIComponent(dashboard.product.id)}`} className="text-sm font-semibold text-brand-700 hover:underline">Manage Launchpad</Link>
        </div>
      )}
      {dashboard && !dashboard.product && (
        <div className="bg-white rounded-xl border border-dashed border-gray-300 p-10 text-center">
          <h2 className="font-semibold text-gray-900">Launchpad is not initialized</h2>
          {dashboard.can_initialize && <Link href="/dashboard/products/new" className="inline-flex mt-4 px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700">Set up Launchpad</Link>}
        </div>
      )}
    </div>
  );
}
