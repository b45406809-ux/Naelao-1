import type { ExtensionManifest } from "@naelao/agent-sdk";

export const SPACE_SHARED_PACKAGE_CAPABILITIES = new Set([
  "channel.invoke", "events.subscribe", "extension.gadget.read", "extension.gadget.business_action", "extension.project_canvas",
  "extension.settings.read", "extension.settings.configure", "assistant.phone.read", "assistant.phone.simulate",
  "space.shared.read", "space.shared.write",
]);

export const SPACE_SHARED_PACKAGE_PERMISSIONS = new Set([
  "events.subscribe", "extension.settings.read", "extension.settings.configure", "assistant.phone.read", "assistant.phone.simulate",
]);

/** Business-action permissions are allowed only when a validated signed Gadget declares the
 * matching named action and the primitive grants exactly the read/write effect that action needs.
 * Do not let a permission string alone opt an unrelated package into Gadget authority. */
export function isSpaceSharedPackagePermissionAllowed(permission: string, manifest?: ExtensionManifest): boolean {
  if (SPACE_SHARED_PACKAGE_PERMISSIONS.has(permission)) return true;
  if (!manifest?.capabilityRequirements.includes("extension.gadget.business_action")) return false;
  const bundleActions = (manifest.bundle?.primitives ?? []).flatMap(primitive => primitive.kind === "gadget"
    && primitive.scope === "SPACE_SHARED" ? (primitive.businessActions ?? []).map(action => ({ action, permissions: primitive.permissions })) : []);
  const bundleAllowsPermission = bundleActions.some(({ action, permissions }) => action.permission === permission
    && permissions.some(grant => grant.scope === "SPACE_SHARED" && grant.resource === permission
      && grant.actions.includes(action.effects === "read_only" ? "read" : "write")));
  if (bundleAllowsPermission) return true;
  // Legacy manifests have no primitive-scoped permission object. Their signed top-level permission
  // declaration is accepted only when a Space-shared tier-3 Gadget declares the exact action.
  return !manifest.bundle && manifest.declaredPermissions.includes(permission)
    && (manifest.gadgets ?? []).some(gadget => gadget.scope === "SPACE_SHARED" && gadget.gadgetTier === 3
      && (gadget.businessActions ?? []).some(action => action.permission === permission));
}
