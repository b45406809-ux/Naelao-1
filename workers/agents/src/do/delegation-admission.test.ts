import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { NaelaoAgentDO } from "./NaelaoAgentDO.js";
import { verifyDelegationContract } from "../script-engine/delegation-contract.js";
import type { ScriptEngineEnv } from "../script-engine/types.js";

type MergeOutcome = { conflicts: Array<{ path: string; reason: string }>; validationReceipts: unknown[]; published: boolean };
type Host = { spawnSubAgentBatch(tasks: Record<string, unknown>[], space: string, agent: string, tenant: string, key: string,
  parent: string, thread: string, project: string, namespace: DurableObjectNamespace, actor: string, model: string,
  effort: string, signal: undefined, runtime: ScriptEngineEnv,
  merge?: (subId: string, branch: string, attempt: number) => Promise<MergeOutcome>): Promise<{ results: Array<{ id?: string; ok: boolean; status?: string; error?: string }> }> };
function fixture() {
  type WorkerRow = { id: string; status: string; goal: string; workspace_branch: string | null; configuration_json: string | null;
    attempt: number; checkpoint_json: string | null; result: string | null; error: string | null; updated_at: number; budget_tokens: number; tokens_used: number };
  const active = new Set<string>(), requests: Record<string, any>[] = [], finishes: Array<(body?: Record<string, any>, status?: number) => void> = [];
  const workers = new Map<string, WorkerRow>();
  const concurrency = { idFromName: (name: string) => name, get: (name: string) => ({ fetch: async (request: Request) => {
    const body = await request.json<{ holder_id: string; limit: number }>(), key = `${name}:${body.holder_id}`;
    if (new URL(request.url).pathname === "/release") { active.delete(key); return Response.json({ ok: true }); }
    const count = [...active].filter(item => item.startsWith(name + ":")).length;
    if (count >= body.limit) return Response.json({ granted: false, active: count });
    active.add(key); return Response.json({ granted: true, active: count + 1 });
  } }) } as unknown as DurableObjectNamespace;
  const children = { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => {
    const body = await request.json<Record<string, any>>(); requests.push(body);
    return new Promise<Response>(resolve => finishes.push((result = { result: { ok: true, output: "done", tokens_used: 10 } }, status = 200) => resolve(Response.json(result, { status }))));
  } }) } as unknown as DurableObjectNamespace;
  const host = (bound = true) => {
    const sql = { exec: (query: string, ...args: unknown[]) => {
      const normalized = query.replace(/\s+/g, " ").trim();
      const cursor = (rows: unknown[] = [], rowsWritten = 0) => ({ toArray: () => rows, rowsWritten });
      if (normalized.startsWith("SELECT status,attempt FROM sub_agents")) {
        const row = workers.get(String(args[0]));
        return cursor(row ? [{ status: row.status, attempt: row.attempt }] : []);
      }
      if (normalized.startsWith("SELECT configuration_json FROM sub_agents")) {
        const row = workers.get(String(args[0]));
        return cursor(row ? [{ configuration_json: row.configuration_json }] : []);
      }
      if (normalized.startsWith("SELECT status, goal, workspace_branch")) {
        const row = workers.get(String(args[0]));
        return cursor(row ? [{ ...row }] : []);
      }
      if (normalized.startsWith("INSERT INTO sub_agents")) {
        const [id, , goal, budget, branch, , updated] = args as [string, string, string, number, string | null, number, number];
        workers.set(id, { id, status: "running", goal, workspace_branch: branch, configuration_json: null,
          attempt: 1, checkpoint_json: null, result: null, error: null, updated_at: updated, budget_tokens: budget, tokens_used: 0 });
        return cursor([], 1);
      }
      const rowId = normalized.startsWith("UPDATE sub_agents SET status = 'terminated'") ? args[1]
        : normalized.startsWith("UPDATE sub_agents SET status='running'") ? args[2]
        : normalized.startsWith("UPDATE sub_agents SET workspace_branch=?") ? args[3]
        : normalized.startsWith("UPDATE sub_agents SET tokens_used=tokens_used+?") || normalized.startsWith("UPDATE sub_agents SET status='failed'") ? args[2]
        : normalized.startsWith("UPDATE sub_agents SET status = ?, tokens_used") ? args[6]
        : args[args.length - 1];
      const row = workers.get(String(rowId));
      if (!row) return cursor();
      if (normalized.startsWith("UPDATE sub_agents SET status = 'terminated'")) {
        if (row.status !== "running") return cursor();
        row.status = "terminated"; row.updated_at = Number(args[0]); return cursor([], 1);
      }
      if (normalized.startsWith("UPDATE sub_agents SET status='running'")) {
        row.status = "running"; row.attempt = Number(args[0]); row.error = null; row.updated_at = Number(args[1]); return cursor([], 1);
      }
      if (normalized.startsWith("UPDATE sub_agents SET workspace_branch=?, configuration_json=?")) {
        row.workspace_branch = args[0] as string | null; row.configuration_json = String(args[1]); row.updated_at = Number(args[2]); return cursor([], 1);
      }
      if (normalized.startsWith("UPDATE sub_agents SET tokens_used=tokens_used+?")) {
        if (row.status !== "terminated" || row.attempt !== Number(args[3])) return cursor();
        row.tokens_used += Number(args[0]); row.updated_at = Number(args[1]); return cursor([], 1);
      }
      if (normalized.startsWith("UPDATE sub_agents SET status=?, result=?, checkpoint_json=?")) {
        const [status, result, checkpoint, error, tokens, updated, , attempt] = args;
        if (row.status !== "running" || row.attempt !== Number(attempt)) return cursor();
        row.status = String(status); row.result = result as string | null; row.checkpoint_json = checkpoint as string | null;
        row.error = error as string | null; row.tokens_used += Number(tokens); row.updated_at = Number(updated);
        return cursor([], 1);
      }
      if (normalized.startsWith("UPDATE sub_agents SET status = ?, tokens_used")) {
        const [status, tokens, result, checkpoint, error, updated, , attempt] = args;
        if (row.status !== "running" || row.attempt !== Number(attempt)) return cursor();
        row.status = String(status); row.tokens_used += Number(tokens); row.result = result as string | null;
        row.checkpoint_json = checkpoint as string | null; row.error = error as string | null; row.updated_at = Number(updated);
        return cursor([], 1);
      }
      if (normalized.startsWith("UPDATE sub_agents SET status='failed'")) {
        const [error, updated, , attempt] = args;
        if (row.status !== "running" || row.attempt !== Number(attempt)) return cursor();
        row.status = "failed"; row.error = String(error); row.updated_at = Number(updated); return cursor([], 1);
      }
      return cursor();
    } };
    const storage = { sql, put: async () => undefined };
    return new NaelaoAgentDO({ storage, id: { toString: () => "parent-do" } } as never,
      { PLATFORM_SECRET: "test-signing-key", ...(bound ? { CONCURRENCY_DO: concurrency } : {}) } as never) as unknown as Host;
  };
  const runtime = { scriptsBucket: {}, tenantId: "tenant", spaceId: "space", agentId: "parent", rootRunId: "root",
    delegationDepth: 2, delegationPlanner: true, effectiveRole: "editor", callerRole: "product_end_user",
    maxTier: 6, airGappedOnly: true, localModelMachine: "authorized-machine" } as ScriptEngineEnv;
  const spawn = (parent: Host, tasks: Record<string, unknown>[], merge?: Host["spawnSubAgentBatch"] extends (...args: infer A) => unknown ? A[14] : never) => parent.spawnSubAgentBatch(tasks, "space", "parent", "tenant", "", "parent-run", "parent-thread", "project", children,
    "person", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "low", undefined, runtime, merge);
  const terminate = (parent: Host, id: string) => (parent as unknown as { terminateSubAgentImpl(id: string): Promise<void> }).terminateSubAgentImpl(id);
  return { active, requests, finishes, workers, host, runtime, spawn, terminate };
}
describe("host delegation admission", () => {
  it("caps active leaves across different subplanners of one root and releases slots after completion", async () => {
    const f = fixture();
    const runs = Array.from({ length: 4 }, () => f.spawn(f.host(), Array.from({ length: 3 }, () => ({ goal: "isolated task" }))));
    await vi.waitFor(() => expect(f.requests).toHaveLength(12));
    const denied = await f.spawn(f.host(), [{ goal: "thirteenth leaf" }]);
    expect(denied.results[0]).toMatchObject({ ok: false, error: "root_leaf_worker_limit_or_service_unavailable" });
    expect(f.requests).toHaveLength(12);
    f.finishes.forEach(finish => finish());
    expect((await Promise.all(runs)).every(result => result.results.every(worker => worker.ok))).toBe(true);
    expect(f.active.size).toBe(0);
  });
  it("signs each child's actor, billing identity and local-only placement without the parent's thread", async () => {
    const f = fixture(), run = f.spawn(f.host(), [{ goal: "isolated task", agent_id: "own-worker", role: "custom-reviewer", workspace_branch: "task/isolated" }]);
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    const body = f.requests[0]!;
    expect(body).toMatchObject({ agentId: "own-worker", userId: "person", airGappedOnly: true, localMachineId: "authorized-machine" });
    expect(body.context.worker_attempt).toBe(1);
    expect(body.sessionId).not.toBe("parent-thread"); expect(body.context).not.toHaveProperty("conversation");
    await verifyDelegationContract({ tenantId: "tenant", spaceId: "space", projectId: "project", actorId: "person", agentId: "own-worker",
      rootRunId: "root", parentRunId: "parent-run", parentDoId: "parent-do", workerId: body.runId, workerAttempt: 1,
      depth: 3, planner: false, maxTokens: body.context.max_tokens, maxSteps: body.context.max_steps,
      model: body.model, role: "custom-reviewer", callerRole: "product_end_user", workspaceBranch: "task/isolated",
      maxTier: 6, localOnly: true, localModelMachine: "authorized-machine" }, body.context.delegation_token, "test-signing-key");
    f.finishes.forEach(finish => finish()); await run;
  });
  it("denies missing concurrency admission and leaf recursion before dispatch", async () => {
    const f = fixture();
    expect((await f.spawn(f.host(false), [{ goal: "task" }])).results[0]?.ok).toBe(false);
    f.runtime.delegationDepth = 3; f.runtime.delegationPlanner = false;
    await expect(f.spawn(f.host(), [{ goal: "task" }])).rejects.toThrow("fan-out");
    expect(f.requests).toHaveLength(0);
  });

  it.each([
    ["late success", { result: { ok: true, output: "late", tokens_used: 10 } }],
    ["late failure", { result: { ok: false, error: "late failure", tokens_used: 10 } }],
  ])("preserves termination when a child returns %s", async (_label, response) => {
    const f = fixture(), parent = f.host();
    const run = f.spawn(parent, [{ goal: "isolated task", workspace_branch: "workers/late-result" }]);
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    const id = String(f.requests[0]!.context.sub_agent_id);
    await f.terminate(parent, id);
    f.finishes[0]!(response);
    const result = (await run).results[0];
    expect(result).toMatchObject({ ok: false, status: "terminated", error: "worker_cancelled" });
    expect(f.workers.get(id)).toMatchObject({ status: "terminated", tokens_used: 10 });
  });

  it("does not overwrite termination when cancellation lands during checked integration", async () => {
    const f = fixture(), parent = f.host();
    let entered!: () => void, release!: () => void;
    const inMerge = new Promise<void>(resolve => { entered = resolve; });
    const waitForMerge = new Promise<void>(resolve => { release = resolve; });
    const merge = vi.fn(async () => { entered(); await waitForMerge; return { conflicts: [], validationReceipts: [], published: false }; });
    const run = f.spawn(parent, [{ goal: "isolated task", workspace_branch: "workers/cancel-during-merge" }], merge);
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    const id = String(f.requests[0]!.context.sub_agent_id);
    f.finishes[0]!();
    await inMerge;
    await f.terminate(parent, id);
    release();
    const result = (await run).results[0];
    expect(merge).toHaveBeenCalledWith(id, "workers/cancel-during-merge", 1);
    expect(result).toMatchObject({ ok: false, status: "terminated", error: "worker_cancelled" });
    expect(f.workers.get(id)?.status).toBe("terminated");
  });

  it("rejects a late internal session update for a terminated worker attempt", async () => {
    const f = fixture(), parent = f.host();
    const run = f.spawn(parent, [{ goal: "isolated task" }]);
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    const id = String(f.requests[0]!.context.sub_agent_id);
    await f.terminate(parent, id);
    const response = await (parent as unknown as { fetch(request: Request): Promise<Response> }).fetch(new Request("http://agent-do/internal/sub-agents/session-update", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant",
        "x-naelao-internal-token": await mintInternalToken("test-signing-key", "tenant") },
      body: JSON.stringify({ id, parentDoId: "parent-do", attempt: 1, status: "done", output: "too late", tokensUsed: 10 }),
    }));
    expect(response.status).toBe(409);
    expect(f.workers.get(id)).toMatchObject({ status: "terminated", result: null, tokens_used: 0 });
    f.finishes[0]!();
    await run;
    expect(f.workers.get(id)?.status).toBe("terminated");
  });

  it("rejects a session update from a superseded attempt", async () => {
    const f = fixture(), parent = f.host();
    const run = f.spawn(parent, [{ goal: "isolated task" }]);
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    const id = String(f.requests[0]!.context.sub_agent_id);
    const row = f.workers.get(id)!;
    row.attempt = 2;
    const response = await (parent as unknown as { fetch(request: Request): Promise<Response> }).fetch(new Request("http://agent-do/internal/sub-agents/session-update", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant",
        "x-naelao-internal-token": await mintInternalToken("test-signing-key", "tenant") },
      body: JSON.stringify({ id, parentDoId: "parent-do", attempt: 1, status: "done", output: "stale", tokensUsed: 10 }),
    }));
    expect(response.status).toBe(409);
    expect(row).toMatchObject({ status: "running", attempt: 2, result: null, tokens_used: 0 });
    f.finishes[0]!();
    await run;
    expect(row).toMatchObject({ status: "running", attempt: 2, result: null, tokens_used: 0 });
  });
});
