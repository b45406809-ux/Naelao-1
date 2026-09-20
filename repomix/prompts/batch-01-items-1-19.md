# AI Studio implementation prompt — batch 01, plan items 1–19

## Manual AI Studio hand-off contract

Implement this batch against the repository snapshot embedded after this instruction. Return the
implementation as **one complete unified Git diff** beginning with `diff --git`. Do not return a
shell script, prose before the diff, a partial snippet, or Markdown fences. The downloaded response
must be saved as `repomix/patches/batch-01.patch` and committed to
the accumulator branch. That path triggers the repository's batch-application workflow, which
validates and applies the patch, rebuilds the prompts, verifies the Repomix configuration, commits
the resulting code, and publishes the next batch XML plus its prompt as a workflow artifact.

The patch must not edit generated `repomix/outputs/` files, `.repomix-cache/`, or the downloaded
patch itself. Include tests and configuration changes in the same diff. If the entire batch cannot
fit, still return one apply-ready diff at an atomic verified boundary; the next downloaded patch
for the same batch continues from the newly generated repository snapshot.

## Mission

Implement every requirement below end to end on the current accumulator branch. The cohesive focus
is **Foundation, storage, Git, and execution ladder**. This prompt is self-contained: the feature definitions and retained implementation
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

### 1. Enterprise Depth Hierarchy

**Final behavior:** A 2-level organizational tree modeling corporate structures: Depth 0 represents the Parent Company Space (Root) holding global billing, brand kits, and compliance; Depth 1 represents Department Sub-Spaces (Legal, Dev, Ops) with localized budgets and specialized viewports.

**Production acceptance contract:**
Production entry: `SpaceDO.createSubSpaceRow`, `authorizeHierarchy`; spaces routes.
Persistence/deployment: SpaceDO `spaces`; D1 migration `0034_space_hierarchy.sql`; `SPACE_DO`.
Required observable verification: `space-hierarchy-policy.test.ts`, `launchpad-runtime.test.ts`; second-generation child is rejected.

