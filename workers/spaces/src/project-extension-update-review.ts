function sorted(values: readonly string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort();
}

function rows<T extends { id: string }>(before: T[], after: T[]) {
  const left = new Map(before.map(row => [row.id, JSON.stringify(row)]));
  const right = new Map(after.map(row => [row.id, JSON.stringify(row)]));
  return {
    added: [...right.keys()].filter(id => !left.has(id)).sort(),
    removed: [...left.keys()].filter(id => !right.has(id)).sort(),
    changed: [...right.keys()].filter(id => left.has(id) && left.get(id) !== right.get(id)).sort(),
  };
}

export function buildProjectExtensionUpdateReview(input: {
  installationId: string;
  installationGeneration: number;
  currentManifestSha256: string;
  currentArtifactSha256: string | null;
  current: unknown;
  candidateManifestSha256: string;
  candidateArtifactSha256: string;
  candidate: unknown;
  publisherId: string;
  publisherKeyId: string;
}) {
  const current = input.current as any;
  const candidate = input.candidate as any;
  const currentVersion = current.bundle?.version ?? null;
  const candidateVersion = candidate.bundle?.version ?? null;
  const additions = (before: string[] | undefined, after: string[] | undefined) =>
    sorted(after).filter(item => !sorted(before).includes(item));
  const removals = (before: string[] | undefined, after: string[] | undefined) =>
    sorted(before).filter(item => !sorted(after).includes(item));
  const currentDependencies = (current.dependencies ?? []).map((item: { extensionId: string; version: string; manifestSha256: string }) => ({
    id: item.extensionId, pin: `${item.version}:${item.manifestSha256}`,
  }));
  const candidateDependencies = (candidate.dependencies ?? []).map((item: { extensionId: string; version: string; manifestSha256: string }) => ({
    id: item.extensionId, pin: `${item.version}:${item.manifestSha256}`,
  }));
  return {
    installation_id: input.installationId,
    installation_generation: input.installationGeneration,
    current: { version: currentVersion, manifest_sha256: input.currentManifestSha256, artifact_sha256: input.currentArtifactSha256 },
    candidate: { version: candidateVersion, manifest_sha256: input.candidateManifestSha256,
      artifact_sha256: input.candidateArtifactSha256, publisher_id: input.publisherId,
      publisher_key_id: input.publisherKeyId, signature_verified: true as const },
    permissions: { added: additions(current.declaredPermissions, candidate.declaredPermissions),
      removed: removals(current.declaredPermissions, candidate.declaredPermissions) },
    capabilities: { added: additions(current.capabilityRequirements, candidate.capabilityRequirements),
      removed: removals(current.capabilityRequirements, candidate.capabilityRequirements) },
    resources: rows(current.resourceRequirements ?? [], candidate.resourceRequirements ?? []),
    dependencies: rows(currentDependencies, candidateDependencies),
    primitives: rows((current.bundle?.primitives ?? []).filter((row: any): row is { id: string } => typeof row.id === "string"),
      (candidate.bundle?.primitives ?? []).filter((row: any): row is { id: string } => typeof row.id === "string")),
    cost_terms: { status: "unknown", reason: "the extension release contract has no approved price or metering terms" },
    apply_supported: false as const,
    apply_block_reason: "project-bound forward update admission and migration compare-and-swap are not implemented",
    mutates_installation: false as const,
  };
}
