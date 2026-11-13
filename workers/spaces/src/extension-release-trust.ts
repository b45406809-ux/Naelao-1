export interface PublisherTaggedRelease {
  signatureValid?: boolean;
  permissions?: string[];
  capabilities?: string[];
  publisher?: { keyId?: string; revoked?: boolean; [key: string]: unknown };
}

export interface ExtensionReleaseAccess {
  permissions?: string[];
  capabilities?: string[];
}

export function extensionReleaseAccessExpansion(current: ExtensionReleaseAccess, target: ExtensionReleaseAccess) {
  const additions = (before: string[] | undefined, after: string[] | undefined) =>
    [...new Set(after ?? [])].filter(value => !(before ?? []).includes(value)).sort();
  return {
    permissions: additions(current.permissions, target.permissions),
    capabilities: additions(current.capabilities, target.capabilities),
  };
}

/** Apply the current D1 publisher-key registry to release metadata returned by a SpaceDO. */
export function applyPublisherKeyRegistry<T extends PublisherTaggedRelease>(
  release: T,
  activePublisherKeyIds: ReadonlySet<string>,
): T {
  if (!release.publisher) return release;
  const keyId = release.publisher.keyId;
  if (keyId && activePublisherKeyIds.has(keyId)) return release;
  return {
    ...release,
    signatureValid: false,
    publisher: { ...release.publisher, revoked: true },
  };
}

export function isTrustedPublisherRelease(
  release: PublisherTaggedRelease | null | undefined,
  activePublisherKeyIds: ReadonlySet<string>,
): boolean {
  if (release?.signatureValid !== true) return false;
  if (!release.publisher) return true;
  const keyId = release.publisher.keyId;
  return typeof keyId === "string" && activePublisherKeyIds.has(keyId);
}

export function retainActivePublisherInstallations<T extends { publisher_key_id?: string | null; publisher_attestation_valid?: boolean }>(
  installations: T[],
  activePublisherKeyIds: ReadonlySet<string>,
): T[] {
  return installations.filter(installation => installation.publisher_attestation_valid !== false
    && (!installation.publisher_key_id || activePublisherKeyIds.has(installation.publisher_key_id)));
}
