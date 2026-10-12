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
  it("accepts ordered forward-only schema migrations and rejects executable or unordered definitions", () => {
    const manifest = { ...valid, gadgets: [{ id: "notes", name: "Notes", viewportComponent: "./view.ts", scope: "PROJECT_SHARED", gadgetTier: 2, defaultSchemaSql: "CREATE TABLE notes(id TEXT)", migrations: [
      { version: 1, description: "add note state", up: "ALTER TABLE notes ADD COLUMN state TEXT NOT NULL DEFAULT 'draft';" },
      { version: 2, description: "index state", up: "CREATE INDEX notes_state ON notes(state);" },
    ] }] };
    expect(validateExtensionManifest(manifest).gadgets[0]?.migrations).toHaveLength(2);
    expect(() => validateExtensionManifest({ ...manifest, gadgets: [{ ...manifest.gadgets[0], migrations: [{ version: 2, description: "second", up: "CREATE TABLE x(id TEXT)" }, { version: 1, description: "first", up: "CREATE TABLE y(id TEXT)" }] }] })).toThrow("migration_versions_must_increase");
  });
});
