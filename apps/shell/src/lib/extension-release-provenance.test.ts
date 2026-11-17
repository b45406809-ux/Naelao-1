import { describe, expect, it } from "vitest";
import { projectInstalledExtensionReleaseProvenance } from "./extension-release-provenance";

describe("installed extension release provenance", () => {
  it("projects verified host release pins and keeps revoked trust distinct", () => {
    expect(projectInstalledExtensionReleaseProvenance({ release_version: "1.2.0", manifest_sha256: "a".repeat(64),
      pinned_artifact_sha256: "b".repeat(64), publisher_payload_sha256: "c".repeat(64), publisher_key_id: "d".repeat(64),
      publisher_attestation_valid: true, publisher_trusted: false })).toEqual({ version: "1.2.0", manifestSha256: "a".repeat(64),
      hostArtifactSha256: "b".repeat(64), publisherPayloadSha256: "c".repeat(64), publisherKeyId: "d".repeat(64), trusted: false });
  });
  it("fails closed when a server release attestation or exact digest is missing", () => {
    expect(projectInstalledExtensionReleaseProvenance({ publisher_attestation_valid: false, manifest_sha256: "a".repeat(64) })).toBeNull();
    expect(projectInstalledExtensionReleaseProvenance({ publisher_attestation_valid: true, release_version: "1.0.0",
      manifest_sha256: "a".repeat(64), pinned_artifact_sha256: "bad", publisher_key_id: "d".repeat(64) })).toBeNull();
  });
});
