import type { ExtensionRelease } from "@/lib/api";

export function projectExtensionRollbackReview(release: ExtensionRelease | undefined,
  current: { permissions?: string[]; capabilities?: string[] }): {
    version: string; artifactSha256: string; publisherId: string | null; publisherKeyId: string | null;
    publisherRevoked: boolean; addedPermissions: string[]; addedCapabilities: string[];
  } | null {
  if (!release?.signatureValid || !/^[a-f0-9]{64}$/.test(release.artifactSha256)) return null;
  return { version: release.version, artifactSha256: release.artifactSha256, publisherId: release.publisher?.id ?? null,
    publisherKeyId: release.publisher?.keyId ?? null, publisherRevoked: release.publisher?.revoked === true,
    addedPermissions: (release.permissions ?? []).filter(item => !(current.permissions ?? []).includes(item)).sort(),
    addedCapabilities: (release.capabilities ?? []).filter(item => !(current.capabilities ?? []).includes(item)).sort() };
}
