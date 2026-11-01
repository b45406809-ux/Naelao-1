import type { AgentActivityEntry } from "./api";

export interface AgentActivityTrace {
  rootRunId: string;
  entries: AgentActivityEntry[];
  latest: string;
}

/** Correlate assistant and delegated-worker activity while keeping unlinked legacy rows separate. */
export function groupAgentActivity(entries: AgentActivityEntry[]): AgentActivityTrace[] {
  const grouped = new Map<string, AgentActivityEntry[]>();
  for (const entry of entries) {
    const key = entry.root_run_id || `unlinked:${entry.id}`;
    const group = grouped.get(key) ?? [];
    group.push(entry);
    grouped.set(key, group);
  }
  return [...grouped.entries()].map(([key, rows]) => ({
    rootRunId: key.startsWith("unlinked:") ? "Unlinked activity" : key,
    entries: rows.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)),
    latest: rows.reduce((latest, row) => Date.parse(row.created_at) > Date.parse(latest) ? row.created_at : latest, rows[0]?.created_at ?? ""),
  })).sort((a, b) => Date.parse(b.latest) - Date.parse(a.latest));
}
