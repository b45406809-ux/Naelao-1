import { describe, expect, it } from "vitest";
import type { AgentActivityEntry } from "../../apps/dashboard/src/lib/api";
import { groupAgentActivity } from "../../apps/dashboard/src/lib/agent-activity";

function activity(id: string, rootRunId: string | null, createdAt: string, scope: AgentActivityEntry["assistant_scope"]): AgentActivityEntry {
  return {
    id,
    space_id: "space-a",
    project_id: scope === "project_assistant" ? "project-a" : null,
    thread_id: null,
    agent_id: id,
    event_type: "run_completed",
    summary: id,
    assistant_scope: scope,
    root_run_id: rootRunId,
    parent_run_id: scope === "worker" ? "run-project" : null,
    worker_id: scope === "worker" ? "worker-a" : null,
    tokens_used: null,
    cost_credits: null,
    created_at: createdAt,
  };
}

describe("dashboard assistant activity grouping", () => {
  it("joins root assistant and delegated worker records under the shared root run", () => {
    const traces = groupAgentActivity([
      activity("worker", "run-space", "2026-11-01T10:00:02Z", "worker"),
      activity("project-assistant", "run-project", "2026-11-01T10:00:03Z", "project_assistant"),
      activity("space-assistant", "run-space", "2026-11-01T10:00:01Z", "space_assistant"),
      activity("project-worker", "run-project", "2026-11-01T10:00:04Z", "worker"),
    ]);

    expect(traces.map((trace) => trace.rootRunId)).toEqual(["run-project", "run-space"]);
    expect(traces.find((trace) => trace.rootRunId === "run-space")?.entries.map((entry) => entry.assistant_scope))
      .toEqual(["space_assistant", "worker"]);
    expect(traces.find((trace) => trace.rootRunId === "run-project")?.entries.map((entry) => entry.assistant_scope))
      .toEqual(["project_assistant", "worker"]);
    expect(traces.find((trace) => trace.rootRunId === "run-project")?.entries[1]).toMatchObject({ parent_run_id: "run-project", worker_id: "worker-a" });
  });

  it("keeps legacy rows without correlation IDs isolated", () => {
    const traces = groupAgentActivity([
      activity("legacy-a", null, "2026-11-01T10:00:01Z", null),
      activity("legacy-b", null, "2026-11-01T10:00:02Z", null),
    ]);

    expect(traces).toHaveLength(2);
    expect(traces.every((trace) => trace.rootRunId === "Unlinked activity" && trace.entries.length === 1)).toBe(true);
  });
});
