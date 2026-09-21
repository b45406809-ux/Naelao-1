# AI Studio implementation prompt — batch 06, plan items 25–33

## Mission

Implement every requirement below end to end on the current accumulator branch. The cohesive focus
is **Connector aliases, authorization, channels, and delegation**. This prompt is self-contained: the feature definitions and retained implementation
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


### 25. Decoupled Logical Connector Binding Matrix

**Final behavior:** Application code never hardcodes account handles (e.g. `leads@company.com`). Scripts reference abstract aliases (`primary_inbox`) mapped dynamically in SQLite.

**Production acceptance contract:**
Production entry: connector resolver/MCP hub.
Persistence/deployment: alias + scope rows in D1; `MCP_HUB`.
Required observable verification: connector scope tests prove user > project > space resolution without cross-tenant fallback.

**Retained implementation constraints:**
- 95. **Channel setup is now scan-to-connect: one Naelao app per channel + a pairing QR, replacing
    BYO-app-per-space.** Prompted by the OpenClaw comparison — their Web Gateway shows a QR you
    scan and you're done in 60 seconds, while ours asked a non-technical owner to open a developer
    console, create an app, find a signing secret, paste it, then copy a webhook URL back into the
    provider. Every step is somewhere they stop, and none of it was work they should ever have
    done: it existed only because the platform had no app of its own.
    - **`launchpad/channel-pairing.ts`**: a short-lived (15 min) single-use `cp_`+32-hex token
      (sized to fit Telegram's 64-char `start` pa
- The Gap Product slug generation derives a slug from the product name (e.g., "My Product" → "my-product") in application code and inserts it into SpaceDO SQLite without a UNIQUE constraint on the slug column or an atomic reservation step. Two concurrent POST /products requests with the same product name will both compute "my-product", both check for availability (both see it as available), and both attempt INSERT — whichever finishes last wins but the first has already returned a 201 with the slug to the client. The client now has a slug that leads to the wrong product.
- 3. **Fix B (same audit, same root cause family): the three Launchpad system prompts referenced
   tools that don't exist in the script-native surface** — `"the Stripe tool"`, `"the email
   tool"`, `"the CRM tool"` (`launchpad/spacetype.ts`, written verbatim into `system-prompt.md`
   by `launchpadAgentToProfile`). Payment is Lemon Squeezy via the reserved `commerce` prebuilt
   (the established specification / the established architecture #9), never a builder's own Stripe key. Rewrote all three
   (`launchpad-fulfillment-v1`, `launchpad-support-v1`, `launchpad-content-v1`) to reference
   `script.find`/`script.create` + distillation, the `commerce` prebuilt for money-in,
   `notifications` for customer/owner messages, `mcp-conn
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi

### 26. Pre-Flight Scope Verification & Incremental Re-Auth

**Final behavior:** SDK validates granted OAuth scopes before execution. If write permissions are missing on a read-only token, it halts and surfaces an incremental scope upgrade card.

**Production acceptance contract:**
Production entry: connector connect/execute routes and scope verifier.
Persistence/deployment: granted scopes + OAuth state in D1/credentials.
Required observable verification: Composio/Pipedream tests cover missing-scope card then successful retry.

**Retained implementation constraints:**
- 58. **Whop added as a second PLATFORM billing provider (AUDIT_TODO.md AI-7), replacing Lemon
    Squeezy as the FIRST-TRIED provider for builder platform plans and end-user subscriptions/
    credit-packs — LS stays as the fallback, item 45 is not reverted.** Trigger: the operator
    couldn't activate a Lemon Squeezy store because LS's own onboarding requires a Stripe-linked
    payout path unavailable in their country. Two genuinely different Whop relationships were
    built, neither the same as the invite-gated Platforms API (items 50-51, business-wallet
    sub-merchants) or the read-only "Connect with Whop" OAuth connector (item 53):
    - **Platform-plan checkout** (`packages/billing-
- Default: 1 assistant per user per Space — second creation attempt returns error
 Admin raises limit to 3 — third assistant creation succeeds
 Heartbeat reads cron-jobs.json from R2 and dispatches overdue jobs
 Heartbeat skips jobs where nextRun > now (no premature execution)
 Heartbeat updates lastRun and nextRun after job dispatch
 Channel message routes to correct channel session (Slack → slack session)
 Channel message processed as runFiber so heartbeat is not blocked
 Slack webhook Origin validation fails with fake Origin header
 Slack webhook URL verification challenge returned correctly
 Permission manifest stored in DO SQLite, not R2
 Skill code cannot modify permissions tab
- - `workers/agents/src/connectors/oauth.ts` — generic OAuth2+PKCE helpers (not Whop-specific code;
  any future connector with a catalogue `oauth` spec reuses these): `generatePkce`,
  `buildAuthorizeUrl`, `exchangeCodeForTokens`, `refreshTokens` (Whop rotates the refresh token on
  every use — the new one is always persisted, the old one never reused), and a KV-backed
  single-use OAuth ticket (`issueOAuthTicket`/`consumeOAuthTicket`) mirroring the codebase's own
  stream-ticket precedent: a short-lived, server-held, single-use ticket rather than putting a
  PKCE verifier or any credential in a browser-navigable URL.
- New `ConnectorDefinition.oauth` field (`catalogue.ts`): authorize/token U
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi

### 27. Gatekeeper Capability-Based Cross-Subspace Delegation

**Final behavior:** Cross-department tool access is governed by cryptographically signed, attenuated tokens specifying allowed resource IDs and expiration timestamps.

**Production acceptance contract:**
Production entry: Gatekeeper/capability verifier and SpaceDO check.
Persistence/deployment: grants + revocation/nonce data; platform signing secret.
Required observable verification: tamper, expiry, wrong-resource and sibling isolation tests.

**Retained implementation constraints:**
- The Gap: CF Zero Trust is referenced for admin tool protection but no spec exists for: device posture checks (is the admin's device up-to-date?), service token rotation for machine-to-machine admin calls, or audit logging of all admin tool access. SOC 2 CC6.3 (multi-factor authentication) and CC6.6 (threat detection) require these controls.
 Required Fix: Configure CF Zero Trust policies for admin tools: (1) Device posture: require CF WARP client installed + OS version check + no malware detection — enforced via Zero Trust device policy; (2) Service tokens: machine-to-machine calls to admin Workers use CF Service Tokens with 90-day rotation schedule (automated via CF API in a Workflow); (3)
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
- ### 2. The "Gatekeepers" Capability-Based Security Model
The fatal flaw of traditional plugins and AI-generated apps is **Raw API Keys**:
* If an AI micro-app is given a master API key, a malicious prompt or buggy script can query other departments, read executive emails, or drain company funds.
**Gatekeepers replaces API keys with Unforgeable, Attenuated Capability Tokens.**
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    THE GATEKEEPER SECURITY PROTOCOL                         │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. THE HUMAN PERMISSION CEILING (Invariant #1)                              │
│    An agent or micro-app can NEVER hold more power than the human who       │
│    created it. If Alice is a "Member" (no refund authority), any micro-app  │
│    Alice builds is physically incap

### 28. 3-Tier Connector Scoping

**Final behavior:** Integrations are partitioned into `Space-Shared` (company Stripe), `Project-Bound` (support WhatsApp), and `User-Personal` (Alice's private Gmail).

**Production acceptance contract:**
Production entry: connector directory/resolver.
Persistence/deployment: scoped credential and connector rows; credentials/MCP bindings.
Required observable verification: connector hierarchy tests prevent broader fallback from shadowing a narrower binding.

**Retained implementation constraints:**
- Required Fix: Three feedback channels, each reusing existing infrastructure rather than inventing new ingress: (1) the existing multi-channel gateway (Slack/Discord/email/WhatsApp, item 11 of the established architecture) already lets a customer-bot project ingest a support channel — an operator project subscribes its PM agent to the SAME channel catalogue, tagged feedback_source instead of support_source ; (2) a new product-analytics prebuilt script reads the operator's OWN deployed product's event stream (via a builder-supplied read-only analytics connector — PostHog/Amplitude/Mixpanel MCP servers already fit the existing mcp-connector pattern, BYO-key per the universal-tools doctrine's own carve-out for a b
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
- ### 1. The 3-Tier Connector Scope Taxonomy
```
                                  ┌──────────────────────────────────────────────┐
                                  │           MCP CONNECTOR SCOPE MODEL          │
                                  └──────────────────────┬───────────────────────┘
                                                         │
         ┌───────────────────────────────────────────────┼───────────────────────────────────────────────┐
         ▼                                               ▼                                               ▼
┌─────────────────────────────────┐             ┌─────────────────────────────────┐             ┌─────────────────────────────────┐
│ 🏢 1. SPACE-SHARED CONNECTOR    │             │ 👤 2. USER-PERSONAL CONNECTOR   │             │ 📁 3. PROJECT-SPECIFIC CONNECTOR│
│ `scope: "space_shared"`         │             │ `scope: "user_per

### 29. Public Channel Tool Stripping & MCP-UI Privacy Bridge

**Final behavior:** Personal tools are physically stripped from the LLM prompt in public channels. If a personal task is requested, the agent emits an interactive card to fork to a private scratchpad.

**Production acceptance contract:**
Production entry: prompt tool filter/channel orchestration.
Persistence/deployment: channel session scope in SpaceDO.
Required observable verification: tool-filter tests inspect the actual serialized schema; card is observable.

**Retained implementation constraints:**
- # naelao-workspace R2 bucket — agent filesystem and skills
spaces/
 {spaceId}/
 .skills/ # Space-level skills (Tier 2)
 {skill-name}/
 SKILL.md
 scripts/
 workflows/
 assistants/
 {userId}/ # Space Assistant filesystem
 cron-jobs.json
 skills/ # Assistant personal skills
 dynamic-tools/ # Self-authored Dynamic Worker tools
 channels/ # Channel configs (Slack, Discord, etc.)
 projects/
 {projectId}/
 workspace/ # Shared project workspace (ProjectDO manages locks)
 todo.md
 output/
 data/
 .versions/ # Version history (every file write)
 knowledge/ # Project knowledge docs
 workflows/ # Agent-authored Dynamic Workflows
 agents/
 {agentId}/
 workspace/ # Agent-specific workspace
 ski
- **J5 — new binding, new Workflow class, both narrowly scoped.** `wrangler.toml` gained a second
`[[workflows]]` entry (`ScriptRunWorkflow` / binding `AGENT_SCRIPT_WORKFLOW`), separate from
`AgentTaskWorkflow`'s `AGENT_TASK_WORKFLOW` — different payload shape (`scriptName`+`params` vs. a
full agent turn's goal/systemPrompt/tools), different purpose, so two classes rather than
overloading one. `NaelaoAgentDO.buildScriptEngineEnv` wires `env.workflowRunner` from
`this.env.AGENT_SCRIPT_WORKFLOW` when present, mirroring `codeRunner`'s wiring exactly (optional,
degrades honestly). `buildOrchestrationHooks` was restructured (it previously `return {}`ed
entirely when `NAELAO_AGENT_DO` was absent, wh
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- ### 8. "Harvey for GovCon" — Federal RFP & Grant Bidding Desk
* **Target Buyer:** Defense contractors, IT staffing vendors, non-profit grant writers.
* **When & Where It’s Used:** When evaluating and assembling multi-million dollar government solicitation bids (SAM.gov).
* **What It Parses:**
  * 150-page Federal Acquisition Regulation (FAR) compliance matrices, RFP solicitations, and past proposal win archives.
* **How It Works with Parse 5 & AVOS:**
  1. Proposal writer uploads government RFP solicitation PDFs.
  2. Parse 5 converts evaluation criteria, CLIN pricing tables, and mandatory clauses into structured Markdown.
  3. The GovCon Agent automatically builds a **Compliance Matrix Task DAG** in the Project Journal, assigning each section to specialized writer subagents.
* **The Pitch & Pricing:**
  * **Price:** **$499 / month**.
  * **Pitch to Gov Contractors:** *"Win more feder

### 30. Single-Use Ephemeral Action Grants

**Final behavior:** Quick one-off personal actions in public rooms are authorized via MCP v2 Elicitation cards, minting a 15-second single-use token that executes without revealing credentials.

**Production acceptance contract:**
Production entry: elicitation grant mint/consume.
Persistence/deployment: nonce consumption ledger in DO SQLite.
Required observable verification: replay, expiry, identity and 15-second boundary tests.

**Retained implementation constraints:**
- Required Fix: Add optional COMPOSIO_API_KEY and PIPEDREAM_API_KEY Workers Secrets to mcp-hub. Key resolution per provider-routed server: (1) if the server row carries auth_secret_name , the builder's own vault credential wins (a builder running their own Composio project keeps full control and their own billing); (2) otherwise the PLATFORM key for that provider is injected server-side — the builder and end user never see it, never enter it; (3) if neither exists, fail with a clear "provider not configured on this platform" error. The platform key lives only inside mcp-hub (already the case for vault credentials — isolates receive only 60-second internal tokens). The reserved money-in tool-na
- - `workers/agents/src/connectors/oauth.ts` — generic OAuth2+PKCE helpers (not Whop-specific code;
  any future connector with a catalogue `oauth` spec reuses these): `generatePkce`,
  `buildAuthorizeUrl`, `exchangeCodeForTokens`, `refreshTokens` (Whop rotates the refresh token on
  every use — the new one is always persisted, the old one never reused), and a KV-backed
  single-use OAuth ticket (`issueOAuthTicket`/`consumeOAuthTicket`) mirroring the codebase's own
  stream-ticket precedent: a short-lived, server-held, single-use ticket rather than putting a
  PKCE verifier or any credential in a browser-navigable URL.
- New `ConnectorDefinition.oauth` field (`catalogue.ts`): authorize/token U
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- ### 6. "Harvey for CPAs" — Forensic Audit & Tax Schedule Desk
* **Target Buyer:** CPA accounting firms, fractional CFOs, bookkeepers.
* **When & Where It’s Used:** During annual tax season, IRS audits, and corporate financial reconciliations.
* **What It Parses:**
  * Schedule K-1 forms, 1099 statements, foreign tax credit receipts, and handwritten expense logs.
* **How It Works with Parse 5 & AVOS:**
  1. Accountant drops 100 client receipts, K-1s, and bank statements into the project.
  2. Parse 5 parses non-standard table formats and matches partner distribution percentages.
  3. The CPA Agent cross-references reported distributions against general ledger journal entries.
* **The Pitch & Pricing:**
  * **Price:** **$199 / month** (or $399/mo during tax season).
  * **Pitch to Accounting Firms:** *"Eliminate manual K-1 and receipt data entry during tax season. Turn paper document ch

### 31. Turn-Holder vs. Referent Mention Router

**Final behavior:** When multiple bots are mentioned (e.g. `@ReviewBot audit @DevBot's patch`), the leading mention gets the turn lock; subsequent mentions become context references and do not wake up.

**Production acceptance contract:**
Production entry: mention router/channel inbound handler.
Persistence/deployment: channel event dedupe + turn lock.
Required observable verification: multi-mention tests prove only first bot wakes.

**Retained implementation constraints:**
- 151. **A new 28-step goal batch (Google Drive `new/goal 1.txt`) is IN PROGRESS — the first
     tranche (steps 2, 3, 8, 9, 10, 12, 13a, 14, 19, 24) is BUILT, tested, and deployed.** The
     authoritative list is the user's Drive file (28 steps, item 1 = a Claude-Code-style
     context-window breakdown UI for the Stats tab; the finale = 6 business templates + business-
     wide BYOK). Shipped so far:
     - **Step 10 (spawn/consult model+agent validation):** `agent.spawn` validates each task's
       model against `ALLOWED_MODELS` before delegating — a wrong id gets a real "did you mean"
       (new `billing-core` `suggestModels`) instead of a silent escalation-clamp (which read as a

- The Gap
 Partial Stream on Disconnect — Half-Written Assistant Messages Persist as Complete When an agent streams a response token-by-token and the connection drops mid-stream — or the DO is evicted, or the LLM call errors halfway — the spec does not define what happens to the partial message. The risk: a half-generated assistant message gets written to the thread as if it were complete. On the next turn, the agent reads its own truncated message as context and continues from a sentence that was cut off mid-word. The conversation becomes incoherent and there is no marker that the message was incomplete. The Missing Message Lifecycle States The spec stores messages with no explicit completio
- - **`packages/billing-core/src/providers/stripe.ts`** — fetch-based `StripeProvider`
  (form-encoded, no SDK): `verifyWebhook` (Stripe-Signature `t=…,v1=…` HMAC, 5-min tolerance,
  constant-time compare), `parseWebhookEvent` (checkout.session.completed → payment.success,
  subscription.*, charge.refunded → refund.issued; folds the Connect event's `account` into
  `metadata.stripe_account` and captures `payment_intent` — the ONE id shared between a
  checkout event and its later refund event), `createCheckout` (ad-hoc `price_data`, direct
  charge + application fee). Connect helpers: `createExpressAccount` / `createAccountLink` /
  `getAccountStatus`. LS provider gained `lsListStores` / `lsCr
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi

### 32. Sequential Turn Delegation

**Final behavior:** Orderly handoffs between agents via `ctx.agent.delegate()`, transferring the active execution turn lock cleanly and preventing multi-agent race conditions.

**Production acceptance contract:**
Production entry: `ctx.agent.delegate`/NaelaoAgentDO delegation handler.
Persistence/deployment: turn-holder lock and task rows in DO SQLite.
Required observable verification: delegation grouping/race tests; old holder cannot continue after transfer.

**Retained implementation constraints:**
- 73. **"Long-running background agent" was capped at 29 seconds — now genuinely unbounded — plus a
    replay-safety ledger, an honest `awaiting_approval` status, and an unauthenticated approvals
    surface closed. Driven by reading CF's own docs rather than this file's stale invariant.**
    - **The 29s cap.** `AgentTaskWorkflow` set `timeout: 29_000` on `run-agent`, the step that does
      all the work. **A CF Workflow step has NO wall-time limit** — only a CPU-time limit, which
      excludes time spent waiting on an LLM/tool/any I/O (`/workflows/reference/limits/`, verified
      2026-07). The ceiling was self-imposed and traceable to this file's own Key CF Invariants line
      claimin
- The Gap CF Durable Objects' input gate only protects storage operations (this.ctx.storage.*). Calls to fetch(), env.R2.put(), env.QUEUE.send(), and similar non-storage I/O do NOT block incoming requests during their execution. If AssistantDO issues a fetch() to an external LLM API (which may take 5-30 seconds), concurrent WebSocket messages or heartbeat requests can arrive and interleave — reading stale in-memory state (this.activeRuns, this.lastHeartbeat, etc.) while the first request awaits the network call. This causes: lost increments to in-memory counters, race conditions in the agentic loop state machine, and double-processing of scheduled jobs.
- Two things the initial framing got wrong, checked before fixing anything (worth recording so a
future pass doesn't inherit the same overstatement):
1. **This is not the enforcement path.** `checkQuota`'s `allowed` boolean (the thing this KV
   counter feeds) is computed in `workers/billing/src/index.ts`'s quota-summary handler but
   never read to block anything — it's returned in a `GET .../quota`-style response body for a
   dashboard usage meter. The actual quota/entitlement enforcement used platform-wide (spaces
   worker, agents worker, knowledge worker's KB-document-count gate) goes through
   `@naelao/entitlements`'s `EntitlementsChecker`, which runs a live `COUNT(*)` D1 query
   dire
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi

### 33. Cryptographic Delegation Chaining

**Final behavior:** Delegated tasks carry an HMAC-signed token with the initiating human user's ID and role rank, preventing low-privilege users from bypassing RBAC via agent delegation.

**Production acceptance contract:**
Production entry: delegation token mint/verify.
Persistence/deployment: signed claims + nonce/expiry; platform secret.
Required observable verification: tamper, privilege amplification, wrong-user and expiry tests.

**Retained implementation constraints:**
- 90. **"Can't change assistant configs" root-caused to a one-word role check — and verifying the fix
    against production surfaced THREE more real bugs, including an infinite refetch loop that had
    been silently blanking the Dashboard. Plus the QClay-style composer dock and two real settings
    pages.**
    - **The reported bug.** `apps/shell`'s Dashboard gated every config control on
      `business?.role === "admin"` — an EXACT match. Whoever creates a business is inserted as
      `'owner'` (`workers/spaces/src/business-routes.ts`), and the backend ranks
      `owner(3) >= admin(2)` (`business-auth.ts`'s `ROLE_RANK`), so the server would have accepted
      every write the UI never o
- The Gap When a space member's role is downgraded (e.g., from admin to viewer) or when a member is removed, the handler updates the space_members SQLite row but does not invalidate active WebSocket sessions or cached JWT tokens that still carry the old role claim. If the member has an active browser session with a JWT that expires in 24 hours, they retain admin privileges for the full 24 hours after being downgraded. During a security incident (compromised employee account), revoking access takes effect only after the attacker's session expires naturally. This is unacceptable for a platform handling user data and AI agent execution.
- 1781/1781 tests pass (12 new: `infra-usage-metering.test.ts` proving the conversion function's
invariants and `reportWorkflowStepInfraUsage`'s real-and-degrades-honestly behavior;
`infra-usage-quota-gate.test.ts` proving the pre-run gate's fail-closed/fail-open cases and its
narrow BUILDER_CALLER_ROLES-only scoping via the same `NaelaoAgentDO` `/run` fixture pattern
`interactive-run-end-user-credit-gate.test.ts` established), `pnpm turbo run typecheck` clean (75
tasks). Next: Phase 4 (real token streaming + context-window usage UI + pre-send
auto-compaction), Phase 5 (model switcher).
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi

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
