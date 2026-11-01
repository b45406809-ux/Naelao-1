"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-provider";
import { listSpaces } from "@/lib/api";
import type { Space } from "@/lib/api";

interface ServiceHealth { service: string; status: number; latency_ms: number; ok: boolean }
interface HealthReport { ok: boolean; services: ServiceHealth[] }
const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

export default function DashboardPage() {
  const { claims } = useAuth();
  const [report, setReport] = useState<HealthReport | null>(null);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [spacesError, setSpacesError] = useState<string | null>(null);
  const [spacesLoading, setSpacesLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${apiUrl}/health/dependencies`, { signal: controller.signal })
      .then(async response => {
        const data: unknown = await response.json();
        if (!data || typeof data !== "object" || !Array.isArray((data as HealthReport).services)) throw new Error("Invalid health response");
        setReport(data as HealthReport);
      })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Health check unavailable"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    let active = true;
    listSpaces()
      .then((items) => { if (active) setSpaces(items); })
      .catch((reason: unknown) => { if (active) setSpacesError(reason instanceof Error ? reason.message : "Space list unavailable"); })
      .finally(() => { if (active) setSpacesLoading(false); });
    return () => { active = false; };
  }, []);

  return <div className="mx-auto max-w-5xl">
    <header className="mb-8"><p className="text-sm font-medium text-brand-700">NAELAO TEAM</p>
      <h1 className="mt-1 text-3xl font-bold text-gray-900">Launchpad overview</h1>
      <p className="mt-2 text-gray-500">{claims?.email ?? "Team member"} · Monitor Naelao and manage team tools.</p>
    </header>
    <section className="rounded-2xl border border-gray-200 bg-white p-6">
      <h2 className="text-xl font-semibold text-gray-900">Service health</h2>
      <p className="mt-1 text-sm text-gray-500">A current check of the router’s configured authentication and Spaces services.</p>
      {loading && <p className="mt-5 text-sm text-gray-500">Checking services…</p>}
      {error && <p role="alert" className="mt-5 text-sm text-red-700">Health check unavailable: {error}</p>}
      {report && <ul className="mt-4 divide-y divide-gray-100">{report.services.map(service => <li key={service.service} className="flex items-center justify-between gap-4 py-3 text-sm">
        <span className="font-medium capitalize text-gray-900">{service.service}</span>
        <span className={service.ok ? "text-green-700" : "text-red-700"}>{service.ok ? "Responding" : "Unavailable"} · {service.latency_ms} ms</span>
      </li>)}</ul>}
    </section>
    <section className="mt-6 rounded-2xl border border-gray-200 bg-white p-6">
      <h2 className="text-xl font-semibold text-gray-900">Team tools</h2>
      <p className="mt-1 text-sm text-gray-500">Space Templates and extensions give Launchpad its capabilities. Users create their Spaces within Launchpad.</p>
      <div className="mt-5 flex flex-wrap gap-3">
        <Link href="/dashboard/templates" className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Team Space Templates</Link>
        <Link href="/dashboard/api-keys" className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Team API keys</Link>
      </div>
    </section>
    <section className="mt-6 rounded-2xl border border-gray-200 bg-white p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Spaces</h2>
          <p className="mt-1 text-sm text-gray-500">Tenant-scoped operations and assistant run traces.</p>
        </div>
        <span className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-600">{spaces.length} listed</span>
      </div>
      {spacesError && <p role="alert" className="mt-4 text-sm text-amber-700">Could not load Spaces: {spacesError}</p>}
      {spacesLoading && <p className="mt-4 text-sm text-gray-500">Loading Spaces…</p>}
      {!spacesLoading && !spacesError && spaces.length === 0 && <p className="mt-4 text-sm text-gray-500">No Spaces are available in this tenant yet.</p>}
      {spaces.length > 0 && <ul className="mt-4 divide-y divide-gray-100">{spaces.map((space) => <li key={space.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
        <div className="min-w-0"><p className="truncate text-sm font-medium text-gray-900">{space.name}</p><p className="truncate font-mono text-xs text-gray-400">{space.id}</p></div>
        <Link href={`/dashboard/spaces/${encodeURIComponent(space.id)}`} className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50">Open operations</Link>
      </li>)}</ul>}
    </section>
  </div>;
}
