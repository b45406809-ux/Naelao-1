# AI Studio implementation prompt — batch 08, plan items 39–46

## Mission

Implement every requirement below end to end on the current accumulator branch. The cohesive focus
is **Universal kernel, role firewall, goals, memory, and compaction**. This prompt is self-contained: the feature definitions and retained implementation
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

### 41. Hardware-Enforced Role Firewalls (`AgentFirewall`)

**Final behavior:** Physically strips disallowed tools from the prompt schema based on declared functional role, preventing customer-facing bots from accessing shells or filesystems.

**Production acceptance contract:**
Production entry: profiles/reserved capabilities/ScriptToolSurface.
Persistence/deployment: role policy in agent config; no client binding authority.
Required observable verification: role-ceiling tests inspect schema and reject direct forbidden runs.

**Retained implementation constraints:**
- The Gap All tools installed in a space are accessible to any agent running in that space. A builder's customer-support agent (which should only be able to query the knowledge base and create tickets) has no restriction preventing it from calling charge_card, send_email, or read_credentials tools. There is no tool allowlist/blocklist per agent role, no per-tool permission level, and no builder-visible tool access policy. Prompt injection or a misconfigured agent instruction can escalate to calling high-privilege tools.
- **Memory OS Layer 4 (Fabric) + Layer 6 (LLM Wiki) — the last two of the spec's 6 layers.**
Schema matches the spec's `fabric_store`/`wiki_store` (byte ~148161), scoped by `user_id` like
every other layer here (the spec's AssistantDO is single-tenant per DO; ours shares one DO's
SQLite in shared-assistant mode). `MemoryStore` gained `recordFabric`/`recallFabric`/
`briefFabric` (Fabric — cross-session summary consolidation, `fabric_recall`/`fabric_brief`
tools per spec) and `upsertWikiConcept`/`lookupWikiConcept`/`searchWiki` (Wiki — auto-curated
concept vault). Exposed to the agent as two new self-managed prebuilts, **`fabric`** and
**`wiki`** (same Hermes pattern as `memory`), in every defau
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- ### Summary of What This Achieves
1. **Zero Fragmentation:** You maintain **one single codebase** for all agents. The same `NaelaoAgentDO` powers the autonomous CEO, the developer coding an Astro site, the 24/7 WhatsApp support bot, and the user's custom legal auditor.
2. **Infinite Customizability:** Users and templates can tweak instructions, prompts, tools, and autonomy levels freely without ever touching backend code.
3. **Hardened Security by Construction:** A user or template can never accidentally give a customer support bot terminal access, because the `AgentFirewall` physically strips the tools based on the manifest's declared role.

### 42. Dual-Tier Planner-Worker Asymmetry Engine (`/goal`)

**Final behavior:** Frontier Planner (Claude 3.7 / o3) plans a clean Task DAG in SQLite; cheap Edge Workers (Llama 3.3 70B) execute subtasks in isolated 2,000-token contexts.

**Production acceptance contract:**
Production entry: plan prebuilt, TaskDO/sub-agent orchestration.
Persistence/deployment: tasks/sub_agents tables and per-worker token budget.
Required observable verification: plan/sub-agent tests cover cycle rejection, dependency order and 2,000-token bounds.

