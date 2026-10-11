import type { WorkflowStep } from "cloudflare:workers";
import { validateDurableWorkflowIdentity, type DurableWorkflowIdentity } from "@naelao/agent-sdk";
import { putWorkflowArtifact, readWorkflowArtifact, readWorkflowGrant, workflowHash, workflowRunStub } from "./workflow-host.js";
import type { Env } from "../env.js";
import type { AgentTaskParams } from "./AgentTaskWorkflow.js";

/** Static workflows use the same journal and pointer boundary as developer workflows. */
export async function checkpointAgentTask(env: Env, runId: string, params: AgentTaskParams, native: WorkflowStep): Promise<{ step: WorkflowStep; identity: DurableWorkflowIdentity }> {
  if (!params.userId) throw new Error("agent_task_workflow_actor_required");
  if (!env.SCRIPTS_R2 || !env.WORKFLOW_BUILD_ID || !/^[a-f0-9]{64}$/.test(env.WORKFLOW_BUILD_ID)) throw new Error("agent_task_workflow_build_pin_required");
  const scope = { tenantId: params.tenantId, spaceId: params.spaceId, projectId: params.projectId, actorId: params.userId, agentId: params.agentId ?? "naelao-agent", runId };
  const stub = workflowRunStub(env, scope);
  const previous = await stub.existing();
  let identity = previous?.identity;
  if (!identity) {
    const grant = await readWorkflowGrant(env, scope);
    identity = { ...scope, schema: 1, startKey: params.taskId, codeDigest: env.WORKFLOW_BUILD_ID, codeKey: "workflow-code/" + params.tenantId + "/" + params.spaceId + "/" + env.WORKFLOW_BUILD_ID + ".agent-task.json",
      grantVersion: grant.version, expiresAt: Date.now() + 7 * 86400_000, workflowClass: "ephemeral_task", capabilities: ["agent.run"] };
    validateDurableWorkflowIdentity(identity);
    await env.SCRIPTS_R2.put(identity.codeKey, JSON.stringify({ kind: "static-agent-task", buildDigest: env.WORKFLOW_BUILD_ID }));
    const input = await putWorkflowArtifact(env, identity, JSON.parse(JSON.stringify(params)));
    await stub.initialize(identity, input, {});
  }
  if (identity.codeDigest !== env.WORKFLOW_BUILD_ID) throw new Error("agent_task_workflow_build_changed");
  await stub.authorize(runId);
  const pinned = identity;
  const wrapper = new Proxy(native, {
    get(target, key) {
      if (key !== "do") { const member = Reflect.get(target, key, target); return typeof member === "function" ? member.bind(target) : member; }
      return async (name: string, optionsOrCallback: unknown, possibleCallback?: () => Promise<unknown>) => {
        await stub.authorize(runId);
        const callback = typeof optionsOrCallback === "function" ? optionsOrCallback as () => Promise<unknown> : possibleCallback;
        if (!callback) throw new Error("workflow_step_callback_required");
        const options = typeof optionsOrCallback === "function" ? {} : optionsOrCallback as object;
        const pointer = await target.do(name, options, async () => {
          await stub.authorize(runId);
          const result = await callback();
          return putWorkflowArtifact(env, pinned, result === undefined ? null : JSON.parse(JSON.stringify(result)));
        });
        await stub.authorize(runId);
        return readWorkflowArtifact(env, pinned, pointer);
      };
    },
  });
  return { step: wrapper, identity };
}
