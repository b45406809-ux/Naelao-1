import { describe, expect, it, vi } from "vitest";
import { finalizeWorkflowBudget, reserveWorkflowBudget, reportWorkflowResourceUsage, reportWorkflowStepInfraUsage } from "./report-infra-usage.js";

function env(fetcher: (request: Request) => Promise<Response>) {
  return { PLATFORM_SECRET: "secret", BILLING_WORKER: { fetch: fetcher } } as never;
}

describe("workflow budget contract", () => {
  it("uses the durable workflow instance as an idempotent reservation", async () => {
    const requests: Request[] = [];
    const reservation = await reserveWorkflowBudget(env(async request => { requests.push(request); return Response.json({ reservation_id: "wf-1" }, { status: 201 }); }), "tenant", "space", "wf-1", "workflow:ephemeral_task:user", 7, undefined,
      { projectId: "project-1", installationId: "install-1" });
    expect(reservation).toBe("wf-1");
    expect(await requests[0]!.json()).toMatchObject({ reservation_id: "wf-1", workflow_id: "wf-1", credits: 7, project_id: "project-1", installation_id: "install-1" });
  });

  it("settles measured credits and reports the same amount once", async () => {
    const requests: Request[] = [];
    const fetcher = vi.fn(async (request: Request) => { requests.push(request); return new Response(null, { status: 200 }); });
    const measured = await reportWorkflowStepInfraUsage(env(fetcher), "tenant", "space", 1000, "workflow:wf:step", false,
      { projectId: "project-1", installationId: "install-1", runId: "wf" });
    await finalizeWorkflowBudget(env(fetcher), "tenant", "wf-1", "settle", measured);
    expect(measured).toBeGreaterThan(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await requests[0]!.json()).toMatchObject({ reservation_id: "wf-1", quantity: measured });
  });

  it("writes scoped infrastructure usage as a versioned plan quota event", async () => {
    const requests: Request[] = [];
    const fetcher = vi.fn(async (request: Request) => { requests.push(request); return new Response(null, { status: 201 }); });
    await reportWorkflowStepInfraUsage(env(fetcher), "tenant", "space", 1000, "workflow:wf:step", true,
      { projectId: "project-1", installationId: "install-1", runId: "wf", runtimeTier: 3 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(await requests[0]!.json()).toMatchObject({
      schema_version: 2, event_type: "infra_credits", unit: "credits", cost_credits: 1,
      space_id: "space", project_id: "project-1", installation_id: "install-1", run_id: "wf",
      runtime_tier: 3, payer_kind: "plan_quota", decision: "charged", idempotency_key: "workflow:wf:step",
    });
  });

  it("records installation-scoped resource units as durable unpriced measurements", async () => {
    const requests: Request[] = [];
    const fetcher = vi.fn(async (request: Request) => { requests.push(request); return new Response(null, { status: 201 }); });
    const dimensions = { projectId: "project-1", installationId: "install-1", runId: "workflow-1" };
    await reportWorkflowResourceUsage(env(fetcher), "tenant", "space", "workflow-1:step-1:resource-units", "byte", 8192, dimensions);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(await requests[0]!.json()).toEqual({ event_type: "extension_resource_bytes", quantity: 8192, unit: "bytes", schema_version: 2,
      space_id: "space", project_id: "project-1", installation_id: "install-1", run_id: "workflow-1",
      idempotency_key: "workflow-1:step-1:resource-units" });
  });

  it("fails the effect path when the durable usage meter cannot accept the event", async () => {
    await expect(reportWorkflowResourceUsage(env(async () => new Response(null, { status: 503 })), "tenant", "space", "meter-1", "request", 1,
      { projectId: "project-1", installationId: "install-1", runId: "workflow-1" })).rejects.toThrow("workflow_resource_meter_failed:503");
  });
});
