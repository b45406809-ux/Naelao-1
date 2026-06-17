# Prompt 08: workers/naelao-spaces/src/WalletDO.ts

---
## PASTE THIS ENTIRE BLOCK INTO YOUR FREE AI
---

Platform: Naelao = multi-tenant AI agent builder on Cloudflare Workers + Durable Objects. NO Node.js, NO PostgreSQL. Data in SpaceDO SQLite (this.ctx.storage.sql). Worker comms via Service Bindings. Routing via Hono. Auth via JWT HMAC-SHA256. Billing via Lemon Squeezy (BillingProvider interface). Errors always: { error: { code: 'SNAKE_CASE', message: 'text' } }. compatibility_date: 2025-01-01.

Generate ONE file: workers/naelao-spaces/src/WalletDO.ts

WalletDO is a Cloudflare Durable Object for per-user credit wallet.
Single-threaded = all deductions are automatically atomic without transactions.
This is the G-F02 (platform daily ceiling) fix location.

class WalletDO extends DurableObject<Env> {
  private sql: SqlStorage;
  constructor(state, env) { ... blockConcurrencyWhile(initSchema) ... }
}

Schema:
  wallet (id TEXT PK, balance_credits INTEGER DEFAULT 0, daily_spent INTEGER DEFAULT 0,
          daily_reset_at TEXT, monthly_spent INTEGER DEFAULT 0, monthly_reset_at TEXT,
          lifetime_spent INTEGER DEFAULT 0, updated_at TEXT)

  reservations (id TEXT PK, wallet_id TEXT, amount INTEGER, created_at TEXT, expires_at TEXT)

  transactions (id TEXT PK, wallet_id TEXT, type TEXT, amount INTEGER,
                reason TEXT, run_id TEXT, created_at TEXT)
  INDEX: idx_txn_wallet ON transactions(wallet_id, created_at DESC)

Fetch routes:
  POST /reserve  { walletId; amount } -> { reservationId } (deduct from balance, store in reservations)
  POST /settle   { reservationId; actual } -> { balance } (charge actual, refund difference)
  POST /deduct   { walletId; amount; reason } -> { success; balance } (immediate, no reservation)
  POST /add      { walletId; amount; reason } -> { balance }
  GET  /balance  ?walletId=... -> { balance; dailySpent; monthlySpent }
  GET  /transactions ?walletId=...&cursor=...&limit=50 -> keyset pagination on id DESC
  POST /sweep-reservations (called by sweeper) -> { expired: number }

PLATFORM CEILING (G-F02 fix):
  const PLATFORM_CEILING = parseInt(env.PLATFORM_DAILY_CREDIT_CEILING ?? '500000'); // in credits
  In deduct and settle: if daily_spent + amount > PLATFORM_CEILING, return { success: false, reason: 'platform_daily_limit_exceeded' }
  Reset daily_spent at UTC midnight (check in every deduct call: if date(daily_reset_at) < date('now'), reset)

RESERVATION EXPIRY:
  In reserve: set expires_at = now + 300 seconds
  sweep-reservations: DELETE expired reservations, refund amounts back to balance

Generate the complete class.

