import { describe, expect, it } from "vitest";
import { LAUNCHPAD_MANIFEST } from "../../spaces/src/launchpad-manifest.js";
import { isProvisionableManifest } from "./manifest-contract.js";

const manifest = LAUNCHPAD_MANIFEST;

describe("provisioner manifest contract", () => {
  it("accepts a bounded manifest for the requested SpaceType", () => {
    expect(isProvisionableManifest(manifest, "launchpad")).toBe(true);
  });

  it.each([
    [{ ...manifest, id: "other" }, "launchpad"],
    [{ ...manifest, agentEnvironment: { ...manifest.agentEnvironment, defaultExecutionTier: "unknown" } }, "launchpad"],
    [{ ...manifest, backend: { ...manifest.backend, platformDOs: "not-an-array" } }, "launchpad"],
    [{ ...manifest, backend: { ...manifest.backend, r2Prefixes: ["../other-space"] } }, "launchpad"],
    [{ ...manifest, backend: { ...manifest.backend, r2Prefixes: ["x".repeat(129)] } }, "launchpad"],
    [{ ...manifest, backend: { ...manifest.backend, workflowTemplates: Array(101).fill({ id: "x", name: "x", triggerType: "event" }) } }, "launchpad"],
    [{ ...manifest, backend: { ...manifest.backend, workflowTemplates: [{ id: 1, name: "x", triggerType: "event" }] } }, "launchpad"],
    [{ ...manifest, ui: { ...manifest.ui, externalPortal: { enabled: true, templateId: "", defaultSlug: "bad slug" } } }, "launchpad"],
    [{ ...manifest, lifecycle: { provisionerWorker: "http://example.com/provision" } }, "launchpad"],
    [{ ...manifest, lifecycle: { provisionerWorker: "https://user:pass@example.com/provision" } }, "launchpad"],
    [null, "launchpad"],
  ])("rejects malformed provisioning manifest %#", (value, id) => {
    expect(isProvisionableManifest(value, id)).toBe(false);
  });
});
