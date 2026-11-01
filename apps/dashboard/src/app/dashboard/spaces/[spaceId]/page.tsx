"use client";

export const runtime = "edge";

import Link from "next/link";
import { useParams } from "next/navigation";

const PANELS = [
  ["activity", "Assistant run traces", "Follow Space Assistant and Project Assistant runs through delegated workers."],
  ["sessions", "Live sessions", "Monitor active user sessions."],
  ["eval", "Evaluations", "Run agent evaluation suites and inspect results."],
  ["connectors", "Connectors", "Review external platform connections."],
  ["credentials", "Credentials", "Manage credentials available to this Space."],
  ["kb", "Knowledge base", "Inspect indexed knowledge sources."],
  ["webhooks", "Webhooks", "Manage event delivery endpoints."],
] as const;

export default function SpaceToolsPage() {
  const params = useParams<{ spaceId: string }>();
  const spaceId = params.spaceId;
  return <div className="mx-auto max-w-5xl px-4 py-8">
    <Link href="/dashboard" className="text-sm text-brand-600">← Dashboard</Link>
    <h1 className="mt-2 text-2xl font-bold text-gray-900">Space operations</h1>
    <p className="mt-1 break-all text-sm text-gray-500">Space ID: {spaceId}</p>
    <div className="mt-6 grid gap-4 sm:grid-cols-2">
      {PANELS.map(([path, title, description]) => <Link key={path} href={`/dashboard/spaces/${encodeURIComponent(spaceId)}/${path}`} className="rounded-xl border border-gray-200 bg-white p-5 transition hover:border-brand-300 hover:shadow-sm">
        <h2 className="font-semibold text-gray-900">{title}</h2>
        <p className="mt-1 text-sm text-gray-500">{description}</p>
      </Link>)}
    </div>
  </div>;
}
