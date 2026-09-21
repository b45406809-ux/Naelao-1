# AI Studio implementation prompt — batch 23, plan items 112–115

## Mission

Implement every requirement below end to end on the current accumulator branch. The cohesive focus
is **Credit metering, subscriptions, budgets, and self-funding**. This prompt is self-contained: the feature definitions and retained implementation
constraints have already been extracted and reconciled into the final specification below.
Do not seek or cite external design context. Repository code is evidence of current
state, not evidence that a requirement is complete.

## Non-negotiable production rules

- Trace and use the real router → authorization → worker/Durable Object → scoped persistence or
  binding → shell path. A helper, type, schema, comment, standalone endpoint, mock, or UI placeholder
  is not an implementation.
- Scope durable state and cache/index keys by every applicable tenant, space, project, invoker/user,
  actor, extension/gadget, and policy version. Conceal inaccessible private resources exactly like
  absent resources. Security-sensitive resolution fails closed.
- Reauthorize immediately before external side effects, artifact commits, merges, connector calls,
  workflow dispatch, and sibling-project calls. Preserve the original human invoker through every
  delegation and background boundary.
- Add migrations and identical development/staging/production Wrangler bindings, service bindings,
  queues, workflows, R2/KV/Vectorize/Analytics resources, secrets documentation, rotations,
  backfills, limits, alarms, and rollback behavior required by the feature.
- Add the real shell experience where applicable, including loading, empty, error, unauthorized,
  offline/reconnecting, spectator/frozen, air-gapped, and completed states. Treat model and source
  data as untrusted; never execute supplied HTML, JavaScript, URLs, or expressions.
- Add contract, isolation, race, replay, expiry, crash/hibernation, fail-closed, and router-to-worker
  journeys using realistic Cloudflare behavior. Success-only mocks may not replace authorization,
  transactions, bindings, namespace isolation, alarms, WebSockets, or Workflow behavior.
- Update the requirements trace matrix only after verification. Mark an item IMPLEMENTED only when
  every required production boundary and meaningful integration/E2E evidence exists.

## Final resolved implementation specification

## Newest cross-cutting architectural delta (overrides conflicts)

# AVOS Evolutionary Architectural Changelog

This is the authoritative architectural delta for plan items 1–130. These decisions postdate the source trails and `CLAUDE.md`; they override conflicts while retaining compatible implementation detail.

## Final reconciled upgrades

1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wins; all competitors receive abort signals immediately and only the winner enters the ordinary authorized merge path.
6. **Three-depth ceiling.** Depth 1 is the lead, depth 2 a domain sub-planner, and depth 3 a leaf executor. Depth-3 runtimes do not receive any delegation capability, making depth 4 structurally impossible.
7. **Five credit defenses.** Enforce model tiering by depth, up-front task escrow, plan-based parallelism, early-exit token reclaim, and daily personal budget envelopes. Starter executes sequentially; higher plans may enable races.
8. **Shared-space collision defense.** Combine 15-minute atomic task leases, sibling spectator mode, >0.85 intent deduplication, and sponsor-conflict RFC freezes in authoritative `SpaceDO` storage.
9. **Immutable kernel, userspace extensions.** Extensions may add manuals, virtual CLIs, daemons, and viewports but cannot replace the agent loop, bypass Gatekeepers or WriteGuard, or commit unreviewed code to `main`.
10. **Durable daemons.** Pair project-scoped DO-facet SQLite state with resumable Workflows for AST indexing, finance reconciliation, and legal citation graphs. Daemons consume no active-chat CPU/tokens and expose approved project MCP tools only.
11. **Dual-role workflows.** Dynamic Workflows support both ephemeral AI tasks and project-owned company automations. Deterministic steps remain deterministic and AI is invoked only for declared semantic work.
12. **No-code subagent studio.** The shell builds declarative `NoCodeSubagentManifest` documents from authorized tools, skills, knowledge, and triggers; a precompiled `GenericSubagentWorkflow` executes them. Creators cannot grant permissions above their current role.
13. **Logical connector aliases.** Code names semantic aliases such as `inbound_mail`; `SpaceDO` maps them to physical accounts. Rebinding never changes project source.
14. **Pluggable `primary_calendar`.** Calendar access is a space-shared MCP connector supporting Google, Microsoft, CalDAV, or scoped SQLite fallback. Voice booking acquires a 15-second `ConcurrencyDO` slot hold before external calls.
15. **Dual-plane customer bots.** Public WhatsApp, Telegram, and voice traffic reaches quarantined ephemeral Workflow agents with `CustomerBotContext`, never internal project agents. Customer contexts have no Bash, file mutation, Git Artifact, or internal-vault capability.
16. **Automation failure defenses.** Production ingress includes KV tombstones, Queue buffering, 14-day R2 replay, a 5 req/s leaky-bucket pacer, SHA-256 idempotency, `x-avos-hop-count` recursion breaking, and lenient validated adapters. The remaining defenses already specified by the relevant plan items remain mandatory.
17. **Deliverable canvas.** `/workspace/` versions every deliverable type, including code, documents, spreadsheets, and data; executable agent machinery remains under Git-ignored `/.avos/`. Review cards render type-aware diffs while bytes remain authoritative.
18. **Strict UI bifurcation.** `apps/shell` is an Apple-clean client workspace with an 85% canvas, command bar, and one-click outcomes, with no model, compute-tier, or raw merge controls. `apps/partner-studio` is the technical foundry for ladder ceilings, daemons, workflows, and blueprint packaging.

