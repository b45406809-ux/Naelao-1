Here is the complete, ultra-detailed, production-ready specification file for **Phase 8 — Chunk 04**: `specs/phase-8/chunk-04-two-tier-marketplace-and-settlement.md`.

---

```markdown
---
chunk_id: "phase-8-chunk-04"
phase: 8
include_files:
  - workers/billing/src/index.ts
  - workers/spaces/src/business-routes.ts
  - packages/billing-core/src/index.ts
  - packages/types/src/index.ts
repomix_include:
  - "workers/billing/src/index.ts"
  - "workers/spaces/src/business-routes.ts"
  - "packages/billing-core/src/index.ts"
  - "packages/types/src/index.ts"
expected_outputs:
  - workers/billing/src/settlement.ts
  - workers/billing/src/index.ts
  - infra/migrations/0075_marketplace_settlement.sql
---

# Phase 8 — Chunk 04: Two-Tier Developer Marketplace & Settlement Engine

## 1. Executive Summary & Architectural Vision

The AVOS marketplace transforms the platform from a standalone SaaS tool into a self-scaling developer ecosystem (the *"Shopify App Store + Figma Community"* for vertical AI studios). 

To prevent shovelware, align creator incentives, and safeguard platform profitability, the marketplace enforces a **Binary Monetization Model** combined with **Cumulative Per-Tier Cycle Quotas** and an **Automated Settlement Ledger**.

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                THE TWO MARKETPLACE TEMPLATE PATHS                                       │
├───────────────────────────────┬───────────────────────────────────────┬─────────────────────────────────┤
│ Dimension                     │ Model A: Freemium Tiered SaaS Template│ Model B: Fixed One-Off License  │
├───────────────────────────────┼───────────────────────────────────────┼─────────────────────────────────┤
│ **Upfront Price to Install**  │ **$0.00 (Free to Install)**           │ **$49 – $499 One-Time Buy-Out** │
├───────────────────────────────┼───────────────────────────────────────┼─────────────────────────────────┤
│ **Feature Gating per Plan**   │ ✅ **YES (Granular per Plan Tier)**   │ ❌ **NO (100% Fully Unlocked)** │
│                               │ • $20 Plan: Basic Features            │ All features open to whatever   │
│                               │ • $50 Plan: Advanced Tools            │ base compute plan the user runs │
│                               │ • $150 Plan: Enterprise Engine        │                                 │
├───────────────────────────────┼───────────────────────────────────────┼─────────────────────────────────┤
│ **Developer Payout**          │ **40% / 20% Recurring Commissions**   │ **100% of Upfront Sale**        │
│                               │ (Lifetime on $150+; 6–12 mo on lower) │ (0% on monthly platform compute)│
├───────────────────────────────┼───────────────────────────────────────┼─────────────────────────────────┤
│ **Developer Incentive**       │ **Build killer $150 features** to     │ **Build turnkey, complete open  │
│                               │ maximize recurring monthly upgrades.  │ templates** for instant cash.   │
└───────────────────────────────┴───────────────────────────────────────┴─────────────────────────────────┘
```

---

## 2. Cumulative Per-Tier Cycle Quotas (Anti-Plan-Hopping Engine)

To protect platform unit economics on low-priced plans while rewarding high-ticket retainers, the system tracks cumulative paid billing cycles per tier:

* **Entry Tier ($20/mo):** Developer receives commission for **maximum 6 paid cycles ($48 total bounty)**. Drops to 0% thereafter (Platform captures 100%).
* **Growth Tier ($50/mo):** Developer receives commission for **maximum 12 paid cycles ($240 total bounty)**. Drops to 0% thereafter.
* **Pro Tier ($150+/mo):** **Lifetime recurring commission** for the duration of the client.
* **Anti-Gaming Ledger:** Cumulative counters in D1 (`cycles_paid_entry_tier`, `cycles_paid_growth_tier`, `cycles_paid_pro_tier`) track usage across plan downgrades and upgrades, ensuring users cannot game commissions by plan-hopping.

---

## 3. Database Schema Migration (`infra/migrations/0075_marketplace_settlement.sql`)

```sql
-- Migration 0075: Marketplace Subscriptions & Multi-Party Settlement Ledger

CREATE TABLE IF NOT EXISTS template_subscriptions (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL UNIQUE,
  template_id TEXT NOT NULL,
  developer_user_id TEXT NOT NULL,
  attribution_channel TEXT NOT NULL CHECK (attribution_channel IN ('DEVELOPER_REFERRAL', 'MARKETPLACE_ORGANIC', 'FIXED_ONE_OFF')),
  
  -- Cumulative Tier Usage Counters (Anti-Plan-Hopping)
  cycles_paid_entry_tier INTEGER NOT NULL DEFAULT 0,  -- Capped at 6 max for plans <= $25
  cycles_paid_growth_tier INTEGER NOT NULL DEFAULT 0, -- Capped at 12 max for plans $26 - $100
  cycles_paid_pro_tier INTEGER NOT NULL DEFAULT 0,    -- Unlimited for plans >= $150
  
  last_billed_plan_price_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'cancelled')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ts_space ON template_subscriptions(space_id);
CREATE INDEX IF NOT EXISTS idx_ts_dev ON template_subscriptions(developer_user_id);

CREATE TABLE IF NOT EXISTS developer_earnings_ledger (
  id TEXT PRIMARY KEY,
  developer_user_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('subscription_cut', 'one_off_license_sale', 'plugin_sale')),
  gross_cents INTEGER NOT NULL,
  developer_cut_cents INTEGER NOT NULL,
  platform_cut_cents INTEGER NOT NULL,
  period TEXT NOT NULL, -- e.g. "2026-09"
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_del_dev ON developer_earnings_ledger(developer_user_id, period);
```

