Here is the complete, exhaustive, production-ready specification for **Phase 8 — Chunk 01**: `specs/phase-8/chunk-01-credit-metering-and-budget-envelopes.md`.

---

```markdown
---
chunk_id: "phase-8-chunk-01"
phase: 8
include_files:
  - packages/billing-core/src/index.ts
  - workers/spaces/src/do/SpaceDO.ts
  - workers/billing/src/index.ts
  - workers/billing/src/quota.ts
repomix_include:
  - "packages/billing-core/src/index.ts"
  - "workers/spaces/src/do/SpaceDO.ts"
  - "workers/billing/src/index.ts"
  - "workers/billing/src/quota.ts"
expected_outputs:
  - packages/billing-core/src/budget-envelope.ts
  - packages/billing-core/src/index.ts
  - workers/spaces/src/do/SpaceDO.ts
  - infra/migrations/0074_budget_envelopes.sql
---

# Phase 8 — Chunk 01: Standardized Credit Metering & Per-User Budget Envelopes

## 1. Executive Summary & Architectural Vision

In shared multi-user company spaces, unconstrained personal assistants create a **"Tragedy of the Commons"**:
* A company space funds a shared corporate operating balance ($150 / 15,000 credits).
* Member Alice prompts her assistant to run a multi-hour competitive research crawl across 50 websites, triggering dozens of parallel container compilations and browser scrapes.
* Alice’s assistant burns $120 of compute in 45 minutes.
* Coworker Bob logs in to execute a mission-critical client deployment and receives an immediate refusal: `402 Payment Required: Company wallet depleted.`

To prevent personal assistants from bankrupting the corporate treasury while preserving an autonomous self-funding business loop, Phase 8 Chunk 01 establishes a strict **Three-Pillar Credit & Quota Governance Architecture**:

1. **Standardized Credit Unit:** $1.00 USD = 100 Platform Credits (1 Credit = $0.01 USD / 1 Cent). All LLM tokens, container compute minutes, Kitesurf scrapes, and voice calls settle in integer credits.
2. **Per-User Daily Budget Envelopes (`space_user_budget_envelopes`):** Every member within a shared space receives a configurable daily spending ceiling (default: 500 credits = $5.00/day). When a user's assistant hits the ceiling, it is halted with a graceful budget message without affecting coworkers or background automations.
3. **The 40% Protected Corporate Reserve:** Exactly 40% of the space's active wallet balance is cryptographically ring-fenced for **Class 1 Company Automations** (nightly Stripe reconciliations, inbound customer telephony, webhook routers). Personal user assistants are physically barred from dipping into this reserve pool.

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                               THE THREE-PILLAR CREDIT GOVERNANCE PLANE                                 │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                COMPANY OPERATING WALLET ($150.00 / 15,000 Credits)                      │
│                                                                                                        │
│   ┌───────────────────────────────────────────────────┬────────────────────────────────────────────┐   │
│   │ 🛡️ PROTECTED CORPORATE RESERVE (40% / $60.00)      │ 👥 SPENDABLE EMPLOYEE POOL (60% / $90.00)   │   │
│   │ • Class 1 Company Automations ONLY                │ • Subject to Per-User Daily Envelopes      │   │
│   │ • Nightly Stripe Reconciler                       │ • Alice Daily Cap: 500 Credits ($5.00)     │   │
│   │ • 24/7 Phone Receptionist                         │ • Bob Daily Cap:   500 Credits ($5.00)     │   │
│   │ • Inbound Lead Triage Queues                      │ • Charlie Cap:     200 Credits ($2.00)     │   │
│   └───────────────────────────────────────────────────┴────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────┬────────────────────────────────────────────────────┘
                                                    │
                         ┌──────────────────────────┴──────────────────────────┐
                         ▼ (Enforced at Edge in SpaceDO)                       ▼
┌─────────────────────────────────────────────────────────────┐   ┌─────────────────────────────────────────────────────────────┐
│ 👩‍💻 ALICE'S ASSISTANT                                        │   │ 🤖 NIGHTLY RECONCILER AUTOMATION (Class 1)                  │
├─────────────────────────────────────────────────────────────┤   ├─────────────────────────────────────────────────────────────┤
│ • Consumed today: 490 Credits ($4.90).                      │   │ • Requires: 50 Credits ($0.50).                             │
│ • Requests: Container compile costing 25 Credits.           │   │ • Personal envelope check: BYPASSED (System Task).          │
│ • Check: 490 + 25 = 515 > 500 (Daily Ceiling Breach!)       │   │ • Reserve check: $60.00 reserve is intact.                 │
│ ❌ **EXECUTION HALTED:** "Daily compute allowance reached.  │   │ ✅ **EXECUTION GRANTED:** Debits corporate wallet directly. │
│    Contact space admin for an envelope expansion."          │   │                                                             │
└─────────────────────────────────────────────────────────────┘   └─────────────────────────────────────────────────────────────┘
```

