import { describe, it, expect } from "vitest";
import { NaelaoAgentDO } from "../../workers/agents/src/do/NaelaoAgentDO.js";
import { createDOSqlStorage } from "./helpers/sqlite-do-shim.js";

/**
 * Close the tab, come back, and the run is still there — with what you missed already loaded.
 *
 * Before this, a run's live progress and its half-written answer lived only in an in-memory map on
 * one DO instance. That map dies with hibernation or eviction, and the client's record of "a run
 * is in flight" lived in sessionStorage, which is per-tab by construction. So the two states a
 * returning person could actually reach were "nothing appears to be happening" and "it finished" —
 * everything in between was lost, even though the run itself kept going the whole time.
 *
 * These tests use a SHARED storage backing across two separately-constructed NaelaoAgentDO
 * instances. That is the point: a second instance is exactly what a hibernated-and-woken DO is, so
 * anything that only ever existed in the first instance's memory is genuinely gone here, the same
 * way it is in production. A test that reused one instance would prove nothing.
 */

async function makeDO(sql: ReturnType<typeof createDOSqlStorage>): Promise<{
  instance: NaelaoAgentDO;
  report: (runId: string, sessionId: string) => (c: Record<string, unknown>) => void;
  finish: (runId: string, terminal: Record<string, unknown>) => void;
  get: (path: string) => Promise<Record<string, unknown>>;
}> {
  const instance = new NaelaoAgentDO({ storage: { sql } } as never, { PLATFORM_SECRET: "test" } as never);
  // Schema is created lazily on the first request, exactly as in production — where every run
  // reaches the progress reporter from inside a fetch. Warm it the same way rather than reaching
  // past the real entry point.
  await instance.fetch(new Request("http://agent-do/active-run?session_id=__warmup"));
  const priv = instance as unknown as {
    buildLiveProgressReporter(runId: string, sessionId?: string): (c: Record<string, unknown>) => void;
    finishLiveRun(runId: string, terminal: Record<string, unknown>): void;
  };
  return {
    instance,
    report: (runId, sessionId) => priv.buildLiveProgressReporter(runId, sessionId),
    finish: (runId, terminal) => priv.finishLiveRun(runId, terminal),
    get: async (path) => (await instance.fetch(new Request(`http://agent-do${path}`))).json(),
  };
}

