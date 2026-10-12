import { describe, expect, it, vi } from "vitest";
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

describe("race failure and bounded retry", () => {
  it("attempts later waves and cleans only branches actually created", async () => {
    const created: string[] = [], cleaned: string[] = [];
    const release = vi.fn(async () => undefined);
    const result = await runSpeculativeModelRace("waves", ["a", "b", "c", "d", "e", "unused"], "fix", "test", {
      plan: "pro", reserveCreditHold: async () => ({ release }),
      createBranch: async branch => { created.push(branch); },
      runWorker: async () => undefined,
      runOracle: async ({ branch }) => ({ exitCode: branch.endsWith("-e") ? 0 : 1 }),
      fastForwardMain: async () => undefined,
      cleanupBranch: async branch => { cleaned.push(branch); },
    });
    expect(result.model).toBe("e");
    expect(result.attempted).toBe(created.length);
    expect(created.length).toBeGreaterThan(4);
    expect(cleaned.sort()).toEqual(created.filter(branch => branch !== result.branch).sort());
    expect(release).toHaveBeenCalledOnce();
  });

  it("scores co-settled successes by changed lines and duration", async () => {
    const result = await runSpeculativeModelRace("score", ["larger", "smaller"], "fix", "test", {
      plan: "pro", reserveCreditHold: async () => ({ release: async () => undefined }),
      createBranch: async () => undefined, runWorker: async () => undefined,
      runOracle: async ({ branch }) => ({ exitCode: 0, linesChanged: branch.endsWith("smaller") ? 2 : 10, durationMs: 10 }),
      fastForwardMain: async () => undefined,
    });
    expect(result.model).toBe("smaller");
  });

  it("never promotes a missing exit code and releases escrow after exhaustion", async () => {
    const promote = vi.fn(), release = vi.fn(), cleanup = vi.fn();
    await expect(runSpeculativeModelRace("invalid", ["bad"], "fix", "test", {
      plan: "pro", reserveCreditHold: async () => ({ release }),
      createBranch: async () => undefined, runWorker: async () => undefined,
      runOracle: async () => ({ ok: true } as never), fastForwardMain: promote, cleanupBranch: cleanup,
    })).rejects.toThrow(/human review/);
    expect(promote).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledOnce(); expect(cleanup).toHaveBeenCalledOnce();
  });

  it("cleans the provisional winner and releases escrow when promotion conflicts", async () => {
    const cleaned: string[] = [], release = vi.fn();
    await expect(runSpeculativeModelRace("conflict", ["good"], "fix", "test", {
      plan: "pro", reserveCreditHold: async () => ({ release }),
      createBranch: async () => undefined, runWorker: async () => undefined,
      runOracle: async () => ({ exitCode: 0 }), fastForwardMain: async () => { throw new Error("head conflict"); },
      cleanupBranch: async branch => { cleaned.push(branch); },
    })).rejects.toThrow("head conflict");
    expect(cleaned).toHaveLength(1); expect(release).toHaveBeenCalledOnce();
  });
});

it("retains shared-workspace candidates for review without moving main", async () => {
  const promote = vi.fn(), cleanup = vi.fn();
  const result = await runSpeculativeModelRace("shared", ["good"], "fix", "test", {
    plan: "pro", reserveCreditHold: async () => ({ release: async () => undefined }),
    createBranch: async () => undefined, runWorker: async () => undefined,
    runOracle: async () => ({ exitCode: 0 }), fastForwardMain: promote, cleanupBranch: cleanup,
    submitForReview: async branch => ({ type: "inline_pull_request", forkBranch: branch }),
  });
  expect(result.review).toMatchObject({ type: "inline_pull_request", forkBranch: result.branch });
  expect(promote).not.toHaveBeenCalled(); expect(cleanup).not.toHaveBeenCalled();
});
