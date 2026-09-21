# AI Studio implementation prompt — batch 04, plan items 14–19

## Mission

Implement every requirement below end to end on the current accumulator branch. The cohesive focus
is **Browser/container bridge, forks, time machine, and blame**. This prompt is self-contained: the feature definitions and retained implementation
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


### 14. Tier 4 Cloudflare Kitesurf Agent Browser

**Final behavior:** 30MB lightweight browser running 3–7x faster and cheaper than Chromium for DOM text extraction and form fills, auto-elevating to Tier 5 Chromium for WebGL or screenshots.

**Production acceptance contract:**
Production entry: browser worker `/v1/browser/navigate`; code-runner browser proxy.
Persistence/deployment: browser session binding; `BROWSER`.
Required observable verification: browser Kitesurf tests; output reports selected engine and fallback reason.

**Retained implementation constraints:**
- - **F10 (Tier-2/3 isolates get raw, unguarded `fetch`, spec G-AF20)** — **already fixed**, in
  the same pass that closed F13 for the browser worker (see A1.16 Track B/F10+F13 above,
  commit tagged `9a541e1`-equivalent). `workers/agents/src/script-engine/code-runner.ts`'s
  `SSRF_GUARD_PRELUDE` overrides `globalThis.fetch` inside the isolate module text itself
  (`__ssrfGuardedFetch`), and the injected `ctx.fetch` calls that same guarded function — not
  the bare `fetch`. Confirmed by reading the current file (not assuming from memory): lines
  ~87-114 show the guard, line ~124 shows `ctx.fetch: (...a) => __ssrfGuardedFetch(...a)`.
