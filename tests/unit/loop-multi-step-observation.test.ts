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
  const store = new Map<string, { bytes: Uint8Array; etag: string; customMetadata: Record<string, string>; uploaded: Date }>();
  let revision = 0;
  const bucket = {
    async put(key: string, value: unknown, options?: R2PutOptions) {
      const previous = store.get(key);
      const onlyIf = options?.onlyIf as { etagMatches?: string; etagDoesNotMatch?: string } | undefined;
      if (onlyIf?.etagMatches !== undefined && previous?.etag !== onlyIf.etagMatches) return null;
      if (onlyIf?.etagDoesNotMatch === "*" && previous) return null;
      const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(typeof value === "string" ? value : String(value));
      const etag = String(++revision);
      store.set(key, { bytes: bytes.slice(), etag, customMetadata: options?.customMetadata ?? {}, uploaded: new Date() });
      return { etag } as R2Object;
    },
    async get(key: string) {
      const item = store.get(key);
      if (!item || item.customMetadata["deleted"] === "true") return null;
      return {
        size: item.bytes.byteLength,
        etag: item.etag,
        uploaded: item.uploaded,
        customMetadata: item.customMetadata,
        async text() { return new TextDecoder().decode(item.bytes); },
        async arrayBuffer() { return item.bytes.slice().buffer; },
      } as unknown as R2ObjectBody;
    },
    async head(key: string) {
      const item = store.get(key);
      return item ? { key, size: item.bytes.byteLength, etag: item.etag, uploaded: item.uploaded, customMetadata: item.customMetadata } as R2Object : null;
    },
    async delete(key: string | string[]) {
      for (const item of Array.isArray(key) ? key : [key]) store.delete(item);
    },
    async list(options?: { prefix?: string }) {
      const prefix = options?.prefix ?? "";
      const objects = [...store.entries()].filter(([key, item]) => key.startsWith(prefix) && item.customMetadata["deleted"] !== "true").map(([key, item]) => ({ key, size: item.bytes.byteLength, etag: item.etag, uploaded: item.uploaded, customMetadata: item.customMetadata }));
      return { objects, truncated: false, cursor: undefined } as unknown as R2Objects;
    },
  };
  return bucket as unknown as R2Bucket;
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
      { action: "run", name: "write_file", params: { path: "a.txt", content: "hello", expectedHash: null } },
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
      { action: "run", name: "write_file", params: { path: "a.txt", content: "hello", expectedHash: null } },
      { action: "answer", text: "done" },
    ]);

    await runScriptLoop(env, tools, reasoner, ["r2-workspace"], LOOP_OPTS);

    // First decision has no history; the second must carry the first step's real outcome.
    expect(seen[0]!.priorSteps).toBeUndefined();
    const prior = seen[1]!.priorSteps!;
    expect(prior).toHaveLength(1);
    expect(prior[0]!.name).toBe("write_file");
    expect(prior[0]!.ok).toBe(true);
    expect(prior[0]!.params).toEqual({ path: "a.txt", content: "hello", expectedHash: null });
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
    // A real write count, not a substring guess — the direct way to prove the repeat guard
    // actually skips re-execution rather than merely relabeling its output.
    let putCount = 0;
    const realPut = env.scriptsBucket.put.bind(env.scriptsBucket);
    env.scriptsBucket.put = (async (...args: Parameters<R2Bucket["put"]>) => {
      putCount++;
      return realPut(...args);
    }) as R2Bucket["put"];
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    // A model that ignores its observations and re-decides the same call forever.
    const { reasoner, seen } = scriptedReasoner([
      { action: "run", name: "write_file", params: { path: "a.txt", content: "x", expectedHash: null } },
    ]);

    await runScriptLoop(env, tools, reasoner, ["r2-workspace"], { ...LOOP_OPTS, maxSteps: 5 });

    // Every step still consults the reasoner (that's the budget bound), but the repeated call is
    // not re-executed — the observation it already produced (the REAL first result, not a vague
    // placeholder — the repeat guard used to always hardcode both `ok: true` and a generic string,
    // even hiding a genuine first-attempt FAILURE behind a false "already ran" success) is handed
    // back instead every time after the first.
    // 5 steps, plus one closing-summary call once they run out — that last one is deliberate:
    // it is what turns "ran out of steps" into a report of what actually happened instead of a
    // bare error. It is bounded at exactly one.
    expect(seen.length).toBeLessThanOrEqual(6);
    expect(putCount).toBe(1);
    const last = seen[seen.length - 1]!.priorSteps!;
    expect(last.length).toBeGreaterThan(1);
    for (const step of last) {
      expect(step.ok).toBe(true);
      expect(step.output).toMatchObject({ ok: true, path: "a.txt" });
    }
  });

  it("records a real trace row for a repeat call — not just a silently-served result", async () => {
    // Live-reported: a repeat attempt's own "reason" step (narration/doing) rendered in the shell
    // with no tool-call table underneath it — this branch used to `continue` with no pushTrace at
    // all, so a genuine repeat left no visible trace even though a real reasoning turn was spent
    // on it. Assert the trace itself, not just priorSteps (which the earlier test already covers).
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    const { reasoner } = scriptedReasoner([
      { action: "run", name: "write_file", params: { path: "a.txt", content: "x", expectedHash: null } },
    ]);

    const result = await runScriptLoop(env, tools, reasoner, ["r2-workspace"], { ...LOOP_OPTS, maxSteps: 3 });

    const runRows = result.trace.filter((t) => t.phase === "run" && t.name === "write_file");
    // First attempt is a real execution; every attempt after it is a repeat, served from cache.
    expect(runRows.length).toBeGreaterThan(1);
    const repeats = runRows.slice(1);
    for (const row of repeats) {
      expect(row.ok).toBe(true);
      expect(row.duration_ms).toBe(0);
      expect(row.detail).toBe("repeated — served the earlier result");
      expect(row.params).toEqual({ path: "a.txt", content: "x", expectedHash: null });
    }
  });

  it("records a real trace row for a repeat of an action still parked pending approval", async () => {
    // Same live-reported gap as the attemptedCalls repeat above, one branch over: a model that
    // re-asks about an action ALREADY parked (deferred.some(...)) used to `continue` with no
    // pushTrace at all, so a second (or third) "Checking on that…" narration also rendered with
    // nothing beneath it.
    const env = makeEnv();
    const asked: string[] = [];
    env.hitlGateway = {
      async requestApproval(params) {
        asked.push(params.actionName);
        return { approvalId: "appr-1", approved: false, pending: true, expiresAt: 1_800_000_000_000 };
      },
    };
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    let step = 0;
    const reasoner: Reasoner = {
      async decide(): Promise<ReasonDecision> {
        // Re-asks for the SAME gated action twice before giving up on it.
        step++;
        if (step <= 2) return { action: "run", name: "write_file", params: { path: "a.txt", content: "x", expectedHash: null } };
        return { action: "answer", text: "Still waiting on that write." };
      },
    };

    const result = await runScriptLoop(env, tools, reasoner, ["r2-workspace"], {
      goal: "write a file",
      startupObserve: "observe_filesystem",
      requiresApprovalFor: [],
      approvalMode: "gate_unless_listed",
    });

    // Only the FIRST attempt actually opens a real approval request — a repeat must not spam a
    // second one for the same action.
    expect(asked).toEqual(["write_file"]);
    const gateRows = result.trace.filter((t) => t.phase === "gate" && t.name === "write_file");
    // One park (the first decision) plus one "still waiting" repeat trace row.
    expect(gateRows.length).toBeGreaterThanOrEqual(2);
    expect(gateRows.every((r) => r.detail === "deferred_pending_approval")).toBe(true);
    expect(gateRows.every((r) => r.params && (r.params as Record<string, unknown>)["path"] === "a.txt")).toBe(true);
  });

  it("still allows the SAME op with DIFFERENT params — that is ordinary work, not a loop", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    const { reasoner, seen } = scriptedReasoner([
      { action: "run", name: "write_file", params: { path: "a.txt", content: "one", expectedHash: null } },
      { action: "run", name: "write_file", params: { path: "b.txt", content: "two", expectedHash: null } },
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
        return { action: "run", name: "write_file", params: { path: `f${n}.txt`, content: "x", expectedHash: null } };
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

describe("the last step is a real deadline, not a cliff", () => {
  it("tells the model when it is on its final turn", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    const { reasoner, seen } = scriptedReasoner([
      { action: "run", name: "write_file", params: { path: "a.txt", content: "x", expectedHash: null } },
      { action: "run", name: "write_file", params: { path: "b.txt", content: "y", expectedHash: null } },
      { action: "answer", text: "done" },
    ]);

    await runScriptLoop(env, tools, reasoner, ["r2-workspace"], { ...LOOP_OPTS, maxSteps: 3 });

    expect(seen[0]?.finalStep).toBeUndefined();
    expect(seen[1]?.finalStep).toBeUndefined();
    expect(seen[2]?.finalStep).toBe(true);
  });

  it("does not execute a tool chosen on the final step", async () => {
    // Running it would spend real side effects on a result nobody can be told about — there is no
    // step left to report it in.
    const env = makeEnv();
    // A real write count, the same way the repeat-guard test above proves non-execution.
    let putCount = 0;
    const realPut = env.scriptsBucket.put.bind(env.scriptsBucket);
    env.scriptsBucket.put = (async (...args: Parameters<R2Bucket["put"]>) => {
      putCount++;
      return realPut(...args);
    }) as R2Bucket["put"];
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    let decided = 0;
    const reasoner: Reasoner = {
      async decide(): Promise<ReasonDecision> {
        decided++;
        return { action: "run", name: "write_file", params: { path: `f${decided}.txt`, content: "x", expectedHash: null } };
      },
    };

    const result = await runScriptLoop(env, tools, reasoner, ["r2-workspace"], { ...LOOP_OPTS, maxSteps: 3 });

    // Three steps were reasoned about, but only the first two were allowed to run — the third
    // landed on the deadline turn and was refused.
    expect(putCount).toBe(2);
    // A live UI bug: the "reason" trace step for that un-run third call carries the model's own
    // status text ("doing"), but nothing recorded that the call itself never happened — so the
    // activity feed showed that status with no row underneath it. A dedicated "gate" trace step
    // is what gives the frontend something concrete to render instead of an orphaned status.
    const skipped = result.trace.filter((s) => s.phase === "gate" && s.detail === "skipped_final_step");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.name).toBe("write_file");
  });

  it("reports work that succeeded instead of failing, when the model can still summarise it", async () => {
    // The exact live failure: a project WAS created, the loop then burned its remaining steps, and
    // the user was shown "Ran 6 step(s) without reaching an answer" with a Try again button — so
    // they retried and created a second project. Successful work must not be reported as failure.
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    const reasoner: Reasoner = {
      async decide(input): Promise<ReasonDecision> {
        // Ignores its own observations and keeps reaching for a tool — until it is told the
        // deadline has arrived, which is the only thing that makes it report back.
        if (input.finalStep) return { action: "answer", text: "I created the project for you." };
        return { action: "run", name: "write_file", params: { path: `f${Math.random()}.txt`, content: "x", expectedHash: null } };
      },
    };

    const result = await runScriptLoop(env, tools, reasoner, ["r2-workspace"], { ...LOOP_OPTS, maxSteps: 3 });

    expect(result.result?.ok).toBe(true);
    expect(result.result?.output).toBe("I created the project for you.");
    expect(result.result?.error).toBeUndefined();
  });

  it("still fails honestly when the model will not summarise even on the deadline", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    const reasoner: Reasoner = {
      async decide(): Promise<ReasonDecision> {
        return { action: "run", name: "write_file", params: { path: `f${Math.random()}.txt`, content: "x", expectedHash: null } };
      },
    };

    const result = await runScriptLoop(env, tools, reasoner, ["r2-workspace"], { ...LOOP_OPTS, maxSteps: 3 });

    expect(result.result?.ok).toBe(false);
    expect(result.result?.error).toMatch(/without reaching an answer/);
  });

  it("never lets the summary attempt itself become the reported failure", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    let calls = 0;
    const reasoner: Reasoner = {
      async decide(): Promise<ReasonDecision> {
        calls++;
        // The closing-summary call (the one after the loop breaks) throws.
        if (calls > 3) throw new Error("reasoner exploded");
        return { action: "run", name: "write_file", params: { path: `f${calls}.txt`, content: "x", expectedHash: null } };
      },
    };

    const result = await runScriptLoop(env, tools, reasoner, ["r2-workspace"], { ...LOOP_OPTS, maxSteps: 3 });

    expect(result.result?.ok).toBe(false);
    expect(result.result?.error).toMatch(/without reaching an answer/);
    expect(result.result?.error).not.toMatch(/exploded/);
  });
});
