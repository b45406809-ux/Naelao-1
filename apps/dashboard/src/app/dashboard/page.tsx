"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { listSpaces, type Space } from "@/lib/api";
import { useAuth } from "@/lib/auth-provider";

export default function DashboardPage() {
  const { claims } = useAuth();
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    listSpaces().then((result) => { if (active) setSpaces(result); })
      .catch((err: unknown) => { if (active) setError(err instanceof Error ? err.message : "Unable to load Spaces"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  return <div className="mx-auto max-w-5xl">
    <header className="mb-8">
      <p className="text-sm font-medium text-brand-700">NAELAO</p>
      <h1 className="mt-1 text-3xl font-bold text-gray-900">Welcome back</h1>
      <p className="mt-2 text-gray-500">{claims?.email ?? "Team member"} · Manage Naelao Spaces and platform tools.</p>
    </header>
    {loading && <p className="py-12 text-center text-gray-400">Loading Spaces…</p>}
    {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-700">{error}</p>}
    {!loading && !error && <section className="rounded-2xl border border-gray-200 bg-white p-6">
      <div className="flex items-center justify-between gap-4">
        <div><h2 className="text-xl font-semibold text-gray-900">Spaces</h2><p className="mt-1 text-sm text-gray-500">Spaces are general work environments. Apply a Space Template when one fits.</p></div>
        <Link href="/dashboard/spaces" className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">Manage Spaces</Link>
      </div>
      <p className="mt-5 text-sm text-gray-600">{spaces.length} {spaces.length === 1 ? "Space" : "Spaces"}</p>
      {spaces.length > 0 && <ul className="mt-3 divide-y divide-gray-100">
        {spaces.slice(0, 5).map((space) => <li key={space.id} className="flex items-center justify-between py-3">
          <span className="font-medium text-gray-900">{space.name}</span><span className="text-xs text-gray-500">{space.spacetype_id}</span>
        </li>)}
      </ul>}
      <div className="mt-6 flex flex-wrap gap-3 border-t border-gray-100 pt-5">
        <Link href="/dashboard/templates" className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Team Space Templates</Link>
        <Link href="/dashboard/api-keys" className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Team API keys</Link>
      </div>
    </section>}
  </div>;
}
