// The agent loop is bounded by real resources, not by a step count.
//
// It used to be `for (step = 0; step < (opts.maxSteps ?? 6); step++)`, and the interactive chat
// path never overrode that six. Any task shaped "look this up, then check that, then act, then
// verify" ran out mid-way and was reported as "Ran 6 step(s) without reaching an answer" — work
// that had genuinely happened, presented to the user as a failure.
//
// OpenClaw, the closest comparable, has no step cap at all: its loop runs until the model stops
// requesting tools, with compaction keeping the payload inside the model's context budget. That is
// the right shape, and these tests pin both halves of it — because raising the cap WITHOUT
// compaction would not remove the limit, it would only move the failure from "gave up at six" to
// "overflowed the context somewhere past twenty", which is worse for being opaque.

import { describe, it, expect } from "vitest";
import { runScriptLoop, type Reasoner, type ReasonDecision } from "../../workers/agents/src/script-engine/loop.js";
import { ScriptToolSurface } from "../../workers/agents/src/script-engine/tool-surface.js";
import type { ScriptEngineEnv } from "../../workers/agents/src/script-engine/types.js";
import {
  assessBudget,
  resolveLoopBudget,
  isContextOverflowError,
  DEFAULT_LOOP_BUDGET,
} from "../../workers/agents/src/script-engine/loop-budget.js";
import {
  compactSteps,
  stepLimitsForModel,
  squeezeStepLimits,
  renderStepsForReasoner,
  estimateTokens,
  type LoopStep,
} from "../../workers/agents/src/script-engine/step-context.js";

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

const LOOP_OPTS = { goal: "do the thing", startupObserve: "observe_filesystem" };

/** A reasoner that writes N distinct files and only then answers — the shape of any real
 *  multi-step task, and exactly what a six-step cap made impossible. */
function multiStepReasoner(toolCalls: number) {
  const seen: Array<Parameters<Reasoner["decide"]>[0]> = [];
  let i = 0;
  const reasoner: Reasoner = {
    async decide(input) {
      seen.push(input);
      if (input.finalStep) return { action: "answer", text: "stopped early" };
      if (i < toolCalls) {
        const n = i++;
        return { action: "run", name: "write_file", params: { path: `f${n}.md`, content: `body ${n}` } };
      }
      return { action: "answer", text: `wrote ${toolCalls} files` };
    },
  };
  return { reasoner, seen };
}

