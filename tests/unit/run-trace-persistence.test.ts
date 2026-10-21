import { describe, it, expect } from "vitest";
import { NaelaoAgentDO } from "../../workers/agents/src/do/NaelaoAgentDO.js";
import { createDOSqlStorage } from "./helpers/sqlite-do-shim.js";
import type { TraceStep } from "../../workers/agents/src/script-engine/types.js";

// §A1 Phase HX1: run_traces persistence + the GET /runs/:runId/trace DO route. Exercises the
// NEW code directly (persistRunTrace/readRunTrace + the route) rather than driving a full
// runScriptLoop through handleScriptRun, which would need a real LLM reasoner — the loop's own
// trace-recording logic is covered separately in tests/unit/script-engine.test.ts.

function makeDO(analytics?: { writeDataPoint: (p: unknown) => void }) {
  const ctx = { storage: { sql: createDOSqlStorage() } };
  const env: Record<string, unknown> = { PLATFORM_SECRET: "test" };
  if (analytics) env.ANALYTICS = analytics;
  return new NaelaoAgentDO(ctx as never, env as never);
}

const sampleTrace: TraceStep[] = [
  { seq: 0, phase: "observe", detail: "filesystem", duration_ms: 5, ts: 1000 },
  { seq: 1, phase: "find", name: "send_email", detail: "1 candidate(s)", duration_ms: 2, ts: 1001 },
  { seq: 2, phase: "gate", detail: "L1", ts: 1002 },
  { seq: 3, phase: "run", name: "send_email", tier: 1, duration_ms: 40, tokens: 0, ok: true, ts: 1003 },
];

describe("NaelaoAgentDO — run_traces persistence (§A1 Phase HX1)", () => {
  it("persists a trace and reads it back in seq order via the private helpers", async () => {
    const doInstance = makeDO() as unknown as {
      persistRunTrace: (runId: string, tenantId: string, trace: TraceStep[]) => void;
      readRunTrace: (runId: string) => TraceStep[];
      fetch: (req: Request) => Promise<Response>;
    };
    // ensureInit runs lazily inside fetch(); trigger it via an innocuous route first so the
    // run_traces table exists before we call the private persistence method directly.
    await doInstance.fetch(new Request("http://agent-do/status"));

    doInstance.persistRunTrace("run-1", "tenant-1", sampleTrace);
    const readBack = doInstance.readRunTrace("run-1");

    expect(readBack.map((t) => t.phase)).toEqual(["observe", "find", "gate", "run"]);
    expect(readBack.map((t) => t.seq)).toEqual([0, 1, 2, 3]);
    const runStep = readBack.find((t) => t.phase === "run")!;
    expect(runStep.name).toBe("send_email");
    expect(runStep.tier).toBe(1);
    expect(runStep.ok).toBe(true);
    expect(runStep.duration_ms).toBe(40);
  });

  it("GET /runs/:runId/trace returns the persisted trace for a real run, and an empty array for an unknown one", async () => {
    const doInstance = makeDO() as unknown as {
      persistRunTrace: (runId: string, tenantId: string, trace: TraceStep[]) => void;
      fetch: (req: Request) => Promise<Response>;
    };
    await doInstance.fetch(new Request("http://agent-do/status"));
    doInstance.persistRunTrace("run-2", "tenant-1", sampleTrace);

    const res = await doInstance.fetch(new Request("http://agent-do/runs/run-2/trace"));
    expect(res.status).toBe(200);
    const body = await res.json() as { run_id: string; trace: TraceStep[] };
    expect(body.run_id).toBe("run-2");
    expect(body.trace.length).toBe(4);
    expect(body.trace[3]!.phase).toBe("run");

    const missing = await doInstance.fetch(new Request("http://agent-do/runs/does-not-exist/trace"));
    expect(missing.status).toBe(200);
    const missingBody = await missing.json() as { trace: TraceStep[] };
    expect(missingBody.trace).toEqual([]);
  });

  it("never throws even if SQLite insert fails (observability must never fail the run)", async () => {
    const doInstance = makeDO() as unknown as {
      persistRunTrace: (runId: string, tenantId: string, trace: TraceStep[]) => void;
    };
    // No ensureInit() called — run_traces doesn't exist yet, so the INSERT would throw if
    // persistRunTrace didn't swallow it.
    expect(() => doInstance.persistRunTrace("run-3", "tenant-1", sampleTrace)).not.toThrow();
  });

  it("best-effort mirrors one root span + one child span per step to Analytics Engine when bound", async () => {
    const points: Array<{ blobs: string[] }> = [];
    const doInstance = makeDO({ writeDataPoint: (p) => points.push(p as { blobs: string[] }) }) as unknown as {
      persistRunTrace: (runId: string, tenantId: string, trace: TraceStep[]) => void;
      fetch: (req: Request) => Promise<Response>;
    };
    await doInstance.fetch(new Request("http://agent-do/status"));
    doInstance.persistRunTrace("run-4", "tenant-1", sampleTrace);
    // ActiveSpan.end() fires its AE write via a non-awaited promise — flush the microtask queue.
    await new Promise((r) => setTimeout(r, 0));
    // 1 root span + 4 step spans = 5 data points.
    expect(points.length).toBe(5);
    expect(new Set(points.map((point) => point.blobs[0])).size).toBe(1);
    expect(points[0]!.blobs[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(points.some((point) => point.blobs[4] === "script_loop.run")).toBe(true);
    expect(points.some((point) => JSON.parse(point.blobs[6]!).run_id === "run-4")).toBe(true);
  });

  it("does not touch Analytics Engine at all when ANALYTICS is unbound (honest degradation)", async () => {
    const doInstance = makeDO() as unknown as {
      persistRunTrace: (runId: string, tenantId: string, trace: TraceStep[]) => void;
      readRunTrace: (runId: string) => TraceStep[];
      fetch: (req: Request) => Promise<Response>;
    };
    await doInstance.fetch(new Request("http://agent-do/status"));
    expect(() => doInstance.persistRunTrace("run-5", "tenant-1", sampleTrace)).not.toThrow();
    expect(doInstance.readRunTrace("run-5").length).toBe(4);
  });
});
