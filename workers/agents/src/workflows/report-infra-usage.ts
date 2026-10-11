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
  idempotencyKey: string,
  recordUsage = true,
): Promise<number> {
  if (!env.BILLING_WORKER) return 0;
  const credits = infraTimeToCredits("workflow_step", durationMs);
  if (credits <= 0) return 0;
  if (!recordUsage) return credits;
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
  return credits;
}

export async function reserveWorkflowBudget(
  env: Env,
  tenantId: string,
  spaceId: string,
  workflowId: string,
  budgetKey: string | undefined,
  credits: number | undefined,
  expiresAt?: number,
): Promise<string | null> {
  if (!credits || credits <= 0) return null;
  if (!env.BILLING_WORKER) throw new Error("workflow_budget_service_unavailable");
  const token = await mintInternalToken(env.PLATFORM_SECRET, tenantId);
  const response = await env.BILLING_WORKER.fetch(new Request("http://billing-worker/internal/workflows/budget/reserve", {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId, "x-naelao-internal-token": token },
    body: JSON.stringify({ reservation_id: workflowId, workflow_id: workflowId, space_id: spaceId, budget_key: budgetKey ?? `workflow:${workflowId}`, credits: Math.ceil(credits), ...(expiresAt ? { expires_at: new Date(expiresAt).toISOString() } : {}) }),
  }));
  if (!response.ok) throw new Error(`workflow budget reservation failed (${response.status})`);
  const body = await response.json<{ reservation_id?: string }>();
  return body.reservation_id ?? workflowId;
}

export async function finalizeWorkflowBudget(
  env: Env,
  tenantId: string,
  reservationId: string | null | undefined,
  action: "release" | "settle",
  usedCredits?: number,
): Promise<void> {
  if (!env.BILLING_WORKER || !reservationId) return;
  const token = await mintInternalToken(env.PLATFORM_SECRET, tenantId);
  const response = await env.BILLING_WORKER.fetch(new Request(`http://billing-worker/internal/workflows/budget/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId, "x-naelao-internal-token": token },
    body: JSON.stringify({ reservation_id: reservationId, ...(action === "settle" && typeof usedCredits === "number" ? { quantity: Math.max(0, Math.ceil(usedCredits)) } : {}) }),
  }));
  if (!response.ok) throw new Error("workflow budget " + action + " failed (" + response.status + ")");
}
