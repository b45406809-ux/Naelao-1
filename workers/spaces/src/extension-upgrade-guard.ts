export interface InstalledExtensionInstanceRef {
  instance_id: string;
  extension_id: string;
  project_id: string | null;
  scope: string;
  instance_key?: string | null;
  status: string;
  release_version?: string | null;
}

/**
 * Versioned installations are pinned independently. Keep this guard for legacy sibling rows that
 * could not be pinned because their signed release record is missing.
 */
export function findUnsafeProjectExtensionUpgrade(
  installations: readonly InstalledExtensionInstanceRef[],
  target: { extensionId: string; projectId: string; instanceKey: string },
): InstalledExtensionInstanceRef[] {
  return installations.filter((instance) => {
    if (instance.extension_id !== target.extensionId || !["active", "disabled", "staging"].includes(instance.status)) return false;
    const isTarget = instance.scope === "PROJECT_BOUND" && instance.project_id === target.projectId
      && (instance.instance_key ?? "default") === target.instanceKey;
    return !isTarget && !instance.release_version;
  });
}
