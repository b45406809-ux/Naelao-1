import { describe, expect, it, vi } from "vitest";
import type { AgentsEnv } from "../index.js";
import { reserveManagedServiceCredits } from "./managed-service-billing.js";

// MS-41 item 1: Project daily spend headroom reaches the Billing reserve as composed_limits, only behind the flag.
const scope = { tenantId: "org_1", spaceId: "space_1", userId: "user_1", projectId: "proj_1", role: "owner" };
const request = { reservationId: "res_1", operationId: "op_1", provider: "cloudflare", serviceId: "workers-ai", operationName: "run",
  region: "global", credits: 5, priceVersion: "v1", enforceProjectSpend: true };

function env(flag: string | undefined, spend: unknown, spendStatus = 200) {
  const billing: Record<string, unknown>[] = [];
  const spaces = vi.fn(async () => Response.json(spend, { status: spendStatus }));
  return { billing, spaces, env: { PLATFORM_SECRET: "secret", MANAGED_LIMITS_COMPOSED_ENABLED: flag,
    BILLING_WORKER: { fetch: vi.fn(async (r: Request) => { billing.push(await r.json() as Record<string, unknown>); return Response.json({ reserved: true, status: "held" }); }) },
    SPACES_WORKER: { fetch: spaces } } as unknown as AgentsEnv };
}

describe("MS-41 composed limits caller", () => {
  it("sends the Project spend headroom keyed by project and day", async () => {
    const e = env("true", { day: "2026-11-26", cap: 100, spent_plus_reserved: 70 });
    await reserveManagedServiceCredits(e.env, scope, request);
    expect(e.billing[0]!.composed_limits).toEqual([{ kind: "project_spend", scope_key: "proj_1:2026-11-26", headroom_credits: 30 }]);
  });
  it("sends nothing for an uncapped Project or a scope without a Project", async () => {
    const uncapped = env("true", { day: "2026-11-26", cap: 0, spent_plus_reserved: 0 });
    await reserveManagedServiceCredits(uncapped.env, scope, request);
    expect(uncapped.billing[0]).not.toHaveProperty("composed_limits");
    const noProject = env("true", {});
    await reserveManagedServiceCredits(noProject.env, { ...scope, projectId: undefined as never }, request);
    expect(noProject.spaces).not.toHaveBeenCalled();
  });
  it("floors headroom at zero when the cap is already exceeded", async () => {
    const e = env("true", { day: "2026-11-26", cap: 10, spent_plus_reserved: 50 });
    await reserveManagedServiceCredits(e.env, scope, request);
    expect((e.billing[0]!.composed_limits as Array<{ headroom_credits: number }>)[0]!.headroom_credits).toBe(0);
  });
  it("fails closed when the cap cannot be read", async () => {
    const e = env("true", {}, 503);
    await expect(reserveManagedServiceCredits(e.env, scope, request)).rejects.toThrow("managed_service_billing_limit_unavailable");
    expect(e.billing).toHaveLength(0);
  });
  it("flag off or caller not opted in: no Spaces read and an unchanged body", async () => {
    const off = env(undefined, { day: "2026-11-26", cap: 100, spent_plus_reserved: 1 });
    await reserveManagedServiceCredits(off.env, scope, request);
    expect(off.spaces).not.toHaveBeenCalled();
    expect(off.billing[0]).not.toHaveProperty("composed_limits");
    const renewal = env("true", { day: "2026-11-26", cap: 100, spent_plus_reserved: 1 });
    await reserveManagedServiceCredits(renewal.env, scope, { ...request, enforceProjectSpend: false });
    expect(renewal.spaces).not.toHaveBeenCalled();
  });
});
