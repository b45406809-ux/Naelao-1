import { describe, expect, it, vi } from "vitest";
import { triageCustomerMessage } from "./customer-triage.js";

describe("customer System One triage", () => {
  it("uses typed model decisions when the sentry is available", async () => {
    const choice = vi.fn(async () => ({ kind: "choice" as const, value: "billing" as const, provider: "openrouter" as const, policyCode: "customer_triage_v1", confidence: 0.9 }));
    const noul = vi.fn(async () => ({ kind: "noul" as const, value: true, provider: "openrouter" as const, policyCode: "customer_urgency_v1", probability: 0.88 }));
    await expect(triageCustomerMessage("Charged twice and launch is today", { choice, noul })).resolves.toMatchObject({ category: "billing", urgent: true, categoryDecision: { provider: "openrouter" } });
  });

  it("falls back deterministically when the sentry is unavailable", async () => {
    const choice = vi.fn(async () => { throw new Error("offline"); });
    const noul = vi.fn(async () => { throw new Error("offline"); });
    await expect(triageCustomerMessage("Urgent: refund this charge today", { choice, noul })).resolves.toMatchObject({ category: "billing", urgent: true, categoryDecision: { provider: "deterministic" }, urgencyDecision: { provider: "deterministic" } });
  });
});
