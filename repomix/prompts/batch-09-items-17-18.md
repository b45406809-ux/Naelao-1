# AI Studio implementation prompt — batch 09, plan items 17–18

## Mission

Implement every requirement below end to end on the current accumulator branch. The cohesive focus
is **Plan items 17–18**. This prompt is self-contained: the feature definitions and retained implementation
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