## Supersession rule

Apply this delta after each item's complete Origin & Transition trail. If it conflicts with an earlier plan statement, this file wins. If it is silent, retain the earlier final decision. All authorization, tenant isolation, fail-closed policy, provenance, billing, deployment parity, and realistic end-to-end verification requirements remain in force.


### 112. Standardized Credit Metering (1 Credit = $0.01 USD)

**Final behavior:** Unified consumption currency across tokens, containers, browser sessions, and phone minutes.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- Required Fix: Build NaelaoKPIDO: daily CF Workflow aggregates Analytics Engine data across all Spaces into platform_daily_kpis(date, total_dau, total_mau, active_spaces, total_sessions, total_tokens, total_revenue_usd, new_builder_signups, active_builders). Compute DAU/MAU ratio (engagement metric). Store in D1 for SQL querying. Build internal leadership dashboard at internal.naelao.dev/kpis (CF Access protected). Charts: 7-day rolling metrics, week-over-week growth rate, top 100 Spaces by session count. Alerts: DAU drops >10% WoW → Slack alert to leadership. Export weekly KPI report email to leadership team every Monday 9am.
- `NaelaoAgentDO.enforceRunGates`'s existing `BUILDER_CALLER_ROLES` branch (the builder-chatting-
with-their-own-Space-Assistant scope — P0-3's exact scoping, re-used verbatim) now ALSO checks the
new infra-credits quota alongside the pre-existing llm-tokens one, same fail-open-on-transient-
error / 402-`error_code: "infra_quota_exceeded"`-on-confirmed-over-cap posture. **Deliberately NOT
extended to project-scoped or signed-in-product-end-user runs** — those already have their own
separate wallet/project-spend-cap/credit-balance gates (project_spend, ProductUserDO credits),
which are a fundamentally different metering axis (currency-like spend) from this one (a resource-
consumption ceiling);
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- ### How Resources Consume Credits:
```
┌──────────────────────────────────────┬────────────────────────┬─────────────────────────────────────────────┐
│ Resource Category                    │ Metered Rate           │ Billing Mechanism                           │
├──────────────────────────────────────┼────────────────────────┼─────────────────────────────────────────────┤
│ **LLM Tokens (Non-BYOK)**            │ Cost + 15% margin      │ `tokensToCredits(input, output, model)`     │
│ **BYOK (Bring Your Own Key)**        │ **$0.00 / Token**      │ Zero token markup (Billed direct by vendor) │
├──────────────────────────────────────┼────────────────────────┼─────────────────────────────────────────────┤
│ **Tier 1: SQLite Virtual FS**        │ Free / Included        │ Sub-ms in DO storage                        │
│ **Tier 2: V8 Isolate CodeMode**      │ 1 Credit per 100 runs  │ `$0.0001 /

