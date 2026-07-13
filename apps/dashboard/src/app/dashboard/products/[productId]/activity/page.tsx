"use client";

export const runtime = "edge";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { getAgentActivity } from "@/lib/api";
import type { AgentActivityEntry } from "@/lib/api";

// Tier 2/3 follow-up: agent_activity_log has been built and populated by NaelaoAgentDO (one row
// per run completion/failure and per approval request/resolution) since a prior security-audit
// pass, but had zero consuming UI — a builder had no consolidated way to see what their agent has
// actually been doing, why it escalated, or what it cost. Pure consumer of the already-tested
// GET /spaces/:spaceId/agent-activity — no new backend route.

const EVENT_STYLES: Record<AgentActivityEntry["event_type"], { label: string; className: string }> = {
  run_completed: { label: "Run completed", className: "bg-green-100 text-green-700" },
  run_failed: { label: "Run failed", className: "bg-red-100 text-red-700" },
  approval_requested: { label: "Approval requested", className: "bg-yellow-100 text-yellow-700" },
  approval_resolved: { label: "Approval resolved", className: "bg-blue-100 text-blue-700" },
  moderation_blocked: { label: "Moderation blocked", className: "bg-red-100 text-red-700" },
};

function formatTimestamp(iso: string): string {
  try {
    return new Date(`${iso}Z`).toLocaleString();
  } catch {
    return iso;
  }
}

export default function ProductActivityPage() {
  const params = useParams<{ productId: string }>();
  const [entries, setEntries] = useState<AgentActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await getAgentActivity(params.productId, { limit: 100 });
      setEntries(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load agent activity");
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
    <div className="space-y-4">
      <p className="text-sm text-gray-500">
        What your agents have been doing — run history, escalations, and cost. Newest first, most
        recent 100 events across every project and thread in this product.
      </p>

      {entries.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-gray-400 text-sm">
          No agent activity recorded yet.
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
          {entries.map((entry) => {
            const style = EVENT_STYLES[entry.event_type] ?? { label: entry.event_type, className: "bg-gray-100 text-gray-600" };
            return (
              <div key={entry.id} className="p-4 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${style.className}`}>
                      {style.label}
                    </span>
                    <span className="text-xs text-gray-400">{entry.agent_id}</span>
                    {entry.project_id && (
                      <span className="text-xs text-gray-400">project: {entry.project_id}</span>
                    )}
                  </div>
                  {entry.summary && (
                    <p className="text-sm text-gray-700 mt-1.5 break-words">{entry.summary}</p>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <div className="text-xs text-gray-400">{formatTimestamp(entry.created_at)}</div>
                  {(entry.tokens_used != null || entry.cost_credits != null) && (
                    <div className="text-xs text-gray-500 mt-1">
                      {entry.tokens_used != null && <>{entry.tokens_used.toLocaleString()} tokens</>}
                      {entry.tokens_used != null && entry.cost_credits != null && " · "}
                      {entry.cost_credits != null && <>{entry.cost_credits.toLocaleString()} credits</>}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
