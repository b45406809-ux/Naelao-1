# AI Studio implementation prompt — batch 25, plan items 120–124

## Mission

Implement every requirement below end to end on the current accumulator branch. The cohesive focus
is **Marketplace recipes, tiers, pricing, and attribution**. This prompt is self-contained: the feature definitions and retained implementation
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


### 120. Prebuilt Automation Recipe Marketplace

**Final behavior:** Turnkey operational recipes bundling Webhooks $\rightarrow$ Queues $\rightarrow$ Workflows $\rightarrow$ Gadgets (e.g. Shopify-to-ShipStation).

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- ## Additional Infrastructure Built
- [x] Terraform IaC (cloudflare/cloudflare ~4.45, all KV/R2/D1/Queues/Vectorize/Pages resources)
- [x] GitHub Actions CI/CD (ci, bundle-check, pr-checks, deploy-staging, deploy-prod)
- [x] D1 migrations 0001-0028 (all tables including marketplace, threads, eval, artifacts, gdpr, etc.)
- [x] apps/widget/ (zero-dependency web component, SSE streaming, < 10KB gzip target)
- [x] apps/marketplace-web/ (SpaceType discovery, categories, listing detail, fork flow)
- [x] All 14 packages: types, auth, db, http, rag, security, llm-gateway, config, crypto, logger, tracing, idempotency, webhooks, analytics-schema, entitlements, tool-runtime, billing-core, moderation, te
- The Gap: Builders who want to automate workflows (when Space conversation ends → update CRM, when user asks about pricing → create Salesforce lead) must write custom code. No native Zapier or Make.com (formerly Integromat) integration exists. This blocks non-technical builders from automation.
 Required Fix: Build native Zapier integration: create Naelao Zapier app (published in Zapier app marketplace). Triggers: "New conversation", "Conversation ended", "Agent tool called", "End-user signed up". Actions: "Run agent with input", "Add KB document", "Create Space". Auth via OAuth 2.0 (G-AQ32). Zapier app definition is a JSON manifest deployed to Zapier CLI. Similarly for Make.com: define HTTP
- **Remaining (documented, not dropped):** per-user MCP credentials (I2b), the `space_credits` sink
for builder-owned runs (part of I3), and Phases J (Workflows tier), K (per-project R2-mounted
container), N (Launchpad operator-shell UI + cleanup), L (Container Marketplace), M
(local-machine-as-container) — see the session's plan file for the full roadmap.
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi

### 121. Prebuilt Customer Service Automation Marketplace

