export interface InstalledExtensionReleaseProvenance {
  version: string;
  manifestSha256: string;
  hostArtifactSha256: string;
  publisherPayloadSha256: string | null;
  publisherKeyId: string;
  trusted: boolean;
}

/** Only project the exact receipt fields returned for an owner-authorized installation listing. */
export function projectInstalledExtensionReleaseProvenance(instance: {
  release_version?: string | null; manifest_sha256?: string | null; pinned_artifact_sha256?: string | null;
  publisher_payload_sha256?: string | null; publisher_key_id?: string | null;
  publisher_attestation_valid?: boolean; publisher_trusted?: boolean;
}): InstalledExtensionReleaseProvenance | null {
  const digest = (value: string | null | undefined): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  if (instance.publisher_attestation_valid !== true || !instance.release_version || !digest(instance.manifest_sha256)
    || !digest(instance.pinned_artifact_sha256) || !digest(instance.publisher_key_id)) return null;
  return { version: instance.release_version, manifestSha256: instance.manifest_sha256,
    hostArtifactSha256: instance.pinned_artifact_sha256,
    publisherPayloadSha256: digest(instance.publisher_payload_sha256) ? instance.publisher_payload_sha256 : null,
    publisherKeyId: instance.publisher_key_id, trusted: instance.publisher_trusted === true };
}
