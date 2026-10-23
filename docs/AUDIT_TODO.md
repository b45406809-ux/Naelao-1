# Launchpad Go-Live Audit — TODO

Findings from the end-to-end audit (branch `claude/launchpad-project-audit-1fqlpj`,
baseline: 1532/1532 tests pass, typecheck clean — all green *while these holes exist*
because tests hit workers directly and UI verification mocked the network layer).
Each item: evidence, failure scenario, fix. Status: `[ ]` open, `[x]` fixed.

## Deferred, tracked follow-up (NOT for the go-live window)

- [x] **A-2 (deferred from S-A1, CLAUDE.md item 46): converge `/agent/run` onto the
  script-native `handleScriptRun` — DISPATCH CUTOVER DONE; physical deletion of
  `handleRun`/`runReActLoop` DELIBERATELY DEFERRED (see below).**
  Traced the full dispatch/response chain (not just the two DO methods) before touching
  anything, per user direction to implement now rather than only file it: confirmed tool-
  capability parity first (ReAct's entire hardcoded surface — `http_get`, a never-implemented
  `search_web` stub, `calculate`, `search_kb` — is a strict subset of what the script-native
  prebuilts already cover: `web-search`, `knowledge-base`, `code-exec`). Found the cutover is
  NOT a one-line dispatch swap: (1) `agent_definition_id` (used by @mention dispatch) is stored
  as the composite `${spaceId}:${agentId}` row id — converting it to script-native's bare
  `agentId` needs the space prefix stripped; (2) `handleScriptRun`'s response
  (`{level, result: {ok, output, ...}, notes}`, answer nested at `result.result.output`) is a
  genuinely different shape from `handleRun`'s (`{runId, status, finalAnswer, reactSteps}`) —
  three existing consumers (mention-run's parser, the async Workflow→TaskDO chain, apps/shell's
  polling) assume the old shape, so a raw swap would have silently broken them; (3) discovered a
  **separate, pre-existing bug** while tracing that chain: `AgentTaskWorkflow.ts`'s step 3 read
  `body.final_answer` (snake_case) off a response that actually carried `finalAnswer`
  (camelCase) — the key was always `undefined` at runtime, so a TaskDO-completed async run
  likely stored an empty result object in production. Fixed alongside (user's explicit choice)
  since it's on the exact code path being touched.
  **What shipped:** `workers/agents/src/index.ts`'s `/agent/run` route (both the async
  Workflow-dispatch branch and the sync branch) now calls `.../script/run` (handleScriptRun)
  instead of `.../run` (handleRun), with a new `normalizeScriptRunResult()` helper translating
  the script-native `LoopResult` back into `{finalAnswer, final_answer, status, reactSteps: []}`
  so mention-run/polling/Workflow consumers need ZERO changes. `agentId` is derived from
  `agent_definition_id` (stripping the `${spaceId}:` prefix) defaulting to `"naelao-agent"`. The
  now-dead SpaceType-D1-driven `systemPrompt`/`toolsConfig`/inline KB-context-fetch block was
  removed from the route (script-native loads the agent's real R2 config instead).
  `AgentTaskWorkflow.ts`'s `AgentTaskParams` swapped `systemPrompt`/`tools`/`kbContext` for
  `agentId`, and its result-read now checks `finalAnswer ?? final_answer` defensively (the bug
  fix). `/internal/tasks/:taskId/run` mirrors the same script/run dispatch + normalization.
  New end-to-end test `tests/unit/agent-run-script-native-dispatch.test.ts` (5 tests) drives the
  REAL `/agent/run` route against a stubbed DO returning a realistic `LoopResult`, proving the
  normalization (not just testing the pure function in isolation) — plus dispatch-target and
  `agent_definition_id`-stripping assertions. 1740/1740 tests pass (5 new),
  `pnpm turbo run typecheck` clean (75 tasks).
  **Deliberately NOT done — physical deletion of `handleRun`/`runReActLoop`/`dispatchTool`/
  `beforeToolCall`/the `agent_runs` FSM machinery.** Tracing the delete surface found
  `handleRun`'s `agent_runs` SQLite table is shared load-bearing infrastructure for
  `handleGetRun` (GET run status), `handleCancelRun`, and the DO's `alarm()`-based stale-run
  sweep/timeout-cancellation — none of which `handleScriptRun` populates or maintains. Deleting
  `handleRun`/`runReActLoop` outright without first redesigning what backs status-polling/
  cancellation for the `Prefer: respond-sync` / no-Workflow-configured fallback path would strand
  that machinery or silently break it. This is a second, separable piece of work — routing is
  cut over (the exploitable duality no caller reaches `handleRun` through anymore), but the code
  itself stays in place, unreferenced from `/agent/run`, until the FSM/alarm/cancel redesign is
  done as its own scoped pass. Not urgent: nothing dispatches to it anymore, so it can't drift
  out of sync with `handleScriptRun`'s gates again.

- [x] **A-3 (deferred from S-A1, CLAUDE.md item 46): the wallet ledger's latent
  multi-currency conflation — FIXED.** Root cause: `SpaceDO.walletBalance` sums `delta_cents`
  across the whole `wallet_ledger` with no `currency` filter, while `creditWallet` stored a
  per-row `currency` from the request body — a display-only column with no bearing on the
  SUM, meaning a hypothetical non-USD credit would have silently blended into the same
  USD-assumed balance (same failure class as item 39's builder-payout multi-currency bug).
  Confirmed no real caller passes a non-USD currency today (grepped every `wallet/credit`
  caller: `workers/spaces/src/index.ts`, `workers/provisioner/src/index.ts` — none set
  `currency`), so the single-currency-reject option was chosen over making the whole ledger
  currency-scoped. Fix: `creditWallet` now rejects any `currency` other than `"USD"` with a
  clear `400 unsupported_currency`, and both `creditWallet`/`debitWallet` always write the
  literal `'USD'` column value rather than trusting the request body. Tests added to
  `wallet-ledger.test.ts`: a non-USD credit is rejected and never lands in the ledger; an
  explicit `currency:"USD"` credit is unaffected. 1735/1735 tests pass (2 new),
  `pnpm turbo run typecheck` clean (75 tasks).

## Competitive gap analysis — Polsia / Felix (OpenClaw) comparison (2026-07-13, deferred product roadmap, NOT bugs)

Prompted by: "for polsia ai / Felix (openclaw) ... what needs to be there to make user
experience better." Business wallet (item 50-52) and business email (`business-email`
prebuilt + email channel) are already built — these items are what's still missing to match
or beat the two most visible "AI that runs your whole business" competitors. Grounded via
live web search (2026-07-13), not assumed — see sources at bottom. Checked the actual
`workers/agents/src/script-engine/prebuilt/` directory and `connectors/catalogue.ts` before
listing anything below as a gap (only `whop` and `gumroad` are `status: "available"` today;
everything else, including the `"social"`/`"voice"` connector categories, is unimplemented or
`coming_soon`) — nothing here is guessed.

Already at parity or ahead (not gaps, listed for contrast):
- Sub-agent orchestration with named personas (`@mention` multi-agent threads, item T) —
  matches Felix's Iris (support) / Remy (sales) pattern.
- Cross-business shared learning (item 43 Business Network, BF.4) — matches Polsia's
  "cross-company learning system" almost verbatim.
- Nightly memory consolidation (Memory OS Fabric, item U) — matches Felix's "three-layer
  memory, nightly consolidation."
- Scheduled/cron jobs + channel heartbeats — matches "daily autonomous cycles."

- [x] **G-1 (marketing, highest priority) — BUILT (CLAUDE.md item 56).** X/Twitter, LinkedIn,
  Instagram, TikTok are now `available` connectors, Composio-routed (a real Composio "Connect
  Link" hosted flow — click Install, authenticate on the real app's own page, done — rather than
  a bespoke OAuth app per platform, so the same mechanism cheaply extends to more apps later) plus
  a seeded `social-post` skill. The onboarding (template-recommended connectors + a shell "Connect
  Apps" panel) and runtime "prompt to install" behavior (`mcp-connector`'s `needs_connector`
  signal, naming the exact app) are built generically — this is the reusable mechanism G-2/G-8
  will plug into, not a one-off. Not yet LIVE: needs a real `COMPOSIO_API_KEY` + per-app Auth
  Configs provisioned in the Composio dashboard; the code degrades honestly
  (`provider_not_configured`) until then. Pipedream's equivalent hosted-connect flow was
  deliberately NOT built this pass (mcp-hub already tool-call-proxies to a Pipedream connection
  once one exists; nothing initiates one yet) — Composio alone covers every app this pass needed.

- [ ] **G-2 (marketing).** Paid ads (Meta Ads, Google Ads) — spend management tied to the
  business wallet so the agent can set budget/targets against real revenue. The connector
  catalogue now HAS `coming_soon` Composio-routed entries for both (`google-ads`, `meta-ads`,
  item 56) — flipping them `available` reuses the same click-Install mechanism G-1 built; what's
  still missing is the wallet-budget-linking logic itself, not the connector layer.

- [x] **G-3 (marketing/content) — BUILT (CLAUDE.md item 56).** Image/video generation: Higgsfield
  is now an `available` connector (its own hosted MCP server, 30+ models incl. Kling/Veo/Sora —
  simpler than the originally-sketched CF-Workers-AI-image + separate video-provider design, since
  Higgsfield already bundles both) plus seeded `content-generate-image`/`content-generate-video`
  skills. Same onboarding/prompt-to-install mechanism as G-1.

- [ ] **G-4 (marketing).** Cold outbound at general availability. Compliant multi-channel cold
  outreach already exists (item 43 BF.3) but is scoped to exactly one template
  (`freelance-web-studio`) — both competitors treat outbound sales as a core capability for
  every business, not a single-template feature. Generalize the existing outreach mechanism
  (HITL batches, hard caps, STOP/opt-out already built) out of that one template into a
  reusable prebuilt any template can wire in.

- [ ] **G-5 (voice, real differentiator for competitors).** AI phone calls — Felix does
  outbound sales/support calls and inbound. No voice prebuilt or connector exists. Needs a
  `voice` prebuilt (`voice.call`, `voice.list_calls`) backed by a telephony provider
  (Twilio-shaped) + TTS/STT, platform-keyed per the universal-tools doctrine (item 42) since
  telephony minutes are a metered platform cost, not a BYO builder credential.

- [ ] **G-6 (voice, cheap/high-charm).** Voice-note founder updates — Felix sends Nat voice
  notes instead of text digests for the nightly/morning update. Cheap relative to G-5: TTS
  over the existing notification channel infrastructure (`notifications` prebuilt already
  delivers to email/Slack/Discord/WhatsApp), no telephony/STT needed. Good candidate to build
  before full G-5 voice-calling.

- [ ] **G-7 (ops).** Site/uptime health monitoring — Felix has this as a named skill; Launchpad
  has the Revenue sidebar (item 41, G-4a) but nothing that pings the business's own storefront/
  site and alerts on downtime. A `site-monitor` prebuilt (`site_monitor.check`,
  `site_monitor.list_incidents`) + a scheduled job template, reusing the existing
  `scheduled_jobs`/event-trigger machinery (items 15, 20) rather than a new dispatch mechanism.

- [ ] **G-8 (ops).** CRM / lead-pipeline data model — Felix's Remy "handles sales leads"
  against structured state, not just chat threads. We have `agent_activity_log` (item 40) and
  ordinary threads but no deal/lead/pipeline-stage primitive an agent can query and update
  (e.g. `crm.create_lead`, `crm.update_stage`, `crm.list_pipeline`). Would likely live as a new
  SpaceDO table (project-scoped, same pattern as `project_spend`/`container_slots`) plus a
  `crm` prebuilt. The catalogue now has a `coming_soon` Composio-routed `hubspot` entry (item 56)
  for businesses that already run a real CRM — flip it on with the same click-Install mechanism as
  G-1 for that case; a NATIVE Naelao-owned pipeline primitive (this item's original scope) is
  still a separate, unbuilt piece for businesses with no existing CRM.

- [ ] **G-9 (identity/domain).** Domain registration — the existing CF-for-SaaS flow (item 16,
  Phase H) assumes the builder already owns a domain and only handles DNS/DCV pointing.
  Neither competitor's feature list (per the search results) mentions autonomous domain
  purchase, but it's a natural pairing with "business wallet + business email" for a truly
  zero-to-launched business. Cloudflare Registrar API could close this — lower priority than
  G-1..G-6, listed for completeness.

- [ ] **G-10 (monetization, distinct from a UX gap — a revenue opportunity for Naelao itself).**
  Skill marketplace between businesses — Felix has "Claw Mart" (an operator can sell a skill
  their agent built to other operators). We have a Business Network that shares distilled
  learnings for free (item 43 BF.4) but the paid version (BF.5, "private-playbook bidding
  exchange") is explicitly deferred in the spec. This is a real platform revenue line, not
  just parity — worth scoping as its own phase rather than folding into a marketing-gap pass.

Not pursuing (lower priority, flagged not dropped):
- Actual LLC/EIN legal-entity formation — neither Polsia nor Felix appears to do this per the
  search results (both stop at wallet + payments, not legal registration), so it's likely not
  worth chasing ahead of G-1..G-8.

Recommended sequencing: **G-1 (social posting) + G-3 (image generation) are now BUILT** (CLAUDE.md
item 56, 2026-07-13) via the new Composio "click Install" connect mechanism. Next up per the
original sequencing: **G-6 (voice-note updates)** as a cheap high-charm add-on (reuses the
existing `notifications` prebuilt, no telephony/STT needed), then the rest in roughly the
numbered order above — G-2/G-8 now have a head start since their catalogue entries + connect
mechanism already exist (item 56), leaving only their own domain logic (ad-spend/wallet linking,
a native CRM pipeline primitive) unbuilt.

Sources (web search, 2026-07-13): [Polsia — AI That Runs Your Company While You Sleep](https://polsia.com/),
[How Polsia builds and runs companies with AI agents](https://timfrin.substack.com/p/how-polsia-builds-and-runs-companies),
[Polsia: How a Solo Founder Hit $1M ARR in 30 Days With AI Agents](https://www.contextstudios.ai/blog/polsia-how-a-solo-founder-hit-1m-arr-in-30-days-with-ai-agents),
[Full Tutorial: Use OpenClaw to Build a Business That Runs Itself | Nat Eliason](https://creatoreconomy.so/p/use-openclaw-to-build-a-business-that-runs-itself-nat-eliason),
[Building Autonomous AI Businesses with OpenClaw and Felix: A Case Study](https://lunanotes.io/summary/building-autonomous-ai-businesses-with-openclaw-and-felix-a-case-study)

## Tier 1 — Launch blockers

- [x] **F-17: `apps/shell` fails typecheck → `next build` fails → the Product Shell cannot
  deploy at all.** Evidence: `apps/shell/src/components/Chat.tsx:168` — `const url = await
  getStreamUrl(...)` inside a NON-async `React.useCallback` (TS1308). **VERIFIED REAL** via 
  `pnpm turbo run typecheck` (1532 tests pass but typecheck fails at `@naelao/shell`). 
  Failure: CF Pages deploy of the shell breaks → every end user of every product has no UI. 
  Fix: make the callback async + re-verify the stream path it was wiring; fix FIRST since 
  it gates verifying everything else end-to-end.

- [x] **F-1: `/v1/builder/*` is not routed — the entire Builder Dashboard API 404s.**
  **⚠ WAS CHECKED BUT NOT ACTUALLY IN CODE — NOW GENUINELY FIXED:** router had no `/builder`
  route at all (re-verified against HEAD). Added `api.all("/builder/*")` + `api.all("/builder")`
  → SPACES_WORKER in the authenticated group, plus router-dispatch tests and the F-STRUCT parity
  guard so this can never silently regress again.
  Evidence: `workers/spaces/src/builder-routes.ts:141+` implements `/builder/api-keys`,
  `/builder/products` (CRUD/pricing/domain/analytics/payouts), `/builder/space-types`;
  `apps/dashboard/src/lib/api.ts` calls them all through the router — but the router's
  `api` group (`workers/router/src/index.ts:589-963`) has NO `/builder` route at all 
  (grep confirms). **VERIFIED REAL** against router HEAD. Failure: builder logs in, clicks 
  Create in the wizard → `POST /v1/builder/products` → 404. All 7+ management tabs dead.
  Fix: `api.all("/builder/*", proxyTo(SPACES_WORKER, ...))` + bare `/builder`, plus a
  router↔frontend route-parity test (see F-STRUCT).

- [x] **F-2: Lemon Squeezy webhooks have no public ingress — all money-in events undeliverable.**
  **⚠ WAS CHECKED BUT NOT ACTUALLY IN CODE — NOW GENUINELY FIXED:** router had no BILLING_WORKER
  binding and no webhook route (re-verified against HEAD). Added the `BILLING_WORKER` service
  binding (router wrangler.toml) + unauthenticated `app.all("/v1/webhooks/lemon-squeezy")` →
  BILLING_WORKER, registered before the JWT group (LS signature is the auth). Tests added.
  Evidence: router has no webhook routes (grep confirms), no `BILLING_WORKER` binding, 
  no `/webhooks/lemon-squeezy` endpoint. **VERIFIED REAL** against router HEAD — the 
  entire money-in path is unreachable. Failure: buyer pays at LS → webhook to `/webhooks/
  lemon-squeezy` times out/404s → orders never fulfil, subscriptions never activate, 
  credit packs never grant. Customers charged; platform never learns. Fix: add 
  `BILLING_WORKER` binding + unauthenticated `app.all("/v1/webhooks/lemon-squeezy")` 
  pass-through registered BEFORE the JWT group (LS signature is the auth — same 
  precedent as connectors/channels ingress at router lines 251-269).
  
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

- [x] **F-3: Builder's post-login landing page fails to load entirely.**
  Evidence: dashboard calls `listSpaceTypes()` (api.ts:183) → `GET /v1/spacetypes` — 
  no worker implements this route (grep + AUDIT_TODO line 845 confirm). **VERIFIED REAL** 
  against code. Promise.all fails, 404 crashes page → "Failed to load data" on every builder 
  login. Blocks any use of the dashboard. Fix: remove the call (or use real 
  `GET /builder/space-types` after F-1 is fixed) and decouple the two fetches.

- [x] **F-13: Staging/production deploys are broken (wrangler env blocks drop all bindings).**
  **⚠ PARTIALLY FALSE-CHECKED — NOW FIXED:** two real remaining gaps found: (1) deploy-prod.yml
  ran `wrangler deploy` with NO `--env=production`, so production deployed the top-level
  ENVIRONMENT="development"/localhost config — added `--env=production`; (2) workers/auth was the
  one worker with no `[env.staging]`/`[env.production]` blocks at all — added them. Extended
  wrangler-vars-parity.test.ts to assert every worker declaring a top-level ENVIRONMENT var also
  defines both named-env blocks. (Binding tables inherit at top level in modern wrangler, so the
  original "drop all bindings" framing was the pre-fix state.)
  Evidence: router's `[env.staging]` and `[env.production]` (wrangler.toml:64-70) define 
  ONLY `vars`, NOT `d1_databases`, `durable_objects`, `kv_namespaces`, or `services`. 
  **VERIFIED REAL** — wrangler's behavior is to REPLACE (not merge) top-level config 
  when env blocks exist. Router declares 11 binding tables top-level (lines 11-62), 
  zero in env blocks. **Two failure modes:**
  (a) Deploy with `--env=staging` → staging workers have no D1/KV/DOs/bindings → all 
  requests 500. (b) Deploy with no env (production) → production runs development config 
  (`ENVIRONMENT=development`, `CORS_ALLOWLIST=localhost`, verification emails link to 
  localhost). Critical for go-live. Fix: replicate ALL binding tables into every env block 
  (or drop named envs), align deploy workflows, and extend `wrangler-vars-parity.test.ts` 
  to assert binding-table parity.

- [x] **F-14 (SECURITY): Cross-tenant access via spoofed headers on publicly-reachable agents 
  worker.** `workers/agents` has no `workers_dev = false` (checked — line absent from 
  wrangler.toml), so ALL routes are directly reachable at `.workers.dev`, bypassing 
  router auth. Most routes call `getCallerIdentity` (reads `x-naelao-tenant-id` header 
  directly, no verification). **VERIFIED REAL** — specifically: 
  `POST /spaces/:spaceId/projects/from-template` (:1535) mints an internal token with 
  the attacker-supplied tenantId (line 1551: `mintInternalToken(c.env.PLATFORM_SECRET, tenantId)`) 
  and passes it to spaces worker, which trusts it. Attacker can create projects/run scripts 
  in victim spaces. Critical severity (active HITL-gate bypass). Fix: sweep ALL routes; 
  every `/spaces/:id/*` route that mints internal tokens must FIRST verify the space's 
  actual tenant (e.g., query DB with `WHERE id = ? AND tenant_id = ?` using claimed 
  tenantId, 404 if mismatch). OR: set `workers_dev = false` + require all requests to 
  route through the router (but channel webhooks need direct ingress — gate those 
  separately).

  **VERIFIED GENUINELY FIXED:** the agents worker's mutating routes now require a
  `verifyInternalToken` (HMAC with PLATFORM_SECRET — unforgeable from a direct .workers.dev
  caller) AND check `WHERE id = ? AND tenant_id = ?` ownership before minting any downstream
  token. workers_dev stays enabled by design (the channel gateway needs public ingress), with
  per-route token verification as the documented mitigation (CLAUDE.md item 21).

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
  
  **ARCH-REVENUE-6 — ✅ BUILT.** productConfig.commerce.builderFeeBps (capped at 3000bps),
  stamped at checkout (GET /internal/builder-fee-bps resolves from the parent reseller product),
  deducted in recordProductOrder/recordSeatActivation, settled net to the business wallet, builder
  slice attributed to reseller_ledger kind='builder_revenue_share' (migration 0061 adds the column
  + launchpad_orders.builder_fee_cents). Refund reverses both. recordResellerAttribution skips a
  sale carrying builder_fee_bps (never double-paid). Tests: builder-revenue-share.test.ts.
  ORIGINAL: Builder share of end-user business revenue.**
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

  **PARTIALLY FIXED (money-leak closed):** `RESELLER_ATTRIBUTION_BLOCKED_KINDS` now excludes
  `business_subscription`, `credit_pack`, `wallet_topup`, and `revenue_cut_surcharge` from
  `recordResellerAttribution` — the wallet_topup payout-farming leak and the surcharge
  double-dip (F-28) are closed, with a test proving zero margin on a child-business
  wallet_topup. **Still open:** the `reseller_ledger.kind` column + ARCH-REVENUE-5's
  by-source payout breakdown (a schema + payout-read change, deferred to the ARCH-REVENUE
  build).

  **ARCH-REVENUE-5: Builder payout calculation** — the inverse of Naelao's cut:
  - Current code: `GET /builder/payouts*` exists (`builder-routes.ts:680+`) and calculates builder balance via `reseller_ledger`
  - Issue: `reseller_ledger` is a dual-purpose table (attribution for ALL transactions, including seats + credit packs where the builder doesn't earn anything). The payout code sums it all, which is imprecise.
  - Recommendation: When calculating builder payouts (the amount they can withdraw), sum only rows where `kind='product_sale'` or `kind='business_subscription'` (explicitly exclude `kind='credit_pack'` if Option C, or include it if Option A). Add test coverage verifying a builder's withdrawable balance is exactly (sum(launchpad_orders.net_cents) + sum(subscription_orders.net_cents)) where order.product_id = builder_product.
  - Current state: `builder-routes.ts:695` returns `{total: reseller_ledger sum, currency}` — should be `{by_source: {product_sales: X, subscriptions: Y, ...}, total: X+Y}` for transparency.

- [~] **F-WALLET: Business wallet system.** ✅ F-WALLET-6 (dashboard Wallet tab) + F-WALLET-7
  (shell Wallet section) BUILT, backed by new GET /spaces/:spaceId/wallet (consolidated per-business
  view: available balance + recent transactions + lifetime gross/naelao-cut/builder-cut/net summary,
  router-allowlisted for the shell) and GET /builder/products/:id/wallet (builder aggregate across
  the product + child businesses + earned builder revenue share by currency). Still open: F-WALLET-1/2
  (auto LS store / Whop sub-merchant provisioning — a design decision, current single-account model
  may be strictly better). ORIGINAL:

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
  
  **F-WALLET-1 — REASONED DEFERRAL (design decision, not a code gap).** The wallet money-custody mechanism — wallet project (kind=wallet, now DB-singleton-enforced per F-32), wallet_ledger, per-run spend gating, order settlement, and the ARCH-REVENUE-6 three-way split — is FULLY BUILT and working under the SINGLE Naelao Lemon Squeezy account (per-business metadata on each order). Per-business LS store creation is deliberately NOT built: (a) the audit itself flags the single-account model as potentially strictly better [no per-store onboarding friction]; (b) it needs the LS multi-store/partner API + real partner credentials, unverifiable in-repo; (c) half-building an untestable integration is worse than the working default (this codebase's standing philosophy). Revisit as a product decision + config-time credential task. ORIGINAL: Auto LS Store provisioning** — provisioner step 10c (after seedOwnerMember): call LS API `POST /v1/stores` with business name + slug, store returned `store_id` + auto-generated API key in that business's `space_credentials` (scope='space'). Best-effort; if LS call fails, business still creates with `wallet_status: 'pending_setup'` flag so builder can retry manually.
  
  **F-WALLET-2 — REASONED DEFERRAL (needs Whop Connect partner access).** Same reasoning as F-WALLET-1: requires the Whop Connect partner API + real partner credentials that don't exist in-repo and can't be tested. A whop-seller business already operates Whop's OWN storefront/checkout via mcp-connector (connector-operated, per F-41) — the assistant reaches Whop through the existing connector rather than Naelao standing up a competing sub-merchant. Revisit as a product + credential task. ORIGINAL: Auto Whop sub-merchant provisioning** (required for `whop-seller` niche) — provisioner checks niche type; if Whop: call Whop Connect API to create managed account under Naelao's Connect partner account. Store returned account ID + webhook signing key in that business's `space_credentials`. Same best-effort pattern. (LS is primary for other niches; Whop is specific to whop-seller template.)
  
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

## Tier 2b-2 — "Business Feature Projects" (new architecture, user-directed 2026-07-10)

**Concept:** wallet, storefront, business email, and every other "auto-provisioned business
infrastructure" idea (CRM, brand kit, bookkeeping, affiliate program, support inbox, legal vault,
analytics dashboards, business phone/social — see the full registry below) are all modeled as
ONE mechanism: a `projects.kind` value drawn from a data-driven registry (mirroring
`LAUNCHPAD_TEMPLATES`'s own pattern — NOT a new DB table per feature, consistent with
CLAUDE.md ground rule #4 "SpaceType differences live in config... never DB tables"). Each kind
gets its own R2 workspace, its own thread, an optional kind-specific prebuilt script surface
(mirroring `wallet.ts`), and an optional dashboard/shell UI panel. Naelao ships every kind
preconfigured; a business template (e.g. `whop-seller`) pre-selects which kinds it bootstraps;
a builder can add/remove kinds later like any other project.

**Two real bugs this investigation surfaced (log as findings, not just forward design):**

- [ ] **F-32 (gap, confirmed against HEAD): the wallet project has NO database-level singleton
  enforcement.** Evidence: `projects` table (SpaceDO.ts:702-709) has no unique constraint on
  `(space_id, kind)`; `createProject` (SpaceDO.ts:1981-2029) doesn't even accept `kind` in its
  request body — `kind` is only set via a follow-up `PATCH` (confirmed: `seedWallet`,
  provisioner/index.ts:392-411, creates the project then PATCHes `kind: "wallet"` separately).
  Nothing stops a second `PATCH .../projects/:id { kind: "wallet" }` on a different project in
  the same space — two wallet projects, ambiguous spend-gating source of truth. Fix: this is
  F-33's precondition; the singleton index below closes it for wallet immediately once built.

- [ ] **F-33 (build item): `createProject` has no `kind` parameter or registry validation at
  all** — it's a pure name/description/agent-binding creator today. Any future kind-aware
  creation flow needs `kind` accepted at creation time (not just via PATCH after the fact), so
  the singleton check can run BEFORE a row exists rather than racing a PATCH against a
  freshly-created default-kind project.

**F-34 (build): Registry + schema.**
- New `packages/events` (or a new small package) export: `BUSINESS_FEATURE_KIND_REGISTRY`, a
  typed array of:
  ```ts
  type BusinessFeatureKind = {
    kind: string;                    // 'wallet' | 'storefront' | 'business_email' | ...
    label: string;
    description: string;
    singleton: boolean;              // DB-enforced, see below
    minCreationRole: 'owner' | 'admin' | 'editor'; // who even SEES this as a creatable template
    prebuiltScripts?: string[];      // e.g. ['wallet'] — script-engine prebuilt names gated to this kind
    uiPanel?: string;                // dashboard/shell component key, e.g. 'wallet-ledger'
  };
  ```
- Widen `projects.kind`'s CHECK constraint (currently `CHECK (kind IN ('workspace',
  'customer_bot','wallet'))`, SpaceDO.ts:709) to include the new kinds, OR (recommended,
  matches ground rule #4) drop the hardcoded CHECK and validate `kind` against the registry
  in application code only — a new kind then ships as a data change, no migration.
- New column: `projects.is_singleton_kind INTEGER NOT NULL DEFAULT 0` — stamped from the
  registry's `singleton` flag AT CREATION TIME (not re-derived on every read).
- New partial unique index (the real guarantee — D1/DO-SQLite has no `SELECT FOR UPDATE`, so
  app-level "check then insert" races exactly like F-22's payout bug):
  `CREATE UNIQUE INDEX idx_projects_singleton_kind ON projects(space_id, kind)
   WHERE is_singleton_kind = 1 AND status = 'active';`
  A second creation attempt gets a real constraint violation → translate to `409
  duplicate_singleton_project` with the existing project's id in the response body.

**F-35 (build): `createProject` + template-listing changes.**
- `createProject` accepts `kind` (default `'workspace'`, unchanged behavior for existing
  callers). Validates against the registry: unknown kind → 400; caller's space-level role
  below `minCreationRole` → 403 (checked BEFORE the singleton check, so a non-admin gets
  "not allowed" rather than leaking whether a wallet project already exists); singleton
  violation → 409 (backed by the unique index above, not just an app-level SELECT).
- Wherever project templates are surfaced for the "create project" picker (agents worker's
  `GET /project-templates`, proxied at router `api.all("/project-templates"...)` — currently
  only the customer-bot templates) — extend to also list `BUSINESS_FEATURE_KIND_REGISTRY`
  entries, FILTERED by the caller's role server-side (not just hidden in UI) so a non-admin
  member never sees "Create Wallet" as an option at all, matching the "identity vs
  authorization" split this codebase already uses everywhere else.
- Dashboard/shell "create project" UI: grey out / hide singleton kinds that already exist for
  the space (a UI nicety on top of the real 409 — never the security boundary).

**F-36 — ✅ BUILT (schema + resolution + endpoint).** SpaceDO migration v29 adds
`project_members.assistant_mode ('inherit'|'read_only'|'none')`; `addProjectMember` accepts it;
`resolveAssistantEffectiveRole` implements the invariant (effective = min(user's role,
assistant_mode clamp); 'read_only'→viewer, 'none'→null); `GET /projects/:id/assistant-access?user_id=`
exposes it (member-gated). No-acting-user (cron/trigger) resolves to null so the dispatch path
falls back to the assistant's own base grant, never this per-user clamp. Tests:
project-assistant-mode.test.ts. Remaining integration: threading the resolved value into the run
loop's project-access check is the enforcement wiring (the load-bearing resolution is built + tested).
ORIGINAL: Per-user project access, extended to that user's assistant interactions.**
- `project_members` already has `role IN ('owner','editor','viewer')` (SpaceDO.ts:623-630) —
  this is the granular per-user read/edit/admin control already asked for; it likely just
  needs a management UI panel if one doesn't exist yet (verify before building new backend).
- NEW: `ALTER TABLE project_members ADD COLUMN assistant_mode TEXT NOT NULL DEFAULT 'inherit'
  CHECK (assistant_mode IN ('inherit','read_only','none'));` — per (project, user) row.
- **Invariant (write this down before implementing, it's the whole security model):** an
  assistant acting ON BEHALF OF user U in project P can never have MORE access than U's own
  `project_members` role for P. `'inherit'` (default) = assistant's effective role equals U's
  role. `'read_only'` clamps to viewer even if U is owner/editor. `'none'` = zero access when
  acting for U, full stop — U must use the project directly, the assistant won't touch it.
- Enforcement point: wherever a run resolves "which projects can this touch" needs a concept
  of "acting-on-behalf-of user" threaded through — when the Space Assistant is invoked from
  inside a specific user's thread/message (a resolvable acting user id exists), the effective
  permission = `min(assistant's own base grant, assistant_mode-clamped U role)`. When there's
  NO acting user (scheduled job / cron / event trigger / autonomous heartbeat — no human in
  the loop for this specific run), fall back to the assistant's own base grant only (today's
  Space Assistant already has broad access by default; document this explicitly rather than
  assume it, and confirm `handleTriggerFire`/`runScheduledJobs` dispatch don't accidentally
  pick up a stale acting-user id from a prior run).

**F-37 — ✅ VERIFIED CORRECT (no fix needed).** `SpaceDO.appendMessage` already derives
author_type from the caller's verified identity: a `role:'assistant'` write with no agent_id →
`author_type='assistant', author_id='naelao-agent'`, distinct from a human's `author_type='user'`
bubble. The bare Space Assistant's replies (written by `writeConversationToSession`) hit exactly
this path, so there is no collision. (Minor residual: the user-echo write carries author_id=null
rather than the acting user's id — cosmetic, not the collision this finding warned about.)
ORIGINAL: assistant identity in threads — no user/assistant
collision.** `messages.author_type`/`author_id` (Phase O) and per-agent mention-run
attribution (Phase T2, "Agent1" vs "Agent2" render distinctly) are already built. NOT yet
confirmed: does the bare Space Assistant's OWN replies (not a project-agent's) also stamp
`author_type='assistant', author_id='naelao-agent'` distinctly from a human `author_type=
'user'` bubble, even when the assistant is "acting on behalf of" that human? Verify against
`NaelaoAgentDO`'s message-write path before assuming built; if it currently reuses the human's
own identity when posting on their behalf, that's the collision to fix.

**F-38 — ✅ VERIFIED CORRECT (no fix needed).** `exclusive_mode`/`active_thread_id` is
thread-FOCUS locking (which thread a HUMAN is actively in — a UX lock acquired via
`activate-thread`), NOT file-write locking. A cron/trigger-fired script has no focused thread, so
it correctly does not participate in thread-focus exclusivity; genuine concurrent-file-write
safety is the separate `lock` prebuilt's job (row-level, actor-agnostic, keyed by resource), which
every dispatch path can call explicitly. So the reasoning-loop bypass for cron/trigger dispatch
did NOT skip a lock it should have honored. ORIGINAL: locking is
actor-agnostic.** The `lock` prebuilt and `projects.exclusive_mode`/`active_thread_id`
(Phase T3) are keyed by resource (project/thread), not by who's acting — so an
assistant-driven script run should already respect the same `activate-thread` exclusive lock
as a human-initiated one, PROVIDED every dispatch path (normal `/agent/run`, `mention-run`,
`handleTriggerFire`, `runScheduledJobs`) actually calls through the same check. CLAUDE.md
items #15/#20 note trigger/cron dispatch deliberately BYPASSES the full reasoning loop for
efficiency — confirm that bypass didn't also skip the exclusive-mode lock check (a real
collision risk if a cron-fired script writes the same file a human has the thread locked for).

**F-39 (build): R2 workspace file viewer.**
- New routes on the spaces worker: `GET /spaces/:spaceId/projects/:projectId/workspace/files`
  (list — reuse the existing bounds from Phase K/R: 300 files/2MB per file/25MB per call) and
  `GET /spaces/:spaceId/projects/:projectId/workspace/files/*path` (read one file). Gate:
  caller needs at least `viewer` via `project_members` (or space owner/admin) — same ACL
  check as every other project-scoped end-user route (`requireBusinessMembership`-style).
  Reuse `ContainerWorkspaceGateway`/the `workspace` prebuilt's read/list logic (Phase R,
  `script-engine/types.ts`) rather than writing new R2 access code — this is an HTTP-facing
  wrapper around what the agent side already has.
- UI: ✅ BUILT — WorkspaceFilesPanel in the shell project detail page (via ProjectKindPanel): lists workspace files, .html opens in a sandboxed iframe, other text shows inline. ORIGINAL: new "Files" tab per project (dashboard product-detail view; shell business-detail
  project view). A file tree/list; clicking an `.html` file opens it in a sandboxed iframe
  preview (this is literally the "AI writes `wallet-transactions-dashboard.html`, builder
  views it" case); other types show as text or a download link.
- Router allowlist: add the new path pattern to `PRODUCT_END_USER_PATH_PATTERNS`
  (router/src/index.ts:422+) so end users (not just builders) can reach it for projects
  they're a member of — identity-only at the router, real ACL check on the spaces worker,
  same split as every other entry in that list.

**F-41 (design correction, user question 2026-07-10): not every kind on this list actually
needs to BE a project — applying a real test instead of defaulting everything to project-
shaped.** A kind belongs in the registry (own R2 workspace, own thread, own `project_members`
ACL, singleton enforcement) only if it passes at least one of:
1. **Bulky persistent content** — real files (video, evidence documents, generated dashboards)
   or a genuinely ongoing thread of discussion a human returns to, not a single request/response.
2. **Independent access control** — a business plausibly wants to grant one teammate access to
   THIS without granting the others (e.g. a bookkeeper shouldn't need storefront-edit access;
   legal docs plausibly want tighter access than general operating notes).
3. **Standing "place" semantics** — something a builder navigates TO as a destination, not a
   verb the assistant performs and reports the result of elsewhere.

If a kind is really just an action (generate a report, call an API, run a periodic check) whose
output has no independent bulk/ACL need, it's a **skill** in the assistant's script library —
invoked from whichever project/thread asked for it, writing its output into THAT project's
workspace (or into `operating_plan`'s decision log) rather than owning a workspace of its own.
Re-classifying the full list against this test:

**Downgraded from project to skill** (no bulky content of their own, no ACL need distinct from
the project that would invoke them):
- `brand_kit` → skill (`brand.generate`/`brand.update`). Output (logo/palette files) is written
  into `storefront`'s own workspace, since that's the only place it's actually rendered/used —
  no independent standing "place" a builder navigates to on its own.
- `bookkeeping` → skill (`bookkeeping.export`). Entirely derived from `wallet`'s ledger, zero
  independent state; writes an export artifact into `wallet`'s own workspace. Whoever can see
  the wallet can see the bookkeeping export — no separate ACL to enforce.
- `churn_retention` → skill (`retention.check_and_draft`), periodic/event-triggered. No bulky
  content of its own (no files, no standing discussion thread) — logs its actions into
  `operating_plan`'s decision log rather than owning a project.
- `coupons_promotions` → skill (`coupons.create`/`coupons.list`). A direct API call to the
  connected commerce platform — there's no persistent Naelao-side state to scope a project to.
- `compliance_risk_monitor` → skill, scheduled via the existing `scheduled_jobs` mechanism
  (CLAUDE.md item 20) — a periodic aggregate check, not a place. Alerts write into
  `operating_plan` when a threshold is crossed.

**Folded into an existing kind** (would have been a redundant second home for the same data):
- `social_media` → folded into `integrations_hub`. It was already spec'd as holding ONLY OAuth
  connection grants — that's exactly what `integrations_hub` is for; a second "connections"
  project was never justified once `integrations_hub` existed. Actual publishing stays a skill
  the assistant runs when `content_calendar` decides to publish.
- `customer_voice` → folded into `analytics_dashboard` as a qualitative panel alongside its
  quantitative ones, rather than a sibling cross-cutting project. Same read-across-kinds
  mechanism, same access-recheck-per-widget discipline — no reason for it to be a second
  standing "place" next to a kind that already exists for exactly this cross-cutting role.
- `incident_postmortems` → folded into `operating_plan` as a distinct, tagged ENTRY TYPE
  ("incident" vs "decision") in the same running log — a postmortem IS a decision-log entry
  with different urgency, not a functionally separate place.

**Removed from the registry entirely — not a project, not even a skill, just a UI view:**
- `handoff_escalations` — already spec'd as "no new backend," a live feed over
  `HITLApprovalDO`/`agent_activity_log` data that already exists. That means it has NEITHER an
  R2 workspace NOR its own thread NOR project-level ACL beyond "can this user see approvals,"
  which is a space-level role check, not a project membership check. It's a dashboard/shell
  page querying existing APIs directly — putting it in the project registry would have created
  fake project semantics (a workspace with nothing in it, a thread nobody writes to) around
  what is honestly just a page.

**Kept as projects, but flagged as genuinely borderline** (real judgment calls, not obvious
either way — revisit once there's actual usage data): `affiliate_program` and
`legal_compliance` (ACL argument is plausible but unconfirmed by any real usage pattern yet),
`waitlist_launch` (naturally temporary/archivable, borderline whether that's enough content to
justify standing infra vs. a skill that manages an email list), `competitor_watch` (could
arguably just be data `operating_plan` reads rather than its own ACL boundary — kept separate
because competitive intel plausibly wants narrower access than general strategy notes, but this
is a guess, not a confirmed requirement). `market_research`/`hiring_freelance` stay
non-singleton and explicitly NOT auto-provisioned/pre-selected by any template — created on
demand only when a specific effort is bulky enough (real documents, real ongoing thread) to
justify it; a quick one-off question stays a skill invocation with output posted wherever asked.

**Registry — proposed initial kinds (Naelao ships all; templates pre-select a subset):**

| kind | singleton? | notes |
|---|---|---|
**Why these stay native (each checked against the connector-operated principle above, not
assumed):** `wallet` is Naelao's actual money-custody moat — no 3rd-party platform can hold a
Launchpad business's earned-revenue balance, this is infrastructure Naelao itself provides, not
a reimplementation of anything. `business_email`/`business_phone` are Naelao PROVISIONING real
infra (a mailbox, a number) the business didn't have before — not competing with Gmail/Twilio,
using them as the underlying rail. `brand_kit`/`legal_compliance`/`bookkeeping` are generation
and read-only synthesis (logo/docs/exports), not a competing design tool, law firm, or
accounting platform. `crm`/`support_inbox` are lightweight and genuinely native ONLY because a
typical Whop-style seller has no existing CRM/helpdesk to defer to — if a business already runs
HubSpot/Zendesk, THAT should be operated via connector instead of forcing them onto Naelao's own
(flag this as a config choice per business, not hardcoded either way). `affiliate_program` is
native because it settles through Naelao's OWN wallet/reseller_ledger — the payout mechanism
itself has no 3rd-party equivalent to defer to. `social_media` deliberately holds ONLY the OAuth
connections, never publishes on its own — it's the connector-operated pattern's own credential
surface for that domain, same role `integrations_hub` plays platform-wide.

| `wallet` | yes | ALREADY BUILT feature-wise; needs F-32/F-34's DB enforcement |
| `storefront` | yes, **conditionally native — reconciled with the connector-operated
  principle** | remodel of `business_services`/`launchpad_products`/`launchpad_orders` (today
  NOT project-scoped — add a `project_id` column rather than migrating the model). **This is
  ONLY the right default for a business with no existing commerce platform** (the `micro-saas`/
  `creator-store` coming-soon templates selling direct through Naelao's own Lemon Squeezy
  checkout — there IS no 3rd party to defer to). For `whop-seller` specifically, Whop already
  has its own storefront/checkout — the assistant should operate THAT via `mcp-connector`
  (connector-operated), never stand up a competing Naelao storefront selling the same product
  twice. The registry's per-template pre-selection (not a global default) decides which mode a
  given business gets; a business can't run both for the same catalog. **Naming
  disambiguation:** spec §48's "NaelaoProduct" (CLAUDE.md item 30) = a Tier-1 builder's deployed
  SPACE (LexSpace/CodePilot/FirmAI), resolved by `GET /v1/products/by-slug/:slug`.
  `launchpad_products` here = a Tier-2 end-user BUSINESS's own storefront catalog item (a
  course/ebook it sells to ITS customers) — unrelated layers sharing the word "product." |
| `business_email` | yes | already partial (business_services kind='business_email');
  extend with an AI-triaged shared inbox as the project's thread surface |
| `business_phone` | yes | new — Twilio-style number wired into the existing channel
  gateway (`workers/agents` channel ingress pattern already established for WhatsApp/Discord) |
| ~~`brand_kit`~~ | **downgraded to skill, see F-41** | not a project — see F-41 |
| ~~`bookkeeping`~~ | **downgraded to skill, see F-41** | not a project — see F-41 |
| `affiliate_program` | yes | referral links + payout via existing wallet/reseller_ledger |
| `crm` | yes | contacts/notes/deal pipeline — native default; if the business already runs an
  external CRM, this SHOULD become connector-operated instead (config choice, not hardcoded) |
| `support_inbox` | yes | ticket queue with SLAs — same caveat as `crm`: native default,
  connector-operated if the business already runs Zendesk/Intercom/etc |
| ~~`social_media`~~ | **folded into `integrations_hub`, see F-41** | not a separate project — see F-41 |
| `legal_compliance` | yes | auto-generated ToS/Privacy/Refund + e-sign vault |
| `analytics_dashboard` | yes | **deliberately cross-cutting**, not a peer of the other kinds
  — its own workspace/thread, but its prebuilt script surface reads ACROSS `wallet` (ledger),
  `storefront` (orders/products), and `crm` (contacts/deals) rather than owning its own data.
  Access model: creating/viewing a dashboard project requires at least `viewer` on EACH
  source kind it reads from (checked per-widget at generation/refresh time, not just once at
  creation — a widget pulling wallet data must re-verify wallet access on every refresh, since
  a user's `project_members` role on wallet can change after the dashboard project exists).
  If a source kind doesn't exist yet in the space (e.g. no `crm` project), that panel is
  omitted, not errored. |
| `hiring_freelance` | **no** | a business may run several hiring efforts concurrently |
| `market_research` | **no** | ad hoc, no reason to cap |

**CORRECTION (user, 2026-07-10): Naelao is not trying to BE Whop, Shopify, Teachable, or any
platform a Launchpad business is already built on — it operates them autonomously (the Polsia
comparison). The batch of kinds below (previous revision of this doc) was spec'd wrong: it had
Naelao OWNING native membership-gating, course-hosting, license-key generation, and coupon math
— i.e. quietly rebuilding the exact platforms the business already runs on. Re-spec'd as
CONNECTOR-OPERATED: the kind is the assistant's dedicated project (workspace + thread + a
prebuilt script surface that is exclusively `mcp-connector` calls into the business's OWN
Whop/Shopify/Teachable/Discord/ad-platform/payment-processor account) — Naelao stores no
parallel copy of that platform's data as source of truth, ever. This is not a new pattern to
invent — it's exactly what CLAUDE.md item 8 already establishes ("MCP is the mcp-connector
prebuilt script... every capability is a script in a library... nothing else is hardcoded") and
what `whop-seller` already does correctly for support/content today; the gap was never "Naelao
needs its own membership system," it was "no connector-operated kind exists yet for the
functions whop-seller doesn't touch (memberships/courses/coupons/disputes/etc)." A `kind`'s
`connectorOperated: true` flag on the registry entry means: (a) its prebuilt script surface has
NO local write path that becomes a second source of truth for that domain — every mutation is a
live `mcp-connector` call; (b) the project's workspace/R2 is for the ASSISTANT's own working
notes/drafts/logs about that domain, never a cache pretending to be authoritative; (c) if the
business hasn't connected the relevant platform (no Whop credential, no Shopify credential), the
kind's panel says so and the assistant can't act in that domain — never silently falls back to a
native reimplementation.

| `membership_access` | yes, connector-operated | the assistant operates the tier/access-gating
  that ALREADY lives on the business's connected platform (Whop memberships, Discord/Telegram
  role sync via THEIR APIs) via `mcp-connector` — who's revoked on churn, who's promoted on
  upgrade — Naelao never becomes a second gate the real one can drift out of sync with. |
| `courses` | yes, connector-operated | the assistant manages content on whatever LMS the
  business already runs (Whop Courses, Teachable, Kajabi, Skool) via that platform's API —
  publishing drip schedules, reading completion data — not a Naelao-hosted LMS. |
| ~~`churn_retention`~~ | **downgraded to skill, see F-41** | not a project — see F-41 |
| ~~`coupons_promotions`~~ | **downgraded to skill, see F-41** | not a project — see F-41 |
| `ad_campaigns` | yes, connector-operated | the assistant operates the business's OWN Meta/
  TikTok/Google Ads accounts via their APIs — campaign creation, budget decisions, pausing
  underperformers. Naelao is not an ad platform; `analytics_dashboard` may read spend data back
  out of this kind's action log, never duplicate ad-serving. |
| `live_events` | yes, connector-operated | the assistant operates the business's existing
  Zoom/Calendly/Google Meet account via API for scheduling — Naelao is not a video platform. |
| `disputes_chargebacks` | yes, connector-operated | the assistant drafts responses and submits
  evidence through the ACTUAL payment processor's dispute API (Whop/Stripe/LS each have one) —
  ties to F-18's exposure as where that gets handled operationally, still never a parallel
  Naelao-owned dispute system. |
| `waitlist_launch` | yes, **native (no existing 3rd-party home)** | most connected platforms
  have no "pre-launch waitlist" primitive at all — this is legitimately Naelao's own light
  email-capture + drip sequence (built on the business's own auto-provisioned business_email),
  not competing with anything the business is already running. |
| `content_calendar` | yes, **native (planning only, publishes through a connector)** | the
  PLANNING layer (drafts, approval queue, what/when) — genuinely Naelao's own since no
  connected platform owns "my content plan" as a concept — but it never posts directly; it
  hands off to `social_media`'s connected accounts (or a per-platform `mcp-connector` call) to
  actually publish. Keep as native, but the boundary matters: this kind owns the PLAN, never
  the published post itself. |
| `license_delivery` | **re-scoped, not a default kind** | most Whop-style sellers' license/
  delivery need is already solved by whichever platform they sell through (Whop's own digital
  delivery, or Lemon Squeezy's file-attachment on a product). Only relevant for a business with
  NO existing commerce platform at all (the `micro-saas` template selling direct via Naelao's
  own storefront) — in that narrow case it's a feature WITHIN `storefront`'s own tool surface
  (extend the storefront prebuilt), not a standalone kind. Removed from the default registry. |

**Two genuinely NEW native kinds — the actual "Polsia-style autonomous operator" layer, not
platform reimplementation:**

| `integrations_hub` | yes, **native** | the control panel for every 3rd-party connection a
  business runs on (Whop, Shopify, Discord, Meta Ads, Zoom, payment processor) — which
  platforms are connected, credential health/expiry, which connector-operated kinds are
  therefore "live" vs. greyed-out. This is the single place a builder sees "here's what my
  autonomous assistant can actually touch right now." Backed by the existing credential
  hierarchy (`workers/credentials`, CLAUDE.md item 18) — this kind is a UI/read surface over
  that, not a new credential store. |
| `operating_plan` | yes, **native** | the assistant's OWN strategic memory: current goals,
  active initiatives, a running decision log ("raised prices 10% on 2026-07-01 because X") —
  this has no 3rd-party home by definition, it's the thing that makes the assistant look like
  it's actually RUNNING the business rather than just executing isolated tasks. Directly
  reinforces the differentiator CLAUDE.md item 41 already stakes out against Polsia's black-box
  autonomy ("honest escalation/transparency as the differentiator") — `agent_activity_log`
  (already built, item 40) is the raw action feed; this kind is the assistant's own narrated
  reasoning ABOVE that feed, builder-readable, not just an audit trail. |

**A third batch — more of the genuinely native "autonomous operator" kinds (2026-07-10 follow-up).
Test applied to each: does this have a 3rd-party home we should defer to via connector? If NO,
and it's specifically about the assistant DOING the running (not just data storage), it belongs
here. Several of these are the concrete UI-level implementation of gaps this audit already
flagged as backend-only/no-surface — cited explicitly, not duplicated.**

| `onboarding_flight_plan` | yes, **native, auto-created** | the CONCRETE fix for the already-
  known **F-10 gap** ("No first-run/onboarding flow for a new product" — currently just a bullet
  with no design). This kind IS the design: auto-created as the FIRST project in every new
  business, its thread is where the assistant interviews the builder (what does the business
  sell, which platforms is it already on, which other kinds to provision) and then actually
  creates the resulting `integrations_hub` connections and kind selections itself, live, in
  front of the builder — this is the actual "time-to-first-value" moment competing directly
  against Polsia's onboarding. Auto-archives (not deleted — stays as a historical record of
  day-one decisions) once the builder marks setup complete; never re-created. |
| `competitor_watch` | yes, **native** | PERSISTENT competitive monitoring (pricing changes,
  feature launches, review-volume shifts for named competitors) feeding `operating_plan`'s
  decision log — distinct from `market_research` (ad hoc, non-singleton, one-off investigations)
  by being an ongoing watch list with history, not a single report. Uses `web-search`/MCP to
  gather data but the tracked-list + timeline + alert history is Naelao's own, native. |
| `experiments_growth` | yes, **native** | structured hypothesis → test → result → decision
  tracking for pricing tests, offer tests, channel tests — the actual "the AI runs experiments
  and learns" capability that separates an autonomous operator from a task-executor. Distinct
  from `operating_plan` (which records decisions already made) — this kind is what PRODUCES
  the evidence behind a future `operating_plan` entry. An experiment's actual execution usually
  routes through a connector-operated kind (e.g. a pricing test touches `storefront` or
  `membership_access`); this kind owns only the experiment's design/tracking/conclusion. |
| ~~`customer_voice`~~ | **folded into `analytics_dashboard`, see F-41** | qualitative panel,
  not a separate project — see F-41 |
| ~~`incident_postmortems`~~ | **folded into `operating_plan`, see F-41** | tagged entry type,
  not a separate project — see F-41 |
| ~~`handoff_escalations`~~ | **removed — it's a UI page, not a project, see F-41** | see F-41 |
| ~~`compliance_risk_monitor`~~ | **downgraded to scheduled skill, see F-41** | not a project —
  see F-41 |

| `workspace` | **no** | today's default, unchanged |
| `customer_bot` | **no** | already exists, unchanged |

Spend card / revenue-based financing / KYB-gated payouts are NOT separate kinds — they're
features WITHIN the `wallet` project's own tool surface (extend `wallet.ts`), since they
operate on the same balance and ledger, not a separate workspace/thread context.

**F-40 — ✅ PATTERN BUILT + first panels shipped.** listProjects now surfaces `kind`; new apps/shell ProjectKindPanel is the mount-point SWITCH the finding calls for (`{project.kind === "wallet" && <WalletLedgerPanel/>}` — purpose-built, not a data-driven interchangeable lookup), wired into the shell project detail page above the shared shell. Shipped panels: WalletLedgerPanel (bank-ledger look, reuses getBusinessWallet) and the F-39 WorkspaceFilesPanel (lists R2 artifacts; .html previews in a sandboxed iframe). Additional kind panels (storefront/crm/...) mount at the documented switch point one at a time — the expected incremental path. ORIGINAL: every kind's UI is the general workspace project SHELL (identical for
every kind) plus a NATIVELY hand-built kind-specific panel — not a generic registry-driven
component lookup.** Correction from the user (2026-07-10): do NOT resolve `uiPanel` through a
generic `kind -> component` map treated as interchangeable/data-driven. The shared shell
(chat/thread/file-viewer from F-39, project header, member/access management) is genuinely
identical scaffolding reused by every kind — that part stays one component. But each kind's
EXTRA panel is real, purpose-built frontend code written one kind at a time, not templated
output: `WalletLedgerPanel`, `StorefrontCatalogPanel`, `CrmPipelinePanel`, etc. are each their
own component with their own layout, own data-fetching, own visual identity — wallet should
look and feel like a bank-account ledger, storefront should look like a product/orders admin,
CRM should look like a pipeline board. The registry's `uiPanel` field is still useful as a
STRING KEY so the frontend's project-page shell knows WHICH natively-built panel to mount for
a given `project.kind` (a simple switch/lookup at the mount point, e.g.
`{project.kind === 'wallet' && <WalletLedgerPanel .../>}` per kind, not a lookup table that
implies the panels are structurally interchangeable) — but the panel implementations
themselves are NOT generated or genericized from the registry data; each is built and
maintained as its own real component. A kind with no built panel yet (e.g. `market_research`
before its panel exists) simply renders the shared shell alone until one is built — this is
the expected incremental-build path, not a fallback state to design around.

## Tier 2 — Serious

- [x] **F-4: Stream-ticket security fix is dead code; raw `nps_` tokens still land in URLs/logs.**
  **⚠ WAS CHECKED BUT ISSUE ENDPOINT WAS MISSING — NOW GENUINELY FIXED:** the shell POSTs
  `/spaces/:spaceId/sessions/stream-ticket` but no route existed (only `/internal/stream-tickets/
  issue`, platform-secret-gated). Added a public branch in the sessions handler that, after the
  router-verified identity + business-membership checks, mints a 60s single-use ticket into KV
  (same key format `/internal/stream-tickets/consume` already reads). The router's consume side
  and the allowlist pattern already existed. ORIGINAL:
  Evidence: shell (api.ts:212) POSTs `/v1/spaces/:spaceId/sessions/stream-ticket` → no 
  router route exists for this (verified by grep), so call 404s → shell falls back to 
  token-in-URL. **VERIFIED REAL** — only `POST /internal/stream-tickets/issue` exists 
  (spaces:2500), requires `x-naelao-platform-secret`. Shell can never call it. Result: 
  60s-validity stream tickets are never issued, end-user chat always uses raw `nps_` 
  session tokens in URL params (logged, cached). Blocks shell's secure operation. Fix: 
  public `POST /spaces/:spaceId/sessions/stream-ticket` on spaces worker (before sessions 
  catch-all), authenticated by verified caller identity, calling issue logic (only takes 
  60s token + single-use burn, never logs it).

- [x] **F-18 (money/legal): Deleting a product strands live paying subscribers.** Evidence: 
  `DELETE /builder/products/:id` (builder-routes.ts:481-490) only sets `status='deleted'` 
  (verified: line 487). **VERIFIED REAL**. Scenario: 5 customers subscribed to a plan on 
  the product; builder deletes it → end users locked out (by-slug requires active, product-
  session verify excludes deleted) WHILE LS keeps charging them monthly. End users cannot 
  cancel, builder can't see the subscriptions to refund, chargeback/legal exposure day one. 
  Fix: on delete/suspend, enum child businesses' `business_subscriptions`, call LS cancel 
  API for each (best-effort + retry), notify end users (if notification flow exists), 
  block deletion OR typed-confirm when active subscriptions exist (show count).

- [x] **F-5: `/billing/*` also unrouted (dead code today, loaded footgun).** RESOLVED WITH F-2: the BILLING_WORKER binding now exists; the `/webhooks/lemon-squeezy` route is the money-in path. The dashboard `/billing/checkout`/`/billing/subscription` calls are still not wired to a router route (no page uses them yet), left as a documented follow-up rather than adding an unused proxy. ORIGINAL:
  Evidence: dashboard `api.ts:461/473` define `/billing/checkout` + `/billing/subscription`;
  billing worker implements them (`workers/billing/src/index.ts:141/203/285`); no page
  calls them yet and the router can't reach billing anyway. Fix rides with F-2's binding.

## Tier 3 — Revenue integrity

- [x] **F-23 (revenue): Subscription gate never reads `current_period_end` — access 
  persists indefinitely after expiry.** Evidence: `resolveBusinessSubscriptionGate` 
  (spaces/index.ts:2196-2203) reads ONLY `status` column, ignores `current_period_end` 
  (which webhooks faithfully populate at line 283). **VERIFIED REAL** — gate checks only 
  status, never time. Two failure modes: (a) if LS webhook outage, status stays 'active' 
  forever with no self-healing; (b) `past_due` treated as active indefinitely (comment 
  says "grace period" but nothing bounds it — business whose card fails permanently runs 
  free until they manually cancel). Fix: gate must check `current_period_end + 3-day grace 
  IN FUTURE`, treat expired periods as inactive regardless of stored status.

- [x] **F-24 (correctness): Out-of-order LS webhooks can brick a resubscribed business.**
  Evidence: `recordBusinessSubscription` (lemon-squeezy.ts:273-289) upserts 
  `ON CONFLICT(business_space_id)` UNCONDITIONALLY. **VERIFIED REAL** — lines 277-287 
  have no check that the webhook's `ls_subscription_id` matches the existing row's ID. 
  Scenario: A=old sub, B=new sub, business cancels A and subscribes to B → if A's 
  terminal `subscription.cancelled` webhook arrives AFTER B's `subscription.created`, 
  the upsert overwrites B's row with A's cancelled status → gate 402s while business 
  is actually paying. Fix: on status-downgrade events (cancelled/expired/paused), ONLY 
  apply if webhook's `subscriptionId` matches stored `ls_subscription_id` (prevent 
  old-sub terminal events from overwriting new subs); creations/upgrades keep unconditional 
  upsert.

- [x] **F-25 (double billing): No guard against subscribing already-subscribed business — 
  plan switching double-charges.** Evidence: `POST /internal/business-subscriptions/
  checkout` (billing/index.ts:600-656) NEVER queries `business_subscriptions` before 
  creating a checkout; missing entirely from the function. **VERIFIED REAL**. Scenario: 
  business is subscribed to Plan A, clicks "Subscribe to Plan B" → checkout created, LS 
  creates a SECOND subscription → now TWO live subscriptions both invoicing monthly. Naelao 
  DB shows only one (upsert keyed on business_space_id), but LS charges customer twice. 
  Compounded by F-24: the two subscriptions' events overwrite each other. No duplicate 
  check in UI either. Fix: route must 409 when active/past_due row exists (response includes 
  current plan); plan switching requires cancelling old sub first via LS API (or use LS's 
  variant-change endpoint for proration).

- [x] **F-22 (race): `POST /builder/payouts/request` is read-then-insert — concurrent requests 
  can each create payout for FULL balance.** Evidence: builder-routes.ts:853-884 calls 
  `computeAvailableBalances` (SELECT), checks if > 0, then INSERT with no uniqueness. 
  **VERIFIED REAL**. Scenario: builder has $100 balance; two concurrent requests both read 
  $100, both INSERT payout_requests rows for $100 → admin fulfilling both pays $200 from 
  Naelao account. No atomic check-and-insert. Manual fulfillment (human-reviewed) is only 
  backstop. Fix: partial unique index `payout_requests(tenant_id, currency) WHERE status=
  'pending'` — D1 doesn't support SELECT FOR UPDATE, so index forces 409 on conflict; 
  one open request per currency per tenant.

- [x] **F-7: FIXED at HEAD (verified, do not re-report)** — `NaelaoAgentDO.
  checkBusinessSubscriptionGate` (agents/do/NaelaoAgentDO.ts:1960) now reads
  `business_subscriptions` before every run and fails CLOSED.
- [x] **F-8: FIXED at HEAD (verified, do not re-report)** — `POST /internal/product-users/
  :spaceId/:endUserId/credits/refresh-monthly` (spaces index.ts:2326) exists and the agents
  worker calls it in the pre-run gate before reading the balance.

- [x] **F-19 (abuse/DoS): Unbounded business creation per end user.** NOW ACTUALLY BUILT (was checked optimistically): `createBusinessForEndUser` rejects with 429 once `productConfig.maxBusinessesPerEndUser` (default 10) is reached; test in `business-create.test.ts`. Evidence: 
  `createBusinessForEndUser` (business-create.ts:103+) does `INSERT INTO spaces` directly 
  and NEVER calls `enforceSpaceQuota` (verified by grep). **VERIFIED REAL**. Attack: one 
  verified email signs up (free tier), then loops `POST /spaces/:productSpaceId/businesses` 
  → each creates a new space with full provisioning (SpaceDO init, agent installs, R2 
  writes, wallet seed) → resource exhaustion. Rate limiter only slows, never bounds. Fix: 
  call `enforceSpaceQuota(childTenantId)` (free-tier cap ~50 spaces applies automatically) 
  and/or add `productConfig.maxBusinessesPerEndUser`.

- [x] **F-26 (severe overbilling): FIXED — fetchWhopRevenueThisPeriod now computes the period's [start,end) bounds, requests a server-side created-at range, and (authoritatively) filters each payment client-side by its parsed paid/created timestamp, so a monthly snapshot is that month's revenue, not all-time. Payments with no parseable timestamp are skipped (conservative). Tests added in revenue-tracker-prebuilt.test.ts. ORIGINAL: the revenue-tracker's Whop pull ignores the `period` it
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

- [x] **F-27 (double billing) — FIXED (delta billing).** SpaceDO migration v30 adds
  `external_revenue_snapshots.billed_cents` (cumulative cut actually charged per period).
  `recordExternalRevenue` NO LONGER reverts billed→0 on a correction — billed_cents persists, and
  the surcharge checkout now bills only `max(0, cut(revenue) − billed_cents)` per period (correcting
  100k→120k bills the 20k×cut delta, not 120k×cut on top of the 5k already collected).
  `mark-billed` accumulates billed_cents from the per-period `charges` (carried in LS metadata as
  `period_charges`); a refund (`unmark-billed`) reverses exactly that charge. Snapshot history is
  already builder-visible via `GET /revenue-tracking` (the audit's auditability half). Tests:
  external-revenue-tracking.test.ts + revenue-cut-surcharge.test.ts. **Not built (smaller
  follow-up):** proactively flagging a business holding a whop credential with no recent snapshot
  — a monitoring feature, not part of the double-billing correctness fix. ORIGINAL: re-tracking an already-billed period reverts it to
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

- [x] **F-28 (double-dip, F-21 instance worth its own line): the revenue-cut surcharge
  payment itself flows through reseller attribution.** FIXED: `RESELLER_ATTRIBUTION_BLOCKED_KINDS`
  in `billing/lemon-squeezy.ts` now excludes `revenue_cut_surcharge` (plus the ARCH-REVENUE-7
  money-leak kinds) from `recordResellerAttribution`, gated on the checkout `kind` before any
  attribution work. Test: `billing-refund-clawback.test.ts` proves a wallet_topup under a
  referral reseller accrues zero margin.
  Evidence: tests/unit/revenue-cut-surcharge.test.ts:9-11's own comment —
  "recordResellerAttribution is unconditional for every payment.success — no new code
  needed there." The surcharge IS the mechanism collecting Naelao's/the builder's cut of
  external revenue; running it through `recordResellerAttribution` too means a
  referral-mode builder accrues `referralSharePct` margin ON the cut collection — paid
  twice for the same revenue (and in reseller mode Naelao books wholesale against its own
  fee). Fix: same allowlist as F-21 — exclude `kind='revenue_cut_surcharge'` from reseller
  attribution.

- [x] **F-29 (monetary loss): refund clawback only exists for storefront product orders —
  a refunded wallet top-up leaves the full spendable credit in the wallet.** FIXED:
  `recordNonOrderRefundClawback` (`billing/lemon-squeezy.ts`) routes a `refund.issued` by the
  original checkout `kind` — wallet_topup → wallet debit (`refund_clawback`), credit_pack →
  new `/internal/credit-packs/clawback` (ProductUserDO `/credits/clawback`, allows negative
  balance since the money was refunded), revenue_cut_surcharge → new
  `/revenue-tracking/unmark-billed` (SpaceDO `markRevenueUnbilled`). Each keyed on
  `refund:{providerEventId}` for idempotency. Tests in `billing-refund-clawback.test.ts`.
  **Still open (noted, not fixed here):** a refunded SEAT purchase claws back the wallet
  settlement but doesn't deactivate the seat member — tracked separately.
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

- [x] **F-30 (paying customer gets nothing): credit-pack / wallet-top-up idempotency keys
  are derived from purchase ATTRIBUTES, so two identical legitimate purchases collide and
  the second grant is silently dropped.** FIXED: both `grantCreditPackPurchase` and
  `grantWalletTopupPurchase` now key on `event.providerEventId` first (the LS order id —
  unique per real purchase, stable across webhook retries), falling back to the synthetic key
  only when no provider id exists.
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

- [x] **F-31 (race) — FIXED.** SpaceDO migration v30 adds
  `external_revenue_snapshots.pending_checkout_at`. The checkout stamps it (via the new
  `POST /revenue-tracking/mark-pending`) right after minting a URL, and its own billable filter
  skips any period with a pending_checkout_at within 24h — so two checkouts minted before either is
  paid don't both bill the same periods. Cleared on pay (`mark-billed`) or refund; a stale pending
  (>24h) is treated as abandoned and re-billable. Tests: revenue-cut-surcharge.test.ts (F-31 skip)
  + external-revenue-tracking.test.ts (stamp/clear). ORIGINAL: two surcharge checkouts issued before either is paid both bill
  the same periods.**
  Evidence: `POST /internal/revenue-cut-surcharge/checkout` computes from `billed=0`
  periods; `billed` only flips on the payment webhook. Two checkout URLs minted for the
  same periods (retry, double-click, assistant re-run) are BOTH payable — the business
  pays the cut twice. Low likelihood (assistant-driven flow), but the fix is one column:
  `pending_checkout_at` on the snapshot row, skipped for ~24h (or the F-25 fix's 409
  shape while one is outstanding).

## Tier 4 — Operate & retain (known-open, re-confirmed)

- [x] **F-9: builder UI for `agent_activity_log`** — VERIFIED BUILT: a complete 111-line ProductActivityPage (dashboard Activity tab) renders GET /spaces/:spaceId/agent-activity with per-event-type styling (run completed/failed, approval requested/resolved, moderation blocked), timestamps, and cost. Wired in the product tabs nav.
- [x] **F-10: first-run onboarding flow** — BUILT: OnboardingChecklist component on the product overview page derives setup steps from the product's own config (name, custom domain, pricing, legal links, launch/active), shows a progress bar + deep-linked next actions, and self-dismisses once every step is complete. Verified via next build.
- [x] **F-11: GDPR erasure for end users** — VERIFIED ALREADY BUILT: DELETE /spaces/:spaceId/product-users/me erases ProductUserDO session/conversation/preference state and anonymizes the D1 roster PII; router allowlist pattern makes it end-user-reachable. (export exists, deletion now does too).
- [x] **F-12: cross-provider LLM failover** — BUILT: ai-client.ts now emits an ORDERED
  multi-entry providers array (buildProviderEntry extracted; buildUniversalBody takes a fallbacks
  chain, deduped by model), so the CF AI Gateway Universal Endpoint tries the primary then each
  fallback until one succeeds — real cross-provider failover, not just cross-request retry.
  GatewayReasoner threads a fallbacks chain; NaelaoAgentDO.resolveFailoverChain builds it from
  secrets (a cheaper Anthropic model on the SAME key by default = zero-config within-provider
  failover; OpenAI when OPENAI_API_KEY+OPENAI_FALLBACK_MODEL are set = cross-provider). All
  optional; absent → single-provider unchanged. Tests in gateway-reasoner-failover.test.ts.

- [x] **F-3d: Prebuilt business-scaling skills library.** BUILT: workers/agents/src/launchpad/scaling-skills.ts ships all 6 skills (scaling-zero-to-ten-k, storefront-setup, pricing-optimization, brand-identity, sales-outreach, customer-retention) as real Tier-2 orchestration scripts (export async function run), well-tagged so script.find retrieves them (degrades to tag/text scan pre-embedding; auto-embeds at create when an embedder is wired). seedScalingSkills() (idempotent, best-effort) seeds them into each space at provision time (installLaunchpadAgents); the Launchpad assistant profile references them. Tests: scaling-skills.test.ts. ORIGINAL: "Builders should be able to tell their AI assistant 'scale the business from $0 to $10k MRR' or 'optimize pricing' or 'build a brand identity' and the AI executes it." Currently there are zero pre-built skills — every builder starts from scratch. Fix: ship 4-6 prebuilt agent-authored skills in the skill library (accessible via `script.find` and auto-loaded into Launchpad's Space Assistant profile):
  - `scaling-zero-to-ten-k` — incremental steps: product-market fit → repeat sales → scaling channels → team handoff
  - `storefront-setup` — configure product catalog, pricing tiers, upsell bundles using LS/Whop APIs
  - `pricing-optimization` — analyze revenue + competitor research (via MCP), recommend price changes
  - `brand-identity` — discover current brand gaps, recommend logo/copy/positioning, source freelancers
  - `sales-outreach` — cold email campaigns via MCP email service, A/B testing harness
  - `customer-retention` — churn analysis, win-back campaigns, loyalty program setup
  
  Each skill: documented in Markdown, versioned in R2 (`spaces/{spaceId}/scripts/{name}/SCRIPT.md`), embeddings in Vectorize for discovery. Agent wires them into its business methodology based on business model (whop-seller, SaaS, agency, etc.). These are not hardcoded — they're ordinary scripts that showcase the platform's capability. Can be forked by builders and customized.

- [x] **F-15: Business invites never email the invitee.** FIXED: the invite route now sends a best-effort `/internal/notify` email (via NOTIFICATIONS_WORKER) with a clickable accept link when PRODUCT_SHELL_URL + product slug are available (falls back to token-only text otherwise), mirroring the product-end-user email helper. ORIGINAL: `workers/spaces/src/
  business-routes.ts:147-165` stores the invitee's email + hashed token but sends nothing
  (no NOTIFICATIONS_WORKER call). The shell surfaces a copyable link
  (`spaces/[businessId]/page.tsx:496`), so invites work by manual paste — "invite by
  email" collects an address it never uses. Fix: best-effort `/internal/notify` email with
  the accept link, same pattern as verification emails.

## Polish

- [x] **F-6: CORS responses lack `Vary: Origin`** (`workers/router/src/index.ts:200`) —
  a shared cache could serve one origin's ACAO to another. One-liner.

- [x] **F-20 (polish): No global uniqueness on `business_services.custom_domain`.** 
  Evidence: migration 0056 creates plain (non-UNIQUE) INDEX on custom_domain; domain-set 
  paths only `ON CONFLICT(space_id, kind)` — per-space, not global. **VERIFIED REAL**. 
  Two different spaces can each hold `pending_dns` for same domain. Not a takeover (CORS 
  trusts only status='active', which requires CF-for-SaaS DCV proof of ownership), just 
  confusion/squatting. Loser's row sits pending forever. Fix: pre-insert check for existing 
  active row → 409, OR partial UNIQUE index WHERE status='active'.

- [x] **F-16: Deploy workflows swallow failures.** `deploy-staging.yml:43` has `|| true`
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
  - **Shell** `NEXT_PUBLIC_API_URL=https://your-domain.com` (omits `/v1`; shell's `api.ts` includes it in paths). Different values for same var name; copy-paste between projects breaks one. Dashboard and shell also fall back to `http://localhost:8787` when unset; verify all deployed build variables are nonempty and project-specific, or make builds fail when these values are missing.
  - **Dashboard product links** `NEXT_PUBLIC_SHELL_URL` is read by the URL helper but is not wired in the checked-in staging/production workflows. Without it, both deployments use the production shell Pages origin; confirm each environment's intended shell host and pass its HTTPS origin to the dashboard build.

- [ ] Replace every `REPLACE_WITH_*_ID` placeholder in wrangler.tomls (D1/KV ids).
- [ ] `PRODUCT_SUBDOMAIN_APEX` matches the real production apex (e.g., `naelao.com` → `*.naelao.com` subdomains).
- [ ] Verify `NAELAO_REVENUE_SHARE` is set in agents/spaces workers (the percentage cut F-WALLET deducts; e.g., 0.15 for 15%).

## Tier 4 — Provisioning & Startup

- [x] **F-47/F-50 RESOLVED: within a single DO the dedup SELECT and the INSERT run with no `await` between them and a DO handles one request to completion, so the TOCTOU cannot actually interleave; added a defensive duplicate-key catch on /credits/deduct that returns the already-recorded balance (defense-in-depth). F-47 (billing, race condition): Credit deduction idempotency check is racy — 
  concurrent requests with the same idempotency_key can both pass the dedup check.** Evidence: 
  `ProductUserDO.handle` (workers/spaces/src/do/ProductUserDO.ts:243-260) for `/credits/deduct` 
  route: (1) SELECT idempotency_key from credit_ledger (line 244-246); (2) if found, return 
  existing balance (line 247-249); (3) if not found, check balance (line 252-254) then INSERT 
  new row (line 257-260). **VERIFIED RACE**: two concurrent `/credits/deduct` requests with 
  the same `idempotency_key` and the same `credits` amount can both:
  - Pass the SELECT (line 245, result empty on first check by both)
  - Both check balance and find 1000 credits
  - Both compute new balance = 1000 - 100 = 900
  - Both INSERT with the same idempotency_key
  - Second INSERT fails with UNIQUE constraint, but the damage is already done (debited twice in 
    the logic, even though only one row exists)
  Actually wait, let me re-examine: if the UNIQUE constraint on idempotency_key is enforced at 
  the DB level, only ONE INSERT succeeds. But I need to verify whether the DO-SQLite actually 
  enforces uniqueness and what error is returned. Test FIRST before fixing — if the constraint 
  properly enforces it, a second INSERT on same key fails and we can use that. Fix: use a 
  `INSERT OR IGNORE` + a follow-up query to fetch the row that exists (either the new one just 
  inserted or the one that was already there from the race), then return that balance (same 
  logic as /credits/grant already uses for idempotency). OR restructure to SELECT FOR UPDATE 
  (not available in DO-SQLite) — the ignore+retry is simpler.

- [x] **F-42 (correctness, HIGH PRIORITY): FIXED — step 10 (flip 'active') now throws → rollback when the essential owner-member seed (userId present) or wallet seed (scriptAgentsEnabled) fails, never activating a broken/owner-less/payer-less space. Provisioner's setup steps are "best-effort" but 
  several are essential for a space to function.** Evidence: lines 540-543 
  (`seedOwnerMember`), 597-600 (`seedWallet`), 484-504 (SpaceDO init hook) all log warnings 
  and continue if they fail. **VERIFIED HIGH-RISK**: a space can be marked `active` even if 
  its owner was never registered, its wallet was never created, or its type-specific init 
  never ran. For Launchpad, the wallet is essential (all project runs need a payer); the 
  owner member is essential (no way to manage the space). If these fail silently, a builder 
  gets a broken product. Fix: gate step 10 (flip to 'active') on step 5c (owner_member) and 
  step 9a (wallet) being completed successfully — if either fails, throw and trigger rollback, 
  don't mark active. The init hook can remain best-effort (type-specific, not all types need 
  it) but must be awaited BEFORE rollback can skip it, so we know whether it ran or not.

- [x] **F-43 (concurrency, MEDIUM): The retried-provision path is idempotent (stable `starter:{spaceId}` key + wallet/credit endpoint dedup, proven by the F-46 test). Residual two-distinct-spaces D1-eventual race is a bounded rare $10. Race in first-space credit grant — concurrent 
  `provisionSpace` messages can both grant starter credits.** Evidence: `seedWallet` 
  (lines 392-437) calls `isUsersFirstSpace` (lines 380-390) to check if this is the user's 
  first space before granting `WALLET_STARTER_BALANCE_CENTS`. **VERIFIED RACE**: if the 
  same user's space-creation trigger enqueues TWO `ProvisionMessage`s (e.g., network retry, 
  or race in the web request handler), both messages can be processed concurrently by the 
  provisioner. Both call `isUsersFirstSpace` at nearly the same time, both see 0 existing 
  spaces (the new space isn't yet visible to other concurrent queries in D1), both grant 
  $10 starter credits. The space record itself is only created once (INSERT with ON CONFLICT 
  on the space_id), but the TWO provisioner runs both credit the wallet, double-granting. 
  Fix: the idempotency key for the credit grant (`starter:${spaceId}`) is already correct 
  — make the idempotency work by ensuring the wallet endpoint STRICTLY implements idempotency 
  (test explicitly: re-sending the same POST with same idempotency_key returns 200/same 
  balance, not 200/+$10). Alternatively, gate the grant on the space being newly created 
  (check `created_at` timestamp vs. provisionMessage.requestedAt window, or require a 
  unique "grant applied" flag in config_json).

- [ ] **F-44 (correctness): Project creation in provisioner lacks singleton enforcement 
  for wallet.** Evidence: step 9a (`seedWallet`, lines 392-437) creates a project with 
  `POST /spaces/:spaceId/projects { name: "Wallet" }`. The spaces worker's `createProject` 
  is idempotent on (space_id, name) (line 2001-2003, ON CONFLICT DO NOTHING), so a retry 
  of the provisioner creates only one project. **BUT**: `projects.kind` is only set via a 
  follow-up PATCH (lines 407-409), not at creation time. If this PATCH fails, the project 
  exists with kind=null, and a retry creates nothing (idempotent on name), leaving the 
  space with a broken wallet project. This is F-32's twin: the singleton index doesn't 
  exist yet (F-33 to be built). Fix rides with F-32/F-33: the wallet project must be 
  created with `kind: "wallet"` in the initial POST, not set via PATCH, so the singleton 
  check can prevent a second "Wallet" project ever existing.

- [x] **F-45 (authorization): `seedOwnerMember` uses unauthenticated internal token.** 
  Evidence: lines 343-352, the provisioner creates an `x-naelao-internal-token` and POSTs 
  to `/spaces/:spaceId/members` with `{ role: "owner" }` — no identity is passed in the 
  body, and the spaces worker trusts the internal token alone. **RISK**: the provisioner 
  itself has PLATFORM_SECRET and can forge any internal token. If the provisioner's message 
  queue is publicly reachable (unlikely but possible in a misconfigured setup), an attacker 
  could enqueue a ProvisionMessage with an attacker-supplied `userId`, and `seedOwnerMember` 
  would register them as owner of a space they don't control. The mitigation is that 
  ProvisionMessages come from a TRUSTED internal queue enqueued only by `createSpaceRecord`, 
  which sources tenantId from verified auth. **VERDICT**: not an active bug given queue 
  gating, but document the assumption: ProvisionMessage.userId must never come from 
  untrusted input. Add a comment on line 67 of workers/provisioner/src/index.ts: "userId 
  is trusted (sourced from verified auth in createSpaceRecord) and used to register the 
  creator as owner; never accept it from untrusted input."

- [x] **F-46 (data integrity): FIXED — added a seedWallet-twice test against a stateful idempotency-respecting fake, proving the balance stays $10. Wallet credit grant idempotency relies on endpoint 
  implementing idempotency correctly.** Evidence: lines 420-422, the provisioner calls 
  `POST .../wallet/credit` with `idempotency_key: "starter:${spaceId}"`. The spaces worker 
  must store idempotency keys and return the same response on a retry. **VERIFY**: does 
  `SpaceDO.creditWallet` (or whichever endpoint this is) actually implement idempotency? 
  If not, a retry of provisioner step 9a grants $10 twice. Current code assumes it exists 
  but doesn't verify it in tests. Fix: add a test in `provisioner-seed-wallet.test.ts` 
  that calls `seedWallet` twice with the same spaceId and verifies the balance is only $10, 
  not $20.

## Summary of Comprehensive End-to-End Audit (Session Context)

**Scope:** Full platform audit for go-live readiness against competitive threat (Polsia).

**Methodology:**
- Deep code review of critical paths: provisioning, billing, authentication, authorization, 
  data persistence, real-time sync, memory/knowledge systems
- Verification of 50+ subsystems against spec and architectural guarantees
- Checked for: TOCTOU races, SQL injection, path traversal, information disclosure, 
  idempotency gaps, cross-tenant boundary violations, orphaning risks, cleanup completeness

**Known Launch Blockers (being fixed):** F-1 through F-17 (builder routing, webhooks, 
environment config, wrangler.toml env blocks, direct-worker trust, credit deduction idempotency)

**Tier 2 Findings (lower priority, documented with context):** F-18 through F-46 (revenue 
model clarity, wallet system, Business Feature Projects registry, provisioning edge cases)

**Tier 3 Findings (very low risk, accumulation only):** F-48/F-49/F-50 (session cleanup, 
thread erasure design, debit idempotency TOCTOU)

**Critical Subsystems: VERIFIED SOLID** — No exploitable bugs found in:
- Channel ingress (all 4 adapters signature-verified, replay windows enforced)
- Event triggers (project scoping enforced, no cross-project leak)
- Knowledge base (cross-tenant check before any operation)
- Local machine (path traversal blocked, exact command matching, project ACLs)
- Credentials (3-tier hierarchy, scope enforcement)
- Threads (no orphaning risk, FK-based cleanup, max_threads correct)
- Sessions/auth (TTL enforced, tokens hashed, expires on verify)
- Rate limiting (pre-auth fail-closed, sharded per bucket, cleanup scheduled)
- Refunds (idempotent via UPDATE ... WHERE status != 'refunded')
- SQL (all queries parameterized, no injection vectors)
- Secrets (no hardcoding, all from worker env or vault)

**What a builder can do TODAY after F-1 through F-17 fixes:**
1. Create a product (space provisioning fixed)
2. Configure templates and agents (routes wired)
3. Publish storefront products (money-in flow fixed, revenue tracked)
4. Connect channels (Slack/Discord/WhatsApp, signature-verified)
5. Set up automation (event triggers with project scoping)
6. Manage team (members, roles, project visibility)
7. Monitor operations (activity log, spend caps, agent success/fail)
8. Control end-user access (business memberships, GDPR export/erasure)

**What needs follow-up (not blocking launch, documented):**
- F-32/F-33: Business Feature Projects registry and singleton enforcement
- F-36/F-38: Assistant identity in threads (already mostly built)
- F-39: R2 workspace file viewer (UI only, backend solid)
- F-41/F-WALLET-1 through F-WALLET-7: Complete wallet system
- Phase L/M: Container marketplace and local-machine scaling

## Structural

- [x] **F-STRUCT: Route-parity test.** BUILT: router-dispatch.test.ts now asserts the router SOURCE registers a handler for every top-level API prefix the frontends depend on (/builder, /spaces, /reseller, /connectors, /templates, /products/by-slug, /webhooks/lemon-squeezy) — the structural guard that caught F-1/F-2 being un-routed. ORIGINAL: Extract every path prefix `apps/dashboard` and
  `apps/shell` call and assert the router dispatches each to a real worker route — F-1,
  F-3, and F-5 are one bug class; this is the `wrangler-vars-parity.test.ts` equivalent.
- [x] **F-HYGIENE: `.turbo/` directories are git-tracked** — every typecheck run dirties
  the tree. Add to `.gitignore` and `git rm -r --cached`.

## Plausible-but-unconfirmed (verify before fixing)

- [ ] `PRODUCT_SUBDOMAIN_APEX` must match the real production apex once domains go live
  (config-time; unverifiable in-repo).
- [ ] `nak_` agent-key approval gate's coarse action keys (`agentActionKey` collapses to
  first path segment) — deliberate, but untested against deep mutating routes.

- [x] **F-48 (LOW): Expired ProductUserDO sessions are never cleaned up from `session_state` 
  table.** Evidence: `ProductUserDO` routes mint sessions with a 30-day TTL 
  (`SESSION_TTL_MS = 30 * 86_400_000`) and expire them on verification (`expires_at` checked 
  at line 172), but no job ever runs `DELETE FROM session_state WHERE expires_at < now()`. 
  This is a low-risk accumulation issue (sessions table stays bounded by legitimate user 
  activity, not a security hole) — every expired session is still unreachable (verification 
  rejects it), and ProductUserDO's own storage doesn't persist across instance restarts 
  anyway. **Verdict**: low priority but should eventually add to a background cleanup job 
  (either a Workflow or a quarterly batch-delete of 30+ days old rows).

- [x] **F-49 (LOW): GDPR erasure in SpaceDO only deletes sessions/messages, not threads.** 
  Evidence: lines 1745-1776, the `DELETE /me/data` route deletes sessions, messages, 
  agent_state, and injection_attempts, but does NOT delete rows from the `threads` table 
  where `user_id = ?`. **Context**: this is intentional by design — threads are structural 
  (a builder's conversation history, linked to projects/spaces), while sessions/messages 
  are user-account data (an end-user's temporary message history). The division is correct, 
  but should be documented in a code comment to prevent a future refactor from accidentally 
  "completing" the deletion by deleting threads too (which would break the builder's history). 
  **No fix needed** (design is sound), but add a note.

- [x] **F-50 (VERIFY): ProjectUserDO credit-ledger idempotency on concurrent debit.** 
  Evidence: `POST /credits/deduct` (lines 228-262) has a TOCTOU race I identified in F-47. 
  The logic SELECT→CHECK→INSERT pattern races; two identical concurrent requests can both 
  pass the SELECT (line 244 checks idempotency key), both check balance (line 251), both 
  INSERT (only one succeeds, constraint violation on the second). The failing INSERT is not 
  caught — it silently returns, but the logic has already debited. FIX: use INSERT OR IGNORE 
  pattern + follow-up query (same as `/credits/grant` does) to atomically enforce idempotency 
  on debit paths.

## Verified solid during deep audit (not bugs)

- **Channel webhook signature verification**: All four adapters (email/Slack/Discord/WhatsApp) 
  properly verify signatures with timing-safe comparison before any handler runs. Replay 
  windows enforced (Slack: 5 min max).
- **Event trigger project scoping**: `resolveLastActiveOtherThread` and `matchesEvent` 
  correctly enforce project boundaries — a space-scoped trigger sees all projects, a 
  project-scoped trigger sees only that project.
- **Knowledge base cross-tenant access**: F8 fixed via `verifySpaceOwnership` middleware 
  run before any KB operation (line 155-161, `workers/knowledge/src/index.ts`).
- **Local machine grants security**: Path traversal blocked, command matching is exact 
  (no prefix), project scoping enforced. Tests verify all edge cases.
- **Credential hierarchy resolution**: Three-tier model (override > user-scoped > space-wide 
  fallback) correctly ordered; scope enforcement at create time.
- **Thread/session lifecycle**: No orphaning risk; cleanup deletes messages via FK constraint 
  before session/thread row. Max_threads enforcement excludes sub_agent threads (correct).
- **Refund clawback idempotency**: `UPDATE ... WHERE status != 'refunded'` ensures retry-safe 
  clawback (already tested).
- **Custom domain provisioning**: CF-for-SaaS integration is thin wrapper around Cloudflare 
  API; no application-logic gaps found.
- **Session TTL enforcement**: 30-day ProductUserDO session TTL refreshes on verify; expired 
  sessions rejected before any downstream call.
- **Permission boundaries**: Cross-space checks fail closed; business membership verified on 
  end-user routes; RBAC enforced (product_end_user has empty permissions by default).

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
- Rate limiter bucket cleanup: `RateLimitDO` reschedules 10-minute idle-cleanup alarm 
  on every check (no unbounded growth).

## AI/LLM provider flexibility + growth-layer mechanism ideas (2026-07-13, session discussion, not bugs)

Surfaced while discussing the first production Cloudflare deployment (Worker Loaders/Containers
need the $5 Workers Paid plan; Workflows don't) and the user's plan to bootstrap Launchpad's
first real business on free-tier resources before opening the platform to other builders.

- [ ] **AI-1 (build, small): `inferProvider()` defaults any unrecognized model name to
  "anthropic" — needs a branch for GLM/Zhipu (and any future non-`@cf/`/non-`gpt-` model) so
  it routes through the existing generic OpenAI-compatible branch instead.** Evidence:
  `workers/agents/src/shared/ai-client.ts`'s `inferProvider()` only special-cases `@cf/*` →
  `workers-ai` and `gpt-`/`o1-`/`o3-` → `openai`; everything else falls through to `anthropic`,
  which builds an Anthropic-Messages-API-shaped request (`x-api-key`, `anthropic-version`,
  `messages` endpoint). A model configured as a Custom Provider in the CF AI Gateway dashboard
  (e.g. Zhipu/GLM's own OpenAI-compatible endpoint, BYOK key stored gateway-side, never in a
  worker secret) would be silently sent in the WRONG shape today. Fix: recognize a `glm-`/`zai/`
  prefix (or whatever slug the user picks when adding the custom provider in the CF dashboard)
  and route it through the already-existing generic "OpenAI and OpenAI-compatible providers"
  branch (`buildProviderEntry`'s fallthrough case) — this is a 2-line routing fix, NOT a
  credential; the API key stays entirely in the CF dashboard's BYOK store either way.
  **No fix needed at all** for Cloudflare's own hosted `@cf/zai-org/glm-5.2` (Workers AI
  catalog) — that already routes correctly via the existing `workers-ai` branch; only needs
  adding to Phase 5's `ALLOWED_MODELS` allowlist (`workers/spaces/src/do/SpaceTypeRegistryDO.ts`)
  to be selectable from the dashboard's Model card.

- [ ] **AI-2 (design decision, deferred): per-product/per-space BYOK LLM key override.**
  User wants a product builder to optionally add their OWN LLM provider key, scoped to their
  deployed Space, overriding Naelao's platform default (which stays available as the fallback,
  billed through the existing credit system). Architecturally feasible — CF AI Gateway already
  supports multiple named/aliased provider keys per gateway — but real new work, not a toggle:
  (a) a vaulting UI (reuse the `space_credentials` scope='space' pattern already built for
  connectors, not a new mechanism); (b) alias-selection threaded through `ai-client.ts`'s
  provider-entry building (today `apiKey` is either empty — gateway-stored default — or a
  request-supplied value; a per-space override needs to resolve to a specific gateway alias
  or a real key fetched from the vault at call time); (c) the unresolved billing question this
  needs answered before building: does a builder using their own key still pay Naelao anything
  per run (infra credits only, per item 48 Phase 3's `infra_credits` metering — which already
  exists and is independent of LLM token cost) or literally nothing? Recommend deferring until
  after the first Launchpad business is running — doesn't block getting to revenue.

- [ ] **AI-3 (design confirmation, not a gap): Dynamic Workflows do NOT substitute for Worker
  Loaders/Containers — they solve a different problem (durability), not code isolation.**
  Traced `execution-ladder.ts`'s `runStoredScript`: a script tagged `runtime:"workflow"`
  dispatches to `env.workflowRunner` INSTEAD of `env.codeRunner`, but per CLAUDE.md item 33 the
  actual `ScriptRunWorkflow` step re-resolves the script by name through `fireScriptDirectly` →
  the SAME `ScriptToolSurface.run()` → `runStoredScript` path — which still needs `env.codeRunner`
  (Worker Loader for Tier 2-3, browser proxy for Tier 4, container DO for Tier 5) the moment it
  actually executes a Tier 2-4 script's code. Workflows give a long-running/cron script
  durability (survives restarts, retries, no isolate held open) — they do not provide an
  alternative sandboxing mechanism for untrusted dynamic code, and Cloudflare Workflow steps are
  ordinary pre-deployed Worker code, not a place to `eval()` arbitrary agent-authored JS safely.
  Bottom line for the free-plan bootstrap: Tier 1 (R2 scripts + prebuilt ops, including all MCP
  connector calls) and Workflows both work today with no upgrade; Tier 2-5 (arbitrary dynamic
  code / containers) genuinely need the $5 Workers Paid plan — there is no legitimate way around
  this using Workflows. A first bootstrap business should stick to Tier 1 + prebuilt ops (which
  is what the built Launchpad templates already use) until upgrading.

- [ ] **AI-4 (confirmed correct, no fix needed): Composio/Pipedream connectors are
  Naelao-API-keyed but per-tenant isolated, verified against actual code, not assumed.**
  `connectors/composio.ts` creates every connected account under
  `user_id: naelao-space:${spaceId}`; `connectors/pipedream.ts`'s Connect token is scoped to
  `externalUserId: naelao-space:${spaceId}` — one connected account per Naelao space, never
  shared. `mcp-hub`'s tool-call/registration routes additionally bind
  `WHERE ... space_id = ? AND tenant_id = ?` before resolving any connector row, so even the
  lookup itself cannot cross a tenant boundary. Naelao's platform Composio/Pipedream API key
  only authorizes the management/proxy calls to those providers' own APIs — it grants no access
  to another tenant's connected account or credentials. Confirms the universal-tools doctrine
  (item 42/56) is genuinely safe for multi-tenant use, not just a documented intent.

- [ ] **AI-5 (design gap, confirmed against HEAD): connectors have NO per-collaborator or
  per-project scoping today — every Composio/Pipedream/OAuth connection is one shared
  space-wide credential, with no path to a personal per-user connection even though the
  generic credential hierarchy that would support it already exists.** Prompted by: "what about
  a business/space that has more than one user — is there a global space connection AND a
  per-user connection to the whole space, without leaking out a collaborator, and at the
  project level?"
  Traced both halves of the actual mechanism:
  - `workers/credentials/src/index.ts`'s `resolveCredential(db, spaceId, tenantId, name,
    actingUserId)` is a GENERIC 3-tier hierarchy (item 18): an `is_override` space-level row
    always wins → then a `scope='user'` row for the specific `actingUserId` → then a
    `scope='space'` fallback. This already supports a personal, per-collaborator credential for
    ANY credential name, including a connector — the mechanism exists.
  - But `workers/mcp-hub/src/index.ts`'s `buildAuthHeaders(server, env, agentId)` — the function
    that actually resolves a connector's credential at tool-call time — takes NO `actingUserId`
    parameter at all, only `agentId` (read from `x-naelao-agent-id`). Its only caller context is
    `c.req.header("x-naelao-agent-id")`; no acting-user identity is threaded through anywhere in
    the connector call path. Combined with item 55's fix (which forced connector storage to
    ALWAYS write `scope='space'`, precisely BECAUSE mcp-hub's resolution had no user-scope
    context to read a `scope='user'` row back with), the result is: **there is no per-user
    connector connection today, by construction, not by a scoping bug** — one Twitter/LinkedIn/
    Whop/etc. connection is shared by every collaborator and every agent in the space. This is
    the CORRECT model for "the business's own official account" (there should only be one
    business Twitter account), but is NOT sufficient if a collaborator wants to connect THEIR
    OWN personal account for use within the shared space without other collaborators being able
    to use it, post as them, or even see that it's connected.
  - **Project-level scoping is also absent**: every mcp-hub route (`/v1/spaces/:spaceId/
    mcp-servers*`) keys purely by `spaceId` — there is no `projectId` column or filter anywhere
    in the connector registry. A business with multiple projects (e.g. managing several
    sub-brands or client accounts as separate projects within one space) cannot have
    project-scoped connectors — every project's agents share the exact same space-wide
    connector set.
  - **What a real fix needs** (not built, scoping only): (a) an explicit `scope: 'space' |
    'user'` (and optionally `project_id`) choice at connect time, surfaced in the shell's
    "Connect Apps" panel — a collaborator explicitly chooses "connect for the whole business"
    vs. "connect just for me"; (b) `mcp-hub`'s server-registration row needs an owning
    `user_id`/`project_id` column (nullable = space-wide, matching today's default) so a lookup
    can prefer/require the right row; (c) `buildAuthHeaders` and every call site need an
    `actingUserId` (and where relevant `projectId`) threaded through from the reasoning loop's
    already-resolved caller identity (the same identity `NaelaoAgentDO` already has for F-36's
    assistant permission clamp — reuse, not a new identity concept); (d) the credential
    RESOLUTION side already works (`resolveCredential` supports this) — the gap is entirely in
    mcp-hub's connector-registry schema and its call sites never carrying a user/project scope.
  - **Leak risk if built carelessly**: a per-user connector row must be resolvable ONLY when the
    acting user matches — the exact same "verified claims, never a client-supplied field"
    discipline every other per-user check in this codebase already follows (e.g. `GET
    /spaces/:spaceId/sessions` deriving `end_user_id` only from verified claims, never a query
    param). A naive implementation that let a caller pass `?user_id=` to select whose connection
    to use would immediately leak one collaborator's personal account to another.

- [ ] **AI-6 (requested, not yet built): migrate `connectors/composio.ts`'s hand-rolled REST
  calls onto Composio's official TypeScript SDK (`@composio/core`, or the smaller
  `@composio/slim` if the full SDK pulls unwanted deps into a Worker bundle).** User preference,
  explicit: "i prefer the composio sdk." Today's `composio.ts` calls `backend.composio.dev/api/v3`
  directly via `fetch()` with a defensive multi-field-name `pick()` parser (its own header
  documents this was because the raw REST response shape wasn't verified against a live key at
  build time). The official SDK (`@composio/core`, confirmed installable via npm/yarn/pnpm,
  requires Node 18+) exposes typed methods (e.g. `composio.connectedAccounts.link(...)`) that
  would remove the guesswork entirely — real field names, real status enum, no defensive `pick()`
  needed. **Before swapping:** confirm the SDK is CF-Workers-bundle-safe (no Node-only APIs the
  Workers runtime doesn't polyfill — `@composio/slim` is the safer bet for a Worker, per its own
  npm description as a smaller-footprint variant of the same API) — the hand-rolled `fetch()`
  version was deliberately chosen to avoid an unverified bundle-compatibility risk in a
  Cloudflare Worker, not out of a preference for raw REST. Scope: replace `startComposioLink`/
  `getComposioConnectionStatus` internals only — the ticket-issuing/consuming flow, the
  `/provider-connect/*` routes, and every test in `composio-connector-connect.test.ts` are
  provider-implementation-agnostic and should need zero changes. Verify bundle size/compat with
  `pnpm turbo run typecheck` + an actual `wrangler deploy --dry-run` (or bundle-check CI step)
  before committing to the swap, not just a local Node test run.

- [ ] **AI-7 (user-directed pivot, blocked on one open question before building): platform
  billing (builder subscriptions) needs a Lemon Squeezy replacement — LS store activation failed
  because its onboarding requires a Stripe-linked payout path and Stripe is unavailable in the
  user's country.** This is a pivot from CLAUDE.md item 45's "Lemon Squeezy is the ONLY billing
  provider" doctrine, for the PLATFORM-billing rail specifically (builder Growth/Business plan
  checkout — `/billing/checkout`/`/billing/portal`/the LS webhook in `workers/billing`). It does
  NOT affect the business-wallet rail (items 50-55, already Whop-based) or the BYO Whop connector
  (items 52-54) — those are unrelated subsystems that already work.
  **Researched, not assumed:** Whop's own plan/checkout API genuinely supports recurring
  ('renewal') subscription billing with a full lifecycle (renewals, dunning, cancellations,
  self-serve billing portal) — structurally capable of replacing what LS did for platform plans.
  BUT Whop's own Terms of Service states payment/payout access requires completing "identity
  verification and compliance checks required by third party identity verification services AND
  financial partners" — and a Whop blog post states non-US creators from Stripe-restricted
  countries "cannot directly access Whop's full seller capabilities" without a US LLC + US-linked
  Stripe account. **Whether this specific restriction applies to a NORMAL Whop seller signup (as
  opposed to the invite-gated Platforms/connected-accounts API items 50-51 already use for
  business wallets) could not be confirmed from public sources** — search results conflated
  Stripe's own KYC documentation with Whop's terms, and Whop's public docs don't clearly separate
  "normal seller onboarding" requirements from the specific Stripe-linked path the blog post
  describes. **Before building:** confirm whether the user can actually create/already has a
  normal Whop company/seller account for Naelao itself (distinct from the sub-merchant wallet
  rail's invite-gated API) — if that account creation itself fails the same way LS did, the pivot
  needs a different provider entirely, not a code change.
  **If confirmed viable, the build is:** a `WhopPlatformBillingProvider`-shaped set of routes
  parallel to what LS's `/billing/checkout`+`/billing/portal`+webhook do today (see item 45's
  `recordPlatformPlanSubscription` for the LS-side precedent to mirror) — Naelao creates Growth/
  Business `renewal` Plans via Whop's Plan API, checkout links point at those plans, and a new
  Whop webhook branch (membership/subscription lifecycle events — NOT the same webhook path as
  `whop-wallet.ts`'s `payment.success`/`withdrawal.*` business-wallet events, a genuinely
  different event family) updates `orgs.plan_tier` + invalidates the quota KV cache the same way
  the existing LS handler does. `LEMON_SQUEEZY_GROWTH_VARIANT_ID`/`BUSINESS_VARIANT_ID` get a
  Whop-plan-id counterpart; `docs/DEPLOYMENT_SECRETS.md`'s LS platform-plan row needs a Whop
  equivalent added, not replaced (LS code stays, in case the user later has an LS-compatible
  region/entity, matching the "D1 has no cheap drop-and-forget" precedent already used elsewhere
  in this codebase for deprecated-but-not-deleted subsystems).

- [ ] **AI-8 (user question, answered — do not build as scoped): Pipedream's custom-code-step
  capability is real but is NOT a safe or sufficient substitute for the CF Tier 2-5 execution
  ladder ($5 Workers Paid plan) — keep Pipedream as a connector, not a code-execution backend.**
  Researched (not assumed): Pipedream workflows genuinely support custom Node.js/Python/Go/Bash
  steps with npm/pip package access, and `client.workflows.invokeForExternalUser()` genuinely
  scopes which end-user's connected-account credentials a given run resolves via
  `external_user_id` — this credential-isolation half is real and already what `connectors/
  pipedream.ts` (item 57) correctly relies on for the Notion connector. Two reasons this does not
  extend to "use Pipedream instead of Worker Loaders/Containers for Tier 2-5":
  (1) **Trust-model mismatch.** A Pipedream workflow's code steps are pre-authored once (in the
  Pipedream UI or via their workflow-management API) — they are not an arbitrary
  `run(code, tier)` API the way `env.codeRunner.run()` is. Making Pipedream serve that role would
  require ONE workflow whose code step dynamically evals a `code` string passed in at trigger
  time — technically buildable, but Pipedream's own security docs put responsibility for securing
  a workflow's code on the account owner; there's no documented guarantee (unlike CF's V8
  isolates/gVisor containers, which are specifically engineered and marketed for running
  untrusted multi-tenant code) that Pipedream's own code-step execution is safe to run
  arbitrary, agent-generated code originating from many DIFFERENT Naelao tenants side by side.
  (2) **Free-tier compute ceiling makes it a non-starter past a toy scale.** Confirmed via
  Pipedream's own pricing/limits docs: the free plan is 100 credits/month (1 credit = 30s @
  256MB — about 50 minutes of total compute per month, PLATFORM-WIDE, not per business), capped
  at 3 active workflows and 3 connected accounts, with a 30s default HTTP-trigger timeout (750s
  hard cap even on paid tiers). This cannot serve as the real Tier 2-5 backend for more than a
  single bootstrapping business's lightest automations.
  **Recommendation given to the user:** keep Pipedream (and Composio) exactly as already built —
  a connector for capabilities that map to a fixed, pre-authored pipeline (post to X, generate
  an image, sync Notion) — and treat the CF Workers Paid plan's flat $5/month as the real Tier
  2-5 unlock once the first bootstrap business has any real revenue, rather than building a
  parallel, less-isolated, more resource-constrained execution path to defer a $5/month cost.

- [x] **AI-9 (FIXED, platform-wide production bug — found while wiring the first real Whop
  webhook end-to-end against the live deployed account): every proxied route across the platform
  was returning HTTP 500 in production, masking the real response with a generic "internal_error"
  — first live end-to-end exercise of any router route ever caught this.** Traced with real
  `wrangler tail` output (not guessed): `TypeError: Can't modify immutable headers.` A Response
  object returned directly from a cross-Worker service-binding `fetch()` call (the `proxyTo`/
  `proxyBillingWebhook` pattern used by nearly every route in `naelao-router`, plus the same
  passthrough pattern independently present in `agents`/`spaces`/`security-gateway`) has headers
  the Workers runtime treats as immutable once the body starts streaming. TWO separate pieces of
  middleware were mutating `c.res.headers` in place after `await next()`: `naelao-router`'s own
  CORS middleware (`workers/router/src/index.ts`) and — the more load-bearing one, since it's
  shared by every worker in the monorepo — `requestId` in `@naelao/http`
  (`packages/http/src/middleware.ts`), which sits INSIDE the CORS middleware's own `next()` call,
  so its throw fired first regardless of the CORS fix. `new Response(body, otherResponse)` does
  NOT reliably yield a fresh mutable `Headers` either (it can still link back to the same
  immutable object) — both fixed by explicitly building a genuinely new `Headers()` and copying
  entries into it before setting anything. Verified against the REAL deployed account (not just
  unit tests, which never exercise workerd's actual immutable-headers semantics): `/v1/webhooks/
  whop`, `/v1/webhooks/whop-platform-plan`, and `/v1/webhooks/lemon-squeezy` all returned generic
  500s before the fix and their real, correct business-logic responses (`whop_not_configured`,
  `invalid_signature`, etc.) after it. Redeployed `naelao-router`, `naelao-billing`,
  `naelao-spaces`, `naelao-security-gateway`, and (after the free-plan workaround below)
  `naelao-agents` — all five workers with a confirmed direct passthrough call site now carry the
  fixed `@naelao/http`. The other ~20 workers that import `requestId` but don't do direct response
  passthrough aren't currently exposed to this specific trigger condition, but should still be
  redeployed with the fixed package on their next normal deploy so the landmine can't reappear if
  a future change adds a passthrough route to any of them.
  **`naelao-agents` deploy was separately blocked** on the Cloudflare account being on the free
  Workers plan — its `wrangler.toml` unconditionally declared a `Worker Loader`/Dynamic Workers
  binding (`[[worker_loaders]] binding = "LOADER"`, for script-engine Tiers 2-4), which 10195s with
  "you must switch to a paid plan" on any deploy attempt regardless of whether Tier 2-4 is ever
  actually invoked. Fixed by commenting out the binding declaration (2 lines) — `code-runner.ts`
  already degrades Tiers 2-4 to "unavailable" when the binding is absent, identical to how it
  behaves today with the binding declared-but-unusable on the free plan, so this is a zero-
  behavior-change toggle: uncomment the two lines and redeploy the moment the account upgrades to
  the $5/mo Workers Paid plan (the bootstrap plan's own stated "enable Worker Loaders later" step).
  Also needed `wrangler@4` (not the repo's pinned 3.114.17, which doesn't parse this worker's
  `[[containers]]` array-of-tables syntax) with `--containers-rollout=none` (no Docker available
  in this sandbox to build the container image; the container itself is untouched by this deploy).

- [x] **HX1 (Harness Excellence Program, agent trace layer) — FIXED/BUILT.** The script-native
  loop computed real per-phase timing/tier/token data but discarded it into an ephemeral
  `notes: string[]`; `packages/tracing` (Span/Tracer → Analytics Engine) had zero consumers
  anywhere in the repo. New `TraceStep`/`LoopResult.trace`, `run_traces` SQLite table on
  `NaelaoAgentDO`, best-effort AE span mirror, and a builder-only
  `GET .../agent/runs/:runId/trace` endpoint. Full detail: CLAUDE.md item 59, appendix §A1.31.
  1914/1914 tests pass, typecheck clean (76 tasks).
- [x] **HX2 (Harness Excellence Program, signals + session token-budget guard) — FIXED/BUILT.**
  Explicit signals (error rate, avg/total cost, regenerations) computed on read from the
  already-existing `agent_activity_log` — no new ingestion. Implicit signals
  (`detectImplicitSignals`, `@naelao/events`) are a regex-based user-frustration/agent-forgot
  classifier wired into `/agent/run`, posting to a new `agent_signal_events` table. The session
  token-budget guard (`SpaceTypeProductConfig.limits.sessionCreditCeiling`, new `session_spend`
  table) is the actual fix for OpenClaw-style unbounded-cost complaints: 80% fires
  `agent.session_budget_warning` through the existing `event_triggers` machinery, 100% refuses
  the run and reuses the HITL approval mechanism (no new gate engine) — never silent. Full
  detail: CLAUDE.md item 60, appendix §A1.32. 1946/1946 tests pass, typecheck clean (76 tasks).
- [x] **HX3 (live-agent eval harness) — FIXED/BUILT.** `workers/eval` never actually invoked an
  agent (only judged a case's raw `input` text) and bypassed the CF AI Gateway vendor cutover
  (item 45, hardcoded direct `api.anthropic.com` call) — both real, previously-undetected gaps.
  New `mode: "agent"` dispatches a real `/agent/run` per case (Prefer: respond-sync, internal
  token, same auth pattern as every other internal caller) and judges the agent's actual answer;
  the judge itself now routes through `@naelao/llm-gateway`'s `callLlm` (CF AI Gateway) instead of
  a raw fetch. Judge scores `correctness` + `semantic_validity` separately, overall score is the
  MIN of the two (anti-reward-hacking — a keyword-stuffed non-answer can't average to a pass).
  3 golden datasets (`tests/eval-datasets/*.jsonl`: tool-use/policy, multi-step web+file,
  commerce/business-ops — 17 cases). `infra/scripts/run-eval-suite.mjs` benchmark runner with a
  regression-threshold exit code (manual dispatch, not wired into CI — no live deployment to
  target yet). Full detail: CLAUDE.md item 61, appendix §A1.33. 1953/1953 tests pass (7 new),
  typecheck clean (76 tasks).
- [ ] **HX4-HX5 (Harness Excellence Program, tracked follow-up, NOT done this pass):** HX4
  (SkillOpt-Lite-style validation-gated skill self-evolution: mine HX1's failure traces per
  skill, propose a patch via the existing `script.update`, validation-gate it against HX3's eval
  cases, keep only if it scores ≥ the old version else `rollback()`), HX5 (skill supply-chain
  hardening — tamper-evident provenance, import/inherit-time reserved-capability + red-flag
  scanning — ahead of any future skill marketplace). Build order is a strict chain HX1→HX2→
  HX3→HX4 (each phase's input is the prior phase's output); HX5 is independent. Full plan: the
  session's plan file / CLAUDE.md item 61 / appendix §A1.33.

## Audit continuation findings (2026-10-22)

- [x] **Dashboard token parsing and storage failure handling.** The browser decoded arbitrary JSON as
  `NaelaoJwtClaims`, accepted non-finite or missing expiration values, and used `localStorage`
  without handling access denial. A malformed token could leave the dashboard in an authenticated
  UI state, while blocked storage could leave hydration stuck or throw during API requests. Claim
  structure and expiry are now checked for UI state, and storage reads/writes/removal fail safely.
  Login and registration reject malformed/expired responses before saving them. Server-side JWT
  verification remains authoritative; decoding in the browser is not signature verification.

- [x] **Dashboard API path segment construction.** Several route helpers interpolated space,
  product, document, and API-key IDs directly into URL paths; encoded separators or dot segments
  could target a different endpoint after URL parsing. All dynamic path identifiers now pass a
  shared segment encoder that rejects empty and exact dot segments; regression tests cover encoded
  separators, dot-segment rejection, and write routes. The 77-call API wrapper still needs a full
  route/response/error contract review, and backend authorization remains the security boundary.

- [x] **Dashboard product URL safety.** The product link helper trusted a deployment URL string and
  appended a database slug as raw path text. It now accepts only an HTTP(S) origin (HTTP is allowed
  only in development), rejects credentials/path/query/fragment components, validates slugs against
  the server's product-slug rule, and uses encoded path segments. Local development defaults to the
  shell's configured port 3100. Tests cover invalid schemes, credentials, slugs, and development
  origin selection. The staging/production shell origin remains an external deployment setting and
  is listed above because the repository workflows do not currently provide it.

- [x] **Password reset links and dashboard login form boundaries.** Newly issued reset credentials
  were placed in a query string, exposing them to initial page-request logs and referrers. New email
  links now carry the token in the URL fragment; the client captures and removes it before submitting
  the token in the POST body. A global `no-referrer` metadata policy reduces accidental disclosure,
  and older query links remain temporarily accepted and are removed after hydration. Login and reset
  forms now associate labels with inputs, announce errors, and perform authenticated redirects from
  an effect rather than during render. `auth-worker.test.ts` passed 32/32 and the complete dashboard
  Cloudflare Pages build passed. Actual browser history/referrer behavior remains unverified here.

- [x] **Dashboard plan-tier display.** Overview and header components read `plan_tier` from JWT
  claims, but auth signs no such claim; every account therefore displayed the fallback `free`, even
  when the authenticated user had a paid subscription. Auth context now retains the tier returned
  by login/register and refreshes mutable subscription state through the authenticated billing
  endpoint after session hydration. The UI shows a checking state until that request resolves rather
  than asserting a false tier. Router dispatch/auth tests passed, dashboard typecheck and the full
  Pages build passed. A live subscription read and browser state synchronization were not exercised.

- [x] **Dashboard API client transport and dead SpaceType methods.** `apiFetch` added
  `Content-Type: application/json` to every request and cast `RequestInit.headers` to a plain object,
  dropping caller-supplied `Headers` instances. It now preserves standard `HeadersInit` values and
  adds JSON content type only for string request bodies; authenticated requests still preflight due
  `Authorization`. Confirmed the removed SpaceType create/get/update wrappers had no callers and
  pointed at unimplemented routes; only the live registry-list endpoint remains. Corrected the stale
  comment claiming the implemented builder API-key routes were not live. Transport regression tests,
  dashboard typecheck, and Pages build pass. The rest of the API wrapper's route/response contracts
  is still open.

- [x] **Destructive product confirmation dialog.** The typed-name delete dialog lacked alert-dialog
  semantics, a programmatic field label, Escape handling, keyboard focus containment, and focus
  restoration. It now exposes an accessible alert dialog, keeps focus within its controls, restores
  focus to the opener, prevents backdrop/Escape dismissal while an action is busy, and announces the
  busy state. A server-render regression checks the dialog naming and label association; the builder
  deletion route tests passed, and dashboard TypeScript plus the Cloudflare Pages build passed. Real
  browser keyboard and focus behavior remains part of the open UI browser audit.

- [x] **Dashboard API-key creation lifecycle.** The UI truncated fractional expiry values (for example,
  `1.5` became one day), allowed repeated create clicks to mint multiple keys even though the raw
  secret is returned once, and swallowed load/create/revoke/clipboard errors. Expiry input now accepts
  only a blank value or an integer from 1 through the backend's 3,650-day limit; create and revoke
  actions serialize, the previous secret must be dismissed before another can be created, and errors
  are shown with clipboard fallback guidance. The UI now validates the backend's 80-character name
  bound and labels its inputs. API-key expiry unit cases and the builder API suite passed 41/41,
  dashboard typecheck and the Cloudflare Pages build passed. Clipboard permission behavior remains a
  browser-only check.

- [x] **Source checklist classification now includes stylesheet and deployment source files.** The
  inventory generator previously omitted `.css` and related style/template languages, along with
  Dockerfile/Containerfile and Makefile-style inputs. It now includes those source/config formats
  and common compiled-language/config extensions. The refreshed checklist count is larger; newly
  included files remain unchecked until individually reviewed.

- [ ] **Outbound DNS rebinding remains an infrastructure gap.** Shared `checkSsrf()` resolves A/AAAA
  records through bounded DNS-over-HTTPS and blocks private results, and several consumers recheck
  at call time and on redirects. The subsequent Workers `fetch()` or browser socket connection does
  a separate DNS resolution, so an attacker-controlled hostname can change from public to private
  between validation and connection. Rechecks reduce the window but do not pin the address. Identify
  a production-supported pinned egress transport/proxy and migrate every outbound consumer (MCP,
  knowledge fetch, browser, callbacks, webhook, compensation, and connector paths); test DNS changes
  between validation and connection, redirect chains, and proxy failure. An experimental
  `packages/security/src/pinned-fetch.ts` transport is unit-tested but no Worker calls it; it only
  supports a bounded HTTP/1.1 subset on ports 80 and 443 and has no Cloudflare `connect()` adapter
  or deployed-runtime proof. Review protocol compatibility and streamed request cancellation before
  adopting it. Browser Chromium needs a proxy or network-level control because its sockets do not use
  Worker `fetch()`. Do not claim this closed until the connection uses the validated address or a
  trusted proxy enforces the same policy.

- [x] **Billing webhook metadata and provider-event routing pass.** Recognized paid checkout
  metadata is now validated rather than silently treated as an unrelated event; malformed
  platform-plan/credit-pack/refund data returns a retryable failure and releases the webhook
  idempotency claim. Checkout path IDs are encoded as individual URL path segments. Failed
  initial plan payments no longer activate a paid tier, failed renewals only mark an existing
  paid plan `past_due`, and platform-plan refund events no longer rewrite the entitlement as
  active. The Lemon Squeezy webhook no longer returns 200 before doing accounting when Agents
  is unbound; platform-plan and personal-plan events are processed without that unrelated
  binding, while generic active-space fulfillment returns 503 and releases the claim if wake
  delivery is unavailable. Whop's platform-plan parser now rejects unmapped event names instead
  of interpreting them as successful payments. Validation: Billing worker suite 21 files /
  183 tests; Billing Core 16 files / 56 tests; both package typechecks pass.
- [x] **Personal-plan finite period grants and Lemon Squeezy lifecycle (implemented; scoped tests pass).**
  ProductUserDO now stores each paid period by provider purchase event, validates amount/interval,
  expires month/year grants at calendar boundaries, extends from the latest unexpired paid period,
  ignores failed renewals/cancellation until paid-through expiry, scopes full refunds to the matching
  purchase, preserves later purchases, and ignores stale expiry events past their event period.
  Checkout carries the catalog interval. Legacy direct grants remain active until replaced by a new
  paid purchase so this migration does not silently revoke existing users. Validation: ProductUserDO
  lifecycle stress tests cover Jan-31 month-end, expiration, renewal, duplicate delivery burst (64
  concurrent repeats), partial/full refund behavior, and stale expiry; Billing/Spaces typechecks pass.
- [ ] **Personal-plan provider lifecycle remains partially open.** Whop's normalized platform-plan
  parser currently recognizes payment success/failure, membership-valid, and membership-invalid, but
  has no verified refund event or explicit subscription-expired mapping. Confirm Whop's signed event
  payloads and stable purchase identifiers, then implement those transitions and test provider event
  ordering/retries. Full refunds revoke a purchase only when the provider supplies an explicit
  refund amount at least equal to the paid amount; otherwise access remains through its paid period.
  Lemon Squeezy's actual signed payload field and units for partial refunds still need live/provider
  documentation confirmation. Legacy `plan_tier` grants have no expiry/source record and are
  grandfathered; define migration/reconciliation policy. Add bounded retention for old entitlement
  rows after the provider refund window. No live provider webhook test has been run.
- [ ] **Platform and business subscription refund policy remains undefined.** Platform-plan
  refunds are now acknowledged without changing access because the webhook lacks an agreed rule
  for partial refunds versus full refunds; business-subscription refunds similarly do not
  deactivate the subscription. Define policy using provider refund amount and subscription
  period state, then implement and test it without allowing a refund event to reactivate access.
- [ ] **Billing checkout expiry/reconciliation remains unverified.** Existing 24-hour surcharge
  claims expire, but provider checkout URL expiry has not been confirmed; add provider-side
  reconciliation or prove old checkout links cannot still be paid after a new claim is issued.
  No live Cloudflare deployment or provider event/request test was run in this pass.

- [x] **Webhook transition identity and stale subscription updates (fixed in the continuing audit).**
  Lemon Squeezy's resource ID is reused for multiple events; deduplication keyed only by that ID
  and the normalized event type suppressed changed payloads such as repeated `subscription.updated`
  events. Webhook delivery claims now use the signed-body fingerprint, while provider IDs remain
  dedicated to ledger joins and downstream idempotency. A delayed failed payment could also mark a
  replacement subscription delinquent; platform updates now match the recorded provider
  subscription and plan, business updates also match product and plan, and Whop payment parsing
  uses `membership_id` rather than `plan_id` as the subscription ID.
- [x] **Missing-space paid product fulfillment (fixed in the continuing audit).** A paid seat or
  product order referencing an absent space used to be acknowledged without recording the order.
  These events now fail retryably and release their body-fingerprint claim. The configured full
  Turbo suite passed 57/57 tasks and 368/368 root files (3,842 tests) after these fixes; Billing
  passed 21 files / 189 tests, Billing Core 16 files / 56 tests, and both typechecks passed.
- [x] **Reseller refund attribution collided with the original sale (fixed in the continuing
  audit).** `reseller_ledger.provider_event_id` is unique, while Lemon Squeezy refunds reuse the
  original order resource ID. The prior refund calculation was negative, but `INSERT OR IGNORE`
  discarded it against the original positive ledger row. The ledger idempotency key now includes
  normalized event type, and a migration-backed sale/refund test verifies the positive and negative
  entries both persist and net to zero.
- [ ] **Provider event ordering and replay retention need production evidence.** Body fingerprints
  distinguish changed payloads but do not impose causal ordering. A late `subscription.created` or
  stale status event may still race a newer lifecycle transition unless provider timestamps and
  current-subscription identity are sufficient for every checkout path. Verify Lemon Squeezy and
  Whop ordering/version fields, then persist a monotonic provider revision or prove the current
  identity checks cover replacement, renewal, cancellation, and recovery. The billing event table
  also has no retention/cleanup path and needs bounded retention without reopening old deliveries.

- [ ] **Workspace dependency ranges and peer compatibility need a full pass.** `packages/types`
  and `packages/ui` previously declared wildcard TypeScript development dependencies; both now use
  the repository's bounded TypeScript range, and `packages/types` also uses the bounded Workers Types
  range. Other workspace packages still declare wildcard
  TypeScript or `@cloudflare/workers-types` versions and should be normalized with lockfile review.
  A lockfile-only install also reported that the current Wrangler 4.149.0 peer range expects
  `@cloudflare/workers-types` v5 while the workspace resolves v4.20260623.1. Typechecking currently
  passes, but confirm the supported version pairing and CI install behavior before closing this.

- [ ] **UI component behavior still needs browser-level stress coverage.** Shared controls had
  keyboard-only activation gaps, unnamed switches, unannounced toast updates, and a modal without
  dialog semantics or Escape/focus management; the scoped components now address these and have
  server-render and keyboard-helper tests. Shared UI styles now provide a keyboard focus indicator,
  reduced-motion overrides, and dynamic viewport sizing for mobile app/dialog layouts. Theme muted
  text is tested at 4.5:1 contrast against page and surface backgrounds for explicit light, explicit
  dark, and system-dark fallback tokens. The modal focus cycle/restore behavior has not been
  exercised in a DOM/browser runtime; responsive overflow, nested modal interaction, full component
  contrast, and screen-reader behavior remain open across the UI package and shell app. A headless
  Chromium check could not complete in the current environment, so these changes still need browser
  layout and assistive-technology validation.

- [x] **Reseller client portfolio authorization, pagination, promotion atomicity, and dashboard handling.**
  The portfolio, wholesale statement, client detail, suspension/reactivation, and promotion endpoints
  relied only on the tenant header and did not restrict reseller-management operations to owner/admin
  roles. They now reject other roles. The portfolio endpoint previously capped the response at 200
  while reporting only that page's row count; it now returns stable 100-row pages and a portfolio-wide
  count, and the dashboard exposes page controls. Promotion previously wrote the terminated hierarchy
  and detached spaces in separate transactions; it now uses an atomic D1 batch. Malformed JSON is
  rejected as 400 for status/promotion requests. The client drawer now has dialog semantics, Escape and
  focus containment/restoration, keyboard-accessible row actions, stale-load protection, and closes
  after successful promotion instead of refetching the now-detached relationship. SQLite-backed tests
  cover viewer denial, malformed/missing confirmation, transaction rollback, successful detachment,
  205-row pagination, and invalid page input. Focused worker/API-key/path suites and dashboard/spaces
  typechecks passed before the current package-manager install issue; a post-change dashboard production
  build is still open. Browser runtime checks for focus restoration, pagination interaction, and network
  race handling remain open.

- [x] **Builder product list silently stopped at 200 entries.** `GET /builder/products` returned a
  fixed first page, so older products became absent from the dashboard list. It now validates a page
  number, counts non-deleted tenant-owned products, and returns stable 200-row pages with total/page
  metadata. The products dashboard renders page controls and ignores stale overlapping list requests;
  the existing layout API remains backward-compatible and continues to return page one. A real-SQLite
  worker regression seeds 205 products and checks both pages, uniqueness, totals, fractional input,
  and out-of-range pages. The test is authored but could not be rerun after pnpm's supply-chain
  release-age guard blocked dependency installation; build/typecheck validation remains open.

- [ ] **Dashboard shell product switcher still loads only the first 200 products.** Its layout uses
  the backward-compatible `listBuilderProducts()` helper and does not expose the new page metadata.
  Products beyond page one remain reachable from the paginated product list, but add search or paging
  to the shared switcher and stress it with large portfolios before considering the navigation flow
  complete.

- [x] **Product launch wizard validation, reachable addresses, and partial success.** Numeric pricing inputs
  previously accepted fractions/unsafe values and retained values from inactive pricing modes; slugs
  accepted leading/trailing hyphens that the server rejects; the wizard could create a product whose
  name has no derivable address; and server address lookup failures silently created slugless products.
  The wizard now validates whole safe nonnegative integers and printable name length, sends only fields
  for the selected pricing mode, matches the server slug pattern, and requires an explicit address
  for names that cannot derive one. Creation fails closed if uniqueness lookup fails or no slug can be
  made, and both creation endpoints return the actual derived slug. Builder product creation now bounds
  request bodies to 64 KiB and rejects malformed/non-object bodies and non-string slugs/config roots.
  A synchronous launch lock prevents repeat submits after success. Domain setup failure now sends the
  builder to a retryable settings page with a partial-success notice instead of silently discarding the
  error. Wizard controls now expose labels, pressed/current states, retry feedback, and step-heading
  focus. The write-only BuilderAccountDO product index was removed after tracing its only writer and
  finding no reader; the authoritative list is the tenant-filtered D1 spaces query. Regression cases
  are authored for slug rules, safe integers, unreachable names, lookup failure, derived response slug,
  and product pagination, but the current workspace dependency installation policy prevents rerunning
  them. Production build and browser behavior remain open.

- [ ] **Validate product configuration at every server write boundary.** `POST /builder/products`
  and `PATCH /builder/products/:id` type product config in TypeScript but still need runtime validation
  for nested auth provider, email-domain, pricing model, and numeric fields. Schema validation is
  optional when a SpaceType has no schema row and does not prove these nested product-specific rules.
  Add malformed-object, invalid-enum, negative/fractional/unsafe-value, and 64 KiB boundary tests before
  considering client-side wizard validation sufficient.

- [ ] **Product creation still needs a durable idempotency boundary.** The browser locks duplicate clicks
  while its request is in flight, but a lost success response can leave the caller unsure whether D1
  committed and whether a provisioning queue message was accepted. Add a caller idempotency key and a
  reconciliation path that cannot create a duplicate product or orphan a provision event under retry.

- [x] **Tool container package egress now follows the Space air-gap policy.** Cold starts previously
  installed exact-host HTTPS interceptions for npm/Python/Git package sources regardless of the
  Space's `airGappedOnly` setting. ToolSandboxDO now resolves the policy from PLATFORM_DB for every
  execution; missing/unavailable policy state disables the intercepts. It recycles warm containers
  when the resolved profile changes and polls the policy during bounded active container work so an
  air-gap change hard-stops the running container. General container internet remains disabled.
  Regression tests cover air-gapped cold start, unavailable policy storage, warm-profile revocation,
  and mid-run revocation. Agents suite passed 165 files / 749 tests; Security passed 22 files / 124
  tests; Agents typecheck and Wrangler dry-run passed. No live Cloudflare policy revocation or network
  packet test has been run; broader egress policy and deployment acceptance remain open.

## Audit continuation — 2026-10-23

- [x] Refresh the Launchpad dashboard API test assumptions to match the team-only, single-root product design; add a concurrent first-launch regression proving the singleton remains unique.
- [x] Add runtime shape/size validation for `product_config`, legal metadata, model config, model policy, and compliance fields on `PATCH /builder/products/:id`, with no-write-on-rejection coverage.
- [ ] Complete the remaining field-by-field review of all other persisted product-config fields and dashboard-facing response contracts.
- [ ] Continue the repository-wide worker, Durable Object, container, API, persistence, and channel audit. The file-by-file checklist remains substantially open; see `audit-output/naelao-file-by-file-stress-audit-plan.md` and the chronological evidence in `audit-output/naelao-audit-progress.md`.
- [ ] Triage remaining root Vitest failures, run the full workspace test/typecheck/deployment validation, and perform controlled live acceptance where credentials and infrastructure are available.
- [ ] Resolve or explicitly disposition DNS rebinding on outbound fetch, production dependency advisories, and unverified deployment bindings before declaring the security audit complete.
- [ ] Repair or document the Turbo workspace test runner's managed `pnpm install` behavior in non-interactive execution (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`), then rerun all 57 package test tasks and triage the results; direct package tests alone do not close the root harness check.
