# Launchpad Go-Live Audit — TODO

Findings from the end-to-end audit (branch `claude/launchpad-project-audit-1fqlpj`,
baseline: 1532/1532 tests pass, typecheck clean — all green *while these holes exist*
because tests hit workers directly and UI verification mocked the network layer).
Each item: evidence, failure scenario, fix. Status: `[ ]` open, `[x]` fixed.

## Tier 1 — Launch blockers

- [ ] **F-17: `apps/shell` fails typecheck → `next build` fails → the Product Shell cannot
  deploy at all.** Evidence: `apps/shell/src/components/Chat.tsx:168` — `const url = await
  getStreamUrl(...)` inside a NON-async `React.useCallback` (TS1308). Introduced by commit
  `a6eab1c` (the stream-ticket wiring was added to `streamRun` without making the callback
  async; shell typecheck wasn't re-run). `pnpm turbo run typecheck` currently FAILS on
  `@naelao/shell` at HEAD. Failure: CF Pages deploy of the shell breaks → every end user of
  every product has no UI. Fix: make the callback async + re-verify the stream path it was
  wiring; fix FIRST since it gates verifying everything else end-to-end.

- [ ] **F-1: `/v1/builder/*` is not routed — the entire Builder Dashboard API 404s.**
  Evidence: `workers/spaces/src/builder-routes.ts:141+` implements `/builder/api-keys`,
  `/builder/products` (CRUD/pricing/domain/analytics/payouts), `/builder/space-types`;
  `apps/dashboard/src/lib/api.ts` calls them all through the router — but the router's
  `api` group (`workers/router/src/index.ts:589-963`) has no `/builder` route, so every
  call hits `app.notFound`. Failure: builder logs in, clicks Create in the wizard →
  `POST /v1/builder/products` → 404. All 7+ management tabs dead.
  Fix: `api.all("/builder/*", proxyTo(SPACES_WORKER, ...))` + bare `/builder`, plus a
  router↔frontend route-parity test (see F-STRUCT).

- [ ] **F-2: Lemon Squeezy webhooks have no public ingress — all money-in events undeliverable.**
  Evidence: `workers/billing/wrangler.toml:10` sets `workers_dev = false` (item 29) but no
  `routes =` exists in any wrangler.toml or Terraform (`infra/terraform/` has zero
  worker-route resources); the router neither proxies `/webhooks/*` nor has a
  `BILLING_WORKER` binding (`workers/router/src/index.ts:21-26`). Failure: buyer pays at
  LS → webhook POST to `/webhooks/lemon-squeezy` reaches nothing → orders never fulfil,
  subscriptions never activate, credit packs never grant, seats never activate.
  Customers charged; platform never learns. Fix: add `BILLING_WORKER` binding + an
  unauthenticated `app.all("/v1/webhooks/lemon-squeezy")` pass-through registered before
  the JWT group (LS signature is the auth — same precedent as connectors/channels ingress
  at router lines 251-269).
  
  **Payment processor rollout note:** Only `whop-seller` template is live at launch
  (spacetype.ts:191-324). The six coming-soon templates (creator-store, newsletter-business,
  micro-saas, service-agency, coaching-community, customer-service) all depend on Lemon
  Squeezy (`commerce` skill, LS webhooks). Once F-2 is fixed, these templates become
  immediately launchable — no code changes needed beyond the webhook route. `whop-seller`
  has its own Whop-side webhook already wired (revenue-tracker prebuilt polls Whop API;
  no webhook dependency). Cross-niche compatibility: LS is the platform standard (all
  niches use it for subscriptions/credit-packs once they launch); Whop is read-only via
  MCP-connector (the whop-seller niche) or managed sub-merchant sub-accounts (future).
  Stripe is currently unimplemented but would follow the same Lemon Squeezy webhook pattern.

- [ ] **F-3: Builder's post-login landing page fails to load entirely.**
  Evidence: `apps/dashboard/src/app/dashboard/page.tsx:53` does
  `Promise.all([listSpaces(), listSpaceTypes()])`; `listSpaceTypes()` (`api.ts:183`) calls
  `GET /v1/spacetypes` — a route no worker implements (api.ts:845's own comment). The 404
  rejects the whole Promise.all, discarding the spaces list too → "Failed to load data"
  on every login. Fix: remove the call (or use the real `GET /builder/space-types` after
  F-1) and decouple the two fetches.

- [ ] **F-13: Staging/production deploys are broken two different ways (wrangler env
  binding non-inheritance + deploy-workflow mismatch).** Wrangler named environments do
  NOT inherit binding tables (`durable_objects`, `d1_databases`, `kv_namespaces`,
  `r2_buckets`, `queues`, `services`) — item 41 fixed only `vars` parity. Measured:
  router declares 11 binding tables top-level, **0** in `[env.staging]`/`[env.production]`;
  spaces 15 → 3; agents 20 → 6; knowledge/notifications/credentials 2-4 → 0; auth has no
  env blocks at all. Two failure modes, both verified:
  (a) `.github/workflows/deploy-staging.yml` deploys every worker with `--env=staging` →
  staging workers run with essentially no DB/DO/KV/queue/service bindings → every request
  500s. (b) `.github/workflows/deploy-prod.yml:82` deploys with **no** `--env` → production
  runs the top-level *development* config: `ENVIRONMENT="development"`,
  `CORS_ALLOWLIST=http://localhost:...` (dashboard.naelao.com is not a product domain, so
  the dynamic resolver can't save it → the builder dashboard is CORS-blocked in prod),
  and `PRODUCT_SHELL_URL=http://localhost:3100` → verification emails link to localhost.
  The `[env.production]` blocks are dead config. Fix: replicate ALL binding tables into
  every env block (or drop named envs and use per-env accounts/config files), align both
  deploy workflows on one strategy, and extend `wrangler-vars-parity.test.ts` to assert
  binding-table parity, not just vars.

- [ ] **F-14 (SECURITY): Cross-tenant read/write on the publicly-reachable agents worker —
  the item-21 hole, incompletely closed.** `workers/agents` deliberately keeps
  `workers_dev` enabled (its channel gateway needs public ingress), so ALL its routes are
  directly reachable, bypassing the router. `/agent/run` verifies
  `x-naelao-internal-token` (index.ts:245) — but many sibling routes only do
  `getCallerIdentity` + "missing tenant" check, trusting the client-supplied
  `x-naelao-tenant-id` header outright. Verified unprotected (agents/src/index.ts):
  `GET /spaces/:id/tasks` (:1101) and `/tasks/:taskId`, `GET /spaces/:id/channels/sessions`
  (:1694) + `/channels/unanswered` (:1702), `POST /channels/sessions/:id/resume` (:1790) +
  `/takeover` (:1798) — flip human-takeover on another tenant's customer bot,
  `POST /skills/promote` (:1913) + `/skills/inherit` (:2037) — write another tenant's
  template skill library, `POST /spaces/:id/projects/from-template` (:1535) — creates
  projects in a victim space and then mints REAL internal tokens downstream,
  `POST /spaces/:id/bootstrap/complete` (:1813) — runs setup scripts / wakes the
  assistant (spends the victim's LLM budget). Attacker needs only the workers.dev URL +
  victim tenant/space ids (internal but not secrets). Fix: sweep ALL 37 routes in this
  file; every non-signature-gated, non-catalog route gets `verifyInternalToken` (same
  fix as :245). Add a test asserting each `/spaces/:id/*` route 403s without the token.

## Tier 2b — Revenue Model & Trust (depends on F-2 webhooks)

- [ ] **ARCH-REVENUE: Three-tier revenue sharing architecture — Naelao, Builder, End User.**

  **✅ DECIDED MODEL (user, 2026-07-08) — supersedes the open options below:**
  On the Launchpad SpaceType, who earns depends on WHOSE revenue the money is:
  1. **End user's BUSINESS revenue** (storefront sales, seat sales — money the business
     earns from ITS customers): **split three ways** — the business keeps the net,
     **Naelao takes a cut AND the builder takes a cut**. Today's code takes only the
     Naelao 5% (`LAUNCHPAD_FEE_BPS`) and settles the rest to the business wallet — a
     BUILDER share must be added: e.g. gross → naelao_fee_bps + builder_fee_bps
     (builder-configurable per product, within a Naelao-set ceiling) → remainder to the
     business's wallet. The builder's share lands in the builder's payout balance
     (`reseller_ledger` row with `kind='builder_revenue_share'`).
  2. **End user's SUBSCRIPTION to the builder's product** (plans/credit packs — the end
     user paying to USE the product): **Naelao keeps 100%.** No settlement to the business
     wallet, no builder share. This resolves ARCH-REVENUE-1/2's open options: do NOT add
     wallet settlement for `business_subscription` payments; do NOT split credit packs.
     (Rationale: subscription revenue funds the platform compute the product consumes.)
  3. **Builder's own platform subscription** (builder paying for Naelao plan tiers —
     growth/business): **Naelao keeps 100%** (already true — Stripe/LS plan billing).
  Implementation surface: `recordProductOrder`/`recordSeatActivation` in
  `billing/lemon-squeezy.ts` gain a builder-share deduction; `builder_fee_bps` lives in
  `productConfig.commerce` (config_json override, like memberBilling — never a manifest
  fork); payout read side per ARCH-REVENUE-5.

  **CURRENT STATE (product sales only):**
  - **Product storefront sales** (launchpad_orders): Naelao takes `LAUNCHPAD_FEE_BPS` (default 500 bps = 5%), the SELLING space gets the net. Example: $100 order → $5 platform fee → $95 to seller's wallet.
  - **Business subscriptions**: Zero revenue split — entire plan price goes to Naelao LS account, seller sees only a database row in `business_subscriptions`.
  - **Credit pack purchases** (individual end user): Zero revenue split — entire purchase amount granted as credits to the end user's balance (ProductUserDO.credit_ledger).
  - **Wallet top-ups** (business funding its own wallet): Zero revenue split — entire amount credited to the business's wallet project.
  - **Member/seat billing**: Takes `LAUNCHPAD_FEE_BPS`, rest to seller's wallet (same pattern as product sales).
  
  **GAPS TO CLOSE (for Launchpad go-live):**
  
  **ARCH-REVENUE-1: ~~Business subscription revenue split~~ RESOLVED by decided model:
  NO split — Naelao keeps 100% of plan subscriptions. The analysis below is kept for
  context only; do not implement its "Required" section.**
  Original framing — when an end user subscribes to a plan on behalf of a business:
  - Event: `subscription.created` / `subscription.payment_success` with metadata `kind="business_subscription"`
  - Current code: `recordBusinessSubscription` (lemon-squeezy.ts:262-292) upserts into `business_subscriptions` table but does NOT settle any revenue to the business's wallet
  - Required: Apply the same fee split as product sales:
    - `gross = event.amountCents` (e.g., 2900 for a $29/mo plan)
    - `fee = round(gross * LAUNCHPAD_FEE_BPS / 10000)` (e.g., 145 cents at 500 bps)
    - `net = gross - fee` (e.g., 2755 cents)
    - `settleOrderToWallet(business_space_id, net, idempotency_key, "subscription_payment")` — credit the business's own wallet
  - Migration: Add a `business_subscription_orders` table (like launchpad_orders) to audit trail subscription revenue, OR reuse launchpad_orders with a `kind='subscription'` field to keep one ledger
  - Idempotency: Use the LS subscription_id + period hash as the key (a subscription has multiple payments over its lifetime; each should settle once)
  - Open question: Should Naelao's own cut be recorded somewhere? (Currently not visible anywhere; product sales just leave it implicit in the math.)
  
  **ARCH-REVENUE-2: ~~Credit pack revenue split~~ RESOLVED by decided model: NO split —
  Naelao keeps 100% (subscription-class revenue). Options below kept for context; the
  earlier "Option A recommended" is overridden.**
  Original framing — when an end user buys credits:
  - Event: `payment.success` with metadata `kind="credit_pack"`
  - Current code: `grantCreditPackPurchase` (lemon-squeezy.ts:301-339) grants the full purchase amount to the end user's credit_ledger, no split
  - Required model decision: WHO gets the revenue cut?
    - **Option A (Builder gets cut):** Credit packs are add-ons sold under the builder's product, so the builder earns revenue. Apply the same fee split: end user charged $5 → Naelao takes $0.25 → builder's wallet gets $4.75, end user gets the credit pack worth $5 worth of credits.
    - **Option B (Naelao gets 100%, credits are free):** Credit packs are a separate revenue stream Naelao owns. End user pays → Naelao keeps it all → end user's balance is debited/topped-up without any wallet settlement.
    - **Option C (Hybrid — builder gets a cut of the plan, credit packs are Naelao's):** Subscriptions split revenue with builder, but credit packs are pure Naelao revenue, used to fund the free tier and upsell.
  - Current spec/CLAUDE.md direction: Not explicitly stated; needs user clarification before building.
  - Recommendation: **Option A (builder gets a cut)** — reason: consistency with product sales (all money-in splits the same way), and a builder who owns a product naturally wants to monetize credit upsells too. This also incentivizes builders to guide end users toward paid credits rather than letting them run out.
  - Implementation: Same as subscription split — settle net to the **product space's wallet** (not the end user's, since this is revenue the product/builder earned, not a user account balance).
  
  **ARCH-REVENUE-3: Wallet top-up — CONFIRMED passthrough (no split), consistent with the
  decided model (a top-up is the business's own capital, not new revenue).**
  Original framing — when a business tops up its own wallet (pre-funding):
  - Event: `payment.success` with metadata `kind="wallet_topup"`
  - Current code: `grantWalletTopupPurchase` (lemon-squeezy.ts:350-387) grants the full amount to the wallet project
  - Context: This is a business (the seller) funding its own agent's compute costs. Naelao is providing the execution platform (container, LLM, etc.), so Naelao should take a cut of this too, UNLESS the wallet top-up is meant to be a pure passthrough (builder pre-funds agent runs, Naelao just stores it).
  - Model decision: Is a wallet top-up a "product sale" (builder buying from Naelao), or a "settlement of earned revenue" (business moving money into the operational wallet)?
    - **If product sale:** Apply fee split (Naelao takes cut, rest goes to wallet)
    - **If passthrough:** No fee split (100% goes to wallet; Naelao's revenue is charged at execution time, via project spend gating)
  - Current spec framing (AUDIT_TODO F-WALLET context): "Your AI only spends money this business earned" — implies wallet_topup is the business's own money moving into operational custody, NOT a sale. Naelao's revenue comes from the spend-gating per-agent-run, not the top-up.
  - Recommendation: **No fee split on wallet top-up** — reason: this is the business's own capital, not a new revenue transaction. If Naelao later charges for execution (hourly API calls, container compute, etc.), that's where the cut comes. For now, wallet top-ups are 100% to the wallet (business has earned it via storefront sales, or is funding its own compute). Update billing-worker comment to reflect this distinction.
  
  **ARCH-REVENUE-4: Tracking Naelao's own revenue** — currently invisible:
  - Every product sale: `launchpad_orders.fee_cents` is calculated but just left in the Naelao LS account. No SpaceDO ledger, no internal tracking.
  - Every subscription: No fee recorded anywhere.
  - Recommended: Add a `naelao_revenue` table (or a view over launchpad_orders summed by period) so:
    - Financial reporting is auditable (sum all fees per month)
    - Builder payouts can be calculated precisely (total_revenue - naelao_revenue = builder_payout)
    - Revenue-sharing %s can be tweaked per product/niche (store current `LAUNCHPAD_FEE_BPS` in a column, not just hardcode it)
  - Migration: `0058_naelao_revenue_tracking.sql` with a summary table and daily/monthly rollup logic.
  
  **ARCH-REVENUE-6 (NEW BUILD ITEM — the one real code change the decided model needs):
  Builder share of end-user business revenue.**
  - `recordProductOrder` / `recordSeatActivation` (`billing/lemon-squeezy.ts`) currently
    compute only `fee = gross * LAUNCHPAD_FEE_BPS` (Naelao) and settle `net` to the selling
    business's wallet. Add a second deduction: `builder_fee = gross * builder_fee_bps`,
    where `builder_fee_bps` comes from the checkout metadata (stamped at checkout time from
    `productConfig.commerce.builderFeeBps`, same way `fee_bps` is stamped today — never
    resolved at webhook time, so a config change can't retroactively re-price an in-flight
    order). Business wallet gets `gross - naelao_fee - builder_fee`.
  - Builder's share recorded as a `reseller_ledger` row (`kind='builder_revenue_share'`)
    so the existing payout-balance sum picks it up; per ARCH-REVENUE-5, payout read side
    must break out by kind.
  - Guardrails: `builderFeeBps` capped by a platform ceiling (e.g. 3000 bps) validated at
    PATCH time in builder-routes; combined fees must never exceed gross (clamp, and never
    let net go negative). Refund clawback must claw back BOTH shares, not just the wallet
    net (extend `recordOrderRefund`).
  - Same split applies to the Whop external-revenue surcharge path (`revenue-cut-surcharge`):
    today the surcharge payment lands entirely in Naelao's LS account; the decided model
    says the builder gets their configured slice — attribute it in `reseller_ledger` when
    the surcharge payment.success arrives.
  - Shell/dashboard transparency: business wallet ledger rows should show the two
    deductions (Naelao cut, builder cut) explicitly, not one opaque fee.

  **ARCH-REVENUE-7 / F-21 (money leak, verified): `recordResellerAttribution` is
  UNCONDITIONAL — it attributes a builder margin on payer classes the decided model says
  are 100% Naelao's, and on money that isn't revenue at all.**
  Evidence: `billing/lemon-squeezy.ts:781` runs `recordResellerAttribution` on EVERY
  ledger event (`isLedgerEvent` = every payment.success + subscription.* ) for any space
  whose tenant is a child under a reseller — with no filter on the checkout `kind`. So a
  referral-mode builder (referral_share_pct) accrues withdrawable `margin_cents`
  (`computeAvailableBalances` sums the whole ledger, builder-routes.ts:831) on:
  - `kind="business_subscription"` payments → decided model says Naelao keeps 100%;
  - `kind="credit_pack"` → same;
  - `kind="wallet_topup"` → WORST case: the business tops up its own wallet with $100,
    the full $100 is credited to the wallet (passthrough by design), AND the builder
    accrues a share of it — total obligations exceed money in. A builder colluding with
    (or owning) a child business can loop top-ups to farm payout balance from Naelao.
  - `kind="revenue_cut_surcharge"` → the surcharge test's own comment (revenue-cut-
    surcharge.test.ts:9) even celebrates this as "no new code needed" — correct for the
    surcharge (the builder SHOULD get a slice of that one) but only by accident.
  Fix: pass the event's checkout `kind` into the attribution step and allowlist which
  kinds accrue builder margin per the decided model (product sales, seats, surcharges —
  NOT business_subscription / credit_pack / wallet_topup). Add a `kind` column to
  `reseller_ledger` rows so ARCH-REVENUE-5's by-source breakdown is possible, and a test
  proving a wallet_topup on a child business accrues zero margin.

  **ARCH-REVENUE-5: Builder payout calculation** — the inverse of Naelao's cut:
  - Current code: `GET /builder/payouts*` exists (`builder-routes.ts:680+`) and calculates builder balance via `reseller_ledger`
  - Issue: `reseller_ledger` is a dual-purpose table (attribution for ALL transactions, including seats + credit packs where the builder doesn't earn anything). The payout code sums it all, which is imprecise.
  - Recommendation: When calculating builder payouts (the amount they can withdraw), sum only rows where `kind='product_sale'` or `kind='business_subscription'` (explicitly exclude `kind='credit_pack'` if Option C, or include it if Option A). Add test coverage verifying a builder's withdrawable balance is exactly (sum(launchpad_orders.net_cents) + sum(subscription_orders.net_cents)) where order.product_id = builder_product.
  - Current state: `builder-routes.ts:695` returns `{total: reseller_ledger sum, currency}` — should be `{by_source: {product_sales: X, subscriptions: Y, ...}, total: X+Y}` for transparency.

- [ ] **F-WALLET: Business wallet system — automatic store provisioning + revenue ledger + agent spend gating.**

  **⚠ RE-SCOPED after verifying HEAD (much already exists — do not rebuild):**
  - ALREADY BUILT: `seedWallet` provisioner step auto-creates a `kind='wallet'` project per
    space; LS storefront sales CREDIT the selling space's wallet and refunds DEBIT it
    (`billing/lemon-squeezy.ts:138-195`, ledger never goes negative); agent runs are gated
    on wallet balance (`NaelaoAgentDO.checkProjectWallet`, always-on for project runs, 402
    when empty); `wallet_topup` checkout exists with idempotency keys; Whop revenue
    reporting exists with a `revenue_reporting_lapsed` fail-closed gate.
  - STILL MISSING: (a) the two UI surfaces (F-WALLET-6 dashboard tab, F-WALLET-7 shell
    display); (b) explicit Naelao revenue-share accounting surfaced in the ledger (verify
    whether commerce `fee_bps` already covers the cut before adding anything); (c) the
    per-business LS Store / Whop sub-merchant auto-provisioning (F-WALLET-1/2) — note the
    CURRENT design settles everything through Naelao's own LS account + per-business ledger,
    which may be strictly better (no per-store onboarding); treat 1/2 as a design decision
    to confirm, not a mandatory build.
  
  Original evidence/model (kept for context): if an agent could access payment credentials, it could spend the builder's PERSONAL money. The Model: Naelao is the merchant; each business's agent can only spend money that business actually earned. Core differentiator: "Your AI only spends what the business earned — transparent, auditable, no risk to your personal account."
  
  **Subparts (re-check each against HEAD before building):**
  
  **F-WALLET-1: Auto LS Store provisioning** — provisioner step 10c (after seedOwnerMember): call LS API `POST /v1/stores` with business name + slug, store returned `store_id` + auto-generated API key in that business's `space_credentials` (scope='space'). Best-effort; if LS call fails, business still creates with `wallet_status: 'pending_setup'` flag so builder can retry manually.
  
  **F-WALLET-2: Auto Whop sub-merchant provisioning** (required for `whop-seller` niche) — provisioner checks niche type; if Whop: call Whop Connect API to create managed account under Naelao's Connect partner account. Store returned account ID + webhook signing key in that business's `space_credentials`. Same best-effort pattern. (LS is primary for other niches; Whop is specific to whop-seller template.)
  
  **F-WALLET-3: Business wallet ledger** — new migration 0050_business_wallet.sql:
  ```sql
  CREATE TABLE business_wallet (
    business_id TEXT PRIMARY KEY,
    currency TEXT DEFAULT 'USD',
    total_earned_cents INTEGER DEFAULT 0,
    naelao_cut_cents INTEGER DEFAULT 0,       -- Naelao's revenue share (configurable %, e.g., 15%)
    available_balance_cents INTEGER DEFAULT 0, -- what agent can spend
    last_transaction_at TIMESTAMP,
    updated_at TIMESTAMP
  );
  ```
  Wired into billing worker: when LS `payment.success` or Whop order webhook arrives → upsert this table (total_earned += amount; naelao_cut += amount * NAELAO_SHARE; available_balance += remainder).
  
  **F-WALLET-4: Wallet project type** — special system project auto-created in each business at provisioning (project.kind = 'wallet'). Read-only to agent. Renders: cumulative_earned | naelao_cut | available_balance | recent_transactions. Visible to builder + Space Assistant. Agent sees "Available to spend: $XXX" in system context for autonomy gating.
  
  **F-WALLET-5: Agent spend gating** — rewire existing Phase E gate: before any costly script execution, check `business_wallet.available_balance >= cost_estimate`. Fail CLOSED with message "Business doesn't have enough balance earned yet to fund this." Debit on completion (already done, just needs wallet reference).
  
  **F-WALLET-6: Dashboard Wallet tab** (builder-facing, business admin only):
  ```
  GET /builder/products/:id/wallet       -- aggregated across all businesses
  GET /spaces/:spaceId/wallet            -- per-business detailed ledger (read + write protected for non-admin)
  ```
  Renders: lifetime earned | Naelao's cut | available for scaling | transaction history. Admin can view and export, payout routes deferred to Tier 4.
  
  **F-WALLET-7: Shell Wallet section** (business detail page) — read-only transparency:
  Display: "Total earned: $X | Available to grow the business: $Y | Naelao's share: $Z". Message: "Your AI only spends money this business has earned."
  
  Routes needed: `GET /spaces/:spaceId/wallet`, `GET /builder/products/:id/wallet`, plus migrations + provisioner steps.

## Tier 2 — Serious

- [ ] **F-4: Stream-ticket security fix is dead code; raw `nps_` tokens still land in URLs/logs.**
  Evidence: `apps/shell/src/lib/api.ts:212` POSTs `/v1/spaces/:id/sessions/stream-ticket`
  → spaces sessions catch-all (`workers/spaces/src/index.ts:458`) → SpaceDO → 404 → shell
  silently falls back to token-in-URL. The only mint endpoint,
  `POST /internal/stream-tickets/issue` (spaces index.ts:2500), requires
  `x-naelao-platform-secret` — the shell can never call it, and nothing anywhere does.
  Fix: public `POST /spaces/:spaceId/sessions/stream-ticket` on the spaces worker
  (registered before the sessions catch-all), authenticated by verified caller identity,
  calling the issue logic; one end-to-end test through the router.

- [ ] **F-18 (money/legal): Deleting a product strands live paying subscribers.**
  Evidence: `workers/spaces/src/builder-routes.ts:481-490` — `DELETE /builder/products/:id`
  only sets `status='deleted'`; nothing enumerates the product's businesses'
  `business_subscriptions` or calls Lemon Squeezy to cancel them; nothing notifies end
  users. Access genuinely dies (`by-slug` requires `status='active'` at index.ts:2660;
  product-session verify excludes deleted at :2043) — so end users are locked out WHILE LS
  keeps invoicing them monthly. Chargeback/legal exposure day one. Same gap on
  `paused`/`suspended` transitions. Distinct from F-7 (F-7 = churned business keeps access;
  F-18 = deleted product keeps charging). Fix: on delete/suspend, enumerate child
  businesses' LS subscription ids and call the LS cancel API (best-effort + retry), and
  block deletion (or typed-confirm with subscriber count) when active subscriptions exist.

- [ ] **F-5: `/billing/*` also unrouted (dead code today, loaded footgun).**
  Evidence: dashboard `api.ts:461/473` define `/billing/checkout` + `/billing/subscription`;
  billing worker implements them (`workers/billing/src/index.ts:141/203/285`); no page
  calls them yet and the router can't reach billing anyway. Fix rides with F-2's binding.

## Tier 3 — Revenue integrity

- [ ] **F-23 (revenue): Subscription gate never reads `current_period_end` — a missed
  webhook grants access forever, and `past_due` grace is unbounded.**
  Evidence: `resolveBusinessSubscriptionGate` (spaces/index.ts:2196-2203) checks only
  `business_subscriptions.status`; the `current_period_end` column the webhook faithfully
  stores (lemon-squeezy.ts:283) is never read anywhere. Two failure modes: (a) if LS
  webhooks stop arriving (endpoint outage, rotated secret — or F-2's current unrouted
  state), a cancelled/expired subscription's row stays `status='active'` forever with no
  self-healing; (b) `past_due` is treated as active indefinitely — the comment says "grace
  period" but nothing bounds it, so a business whose card permanently fails runs free for
  as long as LS keeps the status (or forever if the terminal webhook is missed).
  Fix: the gate should also require `current_period_end` (+ a fixed grace window, e.g.
  3 days) to be in the future when the column is set; treat a long-expired period as
  inactive regardless of stored status.

- [ ] **F-24 (correctness): Out-of-order LS webhooks can brick a resubscribed business.**
  Evidence: `recordBusinessSubscription` upserts `ON CONFLICT(business_space_id)`
  unconditionally (lemon-squeezy.ts:273-289) — the row is keyed by business, not by
  subscription. Real sequence: business's subscription A is set to cancel at period end;
  business resubscribes (subscription B, `subscription.created` → row now B/active); LS
  later delivers A's terminal `subscription_cancelled` (fires at period end, AFTER B was
  created) → the upsert overwrites the row to `cancelled` with A's ids → the gate 402s a
  business that is actually paying, until B's next monthly payment event flips it back.
  Fix: on status-downgrade events (cancelled/expired/paused), only apply when the event's
  `subscriptionId` matches the stored `ls_subscription_id`; creations/upgrades keep the
  unconditional upsert. One test with the A-cancel-after-B-create ordering.

- [ ] **F-25 (double billing): No guard against subscribing an already-subscribed
  business — plan switching double-charges.**
  Evidence: `POST /internal/business-subscriptions/checkout` (billing/index.ts:604-656)
  never reads `business_subscriptions` for an existing active row, and nothing anywhere
  calls the LS subscription-cancel API when a new subscription supersedes an old one
  (grep: zero cancel calls in the repo outside the F-18 fix's TODO). The DB upsert keys on
  business_space_id so Naelao's row shows ONE plan — but in Lemon Squeezy BOTH
  subscriptions keep invoicing the customer monthly. The shell's "Subscribe" button
  (business detail page) has no already-subscribed state either. Compounded by F-24: the
  two live subscriptions' events overwrite the same row in whatever order they arrive.
  Fix: checkout route 409s (`already_subscribed`, with the current plan) when an
  active/past_due row exists; plan switching becomes explicit — cancel old sub via LS API
  then checkout new (or use LS's own update-subscription variant-change endpoint, which
  prorates and avoids the two-subscriptions window entirely).

- [ ] **F-22 (race): `POST /builder/payouts/request` is read-then-insert — two concurrent
  requests can each create a pending payout for the FULL balance.**
  Evidence: `builder-routes.ts:853-884` — `computeAvailableBalances` (a SELECT) then a
  plain INSERT with no uniqueness or atomic decrement; nothing stops the second request
  reading the balance before the first's row lands. Manual fulfillment (v1 is
  human-reviewed by design, migration 0053) is the only backstop — an admin who fulfils
  both pays out double. Fix: a partial unique index on
  `payout_requests(tenant_id, currency) WHERE status='pending'` (one open request per
  currency, matching the UX anyway) — cheapest honest fix given D1 has no SELECT FOR
  UPDATE; 409 on conflict.

- [x] **F-7: FIXED at HEAD (verified, do not re-report)** — `NaelaoAgentDO.
  checkBusinessSubscriptionGate` (agents/do/NaelaoAgentDO.ts:1960) now reads
  `business_subscriptions` before every run and fails CLOSED.
- [x] **F-8: FIXED at HEAD (verified, do not re-report)** — `POST /internal/product-users/
  :spaceId/:endUserId/credits/refresh-monthly` (spaces index.ts:2326) exists and the agents
  worker calls it in the pre-run gate before reading the balance.

- [ ] **F-19 (abuse/DoS): Unbounded business creation per end user.**
  Evidence: `workers/spaces/src/business-create.ts` (`createBusinessForEndUser`) does a
  direct `INSERT INTO spaces` and NEVER calls `enforceSpaceQuota` (which only guards
  `createSpaceRecord`); no per-end-user cap exists anywhere on
  `POST /spaces/:productSpaceId/businesses`. All of one user's businesses share one child
  tenant (`tenant_hierarchy` reuses `child_tenant_id`), so the fix is cheap: one verified
  end user (one free email) can loop the endpoint and create unbounded child spaces, each
  queueing FULL provisioning (SpaceDO init, agent installs, seedWallet, R2 writes) — a
  resource-abuse vector the authenticated rate limiter only slows, never bounds.
  Fix: call `enforceSpaceQuota(childTenantId)` (free-tier cap applies naturally) and/or add
  `productConfig.maxBusinessesPerEndUser` checked in `createBusinessForEndUser`.

- [ ] **F-26 (severe overbilling): the revenue-tracker's Whop pull ignores the `period` it
  claims to snapshot — every monthly snapshot is ALL-TIME revenue.**
  Evidence: `fetchWhopRevenueThisPeriod(ctx, period)`
  (workers/agents/src/script-engine/prebuilt/revenue-tracker.ts:55-82) never uses its
  `period` parameter — `list_payments` is called with only `{page, per, status:"paid"}`,
  no date filter, so the sum is the business's completed payments across all time (capped
  at 5 pages × 100). The SpaceDO upsert then stores that all-time total AS the month's
  revenue, and the surcharge checkout sums every unbilled period — so a business tracked
  monthly is re-billed the cut on its entire historical revenue EVERY month (month 2's
  "revenue" includes all of month 1's, already billed). The SpaceDO comment's premise
  ("a period's revenue can only grow") only holds because it's all-time. The opposite
  error also exists: MAX_PAGES=5 silently caps at 500 payments (the header calls this the
  "conservative direction," but combined with the missing date filter the net effect is
  wildly wrong in both directions). Fix: pass a created-at date range for the period into
  the Whop `list_payments` call (verify Whop's actual filter param name per the file's own
  header caveat) and only sum payments inside it; add a test asserting a payment outside
  the period is excluded.

- [ ] **F-27 (double billing + trust): re-tracking an already-billed period reverts it to
  unbilled and re-bills the FULL corrected figure, not the delta — and the billed party
  controls the number.**
  Evidence: `recordExternalRevenue` (spaces/do/SpaceDO.ts:2628-2642) sets `billed=0`
  whenever the re-tracked figure differs from the stored one (the comment says a corrected
  figure "should be re-billable") — but the surcharge checkout bills
  `cutBps × revenue_cents` of every unbilled period with no memory of what was already
  collected. Correct 2026-06 from 100k (5k cut already paid) to 120k → next checkout bills
  5% of 120k = 6k → 11k collected on 6k owed. With F-26 unfixed this fires constantly (the
  all-time figure changes on every track). Trust half: `revenue_cents` originates from a
  prebuilt running inside the business's own agent — the billed party can decline to run
  the tracker (no snapshot → no bill), register a doctored "whop" MCP server, or post a
  lower figure that both zeroes the basis AND resets billed. Fix: store `billed_cents`
  (what was actually charged) per period and bill only
  `max(0, cut(new_revenue) − billed_cents)` on correction; make snapshot history
  builder-visible so gaming is at least auditable, and flag businesses holding a whop
  credential with no recent snapshot.

- [ ] **F-28 (double-dip, F-21 instance worth its own line): the revenue-cut surcharge
  payment itself flows through reseller attribution.**
  Evidence: tests/unit/revenue-cut-surcharge.test.ts:9-11's own comment —
  "recordResellerAttribution is unconditional for every payment.success — no new code
  needed there." The surcharge IS the mechanism collecting Naelao's/the builder's cut of
  external revenue; running it through `recordResellerAttribution` too means a
  referral-mode builder accrues `referralSharePct` margin ON the cut collection — paid
  twice for the same revenue (and in reseller mode Naelao books wholesale against its own
  fee). Fix: same allowlist as F-21 — exclude `kind='revenue_cut_surcharge'` from reseller
  attribution.

- [ ] **F-29 (monetary loss): refund clawback only exists for storefront product orders —
  a refunded wallet top-up leaves the full spendable credit in the wallet.**
  Evidence: the `refund.issued` handler (lemon-squeezy.ts:215-227) only matches
  `launchpad_orders` rows and returns silently for anything else. A business tops up its
  wallet, spends nothing, requests an LS refund (or chargeback) → money returned by LS,
  wallet balance unchanged → free Naelao platform spend; repeatable. Same gap for credit
  packs (refunded end user keeps credits) and surcharges (refund never un-marks periods
  `billed` — the cut is silently forgiven, loss in Naelao's direction). Note the reseller
  ledger DOES reverse on refund (`REVERSAL_EVENTS`), so today a refunded top-up reverses
  builder attribution (itself wrong per F-21) while leaving the actual wallet credit
  untouched — exactly backwards. Fix: extend the refund handler to route by the original
  checkout `kind` (custom_data survives on the refund event, same as the mark-billed
  path): wallet_topup → wallet debit `refund_clawback` (the 402-tolerant path already
  exists), credit_pack → negative credit_ledger entry, revenue_cut_surcharge → un-mark
  periods. Related: a refunded SEAT purchase (recordSeatActivation writes into
  launchpad_orders, so the clawback path does fire) claws back the wallet settlement but
  never deactivates the seat member — the refunded member keeps access.

- [ ] **F-30 (paying customer gets nothing): credit-pack / wallet-top-up idempotency keys
  are derived from purchase ATTRIBUTES, so two identical legitimate purchases collide and
  the second grant is silently dropped.**
  Evidence: lemon-squeezy.ts:318 and :366 — `event.subscriptionId ?? "credit_pack:
  {customerId}:{amountCents}:{endUserId}:{credits}"`. One-time LS orders have no
  subscriptionId, so the synthetic fallback is what actually runs — and it's identical for
  every purchase of the same pack by the same customer. Buy the same $10 pack twice
  (running low again next week): the second webhook's grant hits ProductUserDO's /
  wallet_ledger's unique idempotency index and is swallowed as a "duplicate" — the
  customer paid and received nothing, with no error anywhere (idempotent replay is
  treated as success). The per-webhook `(provider, event_id)` gate upstream already
  handles genuine retries, so the synthetic key adds no protection — only this failure
  mode. Fix: key on the LS order id (`event.providerEventId`, already used by the refund
  path) — unique per real purchase, stable across webhook retries.

- [ ] **F-31 (minor race): two surcharge checkouts issued before either is paid both bill
  the same periods.**
  Evidence: `POST /internal/revenue-cut-surcharge/checkout` computes from `billed=0`
  periods; `billed` only flips on the payment webhook. Two checkout URLs minted for the
  same periods (retry, double-click, assistant re-run) are BOTH payable — the business
  pays the cut twice. Low likelihood (assistant-driven flow), but the fix is one column:
  `pending_checkout_at` on the snapshot row, skipped for ~24h (or the F-25 fix's 409
  shape while one is outstanding).

## Tier 4 — Operate & retain (known-open, re-confirmed)

- [ ] **F-9: No builder UI for `agent_activity_log`** (data is populated; `GET
  /spaces/:spaceId/agent-activity` exists; nothing renders it).
- [ ] **F-10: No first-run/onboarding flow for a new product.**
- [ ] **F-11: No GDPR erasure for end users** (export exists, deletion doesn't).
- [ ] **F-12: No cross-provider LLM failover** (only the Anthropic-compatible AI Gateway
  endpoint is called, not the Universal multi-provider one).

- [ ] **F-3d: Prebuilt business-scaling skills library.** "Builders should be able to tell their AI assistant 'scale the business from $0 to $10k MRR' or 'optimize pricing' or 'build a brand identity' and the AI executes it." Currently there are zero pre-built skills — every builder starts from scratch. Fix: ship 4-6 prebuilt agent-authored skills in the skill library (accessible via `script.find` and auto-loaded into Launchpad's Space Assistant profile):
  - `scaling-zero-to-ten-k` — incremental steps: product-market fit → repeat sales → scaling channels → team handoff
  - `storefront-setup` — configure product catalog, pricing tiers, upsell bundles using LS/Whop APIs
  - `pricing-optimization` — analyze revenue + competitor research (via MCP), recommend price changes
  - `brand-identity` — discover current brand gaps, recommend logo/copy/positioning, source freelancers
  - `sales-outreach` — cold email campaigns via MCP email service, A/B testing harness
  - `customer-retention` — churn analysis, win-back campaigns, loyalty program setup
  
  Each skill: documented in Markdown, versioned in R2 (`spaces/{spaceId}/scripts/{name}/SCRIPT.md`), embeddings in Vectorize for discovery. Agent wires them into its business methodology based on business model (whop-seller, SaaS, agency, etc.). These are not hardcoded — they're ordinary scripts that showcase the platform's capability. Can be forked by builders and customized.

- [ ] **F-15: Business invites never email the invitee.** `workers/spaces/src/
  business-routes.ts:147-165` stores the invitee's email + hashed token but sends nothing
  (no NOTIFICATIONS_WORKER call). The shell surfaces a copyable link
  (`spaces/[businessId]/page.tsx:496`), so invites work by manual paste — "invite by
  email" collects an address it never uses. Fix: best-effort `/internal/notify` email with
  the accept link, same pattern as verification emails.

## Polish

- [ ] **F-6: CORS responses lack `Vary: Origin`** (`workers/router/src/index.ts:200`) —
  a shared cache could serve one origin's ACAO to another. One-liner.

- [ ] **F-20 (polish): No global uniqueness on `business_services.custom_domain`.**
  Evidence: migration `0056` creates a plain (non-UNIQUE) `INDEX` on `custom_domain`; both
  domain-set paths (`spaces/index.ts:1799`, `builder-routes.ts:538`) only
  `ON CONFLICT(space_id, kind)` — per-space, not global. Two different spaces can each hold
  a `pending_dns` row for the same domain. NOT a takeover (CORS only trusts `status='active'`,
  which requires CF-for-SaaS DCV = proof of ownership; the loser's row sits pending forever),
  so this is squatting/confusion only. Fix: pre-insert check for an existing active row on
  the domain under another space → 409, and/or a partial UNIQUE index where status='active'.

- [ ] **F-16: Deploy workflows swallow failures.** `deploy-staging.yml:43` has `|| true`
  and `:90` marks per-worker deploy failures non-fatal — a half-deployed platform reports
  green. Make core-worker failures fatal; at minimum surface a summary.

## Deploy checklist (config-time, unverifiable in-repo — do before go-live)

- [ ] **Payment processor merchant accounts + credentials** (required for F-WALLET provisioning):
  - **Lemon Squeezy:** `LEMON_SQUEEZY_API_KEY` (personal API key, not store-specific), `LEMON_SQUEEZY_WEBHOOK_SECRET` (signed by LS). Note: `LEMON_SQUEEZY_STORE_ID` is now per-business (auto-provisioned), not a global secret.
  - **Whop:** `WHOP_CONNECT_CLIENT_ID` + `WHOP_CONNECT_CLIENT_SECRET` (partner account credentials for creating managed sub-merchant accounts), `WHOP_WEBHOOK_SIGNING_KEY` (if using webhook signature verification).

- [ ] Secrets per worker (baseline):
  `JWT_SECRET`, `PLATFORM_SECRET` (identical everywhere), `ANTHROPIC_API_KEY`, `RESEND_API_KEY` (verification/reset/invite emails — without it, signup credits are unreachable).

- [ ] Webhook ingress (post-F-2):
  - LS store webhook → points to `https://your-domain.com/v1/webhooks/lemon-squeezy` (with LS `LEMON_SQUEEZY_WEBHOOK_SECRET` for signature verification).
  - Whop order webhooks → same, or separate endpoint if different signature scheme.

- [ ] CF Pages environment variables:
  - **Dashboard** `NEXT_PUBLIC_API_URL=https://your-domain.com/v1` (includes `/v1` prefix; dashboard's `api.ts` omits it from paths).
  - **Shell** `NEXT_PUBLIC_API_URL=https://your-domain.com` (omits `/v1`; shell's `api.ts` includes it in paths). Different values for same var name; copy-paste between projects breaks one. Consider fixing in code later.

- [ ] Replace every `REPLACE_WITH_*_ID` placeholder in wrangler.tomls (D1/KV ids).
- [ ] `PRODUCT_SUBDOMAIN_APEX` matches the real production apex (e.g., `naelao.com` → `*.naelao.com` subdomains).
- [ ] Verify `NAELAO_REVENUE_SHARE` is set in agents/spaces workers (the percentage cut F-WALLET deducts; e.g., 0.15 for 15%).

## Structural

- [ ] **F-STRUCT: Route-parity test.** Extract every path prefix `apps/dashboard` and
  `apps/shell` call and assert the router dispatches each to a real worker route — F-1,
  F-3, and F-5 are one bug class; this is the `wrangler-vars-parity.test.ts` equivalent.
- [ ] **F-HYGIENE: `.turbo/` directories are git-tracked** — every typecheck run dirties
  the tree. Add to `.gitignore` and `git rm -r --cached`.

## Plausible-but-unconfirmed (verify before fixing)

- [ ] `PRODUCT_SUBDOMAIN_APEX` must match the real production apex once domains go live
  (config-time; unverifiable in-repo).
- [ ] `nak_` agent-key approval gate's coarse action keys (`agentActionKey` collapses to
  first path segment) — deliberate, but untested against deep mutating routes.

## Disproven during audit (do NOT re-report)

- Webhook idempotency/replay: top-level `processed_webhook_events` gate ((provider,
  event_id) PK, checked BEFORE any side effect) + per-table `INSERT OR IGNORE` — solid.
- Provisioner failure recovery: real `rollbackSpace` path deprovisions the partial list.
- Verification/reset token entropy: double `crypto.randomUUID()`, stored hashed, expiring.
- Full test suite: 1532/1532 with `--config tests/vitest.config.ts` (a bare root
  `pnpm vitest run` fails to collect 76 files — missing `cloudflare:workers` stub alias —
  wrong invocation, not a bug).
- F-WALLET note: a `wallet_topup` checkout flow ALREADY exists
  (`billing/lemon-squeezy.ts:345-375`, posts to a business project wallet with idempotency
  keys) — F-WALLET-3 should extend it, not duplicate it.

- Bare `GET /templates` through the router: Hono's `app.all("/templates/*")` DOES match
  bare `/templates` (verified empirically against this repo's hono version) — the
  wizard's Template Gallery routes fine. The double registration elsewhere
  (`/spaces` + `/spaces/*`) is belt-and-suspenders, not a requirement.
- Shell router allowlist coverage: every path `apps/shell/src/lib/api.ts` calls was
  cross-checked against `PRODUCT_END_USER_PATH_PATTERNS` — all covered.
- Email delivery mechanism: notifications worker makes real Resend API calls
  (`sendEmailNow`), and spaces→notifications service binding exists in all env blocks.
  Only the secret is a deploy-time concern.
