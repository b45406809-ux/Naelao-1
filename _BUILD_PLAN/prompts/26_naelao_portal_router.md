# Prompt: workers/naelao-portal-router/src/index.ts

---
## PASTE THIS ENTIRE BLOCK INTO YOUR FREE AI
---

Naelao = multi-tenant AI agent builder on Cloudflare Workers + Durable Objects. NO Node.js, NO PostgreSQL. Data in SpaceDO SQLite. Service Bindings for Worker comms. Hono for routing. JWT auth. Errors: { error: { code: 'SNAKE_CASE', message: 'text' } }. All routes /v1/. compatibility_date: 2025-01-01.

Generate ONE file: workers/naelao-portal-router/src/index.ts

Routes custom domains and slugs (*.naelao.app, custom domains) to the correct space.

CRITICAL FIX (G-F10): Uses NAELAO_PORTAL_ROUTES KV (separate namespace, NOT NAELAO_CONFIG_KV).

Env:
  NAELAO_PORTAL_ROUTES: KVNamespace  (key: 'slug:myslug' or 'host:mycustom.domain' -> spaceId)
  NAELAO_SPACES: Service
  NAELAO_CONFIG_KV: KVNamespace  (kill switch, circuit breakers)
  NAELAO_ANALYTICS: AnalyticsEngineDataset

Export default Worker:
  async fetch(request: Request, env: Env): Promise<Response>
  
  1. Extract hostname from request URL
  2. Check if *.naelao.app: extract slug from subdomain (myslug.naelao.app -> 'myslug')
  3. Check if custom domain: look up 'host:' + hostname in NAELAO_PORTAL_ROUTES
  4. Or slug match: look up 'slug:' + slug in NAELAO_PORTAL_ROUTES
  5. If no match: return branded 404 page
  6. Forward to NAELAO_SPACES service with X-Portal-Space-ID header
  
  Rate limiting per hostname: max 1000 req/min using NAELAO_CIRCUIT_KV
  Cache portal route lookups in memory (Map) with 60s TTL to reduce KV reads

SLUG RESERVATION (G-E14 fix): Define reserved slugs that cannot be claimed:
  const RESERVED_SLUGS = new Set(['naelao','admin','api','support','billing','app','www','mail','smtp','ftp','ssh','dashboard','login','auth','status','health','docs','help','blog','about','legal','privacy','terms','careers','jobs','team']);
  export { RESERVED_SLUGS }  // imported by naelao-spaces when creating portal spaces

