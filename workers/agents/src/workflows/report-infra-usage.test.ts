import { describe, expect, it, vi } from "vitest";
import { finalizeWorkflowBudget, reserveWorkflowBudget, reportWorkflowStepInfraUsage } from "./report-infra-usage.js";

function env(fetcher: (request: Request) => Promise<Response>) {
  return { PLATFORM_SECRET: "secret", BILLING_WORKER: { fetch: fetcher } } as never;
}

describe("workflow budget contract", () => {
  it("uses the durable workflow instance as an idempotent reservation", async () => {
    const requests: Request[] = [];
    const reservation = await reserveWorkflowBudget(env(async request => { requests.push(request); return Response.json({ reservation_id: "wf-1" }, { status: 201 }); }), "tenant", "space", "wf-1", "workflow:ephemeral_task:user", 7);
    expect(reservation).toBe("wf-1");
    expect(await requests[0]!.json()).toMatchObject({ reservation_id: "wf-1", workflow_id: "wf-1", credits: 7 });
  });

  it("settles measured credits and reports the same amount once", async () => {
    const requests: Request[] = [];
    const fetcher = vi.fn(async (request: Request) => { requests.push(request); return new Response(null, { status: 200 }); });
    const measured = await reportWorkflowStepInfraUsage(env(fetcher), "tenant", "space", 1000, "workflow:wf:step", false);
    await finalizeWorkflowBudget(env(fetcher), "tenant", "wf-1", "settle", measured);
    expect(measured).toBeGreaterThan(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await requests[0]!.json()).toMatchObject({ reservation_id: "wf-1", quantity: measured });
  });
});
