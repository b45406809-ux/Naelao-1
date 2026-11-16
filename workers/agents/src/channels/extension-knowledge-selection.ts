const KNOWLEDGE_ID = /^[a-z][a-z0-9_-]{2,63}$/;

export function resolveExtensionProjectKnowledge(input: {
  declaredPublicationIds: string[];
  configured: unknown;
  grantedPublicationIds: unknown;
}): string[] | null {
  if (input.declaredPublicationIds.length > 16 || input.declaredPublicationIds.some(id => !KNOWLEDGE_ID.test(id))
    || new Set(input.declaredPublicationIds).size !== input.declaredPublicationIds.length
    || typeof input.configured !== "boolean" || !Array.isArray(input.grantedPublicationIds)
    || input.grantedPublicationIds.length > 16
    || input.grantedPublicationIds.some(id => typeof id !== "string" || !KNOWLEDGE_ID.test(id))
    || new Set(input.grantedPublicationIds).size !== input.grantedPublicationIds.length) return null;
  if (!input.configured) return [];
  const granted = new Set(input.grantedPublicationIds as string[]);
  return input.declaredPublicationIds.filter(id => granted.has(id));
}

export function resolveCurrentExtensionKnowledgeRevision(input: {
  scope: "SPACE_SHARED" | "PROJECT_BOUND";
  instanceId: string;
  extensionId: string;
  publicationId: string;
  publications: unknown;
  grant?: { instanceId?: unknown; extensionId?: unknown; publications?: unknown };
}): number | null {
  if (!KNOWLEDGE_ID.test(input.publicationId) || !Array.isArray(input.publications) || input.publications.length > 100) return null;
  const current = input.publications.find((item): item is { id?: unknown; revision?: unknown } =>
    Boolean(item) && typeof item === "object" && !Array.isArray(item) && "id" in item && "revision" in item
      && (item as { id?: unknown }).id === input.publicationId);
  if (!current || !Number.isSafeInteger(current.revision) || Number(current.revision) < 1) return null;
  if (input.scope !== "SPACE_SHARED") return Number(current.revision);
  const grant = input.grant;
  if (!grant || grant.instanceId !== input.instanceId || grant.extensionId !== input.extensionId
    || !Array.isArray(grant.publications) || grant.publications.length > 16) return null;
  const exactGrant = grant.publications.find((item): item is { id?: unknown; revision?: unknown } =>
    Boolean(item) && typeof item === "object" && !Array.isArray(item) && "id" in item && "revision" in item
      && (item as { id?: unknown }).id === input.publicationId);
  return exactGrant && Number.isSafeInteger(exactGrant.revision) && Number(exactGrant.revision) === Number(current.revision)
    ? Number(current.revision) : null;
}
