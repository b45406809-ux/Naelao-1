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

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
import type { OrchestrationHooks } from "../types.js";

function hooks(ctx: PrebuiltOpContext): OrchestrationHooks {
  return ctx.env.orchestration ?? {};
}

export const dynamicWorkflow: PrebuiltScript = {
  name: "dynamic-workflow",
  description: "Create, run, schedule (cron), and check status of durable CF Workflows.",
  domain: "orchestration",
  requires_tier: 2,
  operations: {
    async "workflow.create"(args, ctx) {
      const h = hooks(ctx);
      if (!h.workflowCreate) return { ok: false, reason: "workflow registry not available in this environment" };
      return await h.workflowCreate(String(args["name"] ?? ""), String(args["code"] ?? ""));
    },
    async "workflow.run"(args, ctx) {
      const h = hooks(ctx);
      if (!h.workflowRun) return { ok: false, reason: "workflow run not available" };
      return await h.workflowRun(String(args["name"] ?? ""), (args["params"] as Record<string, unknown>) ?? {});
    },
    async "workflow.schedule"(args, ctx) {
      const h = hooks(ctx);
      if (!h.workflowSchedule) return { ok: false, reason: "workflow schedule not available" };
      return await h.workflowSchedule(String(args["name"] ?? ""), String(args["cron"] ?? ""));
    },
    async "workflow.status"(args, ctx) {
      const h = hooks(ctx);
      if (!h.workflowStatus) return { ok: false, reason: "workflow status not available" };
      return await h.workflowStatus(String(args["id"] ?? ""));
    },
  },
};
