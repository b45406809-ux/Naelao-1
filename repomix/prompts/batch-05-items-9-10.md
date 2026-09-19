# AI Studio implementation prompt — batch 05, plan items 9–10

## Mission

Implement every requirement below end to end on the current accumulator branch. The cohesive focus
is **Plan items 9–10**. This prompt is self-contained: the feature definitions and retained implementation
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


### 9. Invisible Runtime Hypervisor

**Final behavior:** The LLM prompt is stripped of complex tier-selection tools, presenting only a minimalist 3-tool surface (`Bash`, `Read`, `Edit`) + 2 senses (`Browser`, `Delegate`). The runtime hypervisor silently routes commands to the cheapest capable tier.

**Production acceptance contract:**
Production entry: `ScriptToolSurface.run` → `runStoredScript`.
Persistence/deployment: script metadata in R2; runtime bindings server-side.
Required observable verification: tool-surface and launchpad-runtime tests; callers name an action, not infrastructure.

**Retained implementation constraints:**
- The Gap: Builders writing long system prompts have no tool to see how many tokens their prompt consumes and how much context remains for conversation history and KB chunks. They discover context limits only at runtime when the LLM call fails or silently truncates.
 Required Fix: Add token counter to system prompt editor in builder dashboard: live token count as builder types (using tiktoken-js in the browser). Shows: [System Prompt: 2,400 tokens] + [KB Injection: ~1,200 tokens] + [History: variable] = [Total: ~3,600 / 128,000 tokens] . Context budget visualizer: bar showing allocation across system prompt, KB, history, response reserve. Warning when system prompt exceeds 10% of context wind
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
- ### Summary of Guarantees
1. **True Single Source of Truth:** Whether a file is created by a user in the UI, an agent editing with `Edit`, a headless browser downloading an asset, or a Python script running inside a Docker container, **all bytes settle into the DO SQLite Virtual Filesystem (`workspace_files`)**.
2. **Universal Tool Experience:** The AI doesn't need 50 specialized tools for every language or environment. It uses **`Read`**, **`Edit`**, **`Write`**, **`Grep`**, **`Glob`**, and **`Bash`** everywhere, and the Cloudflare Execution Ladder automatically handles isolation, promotion, and synchronization behind the scenes.
But let add more tools for tiers specific like does it want to run cf/codemode or something like workflows or browser or bash/cmd/terminal in container etc . Infect  remove the universal tools and make tier basic tools be the universal so if it needs to run bas

### 10. `ArtifactFS` FUSE Driver with Lazy Hydration

**Final behavior:** Linux containers mount project workspaces on the fly over FUSE, pulling file contents lazily over the edge network and eliminating 90-second `git clone` delays.

**Production acceptance contract:**
Production entry: `container/artifact-fs.mjs`, sandbox workspace sync.
Persistence/deployment: artifact worker/R2; `ARTIFACT_WORKER`, `SCRIPTS_R2`.
Required observable verification: `artifact-fs.test.mjs`, container workspace tests; list does not fetch bodies.

**Retained implementation constraints:**
- The Gap The spec mentions FUSE-mounted R2 as the container workspace but never specifies: (1) which R2 bucket prefix each container mounts, (2) how FUSE write-back is triggered (write-through vs. write-behind), (3) how a second container reading a file written by the first container avoids a stale cache read, and (4) what happens when two containers write to the same file concurrently. In the Moltworker model, R2 is the source of truth: containers use FUSE write-through (every write is immediately PUT to R2), and cache invalidation uses R2 event notifications (R2 PUT fires an event that all containers with the affected key in their FUSE cache must invalidate).
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
- ### 1. What Cloudflare Artifacts Actually Is
* **Git-Native Storage at Agent Scale:** Built to create tens of millions of repositories programmatically (one repo per business, per project, per agent session, or per test experiment).
* **Zig-to-WASM Git Server in Durable Objects:** Runs a full Git server compiled to WebAssembly directly inside Cloudflare Durable Objects.
* **3 API Access Surfaces:**
  1. **Native Workers Binding (`env.ARTIFACTS`):** Programmatic repo creation, forking, commit reading, and token provisioning in sub-milliseconds.
  2. **Smart HTTP Git Remote (`https://artifacts.cloudflare.net/...`):** Any standard Git client, isolate shell, or container can run native `git clone`, `git commit`, `git push` using short-lived repo-scoped tokens.
  3. **ArtifactFS (Open-Source FUSE Driver):** Mounts repositories directly into `/workspace` inside Linux Containers on the fly, **h

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
