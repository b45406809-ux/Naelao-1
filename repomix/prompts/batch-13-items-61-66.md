# AI Studio implementation prompt — batch 13, plan items 61–66

## Mission

Implement every requirement below end to end on the current accumulator branch. The cohesive focus
is **Task leases, spectators, intent/RFC governance, and alerts**. This prompt is self-contained: the feature definitions and retained implementation
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


### 61. Atomic Task Lease Protocol (`SpaceDO.tasks` CAS)

**Final behavior:** Single-writer task leases with 15-minute crash-proof TTLs. When an incident occurs, exactly one assistant claims it; siblings abort immediately.

**Production acceptance contract:**
Production entry: Authenticated router task routes → spaces worker → transactional SpaceDO claim/renew/complete transitions.
Persistence/deployment: Tenant/space/project-scoped task lease columns, append-only lease events, and DO alarms.
Required observable verification: `task-lease-governance.test.ts` covers winner selection, holder/version enforcement, expiry and history retention.

**Retained implementation constraints:**
- 126. **Three more live-reported bugs, all root-caused to the SAME underlying gap: the reasoner's
     "available_operations" field was a bare flat list of 60+ op names with no description or
     grouping — plus two silent trace-persistence holes that hid real repeat/parked tool calls
     from the activity table.**
     - **The real root cause of "our API doesn't support programmatic thread creation or direct
       in-thread chat messaging"** (item 125 shipped exactly that capability the same session).
       `project-coordination` WAS wired into the assistant's prebuilt list and `tools.
       availableOperations()` DID include `thread.create`/`thread.send_message` in the payload —

- Semantic Caching
 Enabled by default via cf-aig-cache-ttl: 3600 header. Caches LLM responses
 for semantically similar prompts — not just exact matches. Saves 40-80% of LLM costs for repetitive
 research/classification tasks. Cache is namespaced by spaceId so Space A's cache never pollutes Space B.
 Fallback Routing
 Configure in CF AI Gateway dashboard: Primary → Anthropic Claude Sonnet. Fallback 1 → Anthropic
 Claude Haiku. Fallback 2 → Workers AI (Llama-3.1-70B). Fallback triggers on: 429 rate limit, 503 service
 unavailable, timeout >30s. Users never see an error — they get a slightly different model. Log the fallback
 to Analytics Engine.
 Per-Space Rate Limiting
 Configure in CF A
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

### 62. Sibling Assistant Spectator & Review Mode

**Final behavior:** Non-claiming assistants observe active tasks, update user notification feeds, and offer to audit incoming PR diffs without duplicating code work.

**Production acceptance contract:**
Production entry: Authenticated task spectator listing and review-request routes; lease losers transition before work begins.
Persistence/deployment: SpaceDO `task_spectators` records are tenant/space/project/task/actor scoped and review requests are idempotent.
Required observable verification: `task-lease-governance.test.ts` proves loser transition and authorized review request behavior.

**Retained implementation constraints:**
- 97. **The agent loop is no longer capped at six steps — it now runs as long as the task honestly
    needs, bounded by real resources instead of an arbitrary count. Researched against OpenClaw
    first, then built both halves, because raising the cap alone would have made things worse.**
    - **The finding.** OpenClaw (deepwiki + its docs) has NO step cap: its loop runs until the model
      stops requesting tools, with *preflight compaction* against the model's token budget before
      every turn and automatic compaction-on-overflow as recovery. Ours was
      `for (step = 0; step < (opts.maxSteps ?? 6); step++)` and the interactive chat path never
      overrode that six — so every mess
- Default count
 1 per user per Space. Space admin can raise this limit in Space Settings → Assistants → Max per
 user. Maximum 5 per user per Space.
 Container model
 On-demand CF Container (standard-1: ½ vCPU, 4 GiB RAM). Starts only when a task needs Linux
 execution. Default idle timeout: 30 minutes. Warm on wakeup from heartbeat: <3s.
 R2 filesystem path
 spaces/{spaceId}/assistants/{userId}/ mounted at /data/assistant when container starts. Contains: memory.json (deprecated, replaced by DO
 SQLite), skills/, cron-jobs.json, channel-configs/, dynamic-tools/
 Heartbeat frequency
 Every 5 minutes via naelao-sweeper cron trigger. Checks: cron-jobs.json, sub-agent status, pending
 chan
- - **Entry gate** (`NaelaoAgentDO.handleScriptRun`): a project-scoped run that acts on behalf of a
  user (non-empty `userId`, excluding the channel drain's synthetic `channel:...` ids, which never
  route through here anyway) resolves the clamp via a new `fetchAssistantAccess` (internal HMAC
  call to the existing spaces-worker endpoint) BEFORE any billing gate. `null` effective role
  (`assistant_mode='none'`, or a plain non-member) → 403 `assistant_access_denied`; lookup error →
  403 `assistant_access_unverified` (fail CLOSED — the fetchProjectConfig/F17 posture: an
  authorization check that fails open isn't one). No acting user (cron/trigger/webhook/bootstrap
  wakes) → no clamp, the as
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi

### 63. Semantic Intent Deduplication Gate

**Final behavior:** Embeds incoming prompts and checks active tasks for >0.85 cosine similarity, preventing two users from ordering the same feature twice.

**Production acceptance contract:**
Production entry: Governed task creation queries the tenant/space/project-prefiltered active task corpus before a task can be claimed.
Persistence/deployment: Validated intent vectors are durable on SpaceDO tasks; similar work links the caller as spectator.
Required observable verification: `task-lease-governance.test.ts` proves >0.85 dedupe and that no duplicate task becomes executable.

**Retained implementation constraints:**
- 112. **A repeatable capability benchmark — 6 test cases, trace-graded — is BUILT and validated
     against production; the model matrix itself is blocked on a Cloudflare quota window, not on
     code.** Grounded in published work rather than invented: `Claw-SWE-Bench` (arXiv 2606.12344)
     holds the model fixed and swings Pass@1 from **19.1% to 73.4% on adapter design alone**, and
     reports harness choice worth 27.4pp against model choice's 29.4pp; `WildClawBench` runs the
     same 60 tasks under OpenClaw / Claude Code / Codex CLI / Hermes and sees the same effect
     (GPT-5.4: 56.8% on Codex, 50.3% on OpenClaw). So a generic leaderboard measures the wrong
     quantity — what decid
- Required Fix: Implement PresenceDO: shared DO tracking active_sessions per Space. On WebSocket connect: SpaceDO broadcasts presence_update { online_count, typing_users: [] }. "Is typing" indicator: client sends typing_start / typing_stop WebSocket events when user is composing a message (debounce: stop event 3s after last keystroke). SpaceDO broadcasts to other sessions in same room (if multi-user room feature enabled). Online count displayed in Space header (optional, builder-configurable). High-traffic Spaces (>1000 concurrent): aggregate presence updates to max 1/second to avoid broadcast storm. Track peak_concurrent_users per Space in Analytics Engine.
- **Project deduplication** (`SpaceDO.createProject`). Exact-name idempotency already existed
(`ON CONFLICT(space_id, name) DO NOTHING`); this adds a *semantic* heads-up: before inserting a
genuinely new project, its name is compared against every existing active project via
token-Jaccard similarity (`nameSimilarity`/`findPossibleDuplicateProjects`, `@naelao/events`;
threshold 0.5, chosen to favor recall — a false-positive heads-up costs nothing, a missed real
duplicate is the thing this exists to catch). This is deliberately **not** embeddings/Vectorize
— that's reserved for `script.find`'s retrieval, not a synchronous check on every project
creation. Matches are returned in the create respon
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi

### 64. Sponsor Alignment Gate (RFC Trigger)

**Final behavior:** Contradictory architectural directives from different human owners freeze execution and surface an RFC card in Team Room before code is touched.

**Production acceptance contract:**
Production entry: Task creation detects same-scope high-similarity directives from different sponsors and emits the Team Room RFC event before leasing.
Persistence/deployment: Durable `task_rfcs` plus both tasks in `RFC_FROZEN`, retaining directives, sponsors, scope and resolution authority.
Required observable verification: `task-lease-governance.test.ts` proves conflicting work cannot be claimed.

**Retained implementation constraints:**
- 58. **Whop added as a second PLATFORM billing provider (AUDIT_TODO.md AI-7), replacing Lemon
    Squeezy as the FIRST-TRIED provider for builder platform plans and end-user subscriptions/
    credit-packs — LS stays as the fallback, item 45 is not reverted.** Trigger: the operator
    couldn't activate a Lemon Squeezy store because LS's own onboarding requires a Stripe-linked
    payout path unavailable in their country. Two genuinely different Whop relationships were
    built, neither the same as the invite-gated Platforms API (items 50-51, business-wallet
    sub-merchants) or the read-only "Connect with Whop" OAuth connector (item 53):
    - **Platform-plan checkout** (`packages/billing-
