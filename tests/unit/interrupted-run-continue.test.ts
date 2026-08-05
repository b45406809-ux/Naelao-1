// A failed run leaves a durable offer to CONTINUE it — and continuing must not redo work.
//
// Reported live, twice: "Ran N step(s) without reaching an answer (completed: project.create,
// project.create)" with a Try again button. Pressing it started a fresh run, which got a fresh
// ledger key, which re-executed project.create — a second project. The fix is that continuing
// re-enters under the ORIGINAL run's ledger key, so anything already recorded replays instead of
// running again; and the offer is stored server-side so it survives a refresh rather than living
// in a page that a reload throws away.

import { describe, it, expect } from "vitest";
import { runScriptLoop, type Reasoner, type ReasonDecision } from "../../workers/agents/src/script-engine/loop.js";
import { ScriptToolSurface } from "../../workers/agents/src/script-engine/tool-surface.js";
import type { ScriptEngineEnv, ScriptRunResult, ActionLedger } from "../../workers/agents/src/script-engine/types.js";

function makeR2(): R2Bucket {
  const store = new Map<string, string>();
  return {
    async put(key: string, value: unknown) { store.set(key, typeof value === "string" ? value : String(value)); return {} as R2Object; },
    async get(key: string) {
      const v = store.get(key);
      return v === undefined ? null : ({ text: async () => v, uploaded: new Date() } as unknown as R2ObjectBody);
    },
    async delete(key: string) { store.delete(key); },
    async list() { return { objects: [], truncated: false } as unknown as R2Objects; },
  } as unknown as R2Bucket;
}

/** Matches the DO's semantics: first write wins (INSERT OR IGNORE). */
function makeLedger(): ActionLedger & { size: () => number } {
  const rows = new Map<string, ScriptRunResult>();
  return {
    async lookup(key, action, hash) { return rows.get(`${key}|${action}|${hash}`) ?? null; },
    async record(key, action, hash, result) {
      const k = `${key}|${action}|${hash}`;
      if (!rows.has(k)) rows.set(k, result);
    },
    size: () => rows.size,
  };
}

function makeEnv() {
  const env: ScriptEngineEnv = { scriptsBucket: makeR2(), spaceId: "s1", agentId: "a1", tenantId: "t1" };
  let putCount = 0;
  const realPut = env.scriptsBucket!.put.bind(env.scriptsBucket);
  env.scriptsBucket!.put = (async (...args: Parameters<R2Bucket["put"]>) => {
    putCount++;
    return realPut(...args);
  }) as R2Bucket["put"];
  return { env, puts: () => putCount };
}

const OPTS = { goal: "set up the project", startupObserve: "observe_filesystem", forceLevel: "L4" as const };

/** Does the work, then never composes an answer — the shape of the reported failure. */
const stubborn: Reasoner = {
  async decide(): Promise<ReasonDecision> {
    return { action: "run", name: "write_file", params: { path: "project.json", content: "{}" } };
  },
};

describe("a failed run is resumable", () => {
  it("reports the work it completed, so a failure can be continued rather than restarted", async () => {
    const { env } = makeEnv();
    env.actionLedger = makeLedger();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);

    const result = await runScriptLoop(env, tools, stubborn, ["r2-workspace"], { ...OPTS, maxSteps: 3 });

    // The failure is honest AND carries its checkpoint — before this, a failed run handed back an
    // error and nothing else, so the only thing a caller could offer was "start over".
    expect(result.result?.ok).toBe(false);
    expect(result.steps_completed?.length).toBeGreaterThan(0);
    expect(result.steps_completed?.[0]?.name).toBe("write_file");
    expect(result.steps_completed?.[0]?.ok).toBe(true);
  });

  it("continuing under the original run's key does NOT re-execute completed actions", async () => {
    const { env, puts } = makeEnv();
    env.actionLedger = makeLedger();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    const originalRunId = "run-original";

    const failed = await runScriptLoop(env, tools, stubborn, ["r2-workspace"], {
      ...OPTS, maxSteps: 3, runId: originalRunId, ledgerKey: originalRunId,
    });
    const afterFailure = puts();

    // What "Continue" does: a NEW run id, but the ORIGINAL ledger key + the recorded steps.
    const answering: Reasoner = {
      async decide(input): Promise<ReasonDecision> {
        if (input.priorSteps?.length) return { action: "answer", text: "Set up — it was already created." };
        return { action: "run", name: "write_file", params: { path: "project.json", content: "{}" } };
      },
    };
    const continued = await runScriptLoop(env, tools, answering, ["r2-workspace"], {
      ...OPTS, maxSteps: 3, runId: "run-continued", ledgerKey: originalRunId,
      resumeSteps: failed.steps_completed ?? [],
    });

    expect(afterFailure).toBe(1);
    expect(puts()).toBe(1);                       // no second project
    expect(continued.result?.ok).toBe(true);
    expect(continued.result?.output).toContain("already created");
  });

  it("a fresh run — what plain 'try again' does — DOES redo the work", async () => {
    // The behaviour being fixed, pinned so the difference is unambiguous rather than asserted
    // only in prose.
    const { env, puts } = makeEnv();
    env.actionLedger = makeLedger();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);

    await runScriptLoop(env, tools, stubborn, ["r2-workspace"], { ...OPTS, maxSteps: 3, ledgerKey: "run-a" });
    await runScriptLoop(env, tools, stubborn, ["r2-workspace"], { ...OPTS, maxSteps: 3, ledgerKey: "run-b" });

    expect(puts()).toBe(2);
  });

  it("carries the completed steps into the continuation so the model can answer from them", async () => {
    const { env } = makeEnv();
    env.actionLedger = makeLedger();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);

    const failed = await runScriptLoop(env, tools, stubborn, ["r2-workspace"], {
      ...OPTS, maxSteps: 3, ledgerKey: "run-x",
    });

    const seen: Array<Parameters<Reasoner["decide"]>[0]> = [];
    const observer: Reasoner = {
      async decide(input): Promise<ReasonDecision> {
        seen.push(input);
        return { action: "answer", text: "done" };
      },
    };
    await runScriptLoop(env, tools, observer, ["r2-workspace"], {
      ...OPTS, maxSteps: 3, ledgerKey: "run-x", resumeSteps: failed.steps_completed ?? [],
    });

    // The continuation's very FIRST decision already knows what happened — it is not rediscovering
    // the work, which is what would make it decide to repeat it.
    expect(seen[0]?.priorSteps?.length).toBeGreaterThan(0);
  });

  it("a successful run still reports its steps, so nothing depends on failure to populate them", async () => {
    const { env } = makeEnv();
    env.actionLedger = makeLedger();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    let n = 0;
    const reasoner: Reasoner = {
      async decide(): Promise<ReasonDecision> {
        n++;
        return n === 1
          ? { action: "run", name: "write_file", params: { path: "a.txt", content: "x" } }
          : { action: "answer", text: "done" };
      },
    };

    const result = await runScriptLoop(env, tools, reasoner, ["r2-workspace"], { ...OPTS, maxSteps: 3 });

    expect(result.result?.ok).toBe(true);
    expect(result.steps_completed).toHaveLength(1);
  });
});
