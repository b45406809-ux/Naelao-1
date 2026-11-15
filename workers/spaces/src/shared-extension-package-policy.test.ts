import { describe, expect, it } from "vitest";
import type { ExtensionManifest } from "@naelao/agent-sdk";
import { isSpaceSharedPackagePermissionAllowed } from "./shared-extension-package-policy.js";

describe("Space-shared package permissions", () => {
  it("allows the inventory permission only when a Space-shared signed action declares it", () => {
    const permission = "inventory.stock.receive";
    expect(isSpaceSharedPackagePermissionAllowed(permission)).toBe(false);
    expect(isSpaceSharedPackagePermissionAllowed(permission, {
      capabilityRequirements: ["extension.gadget.business_action"],
      bundle: { primitives: [{ kind: "gadget", scope: "SPACE_SHARED", businessActions: [{ permission }] }] },
    } as unknown as ExtensionManifest)).toBe(true);
    expect(isSpaceSharedPackagePermissionAllowed(permission, {
      capabilityRequirements: ["extension.gadget.business_action"],
      bundle: { primitives: [{ kind: "gadget", scope: "PROJECT_BOUND", businessActions: [{ permission }] }] },
    } as unknown as ExtensionManifest)).toBe(false);
    expect(isSpaceSharedPackagePermissionAllowed(permission, {
      capabilityRequirements: ["extension.gadget.business_action"], bundle: { primitives: [{ kind: "canvas" }] },
    } as unknown as ExtensionManifest)).toBe(false);
  });
});