describe("the loop runs as many steps as the task needs", () => {
  it("completes a 15-step task that the old six-step cap would have failed", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    const { reasoner, seen } = multiStepReasoner(15);

    const result = await runScriptLoop(env, tools, reasoner, ["r2-workspace"], LOOP_OPTS);

    expect(result.result?.ok).toBe(true);
    expect(result.result?.output).toBe("wrote 15 files");
    // 15 tool calls + the answering turn. Under the old cap this reached step 6 and returned
    // "Ran 6 step(s) without reaching an answer".
    expect(seen.length).toBe(16);
    expect(seen.some((s) => s.finalStep)).toBe(false);
  });

  it("carries every step's real result forward while the history still fits", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    const { reasoner, seen } = multiStepReasoner(5);

    await runScriptLoop(env, tools, reasoner, ["r2-workspace"], LOOP_OPTS);

    const last = seen[seen.length - 1]!;
    expect(last.priorSteps?.length).toBe(5);
    // Nothing folded at this length, so there is no digest and no "you are missing detail" notice.
    expect(last.earlierSteps).toBeUndefined();
  });

  it("reports real progress on every turn, not just the final one", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    const { reasoner, seen } = multiStepReasoner(3);

    await runScriptLoop(env, tools, reasoner, ["r2-workspace"], LOOP_OPTS);

    // Every turn — including the first, before anything has happened — carries a progress
    // object. This used to only ever appear once, and only as `final_step`, on the very last
    // possible turn.
    expect(seen.every((s) => s.progress !== undefined)).toBe(true);
    expect(seen[0]!.progress).toMatchObject({ step: 1, successful_actions: 0, failed_actions: 0, stall_steps: 0 });
    // By the 4th call (after 3 successful tool calls), the model can see all three actually
    // succeeded — real counts, not just "you're on step 4".
    expect(seen[3]!.progress).toMatchObject({ step: 4, successful_actions: 3, failed_actions: 0 });
    // The runaway ceiling is reported so the model knows how much room exists, but it is never
    // mistaken for a target — DECISION_INSTRUCTIONS says so explicitly.
    expect(seen[0]!.progress!.max_steps).toBe(DEFAULT_LOOP_BUDGET.maxSteps);
  });

  it("lets the model stop itself early with a real explanation, using its own progress", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    let calls = 0;
    const reasoner: Reasoner = {
      async decide(input) {
        calls++;
        // A model that fails twice, SEES its own progress (2 failed, 0 succeeded, still far from
        // any external limit), and decides on its own — not because it was told to stop — that
        // this approach isn't working. Nothing here is `finalStep`.
        if (calls <= 2) return { action: "run", name: "does_not_exist", params: {} };
        expect(input.finalStep).toBeFalsy();
        expect(input.progress).toMatchObject({ successful_actions: 0, failed_actions: 2 });
        return { action: "give_up", reason: "tried does_not_exist twice, it isn't a real operation — need a different approach" };
      },
    };

    const result = await runScriptLoop(env, tools, reasoner, ["r2-workspace"], LOOP_OPTS);

    expect(result.result?.ok).toBe(false);
    expect(result.result?.error).toContain("isn't a real operation");
    // Stopped itself after 3 turns, nowhere near the 50-step runaway ceiling — a self-directed
    // stop, not an externally forced one.
    expect(calls).toBe(3);
  });

  it("folds older steps into a digest rather than overflowing a small context window", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    const seen: Array<Parameters<Reasoner["decide"]>[0]> = [];
    // Writes are cheap to record; READS carry the whole file back, so this is the shape that
    // actually grows a payload — 10 reads of a 3KB file is ~7.5k tokens of history against a 2k
    // budget. (A first draft used 20 tiny writes and folded nothing, correctly: they genuinely fit.)
    let i = 0;
    const reasoner: Reasoner = {
      async decide(input) {
        seen.push(input);
        if (input.finalStep) return { action: "answer", text: "stopped early" };
        if (i < 20) {
          const n = i++;
          const file = `f${Math.floor(n / 2)}.md`;
          return n % 2 === 0
            ? { action: "run", name: "write_file", params: { path: file, content: "x".repeat(3000) } }
            : { action: "run", name: "read_file", params: { path: file } };
        }
        return { action: "answer", text: "wrote and read 10 files" };
      },
    };

    const result = await runScriptLoop(env, tools, reasoner, ["r2-workspace"], {
      ...LOOP_OPTS,
      // Deliberately tiny — the point is that a small window shortens the HISTORY, never the run.
      contextWindowTokens: 6000,
    });

    expect(result.result?.ok).toBe(true);
    expect(result.result?.output).toBe("wrote and read 10 files");

    const last = seen[seen.length - 1]!;
    expect(last.earlierSteps).toBeDefined();
    expect(last.earlierSteps!.length).toBeGreaterThan(0);
    // The digest keeps the ARGUMENTS, not just the operation name: "r2-workspace ran" would not
    // stop a model re-writing f0.md, but "it wrote f0.md" does.
    expect(last.earlierSteps!.join("\n")).toContain("f0.md");
    // And the recent window is still real observations, not digest lines all the way down.
    expect(last.priorSteps!.length).toBeGreaterThan(0);
    // Every step is accounted for exactly once, across the two halves.
    expect(last.earlierSteps!.length + last.priorSteps!.length).toBe(20);
  });

  it("the run's own record keeps the FULL results even when the model only sees a digest", async () => {
    // steps_completed backs resume checkpoints and the Continue offer, so it must not inherit the
    // model's truncated view — a resumed run needs the real values, not "… [truncated]".
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    let i = 0;
    const reasoner: Reasoner = {
      async decide(input) {
        if (input.finalStep) return { action: "answer", text: "done" };
        if (i < 12) {
          const n = i++;
          return { action: "run", name: "write_file", params: { path: `f${n}.md`, content: "x".repeat(4000) } };
        }
        // Never answers — forces the exhaustion path, which is what attaches steps_completed.
        return { action: "run", name: "nope", params: { n: i++ } };
      },
    };

    const result = await runScriptLoop(env, tools, reasoner, ["r2-workspace"], {
      ...LOOP_OPTS,
      contextWindowTokens: 6000,
      maxStallSteps: 2,
    });

    expect(result.steps_completed?.length).toBeGreaterThanOrEqual(12);
    // The originals are untouched objects, not the truncated copies handed to the model.
    const written = result.steps_completed!.filter((s) => s.name === "write_file");
    expect(written.length).toBe(12);
    expect(written.every((s) => s.ok)).toBe(true);
  });
});

