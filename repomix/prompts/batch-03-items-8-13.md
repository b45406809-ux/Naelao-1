# AI Studio implementation prompt — batch 03, plan items 8–13

## Mission

Implement every requirement below end to end on the current accumulator branch. The cohesive focus
is **Execution ladder, hypervisor, synchronization, sleep, and Pyodide**. This prompt is self-contained: the feature definitions and retained implementation
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


### 8. 6-Tier Cloudflare Execution Ladder

**Final behavior:** Hierarchical compute routing: Tier 1 (DO SQLite VFS), Tier 2 (V8 Isolate Shell), Tier 3 (Workflows), Tier 4 (Kitesurf Browser), Tier 5 (Chromium), Tier 6 (Container Sandbox).

**Production acceptance contract:**
Production entry: `runStoredScript`, `buildCodeRunner`, browser engine fallback, workflow runner.
Persistence/deployment: Loader, Workflows, Browser, Sandbox and R2 bindings.
Required observable verification: execution-ladder/workflow/browser/container tests; result records actual tier/engine.

**Retained implementation constraints:**
- **L3 — the routing hook, wired ahead of any image (`ScriptMetadata.container_image`).** A
`requires_tier: 5` script may now carry a `container_image` tag; `execution-ladder.ts` forwards it
to `codeRunner.run()`, and `code-runner.ts`'s `runContainer` checks a NEW `CodeRunnerOptions.
containerImages: Record<string, DurableObjectNamespace>` map — if the named image has a bound
namespace, it addresses that image's own DO (`slot:{image}:{space}:{project ?? "_assistant"}`,
same addressing convention as Phase K's base sandbox) instead of the shared `ToolSandboxDO`; if
not, it fails closed with a clear message rather than silently falling back to the base sandbox
(which would run the script against
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

### 11. 4-Dimension State Synchronization Engine

**Final behavior:** Prevents split-brain between V8 Isolates and Containers across Filesystem, Shell Session (`cwd`/`export`), Git HEAD ref, and DO SQLite state.

**Production acceptance contract:**
Production entry: state coordinator; ToolSandbox session and artifact adapters.
Persistence/deployment: DO SQLite session state + artifact refs + R2.
Required observable verification: stale-revision and container persistence tests; conflicts reject stale writers.

**Retained implementation constraints:**
- Required Fix: Add UserProfile component to Space UI: end-user sets display_name, avatar (upload or select from preset icons), color_theme preference (light/dark/auto). Stored in SpaceDO SQLite end_user_profiles keyed by user_id. Profile persists across sessions. In collaborative sessions (AY04), display name and avatar shown next to each user's messages. Agent addressed end-user by display_name if set ("Hi Sarah,"). Builder can configure required profile fields at Space registration. GDPR: profile data in end-user export (AO30); deletable (AO31). Avatar images stored in R2 with user_id prefix; CDN-served at /spaces/{id}/users/{uid}/avatar.
- - **`packages/billing-core/src/providers/stripe.ts`** — fetch-based `StripeProvider`
  (form-encoded, no SDK): `verifyWebhook` (Stripe-Signature `t=…,v1=…` HMAC, 5-min tolerance,
  constant-time compare), `parseWebhookEvent` (checkout.session.completed → payment.success,
  subscription.*, charge.refunded → refund.issued; folds the Connect event's `account` into
  `metadata.stripe_account` and captures `payment_intent` — the ONE id shared between a
  checkout event and its later refund event), `createCheckout` (ad-hoc `price_data`, direct
  charge + application fee). Connect helpers: `createExpressAccount` / `createAccountLink` /
  `getAccountStatus`. LS provider gained `lsListStores` / `lsCr
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- ### 1. The Unified Filesystem Sync Protocol (All 6 Tiers)
To ensure there is **zero split-brain, zero data loss, and zero file desynchronization**, every tier in the 6-tier ladder connects to the **Authoritative Virtual Filesystem (`workspace_files` in `NaelaoAgentDO`'s SQLite storage)**.
```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                        TIER 1: THE SINGLE AUTHORITATIVE SOURCE OF TRUTH                                │
│                     [ NaelaoAgentDO SQLite Virtual Filesystem (`workspace_files`) ]                    │
│                                 (SHA-256 Checkpoints + In-Memory Fast Cache)                           │
└────────┬───────────────────┬───────────────────┬───────────────────┬───────────────────┬───────────────┘
         │                   │                   │                   │

### 12. 95/5 Compute Arbitrage with 60-Second Micro-Sleep

**Final behavior:** 95% of tasks run in sub-5ms V8 Isolates ($0.0001). Containers spin up only for native compiles and shut down after a strict 60-second idle countdown, keeping monthly costs under $2.50.

**Production acceptance contract:**
Production entry: ToolSandboxDO/container server idle alarm.
Persistence/deployment: DO alarm/session timestamp; `TOOL_SANDBOX`.
Required observable verification: idle-boundary tests at 59,999/60,000ms; state remains persisted after stop.

**Retained implementation constraints:**
- The Gap
 Tier 5 Container Billing — Metered by Start Time, Not Actual Usage; Idle Containers Overcharge Tier 5 containers are billed by the second they are allocated, not by CPU time. The spec says "metered by command duration." If an agent spins up a container to run `sleep 600` (10 minutes of idle sleep), the container is billed for 10 minutes of wall-clock time, even though zero CPU was used. For long-running agents that spawn containers for background tasks, this compounds: a container that allocates, waits 5 minutes for an external API to respond, then completes will be billed for 5+ minutes even if it used only 100ms of CPU.
- **Real per-token accounting — the actual fix underlying both the budget and credit-conversion
gaps.** Turned out `tokens_used` was hardcoded to `0` everywhere — `GatewayReasoner.decide()`
discarded the Anthropic response's `usage` field entirely, so nothing downstream (spend caps,
sub-agent budgets) had a real number to work with despite being *described* as token-based.
Fixed at the source: `GatewayReasoner` now captures `usage.input_tokens`/`output_tokens` into a
`lastUsage` property (the `Reasoner` interface contract); `runScriptLoop` reads it after every
`reasoner.decide()` call and accumulates input/output separately into the returned
`ScriptRunResult.tokens_used`/`input_tokens`/`output
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- # 2. Stream 1: The SaaS Subscription Tiers
```
┌───────────────────────────────┬──────────────┬───────────────────────────────┬──────────────────────────────────────────┐
│ Plan Tier                     │ Price        │ Included Workspaces & Limits  │ Unlocked Features & Capabilities         │
├───────────────────────────────┼──────────────┼───────────────────────────────┼──────────────────────────────────────────┤
│ **1. Free Tier (Hacker)**     │ **$0 / mo**  │ • 1 Business Workspace        │ • BYOK Only (Anthropic, Gemini, Groq)    │
│ *(Top-of-Funnel Viral Onramp)*│              │ • 1 Project / 3 Threads       │ • Tier 1 SQLite FS + Tier 2 Isolates     │
├───────────────────────────────┼──────────────┼───────────────────────────────┼──────────────────────────────────────────┤
│ **2. Starter (Solo Builder)** │ **$29 / mo** │ • 3 Business Workspaces       │ • Includes $10/mo compute al

### 13. In-Isolate WebAssembly Python (Pyodide)

**Final behavior:** Standard Python scripts execute in V8 isolates via WebAssembly in <10ms for $0.00, escalating to Tier 6 Containers only when importing heavy native C-extensions like PyTorch.

**Production acceptance contract:**
Production entry: invisible route classifier and code runner promotion.
Persistence/deployment: loader module cache; Sandbox binding.
Required observable verification: routing tests cover stdlib/pandas versus torch/native imports and honest unavailability.

**Retained implementation constraints:**
- 58. **Whop added as a second PLATFORM billing provider (AUDIT_TODO.md AI-7), replacing Lemon
    Squeezy as the FIRST-TRIED provider for builder platform plans and end-user subscriptions/
    credit-packs — LS stays as the fallback, item 45 is not reverted.** Trigger: the operator
    couldn't activate a Lemon Squeezy store because LS's own onboarding requires a Stripe-linked
    payout path unavailable in their country. Two genuinely different Whop relationships were
    built, neither the same as the invite-gated Platforms API (items 50-51, business-wallet
    sub-merchants) or the read-only "Connect with Whop" OAuth connector (item 53):
    - **Platform-plan checkout** (`packages/billing-
- The Gap env.SANDBOX.create() is called in the spec without a network policy option. CF Containers support configurable network policies: full (default, internet access), restricted (only egress to allowlisted hostnames), or none (no network). Agent-executed user code (Python scripts, bash commands from LLM tool calls) runs in a container with full internet access by default. A prompt-injected agent could exfiltrate secrets, make unexpected external API calls, or participate in a DDoS attack from within the container.
- **Goal:** fix Tier 5 (spec §33b) so `python3.execute_python`/`code.execute_bash` scripts persist
files across restarts and share them across a project's threads — verified BEFORE this pass that
neither was true: `runContainer` addressed the sandbox DO per-`{space,agent}` (so two threads'
agents in the same project got DIFFERENT containers) and the harness only ever wrote/read a
`mkdtemp`+`rm` scratch dir per call (so nothing survived even a single container instance's next
request, let alone a restart).
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