- **F13 (SSRF guard is hostname-literal only, no DNS resolu
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- ### 2. The Refined Execution Ladder: Adding Cloudflare Kitesurf
Placing **Cloudflare Kitesurf** directly before full **Chromium Browser Rendering** provides a massive cost and performance advantage:
* **Kitesurf (Announced Aug 2026):** A lightweight, agent-first browser engine that uses **3–7x less CPU and RAM than Chromium** and starts in milliseconds. It is ideal for 80% of agent web tasks (extracting clean text, navigating DOMs, filling forms, and reading articles).
* **Headless Chromium:** The heavy artillery. Used only when Kitesurf hits a wall (WebGL, complex bot challenges, canvas painting, or visual pixel-perfect screenshots).
```
                                  ┌─────────────────────────────────────────────────────────────┐
                                  │ TIER 5: Sandboxed Linux Container (ToolSandboxDO / Ubuntu)  │
                                  │ • Full OS userland: n
- ### 1. The Updated 6-Tier Cloudflare Execution Ladder
Integrating **Dynamic Workflows** gives your platform durable, multi-day background execution without holding open expensive sockets or burning worker CPU while waiting on external systems or cron schedules:
```
                                  ┌─────────────────────────────────────────────────────────────┐
                                  │ TIER 6: Sandboxed Linux Container (ToolSandboxDO / Ubuntu)  │
                                  │ • Full OS userland: npm install, compilers, Python binaries │
                                  └──────────────────────────────▲──────────────────────────────┘
                                                                 │ (Promote if native compilation needed)
                                  ┌──────────────────────────────┴──────────────────────────────┐
                                  │ TI

### 15. Virtual Display Container Automation ("Computer Use")

**Final behavior:** Xvfb + Fluxbox + noVNC WebSockets running inside Tier 6 Containers, allowing agents to visually interact with desktop software via mouse clicks, keystrokes, and frame captures.

**Production acceptance contract:**
Production entry: ToolSandbox computer-use endpoints/container server.
Persistence/deployment: persistent project SandboxDO state; `TOOL_SANDBOX`.
Required observable verification: container computer-use contract tests; display frames are returned, not simulated.

**Retained implementation constraints:**
- Required Fix
 Required Fix Use CF Container idle detection to pause billing while the container is idle (no CPU usage detected). Resume billing when computation resumes. Alternatively, require agents to implement request-response patterns, not long-lived container sessions. A container should start, do work, and exit quickly. For long-running tasks, use Dynamic Workflows (which have better pricing). Add a billing model choice to the container manifest: "per-wall-clock-second" (current) or "per-cpu-millisecond" (more fair). Default to fair billing. Severity: Medium — Containers metered by wall-clock time, not CPU time. Long waits (API calls, sleep, network I/O) increase costs without increas
- **Execution ladder Tiers 2-5 — `script-engine/code-runner.ts`.** Implements `TieredCodeRunner`
for real:
- **Tier 2/3** — a CF Worker Loader (`[[worker_loaders]]` binding `LOADER`) spins up a fresh V8
  isolate per `script.run` call. Stored code is a single module exporting `run(args, ctx)`; the
  runner appends a small `fetch` harness around it. Tier 3 best-effort resolves bare-specifier
  imports from `esm.sh` as extra virtual modules (there is no real "npm install" inside an
  isolate — documented as a real limitation, not papered over).
- **Tier 4** — the same isolate, with `ctx.browser.navigate(...)` injected, proxied to the
  pre-existing `naelao-browser` Worker (CF Browser Rendering +
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- Just like Hermes s bot mode (check web sources) and grok bot I think that architecture is the ultimate go to for projects (but aren't we there yet since project thread agents can do what grokbots do )  am I wrong think about it. What I really am concerned about is the agent roster UI vs sessions (our UI) I think we are behind should we adopt to agents roster plus how would users Collab plus agents in sessions/threads we solved this with thread tiers

### 16. Multiplexed Persistent gRPC Bridge

**Final behavior:** Replaces high-latency HTTP/1.1 JSON serialization between Durable Objects and Containers with persistent multiplexed binary gRPC streams over TCP sockets.

**Production acceptance contract:**
Production entry: container bridge/server and ToolSandboxDO request correlation.
Persistence/deployment: project-addressed DO/socket state; Sandbox binding.
Required observable verification: local tunnel/container bridge tests; concurrent correlation IDs cannot cross.

**Retained implementation constraints:**
- Required Fix Enable CF Smart Placement for all SpaceDOs, AssistantDOs, and ConversationShardDOs in wrangler.toml: [durable_objects.smart_placement] mode = "auto". Document the tradeoff: Smart Placement may move a DO between regions, which could conflict with data residency requirements (G-AA47). For spaces with data residency constraints (jurisdiction: "EU"), pin to a specific region using locationHint and disable Smart Placement via mode = "off". For all other spaces, enable Smart Placement and accept that DO location adapts to user geography over time. Monitor DO region via CF API metrics and alert if a data-residency-constrained DO migrates outside its jurisdiction.
- **K2 — R2 sync as the "mount," since Cloudflare Containers have no native R2 filesystem mount.**
This is the honest mechanism available on this platform today: `ToolSandboxDO` now reads the
project's R2 workspace (the SAME `workspacePrefix()`-scoped bucket/prefix Tier-1 `r2-workspace`
already reads/writes) before forwarding an `/exec` call to the container harness, hands the files
over as a `workspace_files` map in the request body, and on response writes back whatever the
harness reports as `/workspace`'s final contents (`workspace_files_out`) — including deleting any
file that existed before the run but is gone afterward (the script deleted it). R2 is the
persistent source of truth: a cold
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
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
└───────────────────────────────┘                             └─

### 17. Instant Zero-Copy Branch Micro-Forking

**Final behavior:** Copy-on-write repository forks generated in 10ms for subagents and private scratchpads, guaranteeing zero disruption to the main workspace branch.

**Production acceptance contract:**
Production entry: artifact repository branch/checkout and micro-fork naming.
Persistence/deployment: immutable Git objects + mutable refs in RepositoryDO.
Required observable verification: repository branch tests; main ref remains unchanged.

**Retained implementation constraints:**
- Required Fix: An operator project's container image (the same Tier-5 container-marketplace mechanism from Phase L, item 36, now with its first real, non- coming_soon catalogue entry: dev-sandbox , a container with git + a language runtime preinstalled) clones the operator's registered repository on first use and the workspace prebuilt's copy/move ops (G-BG09's neighbor, Phase R) are joined by workspace.git_commit / git_branch / git_diff ops, so every Dev agent change is a real, revertable git commit against a real branch (never directly against the operator's default branch — the Dev agent always works on a per-spec feature branch, merged only after G-BG05's gate passes), not a set of file w
- **Reskin approach — retarget + shell swap, not a per-page rewrite.** A full Tailwind-to-`@naelao/ui`
markup conversion across ~25 existing dashboard pages was judged disproportionate to what "reskin"
needs; instead: (1) `tailwind.config.ts`'s `brand` color scale was regenerated from the mockup's
actual accent (`packages/ui/src/tokens.css`'s `--accent #5b52f0`) — every existing
`bg-brand-*`/`text-brand-*`/`border-brand-*`/`ring-brand-*` utility across every page picks up the
new violet identity instantly, zero markup changes, zero regression risk; (2) `globals.css` imports
`@naelao/ui/tokens.css` + `@naelao/ui/styles.css` (no class-name collisions found — the dashboard
never used bare `.btn`/
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- ### Summary of What This Establishes:
1. **Deterministic Multi-Tier Knowledge (Mini-AGI):** Documents are partitioned by **Space, Project, and Role Rank**; Vectorize discards unauthorized chunks at the hardware query layer so classified information never leaks.
2. **Google-Search-Level Edge Intelligence:** Combines **sub-50ms KV semantic caching**, **Hybrid RRF (Dense Vectorize + Sparse BM25)**, and **live edge web search** with clickable citation footnotes.
3. **Safe Multi-Player Collaboration:** Users and agents can freely branch and experiment in **Tier 4 Private Scratchpads**. Edits are committed via structured **Pull Requests**, and teammates review visual diffs and merge changes to the main workspace with zero risk of code clobbering.
The release of **Cloudflare Artifacts (Git for Agents)** provides the exact native infrastructure layer needed for this architecture.
Instead of han

### 18. Turn-by-Turn Git Time Machine

**Final behavior:** Every tool turn creates an automated Git commit in Cloudflare Artifacts, allowing 1-click workspace rollbacks from the thread timeline.

**Production acceptance contract:**
Production entry: `NaelaoAgentDO` artifact change adapter; artifacts prebuilt.
Persistence/deployment: RepositoryDO commits; `ARTIFACT_WORKER`.
Required observable verification: artifact integration tests; timeline receives a commit OID per tool turn.

**Retained implementation constraints:**
- Fifth and final pass covering all remaining spec sections: §28 naelao-threads (WebSocket upgrade detection, SSE waitUntil, undefined db), §30 pricing/billing (BEGIN/COMMIT/ROLLBACK, PostgreSQL syntax), §naelao-os createSpace (use-before-declaration), §space-type-registry-appendix (missing settled column, undefined db in settleEarnings), §naelao-spaces-deep (duplicate const declarations causing SyntaxError, COUNT::int cast, NOW()+INTERVAL invite logic), §workflow-examples (SSRF on sourceUrl, GET with body, external fetch), §remoteloop + §remoteloop-appendix (dynamic binding undefined, TTL insufficient), §appendix-custom-dos (CartDO token loss, provisioner errors swallowed, admin db artifacts)
- `NaelaoAgentDO.enforceRunGates` gained a new `checkSessionBudget` branch, checked FIRST (ahead of
every payer-specific gate) since it's session-scoped, not payer-scoped:
- Under 80% of ceiling: run proceeds, no side effect.
- 80-100%: run proceeds; fires `agent.session_budget_warning` through SpaceDO's already-existing
  generic `/internal/events/fire` → `event_triggers` machinery (the SAME no-code mechanism every
  other structural event uses — no new trigger type), and marks `warned_80` so it fires exactly
  once per spending cycle.
- At/past 100%: refuses the run (`402 session_budget_ceiling`) and reuses the HITL approval
  mechanism (no new gate engine, per the plan's explicit direction)
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
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
├── Turn 3 (Agent): Adds webhook handler ──► 🏷️ Commit `t3-webhook`

### 19. Reasoning-Aware Git Blame

**Final behavior:** Commit messages embed structured front-matter metadata containing author agent role, user goal, task ID, and technical/legal rationale.

**Production acceptance contract:**
Production entry: artifact `validateMetadata` and agent commit context.
Persistence/deployment: commit metadata/front matter in RepositoryDO SQLite.
Required observable verification: repository tests reject incomplete metadata and return it on history/blame.

**Retained implementation constraints:**
- Required Fix: A dedicated code-index prebuilt (distinct from knowledge-base — different content shape, different refresh cadence, different consumer) that maintains a per-project Vectorize namespace of code-chunk embeddings plus the structured dependency graph from G-BG04, both incrementally updated on every commit the Dev agent makes (a git post-commit hook implemented as a Tier-2 script, not a human-authored CI step) rather than batch-reindexed. script.find -style semantic lookup extends to code.find(query) so any of the four agents can ask "where is X handled" and get real, current file:line answers instead of guessing from an increasingly stale mental model — the direct fix for the "agen
- New optional `MemoryOSOptions.wikiBucket` (a minimal `{put(key, value)}` interface, not a hard CF
`R2Bucket` dependency — same rationale as the existing `VectorIndex`/`Embedder` minimal interfaces)
and `MemoryOSOptions.autoRag` (`{search(query, {topK}): Promise<Array<{concept, score}>>}`).
`upsertWikiConcept` mirrors each concept to R2 at
`spaces/{spaceId}/memory/wiki/{userId || "_space"}/{concept-slug}.md` (best-effort — SQLite's
`wiki_store` row is written first and is unaffected by a mirror-write failure). `searchWiki` first
runs its existing SQLite LIKE-match (unchanged); if that doesn't already fill the requested `limit`
and an `autoRag` gateway is configured, it ALSO queries AutoRAG fo
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- --AVOS-METADATA--
  author: "@LegalAgent"
  goal: "Review MSA for Delaware compliance"
  rationale: "Delaware Code § 145 limits unilateral indemnification for directors."
  task_id: "task_402"
  ```
* When another agent later inspects the file, it calls `git.blame("src/contracts/msa.md")` and reads **not just who wrote the line, but the exact legal/technical reasoning why they wrote it.**

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
