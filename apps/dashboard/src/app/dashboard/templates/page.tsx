"use client";

import { useEffect, useState } from "react";
import { listTeamPrivateTemplates, type TeamPrivateSpaceTemplate } from "@/lib/api";

export default function TeamTemplatesPage() {
  const [items, setItems] = useState<TeamPrivateSpaceTemplate[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    listTeamPrivateTemplates().then(value => { if (active) setItems(value); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "Team template access is unavailable."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  return <div className="mx-auto max-w-5xl">
    <div className="mb-6">
      <p className="text-sm font-medium text-brand-700">NAELAO TEAM</p>
      <h1 className="mt-1 text-2xl font-bold text-gray-900">Private Space Templates</h1>
      <p className="mt-2 text-sm text-gray-500">Team-only dogfood templates. They are not visible in the public marketplace.</p>
    </div>
    {loading && <p className="py-10 text-center text-gray-400">Loading team templates…</p>}
    {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
    {!loading && !error && items.map(({ template }) => <article key={template.id} className="rounded-xl border border-gray-200 bg-white p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><span className="rounded bg-violet-50 px-2 py-1 text-xs font-medium text-violet-700">Team private</span>
          <h2 className="mt-3 text-xl font-semibold text-gray-900">{template.metadata.name}</h2>
          <p className="mt-1 text-sm text-gray-600">{template.metadata.description}</p>
        </div>
        <code className="rounded bg-gray-50 px-2 py-1 text-xs text-gray-500">{template.id}</code>
      </div>
      <div className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
        <div className="rounded-lg border border-gray-100 p-3"><span className="text-gray-500">Projects</span><p className="mt-1 font-medium text-gray-900">{template.projects.length}</p></div>
        <div className="rounded-lg border border-gray-100 p-3"><span className="text-gray-500">Required extensions</span><p className="mt-1 font-medium text-gray-900">{template.requiredExtensions.join(", ") || "None"}</p></div>
      </div>
      <details className="mt-5"><summary className="cursor-pointer text-sm font-medium text-brand-700">Inspect template blueprint</summary>
        <pre className="mt-3 max-h-96 overflow-auto rounded-lg bg-gray-950 p-4 text-xs text-gray-100">{JSON.stringify(template, null, 2)}</pre>
      </details>
    </article>)}
    {!loading && !error && !items.length && <p className="rounded-lg border border-gray-200 bg-white p-8 text-center text-sm text-gray-500">No private team templates are available.</p>}
  </div>;
}
