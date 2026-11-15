/**
 * dynamic-workflow (spec §12.1) — author and deploy CF Workflows for recurring tasks that
 * should run without AgentDO being awake. Operations include installed-extension discovery,
 * workflow creation/run/schedule, and lifecycle controls.
 *
 * Workflow registration needs the platform workflow registry, which the engine does not
 * own; these delegate to host orchestration hooks and degrade honestly when unwired.
 *
 * This is how scheduled Launchpad agents (e.g. the Content agent's "0 9 * * *" cron) run:
 * the agent authors a workflow once and schedules it, rather than relying on a separate
 * trigger table.
 */

import {
  type ExtensionId,
  type WorkflowClass,
  assertExtensionId,
  routeWorkflow,
} from "@naelao/agent-sdk";
import { compileWorkflowEntrypoint } from "../../workflows/workflow-harness.js";
import type { OrchestrationHooks } from "../types.js";
import type { PrebuiltOpContext, PrebuiltScript } from "./index.js";

function hooks(ctx: PrebuiltOpContext): OrchestrationHooks {
  return ctx.env.orchestration ?? {};
}

/** Validate an untrusted CLI argument before crossing the branded SDK boundary. */
function extensionIdFromArgs(value: unknown): ExtensionId | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const extensionId = String(value);
  assertExtensionId(extensionId);
  return extensionId;
}

