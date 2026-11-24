import { describe, expect, it } from "vitest";
import { NaelaoAgentDO } from "./NaelaoAgentDO.js";
import { verifyDelegationContract, type DelegationContract } from "../script-engine/delegation-contract.js";

const secret = "test-signing-key";

function reconstructContract(body: Record<string, any>, request: Request): DelegationContract {
  const context = body.context as Record<string, any>;
  return {
    tenantId: body.tenantId, spaceId: body.spaceId, ...(body.projectId ? { projectId: body.projectId } : {}),
    actorId: body.userId, agentId: body.agentId,
    rootRunId: context.root_run_id, parentRunId: context.parent_run_id, parentDoId: context.parent_do_id,
    workerId: context.sub_agent_id,
    ...(Number.isSafeInteger(context.worker_attempt) ? { workerAttempt: context.worker_attempt } : {}),
    depth: context.delegation_depth, planner: context.delegation_planner,
    maxTokens: context.max_tokens, maxSteps: context.max_steps,
    ...(typeof context.runtime_capability === "string" ? { runtimeCapability: context.runtime_capability } : {}),
    model: body.model, role: body.functionalRole,
    ...(request.headers.get("x-naelao-role") ? { callerRole: request.headers.get("x-naelao-role")! } : {}),
    ...(typeof body.workspaceBranch === "string" ? { workspaceBranch: body.workspaceBranch } : {}),
    ...(Array.isArray(context.file_paths) ? { filePaths: context.file_paths } : {}),
    ...(typeof context.worker_resume_authorized === "boolean" ? { resumeAuthorized: context.worker_resume_authorized } : {}),
    maxTier: context.delegation_max_tier, localOnly: body.airGappedOnly === true,
    ...(typeof body.localMachineId === "string" ? { localModelMachine: body.localMachineId } : {}),
  };
}

describe("delegated worker approval resume", () => {
  it("reconstructs the exact signed attempt and runtime capability for a confirmed resume", async () => {
    const workerId = `${"a".repeat(64)}:resume-task`;
    const delegation: DelegationContract = {
      tenantId: "tenant", spaceId: "space", projectId: "project", actorId: "member", agentId: "worker-agent",
      rootRunId: "root-run", parentRunId: "parent-run", parentDoId: "parent-do", workerId, workerAttempt: 4,
      depth: 2, planner: false, maxTokens: 500, maxSteps: 5, runtimeCapability: "media.ffmpeg",
      model: "local/test-model", role: "worker", callerRole: "product_end_user", workspaceBranch: "workers/task-a",
      filePaths: ["src/task.ts"], maxTier: 6, localOnly: true, localModelMachine: "authorized-machine",
    };
    const row: Record<string, string | null> = {
      approval_id: "approval-a", run_id: "original-child-run", space_id: "space", tenant_id: "tenant",
      agent_id: "worker-agent", session_id: null, project_id: "project", user_id: "member",
      caller_role: "product_end_user", model: "local/test-model", goal: "continue worker task",
      action_name: "approval.required", action_input_json: null, approval_policy_fingerprint: null,
      delegation_json: JSON.stringify(delegation), context_json: null, steps_json: "[]",
      deliberation_round: "0", status: "suspended",
    };
    const sql = { exec(query: string, ...args: unknown[]) {
      if (query.includes("SELECT * FROM suspended_runs")) return { toArray: () => row.status === "suspended" ? [{ ...row }] : [] };
      if (query.includes("RETURNING approval_id")) {
        if (row.status !== "suspended") return { toArray: () => [] };
        row.status = "resuming";
        return { toArray: () => [{ approval_id: row.approval_id }] };
      }
      if (query.includes("SELECT COALESCE(SUM(tokens), 0) AS used FROM run_traces")) return { toArray: () => [{ used: 50 }] };
      if (query.includes("UPDATE suspended_runs SET resumed_run_id")) row.resumed_run_id = String(args[0]);
      if (query.includes("UPDATE suspended_runs SET status = 'resumed'")) row.status = "resumed";
      return { toArray: () => [] };
    } };
    const instance = new NaelaoAgentDO({ storage: { sql }, id: { toString: () => "worker-do" } } as never, {
      PLATFORM_SECRET: secret,
      HITL_APPROVAL_DO: { idFromName: (name: string) => name, get: () => ({ fetch: async () => Response.json({
        status: "answered", kind: "question", answer: "continue",
      }) }) },
    } as never);
    const resumedRequests: Request[] = [];
    (instance as unknown as { handleScriptRun(request: Request): Promise<Response> }).handleScriptRun = async request => {
      resumedRequests.push(request);
      return Response.json({ result: { ok: true, output: "resumed", tokens_used: 10 }, trace: [] });
    };
    const resume = (instance as unknown as { handleResumeRun(request: Request): Promise<Response> }).handleResumeRun.bind(instance);

    const response = await resume(new Request("http://agent/script/resume", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ approvalId: "approval-a" }) }));

    expect(response.status).toBe(200);
    expect(resumedRequests).toHaveLength(1);
    const request = resumedRequests[0]!;
    const body = await request.clone().json() as Record<string, any>;
    expect(body.context).toMatchObject({ worker_attempt: 4, runtime_capability: "media.ffmpeg",
      worker_resume_authorized: true, max_tokens: 450, worker_token_budget: 450 });
    expect(body.runId).not.toBe("original-child-run");
    await expect(verifyDelegationContract(reconstructContract(body, request), body.context.delegation_token, secret)).resolves.toBeUndefined();
  });
});
