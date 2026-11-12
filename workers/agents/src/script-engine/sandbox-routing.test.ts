import { describe, expect, it } from "vitest";
import { sandboxInstanceName } from "./sandbox-routing.js";

describe("project sandbox routing", () => {
  it("keeps one main computer across normal project branches", () => {
    expect(sandboxInstanceName("space-a", "project-a", "main")).toBe("sandbox:space-a:project-a");
    expect(sandboxInstanceName("space-a", "project-a", "feature/update")).toBe("sandbox:space-a:project-a");
  });

  it("keeps speculative model-race branches on isolated computers", () => {
    expect(sandboxInstanceName("space-a", "project-a", "race/task/model-a"))
      .toBe("sandbox:space-a:project-a:branch:race/task/model-a");
  });

  it("keeps non-project assistant slots space scoped", () => {
    expect(sandboxInstanceName("space-a")).toBe("sandbox:space-a:_assistant");
  });
});
