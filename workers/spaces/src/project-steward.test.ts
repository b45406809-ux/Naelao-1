import { describe, expect, it } from "vitest";
import { rankProjectStewardReviews } from "./project-steward.js";

describe("project steward review ranking", () => {
  it("puts failed routines first and includes factual evidence", () => {
    const reviews = rankProjectStewardReviews([
      { project_id: "quiet", project_name: "Quiet", created_at: "2025-01-01T00:00:00Z", last_activity_at: "2025-01-01T00:00:00Z", failed_routines: [] },
      { project_id: "broken", project_name: "Broken", created_at: "2025-01-01T00:00:00Z", last_activity_at: null, failed_routines: [{ id: "job-a", consecutive_failures: 2 }] },
    ], Date.parse("2026-01-01T00:00:00Z"));
    expect(reviews.map((review) => review.project_id)).toEqual(["broken", "quiet"]);
    expect(reviews[0]).toMatchObject({ recommendation: "inspect_routine", confidence: "high", evidence: [{ kind: "routine_failures", count: 2 }] });
    expect(reviews[1]).toMatchObject({ recommendation: "owner_check_in", confidence: "low", evidence: [{ kind: "inactivity", last_activity_at: "2025-01-01T00:00:00Z" }] });
  });

  it("does not flag recent, invalid-date, or completed-free projects for lifecycle changes", () => {
    const reviews = rankProjectStewardReviews([
      { project_id: "recent", project_name: "Recent", created_at: "2026-01-01T00:00:00Z", last_activity_at: "2026-01-01T00:00:00Z", failed_routines: [] },
      { project_id: "invalid", project_name: "Invalid", created_at: "invalid", last_activity_at: null, failed_routines: [] },
    ], Date.parse("2026-01-15T00:00:00Z"));
    expect(reviews).toEqual([]);
  });

  it("prioritizes blocked project work and includes active-extension evidence for stale projects", () => {
    const reviews = rankProjectStewardReviews([
      { project_id: "stale", project_name: "Stale", created_at: "2025-01-01T00:00:00Z", last_activity_at: "2025-01-01T00:00:00Z", failed_routines: [], pending_task_count: 2, active_extension_count: 1 },
      { project_id: "blocked", project_name: "Blocked", created_at: "2025-01-01T00:00:00Z", last_activity_at: null, failed_routines: [], blocked_task_count: 1 },
    ], Date.parse("2026-01-01T00:00:00Z"));
    expect(reviews.map((review) => review.project_id)).toEqual(["blocked", "stale"]);
    expect(reviews[0]).toMatchObject({ recommendation: "review_blocked_work", confidence: "high", evidence: [{ kind: "blocked_tasks", count: 1 }] });
    expect(reviews[1]?.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "inactivity" }),
      expect.objectContaining({ kind: "pending_tasks", count: 2 }),
      expect.objectContaining({ kind: "active_extensions", count: 1 }),
    ]));
  });

  it("surfaces expired or failed external extension connections before inactivity prompts", () => {
    const reviews = rankProjectStewardReviews([
      { project_id: "connection", project_name: "Connection", created_at: "2026-01-01T00:00:00Z", last_activity_at: "2026-01-01T00:00:00Z", failed_routines: [], unhealthy_extension_connection_count: 2 },
      { project_id: "blocked", project_name: "Blocked", created_at: "2026-01-01T00:00:00Z", last_activity_at: null, failed_routines: [], blocked_task_count: 1 },
    ], Date.parse("2026-01-15T00:00:00Z"));
    expect(reviews.map((review) => review.project_id)).toEqual(["blocked", "connection"]);
    expect(reviews[1]).toMatchObject({ recommendation: "inspect_extension_health", confidence: "high", evidence: [{ kind: "connection_failures", count: 2 }] });
  });

  it("never emits archive, delete, pause, or extension shutdown actions", () => {
    const reviews = rankProjectStewardReviews([
      { project_id: "quiet", project_name: "Quiet", created_at: "2025-01-01T00:00:00Z", last_activity_at: "2025-01-01T00:00:00Z", failed_routines: [] },
    ], Date.parse("2026-01-01T00:00:00Z"));
    expect(JSON.stringify(reviews)).not.toMatch(/archive|delete|pause|shutdown/i);
  });
});
