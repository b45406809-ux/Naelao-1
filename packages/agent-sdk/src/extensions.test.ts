import { describe, expect, it } from "vitest";
import { validateExtensionManifest } from "./extensions.js";

const valid = { id: "ext_safe", type: "extension", declaredPermissions: ["repo.read"], capabilityRequirements: ["repo.read"], gadgets: [], daemons: [], commands: [] };
describe("immutable extension kernel", () => {
  it("verifies declared requirements against Gatekeeper capabilities", () => expect(validateExtensionManifest(valid, { gatekeeperCapabilities: ["repo.read"] }).id).toBe("ext_safe"));
  it("fails closed without explicit requirements", () => expect(() => validateExtensionManifest({ ...valid, capabilityRequirements: [] })).toThrow("capability_requirements_required"));
  it("rejects missing Gatekeeper grants", () => expect(() => validateExtensionManifest(valid, { gatekeeperCapabilities: [] })).toThrow("gatekeeper_capability_denied"));
  it.each([{ systemPromptLayers: ["replace"] }, { replLoopStepBounds: 999 }, { bypassWriteGuard: true }, { unsandboxedTools: ["bash"] }])("rejects kernel mutation %#", attack => expect(() => validateExtensionManifest({ ...valid, ...attack })).toThrow("invalid_extension_manifest"));
  it("accepts all four ownership scopes while preserving legacy names", () => {
    const scopes = ["PROJECT_SHARED", "PROJECT_USER", "SPACE_SHARED", "SPACE_USER"] as const;
    const tiers = [2, 1, 3, 1] as const;
    for (const [index, scope] of scopes.entries()) {
      const manifest = { ...valid, gadgets: [{ id: `gadget_${index}`, name: "Scoped", viewportComponent: "./view.ts", scope, gadgetTier: tiers[index], defaultSchemaSql: "CREATE TABLE records(id TEXT)" }] };
      expect(validateExtensionManifest(manifest).gadgets[0]?.scope).toBe(scope);
    }
  });
});
