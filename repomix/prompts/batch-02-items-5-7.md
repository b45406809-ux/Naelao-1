# AI Studio implementation prompt — batch 02, plan items 5–7

## Mission

Implement every requirement below end to end on the current accumulator branch. The cohesive focus
is **Artifact Git, isolate workspace, and namespace separation**. This prompt is self-contained: the feature definitions and retained implementation
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


### 5. Cloudflare Artifacts Git-for-Agents Engine

**Final behavior:** Native, serverless Git versioning running inside Durable Objects via a Zig-to-WASM engine. Provides real, full-fidelity repositories for commits, branches, and diffs.

**Production acceptance contract:**
Production entry: artifact worker `RepositoryDO`; artifacts prebuilt; agent turn commit adapter.
Persistence/deployment: DO SQLite objects/refs/commits; `ARTIFACT_WORKER`, `AGENT_REPOS`.
Required observable verification: `workers/artifact/src/repository.test.ts`, artifact worker tests; refs and commits survive new requests.

**Retained implementation constraints:**
- **Session token-budget guard — the actual differentiator vs. OpenClaw's "$300-500/mo, no
warning" complaints.** New `SpaceTypeProductConfig.limits.sessionCreditCeiling` (config_json
override, same convention as `modelConfig`/`pricingConfig` — never a manifest fork), resolved
once in `index.ts` next to `modelConfig` (this DO has no `PLATFORM_DB` binding) and threaded
through all three dispatch paths that reach `handleScriptRun` (the sync `/script/run` call, the
async `AgentTaskWorkflow` params, and `/internal/tasks/:taskId/run`) so the guard applies
identically to interactive and durable runs. New `session_spend` table (SpaceDO migration v31,
same one as the signals table) holds only the runn
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
- # 4. Four More Game-Changing Capabilities with Cloudflare Artifacts
Because Cloudflare Artifacts gives you **tens of millions of real Git repositories running inside Durable Objects**, you can unlock capabilities that neither Claude Code nor GitHub can match:

### 6. In-Memory Virtual POSIX Shell (`@cloudflare/computer`)

**Final behavior:** Sub-millisecond shell executing 90%+ of agent terminal actions (`grep`, `cat`, `sed`, `awk`, `find`, `jq`, `diff`, Unix pipes) in V8 isolates against DO SQLite without starting a container.

**Production acceptance contract:**
Production entry: `r2-workspace`/workspace prebuilts and tool surface.
Persistence/deployment: project R2 prefix + SpaceDO locks; `SCRIPTS_R2`.
Required observable verification: file-manager/R2 workspace tests; shell-like reads and writes avoid container startup.

**Retained implementation constraints:**
- - **Migration `0065_whop_kyc_onboarding.sql`** rebuilds `whop_sub_merchants` (SQLite can't ALTER
  a CHECK constraint in place — same limitation migration 0052 hit for `processed_webhook_events`)
  adding `status IN ('pending','awaiting_kyc','active','error')` and a nullable `onboarding_url`
  column.
- **`createSubMerchant`** (`packages/billing-core/src/providers/whop.ts`) now returns
  `{company_id, status, onboarding_url?}`. Since the exact response field name Whop uses for the
  onboarding link is unverified (docs.whop.com blocks unauthenticated fetches — confirmed by
  direct testing during this session), it defensively checks a few plausible names
  (`onboarding_url`/`account_link`/`ve
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- Apply this delta after each item's complete Origin & Transition trail. If it conflicts with an earlier plan statement, this file wins. If it is silent, retain the earlier final decision. All authorization, tenant isolation, fail-closed policy, provenance, billing, deployment parity, and realistic end-to-end verification requirements remain in force.
- #### The Primitive Tool Definitions:
```typescript
export interface ScriptNativeTierPrimitives {
  // TIER 1: In-Memory SQLite Virtual Filesystem
  exec_sqlite_fs: {
    description: "Execute in-memory file operations (read, patch, diff, grep, glob) against DO SQLite.";
    parameters: { op: "read" | "patch" | "write" | "grep" | "glob" | "diff"; params: Record<string, any> };
  };
  // TIER 2: V8 Isolate CodeMode (Pure CodeAct in V8)
  exec_isolate_codemode: {
    description: "Execute arbitrary TypeScript/JS code in a V8 Isolate with fetch() and ctx.mcp bindings. Sub-millisecond execution.";
    parameters: { code: string; args?: Record<string, any> };
  };
  // TIER 3: Dynamic Durable Workflows
  exec_workflow: {
    description: "Deploy and trigger a durable Cloudflare Workflow for long-running, multi-step, or cron-scheduled tasks.";
    parameters: { workflowCode: string; schedule?:

### 7. Clean Namespace Separation (`/workspace/` vs. `/.avos/`)

**Final behavior:** Physical boundary between user deliverables and agent meta-state. `/workspace/` contains application code/data tracked by Git; `/.avos/` is Git-ignored and holds agent skills, workflows, and scratchpads.

**Production acceptance contract:**
Production entry: workspace path normalization; container `materializeWorkspace/collectWorkspace`.
Persistence/deployment: distinct workspace/control prefixes; `SCRIPTS_R2`, artifact DO.
Required observable verification: adversarial namespace traversal tests; `/.avos` is excluded from Git collection.

**Retained implementation constraints:**
- 94. **Skill self-improvement (the last open gap from the OpenClaw/Hermes analysis) and a real
    connector directory are now BUILT.** Two independent pieces, both live-verified.
    - **The skill gap as previously written was slightly wrong, and the correction matters.**
      Outcomes WERE recorded and `script.find` WAS sorted by them. The real problem: `stability_score`
      is a LIFETIME ratio, which cannot express recency — 20 successes and 4 failures scores 0.83
      whether those failures are spread over a year or are the last four runs in a row. A skill that
      broke yesterday kept being offered as proven, kept being picked, and kept failing. New
      `script-engine/skill-healt
- 35 architectural gaps covering: OpenClaw feature parity (continuous background loop, fiber concurrency, proactive trigger types, tool chaining, skill marketplace, inline sub-agent delegation, channel hub normalization, delegation chain), MCP Apps ecosystem (App Store, installed app persistence, tool approval flow, scope model, McpAgent/AIChatAgent separation, OAuth callback), Skills self-improvement via Hermes pattern (crystallization loop, versioning, test suite, within-session cache, conflict resolution), multi-container coordination (pool management, container specialization, filesystem sync, pre-warming, network policy), shared agent user data isolation (memory namespace, Vectorize filte
- **M3 — `LocalTunnelDO` (agents worker, new `LOCAL_TUNNEL` binding, migration v7).** One instance
per `(spaceId, userId)`, using the CF Hibernation API (`ctx.acceptWebSocket`) — the exact same
pattern `workers/ws-gateway`'s `WsHubDO` already established, so the DO can sleep between requests.
`GET /local-tunnel/connect?space=&user=&token=` (agents worker, deliberately unauthenticated at the
Hono layer — the caller is a native client on someone's own machine, not a browser session with a
JWT to check; `verifyLocalTunnelToken` inside the DO is the actual gate) upgrades to a WebSocket.
`POST /exec` on the DO correlates a request to its eventual WS response via an in-memory pending
map with a 30-s
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
