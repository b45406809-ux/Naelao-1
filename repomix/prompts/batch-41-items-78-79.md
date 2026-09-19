# AI Studio implementation prompt — batch 41, plan items 78–79

## Mission

Implement every requirement below end to end on the current accumulator branch. The cohesive focus
is **Plan items 78–79**. This prompt is self-contained: the feature definitions and retained implementation
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


### 78. Canvas-First / Domain Viewport Architecture

**Final behavior:** The workspace canvas is the primary product; chat is secondary. Center canvas mounts live code editors, redliners, or financial grids.

**Production acceptance contract:**
Production entry: shell project page and `PROJECT_KIND_MANIFESTS`.
Persistence/deployment: project config/workspace.
Required observable verification: canvas security tests cover contracts, not layout E2E.

**Retained implementation constraints:**
- 129. **Investigated the reported "no credits dialog with 5000 credits" bug thoroughly — all four
     distinct billing gates were confirmed HEALTHY for the account at investigation time; most
     likely a timing issue, not a live code bug. Plus three real, independently-reported UI/UX
     gaps, all fixed: mobile sidebars unreachable, the Message/text-tab button missing from the
     composer dock, and the verification email carrying no usable link.**
     - **Credits-dialog investigation.** Read-only (zero LLM cost, via a temporary service-bound
       worker mirroring items 128/62's own established technique) checks against all FOUR
       distinct `insufficient_credits`/`quota_exceeded`
- The Gap: When Stripe or an LLM provider updates their API (new required fields, changed response schemas), the platform's Worker code breaks silently. No contract tests exist to catch provider API changes before they reach production.
 Required Fix: Implement consumer-driven contract tests (Pact.js): Workers define expected request/response contracts for each external API call (Stripe PaymentIntent create, OpenAI chat completion, CF AI inference). Contract stubs run in CI instead of live APIs. On provider API change: contract test fails, alerting to necessary code update. Publish contracts to Pact Broker (self-hosted on CF Workers). Run contract verification weekly against provider sandbox
- First concrete step of the full-vision plan (Naelao → Builder → End User, end user gets the
launchpad-6-mockup agentic workspace; see the established architecture item 30 for the complete phased plan A-E).
Phase A had two deliverables: a shared design system, and a running end-user shell app that can
resolve a product, sign an end user up or in, and render the manifest-driven chrome — no chat yet
(that's Phase B).
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi

### 79. The 7 Foundational Project Kinds

**Final behavior:** Standardized project archetypes: `product_dev`, `doc_studio`, `voice_agent`, `customer_bot`, `model_studio`, `growth_engine`, `app_studio`.

**Production acceptance contract:**
Production entry: `PROJECT_KIND_MANIFESTS`.
Persistence/deployment: project kind config rather than tenant schemas.
Required observable verification: `canvas-extension-security.test.ts` asserts the exact seven.

**Retained implementation constraints:**
- 193 - 195
No in the venture templates channels are  for the owner is to access their assistant on WhatsApp telegram etc just like in vertical cowork but for connecting whatapp bots discord bots telegram bits etc like those customer service automations let's keep them under projects of kind=customer bots users can configure such projects to do customer service automations and even the execution ladder for these projects is lower to avoid security threats.
With this I realize there should be more project kinds besides customer bots and using plugins each will have different UI plus there should be project templates for each kind
- ### 4. The UI Canvas Viewport (`ModelStudioCanvas`)
Inside `apps/shell/src/components/ProjectKindPanel.tsx`, projects of `kind: "model_studio"` render a dedicated **ML Research & Training Viewport**:
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 🧠 MODEL STUDIO: "Acme Customer Support Llama-8B (v1.2)"                    │
├─────────────────────────────────────────────────────────────────────────────┤
│ 📊 Training Status: [ COMPLETED & DEPLOYED ]       🎯 Eval Accuracy: 96.4% │
├─────────────────────────────────────────────────────────────────────────────┤
│ 📁 Dataset Pipeline:                                                        │
│ • Raw Ingested Documents: 142 files (PDFs, Markdown, Zendesk CSVs)          │
│ • Synthesized Training Pairs: 8,420 JSONL prompt-completion pairs           │
│ • Validation Split: 1,000 test cases (Zero contaminatio
- ### 5. Adding `kind: "app_studio"` to the Project Kinds
Add this to `packages/events/src/business-feature-kinds.ts`:
```typescript
export const APP_STUDIO_KIND: BusinessFeatureKind = {
  kind: "app_studio",
  label: "Micro-App & Tool Studio",
  description: "Prompt-to-application engine: generates sandboxed full-stack apps with private SQLite databases and Gatekeeper security.",
  singleton: false,
  minCreationRole: "editor",
  autoProvisionable: false,
  viewportComponent: "AppStudioCanvas", // Live app runner + SQLite table viewer
  allowedLadderTiers: [1, 2],           // Isolate execution only
  domainSystemPrompt: `You are a Micro-App Synthesis Specialist.
Generate clean HTML/Preact frontends and Hono backend routes using private in-DO SQLite tables.
Always declare explicit Gatekeeper permission grants for required resources.`,
  linterRules: ["sql-injection-check", "gatekeeper-s
- # 4. How the Entire Flow Works Together
Here is a real-world scenario demonstrating how these three features connect across the platform:
1. **Customer Inbound Voice Call (`kind: "voice_agent"`):**
   A client calls the clinic's phone number. The Cloudflare Calls edge agent answers, checks doctor availability, and books a 3:00 PM appointment for *"John Doe"*.
2. **Atomic Shared State Write (`SpaceDO`):**
   The voice agent writes to `space_calendar_events`. Instantly, `WsHubDO` broadcasts the event.
3. **Cross-Project Awareness (`doc_studio` & `ops_dispatcher`):**
   The clinic's doctor opens their **Document Studio (`doc_studio`)** workstation on desktop. The 3:00 PM appointment is already populated in their patient schedule panel.
4. **Voice-to-Text Dictation (`ComposerDock`):**
   The doctor clicks the 🎙️ **Voice Button** in chat and says:
   > *"Draft John Doe's clinical p

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
