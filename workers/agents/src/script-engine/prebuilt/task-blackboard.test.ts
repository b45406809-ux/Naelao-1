import { describe, expect, it, vi } from "vitest";
import { taskBlackboard } from "./task-blackboard.js";

describe("task blackboard commands", () => {
  it("requires a host-bound orchestration hook", async () => {
    await expect(taskBlackboard.operations["task_blackboard.read"]!({}, { env: {} } as never)).rejects.toThrow("task_blackboard_unavailable");
  });
  it("forwards commands to the authenticated host without accepting an identity", async () => {
    const hook = vi.fn(async () => ({ ok: true }));
    const ctx = { env: { orchestration: { taskBlackboard: hook } } } as never;
    await taskBlackboard.operations["task_blackboard.recipients"]!({}, ctx);
    const input = { id: "one", recipients: ["worker"], kind: "finding", text: "result" };
    await taskBlackboard.operations["task_blackboard.publish"]!(input, ctx);
    expect(hook).toHaveBeenNthCalledWith(1, "recipients", {});
    expect(hook).toHaveBeenNthCalledWith(2, "publish", input);
  });
});
