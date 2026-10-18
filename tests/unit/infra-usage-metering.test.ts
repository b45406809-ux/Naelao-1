import { describe, it, expect, vi } from "vitest";
import { infraTimeToCredits } from "../../packages/billing-core/src/index.js";
import { reportWorkflowStepInfraUsage } from "../../workers/agents/src/workflows/report-infra-usage.js";
import type { Env } from "../../workers/agents/src/env.js";

// §A1.26: per-tenant/per-user Cloudflare infra usage tracking. infraTimeToCredits is the infra
// counterpart to tokensToCredits — same "always round up, minimum 1 credit for nonzero cost"
// invariant, applied to isolate/container wall-clock time and durable Workflow steps instead of
// LLM tokens.

describe("infraTimeToCredits", () => {
  it("returns 0 for zero duration and rejects negative duration", () => {
    expect(infraTimeToCredits("isolate", 0)).toBe(0);
    expect(() => infraTimeToCredits("isolate", -5)).toThrow(RangeError);
  });

  it("rounds up to a minimum of 1 credit for any nonzero isolate duration", () => {
    expect(infraTimeToCredits("isolate", 1)).toBe(1);
    expect(infraTimeToCredits("isolate", 500)).toBeGreaterThanOrEqual(1);
  });

  it("a long container allocation costs more than an isolate invocation", () => {
    const isolateCredits = infraTimeToCredits("isolate", 3_600_000);
    const containerCredits = infraTimeToCredits("container", 3_600_000);
    expect(containerCredits).toBeGreaterThan(isolateCredits);
  });

  it("a workflow_step always costs at least 1 credit as a flat fee, even at duration 0", () => {
    expect(infraTimeToCredits("workflow_step", 0)).toBeGreaterThanOrEqual(1);
  });

  it("longer durations cost strictly more credits than shorter ones (monotonic)", () => {
    const short = infraTimeToCredits("container", 10_000);
    const long = infraTimeToCredits("container", 1_000_000);
    expect(long).toBeGreaterThan(short);
  });
});

describe("reportWorkflowStepInfraUsage — Workflow step timing reaches the billing worker", () => {
  function makeEnv(billingFetch?: ReturnType<typeof vi.fn>): Env {
    return {
      PLATFORM_SECRET: "test-secret",
      BILLING_WORKER: billingFetch ? { fetch: billingFetch } : undefined,
    } as unknown as Env;
  }

  it("posts an infra_credits usage event with the space/tenant and a stable idempotency key", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("{}", { status: 201 }));
    const env = makeEnv(fetchFn);
    await reportWorkflowStepInfraUsage(env, "tenant-1", "space-1", 5000, "workflow:abc:execute-script");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const req = fetchFn.mock.calls[0]![0] as Request;
    expect(req.headers.get("x-naelao-tenant-id")).toBe("tenant-1");
    const body = JSON.parse(await req.text()) as { event_type: string; space_id: string; idempotency_key: string; quantity: number };
    expect(body.event_type).toBe("infra_credits");
    expect(body.space_id).toBe("space-1");
    expect(body.idempotency_key).toBe("workflow:abc:execute-script");
    expect(body.quantity).toBeGreaterThanOrEqual(1);
  });

  it("returns zero when BILLING_WORKER is unbound", async () => {
    const env = makeEnv(undefined);
    await expect(reportWorkflowStepInfraUsage(env, "tenant-1", "space-1", 5000, "k")).resolves.toBe(0);
  });

  it("returns the computed credits when the billing worker call itself fails", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("network down"));
    const env = makeEnv(fetchFn);
    await expect(reportWorkflowStepInfraUsage(env, "tenant-1", "space-1", 5000, "k")).resolves.toBe(1);
  });
});