describe("what actually stops the loop", () => {
  it("stops when the model makes no progress, rather than paying for the same failure forever", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    let calls = 0;
    const reasoner: Reasoner = {
      async decide() {
        calls++;
        // A DIFFERENT failing call each time, so the repeat guard can't catch it — only the stall
        // detector can. This is the case a step count used to guard by accident.
        return { action: "run", name: `missing-${calls}`, params: {} };
      },
    };

    const result = await runScriptLoop(env, tools, reasoner, ["r2-workspace"], {
      ...LOOP_OPTS,
      maxStallSteps: 4,
    });

    expect(result.result?.ok).toBe(false);
    // Stopped on the stall budget, nowhere near the 50-step runaway ceiling.
    expect(calls).toBeLessThanOrEqual(5);
    expect(result.notes.some((n) => n.includes("no progress"))).toBe(true);
  });

  it("a successful call resets the stall count, so slow progress is not mistaken for a loop", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    let i = 0;
    // Fails, fails, succeeds, repeatedly — never four failures in a row, so it must never stall.
    const reasoner: Reasoner = {
      async decide(input) {
        if (input.finalStep) return { action: "answer", text: "wrapped up" };
        const n = i++;
        if (n >= 12) return { action: "answer", text: "got there in the end" };
        if (n % 3 === 2) return { action: "run", name: "write_file", params: { path: `ok${n}.md`, content: "y" } };
        return { action: "run", name: `missing-${n}`, params: {} };
      },
    };

    const result = await runScriptLoop(env, tools, reasoner, ["r2-workspace"], {
      ...LOOP_OPTS,
      maxStallSteps: 4,
    });

    expect(result.result?.ok).toBe(true);
    expect(result.result?.output).toBe("got there in the end");
  });

  it("warns the model one turn before the deadline instead of cutting it off", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    let sawFinal = false;
    const reasoner: Reasoner = {
      async decide(input) {
        if (input.finalStep) {
          sawFinal = true;
          return { action: "answer", text: "here is what I managed to do" };
        }
        return { action: "run", name: "write_file", params: { path: "a.md", content: "1" } };
      },
    };

    const result = await runScriptLoop(env, tools, reasoner, ["r2-workspace"], {
      ...LOOP_OPTS,
      // Already inside the margin, so the very first assessment says "final" rather than
      // "exhausted" — running out of time produces an answer, not a dead end.
      deadlineAt: Date.now() + 1000,
    });

    expect(sawFinal).toBe(true);
    expect(result.result?.ok).toBe(true);
    expect(result.result?.output).toBe("here is what I managed to do");
  });

  it("names WHY it stopped, so 'ran out of time' is distinguishable from 'gave up'", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    // Succeeds once (so there is real work to report), then refuses to ever answer.
    let i = 0;
    const reasoner: Reasoner = {
      async decide() {
        const n = i++;
        return n === 0
          ? { action: "run", name: "write_file", params: { path: "a.md", content: "1" } }
          : { action: "run", name: `missing-${n}`, params: {} };
      },
    };

    const result = await runScriptLoop(env, tools, reasoner, ["r2-workspace"], {
      ...LOOP_OPTS,
      maxStallSteps: 3,
    });

    expect(result.result?.ok).toBe(false);
    // The old message was "Ran 6 step(s) without reaching an answer" — true, and useless.
    expect(result.result?.error).toContain("no progress");
  });
});

describe("a run blocked on a human says so, instead of reading as a failure", () => {
  it("reports what is waiting for approval when nothing else ever succeeded", async () => {
    // Found on a live production run, not in review: the assistant was asked to inspect some
    // files, `list_files` was gated, so it parked one approval and then spent its whole stall
    // budget re-picking the same blocked action. Because no tool had ever SUCCEEDED, the closing
    // summary was skipped entirely and the user got "no terminal action" — a dead end, when the
    // truth was "I need you to approve list_files", which they could have acted on immediately.
    const env: ScriptEngineEnv = {
      ...makeEnv(),
      hitlGateway: {
        async requestApproval() {
          return { approved: false, pending: true, approvalId: "appr-1", expiresAt: Date.now() + 60_000 };
        },
      },
    };
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    const reasoner: Reasoner = {
      // Never answers, and never picks anything but the blocked action — exactly what the live
      // model did.
      async decide(): Promise<ReasonDecision> {
        return { action: "run", name: "list_files", params: {} };
      },
    };

    const result = await runScriptLoop(env, tools, reasoner, ["r2-workspace"], {
      ...LOOP_OPTS,
      requiresApprovalFor: ["list_files"],
      maxStallSteps: 3,
    });

    expect(result.result?.ok).toBe(false);
    expect(result.result?.error).toContain("Waiting on your approval for: list_files");
    // And the approval itself is still carried out, so the UI can offer the button.
    expect(result.deferred_approvals?.[0]?.action_name).toBe("list_files");
  });

  it("still lets the model write its own closing summary when it will", async () => {
    const env: ScriptEngineEnv = {
      ...makeEnv(),
      hitlGateway: {
        async requestApproval() {
          return { approved: false, pending: true, approvalId: "appr-2" };
        },
      },
    };
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    let i = 0;
    const reasoner: Reasoner = {
      async decide(input): Promise<ReasonDecision> {
        if (input.finalStep) return { action: "answer", text: "I need you to approve reading the files first." };
        i++;
        return { action: "run", name: "list_files", params: {} };
      },
    };

    const result = await runScriptLoop(env, tools, reasoner, ["r2-workspace"], {
      ...LOOP_OPTS,
      requiresApprovalFor: ["list_files"],
      maxStallSteps: 3,
    });

    expect(result.result?.ok).toBe(true);
    expect(result.result?.output).toContain("approve reading the files");
    expect(i).toBeGreaterThan(0);
  });
});

