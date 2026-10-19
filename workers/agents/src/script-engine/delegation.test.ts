import { describe, expect, it, vi } from "vitest";
import {
  createRuntimeContext,
  TurnDelegatedError,
  type RuntimeContextServices,
} from "@naelao/agent-sdk";
import {
  issueCapabilityToken,
  issueDelegationClaim,
  verifyCapabilityToken,
  verifyDelegationClaim,
} from "@naelao/security";
import { routeMentions, routeMentionsWithSentry } from "./mention-router.js";

const secret = "unit-test-platform-secret";

function services(): RuntimeContextServices {
  return {
    fs: { read: vi.fn(), write: vi.fn(), edit: vi.fn(), diff: vi.fn(), grep: vi.fn(), glob: vi.fn() },
    vault: { fetchWithAuth: vi.fn() }, browser: { navigate: vi.fn(), click: vi.fn(), type: vi.fn(), extract: vi.fn() },
    mcp: { call: vi.fn(), listTools: vi.fn() }, connectors: { call: vi.fn() }, run: { runSkill: vi.fn() },
    project: { getJournal: vi.fn(), updateJournal: vi.fn(), createTask: vi.fn(), listThreads: vi.fn(), postMessage: vi.fn() },
    delegation: { transfer: vi.fn(async (request) => ({ targetAgentId: request.targetAgentId, depth: (request.currentDepth + 1) as 2 | 3, delegationToken: "signed" })) },
  };
}

describe("signed delegation security", () => {
  it("fails closed for tampering, expiry, and a mismatched resource", async () => {
    const payload = { granteeSpaceId: "sales", targetSpaceId: "legal", resourceId: "case-1", permissions: ["read"], exp: Date.now() + 10_000, nonce: "n-1" };
    const token = await issueCapabilityToken(payload, secret);
    expect(await verifyCapabilityToken(token, secret, { granteeSpaceId: "sales", targetSpaceId: "legal", resourceId: "case-1", permission: "read" })).toEqual(expect.objectContaining(payload));
    expect(await verifyCapabilityToken(`${token.slice(0, -1)}x`, secret, { granteeSpaceId: "sales", targetSpaceId: "legal", resourceId: "case-1" })).toBeNull();
    expect(await verifyCapabilityToken(token, secret, { granteeSpaceId: "sales", targetSpaceId: "legal", resourceId: "case-2" })).toBeNull();
    expect(await verifyCapabilityToken(token, secret, { granteeSpaceId: "sales", targetSpaceId: "legal", resourceId: "case-1" }, payload.exp)).toBeNull();
  });

  it("preserves the original user and rejects privilege escalation", async () => {
    const token = await issueDelegationClaim({ initiatorUserId: "human-1", originatingRoleRank: 2, targetResourceId: "worker", depth: 2, exp: Date.now() + 1000 }, secret);
    expect(await verifyDelegationClaim(token, secret, { maximumRoleRank: 2 })).toMatchObject({ initiatorUserId: "human-1", originatingRoleRank: 2 });
    expect(await verifyDelegationClaim(token, secret, { maximumRoleRank: 1 })).toBeNull();
  });
});

describe("turn routing and delegation ceiling", () => {
  it("routes only the first mention as holder", () => {
    expect(routeMentions("@lead ask @legal, then tell @ops")).toEqual({ turnHolder: "lead", referents: ["legal", "ops"], mentions: ["lead", "legal", "ops"] });
    expect(routeMentions("email a@b.test").turnHolder).toBeNull();
  });

  it("uses high-confidence System One routing only within explicit mentions", async () => {
    const route = await routeMentionsWithSentry("@lead ask @legal to review", {
      choice: async () => ({ kind: "choice", value: "legal", provider: "openrouter", policyCode: "mention_primary_turn_holder", confidence: 0.92 }),
      score: async () => { throw new Error("unused"); },
      noul: async () => { throw new Error("unused"); },
    });
    expect(route).toEqual({ turnHolder: "legal", referents: ["lead"], mentions: ["lead", "legal"] });
  });

  it("keeps deterministic routing when System One confidence is low", async () => {
    const route = await routeMentionsWithSentry("@lead ask @legal", {
      choice: async () => ({ kind: "choice", value: "legal", provider: "openrouter", policyCode: "mention_primary_turn_holder", confidence: 0.4 }),
      score: async () => { throw new Error("unused"); },
      noul: async () => { throw new Error("unused"); },
    });
    expect(route.turnHolder).toBe("lead");
  });

  it.each([1, 2] as const)("injects delegation at depth %s and terminates the caller", async (depth) => {
    const backing = services();
    const context = createRuntimeContext({ scope: "PROJECT_BOUND", projectId: "p", services: backing, delegationDepth: depth, initiatorUserId: "u", originatingRoleRank: 2 });
    expect("delegate" in context).toBe(true);
    await expect((context as unknown as { delegate(input: unknown): Promise<never> }).delegate({ targetAgentId: "next", task: "work" })).rejects.toBeInstanceOf(TurnDelegatedError);
    expect(backing.delegation?.transfer).toHaveBeenCalledOnce();
  });

  it("physically omits delegation from depth 3", () => {
    const context = createRuntimeContext({ scope: "PROJECT_BOUND", projectId: "p", services: services(), delegationDepth: 3 });
    expect("delegate" in context).toBe(false);
    expect("agent" in context).toBe(false);
  });
});
