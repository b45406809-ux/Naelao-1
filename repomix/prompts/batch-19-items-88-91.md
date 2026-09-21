# AI Studio implementation prompt — batch 19, plan items 88–91

## Mission

Implement every requirement below end to end on the current accumulator branch. The cohesive focus
is **Asymmetric subagents and durable workflow harness**. This prompt is self-contained: the feature definitions and retained implementation
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


### 88. Asymmetric Subagent Topology (Verbs vs. Nouns)

**Final behavior:** Subagents are ephemeral execution functions ("verbs") inside workflows; only Parent Agents are persistent entities ("nouns") managing threads and UI.

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
     `scheduled_jobs`/`event_triggers`, don't fork a second eng
- // LaunchpadMiniAGIConfig — only activated in autonomous mode
interface LaunchpadMiniAGIConfig {
 enabled: boolean;
 goalStatement: string; // the high-level goal
 planningHorizon: &#x27;1d&#x27; | &#x27;7d&#x27; | &#x27;30d&#x27;; // how far ahead to plan
 maxSubAgents: number; // parallel execution limit
 autonomousSpend: number; // monthly budget agent can spend alone
 approvalThreshold: number; // single action approval threshold
 prohibitedActions: string[]; // e.g. [&#x27;delete_product&#x27;, &#x27;cancel_subscription&#x27;]
 // Actions the agent can NEVER take regardless of goal — hard-coded safety fence
}
- **Thread hierarchy — sub-agents and channel sessions are subthreads, not a new concept.**
SpaceDO's `threads` table (migration v8) existed but had no CRUD at all until this pass — it's
now real: `POST/GET /threads`, scoped by `space_id`/`project_id`. Migration v13 adds
`parent_thread_id`, `thread_kind` (`primary`/`sub_agent`/`channel`), and `channel`/
`channel_session_id` columns. A sub-agent spawn (`NaelaoAgentDO.spawnSubAgentBatch`) and a new
channel session (`handleChannelInbound`, first sight of a `(channel, channel_user_id)` pair
only) both call a new `mirrorThread()` helper that POSTs to SpaceDO — best-effort, the DO's own
`sub_agents`/`channel_sessions` tables remain the source of tru
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi

### 89. Slimmed-Down `SubagentContext`

**Final behavior:** Strips thread creation, WebSocket handles, and session bloat, exposing only `ai`, `fs`, `cli`, `vault`, and `step` to guarantee step serialization.

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

- The Gap: FCM and APNs do not guarantee delivery order for rapid notification sequences. A "payment processing" notification may arrive after "payment confirmed", confusing users. Critical transactional sequences (payment status, Space status changes) require ordered delivery. No sequence number or ordering mechanism exists.
 Required Fix: Add sequence numbers to all notifications: NotificationDO maintains a per-builder monotonic sequence counter. Each notification includes seq: number . Client SDK buffers received notifications and reorders by seq before displaying. For critical transactional sequences: use email (SMTP guarantees ordering via message threading) instead of push. FCM/APNs pus
- **UI verification: found and worked around a real pre-existing dashboard-wide bug, not
introduced by this phase.** No browser-automation package (playwright/puppeteer) exists anywhere
in this repo, so verification used raw Chrome DevTools Protocol (Node's built-in `WebSocket`,
`/opt/pw-browsers`'s prebuilt Chromium) driven by hand. That process surfaced a real bug in
`apps/dashboard/src/lib/auth-provider.tsx`: on a hard reload of ANY nested `/dashboard/*` route
(not just this one — reproduced identically on the pre-existing `/dashboard/clients`), a race
between `DashboardLayout`'s auth-guard effect and `AuthProvider`'s own localStorage-hydration
effect bounces the user through `/login` and b
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi

### 90. Repomix-Style Chunked Subagent Workflow with Branch Accumulator

**Final behavior:** Two-pass workflow: generates compressed repo map $\rightarrow$ selects files $\rightarrow$ implements atomic chunk $\rightarrow$ commits. Branch accumulator tracks new files automatically.

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
- The Gap: Space configurations (agents, tools, KB manifests, ThemeConfig) are managed only via the Naelao dashboard or API. No GitOps workflow exists to version Space config in git, review changes via PR, and automatically deploy on merge. Enterprise builders who manage infrastructure-as-code are blocked from adopting Naelao.
 Required Fix: Build Naelao GitHub App: installs on builder's GitHub org. Builder maps a repository to a Space: .naelao/space.config.json defines all Space configuration. On merge to main branch: GitHub App webhook triggers naelao deploy GitHub Action. Action calls POST /spaces/{id}/deploy with config JSON payload. Naelao applies config, runs smoke test (G-AQ06), return
- - `NaelaoAgentDO.settleRunBilling`: a new `NaelaoAgentDO.infraResourceTypeForTier(tier)` maps
  `ExecutionTier` 2-4 → `"isolate"`, 5 → `"container"` (Tier 1, in-process R2, is excluded — not a
  distinct CF resource, and `duration_ms` is always 0 there anyway). The infra-credit computation
  and recording now happens **before** the function's pre-existing `if (!tokensUsed) return;`
  early-out, not after — a pure script execution with zero LLM tokens (e.g. a scheduled
  `workflow.run` with no reasoning step) still consumes real isolate/container time and must not
  silently go unmetered just because it made no LLM call. Recorded via the same `/billing/usage`
  POST mechanism (`event_type: "i
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi

### 91. Cloudflare Workflows Harness Pattern

**Final behavior:** The AI writes pure business logic (`execute(step, ctx)`); the platform compiler automatically wraps it in `WorkflowEntrypoint<Env>`.

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
- The Gap The naelao-workflows worker loads user workflow code from R2 (const code = await codeObj.text()) then calls env.DISPATCH_NAMESPACE.get(spaceId + '-' + workflowId) to dispatch it. dispatchNamespace.get(name) retrieves a pre-deployed script by its registered script name — it does not accept or execute code dynamically. The script named spaceId + '-' + workflowId does not exist in the dispatch namespace unless it was previously uploaded via the Cloudflare Workers for Platforms Upload API. The prompt acknowledges eval() and dynamic import() are prohibited but never includes the required upload step. Every workflow dispatch call throws "Worker not found" at runtime. The prompt stores code
- - `NaelaoAgentDO.settleRunBilling`: a new `NaelaoAgentDO.infraResourceTypeForTier(tier)` maps
  `ExecutionTier` 2-4 → `"isolate"`, 5 → `"container"` (Tier 1, in-process R2, is excluded — not a
  distinct CF resource, and `duration_ms` is always 0 there anyway). The infra-credit computation
  and recording now happens **before** the function's pre-existing `if (!tokensUsed) return;`
  early-out, not after — a pure script execution with zero LLM tokens (e.g. a scheduled
  `workflow.run` with no reasoning step) still consumes real isolate/container time and must not
  silently go unmetered just because it made no LLM call. Recorded via the same `/billing/usage`
  POST mechanism (`event_type: "i
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
