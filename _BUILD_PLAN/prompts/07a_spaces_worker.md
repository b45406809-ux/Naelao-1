# Prompt 07a: workers/naelao-spaces/src/index.ts

---
## PASTE THIS ENTIRE BLOCK INTO YOUR FREE AI
---

Platform: Naelao = multi-tenant AI agent builder on Cloudflare Workers + Durable Objects. NO Node.js, NO PostgreSQL. Data in SpaceDO SQLite (this.ctx.storage.sql). Worker comms via Service Bindings. Routing via Hono. Auth via JWT HMAC-SHA256. Billing via Lemon Squeezy (BillingProvider interface). Errors always: { error: { code: 'SNAKE_CASE', message: 'text' } }. compatibility_date: 2025-01-01.

Generate ONE file: workers/naelao-spaces/src/index.ts

This is the HTTP worker for space CRUD. It delegates ALL data writes to SpaceDO via Service Binding.

Env:
  NAELAO_SPACE_DO: DurableObjectNamespace
  NAELAO_WALLET_DO: DurableObjectNamespace
  NAELAO_CONCURRENCY_DO: DurableObjectNamespace
  NAELAO_BUILDER_DO: DurableObjectNamespace
  NAELAO_CONFIG_KV: KVNamespace
  NAELAO_ANALYTICS: AnalyticsEngineDataset
  NAELAO_JWT_SECRET: string
  ENVIRONMENT: string
  SpaceDO: DurableObjectNamespace     (export this DO class)
  WalletDO: DurableObjectNamespace    (export this DO class)
  ConcurrencyDO: DurableObjectNamespace
  BuilderAccountDO: DurableObjectNamespace

Helper:
  function getSpaceDO(spaceId: string, env: Env) {
    return env.NAELAO_SPACE_DO.get(env.NAELAO_SPACE_DO.idFromName('space:' + spaceId));
  }

Routes (all under /v1/, all require authMiddleware):
  POST   /v1/spaces                           createSpace
  GET    /v1/spaces/:spaceId                  getSpace
  PATCH  /v1/spaces/:spaceId                  updateSpace
  DELETE /v1/spaces/:spaceId                  deleteSpace
  GET    /v1/spaces/:spaceId/members          listMembers
  POST   /v1/spaces/:spaceId/members          addMember
  DELETE /v1/spaces/:spaceId/members/:userId  removeMember
  PATCH  /v1/spaces/:spaceId/members/:userId  updateMemberRole
  GET    /v1/spaces/:spaceId/usage            getUsageStats

CRITICAL gap fixes:
1. Space creation serialization lock (prevents race condition G-G05):
   - Get ConcurrencyDO stub: idFromName('space-create-lock:' + jwt.sub)
   - Call /acquire on it before creating, /release after
   - Return 409 if already creating

2. Member role downgrade session invalidation (G-E09):
   - On removeMember or updateMemberRole: write KV key 'revoked:userId:spaceId' = Date.now(), TTL = 7200
   - The auth middleware already checks this key

3. All data calls go through SpaceDO:
   - spaceDO.fetch(new Request('http://space/members/add', { method:'POST', body: JSON.stringify({...}) }))
   - Never write to any database directly from this Worker

Import authMiddleware from './middleware' (it's generated separately, stub the import).