**Retained implementation constraints:**
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
- **Sub-agents — real spawn/receive/terminate.** `NaelaoAgentDO.buildOrchestrationHooks()`
implements the `OrchestrationHooks` the `sub-agent` prebuilt already called (previously always
"unavailable" — no host had wired them). `agent.spawn` accepts a **batch** of tasks
(`{ tasks: [{goal, budget_tokens?, model?}, ...] }`) and spawns them **concurrently** via
`Promise.all` against sibling `NaelaoAgentDO` instances (`idFromName(`sub:{spaceId}:{subId}`)`)
— see A1.12 for why batching is the chosen shape for parallelism here. Each child gets its own
budget (`budget_tokens` → real per-token enforcement in the loop itself as of A1.14, backstopped
by a coarse step ceiling via `budgetToMaxSteps`; never
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- ### Summary
1. **Planner Context Stays Pristine:** The Frontier model (Claude 3.7) only plans the DAG and audits the final diff. It never touches raw build logs or terminal clutter.
2. **Workers Stay Laser-Focused:** Open Edge models (`Llama 3.3 70B` on Cloudflare Workers AI) execute isolated subtasks with small, clean 2k-token code snippets.
3. **Universal Triggers:**
   * **In Chat:** Type `/goal <prompt>` or `@agent /goal <prompt>`.
   * **In Assistant:** Wakes up, evaluates goal complexity, and activates `engine.plan_and_delegate_goal` automatically.

### 43. 3-Layer Hybrid Memory Architecture

**Final behavior:** Memory separated into Working Context (DO RAM), Deterministic Project Truth (`PROJECT.md` in SQLite), and Long-Term Episodic/Semantic Memory (Vectorize).

**Production acceptance contract:**
Production entry: memory OS + project memory client + SpaceDO memory routes.
Persistence/deployment: DO working/session state, project facts/wiki, Vectorize episodic/semantic records.
Required observable verification: memory OS/project-memory tests cover expiry, durable truth and scoped retrieval.

**Retained implementation constraints:**
- The Gap: The KB stores document chunks as flat, independent vectors. No entity extraction or relationship mapping exists. For complex queries ("What is the relationship between product X and feature Y?"), the agent must retrieve many chunks and synthesize. A knowledge graph would dramatically improve complex reasoning.
 Required Fix: Add optional knowledge graph layer to KB ingestion: run NER (Named Entity Recognition) on chunks using a small local model (via CF AI). Extract entities and co-occurrence relationships. Store in KnowledgeBaseDO SQLite: CREATE TABLE kg_entities (id TEXT, label TEXT, type TEXT); CREATE TABLE kg_edges (from_id TEXT, to_id TEXT, relation TEXT, weight REAL) . On que
- The `MEMORY_VECTORIZE` binding's own `wrangler.toml` comment has always claimed Layer 5 semantic
recall is "queried by embedding + user_id filter" — the actual `recall()` code only ever filtered
Vectorize by `{spaceId: {$eq}}`, never `userId`. In shared-assistant mode (one DO/SQLite instance
serving multiple end users), this meant one user's promoted episodic memories were fully recallable
by every OTHER user sharing the same space — a real cross-user memory leak, not a documentation
typo, since the comment described intended behavior that the code never implemented. Fixed with a
two-query merge: Vectorize's flat `{field: {$eq}}` filter has no `OR`/`IN` support, so — mirroring
the exact `use
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- ### Axis 5: Decentralized & Scoped Intelligence ("Mini-AGI" & Permissioned Vector RAG) *(Continued)*
**Core Architectural Blueprint (Continued)**
* **Indirect Injection Security Firewalls:** Context-sanitization layers scan tool outputs, third-party web content, and retrieved vector chunks before prompt insertion [1.3.17]. Untrusted dynamic payloads are encapsulated in strict semantic boundary tags (e.g., `<untrusted_retrieval_chunk>`), explicitly signaling to the model's attention layers that text within these blocks cannot alter operational instructions or tool-dispatch policies [1.3.17].
* **Hierarchical Role-Based Access Control (RBAC):** Every document ingestion payload registers access bitmasks (defining tenant, department, project, and specific user IDs). Queries executed by an agent inherit the authenticated user's permission bitmask, automatically discarding unauthorized seman

### 44. Cross-Thread Context Isolation

**Final behavior:** New threads start with a pristine context window. Message logs from previous threads are never injected, eliminating prompt pollution.

**Production acceptance contract:**
Production entry: conversation context, `NaelaoAgentDO` session addressing, memory retrieval filters.
Persistence/deployment: separate session/agent DO state + scoped project memory/Vectorize.
Required observable verification: conversation isolation tests create a second thread and assert no prior messages or unauthorized vectors.

**Retained implementation constraints:**
- The Gap After a tool executes, the spec forwards the raw tool output directly to the next streamText call with no interception point. This means: (1) a read_file result beginning with "Ignore all previous instructions..." is fed verbatim to the LLM (prompt injection via file content), (2) a list_directory on a 10,000-file directory returns a result that blows the context window, (3) tool results are never logged for audit/forensic purposes. The CF Think SDK's afterToolCall(toolName, args, result) fires after tool execution and before the result is appended to messages.
- **Frontend (`apps/shell`).** Real chat: `Chat.tsx` ports `apps/portal`'s proven SSE client
(session start/resume, SSE streaming with a polling fallback, optimistic user-message rendering)
onto the mockup's markup (`msg-row`/`bubble`/`chat-area`/`thread-panel` classes from
`packages/ui`) instead of Tailwind. Chat "sessions" (the message-history transport,
`SpaceDO.sessions`) and "threads" (the structural browse table, `SpaceDO.threads`) are separate
tables with **no server-side link yet** — `sessionKey={threadId}` keeps each thread's chat
session persisted independently client-side (`chatSession.ts`, keyed per `(spaceId, key)`,
ported from `apps/portal/src/lib/session.ts`), which is an honest
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- #### Layer 1: Optimistic Concurrency Control (OCC / Hash Checkpoint)
Every file in your authoritative SQLite `workspace_files` table carries a **SHA-256 content hash**.
When an agent calls `Edit(filePath, oldString, newString)`, the DO SQLite write enforces a **Conditional Checkpoint**:
```sql
-- Atomic OCC Update in DO SQLite
UPDATE workspace_files
SET content = ?, hash = ?, size_bytes = ?, updated_at = datetime('now')
WHERE path = ? AND hash = ?; -- Verified against hash at start of turn!
```
* **If another user/agent edited the file mid-turn:** `changes === 0`. The DO throws an instant conflict exception:
  > `✖ Conflict Error: 'src/Header.astro' was modified by another thread 1.2s ago. Re-read lines before applying patch.`
* The agent reads the fresh lines with `Read` and self-heals its patch cleanly.

### 45. Semantic Fact Gating (Hindsight Memory)

**Final behavior:** Tasks distill into atomic rules in Vectorize. Retrieved in new threads only if semantic cosine similarity exceeds 0.80 against the new prompt.

**Production acceptance contract:**
Production entry: `gateMemory`, memory OS and project-memory client.
Persistence/deployment: Vectorize/R2 agent memory bindings.
Required observable verification: `avos-features.test.ts` tests the gate, but does not prove every thread ingress uses it.

**Retained implementation constraints:**
- 141. **The six items item 140 explicitly left open are now BUILT — Phase 1 of the 62-item batch is
     complete.** `thread.create` (the assistant's own `project-coordination` prebuilt) minted a
     `threads` row with no `session_id` — the exact bug behind "Session not found" on any
     assistant-created thread. It now also mints and links a real session (generating the thread's
     own id client-side so the link can point at it, then `POST /sessions {thread_id}`), matching
     the shape a human's own "New thread" already produces; degrades to returning the bare thread
     (still real, still usable via a later open) rather than throwing if the session-link call
     itself fails. The SA
- The Gap: Agents retrieve KB chunks but do not always cite sources in responses. When they do cite, they may cite the wrong chunk (hallucinated citation). Builders and end-users cannot verify claims. No citation grounding or verification pipeline exists.
 Required Fix: Implement citation grounding: after LLM response, run a post-processing step that (1) extracts claimed facts from response, (2) verifies each fact against the retrieved chunks via semantic similarity check (cosine > 0.8), (3) annotates verified citations with source doc_id and chunk index, (4) flags ungrounded claims as [unverified] . Return citations array alongside response. Builder can configure require_grounding: boolean —
- The `MEMORY_VECTORIZE` binding's own `wrangler.toml` comment has always claimed Layer 5 semantic
recall is "queried by embedding + user_id filter" — the actual `recall()` code only ever filtered
Vectorize by `{spaceId: {$eq}}`, never `userId`. In shared-assistant mode (one DO/SQLite instance
serving multiple end users), this meant one user's promoted episodic memories were fully recallable
by every OTHER user sharing the same space — a real cross-user memory leak, not a documentation
typo, since the comment described intended behavior that the code never implemented. Fixed with a
two-query merge: Vectorize's flat `{field: {$eq}}` filter has no `OR`/`IN` support, so — mirroring
the exact `use
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi

### 46. In-Flight Milestone Squashing (`compact_context`)

**Final behavior:** When threads cross 25 turns, completed decisions squash into `PROJECT.md`, older turns archive to D1, and prompt retains only summary plus recent turns.

**Production acceptance contract:**
Production entry: session `/compact`; `compactContext`; `NaelaoAgentDO` compaction.
Persistence/deployment: agent DO SQLite archive and project workspace.
Required observable verification: `compact-conversation.test.ts` and conversation context tests cover retention.

**Retained implementation constraints:**
- Required Fix: Implement priority-based context truncation: context budget allocation: system_prompt (reserved 20%), KB_chunks (40%), recent_conversation (30%), metadata (10%). When total > model_context_limit: (1) truncate oldest conversation turns first (keep last N turns), (2) reduce KB_chunks to top-3 by score, (3) compress older conversation with LLM summarizer to summary_token. Track context_truncation_events and user_experience_impact (does truncation correlate with negative ratings?).
- **Frontend (`apps/shell`).** Real chat: `Chat.tsx` ports `apps/portal`'s proven SSE client
(session start/resume, SSE streaming with a polling fallback, optimistic user-message rendering)
onto the mockup's markup (`msg-row`/`bubble`/`chat-area`/`thread-panel` classes from
`packages/ui`) instead of Tailwind. Chat "sessions" (the message-history transport,
`SpaceDO.sessions`) and "threads" (the structural browse table, `SpaceDO.threads`) are separate
tables with **no server-side link yet** — `sessionKey={threadId}` keeps each thread's chat
session persisted independently client-side (`chatSession.ts`, keyed per `(spaceId, key)`,
ported from `apps/portal/src/lib/session.ts`), which is an honest
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
