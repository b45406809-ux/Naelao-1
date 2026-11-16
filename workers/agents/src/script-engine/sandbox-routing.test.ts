import { describe, expect, it } from "vitest";
import { sandboxInstanceName } from "./sandbox-routing.js";

describe("project sandbox routing", () => {
  it("keeps one main computer across the project main and normal feature branches", () => {
    expect(sandboxInstanceName("space-a", "project-a", "main")).toBe("sandbox:space-a:project-a");
    expect(sandboxInstanceName("space-a", "project-a", "feature/update")).toBe("sandbox:space-a:project-a");
  });

  it("isolates delegated worker and speculative model-race branches by exact branch", () => {
    expect(sandboxInstanceName("space-a", "project-a", "workers/task-a"))
      .toBe("sandbox:space-a:project-a:branch:workers/task-a");
    expect(sandboxInstanceName("space-a", "project-a", "workers/task-b"))
      .toBe("sandbox:space-a:project-a:branch:workers/task-b");
    expect(sandboxInstanceName("space-a", "project-a", "race/task/model-a"))
      .toBe("sandbox:space-a:project-a:branch:race/task/model-a");
  });

  it("keeps non-project assistant slots space scoped", () => {
    expect(sandboxInstanceName("space-a")).toBe("sandbox:space-a:_assistant");
  });
});
