# AI Studio implementation prompt — batch 13, plan items 120–130

## Mission

Implement every requirement below end to end on the current accumulator branch. The cohesive focus
is **Recipes, marketplace economics, partner distribution, and market radar**. This prompt is self-contained: the feature definitions and retained implementation
constraints have already been extracted and reconciled into the final specification below.
Do not seek or cite external design context. Repository code is evidence of current
state, not evidence that a requirement is complete.

When present, the **Final reconciled architectural changes** section is the newest authority in
this prompt. Where it updates or replaces a numbered plan requirement or retained constraint,
implement the new architecture and do not preserve the superseded behavior for compatibility.

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
- [x] All 14 packages: types, auth, db, http, rag, security, llm-gateway, config, crypto, logger, tracing, idempotency, webhooks, analytics-schema, entitlements, tool-runtime, billing-core, moderation, testing, client-sdk, agent-sdk
- The Gap: Builders who want to automate workflows (when Space conversation ends → update CRM, when user asks about pricing → create Salesforce lead) must write custom code. No native Zapier or Make.com (formerly Integromat) integration exists. This blocks non-technical builders from automation.
 Required Fix: Build native Zapier integration: create Naelao Zapier app (published in Zapier app marketplace). Triggers: "New conversation", "Conversation ended", "Agent tool called", "End-user signed up". Actions: "Run agent with input", "Add KB document", "Create Space". Auth via OAuth 2.0 (G-AQ32). Zapier app definition is a JSON manifest deployed to Zapier CLI. Similarly for Make.com: define HTTP module with Naelao API endpoints. Publish webhook subscription endpoint: POST /webhooks/zapier/subscribe stores callback URL in WebhookSubscriptionDO.
- **Remaining (documented, not dropped):** per-user MCP credentials (I2b), the `space_credits` sink
for builder-owned runs (part of I3), and Phases J (Workflows tier), K (per-project R2-mounted
container), N (Launchpad operator-shell UI + cleanup), L (Container Marketplace), M
(local-machine-as-container) — see the session's plan file for the full roadmap.

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
       misleading "too expensive") or a bare provider 404. `thread.consult`/`thread.send_message`
       validate `agent_id` (and model) up front with did-you-mean over the project's agents.
     - **Step 8 (project model/agent listing):** new `thread.list_project_models` +
       `thread.list_project_agents` on the `project-coordination` prebuilt; the agent listing
       ALWAYS includes the general Space Assistant (`naelao-agent`) so a brand-new project still
       shows a real, addressable target. Both auto-approved reads.
     - **Step 9 (tool-result pagination):** generic size-guard in `ScriptToolSurface.run()` —
       `applyToolResultLimit` (exported, tested) pages the primary list of an oversized (or
       explicitly `limit`/`offset`-ed) result in place with a `_pagination` note carrying the true
       total + next-page instruction, or truncates a non-list blob with guidance. Small results
       stay byte-identical.
     - **Step 3 (chunked file read/search):** `read_file` gains `offset`/`length` ranged reads
       (`has_more`/`next_offset` paging) so a file over the single-read cap is read a slice at a
       time; new `search_file` returns matching lines with line numbers + optional context without
       pulling the whole file. paramHints added for every `r2-workspace` op.
     - **Step 12 (self-scheduling / background-task wake):** new `schedule` prebuilt
       (`schedule.wake_me`/`list`/`cancel`) lets an agent wake ITSELF later with a follow-up goal
       — the "set a cron trigger to check back on a background task" pattern. Built on the existing
       goal-based `scheduled_jobs` dispatcher; a delay-based wake is one-shot (`params._one_shot`,
       which the dispatcher now disables after firing), a `cron` wake recurs. Granularity is the
       hourly he
- Required Fix: Three feedback channels, each reusing existing infrastructure rather than inventing new ingress: (1) the existing multi-channel gateway (Slack/Discord/email/WhatsApp, item 11 of the established architecture) already lets a customer-bot project ingest a support channel — an operator project subscribes its PM agent to the SAME channel catalogue, tagged feedback_source instead of support_source ; (2) a new product-analytics prebuilt script reads the operator's OWN deployed product's event stream (via a builder-supplied read-only analytics connector — PostHog/Amplitude/Mixpanel MCP servers already fit the existing mcp-connector pattern, BYO-key per the universal-tools doctrine's own carve-out for a builder's own accounts, G-BF01); (3) a periodic pm.mine_feedback skill runs on a scheduled job (the existing scheduled_jobs primitive, item 20) that clusters raw feedback text by embedding similarity (Vectorize, the same primitive KB search and script.find already use) into named PATTERNS before it ever reaches the reasoning loop — "47 raw complaints" becomes "1 pattern: dashboard load time" as a distilled input, not a wall of text the model has to notice a pattern in itself.
- **Templates declare the binding as data.** `TemplateProjectSeed` (`launchpad/spacetype.ts`) lets
a template's `bootstrap.projects` entry be either a plain string (an unbound, reference-only
project — e.g. "Products", "Members", "FAQ": nothing runs there automatically) or
`{ name, default_agent_id }`. Every template that installs a fulfillment/support/content agent
now seeds a project bound to it: creator-store (Orders→fulfillment, Support→support),
newsletter-business (Content→content, Orders→fulfillment), micro-saas (Support→support,
Orders→fulfillment), service-agency (Deliverables→content, Client Communication→support),
coaching-community (Member Questions→support, Learning Materials→content), whop-seller
(Support→support, Content→content), customer-service (Inbox→support; Escalations/FAQ stay
unbound — human-review and reference surfaces, not agent-run). `validateLaunchpadSpaceType`
fails fast if a project's `default_agent_id` isn't one of that same template's own `agents`.

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
    - **Platform-plan checkout** (`packages/billing-core/src/providers/whop-platform-plan.ts`):
      Naelao's OWN normal Whop seller/company account (`WHOP_API_KEY` — no invite needed, the
      same relationship any Whop creator has) sells the builder Growth/Business plans directly.
      `/billing/checkout` tries Whop first, falls back to LS, then the dev placeholder;
      `/billing/portal` returns Whop's fixed self-serve orders page (`whop.com/orders/` — Whop
      has no API-mintable per-customer portal session the way Stripe/LS do) when the org's
      subscription is Whop-backed. New `POST /webhooks/whop-platform-plan` (Naelao's OWN
      company's webhook, a DIFFERENT secret than the sub-merchant wallet's `WHOP_WEBHOOK_SECRET`)
      parses `membership.went_valid`/`went_invalid`/`payment.succeeded` into the SAME
      `NormalizedBillingEvent` shape LS already produces — `NormalizedBillingEvent.provider`
      widened to `"lemon_squeezy" | "whop"` and `recordPlatformPlanSubscription` (unchanged
      logic) now branches only on which id-columns to write (migration 0067 adds
      `subscriptions.whop_customer_id`/`whop_subscription_id`, `ls_*` columns untouched — same
      "no cheap DROP COLUMN" precedent 0062 set for Stripe→LS).
    - **End-user OAuth-delegated checkout** (`whop-oauth-checkout.ts` + `workers/billing/src/
      whop-oauth-billing.ts`): `/internal/business-subscriptions/checkout` and `/internal/
      credit-packs/checkout` now try the BUSINESS's own connected Whop company first (via the
      existing "Connect with Whop" OAuth token, vaulted under `WHOP_OAUTH_TOKENS`) before falling
      back to LS. Settles 100% into that business's own Whop balance — there's no payment-split
      primitive on a normal OAuth token, so Naelao's cut is NOT auto-split at checkout; it
      reaches the ledger via t
- Required Fix Build a Template Marketplace at developers.naelao.com/templates: (1) templates are published by submitting a manifest JSON via POST /marketplace/templates (requires publisher account), (2) each listing has title, description, preview_url, screenshots, Space Type compatibility, rating, install_count, (3) a "Use this template" CTA creates a new space with the template pre-applied, (4) full-text search (Vectorize + BM25) over template metadata, (5) a review system (1-5 stars + text review) with moderation. Platform curates a "Featured" collection. Revenue share: paid templates (optional) split 80% publisher / 20% platform.
- **Item 52 (BYO connector):** a business owner connects their OWN normal Whop account (an API key
from their own dashboard, no invite needed — a completely different, always-available Whop
mechanism from the Platforms API) so the assistant can read it via the existing `mcp-connector`
prebuilt, with Naelao's revenue-share cut billed via the pre-existing `revenue-tracker` surcharge
mechanism (charged on the builder's next platform subscription, not auto-split at checkout — a
BYO account has no application-fee-split primitive). The dashboard's `/connectors/*` connect
route already did the store-credential + register-MCP-server work, but only checked
`requireVerifiedTenant` (proves SOME verified tenant, never that it owns the specific `space_id`
in the body) — safe for a builder (their tenant owns every space they have) but not for a
product end user, whose session tenant is the PRODUCT root spanning every business under it. New
spaces-worker wrapper routes (`GET /spaces/:spaceId/connectors/status`,
`POST /spaces/:spaceId/connectors/connect`) close that gap with `requireBusinessMembership`
before proxying to the agents worker's already-tested logic. Reproduced (and fixed, the
established way) the documented Hono router-table-scale corruption: a
`POST /spaces/:spaceId/connectors/:platform/connect` shape silently 404'd 8 unrelated tests
elsewhere in the file; fixed by moving `platform` into the request body instead of a URL param.

