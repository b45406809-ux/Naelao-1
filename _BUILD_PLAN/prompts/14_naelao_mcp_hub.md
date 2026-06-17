# Prompt: workers/naelao-mcp-hub/src/ (2 files)

---
## PASTE THIS ENTIRE BLOCK INTO YOUR FREE AI
---

Platform: Naelao = multi-tenant AI agent builder on Cloudflare Workers + Durable Objects. NO Node.js, NO PostgreSQL. Data in SpaceDO SQLite (this.ctx.storage.sql). Worker comms via Service Bindings. Routing via Hono. Auth via JWT HMAC-SHA256. Billing via Lemon Squeezy first, Stripe later via BillingProvider interface. Errors: { error: { code: 'SNAKE_CASE', message: 'text' } }. All routes prefixed /v1/. compatibility_date: 2025-01-01.

Generate TWO files for workers/naelao-mcp-hub/src/.

Env:
  NAELAO_SPACE_DO: DurableObjectNamespace
  NAELAO_CONFIG_KV: KVNamespace  (tool schema cache)
  NAELAO_JWT_SECRET: string
  NAELAO_ANALYTICS: AnalyticsEngineDataset

=== File 1: src/route-resolver.ts ===

Resolves which App Worker handles a given tool name.

CRITICAL FIX (G-G15): resolveToolRoute MUST use agentId parameter, NOT hardcoded 'unknown':
  async function resolveToolRoute(spaceId: string, toolName: string, agentId: string, kv: KVNamespace): Promise<string | null>
    const cacheKey = 'tool-schemas:' + spaceId + ':' + agentId;  // NOT ':unknown'
    const cached = await kv.get<{[tool: string]: string}>(cacheKey, 'json');
    if (cached) return cached[toolName] ?? null;
    return null;  // caller must refresh

  async function cacheToolSchemas(spaceId: string, agentId: string, schemas: Record<string, string>, kv: KVNamespace): Promise<void>
    await kv.put('tool-schemas:' + spaceId + ':' + agentId, JSON.stringify(schemas), { expirationTtl: 300 });

  async function invalidateToolCache(spaceId: string, kv: KVNamespace): Promise<void>
    // list all keys with prefix and delete them
    const listed = await kv.list({ prefix: 'tool-schemas:' + spaceId + ':' });
    await Promise.all(listed.keys.map(k => kv.delete(k.name)));

=== File 2: src/index.ts ===

Hono Worker that proxies MCP tool calls to installed App Workers.

Routes:
  GET  /v1/tools/:spaceId
    ?agentId=<id>   (REQUIRED - G-G15 fix, never default to 'unknown')
    -> Return list of all tools available for this agent in this space
    -> Cache result in KV with key 'tool-schemas:spaceId:agentId'

  POST /v1/tools/:spaceId/execute
    Body: { toolName: string; args: Record<string,unknown>; agentId: string; runId: string; walEntryId: string }
    -> Resolve tool route using agentId (G-G15 fix)
    -> If not cached, refresh tool list first
    -> Forward to App Worker via fetch
    -> CRITICAL (G-F13 fix): add idempotency header to all forwarded calls:
       'X-Naelao-Idempotency-Key': runId + ':' + walEntryId
    -> Return { result: unknown } or { error: {...} }

  DELETE /v1/tools/:spaceId/cache
    -> Call invalidateToolCache (deletes ALL agent-specific cache keys for space)

Platform tools (handled locally, no App Worker):
  'naelao.read_file', 'naelao.write_file', 'naelao.append_to_file',
  'naelao.web_search', 'naelao.create_thread', 'naelao.add_message'
  -> Route to tool-executor (import from agents worker via env binding)

