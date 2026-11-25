/**
 * §A1.26: shared helper for CF Workflow classes (ScriptRunWorkflow, AgentTaskWorkflow) to report
 * their own step's wall-clock duration as infra-credit usage — the durable-Workflow counterpart
 * to NaelaoAgentDO.settleRunBilling's isolate/container recording. Workflow classes don't share
 * NaelaoAgentDO's internalHeaders()/BILLING_WORKER wiring (they run in the same worker, a
 * different Env shape), so this is a small standalone equivalent rather than a DO method.
 * Best-effort throughout — a reporting failure never fails the workflow step it's timing.
 */
import { mintInternalToken, readBoundedResponseJson } from "@naelao/http";
import { infraTimeToCredits, BILLING_CORE_RATE_CARD_VERSION, priceExtensionResourceUnits } from "@naelao/billing-core";
import type { Env } from "../env.js";

export interface WorkflowUsageDimensions {
  projectId?: string;
  installationId?: string;
  installationBudgetCredits?: number;
  installationBudgetRevision?: number;
  runtimeTier?: number;
  runId?: string;
}

/** Persist resource units separately from the flat Workflow-step credit charge. These rows are
 * deliberately unpriced until an approved per-byte/storage rate exists; the billing summary will
 * expose them as unpriced instead of implying an invented rate. */
export async function reportWorkflowResourceUsage(
  env: Env,
  tenantId: string,
  spaceId: string,
  idempotencyKey: string,
  meteringUnit: "request" | "byte" | "job",
  meteredUnits: number,
  dimensions: WorkflowUsageDimensions & { projectId: string; installationId: string; runId: string },
  /** D8: when set, the row stays unpriced (no cost_credits) and is marked as charged in settlement. */
  pricedInSettlement?: { priceVersion: string },
): Promise<void> {
  if (!env.BILLING_WORKER) throw new Error("workflow_resource_meter_unavailable");
  if (!Number.isSafeInteger(meteredUnits) || meteredUnits < 0 || meteredUnits > 5 * 1024 * 1024)
    throw new Error("workflow_resource_meter_invalid");
  const eventType = meteringUnit === "request" ? "extension_resource_requests"
    : meteringUnit === "job" ? "extension_resource_jobs" : "extension_resource_bytes";
  const unit = meteringUnit === "request" ? "invocations" : meteringUnit === "job" ? "units" : "bytes";
  const token = await mintInternalToken(env.PLATFORM_SECRET, tenantId);
  const response = await env.BILLING_WORKER.fetch(new Request("http://billing-worker/billing/usage", {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId, "x-naelao-internal-token": token },
    body: JSON.stringify({ event_type: eventType, quantity: meteredUnits, unit, schema_version: 2,
      space_id: spaceId, project_id: dimensions.projectId, installation_id: dimensions.installationId, run_id: dimensions.runId,
      ...(pricedInSettlement ? { rate_card_version: pricedInSettlement.priceVersion, priced_in_settlement: true, price_version: pricedInSettlement.priceVersion } : {}),
      idempotency_key: idempotencyKey }),
  }));
  if (!response.ok) throw new Error("workflow_resource_meter_failed:" + response.status);
}

export async function reportWorkflowStepInfraUsage(
  env: Env,
  tenantId: string,
  spaceId: string,
  durationMs: number,
  idempotencyKey: string,
  recordUsage = true,
  dimensions: WorkflowUsageDimensions = {},
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
      body: JSON.stringify({ event_type: "infra_credits", quantity: credits, unit: "credits", schema_version: 2,
        cost_credits: credits, rate_card_version: BILLING_CORE_RATE_CARD_VERSION, space_id: spaceId,
        ...(dimensions.projectId ? { project_id: dimensions.projectId } : {}),
        ...(dimensions.installationId ? { installation_id: dimensions.installationId } : {}),
        ...(dimensions.runtimeTier ? { runtime_tier: dimensions.runtimeTier } : {}),
        ...(dimensions.runId ? { run_id: dimensions.runId } : {}),
        payer_kind: "plan_quota", decision: "charged", idempotency_key: idempotencyKey }),
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
  dimensions: WorkflowUsageDimensions = {},
): Promise<string | null> {
  if (!credits || credits <= 0) return null;
  if (!env.BILLING_WORKER) throw new Error("workflow_budget_service_unavailable");
  const token = await mintInternalToken(env.PLATFORM_SECRET, tenantId);
  const response = await env.BILLING_WORKER.fetch(new Request("http://billing-worker/internal/workflows/budget/reserve", {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId, "x-naelao-internal-token": token },
    body: JSON.stringify({ reservation_id: workflowId, workflow_id: workflowId, space_id: spaceId, budget_key: budgetKey ?? `workflow:${workflowId}`, credits: Math.ceil(credits),
      ...(dimensions.projectId ? { project_id: dimensions.projectId } : {}),
      ...(dimensions.installationId ? { installation_id: dimensions.installationId } : {}),
      ...(dimensions.installationBudgetCredits !== undefined ? { installation_budget_credits: dimensions.installationBudgetCredits } : {}),
      ...(dimensions.installationBudgetRevision !== undefined ? { installation_budget_revision: dimensions.installationBudgetRevision } : {}),
      ...(dimensions.runtimeTier ? { runtime_tier: dimensions.runtimeTier } : {}),
      ...(expiresAt ? { expires_at: new Date(expiresAt).toISOString() } : {}) }),
  }));
  if (!response.ok) throw new Error(`workflow budget reservation failed (${response.status})`);
  const body = await readBoundedResponseJson<{ reservation_id?: string }>(response, 64 * 1024);
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

/** D8: prices a run's accumulated resource units once (round up per line, once per settlement)
 * and returns the credits to add to the settle quantity, never above the run's hold. The billing
 * settle also charges min(quantity, held), so this is a second, independent bound. */
export function priceRunResourceUnitsForSettlement(
  units: { invocations: number; jobUnits: number; bytes: number } | undefined,
  usedCredits: number,
  heldCredits: number | undefined,
): { credits: number; priceVersion: string } {
  const priced = priceExtensionResourceUnits(units ?? { invocations: 0, jobUnits: 0, bytes: 0 });
  const headroom = heldCredits === undefined ? priced.credits : Math.max(0, Math.ceil(heldCredits) - Math.ceil(usedCredits));
  return { credits: Math.min(priced.credits, headroom), priceVersion: priced.priceVersion };
}
