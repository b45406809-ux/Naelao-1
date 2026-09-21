# AI Studio implementation prompt — batch 17, plan items 80–84

## Mission

Implement every requirement below end to end on the current accumulator branch. The cohesive focus
is **Extensions, gadgets, daemons, tree-sitter, and MCP exposure**. This prompt is self-contained: the feature definitions and retained implementation
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


### 80. Cloudflare OS Stateful Gadgets

**Final behavior:** Living micro-applications built from prompts in 30 seconds, running inside Dynamic Worker isolates with private DO Facet SQLite DBs.

**Production acceptance contract:**
Production entry: `gadgetStorageKey` namespacing helper.
Persistence/deployment: tenant/space/project/gadget R2/DO prefix contract.
Required observable verification: canvas security test covers traversal/isolation key shape only.

**Retained implementation constraints:**
- Required Fix: Add optional COMPOSIO_API_KEY and PIPEDREAM_API_KEY Workers Secrets to mcp-hub. Key resolution per provider-routed server: (1) if the server row carries auth_secret_name , the builder's own vault credential wins (a builder running their own Composio project keeps full control and their own billing); (2) otherwise the PLATFORM key for that provider is injected server-side — the builder and end user never see it, never enter it; (3) if neither exists, fail with a clear "provider not configured on this platform" error. The platform key lives only inside mcp-hub (already the case for vault credentials — isolates receive only 60-second internal tokens). The reserved money-in tool-na
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
- 250 - 252
What about allowing user to build micro apps t Small, user-generated full-stack applications built by AI from natural language prompts, running in isolated V8 isolates with private SQLite databases
Utilizes a capability-based security model called Gatekeepers instead of raw API keys, enforcing granular, resource-level permissions so an agent's access never exceeds a human user's limits.
Allowing users to generate **Micro-Apps** on demand from natural language prompts—powered by private SQLite databases running in V8 isolates and protected by the **Gatekeepers capability-based security model**—is the holy grail of enterprise software.
Instead of paying $50/user/month for rigid SaaS tools (Jira, expensify, bespoke form builders), a user simply types:
> *"Build an internal Equipment Checkout app for our warehouse team with QR scanning and a private approval ledger."*
The AI ge

### 81. Plandex-Style Wasm Tree-Sitter Code Indexer Daemon

**Final behavior:** Navigates massive 20M+ token codebases by running `web-tree-sitter` in WebAssembly inside a Dynamic Worker, storing AST symbol graphs in SQLite.

**Production acceptance contract:**
Production entry: no production daemon.
Persistence/deployment: no AST graph SQLite schema/alarm.
Required observable verification: comments or file-search tests are not indexer evidence.

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
- The Gap
 Developer Space — The Agent Has wrangler CLI in the Container The Developer Space Code Agent deploys Naelao Apps using wrangler CLI inside the CF Container. Journey step 6 states: "Deploy Agent publishes: deploys MCP Worker via wrangler." This means the container running the code agent has access to a CLOUDFLARE_API_TOKEN that can deploy Workers to Cloudflare. This is one of the most privileged operations possible on the platform — a leaked or misused token can deploy arbitrary code to CF infrastructure. The spec treats this as a capability without specifying the security boundary. There are three critical unresolved questions: Which CF account does wrangler deploy to? If it deploy
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

### 82. Domain-Specific Durable Daemons (Active Services)

**Final behavior:** Background data engines combining stateful SQLite memory with autonomous workflow loops (e.g. Ledger Reconciler, Citation Grapher, Customs Matrix).

**Production acceptance contract:**
Production entry: `validateExtensionManifest`.
Persistence/deployment: declared permissions and bounded lifecycle contract.
Required observable verification: extension test checks retry/alarm bounds; worker journey required.

**Retained implementation constraints:**
- 73. **"Long-running background agent" was capped at 29 seconds — now genuinely unbounded — plus a
    replay-safety ledger, an honest `awaiting_approval` status, and an unauthenticated approvals
    surface closed. Driven by reading CF's own docs rather than this file's stale invariant.**
    - **The 29s cap.** `AgentTaskWorkflow` set `timeout: 29_000` on `run-agent`, the step that does
      all the work. **A CF Workflow step has NO wall-time limit** — only a CPU-time limit, which
      excludes time spent waiting on an LLM/tool/any I/O (`/workflows/reference/limits/`, verified
      2026-07). The ceiling was self-imposed and traceable to this file's own Key CF Invariants line
      claimin
- The Gap
 CF Durable Objects SQLite storage has a 1 GB limit per Cloudflare account, not per DO instance. The spec treats SpaceDO as if each space gets an unlimited personal SQLite database and stores threads, messages, memories, knowledge chunks, workflow definitions, and file metadata all in SpaceDO SQLite. With 100 active spaces the average per-space budget is 10 MB. A single space with a large knowledge base (5,000 chunks × 2 KB each = 10 MB) consumes the entire per-space budget. When the account-wide 1 GB limit is reached, all writes to all SpaceDOs fail simultaneously with no warning to the user.
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

### 83. Modular Extensions Architecture

