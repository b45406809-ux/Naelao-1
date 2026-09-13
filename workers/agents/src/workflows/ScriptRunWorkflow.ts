/**
 * ScriptRunWorkflow (§A1.17 Phase J) — durable execution for a stored script tagged
 * `metadata.runtime === "workflow"` (long-running, must survive restarts, or scheduled).
 *
 * Deliberately thin: the one step re-resolves the script BY NAME through the exact same
 * "run directly, no OBSERVE/FIND/GATE, no reasoner" path a trigger fire or scheduled job
 * already uses (see fireScriptDirectly / POST agent-do/triggers/fire in ../index.ts) — the
 * workflow never carries code through its own params, so an edit to the script between
 * schedule and fire is picked up automatically, and step retries + the workflow platform's
 * long ceiling (vs. an isolate's short one) are the only new behavior this class adds.
 */

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import { mintInternalToken } from "@naelao/http";
import type { Env } from "../env.js";
import { reportWorkflowStepInfraUsage } from "./report-infra-usage.js";

export interface ScriptRunWorkflowParams {
  spaceId: string;
  tenantId: string;
  agentId?: string;
  projectId: string;
  scriptName: string;
  params: Record<string, unknown>;
}

/** The step's result is kept to CF Workflows' structured-cloneable `Serializable` shape (no
 *  arbitrary `unknown` object) — the raw JSON text, parsed by whoever reads workflow.status(). */
export interface ScriptRunWorkflowResult {
  ok: boolean;
  status: number;
  body: string;
}

export class ScriptRunWorkflow extends WorkflowEntrypoint<Env, ScriptRunWorkflowParams> {
  async run(event: WorkflowEvent<ScriptRunWorkflowParams>, step: WorkflowStep): Promise<ScriptRunWorkflowResult> {
    const p = event.payload;

    const result = await step.do(
      "execute-script",
      { retries: { limit: 3, delay: 5000, backoff: "exponential" as const }, timeout: "10 minutes" },
      async (): Promise<ScriptRunWorkflowResult> => {
        const started = Date.now();
        const token = await mintInternalToken(this.env.PLATFORM_SECRET, p.tenantId);
        const resp = await this.env.AGENTS_WORKER.fetch(
          new Request("https://agents-worker/internal/scripts/run-durable", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-naelao-tenant-id": p.tenantId,
              "x-naelao-internal-token": token,
            },
            body: JSON.stringify({
              spaceId: p.spaceId,
              tenantId: p.tenantId,
              ...(p.agentId ? { agentId: p.agentId } : {}),
              ...(p.projectId ? { projectId: p.projectId } : {}),
              scriptName: p.scriptName,
              params: p.params,
            }),
          })
        );
        const body = await resp.text();
        // §A1.26: this step's own orchestration/dispatch wall-clock time (distinct from any
        // isolate/container time the durable script run itself reports, which is billed
        // separately inside NaelaoAgentDO.settleRunBilling when that script executes).
        await reportWorkflowStepInfraUsage(this.env, p.tenantId, p.spaceId, Date.now() - started, `workflow:${event.instanceId}:execute-script`);
        if (!resp.ok) {
          throw new Error(`durable script run failed (${resp.status}): ${body}`);
        }
        return { ok: true, status: resp.status, body };
      }
    );
    return result;
  }
}
