import { describe, expect, it } from "vitest";
import { isProjectStewardDecisionAction, projectStewardReviewKey } from "./project-steward-decisions.js";
import type { ProjectStewardReview } from "./project-steward.js";

const review: ProjectStewardReview = {
  project_id: "project-a", project_name: "Research", recommendation: "owner_check_in", confidence: "low", priority: 35,
  evidence: [{ kind: "inactivity", days: 35, last_activity_at: "2026-09-01T00:00:00.000Z" }],
};

describe("Project Steward decision identity", () => {
  it("keys decisions to stable review evidence and changes when evidence changes", async () => {
    expect(await projectStewardReviewKey(review)).toBe(await projectStewardReviewKey({ ...review, priority: 90 }));
    expect(await projectStewardReviewKey(review)).not.toBe(await projectStewardReviewKey({
      ...review, evidence: [{ kind: "inactivity", days: 36, last_activity_at: "2026-08-31T00:00:00.000Z" }],
    }));
  });

  it("accepts only the supported non-mutating review decisions", () => {
    expect(["acknowledge", "snooze", "dismiss"].every(isProjectStewardDecisionAction)).toBe(true);
    expect(isProjectStewardDecisionAction("archive")).toBe(false);
    expect(isProjectStewardDecisionAction("pause_extensions")).toBe(false);
  });
});
