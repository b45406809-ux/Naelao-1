import { canonicalExtensionManifestForPublisher, extensionPublisherSigningPayload } from "@naelao/agent-sdk";

/** Fingerprint the exact source payload the publisher SDK signs; this is not a host build digest. */
export async function previewExtensionPublisherProvenance(manifestDraft: string, artifactsDraft: string): Promise<{
  signingPayloadSha256: string; sourceCount: number; sourceBytes: number;
}> {
  const manifest: unknown = JSON.parse(manifestDraft);
  const candidate: unknown = JSON.parse(artifactsDraft);
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("artifact_map_required");
  const artifacts = candidate as Record<string, unknown>;
  if (Object.keys(artifacts).length > 128 || Object.values(artifacts).some(value => typeof value !== "string")) throw new Error("artifact_map_invalid");
  const canonicalManifest = canonicalExtensionManifestForPublisher(manifest);
  const signingPayload = extensionPublisherSigningPayload(canonicalManifest, artifacts as Record<string, string>);
  const sourceBytes = (Object.values(artifacts) as string[]).reduce<number>((total, source) => total + new TextEncoder().encode(source).byteLength, 0);
  if (sourceBytes > 2_000_000) throw new Error("artifact_sources_too_large");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(signingPayload));
  return { signingPayloadSha256: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join(""),
    sourceCount: Object.keys(artifacts).length, sourceBytes };
}
