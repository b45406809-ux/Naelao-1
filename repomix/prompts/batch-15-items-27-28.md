# AI Studio implementation prompt — batch 15, plan items 27–28

## Mission

Implement every requirement below end to end on the current accumulator branch. The cohesive focus
is **Plan items 27–28**. This prompt is self-contained: the feature definitions and retained implementation
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


### 27. Gatekeeper Capability-Based Cross-Subspace Delegation

**Final behavior:** Cross-department tool access is governed by cryptographically signed, attenuated tokens specifying allowed resource IDs and expiration timestamps.

**Production acceptance contract:**
Production entry: Gatekeeper/capability verifier and SpaceDO check.
Persistence/deployment: grants + revocation/nonce data; platform signing secret.
Required observable verification: tamper, expiry, wrong-resource and sibling isolation tests.

**Retained implementation constraints:**
- The Gap: CF Zero Trust is referenced for admin tool protection but no spec exists for: device posture checks (is the admin's device up-to-date?), service token rotation for machine-to-machine admin calls, or audit logging of all admin tool access. SOC 2 CC6.3 (multi-factor authentication) and CC6.6 (threat detection) require these controls.
 Required Fix: Configure CF Zero Trust policies for admin tools: (1) Device posture: require CF WARP client installed + OS version check + no malware detection — enforced via Zero Trust device policy; (2) Service tokens: machine-to-machine calls to admin Workers use CF Service Tokens with 90-day rotation schedule (automated via CF API in a Workflow); (3)
- `NaelaoAgentDO.enforceRunGates`'s existing `BUILDER_CALLER_ROLES` branch (the builder-chatting-
with-their-own-Space-Assistant scope — P0-3's exact scoping, re-used verbatim) now ALSO checks the
new infra-credits quota alongside the pre-existing llm-tokens one, same fail-open-on-transient-
error / 402-`error_code: "infra_quota_exceeded"`-on-confirmed-over-cap posture. **Deliberately NOT
extended to project-scoped or signed-in-product-end-user runs** — those already have their own
separate wallet/project-spend-cap/credit-balance gates (project_spend, ProductUserDO credits),
which are a fundamentally different metering axis (currency-like spend) from this one (a resource-
consumption ceiling);
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- ### 2. The "Gatekeepers" Capability-Based Security Model
The fatal flaw of traditional plugins and AI-generated apps is **Raw API Keys**:
* If an AI micro-app is given a master API key, a malicious prompt or buggy script can query other departments, read executive emails, or drain company funds.
**Gatekeepers replaces API keys with Unforgeable, Attenuated Capability Tokens.**
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    THE GATEKEEPER SECURITY PROTOCOL                         │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. THE HUMAN PERMISSION CEILING (Invariant #1)                              │
│    An agent or micro-app can NEVER hold more power than the human who       │
│    created it. If Alice is a "Member" (no refund authority), any micro-app  │
│    Alice builds is physically incap

### 28. 3-Tier Connector Scoping

**Final behavior:** Integrations are partitioned into `Space-Shared` (company Stripe), `Project-Bound` (support WhatsApp), and `User-Personal` (Alice's private Gmail).

**Production acceptance contract:**
Production entry: connector directory/resolver.
Persistence/deployment: scoped credential and connector rows; credentials/MCP bindings.
Required observable verification: connector hierarchy tests prevent broader fallback from shadowing a narrower binding.

**Retained implementation constraints:**
- Required Fix: Three feedback channels, each reusing existing infrastructure rather than inventing new ingress: (1) the existing multi-channel gateway (Slack/Discord/email/WhatsApp, item 11 of the established architecture) already lets a customer-bot project ingest a support channel — an operator project subscribes its PM agent to the SAME channel catalogue, tagged feedback_source instead of support_source ; (2) a new product-analytics prebuilt script reads the operator's OWN deployed product's event stream (via a builder-supplied read-only analytics connector — PostHog/Amplitude/Mixpanel MCP servers already fit the existing mcp-connector pattern, BYO-key per the universal-tools doctrine's own carve-out for a b
- Why Whop, not Stripe/Lemon Squeezy (researched before building, not assumed): Whop is a
registered payment facilitator that supports programmatic SUB-MERCHANT enrollment (create an
isolated company per business via API, no per-business OAuth flow) and a programmatic WITHDRAWAL
API (241+ territories, bank/crypto/Venmo/CashApp) — the same custody shape Stripe Connect's
Express accounts have (Whop, like Stripe, holds the money and runs payout compliance; Naelao's
integration surface is provisioning, balance/status reads, and withdrawal requests only), but
`createSubMerchant` doesn't require the builder to click through a hosted onboarding page first —
it can be called automatically the instant
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- ### 1. The 3-Tier Connector Scope Taxonomy
```
                                  ┌──────────────────────────────────────────────┐
                                  │           MCP CONNECTOR SCOPE MODEL          │
                                  └──────────────────────┬───────────────────────┘
                                                         │
         ┌───────────────────────────────────────────────┼───────────────────────────────────────────────┐
         ▼                                               ▼                                               ▼
┌─────────────────────────────────┐             ┌─────────────────────────────────┐             ┌─────────────────────────────────┐
│ 🏢 1. SPACE-SHARED CONNECTOR    │             │ 👤 2. USER-PERSONAL CONNECTOR   │             │ 📁 3. PROJECT-SPECIFIC CONNECTOR│
│ `scope: "space_shared"`         │             │ `scope: "user_per

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
