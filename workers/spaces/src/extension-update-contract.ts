import type { ExtensionManifest } from "@naelao/agent-sdk";
import { SPACE_SHARED_PACKAGE_CAPABILITIES, SPACE_SHARED_PACKAGE_PERMISSIONS } from "./shared-extension-package-policy.js";

function isVersionOnlyManifestChange(current: ExtensionManifest, candidate: ExtensionManifest): boolean {
  if (current.id !== candidate.id || !current.bundle || !candidate.bundle
    || current.bundle.version === candidate.bundle.version) return false;
  const normalize = (manifest: ExtensionManifest): string => {
    const copy = JSON.parse(JSON.stringify(manifest)) as ExtensionManifest;
    if (!copy.bundle) return "";
    copy.bundle.version = "__release_version__";
    for (const primitive of copy.bundle.primitives) primitive.version = "__release_version__";
    // validateExtensionManifest derives this compatibility view from bundle primitives.
    for (const channel of copy.channels ?? []) channel.version = "__release_version__";
    return JSON.stringify(copy);
  };
  return normalize(current) === normalize(candidate);
}

function isCodeOnlySpaceSharedPackage(manifest: ExtensionManifest): boolean {
  const bundle = manifest.bundle;
  if (!bundle || !bundle.primitives.length
    || manifest.declaredPermissions.some(permission => !SPACE_SHARED_PACKAGE_PERMISSIONS.has(permission))
    || manifest.capabilityRequirements.some(capability => !SPACE_SHARED_PACKAGE_CAPABILITIES.has(capability))
    || (manifest.gadgets?.length ?? 0) > 0 || (manifest.daemons?.length ?? 0) > 0
    || (manifest.commands?.length ?? 0) > 0 || (manifest.containers?.length ?? 0) > 0
    || (manifest.widgetSubscriptions?.length ?? 0) > 0
    || (manifest.dependencies?.length ?? 0) > 0 || (manifest.shared_filesystem?.length ?? 0) > 0
    || manifest.settingsSchema || (bundle.workerRoles?.length ?? 0) > 0) return false;

  return bundle.primitives.every(part => {
    if (part.version !== bundle.version) return false;
    if (part.kind === "canvas") {
      return part.layout === "CanvasMount" && part.dynamicPage === false
        && part.permissions.length === 0 && part.capabilityRequirements.length === 0;
    }
    if (part.kind === "channel") {
      return part.context === "channel_only" && /^\.\/[A-Za-z0-9._-]{1,128}\.(?:ts|js)$/.test(part.handlerScript);
    }
    // Gadget schema and migration changes need their own preview and recovery path.
    return false;
  });
}

/** Permit owner-reviewed artifact code updates only when authority and all declared package
 * configuration remain byte-for-byte stable apart from the signed release version. */
export function supportsVersionOnlySpaceSharedCodeUpdate(current: ExtensionManifest, candidate: ExtensionManifest): boolean {
  return isCodeOnlySpaceSharedPackage(current) && isCodeOnlySpaceSharedPackage(candidate)
    && isVersionOnlyManifestChange(current, candidate);
}
