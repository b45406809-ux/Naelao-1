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

  it("never emits archive, delete, pause, or extension shutdown actions", () => {
    const reviews = rankProjectStewardReviews([
      { project_id: "quiet", project_name: "Quiet", created_at: "2025-01-01T00:00:00Z", last_activity_at: "2025-01-01T00:00:00Z", failed_routines: [] },
    ], Date.parse("2026-01-01T00:00:00Z"));
    expect(JSON.stringify(reviews)).not.toMatch(/archive|delete|pause|shutdown/i);
  });
});
