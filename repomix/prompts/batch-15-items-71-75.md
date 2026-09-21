# AI Studio implementation prompt — batch 15, plan items 71–75

## Mission

Implement every requirement below end to end on the current accumulator branch. The cohesive focus
is **Model certification, LoRA, local inference, air-gap, and sleep**. This prompt is self-contained: the feature definitions and retained implementation
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


### 71. Vertical-Scoped Certified Model Whitelist (`whitelist_only`)

**Final behavior:** Server-side validation rejecting any model not certified for that vertical template, guaranteeing compliance in medical and legal spaces.

**Production acceptance contract:**
Production entry: reasoner/model selector.
Persistence/deployment: agent/project policy config.
Required observable verification: model override tests do not prove vertical whitelist-only enforcement.

**Retained implementation constraints:**
- // Temple: LexSpace — full configuration
const TEMPLE_LEXSPACE: Temple = {
 id: 'temple-lexspace-v1',
 name: 'LexSpace',
 tagline: 'AI legal research and drafting — compliance-first',
 category: 'vertical-legal',
 spaceType: 'verticals',
 suggestedPricing: { type: 'seats', pricePerSeat: 15000, trialDays: 0 }, // $150/seat/month
 defaultAuthProvider: 'saml-sso',
 productConfig: {
 allowPublicSignup: false,
 requireAdminApproval: true,
 featureFlags: {
 'matter-management': true,
 'immutable-audit-trail': true,
 'citation-verification': true,
 'document-compare': true,
 'privilege-log-generator': true,
 },
 userPermissions: {
 canCreateProjects: true, // Matters = projects
 canCreateSubSpaces:
- - **G-BF02 — platform Composio/Pipedream keys in mcp-hub.** `COMPOSIO_API_KEY`/`PIPEDREAM_API_KEY`
  optional Workers Secrets; new `resolveProviderApiKey` — a BYO vault credential (`auth_secret_name`)
  still WINS when present (a builder running their own provider project keeps control + their own
  billing); otherwise the platform key is injected server-side and never leaves the worker; neither
  → honest 503 `provider_not_configured`. A BYO declaration that resolves to no key errors clearly
  (400) instead of silently falling back — fallback would mask the misconfiguration and bill
  Naelao's provider account. Applied to both provider branches (tools-list + tool-call); the
  reserved money
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- ### 3. Server-Side Enforcement (The Compliance Gate)
A compliance rule cannot just be a UI hiding trick. If someone tries to send an API request with an unallowed model via curl or the developer API, **the server must reject it**.
In `workers/agents/src/index.ts` and `NaelaoAgentDO.ts`:
```typescript
// Inside /agent/run route (workers/agents/src/index.ts)
export function validateModelForSpacePolicy(
  requestedModel: string,
  spaceModelPolicy?: VerticalModelPolicy
): { valid: boolean; reason?: string } {
  // If template has no restrictive policy, allow platform default allowlist
  if (!spaceModelPolicy || spaceModelPolicy.mode !== "whitelist_only") {
    return { valid: isAllowedModel(requestedModel) };
  }
  // Enforce the vertical whitelist strictly
  const isWhitelisted = spaceModelPolicy.allowedModelIds.includes(requestedModel) ||
                        (requestedModel.startsWit

### 72. Private LoRA Model Dynamic Edge Loading

**Final behavior:** Routes `custom/*` model calls through AI Gateway, dynamically injecting company LoRA weights onto base models at edge runtime.

**Production acceptance contract:**
Production entry: no custom-model route with enforced weight boundary.
Persistence/deployment: no certified LoRA binding or deployment config.
Required observable verification: no LoRA routing boundary test exists.

**Retained implementation constraints:**
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
- ### 2. How Cloudflare Infrastructure Powers This at Low Cost
You do not need a dedicated $10,000/month GPU server. You leverage Cloudflare’s native stack:
1. **R2 Training Buckets:** The raw unstructured documents and the synthesized `dataset.jsonl` files live in your project's R2 workspace.
2. **Workers AI Edge Synthesis:** Lightweight models (`@cf/meta/llama-3.2-3b-instruct`) run in parallel isolates to clean, deduplicate, and format raw text into clean training prompt-completion pairs.
3. **Cloudflare Workers AI LoRA Adapters:** Instead of training a 70B model from scratch, the system trains a **LoRA adapter (typically 20MB–100MB)** on top of base models like Llama 3.1 8B. Cloudflare loads these adapters dynamically on their edge GPUs at inference time.
4. **Cloudflare Workflows (`ModelTrainingWorkflow.ts`):** Manages the multi-hour training, loss-curve monitoring, and automated bench
- ### 4. UI Experience in `ModelSelector.tsx`
When a doctor or lawyer opens the **Model Selector (`ModelSelector.tsx`)** in their space, the dropdown **only renders their certified vertical models and private fine-tuned weights**:
```
┌─────────────────────────────────────────────────────────────┐
│ 🏥 Clinically Vetted Models (Hospital Policy Locked):       │
├─────────────────────────────────────────────────────────────┤
│ • 🧠 Clinica Llama-8B v1.2 (Fine-Tuned on Hospital EHRs)  ⭐ │
│ • ⚡ Llama 3.3 70B (Cloudflare HIPAA Edge Gateway)          │
│ • 🔬 Claude 3.7 Sonnet (Clinical Research & Pharmacology)   │
├─────────────────────────────────────────────────────────────┤
│ 🔒 Other foundation models are disabled by space policy.    │
└─────────────────────────────────────────────────────────────┘
```

### 73. Sovereign Enterprise Air-Gapped Local AI Engine

**Final behavior:** Connects on-premise GPU clusters running Ollama / vLLM via `LocalTunnelDO` over encrypted WebSockets with zero cloud data egress.

**Production acceptance contract:**
Production entry: local tunnel connect and local-machine prebuilt.
Persistence/deployment: hibernating WebSocket DO.
Required observable verification: local tunnel tests cover token isolation, not local AI E2E.

**Retained implementation constraints:**
- The Gap: Government, defense, and highly regulated enterprises cannot use cloud SaaS due to data sovereignty requirements. No private or air-gapped deployment option exists. These enterprise segments are entirely inaccessible as customers.
 Required Fix: Design self-hosted deployment package: Docker Compose / Kubernetes Helm chart with all Naelao services containerized. Replace CF-specific APIs: Durable Objects → Redis/SQLite; Queues → RabbitMQ; R2 → MinIO; KV → Redis; Analytics Engine → ClickHouse; Workers → Node.js/Fastify. Publish migration shim layer that maps CF SDK calls to self-hosted equivalents. Provide Terraform modules for AWS/Azure/GCP. Enterprise license with SLA. Air-gapped in
- **Benchmark runner** (`infra/scripts/run-eval-suite.mjs`, dependency-free Node, manual dispatch
only — costs real tokens, not wired into CI): loads a JSONL dataset, finds-or-creates the named
suite via the real `/evals` API (never touches a worker directly — goes through
`NAELAO_API_BASE`/`NAELAO_TENANT_TOKEN` like any other authenticated caller), reads the suite's
LAST stored result BEFORE running again, runs it in `mode=agent`, and exits non-zero when
`avg_score` regresses by more than `--threshold` (default 0.5) versus that prior run — the
regression gate the plan called for, without yet wiring it into CI (no live deployment to point
it at in this pass — see the top-level the established architecture discus
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- 301 - 303
What about allowing companies to download and run models on local machine on ollama or other local llm models runner and connect ollama to their space
This is one of the most requested features for **Enterprise, Legal, Defense, and Healthcare** clients: **The Local / Air-Gapped On-Premises AI Runner**.
Many companies are legally prohibited (under HIPAA, GDPR, or defense contracts) from sending sensitive prompts over the internet to third-party AI APIs (Anthropic, OpenAI, Google). They also already have expensive on-premise hardware (Mac Studio M3/M4 Ultras, RTX 4090 workstations, or local NVIDIA H100 clusters) running **Ollama, vLLM, LM Studio, or llama.cpp**.
Because your codebase **already has `LocalTunnelDO` (`workers/agents/src/do/LocalTunnelDO.ts`) and the `local-agent` daemon**, enabling local Ollama clusters to power their Cloudflare workspace is a natural extension of t

### 74. Strict Air-Gapped Space Compliance Lock

**Final behavior:** Router-level block physically preventing any request from reaching external cloud AI APIs when compliance lock is engaged.

**Production acceptance contract:**
Production entry: required central egress policy gate absent.
Persistence/deployment: required immutable space compliance setting/audit absent.
Required observable verification: no external-fetch denial journey test exists.

**Retained implementation constraints:**
- Required Fix: Audit high-subrequest paths in Space Workers. Mitigation: (1) Batch Analytics Engine writes: accumulate multiple events and write in a single multi-row batch call. (2) Batch external tool calls: if agent invokes multiple external APIs, fan out via single fetch with parallel sub-streams rather than N sequential fetches. (3) Cache DO reads: cache SpaceDO config reads in Worker memory for request duration to avoid repeated DO RPC calls. (4) Instrument subrequest counting via proxy wrapper on fetch(). (5) Alert when any request path exceeds 500 subrequests (50% threshold). Track max_subrequests_per_request in Analytics Engine.
- **The gap:** Slack's webhook verifier (`channels.ts`) already rejects requests older than 300s
(replay defense-in-depth on top of the primary control — the `(session, direction, external_id)`
unique-index dedupe in `channel_messages`, `NaelaoAgentDO.ts` — and per-space secret scoping,
which blocks cross-business replay). Email, Discord, and WhatsApp had no freshness check at all:
a captured, validly-signed webhook for any of these three channels could be replayed indefinitely
and would still verify.
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- ### 5. Enterprise Security: The "Air-Gapped Space" Lock
In **Space Settings**, enterprise admins can enable **`Air-Gapped Mode`**:
```typescript
export interface EnterpriseCompliancePolicy {
  airGappedOnly: boolean; // When true: ALL cloud AI APIs (Anthropic/OpenAI/Workers AI) are blocked
  allowedLocalTunnels: string[]; // Whitelisted on-prem GPU machine IDs
}
```
* **The Guarantee:** If `airGappedOnly === true`, the router and `NaelaoAgentDO` **physically refuse** to dispatch calls to any external cloud URL. If the local Ollama machine goes offline, the system halts with a security alert rather than silently falling back to a cloud model.

### 75. Finite Task Project Auto-Sleep

**Final behavior:** When the Project Journal Task DAG hits 100% completion, Durable Objects clear all alarms and hibernate at $0 cost.

**Production acceptance contract:**
Production entry: project journal and ToolSandbox idle alarm.
Persistence/deployment: durable Git/R2/SQLite plus alarms.
Required observable verification: idle tests do not prove project completion cleanup.

**Retained implementation constraints:**
- **Explicit signals — no new ingestion.** `agent_activity_log` (item 40) already carries
`event_type`/`tokens_used`/`cost_credits`/`created_at` for every run completion/failure and
approval request — exactly what error rate and avg/total cost need. New `GET /spaces/:spaceId/
agent-signals?project_id=&window_hours=` (SpaceDO's `computeAgentSignals`, builder-only, same
gate as `agent-activity`) rolls it up on read: `runs_total/completed/failed`, `error_rate`,
`avg_cost_credits`, `total_cost_credits`, `approvals_requested`. "Regenerations" (a proxy for the
user hitting retry) is computed in application code — 2+ run events on the SAME thread within 5
minutes — rather than a SQL window function,
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- ### Summary
1. **Finite Projects Sleep Automatically:** Projects built for a single task (like building a website or auditing a contract) **shut down their alarms and sleep at $0 cost** the second the journal hits 100%.
2. **Context-Aware Connector Selection:** The agent defaults to **Personal accounts in private 1-on-1s** and **Shared company accounts in public team channels**, with a clear visual pill in the chat bar.
3. **Enterprise Power with Consumer Simplicity:** Non-technical users get a clean, human-friendly experience with simple buttons and previews, while all Git versioning, container promotions, and database isolations run invisibly at the edge.
- #### Turn 2: Self-Scheduled Delayed Wake-Up (When Waiting is Required)
* **Goal:** *"Send cold audit emails and follow up in 24 hours."*
* The agent drafts and dispatches the outreach emails on Turn 1.
* It does **not** sit awake burning CPU. It calls the `schedule.wake_me` tool [1.3.4, 1.3.17]:
  ```typescript
  await ctx.run("schedule.wake_me", {
    delayMinutes: 1440, // 24 Hours
    goal: "Check response status for Miami Dental outreach batch and follow up."
  });
  ```
* The Durable Object sets a native **Cloudflare Alarm (`this.ctx.storage.setAlarm`)** and **completely hibernates at $0 cost** [1.2.5].
* Exactly 24 hours later, Cloudflare fires the alarm, the agent wakes up with the goal in hand, checks the inbox, and takes the next step.

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