describe("context overflow is recovered from, not surrendered to", () => {
  it("compacts harder and retries when the model reports its context overflowing", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    let call = 0;
    const reasoner: Reasoner = {
      async decide() {
        call++;
        if (call === 1) {
          return { action: "give_up", reason: "reasoner gateway error 400: context_length_exceeded" };
        }
        return { action: "answer", text: "recovered and answered" };
      },
    };

    const result = await runScriptLoop(env, tools, reasoner, ["r2-workspace"], LOOP_OPTS);

    expect(result.result?.ok).toBe(true);
    expect(result.result?.output).toBe("recovered and answered");
    expect(result.notes.some((n) => n.includes("context limit"))).toBe(true);
  });

  it("takes a persistent overflow at face value rather than retrying forever", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    let call = 0;
    const reasoner: Reasoner = {
      async decide() {
        call++;
        return { action: "give_up", reason: "prompt is too long for this model" };
      },
    };

    const result = await runScriptLoop(env, tools, reasoner, ["r2-workspace"], LOOP_OPTS);

    expect(result.result?.ok).toBe(false);
    // Two squeezes, then the third is believed — not fifty.
    expect(call).toBe(3);
  });

  it("does not mistake an ordinary give_up for an overflow", async () => {
    const env = makeEnv();
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    let call = 0;
    const reasoner: Reasoner = {
      async decide() {
        call++;
        return { action: "give_up", reason: "the customer's account number is missing" };
      },
    };

    const result = await runScriptLoop(env, tools, reasoner, ["r2-workspace"], LOOP_OPTS);

    expect(call).toBe(1);
    expect(result.result?.error).toContain("account number");
  });
});

describe("budget arithmetic", () => {
  const state = { step: 0, tokensUsed: 0, stallSteps: 0, now: 1_000_000, longestStepMs: 0 };

  it("keeps going when nothing is close to running out", () => {
    expect(assessBudget(DEFAULT_LOOP_BUDGET, state).verdict).toBe("continue");
  });

  it("calls the last affordable turn 'final', not 'exhausted'", () => {
    const budget = resolveLoopBudget({ maxTokens: 10_000 });
    expect(assessBudget(budget, { ...state, tokensUsed: 5_000 }).verdict).toBe("final");
    expect(assessBudget(budget, { ...state, tokensUsed: 10_000 }).verdict).toBe("exhausted");
  });

  it("sizes the deadline margin from the slowest step seen, not a fixed guess", () => {
    const budget = resolveLoopBudget({ deadlineAt: state.now + 40_000 });
    // A run whose steps have taken ~2s has room for another.
    expect(assessBudget(budget, { ...state, longestStepMs: 2_000 }).verdict).toBe("continue");
    // A run whose steps have taken 50s does not, even though the clock says 40s remain.
    expect(assessBudget(budget, { ...state, longestStepMs: 50_000 }).verdict).toBe("final");
  });

  it("treats maxTokens: null as 'no ceiling', distinct from omitting it", () => {
    expect(resolveLoopBudget({ maxTokens: null }).maxTokens).toBeUndefined();
    expect(resolveLoopBudget({}).maxTokens).toBe(DEFAULT_LOOP_BUDGET.maxTokens);
  });

  it("recognises the wording each provider uses for a context overflow", () => {
    expect(isContextOverflowError("context_length_exceeded")).toBe(true);
    expect(isContextOverflowError("This model's maximum context length is 24000 tokens")).toBe(true);
    expect(isContextOverflowError("prompt is too long: 30000 tokens > 24000")).toBe(true);
    expect(isContextOverflowError("invalid api key")).toBe(false);
    expect(isContextOverflowError("the customer has no context for this request")).toBe(false);
  });
});