describe("a run survives the tab being closed", () => {
  it("serves progress and the half-written answer from a DIFFERENT instance", async () => {
    const sql = createDOSqlStorage();
    const first = await makeDO(sql);
    const report = first.report("run-a", "sess-1");

    report({ phase: "observe", detail: "Observing current state", duration_ms: 5, ok: true });
    report({ phase: "reason", detail: "Thinking…" });
    report({ phase: "reason", detail: "Thinking", partial: true, narration: "Let me check your store" });
    report({ phase: "reason", detail: "run", duration_ms: 900, ok: true, narration: "Let me check your store" });
    report({ phase: "run", name: "commerce.list_products", duration_ms: 40, ok: true });

    // The tab closes; this instance is evicted. Everything it held in memory is gone.
    const revived = await makeDO(sql);
    const run = await revived.get("/runs/run-a");

    expect(run["status"]).toBe("running");
    const steps = run["live_steps"] as Array<{ phase: string; narration?: string }>;
    // The narration the model wrote while nobody was watching is still there to be read.
    expect(steps.some((s) => s.narration === "Let me check your store")).toBe(true);
    expect(steps.some((s) => s.phase === "run")).toBe(true);
  });

  it("finds the in-flight run from a session id alone — the only thing a new tab knows", async () => {
    const sql = createDOSqlStorage();
    const first = await makeDO(sql);
    const report = first.report("run-b", "sess-2");
    report({ phase: "reason", detail: "Thinking…" });
    report({ phase: "reason", partial: true, answer_preview: "You sell websites, and" });

    const revived = await makeDO(sql);
    const active = await revived.get("/active-run?session_id=sess-2");
    expect(active["active"]).toBe(true);
    expect(active["run_id"]).toBe("run-b");
    // What you missed arrives WITH the id, so the reply can be painted immediately rather than
    // the person watching a blank space until the next chunk happens to land.
    expect(active["partial_answer"]).toBe("You sell websites, and");
  });

  it("does not offer a run that has already finished", async () => {
    const sql = createDOSqlStorage();
    const first = await makeDO(sql);
    (await first.report("run-c", "sess-3"))({ phase: "reason", detail: "Thinking…" });
    first.finish("run-c", { status: "completed", final_answer: "all done" });

    const revived = await makeDO(sql);
    expect((await revived.get("/active-run?session_id=sess-3"))["active"]).toBe(false);
    // ...but the result itself is still readable, which is what a client polling one beat late
    // needs. Reporting "no such run" for a run that actually succeeded is the failure this avoids.
    const run = await revived.get("/runs/run-c");
    expect(run["status"]).toBe("completed");
    expect(run["final_answer"]).toBe("all done");
  });

  it("writes the final fragment even though partials are throttled", async () => {
    // Partials are written through at most every few hundred ms, so the LAST one is very often
    // the one the throttle skipped — and losing the end of a reply is the most visible way this
    // could fail. finishLiveRun flushes unconditionally.
    const sql = createDOSqlStorage();
    const first = await makeDO(sql);
    const report = first.report("run-d", "sess-4");
    report({ phase: "reason", detail: "Thinking…" });
    report({ phase: "reason", partial: true, answer_preview: "start" });
    report({ phase: "reason", partial: true, answer_preview: "start middle end" });
    first.finish("run-d", { status: "completed", final_answer: "start middle end" });

    const rows = sql.exec(`SELECT partial_answer FROM run_state WHERE run_id = 'run-d'`).toArray() as unknown as Array<{ partial_answer: string }>;
    expect(rows[0]!.partial_answer).toBe("start middle end");
  });

  it("treats a run whose DO died mid-flight as no longer live", async () => {
    // Nothing ever reports a terminal state for a run that was killed outright, so without this
    // it would be offered as "in flight" forever and every new tab would attach to a corpse.
    const sql = createDOSqlStorage();
    (await makeDO(sql)).report("run-e", "sess-5")({ phase: "reason", detail: "Thinking…" });
    sql.exec(`UPDATE run_state SET updated_at = ? WHERE run_id = 'run-e'`, Date.now() - 10 * 60 * 1000);

    const revived = await makeDO(sql);
    expect((await revived.get("/active-run?session_id=sess-5"))["active"]).toBe(false);
  });

  it("reports nothing active for a conversation that has never run anything", async () => {
    const sql = createDOSqlStorage();
    expect((await (await makeDO(sql)).get("/active-run?session_id=unknown-session"))["active"]).toBe(false);
  });
});

// Phase 3 item 23/24 — GET /active-run with NO session_id answers "is this DO instance running
// ANYTHING right now?" (as opposed to the session-scoped question above). This is the scheduled
// job dispatcher's own pending-run check: every wake for a space addresses the SAME
// `{spaceId}:agentId` instance, so it's what lets a busy tick be skipped instead of overlapping.
describe("GET /active-run with no session_id — is this DO instance busy at all", () => {
  it("reports active for a run in flight regardless of which session started it", async () => {
    const sql = createDOSqlStorage();
    const first = await makeDO(sql);
    first.report("run-f", "sess-any")({ phase: "reason", detail: "Thinking…" });

    const revived = await makeDO(sql);
    const active = await revived.get("/active-run");
    expect(active["active"]).toBe(true);
    expect(active["run_id"]).toBe("run-f");
  });

  it("reports inactive once the run has finished", async () => {
    const sql = createDOSqlStorage();
    const first = await makeDO(sql);
    first.report("run-g", "sess-any")({ phase: "reason", detail: "Thinking…" });
    first.finish("run-g", { status: "completed", final_answer: "done" });

    const revived = await makeDO(sql);
    expect((await revived.get("/active-run"))["active"]).toBe(false);
  });

  it("treats a run whose DO died mid-flight as no longer active (same staleness rule as the session-scoped check)", async () => {
    const sql = createDOSqlStorage();
    (await makeDO(sql)).report("run-h", "sess-any")({ phase: "reason", detail: "Thinking…" });
    sql.exec(`UPDATE run_state SET updated_at = ? WHERE run_id = 'run-h'`, Date.now() - 10 * 60 * 1000);

    const revived = await makeDO(sql);
    expect((await revived.get("/active-run"))["active"]).toBe(false);
  });

  it("reports inactive for an instance that has never run anything", async () => {
    const sql = createDOSqlStorage();
    expect((await (await makeDO(sql)).get("/active-run"))["active"]).toBe(false);
  });
});
