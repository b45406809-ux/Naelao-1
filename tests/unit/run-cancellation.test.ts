import { describe, it, expect } from "vitest";
import { runScriptLoop } from "../../workers/agents/src/script-engine/loop.js";
import { NaelaoAgentDO } from "../../workers/agents/src/do/NaelaoAgentDO.js";
import { createDOSqlStorage } from "./helpers/sqlite-do-shim.js";
import { ScriptToolSurface } from "../../workers/agents/src/script-engine/tool-surface.js";
import type { Reasoner } from "../../workers/agents/src/script-engine/loop.js";

/**
 * Stopping a run.
 *
 * The route existed and did nothing useful: `handleCancelRun` read `agent_runs`, a table only the
 * retired ReAct path ever wrote to, so cancelling 404'd for every run a person could actually want
 * to stop. And nothing checked a cancel flag anyway — setting a row to "cancelled" does not stop a
 * loop that never looks at it.
 *
 * Cancellation is cooperative by design. A run mid-way through a tool call cannot be torn down
 * safely: the side effect it is performing either happened or did not, and killing it partway
 * leaves nobody able to say which. So it finishes the action it is in, stops at the next step
 * boundary, and reports what it genuinely completed.
 */

function makeEnv() {
  const store = new Map<string, string>();
  return {
    r2: {
      async put(k: string, v: unknown) { store.set(k, String(v)); return {} as R2Object; },
      async get(k: string) {
        if (!store.has(k)) return null;
        const t = store.get(k)!;
        return { size: t.length, uploaded: new Date(), async text() { return t; } } as unknown as R2ObjectBody;
      },
      async head(k: string) { return store.has(k) ? ({} as R2Object) : null; },
      async delete() {},
      async list() { return { objects: [], truncated: false } as unknown as R2Objects; },
    } as unknown as R2Bucket,
  };
}

/** A model that would keep going forever if nothing stopped it. */
function relentlessReasoner(): Reasoner {
  return {
    async decide() {
      return { action: "run", name: "code.execute_bash", params: { command: "echo hi" } };
    },
  } as unknown as Reasoner;
}

describe("stopping a run", () => {
  it("stops at the next step boundary and reports the work already done", async () => {
    const { r2 } = makeEnv();
    const env = { scriptsBucket: r2, spaceId: "s1", agentId: "a1" } as never;
    const tools = new ScriptToolSurface(env, []);
    let steps = 0;

    const result = await runScriptLoop(env, tools, relentlessReasoner(), [], {
      goal: "keep going",
      // Cancel after the loop has genuinely taken a couple of turns, so this proves it STOPS
      // rather than never having started.
      shouldCancel: () => ++steps > 2,
      escalation: { confidenceFloor: 1 },
    });

    // ok:false (not true) is deliberate — it's what makes NaelaoAgentDO.handleScriptRun
    // checkpoint an interrupted-run offer to Continue, instead of silently treating a stop as an
    // ordinary completed answer with nothing to resume. `error` carries the exact marker
    // packages/events' classifyFailure matches to "user_cancelled".
    expect(result.result.ok).toBe(false);
    expect(result.result.error).toBe("Stopped by you before finishing.");
    expect(String(result.result.output)).toContain("Stopped");
    // Without the check the loop would run to its runaway ceiling; three boundaries proves the
    // stop is what ended it.
    expect(steps).toBeLessThanOrEqual(4);
    expect(result.notes.some((n) => n.includes("user's request"))).toBe(true);
  });

  it("never checks for cancellation when no caller asked to be able to stop", async () => {
    // A cron wake, a channel drain and a sub-agent have nobody watching. They must behave exactly
    // as before, with no added per-step work.
    const { r2 } = makeEnv();
    const env = { scriptsBucket: r2, spaceId: "s1", agentId: "a1" } as never;
    const tools = new ScriptToolSurface(env, []);
    const answering = { async decide() { return { action: "answer", text: "done" }; } } as unknown as Reasoner;
    const result = await runScriptLoop(env, tools, answering, [], { goal: "hi", escalation: { confidenceFloor: 1 } });
    expect(result.result.ok).toBe(true);
    expect(String(result.result.output)).not.toContain("Stopped");
  });
});

describe("the DO's cancel endpoint", () => {
  async function makeDO() {
    const sql = createDOSqlStorage();
    const instance = new NaelaoAgentDO({ storage: { sql } } as never, { PLATFORM_SECRET: "t" } as never);
    await instance.fetch(new Request("http://agent-do/active-run?session_id=__warm"));
    return { instance, sql };
  }

  it("accepts a cancel for a script-native run, which has no agent_runs row at all", async () => {
    const { instance } = await makeDO();
    (instance as unknown as { buildLiveProgressReporter(r: string, s?: string): (c: Record<string, unknown>) => void })
      .buildLiveProgressReporter("run-1", "sess-1")({ phase: "reason", detail: "Thinking…" });

    const resp = await instance.fetch(new Request("http://agent-do/runs/run-1/cancel", { method: "POST" }));
    expect(resp.status).toBe(200);
    expect((await resp.json<{ status: string }>()).status).toBe("cancelling");
    // And the loop's own check sees it — which is what actually stops anything.
    expect((instance as unknown as { isCancelRequested(r: string): boolean }).isCancelRequested("run-1")).toBe(true);
  });

  it("is honoured by an instance that was not the one running it", async () => {
    // A cancel can land on a woken instance rather than the one executing, so the flag has to be
    // durable — an in-memory set alone would silently drop the request.
    const sql = createDOSqlStorage();
    const first = new NaelaoAgentDO({ storage: { sql } } as never, { PLATFORM_SECRET: "t" } as never);
    await first.fetch(new Request("http://agent-do/active-run?session_id=__warm"));
    (first as unknown as { buildLiveProgressReporter(r: string, s?: string): (c: Record<string, unknown>) => void })
      .buildLiveProgressReporter("run-2", "sess-2")({ phase: "reason", detail: "Thinking…" });
    await first.fetch(new Request("http://agent-do/runs/run-2/cancel", { method: "POST" }));

    const revived = new NaelaoAgentDO({ storage: { sql } } as never, { PLATFORM_SECRET: "t" } as never);
    expect((revived as unknown as { isCancelRequested(r: string): boolean }).isCancelRequested("run-2")).toBe(true);
  });

  it("does not report a stop for a run this DO has never heard of", async () => {
    const { instance } = await makeDO();
    const resp = await instance.fetch(new Request("http://agent-do/runs/nope/cancel", { method: "POST" }));
    expect(resp.status).toBe(404);
  });
});
