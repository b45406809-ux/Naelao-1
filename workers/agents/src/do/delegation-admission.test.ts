import { describe, expect, it, vi } from "vitest";
import { NaelaoAgentDO } from "./NaelaoAgentDO.js";
import { verifyDelegationContract } from "../script-engine/delegation-contract.js";
import type { ScriptEngineEnv } from "../script-engine/types.js";

type Host = { spawnSubAgentBatch(tasks: Record<string, unknown>[], space: string, agent: string, tenant: string, key: string,
  parent: string, thread: string, project: string, namespace: DurableObjectNamespace, actor: string, model: string,
  effort: string, signal: undefined, runtime: ScriptEngineEnv): Promise<{ results: Array<{ ok: boolean; error?: string }> }> };
function fixture() {
  const active = new Set<string>(), requests: Record<string, any>[] = [], finishes: Array<() => void> = [];
  const concurrency = { idFromName: (name: string) => name, get: (name: string) => ({ fetch: async (request: Request) => {
    const body = await request.json<{ holder_id: string; limit: number }>(), key = `${name}:${body.holder_id}`;
    if (new URL(request.url).pathname === "/release") { active.delete(key); return Response.json({ ok: true }); }
    const count = [...active].filter(item => item.startsWith(name + ":")).length;
    if (count >= body.limit) return Response.json({ granted: false, active: count });
    active.add(key); return Response.json({ granted: true, active: count + 1 });
  } }) } as unknown as DurableObjectNamespace;
  const children = { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => {
    const body = await request.json<Record<string, any>>(); requests.push(body);
    return new Promise<Response>(resolve => finishes.push(() => resolve(Response.json({ result: { ok: true, output: "done", tokens_used: 10 } }))));
  } }) } as unknown as DurableObjectNamespace;
  const host = (bound = true) => {
    const storage = { sql: { exec: () => ({ toArray: () => [] }) }, put: async () => undefined };
    return new NaelaoAgentDO({ storage, id: { toString: () => "parent-do" } } as never,
      { PLATFORM_SECRET: "test-signing-key", ...(bound ? { CONCURRENCY_DO: concurrency } : {}) } as never) as unknown as Host;
  };
  const runtime = { scriptsBucket: {}, tenantId: "tenant", spaceId: "space", agentId: "parent", rootRunId: "root",
    delegationDepth: 2, delegationPlanner: true, effectiveRole: "editor", callerRole: "product_end_user",
    maxTier: 6, airGappedOnly: true, localModelMachine: "authorized-machine" } as ScriptEngineEnv;
  const spawn = (parent: Host, tasks: Record<string, unknown>[]) => parent.spawnSubAgentBatch(tasks, "space", "parent", "tenant", "", "parent-run", "parent-thread", "project", children,
    "person", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "low", undefined, runtime);
  return { active, requests, finishes, host, runtime, spawn };
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
    expect(body.sessionId).not.toBe("parent-thread"); expect(body.context).not.toHaveProperty("conversation");
    await verifyDelegationContract({ tenantId: "tenant", spaceId: "space", projectId: "project", actorId: "person", agentId: "own-worker",
      rootRunId: "root", parentRunId: "parent-run", parentDoId: "parent-do", workerId: body.runId,
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
});
