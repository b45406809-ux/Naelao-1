// Exactly-once execution across a replay.
//
// A run can be re-entered: a Workflow restart, or a resume after someone approves a gated action
// hours later. Re-entering means walking the task again from the top. Handing the model its
// completed steps helps it not to repeat them — but being shown is not being prevented, and the
// cost of it deciding to redo one is a second email, a second charge, a second payout.
//
// The ledger is the guarantee rather than the hope. These tests pin the two properties that
// matter: the same action under the same key never executes twice, and a genuinely different run
// is never short-circuited by someone else's work.

import { describe, it, expect } from "vitest";
import { runScriptLoop } from "../../workers/agents/src/script-engine/loop.js";
import { ScriptToolSurface } from "../../workers/agents/src/script-engine/tool-surface.js";
import type { Reasoner, ReasonDecision } from "../../workers/agents/src/script-engine/loop.js";
import type { ActionLedger, ScriptEngineEnv, ScriptRunResult } from "../../workers/agents/src/script-engine/types.js";
import { makeR2Bucket } from "./helpers/r2-bucket.js";

function makeR2(): R2Bucket {
  return makeR2Bucket();
}

/** An in-memory ledger with the same semantics as the DO's: first write wins, never overwritten. */
function makeLedger(): { ledger: ActionLedger; rows: Map<string, ScriptRunResult> } {
  const rows = new Map<string, ScriptRunResult>();
  return {
    rows,
    ledger: {
      async lookup(key, action, hash) { return rows.get(`${key}|${action}|${hash}`) ?? null; },
      async record(key, action, hash, result) {
        const k = `${key}|${action}|${hash}`;
        if (!rows.has(k)) rows.set(k, result);
      },
    },
  };
}

function makeEnv(ledger?: ActionLedger): ScriptEngineEnv {
  const env = { scriptsBucket: makeR2(), spaceId: "space-1", agentId: "agent-1", tenantId: "tenant-1" } as ScriptEngineEnv;
  if (ledger) env.actionLedger = ledger;
  return env;
}

/** Counts real executions, so "did it run again" is measured rather than inferred. */
function countingTools(env: ScriptEngineEnv, executed: string[]): ScriptToolSurface {
  const tools = new ScriptToolSurface(env, ["r2-workspace"]);
  const original = tools.run.bind(tools);
  tools.run = async (name: string, params: Record<string, unknown>) => {
    executed.push(name);
    return original(name, params);
  };
  return tools;
}

function writeThenAnswer(): Reasoner {
  let step = 0;
  return {
    async decide(): Promise<ReasonDecision> {
      return step++ === 0
        ? { action: "run", name: "write_file", params: { path: "a.txt", content: "x", expectedHash: null } }
        : { action: "answer", text: "done" };
    },
  };
}