describe("step compaction", () => {
  const steps = (n: number, size = 100): LoopStep[] =>
    Array.from({ length: n }, (_, i) => ({
      name: "op",
      params: { i },
      ok: true,
      output: "z".repeat(size),
    }));

  it("keeps everything when it fits", () => {
    const out = compactSteps(steps(3), { maxTokens: 10_000, keepRecent: 3, maxObservationChars: 2000 });
    expect(out.compacted).toBe(false);
    expect(out.recent.length).toBe(3);
    expect(out.digest).toEqual([]);
  });

  it("keeps the NEWEST steps, because those are the ones the model has to act on", () => {
    const out = compactSteps(steps(20), { maxTokens: 200, keepRecent: 2, maxObservationChars: 2000 });
    expect(out.compacted).toBe(true);
    expect(out.recent.length).toBeGreaterThan(0);
    expect((out.recent[out.recent.length - 1]!.params as { i: number }).i).toBe(19);
  });

  it("keeps at least keepRecent real observations even when they blow the budget", () => {
    // An agent that can see a digest but not one actual result cannot act on what it just learned.
    const out = compactSteps(steps(20, 8000), { maxTokens: 100, keepRecent: 3, maxObservationChars: 4000 });
    expect(out.recent.length).toBe(3);
    expect(out.omitted).toBe(17);
  });

  it("numbers digest lines against the original run so they line up with the trace", () => {
    const out = compactSteps(steps(10), { maxTokens: 200, keepRecent: 1, maxObservationChars: 500 });
    expect(out.digest[0]).toMatch(/^1\. op\(/);
  });

  it("records a failure as a failure — a digest must never imply work succeeded", () => {
    const out = compactSteps(
      [{ name: "commerce", params: { amount: 500 }, ok: false, error: "insufficient balance" }, ...steps(5)],
      { maxTokens: 120, keepRecent: 1, maxObservationChars: 200 }
    );
    expect(out.digest[0]).toContain("FAILED");
    expect(out.digest[0]).toContain("insufficient balance");
  });

  it("truncates a copy, leaving the caller's own step objects intact for checkpointing", () => {
    const original = steps(4, 9000);
    const out = compactSteps(original, { maxTokens: 100_000, keepRecent: 4, maxObservationChars: 100 });
    expect((out.recent[0]!.output as string).length).toBeLessThan(300);
    expect((original[0]!.output as string).length).toBe(9000);
  });

  it("survives a tool result that cannot be serialised", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic["self"] = cyclic;
    const out = compactSteps([{ name: "weird", params: {}, ok: true, output: cyclic }, ...steps(4)], {
      maxTokens: 120,
      keepRecent: 1,
      maxObservationChars: 200,
    });
    expect(out.digest.length).toBeGreaterThan(0);
  });

  it("tells the model plainly that the folded steps are DONE", () => {
    const rendered = renderStepsForReasoner([], ["1. op({}) → ok"], 2000);
    expect(String(rendered["steps_notice"])).toContain("do not run them again");
    expect(rendered["earlier_steps"]).toEqual(["1. op({}) → ok"]);
  });

  it("omits the notice entirely when nothing was folded", () => {
    const rendered = renderStepsForReasoner([{ name: "op", params: {}, ok: true, output: "x" }], [], 2000);
    expect(rendered["steps_notice"]).toBeUndefined();
    expect(rendered["earlier_steps"]).toBeUndefined();
  });

  it("sizes the history against the model's REAL window, not a nominal one", () => {
    // Llama 3.3 is served at 24k here against a nominal 128k — budgeting on the wrong figure is
    // precisely how a long run would overflow.
    const small = stepLimitsForModel(24_000);
    const large = stepLimitsForModel(200_000);
    expect(small.maxTokens).toBeLessThan(large.maxTokens);
    expect(small.maxObservationChars).toBeLessThan(large.maxObservationChars);
    expect(small.maxTokens).toBeGreaterThanOrEqual(2000);
  });

  it("squeezes hard on an overflow, and never below something usable", () => {
    const once = squeezeStepLimits(stepLimitsForModel(24_000));
    const floor = squeezeStepLimits(squeezeStepLimits(squeezeStepLimits(once)));
    expect(once.maxTokens).toBeLessThan(stepLimitsForModel(24_000).maxTokens);
    expect(floor.keepRecent).toBeGreaterThanOrEqual(1);
    expect(floor.maxObservationChars).toBeGreaterThanOrEqual(400);
  });

  it("estimates tokens the same way the rest of the codebase does", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("")).toBe(0);
  });
});
