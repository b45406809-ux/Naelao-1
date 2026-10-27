export interface InstalledExtensionInstanceRef {
  instance_id: string;
  extension_id: string;
  project_id: string | null;
  scope: string;
  instance_key?: string | null;
  status: string;
}

/**
 * The SpaceDO currently stores one active manifest per extension ID. Until releases are pinned
 * per installation, an upgrade is safe only when it affects a single project-bound instance.
 */
export function findUnsafeProjectExtensionUpgrade(
  installations: readonly InstalledExtensionInstanceRef[],
  target: { extensionId: string; projectId: string; instanceKey: string },
): InstalledExtensionInstanceRef[] {
  return installations.filter((instance) => {
    if (instance.extension_id !== target.extensionId || !["active", "disabled", "staging"].includes(instance.status)) return false;
    return !(instance.scope === "PROJECT_BOUND" && instance.project_id === target.projectId
      && (instance.instance_key ?? "default") === target.instanceKey);
  });
}
