import { describe, expect, it, vi } from "vitest";
import { subAgent } from "./sub-agent.js";

describe("same-session worker follow-up", () => {
  it("forwards a bounded dependent follow-up with the exact existing worker id", async () => {
    const sendToSubAgent = vi.fn(async (id: string, task: unknown) => ({ id, accepted: task }));
    const result = await subAgent.operations["agent.send"]!({ id: "worker:7", task: "Check the second source" }, {
      env: { orchestration: { sendToSubAgent } }, run: vi.fn(),
    } as never);
    expect(result).toEqual({ id: "worker:7", accepted: "Check the second source" });
    expect(sendToSubAgent).toHaveBeenCalledWith("worker:7", "Check the second source");
  });

  it("rejects empty, oversized, and invalid follow-up requests before host dispatch", async () => {
    const sendToSubAgent = vi.fn();
    const ctx = { env: { orchestration: { sendToSubAgent } }, run: vi.fn() } as never;
    await expect(subAgent.operations["agent.send"]!({ id: "", task: "follow up" }, ctx))
      .resolves.toMatchObject({ reason: "agent.send requires a bounded worker id and follow-up task" });
    await expect(subAgent.operations["agent.send"]!({ id: "worker:7", task: "x".repeat(8 * 1024 + 1) }, ctx))
      .resolves.toMatchObject({ reason: "agent.send requires a bounded worker id and follow-up task" });
    await expect(subAgent.operations["agent.send"]!({ id: "worker:7", task: ["not", "a", "task"] }, ctx))
      .resolves.toMatchObject({ reason: "agent.send requires a bounded worker id and follow-up task" });
    expect(sendToSubAgent).not.toHaveBeenCalled();
  });
});
