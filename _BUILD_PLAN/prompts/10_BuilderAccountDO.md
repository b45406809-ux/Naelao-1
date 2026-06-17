# Prompt 10: workers/naelao-spaces/src/BuilderAccountDO.ts

---
## PASTE THIS ENTIRE BLOCK INTO YOUR FREE AI
---

Platform: Naelao = multi-tenant AI agent builder on Cloudflare Workers + Durable Objects. NO Node.js, NO PostgreSQL. Data in SpaceDO SQLite (this.ctx.storage.sql). Worker comms via Service Bindings. Routing via Hono. Auth via JWT HMAC-SHA256. Billing via Lemon Squeezy (BillingProvider interface). Errors always: { error: { code: 'SNAKE_CASE', message: 'text' } }. compatibility_date: 2025-01-01.

Generate ONE file: workers/naelao-spaces/src/BuilderAccountDO.ts

BuilderAccountDO stores builder account data. This was gap G-N27 - the missing schema.

class BuilderAccountDO extends DurableObject<Env> using SQLite.

Schema:
  builders (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT 'free' CHECK(plan IN ('free','starter','pro','team','enterprise')),
    credit_cents INTEGER NOT NULL DEFAULT 0,
    api_key_hash TEXT,
    rate_limit_rpm INTEGER NOT NULL DEFAULT 60,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','deleted')),
    created_at TEXT DEFAULT (datetime('now')),
    trial_ends_at TEXT,
    stripe_customer_id TEXT,
    lemon_squeezy_customer_id TEXT,
    billing_provider TEXT DEFAULT 'lemon_squeezy'
  )
  api_keys (id TEXT PK, builder_id TEXT, key_hash TEXT UNIQUE, name TEXT, created_at TEXT, last_used_at TEXT, expires_at TEXT)
  schema_version (version INTEGER PK DEFAULT 0)

Fetch routes:
  POST /init       { id; email; name } -> { ok: true } (create builder record)
  GET  /account    -> builder row
  PATCH /account   { name?; plan?; status? } -> updated row
  GET  /plan       -> { plan; rateLimitRpm; isEnterprise: boolean; features: string[] }
  POST /api-keys/create { name } -> { key: string; id: string } (generate, hash, store - return plaintext ONCE)
  GET  /api-keys   -> list (no plaintext keys)
  DELETE /api-keys/:id -> { ok: true }
  POST /verify-api-key { keyHash } -> { valid: boolean; builderId?: string }

isEnterprise check used by AssistantSandboxDO:
  NEVER trust isEnterprise from request body (G-E18 fix)
  Always derive from plan field: plan === 'enterprise' || plan === 'team'

Generate the complete class.

