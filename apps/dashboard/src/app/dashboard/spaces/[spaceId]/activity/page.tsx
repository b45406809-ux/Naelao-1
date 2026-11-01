"use client";

export const runtime = "edge";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { getAgentActivity } from "@/lib/api";
import type { AgentActivityEntry } from "@/lib/api";
import { groupAgentActivity } from "@/lib/agent-activity";

const SCOPE_LABEL: Record<NonNullable<AgentActivityEntry["assistant_scope"]>, string> = {
  space_assistant: "Space Assistant",
  project_assistant: "Project Assistant",
  worker: "Worker",
};

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function ActivityPage() {
  const params = useParams<{ spaceId: string }>();
  const spaceId = params.spaceId;
  const [entries, setEntries] = useState<AgentActivityEntry[]>([]);
  const [rootRunId, setRootRunId] = useState("");
  const [rootRunDraft, setRootRunDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getAgentActivity(spaceId, { limit: 200, ...(rootRunId.trim() ? { rootRunId: rootRunId.trim() } : {}) });
      setEntries(result.data ?? []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load assistant activity.");
    } finally {
      setLoading(false);
    }
  }, [spaceId, rootRunId]);

  useEffect(() => { void load(); }, [load]);

  const traces = useMemo(() => groupAgentActivity(entries), [entries]);

  return <div className="mx-auto max-w-5xl px-4 py-8">
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <Link href={`/dashboard/spaces/${encodeURIComponent(spaceId)}`} className="text-sm text-brand-600">← Back to space</Link>
        <h1 className="mt-2 text-2xl font-bold text-gray-900">Assistant run traces</h1>
        <p className="mt-1 max-w-2xl text-sm text-gray-500">Builder audit view linking Space Assistant and Project Assistant runs to delegated workers by root run ID. This view can include operational summaries; access is enforced by the builder-only API.</p>
      </div>
      <button type="button" onClick={() => void load()} disabled={loading} className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 disabled:opacity-50">{loading ? "Refreshing…" : "Refresh"}</button>
    </div>

    <form onSubmit={(event) => { event.preventDefault(); const nextFilter = rootRunDraft.trim(); if (nextFilter === rootRunId) void load(); else setRootRunId(nextFilter); }} className="mb-5 flex gap-2 rounded-xl border border-gray-200 bg-white p-3">
      <label htmlFor="root-run-filter" className="sr-only">Filter by root run ID</label>
      <input id="root-run-filter" value={rootRunDraft} onChange={(event) => setRootRunDraft(event.target.value)} maxLength={256} placeholder="Filter by root run ID" className="min-w-0 flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm" />
      <button type="submit" disabled={loading} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Filter</button>
      {rootRunId && <button type="button" onClick={() => { setRootRunDraft(""); setRootRunId(""); }} className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-600">Clear</button>}
    </form>

    {error && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">Activity unavailable: {error}</p>}
    {!error && !loading && traces.length === 0 && <div className="rounded-xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">No assistant activity found for this Space.</div>}
    {loading && <p className="py-8 text-center text-sm text-gray-500">Loading run traces…</p>}

    <div className="space-y-4">
      {traces.map((trace) => <section key={trace.rootRunId} className="overflow-hidden rounded-xl border border-gray-200 bg-white">
        <header className="border-b border-gray-100 bg-gray-50 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div><h2 className="text-sm font-semibold text-gray-900">Root run</h2><code className="break-all text-xs text-gray-500">{trace.rootRunId}</code></div>
            <span className="rounded-full bg-white px-2.5 py-1 text-xs text-gray-600">{trace.entries.length} {trace.entries.length === 1 ? "event" : "events"}</span>
          </div>
        </header>
        <ol className="divide-y divide-gray-100">
          {trace.entries.map((entry) => <li key={entry.id} className="px-4 py-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">{entry.assistant_scope ? SCOPE_LABEL[entry.assistant_scope] : "Legacy / unknown scope"}</span>
              <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${entry.event_type === "run_failed" || entry.event_type === "moderation_blocked" ? "bg-red-50 text-red-700" : "bg-gray-100 text-gray-700"}`}>{entry.event_type.replaceAll("_", " ")}</span>
              <time className="ml-auto text-xs text-gray-400">{dateLabel(entry.created_at)}</time>
            </div>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm text-gray-700">{entry.summary || "No summary recorded."}</p>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-400">
              <span>Agent {entry.agent_id}</span>
              {entry.project_id && <span>Project {entry.project_id}</span>}
              {entry.parent_run_id && <span>Parent run {entry.parent_run_id}</span>}
              {entry.worker_id && <span>Worker {entry.worker_id}</span>}
              {entry.tokens_used != null && <span>{entry.tokens_used} tokens</span>}
            </div>
          </li>)}
        </ol>
      </section>)}
    </div>
    {!loading && entries.length === 200 && <p className="mt-4 text-center text-xs text-gray-400">Showing the latest 200 rows. Filter by root run ID to inspect a specific trace.</p>}
  </div>;
}