### 123. Mutual Exclusivity Marketplace Pricing Rule

**Final behavior:** Freemium templates must be $0 upfront with feature gating across plans. Fixed-price templates must unlock all features permanently.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- 140. **A ~62-item batch of live-use asks was planned and phased; Phase 1 (bug sweep + chat
     fidelity) is BUILT and deployed. Three of the reported "missing features" turned out to be
     DEAD CSS waiting for a component, and writing the test for one bug exposed a second, worse
     one underneath it.** Full plan (all 6 phases, decisions, deferred items):
     `/root/.claude/plans/gleaming-scribbling-pelican.md`; the user's own answers set the
     sequencing (bug sweep first), the billing model (hybrid personal-plan + business-subscription),
     channel scoping (both scopes, kind-gated UI) and project automations (build on
     `scheduled_jobs`/`event_triggers`, don't fork a second engine).
     - **Markdown never existed anywhere in chat.** Every bubble rendered its content as a raw
       React text child, so an assistant reply arrived with its `**bold**`, `- bullets` and ```
       fences intact as literal characters — while `packages/ui/src/styles.css` had been carrying
       finished styles for `.bubble p/ul/strong/em/pre/code` the whole time with nothing ever
       emitting those elements. New `apps/shell/src/components/Markdown.tsx` uses `react-markdown`
       + `remark-gfm`, chosen over `marked`/`showdown` for one reason that matters here: it builds
       React elements and never touches `dangerouslySetInnerHTML`, and an agent in this product
       renders web-fetched pages, customer email and connector output into these bubbles.
       `rehype-raw` is deliberately NOT installed, so inline HTML in markdown stays inert text.
       Wired through `RevealText`'s revealed substring (new opt-in `markdown` prop) so the reveal
       animation is untouched; an unclosed construct mid-reveal reads as literal text for a frame.
       The USER's own message stays literal — they typed it — and `.bubble.user` gained
       `white-space:pre-wrap`, which it never had, so their line breaks survive at all.
     - **`.msg-actions`/`.msg-action`/`.msg-action .tooltip` + `.msg-row:hover` were ALSO already
       styled and used by no component.** The only affordance was a permanently-visible text
       "Edit" button on one message. New `MessageActions.tsx` wires the existing styles: copy on
       every bubble, edit only on the last user message, both icons. `:hover` never fires on a
       tap, so a `.revealed` class set on tap reveals the row on touch rather than making it
       always-visible there (which would put two buttons under every message in a
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
 canCreateSubSpaces: true, // Practice groups = sub-spaces
 canUploadKnowledge: true,
 maxThreadsPerUser: null,
 },
 adminFeatures: {
 conversationLogAccess: true, // Required for regulatory compliance — pre-flagged for Naelao approval
 auditLogAccess: true,
 knowledgeBaseManagement: true,
 },
 subSpaceTerminology: 'practice groups',
 },
 agentBundle: [
 {
 agentId: 'legal-researcher-v1',
 required: true,
 configOverrides: {
 systemPromptAddendum: 'Always cite primary sources. Never cite secondary summaries without the primary. Flag any jurisdiction ambiguity explicitly. All legal citations must follow Bluebook format.',
 },
 },
 {
 agentId: 'legal-drafter-v1',
 required: true,
 configOverrides: {
 requiresApprovalFor: ['document_finalise', 'client_send'],
 },
 },
 {
 agentId: 'privilege-checker-v1',
 required: false, // Optional — activated if firm handles litigation
 configOverrides: {},
 },
 ],
 knowledgeSchema: [
 { documentType: 'jurisdiction_guides', required: true, description: 'Upload court rules and jurisdiction-specific procedural guides', exampleUrl: 'https://docs.naelao.app/templates/lexspace-jurisdiction-guide' },
 { documentType: 'firm_precedents', required: false, description: 'Past briefs and contracts the agents can reference as style guides', exampleUrl: null },
 { documentType: 'client_intake_forms', required: false, description: 'Standard client intake templates auto-populated by the intake agent', exampleUrl: 'https://docs.naelao.app/templates/lexspace-intake' },
 ],
 estimatedSetupMinutes: 25,
 buildsCount: 0,
 featured: true,
};
- **Phase 1 — DONE.** Migration `0044_naelao_product.sql` adds only two genuinely new,
cross-space-queryable columns to `spaces` — `product_slug` (unique platform-subdomain identity,
partial unique index excluding NULL) and `conversation_access_approved_by`/`_at` (the spec's
legally-gated conversation-log-access approval, which Naelao staff need to query across every
space for the platform-wide approval queue). Everything else from the spec's ~20-field
NaelaoProduct list — branding, auth provider config, pricing, sub-space terminology/depth
display, admin features, per-product feature flags — extends `SpaceTypeProductConfig`
(`workers/spaces/src/do/SpaceTypeRegistryDO.ts`) instead: new optional `branding`/`authProvider`/
`pricingConfig`/`subSpaceDisplay`/`adminFeatures`/`featureFlags` fields, stored as a
`config_json.productConfig` override on the space row exactly like member billing (#17) and
assistant policy (#20) already work. A `product_domain`/`custom_domain_verified` pair was
deliberately NOT added — that would duplicate what `business_services` already tracks end-to-end
for storefront/custom-domain identity (#16); a per-product feature-flags mechanism deliberately
does NOT reuse `FeatureFlagDO` — that DO is Naelao's own platform-wide gradual-rollout system
(global flags, staff-controlled), a different actor/lifecycle from a builder toggling a flag for
their own product's end users.
- ### Why this design holds up:
1. **Immune to Plan Switching:** A user can switch between plans every month; the system tracks the cumulative count per tier.
2. **Re-Monetization on Upgrade:** The moment an expired $20 client upgrades to $150, the developer's commission resumes immediately.
3. **Automated Upsell Drive:** Developers have a dashboard metric telling them which clients have exhausted their lower-tier quotas, motivating them to pitch higher-tier upgrades.
Plus they can make template tiers lie x features of the template cannot be accessed by an $20 plan user and $150 plan user can access them but if made so the template becomes free so it's not sold on fixed prices and vice versa if they sell at fixed price once no more per plan access upgrades. This way it forces devs to add more features in templates in $150 dollar plans
This rule creates a **mutually exclusive monetization model** that solves the shovelware problem and aligns developer incentives with buyer value:
* **Rule 1 (The Freemium Tiered Model):** If a developer wants to gate features between the $20, $50, and $150 tiers, **the template MUST be 100% free upfront to clone/install**. The developer earns purely through recurring subscription commissions as the business upgrades to unlock higher-tier capabilities.
* **Rule 2 (The Fixed Buy-Out Model):** If a developer sells the template for a **fixed one-off price** (e.g., $99 upfront), **all features must be 100% unlocked forever**. They cannot charge upfront *and* gate features behind subscription walls.
This gives buyers a frictionless way to try templates for free, while **forcing developers to build heavy, high-leverage enterprise features into the $150+ tiers** to earn lifetime recurring commissions.
- ### 1. The Binary Marketplace Model (Mutually Exclusive)
```
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                  THE TWO MARKETPLACE TEMPLATE PATHS                                     │
├───────────────────────────────┬───────────────────────────────────────┬─────────────────────────────────┤
│ Dimension                     │ Model A: Freemium Tiered SaaS Template │ Model B: Fixed One-Off License  │
├───────────────────────────────┼───────────────────────────────────────┼─────────────────────────────────┤
│ **Upfront Price to Install**  │ **$0.00 (Free to Install)**           │ **$49 – $499 One-Time Buy-Out** │
├───────────────────────────────┼───────────────────────────────────────┼─────────────────────────────────┤
│ **Feature Gating per Plan**   │ ✅ **YES (Granular per Plan Tier)**   │ ❌ **NO (100% Fully Unlocked)** │
│                               │ • $20 Plan: Basic Features            │ All features open to whatever   │
│                               │ • $50 Plan: Advanced Tools            │ base compute plan the user runs │
│                               │ • $150 Plan: Enterprise Engine        │                                 │
├───────────────────────────────┼───────────────────────────────────────┼─────────────────────────────────┤
│ **Developer Payout**          │ **40% / 20% Recurring Commissions**   │ **100% of Upfront Sale**        │
│                               │ (Lifetime on $150+; 6-12 mo on lower) │ (0% on monthly platform compute)│
├───────────────────────────────┼───────────────────────────────────────┼─────────────────────────────────┤
│ **Developer Incentive**       │ **Build killer $150 features** to     │ **Build turnkey, complete open  │
│                               │ maximize recurring monthly upgrades.  │ templates** for instant cash.   │
└───────────────────────────────┴───────────────────────────────────────┴─────────────────────────────────┘
```
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
│                                                                             │
│ ( ) 💵 Fixed-Price One-Off License (Buy-Out)                                │
│     • Set One-Time Template Price: [ $99.00 ]                               │
│     • You keep 100% ($99.00) upfront.                                       │
│     • 🔒 *Feature gating is disabled: All template features unlocked.*      │
│                                                                             │
│ [ Publish Template ]                                                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

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
     handling entirely and killed the whole run — so a model typo was fatal rather than a step it
     could observe and correct. Worst precisely on the unattended proactive path, where nobody is
     watching to retry: the job records a failure and goes quiet.
     - **Fixed by splitting lookups from writes.** The two LOOKUPS (`read`, `exists`) now report
       "no such script" for an unusable name; all six WRITE paths (`create`/`update`/`patch`/
       `rollback`/`delete`/`import`) still call `assertName` and still throw, since there a bad name
       is a bug or an attack, not a typo. Path safety is unchanged either way — an unusable name
       never reaches the bucket, asserted directly by a test that counts bucket touches.
     - **The resulting failure now teaches the model** rather than leaving it to re-guess until the
       stall budget runs out: `Unknown script or operation: X` gained a "Did you mean…" naming the
       closest real operations. **That match considers the owning prebuilt's NAME as well as the op
       name**, which turned out to be load-bearing — `notifications` owns ops prefixed `notify.`
       (`notify.email`, `notify.slack`, …), so matching op names alone would have suggested
       *nothing* for this exact failure. The prebuilt name is what the model sees listed in its own
       profile, and that prefix mismatch is very likely why it reached for the wrong name at all.
       Prebuilt ops only — they're already in memory, so a miss costs nothing, whereas listing the
       R2 skill library would turn every mistyped name into a bucket listing.
     - **The new test was verified to catch the bug**, not merely to pass: reverting the one-line
       `read()` change fails 3 of its 5 cases, including the exact live-failure string.
     - **The actual root cause
- The Gap When an end-user makes a payment on a builder's product that uses a paid marketplace app (e.g., an AI writing app built by a third-party developer), three parties are entitled to revenue: the platform (infrastructure fee), the builder (product owner), and the app developer (component creator). The spec records revenue_share percentages in the registry_earnings table but never executes automated splits or payout transfers. The split calculation is never applied, and neither the builder nor the app developer receives their earned share.
- **`apps/shell`** — new Next.js 14 app (same tooling as `apps/dashboard`: `next-on-pages`, plain
`tsc --noEmit` typecheck, no Tailwind — consumes `@naelao/ui`'s CSS directly via
`transpilePackages`). Product resolution is path-based: `/p/[slug]`. `lib/api.ts` and
`lib/productAccount.ts` port `apps/portal`'s proven hybrid-auth pattern verbatim (Bearer `nps_...`
+ `x-naelao-end-user-id`, per-`spaceId` localStorage session keys) — a person can be signed into
several different builder products in the same browser. `lib/auth-provider.tsx`
(`ProductAuthProvider`/`useProductAuth`) is built with an **`isHydrated` tri-state from day one**:
no consumer may redirect on `isAuthenticated` until `isHydrated` is true. This directly targets a
bug already known to exist in the dashboard's own `AuthProvider` (`apps/dashboard/src/lib/auth-provider.tsx`,
still unfixed — that's Phase D's job) — it initializes `token`/`claims` to `null` and only reads
`localStorage` in a post-mount `useEffect`, so the first render of any protected route sees
`isAuthenticated=false` and can redirect to `/login` before the real session is ever read.
`/p/[slug]/layout.tsx` is a server component that resolves the product once (see backend below)
and calls Next's `notFound()` for an unknown/inactive slug; `/p/[slug]/login` and `/p/[slug]/signup`
call the existing `POST /v1/spaces/:spaceId/end-users/{login,signup}` routes (already
unauthenticated on the router, built in an earlier pass); `/p/[slug]/(shell)/layout.tsx` renders
`@naelao/ui`'s `Sidebar` + top bar driven by `GET shell/manifest` (branding, `hidden_core_items`)
and `GET product-users/me` (name, credit balance) — the nav item SET itself is a fixed default
list matching the mockup (Home/Spaces/Assistant/Projects, More→Agents/Knowledge/Workflows/Settings
— Marketplace/Analytics/Explore deliberately deferred per the decided Shell v1 scope), filtered by
`hidden_core_items`, deliberately NOT driven by the manifest's `ui.sidebar_items` — that field is
the BUILDER dashboard's own operator-shell config (Revenue/Orders/Customers/Products/Campaigns/
Agents for Launchpad), a structurally different surface from the end-user Product Shell nav
(same distinction the established architecture item 30's Phase 6 scope-correction already drew out for
`hiddenCoreItems`). The space-switcher is wired to real `shell/manifest` data but only shows the
current business for now — real multi-business switching is Phase C.
- ### 1. The 3-Sided Marketplace Flywheel
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    THE CREATOR & TEMPLATE FLYWHEEL                          │
│                                                                             │
│ 1. [Niche Experts & Agencies]                                               │
│    A top paralegal or agency builds a killer "Legal M&A Studio" or         │
│    "Shopify CRO Agency" in AVOS, tests it live, and exports it as a template│
│                               │                                             │
│                               ▼                                             │
│ 2. [Marketplace Monetization]                                               │
│    They list it for $49/mo or $299 one-off. They market it to their own     │
│    niche network/audience (Twitter, LinkedIn, Whop, YouTube).               │
│                               │                                             │
│                               ▼                                             │
│ 3. [Buyers & Solo Operators]                                                │
│    Buy and launch the template in 1 click. Zero prompt engineering needed.  │
│                               │                                             │
│                               ▼                                             │
│ 4. [Automated Revenue Split]                                                │
│    • 80% goes to the Template Creator (via Stripe Connect / Whop).          │
│    • 20% Platform Take-Rate + compute fees go to YOU.                       │
└─────────────────────────────────────────────────────────────────────────────┘
```
- ### 4. Automated Payout Rails (Connecting to Your Existing Infrastructure)
Your codebase already has `reseller_ledger` and `whop_sub_merchants` / `payment_connections`! We wire marketplace purchases directly into this settlement engine:
```typescript
// When a Buyer purchases a Creator's Template
export async function settleTemplateSale(
  db: D1Database,
  creatorTenantId: string,
  buyerTenantId: string,
  grossCents: number
) {
  const platformFeeBps = 2000; // 20% platform cut
  const platformFeeCents = Math.round((grossCents * platformFeeBps) / 10000);
  const creatorPayoutCents = grossCents - platformFeeCents; // 80% to creator
  // Record creator's margin in reseller_ledger for automated withdrawal
  await db.prepare(`
    INSERT INTO reseller_ledger (
      id, parent_tenant_id, child_tenant_id, event_type,
      retail_cents, wholesale_cents, margin_cents, kind, period
    ) VALUES (?, ?, ?, 'template_sale', ?, ?, ?, 'builder_revenue_share', ?)
  `).bind(
    `sale_${Date.now()}`, creatorTenantId, buyerTenantId,
    grossCents, platformFeeCents, creatorPayoutCents,
    new Date().toISOString().slice(0, 7)
  ).run();
}
```
- ### Summary of What This Creates
1. **Zero Content Bottleneck:** You don't have to build 500 vertical templates. The community will build them for law, medicine, real estate, accounting, and crypto.
2. **Organic User Acquisition:** Template creators will actively promote their templates to their own networks to earn recurring 80% royalties, driving thousands of new users directly to your platform.
3. **Compounding Platform Revenue:** You earn **20% of all template sales** plus recurring infrastructure and compute margins on every single business running on your Cloudflare edge network.

### 125. Cumulative Per-Tier Cycle Quotas

**Final behavior:** $20 plans pay developer commissions for 6 cumulative months max ($48 cap); $50 plans pay for 12 months; $150+ plans pay lifetime recurring.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- 138. **Answering the stop hook's exact challenge — a genuine, comprehensive end-to-end proactive-
     autonomy test, not just quota-chasing — proved three previously-unverified capabilities live
     and found one more real, currently-unfixed defect worth stating precisely rather than papering
     over.**
     - **Multiple autonomous heartbeat wake-ups, spaced ~100s apart, unattended, exactly as asked
       ("secs or few mins apart").** Fired the on-demand tick sweep three times with a real ~100s
       gap between each, doing nothing in between — the loop woke on its own schedule each time
       (`enqueueAgentTicks`, the same function the hourly production cron calls) with no manual
       intervention beyond the sweep trigger itself. All three landed real `run_failed` activity
       rows at the right cadence, proving the WAKE mechanism is genuinely periodic and unattended,
       independent of what the reasoning call inside each wake then did.
     - **`llama-3.1-8b-instant` has a SMALLER Groq TPM ceiling (6000) than the 70B model (12000)**
       — the opposite of the reasonable assumption that a cheaper model gets more headroom. Its
       413 ("Request too large... Limit 6000, Requested 8749") is correctly classified
       `rate_limited` by `classifyFailure`'s existing body-pattern match, and correctly NOT
       retried (`retryDelayMs` only fires on 429/503 — a payload permanently over a fixed ceiling
       cannot be fixed by waiting, so declining to retry is right, not a gap).
     - **Confirmed `onProgress` — and therefore streaming — is now wired into EVERY dispatch, not
       just interactive ones**, traced by reading `handleScriptRun`: `buildLiveProgressReporter`
       (item 133's durable live-trace persistence) is unconditional, so `deltaReporter` always
       returns a function and `streaming = typeof input.onDelta === "function"` is true for a
       heartbeat wake exactly as much as a chat message. This matters because it's what put a
       Groq-specific defect on the SAME code path a heartbeat run reaches.
     - **A real, currently open finding, left unfixed on purpose: Groq's own server-side schema
       validator rejects the model's object-shaped `params` against the `type:"string"` schema
       item 135 introduced to fix Gemini** (`tool call validation failed: parameters for tool run
       did not match schema: errors: [\`/params\`: expected string, but got object]`), on BOTH
       the streamed attempt and its non-stream
- Required Fix Add memory usage checkpoints for memory-intensive operations: before processing a large file, check `process.memoryUsage().heapUsed`. If above 80MB, return 413 (payload too large) with a message asking the user to split the file. Log memory usage to Analytics Engine for capacity planning. Set the `max_chunk_size` for batch operations based on available memory headroom.
- - **`packages/billing-core/src/providers/stripe.ts`** — fetch-based `StripeProvider`
  (form-encoded, no SDK): `verifyWebhook` (Stripe-Signature `t=…,v1=…` HMAC, 5-min tolerance,
  constant-time compare), `parseWebhookEvent` (checkout.session.completed → payment.success,
  subscription.*, charge.refunded → refund.issued; folds the Connect event's `account` into
  `metadata.stripe_account` and captures `payment_intent` — the ONE id shared between a
  checkout event and its later refund event), `createCheckout` (ad-hoc `price_data`, direct
  charge + application fee). Connect helpers: `createExpressAccount` / `createAccountLink` /
  `getAccountStatus`. LS provider gained `lsListStores` / `lsCreateWebhook` / `lsDeleteWebhook`.
- **Migration `0063_payment_connections`** — one live (non-disabled) connection per space
  (partial unique index, the 0040 technique); vault credential POINTERS only; indexed by
  `(provider, provider_account_id)` for webhook dispatch.
- **`workers/billing/src/wallet-connections.ts`** — HMAC-gated, owner/admin-only lifecycle
  routes (`GET/DELETE /billing/wallet/connection`, `POST /billing/wallet/connect/{stripe,
  lemon-squeezy}`), tenant/space ownership checked on every route; `role="agent"` can never
  manage payments. Disconnect keeps the row as an audit record (`disabled`), best-effort
  deletes the LS webhook, and deliberately never deletes the Stripe account (it's the
  builder's own business account — they keep it via their Express dashboard).
- **`workers/billing/src/wallet-checkout.ts`** — `/internal/commerce/checkout` (which the
  storefront also flows through) routes to the builder's provider when a connection is ACTIVE;
  no connection → the Naelao-store path byte-identical. **Fail-closed rule:** a broken rail on
  a connected space (missing platform key, unreachable vault) 503s rather than falling back —
  falling back would settle revenue into the wrong custody, the exact thing this feature
  prevents. The LS rail lazily provisions a product+variant ONCE on the builder's own store
  (cached in `details_json.product_variants`).
- **`workers/billing/src/wallet-webhooks.ts`** — two public signature-verified ingress routes
  (router-proxied like the platform LS webhook): `POST /v1/webhooks/stripe` (the platform's ONE
  Connect endpoint; connection resolved from the event's connected-account id) and
  `POST /v1/webhooks/lemon-squeezy/wallet/:connectionId` (per-connection vault secret; a
  builder controls their own store so t
- 265 - 270
What if a $150 plan user goes to $20 plan we should count the times they use $20 plans if it reaches 6 then after that if they goe to $20 plan again we don't give developer any communication if they go to higher plan we start giving them this way if a user changes plans everyonth we just count how many times the had the $20 plan
This is a clean solution. Tracking **cumulative cycles per tier** (a **Per-Tier Lifetime Quota**) completely eliminates plan-hopping and subscription gaming.
Whether a customer stays on a $20 plan for 6 consecutive months, or hops back and forth between $150 and $20 over two years, the system simply checks: **"Has this developer already collected their 6 commission payouts for the $20 tier on this account?"**
- ### Why this design holds up:
1. **Immune to Plan Switching:** A user can switch between plans every month; the system tracks the cumulative count per tier.
2. **Re-Monetization on Upgrade:** The moment an expired $20 client upgrades to $150, the developer's commission resumes immediately.
3. **Automated Upsell Drive:** Developers have a dashboard metric telling them which clients have exhausted their lower-tier quotas, motivating them to pitch higher-tier upgrades.
Plus they can make template tiers lie x features of the template cannot be accessed by an $20 plan user and $150 plan user can access them but if made so the template becomes free so it's not sold on fixed prices and vice versa if they sell at fixed price once no more per plan access upgrades. This way it forces devs to add more features in templates in $150 dollar plans
This rule creates a **mutually exclusive monetization model** that solves the shovelware problem and aligns developer incentives with buyer value:
* **Rule 1 (The Freemium Tiered Model):** If a developer wants to gate features between the $20, $50, and $150 tiers, **the template MUST be 100% free upfront to clone/install**. The developer earns purely through recurring subscription commissions as the business upgrades to unlock higher-tier capabilities.
* **Rule 2 (The Fixed Buy-Out Model):** If a developer sells the template for a **fixed one-off price** (e.g., $99 upfront), **all features must be 100% unlocked forever**. They cannot charge upfront *and* gate features behind subscription walls.
This gives buyers a frictionless way to try templates for free, while **forcing developers to build heavy, high-leverage enterprise features into the $150+ tiers** to earn lifetime recurring commissions.
- ### 1. The Binary Marketplace Model (Mutually Exclusive)
```
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                  THE TWO MARKETPLACE TEMPLATE PATHS                                     │
├───────────────────────────────┬───────────────────────────────────────┬─────────────────────────────────┤
│ Dimension                     │ Model A: Freemium Tiered SaaS Template │ Model B: Fixed One-Off License  │
├───────────────────────────────┼───────────────────────────────────────┼─────────────────────────────────┤
│ **Upfront Price to Install**  │ **$0.00 (Free to Install)**           │ **$49 – $499 One-Time Buy-Out** │
├───────────────────────────────┼───────────────────────────────────────┼─────────────────────────────────┤
│ **Feature Gating per Plan**   │ ✅ **YES (Granular per Plan Tier)**   │ ❌ **NO (100% Fully Unlocked)** │
│                               │ • $20 Plan: Basic Features            │ All features open to whatever   │
│                               │ • $50 Plan: Advanced Tools            │ base compute plan the user runs │
│                               │ • $150 Plan: Enterprise Engine        │                                 │
├───────────────────────────────┼───────────────────────────────────────┼─────────────────────────────────┤
│ **Developer Payout**          │ **40% / 20% Recurring Commissions**   │ **100% of Upfront Sale**        │
│                               │ (Lifetime on $150+; 6-12 mo on lower) │ (0% on monthly platform compute)│
├───────────────────────────────┼───────────────────────────────────────┼─────────────────────────────────┤
│ **Developer Incentive**       │ **Build killer $150 features** to     │ **Build turnkey, complete open  │
│                               │ maximize recurring monthly upgrades.  │ templates** for instant cash.   │
└───────────────────────────────┴───────────────────────────────────────┴─────────────────────────────────┘
```

### 126. Anti-Plan-Hopping D1 Ledger

**Final behavior:** Tracks cumulative billing cycles per plan tier (`cycles_paid_entry_tier`), ensuring downgrading and upgrading cannot reset the commission clock.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- 149. **A post-shipping pass over the SAME source list the 62-item plan came from
     (`long running.txt`, Google Drive) — it had been updated with fresh reports from live use
     AFTER those phases landed, so several items marked done were reported still broken. Ten real
     defects found and fixed, most of them the "fixed on one path, missed the other" class this
     file has now documented repeatedly.** Binary downloads corrupted (the knowledge worker read
     every response as text, so a PDF landed as mojibake — now reads bytes once and returns
     `encoding: "text"|"base64"`, refusing an oversized binary with 413 rather than truncating,
     since half a PDF is corrupt rather than smaller); the Sub-agents panel queried the space-wide
     assistant DO while a spawn records into the session's own DO, so it was structurally always
     empty; `thread.create` still produced "Session not found" (the spaces-worker session proxy
     derived `end_user_id` for only one of the two caller shapes); the Compact button hit a route
     that ran space-wide maintenance and never touched the session it was invoked from; `effort`
     capped its own ladder at the model's native reasoning-level count, so `ultra` was rejected on
     models that could serve it; the personal-plan checkout still went LS-first after the Whop
     cutover; `thread.send_message` rendered as the assistant apparently answering its own
     question (now a collapsible on-behalf card, paired to the reply that follows it); the
     project-thread page was unusable on a phone; and the agent had no way to see which models or
     agent templates existed (`agent.list_models`, plus four free-tier Gemini models added to the
     catalogue).
     - **The two reported chat bugs were both about the SERVER transcript, and had separate root
       causes.** A reload discards every scrap of client state, so anything wrong after a reload is
       wrong in the database. *"I got a reply but when I reload it's gone"*: `NaelaoAgentDO` wrote
       the answer back with `void` — a promise still pending when a DO handler returns may never
       run, so the write raced the response (the same class as item 136's `recordWakeFailure`).
       Awaited now; safe because `writeAgentAnswerToSession` already swallows its own errors, so it
       still cannot turn a successful run into a failed one. *"the reload duplicate is still
       there"*: `POST /messages` was not idempotent and `apps/shell`'s `apiFetch` retri
- The Gap: BillingDO tracks subscription revenue but has no builder earnings wallet — an accumulator that holds earned revenue (after platform fee) before the periodic payout transfer. Without a ledger, the platform cannot show builders their pending balance, correct for refunds against pending earnings, or enforce minimum payout thresholds accurately.
 Required Fix: Add earnings ledger to BillingDO SQLite: CREATE TABLE earnings_ledger (id TEXT PRIMARY KEY, type TEXT CHECK(type IN ("credit","debit","refund","payout")), amount_cents INTEGER, currency TEXT, description TEXT, created_at INTEGER, related_payment_intent TEXT) . Credit on each subscription payment (after platform fee). Debit on refunds. Debit on payout transfer. Balance = SELECT SUM(CASE WHEN type='credit' THEN amount_cents ELSE -amount_cents END) . Builder dashboard "Earnings" tab shows ledger with running balance.
- `NaelaoAgentDO.enforceRunGates` gained a new `checkSessionBudget` branch, checked FIRST (ahead of
every payer-specific gate) since it's session-scoped, not payer-scoped:
- Under 80% of ceiling: run proceeds, no side effect.
- 80-100%: run proceeds; fires `agent.session_budget_warning` through SpaceDO's already-existing
  generic `/internal/events/fire` → `event_triggers` machinery (the SAME no-code mechanism every
  other structural event uses — no new trigger type), and marks `warned_80` so it fires exactly
  once per spending cycle.
- At/past 100%: refuses the run (`402 session_budget_ceiling`) and reuses the HITL approval
  mechanism (no new gate engine, per the plan's explicit direction) — a request is keyed on
  `run_id: sessionId` + `tool_name: 'session_budget_continue'`, a stable identity that lets the
  gate find an already-open or already-resolved request for THIS session without needing a new
  column anywhere. A second concurrent run over the same ceiling finds the pending request and
  returns its `approval_id` rather than opening a duplicate. Once a human approves, the gate
  resets the tally (`POST .../session-spend/:sessionId/continue`) and lets the run through — the
  NEXT time the same ceiling is crossed, a FRESH approval is required (approving once doesn't
  permanently disable the guard). Fails CLOSED when `HITL_APPROVAL_DO` isn't configured — the
  whole point of a ceiling is that it's never silently bypassed just because the approval
  mechanism isn't wired up. `settleRunBilling` gained the post-run counterpart: an increment to
  `session_spend`, but ONLY when a ceiling is actually configured, so a space that never opted in
  pays zero extra round-trip cost per run.
- -- Cumulative Tier Usage Counters
  cycles_paid_entry_tier INTEGER NOT NULL DEFAULT 0,  -- Capped at 6 max for plans <= $25
  cycles_paid_growth_tier INTEGER NOT NULL DEFAULT 0, -- Capped at 12 max for plans $26 - $100
  cycles_paid_pro_tier INTEGER NOT NULL DEFAULT 0,    -- Unlimited for plans >= $150
- ### 3. The Settlement Engine Implementation
In `workers/billing/src/settlement.ts`, evaluate the tier quota on every invoice payment webhook:
```typescript
// workers/billing/src/settlement.ts
export async function settleTemplateSubscriptionPayment(
  db: D1Database,
  spaceId: string,
  grossCents: number
) {
  // 1. Fetch active subscription record
  const sub = await db.prepare(`
    SELECT * FROM template_subscriptions WHERE space_id = ? AND status = 'active'
  `).bind(spaceId).first() as any;
  if (!sub) return;
  const planPriceUsd = grossCents / 100;
  let isCommissionEligible = false;
  // 2. Evaluate & Increment Per-Tier Quota
  if (planPriceUsd <= 25) {
    // Entry Tier ($20/mo): Maximum 6 Paid Cycles
    const newEntryCount = sub.cycles_paid_entry_tier + 1;
    await db.prepare(`
      UPDATE template_subscriptions
      SET cycles_paid_entry_tier = ?, last_billed_plan_price_cents = ?, updated_at = datetime('now')
      WHERE id = ?
    `).bind(newEntryCount, grossCents, sub.id).run();
    // Eligible ONLY if this is cycle 1 through 6
    isCommissionEligible = newEntryCount <= 6;
  } else if (planPriceUsd < 150) {
    // Growth Tier ($50/mo): Maximum 12 Paid Cycles
    const newGrowthCount = sub.cycles_paid_growth_tier + 1;
    await db.prepare(`
      UPDATE template_subscriptions
      SET cycles_paid_growth_tier = ?, last_billed_plan_price_cents = ?, updated_at = datetime('now')
      WHERE id = ?
    `).bind(newGrowthCount, grossCents, sub.id).run();
    // Eligible ONLY if this is cycle 1 through 12
    isCommissionEligible = newGrowthCount <= 12;
  } else {
    // Pro Tier ($150+/mo): LIFETIME UNLIMITED
    const newProCount = sub.cycles_paid_pro_tier + 1;
    await db.prepare(`
      UPDATE template_subscriptions
      SET cycles_paid_pro_tier = ?, last_billed_plan_price_cents = ?, updated_at = datetime('now')
      WHERE id = ?
    `).bind(newProCount, grossCents, sub.id).run();
    isCommissionEligible = true; // Always eligible!
  }
  // 3. Compute Split
  let developerRate = 0.0;
  if (isCommissionEligible) {
    if (sub.attribution_channel === "DEVELOPER_REFERRAL") {
      developerRate = 0.40; // 40% (Developer referred)
    } else if (sub.attribution_channel === "MARKETPLACE_ORGANIC") {
      developerRate = 0.20; // 20% (Marketplace organic)
    }
  }
  const developerCutCents = Math.round(grossCents * developerRate);
  const platformCutCents = grossCents - developerCutCents;
  // 4. Record in Ledger
  const period = new Date().toISOString().slice(0, 7);
  await db.prepare(`
    INSERT INTO developer_earnings_ledger (
      id, developer_user_id, space_id, event_type, gross_cents, developer_cut_cents, platform_cut_cents, period
    ) VALUES (?, ?, ?, 'subscription_cut', ?, ?, ?, ?)
  `).bind(
    `earn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    sub.developer_user_id,
    spaceId,
    grossCents,
    developerCutCents,
    platformCutCents,
    period
  ).run();
}
```
- ### Why this design holds up:
1. **Immune to Plan Switching:** A user can switch between plans every month; the system tracks the cumulative count per tier.
2. **Re-Monetization on Upgrade:** The moment an expired $20 client upgrades to $150, the developer's commission resumes immediately.
3. **Automated Upsell Drive:** Developers have a dashboard metric telling them which clients have exhausted their lower-tier quotas, motivating them to pitch higher-tier upgrades.
Plus they can make template tiers lie x features of the template cannot be accessed by an $20 plan user and $150 plan user can access them but if made so the template becomes free so it's not sold on fixed prices and vice versa if they sell at fixed price once no more per plan access upgrades. This way it forces devs to add more features in templates in $150 dollar plans
This rule creates a **mutually exclusive monetization model** that solves the shovelware problem and aligns developer incentives with buyer value:
* **Rule 1 (The Freemium Tiered Model):** If a developer wants to gate features between the $20, $50, and $150 tiers, **the template MUST be 100% free upfront to clone/install**. The developer earns purely through recurring subscription commissions as the business upgrades to unlock higher-tier capabilities.
* **Rule 2 (The Fixed Buy-Out Model):** If a developer sells the template for a **fixed one-off price** (e.g., $99 upfront), **all features must be 100% unlocked forever**. They cannot charge upfront *and* gate features behind subscription walls.
This gives buyers a frictionless way to try templates for free, while **forcing developers to build heavy, high-leverage enterprise features into the $150+ tiers** to earn lifetime recurring commissions.

### 127. Dynamic First-Month Price Floor Formula Protection

**Final behavior:** Enforces that Month 1 Price $\ge$ Base Plan Price $+$ $\sum$ Extension Wholesale Fees, guaranteeing platform and extension creators never lose money.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- 93. **Channels made real (they could not reply at all), Telegram added, the webdev store made
    deterministic, and a live end-to-end run that found two more bugs — plus an OpenClaw/Hermes
    gap analysis in `docs/COMPETITIVE_2026-08-05_openclaw_hermes.md`.**
    - **Reported bug: the Channels panel could not connect anything.** It listed connected channels
      and offered no way to add one — the only connect route was `POST /channels/:channel/connect`,
      builder-only and left out of the router's end-user allowlist. New `POST /spaces/:spaceId/
      assistant/channels` (same path as the existing GET, `action` in the body — a dynamic segment
      followed by a static suffix is the shape that has repeatedly corrupted this codebase's Hono
      route tables), gated by `requireEndUserBusinessMembership` at a NEW admin floor: changing how
      a business is reached from outside is not a plain member action. Owner outranks admin (the
      item 90 bug, avoided here rather than repeated). Returns the webhook URL, since connecting on
      our side is only half of it. New `ChannelConnect` component in the shell.
    - **Unreported and worse: NO channel could reply.** `/internal/notify` handled email and
      returned `delivered:false` for everything else, so a customer could message a business on
      Slack/Discord/WhatsApp, the agent would run and produce a real answer, and the reply never
      left the building. Slack, Discord, WhatsApp and Telegram now send for real, resolving the
      space's own bot token from the vault at send time (`CHANNEL_SEND_CREDENTIAL` — a DIFFERENT
      secret from the inbound-verification one). Slack's 200-with-`ok:false` is treated as the
      failure it is. New `CREDENTIALS_WORKER` binding on the notifications worker.
    - **Telegram** (`ChannelType` gained a 5th member): free, no business verification, no
      per-message billing, no 24-hour reply window — the opposite of WhatsApp on every axis that
      matters to a $0-budget business, and the top gap the OpenClaw/Hermes analysis identified.
      Auth is unlike every other adapter: Telegram does not sign payloads, it echoes back a secret
      token the owner chose at `setWebhook` time, so this is a shared bearer secret compared in
      constant time, not a signature. Keys on the CHAT id (a group reply must go to the
      conversation, not the sender) and dedupes on `chat:message_id` since message_id is only
      unique per chat. Signal/iMessage deliberatel
- The Gap The Naelao billing model (spec §billing, the established specification BillingStrategy) prices builder plans around AI token consumption and feature access. It does not factor in: (1) Turso per-DB cost ($0.20-0.75/month per product DB, or per-user DB at 1M users = $200K/month). (2) Analytics Engine volume (up to $375K/month at 1M users as G-AC15). (3) R2 egress costs for file downloads, screenshots, and exports (typically $0.09/GB, significant for document-heavy spaces). (4) CF Container compute costs for code execution sandboxes. Naelao is currently selling token-based credits while silently absorbing all infrastructure costs, which are non-linear and will cause the platform to lose money at scale.
- - ~~**Credential hierarchy**~~ — **BUILT** (see A1.16.5). Per-user (default) + per-space
  (shared) + per-privileged-user overrides, in `workers/credentials`. Also closed a
  pre-existing gap: `space_credentials` had no migration at all — the worker would have
  thrown at runtime against a real D1.
- **MCP as scripts**: agents never connect to MCP directly; they write/use scripts that wrap
  MCP providers (Pipedream, Composio).
- ~~**Member/seat billing**~~ — **BUILT** (see A1.16.4). Lemon Squeezy billing for a builder's
  space-members (the third payer class): `/internal/seats/checkout` + LS-webhook
  `recordSeatActivation` (member activated on paid seat) already existed; this pass added the
  builder-facing enable/price surface (`GET/PATCH /spaces/:spaceId/member-billing`) that
  provisions the seat LS variant and stores the config as a per-space `productConfig` override.
- ~~**Storefront render + CF for SaaS apply step**~~ — **BUILT** (see A1.16.3). The portal
  Worker now serves the store at the root path a buyer lands on (`GET /` resolves the Host via
  `business_services`, precedence storefront → product portal), and the zone-scoped
  `custom_hostnames` apply (`createCustomHostname` + TXT DCV + status poll) is wired end-to-end
  in the spaces worker. The `storefront.set_custom_domain` prebuilt now posts `kind='custom_domain'`
  (the branch that actually runs the CF-for-SaaS apply).
- ~~**Space collaboration**~~ — **BUILT** (see A1.16.6). Roles already existed
  (`space_members.role`); locks already existed (`LockDO`/A1.15). This pass added presence
  (heartbeat-based, in `SpaceDO`) and project deduplication (name-similarity heads-up on
  `POST /projects`, wired to the existing event-trigger mechanism so a builder can broadcast
  "this already exists" via a no-code trigger). "Task boards" is the existing
  Projects+threads model (§A1.0) — a dashboard rendering concern, not a missing backend.
- ~~**Reseller / `tenant` membership**~~ — **BUILT** (see A1.16.4). `parent_tenant_id` hierarchy
  (`tenant_hierarchy`), `reseller_accounts`, per-event `reseller_ledger` attribution
  (`recordResellerAttribution` in the LS webhook), `/reseller/spaces` + client-portfolio
  endpoints were already in place; this pass added the consolidated **wholesale statement**
  (`GET /reseller/statement?period=YYYY-MM`) that sums the ledger into the invoice the reseller
  settles + a per-client breakdown (spec G-AS34/G-AS35).

### 128. FDE-to-Vertical-SaaS Graduation Pipeline

**Final behavior:** 3-stage agency-to-software ladder: Consulting Embed ($5k–$25k setup) $\rightarrow$ Exporter $\rightarrow$ Scalable Marketplace Template (MRR).

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- 149. **A post-shipping pass over the SAME source list the 62-item plan came from
     (`long running.txt`, Google Drive) — it had been updated with fresh reports from live use
     AFTER those phases landed, so several items marked done were reported still broken. Ten real
     defects found and fixed, most of them the "fixed on one path, missed the other" class this
     file has now documented repeatedly.** Binary downloads corrupted (the knowledge worker read
     every response as text, so a PDF landed as mojibake — now reads bytes once and returns
     `encoding: "text"|"base64"`, refusing an oversized binary with 413 rather than truncating,
     since half a PDF is corrupt rather than smaller); the Sub-agents panel queried the space-wide
     assistant DO while a spawn records into the session's own DO, so it was structurally always
     empty; `thread.create` still produced "Session not found" (the spaces-worker session proxy
     derived `end_user_id` for only one of the two caller shapes); the Compact button hit a route
     that ran space-wide maintenance and never touched the session it was invoked from; `effort`
     capped its own ladder at the model's native reasoning-level count, so `ultra` was rejected on
     models that could serve it; the personal-plan checkout still went LS-first after the Whop
     cutover; `thread.send_message` rendered as the assistant apparently answering its own
     question (now a collapsible on-behalf card, paired to the reply that follows it); the
     project-thread page was unusable on a phone; and the agent had no way to see which models or
     agent templates existed (`agent.list_models`, plus four free-tier Gemini models added to the
     catalogue).
     - **The two reported chat bugs were both about the SERVER transcript, and had separate root
       causes.** A reload discards every scrap of client state, so anything wrong after a reload is
       wrong in the database. *"I got a reply but when I reload it's gone"*: `NaelaoAgentDO` wrote
       the answer back with `void` — a promise still pending when a DO handler returns may never
       run, so the write raced the response (the same class as item 136's `recordWakeFailure`).
       Awaited now; safe because `writeAgentAnswerToSession` already swallows its own errors, so it
       still cannot turn a successful run into a failed one. *"the reload duplicate is still
       there"*: `POST /messages` was not idempotent and `apps/shell`'s `apiFetch` retri
- The Gap When a Space Type author submits a template to the marketplace, it may contain: MCP tool bindings pointing to malicious external services, system prompts designed to override builder customizations, dangerous default RBAC configurations (e.g., all users get admin role), or embedded webhook URLs that exfiltrate data. There is no automated security validation pipeline before a Space Type is approved for listing.
- New optional `MemoryOSOptions.wikiBucket` (a minimal `{put(key, value)}` interface, not a hard CF
`R2Bucket` dependency — same rationale as the existing `VectorIndex`/`Embedder` minimal interfaces)
and `MemoryOSOptions.autoRag` (`{search(query, {topK}): Promise<Array<{concept, score}>>}`).
`upsertWikiConcept` mirrors each concept to R2 at
`spaces/{spaceId}/memory/wiki/{userId || "_space"}/{concept-slug}.md` (best-effort — SQLite's
`wiki_store` row is written first and is unaffected by a mirror-write failure). `searchWiki` first
runs its existing SQLite LIKE-match (unchanged); if that doesn't already fill the requested `limit`
and an `autoRag` gateway is configured, it ALSO queries AutoRAG for semantically-matched concept
names (useful for e.g. a query like "what's our refund window" finding a concept literally named
"return_policy" that no substring match would ever find) — but **always re-hydrates the actual
`WikiArticle` from SQLite** for each AutoRAG-named concept rather than trusting AutoRAG's own
(unstructured) result directly; a concept AutoRAG still has indexed but that's since been deleted
from SQLite is silently skipped, never fabricated. Wired in `NaelaoAgentDO.buildScriptEngineEnv`: a
new `AUTORAG_WIKI_INSTANCE` env config, `wikiBucket` reuses the already-bound `SCRIPTS_R2`, and the
`autoRag` gateway is a small inline adapter over the existing `AI` binding's `.autorag(name)`
accessor (same accessor the KB pipeline above uses, different instance name/config so the two
subsystems can be configured independently). Explicitly NOT done this phase: wiring AutoRAG into the
SpaceDO-backed **project-shared** Wiki path (`project-memory-client.ts`, §A1.17 Phase U) — that's a
structurally separate implementation (HTTP calls to SpaceDO's own `wiki_store`-equivalent, not this
DO's local SQLite), deliberately deferred rather than silently left half-covered.

### 129. Developer Partner Portal & White-Label Referral Links

**Final behavior:** Dedicated workstation for partners to manage clients, track remaining commission cycles, and execute automated Stripe payouts.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- 126. **Three more live-reported bugs, all root-caused to the SAME underlying gap: the reasoner's
     "available_operations" field was a bare flat list of 60+ op names with no description or
     grouping — plus two silent trace-persistence holes that hid real repeat/parked tool calls
     from the activity table.**
     - **The real root cause of "our API doesn't support programmatic thread creation or direct
       in-thread chat messaging"** (item 125 shipped exactly that capability the same session).
       `project-coordination` WAS wired into the assistant's prebuilt list and `tools.
       availableOperations()` DID include `thread.create`/`thread.send_message` in the payload —
       but only as bare strings among dozens of others, with zero indication of what any of them
       do or what parameters they take (unlike `candidate_scripts`, which carries a real
       description/parameters/health per entry). A model asked to "communicate with an agent
       directly in a thread" had no way to recognize an opaque name like `thread.send_message` as
       the answer. New `ScriptToolSurface.availableOperationsGrouped()` groups the same ops by
       their owning prebuilt SCRIPT, reusing that script's own (already-written) description —
       `reasoner.ts` now sends this grouped structure as `available_operations` instead of the
       flat list (falls back to the flat list when a caller/test doesn't supply groups), and
       `DECISION_INSTRUCTIONS` gained one sentence telling the model to read every group's
       description before concluding a capability doesn't exist. Zero new prose was written per
       operation — the fix is structural (grouping + reuse), not a bigger prompt.
     - **The intermittent "narration with no tool-call table underneath it," and the "it's sort of
       repeating the same task many times" observation — the SAME bug, now fixed.** `loop.ts`'s
       within-run repeat-call guard (an already-attempted `name+params` combo, or an action still
       sitting in `deferred` awaiting approval) correctly served the model a cached outcome and
       `continue`d — but neither branch ever called `pushTrace`, even though the "reason" step
       immediately before it (carrying that turn's own `narration`/`doing` text, e.g. "Checking
       Instagram MCP tools") always does. Every REPEAT attempt therefore showed a real status line
       with nothing in the table beneath it — exactly the reported screenshot, and exactly why it

- The Gap: Agencies building AI products for multiple clients using Naelao have no formal partner program. No agency-specific pricing, multi-client dashboard, or co-marketing exists. Agencies are the most efficient channel for SaaS platform growth but are treated identically to individual builders.
 Required Fix: Launch Agency Partner Program: (1) Agency account type: single login, manages multiple "client workspaces" (G-AR50 workspace concept), consolidated billing; (2) Agency pricing: 30% discount on all plans for resale to clients; (3) Agency dashboard: client portfolio view with health scores, billing status, Space status; (4) White-label portal: agencies can rebrand Naelao dashboard with their logo for client access; (5) Agency support tier: dedicated Slack channel with Naelao solutions engineer; (6) Co-marketing: Naelao refers enterprise prospects to certified agency partners. Certification: 5+ deployed client Spaces, 1 year history, security review.
- - **Storefront/connect_revenue prebuilt scripts and per-template bootstrap wiring** (the plan's
  WH4/WH7): the existing `storefront` prebuilt (Naelao-hosted catalog) and the `mcp-connector` +
  `revenue-tracker` prebuilts already cover "connect a 3rd-party revenue source" — no new
  connect_revenue mechanism was added on top, matching the reuse-don't-reinvent precedent this
  codebase follows elsewhere. Per-template auto-creation of a `business_wallet` PROJECT at
  bootstrap was not wired: `BUSINESS_FEATURE_KIND_REGISTRY.autoProvisionable` is (and was already,
  independent of this pass) a documented-but-unconsumed field platform-wide — nothing reads it to
  auto-create ANY feature-kind project for ANY template today (storefront/business_email
  included), so wiring it just for `business_wallet` would be inconsistent with every sibling
  kind. The WALLET DATA itself is unconditionally auto-provisioned regardless (every business
  gets a real `whop_sub_merchants` row at creation) — the project is only an optional UI "place"
  a builder can additionally create to view it, and the assistant already has direct
  `business-wallet` prebuilt access without needing one.
- **Scheduled/hourly wallet-health monitoring** (a dedicated "Wallet Manager" heartbeat distinct
  from the Space Assistant's own existing hourly heartbeat): the plan's WH6 scheduled-job idea
  is subsumed by the assistant's own continuous existence + the new
  `business_wallet.revenue_received` event a builder can already wire a no-code trigger to,
  rather than adding a second heartbeat mechanism.
- **Owner-email resolution for end-user-created businesses** (see above) — a real, scoped
  follow-up, not a silent gap.

### 130. Discover Page Live Market Radar

**Final behavior:** Queries Cloudflare Pipelines and Apache Iceberg on R2 to display the Top 5 High-Velocity Market Opportunities with 1-click launch buttons.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- 126. **Three more live-reported bugs, all root-caused to the SAME underlying gap: the reasoner's
     "available_operations" field was a bare flat list of 60+ op names with no description or
     grouping — plus two silent trace-persistence holes that hid real repeat/parked tool calls
     from the activity table.**
     - **The real root cause of "our API doesn't support programmatic thread creation or direct
       in-thread chat messaging"** (item 125 shipped exactly that capability the same session).
       `project-coordination` WAS wired into the assistant's prebuilt list and `tools.
       availableOperations()` DID include `thread.create`/`thread.send_message` in the payload —
       but only as bare strings among dozens of others, with zero indication of what any of them
       do or what parameters they take (unlike `candidate_scripts`, which carries a real
       description/parameters/health per entry). A model asked to "communicate with an agent
       directly in a thread" had no way to recognize an opaque name like `thread.send_message` as
       the answer. New `ScriptToolSurface.availableOperationsGrouped()` groups the same ops by
       their owning prebuilt SCRIPT, reusing that script's own (already-written) description —
       `reasoner.ts` now sends this grouped structure as `available_operations` instead of the
       flat list (falls back to the flat list when a caller/test doesn't supply groups), and
       `DECISION_INSTRUCTIONS` gained one sentence telling the model to read every group's
       description before concluding a capability doesn't exist. Zero new prose was written per
       operation — the fix is structural (grouping + reuse), not a bigger prompt.
     - **The intermittent "narration with no tool-call table underneath it," and the "it's sort of
       repeating the same task many times" observation — the SAME bug, now fixed.** `loop.ts`'s
       within-run repeat-call guard (an already-attempted `name+params` combo, or an action still
       sitting in `deferred` awaiting approval) correctly served the model a cached outcome and
       `continue`d — but neither branch ever called `pushTrace`, even though the "reason" step
       immediately before it (carrying that turn's own `narration`/`doing` text, e.g. "Checking
       Instagram MCP tools") always does. Every REPEAT attempt therefore showed a real status line
       with nothing in the table beneath it — exactly the reported screenshot, and exactly why it

- Required Fix: Build cross-Space discovery: at builder opt-in, Space listed in end-user discovery feed. Recommendation engine: embed user interaction topics, query Vectorize for Spaces with similar topic coverage. Display as "You might also like" panel in Space shell (configurable by builder: show/hide). Discovery click → Space landing page. Track discovery_click_rate and cross_space_activation_rate. Privacy: users can opt out of being included in recommendation signals.
- **Deliberately NOT built this pass:** any specific image's Dockerfile/DO/persistence/wrangler
binding (see the "why" note above — the very next incremental step, not silently dropped); a
Container Manager UI (there is nothing real to click yet — an all-disabled marketplace page would
be worse UX than no page; build it alongside the first live image); per-slot billing/metering
(meaningless with zero running slots — the `billing_tier` field on each catalogue entry is the
placeholder this will read from). Phase M (local-machine-as-container + Cowork Desktop) remains
the one open item in this roadmap, and needs a native client app outside this repo before its
server-side half has anything to talk to.
- 295 - 297
In discover page it should show top 5 trends or radar researchs on potential business to build (when in a autonomous business template ) think about there is something here
This is a breakthrough product insight.
The biggest reason aspiring founders and solo operators fail or hesitate isn't that they lack tools—**it's that they don't know *what* business to start today.** They suffer from "Blank Canvas Paralysis."
By integrating **Cloudflare Radar Researcher** and **Pipelines/Iceberg streaming telemetry** directly into the **Discover Page**, you turn the platform into a **Live Opportunity Radar**.
Instead of asking users to invent an idea, the platform presents the **Top 5 High-Velocity Market Opportunities of the Week**, backed by real internet traffic surges and low competitor density. With **1 click**, the user launches the entire business.
- ### 1. The Discover Page Radar Experience
At the top of the **Discover Page (`apps/shell/src/app/p/[slug]/(shell)/spaces/page.tsx`)**, above the static template list, is a live, dynamic section:
```
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ 🔥 LIVE MARKET RADAR: Top 5 Autonomous Opportunities to Launch Today                                    │
│ Verified by Cloudflare Internet Telemetry & Global Search Velocity                                      │
├─────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                         │
│ ┌─────────────────────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ ⚡ TREND #1: Automated Solar Permitting & Quoting Engine (Florida & Texas)                          │ │
│ │ 📈 **Market Signal:** **+118% Traffic & Search Surge** (Last 30 Days)                                │ │
│ │ 🌊 **Saturation Index:** **14/100 (Blue Ocean — High Demand / Zero AI Tools)**                       │ │
│ │ 💵 **Est. Operator ARR:** **$3,800 – $6,500 / month**                                                │ │
│ │ 🛠️ **Pre-Configured Stack:** `growth_engine` (Scrapes permit filings) + `doc_studio` (Quote Engine) │ │
│ │                                                                                                     │ │
│ │ [ 🚀 Launch This Venture with 1-Click (Pre-Seeded) ]                  [ 🔍 Inspect Radar Telemetry ]│ │
│ └─────────────────────────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                                         │
│ ┌─────────────────────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ ⚡ TREND #2: Post-Op Care Voice Receptionist for Plastic Surgery & Med-Spas                         │ │
│ │ 📈 **Market Signal:** **+84% Regional Clinic Inbound Surge** │ 🌊 **Saturation:** **21/100 (Low)**  │ │
│ │ 🛠️ **Pre-Configured Stack:** `voice_agent` (Cloudflare Voice) + `space_calendar`                    │ │
│ │ [ 🚀 Launch This Venture with 1-Click ]                               [ 🔍 Inspect Radar Telemetry ]│ │
│ └─────────────────────────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                                         │
│ ┌─────────────────────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ ⚡ TREND #3: Subcontractor Change Order & Lien Waiver Tracker (Commercial Construction)             │ │
│ │ 📈 **Market Signal:** **+92% Search Surge**                 │ 🌊 **Saturation:** **18/100 (Low)**  │ │
│ │ 🛠️ **Pre-Configured Stack:** `product_dev` (Micro-App) + `doc_studio` (Lien PDF Generator)         │ │
│ │ [ 🚀 Launch This Venture with 1-Click ]                               [ 🔍 Inspect Radar Telemetry ]│ │
│ └─────────────────────────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                                         │
│ ┌─────────────────────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ ⚡ TREND #4: Automated Competitor Pricing Intelligence for Shopify Apparel Brands                  │ │
│ │ 📈 **Market Signal:** **+76% Holiday Season Prep Surge**    │ 🌊 **Saturation:** **29/100 (Moderate)│
│ │ 🛠️ **Pre-Configured Stack:** `growth_engine` (Kitesurf Browser) + `finance_grid` (Live Wasm Comps) │ │
│ │ [ 🚀 Launch This Venture with 1-Click ]                               [ 🔍 Inspect Radar Telemetry ]│ │
│ └─────────────────────────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                                         │
│ ┌─────────────────────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ ⚡ TREND #5: Cross-Border EU-UK Freight Tariff Compliance Radar                                    │ │
│ │ 📈 **Market Signal:** **+145% Regulatory Change Spike**      │ 🌊 **Saturation:** **11/100 (Unserved)│
│ │ 🛠️ **Pre-Configured Stack:** `doc_studio` (Customs RAG) + `ops_dispatcher` (Daily Regulatory Cron)│ │
│ │ [ 🚀 Launch This Venture with 1-Click ]                               [ 🔍 Inspect Radar Telemetry ]│ │
│ └─────────────────────────────────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```
- ### 4. What This Achieves for the Platform
1. **Eliminates Founder Hesitation:** Users don't need to brainstorm. The platform points at an active fire (a +118% search surge) and hands them the hose.
2. **True Algorithmic Arbitrage:** Pairs **Cloudflare’s global internet traffic telemetry** with **instant serverless Edge compilation** to launch custom businesses at the exact moment market demand spikes.
3. **High-Converting Discover Page:** The Discover page transforms from a static list of templates into a **real-time financial and market intelligence feed** that users check every single week to see what is trending.

## Final reconciled architectural changes (newest authority)

These are normative replacements, not optional context. Remove or migrate superseded behavior; do not implement both architectures.

#### 18. Strict UI Bifurcation: Client Workspace ("Apple Clean") vs. Developer Foundry
* **This updates/replaces:** Exposing technical knobs, model selectors, and tier sliders to non-technical business clients.
* **The New Architecture & Mental Model:**
  * **Client Workspace (`apps/shell`):** 85% of screen is the Work Viewport Canvas + clean command bar + 1-click action buttons. Zero technical knobs.
  * **Developer Portal (`apps/partner-studio`):** The full engineering workbench where FDEs and template authors configure 6-tier ladder ceilings, tune Tree-Sitter daemons, wire workflows, and package blueprints.
* **Key Invariant (Zero-Exposed-Machinery Rule):** Business clients never see model names, compute tiers, or raw Git merge markers.

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
