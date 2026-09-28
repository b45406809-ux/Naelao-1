import { describe, expect, it } from "vitest";
import { runSpeculativeModelRace, type ModelRaceDependencies } from "./model-race.js";

const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

describe("SR-EEO", () => {
  it("aborts parallel losers as soon as the oracle passes", async () => {
    const signals: AbortSignal[] = [];
    const dependencies: ModelRaceDependencies = {
      plan: "pro", createBranch: async () => undefined,
      reserveCreditHold: async () => ({ release: async () => undefined }),
      runWorker: async ({ model, signal }) => { signals.push(signal); await delay(model === "winner" ? 1 : 100, signal); },
      runOracle: async ({ branch }) => ({ exitCode: branch.endsWith("winner") ? 0 : 1 }),
      fastForwardMain: async () => undefined,
    };
    const result = await runSpeculativeModelRace("t1", ["winner", "slow"], "fix", "pnpm test", dependencies);
    expect(result.model).toBe("winner");
    expect(result.aborted).toBe(1);
    expect(signals[1]?.aborted).toBe(true);
  });

  it("clamps Starter to one worker at a time", async () => {
    let active = 0, maximum = 0;
    const result = await runSpeculativeModelRace("t2", ["bad", "good"], "fix", "test", {
      plan: "starter", createBranch: async () => undefined,
      reserveCreditHold: async () => ({ release: async () => undefined }),
      runWorker: async () => { active++; maximum = Math.max(maximum, active); await Promise.resolve(); active--; },
      runOracle: async ({ branch }) => ({ exitCode: branch.endsWith("good") ? 0 : 1 }),
      fastForwardMain: async () => undefined,
    });
    expect(result.model).toBe("good");
    expect(maximum).toBe(1);
  });

  it("reserves escrow before creating branches and releases it", async () => {
    const events: string[] = [];
    await runSpeculativeModelRace("t3", ["good"], "fix", "test", {
      plan: "free",
      reserveCreditHold: async (credits) => { events.push(`hold:${credits}`); return { release: async () => { events.push("release"); } }; },
      createBranch: async () => { events.push("branch"); },
      runWorker: async () => undefined,
      runOracle: async () => ({ exitCode: 0 }),
      fastForwardMain: async () => undefined,
    });
    expect(events).toEqual(["hold:30", "branch", "release"]);
  });
});