describe("the action ledger stops a replay redoing real work", () => {
  it("does not execute the same action twice under the same ledger key", async () => {
    const { ledger } = makeLedger();
    const key = "run-original";

    const firstExecuted: string[] = [];
    const env1 = makeEnv(ledger);
    await runScriptLoop(env1, countingTools(env1, firstExecuted), writeThenAnswer(), ["r2-workspace"], {
      goal: "write a file", startupObserve: "observe_filesystem", ledgerKey: key,
    });
    expect(firstExecuted).toEqual(["write_file"]);

    // The replay: same task, fresh run id, same ledger key — as a resume-after-approval is.
    const replayExecuted: string[] = [];
    const env2 = makeEnv(ledger);
    const replay = await runScriptLoop(env2, countingTools(env2, replayExecuted), writeThenAnswer(), ["r2-workspace"], {
      goal: "write a file", startupObserve: "observe_filesystem", ledgerKey: key,
    });
    expect(replayExecuted).toEqual([]); // never ran again
    expect(replay.notes.some((n) => n.includes("already ran under this task"))).toBe(true);
  });

  it("hands back what the action actually returned, not a placeholder", async () => {
    // A short-circuit that loses the result would make the replay's reasoning wrong in a subtler
    // way than re-running would — the model would proceed on a fabricated observation.
    const { ledger } = makeLedger();
    await ledger.record("run-1", "list_files", JSON.stringify({}), {
      ok: true, output: ["ledger.csv"], tier: 1, duration_ms: 5, tokens_used: 0,
    });

    const executed: string[] = [];
    const env = makeEnv(ledger);
    let seen: unknown;
    const reasoner: Reasoner = {
      async decide(input): Promise<ReasonDecision> {
        const prior = (input as { priorSteps?: Array<{ name: string; output?: unknown }> }).priorSteps ?? [];
        if (prior.length === 0) return { action: "run", name: "list_files", params: {} };
        seen = prior[0]?.output;
        return { action: "answer", text: "done" };
      },
    };
    await runScriptLoop(env, countingTools(env, executed), reasoner, ["r2-workspace"], {
      goal: "list", startupObserve: "observe_filesystem", ledgerKey: "run-1",
    });

    expect(executed).toEqual([]);
    expect(seen).toEqual(["ledger.csv"]);
  });

  it("does not short-circuit a genuinely different run", async () => {
    // Doing the same work again in a NEW task is ordinary, not a duplicate — a ledger that
    // blocked it would quietly break repeat work like a daily report.
    const { ledger } = makeLedger();
    const first: string[] = [];
    const env1 = makeEnv(ledger);
    await runScriptLoop(env1, countingTools(env1, first), writeThenAnswer(), ["r2-workspace"], {
      goal: "write", startupObserve: "observe_filesystem", ledgerKey: "run-A",
    });

    const second: string[] = [];
    const env2 = makeEnv(ledger);
    await runScriptLoop(env2, countingTools(env2, second), writeThenAnswer(), ["r2-workspace"], {
      goal: "write", startupObserve: "observe_filesystem", ledgerKey: "run-B",
    });
    expect(second).toEqual(["write_file"]);
  });

  it("only records successes — a failed action must stay retryable", async () => {
    const { ledger, rows } = makeLedger();
    const env = makeEnv(ledger);
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    // An op that doesn't exist fails; recording that would permanently poison the retry.
    const reasoner: Reasoner = {
      async decide(input): Promise<ReasonDecision> {
        const prior = (input as { priorSteps?: unknown[] }).priorSteps ?? [];
        return prior.length === 0
          ? { action: "run", name: "no_such_op", params: {} }
          : { action: "answer", text: "gave up on that one" };
      },
    };
    await runScriptLoop(env, tools, reasoner, ["r2-workspace"], {
      goal: "try something broken", startupObserve: "observe_filesystem", ledgerKey: "run-fail",
    });
    expect(rows.size).toBe(0);
  });

  it("runs normally when no ledger is wired", async () => {
    // Degrading to today's behavior — the model's judgment plus the within-run repeat guard — is
    // the honest fallback. Never a blocked run.
    const executed: string[] = [];
    const env = makeEnv();
    const result = await runScriptLoop(env, countingTools(env, executed), writeThenAnswer(), ["r2-workspace"], {
      goal: "write a file", startupObserve: "observe_filesystem",
    });
    expect(executed).toEqual(["write_file"]);
    expect(result.result?.ok).toBe(true);
  });

  it("does not execute a mutation when its ledger cannot be read", async () => {
    const broken: ActionLedger = {
      async lookup() { throw new Error("ledger unavailable"); },
      async record() { throw new Error("ledger unavailable"); },
    };
    const executed: string[] = [];
    const env = makeEnv(broken);
    const result = await runScriptLoop(env, countingTools(env, executed), writeThenAnswer(), ["r2-workspace"], {
      goal: "write a file", startupObserve: "observe_filesystem", ledgerKey: "run-x",
    });
    expect(executed).toEqual([]);
    expect(JSON.stringify(result)).toContain("action_ledger_unavailable_reconciliation_required");
  });
});


describe("durable mutation claims", () => {
  it("allows only one claimant across 30 concurrent replays", async () => {
    const { ledger } = makeLedger();
    const claims = new Set<string>();
    ledger.claim = async (key, action, hash) => {
      const id = JSON.stringify([key, action, hash]);
      if (claims.has(id)) return false;
      claims.add(id); return true;
    };
    const executed: string[] = [];
    await Promise.all(Array.from({ length: 30 }, async () => {
      const env = makeEnv(ledger);
      return runScriptLoop(env, countingTools(env, executed), writeThenAnswer(), ["r2-workspace"], {
        goal: "write once", startupObserve: "observe_filesystem", ledgerKey: "shared-operation",
      });
    }));
    expect(executed).toEqual(["write_file"]);
  });
  it("holds the operation if the result receipt cannot be persisted", async () => {
    const claims = new Set<string>();
    const ledger: ActionLedger = {
      async lookup() { return null; },
      async claim(key, action, hash) {
        const id = JSON.stringify([key, action, hash]);
        if (claims.has(id)) return false;
        claims.add(id); return true;
      },
      async record() { throw new Error("storage interrupted after execution"); },
    };
    const executed: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const env = makeEnv(ledger);
      const result = await runScriptLoop(env, countingTools(env, executed), writeThenAnswer(), ["r2-workspace"], {
        goal: "write once", startupObserve: "observe_filesystem", ledgerKey: "unknown-operation",
      });
      expect(JSON.stringify(result)).toContain("reconciliation_required");
    }
    expect(executed).toEqual(["write_file"]);
  });
  it("discards an obsolete action when authenticated steering arrives during reasoning", async () => {
    const env = makeEnv(); const executed: string[] = []; let polls = 0; let decisions = 0;
    const reasoner: Reasoner = { async decide() {
      return decisions++ === 0
        ? { action: "run", name: "write_file", params: { path: "obsolete.txt", content: "x", expectedHash: null } }
        : { action: "answer", text: "Updated instructions received." };
    } };
    await runScriptLoop(env, countingTools(env, executed), reasoner, ["r2-workspace"], {
      goal: "write a file", startupObserve: "observe_filesystem",
      pollSteering: async () => ++polls === 2 ? ["Stop editing; summarize only."] : [],
    });
    expect(decisions).toBe(2);
    expect(executed).toEqual([]);
  });
});
