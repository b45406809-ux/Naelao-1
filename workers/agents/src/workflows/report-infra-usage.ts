/**
 * §A1.26: shared helper for CF Workflow classes (ScriptRunWorkflow, AgentTaskWorkflow) to report
 * their own step's wall-clock duration as infra-credit usage — the durable-Workflow counterpart
 * to NaelaoAgentDO.settleRunBilling's isolate/container recording. Workflow classes don't share
 * NaelaoAgentDO's internalHeaders()/BILLING_WORKER wiring (they run in the same worker, a
 * different Env shape), so this is a small standalone equivalent rather than a DO method.
 * Best-effort throughout — a reporting failure never fails the workflow step it's timing.
 */
import { mintInternalToken } from "@naelao/http";
import { infraTimeToCredits } from "@naelao/billing-core";
import type { Env } from "../env.js";

export async function reportWorkflowStepInfraUsage(
  env: Env,
  tenantId: string,
  spaceId: string,
  durationMs: number,
  idempotencyKey: string
): Promise<void> {
  if (!env.BILLING_WORKER) return;
  const credits = infraTimeToCredits("workflow_step", durationMs);
  if (credits <= 0) return;
  try {
    const token = await mintInternalToken(env.PLATFORM_SECRET, tenantId);
    await env.BILLING_WORKER.fetch(new Request("http://billing-worker/billing/usage", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId, "x-naelao-internal-token": token },
      body: JSON.stringify({ event_type: "infra_credits", quantity: credits, space_id: spaceId, idempotency_key: idempotencyKey }),
    }));
  } catch {
    /* best-effort — never fails the workflow step */
  }
}
