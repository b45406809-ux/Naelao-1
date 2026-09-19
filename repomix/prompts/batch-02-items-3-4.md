# AI Studio implementation prompt — batch 02, plan items 3–4

## Mission

Implement every requirement below end to end on the current accumulator branch. The cohesive focus
is **Plan items 3–4**. This prompt is self-contained: the feature definitions and retained implementation
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


### 3. Public vs. Private Project Access Control

**Final behavior:** Projects are partitioned into Public Commons (visible to all space members) or Confidential Workstations (membership-locked). Unauthorized members querying private projects receive a 404 Not Found to conceal the project's existence.

**Production acceptance contract:**
Production entry: `SpaceDO.listProjects/getProject`; spaces `/projects` routes.
Persistence/deployment: `projects.visibility`, `project_members`; SpaceDO migration v17.
Required observable verification: `launchpad-runtime.test.ts` plus confidential single-read/list tests; response is the same “Project not found” 404 as an absent id.

**Retained implementation constraints:**
- - **Storefront/connect_revenue prebuilt scripts and per-template bootstrap wiring** (the plan's
  WH4/WH7): the existing `storefront` prebuilt (Naelao-hosted catalog) and the `mcp-connector` +
  `revenue-tracker` prebuilts already cover "connect a 3rd-party revenue source" — no new
  connect_revenue mechanism was added on top, matching the reuse-don't-reinvent precedent this
  codebase follows elsewhere. Per-template auto-creation of a `business_wallet` PROJECT at
  bootstrap was not wired: `BUSINESS_FEATURE_KIND_REGISTRY.autoProvisionable` is (and was already,
  independent of this pass) a documented-but-unconsumed field platform-wide — nothing reads it to
  auto-create ANY feature-kind pro
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- ### 3. Public vs. Private Projects & Workspaces
The platform's project hierarchy cleanly separates **Public Company Commons** from **Confidential Workstations**:
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            COMPANY SPACE (ORGANIZATION)                     │
├─────────────────────────────────────────────────────────────────────────────┤
│ 🌐 PUBLIC PROJECTS (Visible to all space members)                           │
│ ├── 📁 Project: "Product Engineering" (Astro codebase, open to all devs)    │
│ ├── 📁 Project: "Marketing & Brand" (Social assets, open to whole team)     │
│ └── 📁 Project: "Customer Support" (Public FAQ bot, visible to all agents)  │
├─────────────────────────────────────────────────────────────────────────────┤
│ 🔒 PRIVATE PROJECTS (Encrypted & restricted to invited members only)        │
│ ├── 📁 Proje
- #### Core Architectural Blueprint
Multi-agent concurrency across shared workspaces is organized into a four-tier operational structure enforced by stateful edge actors:
```
┌───────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   THE 4-TIER COLLABORATION MODEL                                          │
├────────────────────┬─────────────────────────┬────────────────────────────┬───────────────────────────────┤
│ Tier Level         │ Audience & Visibility   │ Multi-Player Interaction   │ Workspace Write Permissions   │
├────────────────────┼─────────────────────────┼────────────────────────────┼───────────────────────────────┤
│ **Tier 1: Team**   │ **Public to Project**   │ Humans chat freely;        │ **Full Execution:**           │
│ **Room**           │ (All team members)      │ Agents answer on `

### 4. Project-Anchored Automation Architecture

**Final behavior:** Background automations and cron routines never float unattached at the root space level; every automation lives inside a specific project container (e.g. Stripe reconciler lives in `Project: Treasury`), inheriting a Git repo, testing harnesses, and access control.

**Production acceptance contract:**
Production entry: `requireManageableAutomationProject`; schedules/triggers/workflow dispatch.
Persistence/deployment: D1 `0073_project_scoped_automation.sql`; `SPACE_DO`, `WORKFLOWS`.
Required observable verification: project-automation and workflow-tier tests; missing/cross-tenant IDs fail before insert.

**Retained implementation constraints:**
- Required Fix: An operator project's container image (the same Tier-5 container-marketplace mechanism from Phase L, item 36, now with its first real, non- coming_soon catalogue entry: dev-sandbox , a container with git + a language runtime preinstalled) clones the operator's registered repository on first use and the workspace prebuilt's copy/move ops (G-BG09's neighbor, Phase R) are joined by workspace.git_commit / git_branch / git_diff ops, so every Dev agent change is a real, revertable git commit against a real branch (never directly against the operator's default branch — the Dev agent always works on a per-spec feature branch, merged only after G-BG05's gate passes), not a set of file w
- **Fix — a wallet-specific role resolver, not a change to the generic one:** the generic
`resolveEndUserBusinessRole`'s root-is-`"member"` shortcut stays untouched (sessions, projects,
threads all still need it). New `resolveWalletAccessRole` (`business-auth.ts`) instead: for a
space with no `parent_space_id` (the product root), returns `null` — no product_end_user has any
legitimate wallet access there, full stop; for a business (child) space, delegates to the same
real `business_memberships` lookup as everything else, so a business owner/admin still reads
their OWN business's wallet exactly as before. Wrapped in a new
`requireBusinessMembershipForWallet` middleware (its own 5s-TTL cache, ke
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- ### 4. Real-World Use Case: How a Founder Uses This
1. **Record a 60-Second Video:**
   The user opens their screen recorder, navigates to their municipal zoning portal, filters by "Commercial Permits", downloads a CSV, and says:
   > *"I'm searching for new permits in Miami, downloading the report, and filtering out residential projects."*
2. **Drop into Workspace:**
   They upload `permit_demo.mp4` into their `growth_engine` project.
3. **AI Learns the Skill:**
   The user types in chat:
   > *"Learn a new skill called `scrape_miami_permits` from `permit_demo.mp4` and schedule it as a Tier 3 Dynamic Workflow every Monday."*
4. **Autonomous Execution Forever:**
   The agent distills the video into `code.ts`, verifies it in Kitesurf, registers it as a reusable skill, and schedules it inside **Tier 3 Dynamic Workflows** to run every week without anyone touching a keyboard agai

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
