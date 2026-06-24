export async function resolveToolRoute(
  spaceId: string,
  toolName: string,
  agentId: string,
  kv: KVNamespace
): Promise<string | null> {
  const cacheKey = 'tool-schemas:' + spaceId + ':' + agentId;
  const cached = await kv.get<Record<string, string>>(cacheKey, 'json');
  if (cached) return cached[toolName] ?? null;
  return null;
}

export async function cacheToolSchemas(
  spaceId: string,
  agentId: string,
  schemas: Record<string, string>,
  kv: KVNamespace
): Promise<void> {
  await kv.put('tool-schemas:' + spaceId + ':' + agentId, JSON.stringify(schemas), { expirationTtl: 300 });
}

export async function invalidateToolCache(spaceId: string, kv: KVNamespace): Promise<void> {
  const listed = await kv.list({ prefix: 'tool-schemas:' + spaceId + ':' });
  await Promise.all(listed.keys.map(k => kv.delete(k.name)));
}
