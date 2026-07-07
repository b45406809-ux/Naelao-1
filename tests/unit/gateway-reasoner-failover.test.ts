import { describe, it, expect, vi, afterEach } from "vitest";
import { GatewayReasoner } from "../../workers/agents/src/script-engine/reasoner.js";
import type { ObserveSnapshot } from "../../workers/agents/src/script-engine/types.js";

// Tier 2/3 follow-up (spec §15 gap): "a real LLM-provider failover chain beyond CF AI Gateway's
// own dashboard-configurable retries" — the reasoner only ever called the Anthropic-compatible
// endpoint with no cross-PROVIDER failover; a primary failure just gave up immediately. This adds
// an optional CF Workers AI fallback (already-bound platform-wide, no new credentials needed) that
// only engages once the primary call has definitively failed (network error or non-2xx) —
// CF AI Gateway's own retries already cover transient same-provider hiccups before this point.

const SNAPSHOT: ObserveSnapshot = { type: "compute", timestamp: Date.now(), fingerprint: "fp1" };
const DECIDE_INPUT = {
  goal: "test goal",
  level: "L2" as const,
  snapshot: SNAPSHOT,
  candidates: [],
  availableOperations: ["script.run"],
};

function anthropicSuccessResponse(): Response {
  return new Response(JSON.stringify({
    content: [{ type: "text", text: JSON.stringify({ action: "answer", text: "primary answered" }) }],
    usage: { input_tokens: 100, output_tokens: 20 },
  }), { status: 200 });
}

function fakeAi(responseText: string): Ai {
  return { run: vi.fn(async () => ({ response: responseText })) } as unknown as Ai;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GatewayReasoner — primary success (unchanged behavior)", () => {
  it("returns the primary decision and real usage without touching the fallback", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(anthropicSuccessResponse());
    const ai = fakeAi(JSON.stringify({ action: "answer", text: "should never be used" }));
    const reasoner = new GatewayReasoner({
      apiKey: "key", gateway: { accountId: "placeholder", gatewayId: "gw" },
      ctx: { spaceId: "space1" }, fallback: { ai },
    });
    const decision = await reasoner.decide(DECIDE_INPUT);
    expect(decision).toEqual({ action: "answer", text: "primary answered" });
    expect(reasoner.lastUsage).toEqual({ input_tokens: 100, output_tokens: 20 });
    expect(ai.run).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("GatewayReasoner — cross-provider failover", () => {
  it("falls back to CF Workers AI on a non-2xx primary response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("rate limited", { status: 429 }));
    const ai = fakeAi(JSON.stringify({ action: "answer", text: "fallback answered" }));
    const reasoner = new GatewayReasoner({
      apiKey: "key", gateway: { accountId: "placeholder", gatewayId: "gw" },
      ctx: { spaceId: "space1" }, fallback: { ai },
    });
    const decision = await reasoner.decide(DECIDE_INPUT);
    expect(decision).toEqual({ action: "answer", text: "fallback answered" });
    expect(ai.run).toHaveBeenCalledTimes(1);
  });

  it("falls back to CF Workers AI on a network error (fetch throws)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const ai = fakeAi(JSON.stringify({ action: "give_up", reason: "fallback also had nothing" }));
    const reasoner = new GatewayReasoner({
      apiKey: "key", gateway: { accountId: "placeholder", gatewayId: "gw" },
      ctx: { spaceId: "space1" }, fallback: { ai },
    });
    const decision = await reasoner.decide(DECIDE_INPUT);
    expect(decision).toEqual({ action: "give_up", reason: "fallback also had nothing" });
    expect(ai.run).toHaveBeenCalledTimes(1);
  });

  it("leaves lastUsage unset for a fallback response (not billed against the tenant)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("error", { status: 500 }));
    const ai = fakeAi(JSON.stringify({ action: "answer", text: "ok" }));
    const reasoner = new GatewayReasoner({
      apiKey: "key", gateway: { accountId: "placeholder", gatewayId: "gw" },
      ctx: { spaceId: "space1" }, fallback: { ai },
    });
    await reasoner.decide(DECIDE_INPUT);
    expect(reasoner.lastUsage).toBeUndefined();
  });

  it("gives up with a combined error when BOTH providers fail", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("error", { status: 503 }));
    const ai = { run: vi.fn(async () => { throw new Error("workers ai unavailable"); }) } as unknown as Ai;
    const reasoner = new GatewayReasoner({
      apiKey: "key", gateway: { accountId: "placeholder", gatewayId: "gw" },
      ctx: { spaceId: "space1" }, fallback: { ai },
    });
    const decision = await reasoner.decide(DECIDE_INPUT);
    expect(decision.action).toBe("give_up");
    expect((decision as { reason: string }).reason).toContain("503");
    expect((decision as { reason: string }).reason).toContain("workers ai unavailable");
  });

  it("gives up immediately (unchanged legacy behavior) when no fallback is configured", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("error", { status: 500 }));
    const reasoner = new GatewayReasoner({
      apiKey: "key", gateway: { accountId: "placeholder", gatewayId: "gw" },
      ctx: { spaceId: "space1" },
    });
    const decision = await reasoner.decide(DECIDE_INPUT);
    expect(decision).toEqual({ action: "give_up", reason: "reasoner LLM error 500" });
  });

  it("gives up with a network-error message when no fallback is configured and fetch throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("dns failure"));
    const reasoner = new GatewayReasoner({
      apiKey: "key", gateway: { accountId: "placeholder", gatewayId: "gw" },
      ctx: { spaceId: "space1" },
    });
    const decision = await reasoner.decide(DECIDE_INPUT);
    expect(decision).toEqual({ action: "give_up", reason: "reasoner LLM network error: dns failure" });
  });

  it("uses the configured fallback model when specified", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("error", { status: 500 }));
    const ai = fakeAi(JSON.stringify({ action: "answer", text: "ok" }));
    const reasoner = new GatewayReasoner({
      apiKey: "key", gateway: { accountId: "placeholder", gatewayId: "gw" },
      ctx: { spaceId: "space1" }, fallback: { ai, model: "@cf/custom/model" },
    });
    await reasoner.decide(DECIDE_INPUT);
    expect(ai.run).toHaveBeenCalledWith("@cf/custom/model", expect.anything());
  });
});
