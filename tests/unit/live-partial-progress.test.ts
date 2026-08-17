import { describe, it, expect } from "vitest";
import { NaelaoAgentDO } from "../../workers/agents/src/do/NaelaoAgentDO.js";
import { createDOSqlStorage } from "./helpers/sqlite-do-shim.js";
import { mergeActivitySteps, type LiveRunStep } from "../../apps/shell/src/lib/api.js";

/**
 * A reasoning step's text now GROWS while the model writes it, which changes what a progress
 * checkpoint means: several checkpoints can describe the same step. Both ends of that have to
 * agree or the feed degenerates into a row per fragment.
 *
 * The DO merges in place (this file's first block) and the client merges by seq (its second), so
 * whichever transport a client is on — the plain poll route sends the full list every tick, the
 * SSE endpoint sends only what changed — it renders one row per real step.
 */

type Reporter = (checkpoint: Record<string, unknown>) => void;

function makeDO(): { doInstance: NaelaoAgentDO; report: Reporter; read: (runId: string) => Promise<{ live_steps?: LiveRunStep[]; partial_answer?: string }> } {
  const ctx = { storage: { sql: createDOSqlStorage() } };
  const doInstance = new NaelaoAgentDO(ctx as never, { PLATFORM_SECRET: "test" } as never);
  // buildLiveProgressReporter is private — reached the same way the loop reaches it, via the DO
  // instance, rather than duplicating its logic in the test.
  const report = (runId: string): Reporter =>
    (doInstance as unknown as { buildLiveProgressReporter(id: string): Reporter }).buildLiveProgressReporter(runId);
  return {
    doInstance,
    report: report("run-1"),
    read: async (runId) => {
      const resp = await doInstance.fetch(new Request(`http://agent-do/runs/${runId}`));
      return resp.json();
    },
  };
}

describe("NaelaoAgentDO — a step that grows while the model writes it", () => {
  it("updates the in-flight step in place instead of appending a row per fragment", async () => {
    const { report, read } = makeDO();

    // The loop's own sequence: a "starting" ping, then partials as the sentence arrives, then the
    // completed step once the call returns.
    report({ phase: "reason", detail: "Thinking…" });
    report({ phase: "reason", detail: "Thinking", partial: true, narration: "Let me " });
    report({ phase: "reason", detail: "Thinking", partial: true, narration: "Let me check " });
    report({ phase: "reason", detail: "Thinking", partial: true, narration: "Let me check your store" });

    const midRun = await read("run-1");
    // One row, not four.
    expect(midRun.live_steps).toHaveLength(1);
    expect(midRun.live_steps![0]!.narration).toBe("Let me check your store");
    expect(midRun.live_steps![0]!.partial).toBe(true);
    expect(midRun.live_steps![0]!.seq).toBe(0);

    // The completed step is a NEW row — it is a different fact ("this finished, here is how long
    // it took"), and collapsing it into the partial is the client's job, not the DO's.
    report({ phase: "reason", detail: "run", duration_ms: 900, ok: true, narration: "Let me check your store" });
    const done = await read("run-1");
    expect(done.live_steps).toHaveLength(2);
    expect(done.live_steps![1]!.duration_ms).toBe(900);
    expect(done.live_steps![1]!.partial).toBeUndefined();
  });

  it("surfaces the answer as it is being written, separately from a finished final_answer", async () => {
    const { report, read } = makeDO();
    report({ phase: "reason", detail: "Thinking…" });
    report({ phase: "reason", partial: true, answer_preview: "You sell " });
    report({ phase: "reason", partial: true, answer_preview: "You sell websites." });

    const midRun = await read("run-1");
    // Named apart from final_answer on purpose: a caller must be able to tell "still growing" from
    // "this is the result", or a client would render a half-sentence as the finished reply.
    expect(midRun.partial_answer).toBe("You sell websites.");
    // The growing answer belongs to the RUN, not to a step — it becomes the reply bubble.
    expect(midRun.live_steps![0]!.narration).toBeUndefined();
  });

  it("starts a new row when a partial arrives for a different phase", async () => {
    const { report, read } = makeDO();
    report({ phase: "run", name: "commerce.list_products", detail: "Running", duration_ms: 12, ok: true });
    report({ phase: "reason", partial: true, narration: "Now I'll draft the emails" });

    const state = await read("run-1");
    expect(state.live_steps).toHaveLength(2);
    expect(state.live_steps![1]!.phase).toBe("reason");
    expect(state.live_steps![1]!.narration).toBe("Now I'll draft the emails");
  });
});

describe("mergeActivitySteps — the client side of the same contract", () => {
  const step = (seq: number, narration?: string): LiveRunStep =>
    ({ seq, phase: "reason", ts: 0, ...(narration ? { narration, partial: true } : {}) }) as LiveRunStep;

  it("replaces a re-sent step rather than appending it again", () => {
    const first = mergeActivitySteps([], [step(0, "Let me ")]);
    const grown = mergeActivitySteps(first, [step(0, "Let me check your store")]);
    expect(grown).toHaveLength(1);
    expect(grown[0]!.narration).toBe("Let me check your store");
  });

  it("appends genuinely new steps and keeps everything in seq order", () => {
    const merged = mergeActivitySteps([step(0, "a"), step(1, "b")], [step(2, "c"), step(0, "a2")]);
    expect(merged.map((s) => s.seq)).toEqual([0, 1, 2]);
    expect(merged[0]!.narration).toBe("a2");
  });

  it("returns the existing list untouched when nothing arrived", () => {
    const existing = [step(0, "a")];
    expect(mergeActivitySteps(existing, [])).toBe(existing);
  });
});
