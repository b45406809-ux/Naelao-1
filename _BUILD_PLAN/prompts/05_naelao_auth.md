# Prompt 05: workers/naelao-auth/src/ (3 files)

---
## PASTE THIS ENTIRE BLOCK INTO YOUR FREE AI
---

Platform: Naelao = multi-tenant AI agent builder on Cloudflare Workers + Durable Objects. NO Node.js, NO PostgreSQL. Data in SpaceDO SQLite (this.ctx.storage.sql). Worker comms via Service Bindings. Routing via Hono. Auth via JWT HMAC-SHA256. Billing via Lemon Squeezy (BillingProvider interface). Errors always: { error: { code: 'SNAKE_CASE', message: 'text' } }. compatibility_date: 2025-01-01.

Generate THREE files for workers/naelao-auth/src/.

Env bindings interface for all three files:
  NAELAO_JWT_SECRET: string
  NAELAO_CONFIG_KV: KVNamespace
  NAELAO_SPACE_DO: DurableObjectNamespace
  NAELAO_ANALYTICS: AnalyticsEngineDataset
  ENVIRONMENT: string

=== File 1: src/jwt.ts ===

Implement JWT functions using Web Crypto API (NOT npm jsonwebtoken):

  signJWT(payload: object, secret: string, expiresInSeconds?: number): Promise<string>
  - Format: base64url(header).base64url(payload).base64url(sig)
  - header: { alg: 'HS256', typ: 'JWT' }
  - Use crypto.subtle.importKey({ name:'HMAC', hash:'SHA-256' }) + crypto.subtle.sign

  verifyJWT(token: string, secret: string): Promise<JWTPayload>
  - Throws Error('jwt_expired') if exp < Date.now()/1000
  - Throws Error('jwt_invalid') on bad signature

  signInternalToken(claims: object, secret: string, ttlSeconds?: number): Promise<string>
  - Short-lived: base64url(JSON with exp).hexSignature
  - Used for internal service-binding auth

  verifyInternalToken(token: string, secret: string): Promise<Record<string,unknown>>
  - Throws if expired or bad signature

Export JWTPayload interface:
  { sub: string; spaceId: string; rootSpaceId: string; role: 'owner'|'admin'|'member'|'viewer'; builderId: string; exp: number; impersonatedBy?: string; scope?: string[] }

=== File 2: src/middleware.ts ===

  authMiddleware(env: Env): MiddlewareHandler
  - Reads Authorization: Bearer <token>
  - Calls verifyJWT, sets c.set('jwt', payload) on success
  - Returns 401 { error: { code: 'UNAUTHORIZED', message: 'Invalid or missing token' } } on failure
  - Also checks NAELAO_CONFIG_KV for revoked:<userId>:<spaceId> key (session revocation)

  requireRole(...roles: MemberRole[]): MiddlewareHandler
  - Reads c.get('jwt'), checks role is in roles array
  - Returns 403 if not permitted

=== File 3: src/index.ts ===

Hono Worker with routes (all public - no auth on this worker itself):

  POST /v1/auth/register   { email, password, name } -> { token, builderId }
  POST /v1/auth/login      { email, password } -> { token, refreshToken }
  POST /v1/auth/refresh    { refreshToken } -> { token }
  POST /v1/auth/logout     { refreshToken } -> { ok: true }
  GET  /v1/auth/me         (requires Bearer token) -> JWTPayload
  POST /v1/auth/space-token { spaceId } (requires valid JWT) -> { token }

Implementation rules:
- Store hashed passwords in KV as user:hash:<email> using PBKDF2 (100000 iterations, SHA-256, 32-byte key, 16-byte salt stored as prefix)
- Store refresh tokens in KV as refresh:<token> with 7-day TTL (expirationTtl: 604800)
- Rate limit login: max 10 attempts per IP per 15min, key: rl:login:<ip> in NAELAO_CONFIG_KV
- Space tokens include spaceId in JWT payload, expire in 1 hour
- NEVER log passwords or tokens
- Always use constant-time comparison for security-sensitive values

Generate all three files completely with no placeholders.

