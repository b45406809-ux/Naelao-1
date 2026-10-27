"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getNaelaoLaunchpadDashboard } from "@/lib/api";
import type { NaelaoLaunchpadDashboard } from "@/lib/api";
import { useAuth } from "@/lib/auth-provider";

export default function DashboardPage() {
  const { claims } = useAuth();
  const [dashboard, setDashboard] = useState<NaelaoLaunchpadDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    getNaelaoLaunchpadDashboard()
      .then((result) => { if (active) setDashboard(result); })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : "Unable to load Naelao dashboard");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-8">
        <p className="text-sm font-medium text-brand-700">NAELAO PLATFORM</p>
        <h1 className="text-3xl font-bold text-gray-900 mt-1">Welcome back</h1>
        <p className="text-gray-500 mt-2">{claims?.email ?? "Team member"} · Manage the Launchpad product and platform operations.</p>
      </div>

      {loading && <div className="text-center py-12 text-gray-400">Loading Launchpad…</div>}
      {error && <div role="alert" className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3">{error}</div>}

      {!loading && !error && dashboard && (
        <section className="bg-white rounded-2xl border border-gray-200 p-8">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-5">
            <div>
              <p className="text-sm text-gray-500">Naelao product</p>
              <h2 className="text-2xl font-semibold text-gray-900 mt-1">Launchpad</h2>
              <p className="text-sm text-gray-500 mt-2">The product workspace for Naelao and its team.</p>
              {dashboard.product && <p className="text-sm text-gray-500 mt-3">Status: <span className="capitalize text-gray-800">{dashboard.product.status}</span></p>}
            </div>
            {dashboard.product ? (
              <Link href={`/dashboard/products/${encodeURIComponent(dashboard.product.id)}`} className="inline-flex justify-center px-5 py-2.5 rounded-lg bg-brand-600 text-white text-sm font-semibold hover:bg-brand-700">
                Open Launchpad
              </Link>
            ) : dashboard.can_initialize ? (
              <Link href="/dashboard/products/new" className="inline-flex justify-center px-5 py-2.5 rounded-lg bg-brand-600 text-white text-sm font-semibold hover:bg-brand-700">
                Set up Launchpad
              </Link>
            ) : null}
          </div>
          <div className="mt-6 border-t border-gray-100 pt-5">
            <p className="text-sm font-medium text-gray-900">Team tools</p>
            <div className="mt-3 flex flex-wrap gap-3">
              <Link href="/dashboard/templates" className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Private Space Templates</Link>
              <Link href="/dashboard/api-keys" className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Team API keys</Link>
            </div>
          </div>
          {!dashboard.product && <p className="mt-6 pt-5 border-t border-gray-100 text-sm text-gray-500">Launchpad has not been initialized for this team yet.</p>}
        </section>
      )}
    </div>
  );
}
