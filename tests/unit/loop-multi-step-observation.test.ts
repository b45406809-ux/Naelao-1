// The reasoning loop feeds tool results back to the model and only ends on answer/give_up.
//
// Found by running the real eval harness against a live deployment (step 4 of the model-matrix
// work), not by reading code: every tool-requiring eval case came back with status "completed"
// and an EMPTY answer, while "what is 2+2" (which needs no tool) worked fine.
//
// Cause: at L3/L4 the loop `return`ed the moment any tool call succeeded, handing that tool's raw
// result back as the run's answer. Two consequences, both severe:
//   1. The model never observed its own tool output, so multi-step work — "look this up, THEN
//      decide" — was structurally impossible. Every run was a single dispatch.
//   2. A user's reply was whatever the tool happened to return. For ops that return no text (most
//      of them), that is an empty message.
// ~2000 unit tests passed throughout, because every test reasoner answered immediately.

import { describe, it, expect } from "vitest";
import { runScriptLoop, type Reasoner, type ReasonDecision } from "../../workers/agents/src/script-engine/loop.js";
import { ScriptToolSurface } from "../../workers/agents/src/script-engine/tool-surface.js";
import type { ScriptEngineEnv } from "../../workers/agents/src/script-engine/types.js";

function makeR2(): R2Bucket {
  const store = new Map<string, string>();
  return {
    async put(key: string, value: unknown) {
      store.set(key, typeof value === "string" ? value : String(value));
      return {} as R2Object;
    },
    async get(key: string) {
      const v = store.get(key);
      if (v === undefined) return null;
      return { text: async () => v, uploaded: new Date() } as unknown as R2ObjectBody;
    },
    async delete(key: string) { store.delete(key); },
    async list() { return { objects: [], truncated: false } as unknown as R2Objects; },
  } as unknown as R2Bucket;
}

function makeEnv(): ScriptEngineEnv {
  return { scriptsBucket: makeR2(), spaceId: "space-1", agentId: "agent-1", tenantId: "tenant-1" };
}

/** A reasoner driven by a fixed script of decisions, recording what it was shown each time. */
function scriptedReasoner(decisions: ReasonDecision[]) {
  const seen: Array<Parameters<Reasoner["decide"]>[0]> = [];
  let i = 0;
  const reasoner: Reasoner = {
    async decide(input) {
      seen.push(input);
      return decisions[Math.min(i++, decisions.length - 1)]!;
    },
  };
  return { reasoner, seen };
}

const LOOP_OPTS = { goal: "do the thing", startupObserve: "observe_filesystem", forceLevel: "L4" as const };

describe("a successful tool call is a STEP, not the end of the run", () => {
  it("keeps going after a tool succeeds and answers on a later step", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    const { reasoner, seen } = scriptedReasoner([
      { action: "run", name: "write_file", params: { path: "a.txt", content: "hello" } },
      { action: "run", name: "read_file", params: { path: "a.txt" } },
      { action: "answer", text: "The file contains: hello" },
    ]);

    const result = await runScriptLoop(env, tools, reasoner, ["r2-workspace"], LOOP_OPTS);

    // The composed answer wins — NOT the raw output of the first tool that happened to succeed.
    expect(result.result?.ok).toBe(true);
    expect(result.result?.output).toBe("The file contains: hello");
    expect(seen).toHaveLength(3);
  });

  it("shows the model what it already ran, and what came back", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    const { reasoner, seen } = scriptedReasoner([
      { action: "run", name: "write_file", params: { path: "a.txt", content: "hello" } },
      { action: "answer", text: "done" },
    ]);

    await runScriptLoop(env, tools, reasoner, ["r2-workspace"], LOOP_OPTS);

    // First decision has no history; the second must carry the first step's real outcome.
    expect(seen[0]!.priorSteps).toBeUndefined();
    const prior = seen[1]!.priorSteps!;
    expect(prior).toHaveLength(1);
    expect(prior[0]!.name).toBe("write_file");
    expect(prior[0]!.ok).toBe(true);
    expect(prior[0]!.params).toEqual({ path: "a.txt", content: "hello" });
  });

  it("reports a failed step honestly rather than hiding it", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    const { reasoner, seen } = scriptedReasoner([
      { action: "run", name: "definitely_not_a_real_op", params: {} },
      { action: "answer", text: "couldn't do that, here's why" },
    ]);

    await runScriptLoop(env, tools, reasoner, ["r2-workspace"], LOOP_OPTS);

    const prior = seen[1]!.priorSteps!;
    expect(prior[0]!.ok).toBe(false);
    expect(prior[0]!.error).toBeTruthy();
  });
});

describe("the loop cannot be made to spin on one repeated call", () => {
  it("runs an identical call once, then serves the result it already has", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    // A model that ignores its observations and re-decides the same call forever.
    const { reasoner, seen } = scriptedReasoner([
      { action: "run", name: "write_file", params: { path: "a.txt", content: "x" } },
    ]);

    await runScriptLoop(env, tools, reasoner, ["r2-workspace"], { ...LOOP_OPTS, maxSteps: 5 });

    // Every step still consults the reasoner (that's the budget bound), but the repeated call is
    // not re-executed — the observation it already produced is handed back instead.
    expect(seen.length).toBeLessThanOrEqual(5);
    const repeats = seen[seen.length - 1]!.priorSteps!.filter((s) => String(s.output ?? "").includes("already run"));
    expect(repeats.length).toBeGreaterThan(0);
  });

  it("still allows the SAME op with DIFFERENT params — that is ordinary work, not a loop", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    const { reasoner, seen } = scriptedReasoner([
      { action: "run", name: "write_file", params: { path: "a.txt", content: "one" } },
      { action: "run", name: "write_file", params: { path: "b.txt", content: "two" } },
      { action: "answer", text: "wrote both" },
    ]);

    await runScriptLoop(env, tools, reasoner, ["r2-workspace"], LOOP_OPTS);

    const prior = seen[2]!.priorSteps!;
    expect(prior).toHaveLength(2);
    expect(prior.every((s) => !String(s.output ?? "").includes("already run"))).toBe(true);
  });
});

describe("running out of steps without an answer", () => {
  it("FAILS honestly, naming the work that did complete", async () => {
    // The live failure this whole change set came from: the model looped on an op, ran out of
    // steps, and the user got status=completed with a blank message. There is no reliable way to
    // tell a tool receipt from a real result, so a run that never composed an answer reports
    // exactly that — with the completed steps named, so nothing is silently thrown away.
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    let n = 0;
    const reasoner: Reasoner = {
      async decide(): Promise<ReasonDecision> {
        n++;
        return { action: "run", name: "write_file", params: { path: `f${n}.txt`, content: "x" } };
      },
    };

    const result = await runScriptLoop(env, tools, reasoner, ["r2-workspace"], { ...LOOP_OPTS, maxSteps: 3 });

    expect(result.result?.ok).toBe(false);
    expect(result.result?.error).toMatch(/without reaching an answer/);
    expect(result.result?.error).toContain("write_file");
  });

  it("gives up honestly when nothing ever succeeded", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    const reasoner: Reasoner = {
      async decide(): Promise<ReasonDecision> {
        return { action: "run", name: "not_a_real_op", params: { n: Math.random() } };
      },
    };

    const result = await runScriptLoop(env, tools, reasoner, ["r2-workspace"], { ...LOOP_OPTS, maxSteps: 3 });
    expect(result.result?.ok).toBe(false);
  });
});