- Required Fix (suggested sequencing, not a hard requirement): G-BG09/G-BG10 (code index + real git checkout) first — nothing else in this the established specification trustworthy without them. Then G-BG01/G-BG03 (agent scaffolding + structured spec handoff) with a HUMAN standing in for the PM agent's feedback-mining step initially — prove the Dev/QA/Security loop end-to-end on human-authored specs before trusting G-BG02's automated feedback mining. Then G-BG04/G-BG05/G-BG11 (blast radius, deploy gate, SAST) together, since a deploy gate without a real regression signal or a security check is theater. G-BG02 (automated feedback mining), G-BG07/G-BG08 (Control Room), and G-BG13 (self-heal fast lane) follow once
- **J3 — the workflow IS a stored script, not a second store.** `dynamic-workflow`'s
`workflow.create(name, code)` op (previously always "not available" — `buildOrchestrationHooks`
never set the workflow hooks at all) now just calls `ScriptToolSurface.create()` with
`metadata.runtime: "workflow"` — the SAME skill library `script.create` already writes to.
`workflow.run(name, params)` is literally `tools.run(name, params)`; because the script is tagged
`runtime:"workflow"`, `execution-ladder.ts` routes that particular `script.run` call to
`ScriptRunWorkflow` regardless of who invoked it (the dynamic-workflow prebuilt, a trigger fire, or
a scheduled job) — one routing decision, not three call si
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi

