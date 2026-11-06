import { describe, expect, it, vi } from "vitest";
import { computerUse } from "./computer-use.js";

describe("computer-use context propagation", () => {
  it("passes the authorized run, actor, branch and cancellation context to Tier 6", async () => {
    const run = vi.fn(async () => ({ ok: true, output: "ok" }));
    const signal = new AbortController().signal;
    const context = {
      env: {
        codeRunner: { run },
        spaceId: "s",
        projectId: "p",
        agentId: "a",
        tenantId: "t",
        humanInvokerId: "human",
        userId: "user",
        runId: "r",
        taskId: "task",
        workspaceBranch: "feature/a",
        maxTier: 6 as const,
        executionSignal: signal,
      },
    };
    await computerUse.operations["computer.see"]?.({}, context as never);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user",
        runId: "r",
        taskId: "task",
        workspaceBranch: "feature/a",
        maxTier: 6,
        signal,
      })
    );
  });
});
