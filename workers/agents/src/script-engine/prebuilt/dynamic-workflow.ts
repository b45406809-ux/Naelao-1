/**
 * dynamic-workflow (spec §12.1) — author and deploy CF Workflows for recurring tasks that
 * should run without AgentDO being awake. Operations: workflow.create, workflow.run,
 * workflow.schedule, workflow.status.
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
  requires_tier: 2,
  operations: {
    async "workflow.create"(args, ctx) {
      const h = hooks(ctx);
      if (!h.workflowCreate)
        return {
          ok: false,
          reason: "workflow registry not available in this environment",
        };
      const compiled = compileWorkflowEntrypoint(String(args.code ?? ""));
      return await h.workflowCreate(String(args.name ?? ""), compiled.source);
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
          reportTarget: route.reportTarget,
          escalationTarget: route.escalationTarget,
        }
      );
      return {
        queued: true,
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
  },
};
