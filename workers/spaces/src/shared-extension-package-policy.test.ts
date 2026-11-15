import { describe, expect, it } from "vitest";
import type { ExtensionManifest } from "@naelao/agent-sdk";
import { isSpaceSharedPackagePermissionAllowed } from "./shared-extension-package-policy.js";

describe("Space-shared package permissions", () => {
  it("allows the inventory permission only when a Space-shared signed action declares it", () => {
    const permission = "inventory.stock.receive";
    expect(isSpaceSharedPackagePermissionAllowed(permission)).toBe(false);
    expect(isSpaceSharedPackagePermissionAllowed(permission, {
      declaredPermissions: [permission],
      capabilityRequirements: ["extension.gadget.business_action"],
      bundle: { primitives: [{ kind: "gadget", scope: "SPACE_SHARED", businessActions: [{ permission, effects: "transactional_write" }],
        permissions: [{ scope: "SPACE_SHARED", actions: ["write"], resource: permission }] }] },
    } as unknown as ExtensionManifest)).toBe(true);
    expect(isSpaceSharedPackagePermissionAllowed(permission, {
      capabilityRequirements: ["extension.gadget.business_action"],
      bundle: { primitives: [{ kind: "gadget", scope: "PROJECT_BOUND", businessActions: [{ permission }] }] },
    } as unknown as ExtensionManifest)).toBe(false);
    expect(isSpaceSharedPackagePermissionAllowed(permission, {
      capabilityRequirements: ["extension.gadget.business_action"], bundle: { primitives: [{ kind: "canvas" }] },
    } as unknown as ExtensionManifest)).toBe(false);
  });

  it("admits read and write permissions only when the signed action and exact primitive grant agree", () => {
    const read = { id: "listLowStock", permission: "inventory.stock.read", effects: "read_only" };
    const write = { id: "adjustStock", permission: "inventory.stock.adjust", effects: "transactional_write" };
    const manifest = (action: typeof read | typeof write, actions: string[]) => ({
      capabilityRequirements: ["extension.gadget.business_action"],
      bundle: { primitives: [{ kind: "gadget", scope: "SPACE_SHARED", businessActions: [action],
        permissions: [{ scope: "SPACE_SHARED", resource: action.permission, actions }] }] },
    } as unknown as ExtensionManifest);
    expect(isSpaceSharedPackagePermissionAllowed(read.permission, manifest(read, ["read"]))).toBe(true);
    expect(isSpaceSharedPackagePermissionAllowed(read.permission, manifest(read, ["write"]))).toBe(false);
    expect(isSpaceSharedPackagePermissionAllowed(write.permission, manifest(write, ["write"]))).toBe(true);
    expect(isSpaceSharedPackagePermissionAllowed(write.permission, manifest(write, ["read"]))).toBe(false);
    expect(isSpaceSharedPackagePermissionAllowed("inventory.stock.read", manifest(write, ["read"]))).toBe(false);
  });
});