---

## 4. Production TypeScript Implementation

### A. Automated Settlement Engine (`workers/billing/src/settlement.ts`)

```typescript
import { D1Database } from "@cloudflare/workers-types";

export interface SettlementResult {
  ok: boolean;
  grossCents: number;
  developerCutCents: number;
  platformCutCents: number;
  developerUserId: string;
}

/**
 * Evaluates cumulative subscription billing cycles and executes 
 * automated multi-party revenue splits upon successful invoice webhooks.
 */
export async function settleTemplateSubscriptionPayment(
  db: D1Database,
  spaceId: string,
  grossCents: number
): Promise<SettlementResult | null> {
  // 1. Fetch active subscription record for this business space
  const sub = await db.prepare(
    "SELECT * FROM template_subscriptions WHERE space_id = ? AND status = 'active'"
  ).bind(spaceId).first<any>();

  if (!sub) {
    return null; // Not a template-driven subscription
  }

  const planPriceUsd = grossCents / 100;
  let isCommissionEligible = false;

  // 2. Evaluate & Increment Per-Tier Cumulative Quotas
  if (planPriceUsd <= 25) {
    const newEntryCount = (sub.cycles_paid_entry_tier || 0) + 1;
    await db.prepare(
      "UPDATE template_subscriptions SET cycles_paid_entry_tier = ?, last_billed_plan_price_cents = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(newEntryCount, grossCents, sub.id).run();

    // Eligible ONLY if cycle 1 through 6
    isCommissionEligible = newEntryCount <= 6;
  } else if (planPriceUsd < 150) {
    const newGrowthCount = (sub.cycles_paid_growth_tier || 0) + 1;
    await db.prepare(
      "UPDATE template_subscriptions SET cycles_paid_growth_tier = ?, last_billed_plan_price_cents = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(newGrowthCount, grossCents, sub.id).run();

    // Eligible ONLY if cycle 1 through 12
    isCommissionEligible = newGrowthCount <= 12;
  } else {
    const newProCount = (sub.cycles_paid_pro_tier || 0) + 1;
    await db.prepare(
      "UPDATE template_subscriptions SET cycles_paid_pro_tier = ?, last_billed_plan_price_cents = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(newProCount, grossCents, sub.id).run();

    // Pro Tier ($150+/mo) is Lifetime Unlimited
    isCommissionEligible = true;
  }

  // 3. Compute Multi-Party Revenue Split
  let developerRate = 0.0;
  if (isCommissionEligible) {
    if (sub.attribution_channel === "DEVELOPER_REFERRAL") {
      developerRate = 0.40; // 40% (Developer brought the client)
    } else if (sub.attribution_channel === "MARKETPLACE_ORGANIC") {
      developerRate = 0.20; // 20% (Found in marketplace)
    }
  }

  const developerCutCents = Math.round(grossCents * developerRate);
  const platformCutCents = grossCents - developerCutCents;
  const period = new Date().toISOString().slice(0, 7);

  // 4. Record Settlement in Developer Earnings Ledger
  const ledgerId = `earn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await db.prepare(
    `INSERT INTO developer_earnings_ledger (
       id, developer_user_id, space_id, event_type, gross_cents, developer_cut_cents, platform_cut_cents, period
     ) VALUES (?, ?, ?, 'subscription_cut', ?, ?, ?, ?)`
  ).bind(
    ledgerId,
    sub.developer_user_id,
    spaceId,
    grossCents,
    developerCutCents,
    platformCutCents,
    period
  ).run();

  return {
    ok: true,
    grossCents,
    developerCutCents,
    platformCutCents,
    developerUserId: sub.developer_user_id
  };
}
```

---

## 5. Step-by-Step Implementation Instructions for the AI Runner

When applying this chunk:
1. Apply the D1 migration `infra/migrations/0075_marketplace_settlement.sql` to initialize `template_subscriptions` and `developer_earnings_ledger`.
2. Create `workers/billing/src/settlement.ts` implementing `settleTemplateSubscriptionPayment`.
3. Wire the settlement hook into `workers/billing/src/index.ts` so invoice payment success webhooks automatically call `settleTemplateSubscriptionPayment`.
4. Run `node --check` syntax validation to ensure zero compilation regressions.
```
