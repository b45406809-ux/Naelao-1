import { describe, expect, it } from "vitest";
import { projectExtensionRollbackReview } from "./extension-rollback-review";

describe("extension release rollback review", () => {
  it("pins the signed artifact and shows authority expansion and revoked publisher status", () => {
    expect(projectExtensionRollbackReview({ version: "1.0.0", artifactSha256: "a".repeat(64), hostSignature: "host",
      signatureValid: true, createdAt: "2026-01-01", permissions: ["read", "write"], capabilities: ["tool.read", "tool.send"],
      publisher: { id: "pub_demo", keyId: "b".repeat(64), revoked: true } }, { permissions: ["read"], capabilities: ["tool.read"] }))
      .toEqual({ version: "1.0.0", artifactSha256: "a".repeat(64), publisherId: "pub_demo", publisherKeyId: "b".repeat(64),
        publisherRevoked: true, addedPermissions: ["write"], addedCapabilities: ["tool.send"] });
  });
  it("does not render unverified or malformed artifact candidates", () => {
    expect(projectExtensionRollbackReview({ version: "1.0.0", artifactSha256: "bad", hostSignature: "", signatureValid: true, createdAt: "" }, {})).toBeNull();
    expect(projectExtensionRollbackReview({ version: "1.0.0", artifactSha256: "a".repeat(64), hostSignature: "", signatureValid: false, createdAt: "" }, {})).toBeNull();
  });
});