export const dynamicWorkflow: PrebuiltScript = {
  name: "dynamic-workflow",
  description:
    "Create, run, schedule (cron), and check status of durable CF Workflows.",
  domain: "orchestration",
  requires_tier: 3,
  paramHints: {
    "workflow.extensions": "no parameters; lists only this project’s active bound/shared extensions with installation ID, version, scope, exact declared dependency pins, primitive IDs/kinds, workflow runtime and entries when present, and worker-role bindings",
    "workflow.extension.settings": "installation_id, action=status|propose. Status returns only active and draft revisions. Propose requires expected_active_revision, expected_draft_revision, and a partial changes object; it creates an owner-reviewable draft only and never publishes settings.",
    "workflow.create": "name, code: export async function execute(step, ctx); capabilities: installed operation names; use ctx.params and ctx.tools.call(stableStepKey, operation, params)",
    "workflow.run": "name, params, start_key (reuse for retries), workflow_class, budget_credits, optional installation_id",
    "workflow.status": "id: workflow run ID",
    "workflow.signal": "id, type, payload: JSON event",
    "workflow.cancel": "id: cancel durably and release its reservation",
    "workflow.retry": "id: explicitly restart a failed workflow; committed effects are reused, uncertain effects require reconciliation",
  },
  operations: {
    async "workflow.extensions"(_args, ctx) {
      const h = hooks(ctx);
      if (!h.workflowListExtensions) return { ok: false, reason: "extension workflow inventory not available" };
      return { extensions: await h.workflowListExtensions() };
    },
    async "workflow.extension.settings"(args, ctx) {
      const h = hooks(ctx);
      if (!h.workflowExtensionSettings) return { ok: false, reason: "delegated extension settings proposals are not available" };
      const installationId = String(args.installation_id ?? "");
      if (!/^[A-Za-z0-9._:-]{1,768}$/.test(installationId)) throw new Error("workflow_extension_installation_required");
      const action = args.action;
      if (action === "status") return h.workflowExtensionSettings({ installationId, action });
      if (action !== "propose" || !Number.isSafeInteger(args.expected_active_revision) || Number(args.expected_active_revision) < 0
        || !Number.isSafeInteger(args.expected_draft_revision) || Number(args.expected_draft_revision) < 0
        || !args.changes || typeof args.changes !== "object" || Array.isArray(args.changes)) throw new Error("workflow_extension_settings_proposal_invalid");
      const changes = args.changes as Record<string, unknown>;
      if (Object.keys(changes).length < 1 || Object.keys(changes).length > 32
        || Object.values(changes).some(value => !["string", "number", "boolean"].includes(typeof value)))
        throw new Error("workflow_extension_settings_proposal_invalid");
      return h.workflowExtensionSettings({ installationId, action, expectedActiveRevision: Number(args.expected_active_revision),
        expectedDraftRevision: Number(args.expected_draft_revision), changes: changes as Record<string, string | number | boolean> });
    },
    async "workflow.create"(args, ctx) {
      const h = hooks(ctx);
      if (!h.workflowCreate)
        return {
          ok: false,
          reason: "workflow registry not available in this environment",
        };
      const compiled = await compileWorkflowEntrypoint(String(args.code ?? ""));
      const capabilities = args.capabilities === undefined ? [] : args.capabilities;
      if (!Array.isArray(capabilities) || capabilities.some((op) => typeof op !== "string")) throw new Error("workflow_capabilities_invalid");
      return await h.workflowCreate(String(args.name ?? ""), compiled.source, { capabilities });
    },
    async "workflow.run"(args, ctx) {
      const workflowClass = String(
        args.workflow_class ?? "ephemeral_task"
      ) as WorkflowClass;
      const extensionId = extensionIdFromArgs(args.extension_id);
      const route = routeWorkflow({
        workflowClass,
        spaceId: ctx.env.spaceId,
        ...(ctx.env.projectId ? { projectId: ctx.env.projectId } : {}),
        ...(typeof args.installation_id === "string" ? { installationId: args.installation_id } : {}),
        ...(extensionId ? { extensionId } : {}),
        invokerId: ctx.env.humanInvokerId ?? "system",
        budgetCredits: Number(args.budget_credits ?? 1),
      });
      const h = hooks(ctx);
      if (!h.workflowRun)
        return { ok: false, reason: "workflow run not available" };
      const name = String(args.name ?? "");
      const result = await h.workflowRun(
        name,
        (args.params as Record<string, unknown>) ?? {},
        {
          detach: args.detach === true,
          cleanContext: true,
          maxContextTokens: 2_000,
          contextSources: ["task_payload", "target_files", "SOUL.md"],
          inheritChatHistory: false,
          workflowClass: route.workflowClass,
          budgetKey: route.budgetKey,
          budgetCredits: route.budgetCredits,
          reportTarget: route.reportTarget,
          escalationTarget: route.escalationTarget,
          ...(typeof args.start_key === "string" ? { startKey: args.start_key } : {}),
          ...(typeof args.installation_id === "string" ? { installationId: args.installation_id } : {}),
          ...(extensionId ? { extensionId } : {}),
        }
      );
      return {
        queued: !!(result as { queued?: boolean } | null)?.queued,
        result,
        ...(workflowClass === "ephemeral_task"
          ? {
              receipt_card: {
                kind: "workflow_receipt",
                collapsed: true,
                lines: [
                  `[ ⏰ Background Job: ${name} | Status: 🟡 Queued ]`,
                  "[View Full R2 Logs] [Inspect Diff]",
                ],
              },
            }
          : { alert_route: route.reportTarget }),
      };
    },
    async "workflow.schedule"(args, ctx) {
      if (!ctx.env.projectId)
        throw new Error("workflow.schedule requires a project-scoped run");
      const h = hooks(ctx);
      if (!h.workflowSchedule)
        return { ok: false, reason: "workflow schedule not available" };
      const result = await h.workflowSchedule(
        String(args.name ?? ""),
        String(args.cron ?? "")
      );
      return {
        result,
        receipt_card: {
          kind: "workflow_receipt",
          collapsed: true,
          lines: [
            `[ ⏰ Background Cron: ${String(args.name ?? "")} | Status: 🟡 Scheduled ]`,
            "[View Full R2 Logs] [Inspect Diff]",
          ],
        },
      };
    },
    async "workflow.status"(args, ctx) {
      const h = hooks(ctx);
      if (!h.workflowStatus)
        return { ok: false, reason: "workflow status not available" };
      return await h.workflowStatus(String(args.id ?? ""));
    },
    async "workflow.cancel"(args, ctx) {
      const h = hooks(ctx);
      if (!h.workflowCancel) return { ok: false, reason: "workflow cancellation not available" };
      const id = String(args.id ?? "");
      if (!id) throw new Error("workflow.cancel requires an id");
      return await h.workflowCancel(id);
    },
    async "workflow.signal"(args, ctx) {
      const h = hooks(ctx);
      if (!h.workflowSignal) throw new Error("workflow_signal_unavailable");
      return h.workflowSignal(String(args.id ?? ""), String(args.type ?? ""), args.payload ?? null);
    },
    async "workflow.retry"(args, ctx) {
      const h = hooks(ctx);
      if (!h.workflowRetry) throw new Error("workflow_retry_unavailable");
      return h.workflowRetry(String(args.id ?? ""));
    },
  },
};
