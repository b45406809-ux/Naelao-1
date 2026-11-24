import { describe, expect, it } from "vitest";
import { sandboxInstanceName } from "./sandbox-routing.js";

describe("project sandbox routing", () => {
  it("routes main, feature, worker and model-race branches to one Project allocation", () => {
    for (const branch of ["main", "feature/update", "workers/task-a", "workers/task-b", "race/task/model-a"]) {
      expect(sandboxInstanceName("space-a", "project-a", branch)).toBe("sandbox:space-a:project-a");
    }
  });

  it("keeps non-project assistant slots space scoped", () => {
    expect(sandboxInstanceName("space-a")).toBe("sandbox:space-a:_assistant");
  });
});
