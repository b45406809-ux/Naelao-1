# AI Studio implementation prompt — batch 21, plan items 39–40

## Mission

Implement every requirement below end to end on the current accumulator branch. The cohesive focus
is **Plan items 39–40**. This prompt is self-contained: the feature definitions and retained implementation
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


### 39. Universal Agent Execution Kernel (`NaelaoAgentDO`)

**Final behavior:** Single unified REPL execution kernel powering all agent roles across the platform, maintaining state and memory inside an isolated Durable Object.

**Production acceptance contract:**
Production entry: `NaelaoAgentDO.handleScriptRun`/loop.
Persistence/deployment: per-thread DO SQLite + R2 config; `NAELAO_AGENT_DO`.
Required observable verification: durable-default/archetype tests assert no alternate role loop.

**Retained implementation constraints:**
- The Gap The spec loads skills by reading R2 objects for all three tiers (Platform, Space, Personal) on each agent turn to compose the system prompt. A single turn may load 10-30 skill files across three R2 prefixes. With R2 read latency of 20-40ms per object and no within-session cache, a turn that activates 5 skills incurs 100-200ms of R2 read overhead on top of LLM latency. Skills rarely change during an active session (they change between sessions when a user edits them). An in-memory cache keyed by skill version avoids redundant R2 reads within the same DO activation.
- 1. **Agents are their own Durable Object.** `NaelaoAgentDO` (original spec §G-D01–G-D20) is
   the agent runtime: ReAct loop, FSM, tool dispatch, 30 s timeout watchdog, SQLite-
   persisted run state. The agent loop lives here — **not** inside a per-product/per-niche
   DO. Addressed as `space:project:thread`.
2. **`SpaceDO` owns product structure.** Threads, messages, members, sub-space grants,
   billing, and **`agent_definitions`** live in `SpaceDO` SQLite. SpaceType differences live
   in config / agent definitions / manifests — **never in DB tables**.
3. **A project is a grouping of threads within a space.** Not a sub-space, not a workspace.
   Addressing is `space:project:thread`; `thr
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- #### How the DO Executes the Unified Config:
```typescript
// Inside NaelaoAgentDO.ts (Building the Universal Prompt & Toolset)
function assembleUniversalAgent(manifest: UniversalAgentManifest, businessContext: BusinessContext) {
  // 1. Assemble 4-Layer Dynamic System Prompt
  const systemPrompt = [
    // Layer 1: Universal Engine Kernel
    BASE_CLAUDE_CODE_REPL_RULES,
    // Layer 2: Live Business Identity
    renderBusinessBrief(businessContext),
    // Layer 3: Archetype Role
    manifest.prompts.systemPrompt,
    // Layer 4: User/Founder Custom Instructions
    manifest.prompts.userCustomInstructions ? `\n# FOUNDER CUSTOM DIRECTIVES\n${manifest.prompts.userCustomInstructions}` : ""
  ].join("\n\n");
  // 2. Hardware-Level Tool Stripping (Physical Firewall)
  const sanitizedTools = sanitizePrebuiltListForRole(
    manifest.role,
    manifest.capabilities.enabledPrebuilts
  );
  //

### 40. Dynamic 4-Layer System Prompt Assembly

**Final behavior:** Assembles prompts dynamically from 4 immutable layers: Universal Kernel $\rightarrow$ Business Context $\rightarrow$ Agent `SOUL.md` $\rightarrow$ Founder Directives.

**Production acceptance contract:**
Production entry: agent config loader/reasoner prompt assembly.
Persistence/deployment: immutable/versioned config files in R2.
Required observable verification: conversation-context tests verify order and replacement behavior.

**Retained implementation constraints:**
- 1. **Schedule-type triggers → a real `scheduled_jobs` row, with a new goal-based dispatch
   mode.** `scheduled_jobs` (0041/0042) only supported firing a named prebuilt script op
   DIRECTLY (`fireScriptDirectly`/`handleTriggerFire` — no reasoner, no OBSERVE/FIND/GATE loop,
   by deliberate design, identical posture to `event_triggers`). That's fine for "run this exact
   script on a timer," but "draft this week's marketing content" needs judgment, not a
   deterministic tool call — the dispatcher itself has no reasoning mode. Migration `0043`
   (`infra/migrations/0043_scheduled_jobs_agent_goal.sql`) adds two nullable columns:
   `agent_id` (which agent's own R2 config — system prompt, `req
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- ### 1. The 4-Layer Universal Prompt Hierarchy
To make any agent configurable without breaking the underlying Claude Code tool-calling discipline, the system prompt is assembled dynamically from 4 distinct layers:
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. UNIVERSAL OPERATING KERNEL (Immutable Engine Directives)                 │
│    • Universal Claude Code rules: Use `Edit` for AST search & replace.     │
│    • Never rewrite full files. Line-numbered `Read` with offset/limit.      │
│    • In-flight `compact_context` on milestone completion. Exit-0 squashing. │
├─────────────────────────────────────────────────────────────────────────────┤
│ 2. BUSINESS CONTEXT (Living Enterprise Identity)                            │
│    • Name, offering, pricing tiers, and setup status:                       │
│      "You are operating for 'LexPulse Lega
- ### Tier 3: On-Demand Stateful Micro-Apps ("Cloudflare OS Gadgets")
* **What it is:** A full-stack, living micro-application (built from a prompt in 30 seconds) that holds **its own private database and business logic**.
* **Storage & Execution:**
  * **Frontend:** Sandboxed in a null-origin `<iframe>` that communicates with the server via **Cap'n Web RPC / MCP-UI**.
  * **Backend & Database:** Runs inside a **Dynamic Worker isolate** backed by an isolated **Durable Object Facet SQLite database**.
  * **Self-Exposing API:** Automatically gets an **MCP v2 `/mcp` endpoint**, allowing AI agents to read, query, or automate the gadget natively!

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