**Final behavior:** Ready-to-use customer support subagent recipes (Dental Booking, Shopify Returns, Hotel Concierge) deployed into `customer_bot` projects.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- 151. **A new 28-step goal batch (Google Drive `new/goal 1.txt`) is IN PROGRESS — the first
     tranche (steps 2, 3, 8, 9, 10, 12, 13a, 14, 19, 24) is BUILT, tested, and deployed.** The
     authoritative list is the user's Drive file (28 steps, item 1 = a Claude-Code-style
     context-window breakdown UI for the Stats tab; the finale = 6 business templates + business-
     wide BYOK). Shipped so far:
     - **Step 10 (spawn/consult model+agent validation):** `agent.spawn` validates each task's
       model against `ALLOWED_MODELS` before delegating — a wrong id gets a real "did you mean"
       (new `billing-core` `suggestModels`) instead of a silent escalation-clamp (which read as a

- Required Fix: Three feedback channels, each reusing existing infrastructure rather than inventing new ingress: (1) the existing multi-channel gateway (Slack/Discord/email/WhatsApp, item 11 of the established architecture) already lets a customer-bot project ingest a support channel — an operator project subscribes its PM agent to the SAME channel catalogue, tagged feedback_source instead of support_source ; (2) a new product-analytics prebuilt script reads the operator's OWN deployed product's event stream (via a builder-supplied read-only analytics connector — PostHog/Amplitude/Mixpanel MCP servers already fit the existing mcp-connector pattern, BYO-key per the universal-tools doctrine's own carve-out for a b
- **Templates declare the binding as data.** `TemplateProjectSeed` (`launchpad/spacetype.ts`) lets
a template's `bootstrap.projects` entry be either a plain string (an unbound, reference-only
project — e.g. "Products", "Members", "FAQ": nothing runs there automatically) or
`{ name, default_agent_id }`. Every template that installs a fulfillment/support/content agent
now seeds a project bound to it: creator-store (Orders→fulfillment, Support→support),
newsletter-business (Content→content, Orders→fulfillment), micro-saas (Support→support,
Orders→fulfillment), service-agency (Deliverables→content, Client Communication→support),
coaching-community (Member Questions→support, Learning Materials→cont
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi

### 122. 2-Tier Developer Marketplace

**Final behavior:** Tier 1: Freemium Tiered SaaS Templates ($0 install, recurring subscription split). Tier 2: Fixed One-Off Licenses ($49–$499 buy-out).

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- 58. **Whop added as a second PLATFORM billing provider (AUDIT_TODO.md AI-7), replacing Lemon
    Squeezy as the FIRST-TRIED provider for builder platform plans and end-user subscriptions/
    credit-packs — LS stays as the fallback, item 45 is not reverted.** Trigger: the operator
    couldn't activate a Lemon Squeezy store because LS's own onboarding requires a Stripe-linked
    payout path unavailable in their country. Two genuinely different Whop relationships were
    built, neither the same as the invite-gated Platforms API (items 50-51, business-wallet
    sub-merchants) or the read-only "Connect with Whop" OAuth connector (item 53):
    - **Platform-plan checkout** (`packages/billing-
- Required Fix Build a Template Marketplace at developers.naelao.com/templates: (1) templates are published by submitting a manifest JSON via POST /marketplace/templates (requires publisher account), (2) each listing has title, description, preview_url, screenshots, Space Type compatibility, rating, install_count, (3) a "Use this template" CTA creates a new space with the template pre-applied, (4) full-text search (Vectorize + BM25) over template metadata, (5) a review system (1-5 stars + text review) with moderation. Platform curates a "Featured" collection. Revenue share: paid templates (optional) split 80% publisher / 20% platform.
- **Item 52 (BYO connector):** a business owner connects their OWN normal Whop account (an API key
from their own dashboard, no invite needed — a completely different, always-available Whop
mechanism from the Platforms API) so the assistant can read it via the existing `mcp-connector`
prebuilt, with Naelao's revenue-share cut billed via the pre-existing `revenue-tracker` surcharge
mechanism (charged on the builder's next platform subscription, not auto-split at checkout — a
BYO account has no application-fee-split primitive). The dashboard's `/connectors/*` connect
route already did the store-credential + register-MCP-server work, but only checked
`requireVerifiedTenant` (proves SOME verified
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi

### 123. Mutual Exclusivity Marketplace Pricing Rule

**Final behavior:** Freemium templates must be $0 upfront with feature gating across plans. Fixed-price templates must unlock all features permanently.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- // Temple: LexSpace — full configuration
const TEMPLE_LEXSPACE: Temple = {
 id: 'temple-lexspace-v1',
 name: 'LexSpace',
 tagline: 'AI legal research and drafting — compliance-first',
 category: 'vertical-legal',
 spaceType: 'verticals',
 suggestedPricing: { type: 'seats', pricePerSeat: 15000, trialDays: 0 }, // $150/seat/month
 defaultAuthProvider: 'saml-sso',
 productConfig: {
 allowPublicSignup: false,
 requireAdminApproval: true,
 featureFlags: {
 'matter-management': true,
 'immutable-audit-trail': true,
 'citation-verification': true,
 'document-compare': true,
 'privilege-log-generator': true,
 },
 userPermissions: {
 canCreateProjects: true, // Matters = projects
 canCreateSubSpaces:
- **Phase 1 — DONE.** Migration `0044_naelao_product.sql` adds only two genuinely new,
cross-space-queryable columns to `spaces` — `product_slug` (unique platform-subdomain identity,
partial unique index excluding NULL) and `conversation_access_approved_by`/`_at` (the spec's
legally-gated conversation-log-access approval, which Naelao staff need to query across every
space for the platform-wide approval queue). Everything else from the spec's ~20-field
NaelaoProduct list — branding, auth provider config, pricing, sub-space terminology/depth
display, admin features, per-product feature flags — extends `SpaceTypeProductConfig`
(`workers/spaces/src/do/SpaceTypeRegistryDO.ts`) instead: new optiona
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- ### 6. The Publishing Guard in the Partner Studio
In `apps/shell`, the publishing form enforces the mutual exclusivity rule automatically:
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 🚀 PUBLISH TEMPLATE TO MARKETPLACE                                          │
├─────────────────────────────────────────────────────────────────────────────┤
│ Choose your Distribution & Monetization Strategy:                           │
│                                                                             │
│ (x) 🔄 Tiered SaaS Template (Freemium)                                      │
│     • Upfront Template Price: **$0.00 (Free to Install)**                   │
│     • Configure what features unlock at $20, $50, and $150 plans.           │
│     • You earn 40% recurring lifetime commissions on $150 upgrades.         │
│

### 124. Attribution-Based Commission Split

**Final behavior:** Developer Direct Referrals earn 40% recurring; Organic Marketplace sales earn 20% recurring; Fixed Buy-Outs earn 100% upfront.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- 111. **The re-fire confirmed item 110's model fix AND exposed the next layer: a model mistyping a
     script name killed the entire run.** The 15:00 sweep ran the job at 15:02:24 UTC with no
     `Model not found` — the 404 is genuinely gone. It failed for a completely different reason:
     `{"error":"Invalid script name: \"notifications prebuilt\""}`, `consecutive_failures: 1`. The
     model chose to run the `notifications` prebuilt by its **descriptive phrase** instead of one
     of its real operation names, and `SkillLibrary.read()`/`exists()` asserted the name was a safe
     path segment and **threw**. That throw escaped `ScriptToolSurface.run()`'s per-step error
     handling entir
- The Gap When an end-user makes a payment on a builder's product that uses a paid marketplace app (e.g., an AI writing app built by a third-party developer), three parties are entitled to revenue: the platform (infrastructure fee), the builder (product owner), and the app developer (component creator). The spec records revenue_share percentages in the registry_earnings table but never executes automated splits or payout transfers. The split calculation is never applied, and neither the builder nor the app developer receives their earned share.
- **`apps/shell`** — new Next.js 14 app (same tooling as `apps/dashboard`: `next-on-pages`, plain
`tsc --noEmit` typecheck, no Tailwind — consumes `@naelao/ui`'s CSS directly via
`transpilePackages`). Product resolution is path-based: `/p/[slug]`. `lib/api.ts` and
`lib/productAccount.ts` port `apps/portal`'s proven hybrid-auth pattern verbatim (Bearer `nps_...`
+ `x-naelao-end-user-id`, per-`spaceId` localStorage session keys) — a person can be signed into
several different builder products in the same browser. `lib/auth-provider.tsx`
(`ProductAuthProvider`/`useProductAuth`) is built with an **`isHydrated` tri-state from day one**:
no consumer may redirect on `isAuthenticated` until `isHydrate
- ### Summary of What This Creates
1. **Zero Content Bottleneck:** You don't have to build 500 vertical templates. The community will build them for law, medicine, real estate, accounting, and crypto.
2. **Organic User Acquisition:** Template creators will actively promote their templates to their own networks to earn recurring 80% royalties, driving thousands of new users directly to your platform.
3. **Compounding Platform Revenue:** You earn **20% of all template sales** plus recurring infrastructure and compute margins on every single business running on your Cloudflare edge network.

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
