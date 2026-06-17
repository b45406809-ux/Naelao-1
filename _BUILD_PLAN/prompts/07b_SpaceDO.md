# Prompt 07b: workers/naelao-spaces/src/SpaceDO.ts (CRITICAL - largest file)

---
## PASTE THIS ENTIRE BLOCK INTO YOUR FREE AI
---

Platform: Naelao = multi-tenant AI agent builder on Cloudflare Workers + Durable Objects. NO Node.js, NO PostgreSQL. Data in SpaceDO SQLite (this.ctx.storage.sql). Worker comms via Service Bindings. Routing via Hono. Auth via JWT HMAC-SHA256. Billing via Lemon Squeezy (BillingProvider interface). Errors always: { error: { code: 'SNAKE_CASE', message: 'text' } }. compatibility_date: 2025-01-01.

Generate ONE file: workers/naelao-spaces/src/SpaceDO.ts

SpaceDO is a Cloudflare Durable Object with SQLite. It is the ONLY place per-space data is written.

CRITICAL RULES:
- All queries use this.ctx.storage.sql.exec<T>(sql, ...params) - NEVER db.query()
- Transactions use: this.sql.exec('BEGIN; ...; COMMIT') in ONE exec call
- Constructor uses blockConcurrencyWhile(() => this.initSchema()) - never await in constructor body

Import: import { DurableObject } from 'cloudflare:workers';

class SpaceDO extends DurableObject<Env> {
  private sql: SqlStorage;
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql = state.storage.sql;
    state.blockConcurrencyWhile(() => this.initSchema());
  }
}

SCHEMA (all CREATE TABLE IF NOT EXISTS):
  schema_version (version INTEGER PRIMARY KEY DEFAULT 0)
  
  spaces (id TEXT PK, root_space_id TEXT NOT NULL, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
          status TEXT DEFAULT 'active' CHECK(IN 'active','suspended','paused','deleted'),
          billing_provider TEXT DEFAULT 'lemon_squeezy', billing_subscription_id TEXT,
          billing_portal_url TEXT, billing_customer_id TEXT, space_type TEXT,
          metadata TEXT DEFAULT '{}', created_at TEXT, updated_at TEXT)

  space_members (space_id TEXT, user_id TEXT, role TEXT CHECK(IN 'owner','admin','member','viewer'),
                 joined_at TEXT, PRIMARY KEY(space_id, user_id))
  INDEX: idx_members_user ON space_members(user_id)

  space_credits (space_id TEXT PK, balance_credits INTEGER DEFAULT 0,
                 daily_spent_credits INTEGER DEFAULT 0, daily_reset_at TEXT,
                 monthly_budget_credits INTEGER, platform_daily_ceiling INTEGER, updated_at TEXT)

  token_usage (id TEXT PK, space_id TEXT NOT NULL, run_id TEXT, model_id TEXT,
               input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
               credits_charged INTEGER DEFAULT 0, created_at TEXT)
  INDEX: idx_usage_space ON token_usage(space_id, created_at)

  device_tokens (user_id TEXT, token TEXT, platform TEXT CHECK(IN 'ios','android','web'),
                 registered_at TEXT, PRIMARY KEY(user_id, token))

  processed_billing_events (event_id TEXT PK, processed_at TEXT)

MIGRATION PATTERN (G-G13 fix - critical):
  After creating all tables IF NOT EXISTS, read schema_version.
  Apply ALTER TABLE ADD COLUMN for any new columns by version number.
  v < 1: ADD COLUMN billing_portal_url to spaces (already in base schema, just example)
  Increment version after each migration block.

FETCH HANDLER - route on url.pathname:
  /meta              GET → return space row
  /init              POST { id, rootSpaceId, name, slug, spaceType, ownerId } → initialize space + credits
  /members/check     POST { userId } → { allowed: boolean; role?: string }
  /members/add       POST { userId; role } → { ok: true }
  /members/remove    POST { userId } → { ok: true }
  /members/list      GET → { members: [...] }
  /members/role      PATCH { userId; role } → { ok: true }
  /credits/deduct    POST { amount; reason; runId? } → { success: boolean; balance: number }
  /credits/add       POST { amount; reason; billingEventId } → { balance: number } (idempotent via processed_billing_events)
  /credits/balance   GET → { balance: number; dailySpent: number }
  /credits/record-usage POST { runId; modelId; inputTokens; outputTokens; creditsCharged } → { ok: true }
  /device-tokens     GET ?userId=... → { tokens: [...] }
  /device-tokens/upsert POST { userId; token; platform } → { ok: true }
  /billing/update    POST { subscriptionId?; portalUrl?; status?; provider? } → { ok: true }
  /billing/event-check POST { eventId } → { processed: boolean } (idempotency check)
  /billing/event-mark  POST { eventId } → { ok: true }
  /purge             POST → delete all data for space (deprovisioning)

CRITICAL - deductCredits implementation (G-G06 fix - atomic transaction):
  Check platform daily ceiling first (reject if daily_spent + amount > ceiling)
  Reset daily_spent if daily_reset_at < today
  Single exec: BEGIN; UPDATE space_credits SET balance=balance-?, daily_spent=daily_spent+? WHERE space_id=? AND balance>=?; COMMIT
  Check if rows changed = 0 (insufficient balance)

CRITICAL - member check with in-memory cache (G-F03 fix):
  private authCache = new Map<string, {result: boolean; role?: string; expires: number}>()
  Cache negative results for 30 seconds, positive for 5 minutes
  Key: userId:spaceId
  On members/add or members/remove: delete cache entries for that userId

Generate the complete class with all methods implemented.

