# Prompt: workers/naelao-router/src/ (4 files) — DEPLOY LAST

---
## PASTE THIS ENTIRE BLOCK INTO YOUR FREE AI
---

Naelao = multi-tenant AI agent builder on Cloudflare Workers + Durable Objects. NO Node.js, NO PostgreSQL. Data in SpaceDO SQLite. Service Bindings for Worker comms. Hono for routing. JWT auth. Errors: { error: { code: 'SNAKE_CASE', message: 'text' } }. All routes /v1/. compatibility_date: 2025-01-01.

Generate FOUR files for workers/naelao-router/src/. THIS IS DEPLOYED LAST.

Env (this worker has Service Bindings to ALL other workers):
  NAELAO_AUTH: Service
  NAELAO_SPACES: Service
  NAELAO_AGENTS: Service
  NAELAO_THREADS: Service
  NAELAO_KNOWLEDGE: Service
  NAELAO_BILLING: Service
  NAELAO_MCP_HUB: Service
  NAELAO_REGISTRY: Service
  NAELAO_TOGETHER_AI: Service
  NAELAO_ADMIN: Service
  NAELAO_CREDENTIALS: Service
  NAELAO_CIRCUIT_KV: KVNamespace  (rate limiting)
  NAELAO_CONFIG_KV: KVNamespace
  NAELAO_JWT_SECRET: string
  ENVIRONMENT: string

=== File 1: src/middleware/cors.ts ===
  corsMiddleware(): MiddlewareHandler
  Allowed origins: ['https://app.naelao.com', 'https://naelao.com', ENVIRONMENT === 'development' ? 'http://localhost:*' : '']
  Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
  Headers: Authorization, Content-Type, X-Trace-ID
  Expose: X-Trace-ID, API-Version

=== File 2: src/middleware/rate-limit.ts ===
  rateLimitMiddleware(env: Env): MiddlewareHandler
  Key: 'rl:api:' + ip (from CF-Connecting-IP header)
  Limits: 100 req/min for free, 1000/min for pro (check JWT plan)
  Storage: NAELAO_CIRCUIT_KV, TTL 60s
  Return 429 with Retry-After header when exceeded

=== File 3: src/middleware/auth.ts ===
  Same as naelao-auth middleware but calling NAELAO_AUTH Service Binding:
  authMiddleware(env: Env): MiddlewareHandler
  1. Extract Bearer token from Authorization header
  2. Verify via call to NAELAO_AUTH Service Binding: GET /v1/auth/me with Authorization forwarded
  3. Set c.set('jwt', payload)
  
  Also handles revocation check: KV get 'revoked:userId:spaceId' - return 401 if found

=== File 4: src/index.ts ===

Main Hono router. Generates traceId and propagates it (G-F26 fix).

CRITICAL: Add traceId to every request:
  app.use('*', async (c, next) => {
    const traceId = crypto.randomUUID();
    c.set('traceId', traceId);
    c.header('X-Trace-ID', traceId);
    c.header('API-Version', '1');
    await next();
  });

PUBLIC paths (no auth, no rate limit):
  /v1/auth/*               -> NAELAO_AUTH Service Binding
  /v1/billing/webhook      -> NAELAO_BILLING Service Binding (G-H13 fix: bypass auth)
  /v1/webhooks/*           -> NAELAO_TRIGGERS Service Binding (no auth - verified by signature)
  /health                  -> { ok: true; timestamp: Date.now() }

AUTHENTICATED paths (authMiddleware + rateLimitMiddleware):
  /v1/spaces/*             -> NAELAO_SPACES Service Binding
  /v1/agents/*             -> NAELAO_AGENTS Service Binding
  /v1/threads/*            -> NAELAO_THREADS Service Binding
  /v1/knowledge/*          -> NAELAO_KNOWLEDGE Service Binding
  /v1/billing/*            -> NAELAO_BILLING Service Binding (except /webhook - already routed above)
  /v1/registry/*           -> NAELAO_REGISTRY Service Binding
  /v1/ai/*                 -> NAELAO_TOGETHER_AI Service Binding
  /v1/credentials/*        -> NAELAO_CREDENTIALS Service Binding
  /v1/mcp/*                -> NAELAO_MCP_HUB Service Binding

ADMIN paths (authMiddleware + requireRole('owner') + rateLimitMiddleware):
  /v1/admin/*              -> NAELAO_ADMIN Service Binding

Forwarding pattern (pass traceId and Authorization through to all service bindings):
  function forward(service: Service, c: Context): Promise<Response> {
    const headers = new Headers(c.req.headers);
    headers.set('X-Trace-ID', c.get('traceId'));
    return service.fetch(new Request(c.req.url, { method: c.req.method, headers, body: c.req.body }));
  }

