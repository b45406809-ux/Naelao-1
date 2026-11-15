import type { ExtensionManifest } from "@naelao/agent-sdk";

export const SPACE_SHARED_PACKAGE_CAPABILITIES = new Set([
  "channel.invoke", "events.subscribe", "extension.gadget.read", "extension.gadget.business_action", "extension.project_canvas",
  "extension.settings.read", "extension.settings.configure", "assistant.phone.read", "assistant.phone.simulate",
  "space.shared.read", "space.shared.write",
]);

export const SPACE_SHARED_PACKAGE_PERMISSIONS = new Set([
  "events.subscribe", "extension.settings.read", "extension.settings.configure", "assistant.phone.read", "assistant.phone.simulate",
]);

/** Business-action permissions are allowed only when a validated signed gadget declares the
 * matching action. Do not let the permission string alone opt an otherwise unrelated package
 * into a write capability. The package-shape checks still enforce exact primitive permissions. */
export function isSpaceSharedPackagePermissionAllowed(permission: string, manifest?: ExtensionManifest): boolean {
  if (SPACE_SHARED_PACKAGE_PERMISSIONS.has(permission)) return true;
  if (permission !== "inventory.stock.receive" || !manifest?.capabilityRequirements.includes("extension.gadget.business_action")) return false;
  const bundleActions = (manifest.bundle?.primitives ?? []).some(primitive => primitive.kind === "gadget"
    && primitive.scope === "SPACE_SHARED" && (primitive.businessActions ?? []).some(action => action.permission === permission));
  const legacyActions = (manifest.gadgets ?? []).some(gadget => gadget.scope === "SPACE_SHARED" && gadget.gadgetTier === 3
    && (gadget.businessActions ?? []).some(action => action.permission === permission));
  return bundleActions || legacyActions;
}
