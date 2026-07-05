import { describe, it, expect, vi } from "vitest";
import { runStoredScript } from "../../workers/agents/src/script-engine/execution-ladder.js";
import type { ScriptEngineEnv, StoredScript, WorkflowRunner } from "../../workers/agents/src/script-engine/types.js";

// §A1.17 Phase J: a script tagged metadata.runtime:"workflow" must dispatch to the injected
// WorkflowRunner (a durable CF Workflow instance) instead of the ordinary Tier 2-5 codeRunner —
// so a long-running/cron automation doesn't hold an isolate or a DO open the whole time.

function baseEnv(overrides: Partial<ScriptEngineEnv> = {}): ScriptEngineEnv {
  return {
    scriptsBucket: {} as never,
    spaceId: "space-1",
    agentId: "naelao-agent",
    tenantId: "tenant-1",
    ...overrides,
  };
}

function workflowScript(overrides: Partial<StoredScript["metadata"]> = {}): StoredScript {
  return {
    code: "export default async function() { return { ok: true }; }",
    metadata: {
      name: "revenue-review",
      version: 1,
      domain: "orchestration",
      description: "Nightly revenue review",
      tags: [],
      fingerprint_schema: {},
      preconditions: [],
      parameters: [],
      calls: [],
      requires_tier: 2,
      runtime: "workflow",
      success_count: 0,
      failure_count: 0,
      patch_history: [],
      stability_score: 1,
      origin: "distilled",
      created_at: Date.now(),
      updated_at: Date.now(),
      ...overrides,
    },
  };
}

describe("execution-ladder — runtime:workflow routing", () => {
  it("dispatches to workflowRunner.start instead of codeRunner, and does NOT block on completion", async () => {
    const start = vi.fn(async () => ({ id: "wf-instance-123" }));
    const codeRunnerRun = vi.fn();
    const workflowRunner: WorkflowRunner = { start, status: vi.fn() };
    const env = baseEnv({
      workflowRunner,
      codeRunner: { run: codeRunnerRun } as never,
      projectId: "proj-1",
    });

    const result = await runStoredScript(env, workflowScript(), { since: "yesterday" });

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ workflow_id: "wf-instance-123", status: "started" });
    expect(codeRunnerRun).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith({
      name: "revenue-review",
      args: { since: "yesterday" },
      spaceId: "space-1",
      agentId: "naelao-agent",
      tenantId: "tenant-1",
      projectId: "proj-1",
    });
  });

  it("is per-tenant isolated — passes the calling env's own space/tenant, never a fixed one", async () => {
    const start = vi.fn(async () => ({ id: "wf-a" }));
    const envA = baseEnv({ spaceId: "space-A", tenantId: "tenant-A", workflowRunner: { start, status: vi.fn() } });
    const envB = baseEnv({ spaceId: "space-B", tenantId: "tenant-B", workflowRunner: { start, status: vi.fn() } });

    await runStoredScript(envA, workflowScript(), {});
    await runStoredScript(envB, workflowScript(), {});

    expect(start).toHaveBeenNthCalledWith(1, expect.objectContaining({ spaceId: "space-A", tenantId: "tenant-A" }));
    expect(start).toHaveBeenNthCalledWith(2, expect.objectContaining({ spaceId: "space-B", tenantId: "tenant-B" }));
  });

  it("degrades honestly (ok:false) when no workflowRunner is wired, rather than silently running in an isolate", async () => {
    const codeRunnerRun = vi.fn();
    const env = baseEnv({ codeRunner: { run: codeRunnerRun } as never });

    const result = await runStoredScript(env, workflowScript(), {});

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/workflow runner is wired/);
    expect(codeRunnerRun).not.toHaveBeenCalled();
  });

  it("surfaces a workflowRunner.start rejection as ok:false rather than throwing", async () => {
    const env = baseEnv({
      workflowRunner: { start: vi.fn(async () => { throw new Error("workflows binding unavailable"); }), status: vi.fn() },
    });

    const result = await runStoredScript(env, workflowScript(), {});

    expect(result.ok).toBe(false);
    expect(result.error).toBe("workflows binding unavailable");
  });

  it("an ordinary (runtime absent/isolate) script still routes to codeRunner, unaffected", async () => {
    const codeRunnerRun = vi.fn(async () => ({ ok: true, output: { done: true }, tier: 2 as const, duration_ms: 5, tokens_used: 0 }));
    const start = vi.fn();
    const env = baseEnv({ codeRunner: { run: codeRunnerRun }, workflowRunner: { start, status: vi.fn() } });

    const result = await runStoredScript(env, workflowScript({ runtime: "isolate" }), {});

    expect(codeRunnerRun).toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(result.output).toEqual({ done: true });
  });
});
