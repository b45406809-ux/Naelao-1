import { describe, expect, it } from "vitest";
import { resourceQueuePartition } from "./resource-queue-scope.js";

describe("resource queue scope", () => {
  it("shares Space-wide and per-user runtime contention across projects", () => {
    expect(resourceQueuePartition("project-a", "runtime.space.abc")).toBe("_");
    expect(resourceQueuePartition("project-b", "runtime.user.def")).toBe("_");
    expect(resourceQueuePartition("project-a", "worker.execution")).toBe("_");
    expect(resourceQueuePartition("project-b", "worker.execution")).toBe("_");
  });

  it("keeps project runtime contention isolated to its project", () => {
    expect(resourceQueuePartition("project-a", "runtime.project.abc")).toBe("project-a");
    expect(resourceQueuePartition("project-b", "runtime.project.abc")).toBe("project-b");
    expect(resourceQueuePartition(undefined, "project.container")).toBe("_");
  });
});
