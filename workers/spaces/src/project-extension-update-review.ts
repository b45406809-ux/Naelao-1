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

export function projectBoundExtensionUpdateClaims(input: { tenantId: string; spaceId: string; projectId: string;
  actorId: string; installationId: string; extensionId: string; installationGeneration: number;
  fromVersion: string; toVersion: string; sourceManifestSha256: string; candidateManifestSha256: string;
  sourceArtifactSha256: string; artifactSha256: string; publisherId: string; publisherKeyId: string;
  expiresAt: number; requestId: string }): ProjectBoundExtensionUpdateClaims {
  return { version: 1, purpose: "project_bound_extension_update", ...input };
}

export interface ProjectBoundExtensionUpdateClaims {
  version: 1; purpose: "project_bound_extension_update"; tenantId: string; spaceId: string; projectId: string;
  actorId: string; installationId: string; extensionId: string; installationGeneration: number;
  fromVersion: string; toVersion: string; sourceManifestSha256: string; candidateManifestSha256: string;
  sourceArtifactSha256: string; artifactSha256: string; publisherId: string; publisherKeyId: string;
  expiresAt: number; requestId: string;
}

export function isCurrentProjectBoundExtensionUpdate(value: unknown, expected: Omit<ProjectBoundExtensionUpdateClaims, "version" | "purpose" | "expiresAt" | "requestId">,
  now = Date.now()): value is ProjectBoundExtensionUpdateClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claims = value as Partial<ProjectBoundExtensionUpdateClaims>;
  return claims.version === 1 && claims.purpose === "project_bound_extension_update"
    && claims.tenantId === expected.tenantId && claims.spaceId === expected.spaceId && claims.projectId === expected.projectId
    && claims.actorId === expected.actorId && claims.installationId === expected.installationId && claims.extensionId === expected.extensionId
    && claims.installationGeneration === expected.installationGeneration && claims.fromVersion === expected.fromVersion
    && claims.toVersion === expected.toVersion && claims.sourceManifestSha256 === expected.sourceManifestSha256
    && claims.candidateManifestSha256 === expected.candidateManifestSha256 && claims.sourceArtifactSha256 === expected.sourceArtifactSha256
    && claims.artifactSha256 === expected.artifactSha256 && claims.publisherId === expected.publisherId && claims.publisherKeyId === expected.publisherKeyId
    && Number.isSafeInteger(claims.expiresAt) && (claims.expiresAt ?? 0) > now && (claims.expiresAt ?? 0) <= now + 5 * 60_000
    && typeof claims.requestId === "string" && /^[0-9a-f-]{36}$/i.test(claims.requestId);
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
  applySupported?: boolean;
  applyBlockReason?: string | null;
  updateReviewToken?: string;
  updateReviewExpiresAt?: number;
  updateReviewRequestId?: string;
  gadgetMigrations?: Array<{ id: string; migrations: Array<{ version: number; description: string; up: string }> }>;
}) {
  const current = input.current as any;
  const candidate = input.candidate as any;
  type ResourceReviewDeclaration = { id: string; kind: string; apiVersion: string; scope: string;
    operations: readonly unknown[]; limits: { requestsPerMinute: number; maxConcurrent: number; maxBytesPerOperation: number }; binding?: unknown };
  const currentResources = (current.resourceRequirements ?? []) as ResourceReviewDeclaration[];
  const candidateResources = (candidate.resourceRequirements ?? []) as ResourceReviewDeclaration[];
  const resourceChanges = rows(currentResources, candidateResources);
  const currentResourcesById = new Map(currentResources.map(item => [item.id, item]));
  const candidateResourcesById = new Map(candidateResources.map(item => [item.id, item]));
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
    resources: resourceChanges,
    resource_requirements: {
      added: resourceChanges.added.flatMap(id => candidateResourcesById.has(id) ? [candidateResourcesById.get(id)!] : []),
      removed: resourceChanges.removed.flatMap(id => currentResourcesById.has(id) ? [currentResourcesById.get(id)!] : []),
      changed: resourceChanges.changed.flatMap(id => currentResourcesById.has(id) && candidateResourcesById.has(id)
        ? [{ id, before: currentResourcesById.get(id)!, after: candidateResourcesById.get(id)! }] : []),
    },
    dependencies: rows(currentDependencies, candidateDependencies),
    primitives: rows((current.bundle?.primitives ?? []).filter((row: any): row is { id: string } => typeof row.id === "string"),
      (candidate.bundle?.primitives ?? []).filter((row: any): row is { id: string } => typeof row.id === "string")),
    gadget_migrations: (input.gadgetMigrations ?? []).map(gadget => ({ id: gadget.id, migrations: gadget.migrations })),
    cost_terms: { status: "unknown", reason: "the extension release contract has no approved price or metering terms" },
    review: { apply_supported: input.applySupported === true, apply_block_reason: input.applyBlockReason ?? null,
      mutates_installation: false as const },
    ...(input.updateReviewToken ? { update_review_token: input.updateReviewToken, update_review_expires_at: input.updateReviewExpiresAt!,
      update_review_request_id: input.updateReviewRequestId! } : {}),
    apply_supported: input.applySupported === true,
    apply_block_reason: input.applySupported ? null : input.applyBlockReason ?? "project-bound package change is outside the version-only update contract",
    mutates_installation: false as const,
  };
}
