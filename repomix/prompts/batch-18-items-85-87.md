# AI Studio implementation prompt — batch 18, plan items 85–87

## Mission

Implement every requirement below end to end on the current accumulator branch. The cohesive focus
is **MCP-UI, safe widgets, and workflow classes**. This prompt is self-contained: the feature definitions and retained implementation
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


### 85. Bidirectional MCP-UI Real-Time Canvas Streaming

**Final behavior:** Canvas iframe actions (clicks, form submits, table edits) stream into the agent's observation loop over WebSockets in real time.

**Production acceptance contract:**
Production entry: `acceptCanvasEvent`; ws-gateway.
Persistence/deployment: authenticated WS session state.
Required observable verification: canvas security test rejects hostile origins/payloads.

**Retained implementation constraints:**
- The Gap naelao-together-ai settles the WalletDO credit reservation via ctx.waitUntil(walletDO.settle(reservationId, actualCredits)) after returning the streaming response. CF Workers guarantee that waitUntil() extends the worker lifetime, but this is not absolute: platform incidents, aggressive eviction, or timeout overruns can terminate the worker before the settlement resolves. If settlement never completes, the 300-second reservation sweep in WalletDO refunds the credits. The user received LLM inference for free. Under high-volume concurrent streaming this is an exploitable revenue leak: a client that opens thousands of simultaneous streams and aborts them immediately forces reservations
- 1. **Execution ceiling** (`projects.execution_ceiling`, 1-5) — caps which execution-ladder
   tier the bound agent may use. Enforced in `ScriptToolSurface` (`code-runner.ts`'s
   sibling, not it) at `script.create`, `script.update` (including retroactively, if an
   admin lowers the ceiling after scripts already exist), *and* `script.run` — for both
   prebuilt ops and stored scripts. A ceiling of 2 means "talk and look things up, never
   touch a container or browser." `ScriptEngineEnv.maxTier` is the plumbing; it's set per
   message in the heartbeat, not once per agent, since one heartbeat sweep can touch several
   projects with different ceilings.
2. **Daily spend cap** (`projects.daily
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
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
│

### 86. Generative In-Chat Dynamic UI Widgets

**Final behavior:** The model streams interactive UI components (date pickers, sliders, approval cards) directly into the message feed.

**Production acceptance contract:**
Production entry: `validateGeneratedWidget`.
Persistence/deployment: message event JSON only, never executable source.
Required observable verification: canvas security test rejects script/html/srcdoc fields.

**Retained implementation constraints:**
- Required Fix Implement in-chat approval using the SDK hook. In the operator shell: const {messages, addToolApprovalResponse} = useAgentChat({agent: "AssistantDO", name: spaceId}). Render approval cards inline in the message list: {messages.map(m => m.parts?.filter(p => p.type === "tool-approval").map(p => (<ApprovalCard key={p.id} toolName={p.toolName} args={p.args} onApprove={() => addToolApprovalResponse({id: p.id, approved: true})} onReject={() => addToolApprovalResponse({id: p.id, approved: false, data: {reason: "User rejected"}})} />)))}. Retain the email/push fallback for approvals where the user is not actively in the chat (implement the REST POST endpoint for those), but make in-chat
- **G4 — autonomy toggle reuses the ALREADY-BUILT `assistant_policy` gate (SpaceDO migration v14) —
no new gate engine.** Two things had to be gotten right that weren't obvious from the plan: (1) for
the Space Assistant specifically (no `projectId`), `AgentConfig.requiresApprovalFor` is completely
ignored by `NaelaoAgentDO.handleScriptRun` — the assistant's gate list comes exclusively from the
space's `assistant_policy` row, fetched fresh per run, so G1's profile does NOT set that field; (2)
`assistant_policy` has no provisioning-time seed anywhere in the codebase (the row is created
lazily via PATCH), so a fresh Launchpad space's assistant would default to `always_ask` with an
EMPTY `auto_app
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- ### 1. The Dynamic In-Chat Generative UI (Google Search AI Mode Style)
Instead of dumping a wall of markdown text or forcing users to fill out complex forms, the AI dynamically streams **interactive UI widgets directly inside the chat stream** whenever it needs structured input or wants to present decision-grade data:
```
                                  ┌──────────────────────────────────────────────┐
                                  │      DYNAMIC STREAMING IN-CHAT GENERATIVE UI │
                                  └──────────────────────┬───────────────────────┘
                                                         │
                         ┌───────────────────────────────┼───────────────────────────────┐
                         ▼                               ▼                               ▼
┌─────────────────────────────────┐             ┌─────────────────────────────────┐

### 87. 3-Class Workflow Taxonomy

**Final behavior:** Classifies workflows as: Class 1 (Company Automations), Class 2 (Vertical Extensions), or Class 3 (Ephemeral Tasks), establishing distinct escalation paths.

**Production acceptance contract:**
Production entry: `WORKFLOW_CLASS_POLICIES`.
Persistence/deployment: workflow records and billing attribution required.
Required observable verification: canvas/extension test validates every policy dimension.

**Retained implementation constraints:**
- 140. **A ~62-item batch of live-use asks was planned and phased; Phase 1 (bug sweep + chat
     fidelity) is BUILT and deployed. Three of the reported "missing features" turned out to be
     DEAD CSS waiting for a component, and writing the test for one bug exposed a second, worse
     one underneath it.** Full plan (all 6 phases, decisions, deferred items):
     `/root/.claude/plans/gleaming-scribbling-pelican.md`; the user's own answers set the
     sequencing (bug sweep first), the billing model (hybrid personal-plan + business-subscription),
     channel scoping (both scopes, kind-gated UI) and project automations (build on
     `scheduled_jobs`/`event_triggers`, don't fork a second eng
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
