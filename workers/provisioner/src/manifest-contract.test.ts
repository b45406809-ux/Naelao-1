import { describe, expect, it } from "vitest";
import { WORKSPACE_MANIFEST } from "../../spaces/src/workspace-manifest.js";
import { isProvisionableManifest } from "./manifest-contract.js";

const manifest = WORKSPACE_MANIFEST;

describe("provisioner manifest contract", () => {
  it("accepts a bounded manifest for the requested SpaceType", () => {
    expect(isProvisionableManifest(manifest, "workspace")).toBe(true);
  });

  it.each([
    [{ ...manifest, id: "other" }, "workspace"],
    [{ ...manifest, agentEnvironment: { ...manifest.agentEnvironment, defaultExecutionTier: "unknown" } }, "workspace"],
    [{ ...manifest, backend: { ...manifest.backend, platformDOs: "not-an-array" } }, "workspace"],
    [{ ...manifest, backend: { ...manifest.backend, r2Prefixes: ["../other-space"] } }, "workspace"],
    [{ ...manifest, backend: { ...manifest.backend, r2Prefixes: ["x".repeat(129)] } }, "workspace"],
    [{ ...manifest, ui: { ...manifest.ui, externalPortal: { enabled: true, templateId: "", defaultSlug: "bad slug" } } }, "workspace"],
    [{ ...manifest, lifecycle: { provisionerWorker: "http://example.com/provision" } }, "workspace"],
    [{ ...manifest, lifecycle: { provisionerWorker: "https://user:pass@example.com/provision" } }, "workspace"],
    [null, "workspace"],
  ])("rejects malformed provisioning manifest %#", (value, id) => {
    expect(isProvisionableManifest(value, id)).toBe(false);
  });
});
