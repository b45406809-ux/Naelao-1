# AI Studio implementation prompt — batch 20, plan items 92–99

## Mission

Implement every requirement below end to end on the current accumulator branch. The cohesive focus
is **Authenticated automation ingress and failure defenses**. This prompt is self-contained: the feature definitions and retained implementation
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


### 92. Edge Ingress Webhook Router with HMAC Validation

**Final behavior:** Validates cryptographic HMAC signatures (Stripe, GitHub, Shopify) in sub-2ms before passing payloads to compute tiers.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- 128. **"insufficient credits — top up or subscribe to keep chatting" is now a real upgrade dialog,
     not a bare error banner — and the underlying gap it exposed (a billing gate's machine-
     readable `error_code` was parsed and then silently discarded on the async dispatch path,
     every real chat message's path) is fixed at the root.** Traced the exact string to
     `NaelaoAgentDO.enforceRunGates`'s `product_end_user` own-balance credit check (a `402` with
     `error_code: "insufficient_credits"`) — one of several billing gates sharing this shape
     (`subscription_inactive`, `quota_exceeded`, `infra_quota_exceeded`, and a DIFFERENT
     `insufficient_credits` variant for an empty
- Required Fix Add source IP allowlisting as a defense-in-depth layer for webhook ingress: (1) Maintain an IP allowlist for each webhook source in KV (refreshed daily from official published lists: Stripe publishes its webhook IPs, GitHub publishes its hook IPs via the meta API). (2) The webhook handler checks CF-Connecting-IP against the allowlist BEFORE computing the HMAC (fail fast, reduce attack surface). (3) For sources without published IP ranges (custom MCP webhooks), require HMAC-SHA256 validation with a 300-second timestamp skew tolerance. (4) Log all webhook deliveries with source IP for anomaly detection.
- **Fixed:**
- `workers_dev = false` added to every `workers/*/wrangler.toml` except the workers that need
  genuine public ingress with their OWN independent verification: `naelao-router` and
  `naelao-portal-router` (the public API/portal surface itself), `naelao-agents` (the
  signature-verified multi-channel gateway, `adapter.verifySignature`), `naelao-billing`
  (Stripe/Lemon Squeezy webhook signature checks), and `naelao-ws-gateway` (WebSocket upgrades
  do their own origin + tenant check, can't be relayed through a service-binding fetch).
- `proxyTo` now unconditionally `headers.delete()`s all five identity/internal headers before
  the `if (claims)` block sets them from verified JWT cl
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi

### 93. Edge Tombstone Filter (410 Gone / 204 Drop)

**Final behavior:** KV registry returning `410 Gone` on deleted webhooks and `204 No Content` on paused webhooks, absorbing zombie webhook floods for $0 compute.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- 84. **Projects sidebar (mockup port), in-chat approval + connector cards, a Connectors browser
    (Composio default / Pipedream filter), and input-bar Connectors/Upload buttons — a large,
    user-directed batch, explicitly scoped down in two places (documented below, not silently
    dropped).**
    - **Projects page sidebar.** `apps/launchpad/src/index.html`'s `#projects-view` has a 220px
      left rail (project tree + "Agents in Space" shortcuts) the shell's `/projects/[projectId]`
      page never ported (item 81 only matched the RIGHT pane). Added, reusing the Discover page's
      existing `.spaces-layout`/`.spaces-sidebar`/`.spaces-content` classes rather than inventing
      new on
- The Gap A single logical entity (a knowledge document) spans three stores: a SQLite metadata row, R2 object(s) for content, and Vectorize vectors for embeddings. There is no foreign-key relationship across stores and no reconciliation job. Over time, partial failures cause drift: SQLite rows pointing to deleted R2 objects, R2 objects with no SQLite row (orphans consuming storage/cost), Vectorize vectors for documents that no longer exist (returning ghost results), and documents missing their vectors (silently absent from RAG). At scale this drift is continuous and invisible.
- The ENTIRE A1.29 Wallet Connect subsystem: `StripeProvider` (`packages/billing-core/src/
providers/stripe.ts`, deleted), migration 0063's application code (the migration file itself is
left in place, unused — D1 has no cheap drop-and-forget story and nothing writes to it anymore),
`workers/billing/src/{wallet-connections,wallet-checkout,wallet-webhooks}.ts` (deleted),
`/webhooks/stripe` + `/webhooks/lemon-squeezy/wallet/:connectionId`, the dashboard
`PaymentsAccountCard`'s Stripe/LS connect flow, the shell business-detail Payments Account card,
and every `BillingProvider`/`BillingProviderEnv` "stripe" type-union member (now `"lemon_squeezy"`
only — item 45's platform-billing-is-LS-only decis
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi

### 94. Cloudflare Queues Concurrency Buffering

**Final behavior:** Buffers incoming webhook bursts (e.g. 10,000 Shopify Black Friday orders) into Cloudflare Queues, pacing worker execution safely.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

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
- D1 (platform metadata, billing, users — single instance today;
- The Gap
 None of the wrangler.jsonc queue consumer definitions set `max_concurrency`. When a burst of messages arrives (e.g., 500 run-complete notifications from a parallel workflow), CF Queues spawns up to 250 concurrent Worker invocations by default. Each invocation makes calls to APNs, FCM, Slack webhooks, and Analytics Engine. APNs rate-limits at 300 requests/second per certificate. FCM limits at 500/second. The burst from unbounded queue consumers hits these limits immediately, triggering 429 errors, causing messages to be retried, causing more burst, in a cascading failure loop.
- - **Money-in is reserved.** `RESERVED_CAPABILITIES` (checkout, charge, payout, wallet, …) may
  only be provided by Naelao's **prebuilt `commerce` script**, which holds the Lemon Squeezy
  store credentials (Workers Secret) and bakes in the platform fee (`naelaoFeeBps`).
  `ScriptToolSurface.create/update` **fail closed**: a user/agent script that references an
  external payment host (Stripe/PayPal/… *and* `api.lemonsqueezy.com`), embeds a payment SDK,
  or declares a reserved capability/domain is rejected. Builders keep full freedom to author
  delivery, marketing, storefront-UI, and email scripts — just not the wallet. 9 unit tests.
- **Business services are Naelao-provided multitenant pr
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi

### 95. Time-Travel Webhook Event Replay Lake in R2

**Final behavior:** Archives raw webhook payloads to Cloudflare R2 with 14-day retention rules, enabling 1-click replaying of historical events against patched code.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- 98. **The assistant had never once been told who it was, `/new` silently dropped the user's first
    message, and a completed run 404'd on its own status poll. All three reported by the user, all
    three root-caused against live behaviour rather than guessed at.**
    - **The agent's own system prompt reached the model in no run, ever.** `loadAgentConfig` read
      `system-prompt.md` from R2 on every call and used it only to parse approval gates;
      `GatewayReasoner` hardcoded `system: DECISION_INSTRUCTIONS`. Every word of
      `LAUNCHPAD_ASSISTANT_PROFILE` — the business-building methodology, the wallet rules, "read the
      project journal first" — written, stored, never delivered
- The Gap: Builders want to automate actions within their Space based on events (e.g., "when end-user hasn't returned in 7 days, send a re-engagement email"; "when Space error rate exceeds 5%, send Slack alert"). No event-driven automation framework exists within Spaces. Builders must build this externally via webhooks (G-AR41) and their own infrastructure.
 Required Fix: Add Space Automation rules to SpaceConfig: automations: [{trigger: {event: "end_user_inactive", condition: {idle_days: 7}}, action: {type: "send_email", template_id: "...", to: "{{end_user.email}}"}}] . Trigger types: end_user_inactive, error_rate_exceeded, budget_threshold, new_end_user, conversation_completed . Action type
- `GET .../agent/runs/:runId/stream` used named SSE events (`event: status`, `event: done`) with
payloads carrying no `type` field. A browser's native `EventSource.onmessage` only fires for
UNNAMED (default `message`) events — so it never fired for this endpoint's output at all. Read all
three known chat clients (`apps/shell/Chat.tsx`, `apps/widget/naelao-chat.ts`,
`apps/portal/.../page.tsx`) and confirmed they independently already expect an unnamed event
carrying `{type: "delta"|"done"|"error", ...}` — a systemic, shared assumption, not a typo in one
file. The only way any client ever progressed was `onerror` firing once the stream closed
(interpreted as a dropped connection), falling back t
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi

### 96. Leaky-Bucket Outbound Rate-Limiter Pacer

**Final behavior:** Paces outbound API requests through `ConcurrencyDO` (e.g. max 5 req/sec to HubSpot or Instagram), preventing external provider HTTP 429 bans.

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

- // Temple: DevPilot — configuration
const TEMPLE_DEVPILOT: Temple = {
 id: 'temple-devpilot-v1',
 name: 'DevPilot',
 tagline: 'AI coding assistant — your stack, your control',
 category: 'developer-tools',
 spaceType: 'developer',
 suggestedPricing: { type: 'seats', pricePerSeat: 2000, trialDays: 14 }, // $20/seat/month
 defaultAuthProvider: 'custom-oidc',
 productConfig: {
 allowPublicSignup: false,
 featureFlags: {
 'inline-autocomplete': true,
 'multi-file-context': true,
 'test-generation': true,
 'code-review-agent': true,
 'background-refactor': false, // Off by default — costs more credits, enable per team
 'terminal-access': false, // Disabled by default for security — builder can en
- - **Money-in is reserved.** `RESERVED_CAPABILITIES` (checkout, charge, payout, wallet, …) may
  only be provided by Naelao's **prebuilt `commerce` script**, which holds the Lemon Squeezy
  store credentials (Workers Secret) and bakes in the platform fee (`naelaoFeeBps`).
  `ScriptToolSurface.create/update` **fail closed**: a user/agent script that references an
  external payment host (Stripe/PayPal/… *and* `api.lemonsqueezy.com`), embeds a payment SDK,
  or declares a reserved capability/domain is rejected. Builders keep full freedom to author
  delivery, marketing, storefront-UI, and email scripts — just not the wallet. 9 unit tests.
- **Business services are Naelao-provided multitenant pr
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi

### 97. Payload Hash Idempotency Deduplication

**Final behavior:** Hashes provider event IDs and resource IDs in SQLite. Duplicate events received within 24 hours are acknowledged and discarded.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- 74. **The four items item 73 left open are now BUILT — plus a real bug found while closing them:
    the script-native path never persisted the assistant's answer.** The client writes the USER
    message before dispatching, but nothing wrote the reply, so a reload showed questions with no
    answers, the agent's own conversation memory (item 71 — which reads that same SpaceDO
    transcript) only ever saw the user's half, and a resumed run had nowhere to put its result.
    `handleScriptRun` now writes the answer back via a new `writeAgentAnswerToSession` —
    deliberately NOT the legacy `writeConversationToSession` goal+answer pair, which would
    duplicate every question — attributed w
- Required Fix
 Required Fix Add an idempotency key to webhooks: store a hash of (spaceId, provider, event_type, event_id) and reject duplicate webhooks within a 24-hour window. Use a unique constraint on space_triggers to prevent duplicate registrations: no two triggers with the same (space_id, provider, event_type, target_type, target_id). Make workflow execution idempotent: if the same workflow is triggered twice with the same input, the second one is a no-op. Severity: Medium — Concurrent triggers cause duplicate workflow dispatches. No idempotency key or deduplication. Workflows execute multiple times for single webhooks. T-173 — naelao-notifications
- **Explicit signals — no new ingestion.** `agent_activity_log` (item 40) already carries
`event_type`/`tokens_used`/`cost_credits`/`created_at` for every run completion/failure and
approval request — exactly what error rate and avg/total cost need. New `GET /spaces/:spaceId/
agent-signals?project_id=&window_hours=` (SpaceDO's `computeAgentSignals`, builder-only, same
gate as `agent-activity`) rolls it up on read: `runs_total/completed/failed`, `error_rate`,
`avg_cost_credits`, `total_cost_credits`, `approvals_requested`. "Regenerations" (a proxy for the
user hitting retry) is computed in application code — 2+ run events on the SAME thread within 5
minutes — rather than a SQL window function,
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi

### 98. Ouroboros Loop Circuit Breaker

**Final behavior:** Injects `x-avos-hop-count` headers into automation payloads. If hops exceed 2 within an hour, execution halts, breaking recursive loops.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- 137. **Follow-up to the stop-hook's exact objection: Groq's own 429 says precisely how long to
     wait, and the reasoner threw that away instead of waiting — closing the last blocker item 136
     left open.** Four spaced live attempts in item 136 all died on provider capacity; the honest
     conclusion was "capacity, not capability," but the hook was right that "check other models"
     was not a real test of anything. The actual fix is structural: Groq's rate-limit body reads
     *"Please try again in 27.715s"* and the reasoner discarded it, failing the whole run on the
     first transient hit — on a free tier whose 12k-tokens-per-minute ceiling sits below this
     agent's own ~9-11k
- Required Fix Implement poison message detection: after 3 consecutive failures of the same message type within 60 seconds, flag the message as a potential poison message. Store it in R2 for analysis. Send an alert. Use a `messageId` hash to identify the same message across retries. Add a per-consumer circuit breaker that stops processing if failure rate exceeds 50% for 5 minutes.
- **Tests:** `tests/unit/project-config-fail-closed.test.ts` (new, 6) — `handleScriptRun`: a
thrown network error and a `500` response from the project-config endpoint both reject the run
`429 spend_capped`; a clean `404` falls through past the gate exactly as before (never rejected
as `spend_capped`). `handleChannelHeartbeat`: a network error marks pending messages
`spend_capped` (not silently answered or dropped); a clean `404` leaves `spend_capped` at `0`;
and a matched no-code `run_script` rule under a project-config error is short-circuited to
`spend_capped` BEFORE the rule's script ever runs (`rule_handled: 0`), proving the fix covers
that execution path independently of the main reasoni
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi

### 99. Lenient Zod Adapters with Self-Healing Schema Repair

**Final behavior:** Wraps responses in lenient Zod schemas. If parsing fails due to third-party API changes, cheap edge models repair the field mapping dynamically.

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
     since half a PDF is corrupt rather than
- The Gap: When Stripe or an LLM provider updates their API (new required fields, changed response schemas), the platform's Worker code breaks silently. No contract tests exist to catch provider API changes before they reach production.
 Required Fix: Implement consumer-driven contract tests (Pact.js): Workers define expected request/response contracts for each external API call (Stripe PaymentIntent create, OpenAI chat completion, CF AI inference). Contract stubs run in CI instead of live APIs. On provider API change: contract test fails, alerting to necessary code update. Publish contracts to Pact Broker (self-hosted on CF Workers). Run contract verification weekly against provider sandbox
- - `workers/spaces/src/do/SpaceTypeRegistryDO.ts` — `SpaceTypeProductConfig` gains
  `modelConfig?: { model?: string }`, with an explicit comment distinguishing this from the dead
  `spacetypes.model_config` D1 column so a future session doesn't conflate the two or try to
  "restore" the column.
- `workers/spaces/src/builder-routes.ts` — new `ALLOWED_MODELS` curated allowlist
  (`claude-haiku-4-5-20251001`, `claude-sonnet-4-6`, `claude-opus-4-8`) — deliberately not
  arbitrary free text, for cost predictability and to keep the platform's own AI-Gateway routing
  table meaningful. The generic `PATCH /builder/products/:id` handler already shallow-merges any
  `product_config` object into `confi
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
