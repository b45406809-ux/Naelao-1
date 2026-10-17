import type { WorkflowClass } from "@naelao/agent-sdk";
import type { OrchestrationHooks } from "../script-engine/types.js";
import type { ScriptToolSurface } from "../script-engine/tool-surface.js";
import { readWorkflowGrant, startDurableWorkflow, workflowHash, workflowHeaders, workflowRunStub, type DurableWorkflowHostEnv } from "./workflow-host.js";

interface WorkflowInventoryRow {
  instance?: { instance_id?: string; project_id?: string | null; status?: string; scope?: string };
  manifest?: { id?: string; bundle?: {
    id?: string; version?: string;
    primitives?: Array<{ kind?: string; id?: string; entry?: string; toolNames?: string[] }>;
    workerRoles?: Array<{ id?: string; principal?: string; invocation?: string; execution?: string; entry?: string; primitiveIds?: string[] }>;
  } };
}

export function createWorkflowHooks(env: DurableWorkflowHostEnv, scope: { tenantId: string; spaceId: string; projectId?: string; agentId: string; actorId?: string }, parentRunId: string, tools: ScriptToolSurface): Partial<OrchestrationHooks> {
  const actor = (): string => { if (!scope.actorId || scope.actorId === "system") throw new Error("workflow_actor_required"); return scope.actorId; };
  const journal = (runId: string) => workflowRunStub(env, { ...scope, runId });
  return {
    workflowListExtensions: async () => {
      const actorId = actor();
      // Re-check the caller's membership and active project scope before exposing any package
      // ids; possession of a signed internal token alone is not a project membership grant.
      await readWorkflowGrant(env, { tenantId: scope.tenantId, spaceId: scope.spaceId, actorId, agentId: scope.agentId, ...(scope.projectId ? { projectId: scope.projectId } : {}) });
      const response = await env.SPACES_WORKER.fetch(new Request(`http://spaces-worker/spaces/${encodeURIComponent(scope.spaceId)}/container-installations${scope.projectId ? `?project_id=${encodeURIComponent(scope.projectId)}` : ""}`, {
        headers: await workflowHeaders(env, scope.tenantId, actorId),
      }));
      if (!response.ok) throw new Error("extension_workflow_inventory_unavailable");
      const result = await response.json<{ installations?: WorkflowInventoryRow[] }>();
      return (result.installations ?? []).flatMap(item => {
        const instanceId = item.instance?.instance_id, bundle = item.manifest?.bundle;
        if (!instanceId || item.instance?.status !== "active" || (scope.projectId && item.instance.project_id !== scope.projectId)
          || !bundle?.id || bundle.id !== item.manifest?.id || !bundle.version) return [];
        const parts = (bundle.primitives ?? []).filter((part): part is typeof part & { id: string; kind: string } => typeof part.id === "string" && typeof part.kind === "string")
          .map(part => ({ id: part.id, kind: part.kind }));
        const workflows = (bundle.primitives ?? []).filter(part => part.kind === "workflow" && typeof part.id === "string" && typeof part.entry === "string")
          .map(part => ({ id: part.id!, entry: part.entry!, toolNames: (part.toolNames ?? []).filter((name): name is string => typeof name === "string"),
            workerRoles: (bundle.workerRoles ?? []).filter(role => role.primitiveIds?.includes(part.id!)).map(role => ({ id: role.id, principal: role.principal, invocation: role.invocation, execution: role.execution, entry: role.entry })) }));
        return workflows.length ? [{ extensionId: bundle.id, version: bundle.version, installationId: instanceId, parts, workflows }] : [];
      });
    },
    workflowCreate: async (name, code, options) => {
      const capabilities = options?.capabilities ?? [];
      const available = new Set(tools.availableOperations());
      if (capabilities.length > 64 || capabilities.some((op) => !available.has(op) || op === "Bash" || op.startsWith("workflow.") || op.startsWith("lock.") || op === "code.run_js" || op === "code.run_python")) throw new Error("workflow_capability_not_installed");
      await tools.create({ name, code, metadata: { description: "Durable workflow with pinned code and scoped capabilities", domain: "orchestration", requires_tier: 3, runtime: "workflow", code_capabilities: [...new Set(capabilities)], origin: "distilled" } });
      return { id: name };
    },
    workflowRun: async (name, params, options = {}) => {
      const startKey = options.startKey ?? await workflowHash(JSON.stringify([parentRunId, name]));
      const result = await startDurableWorkflow(env, { ...scope, actorId: actor(), name, params, startKey, ...(options.workflowClass ? { workflowClass: options.workflowClass as WorkflowClass } : {}),
        budgetKey: options.budgetKey, budgetCredits: options.budgetCredits, installationId: options.installationId, extensionId: options.extensionId });
      return { ...result, instanceId: result.id, workflow: name, context: "clean", max_context_tokens: options.maxContextTokens ?? 2000 };
    },
    workflowStatus: async (id) => journal(id).status(actor()),
    workflowCancel: async (id) => { await journal(id).cancel(actor()); return { ok: true, cancelled: id }; },
    workflowSignal: async (id, type, payload) => { await journal(id).signal(actor(), type, payload); return { ok: true, signalled: id }; },
    workflowRetry: async (id) => { await journal(id).retry(actor()); return { ok: true, retrying: id }; },
    workflowSchedule: async (name, cron) => {
      actor();
      if (!scope.projectId) throw new Error("workflow_schedule_project_required");
      const response = await env.SPACES_WORKER.fetch(new Request("http://spaces-worker/spaces/" + encodeURIComponent(scope.spaceId) + "/scheduled-jobs", {
        method: "POST", headers: await workflowHeaders(env, scope.tenantId, actor()),
        body: JSON.stringify({ name: "workflow:" + name, cron_expression: cron, script_name: name, agent_id: scope.agentId, project_id: scope.projectId, created_by: actor() }),
      }));
      if (!response.ok) throw new Error("workflow_schedule_failed:" + response.status);
      return response.json<{ id: string }>();
    },
  };
}
