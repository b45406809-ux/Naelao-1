import { describe, expect, it } from "vitest";
import { buildProjectExtensionUpdateReview } from "./project-extension-update-review.js";

describe("project extension update review", () => {
  it("binds review to the exact installation generation and reports authority, resource, dependency and code changes", () => {
    const review = buildProjectExtensionUpdateReview({
      installationId: "install-1", installationGeneration: 4, currentManifestSha256: "a".repeat(64),
      currentArtifactSha256: "b".repeat(64), publisherId: "publisher-1", publisherKeyId: "c".repeat(64),
      candidateManifestSha256: "d".repeat(64), candidateArtifactSha256: "e".repeat(64),
      current: { id: "ext_sample", bundle: { version: "1.0.0", primitives: [{ id: "main", kind: "canvas" }] },
        declaredPermissions: ["read"], capabilityRequirements: ["data.read"],
        resourceRequirements: [{ id: "records", kind: "structured_data", schema: "v1" }],
        dependencies: [{ extensionId: "ext_dep", version: "1.0.0", manifestSha256: "f".repeat(64) }] },
      candidate: { id: "ext_sample", bundle: { version: "1.1.0", primitives: [{ id: "main", kind: "canvas" }, { id: "sync", kind: "workflow" }] },
        declaredPermissions: ["read", "write"], capabilityRequirements: ["data.read", "jobs.run"],
        resourceRequirements: [{ id: "records", kind: "structured_data", schema: "v2" }, { id: "uploads", kind: "objects" }],
        dependencies: [] },
    });
    expect(review).toMatchObject({ installation_id: "install-1", installation_generation: 4,
      current: { version: "1.0.0" }, candidate: { version: "1.1.0", signature_verified: true },
      permissions: { added: ["write"], removed: [] }, capabilities: { added: ["jobs.run"], removed: [] },
      resources: { added: ["uploads"], removed: [], changed: ["records"] },
      dependencies: { removed: ["ext_dep"] }, primitives: { added: ["sync"] },
      cost_terms: { status: "unknown" }, apply_supported: false, mutates_installation: false });
  });
});
