import { describe, expect, it, vi } from "vitest";
import { GatewayReasoner, modelForDelegationDepth, preferredLanguageContext } from "./reasoner.js";

describe("delegation-depth model tiering", () => {
  it("physically clamps depth 3 to the free edge model", () => {
    expect(modelForDelegationDepth(3, "anthropic/claude-opus-4-1")).toBe("@cf/meta/llama-3.2-3b-instruct");
    expect(modelForDelegationDepth(2)).toBe("groq/llama-3.3-70b-versatile");
  });
});

describe("saved language preference context", () => {
  it("defers to an explicit current-turn language request and preserves code-switching", () => {
    const context = preferredLanguageContext("fr-CA");
    expect(context?.preferred_language).toBe("fr-CA");
    expect(context?.preferred_language_rule).toContain("An explicit language request in the current message wins");
    expect(context?.preferred_language_rule).toContain("Preserve mixed-language and code-switched input");
  });

  it("omits a preference when unset", () => {
    expect(preferredLanguageContext()).toBeUndefined();
  });
});

describe("pre-inference spend admission", () => {
  const input = { goal: "answer", level: "L2", snapshot: {}, candidates: [], availableOperations: [] } as never;
  const deps = (reserveInferenceCost: () => Promise<boolean>) => ({
    apiKey: "", gateway: { accountId: "test", gatewayId: "test" },
    ctx: { spaceId: "space", agentId: "agent", model: "test-model" }, model: "test-model",
    reserveInferenceCost,
  });

  it("does not continue when the project cap rejects the reservation", async () => {
    const reserveInferenceCost = vi.fn(async () => false);
    const decision = await new GatewayReasoner(deps(reserveInferenceCost)).decide(input);
    expect(reserveInferenceCost).toHaveBeenCalledWith(expect.objectContaining({ model: "test-model", maxOutputTokens: 1500 }));
    expect(decision).toMatchObject({ action: "give_up", reason: "project_spend_capped: no inference was sent" });
  });

  it("fails closed when reservation status cannot be verified", async () => {
    const decision = await new GatewayReasoner(deps(async () => { throw new Error("offline"); })).decide(input);
    expect(decision).toMatchObject({ action: "give_up", reason: "project_spend_reservation_unavailable: no inference was sent" });
  });
});
