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
