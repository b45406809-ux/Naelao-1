import { describe, expect, it } from "vitest";
import {
  issueCapabilityToken,
  issueDelegationClaim,
  verifyCapabilityToken,
  verifyDelegationClaim,
} from "./delegation.js";

describe("delegation token boundaries", () => {
  it("rejects oversized capability claims before signing", async () => {
    await expect(
      issueCapabilityToken(
        {
          granteeSpaceId: "a",
          targetSpaceId: "b",
          resourceId: "c",
          nonce: "n",
          exp: 10,
          permissions: Array.from({ length: 65 }, (_, index) => `p${index}`),
        },
        "secret"
      )
    ).rejects.toThrow("Invalid capability payload");
    await expect(
      issueCapabilityToken(
        {
          granteeSpaceId: "a".repeat(257),
          targetSpaceId: "b",
          resourceId: "c",
          nonce: "n",
          exp: 10,
          permissions: ["read"],
        },
        "secret"
      )
    ).rejects.toThrow("Invalid capability payload");
  });

  it("bounds and verifies encoded tokens", async () => {
    const token = await issueCapabilityToken(
      {
        granteeSpaceId: "g",
        targetSpaceId: "t",
        resourceId: "r",
        permissions: ["read"],
        exp: 2_000,
        nonce: "n",
      },
      "secret"
    );
    expect(
      await verifyCapabilityToken(
        token,
        "secret",
        { granteeSpaceId: "g", targetSpaceId: "t", resourceId: "r" },
        1_000
      )
    ).not.toBeNull();
    expect(
      await verifyCapabilityToken(
        `${token}${"x".repeat(16_384)}`,
        "secret",
        { granteeSpaceId: "g", targetSpaceId: "t", resourceId: "r" },
        1_000
      )
    ).toBeNull();
    await expect(
      issueDelegationClaim(
        {
          initiatorUserId: "u".repeat(257),
          originatingRoleRank: 1,
          targetResourceId: "r",
          depth: 1,
          exp: 2_000,
        },
        "secret"
      )
    ).rejects.toThrow("Invalid delegation claim");
    expect(
      await verifyDelegationClaim("!".repeat(16_385), "secret")
    ).toBeNull();
  });
});