### 65. 2-Round Deliberation Horizon

**Final behavior:** Limits autonomous agent debate to 2 rounds. If consensus is not reached, transitions to `BLOCKED_AWAITING_HUMAN`, halting runaway loops.

**Production acceptance contract:**
Production entry: Authenticated `/deliberate` transition on frozen project tasks.
Persistence/deployment: SpaceDO persists `deliberation_round`; the second unresolved round transitions exactly once to `BLOCKED_AWAITING_HUMAN`.
Required observable verification: `task-lease-governance.test.ts` covers rounds one and two plus fail-closed missing-owner behavior.

**Retained implementation constraints:**
- 103. **Self-directed loop stopping (real-time progress visibility), a real project-thread/session
     conflation bug fixed, and automatic request-retry-with-visible-feedback — three
     user-reported items, all BUILT.**
     - **The loop previously told the model it was almost out of budget only via `final_step`, on
       the very last possible turn — it had NO visibility into its own progress before that.** A
       model that kept failing had no way to notice and stop itself; the only way a run ever ended
       early was being cut off externally with a generic, unhelpful message. New
       `Reasoner.decide()` `progress` field (`script-engine/loop.ts`) — step / max_steps (the
       ru
- The Gap: Free-plan limits exist for storage/sessions/tokens, but an autonomous business (agents doing outreach, building sites, running scheduled jobs) can burn spend in ways those static quotas do not shape — and the free program's economics depend on a hard ceiling.
- **Config surfaces — all three backend fields already existed on `SpaceTypeProductConfig`
(`membershipModel`, `allowedChildSpaceTypes`, `userPermissions`) except one new one.** The
Configuration tab gained: a Product Mode picker (team/tenant/hybrid, with `allowPublicSignup` +
`allowedChildSpaceTypes` shown only for tenant/hybrid), a Limits section (`userPermissions`:
max threads/user, max credits/month, can-create-sub-spaces, can-create-projects), and a Templates
Catalog (checkboxes over the same hardcoded `LAUNCHPAD_TEMPLATES` list `apps/shell`'s create-
business dialog already uses — same "no builder-reachable `/templates` route yet" simplification,
applied consistently in both places). The
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi

### 66. Single On-Call Alert Routing

**Final behavior:** Project failures alert only the designated project lead's assistant rather than broadcasting to all team members, eliminating bystander effects.

**Production acceptance contract:**
Production entry: Admin-controlled alert-owner route and targeted `task.blocked_awaiting_human` SpaceDO broadcast.
Persistence/deployment: One `project_alert_owners` row per project; transition fails closed with 503 if none exists.
Required observable verification: `task-lease-governance.test.ts` proves no-owner refusal and exactly one designated recipient. Other failure domains remain independently release-gated.

**Retained implementation constraints:**
- 112. **A repeatable capability benchmark — 6 test cases, trace-graded — is BUILT and validated
     against production; the model matrix itself is blocked on a Cloudflare quota window, not on
     code.** Grounded in published work rather than invented: `Claw-SWE-Bench` (arXiv 2606.12344)
     holds the model fixed and swings Pass@1 from **19.1% to 73.4% on adapter design alone**, and
     reports harness choice worth 27.4pp against model choice's 29.4pp; `WildClawBench` runs the
     same 60 tasks under OpenClaw / Claude Code / Codex CLI / Hermes and sees the same effect
     (GPT-5.4: 56.8% on Codex, 50.3% on OpenClaw). So a generic leaderboard measures the wrong
     quantity — what decid
- Required Fix Implement a tiered read pattern for high-read-rate data: (1) Agent definitions, Space config, and knowledge article metadata are read-only after creation (or version-stamped). Cache these in KV with a 60-second TTL: kv.put(`space:${id}:agents`, JSON.stringify(agents), {expirationTtl: 60}). All Workers read from KV cache first; only on cache miss do they fall through to SpaceDO. (2) For rapidly-changing data (conversation messages, live usage counts): continue routing through SpaceDO but add a request coalescing layer: multiple concurrent requests for the same data are deduplicated to a single DO call. (3) For analytics data: route to Analytics Engine (already done in spec) rathe
- **Backend — `requireBusinessMembership` (new `workers/spaces/src/business-auth.ts`).** The
routes the shell's Projects/Threads views need (`/spaces/:id/projects*`, `/spaces/:id/threads*`,
`/spaces/:id/agent-definitions*`, `/spaces/:id/presence`) were previously builder-only, gated
ONLY by `requireInternalHmac` — which passes for a `product_end_user` caller exactly the same as
a builder, since `proxyTo` mints the internal token off any verified claims, role included. What
was missing was a FLOOR on what a `product_end_user` may do once past that gate (nothing checked
`role` at all). `requireBusinessMembership(methodMinRole)` is **additive-only**: a
non-`product_end_user` caller always passes
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