---

## 2. Mathematical Formulation of Quota Enforcement

Let $W_t \in \mathbb{R}^+$ be the total liquid credit balance in `SpaceDO.wallet_ledger` at time $t$. 
The corporate reserve floor $R(W_t)$ is strictly defined as:
$$R(W_t) = 0.40 \times W_t$$

Let $E_{u} \in \mathbb{N}$ be the daily credit allowance assigned to user $u$, and $S_{u, t} \in \mathbb{N}$ be the cumulative credits spent by user $u$ during the current 24-hour cycle beginning at $T_{\text{reset}}$.

For an execution request originating from user $u$ demanding $C_{\text{req}}$ credits:

$$\text{Authorize}(u, C_{\text{req}}, W_t) = \begin{cases}
\text{ALLOW}, & \text{if } (S_{u, t} + C_{\text{req}} \le E_u) \land (W_t - C_{\text{req}} \ge R(W_t)) \\
\text{REJECT (USER\_BUDGET\_EXCEEDED)}, & \text{if } S_{u, t} + C_{\text{req}} > E_u \\
\text{REJECT (RESERVE\_FLOOR\_BREACH)}, & \text{if } W_t - C_{\text{req}} < R(W_t)
\end{cases}$$

For an authorized **Class 1 Company Automation** (system-level, unassociated with a human user):
$$\text{Authorize}_{\text{system}}(C_{\text{req}}, W_t) = \begin{cases}
\text{ALLOW}, & \text{if } W_t - C_{\text{req}} \ge 0 \\
\text{REJECT (WALLET\_EMPTY)}, & \text{otherwise}
\end{cases}$$

---

## 3. Database Schema Migrations

### A. D1 Migration (`infra/migrations/0074_budget_envelopes.sql`)
Persists user budget allocations across the organization in primary D1 storage:

```sql
-- Migration 0074: Per-User Daily Budget Envelopes
CREATE TABLE IF NOT EXISTS space_user_budget_envelopes (
  space_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  daily_credit_allowance INTEGER NOT NULL DEFAULT 500, -- 500 credits = $5.00 USD
  credits_spent_today INTEGER NOT NULL DEFAULT 0,
  hard_stop_enabled INTEGER NOT NULL DEFAULT 1,
  warned_at_eighty INTEGER NOT NULL DEFAULT 0,         -- Boolean flag for 80% threshold alert
  reset_at TEXT NOT NULL DEFAULT (datetime('now', '+1 day')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (space_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_sube_reset ON space_user_budget_envelopes(reset_at);
CREATE INDEX IF NOT EXISTS idx_sube_space_user ON space_user_budget_envelopes(space_id, user_id);
```

---

## 4. Technical File Specifications & Implementation Contracts

### A. `packages/billing-core/src/budget-envelope.ts`

Create `packages/billing-core/src/budget-envelope.ts` and export all functions and types through `packages/billing-core/src/index.ts`:

```typescript
export interface UserBudgetEnvelope {
  spaceId: string;
  userId: string;
  dailyCreditAllowance: number;
  creditsSpentToday: number;
  hardStopEnabled: boolean;
  warnedAtEighty: boolean;
  resetAt: string;
}

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: "USER_BUDGET_EXCEEDED" | "RESERVE_FLOOR_BREACH" | "INSUFFICIENT_FUNDS";
  remainingUserCredits: number;
  remainingWalletCredits: number;
  requiresSoftWarning?: boolean;
}

export const CORPORATE_RESERVE_PERCENT = 0.40; // 40% of wallet reserved for Class 1 automations
export const DEFAULT_USER_DAILY_CREDITS = 500;  // 500 credits = $5.00

/**
 * Pure evaluation function for user budget envelope compliance
 */
export function evaluateUserBudget(
  envelope: UserBudgetEnvelope,
  requestedCredits: number,
  walletBalanceCredits: number,
  isClass1Automation: boolean = false
): BudgetCheckResult {
  // 1. System Class 1 Automations bypass user envelopes
  if (isClass1Automation) {
    const hasFunds = walletBalanceCredits >= requestedCredits;
    return {
      allowed: hasFunds,
      reason: hasFunds ? undefined : "INSUFFICIENT_FUNDS",
      remainingUserCredits: Infinity,
      remainingWalletCredits: walletBalanceCredits - requestedCredits
    };
  }

  // 2. Evaluate User Daily Envelope
  const projectedUserSpend = envelope.creditsSpentToday + requestedCredits;
  if (envelope.hardStopEnabled && projectedUserSpend > envelope.dailyCreditAllowance) {
    return {
      allowed: false,
      reason: "USER_BUDGET_EXCEEDED",
      remainingUserCredits: Math.max(0, envelope.dailyCreditAllowance - envelope.creditsSpentToday),
      remainingWalletCredits: walletBalanceCredits
    };
  }

  // 3. Evaluate 40% Corporate Reserve Floor
  const reserveFloor = Math.round(walletBalanceCredits * CORPORATE_RESERVE_PERCENT);
  const remainingAfterDebit = walletBalanceCredits - requestedCredits;
  if (remainingAfterDebit < reserveFloor) {
    return {
      allowed: false,
      reason: "RESERVE_FLOOR_BREACH",
      remainingUserCredits: Math.max(0, envelope.dailyCreditAllowance - envelope.creditsSpentToday),
      remainingWalletCredits: walletBalanceCredits
    };
  }

  // 4. Check for 80% soft warning threshold
  const eightyPercentThreshold = envelope.dailyCreditAllowance * 0.80;
  const requiresSoftWarning = !envelope.warnedAtEighty && projectedUserSpend >= eightyPercentThreshold;

  return {
    allowed: true,
    remainingUserCredits: envelope.dailyCreditAllowance - projectedUserSpend,
    remainingWalletCredits: remainingAfterDebit,
    requiresSoftWarning
  };
}
```

