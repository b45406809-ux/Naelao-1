import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { NaelaoAgentDO } from "./NaelaoAgentDO.js";
import { verifyDelegationContract } from "../script-engine/delegation-contract.js";
import type { ScriptEngineEnv } from "../script-engine/types.js";

type MergeOutcome = { conflicts: Array<{ path: string; reason: string }>; validationReceipts: unknown[]; published: boolean };
type Host = { spawnSubAgentBatch(tasks: Record<string, unknown>[], space: string, agent: string, tenant: string, key: string,
  parent: string, thread: string, project: string, namespace: DurableObjectNamespace, actor: string, model: string,
  effort: string, signal: undefined, runtime: ScriptEngineEnv,
  merge?: (subId: string, branch: string, attempt: number) => Promise<MergeOutcome>, goalDispatchId?: string): Promise<{ results: Array<{ id?: string; ok: boolean; status?: string; error?: string }> }> };
function fixture() {
  type WorkerRow = { id: string; parent_run_id: string; status: string; goal: string; workspace_branch: string | null; configuration_json: string | null;
    attempt: number; checkpoint_json: string | null; checkpoint_updated_at: number | null; result: string | null; error: string | null; updated_at: number; budget_tokens: number; tokens_used: number;
    late_result_json: string | null; late_result_at: number | null; late_result_attempt: number | null };
  const active = new Set<string>(), requests: Record<string, any>[] = [], finishes: Array<(body?: Record<string, any>, status?: number) => void> = [];
  const workers = new Map<string, WorkerRow>();
  const dispatches = new Map<string, { status: string; worker_id: string; parent_run_id: string; cancel_requested_at: number | null; attempt?: number; workspace_branch?: string }>();
  const storageValues = new Map<string, unknown>();
  const publicationAttempts = new Map<string, Array<{ worker_attempt: number; target_branch: string; target_revision: number; status: string; updated_at: number }>>();
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
      if (normalized.startsWith("SELECT status,attempt,parent_run_id,configuration_json FROM sub_agents")) {
        const row = workers.get(String(args[0]));
        return cursor(row ? [{ status: row.status, attempt: row.attempt, parent_run_id: row.parent_run_id, configuration_json: row.configuration_json }] : []);
      }
      if (normalized.startsWith("SELECT status,worker_id,parent_run_id,cancel_requested_at FROM goal_dispatch_outbox")) {
        const row = dispatches.get(String(args[0]));
        return cursor(row ? [{ ...row }] : []);
      }
      if (normalized.startsWith("SELECT id, parent_run_id, goal, status, budget_tokens")) {
        const parentRunId = String(args[0]);
        return cursor([...workers.values()].filter(row => !parentRunId || row.parent_run_id === parentRunId).map(row => ({
          id: row.id, parent_run_id: row.parent_run_id, goal: row.goal, status: row.status, budget_tokens: row.budget_tokens,
          tokens_used: row.tokens_used, progress_note: null, workspace_branch: row.workspace_branch, attempt: row.attempt,
          result: row.result, error: row.error, created_at: 1, updated_at: row.updated_at,
          checkpoint_updated_at: row.checkpoint_json ? row.checkpoint_updated_at : null,
        })));
      }
      if (normalized.startsWith("SELECT * FROM sub_agents WHERE id = ?")) {
        const row = workers.get(String(args[0]));
        return cursor(row ? [{ ...row }] : []);
      }
      if (normalized.startsWith("SELECT worker_attempt,target_branch,target_revision,status,updated_at FROM worker_publication_permits")) {
        return cursor(publicationAttempts.get(String(args[0])) ?? []);
      }
      if (normalized.startsWith("SELECT configuration_json,workspace_branch,checkpoint_json,attempt,status FROM sub_agents")) {
        const row = workers.get(String(args[0]));
        return cursor(row ? [{ configuration_json: row.configuration_json, workspace_branch: row.workspace_branch,
          checkpoint_json: row.checkpoint_json, attempt: row.attempt, status: row.status }] : []);
      }
      if (normalized.startsWith("SELECT late_result_json FROM sub_agents")) {
        const row = workers.get(String(args[0]));
        return cursor(row ? [{ late_result_json: row.late_result_json }] : []);
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
        const [id, parentRunId, goal, budget, branch, , , updated] = args as [string, string, string, number, string | null, number, number, number];
        workers.set(id, { id, parent_run_id: parentRunId, status: "running", goal, workspace_branch: branch, configuration_json: null,
          attempt: 1, checkpoint_json: null, checkpoint_updated_at: null, result: null, error: null, updated_at: updated, budget_tokens: budget, tokens_used: 0,
          late_result_json: null, late_result_at: null, late_result_attempt: null });
        return cursor([], 1);
      }
      if (normalized.startsWith("UPDATE sub_agents SET late_result_json=CASE WHEN late_result_attempt")) {
        const [lateJson, lateAt, tokens, updated, id, attempt] = args;
        const row = workers.get(String(id));
        if (!row || row.status !== "terminated" || row.attempt !== Number(attempt)) return cursor();
        if (row.late_result_attempt !== Number(attempt)) {
          row.late_result_json = String(lateJson); row.late_result_at = Number(lateAt);
          row.late_result_attempt = Number(attempt); row.tokens_used += Number(tokens);
        }
        row.updated_at = Number(updated);
        return cursor([], 1);
      }
      if (normalized.startsWith("UPDATE goal_dispatch_outbox SET status='acknowledged',attempt=?")) {
        const [attempt, branch, , id] = args, row = dispatches.get(String(id));
        if (!row || row.status !== "delivering" || row.cancel_requested_at !== null) return cursor();
        row.status = "acknowledged"; row.attempt = Number(attempt); row.workspace_branch = String(branch); return cursor([], 1);
      }
      const rowId = normalized.startsWith("UPDATE sub_agents SET status = 'terminated'") ? args[1]
        : normalized.startsWith("UPDATE sub_agents SET status='running'") ? args[2]
        : normalized.startsWith("UPDATE sub_agents SET workspace_branch=?") ? args[3]
        : normalized.startsWith("UPDATE sub_agents SET tokens_used=tokens_used+?") || normalized.startsWith("UPDATE sub_agents SET status='failed'") ? args[2]
        : normalized.startsWith("UPDATE sub_agents SET status = ?, tokens_used") ? args[7]
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
        const [status, tokens, result, checkpoint, checkpointUpdatedAt, error, updated, , attempt] = args;
        if (row.status !== "running" || row.attempt !== Number(attempt)) return cursor();
        row.status = String(status); row.tokens_used += Number(tokens); row.result = result as string | null;
        row.checkpoint_json = checkpoint as string | null; row.checkpoint_updated_at = Number(checkpointUpdatedAt);
        row.error = error as string | null; row.updated_at = Number(updated);
        return cursor([], 1);
      }
      if (normalized.startsWith("UPDATE sub_agents SET status=?, result=?, checkpoint_json=?")) {
        const hasAttempt = normalized.endsWith("AND attempt=?");
        const [status, result, checkpoint, checkpointUpdatedAt, error, tokens, updated, , attempt] = args;
        if (row.status !== "running" || (hasAttempt && row.attempt !== Number(attempt))) return cursor();
        row.status = String(status); row.result = result as string | null; row.checkpoint_json = checkpoint as string | null;
        row.checkpoint_updated_at = Number(checkpointUpdatedAt); row.error = error as string | null;
        row.tokens_used += Number(tokens); row.updated_at = Number(updated);
        return cursor([], 1);
      }
      if (normalized.startsWith("UPDATE sub_agents SET status='failed'")) {
        const [error, updated, , attempt] = args;
        if (row.status !== "running" || row.attempt !== Number(attempt)) return cursor();
        row.status = "failed"; row.error = String(error); row.updated_at = Number(updated); return cursor([], 1);
      }
      return cursor();
    } };
    const storage = { sql, transactionSync: (callback: () => void) => callback(), put: async (key: string, value: unknown) => { storageValues.set(key, value); },
      get: async (key: string) => storageValues.get(key) };
    return new NaelaoAgentDO({ storage, id: { toString: () => "parent-do" } } as never,
      { PLATFORM_SECRET: "test-signing-key", ...(bound ? { CONCURRENCY_DO: concurrency } : {}) } as never) as unknown as Host;
  };
  const runtime = { scriptsBucket: {}, tenantId: "tenant", spaceId: "space", agentId: "parent", rootRunId: "root",
    delegationDepth: 2, delegationPlanner: true, effectiveRole: "editor", callerRole: "product_end_user",
    maxTier: 6, airGappedOnly: true, localModelMachine: "authorized-machine",
    privateWorkerModels: [{ id: "test-model", inputModalities: ["text"], outputModalities: ["text"], contextTokens: 32_000, toolCalling: true }] } as ScriptEngineEnv;
  const spawn = (parent: Host, tasks: Record<string, unknown>[], merge?: Host["spawnSubAgentBatch"] extends (...args: infer A) => unknown ? A[14] : never,
    goalDispatchId?: string) => parent.spawnSubAgentBatch(tasks, "space", "parent", "tenant", "", "parent-run", "parent-thread", "project", children,
    "person", "local/test-model", "low", undefined, runtime, merge, goalDispatchId);
  const terminate = (parent: Host, id: string) => (parent as unknown as { terminateSubAgentImpl(id: string): Promise<void> }).terminateSubAgentImpl(id);
  return { active, requests, finishes, workers, dispatches, storageValues, publicationAttempts, host, runtime, spawn, terminate };
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
  it("inherits the assigned task budget as a delegated planner's child budget ceiling", async () => {
    const f = fixture();
    f.runtime.delegationDepth = 1;
    f.runtime.delegationPlanner = true;
    f.runtime.workerTokenBudget = 1_000;
    const run = f.spawn(f.host(), [{ goal: "plan a bounded subtask", planner: true, budget_tokens: 256 }]);
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    expect(f.requests[0]!.context).toMatchObject({ max_tokens: 256, worker_token_budget: 256, delegation_depth: 2, delegation_planner: true });
    f.finishes[0]!();
    await run;
  });
  it("fences child session start against the exact parent worker attempt", async () => {
    const f = fixture(), parent = f.host();
    const run = f.spawn(parent, [{ goal: "start only while admitted" }]);
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    const id = String(f.requests[0]!.context.sub_agent_id);
    const check = async () => (parent as unknown as { fetch(request: Request): Promise<Response> }).fetch(new Request("http://agent-do/internal/sub-agents/start-check", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant",
        "x-naelao-internal-token": await mintInternalToken("test-signing-key", "tenant") },
      body: JSON.stringify({ workerId: id, parentDoId: "parent-do", parentRunId: "parent-run", attempt: 1, runId: id,
        spaceId: "space", projectId: "project", actorId: "person" }),
    }));
    expect(await (await check()).json()).toEqual({ active: true });
    await f.terminate(parent, id);
    expect(await (await check()).json()).toEqual({ active: false });
    f.finishes[0]!();
    await run;
  });
  it("does not admit a goal worker session after the durable dispatch cancel bit wins", async () => {
    const f = fixture(), parent = f.host();
    f.dispatches.set("dispatch-1", { status: "delivering", worker_id: "worker-1", parent_run_id: "parent-run", cancel_requested_at: Date.now() });
    const result = await f.spawn(parent, [{ sub_agent_id: "worker-1", goal: "must not start" }], undefined, "dispatch-1");
    expect(result.results[0]).toMatchObject({ id: "worker-1", ok: false, status: "terminated", error: "worker_cancelled" });
    expect(f.workers.has("worker-1")).toBe(false);
    expect(f.requests).toHaveLength(0);
    expect(f.dispatches.get("dispatch-1")?.status).toBe("delivering");
  });
  it("lists a saved progress checkpoint timestamp without exposing checkpoint payload", async () => {
    const f = fixture(), parent = f.host();
    const run = f.spawn(parent, [{ goal: "persist progress" }]);
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    const id = String(f.requests[0]!.context.sub_agent_id);
    f.finishes[0]!({ result: { ok: true, output: { checkpoint: "durable progress" }, tokens_used: 4 } });
    await run;

    const response = await (parent as unknown as { fetch(request: Request): Promise<Response> }).fetch(
      new Request("http://agent-do/sub-agents?parent_run_id=parent-run"),
    );
    expect(response.status).toBe(200);
    const listed = await response.json() as { data: Array<Record<string, unknown>> };
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]).toMatchObject({ id, checkpoint_updated_at: expect.any(Number) });
    expect(listed.data[0]).not.toHaveProperty("checkpoint_json");
    expect(listed.data[0]).not.toHaveProperty("checkpoint");
  });
  it("surfaces malformed persisted checkpoint data instead of treating it as absent", async () => {
    const f = fixture(), parent = f.host();
    const run = f.spawn(parent, [{ goal: "persist progress" }]);
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    const id = String(f.requests[0]!.context.sub_agent_id);
    f.finishes[0]!({ result: { ok: true, output: "done", tokens_used: 2 } });
    await run;
    f.workers.get(id)!.checkpoint_json = "{malformed";
    const received = await (parent as unknown as { receiveFromSubAgentImpl(id: string): Promise<Record<string, unknown>> }).receiveFromSubAgentImpl(id);
    expect(received).toMatchObject({ ok: false, status: "done", error: "worker_session_checkpoint_invalid" });
  });
  it("withholds branch checkpoint payloads when no immutable workspace pin is available", async () => {
    const f = fixture(), parent = f.host();
    const run = f.spawn(parent, [{ goal: "persist branch progress", workspace_branch: "workers/unpinned" }]);
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    const id = String(f.requests[0]!.context.sub_agent_id);
    f.finishes[0]!({ result: { ok: true, output: { privateProgress: "must not be trusted" }, tokens_used: 2 } });
    await run;
    const received = await (parent as unknown as { receiveFromSubAgentImpl(id: string): Promise<Record<string, unknown>> }).receiveFromSubAgentImpl(id);
    expect(received).toMatchObject({ checkpoint_state: "unverified" });
    expect(received).not.toHaveProperty("checkpoint");
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
    expect(f.workers.get(id)).toMatchObject({ status: "terminated", tokens_used: 10, late_result_at: expect.any(Number), late_result_attempt: 1 });
    expect(JSON.parse(f.workers.get(id)!.late_result_json!)).toMatchObject({ attempt: 1, status: response.result.ok ? "done" : "failed", effects: "unknown" });
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

  it("returns the durable checked-publication outcome with the terminated worker status", async () => {
    const f = fixture(), parent = f.host();
    const run = f.spawn(parent, [{ goal: "isolated task", workspace_branch: "workers/publish-race" }]);
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    const id = String(f.requests[0]!.context.sub_agent_id);
    await f.terminate(parent, id);
    f.finishes[0]!();
    await run;
    const receipt = { path: "naelao-worker-validation.json", paths: ["naelao-worker-validation.json"], status: "passed",
      branch: "race/worker-validation/abc", revision: 2, manifestHash: "a".repeat(64), targetRevision: 1,
      targetManifestHash: "b".repeat(64), commandHash: "c".repeat(64), executionId: "worker-integration-test", runId: "run-test",
      durationMs: 10, completedAt: new Date(0).toISOString(), candidateBranch: "race/worker-candidate/abc",
      candidateCommitId: "d".repeat(40), sourceBranch: "workers/publish-race", sourceCommitId: "e".repeat(40),
      targetBranch: "main", targetCommitId: "f".repeat(40), publicationStatus: "uncertain" };
    f.storageValues.set(`worker-integration-receipts:${id}`, [receipt]);
    f.publicationAttempts.set(id, [{ worker_attempt: 1, target_branch: "main", target_revision: 1, status: "authorized", updated_at: 0 }]);
    const view = await (parent as unknown as { receiveFromSubAgentImpl(workerId: string): Promise<Record<string, any>> }).receiveFromSubAgentImpl(id);
    expect(view).toMatchObject({ status: "terminated", workspaceIntegration: {
      validationReceipts: [receipt], publicationAttempts: [{ attempt: 1, targetBranch: "main", targetRevision: 1, status: "outcome_unknown" }],
    } });
    expect(f.workers.get(id)?.status).toBe("terminated");
  });

  it("retains a late internal session update without replacing a terminated worker", async () => {
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
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, late_result: true });
    expect(f.workers.get(id)).toMatchObject({ status: "terminated", result: null, tokens_used: 10, late_result_at: expect.any(Number) });
    expect(JSON.parse(f.workers.get(id)!.late_result_json!)).toMatchObject({ status: "done", output: "<untrusted_subagent_result>\ntoo late\n</untrusted_subagent_result>", effects: "unknown" });
    const repeated = await (parent as unknown as { fetch(request: Request): Promise<Response> }).fetch(new Request("http://agent-do/internal/sub-agents/session-update", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant",
        "x-naelao-internal-token": await mintInternalToken("test-signing-key", "tenant") },
      body: JSON.stringify({ id, parentDoId: "parent-do", attempt: 1, status: "done", output: "replacement", tokensUsed: 10 }),
    }));
    expect(repeated.status).toBe(200);
    expect(f.workers.get(id)).toMatchObject({ status: "terminated", tokens_used: 10 });
    const view = await (parent as unknown as { receiveFromSubAgentImpl(workerId: string): Promise<Record<string, any>> }).receiveFromSubAgentImpl(id);
    expect(view).toMatchObject({ status: "terminated", late_result: { status: "done", effects: "unknown" } });
    f.finishes[0]!();
    await run;
    expect(f.workers.get(id)).toMatchObject({ status: "terminated", tokens_used: 10 });
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
