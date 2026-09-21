# AI Studio implementation prompt — batch 14, plan items 67–70

## Mission

Implement every requirement below end to end on the current accumulator branch. The cohesive focus
is **Provenance, model races, presence, and invoker actors**. This prompt is self-contained: the feature definitions and retained implementation
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


### 67. Immutable Cryptographic Provenance Ledger (`provenance_ledger`)

**Final behavior:** 4-point audit trail linking Human Trigger $\rightarrow$ Assistant Actor $\rightarrow$ Project Executor $\rightarrow$ Git Commit Hash for SOC2/HIPAA compliance.

**Production acceptance contract:**
Production entry: Router → spaces worker → project-authorized SpaceDO `/provenance` append/list/verify routes.
Persistence/deployment: Tenant/space/project-scoped append-only DO tables and rotated `PROVENANCE_SIGNING_KEY`; global D1 mirror retains no-update/no-delete triggers.
Required observable verification: `provenance-chain.test.ts` proves chaining, tamper detection, unavailable signer denial and absence of update/delete routes; complete side-effect coverage remains release-blocking.

**Retained implementation constraints:**
- // Space type: Verticals | Execution: Supervised (human checkpoint on every action)
const legalAI: Partial<NaelaoProduct> = {
 name: 'LexSpace', authProvider: 'saml-sso',
 allowPublicSignup: false, allowedEmailDomains: ['acmefirm.com'],
 pricingConfig: { type: 'seats', pricePerSeat: 15000, trialDays: 0, currency: 'USD' },
 adminFeatures: {
 conversationLogAccess: true, // ENABLED — explicit partner consent obtained, compliance requirement
 auditLogAccess: true, userManagement: true, knowledgeBaseManagement: true,
 },
 featureFlags: { 'matter-management': true, 'immutable-audit-trail': true, 'citation-verification': true },
};
// End-user UX: Matter dashboard, document workspace, research sid
- **Credit ledger is a LEDGER, not a second conversion source.** `credit_ledger`'s balance is the
SUM of its deltas; `deduct` fails CLOSED on an over-draw (402, balance unchanged), matching the
`fetchAssistantPolicy`/`project_spend` fail-closed precedent. Crucially, `deduct` accepts
ALREADY-CONVERTED credits — the agent runtime owns `tokensToCredits()` (billing-core's single
token→credit conversion point, #12), converts there, and passes credits here. The DO never
re-derives the rate, so there's no split-brain with billing-core. (This is also why the spaces
worker did NOT need to add a `@naelao/billing-core` dependency.) `/export` is the GDPR Art. 20
data-portability dump (mirrors the SpaceDO
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- Apply this delta after each item's complete Origin & Transition trail. If it conflicts with an earlier plan statement, this file wins. If it is silent, retain the earlier final decision. All authorization, tenant isolation, fail-closed policy, provenance, billing, deployment parity, and realistic end-to-end verification requirements remain in force.

### 68. Multi-Branch Parallel Model Benchmarking Races

**Final behavior:** Forks 3 branches for 3 models in parallel, evaluates test assertions, and automatically merges the winning benchmarked code.

**Production acceptance contract:**
Production entry: model benchmark helper; RepositoryDO forks.
Persistence/deployment: branch refs and billing metrics.
Required observable verification: model benchmark tests do not prove winner-only merge.

**Retained implementation constraints:**
- This agent can: read and write files, search the web, execute code, author workflows that run on a schedule, spawn sub-agents for parallel work, and send notifications. The R2 workspace is the primary persistent environment. The execution ladder routes each script to the appropriate tier automatically.
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
- ### Summary of What This Adds to the Platform
| Feature | How It Works with Cloudflare Artifacts |
| :--- | :--- |
| **Upstream Staleness Tracking** | Real-time `commitsBehind` badges across all scratchpads and task threads. |
| **Smart Agent Rebase** | Agents inspect upstream diffs before pulling, auto-rebasing non-overlapping files. |
| **Turn-by-Turn Time Machine** | 1-click rollback to any historical agent turn via instant Git commit resets. |
| **Reasoning-Aware `git-blame`** | Agents read historical commit reasoning to understand why past code was written. |
| **Multi-Model Branch Races** | Fork 3 branches for 3 models in parallel; merge the winning benchmarked code. |
| **AST-Aware Merge Resolver** | AI resolves Git merge conflicts automatically by understanding code syntax. |

### 69. Real-Time Multiplayer Presence via `WsHubDO`

**Final behavior:** WebSockets broadcast active file editing presence, cursor positions, and AST mutations to all connected clients in real time.

**Production acceptance contract:**
Production entry: ws-gateway WsHubDO and SpaceDO `/presence`.
Persistence/deployment: hibernating sockets plus presence rows.
Required observable verification: WebSocket tests cover transport; reconnect/crash journey remains.

**Retained implementation constraints:**
- Spec §05 (byte ~116k): *"One assistant per user per Space by default. Admin can raise
this limit."* The **company state is shared** and space-level — `SpaceDO` (members,
structure, billing) + `ProjectDO` workspaces (file **locks**, **version history**,
**real-time presence**, byte ~399k/§12) + threads + KB. Each user's assistant
(`assistants/{userId}/`, byte ~411k) is a personal chief-of-staff acting **on** that
shared company — it is **not** a private fork of the company. Two members' assistants do
not build two companies because they read/write the *same* `ProjectDO`. Coordination =
file locks + presence + **project deduplication** (admin's assistant broadcasts "this
already exists"). This
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- ### 3. Real-Time Multiplayer Awareness (WebSockets over `WsHubDO`)
When Alice's agent edits a component, your **WebSocket Gateway (`WsHubDO`)** broadcasts a live presence event to all connected teammates:
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 👥 LIVE MULTIPLAYER WORKSPACE CANVAS                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│ 📁 src/components/                                                          │
│   ├── 📄 Header.astro  [ 👩‍💻 Alice's Agent Editing... (Locked) ]              │
│   ├── 📄 Footer.astro  [ 👨‍💻 Bob's Agent Editing... (Locked) ]                │
│   └── 📄 Button.astro  [ Available ]                                        │
└─────────────────────────────────────────────────────────────────────────────┘
```
* **Live AST Diff Updates:** While Alic
- #### Direct Implementation Recommendation for Cloudflare Edge Runtime
Implement the project virtual filesystem inside a single **Cloudflare Durable Object** (`SpaceDO`) to ensure all file writes are serialized through a single-threaded SQLite event loop [1.3.17]. Utilize **Cloudflare WebSocket Hibernation (`WsHubDO`)** to broadcast file mutation events (`presence.file_editing`, `workspace.file_changed`) across all connected clients in real time [1.3.17]. Lock acquisition is managed via `ConcurrencyDO` with automatic 30-second TTL expirations [1.3.17].

### 70. Invoker-Attested Split-Actor Model

**Final behavior:** Private scratchpads spawn personal actor instances with private memory; public channels spawn canonical actors with shared memory.

**Production acceptance contract:**
Production entry: assistant access and NaelaoAgentDO addressing.
Persistence/deployment: separate actor DO state.
Required observable verification: scratchpad helper tests are not actor-chain isolation tests.

**Retained implementation constraints:**
- 141. **The six items item 140 explicitly left open are now BUILT — Phase 1 of the 62-item batch is
     complete.** `thread.create` (the assistant's own `project-coordination` prebuilt) minted a
     `threads` row with no `session_id` — the exact bug behind "Session not found" on any
     assistant-created thread. It now also mints and links a real session (generating the thread's
     own id client-side so the link can point at it, then `POST /sessions {thread_id}`), matching
     the shape a human's own "New thread" already produces; degrades to returning the bare thread
     (still real, still usable via a later open) rather than throwing if the session-link call
     itself fails. The SA
- The Gap
 AssistantDO Channel Messages — No Per-Channel Access Control; Metadata Leakage Across Channels The AssistantDO stores channel messages in a unified `messages` table with a `channel_meta` JSON field containing `{ channelId, authorId, authorName }`. There is no per-channel access control on message retrieval. If a human handler calls `getMessages(sessionId, limit: 100)`, the method returns all messages in that session across all channels without checking whether the requesting user has access to all those channels. For a Space Assistant connected to both Slack (public) and Discord (private) channels, a user querying the assistant's memory could technically see messages from channels
- The canonical spec gained **the established specification — Growth Layer** (G-BF01..G-BF20, appended at the end of
`naelao_expanded_gaps_resolved.html` per its running-log convention; `docs/SPEC_HEADER_INDEX.md`
regenerated). It codifies the **universal-tools doctrine** (G-BF01, generalizing the web-search
fix): a universal capability is PLATFORM-KEYED — Naelao holds ONE provider key as a Workers
Secret, users never see or enter it (the Claude/ChatGPT bundled-connector model); BYO credentials
are reserved for a builder's OWN external accounts. It also specs business idea discovery
(App Store trends + Starter Story case studies as seeded skills), the free-plan simple-business
program (flagship `freelance-web-s
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