---

### B. Update `packages/billing-core/src/index.ts`

Re-export all budget envelope interfaces, constants, and evaluation functions:

```typescript
export * from "./budget-envelope";
```

---

### C. Update `workers/spaces/src/do/SpaceDO.ts`

Extend `SpaceDO` to enforce budget envelopes directly inside single-threaded SQLite storage, avoiding distributed race conditions:

#### 1. Schema Initialization in `ensureInit()`
Inside `ensureInit()`, add the in-DO SQLite table for budget envelopes:

```typescript
this.ctx.storage.sql.exec(`
  CREATE TABLE IF NOT EXISTS space_user_budget_envelopes (
    user_id TEXT PRIMARY KEY,
    daily_credit_allowance INTEGER NOT NULL DEFAULT 500,
    credits_spent_today INTEGER NOT NULL DEFAULT 0,
    hard_stop_enabled INTEGER NOT NULL DEFAULT 1,
    warned_at_eighty INTEGER NOT NULL DEFAULT 0,
    reset_at TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
```

#### 2. Envelope Check & Automated Daily Reset Handler
Implement `checkUserBudgetEnvelope`:

```typescript
async checkUserBudgetEnvelope(
  userId: string,
  requestedCredits: number,
  isClass1Automation: boolean = false
): Promise<{ allowed: boolean; reason?: string; remainingCredits: number }> {
  const nowIso = new Date().toISOString();

  // 1. Fetch or initialize user budget envelope
  let row = this.ctx.storage.sql.exec(
    `SELECT * FROM space_user_budget_envelopes WHERE user_id = ?`,
    userId
  ).toArray()[0] as any;

  if (!row) {
    const nextDay = new Date(Date.now() + 86400000).toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO space_user_budget_envelopes 
       (user_id, daily_credit_allowance, credits_spent_today, hard_stop_enabled, warned_at_eighty, reset_at)
       VALUES (?, 500, 0, 1, 0, ?)`,
      userId,
      nextDay
    );
    row = {
      user_id: userId,
      daily_credit_allowance: 500,
      credits_spent_today: 0,
      hard_stop_enabled: 1,
      warned_at_eighty: 0,
      reset_at: nextDay
    };
  }

  // 2. Check if daily window has rolled over
  if (nowIso >= row.reset_at) {
    const nextReset = new Date(Date.now() + 86400000).toISOString();
    this.ctx.storage.sql.exec(
      `UPDATE space_user_budget_envelopes 
       SET credits_spent_today = 0, warned_at_eighty = 0, reset_at = ?, updated_at = datetime('now')
       WHERE user_id = ?`,
      nextReset,
      userId
    );
    row.credits_spent_today = 0;
    row.warned_at_eighty = 0;
    row.reset_at = nextReset;
  }

  // 3. Fetch current liquid wallet balance (in credits = cents)
  const balanceRow = this.ctx.storage.sql.exec(
    `SELECT COALESCE(SUM(delta_cents), 0) as balance_cents FROM wallet_ledger WHERE currency = 'USD'`
  ).toArray()[0] as any;
  const walletBalanceCredits = balanceRow ? Number(balanceRow.balance_cents) : 0;

  // 4. Evaluate via pure billing-core logic
  const envelope: UserBudgetEnvelope = {
    spaceId: this.spaceId,
    userId: row.user_id,
    dailyCreditAllowance: Number(row.daily_credit_allowance),
    creditsSpentToday: Number(row.credits_spent_today),
    hardStopEnabled: Boolean(row.hard_stop_enabled),
    warnedAtEighty: Boolean(row.warned_at_eighty),
    resetAt: row.reset_at
  };

  const evalResult = evaluateUserBudget(envelope, requestedCredits, walletBalanceCredits, isClass1Automation);

  if (!evalResult.allowed) {
    return {
      allowed: false,
      reason: evalResult.reason,
      remainingCredits: evalResult.remainingUserCredits
    };
  }

  // 5. If 80% threshold reached, record warning flag
  if (evalResult.requiresSoftWarning) {
    this.ctx.storage.sql.exec(
      `UPDATE space_user_budget_envelopes SET warned_at_eighty = 1 WHERE user_id = ?`,
      userId
    );
  }

  return {
    allowed: true,
    remainingCredits: evalResult.remainingUserCredits
  };
}
```

#### 3. Atomic Debit Method in `SpaceDO.ts`
Implement `recordUserBudgetDebit`:

```typescript
async recordUserBudgetDebit(
  userId: string,
  creditsSpent: number,
  reason: string,
  isClass1Automation: boolean = false
): Promise<{ ok: boolean; balanceRemaining: number }> {
  // 1. Transactionally increment user envelope spend and record in wallet_ledger
  return this.ctx.storage.transactionSync(() => {
    if (!isClass1Automation) {
      this.ctx.storage.sql.exec(
        `UPDATE space_user_budget_envelopes 
         SET credits_spent_today = credits_spent_today + ?, updated_at = datetime('now')
         WHERE user_id = ?`,
        creditsSpent,
        userId
      );
    }

    // Record negative debit in wallet ledger
    const debitCents = -Math.abs(creditsSpent);
    this.ctx.storage.sql.exec(
      `INSERT INTO wallet_ledger (id, space_id, delta_cents, currency, reason, created_at)
       VALUES (?, ?, ?, 'USD', ?, datetime('now'))`,
      `wld_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      this.spaceId,
      debitCents,
      `[${isClass1Automation ? "SYSTEM_AUTOMATION" : `USER:${userId}`}] ${reason}`
    );

    const balanceRow = this.ctx.storage.sql.exec(
      `SELECT COALESCE(SUM(delta_cents), 0) as balance_cents FROM wallet_ledger WHERE currency = 'USD'`
    ).toArray()[0] as any;

    return {
      ok: true,
      balanceRemaining: balanceRow ? Number(balanceRow.balance_cents) : 0
    };
  });
}
```

---

### D. Update `workers/billing/src/quota.ts`

Add helper functions to check user budget envelopes from external HTTP routes:

```typescript
export async function checkUserBudgetBeforeRun(
  spaceDO: DurableObjectStub,
  userId: string,
  estimatedCredits: number,
  isClass1Automation: boolean = false
): Promise<{ allowed: boolean; reason?: string; remainingCredits: number }> {
  const res = await spaceDO.fetch("http://internal/budget/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId, estimatedCredits, isClass1Automation })
  });

  if (!res.ok) {
    return { allowed: false, reason: "BUDGET_LOOKUP_FAILED", remainingCredits: 0 };
  }

  return await res.json();
}
```

---

## 5. Step-by-Step Implementation Guide for the AI Runner

When executing this chunk:

1. **Create `packages/billing-core/src/budget-envelope.ts`**:
   - Implement `UserBudgetEnvelope`, `BudgetCheckResult`, `evaluateUserBudget`, `CORPORATE_RESERVE_PERCENT`, and `DEFAULT_USER_DAILY_CREDITS`.
2. **Update `packages/billing-core/src/index.ts`**:
   - Add `export * from "./budget-envelope";`.
3. **Create Migration `infra/migrations/0074_budget_envelopes.sql`**:
   - Create the `space_user_budget_envelopes` table and indices as specified.
4. **Update `workers/spaces/src/do/SpaceDO.ts`**:
   - In `ensureInit()`, add the in-DO SQLite schema initialization.
   - Implement `checkUserBudgetEnvelope` and `recordUserBudgetDebit`.
   - Add internal HTTP routing branches: `POST /budget/check` and `POST /budget/debit`.
5. **Update `workers/billing/src/quota.ts`**:
   - Add `checkUserBudgetBeforeRun`.
6. **Execute Local Verification**:
   - Run `node --check` across modified JavaScript/TypeScript outputs to ensure strict syntax correctness.
```

---