**Retained implementation constraints:**
- 129. **Investigated the reported "no credits dialog with 5000 credits" bug thoroughly — all four
     distinct billing gates were confirmed HEALTHY for the account at investigation time; most
     likely a timing issue, not a live code bug. Plus three real, independently-reported UI/UX
     gaps, all fixed: mobile sidebars unreachable, the Message/text-tab button missing from the
     composer dock, and the verification email carrying no usable link.**
     - **Credits-dialog investigation.** Read-only (zero LLM cost, via a temporary service-bound
       worker mirroring items 128/62's own established technique) checks against all FOUR
       distinct `insufficient_credits`/`quota_exceeded` sources in `NaelaoAgentDO.enforceRunGates`
       + the org-level pre-dispatch quota check in `index.ts`: the granted personal balance
       (`5000` credits, intact), Test 1's project wallet (`balance_cents: 996`, `credited_cents:
       1000` — funded, not empty), and the org's monthly `llm_tokens` quota (`enterprise` tier,
       200,000,000 limit, `166,745` used this month) — all healthy, none would trigger the
       dialog. Also audited every code path for a Gemini/Groq/CF PROVIDER-level failure (a 429/
       rate-limit/quota-exhaustion from the LLM itself, mid-run) ever being mislabeled with one
       of the four billing `error_code`s — found none: those already route through the SEPARATE
       `classifyFailure`/`FailureKind` system (`quota_exhausted`/`rate_limited`/
       `model_unavailable`) into `InterruptedRunCard`'s self-heal flow, never `UpgradeDialog`.
       Confirmed the live shell IS running the exact deploy carrying the error_code fix
       (`e089dbaf`, `environment:"production"`). Conclusion: if the dialog is seen again, it is
       very likely a real gate genuinely firing at that moment (the account has real, separate
       state per gate) rather than a mislabeling bug — capturing the EXACT message text next time
       narrows it immediately, since each of the four has distinct wording. Temporary read-only
       worker deleted immediately after use, same discipline as item 128.
     - **Mobile sidebars were completely unreachable — root cause: the CSS was already ported
       from the mockup but nothing in React ever wired it up.** `packages/ui/src/styles.css`
       already carried `#sidebar.mobile-open`/`.mobile-topbar`/`.mobile-backdrop` (ported earlier
       from `apps/launchpad/src/index.html`'s own off-canvas-drawer pattern) — but no
- The Gap: Some builders compose parent/child Space relationships (e.g., a main Space with sub-Spaces per department). No permission inheritance model exists for this hierarchy. A user granted access to the parent Space may need explicit re-granting in each child Space. Admin changes in parent do not propagate to children.
 Required Fix: Define Space hierarchy in SpaceConfig: parent_space_id: string | null, inherit_permissions: boolean . If inherit_permissions=true : parent Space's role-to-user mappings are inherited by child Space at permission check time. Worker permission check: query parent SpaceDO for user's role if user not found in child SpaceDO. Override: explicit role grant in child Space overrides inherited role. Permission tree depth limit: 3 levels. Broadcast permission changes from parent to all children via CF Queue.
- - **Done:** `SpaceTypeProductConfig` schema (`membershipModel`, `assistantMode`,
  `allowedChildSpaceTypes`, `billingRelationship`, `userPermissions`) on the manifest;
  Launchpad defaults to `team` / `per-user` / `platform`.
- **Done — `tenant`/reseller subsystem backend (G-AS34/G-AS35):**
  - **Account hierarchy** — `infra/migrations/0033_reseller_accounts.sql`:
    `reseller_accounts` (per-reseller billing config), `tenant_hierarchy`
    (child→parent lineage), `reseller_ledger` (consolidated rollup). Dedicated tables
    keyed by `tenant_id` (kept off the `orgs`/`organizations` drift).
  - **Customer self-serve provisioning** — `POST /reseller/spaces` (spaces worker):
    resolves the reseller from the product space, gates on effective `productConfig`
    (`membershipModel` ∈ tenant/hybrid, `allowPublicSignup`, `allowedChildSpaceTypes`),
    mints/reuses a child tenant (`parent_tenant_id` = reseller), and runs the **same
    10-step provisioner** with `tenant_id = childTenant`. `GET /reseller/clients`
    returns the client portfolio + current-period billing rollup.
  - **Billing attribution** — `packages/billing-core/src/reseller.ts`
    (`computeResellerAttribution`): `reseller` = retail−wholesale margin, `referral`
    = clamped rev-share %, `platform` = no-op; refunds reverse. Wired into the Lemon
    Squeezy webhook (`workers/billing/src/lemon-squeezy.ts`) to write `reseller_ledger`
    rows. 10 unit tests in `tests/unit/reseller-attribution.test.ts`.
- **Done — tenancy topology & space hierarchy (G-Y15/G-Y16, §49), built generically for
  every SpaceType (not Launchpad-only):**
  - **`tenancy` dimension** on `SpaceTypeProductConfig` + `agencyShell`; `resolveTenancy()`
    in the pure `workers/spaces/src/tenancy.ts` (5 unit tests in
    `tests/unit/space-tenancy.test.ts`). Provisioner step 5b seeds the manifest tenancy +
    `agency_shell` onto the D1 `spaces` row and registers the SpaceDO root-space row.
  - **D1 hierarchy columns** — `infra/migrations/0034_space_hierarchy.sql`:
    `parent_space_id`, `depth`, `tenancy_mode`, `agency_shell`, `scenario_type` on `spaces`.
  - **SpaceDO `spaces` registry + `cross_space_grants`** — migration v10
    (`workers/spaces/src/do/SpaceDO.ts`): in-DO department hierarchy (depth ≤ 2, mixed-type
    gated by agency_shell, end-user type-forcing) + fail-closed cross-space permission check.
  - **Endpoints** (spaces worker): `POST/GET /spaces/:id/sub-spaces`,
    `PATCH /spaces/:id/sub-spaces/:subId`, cross-space
- ### PART 1: Sub-Spaces as Departments (The Enterprise Hierarchy)
Modeling **departments as Sub-Spaces** under a Parent Company Space is not only useful—it is the **standard architecture for scaling to enterprise and mid-market organizations**.
A company like an accounting firm, tech startup, or hospital doesn't run on one flat space:
* The **Engineering Department** needs a `product_dev` template with full isolate/container coding ladders.
* The **Legal Department** needs a `doc_studio` template with contract redlining and Delaware statutes.
* The **Support Department** needs a `customer_bot` template with WhatsApp receptionist integrations.
```
                                  ┌──────────────────────────────────────────────┐
                                  │      PARENT COMPANY SPACE (Root Depth 0)     │
                                  │      e.g. "Stripe Global Inc."               │
                                  │      • Master Billing Account (Stripe/Whop)  │
                                  │      • Company-wide Security & Brand Kit     │
                                  │      • Global Executive Oversight            │
                                  └──────────────────────┬───────────────────────┘
                                                         │
                         ┌───────────────────────────────┼───────────────────────────────┐
                         ▼                               ▼                               ▼
┌──────────────────────────────────┐   ┌──────────────────────────────────┐   ┌──────────────────────────────────┐
│ SUB-SPACE 1: Legal Department    │   │ SUB-SPACE 2: Product Engineering │   │ SUB-SPACE 3: Customer Operations │
│ • Template: `doc_studio` (Cowork)│   │ • Template: `product_dev` (Dev)  │   │ • Template: `customer_bot`       │
│ • Clearance: Confidential Docs   │   │ • Clearance: Astro Codebase & API│   │ • Clearance: Public FAQ & CRM    │
│ • Local Budget: $500/mo          │   │ • Local Budget: $2,000/mo        │   │ • Local Budget: $200/mo          │
└──────────────────────────────────┘   └──────────────────────────────────┘   └──────────────────────────────────┘
```
- #### Settings Inheritance (What Cascades Down vs. What Overrides Locally):
1. **Inherited from Parent Space (Cascading Defaults):**
   * **Master Billing Ledger:** Sub-space compute draws from the corporate balance.
   * **Company Brand Identity:** Global logo, brand colors, and company disclaimer.
   * **Company Master Knowledge:** Universal company policies (e.g., employee handbook, general compliance) automatically index into sub-space RAG.
2. **Overridden at the Sub-Space Level (Department Autonomy):**
   * **Space Template & Plugins:** Legal uses redlining viewports; Engineering uses code canvases.
   * **Local Spend Caps:** Each department has its own monthly token and compute ceiling.
   * **Departmental Channels:** Legal has a private Telegram group; Engineering has a Slack webhook.
- ### Summary Checklist
1. **Sub-Spaces as Departments:** Parent spaces provide **top-down executive oversight, corporate billing, and global brand policies**, while department sub-spaces provide **isolated templates, custom toolsets, and local spend caps**.
2. **Clean Scoping:** Sub-space members cannot see parent or sibling data by default; cross-department collaboration is explicitly authorized via `cross_space_grants`.
3. **Multi-User Projects Without Chaos:**
   * Tame thread sprawl with **1 Team Room + Dedicated Task Threads**.
   * Prevent code corruption with **Optimistic Hash-Checked SQLite Writes (`OCC`)** and **File Mutex Locks**.
   * Broadcast real-time awareness over **`WsHubDO` WebSockets**.

### 2. Sub-Space Inheritance & Isolation Matrix

**Final behavior:** Downward oversight coupled with strict upward and lateral air-gapping. Parent admins inherit full management over sub-spaces; department members cannot view parent ledgers; sibling sub-spaces have zero visibility into each other by default.

**Production acceptance contract:**
Production entry: `SpaceDO.authorizeHierarchy`, `checkCrossSpace`; `/hierarchy-authorize`.
Persistence/deployment: `space_members`, `cross_space_grants`; `SPACE_DO`.
Required observable verification: hierarchy/isolation tests; denial is fail-closed and siblings need an explicit grant.

**Retained implementation constraints:**
- 112. **A repeatable capability benchmark — 6 test cases, trace-graded — is BUILT and validated
     against production; the model matrix itself is blocked on a Cloudflare quota window, not on
     code.** Grounded in published work rather than invented: `Claw-SWE-Bench` (arXiv 2606.12344)
     holds the model fixed and swings Pass@1 from **19.1% to 73.4% on adapter design alone**, and
     reports harness choice worth 27.4pp against model choice's 29.4pp; `WildClawBench` runs the
     same 60 tasks under OpenClaw / Claude Code / Codex CLI / Hermes and sees the same effect
     (GPT-5.4: 56.8% on Codex, 50.3% on OpenClaw). So a generic leaderboard measures the wrong
     quantity — what decides whether OUR assistant runs a business is THIS loop, which is what the
     matrix scores.
     - **`workers/eval/src/trace-checks.ts` grades from the HX1 run trace, not the prose.** The LLM
       judge reads what the agent WROTE — right for answer quality, wrong for "did it do this",
       since a model can describe work it never performed and score well because the paragraph is
       genuinely good (item 108 exactly). Ten check types (`called_tool`, `verified_after_write`,
       `no_fabricated_success`, `no_identical_retry`, `escalated`, `no_secret_leak`, …). `claweval`
       scores its own tool-calling category the same way ("deterministic — tool name + params
       match"). Composition with the judge is **MIN, not average** — the same rule `judgeAnswer`
       already applies between correctness and semantic_validity: a run the trace proves fabricated
       must not be rescued by writing well about it.
     - **New dataset `tests/eval-datasets/agent-capability-matrix.jsonl`** — 6 cases over 6 axes
       (agency, safety/credentials, fabrication, recovery, proactive escalation, multi-source
       synthesis). Each maps to a published benchmark category AND a real production failure of
       ours, so no axis exists just to be passed. `trace_only` on the runner skips the judge
       entirely — a real cost lever, since the configured judge is a premium model and judging 4
       cases costs several times the 6 runs being measured.
     - **Validated against production, and it immediately caught a real model weakness.** The trace
       endpoint returned 13 real steps; asked to create a project and read it back, llama-3.3-70b
       hit the approval gate on `project.create`, correctly ran `project.list`, then **re-chose the
       already-parked action five co
- The Gap: Some builders compose parent/child Space relationships (e.g., a main Space with sub-Spaces per department). No permission inheritance model exists for this hierarchy. A user granted access to the parent Space may need explicit re-granting in each child Space. Admin changes in parent do not propagate to children.
 Required Fix: Define Space hierarchy in SpaceConfig: parent_space_id: string | null, inherit_permissions: boolean . If inherit_permissions=true : parent Space's role-to-user mappings are inherited by child Space at permission check time. Worker permission check: query parent SpaceDO for user's role if user not found in child SpaceDO. Override: explicit role grant in child Space overrides inherited role. Permission tree depth limit: 3 levels. Broadcast permission changes from parent to all children via CF Queue.
- **Config surfaces — all three backend fields already existed on `SpaceTypeProductConfig`
(`membershipModel`, `allowedChildSpaceTypes`, `userPermissions`) except one new one.** The
Configuration tab gained: a Product Mode picker (team/tenant/hybrid, with `allowPublicSignup` +
`allowedChildSpaceTypes` shown only for tenant/hybrid), a Limits section (`userPermissions`:
max threads/user, max credits/month, can-create-sub-spaces, can-create-projects), and a Templates
Catalog (checkboxes over the same hardcoded `LAUNCHPAD_TEMPLATES` list `apps/shell`'s create-
business dialog already uses — same "no builder-reachable `/templates` route yet" simplification,
applied consistently in both places). The Templates Catalog needed one genuinely new backend field,
`productConfig.catalog.businessTemplates` (`SpaceTypeRegistryDO.ts`) — plumbed through
`shell/manifest`'s existing safe-projection pattern as `business_templates`, and `apps/shell`'s
create-business dialog now filters its template picker by it (empty/unset = every template, the
pre-Phase-D default, so this is non-breaking for every product that hasn't configured it yet). All
three config sections round-tripped through `PATCH /builder/products/:id`'s existing
shallow-merge-into-`productConfig` handler with ZERO backend route changes — confirmed by feeding
the full config shape through a mocked `GET /builder/products/:id` via CDP's Fetch domain and
screenshotting the rendered, pre-populated form (Product Mode correctly showed "Hybrid" selected;
Templates Catalog correctly checked exactly the two configured templates and left the other five
unchecked). New **Agents tab** (8th tab) is a deliberately READ-ONLY view of the SpaceType's 3 core
agents (name, trigger, required-approval actions) — hardcoded like the templates lists, for the
same reason. Per-agent enable/disable (which the phased plan's Agents bullet also mentioned) was
NOT built: it would require a new `productConfig.catalog.disabledCoreAgents`-style field AND
threading it into the provisioner's agent-install step (`workers/provisioner/src/index.ts`,
`installLaunchpadAgents`) — a real, separate follow-up, flagged here rather than rushed in without
adequate test coverage for a path that touches what actually gets provisioned.
- ### The Access & Permission Rules (Inheritance Matrix)
Your codebase already laid the database foundation for this in `infra/migrations/0034_space_hierarchy.sql` and `SpaceDO.ts`. Here are the deterministic permission rules:
```
┌─────────────────────────────────────────────────────────────┬─────────────────────────────────────────────────────────────┐
│ DIRECTION / ACCESS PATH                                     │ ACCESS RULE & ENFORCEMENT                                   │
├─────────────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┤
│ ⬇️ **Parent Owner/Admin ──► Sub-Spaces**                     │ **FULL INHERITED ACCESS (Downward Oversight):**             │
│    (CEO, CFO, General Counsel)                              │ Parent owners/admins can view and manage all departments.   │
├─────────────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┤
│ ⬆️ **Sub-Space Member ──► Parent Space**                    │ **STRICT ISOLATION (Least Privilege):**                     │
│    (Junior Paralegal in Legal Dept)                         │ Cannot access parent space or financial ledgers unless      │
│                                                             │ explicitly granted a `space_members` row on the parent.     │
├─────────────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┤
│ ↔️ **Sibling Sub-Space A ──► Sibling Sub-Space B**           │ **ZERO LATERAL ACCESS (Wall by Default):**                  │
│    (Engineer in Product Dev ──► Legal Dept)                 │ Engineering cannot see Legal files. Cross-department access │
│                                                             │ requires an explicit `cross_space_grants` ticket.           │
└─────────────────────────────────────────────────────────────┴─────────────────────────────────────────────────────────────┘
```
- #### Settings Inheritance (What Cascades Down vs. What Overrides Locally):
1. **Inherited from Parent Space (Cascading Defaults):**
   * **Master Billing Ledger:** Sub-space compute draws from the corporate balance.
   * **Company Brand Identity:** Global logo, brand colors, and company disclaimer.
   * **Company Master Knowledge:** Universal company policies (e.g., employee handbook, general compliance) automatically index into sub-space RAG.
2. **Overridden at the Sub-Space Level (Department Autonomy):**
   * **Space Template & Plugins:** Legal uses redlining viewports; Engineering uses code canvases.
   * **Local Spend Caps:** Each department has its own monthly token and compute ceiling.
   * **Departmental Channels:** Legal has a private Telegram group; Engineering has a Slack webhook.
- ### Summary Checklist
1. **Sub-Spaces as Departments:** Parent spaces provide **top-down executive oversight, corporate billing, and global brand policies**, while department sub-spaces provide **isolated templates, custom toolsets, and local spend caps**.
2. **Clean Scoping:** Sub-space members cannot see parent or sibling data by default; cross-department collaboration is explicitly authorized via `cross_space_grants`.
3. **Multi-User Projects Without Chaos:**
   * Tame thread sprawl with **1 Team Room + Dedicated Task Threads**.
   * Prevent code corruption with **Optimistic Hash-Checked SQLite Writes (`OCC`)** and **File Mutex Locks**.
   * Broadcast real-time awareness over **`WsHubDO` WebSockets**.

### 3. Public vs. Private Project Access Control

**Final behavior:** Projects are partitioned into Public Commons (visible to all space members) or Confidential Workstations (membership-locked). Unauthorized members querying private projects receive a 404 Not Found to conceal the project's existence.

**Production acceptance contract:**
Production entry: `SpaceDO.listProjects/getProject`; spaces `/projects` routes.
Persistence/deployment: `projects.visibility`, `project_members`; SpaceDO migration v17.
Required observable verification: `launchpad-runtime.test.ts` plus confidential single-read/list tests; response is the same “Project not found” 404 as an absent id.

**Retained implementation constraints:**
- 141. **The six items item 140 explicitly left open are now BUILT — Phase 1 of the 62-item batch is
     complete.** `thread.create` (the assistant's own `project-coordination` prebuilt) minted a
     `threads` row with no `session_id` — the exact bug behind "Session not found" on any
     assistant-created thread. It now also mints and links a real session (generating the thread's
     own id client-side so the link can point at it, then `POST /sessions {thread_id}`), matching
     the shape a human's own "New thread" already produces; degrades to returning the bare thread
     (still real, still usable via a later open) rather than throwing if the session-link call
     itself fails. The SAME gap existed on the flat `/threads` browse page's own "New Session"
     button and its `/threads/:id` chat route — fixed identically, and that route now waits for the
     thread to load (mirroring the project-scoped page) instead of always taking Chat's client-only
     fallback.
     - **Memory was never written automatically — confirmed, and closed.** Layer 4 (Fabric,
       project-shared consolidation) already had a post-run write; Layer 5 (episodic, the layer
       `memory.recall` actually searches) did not — nothing besides the model's own occasional
       `memory.remember` tool call ever populated it, which is the real root cause of "the AI isn't
       recording anything." `NaelaoAgentDO.handleScriptRun` now also writes a low-importance (0.3,
       below the auto-promotion threshold — a background trail to recall on demand, not something
       that forces itself into every future prompt) episodic note alongside the existing Fabric
       write, same best-effort posture. `memory.remember` added to
       `LAUNCHPAD_ASSISTANT_DEFAULT_AUTO_APPROVED` (`memory.recall` was already there) — it's a
       write, but a purely internal one (lands only in the agent's own private recall store,
       invisible to anyone unless recalled again), unlike `write_file` or a commerce write, which
       stay gated.
     - **Context meter now reflects the real selected model.** `ContextUsageMeter` hardcoded
       `claude-haiku-4-5-20251001`; `Chat.tsx` had `selectedModel` in scope the whole time and
       simply never passed it to the Stats-tab instance — fixed. Also gained a manual **Compact**
       button (next to the percentage, calling the existing `/compact` route on demand rather than
       only auto-firing at 85%) and a `compact` single-line rendering mode mounte
- // Temple: PropertyAI
const TEMPLE_PROPERTYAI: Temple = {
 id: 'temple-propertyai-v1',
 name: 'PropertyAI',
 tagline: 'Listing descriptions — from property data to published copy in minutes',
 category: 'vertical-real-estate',
 spaceType: 'launchpad',
 suggestedPricing: { type: 'subscription', pricePerSeat: 4900, trialDays: 30 }, // $49/realtor/month
 defaultAuthProvider: 'naelao-native',
 productConfig: {
 allowPublicSignup: true,
 featureFlags: {
 'webhook-intake': true,
 'multi-platform-output': true, // MLS + social + email in one run
 'tone-variants': true, // Luxury vs standard tone toggle per listing
 'photo-brief-generator': true, // Describes what photos to take based on property data
 },
 adminFeatures: {
 conversationLogAccess: false,
 webhookEndpoints: true,
 analyticsAccess: true,
 },
 userPermissions: {
 canCreateProjects: true,
 canUploadKnowledge: false, // Realtors don't manage a knowledge base — it's pre-built
 maxProjectsPerUser: null,
 },
 },
 agentBundle: [
 {
 agentId: 'launchpad-fulfillment-v1',
 required: true,
 configOverrides: {
 systemPromptAddendum: 'You write real estate listing copy. You receive a JSON object with: address, bedrooms, bathrooms, sqft, lot_size, year_built, key_features (array), neighborhood_notes, price, tone ("luxury" or "standard"). You return a JSON object with: mls_description (max 500 words), social_caption (max 150 chars), email_blurb (max 80 words), photo_brief (list of 8 recommended shots with description). Always lead with the property\'s strongest feature. Never use the phrase "motivated seller". For luxury tone: no contractions, no slang. For standard tone: conversational, neighbourhood-first.',
 requiresApprovalFor: ['customer_email_send'], // Builder can toggle this off for full autopilot
 },
 },
 ],
 knowledgeSchema: [
 { documentType: 'area_market_data', required: false, description: 'Local market context agents can reference for neighbourhood descriptions', exampleUrl: null },
 ],
 estimatedSetupMinutes: 8,
 featured: true,
};
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
- ### 2. How Permissioned RAG Works in Cloudflare Vectorize
When documents are uploaded to the company’s Knowledge Base, the **Knowledge Worker** tags every chunk with an Access Control List (ACL):
```typescript
// During Document Ingestion (workers/knowledge/src/index.ts)
interface DocumentAclMetadata {
  spaceId: string;
  projectId?: string;
  visibility: "public" | "private" | "role_restricted";
  allowedRoles: Array<"owner" | "admin" | "editor" | "member" | "viewer">;
  allowedUserIds: string[]; // Specific whitelisted user IDs
}
```
When an employee queries their assistant, **Cloudflare Vectorize enforces the ACL at the vector search level**:
```typescript
// Querying Vectorize with User ACL Filtering
export async function searchPermissionedKnowledge(
  vectorize: VectorizeIndex,
  queryEmbedding: number[],
  spaceId: string,
  user: { id: string; role: string }
) {
  // The vector engine PHYSICALLY discards chunks the user is not cleared for
  const results = await vectorize.query(queryEmbedding, {
    topK: 5,
    filter: {
      spaceId: spaceId,
      // Metadata match: Public OR user's role is in allowed_roles OR user is whitelisted
      $or: [
        { visibility: "public" },
        { allowedRoles: { $in: [user.role] } },
        { allowedUserIds: { $in: [user.id] } }
      ]
    }
  });
  return results.matches;
}
```
- ### 3. Public vs. Private Projects & Workspaces
The platform's project hierarchy cleanly separates **Public Company Commons** from **Confidential Workstations**:
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            COMPANY SPACE (ORGANIZATION)                     │
├─────────────────────────────────────────────────────────────────────────────┤
│ 🌐 PUBLIC PROJECTS (Visible to all space members)                           │
│ ├── 📁 Project: "Product Engineering" (Astro codebase, open to all devs)    │
│ ├── 📁 Project: "Marketing & Brand" (Social assets, open to whole team)     │
│ └── 📁 Project: "Customer Support" (Public FAQ bot, visible to all agents)  │
├─────────────────────────────────────────────────────────────────────────────┤
│ 🔒 PRIVATE PROJECTS (Encrypted & restricted to invited members only)        │
│ ├── 📁 Project: "Executive M&A Room" (Only CEO + CFO + General Counsel)    │
│ ├── 📁 Project: "Performance Reviews" (Only HR Director + Department Lead)  │
│ └── 📁 Project: "Legal Litigation" (Only External Counsel + Partners)       │
└─────────────────────────────────────────────────────────────────────────────┘
```
- #### Hardware-Level Enforcement in `SpaceDO.ts`:
In `workers/spaces/src/do/SpaceDO.ts`, private projects are protected by `project_members` ACLs:
1. **`visibility: "public"`**: Any authenticated member in the space can view the project, browse files, and summon agents.
2. **`visibility: "private"`**:
   * Filtered out of `listProjects()` for uninvited users.
   * `readWorkspaceFile()` and `listThreads()` return **404 Not Found** if the user's `userId` is not an active row in `project_members`.
   * An employee’s Space Assistant **cannot read, grep, or search** files in a private project unless that employee was explicitly invited by the project creator.
- ### Axis 5: Decentralized & Scoped Intelligence ("Mini-AGI" & Permissioned Vector RAG) *(Continued)*
**Core Architectural Blueprint (Continued)**
* **Indirect Injection Security Firewalls:** Context-sanitization layers scan tool outputs, third-party web content, and retrieved vector chunks before prompt insertion [1.3.17]. Untrusted dynamic payloads are encapsulated in strict semantic boundary tags (e.g., `<untrusted_retrieval_chunk>`), explicitly signaling to the model's attention layers that text within these blocks cannot alter operational instructions or tool-dispatch policies [1.3.17].
* **Hierarchical Role-Based Access Control (RBAC):** Every document ingestion payload registers access bitmasks (defining tenant, department, project, and specific user IDs). Queries executed by an agent inherit the authenticated user's permission bitmask, automatically discarding unauthorized semantic matches at the vector index level prior to score thresholding [1.3.17].
```
                        ┌────────────────────────────────────────────────────────┐
                        │              COMPANY KNOWLEDGE VAULT                   │
                        │           (Ingested via R2 & Vectorize)                │
                        └──────────────────────────┬─────────────────────────────┘
                                                   │
                ┌──────────────────────────────────┴──────────────────────────────────┐
                ▼                                                                     ▼
┌───────────────────────────────────────┐                             ┌───────────────────────────────────────┐
│     USER A (Junior Developer)         │                             │       USER B (General Counsel)        │
│   • Role Mask: [DEV_READ, PUBLIC]     │                             │   • Role Mask: [LEGAL, EXEC, CONF]    │
└──────────────────┬────────────────────┘                             └──────────────────┬────────────────────┘
                   │                                                                     │
                   ▼ (Vectorize Query with ACL Bitmask)                                  ▼ (Vectorize Query with ACL Bitmask)
┌───────────────────────────────────────┐                             ┌───────────────────────────────────────┐
│   RETRIEVAL FILTER:                   │                             │   RETRIEVAL FILTER:                   │
│   WHERE (role_mask & 0x0001) > 0      │                             │   WHERE (role_mask & 0x0010) > 0      │
│   AND space_id = "space_102"          │                             │   AND space_id = "space_102"          │
└──────────────────┬────────────────────┘                             └──────────────────┬────────────────────┘
                   │                                                                     │
                   ▼                                                                     ▼
┌───────────────────────────────────────┐                             ┌───────────────────────────────────────┐
│ MATCHED CONTEXT:                      │                             │ MATCHED CONTEXT:                      │
│ • API Architecture Guidelines         │                             │ • Master Services Agreement (MSA)     │
│ • Git Branching Conventions           │                             │ • M&A Term Sheets & Cap Table         │
│ (Restricted Legal Chunks Excluded)    │                             │ (Full Unrestricted Semantic Graph)    │
└───────────────────────────────────────┘                             └───────────────────────────────────────┘
```
- #### Failure Modes & Anti-Patterns
* **Post-Retrieval Filtering (Information Leakage via Ranking):** Performing vector similarity search across all documents and filtering unauthorized documents in application logic allows unauthorized chunks to alter top-$k$ nearest-neighbor density, inadvertently leaking the existence or topical clustering of classified materials.
* **Global Assistant Amnesia & Scope Leakage:** Sharing memory state across different project spaces within the same organization allows non-privileged project threads to inherit semantic facts derived in restricted rooms [1.3.15].
* **Raw String Interpolation of External Artifacts:** Injecting unstructured scraper outputs directly into the prompt without semantic envelope encapsulation allows third-party websites to execute prompt injection against the agent.
- #### Core Architectural Blueprint
Multi-agent concurrency across shared workspaces is organized into a four-tier operational structure enforced by stateful edge actors:
```
┌───────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   THE 4-TIER COLLABORATION MODEL                                          │
├────────────────────┬─────────────────────────┬────────────────────────────┬───────────────────────────────┤
│ Tier Level         │ Audience & Visibility   │ Multi-Player Interaction   │ Workspace Write Permissions   │
├────────────────────┼─────────────────────────┼────────────────────────────┼───────────────────────────────┤
│ **Tier 1: Team**   │ **Public to Project**   │ Humans chat freely;        │ **Full Execution:**           │
│ **Room**           │ (All team members)      │ Agents answer on `@mention`│ File edits, builds, deploys.  │
├────────────────────┼─────────────────────────┼────────────────────────────┼───────────────────────────────┤
│ **Tier 2: Task**   │ **Public to Project**   │ Focused on 1 Feature/DAG;  │ **Full Execution:**           │
│ **Workstations**   │ (All team members)      │ Teammates + `@DevAgent`    │ Locks & OCC patches.          │
├────────────────────┼─────────────────────────┼────────────────────────────┼───────────────────────────────┤
│ **Tier 3: System** │ **Internal System**     │ Space Assistant consulting │ **Coordination Only:**        │
│ **Consult Lanes**  │ (Collapsed in UI)       │ Specialist Agents in bg    │ Journal & state updates.      │
├────────────────────┼─────────────────────────┼────────────────────────────┼───────────────────────────────┤
│ **Tier 4: Private**│ **Strictly Private**    │ 1-on-1 between User & Agent│ **Read-Only / Simulation:**   │
│ **Scratchpad**     │ (Only that single user) │ No `@mention` needed       │ Zero direct writes to repo.   │
└────────────────────┴─────────────────────────┴────────────────────────────┴───────────────────────────────┘
```
* **Optimistic Concurrency Control (OCC) Storage Layer:** The authoritative filesystem stores source files as content-addressed chunk graphs in SQLite. File update transactions execute atomically using Compare-And-Swap (CAS) based on SHA-256 hashes.
* **Hierarchical File Mutex Engine:** Long-running refactoring operations acquire bounded-TTL distributed mutexes managed by dedicated actor instances. If an agent attempts to edit a locked file, the runtime intercepts the operation and signals the agent to yield or execute alternative DAG paths.
* **Slack-Style `@mention` Dispatch Matrix:** Public project rooms (Tier 1 & Tier 2) process multi-user chat streams. Agents remain inactive until explicitly summoned via tokens (e.g., `@DevAgent`), preventing unprompted token burn and race conditions [1.3.17].

### 4. Project-Anchored Automation Architecture

**Final behavior:** Background automations and cron routines never float unattached at the root space level; every automation lives inside a specific project container (e.g. Stripe reconciler lives in `Project: Treasury`), inheriting a Git repo, testing harnesses, and access control.

**Production acceptance contract:**
Production entry: `requireManageableAutomationProject`; schedules/triggers/workflow dispatch.
Persistence/deployment: D1 `0073_project_scoped_automation.sql`; `SPACE_DO`, `WORKFLOWS`.
Required observable verification: project-automation and workflow-tier tests; missing/cross-tenant IDs fail before insert.

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
- Required Fix: An operator project's container image (the same Tier-5 container-marketplace mechanism from Phase L, item 36, now with its first real, non- coming_soon catalogue entry: dev-sandbox , a container with git + a language runtime preinstalled) clones the operator's registered repository on first use and the workspace prebuilt's copy/move ops (G-BG09's neighbor, Phase R) are joined by workspace.git_commit / git_branch / git_diff ops, so every Dev agent change is a real, revertable git commit against a real branch (never directly against the operator's default branch — the Dev agent always works on a per-spec feature branch, merged only after G-BG05's gate passes), not a set of file writes with no history.
- **Fix — a wallet-specific role resolver, not a change to the generic one:** the generic
`resolveEndUserBusinessRole`'s root-is-`"member"` shortcut stays untouched (sessions, projects,
threads all still need it). New `resolveWalletAccessRole` (`business-auth.ts`) instead: for a
space with no `parent_space_id` (the product root), returns `null` — no product_end_user has any
legitimate wallet access there, full stop; for a business (child) space, delegates to the same
real `business_memberships` lookup as everything else, so a business owner/admin still reads
their OWN business's wallet exactly as before. Wrapped in a new
`requireBusinessMembershipForWallet` middleware (its own 5s-TTL cache, kept separate from the
generic role cache so the two resolvers' answers for the same `(spaceId, endUserId)` key can never
cross-contaminate) — applied in place of `requireBusinessMembership` on all three end-user-reachable
wallet read routes: `GET .../projects/:projectId/wallet/{balance,history}` and the consolidated
`GET /spaces/:spaceId/wallet`. Every non-`product_end_user` caller (builder JWT roles) is
unaffected, per the file's existing additive-only convention.
- ### 1. The Updated 6-Tier Cloudflare Execution Ladder
Integrating **Dynamic Workflows** gives your platform durable, multi-day background execution without holding open expensive sockets or burning worker CPU while waiting on external systems or cron schedules:
```
                                  ┌─────────────────────────────────────────────────────────────┐
                                  │ TIER 6: Sandboxed Linux Container (ToolSandboxDO / Ubuntu)  │
                                  │ • Full OS userland: npm install, compilers, Python binaries │
                                  └──────────────────────────────▲──────────────────────────────┘
                                                                 │ (Promote if native compilation needed)
                                  ┌──────────────────────────────┴──────────────────────────────┐
                                  │ TIER 5: Full Headless Chromium (Puppeteer / Browser Render) │
                                  │ • Heavy browser: Visual QA snapshots, WebGL, Canvas, Bot-Def│
                                  └──────────────────────────────▲──────────────────────────────┘
                                                                 │ (Promote if visual QA / WebGL needed)
                                  ┌──────────────────────────────┴──────────────────────────────┐
                                  │ TIER 4: Lightweight Agent Browser (Cloudflare Kitesurf)     │
                                  │ • 3–7x cheaper/faster: DOM text extraction & form fills     │
                                  └──────────────────────────────▲──────────────────────────────┘
                                                                 │ (Promote if web navigation needed)
                                  ┌──────────────────────────────┴──────────────────────────────┐
                                  │ TIER 3: Dynamic Workflows (Cloudflare Workflows / Cron Hub) │
                                  │ • Durable multi-step runs, hours/days execution, sleep/pause│
                                  │ • Step retry boundaries, scheduled crons without awake DOs │
                                  └──────────────────────────────▲──────────────────────────────┘
                                                                 │ (Promote if task is long-running/durable)
                                  ┌──────────────────────────────┴──────────────────────────────┐
                                  │ TIER 2: Dynamic Worker Loader (V8 Isolate Shell / TS Script)│
                                  │ • Pure code execution, HTTP fetches, MCP orchestration      │
                                  └──────────────────────────────▲──────────────────────────────┘
                                                                 │ (Promote if script logic needed)
┌────────────────────────────────────────────────────────────────┴──────────────────────────────┐
│ TIER 1: Direct In-Memory Virtual FS (@cloudflare/computer / DO SQLite)                        │
│ • Sub-millisecond Read, Edit (AST Search & Replace), Grep, Glob, just-bash                    │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```
- ### How Tier 3 (Dynamic Workflows) Functions
When an agent needs to execute a task that spans multiple hours or requires scheduled checks (e.g., *"Monitor this government bidding portal every 6 hours and send a summary on Friday"*), running a synchronous loop inside a Durable Object would waste compute budget.
Instead, the agent compiles the task into a **Cloudflare Workflow (`ScriptRunWorkflow.ts`)**:
1. **Step Durability & State Checkpoints:** Each workflow step (`step.do(...)`) automatically serializes its output to Cloudflare storage. If an external API errors or rate-limits, only that step retries—the rest of the pipeline does not restart.
2. **Dormant Sleeping (`step.sleep`):** The workflow can pause for hours or days at **$0 compute cost**, waking up at the exact timestamp required.
3. **Cron Triggers Without Awake DOs:** Scheduled jobs trigger directly from Cloudflare’s workflow scheduler rather than an awake background worker.
```typescript
// workers/agents/src/workflows/DynamicTaskWorkflow.ts
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
export class DynamicTaskWorkflow extends WorkflowEntrypoint<Env, { scriptName: string; args: any }> {
  async run(event: WorkflowEvent<{ scriptName: string; args: any }>, step: WorkflowStep) {
    // Step 1: Execute scraping pass (Tier 4 Kitesurf)
    const rawData = await step.do("scrape-portal", async () => {
      return await executeKitesurfScrape(event.payload.args.targetUrl);
    });
    // Step 2: Sleep for 6 hours (Zero compute cost during wait)
    await step.sleep("wait-for-update-window", "6 hours");
    // Step 3: Compare diff and dispatch report
    await step.do("compile-and-notify", async () => {
      return await compareAndSendReport(rawData);
    });
  }
}
```
- ### 4. Real-World Use Case: How a Founder Uses This
1. **Record a 60-Second Video:**
   The user opens their screen recorder, navigates to their municipal zoning portal, filters by "Commercial Permits", downloads a CSV, and says:
   > *"I'm searching for new permits in Miami, downloading the report, and filtering out residential projects."*
2. **Drop into Workspace:**
   They upload `permit_demo.mp4` into their `growth_engine` project.
3. **AI Learns the Skill:**
   The user types in chat:
   > *"Learn a new skill called `scrape_miami_permits` from `permit_demo.mp4` and schedule it as a Tier 3 Dynamic Workflow every Monday."*
4. **Autonomous Execution Forever:**
   The agent distills the video into `code.ts`, verifies it in Kitesurf, registers it as a reusable skill, and schedules it inside **Tier 3 Dynamic Workflows** to run every week without anyone touching a keyboard again.

### 5. Cloudflare Artifacts Git-for-Agents Engine

**Final behavior:** Native, serverless Git versioning running inside Durable Objects via a Zig-to-WASM engine. Provides real, full-fidelity repositories for commits, branches, and diffs.

**Production acceptance contract:**
Production entry: artifact worker `RepositoryDO`; artifacts prebuilt; agent turn commit adapter.
Persistence/deployment: DO SQLite objects/refs/commits; `ARTIFACT_WORKER`, `AGENT_REPOS`.
Required observable verification: `workers/artifact/src/repository.test.ts`, artifact worker tests; refs and commits survive new requests.

**Retained implementation constraints:**
- ## Stack
- CF Workers (router, auth, spaces, agents, knowledge, billing, etc.)
- CF Durable Objects + DO SQLite (`SpaceDO` = structure/agent_definitions, `NaelaoAgentDO` = agent runtime, sessions, memory)
- CF R2 (KB documents, exports, backups, artifacts)
- CF Vectorize (KB semantic search — shared multi-tenant index with spaceId filter)
- CF KV (circuit breakers, config cache, session revocation, portal routes)
- CF Queues + DLQ (async events, webhook delivery, analytics, notifications)
- CF Workflows (provisioning, erasure, ingestion, billing, dunning)
- CF Analytics Engine (events, metrics — append-only, 25M rows/day limit)
- D1 (platform metadata, billing, users — single instance today; sharding a named future milestone)
- LLM: Cloudflare AI Gateway is the LLM path — the gateway HOLDS the Anthropic provider key
  (Authenticated Gateway / BYOK via `NAELAO_AIG_TOKEN`), so no `ANTHROPIC_API_KEY` lives on any
  worker (item 45). Claude is primary with a gateway-driven fallback chain.
- PLATFORM billing (Stripe removed — item 45): Naelao's own normal Whop seller account is tried
  FIRST for builder platform plans (item 58), Lemon Squeezy is the fallback. End-user
  subscriptions/credit-packs try the business's own connected Whop company (OAuth-delegated,
  item 58) first, then LS, then a dev placeholder.
- Whop is the business-bank-account rail (item 50, replacing item 49's Stripe/LS Wallet Connect):
  every business auto-provisions an isolated Whop sub-merchant wallet at creation — no builder
  action. This is BUSINESS revenue custody, a different thing from Naelao's own platform billing
  above.
- Next.js on CF Pages (builder dashboard)
- The Gap The spec calls this.ctx.waitUntil(promise) inside the Slack webhook handler to defer post-response processing. In a Cloudflare Worker fetch handler, ctx (ExecutionContext) exposes waitUntil(). However, inside a Durable Object, this.ctx is a DurableObjectState, which does NOT have a waitUntil() method — this method only exists on ExecutionContext (the second argument to Worker fetch). Calling this.ctx.waitUntil(promise) in a DO throws "TypeError: this.ctx.waitUntil is not a function" at runtime, crashing the DO's request handler and returning a 500 error to the Slack webhook endpoint, causing Slack to retry the webhook up to 3 times and potentially triggering duplicate processing.
- **Session token-budget guard — the actual differentiator vs. OpenClaw's "$300-500/mo, no
warning" complaints.** New `SpaceTypeProductConfig.limits.sessionCreditCeiling` (config_json
override, same convention as `modelConfig`/`pricingConfig` — never a manifest fork), resolved
once in `index.ts` next to `modelConfig` (this DO has no `PLATFORM_DB` binding) and threaded
through all three dispatch paths that reach `handleScriptRun` (the sync `/script/run` call, the
async `AgentTaskWorkflow` params, and `/internal/tasks/:taskId/run`) so the guard applies
identically to interactive and durable runs. New `session_spend` table (SpaceDO migration v31,
same one as the signals table) holds only the running tally — the ceiling itself is never stored
there, avoiding a split-brain against the config_json copy.
- ### Summary of What This Establishes:
1. **Deterministic Multi-Tier Knowledge (Mini-AGI):** Documents are partitioned by **Space, Project, and Role Rank**; Vectorize discards unauthorized chunks at the hardware query layer so classified information never leaks.
2. **Google-Search-Level Edge Intelligence:** Combines **sub-50ms KV semantic caching**, **Hybrid RRF (Dense Vectorize + Sparse BM25)**, and **live edge web search** with clickable citation footnotes.
3. **Safe Multi-Player Collaboration:** Users and agents can freely branch and experiment in **Tier 4 Private Scratchpads**. Edits are committed via structured **Pull Requests**, and teammates review visual diffs and merge changes to the main workspace with zero risk of code clobbering.
The release of **Cloudflare Artifacts (Git for Agents)** provides the exact native infrastructure layer needed for this architecture.
Instead of hand-rolling custom table schemas in SQLite to simulate branches and diffs, Cloudflare has built a **native Git-compatible versioned filesystem running inside Durable Objects (via a Zig-to-WASM Git engine)**.
This unlocks the **Per-Session/Per-Project Git Engine**, **Instant Zero-Copy Forking**, and **ArtifactFS FUSE Mounting** directly within our 6-Tier Execution Ladder.
- ### 1. What Cloudflare Artifacts Actually Is
* **Git-Native Storage at Agent Scale:** Built to create tens of millions of repositories programmatically (one repo per business, per project, per agent session, or per test experiment).
* **Zig-to-WASM Git Server in Durable Objects:** Runs a full Git server compiled to WebAssembly directly inside Cloudflare Durable Objects.
* **3 API Access Surfaces:**
  1. **Native Workers Binding (`env.ARTIFACTS`):** Programmatic repo creation, forking, commit reading, and token provisioning in sub-milliseconds.
  2. **Smart HTTP Git Remote (`https://artifacts.cloudflare.net/...`):** Any standard Git client, isolate shell, or container can run native `git clone`, `git commit`, `git push` using short-lived repo-scoped tokens.
  3. **ArtifactFS (Open-Source FUSE Driver):** Mounts repositories directly into `/workspace` inside Linux Containers on the fly, **hydrating file contents lazily instead of blocking on full clones (shaving 90–100 seconds off container cold starts)**.
- ### 5. Why This Sets You Apart from Polsia and Claude Code
1. **True Git Versioning for Agents:** You are not storing loose strings in a database. Every project has a **real, full-fidelity Git repository on Cloudflare** with commits, authors, trees, and tags.
2. **Instant Micro-Forking (10ms):** When a user enters a Tier 4 Private Scratchpad or spawns 5 subagents, the platform creates 5 instant repository forks in parallel for **zero compute cost**.
3. **90-Second Container Acceleration:** With **`ArtifactFS`**, Linux containers mount the repository on the fly via FUSE, pulling only the files being touched instead of freezing the user for 2 minutes while `git clone` downloads 200MB.
4. **Commit-Driven CI/CD at the Edge:** Pushing a commit triggers a Cloudflare Worker via `artifacts.repo.pushed`, automatically building the site and updating the edge preview on Cloudflare Pages.
- # 1. The Upstream Staleness & AI Rebase Engine
When work is committed to `main` (Tier 1 Team Room), any active Tier 4 Private Scratchpad or Tier 2 Task Thread automatically detects that it is **behind upstream** and enables the agent to **autonomously inspect, evaluate, and pull changes.**
```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                        UPSTREAM STALENESS & AI REBASE FLOW                                             │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 1. [Commit on Main]         Admin merges PR #14 on `main` (New Commit: `c_main_v2`).                   │
│                                  │                                                                     │
│ 2. [Artifacts Event]        Cloudflare Queue receives `artifacts.repo.pushed`.                        │
│                             `WsHubDO` broadcasts `workspace.upstream_pushed` to all active threads.    │
│                                  │                                                                     │
│ 3. [Divergence Calculation] Active Thread DO queries: `env.AGENT_REPOS.compare(scratchpad, main)`      │
│                             Result: "2 commits behind main. Files changed: ['src/api/stripe.ts']"     │
│                                  │                                                                     │
│ 4. [UI Status Bar]          Thread UI updates: `[ 🌿 scratchpad-alice | ⚠️ 2 commits behind | [Sync] ]`│
│                                  │                                                                     │
│ 5. [AI Auto-Reconciliation] Agent in thread inspects diff:                                             │
│                             • "My task is editing `src/Header.astro`."                                 │
│                             • "Upstream changed `src/api/stripe.ts` (No direct overlap)."              │
│                             • Agent triggers `git.pull_upstream()` and updates its local types!        │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```
- # 4. Four More Game-Changing Capabilities with Cloudflare Artifacts
Because Cloudflare Artifacts gives you **tens of millions of real Git repositories running inside Durable Objects**, you can unlock capabilities that neither Claude Code nor GitHub can match:
- ### Summary of What This Adds to the Platform
| Feature | How It Works with Cloudflare Artifacts |
| :--- | :--- |
| **Upstream Staleness Tracking** | Real-time `commitsBehind` badges across all scratchpads and task threads. |
| **Smart Agent Rebase** | Agents inspect upstream diffs before pulling, auto-rebasing non-overlapping files. |
| **Turn-by-Turn Time Machine** | 1-click rollback to any historical agent turn via instant Git commit resets. |
| **Reasoning-Aware `git-blame`** | Agents read historical commit reasoning to understand why past code was written. |
| **Multi-Model Branch Races** | Fork 3 branches for 3 models in parallel; merge the winning benchmarked code. |
| **AST-Aware Merge Resolver** | AI resolves Git merge conflicts automatically by understanding code syntax. |

### 6. In-Memory Virtual POSIX Shell (`@cloudflare/computer`)

**Final behavior:** Sub-millisecond shell executing 90%+ of agent terminal actions (`grep`, `cat`, `sed`, `awk`, `find`, `jq`, `diff`, Unix pipes) in V8 isolates against DO SQLite without starting a container.

**Production acceptance contract:**
Production entry: `r2-workspace`/workspace prebuilts and tool surface.
Persistence/deployment: project R2 prefix + SpaceDO locks; `SCRIPTS_R2`.
Required observable verification: file-manager/R2 workspace tests; shell-like reads and writes avoid container startup.

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

- Required Fix: The Security agent runs two passes before G-BG05's deploy gate can pass: (1) a SAST pass — a security.static_scan Tier-2/3 skill wrapping an off-the-shelf open-source scanner (Semgrep's community ruleset is a reasonable default — runs as a subprocess inside the Tier-5 dev-sandbox container from G-BG10, output parsed into structured findings, not prose) against the exact diff G-BG04's blast-radius already scoped; (2) a targeted adversarial pass — a security.exploit_attempt skill that, for any spec touching an auth boundary, input-handling path, or the payments/wallet surface (flagged automatically from the blast-radius call sites), spins up the changed code in an isolated sandbox and attempts a curated battery of known exploit classes (SQLi/XSS/SSRF/auth-bypass/IDOR patterns — the same vulnerability classes this very platform's own historical audit passes, items 21-29/39/55, found and fixed BY HAND; this is that same discipline automated). A finding at HIGH or above blocks deploy exactly like a QA failure; MED/LOW findings are recorded and surfaced in the Control Room (G-BG07) as a queued, non-blocking item.
- - **Migration `0065_whop_kyc_onboarding.sql`** rebuilds `whop_sub_merchants` (SQLite can't ALTER
  a CHECK constraint in place — same limitation migration 0052 hit for `processed_webhook_events`)
  adding `status IN ('pending','awaiting_kyc','active','error')` and a nullable `onboarding_url`
  column.
- **`createSubMerchant`** (`packages/billing-core/src/providers/whop.ts`) now returns
  `{company_id, status, onboarding_url?}`. Since the exact response field name Whop uses for the
  onboarding link is unverified (docs.whop.com blocks unauthenticated fetches — confirmed by
  direct testing during this session), it defensively checks a few plausible names
  (`onboarding_url`/`account_link`/`verification_url`) and falls back to an honest
  `awaiting_kyc` with no link (rather than fabricating one) if Whop signals
  `requires_onboarding` without supplying a URL.
- **`getCompanyStatus`** derives `awaiting_kyc` from the plain `payouts_enabled: false` boolean
  during a live sync, independent of whatever status string Whop's own API returns — a more
  reliable signal than the unverified onboarding-link field name, mirroring exactly how the
  removed Stripe Connect rail (A1.29) polled `charges_enabled`/`payouts_enabled` rather than
  trusting the return-redirect.
- **`provisionSubMerchant`** best-effort emails the owner the moment a wallet lands in
  `awaiting_kyc` (`notifyOwnerOnboardingRequired`, never blocks provisioning on send failure) —
  with the link if one was captured, or a plain "check your email from Whop" if not.
- **Payout gating** (`POST /billing/whop-wallet/payouts`) now names the verification step
  explicitly in its 409 rather than a generic "wallet not active" message.
- **UI**: dashboard `PaymentsAccountCard` and the shell business-detail page both show an amber
  "one more step" banner with a direct "Complete verification" link when Whop supplied one, or a
  "check your email" fallback when it didn't. Both wallet-carrying assistant profiles
  (`DEFAULT_NAELAO_AGENT`, `LAUNCHPAD_ASSISTANT_PROFILE`) were told explicitly: `awaiting_kyc`
  means the wallet can still receive revenue but cannot pay out yet — tell the owner plainly,
  never let a payout request fail with no explanation.
- ### How Every Tier Reads and Writes to the Same Workspace
1. **Tier 1 (In-Memory DO SQLite) & Tier 2 (Dynamic Worker Loader):**
   * Operates directly inside the V8 isolate. `Read`, `Edit`, `Write`, `Grep`, and `Glob` execute against SQLite in **sub-milliseconds** without network latency.
2. **Tier 3 (Dynamic Workflows):**
   * Workflows run across hours/days, but every step (`step.do`) reads its inputs from and commits its outputs back to the **Project's DO SQLite Virtual Filesystem** via internal RPC. If a workflow runs at 3:00 AM, the files it generates are immediately waiting in the workspace when the human wakes up.
3. **Tier 4 (Kitesurf) & Tier 5 (Chromium Puppeteer):**
   * When an agent scrapes a webpage, extracts tables, or downloads PDFs/CSVs via `download_file`, the binary stream is written directly to the **Project Virtual FS (`workspace_files`)** under `downloads/{sessionId}/...`. The agent can immediately run `Read` or `Grep` on the downloaded file on its next turn.
4. **Tier 6 (Sandboxed Linux Container / `ToolSandboxDO`):**
   * Before running native commands (`npm install`, `python3 script.py`), `workspace.sync_to_container` stages all project files from the DO SQLite database into the container's local `/workspace` disk.
   * When the command completes, any modified files or newly generated build artifacts (e.g. `dist/`, `output.csv`) are **flushed back to DO SQLite using SHA-256 hash diffs**.
- ### 2. The 6 Tier-Specific Universal Execution Primitives
Your agent's prompt contains only **6 universal execution primitives** (one per tier of the Cloudflare ladder):
```
                                  ┌─────────────────────────────────────────────────────────────┐
                                  │           THE SCRIPT-NATIVE EXECUTION ENGINE                │
                                  └──────────────────────┬───────────────────────┘
                                                         │
         ┌───────────────────────┬───────────────────────┼───────────────────────┬───────────────────────┐
         ▼                       ▼                       ▼                       ▼                       ▼
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│ TIER 1:          │    │ TIER 2:          │    │ TIER 3:          │    │ TIER 4 / 5:      │    │ TIER 6:          │
│ `exec_sqlite_fs` │    │ `exec_isolate`   │    │ `exec_workflow`  │    │ `exec_browser`   │    │ `exec_container` │
│ (Virtual Storage)│    │ (Isolate CodeMode│    │ (Dynamic Workflow│    │ (Kitesurf/Puppet)│    │ (Linux Bash/npm) │
├──────────────────┤    ├──────────────────┤    ├──────────────────┤    ├──────────────────┤    ├──────────────────┤
│ Read, Edit, Diff,│    │ Pure TypeScript/ │    │ Durable runs,    │    │ DOM scraping,    │    │ Full Ubuntu shell│
│ Grep, Glob, AST  │    │ JS with fetch &  │    │ crons, multi-day │    │ form automation, │    │ npm install, pip,│
│ in-memory DO.    │    │ MCP chaining.    │    │ background tasks.│    │ visual snapshots.│    │ native compilers.│
└──────────────────┘    └──────────────────┘    └──────────────────┘    └──────────────────┘    └──────────────────┘
```
- #### The Primitive Tool Definitions:
```typescript
export interface ScriptNativeTierPrimitives {
  // TIER 1: In-Memory SQLite Virtual Filesystem
  exec_sqlite_fs: {
    description: "Execute in-memory file operations (read, patch, diff, grep, glob) against DO SQLite.";
    parameters: { op: "read" | "patch" | "write" | "grep" | "glob" | "diff"; params: Record<string, any> };
  };
  // TIER 2: V8 Isolate CodeMode (Pure CodeAct in V8)
  exec_isolate_codemode: {
    description: "Execute arbitrary TypeScript/JS code in a V8 Isolate with fetch() and ctx.mcp bindings. Sub-millisecond execution.";
    parameters: { code: string; args?: Record<string, any> };
  };
  // TIER 3: Dynamic Durable Workflows
  exec_workflow: {
    description: "Deploy and trigger a durable Cloudflare Workflow for long-running, multi-step, or cron-scheduled tasks.";
    parameters: { workflowCode: string; schedule?: string; params?: Record<string, any> };
  };
  // TIER 4: Lightweight Kitesurf Agent Browser
  exec_kitesurf: {
    description: "Fast, low-memory DOM extraction, article parsing, and form interaction (3-7x lighter than Chromium).";
    parameters: { url: string; actions?: Array<{ type: "click" | "type" | "extract"; selector: string; value?: string }> };
  };
  // TIER 5: Full Chromium Puppeteer
  exec_browser: {
    description: "Full Chromium engine for WebGL, Canvas, bot challenges, and pixel-perfect Visual QA screenshots.";
    parameters: { url: string; puppeteerScript: string };
  };
  // TIER 6: Sandboxed Linux Container Bash
  exec_container_bash: {
    description: "Execute Linux shell commands in Docker container (ToolSandboxDO) for npm, pip, native builds, and compilers.";
    parameters: { command: string; filesToStage?: string[] };
  };
}
```

### 7. Clean Namespace Separation (`/workspace/` vs. `/.avos/`)

**Final behavior:** Physical boundary between user deliverables and agent meta-state. `/workspace/` contains application code/data tracked by Git; `/.avos/` is Git-ignored and holds agent skills, workflows, and scratchpads.

**Production acceptance contract:**
Production entry: workspace path normalization; container `materializeWorkspace/collectWorkspace`.
Persistence/deployment: distinct workspace/control prefixes; `SCRIPTS_R2`, artifact DO.
Required observable verification: adversarial namespace traversal tests; `/.avos` is excluded from Git collection.

**Retained implementation constraints:**
- 94. **Skill self-improvement (the last open gap from the OpenClaw/Hermes analysis) and a real
    connector directory are now BUILT.** Two independent pieces, both live-verified.
    - **The skill gap as previously written was slightly wrong, and the correction matters.**
      Outcomes WERE recorded and `script.find` WAS sorted by them. The real problem: `stability_score`
      is a LIFETIME ratio, which cannot express recency — 20 successes and 4 failures scores 0.83
      whether those failures are spread over a year or are the last four runs in a row. A skill that
      broke yesterday kept being offered as proven, kept being picked, and kept failing. New
      `script-engine/skill-health.ts` adds the recency layer: `ScriptMetadata.recent_outcomes`, a
      bounded (10) window carrying the ERROR of each failure, and `assessSkillHealth` →
      `unproven | proven | degrading | broken`. Three consumers: `script.find` demotes a failing
      skill (never hides it — an agent cannot repair what it can't see); the GATE refuses to
      auto-run one at L1 and routes it to L2/L3 repair carrying its own `last_error` as the
      `repairTarget.failureReason`; and the reasoner's candidate projection now includes the health
      record, with a `DECISION_INSTRUCTIONS` paragraph telling it to patch rather than re-run.
      **A real design bug caught by writing the test:** demoting a broken skill pushed it under
      `FIND_CONFIDENCE_FLOOR`, so the loop read "nothing relevant found" and went to L4 (write a
      NEW skill) instead of repairing the one it had. Fixed by splitting the score into
      `FindCandidate.relevance` (stability × similarity — what the GATE's floor tests, "is there a
      skill about this at all") and `confidence` (relevance × health — the sort key, "and can I
      trust it as it stands"). Health must never affect relevance.
    - **New `skill-manager` prebuilt** gives the agent agency over its own library, since the
      automatic half can't decide to fix a skill nobody is currently reaching for:
      `skill.health` (assessment naming what's broken/degrading/promotable), `skill.inspect`
      (real errors + patch history), `skill.rollback`, `skill.retire` (deletes the Vectorize
      embedding too — otherwise it stays findable-but-unresolvable), `skill.promote` (delegates to
      the already-existing `/skills/promote` route, which owns the template lookup + threshold —
      one gate, not two that drift). Reads auto-approved in guided
- 35 architectural gaps covering: OpenClaw feature parity (continuous background loop, fiber concurrency, proactive trigger types, tool chaining, skill marketplace, inline sub-agent delegation, channel hub normalization, delegation chain), MCP Apps ecosystem (App Store, installed app persistence, tool approval flow, scope model, McpAgent/AIChatAgent separation, OAuth callback), Skills self-improvement via Hermes pattern (crystallization loop, versioning, test suite, within-session cache, conflict resolution), multi-container coordination (pool management, container specialization, filesystem sync, pre-warming, network policy), shared agent user data isolation (memory namespace, Vectorize filter, session isolation, R2 path divergence), instance management (atomic limit enforcement, hibernation flush, spaceId/userId restoration, observability), and missing CF primitive usage (Vectorize write path, decay_rate application, ctx.waitUntil() crash).
- **M3 — `LocalTunnelDO` (agents worker, new `LOCAL_TUNNEL` binding, migration v7).** One instance
per `(spaceId, userId)`, using the CF Hibernation API (`ctx.acceptWebSocket`) — the exact same
pattern `workers/ws-gateway`'s `WsHubDO` already established, so the DO can sleep between requests.
`GET /local-tunnel/connect?space=&user=&token=` (agents worker, deliberately unauthenticated at the
Hono layer — the caller is a native client on someone's own machine, not a browser session with a
JWT to check; `verifyLocalTunnelToken` inside the DO is the actual gate) upgrades to a WebSocket.
`POST /exec` on the DO correlates a request to its eventual WS response via an in-memory pending
map with a 30-second timeout; a clean disconnect resolves any still-pending calls immediately with
an honest "the Local Agent disconnected" rather than making the caller wait out the full timeout.
This DO's own test coverage is bounded exactly where `WsHubDO`'s already is: the test harness stubs
`cloudflare:workers` for plain-Node vitest and explicitly does not instantiate DOs that touch
`WebSocketPair`/`ctx.acceptWebSocket` (real CF runtime primitives with no Node polyfill in this
suite) — verified by typecheck + code review, matching the codebase's own established boundary for
CF-native primitives, not a gap unique to this phase.

### 8. 6-Tier Cloudflare Execution Ladder

**Final behavior:** Hierarchical compute routing: Tier 1 (DO SQLite VFS), Tier 2 (V8 Isolate Shell), Tier 3 (Workflows), Tier 4 (Kitesurf Browser), Tier 5 (Chromium), Tier 6 (Container Sandbox).

**Production acceptance contract:**
Production entry: `runStoredScript`, `buildCodeRunner`, browser engine fallback, workflow runner.
Persistence/deployment: Loader, Workflows, Browser, Sandbox and R2 bindings.
Required observable verification: execution-ladder/workflow/browser/container tests; result records actual tier/engine.

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

- Execution Ladder
 The 5-tier hierarchy of compute resources: workspace (R2) → isolate (Dynamic Worker) → npm (DW + packages)
 → browser (CF Browser Rendering) → sandbox (CF Container). Agent always uses the lowest sufficient tier.
- **L3 — the routing hook, wired ahead of any image (`ScriptMetadata.container_image`).** A
`requires_tier: 5` script may now carry a `container_image` tag; `execution-ladder.ts` forwards it
to `codeRunner.run()`, and `code-runner.ts`'s `runContainer` checks a NEW `CodeRunnerOptions.
containerImages: Record<string, DurableObjectNamespace>` map — if the named image has a bound
namespace, it addresses that image's own DO (`slot:{image}:{space}:{project ?? "_assistant"}`,
same addressing convention as Phase K's base sandbox) instead of the shared `ToolSandboxDO`; if
not, it fails closed with a clear message rather than silently falling back to the base sandbox
(which would run the script against the WRONG compute — e.g. a `postgres.query` script executing
in a plain Python/Bash container with no postgres binary at all). This is the extension point
whichever image lands first will plug into: add its Dockerfile + DO class + `[[containers]]`
binding, wire the binding into `containerImages`, flip its catalogue `available` to `true` — no
other code changes needed.
- ### 2. The Refined Execution Ladder: Adding Cloudflare Kitesurf
Placing **Cloudflare Kitesurf** directly before full **Chromium Browser Rendering** provides a massive cost and performance advantage:
* **Kitesurf (Announced Aug 2026):** A lightweight, agent-first browser engine that uses **3–7x less CPU and RAM than Chromium** and starts in milliseconds. It is ideal for 80% of agent web tasks (extracting clean text, navigating DOMs, filling forms, and reading articles).
* **Headless Chromium:** The heavy artillery. Used only when Kitesurf hits a wall (WebGL, complex bot challenges, canvas painting, or visual pixel-perfect screenshots).
```
                                  ┌─────────────────────────────────────────────────────────────┐
                                  │ TIER 5: Sandboxed Linux Container (ToolSandboxDO / Ubuntu)  │
                                  │ • Full OS userland: npm install, compilers, Python binaries │
                                  └──────────────────────────────▲──────────────────────────────┘
                                                                 │ (Promote if native binary required)
                                  ┌──────────────────────────────┴──────────────────────────────┐
                                  │ TIER 4: Full Headless Chromium (Cloudflare Browser / Puppeteer)
                                  │ • Heavy browser: Visual QA screenshots, WebGL, Canvas, Bot-Shield
                                  └──────────────────────────────▲──────────────────────────────┘
                                                                 │ (Promote if WebGL/Visual QA required)
                                  ┌──────────────────────────────┴──────────────────────────────┐
                                  │ TIER 3: Lightweight Agent Browser (Cloudflare Kitesurf)     │
                                  │ • 3-7x less CPU/memory; ultra-fast DOM extraction & form fills
                                  └──────────────────────────────▲──────────────────────────────┘
                                                                 │ (Promote if web navigation required)
                                  ┌──────────────────────────────┴──────────────────────────────┐
                                  │ TIER 2: Dynamic Worker Isolate (V8 Script Execution)       │
                                  │ • TypeScript/JS execution, HTTP fetches, MCP orchestration │
                                  └──────────────────────────────▲──────────────────────────────┘
                                                                 │ (Promote if script logic required)
┌────────────────────────────────────────────────────────────────┴──────────────────────────────┐
│ TIER 1: Direct In-Memory Virtual FS (@cloudflare/computer / DO SQLite)                        │
│ • Sub-millisecond Read, Edit (AST Search & Replace), Grep, Glob, just-bash                    │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```
- ### 3. Tier Comparison & Transparent Fallback Protocol
```
┌──────────┬──────────────────────┬────────────────────────┬──────────────────────┬────────────────────────────┐
│ Tier     │ Name                 │ Compute Primitive      │ Memory / Cost        │ Capabilities & Gaps        │
├──────────┼──────────────────────┼────────────────────────┼──────────────────────┼────────────────────────────┤
│ **T1**   │ Virtual SQLite FS    │ DO SQLite in-memory    │ ~0ms / $0.00         │ `Read`, `Edit`, `Grep`     │
├──────────┼──────────────────────┼────────────────────────┼──────────────────────┼────────────────────────────┤
│ **T2**   │ Isolate Shell        │ Dynamic Worker Isolate │ ~5MB / $0.0001       │ TS logic, HTTP, MCP chain  │
├──────────┼──────────────────────┼────────────────────────┼──────────────────────┼────────────────────────────┤
│ **T3**   │ **Kitesurf Browser** │ **Agent-First Web**    │ **~30MB / $0.001**   │ **DOM reads, form fills**  │
│          │                      │                        │                      │ *(No WebGL/Screenshots)*   │
├──────────┼──────────────────────┼────────────────────────┼──────────────────────┼────────────────────────────┤
│ **T4**   │ **Chromium Browser** │ **Full Puppeteer**     │ **~200MB / $0.01**   │ **Visual QA, WebGL, Canvas**│
├──────────┼──────────────────────┼────────────────────────┼──────────────────────┼────────────────────────────┤
│ **T5**   │ Linux Container      │ Docker / MicroVM       │ ~512MB / $0.05       │ `npm install`, compilers   │
└──────────┴──────────────────────┴────────────────────────┴──────────────────────┴────────────────────────────┘
```
- ### Summary of What This Adds
1. **Self-Improving Skill Accumulation:** Any complex CLI or browser task done once can be **distilled into a versioned skill** stored in R2, making future executions 100x faster and cheaper.
2. **Kitesurf as Tier 3:** Dramatically cuts compute costs for web scraping and form filling by using Cloudflare's lightweight **Kitesurf engine**, reserving full **Chromium (Tier 4)** strictly for visual QA and complex rendering.
3. **Frictionless Ladder Escalation:** Tiers promote smoothly: **Tier 1 (SQLite FS)** $\rightarrow$ **Tier 2 (Isolate)** $\rightarrow$ **Tier 3 (Kitesurf)** $\rightarrow$ **Tier 4 (Chromium)** $\rightarrow$ **Tier 5 (Container)** with zero crashed turns.
- ### 1. The Updated 6-Tier Cloudflare Execution Ladder
Integrating **Dynamic Workflows** gives your platform durable, multi-day background execution without holding open expensive sockets or burning worker CPU while waiting on external systems or cron schedules:
```
                                  ┌─────────────────────────────────────────────────────────────┐
                                  │ TIER 6: Sandboxed Linux Container (ToolSandboxDO / Ubuntu)  │
                                  │ • Full OS userland: npm install, compilers, Python binaries │
                                  └──────────────────────────────▲──────────────────────────────┘
                                                                 │ (Promote if native compilation needed)
                                  ┌──────────────────────────────┴──────────────────────────────┐
                                  │ TIER 5: Full Headless Chromium (Puppeteer / Browser Render) │
                                  │ • Heavy browser: Visual QA snapshots, WebGL, Canvas, Bot-Def│
                                  └──────────────────────────────▲──────────────────────────────┘
                                                                 │ (Promote if visual QA / WebGL needed)
                                  ┌──────────────────────────────┴──────────────────────────────┐
                                  │ TIER 4: Lightweight Agent Browser (Cloudflare Kitesurf)     │
                                  │ • 3–7x cheaper/faster: DOM text extraction & form fills     │
                                  └──────────────────────────────▲──────────────────────────────┘
                                                                 │ (Promote if web navigation needed)
                                  ┌──────────────────────────────┴──────────────────────────────┐
                                  │ TIER 3: Dynamic Workflows (Cloudflare Workflows / Cron Hub) │
                                  │ • Durable multi-step runs, hours/days execution, sleep/pause│
                                  │ • Step retry boundaries, scheduled crons without awake DOs │
                                  └──────────────────────────────▲──────────────────────────────┘
                                                                 │ (Promote if task is long-running/durable)
                                  ┌──────────────────────────────┴──────────────────────────────┐
                                  │ TIER 2: Dynamic Worker Loader (V8 Isolate Shell / TS Script)│
                                  │ • Pure code execution, HTTP fetches, MCP orchestration      │
                                  └──────────────────────────────▲──────────────────────────────┘
                                                                 │ (Promote if script logic needed)
┌────────────────────────────────────────────────────────────────┴──────────────────────────────┐
│ TIER 1: Direct In-Memory Virtual FS (@cloudflare/computer / DO SQLite)                        │
│ • Sub-millisecond Read, Edit (AST Search & Replace), Grep, Glob, just-bash                    │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```
- ### How Tier 3 (Dynamic Workflows) Functions
When an agent needs to execute a task that spans multiple hours or requires scheduled checks (e.g., *"Monitor this government bidding portal every 6 hours and send a summary on Friday"*), running a synchronous loop inside a Durable Object would waste compute budget.
Instead, the agent compiles the task into a **Cloudflare Workflow (`ScriptRunWorkflow.ts`)**:
1. **Step Durability & State Checkpoints:** Each workflow step (`step.do(...)`) automatically serializes its output to Cloudflare storage. If an external API errors or rate-limits, only that step retries—the rest of the pipeline does not restart.
2. **Dormant Sleeping (`step.sleep`):** The workflow can pause for hours or days at **$0 compute cost**, waking up at the exact timestamp required.
3. **Cron Triggers Without Awake DOs:** Scheduled jobs trigger directly from Cloudflare’s workflow scheduler rather than an awake background worker.
```typescript
// workers/agents/src/workflows/DynamicTaskWorkflow.ts
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
export class DynamicTaskWorkflow extends WorkflowEntrypoint<Env, { scriptName: string; args: any }> {
  async run(event: WorkflowEvent<{ scriptName: string; args: any }>, step: WorkflowStep) {
    // Step 1: Execute scraping pass (Tier 4 Kitesurf)
    const rawData = await step.do("scrape-portal", async () => {
      return await executeKitesurfScrape(event.payload.args.targetUrl);
    });
    // Step 2: Sleep for 6 hours (Zero compute cost during wait)
    await step.sleep("wait-for-update-window", "6 hours");
    // Step 3: Compare diff and dispatch report
    await step.do("compile-and-notify", async () => {
      return await compareAndSendReport(rawData);
    });
  }
}
```
- ### 4. Real-World Use Case: How a Founder Uses This
1. **Record a 60-Second Video:**
   The user opens their screen recorder, navigates to their municipal zoning portal, filters by "Commercial Permits", downloads a CSV, and says:
   > *"I'm searching for new permits in Miami, downloading the report, and filtering out residential projects."*
2. **Drop into Workspace:**
   They upload `permit_demo.mp4` into their `growth_engine` project.
3. **AI Learns the Skill:**
   The user types in chat:
   > *"Learn a new skill called `scrape_miami_permits` from `permit_demo.mp4` and schedule it as a Tier 3 Dynamic Workflow every Monday."*
4. **Autonomous Execution Forever:**
   The agent distills the video into `code.ts`, verifies it in Kitesurf, registers it as a reusable skill, and schedules it inside **Tier 3 Dynamic Workflows** to run every week without anyone touching a keyboard again.

### 9. Invisible Runtime Hypervisor

**Final behavior:** The LLM prompt is stripped of complex tier-selection tools, presenting only a minimalist 3-tool surface (`Bash`, `Read`, `Edit`) + 2 senses (`Browser`, `Delegate`). The runtime hypervisor silently routes commands to the cheapest capable tier.

**Production acceptance contract:**
Production entry: `ScriptToolSurface.run` → `runStoredScript`.
Persistence/deployment: script metadata in R2; runtime bindings server-side.
Required observable verification: tool-surface and launchpad-runtime tests; callers name an action, not infrastructure.

**Retained implementation constraints:**
- 141. **The six items item 140 explicitly left open are now BUILT — Phase 1 of the 62-item batch is
     complete.** `thread.create` (the assistant's own `project-coordination` prebuilt) minted a
     `threads` row with no `session_id` — the exact bug behind "Session not found" on any
     assistant-created thread. It now also mints and links a real session (generating the thread's
     own id client-side so the link can point at it, then `POST /sessions {thread_id}`), matching
     the shape a human's own "New thread" already produces; degrades to returning the bare thread
     (still real, still usable via a later open) rather than throwing if the session-link call
     itself fails. The SAME gap existed on the flat `/threads` browse page's own "New Session"
     button and its `/threads/:id` chat route — fixed identically, and that route now waits for the
     thread to load (mirroring the project-scoped page) instead of always taking Chat's client-only
     fallback.
     - **Memory was never written automatically — confirmed, and closed.** Layer 4 (Fabric,
       project-shared consolidation) already had a post-run write; Layer 5 (episodic, the layer
       `memory.recall` actually searches) did not — nothing besides the model's own occasional
       `memory.remember` tool call ever populated it, which is the real root cause of "the AI isn't
       recording anything." `NaelaoAgentDO.handleScriptRun` now also writes a low-importance (0.3,
       below the auto-promotion threshold — a background trail to recall on demand, not something
       that forces itself into every future prompt) episodic note alongside the existing Fabric
       write, same best-effort posture. `memory.remember` added to
       `LAUNCHPAD_ASSISTANT_DEFAULT_AUTO_APPROVED` (`memory.recall` was already there) — it's a
       write, but a purely internal one (lands only in the agent's own private recall store,
       invisible to anyone unless recalled again), unlike `write_file` or a commerce write, which
       stay gated.
     - **Context meter now reflects the real selected model.** `ContextUsageMeter` hardcoded
       `claude-haiku-4-5-20251001`; `Chat.tsx` had `selectedModel` in scope the whole time and
       simply never passed it to the Stats-tab instance — fixed. Also gained a manual **Compact**
       button (next to the percentage, calling the existing `/compact` route on demand rather than
       only auto-firing at 85%) and a `compact` single-line rendering mode mounte
- The Gap: Builders writing long system prompts have no tool to see how many tokens their prompt consumes and how much context remains for conversation history and KB chunks. They discover context limits only at runtime when the LLM call fails or silently truncates.
 Required Fix: Add token counter to system prompt editor in builder dashboard: live token count as builder types (using tiktoken-js in the browser). Shows: [System Prompt: 2,400 tokens] + [KB Injection: ~1,200 tokens] + [History: variable] = [Total: ~3,600 / 128,000 tokens] . Context budget visualizer: bar showing allocation across system prompt, KB, history, response reserve. Warning when system prompt exceeds 10% of context window (leaves insufficient room for conversation). On publish: CI check rejects if system prompt + KB injection > 50% of smallest supported model context window.
- - **Entry gate** (`NaelaoAgentDO.handleScriptRun`): a project-scoped run that acts on behalf of a
  user (non-empty `userId`, excluding the channel drain's synthetic `channel:...` ids, which never
  route through here anyway) resolves the clamp via a new `fetchAssistantAccess` (internal HMAC
  call to the existing spaces-worker endpoint) BEFORE any billing gate. `null` effective role
  (`assistant_mode='none'`, or a plain non-member) → 403 `assistant_access_denied`; lookup error →
  403 `assistant_access_unverified` (fail CLOSED — the fetchProjectConfig/F17 posture: an
  authorization check that fails open isn't one). No acting user (cron/trigger/webhook/bootstrap
  wakes) → no clamp, the assistant's own base grant, exactly as the clamp's SpaceDO doc always
  specified.
- **Read-only enforcement** (`ScriptEngineEnv.effectiveRole` + `ScriptToolSurface`, the `maxTier`
  structural precedent): `"viewer"` (which is also what `read_only` maps to server-side, even for
  a project owner) refuses `script.create/update/delete`, every STORED script (arbitrary
  agent-authored code is assumed mutating — fail closed), and any prebuilt op not on the explicit
  read-safe allowlist in the new `script-engine/assistant-access.ts` (`READ_SAFE_PREBUILT_OPS` —
  small and explicit like wallet.ts's credential-name list; a new prebuilt op is write-gated until
  consciously classified). `script.read`/`script.find` and read ops (read_file, knowledge.search,
  wallet.balance, project.list, ...) still work.
- **Approval-policy intersection** (`resolveAssistantApprovalPlan`, pure + unit-tested): `yolo`
  now fully applies only for system wakes (no `x-naelao-role` — the autonomous operation the owner
  configured it for) and owner/admin callers (who could self-authorize any gated action anyway);
  every other verified caller role — editor/viewer builders, `product_end_user`, `agent` API keys,
  and unrecognized roles (fail closed) — downgrades to the always_ask posture
  (`gate_unless_listed` + the policy's own `auto_approved_actions`).
- **Two escape hatches closed while wiring:** (1) `POST /agents/:agentId/script/run` (the worker's
  script-first entrypoint, whose own doc says "owner-initiated calls arrive with the usual
  JWT-derived headers") silently DROPPED `x-naelao-user-id`/`x-naelao-role` when forwarding to the
  DO — so not just the clamp but also handleScriptRun's per-caller billing branches could never
  apply to runs entering there; both headers are now forwarded (the ro
- ### Summary of Guarantees
1. **True Single Source of Truth:** Whether a file is created by a user in the UI, an agent editing with `Edit`, a headless browser downloading an asset, or a Python script running inside a Docker container, **all bytes settle into the DO SQLite Virtual Filesystem (`workspace_files`)**.
2. **Universal Tool Experience:** The AI doesn't need 50 specialized tools for every language or environment. It uses **`Read`**, **`Edit`**, **`Write`**, **`Grep`**, **`Glob`**, and **`Bash`** everywhere, and the Cloudflare Execution Ladder automatically handles isolation, promotion, and synchronization behind the scenes.
But let add more tools for tiers specific like does it want to run cf/codemode or something like workflows or browser or bash/cmd/terminal in container etc . Infect  remove the universal tools and make tier basic tools be the universal so if it needs to run bash that's a tier 6 universal tool  things like read edit can be prebuilt tier1 skills scripts it can run so it's mostly script native like https://arxiv.org/abs/2402.01030, https://www.alphaxiv.org/abs/2505.20286 https://arxiv.org/html/2604.07791v1 and so on other aper I might have left out .I want to one found to be better on benchmarks. It writes it's own tools and improve and learn a skill and next time just read skill and run the tool it created only this time we have tier based execution ladder
This shifts the architecture to the **state of the art in AI agent research**.
By adopting the **Script-Native / Code-as-Action** paradigm (backed by papers like **CodeAct [arXiv:2402.01030]**, **Dynamic Tool Synthesis & Evolution [arXiv:2505.20286]**, and **Code-as-Policies [arXiv:2604.07791]**), you eliminate the biggest flaw in modern agents: **static JSON tool bloat**.
Instead of feeding 30 rigid JSON tool schemas into every prompt, your agent gets **6 Tier-Specific Execution Primitives**. Everything else—reading, AST editing, scraping, database migrations, invoice syncing—is a **reusable, self-evolving script authored and improved by the agent itself.**
- ### 2. The 6 Tier-Specific Universal Execution Primitives
Your agent's prompt contains only **6 universal execution primitives** (one per tier of the Cloudflare ladder):
```
                                  ┌─────────────────────────────────────────────────────────────┐
                                  │           THE SCRIPT-NATIVE EXECUTION ENGINE                │
                                  └──────────────────────┬───────────────────────┘
                                                         │
         ┌───────────────────────┬───────────────────────┼───────────────────────┬───────────────────────┐
         ▼                       ▼                       ▼                       ▼                       ▼
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│ TIER 1:          │    │ TIER 2:          │    │ TIER 3:          │    │ TIER 4 / 5:      │    │ TIER 6:          │
│ `exec_sqlite_fs` │    │ `exec_isolate`   │    │ `exec_workflow`  │    │ `exec_browser`   │    │ `exec_container` │
│ (Virtual Storage)│    │ (Isolate CodeMode│    │ (Dynamic Workflow│    │ (Kitesurf/Puppet)│    │ (Linux Bash/npm) │
├──────────────────┤    ├──────────────────┤    ├──────────────────┤    ├──────────────────┤    ├──────────────────┤
│ Read, Edit, Diff,│    │ Pure TypeScript/ │    │ Durable runs,    │    │ DOM scraping,    │    │ Full Ubuntu shell│
│ Grep, Glob, AST  │    │ JS with fetch &  │    │ crons, multi-day │    │ form automation, │    │ npm install, pip,│
│ in-memory DO.    │    │ MCP chaining.    │    │ background tasks.│    │ visual snapshots.│    │ native compilers.│
└──────────────────┘    └──────────────────┘    └──────────────────┘    └──────────────────┘    └──────────────────┘
```
- #### The Primitive Tool Definitions:
```typescript
export interface ScriptNativeTierPrimitives {
  // TIER 1: In-Memory SQLite Virtual Filesystem
  exec_sqlite_fs: {
    description: "Execute in-memory file operations (read, patch, diff, grep, glob) against DO SQLite.";
    parameters: { op: "read" | "patch" | "write" | "grep" | "glob" | "diff"; params: Record<string, any> };
  };
  // TIER 2: V8 Isolate CodeMode (Pure CodeAct in V8)
  exec_isolate_codemode: {
    description: "Execute arbitrary TypeScript/JS code in a V8 Isolate with fetch() and ctx.mcp bindings. Sub-millisecond execution.";
    parameters: { code: string; args?: Record<string, any> };
  };
  // TIER 3: Dynamic Durable Workflows
  exec_workflow: {
    description: "Deploy and trigger a durable Cloudflare Workflow for long-running, multi-step, or cron-scheduled tasks.";
    parameters: { workflowCode: string; schedule?: string; params?: Record<string, any> };
  };
  // TIER 4: Lightweight Kitesurf Agent Browser
  exec_kitesurf: {
    description: "Fast, low-memory DOM extraction, article parsing, and form interaction (3-7x lighter than Chromium).";
    parameters: { url: string; actions?: Array<{ type: "click" | "type" | "extract"; selector: string; value?: string }> };
  };
  // TIER 5: Full Chromium Puppeteer
  exec_browser: {
    description: "Full Chromium engine for WebGL, Canvas, bot challenges, and pixel-perfect Visual QA screenshots.";
    parameters: { url: string; puppeteerScript: string };
  };
  // TIER 6: Sandboxed Linux Container Bash
  exec_container_bash: {
    description: "Execute Linux shell commands in Docker container (ToolSandboxDO) for npm, pip, native builds, and compilers.";
    parameters: { command: string; filesToStage?: string[] };
  };
}
```

### 10. `ArtifactFS` FUSE Driver with Lazy Hydration

**Final behavior:** Linux containers mount project workspaces on the fly over FUSE, pulling file contents lazily over the edge network and eliminating 90-second `git clone` delays.

**Production acceptance contract:**
Production entry: `container/artifact-fs.mjs`, sandbox workspace sync.
Persistence/deployment: artifact worker/R2; `ARTIFACT_WORKER`, `SCRIPTS_R2`.
Required observable verification: `artifact-fs.test.mjs`, container workspace tests; list does not fetch bodies.

**Retained implementation constraints:**
- 103. **Self-directed loop stopping (real-time progress visibility), a real project-thread/session
     conflation bug fixed, and automatic request-retry-with-visible-feedback — three
     user-reported items, all BUILT.**
     - **The loop previously told the model it was almost out of budget only via `final_step`, on
       the very last possible turn — it had NO visibility into its own progress before that.** A
       model that kept failing had no way to notice and stop itself; the only way a run ever ended
       early was being cut off externally with a generic, unhelpful message. New
       `Reasoner.decide()` `progress` field (`script-engine/loop.ts`) — step / max_steps (the
       runaway ceiling, explicitly NOT a target), successful_actions, failed_actions, stall_steps /
       max_stall_steps, tokens_used / max_tokens — computed fresh and passed on EVERY L3/L4 turn,
       not just the final one. `DECISION_INSTRUCTIONS` (`reasoner.ts`) now tells the model
       explicitly: use this to judge whether you're converging; if failed actions are climbing or
       the stall streak is closing in on its limit with nothing to show, `give_up` on your OWN
       initiative, right now, with a SPECIFIC explanation of what you tried and why it didn't work
       — don't wait to be cut off. This is additive to the existing `final_step` mechanism (item 91
       in the the established specification / the established architecture's own step-budget work), not a replacement — an
       externally-forced stop still happens if the model doesn't act on the signal itself. 2 new
       tests in `agent-loop-unbounded.test.ts`: progress is reported correctly turn-by-turn (not
       just once), and a model that sees 2 failed attempts stops itself after 3 turns total with a
       real reason — nowhere near the 50-step ceiling, proving the stop was self-directed, not
       externally forced.
     - **Reported live: a thread created and chatted in inside a project also appeared in the flat
       Sessions sidebar, as if it were a separate, unrelated conversation — and the thread then
       seemed to "disappear" from the project.** Root cause, confirmed by reading the code rather
       than guessed: `Chat.tsx`'s lazy session creation (`ensureSessionId`) called `startSession()`
       with NO link back to the thread it belonged to, so the resulting session was
       indistinguishable from an ordinary Home/assistant conversation — and SpaceDO's
       `listSessions()` had no way to exclude it, since `t
- The Gap The spec mentions FUSE-mounted R2 as the container workspace but never specifies: (1) which R2 bucket prefix each container mounts, (2) how FUSE write-back is triggered (write-through vs. write-behind), (3) how a second container reading a file written by the first container avoids a stale cache read, and (4) what happens when two containers write to the same file concurrently. In the Moltworker model, R2 is the source of truth: containers use FUSE write-through (every write is immediately PUT to R2), and cache invalidation uses R2 event notifications (R2 PUT fires an event that all containers with the affected key in their FUSE cache must invalidate).
- **K2 — R2 sync as the "mount," since Cloudflare Containers have no native R2 filesystem mount.**
This is the honest mechanism available on this platform today: `ToolSandboxDO` now reads the
project's R2 workspace (the SAME `workspacePrefix()`-scoped bucket/prefix Tier-1 `r2-workspace`
already reads/writes) before forwarding an `/exec` call to the container harness, hands the files
over as a `workspace_files` map in the request body, and on response writes back whatever the
harness reports as `/workspace`'s final contents (`workspace_files_out`) — including deleting any
file that existed before the run but is gone afterward (the script deleted it). R2 is the
persistent source of truth: a cold-started container (post-sleep or post-restart) still sees the
same files because they're materialized fresh from R2 on every call, never relied upon to survive
in the container's own ephemeral disk. Bounded (300 files / 2MB per file / 25MB per call —
generous for a working set, not unlimited; a project that outgrows this is a Container
Marketplace-tier problem, §A1.17 Phase L, not a bigger cap here) and text-only (matches the
existing R2-workspace convention of `.text()`, not binary-safe — an honest, documented
limitation). `/build` (the legacy Whop micro-tool build/test route) is untouched — it never
touched a project workspace and still doesn't.
- ### 1. What Cloudflare Artifacts Actually Is
* **Git-Native Storage at Agent Scale:** Built to create tens of millions of repositories programmatically (one repo per business, per project, per agent session, or per test experiment).
* **Zig-to-WASM Git Server in Durable Objects:** Runs a full Git server compiled to WebAssembly directly inside Cloudflare Durable Objects.
* **3 API Access Surfaces:**
  1. **Native Workers Binding (`env.ARTIFACTS`):** Programmatic repo creation, forking, commit reading, and token provisioning in sub-milliseconds.
  2. **Smart HTTP Git Remote (`https://artifacts.cloudflare.net/...`):** Any standard Git client, isolate shell, or container can run native `git clone`, `git commit`, `git push` using short-lived repo-scoped tokens.
  3. **ArtifactFS (Open-Source FUSE Driver):** Mounts repositories directly into `/workspace` inside Linux Containers on the fly, **hydrating file contents lazily instead of blocking on full clones (shaving 90–100 seconds off container cold starts)**.
- ### 3. Execution Ladder Integration with Artifacts
Here is how each tier of the 6-tier ladder interacts with Cloudflare Artifacts:
| Ladder Tier | How it talks to Cloudflare Artifacts |
| :--- | :--- |
| **Tier 1 & 2 (DO SQLite & V8 Isolates)** | Uses the **Native Workers Binding (`env.ARTIFACTS`)** to inspect trees, read line-numbered files, and commit AST patches via programmatic RPC. |
| **Tier 3 (Dynamic Workflows)** | Subscribes to **Artifacts Lifecycle Events (`artifacts.repo.pushed`, `repo.created`)** via Cloudflare Queues to trigger automatic review agents, builds, and tests. |
| **Tier 4 & 5 (Kitesurf & Chromium)** | Web assets or downloads are committed directly into an Artifacts branch (`git add downloads/ && git commit`). |
| **Tier 6 (Linux Containers / ToolSandboxDO)** | Uses **`ArtifactFS` (FUSE mount)**. The container mounts `/workspace` lazily from the Artifacts Git remote without doing a heavy `git clone`, executing `npm install` and compiling code instantly. |
- ### 5. Why This Sets You Apart from Polsia and Claude Code
1. **True Git Versioning for Agents:** You are not storing loose strings in a database. Every project has a **real, full-fidelity Git repository on Cloudflare** with commits, authors, trees, and tags.
2. **Instant Micro-Forking (10ms):** When a user enters a Tier 4 Private Scratchpad or spawns 5 subagents, the platform creates 5 instant repository forks in parallel for **zero compute cost**.
3. **90-Second Container Acceleration:** With **`ArtifactFS`**, Linux containers mount the repository on the fly via FUSE, pulling only the files being touched instead of freezing the user for 2 minutes while `git clone` downloads 200MB.
4. **Commit-Driven CI/CD at the Edge:** Pushing a commit triggers a Cloudflare Worker via `artifacts.repo.pushed`, automatically building the site and updating the edge preview on Cloudflare Pages.

### 11. 4-Dimension State Synchronization Engine

**Final behavior:** Prevents split-brain between V8 Isolates and Containers across Filesystem, Shell Session (`cwd`/`export`), Git HEAD ref, and DO SQLite state.

**Production acceptance contract:**
Production entry: state coordinator; ToolSandbox session and artifact adapters.
Persistence/deployment: DO SQLite session state + artifact refs + R2.
Required observable verification: stale-revision and container persistence tests; conflicts reject stale writers.

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
- Required Fix: Add UserProfile component to Space UI: end-user sets display_name, avatar (upload or select from preset icons), color_theme preference (light/dark/auto). Stored in SpaceDO SQLite end_user_profiles keyed by user_id. Profile persists across sessions. In collaborative sessions (AY04), display name and avatar shown next to each user's messages. Agent addressed end-user by display_name if set ("Hi Sarah,"). Builder can configure required profile fields at Space registration. GDPR: profile data in end-user export (AO30); deletable (AO31). Avatar images stored in R2 with user_id prefix; CDN-served at /spaces/{id}/users/{uid}/avatar.
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
- ### 1. The Unified Filesystem Sync Protocol (All 6 Tiers)
To ensure there is **zero split-brain, zero data loss, and zero file desynchronization**, every tier in the 6-tier ladder connects to the **Authoritative Virtual Filesystem (`workspace_files` in `NaelaoAgentDO`'s SQLite storage)**.
```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                        TIER 1: THE SINGLE AUTHORITATIVE SOURCE OF TRUTH                                │
│                     [ NaelaoAgentDO SQLite Virtual Filesystem (`workspace_files`) ]                    │
│                                 (SHA-256 Checkpoints + In-Memory Fast Cache)                           │
└────────┬───────────────────┬───────────────────┬───────────────────┬───────────────────┬───────────────┘
         │                   │                   │                   │                   │
         ▼ (Direct Memory)   ▼ (RPC)             ▼ (Step State)      ▼ (Capture)         ▼ (FUSE Sync)
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│ TIER 1 & 2:     │ │ TIER 3:         │ │ TIER 4:         │ │ TIER 5:         │ │ TIER 6:         │
│ Isolate Shell & │ │ Dynamic         │ │ Kitesurf        │ │ Full Chromium   │ │ Linux Container │
│ V8 Worker       │ │ Workflows       │ │ Agent Browser   │ │ Puppeteer       │ │ ToolSandboxDO   │
├─────────────────┤ ├─────────────────┤ ├─────────────────┤ ├─────────────────┤ ├─────────────────┤
│ • Sub-ms read/  │ │ • Step checks   │ │ • Scraped DOM   │ │ • Screenshots   │ │ • /workspace    │
│   edit in DO.   │   serialize to DO   text/JSON saved   & PDF downloads   FUSE-synced with│
│ • just-bash &   │ • Pauses/resumes    directly to DO    streamed to DO    SQLite chunks.  │
│   Wasm ripgrep. │   from SQLite FS    Virtual FS.       Virtual FS.       │ • npm/pip writes  │
│                 │   state.            │                 │                 │   flush back.     │
└─────────────────┘ └─────────────────┘ └─────────────────┘ └─────────────────┘ └─────────────────┘
```
- ### Summary of Guarantees
1. **True Single Source of Truth:** Whether a file is created by a user in the UI, an agent editing with `Edit`, a headless browser downloading an asset, or a Python script running inside a Docker container, **all bytes settle into the DO SQLite Virtual Filesystem (`workspace_files`)**.
2. **Universal Tool Experience:** The AI doesn't need 50 specialized tools for every language or environment. It uses **`Read`**, **`Edit`**, **`Write`**, **`Grep`**, **`Glob`**, and **`Bash`** everywhere, and the Cloudflare Execution Ladder automatically handles isolation, promotion, and synchronization behind the scenes.
But let add more tools for tiers specific like does it want to run cf/codemode or something like workflows or browser or bash/cmd/terminal in container etc . Infect  remove the universal tools and make tier basic tools be the universal so if it needs to run bash that's a tier 6 universal tool  things like read edit can be prebuilt tier1 skills scripts it can run so it's mostly script native like https://arxiv.org/abs/2402.01030, https://www.alphaxiv.org/abs/2505.20286 https://arxiv.org/html/2604.07791v1 and so on other aper I might have left out .I want to one found to be better on benchmarks. It writes it's own tools and improve and learn a skill and next time just read skill and run the tool it created only this time we have tier based execution ladder
This shifts the architecture to the **state of the art in AI agent research**.
By adopting the **Script-Native / Code-as-Action** paradigm (backed by papers like **CodeAct [arXiv:2402.01030]**, **Dynamic Tool Synthesis & Evolution [arXiv:2505.20286]**, and **Code-as-Policies [arXiv:2604.07791]**), you eliminate the biggest flaw in modern agents: **static JSON tool bloat**.
Instead of feeding 30 rigid JSON tool schemas into every prompt, your agent gets **6 Tier-Specific Execution Primitives**. Everything else—reading, AST editing, scraping, database migrations, invoice syncing—is a **reusable, self-evolving script authored and improved by the agent itself.**
- #### The Primitive Tool Definitions:
```typescript
export interface ScriptNativeTierPrimitives {
  // TIER 1: In-Memory SQLite Virtual Filesystem
  exec_sqlite_fs: {
    description: "Execute in-memory file operations (read, patch, diff, grep, glob) against DO SQLite.";
    parameters: { op: "read" | "patch" | "write" | "grep" | "glob" | "diff"; params: Record<string, any> };
  };
  // TIER 2: V8 Isolate CodeMode (Pure CodeAct in V8)
  exec_isolate_codemode: {
    description: "Execute arbitrary TypeScript/JS code in a V8 Isolate with fetch() and ctx.mcp bindings. Sub-millisecond execution.";
    parameters: { code: string; args?: Record<string, any> };
  };
  // TIER 3: Dynamic Durable Workflows
  exec_workflow: {
    description: "Deploy and trigger a durable Cloudflare Workflow for long-running, multi-step, or cron-scheduled tasks.";
    parameters: { workflowCode: string; schedule?: string; params?: Record<string, any> };
  };
  // TIER 4: Lightweight Kitesurf Agent Browser
  exec_kitesurf: {
    description: "Fast, low-memory DOM extraction, article parsing, and form interaction (3-7x lighter than Chromium).";
    parameters: { url: string; actions?: Array<{ type: "click" | "type" | "extract"; selector: string; value?: string }> };
  };
  // TIER 5: Full Chromium Puppeteer
  exec_browser: {
    description: "Full Chromium engine for WebGL, Canvas, bot challenges, and pixel-perfect Visual QA screenshots.";
    parameters: { url: string; puppeteerScript: string };
  };
  // TIER 6: Sandboxed Linux Container Bash
  exec_container_bash: {
    description: "Execute Linux shell commands in Docker container (ToolSandboxDO) for npm, pip, native builds, and compilers.";
    parameters: { command: string; filesToStage?: string[] };
  };
}
```

### 12. 95/5 Compute Arbitrage with 60-Second Micro-Sleep

**Final behavior:** 95% of tasks run in sub-5ms V8 Isolates ($0.0001). Containers spin up only for native compiles and shut down after a strict 60-second idle countdown, keeping monthly costs under $2.50.

**Production acceptance contract:**
Production entry: ToolSandboxDO/container server idle alarm.
Persistence/deployment: DO alarm/session timestamp; `TOOL_SANDBOX`.
Required observable verification: idle-boundary tests at 59,999/60,000ms; state remains persisted after stop.

**Retained implementation constraints:**
- 141. **The six items item 140 explicitly left open are now BUILT — Phase 1 of the 62-item batch is
     complete.** `thread.create` (the assistant's own `project-coordination` prebuilt) minted a
     `threads` row with no `session_id` — the exact bug behind "Session not found" on any
     assistant-created thread. It now also mints and links a real session (generating the thread's
     own id client-side so the link can point at it, then `POST /sessions {thread_id}`), matching
     the shape a human's own "New thread" already produces; degrades to returning the bare thread
     (still real, still usable via a later open) rather than throwing if the session-link call
     itself fails. The SAME gap existed on the flat `/threads` browse page's own "New Session"
     button and its `/threads/:id` chat route — fixed identically, and that route now waits for the
     thread to load (mirroring the project-scoped page) instead of always taking Chat's client-only
     fallback.
     - **Memory was never written automatically — confirmed, and closed.** Layer 4 (Fabric,
       project-shared consolidation) already had a post-run write; Layer 5 (episodic, the layer
       `memory.recall` actually searches) did not — nothing besides the model's own occasional
       `memory.remember` tool call ever populated it, which is the real root cause of "the AI isn't
       recording anything." `NaelaoAgentDO.handleScriptRun` now also writes a low-importance (0.3,
       below the auto-promotion threshold — a background trail to recall on demand, not something
       that forces itself into every future prompt) episodic note alongside the existing Fabric
       write, same best-effort posture. `memory.remember` added to
       `LAUNCHPAD_ASSISTANT_DEFAULT_AUTO_APPROVED` (`memory.recall` was already there) — it's a
       write, but a purely internal one (lands only in the agent's own private recall store,
       invisible to anyone unless recalled again), unlike `write_file` or a commerce write, which
       stay gated.
     - **Context meter now reflects the real selected model.** `ContextUsageMeter` hardcoded
       `claude-haiku-4-5-20251001`; `Chat.tsx` had `selectedModel` in scope the whole time and
       simply never passed it to the Stats-tab instance — fixed. Also gained a manual **Compact**
       button (next to the percentage, calling the existing `/compact` route on demand rather than
       only auto-firing at 85%) and a `compact` single-line rendering mode mounte
- The Gap
 Tier 5 Container Billing — Metered by Start Time, Not Actual Usage; Idle Containers Overcharge Tier 5 containers are billed by the second they are allocated, not by CPU time. The spec says "metered by command duration." If an agent spins up a container to run `sleep 600` (10 minutes of idle sleep), the container is billed for 10 minutes of wall-clock time, even though zero CPU was used. For long-running agents that spawn containers for background tasks, this compounds: a container that allocates, waits 5 minutes for an external API to respond, then completes will be billed for 5+ minutes even if it used only 100ms of CPU.
- **Real per-token accounting — the actual fix underlying both the budget and credit-conversion
gaps.** Turned out `tokens_used` was hardcoded to `0` everywhere — `GatewayReasoner.decide()`
discarded the Anthropic response's `usage` field entirely, so nothing downstream (spend caps,
sub-agent budgets) had a real number to work with despite being *described* as token-based.
Fixed at the source: `GatewayReasoner` now captures `usage.input_tokens`/`output_tokens` into a
`lastUsage` property (the `Reasoner` interface contract); `runScriptLoop` reads it after every
`reasoner.decide()` call and accumulates input/output separately into the returned
`ScriptRunResult.tokens_used`/`input_tokens`/`output_tokens`. Two real consumers followed from
having a real number:
- **Sub-agent budgets are now enforced against real tokens**, not just a step count.
  `RunLoopOptions.maxTokens` is checked before every L3/L4 reasoning step (never starts a step
  it can't afford) and `spawnSubAgentBatch` passes each child's own `budget_tokens` as its
  `max_tokens` context field. `budgetToMaxSteps`'s coarse step cap remains as a backstop for
  the rare case a reasoner doesn't report usage at all — documented as secondary, not primary.
- **Real USD→credit conversion** (`packages/billing-core`): `tokensToCredits(input, output,
  model)` composes the pre-existing (but previously unused!) `computeTokenCostMicro` per-model
  pricing table with a new platform-wide constant `CREDITS_PER_USD = 100` (1 credit = $0.01,
  the single source of truth for every USD↔credit conversion — never re-derive this rate
  locally). Always rounds up to at least 1 credit for any non-zero cost. Wired into the channel
  heartbeat's `addProjectSpend` call, replacing the "1 token ≈ 1 credit" proxy.
- # 2. Stream 1: The SaaS Subscription Tiers
```
┌───────────────────────────────┬──────────────┬───────────────────────────────┬──────────────────────────────────────────┐
│ Plan Tier                     │ Price        │ Included Workspaces & Limits  │ Unlocked Features & Capabilities         │
├───────────────────────────────┼──────────────┼───────────────────────────────┼──────────────────────────────────────────┤
│ **1. Free Tier (Hacker)**     │ **$0 / mo**  │ • 1 Business Workspace        │ • BYOK Only (Anthropic, Gemini, Groq)    │
│ *(Top-of-Funnel Viral Onramp)*│              │ • 1 Project / 3 Threads       │ • Tier 1 SQLite FS + Tier 2 Isolates     │
├───────────────────────────────┼──────────────┼───────────────────────────────┼──────────────────────────────────────────┤
│ **2. Starter (Solo Builder)** │ **$29 / mo** │ • 3 Business Workspaces       │ • Includes $10/mo compute allowance      │
│ *(Freelancers & Solopreneurs)*│              │ • Unlimited Threads           │ • Tier 3 Dynamic Workflows + Kitesurf    │
│                               │              │ • 1 Custom Domain             │ • Personal WhatsApp/Telegram Assistant   │
├───────────────────────────────┼──────────────┼───────────────────────────────┼──────────────────────────────────────────┤
│ **3. Pro (Venture Studio)**   │ **$99 / mo** │ • 10 Business Workspaces      │ • Includes $35/mo compute allowance      │
│ *(Agencies & Growth Startups)*│              │ • Unlimited Projects & Threads│ • Tier 5 Chromium + Tier 6 Containers    │
│                               │              │ • 3 Sub-spaces (Departments)  │ • Model Studio (Private LoRA Training)   │
│                               │              │ • 5 Team Member Seats         │ • Voice Calling Receptionists (@cf/voice)│
│                               │              │                               │ • Artifacts PR Branching & Merging       │
├───────────────────────────────┼──────────────┼───────────────────────────────┼──────────────────────────────────────────┤
│ **4. Enterprise (Holding Co)**│ **$299+/mo** │ • Unlimited Sub-spaces        │ • Full White-Labeling (Zero AVOS badge)  │
│ *(Corporates & Law/PE Firms)* │              │ • 25+ Team Member Seats       │ • Cloudflare for SaaS Custom SSL Apex    │
│                               │              │ • Dedicated Phone Numbers     │ • 365-Day Audit Retention (HIPAA/SOC2)   │
└───────────────────────────────┴──────────────┴───────────────────────────────┴──────────────────────────────────────────┘
```
- # 4. Stream 3: Marketplace & Downstream Take-Rates
```
                                  ┌──────────────────────────────────────────────┐
                                  │        TRANSACTIONAL & REVENUE CUTS          │
                                  └──────────────────────┬───────────────────────┘
                                                         │
                         ┌───────────────────────────────┴───────────────────────────────┐
                         ▼                                                               ▼
┌─────────────────────────────────────────────────────────────┐   ┌─────────────────────────────────────────────────────────────┐
│ 🛒 DOWNSTREAM COMMERCE / INVOICE CUT                        │   │ 🧩 TEMPLATE MARKETPLACE REVENUE SPLIT                       │
├─────────────────────────────────────────────────────────────┤   ├─────────────────────────────────────────────────────────────┤
│ • **Digital Storefront Sales:** 5.0% fee on one-time items. │   │ • **Developer Referral (Direct Link):**                     │
│ • **Client Invoices & Retainers:** 1.5% processing cut on   │   │   **40% to Dev / 60% to Platform**                          │
│   Stripe Connect / Whop sub-merchant checkouts.             │   │ • **Organic Marketplace Discovery:**                        │
│ • Fee is deducted automatically at transaction settlement.  │   │   **20% to Dev / 80% to Platform**                          │
│                                                             │   │ • **Fixed One-Off License ($99):**                          │
│                                                             │   │   **100% upfront to Dev / 0% on monthly compute**           │
└─────────────────────────────────────────────────────────────┘   └─────────────────────────────────────────────────────────────┘
```
- ### Summary:
1. **Predictable SaaS Revenue:** Base subscription plans ($29 to $299/mo) provide recurring MRR.
2. **True Cost Protection with BYOK & Credits:** Users either bring their own AI keys ($0 token cost to you) or pay per-credit for edge compute, containers, and voice telephony.
3. **Compounding Marketplace Margins:** You capture **60%–80% of recurring template subscriptions** and **1.5%–5% of all downstream customer sales** processed across the network.

### 13. In-Isolate WebAssembly Python (Pyodide)

**Final behavior:** Standard Python scripts execute in V8 isolates via WebAssembly in <10ms for $0.00, escalating to Tier 6 Containers only when importing heavy native C-extensions like PyTorch.

**Production acceptance contract:**
Production entry: invisible route classifier and code runner promotion.
Persistence/deployment: loader module cache; Sandbox binding.
Required observable verification: routing tests cover stdlib/pandas versus torch/native imports and honest unavailability.

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
- The Gap env.SANDBOX.create() is called in the spec without a network policy option. CF Containers support configurable network policies: full (default, internet access), restricted (only egress to allowlisted hostnames), or none (no network). Agent-executed user code (Python scripts, bash commands from LLM tool calls) runs in a container with full internet access by default. A prompt-injected agent could exfiltrate secrets, make unexpected external API calls, or participate in a DDoS attack from within the container.
- **Goal:** fix Tier 5 (spec §33b) so `python3.execute_python`/`code.execute_bash` scripts persist
files across restarts and share them across a project's threads — verified BEFORE this pass that
neither was true: `runContainer` addressed the sandbox DO per-`{space,agent}` (so two threads'
agents in the same project got DIFFERENT containers) and the harness only ever wrote/read a
`mkdtemp`+`rm` scratch dir per call (so nothing survived even a single container instance's next
request, let alone a restart).

### 14. Tier 4 Cloudflare Kitesurf Agent Browser

**Final behavior:** 30MB lightweight browser running 3–7x faster and cheaper than Chromium for DOM text extraction and form fills, auto-elevating to Tier 5 Chromium for WebGL or screenshots.

**Production acceptance contract:**
Production entry: browser worker `/v1/browser/navigate`; code-runner browser proxy.
Persistence/deployment: browser session binding; `BROWSER`.
Required observable verification: browser Kitesurf tests; output reports selected engine and fallback reason.

**Retained implementation constraints:**
- 98. **The assistant had never once been told who it was, `/new` silently dropped the user's first
    message, and a completed run 404'd on its own status poll. All three reported by the user, all
    three root-caused against live behaviour rather than guessed at.**
    - **The agent's own system prompt reached the model in no run, ever.** `loadAgentConfig` read
      `system-prompt.md` from R2 on every call and used it only to parse approval gates;
      `GatewayReasoner` hardcoded `system: DECISION_INSTRUCTIONS`. Every word of
      `LAUNCHPAD_ASSISTANT_PROFILE` — the business-building methodology, the wallet rules, "read the
      project journal first" — written, stored, never delivered. Asked what business it ran, the
      assistant said "that information is not provided in the given context", which was true.
      New `ReasonerDeps.agentPrompt` + `composeSystemPrompt` (identity, protocol, then a one-line
      identity anchor — recency wins on small models), wired at both reasoner sites.
      **That alone was not enough, and the reason is worth keeping.** A direct gateway call proved
      llama-3.3 follows a plain system prompt correctly, yet the SAME identity inside the real
      request still produced "I am an AI assistant, and I am not running a business for you" — the
      real request also carries a 4.3k-char protocol and five tool schemas, and `tool_choice:
      "required"` pulls attention onto the machinery. Fixed by ALSO carrying a bounded
      `who_you_are` digest in the payload the model is answering about. Verified live: it now
      answers "I am the Naelao Agent, a business-builder Space Assistant for your Launchpad
      Space…". Diagnostic worth reusing: when a prompt "should" work, test the model in isolation
      first — it separates delivery from attention in one call.
    - **`/new` created a session and nothing happened.** Home passes the opening line as `?q=`; the
      session page stripped `q` from the URL on mount, Next syncs that `replaceState` back into
      `useSearchParams`, and Chat cannot send until its history has loaded a beat later — so the
      message was retracted before the surface was ready for it. Reproduced exactly in a real
      browser: `POST /sessions` 201, then **no `POST /agent/run` at all**, 0 messages. Fixed by
      latching `q` on first render (`useState` initialiser) plus a second latch inside Chat, so
      whoever hands the message over, the first non-empty value wins and cannot be withd
- // ── Layer 1: Agent Environment ────────────────────────
 agentEnvironment: {
 defaultExecutionTier: 'workspace' | 'isolate' | 'browser' | 'sandbox';
 containerIdleTimeoutMs: number; // 0 = no container. -1 = never idle (always warm).
 loopModel: AgentLoopModel;
 alwaysLoadedSkills: string[]; // skill IDs always in context, regardless of user config
 disabledSkills: string[]; // skills agents in this type CANNOT use
 networkPolicy: 'open' | 'restricted' | 'none';
 networkAllowlist?: string[]; // if restricted: only these domains allowed
 memorySchemaOverride?: JSONSchema; // override agent_memory schema for this type
 maxContextTokens: number; // context window limit for this type
 agentPermissions: string[]; // e.g. ['wallet_spend', 'external_deploy', 'read_cross_space']
 // Note: customLoopWorker (RemoteLoop) is reserved for Naelao platform types only.
 // Community developers requiring custom agent reasoning should use the Apps SDK
 // and publish an App with a custom MCP server instead.
 };
- - **F10 (Tier-2/3 isolates get raw, unguarded `fetch`, spec G-AF20)** — **already fixed**, in
  the same pass that closed F13 for the browser worker (see A1.16 Track B/F10+F13 above,
  commit tagged `9a541e1`-equivalent). `workers/agents/src/script-engine/code-runner.ts`'s
  `SSRF_GUARD_PRELUDE` overrides `globalThis.fetch` inside the isolate module text itself
  (`__ssrfGuardedFetch`), and the injected `ctx.fetch` calls that same guarded function — not
  the bare `fetch`. Confirmed by reading the current file (not assuming from memory): lines
  ~87-114 show the guard, line ~124 shows `ctx.fetch: (...a) => __ssrfGuardedFetch(...a)`.
- **F13 (SSRF guard is hostname-literal only, no DNS resolution, spec G-AF20 second half)** —
  **already fixed** in the same pass. The isolate's `SSRF_GUARD_PRELUDE` includes
  `__resolveIps(hostname)` (Cloudflare DoH query for A + AAAA records) and
  `__ssrfGuardedFetch` blocks if ANY resolved IP matches the deny list, in addition to the
  literal-hostname check — closing exactly the DNS-rebinding bypass the spec's clause exists
  for. `@naelao/security`'s `checkSsrf`/`resolveHostnameIps` (used by the browser worker) has
  the equivalent resolution step.
- **F11 (CORS is `*` platform-wide, spec G-AF14)** — **already fixed**, in the first audit
  batch (Track D). `workers/router/src/index.ts`'s CORS middleware (~line 104) is not
  `cors(["*"])` from `packages/http/src/cors.ts` at all — it's a custom, env-driven
  (`CORS_ALLOWLIST`) allowlist middleware that never echoes `*`, reads the allowlist per-request
  (`c.env`, not baked in at module load), and returns an empty `Access-Control-Allow-Origin` for
  a non-allowlisted origin. Regression coverage already exists in
  `tests/unit/router-cors-allowlist.test.ts`.
- ### 2. The Refined Execution Ladder: Adding Cloudflare Kitesurf
Placing **Cloudflare Kitesurf** directly before full **Chromium Browser Rendering** provides a massive cost and performance advantage:
* **Kitesurf (Announced Aug 2026):** A lightweight, agent-first browser engine that uses **3–7x less CPU and RAM than Chromium** and starts in milliseconds. It is ideal for 80% of agent web tasks (extracting clean text, navigating DOMs, filling forms, and reading articles).
* **Headless Chromium:** The heavy artillery. Used only when Kitesurf hits a wall (WebGL, complex bot challenges, canvas painting, or visual pixel-perfect screenshots).
```
                                  ┌─────────────────────────────────────────────────────────────┐
                                  │ TIER 5: Sandboxed Linux Container (ToolSandboxDO / Ubuntu)  │
                                  │ • Full OS userland: npm install, compilers, Python binaries │
                                  └──────────────────────────────▲──────────────────────────────┘
                                                                 │ (Promote if native binary required)
                                  ┌──────────────────────────────┴──────────────────────────────┐
                                  │ TIER 4: Full Headless Chromium (Cloudflare Browser / Puppeteer)
                                  │ • Heavy browser: Visual QA screenshots, WebGL, Canvas, Bot-Shield
                                  └──────────────────────────────▲──────────────────────────────┘
                                                                 │ (Promote if WebGL/Visual QA required)
                                  ┌──────────────────────────────┴──────────────────────────────┐
                                  │ TIER 3: Lightweight Agent Browser (Cloudflare Kitesurf)     │
                                  │ • 3-7x less CPU/memory; ultra-fast DOM extraction & form fills
                                  └──────────────────────────────▲──────────────────────────────┘
                                                                 │ (Promote if web navigation required)
                                  ┌──────────────────────────────┴──────────────────────────────┐
                                  │ TIER 2: Dynamic Worker Isolate (V8 Script Execution)       │
                                  │ • TypeScript/JS execution, HTTP fetches, MCP orchestration │
                                  └──────────────────────────────▲──────────────────────────────┘
                                                                 │ (Promote if script logic required)
┌────────────────────────────────────────────────────────────────┴──────────────────────────────┐
│ TIER 1: Direct In-Memory Virtual FS (@cloudflare/computer / DO SQLite)                        │
│ • Sub-millisecond Read, Edit (AST Search & Replace), Grep, Glob, just-bash                    │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```
- ### 3. Tier Comparison & Transparent Fallback Protocol
```
┌──────────┬──────────────────────┬────────────────────────┬──────────────────────┬────────────────────────────┐
│ Tier     │ Name                 │ Compute Primitive      │ Memory / Cost        │ Capabilities & Gaps        │
├──────────┼──────────────────────┼────────────────────────┼──────────────────────┼────────────────────────────┤
│ **T1**   │ Virtual SQLite FS    │ DO SQLite in-memory    │ ~0ms / $0.00         │ `Read`, `Edit`, `Grep`     │
├──────────┼──────────────────────┼────────────────────────┼──────────────────────┼────────────────────────────┤
│ **T2**   │ Isolate Shell        │ Dynamic Worker Isolate │ ~5MB / $0.0001       │ TS logic, HTTP, MCP chain  │
├──────────┼──────────────────────┼────────────────────────┼──────────────────────┼────────────────────────────┤
│ **T3**   │ **Kitesurf Browser** │ **Agent-First Web**    │ **~30MB / $0.001**   │ **DOM reads, form fills**  │
│          │                      │                        │                      │ *(No WebGL/Screenshots)*   │
├──────────┼──────────────────────┼────────────────────────┼──────────────────────┼────────────────────────────┤
│ **T4**   │ **Chromium Browser** │ **Full Puppeteer**     │ **~200MB / $0.01**   │ **Visual QA, WebGL, Canvas**│
├──────────┼──────────────────────┼────────────────────────┼──────────────────────┼────────────────────────────┤
│ **T5**   │ Linux Container      │ Docker / MicroVM       │ ~512MB / $0.05       │ `npm install`, compilers   │
└──────────┴──────────────────────┴────────────────────────┴──────────────────────┴────────────────────────────┘
```
- ### Summary of What This Adds
1. **Self-Improving Skill Accumulation:** Any complex CLI or browser task done once can be **distilled into a versioned skill** stored in R2, making future executions 100x faster and cheaper.
2. **Kitesurf as Tier 3:** Dramatically cuts compute costs for web scraping and form filling by using Cloudflare's lightweight **Kitesurf engine**, reserving full **Chromium (Tier 4)** strictly for visual QA and complex rendering.
3. **Frictionless Ladder Escalation:** Tiers promote smoothly: **Tier 1 (SQLite FS)** $\rightarrow$ **Tier 2 (Isolate)** $\rightarrow$ **Tier 3 (Kitesurf)** $\rightarrow$ **Tier 4 (Chromium)** $\rightarrow$ **Tier 5 (Container)** with zero crashed turns.
- ### 1. The Updated 6-Tier Cloudflare Execution Ladder
Integrating **Dynamic Workflows** gives your platform durable, multi-day background execution without holding open expensive sockets or burning worker CPU while waiting on external systems or cron schedules:
```
                                  ┌─────────────────────────────────────────────────────────────┐
                                  │ TIER 6: Sandboxed Linux Container (ToolSandboxDO / Ubuntu)  │
                                  │ • Full OS userland: npm install, compilers, Python binaries │
                                  └──────────────────────────────▲──────────────────────────────┘
                                                                 │ (Promote if native compilation needed)
                                  ┌──────────────────────────────┴──────────────────────────────┐
                                  │ TIER 5: Full Headless Chromium (Puppeteer / Browser Render) │
                                  │ • Heavy browser: Visual QA snapshots, WebGL, Canvas, Bot-Def│
                                  └──────────────────────────────▲──────────────────────────────┘
                                                                 │ (Promote if visual QA / WebGL needed)
                                  ┌──────────────────────────────┴──────────────────────────────┐
                                  │ TIER 4: Lightweight Agent Browser (Cloudflare Kitesurf)     │
                                  │ • 3–7x cheaper/faster: DOM text extraction & form fills     │
                                  └──────────────────────────────▲──────────────────────────────┘
                                                                 │ (Promote if web navigation needed)
                                  ┌──────────────────────────────┴──────────────────────────────┐
                                  │ TIER 3: Dynamic Workflows (Cloudflare Workflows / Cron Hub) │
                                  │ • Durable multi-step runs, hours/days execution, sleep/pause│
                                  │ • Step retry boundaries, scheduled crons without awake DOs │
                                  └──────────────────────────────▲──────────────────────────────┘
                                                                 │ (Promote if task is long-running/durable)
                                  ┌──────────────────────────────┴──────────────────────────────┐
                                  │ TIER 2: Dynamic Worker Loader (V8 Isolate Shell / TS Script)│
                                  │ • Pure code execution, HTTP fetches, MCP orchestration      │
                                  └──────────────────────────────▲──────────────────────────────┘
                                                                 │ (Promote if script logic needed)
┌────────────────────────────────────────────────────────────────┴──────────────────────────────┐
│ TIER 1: Direct In-Memory Virtual FS (@cloudflare/computer / DO SQLite)                        │
│ • Sub-millisecond Read, Edit (AST Search & Replace), Grep, Glob, just-bash                    │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```
- ### How Tier 3 (Dynamic Workflows) Functions
When an agent needs to execute a task that spans multiple hours or requires scheduled checks (e.g., *"Monitor this government bidding portal every 6 hours and send a summary on Friday"*), running a synchronous loop inside a Durable Object would waste compute budget.
Instead, the agent compiles the task into a **Cloudflare Workflow (`ScriptRunWorkflow.ts`)**:
1. **Step Durability & State Checkpoints:** Each workflow step (`step.do(...)`) automatically serializes its output to Cloudflare storage. If an external API errors or rate-limits, only that step retries—the rest of the pipeline does not restart.
2. **Dormant Sleeping (`step.sleep`):** The workflow can pause for hours or days at **$0 compute cost**, waking up at the exact timestamp required.
3. **Cron Triggers Without Awake DOs:** Scheduled jobs trigger directly from Cloudflare’s workflow scheduler rather than an awake background worker.
```typescript
// workers/agents/src/workflows/DynamicTaskWorkflow.ts
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
export class DynamicTaskWorkflow extends WorkflowEntrypoint<Env, { scriptName: string; args: any }> {
  async run(event: WorkflowEvent<{ scriptName: string; args: any }>, step: WorkflowStep) {
    // Step 1: Execute scraping pass (Tier 4 Kitesurf)
    const rawData = await step.do("scrape-portal", async () => {
      return await executeKitesurfScrape(event.payload.args.targetUrl);
    });
    // Step 2: Sleep for 6 hours (Zero compute cost during wait)
    await step.sleep("wait-for-update-window", "6 hours");
    // Step 3: Compare diff and dispatch report
    await step.do("compile-and-notify", async () => {
      return await compareAndSendReport(rawData);
    });
  }
}
```
- ### 3. Implementation: The Video Distillation Prebuilt Tool
Add the `skill.distill_from_video` operation to `workers/agents/src/script-engine/prebuilt/skill-manager.ts`:
```typescript
// workers/agents/src/script-engine/prebuilt/skill-manager.ts
import { generateObject, generateText } from "ai";
import { z } from "zod";
export async function distillSkillFromVideo(
  args: Record<string, unknown>,
  ctx: PrebuiltOpContext
) {
  const videoR2Key = args["videoPath"] as string;
  const skillName = args["skillName"] as string;
  const description = args["description"] as string || `Automated skill learned from video: ${skillName}`;
  // 1. Fetch video from R2 Workspace
  const bucket = ctx.env.workspaceBucket || ctx.env.scriptsBucket;
  const videoObj = await bucket.get(videoR2Key);
  if (!videoObj) throw new Error(`Video file not found in workspace: ${videoR2Key}`);
  // 2. Multimodal Action Extraction Pipeline
  // Extracts ordered action sequence: navigation targets, selectors, typed inputs, and assertions
  const { object: actionSequence } = await generateObject({
    model: ctx.env.AI_GATEWAY("claude-3-7-sonnet-20250219"),
    schema: z.object({
      parameters: z.array(z.object({
        name: z.string(),
        type: z.string(),
        description: z.string()
      })),
      steps: z.array(z.object({
        actionType: z.enum(["NAVIGATE", "CLICK", "TYPE", "EXTRACT", "ASSERT", "BASH"]),
        target: z.string().describe("URL, CSS selector, or command"),
        valueExpression: z.string().describe("Dynamic parameter or static value"),
        description: z.string()
      }))
    }),
    prompt: `Analyze this recorded demonstration of '${skillName}'.
Identify the parameterizable inputs, DOM interactions, and logic flow required to replicate this exact task programmatically.`
  });
  // 3. Synthesize clean, hardened TypeScript code using universal primitives
  const synthesizedTypeScript = `
/**
* Auto-Distilled Skill: ${skillName}
* ${description}
*/
export async function run(args: Record<string, any>, ctx: any) {
  ${actionSequence.parameters.map(p => `const ${p.name} = args["${p.name}"];`).join("\n  ")}
  // Replay synthesized action timeline
  ${actionSequence.steps.map(s => {
    if (s.actionType === "NAVIGATE") return `await ctx.run("browser.navigate", { url: "${s.target}" });`;
    if (s.actionType === "TYPE") return `await ctx.run("browser.type", { selector: "${s.target}", text: ${s.valueExpression} });`;
    if (s.actionType === "CLICK") return `await ctx.run("browser.click", { selector: "${s.target}" });`;
    if (s.actionType === "BASH") return `await ctx.run("Bash", { command: ${s.valueExpression} });`;
    return `// ${s.description}`;
  }).join("\n  ")}
  return { ok: true, message: "Successfully executed learned skill: ${skillName}" };
}
`;
  // 4. Save to Authoritative Skill Library in R2
  const skill = await ctx.env.skillLibrary.create({
    name: skillName,
    code: synthesizedTypeScript,
    metadata: {
      description,
      domain: "automation",
      requires_tier: 4, // Tier 4 (Kitesurf/Browser)
      origin: "distilled",
      stability_score: 1.0,
      parameters: actionSequence.parameters
    }
  });
  return {
    ok: true,
    skillName: skill.name,
    version: 1,
    parameters: actionSequence.parameters,
    message: `✔ Successfully learned and registered skill '${skillName}' from video demonstration.`
  };
}
```

### 15. Virtual Display Container Automation ("Computer Use")

**Final behavior:** Xvfb + Fluxbox + noVNC WebSockets running inside Tier 6 Containers, allowing agents to visually interact with desktop software via mouse clicks, keystrokes, and frame captures.

**Production acceptance contract:**
Production entry: ToolSandbox computer-use endpoints/container server.
Persistence/deployment: persistent project SandboxDO state; `TOOL_SANDBOX`.
Required observable verification: container computer-use contract tests; display frames are returned, not simulated.

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

- Required Fix
 Required Fix Use CF Container idle detection to pause billing while the container is idle (no CPU usage detected). Resume billing when computation resumes. Alternatively, require agents to implement request-response patterns, not long-lived container sessions. A container should start, do work, and exit quickly. For long-running tasks, use Dynamic Workflows (which have better pricing). Add a billing model choice to the container manifest: "per-wall-clock-second" (current) or "per-cpu-millisecond" (more fair). Default to fair billing. Severity: Medium — Containers metered by wall-clock time, not CPU time. Long waits (API calls, sleep, network I/O) increase costs without increasing computation. Agents are incentivized to use Tier 2 instead. T-151 — WalletDO
- **Execution ladder Tiers 2-5 — `script-engine/code-runner.ts`.** Implements `TieredCodeRunner`
for real:
- **Tier 2/3** — a CF Worker Loader (`[[worker_loaders]]` binding `LOADER`) spins up a fresh V8
  isolate per `script.run` call. Stored code is a single module exporting `run(args, ctx)`; the
  runner appends a small `fetch` harness around it. Tier 3 best-effort resolves bare-specifier
  imports from `esm.sh` as extra virtual modules (there is no real "npm install" inside an
  isolate — documented as a real limitation, not papered over).
- **Tier 4** — the same isolate, with `ctx.browser.navigate(...)` injected, proxied to the
  pre-existing `naelao-browser` Worker (CF Browser Rendering + SSRF guard) via a new
  `BROWSER_WORKER` service binding. Agents still never get raw CDP.
- **Tier 5** — `ToolSandboxDO`'s container harness (`container/server.mjs`) gained a generic
  `POST /exec { code, args }` route (esbuild-bundle → import → call `run(args,{})`), alongside
  its existing `/build` route for the legacy micro-tool gate.
- Wired into `NaelaoAgentDO.buildScriptEngineEnv` as `env.codeRunner`; degrades tier-by-tier,
  never crashes, when a binding is absent.
- New prebuilts **`browser-use`** (navigate/click/type/extract/screenshot, Tier 4) and
  **`code-exec`** (`execute_python`/`execute_bash` → Tier 5; `run_js` → Tier 2, codemode) ship
  in the Default Naelao Agent. `run_js` re-applies the reserved-capability guard at call time
  (ad hoc code bypasses `script.create`, so it must not bypass the money-in guard too).
- Just like Hermes s bot mode (check web sources) and grok bot I think that architecture is the ultimate go to for projects (but aren't we there yet since project thread agents can do what grokbots do )  am I wrong think about it. What I really am concerned about is the agent roster UI vs sessions (our UI) I think we are behind should we adopt to agents roster plus how would users Collab plus agents in sessions/threads we solved this with thread tiers

### 16. Multiplexed Persistent gRPC Bridge

**Final behavior:** Replaces high-latency HTTP/1.1 JSON serialization between Durable Objects and Containers with persistent multiplexed binary gRPC streams over TCP sockets.

**Production acceptance contract:**
Production entry: container bridge/server and ToolSandboxDO request correlation.
Persistence/deployment: project-addressed DO/socket state; Sandbox binding.
Required observable verification: local tunnel/container bridge tests; concurrent correlation IDs cannot cross.

**Retained implementation constraints:**
- 118. **Real streaming, and the agent now TALKS between tool calls — item 117's two stated
     limitations are both closed.** The user's correction was structural, not cosmetic: Claude Code
     has no hardcoded "tools then one final answer" shape; the model streams as it generates,
     speaks to the user as many times as it decides to, and stops when it judges the job done. Two
     of those three were genuinely missing here.
     - **The reasoning call is now streamed** (`stream: true` + `stream_options.include_usage`,
       new `parseUniversalStream` in `shared/ai-client.ts`). The hard part is that a tool call
       arrives as JSON *fragments* — `{"say":"Let me ch` — so `JSON.parse` is unusable until the
       final chunk, which would defeat the point. New `partialJsonString(buffer, key)` walks the
       buffer by hand and returns whatever of a value has arrived, unescaped, whether or not the
       closing quote has been seen (stopping at a half-arrived `\` or `\uXXXX` rather than emitting
       a character the next chunk replaces). Streaming is **opt-in per call** via a new
       `Reasoner.decide({onDelta})`: an interactive chat passes it, a cron wake / channel drain /
       sub-agent does not, so those keep the cheaper non-streamed path and cannot regress.
     - **Mid-run replies are a first-class tool parameter, not incidental prose.** Item 117
       captured text a model *happened* to attach beside its tool call — but under
       `tool_choice:"required"` many providers suppress free text entirely, so that source is
       unreliable exactly where reliability matters most (the small open-weight models a free-tier
       business runs on). `run`/`distill`/`patch` now each declare a **required `say`**, so it
       comes back through the provider's own constrained decoding every time, and it streams — the
       user reads the sentence before the tool it describes has started. `DECISION_INSTRUCTIONS`
       gained a paragraph telling the model to write it as speech reflecting what it just learned,
       never a stock phrase; the existing "not on a short leash" paragraph absorbed the
       conversation framing (keep going as long as the goal needs, `answer` when YOU judge it met).
     - **Growing text needed a new checkpoint kind.** New `LiveCheckpoint = TraceStep + {partial,
       answer_preview}` (`script-engine/types.ts`) — deliberately NOT on `TraceStep` itself, which
       is the durable record. `NaelaoAgentDO.recordLiveProgress` u
- Required Fix Enable CF Smart Placement for all SpaceDOs, AssistantDOs, and ConversationShardDOs in wrangler.toml: [durable_objects.smart_placement] mode = "auto". Document the tradeoff: Smart Placement may move a DO between regions, which could conflict with data residency requirements (G-AA47). For spaces with data residency constraints (jurisdiction: "EU"), pin to a specific region using locationHint and disable Smart Placement via mode = "off". For all other spaces, enable Smart Placement and accept that DO location adapts to user geography over time. Monitor DO region via CF API metrics and alert if a data-residency-constrained DO migrates outside its jurisdiction.
- **K2 — R2 sync as the "mount," since Cloudflare Containers have no native R2 filesystem mount.**
This is the honest mechanism available on this platform today: `ToolSandboxDO` now reads the
project's R2 workspace (the SAME `workspacePrefix()`-scoped bucket/prefix Tier-1 `r2-workspace`
already reads/writes) before forwarding an `/exec` call to the container harness, hands the files
over as a `workspace_files` map in the request body, and on response writes back whatever the
harness reports as `/workspace`'s final contents (`workspace_files_out`) — including deleting any
file that existed before the run but is gone afterward (the script deleted it). R2 is the
persistent source of truth: a cold-started container (post-sleep or post-restart) still sees the
same files because they're materialized fresh from R2 on every call, never relied upon to survive
in the container's own ephemeral disk. Bounded (300 files / 2MB per file / 25MB per call —
generous for a working set, not unlimited; a project that outgrows this is a Container
Marketplace-tier problem, §A1.17 Phase L, not a bigger cap here) and text-only (matches the
existing R2-workspace convention of `.text()`, not binary-safe — an honest, documented
limitation). `/build` (the legacy Whop micro-tool build/test route) is untouched — it never
touched a project workspace and still doesn't.
- ### The MCP-UI Protocol: Making Canvas Actions Observable to Agents
Normally, if a user interacts with an app inside an iframe (e.g. clicks a checkbox, submits a form, or drags a Kanban card), **the AI agent is completely blind to it**.
With **MCP-UI**, the Micro-App / Canvas iframe emits structured **UI Action Events** back to the agent's Durable Object over WebSockets in real time:
```
[ User interacts with Micro-App on Canvas (e.g. Clicks "Reject Invoice #42") ]
                                    │
                                    ▼ (MCP-UI JSON-RPC Stream)
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. MCP-UI EMISSION:                                                         │
│    `window.postMessage({ type: "mcp.ui_action", action: "INVOICE_REJECTED",│
│                          payload: { invoiceId: "42", reason: "Over budget" }│
│                        })`                                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│ 2. AGENT OBSERVATION INJECTION:                                             │
│    The agent's active reasoning loop receives this as an instant turn:      │
│    `<ui_action_event user="bob" action="INVOICE_REJECTED" id="42" />`       │
├─────────────────────────────────────────────────────────────────────────────┤
│ 3. AUTONOMOUS AGENT REACTION:                                               │
│    Agent automatically logs the rejection to the Project Journal, updates   │
│    the DO Facet SQLite database, and drafts an email to the supplier!       │
└─────────────────────────────────────────────────────────────────────────────┘
```
- ### 4. Inbound TCP & Full-Duplex gRPC (`connect(socket)`)
In traditional architectures, when a **Durable Object (Isolate)** talks to a **Tier 6 Linux Container (`ToolSandboxDO`)**, it sends HTTP/1.1 JSON payloads over a REST port. This introduces:
* High serialization overhead (converting large AST trees or file buffers into JSON strings).
* Connection setup latency on every command.
With Cloudflare's native **`connect(socket)` API and gRPC**:
```
┌───────────────────────────────┐                             ┌───────────────────────────────┐
│ NaelaoAgentDO (V8 Isolate)    │  ◄═══════════════════════►  │ ToolSandboxDO (Linux Docker)  │
│ • State machine & REPL loop   │    Full-Duplex Binary gRPC  │ • `server.mjs` / Native OS    │
│ • Virtual SQLite Filesystem   │    (Protobuf / Cap'n Proto) │ • Compilers, Python, npm      │
└───────────────────────────────┘                             └───────────────────────────────┘
```
* **Sub-5ms Inter-Process Communication:** Data flows over a persistent, multiplexed binary socket directly between the DO and the container.
* **Streaming Terminal & AST Buffers:** Live compiler logs and AST patch streams flow with zero memory copy overhead.
- ### Summary of Platform Superpowers:
1. **Micro-Apps vs. Artifacts:** Artifacts are **versioned deliverables** (PDFs, Git commits). Micro-Apps are **stateful, living Artifacts** equipped with **DO Facet SQLite databases** and real-time **MCP-UI canvas action streaming**.
2. **WriteGuard & Outbound Workers:** Solves agent security by acting as an **unbypassable zero-trust edge firewall**, injecting credentials automatically and blocking destructive mutations.
3. **Pipelines & Iceberg:** Replaces slow database analytics with an **industrial streaming lakehouse on R2**, computing live Market Radar scores for thousands of templates simultaneously.
4. **gRPC over TCP:** Cuts communication latency between Durable Objects and Linux containers to **sub-5ms**.
5. **Radar Researcher:** Feeds global internet traffic trends into growth agents, allowing the platform to **autonomously identify and exploit profitable market opportunities.**

### 17. Instant Zero-Copy Branch Micro-Forking

**Final behavior:** Copy-on-write repository forks generated in 10ms for subagents and private scratchpads, guaranteeing zero disruption to the main workspace branch.

**Production acceptance contract:**
Production entry: artifact repository branch/checkout and micro-fork naming.
Persistence/deployment: immutable Git objects + mutable refs in RepositoryDO.
Required observable verification: repository branch tests; main ref remains unchanged.

**Retained implementation constraints:**
- 141. **The six items item 140 explicitly left open are now BUILT — Phase 1 of the 62-item batch is
     complete.** `thread.create` (the assistant's own `project-coordination` prebuilt) minted a
     `threads` row with no `session_id` — the exact bug behind "Session not found" on any
     assistant-created thread. It now also mints and links a real session (generating the thread's
     own id client-side so the link can point at it, then `POST /sessions {thread_id}`), matching
     the shape a human's own "New thread" already produces; degrades to returning the bare thread
     (still real, still usable via a later open) rather than throwing if the session-link call
     itself fails. The SAME gap existed on the flat `/threads` browse page's own "New Session"
     button and its `/threads/:id` chat route — fixed identically, and that route now waits for the
     thread to load (mirroring the project-scoped page) instead of always taking Chat's client-only
     fallback.
     - **Memory was never written automatically — confirmed, and closed.** Layer 4 (Fabric,
       project-shared consolidation) already had a post-run write; Layer 5 (episodic, the layer
       `memory.recall` actually searches) did not — nothing besides the model's own occasional
       `memory.remember` tool call ever populated it, which is the real root cause of "the AI isn't
       recording anything." `NaelaoAgentDO.handleScriptRun` now also writes a low-importance (0.3,
       below the auto-promotion threshold — a background trail to recall on demand, not something
       that forces itself into every future prompt) episodic note alongside the existing Fabric
       write, same best-effort posture. `memory.remember` added to
       `LAUNCHPAD_ASSISTANT_DEFAULT_AUTO_APPROVED` (`memory.recall` was already there) — it's a
       write, but a purely internal one (lands only in the agent's own private recall store,
       invisible to anyone unless recalled again), unlike `write_file` or a commerce write, which
       stay gated.
     - **Context meter now reflects the real selected model.** `ContextUsageMeter` hardcoded
       `claude-haiku-4-5-20251001`; `Chat.tsx` had `selectedModel` in scope the whole time and
       simply never passed it to the Stats-tab instance — fixed. Also gained a manual **Compact**
       button (next to the percentage, calling the existing `/compact` route on demand rather than
       only auto-firing at 85%) and a `compact` single-line rendering mode mounte
- Required Fix: An operator project's container image (the same Tier-5 container-marketplace mechanism from Phase L, item 36, now with its first real, non- coming_soon catalogue entry: dev-sandbox , a container with git + a language runtime preinstalled) clones the operator's registered repository on first use and the workspace prebuilt's copy/move ops (G-BG09's neighbor, Phase R) are joined by workspace.git_commit / git_branch / git_diff ops, so every Dev agent change is a real, revertable git commit against a real branch (never directly against the operator's default branch — the Dev agent always works on a per-spec feature branch, merged only after G-BG05's gate passes), not a set of file writes with no history.
- **Reskin approach — retarget + shell swap, not a per-page rewrite.** A full Tailwind-to-`@naelao/ui`
markup conversion across ~25 existing dashboard pages was judged disproportionate to what "reskin"
needs; instead: (1) `tailwind.config.ts`'s `brand` color scale was regenerated from the mockup's
actual accent (`packages/ui/src/tokens.css`'s `--accent #5b52f0`) — every existing
`bg-brand-*`/`text-brand-*`/`border-brand-*`/`ring-brand-*` utility across every page picks up the
new violet identity instantly, zero markup changes, zero regression risk; (2) `globals.css` imports
`@naelao/ui/tokens.css` + `@naelao/ui/styles.css` (no class-name collisions found — the dashboard
never used bare `.btn`/`.card` class names) so the DM Sans font, warm paper background, and shared
component classes are available; (3) the root layout's `<body>` now reads `var(--bg)`/`var(--text)`
directly instead of `bg-gray-50 text-gray-900` (Tailwind utility classes still win by specificity
wherever an existing page sets its own colors, so this is additive, not a repaint of every page).
The highest-visibility piece — the shell chrome — got a REAL component swap: `DashboardLayout` now
renders `@naelao/ui`'s `Sidebar`/`TopBar`/`Badge` (all three already generic enough for an admin
nav; `Sidebar`'s `projects`/`threads`/`spaceSwitcher` props are optional and simply don't render
when omitted, so it fits without dragging in end-user chat-shell concepts) instead of hand-rolled
Tailwind markup — verified visually via the same CDP screenshot technique (warm paper background,
violet accent, Instrument Serif logo wordmark all render correctly with a live dev server).
- ### Summary of What This Establishes:
1. **Deterministic Multi-Tier Knowledge (Mini-AGI):** Documents are partitioned by **Space, Project, and Role Rank**; Vectorize discards unauthorized chunks at the hardware query layer so classified information never leaks.
2. **Google-Search-Level Edge Intelligence:** Combines **sub-50ms KV semantic caching**, **Hybrid RRF (Dense Vectorize + Sparse BM25)**, and **live edge web search** with clickable citation footnotes.
3. **Safe Multi-Player Collaboration:** Users and agents can freely branch and experiment in **Tier 4 Private Scratchpads**. Edits are committed via structured **Pull Requests**, and teammates review visual diffs and merge changes to the main workspace with zero risk of code clobbering.
The release of **Cloudflare Artifacts (Git for Agents)** provides the exact native infrastructure layer needed for this architecture.
Instead of hand-rolling custom table schemas in SQLite to simulate branches and diffs, Cloudflare has built a **native Git-compatible versioned filesystem running inside Durable Objects (via a Zig-to-WASM Git engine)**.
This unlocks the **Per-Session/Per-Project Git Engine**, **Instant Zero-Copy Forking**, and **ArtifactFS FUSE Mounting** directly within our 6-Tier Execution Ladder.
- return {
      repoId: repo.id,
      remoteUrl: repo.remote, // https://x:token@artifacts.cloudflare.net/...
      token: token.token
    };
  }
  // 2. Instant Zero-Copy Fork for Tier 4 Private Scratchpad
  async forkForPrivateScratchpad(parentRepoName: string, scratchpadId: string) {
    const forkName = `${parentRepoName}_fork_${scratchpadId}`;
    const fork = await this.env.AGENT_REPOS.fork({
      source: parentRepoName,
      name: forkName
    });
    const writeToken = await fork.issueToken({ permission: "write", ttlSeconds: 3600 });
    return {
      forkName,
      remoteUrl: fork.remote,
      token: writeToken.token
    };
  }
  // 3. Generate Native Git Diff for Pull Request Review Card
  async generatePullRequestDiff(baseRepoName: string, forkRepoName: string) {
    const baseRepo = await this.env.AGENT_REPOS.get(baseRepoName);
    const forkRepo = await this.env.AGENT_REPOS.get(forkRepoName);
    // Fetch commit comparison between fork and base
    const diff = await this.env.AGENT_REPOS.compare({
      base: baseRepo.head,
      head: forkRepo.head
    });
    return {
      baseCommit: baseRepo.head,
      headCommit: forkRepo.head,
      changedFiles: diff.files, // [{ path, additions, deletions, patch }]
      totalAdditions: diff.additions,
      totalDeletions: diff.deletions
    };
  }
  // 4. Atomic Fast-Forward Merge to Main Workspace
  async mergePullRequest(baseRepoName: string, forkRepoName: string) {
    const baseRepo = await this.env.AGENT_REPOS.get(baseRepoName);
    const forkRepo = await this.env.AGENT_REPOS.get(forkRepoName);
    // Fast-forward base repository to the fork's commit head
    await baseRepo.fastForward(forkRepo.head);
    return {
      ok: true,
      mergedCommit: forkRepo.head,
      message: `✔ Successfully merged ${forkRepoName} into ${baseRepoName} at commit ${forkRepo.head.slice(0, 7)}.`
    };
  }
}
```
- ### 5. Why This Sets You Apart from Polsia and Claude Code
1. **True Git Versioning for Agents:** You are not storing loose strings in a database. Every project has a **real, full-fidelity Git repository on Cloudflare** with commits, authors, trees, and tags.
2. **Instant Micro-Forking (10ms):** When a user enters a Tier 4 Private Scratchpad or spawns 5 subagents, the platform creates 5 instant repository forks in parallel for **zero compute cost**.
3. **90-Second Container Acceleration:** With **`ArtifactFS`**, Linux containers mount the repository on the fly via FUSE, pulling only the files being touched instead of freezing the user for 2 minutes while `git clone` downloads 200MB.
4. **Commit-Driven CI/CD at the Edge:** Pushing a commit triggers a Cloudflare Worker via `artifacts.repo.pushed`, automatically building the site and updating the edge preview on Cloudflare Pages.

### 18. Turn-by-Turn Git Time Machine

**Final behavior:** Every tool turn creates an automated Git commit in Cloudflare Artifacts, allowing 1-click workspace rollbacks from the thread timeline.

**Production acceptance contract:**
Production entry: `NaelaoAgentDO` artifact change adapter; artifacts prebuilt.
Persistence/deployment: RepositoryDO commits; `ARTIFACT_WORKER`.
Required observable verification: artifact integration tests; timeline receives a commit OID per tool turn.

**Retained implementation constraints:**
- 141. **The six items item 140 explicitly left open are now BUILT — Phase 1 of the 62-item batch is
     complete.** `thread.create` (the assistant's own `project-coordination` prebuilt) minted a
     `threads` row with no `session_id` — the exact bug behind "Session not found" on any
     assistant-created thread. It now also mints and links a real session (generating the thread's
     own id client-side so the link can point at it, then `POST /sessions {thread_id}`), matching
     the shape a human's own "New thread" already produces; degrades to returning the bare thread
     (still real, still usable via a later open) rather than throwing if the session-link call
     itself fails. The SAME gap existed on the flat `/threads` browse page's own "New Session"
     button and its `/threads/:id` chat route — fixed identically, and that route now waits for the
     thread to load (mirroring the project-scoped page) instead of always taking Chat's client-only
     fallback.
     - **Memory was never written automatically — confirmed, and closed.** Layer 4 (Fabric,
       project-shared consolidation) already had a post-run write; Layer 5 (episodic, the layer
       `memory.recall` actually searches) did not — nothing besides the model's own occasional
       `memory.remember` tool call ever populated it, which is the real root cause of "the AI isn't
       recording anything." `NaelaoAgentDO.handleScriptRun` now also writes a low-importance (0.3,
       below the auto-promotion threshold — a background trail to recall on demand, not something
       that forces itself into every future prompt) episodic note alongside the existing Fabric
       write, same best-effort posture. `memory.remember` added to
       `LAUNCHPAD_ASSISTANT_DEFAULT_AUTO_APPROVED` (`memory.recall` was already there) — it's a
       write, but a purely internal one (lands only in the agent's own private recall store,
       invisible to anyone unless recalled again), unlike `write_file` or a commerce write, which
       stay gated.
     - **Context meter now reflects the real selected model.** `ContextUsageMeter` hardcoded
       `claude-haiku-4-5-20251001`; `Chat.tsx` had `selectedModel` in scope the whole time and
       simply never passed it to the Stats-tab instance — fixed. Also gained a manual **Compact**
       button (next to the percentage, calling the existing `/compact` route on demand rather than
       only auto-firing at 85%) and a `compact` single-line rendering mode mounte
- Fifth and final pass covering all remaining spec sections: §28 naelao-threads (WebSocket upgrade detection, SSE waitUntil, undefined db), §30 pricing/billing (BEGIN/COMMIT/ROLLBACK, PostgreSQL syntax), §naelao-os createSpace (use-before-declaration), §space-type-registry-appendix (missing settled column, undefined db in settleEarnings), §naelao-spaces-deep (duplicate const declarations causing SyntaxError, COUNT::int cast, NOW()+INTERVAL invite logic), §workflow-examples (SSRF on sourceUrl, GET with body, external fetch), §remoteloop + §remoteloop-appendix (dynamic binding undefined, TTL insufficient), §appendix-custom-dos (CartDO token loss, provisioner errors swallowed, admin db artifacts), §agentpress (truncateMiddle reverse order, StreamingXMLParser hibernation, Orchestrator timeout), §56 analytics (ClickHouse SQL dialect errors, index2 never populated), §observability (silent writeDataPoint failures), §space-type-sites (external fetch), §file-manager-skill-spec (path-stripping offset).
 This pass identified 31 new gaps: 10 CRITICAL, 12 HIGH, 7 MEDIUM, 2 LOW.
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
- # 1. The Upstream Staleness & AI Rebase Engine
When work is committed to `main` (Tier 1 Team Room), any active Tier 4 Private Scratchpad or Tier 2 Task Thread automatically detects that it is **behind upstream** and enables the agent to **autonomously inspect, evaluate, and pull changes.**
```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                        UPSTREAM STALENESS & AI REBASE FLOW                                             │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 1. [Commit on Main]         Admin merges PR #14 on `main` (New Commit: `c_main_v2`).                   │
│                                  │                                                                     │
│ 2. [Artifacts Event]        Cloudflare Queue receives `artifacts.repo.pushed`.                        │
│                             `WsHubDO` broadcasts `workspace.upstream_pushed` to all active threads.    │
│                                  │                                                                     │
│ 3. [Divergence Calculation] Active Thread DO queries: `env.AGENT_REPOS.compare(scratchpad, main)`      │
│                             Result: "2 commits behind main. Files changed: ['src/api/stripe.ts']"     │
│                                  │                                                                     │
│ 4. [UI Status Bar]          Thread UI updates: `[ 🌿 scratchpad-alice | ⚠️ 2 commits behind | [Sync] ]`│
│                                  │                                                                     │
│ 5. [AI Auto-Reconciliation] Agent in thread inspects diff:                                             │
│                             • "My task is editing `src/Header.astro`."                                 │
│                             • "Upstream changed `src/api/stripe.ts` (No direct overlap)."              │
│                             • Agent triggers `git.pull_upstream()` and updates its local types!        │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```
- ### A. The Agent "Time Machine" (Turn-by-Turn Auto-Commits & 1-Click Rollback)
* **The Problem:** An agent runs 6 turns, and on turn 5 it introduces a subtle bug. In standard chat agents, you have to manually copy-paste old code or restart.
* **The Artifacts Solution:**
  * Every single tool turn in `loop.ts` automatically creates a lightweight Git commit:
    ```bash
    git commit -m "Turn 4: Applied patch to src/Header.astro [Task #2]"
    ```
  * In the thread UI, every message has a **[⏪ Revert Workspace to Here]** button. Clicking it runs `git reset --hard turn_3_commit_hash` in **5 milliseconds**, restoring the exact repository state of that turn without data loss.
```
Thread Timeline:
├── Message 1 (User): "Add Stripe checkout"
├── Turn 2 (Agent): Scaffolds `stripe.ts` ──► 🏷️ Commit `t2-scaffold` [⏪ Rollback]
├── Turn 3 (Agent): Adds webhook handler ──► 🏷️ Commit `t3-webhook`  [⏪ Rollback]
└── Turn 4 (Agent): Broken CSS patch     ──► 🏷️ Commit `t4-css-bug`  [⏪ Rollback]
```
- ### Summary of What This Adds to the Platform
| Feature | How It Works with Cloudflare Artifacts |
| :--- | :--- |
| **Upstream Staleness Tracking** | Real-time `commitsBehind` badges across all scratchpads and task threads. |
| **Smart Agent Rebase** | Agents inspect upstream diffs before pulling, auto-rebasing non-overlapping files. |
| **Turn-by-Turn Time Machine** | 1-click rollback to any historical agent turn via instant Git commit resets. |
| **Reasoning-Aware `git-blame`** | Agents read historical commit reasoning to understand why past code was written. |
| **Multi-Model Branch Races** | Fork 3 branches for 3 models in parallel; merge the winning benchmarked code. |
| **AST-Aware Merge Resolver** | AI resolves Git merge conflicts automatically by understanding code syntax. |

### 19. Reasoning-Aware Git Blame

**Final behavior:** Commit messages embed structured front-matter metadata containing author agent role, user goal, task ID, and technical/legal rationale.

**Production acceptance contract:**
Production entry: artifact `validateMetadata` and agent commit context.
Persistence/deployment: commit metadata/front matter in RepositoryDO SQLite.
Required observable verification: repository tests reject incomplete metadata and return it on history/blame.

**Retained implementation constraints:**
- 71. **Project Journal, conversation memory + compaction, and the assistant/shell UI split are
    BUILT — and building them surfaced that the agent had NO conversation memory at all.**
    - **Project Journal** (`script-engine/project-journal.ts` + `prebuilt/project-journal.ts`).
      One `PROJECT.md` per project (`spaces/{id}/projects/{id}/PROJECT.md`, a SIBLING of
      `workspace/` so an ordinary file write can't spoof it): goal, standing instructions, status,
      todos, and a bounded log of what every agent did. Memory OS already shared L3/L4/L6 across a
      project and kept L5 private, but project STATE ("invoice.csv exists", "the payout task is
      done") was homeless, so two threads would each redo the other's work. Read ON DEMAND via
      `project_journal.read` — never injected per call, which is what lets it hold real detail.
      Bounded by entry count AND rendered bytes; overflow folds into a dense archive
      (Mastra Observational Memory's shape) rather than truncating. Summarisation is optional:
      LLM when wired, deterministic rollup when not — losing a completed action to a summariser
      outage would defeat the point. Scoping is structural (project comes from the run, never an
      argument). Both assistant profiles instruct: read before working, log after acting.
    - **The agent had no conversation memory.** Confirmed by reading `GatewayReasoner.decide()`:
      the payload carried goal + snapshot + candidates + this run's own steps, and NOTHING else.
      No history at all — so it could not resolve "do that again", could not answer "what did we
      decide", and re-asked what the user had just said. The context-usage meter (§A1.27) was
      measuring a transcript the model never received. New
      `script-engine/conversation-context.ts` carries recent history bounded by tokens and message
      count, walking backwards so the newest message can never be the one evicted; a single huge
      message is truncated (and says so) rather than evicting everything else.
    - **Compaction is explicit, never silent.** Claude Code's own has the documented failure mode
      the user described: after a compact the assistant treats anything absent from the summary as
      never having happened. So the payload itself carries a `notice` (not just the system prompt)
      saying the history is compacted, how many messages are missing, and to run
      `conversation.search` rather than guess. `DECISION_INSTRUCTIONS` says the same.

- Required Fix: A dedicated code-index prebuilt (distinct from knowledge-base — different content shape, different refresh cadence, different consumer) that maintains a per-project Vectorize namespace of code-chunk embeddings plus the structured dependency graph from G-BG04, both incrementally updated on every commit the Dev agent makes (a git post-commit hook implemented as a Tier-2 script, not a human-authored CI step) rather than batch-reindexed. script.find -style semantic lookup extends to code.find(query) so any of the four agents can ask "where is X handled" and get real, current file:line answers instead of guessing from an increasingly stale mental model — the direct fix for the "agents lose context when the codebase gets too large" failure mode named in the originating research.
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
- ### B. AI `git-blame` & Reasoning Attribution
When multiple agents and humans collaborate across a project, an agent often needs to understand **why a piece of code was written a certain way.**
* Every commit authored by an agent stores structured **Reasoning Front-Matter** in the Git commit message:
  ```yaml
  feat: add mutual indemnification clause in Section 4.2
- --AVOS-METADATA--
  author: "@LegalAgent"
  goal: "Review MSA for Delaware compliance"
  rationale: "Delaware Code § 145 limits unilateral indemnification for directors."
  task_id: "task_402"
  ```
* When another agent later inspects the file, it calls `git.blame("src/contracts/msa.md")` and reads **not just who wrote the line, but the exact legal/technical reasoning why they wrote it.**
- ### Summary of What This Adds to the Platform
| Feature | How It Works with Cloudflare Artifacts |
| :--- | :--- |
| **Upstream Staleness Tracking** | Real-time `commitsBehind` badges across all scratchpads and task threads. |
| **Smart Agent Rebase** | Agents inspect upstream diffs before pulling, auto-rebasing non-overlapping files. |
| **Turn-by-Turn Time Machine** | 1-click rollback to any historical agent turn via instant Git commit resets. |
| **Reasoning-Aware `git-blame`** | Agents read historical commit reasoning to understand why past code was written. |
| **Multi-Model Branch Races** | Fork 3 branches for 3 models in parallel; merge the winning benchmarked code. |
| **AST-Aware Merge Resolver** | AI resolves Git merge conflicts automatically by understanding code syntax. |

## Final reconciled architectural changes (newest authority)

These are normative replacements, not optional context. Remove or migrate superseded behavior; do not implement both architectures.

#### 1. The Universal Swarm Orchestrator Paradigm
* **This updates/replaces:** The Grok Bot / Hermes "chatty coworker roster" model (where users manage 5 named avatars in a sidebar and act as middle-manager dispatchers).
* **The New Architecture & Mental Model:** The user interacts with **ONE Sovereign Universal Agent (`NaelaoAgentDO`)** that acts as the **Lead Swarm Director** (modeled directly after Cursor’s SQLite benchmark swarm). When given a goal (`/goal` or natural language), the Universal Agent does not engage in conversational roleplay; it deconstructs the objective into a clean Task DAG in `SpaceDO.tasks`, forks isolated Git branches on Cloudflare Artifacts, and dispatches tasks to ephemeral worker subagents.
* **Key Invariant:** The human is strictly the **Outcome Definer & Final Approver**; the AI Lead is the **Orchestrator**. Humans never act as air-traffic controllers between bots.

#### 17. Generalization of `/workspace/` (Deliverable Canvas, Not Just Code)
* **This updates/replaces:** The developer bias that Git and `/workspace/` are strictly for programming source code.
* **The New Architecture & Mental Model:** `/workspace/` is the **Project Deliverable Canvas** regardless of file format. In legal projects, it holds contract suites (`.docx`, `.md`); in finance, it holds Excel models (`.xlsx`, `.csv`); in coding, it holds source code (`src/`). All executable agent machinery (skills, workflows, daemons) lives strictly in `/.avos/`.
* **Key Invariant:** Cloudflare Artifacts (Git for Agents) versions any file type; Pull Request cards adapt to show spreadsheet cell deltas or document redlines.

## Required execution and response

1. Convert every numbered specification above into a file/request-path checklist before editing.
2. Implement in dependency order and reuse canonical workers/DOs rather than parallel helpers.
3. Return one complete apply-ready unified diff for every changed, created, or deleted file. Do not use
   ellipses, pseudo-code, TODO-only stubs, omitted boilerplate, or comments standing in for code.
4. Include exact migration, provisioning, secret rotation, rollout/backfill, rollback, and staging
   smoke commands.
5. Include exact test/typecheck/config-parity commands and the security/race assertions they prove.
6. Finish with an item-by-item release ledger: IMPLEMENTED, PARTIAL, or MISSING with honest gaps.

Do not silently omit an item. If one response cannot hold the implementation, stop only after an
atomic, testable commit boundary. Never claim completion because code merely compiles. The response
must start with `diff --git`; record verification notes in an added or updated repository file if
they are necessary to preserve them.
