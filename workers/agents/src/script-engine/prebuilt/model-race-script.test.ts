import { describe, expect, it, vi } from "vitest";
import { modelRaceScript } from "./model-race-script.js";

describe("model-race prebuilt", () => {
  it("hands a validated race request to the host orchestration hook", async () => {
    const modelRace = vi.fn(async () => ({ model: "winner", branch: "race/t/winner", attempted: 2, aborted: 1 }));
    const result = await modelRaceScript.operations["model.race"](
      { task_id: "t1", models: ["winner", "fallback"], prompt: "fix the bug", test_command: "pnpm test", escrow_credits: 40 },
      { env: { orchestration: { modelRace } } as never, run: vi.fn() },
    );
    expect(modelRace).toHaveBeenCalledWith({
      taskId: "t1", models: ["winner", "fallback"], prompt: "fix the bug", testCommand: "pnpm test", escrowCredits: 40,
    });
    expect(result).toEqual({ ok: true, model: "winner", branch: "race/t/winner", attempted: 2, aborted: 1 });
  });

  it("rejects an incomplete race request before dispatch", async () => {
    await expect(modelRaceScript.operations["model.race"](
      { task_id: "t1", models: [], prompt: "fix", test_command: "test" },
      { env: { orchestration: { modelRace: vi.fn() } } as never, run: vi.fn() },
    )).rejects.toThrow("models[]");
  });
});
