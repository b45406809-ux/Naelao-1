# AI Studio implementation prompt — batch 21, plan items 100–103

## Mission

Implement every requirement below end to end on the current accumulator branch. The cohesive focus
is **Scheduling, receipts, calendar connector, and slot mutex**. This prompt is self-contained: the feature definitions and retained implementation
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


### 100. Project-Universal, Bot-Attributed Scheduled Crons

**Final behavior:** Registered in `SpaceDO.project_scheduled_jobs`. Executes in clean Workflow contexts without inheriting bloated chat histories.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- The Gap Workers that need CF Cron Triggers (analytics aggregation, quota reset, key expiry cleanup) must declare `[triggers] crons` in wrangler.toml. Without this, the `scheduled` handler is dead code in production — it only runs during local `wrangler dev`.`
- **Tests:** `tests/unit/workflow-tier-routing.test.ts` (5 — dispatches to `workflowRunner.start`
instead of `codeRunner` and returns immediately without blocking; per-tenant isolation, i.e. two
different spaces' runs pass their own space/tenant, never a shared/fixed one; honest `ok:false`
degrade with no runner wired; a runner rejection surfaces as `ok:false` rather than throwing; an
ordinary `runtime:"isolate"` script is unaffected and still reaches `codeRunner`).
`tests/unit/internal-scripts-run-durable.test.ts` (5 — the new route's HMAC auth boundary: rejects
no token, wrong secret, tenant-header/body mismatch, missing `scriptName`; accepts a valid token
and forwards to the space's agent D
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- ### Real-World Example: A Non-Technical Dentist vs. The Engine
Look at how a non-technical dental clinic owner experiences the platform compared to what the engine is doing in the background:
| What the Non-Technical Dentist Does | What the Platform Executes Invisibly Under the Hood |
| :--- | :--- |
| **1. Dentist clicks:** *"Launch 24/7 Receptionist Template"*. | • `GenesisEngine` provisions `SpaceDO`, creates D1 tables, registers WhatsApp webhooks, and seeds clinic FAQs into Vectorize in 3 seconds. |
| **2. Dentist types:** *"Update our Friday hours to close at 2 PM instead of 5 PM."* | • Agent receives prompt, executes `patch_file` on `PROJECT.md` and calendar rules in Tier 1 SQLite FS, and creates commit `c_4f12`. |
| **3. Dentist sees an alert in chat:** *"Your assistant updated the booking rules. Click here to review."* | • A visual Pull Request card renders. The dentist sees a si

### 101. Compact Background Job Receipt Cards

**Final behavior:** Background jobs post a 2-line expandable notification card into the timeline; heavy terminal logs are offloaded to R2.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- 149. **A post-shipping pass over the SAME source list the 62-item plan came from
     (`long running.txt`, Google Drive) — it had been updated with fresh reports from live use
     AFTER those phases landed, so several items marked done were reported still broken. Ten real
     defects found and fixed, most of them the "fixed on one path, missed the other" class this
     file has now documented repeatedly.** Binary downloads corrupted (the knowledge worker read
     every response as text, so a PDF landed as mojibake — now reads bytes once and returns
     `encoding: "text"|"base64"`, refusing an oversized binary with 413 rather than truncating,
     since half a PDF is corrupt rather than
- The Gap: Builders building on Naelao have no visibility into planned features, timelines, or priorities. They cannot plan their product roadmaps around platform capabilities. No public roadmap exists. This creates anxiety for builders making long-term platform bets.
 Required Fix: Publish public roadmap at naelao.com/roadmap : board view with columns: "Now" (in development), "Next" (committed), "Later" (planned), "Considering" (not committed). Each card: feature name, description, category (Security, DX, AI, Marketplace, etc.), target quarter. Integration with feature request system (G-AS38): most-voted requests appear with vote counts. Builder dashboard: roadmap widget showing upcoming fea
- **Provisioner wiring:** `workers/provisioner/src/index.ts`'s `installLaunchpadAgents` (step 9)
now calls a new `installAgentTrigger` per installed agent: `schedule` → POST
`/spaces/:id/scheduled-jobs` with `agent_id` + a `goal` derived from the agent's own
`description` (`"Run your scheduled work per your role: ...; use script.find ...; distill a new
one when you succeed"`); `webhook`/`manual` → no-op (see decision 2 above). Best-effort — a
failed install logs and does not fail provisioning, same posture as the other non-critical
install steps (`spacedo_init_hook`, `workflow_templates`). `rollbackSpace` now also deletes any
`scheduled_jobs` rows for the space (PLATFORM_DB, not under the R2-p
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi

### 102. Pluggable Space-Shared Calendar Connector (`primary_calendar`)

**Final behavior:** Replaces rigid SQLite calendar silos with a standardized MCP connector alias (`primary_calendar`) binding to Google Workspace, Microsoft 365, or CalDAV.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- Required Fix: Extend ConnectorDefinition with provider: 'direct' | 'composio' | 'pipedream' and key_source: 'platform' | 'byo' . Curate an initial platform-keyed inventory chosen for the general autonomous Space Assistant and the free-tier business program: Google Maps/Places (prospect research), Gmail, Google Calendar, Google Sheets, Notion, Slack, LinkedIn, X, YouTube, GitHub. Catalogue stays exclusively Naelao-authored (same rule as SpaceTypes). mcp.register for a platform-keyed entry requires no credential_name — only the G-BF03 consent flow where the app needs a user account. The Space Assistant profile's system prompt names the inventory and the connect flow so the assistant can propos
- Tests: `tests/unit/whop-oauth-connect.test.ts` (12 tests) — authorize-URL construction (client
id, PKCE challenge method, redirect_uri, state), honest `oauth_not_configured` degradation when
the OAuth app isn't set up, a missing/unknown state ticket rejected with a clear message, the
full happy path (code exchange → vaulted tokens never appearing in the redirect → MCP server
upserted with the right `auth_type`/`auth_secret_name`), single-use ticket replay rejection, an
`error=` query param from Whop redirecting cleanly instead of 500ing, the refresh endpoint's HMAC
gate and token-rotation persistence, and mcp-hub's `resolveOAuthAccessToken` exercised directly
(fresh token passthrough, proact
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- ### Summary of What This Adds:
1. **Space-Wide Shared Calendar & State:** Hosted in `SpaceDO` SQLite; ensures that appointments, leads, and customer states are shared seamlessly across all project workstations without data silos.
2. **`kind: "voice_agent"`:** Deploys 24/7 AI phone receptionists using Cloudflare Calls (WebRTC) and Workers AI with zero external server infrastructure.
3. **Built-in Voice Dictation:** Adds native WhisperFlow-style voice-to-text directly inside the chat composer dock powered by Cloudflare's free edge Whisper model.
B7t since we have space wide mcp connector there is no need that means every project has access to the same mcp calendar. But we have to let agents know difference between space shared connector vs space wide user connect vs project specific
Establishing a clear **3-Tier Connector Scope Model** prevents cross-user account bleed and ensures the agen

### 103. 15-Second Edge Slot-Hold Mutex (`ConcurrencyDO`)

**Final behavior:** Ephemeral edge lock reserved during voice calls before external API execution, preventing double-booking during third-party API latency windows.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- 58. **Whop added as a second PLATFORM billing provider (AUDIT_TODO.md AI-7), replacing Lemon
    Squeezy as the FIRST-TRIED provider for builder platform plans and end-user subscriptions/
    credit-packs — LS stays as the fallback, item 45 is not reverted.** Trigger: the operator
    couldn't activate a Lemon Squeezy store because LS's own onboarding requires a Stripe-linked
    payout path unavailable in their country. Two genuinely different Whop relationships were
    built, neither the same as the invite-gated Platforms API (items 50-51, business-wallet
    sub-merchants) or the read-only "Connect with Whop" OAuth connector (item 53):
    - **Platform-plan checkout** (`packages/billing-
- Required Fix Add a cost/resource preview: (1) Before executing, estimate the plan's cost from per-node heuristics (expected LLM calls × avg tokens × model price + expected tool/API costs + sub-agent fan-out). (2) Check the estimate against the space's remaining budget; if it would exceed, require explicit confirmation or block. (3) Present the estimate (credits, est. duration, sub-agent count, external calls) for approval on high-cost plans (over a threshold). (4) Enforce a hard budget cap during execution (auto-pause at the cap, G-AE23). (5) After execution, compare actual vs estimated cost and feed the delta back to improve future estimates.
- Tests: `tests/unit/whop-wallet.test.ts` (13 tests — webhook signature verify/reject,
sub-merchant provisioning idempotency + honest error-status on missing key, cross-business
isolation on both balance-read and payout-request, webhook idempotent recording + unknown-
company skip + invalid-signature rejection, the full payout-approval state machine (pending →
emailed link → single-use execution → destination marked verified → a verified destination's
NEXT payout skips approval), insufficient-balance rejection, and a secret-hygiene check that the
master API key never lands in any D1 row). `tests/unit/reserved-capabilities.test.ts` updated to
assert Whop is now blocked as a direct-fetch host (p
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
