# AI Studio implementation prompt — batch 05, plan items 20–24

## Mission

Implement every requirement below end to end on the current accumulator branch. The cohesive focus
is **Runtime SDK, vault, WriteGuard, and virtual CLI**. This prompt is self-contained: the feature definitions and retained implementation
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


### 20. Universal Runtime SDK (`ctx`)

**Final behavior:** Injected typed API namespace (`fs`, `project`, `space`, `vault`, `cli`, `browser`, `connectors`) giving scripts programmatic control over the workspace.

**Production acceptance contract:**
Production entry: isolate harness and `createRuntimeContext`; production code runner injects scoped proxies.
Persistence/deployment: no secret persistence in ctx; service bindings stay in host.
Required observable verification: code-runner/runtime tests execute scripts against ctx and assert omitted unavailable capabilities.

**Retained implementation constraints:**
- Required Fix: Add optional COMPOSIO_API_KEY and PIPEDREAM_API_KEY Workers Secrets to mcp-hub. Key resolution per provider-routed server: (1) if the server row carries auth_secret_name , the builder's own vault credential wins (a builder running their own Composio project keeps full control and their own billing); (2) otherwise the PLATFORM key for that provider is injected server-side — the builder and end user never see it, never enter it; (3) if neither exists, fail with a clear "provider not configured on this platform" error. The platform key lives only inside mcp-hub (already the case for vault credentials — isolates receive only 60-second internal tokens). The reserved money-in tool-na
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
- ### 4. The `AVOS_SDK.d.ts` Reference Injected into the Agent Prompt
The agent receives this clean, complete TypeScript definition file in its context. Because LLMs are trained on millions of lines of TypeScript, **giving it standard types produces syntactically flawless code on Turn 1**:
```typescript
/**
* AVOS RUNTIME ENVIRONMENT DEFINITIONS (v2.0)
* Available in all Isolate CodeMode (Tier 2), Workflows (Tier 3), and Container (Tier 6) scripts.
*/
declare namespace ctx {
  namespace fs {
    function read(path: string, opts?: { offset?: number; limit?: number }): Promise<{ content: string; totalLines: number }>;
    function edit(path: string, oldString: string, newString: string): Promise<{ ok: boolean; message: string }>;
    function write(path: string, content: string): Promise<{ ok: boolean; bytesWritten: number }>;
    function grep(pattern: string, path?: string): Promise<{ matc

### 21. Universal Vault Layer with Edge Outbound Workers

**Final behavior:** Zero-leak secret injection. Application code refers to logical credential names; Outbound Workers inject decrypted `Authorization` headers at the edge network boundary.

**Production acceptance contract:**
Production entry: credentials worker + MCP/security outbound path.
Persistence/deployment: encrypted credential rows; `CREDENTIALS_WORKER`, encryption secret.
Required observable verification: credential/MCP tests assert scripts see logical names only.

**Retained implementation constraints:**
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
- ### 3. The Zero-Leak Secret Injection Protocol
To ensure that API keys (Stripe secrets, GitHub tokens, database passwords) **never leak into the LLM context or conversation logs**:
1. Secrets live encrypted in `space_credentials` (AES-256-GCM).
2. The agent writes code referring only to the **credential name** (`ctx.vault.fetchWithAuth` or `ctx.mcp.call`).
3. The Cloudflare Worker injects the decrypted secret at the **edge network boundary** during the outbound fetch. The script code never holds `const key = "sk-live-..."`.
```typescript
// How the agent writes a script using vault credentials safely:
export async function run(args: any, ctx: any) {
  // The SDK automatically resolves 'STRIPE_API_KEY' inside the Worker runtime.
  // The secret is injected into the Authorization header at the network hop!
  const response = await ctx.vault.fetchWithAuth("https://api.stripe.com/v1/charges"
- ### 2. Outbound Workers & WriteGuard: Zero-Trust Security at the Edge
When an agent writes code in Tier 2 CodeMode or executes scripts in Tier 6 Containers, you cannot give the script open internet access or direct database delete privileges.
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                   OUTBOUND WORKER & WRITEGUARD PROXY                        │
│                                                                             │
│ [ Agent CodeMode Script / Container Tool Execution ]                        │
│                 │                                                           │
│                 ├──► Outbound HTTP Fetch (e.g. `fetch("https://api.stripe.com")`)
│                 │          │                                                │
│                 │          ▼                                                │
│

### 22. WriteGuard Mutation Interceptor

**Final behavior:** Edge proxy parsing SQL ASTs and tool parameters, blocking destructive operations (`DROP`, `DELETE *`, `rm -rf`) unless authorized by signed capability tokens.

**Production acceptance contract:**
Production entry: security gateway, tool runtime, virtual CLI and connector mutation gates.
Persistence/deployment: capability nonce/audit storage; `SECURITY_GATEWAY`.
Required observable verification: WriteGuard/adversarial tests cover SQL, shell, encoded parameters and invalid grants.

**Retained implementation constraints:**
- The Gap: The spec does not define how builders invite team members to collaborate on their Spaces. No invitation flow, role assignment (owner, editor, viewer), or permission enforcement per role exists. BuilderDO has no team membership concept.
 Required Fix: Add team model to BuilderDO SQLite: CREATE TABLE team_members (member_id TEXT, role TEXT CHECK(role IN ("owner","editor","viewer")), invited_by TEXT, joined_at INTEGER, status TEXT) . Invitation: generate signed token (HMAC-SHA256, 48-hour expiry), email invitee, on acceptance add member row. Role enforcement: Worker middleware checks team_members before write operations — viewers get 403 on mutations. Owner can transfer ownership. Cas
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
- ### 2. Outbound Workers & WriteGuard: Zero-Trust Security at the Edge
When an agent writes code in Tier 2 CodeMode or executes scripts in Tier 6 Containers, you cannot give the script open internet access or direct database delete privileges.
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                   OUTBOUND WORKER & WRITEGUARD PROXY                        │
│                                                                             │
│ [ Agent CodeMode Script / Container Tool Execution ]                        │
│                 │                                                           │
│                 ├──► Outbound HTTP Fetch (e.g. `fetch("https://api.stripe.com")`)
│                 │          │                                                │
│                 │          ▼                                                │
│

### 23. Virtual CLI Interception Engine

**Final behavior:** Terminal commands (`stripe`, `gh`, `r2`, `jq`) run in <5ms inside V8 Isolates by intercepting binary calls and mapping them to edge REST fetches or Wasm.

**Production acceptance contract:**
Production entry: tool runtime virtual CLI dispatcher.
Persistence/deployment: registered command catalog in DO SQLite.
Required observable verification: virtual CLI tests cover parse, dispatch and tenant scope.

**Retained implementation constraints:**
- 90. **"Can't change assistant configs" root-caused to a one-word role check — and verifying the fix
    against production surfaced THREE more real bugs, including an infinite refetch loop that had
    been silently blanking the Dashboard. Plus the QClay-style composer dock and two real settings
    pages.**
    - **The reported bug.** `apps/shell`'s Dashboard gated every config control on
      `business?.role === "admin"` — an EXACT match. Whoever creates a business is inserted as
      `'owner'` (`workers/spaces/src/business-routes.ts`), and the backend ranks
      `owner(3) >= admin(2)` (`business-auth.ts`'s `ROLE_RANK`), so the server would have accepted
      every write the UI never o
- Required Fix
 Never pass secrets as container env vars. Use a scoped credential-retrieval endpoint:
```typescript
// Container fetches a short-lived, request-scoped token from an internal endpoint
// instead of receiving raw keys:
// GET http://credentials.internal/get?provider=stripe&runId=...
// returns a signed token valid for seconds, scoped to this run and provider.
const token = await fetch(`http://credentials.internal/get?provider=${p}&runId=${runId}`,
 { headers: { "x-run-attestation": runAttestation } }).then(r => r.text());
```
If env injection is unavoidable, mount secrets as a read-only tmpfs file with restrictive permissions and clear them after the command, and disable shell h
- **Scope correction, mid-phase, from the user directly:** a "Product" is not a storefront or any
commerce concept — the spec is explicit: *"NaelaoProduct is the core data model representing a
Tier 1 builder's deployed product. It wraps a configured Space."* (Section 48). The spec's own
examples are LexSpace/CodePilot/FirmAI — a legal tool, a coding tool, a law-firm tool — matching
the user's own analogy exactly. Journey 1B ("End User Joins a Builder's Product") describes
precisely the rich shell this phase builds: *"the product UI — threads, sub-spaces, knowledge
base — exactly as the builder configured it."* Nothing commerce-related appears in that journey
at all. Journey 2 ("Space Admin Set
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi

### 24. Just-In-Time (JIT) Virtual CLI Synthesis

**Final behavior:** When an agent encounters an unregistered CLI command, it synthesizes a 15-line parser using `ctx.cli.register`, compiling it into SQLite for instant future invocations.

**Production acceptance contract:**
Production entry: `VirtualCli.registerSynthesized`, script library.
Persistence/deployment: versioned parser source in SQLite/R2.
Required observable verification: synthesis tests reject eval/import and prove reload persistence.

**Retained implementation constraints:**
- initSchema() creates all 8 SQLite tables without error on fresh DO
 initSchema() is idempotent — calling twice does not error or duplicate tables
 DO ID format: must include spaceId, projectId, threadId — missing any returns error
 spaceId mismatch in run() request returns 403 immediately
 runFiber() registers fiber in SQLite fibers table BEFORE execution starts
 runFiber() updates fiber status to 'complete' after successful execution
 runFiber() updates fiber status to 'failed' if execution throws
 onFiberRecovered() called with snapshot restores execution from last ctx.stash()
 ctx.stash() persists iteration count and sessionId — recoverable after eviction
 executeAgentLoop() crea
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
- Check on web  articles and docs etc on Hermes ai bot modes architecture from when the bots reply to bit groups etc how do we add that to projects and will it work with the 4vtier thread architecture plus if they share workspace how will that work plus how to give each bor it's own identity thits ow agent.md etc all those and many I didn't mention here find rhem

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
