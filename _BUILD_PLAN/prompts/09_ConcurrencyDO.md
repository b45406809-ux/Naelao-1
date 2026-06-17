# Prompt 09: workers/naelao-spaces/src/ConcurrencyDO.ts

---
## PASTE THIS ENTIRE BLOCK INTO YOUR FREE AI
---

Platform: Naelao = multi-tenant AI agent builder on Cloudflare Workers + Durable Objects. NO Node.js, NO PostgreSQL. Data in SpaceDO SQLite (this.ctx.storage.sql). Worker comms via Service Bindings. Routing via Hono. Auth via JWT HMAC-SHA256. Billing via Lemon Squeezy (BillingProvider interface). Errors always: { error: { code: 'SNAKE_CASE', message: 'text' } }. compatibility_date: 2025-01-01.

Generate ONE file: workers/naelao-spaces/src/ConcurrencyDO.ts

ConcurrencyDO gates concurrent agent runs per space. Single-threaded = no race conditions.

class ConcurrencyDO extends DurableObject<Env> using SQLite.

Schema:
  slots (run_id TEXT PK, agent_id TEXT, space_id TEXT, last_heartbeat INTEGER, created_at INTEGER)
  config (key TEXT PK, value TEXT)

Fetch routes:
  POST /reserve    { runId; agentId; spaceId; maxConcurrent? } -> { granted: boolean; reason?: string }
  POST /heartbeat  { runId } -> { ok: boolean }
  POST /release    { runId } -> { ok: boolean }
  GET  /slots      -> { used: number; max: number; runs: [...] }

ALARM for cleanup (G-G19 fix - setAlarm only if no alarm exists):
  alarm(): delete stale slots (last_heartbeat < now - 300000ms), reschedule if runs remain

CRITICAL fix (G-G19): In reserve(), do NOT call setAlarm if alarm already exists:
  const existing = await this.ctx.storage.getAlarm();
  if (!existing) await this.ctx.storage.setAlarm(Date.now() + 300_000);

Max concurrent runs: read from config table, default 5 for free tier, 25 for team, 100 for enterprise.

Also handles space-creation locks:
  POST /acquire   { lockId } -> { granted: boolean }
  POST /release-lock { lockId } -> { ok: true }
  (store locks in a separate locks table with 30s TTL, alarm cleans them up)

Generate the complete class.