### 113. Unified SaaS Subscription Plans

**Final behavior:** Transparent capacity tiers: Free ($0/mo BYOK), Starter ($29/mo, 1,200 credits), Pro ($99–$150/mo, 4,500 credits), Enterprise ($299+/mo, dedicated pools).

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- The Gap Builders need to choose their product's billing strategy — flat subscription, usage-based credits, per-seat, or a team plan inside a SaaS. The spec offers only fixed platform tiers (free–enterprise) and a credit model, with no per-product strategy configuration, so a builder cannot price their product the way their market expects.
- Alongside the existing Tavily-backed `web-search` prebuilt (item 42/§A1.x, unchanged — still the
only option for raw structured search results with no LLM in the loop), Phase 2 adds a second,
genuinely different mechanism: Anthropic's native, server-executed `web_search` tool, proxied
transparently by Cloudflare AI Gateway. Per Cloudflare's own docs
(https://developers.cloudflare.com/ai-gateway/usage/web-search/), this is NOT a Cloudflare-owned
search index — the gateway passes the model provider's own native tool through, applying its
standard logging/caching/guardrails, and **bills it through the same Unified Billing as the rest
of the LLM call, with no separate web-search fee**. This is t
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- # 2. Stream 1: The SaaS Subscription Tiers
```
┌───────────────────────────────┬──────────────┬───────────────────────────────┬──────────────────────────────────────────┐
│ Plan Tier                     │ Price        │ Included Workspaces & Limits  │ Unlocked Features & Capabilities         │
├───────────────────────────────┼──────────────┼───────────────────────────────┼──────────────────────────────────────────┤
│ **1. Free Tier (Hacker)**     │ **$0 / mo**  │ • 1 Business Workspace        │ • BYOK Only (Anthropic, Gemini, Groq)    │
│ *(Top-of-Funnel Viral Onramp)*│              │ • 1 Project / 3 Threads       │ • Tier 1 SQLite FS + Tier 2 Isolates     │
├───────────────────────────────┼──────────────┼───────────────────────────────┼──────────────────────────────────────────┤
│ **2. Starter (Solo Builder)** │ **$29 / mo** │ • 3 Business Workspaces       │ • Includes $10/mo compute al

### 114. Per-User Daily Budget Envelopes (`space_user_budget_envelopes`)

**Final behavior:** Enforces daily compute allowances per employee assistant (e.g. $5.00/day max) to prevent tragedy of the commons in shared spaces.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- 141. **The six items item 140 explicitly left open are now BUILT — Phase 1 of the 62-item batch is
     complete.** `thread.create` (the assistant's own `project-coordination` prebuilt) minted a
     `threads` row with no `session_id` — the exact bug behind "Session not found" on any
     assistant-created thread. It now also mints and links a real session (generating the thread's
     own id client-side so the link can point at it, then `POST /sessions {thread_id}`), matching
     the shape a human's own "New thread" already produces; degrades to returning the bare thread
     (still real, still usable via a later open) rather than throwing if the session-link call
     itself fails. The SA
- Required Fix: A new GET /spaces/:productSpaceId/portfolio route (spaces worker, gated exactly like my-businesses — identity-only at the router, real per-business membership check server-side) aggregates, per business the caller is a member of: wallet balance (from the existing business_wallet data, item 50), a revenue trend (reusing agent_activity_log /usage rollups where available, honestly nulled where not — matching the platform's own "never fabricate an aggregate" precedent from item 30 Phase 3/5), space_status, and a computed attention_score (a simple, explainable heuristic — days since last assistant activity, any pending HITL approval, any agent.session_budget_warning fired recently,
- **Time-based scheduling (spec §05 "cron-jobs.json — the assistant's schedule of recurring
tasks").** The no-code, TIME-driven counterpart to event_triggers:
- `scheduled_jobs` (new PLATFORM_DB table, `infra/migrations/0041_scheduled_jobs.sql`) — lives
  in platform D1 rather than per-space SpaceDO SQLite, for the same reason `channel_links`
  does: the hourly dispatcher needs one cheap cross-space query to find everything due, rather
  than waking every space's DO to ask "do you have anything due."
- A dependency-free 5-field cron matcher in `@naelao/events`
  (`parseCronExpression`/`cronMatchesDate`/`isCronDue`/`validateCronExpression`) — `*`, literal
  numbers, comma lists, ranges, `/step`
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi

### 115. Self-Funding Autonomous Business Loop

**Final behavior:** Storefront sales settle into `wallet_ledger`; compute expenses deduct automatically; owners withdraw net profits with one click.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- Required Fix (DEFERRED — a scoping statement for a future phase): When this is eventually built, it is its OWN SpaceType ( personal-assistant , membership_model: "team" -shaped since there is exactly one real owner per instance, no business-switcher concept) with its own Product Shell skin — not a mode of Launchpad, and not a rename of the existing generic Space Assistant (item 20's SPACE_ASSISTANT_PROFILE ), which is scoped to operate WITHIN one space, not across a person's whole life and portfolio. The reason to sequence it last is architectural honesty, not lack of ambition: it needs the established specification's portfolio/delegation primitives to already exist and be trustworthy before a personal assist
- Why Whop, not Stripe/Lemon Squeezy (researched before building, not assumed): Whop is a
registered payment facilitator that supports programmatic SUB-MERCHANT enrollment (create an
isolated company per business via API, no per-business OAuth flow) and a programmatic WITHDRAWAL
API (241+ territories, bank/crypto/Venmo/CashApp) — the same custody shape Stripe Connect's
Express accounts have (Whop, like Stripe, holds the money and runs payout compliance; Naelao's
integration surface is provisioning, balance/status reads, and withdrawal requests only), but
`createSubMerchant` doesn't require the builder to click through a hosted onboarding page first —
it can be called automatically the instant
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- # 5. The Self-Funding Autonomous Business Loop
This is how an **AI-operated business pays for its own infrastructure** without the owner manually topping up cards:
```
[ Customer books a $500 WebDev project or $150 Cowork subscription ]
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. PAYMENT SETTLEMENT (Stripe Connect / Whop / Lemon Squeezy)               │
│    • Gross Sale: +$150.00                                                   │
│    • Platform Fee (5%): -$7.50                                              │
│    • Net Settles to `SpaceDO.wallet_ledger`: **+$142.50**                   │
├─────────────────────────────────────────────────────────────────────────────┤
│ 2. AUTONOMOUS EXPENSE DEBITS (Real-Time Background Execution)               │
│    • Dev Agent runs Tier 6 Containe

## Required execution and response

1. Convert every numbered specification above into a file/request-path checklist before editing.
2. Implement in dependency order and reuse canonical workers/DOs rather than parallel helpers.
3. Return complete apply-ready unified diffs for every changed, created, or deleted file. Do not use
   ellipses, pseudo-code, TODO-only stubs, omitted boilerplate, or comments standing in for code.
4. Include exact migration, provisioning, secret rotation, rollout/backfill, rollback, and staging
   smoke commands.
5. Include exact test/typecheck/config-parity commands and the security/race assertions they prove.
6. Finish with an item-by-item release ledger: IMPLEMENTED, PARTIAL, or MISSING with honest gaps.

For automation, put exactly one machine-readable line before the first diff:
`PHASE_STATUS: CONTINUE` when another implementation turn is required, or
`PHASE_STATUS: COMPLETE` only when every numbered item and verification boundary is finished.
Place all prose after the diff or in a separate `PHASE_NOTES` section. A COMPLETE response with no
apply-ready diff is valid only when the current branch already satisfies and verifies every item.

Do not silently omit an item. If one response cannot hold the implementation, stop only after an
atomic, testable commit boundary and return a continuation prompt containing the remaining numbered
specifications and current verification state. Never claim completion because code merely compiles.