**Final behavior:** Clean naming taxonomy: whole-space blueprints are **Templates**; atomic modular add-ons (daemons, viewports, tools) are **Extensions**.

**Production acceptance contract:**
Production entry: extension runtime helpers and template catalogue.
Persistence/deployment: versioned immutable extension manifests.
Required observable verification: extension security test covers declaration/enforcement.

**Retained implementation constraints:**
- 151. **A new 28-step goal batch (Google Drive `new/goal 1.txt`) is IN PROGRESS — the first
     tranche (steps 2, 3, 8, 9, 10, 12, 13a, 14, 19, 24) is BUILT, tested, and deployed.** The
     authoritative list is the user's Drive file (28 steps, item 1 = a Claude-Code-style
     context-window breakdown UI for the Stats tab; the finale = 6 business templates + business-
     wide BYOK). Shipped so far:
     - **Step 10 (spawn/consult model+agent validation):** `agent.spawn` validates each task's
       model against `ALLOWED_MODELS` before delegating — a wrong id gets a real "did you mean"
       (new `billing-core` `suggestModels`) instead of a silent escalation-clamp (which read as a

- Required Fix: Enforce at every path where template ids enter provisioning: business creation for end users ( createBusinessForEndUser , covering both the product-scoped route and reseller spaces) and builder product creation. Resolve the OWNING org's plan tier ( EntitlementsChecker.getTenantTier — end-user claims already carry the owning tenant); on the free tier, any requested template with free_tier_eligible !== true is rejected 403 plan_upgrade_required naming the offending templates. Empty template list ("Custom, build with the assistant") stays allowed — usage caps bound it. Unknown/missing tier resolves to free (fail closed). The shell's template catalogue projection carries free_tier_
- Tests: 5 new in `tests/unit/whop-wallet.test.ts` — onboarding-link capture + best-effort owner
notification, an owner with an existing Whop account provisioning straight to `active` (no link
needed), `GET balance` surfacing `onboarding_url` only while `awaiting_kyc`, a payout rejection
naming verification explicitly, and a live sync deriving `awaiting_kyc` from
`payouts_enabled: false` independent of Whop's own status string. 1823/1823 suite green,
`pnpm turbo run typecheck` clean (75 tasks), dashboard + shell both verified via `next build`.
**Not done:** the exact onboarding-link field name and full connected-account response shape
remain unverified against live Whop docs — confirm once Pla
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi

### 84. Auto-Generated Stateless MCP v2 Endpoints for Daemons & Gadgets

**Final behavior:** Automatically exposes `/mcp` endpoints wrapping internal SQLite schemas using Cloudflare MCP SDK v2.

**Production acceptance contract:**
Production entry: connector MCP is not gadget MCP.
Persistence/deployment: project-scoped tool schema/transport absent.
Required observable verification: requires standard MCP contract tests.

**Retained implementation constraints:**
- The Gap: When a builder exposes their Space as an API (via G-AQ32 OAuth or API keys), external developers integrating with the Space have no documentation. No auto-generated OpenAPI docs exist for a Space's public API. Builders must manually document their API, which is tedious and often not done.
 Required Fix: Auto-generate Space API documentation: GET /spaces/{id}/openapi.json returns OpenAPI 3.0 spec for the Space's public endpoints (agent run, conversation history, KB search, analytics read). Generated from SpaceConfig: agent definitions become endpoints; tool definitions become request schemas. Hosted docs: GET /spaces/{id}/docs renders Swagger UI. Builder can customize: description,
- - `workers/agents/src/connectors/oauth.ts` — generic OAuth2+PKCE helpers (not Whop-specific code;
  any future connector with a catalogue `oauth` spec reuses these): `generatePkce`,
  `buildAuthorizeUrl`, `exchangeCodeForTokens`, `refreshTokens` (Whop rotates the refresh token on
  every use — the new one is always persisted, the old one never reused), and a KV-backed
  single-use OAuth ticket (`issueOAuthTicket`/`consumeOAuthTicket`) mirroring the codebase's own
  stream-ticket precedent: a short-lived, server-held, single-use ticket rather than putting a
  PKCE verifier or any credential in a browser-navigable URL.
- New `ConnectorDefinition.oauth` field (`catalogue.ts`): authorize/token U
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- ### 4. Implementation: The Auto-MCP v2 Factory for Micro-Apps
Using Cloudflare's `@cloudflare/mcp` and `createMcpHandler`, the runtime wraps any DO Facet SQLite table into an MCP server automatically [1.2.2, 1.2.6]:
```typescript
// workers/spaces/src/engine/AutoMcpFactory.ts
import { createMcpHandler } from "@cloudflare/mcp";
export function generateMcpServerForMicroApp(
  appId: string,
  doStorage: DurableObjectStorage,
  tableSchema: Record<string, string> // e.g. { name: "string", status: "string", returnDate: "string" }
) {
  return createMcpHandler({
    tools: {
      // 1. Auto-generated List/Query Tool
      [`app_${appId}_list`]: {
        description: `Query and filter records in the ${appId} micro-app database.`,
        parameters: {
          filter: { type: "string", description: "Optional SQL WHERE clause" },
          limit: { type: "number", description: "Max records t

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
