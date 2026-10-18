import { describe, expect, it, vi } from "vitest";
import { inspectAutomationCircuit } from "./circuit-breaker.js";
import { resolveKnowledgeClearance } from "./knowledge-permissions.js";
import {
  generateCsrfToken,
  validatePasswordStrength,
  verifyApiKey,
  verifyCsrfToken,
} from "./secrets.js";

describe("security control input boundaries", () => {
  it("requires canonical bounded automation cursors and bounds causal chain keys", async () => {
    for (const hop of ["1tail", "-1", "1.0", "9".repeat(100)]) {
      const result = await inspectAutomationCircuit(
        new Request("https://example.test", {
          headers: { "x-avos-hop-count": hop },
        }),
        {}
      );
      expect(result).toMatchObject({ allowed: false });
    }
    const oversized = await inspectAutomationCircuit(
      new Request("https://example.test", {
        headers: {
          "x-avos-hop-count": "3",
          "x-avos-causal-chain": "x".repeat(257),
        },
      }),
      {}
    );
    expect(oversized).toMatchObject({ allowed: false });
    const trip = await inspectAutomationCircuit(
      new Request("https://example.test", {
        headers: { "x-avos-hop-count": "3" },
      }),
      {
        logCircuitBreakerTrip: async () => {
          throw new Error("log down");
        },
      }
    );
    expect(trip).toMatchObject({ allowed: false, response: { status: 409 } });
  });

  it("rejects malformed roles and oversized membership claims", () => {
    expect(() =>
      resolveKnowledgeClearance(
        { userId: "u", role: "root" as never, spaceIds: ["s"] },
        "s"
      )
    ).toThrow();
    expect(() =>
      resolveKnowledgeClearance(
        { userId: "u", role: "member", spaceIds: Array(1001).fill("s") },
        "s"
      )
    ).toThrow();
    expect(
      resolveKnowledgeClearance(
        { userId: "u", role: "member", spaceIds: ["s"], projectIds: ["p"] },
        "s",
        "p"
      )
    ).toMatchObject({ roleMask: 2, scope: "PROJECT_BOUND" });
  });

  it("rejects future CSRF tokens, malformed hashes, and extreme credential inputs", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(100_000));
      const token = await generateCsrfToken("session", "secret");
      vi.setSystemTime(new Date(0));
      await expect(verifyCsrfToken(token, "session", "secret")).resolves.toBe(
        false
      );
    } finally {
      vi.useRealTimers();
    }
    await expect(verifyApiKey("x".repeat(2048), "a".repeat(64))).resolves.toBe(
      false
    );
    expect(validatePasswordStrength("x".repeat(1025))).toMatchObject({
      valid: false,
    });
  });
});
