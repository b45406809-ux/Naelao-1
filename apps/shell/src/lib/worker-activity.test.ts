import { describe, expect, it } from "vitest";
import { workerActivityLabel } from "./worker-activity";

describe("worker activity labels", () => {
  it("distinguishes active, completed, failed and suspended sessions", () => {
    expect(workerActivityLabel("running")).toBe("Working");
    expect(workerActivityLabel("done")).toBe("Completed");
    expect(workerActivityLabel("awaiting_human_input")).toContain("Waiting");
    expect(workerActivityLabel("awaiting_planner_input")).toContain("planner");
    expect(workerActivityLabel("failed")).toContain("attention");
  });
});
