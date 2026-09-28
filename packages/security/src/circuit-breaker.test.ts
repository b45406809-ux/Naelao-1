import { describe, expect, it, vi } from "vitest";
import { inspectAutomationCircuit } from "./circuit-breaker.js";

describe("Ouroboros circuit breaker", () => {
  it("halts and records causal chains above two hops", async () => {
    const put = vi.fn(); const log = vi.fn();
    const result = await inspectAutomationCircuit(new Request("https://example.test", { headers: { "x-avos-hop-count": "3", "x-avos-causal-chain": "chain-1" } }), { OUROBOROS_CIRCUITS: { put } as never, logCircuitBreakerTrip: log });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.response.status).toBe(409);
    expect(put).toHaveBeenCalledWith("ouroboros:chain-1", expect.any(String), { expirationTtl: 3600 });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ type: "ouroboros_loop_detected" }));
  });
});
