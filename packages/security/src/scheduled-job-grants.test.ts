import { describe, expect, it } from "vitest";
import { parseScheduledJobGrantConfig, validateScheduledJobGrantConfig } from "./scheduled-job-grants.js";

describe("scheduled job grant config", () => {
  it("normalizes explicit action grants and accepts an unset per-run ceiling", () => {
    expect(validateScheduledJobGrantConfig(["task.update", "project.list"], 250)).toEqual({
      approvedActions: ["project.list", "task.update"], maxRunCredits: 250,
    });
    expect(parseScheduledJobGrantConfig('["project.list"]', 250)).toEqual({ approvedActions: ["project.list"], maxRunCredits: 250 });
  });

  it("rejects malformed names, duplicates, unknown shapes and unbounded budgets", () => {
    expect(validateScheduledJobGrantConfig(["task.update", "task.update"], 10)).toBeNull();
    expect(validateScheduledJobGrantConfig(["*"], 10)).toBeNull();
    expect(validateScheduledJobGrantConfig(["task.update"], 1_000_001)).toBeNull();
    expect(validateScheduledJobGrantConfig(["task.update"], 0)).toBeNull();
    expect(parseScheduledJobGrantConfig("not-json", 1)).toBeNull();
  });
});
