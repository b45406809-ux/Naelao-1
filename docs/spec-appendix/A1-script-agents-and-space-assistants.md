# Appendix A1 — Script-First Agents & Space Assistants

**Status:** Normative appendix to the original specification
(`naelao_expanded_gaps_resolved.html`).
**Scope:** This appendix records design *additions* adopted during implementation. It does
**not** fork or replace the original spec. Everything here layers on top of the spec's
existing primitives — `NaelaoAgentDO`, `SpaceDO`, and `SpaceTypeManifest` — and is wired
through the **Launchpad** space type (§11) first, then the other space types later.

> **Why this appendix exists.** The first build pass was scoped against the niche document
> `naelao_whop_businesses_spec.html`, on the assumption we were only shipping the Whop
> niche. We have since decided to build the full product as the original spec describes,
> **starting with the Launchpad SpaceType**. The script-first engine and Space Assistants
> introduced during the niche pass are genuinely useful and are retained — but they are
> additions, documented here, not a competing architecture.

---

## A1.0 Architectural ground rules (unchanged from the original spec)

These are restated so the additions below cannot be read as overriding them:

1. **Agents are their own Durable Object.** `NaelaoAgentDO` (original spec §G-D01–G-D20) is
   the agent runtime: ReAct loop, FSM, tool dispatch, 30 s timeout watchdog, SQLite-
   persisted run state. The agent loop lives here — **not** inside a per-product/per-niche
   DO. Addressed as `space:project:thread`.
2. **`SpaceDO` owns product structure.** Threads, messages, members, sub-space grants,
   billing, and **`agent_definitions`** live in `SpaceDO` SQLite. SpaceType differences live
   in config / agent definitions / manifests — **never in DB tables**.
3. **A project is a grouping of threads within a space.** Not a sub-space, not a workspace.
   Addressing is `space:project:thread`; `threads.project_id` is a nullable grouping key.
4. **SpaceTypes are configurations of one set of primitives.** Launchpad, Sites, Verticals,
   Enterprise, Workers, Mini-AGI differ by `SpaceTypeManifest` + agent definitions, not code.

> **Correction recorded:** the niche pass implemented a monolithic `BusinessDO` that
> re-implemented the agent loop *and* threads/sub-spaces/projects. That conflation is being
> decomposed: the agent loop returns to `NaelaoAgentDO`, space structure returns to
> `SpaceDO`, and the script engine becomes a *behavior module* the agent DO runs (A1.1).

---

## A1.1 Addition: the Script-First Engine (agent behavior)

**What it is.** A behavior strategy an agent runs *inside* `NaelaoAgentDO` — not a new DO.
The loop:

```
OBSERVE → FINGERPRINT → FIND → GATE → EXECUTE → VERIFY → DISTILL
```

with a four-level escalation ladder:

| Level | Meaning | Cost |
|------:|---------|------|
| L1 | Run a matching registry script directly | cheapest |
| L2 | Cheap patch of a drifted script (small/fast model) | low |
| L3 | Full re-derivation of a broken script | medium |
| L4 | Live first-principles reasoning, then **distill** a new script | highest |

**Script registry.** Each agent keeps a flat, name-based registry of parameterized scripts
(`name`, `description`, `code`, `fingerprint_schema`, `parameters`, `required_credentials`,
stability stats). Proven scripts are promoted to a shared registry → **cross-agent learning**
(a new agent starts with what the fleet already figured out). Auto-demotion pulls a falling
or chronically-patched script out of L1 candidacy.

**Relationship to the spec's ReAct loop.** ReAct (spec §G-D01) is the *outer* loop; the
script-first ladder is a *tool-selection + skill-distillation strategy* the agent uses
within it. They compose: the ReAct planner decides *what* to do; the script ladder decides
*how* cheaply to do it and captures the result as a reusable skill (Voyager, Wang et al.
2023).

**Credential safety.** A distilled script may declare `required_credentials: string[]`.
Before L1 execution, missing credentials raise a HITL approval that opens a credential-entry
form; script code never embeds secrets. Credentials resolve through the credentials worker
(AES-256-GCM, per-space key via HKDF, short-lived HMAC token).

**Safety floor.** Every L4 (free-form) goal passes a template-agnostic safety floor before
any live action, independent of the niche/template.

---

## A1.2 Addition: Manifests & the Capability Kernel

**Manifest = data, not code.** A niche, a custom business, and a Space Assistant are the
*same* engine loaded with a different **manifest**: a bundle of prebuilt skills, seed
scripts, instructions, capabilities, and (for assistants) channels. Adding a niche =
adding a manifest.

**Capability kernel.** A fixed vocabulary of capabilities a manifest may declare; anything
outside the set is rejected at module load. This prevents manifests from inventing powers
and keeps space types from forking into separate codebases (original spec appendix
@3614922).

**Mapping to the spec.** A manifest is the concrete, in-code expression of a
`SpaceTypeManifest`'s `tools` + `systemPromptTemplate` + seed behavior for one
template/agent definition. The Launchpad core agent definitions (§11) are authored as
manifests.

---

## A1.3 Addition: Space Assistants (the "glorified agent")

The original spec's "Space Assistants — Full OpenClaw Architecture" is realized as an agent
whose manifest has `kind: "assistant"` plus:

- **Channel adapters** (email / Slack / Discord) behind a uniform adapter interface, with
  **per-(channel, channel_user_id) sessions** (never per channel type — that bleeds users).
- A **heartbeat**: on a schedule the assistant drains unanswered inbound messages, drafts a
  grounded + moderated reply, and **escalates honestly** when unsure rather than guessing.

It is the same `NaelaoAgentDO` runtime — only the bundle (channels + heartbeat skill +
instructions) differs. No separate codebase.

**Nightly dispatch.** The scheduler dispatches by `manifest_kind`: `assistant` →
heartbeat (drain channel queue); niche/custom → the agent cycle.

---

## A1.4 Additions carried from the niche pass that remain valid as-is

These are infrastructure and apply regardless of DO topology; they move with the engine
into `NaelaoAgentDO`:

- **CF AI Gateway is mandatory for every LLM call** (original spec §15): all calls route
  through `gateway.ai.cloudflare.com/v1/{account}/{gateway}/anthropic/...` with
  `cf-aig-metadata` (spaceId/userId/agentId/model) for per-tenant analytics + caching.
  Canonical factory: `workers/agents/src/shared/ai-client.ts`.
- **CF Workers AI binding** for free-tier agents and sub-agent vision.
- **Per-agent LLM provider config (BYOK)**: `llm_provider ∈ {platform, cf-workers-ai,
  byok-anthropic}`.
- **Free tier**: no custom (L4) business on free; Launchpad templates are free; free agents
  default to Workers AI and act autonomously (tier 2) so the AI earns and covers cost.

---

## A1.9 Commerce, business services & the "always get our cut" guarantee

The point of friction the builder raised: *a builder must not be able to tell their agent
"write a Stripe script with my key" and route income around Naelao.* Settled structurally
via **reserved capabilities** (`workers/agents/src/script-engine/reserved-capabilities.ts`):

- **Money-in is reserved.** `RESERVED_CAPABILITIES` (checkout, charge, payout, wallet, …) may
  only be provided by Naelao's **prebuilt `commerce` script**, which holds the Lemon Squeezy
  store credentials (Workers Secret) and bakes in the platform fee (`naelaoFeeBps`).
  `ScriptToolSurface.create/update` **fail closed**: a user/agent script that references an
  external payment host (Stripe/PayPal/… *and* `api.lemonsqueezy.com`), embeds a payment SDK,
  or declares a reserved capability/domain is rejected. Builders keep full freedom to author
  delivery, marketing, storefront-UI, and email scripts — just not the wallet. 9 unit tests.
- **Business services are Naelao-provided multitenant prebuilts** (so the assistant never has
  to shop third-party tools): `commerce`, `storefront`, `business-email`. All manifest-gated
  via `productConfig.commerce` / `productConfig.businessServices`; the provisioner merges them
  into installed agents (`businessServicePrebuilts`). A builder may still author their own
  scripts for anything except the income wallet, and may opt into a custom domain.
- **Storefront = one multitenant surface, not a Worker-per-tenant** (corrects the early
  "dynamic-worker" wording). Confirmed against Cloudflare for SaaS docs: a CF **Pages** static
  shell fronted by the portal **Worker as fallback origin**, routing by `Host` header.
  `storefront.provision` allocates `{slug}-{id}.naelao.com` (covered by the zone wildcard cert
  — no per-tenant cert) and registers a `portal-host:{host}→spaceId` KV route; custom domains
  use the CF for SaaS `custom_hostnames` API (DV cert, customer CNAMEs to the fallback origin).
- **Commerce data model** (`0035_commerce.sql`) is a generic, manifest-gated primitive:
  `launchpad_products`, `launchpad_orders` (idempotent on `provider_event_id`),
  `business_services`. Owner CRUD + revenue rollup in the spaces worker (gated on
  `commerce.enabled`); the LS webhook writes the order + platform fee and wakes the fulfilment
  agent with the `order_id`. Dashboard: `/dashboard/spaces/{id}/commerce` (products, orders,
  revenue).
- **Lemon Squeezy is the processor for all three payer classes** (all wired): customers
  buying products (checkout→order→fulfilment), Naelao builders' plans, and a builder's
  space-members/seats. Seat billing = `productConfig.memberBilling { enabled, seatPriceCents,
  lsVariantId, interval }`; the billing worker's `/internal/seats/checkout` runs the seat
  charge through Naelao's store (reserved money-in, fee applies), and the LS webhook activates
  the member in SpaceDO + records the fee in the revenue rollup. `commerce.seat_checkout` lets
  the assistant mint a join link.
- **Storefront rendering (multitenant)**: the portal-router Worker is the CF-for-SaaS fallback
  origin. `GET /storefront` resolves the Host against `business_services` (naelao_handle or
  custom_domain), renders the published-product storefront, and `POST /storefront/checkout`
  initiates the reserved money-in checkout (redirect to Lemon Squeezy). Service bindings wired
  (portal→billing, billing→spaces, agents→billing).

## A1.10 Connector layer, federated learning, webhooks & template bootstrap — BUILT

**Connector catalogue (`workers/agents/src/connectors/catalogue.ts`).** "Whop first, everything
else coming soon" as Naelao-authored DATA. Whop is `available` (bearer auth, MCP endpoint, read/write
ops, webhook spec, **no money-in**); 20+ creator-economy platforms (Gumroad, Skool, Beehiiv,
Substack, Cal.com, Etsy, Vapi/Twilio/ElevenLabs voice, Zendesk/Intercom support, …) are
`coming_soon`. Reached through `mcp-connector`/`mcp-hub` — adding one is a catalogue row + its shim,
never a code branch. Connect flow: `POST /connectors/:platform/connect` stores the key in the vault
+ registers the MCP server. (Whop's MCP shim itself is the remaining piece to make it *live*.)

**Federated template learning (`script-engine/federation.ts`, A1.9 vision).** A template is a
living shared skill library (`templates/{id}/scripts/…`). `promoteSkill` copies a *proven* space
skill (stability ≥ 0.8, ≥ 5 successes) up to the shared library (health reset — it earns its own
fleet record); `inheritTemplateSkills` pulls it down into spaces without clobbering a space's own
learned version. Endpoints: `/skills/promote`, `/skills/inherit`, `GET /templates/:id/skills`.

**Generic inbound-webhook normalizer (`connectors/webhook-normalizer.ts`).** One ingress for any
platform's webhooks: HMAC-verify (secret from the vault) → normalize to a common envelope → wake the
agent via `/script/run` (same path as cron + Lemon Squeezy). Public route
`/v1/connectors/:platform/webhook/:spaceId` (signature is the auth). Each platform's signing/shape is
a `WebhookSpec` on its connector — data, not code.

**Template bootstrap (the "as you start, everything is set up" flow).** A template carries
`bootstrap`: first-run `prompts` (credentials to connect + preference questions), initial `projects`,
and `setup_scripts` the Space Assistant runs on start. Prebuilt agents are already installed by the
provisioner (`template.agents`). `GET /templates` exposes this for the onboarding wizard.
*Still to wire: the provisioner actually executing bootstrap on provision (create projects, run
setup scripts, inherit shared skills) + the dashboard onboarding wizard UI.*

**Voice agents & customer service.** Both are the SAME engine, not new SpaceTypes. **Customer
service** = the Support agent profile + channels + KB grounding, shipped as the `customer-service`
template (+ Zendesk/Intercom support connectors). **Voice agents** = the same agent reached over a
*voice channel connector* (Vapi/Twilio/ElevenLabs, catalogued `coming_soon`): the connector handles
telephony/TTS, the agent reasons over the transcript and calls scripts. No special-casing — voice is
a channel, support is a profile.

## A1.11 Execution substrate, multi-channel gateway, Memory OS & sub-agents — BUILT

This closes the three gaps identified by comparing our Space Assistants against OpenClaw
(execution agency) and Hermes Agent (self-improving, memory-first agents): the engine could
*design* Tier 2-5 work and channel ingress but not yet *run* them, and had procedural memory
(skills) without episodic/semantic memory or a self-managed memory tool.

**Execution ladder Tiers 2-5 — `script-engine/code-runner.ts`.** Implements `TieredCodeRunner`
for real:
- **Tier 2/3** — a CF Worker Loader (`[[worker_loaders]]` binding `LOADER`) spins up a fresh V8
  isolate per `script.run` call. Stored code is a single module exporting `run(args, ctx)`; the
  runner appends a small `fetch` harness around it. Tier 3 best-effort resolves bare-specifier
  imports from `esm.sh` as extra virtual modules (there is no real "npm install" inside an
  isolate — documented as a real limitation, not papered over).
- **Tier 4** — the same isolate, with `ctx.browser.navigate(...)` injected, proxied to the
  pre-existing `naelao-browser` Worker (CF Browser Rendering + SSRF guard) via a new
  `BROWSER_WORKER` service binding. Agents still never get raw CDP.
- **Tier 5** — `ToolSandboxDO`'s container harness (`container/server.mjs`) gained a generic
  `POST /exec { code, args }` route (esbuild-bundle → import → call `run(args,{})`), alongside
  its existing `/build` route for the legacy micro-tool gate.
- Wired into `NaelaoAgentDO.buildScriptEngineEnv` as `env.codeRunner`; degrades tier-by-tier,
  never crashes, when a binding is absent.
- New prebuilts **`browser-use`** (navigate/click/type/extract/screenshot, Tier 4) and
  **`code-exec`** (`execute_python`/`execute_bash` → Tier 5; `run_js` → Tier 2, codemode) ship
  in the Default Naelao Agent. `run_js` re-applies the reserved-capability guard at call time
  (ad hoc code bypasses `script.create`, so it must not bypass the money-in guard too).

**Multi-channel gateway — `launchpad/channels.ts` + the new public ingress.** The
`ChannelAdapter` interface (normalize/format) already existed; this pass added the missing
half — **verified, public ingress**: `verifySignature()` per channel (Slack HMAC-SHA256,
Discord Ed25519, email HMAC/Mailgun-style), a public route
`POST /v1/channels/:channel/inbound/:spaceId` (router registers it before the JWT gate, same
pattern as the connector webhook), and `POST /channels/:channel/connect` to store the signing
secret in the vault + mark `channel_links` (the heartbeat cron's discovery roster,
`0038_channel_links.sql`). `NaelaoAgentDO` gained `channel_sessions`/`channel_messages` tables
(per-(channel, channel_user_id) sessions — two Slack users never bleed into one thread) and a
`/channels/heartbeat` route that drains the unanswered queue through the **same script-first
loop** `/script/run` uses (goal: draft + send a reply via `notify.<channel>`, or reply exactly
`"ESCALATE"` rather than guess). The hourly cron now also calls `runChannelHeartbeats()`.
Channels are an *ingress*, not a parallel reply mechanism, per CLAUDE.md's "channels are
scripts."

**Memory OS — `script-engine/memory-os.ts`.** Layer 3 (Structured Facts: entity/relation/
attribute triples, `trust_score`/`decay_rate`) and the episodic feeder for Layer 5 (Vectorize
semantic recall), both scoped by `user_id` (empty-string sentinel = space-level) so shared-
assistant mode can never merge two users' memories (the "Shared Agent Mode Memory Namespace
Collision" gap). `runMemoryMaintenance()` — called from the same hourly heartbeat sweep —
**applies decay** (trust_score shrinks per `decay_rate` per day of inactivity, pruned below a
floor: "decay_rate field defined but never applied" + "grows without bound," both fixed),
**promotes** high-importance unpromoted episodic notes into Vectorize ("episodic→semantic
promotion has no trigger," fixed), and prunes the unbounded episodic log to a retention cap.
The new **`memory` prebuilt** (`memory.remember` / `memory.recall` / `memory.forget`) is the
missing Hermes pattern — the agent can explicitly write/query memory mid-task instead of it
being something only the host silently injects — and ships in every agent by default.
Layers 1 (Workspace/R2) and 2 (Sessions/FTS5) already existed; Layer 4 (Fabric, cross-session
LLM-driven consolidation) and Layer 6 (LLM Wiki) remain open (A1.5).

**Sub-agents — real spawn/receive/terminate.** `NaelaoAgentDO.buildOrchestrationHooks()`
implements the `OrchestrationHooks` the `sub-agent` prebuilt already called (previously always
"unavailable" — no host had wired them). `agent.spawn` accepts a **batch** of tasks
(`{ tasks: [{goal, budget_tokens?, model?}, ...] }`) and spawns them **concurrently** via
`Promise.all` against sibling `NaelaoAgentDO` instances (`idFromName(`sub:{spaceId}:{subId}`)`)
— see A1.12 for why batching is the chosen shape for parallelism here. Each child gets its own
budget (`budget_tokens` → a coarse step ceiling via `budgetToMaxSteps`, never inherited from
the parent — fixes "Sub-Agent Token Budget Not Isolated From Parent"); spawning is `await`ed
synchronously inside the parent's own request, so a child can never be orphaned by the parent's
response completing first (fixes "Sub-agents have no parent-liveness link" structurally, not by
polling); a fleet-wide batch cap (`MAX_SUB_AGENTS_PER_SPAWN = 16`, deliberately the same order
of magnitude as Claude Code's own subagent fan-out) bounds the blast radius (fixes "No
Account-Level Parallelism Ceiling"); every child's output is wrapped in
`<untrusted_subagent_result>` and moderation-scanned before the parent ever sees it (fixes
"Sub-Agent Output Schema Enforcement" — output is data, never instructions). `agent.receive`
polls the new `sub_agents` table; `agent.terminate` marks a row terminated; `agent.send` is
intentionally a no-op explainer (children run to completion synchronously in this build —
fan out another batch instead of messaging a "running" one).

## A1.12 Vertical / specialized agents & sub-agent fan-out — how it composes

**A vertical agent is a Profile, not a new code path.** "Customer service agent," "voice
agent," "legal-vertical agent," "sales-outreach agent" are all the SAME `NaelaoAgentDO` +
script engine, configured by the 4-file agent config (`agents.md`, `system-prompt.md`,
`scripts.json`, `skills.json`) that `script-engine/profiles.ts` composes. Specializing an
agent is choosing: (1) which **prebuilt scripts** it's allowed (`scripts.json.prebuilt`,
e.g. a voice agent enables a voice channel connector + `notifications`; a coding agent enables
`code-exec` + `browser-use`; neither needs the other), (2) its **system prompt** (role/domain/
tone), (3) its **behavioral rules** in `agents.md` (escalation thresholds, `requires_approval_for`),
and (4) its **skills.json** knowledge docs. None of this is a fork of the engine — adding a new
"kind" of agent is authoring a Profile (`launchpadAgentToProfile`-style function) or a Template
`bootstrap.agents` entry (A1.10), never a new DO class or a new loop.

**Where this composition happens:** `SpaceTypeRegistryDO`'s manifest → `provisioner` installs
the space's `agent_definitions` → each one is realized as a Profile → written out as the 4 R2
files under `spaces/{spaceId}/agents/{agentId}/`. A builder configuring a vertical agent via
the dashboard is choosing prebuilt-script checkboxes and filling in prompt/instruction fields
— never writing code (the platform's standing security requirement).

**Sub-agents vs. specialized agents — different axes.** A *specialized agent* is a long-lived
identity (own R2 config, own thread history, own escalation rules) a builder configures once.
A *sub-agent* (A1.11) is ephemeral — spawned mid-task by another agent's `agent.spawn`,
addressed `sub:{spaceId}:{subId}`, runs one goal to completion, and is gone. A specialized
agent's *work* can itself fan out into sub-agents (e.g. a "research agent" Profile whose
`agents.md` instructs it to `agent.spawn` one sub-task per source); the two concepts compose
freely.

**Why batched `agent.spawn` instead of N separate spawn calls (Claude Code parity, adapted).**
Claude Code's own multi-agent pattern is: an orchestrator issues several `Task` tool calls in
one assistant turn, and they run in parallel because nothing blocks between them — "send one
message with multiple Task tool calls," explicitly *not* serial spawn-then-wait-then-spawn.
Our `OBSERVE→FINGERPRINT→FIND→GATE→EXECUTE→VERIFY→DISTILL` loop's GATE→EXECUTE step issues
**one** `script.run` per turn (`ReasonDecision` is a single `run`/`patch`/`distill`/`answer`/
`give_up`), so N separate `agent.spawn` calls across N turns would be serial, not parallel —
the loop has no batched-tool-call concept the way a chat-completions tool-use turn does. The
fix that preserves the loop's one-decision-per-turn shape while still delivering real
concurrency: `agent.spawn` itself accepts an **array** of tasks and the host fans them out
together via `Promise.all`. One tool call, N children running concurrently — functionally
equivalent to Claude Code's "one message, multiple Task calls," expressed as the loop's single
op rather than a batch of ops. `MAX_SUB_AGENTS_PER_SPAWN = 16` deliberately mirrors the rough
scale Claude Code runs at, not picked arbitrarily.

**What this does NOT yet do (open, tracked):** incremental streaming of a sub-agent's progress
back to the parent before it finishes (spec gap "Sub-Agent Results Block Parent"); a real
per-token meter for `budget_tokens` (today it's a coarse step-count proxy, documented as such);
`parentAgent()`/notify-parent-of-progress for long-running children; an account-level (not
just per-spawn-call) concurrency ceiling across a tenant's *simultaneous* sub-agent trees.

## A1.5 Open follow-ups (tracked, not yet built)

- **Credential hierarchy**: per-user (default) + per-space (shared, e.g. company email) +
  per-privileged-user overrides.
- **MCP as scripts**: agents never connect to MCP directly; they write/use scripts that wrap
  MCP providers (Pipedream, Composio).
- **Member/seat billing**: Lemon Squeezy billing for a builder's space-members (the third
  payer class) — the customer-purchase and builder-plan paths are done.
- **Storefront render + CF for SaaS apply step**: the portal Worker serving the multitenant
  storefront UI from the `portal-host` route, and the zone-scoped `custom_hostnames` API call
  (the data model + route registration + DNS instructions are built).
- **Space collaboration**: roles, task boards, and project deduplication (admin's assistant
  broadcasts "this already exists" to member assistants). **Settled in A1.8** — assistant is
  the operator over shared `ProjectDO` state (locks + presence + dedup), not a per-user fork.
- **Reseller / `tenant` membership**: `parent_tenant_id` account hierarchy + wholesale
  invoicing + client-portfolio dashboard (spec G-AS34/G-AS35). Schema landed (`productConfig`);
  the billing subsystem is a separate build — see A1.8.

---

## A1.7 Authoritative reconciliation — Script-First is the agent model (not an addition)

> **Correction (this pass).** Earlier passes (and an earlier version of this appendix) framed the
> script-first engine as an *addition* layered on a ReAct/hardcoded-tools `NaelaoAgentDO`. Reading
> the spec top-to-bottom, the **bottom appendix "Script-First General Agent Architecture" (byte
> ~6672k) is authoritative** and *replaces* the early agent framing. It is the agent model, not an
> add-on. This section records the binding facts; the engine is implemented in
> `workers/agents/src/script-engine/`.

**The 6-op tool surface (complete).** `script.create(name, code, metadata)`, `script.read(name)`,
`script.update(name, patch, reason)`, `script.delete(name)`, `script.find(query, fingerprint?)`,
`script.run(name, params)`. There are **no** other hardcoded tools. Browser, filesystem, API,
container, comms and MCP are **scripts**, not built-ins.

**The loop.** `OBSERVE → FINGERPRINT → FIND → GATE → EXECUTE → VERIFY → DISTILL`. The reasoning
model participates only in GATE→DIAGNOSE/REASON and DISTILL. OBSERVE/FINGERPRINT are themselves
scripts. Escalation ladder L1 (run match) → L2 (cheap patch) → L3 (re-derive) → L4 (live reason +
distill). Token spend scales with novelty, trending toward ~0 as the library matures.

**Skill library (R2).** `spaces/{spaceId}/scripts/{name}/` → `SCRIPT.md` (current metadata),
`code.ts` (current code), `versions/v{n}.ts` + `v{n}.meta.json` (full history, never overwritten).
`ScriptMetadata` carries identity, retrieval (`description`, `embedding_vector`, `tags`),
preconditions (`fingerprint_schema`, `preconditions`), `parameters`, `calls` (skill graph),
`requires_tier`, and health (`success_count`, `failure_count`, `patch_history`, `stability_score`).

**`script.find`.** Embed query → Vectorize ANN (top-K 10) → filter by `fingerprint_schema`
compatibility + `domain` → sort by `stability_score × semantic_similarity` → top 3 with confidence.
Confidence < 0.5 ⇒ treat as no match ⇒ Level 4. This is Naelao's native "skill that finds skills".

**Execution ladder (auto-routed by `requires_tier`).** T1 direct R2 (file ops, fingerprint reads);
T2 V8 isolate / Dynamic Worker (TS, HTTP fetch, web-search, call_api); T3 npm (isolate + package
resolution); T4 CF Browser Rendering (DOM, click/fill/screenshot — via `naelao-browser` proxy,
agents never get raw CDP); T5 Container / SandboxDO (Python, bash, native bins, multi-container via
`mountBucket`). The agent calls `script.run`; the orchestrator picks the tier.

**Agent config = 4 R2 files** under `spaces/{spaceId}/agents/{agentId}/`: `agents.md` (identity +
behavioral/escalation rules), `system-prompt.md` (role/domain/tone), `scripts.json`
(`prebuilt[]`, `space_scripts[]`, `agent_scripts:"auto"`, `startup_observe`), `skills.json`
(SKILL.md knowledge docs loaded into context). **Profiles** compose these: Default Naelao Agent,
Code, Browser, Vertical Niche, Cowork Desktop, Community/Marketplace.

**Prebuilt catalogue.** Infra: `r2-workspace`, `sandbox-container`, `dynamic-workflow`,
`sub-agent`. Browser: `browser-use`, `vision-delegate`. Data/compute: `web-search`, `code-exec`,
`knowledge-base`, `file-manager`. Comms: `notifications`, `mcp-connector`. Launchpad subset
(this build, browser deferred): `r2-workspace`, `web-search`, `file-manager`, `knowledge-base`,
`notifications`, `sub-agent`, `dynamic-workflow`, `commerce`, `storefront`, `business-email`,
`mcp-connector`.

**MCP without hardcoded tools — BUILT (the connector layer).** `mcp-connector` prebuilt script:
`mcp.register(name, url, auth_type?, credential_name?)`, `mcp.list_servers()`,
`mcp.list_tools(server)`, `mcp.call(server, tool, params)`. It bridges the agent's 6-op surface to
the `naelao-mcp-hub` worker (registry + SSRF guard + `tools/list`/`tools/call` proxy). A connector's
secret is stored in the encrypted **credentials** vault (AES-256-GCM, per-space HKDF key); the hub
resolves `auth_secret_name` → plaintext at call time via a short-lived HMAC credential token — the
agent never sees it. **Every external platform (Whop, Gumroad, Beehiiv, Cal.com, Etsy, …) is an MCP
server registration + distilled wrapper scripts — not a hardcoded integration.** Reserved-capability
guard applies twice (prebuilt + hub, defense-in-depth): you may not register a payment processor as a
connector, nor call a tool whose name is money-in — income stays on the reserved commerce path.
(The MCP **Apps marketplace** — discovery, 3rd-party billing, security review — remains on hold; the
connector mechanism itself is live.)

**No community SpaceTypes.** SpaceTypes are Naelao-authored only (spec byte ~896493). Community
publishes **Apps** (MCP) or **Space Templates**. Provisioning is the **10-step transactional
provisioner** (byte ~899k): manifest from `SpaceTypeRegistryDO` (KV-cached) → init SpaceDO → platform
DOs → R2 prefixes → space-type init → workflow templates → external portal → custom (n/a, community
retired) → **Space Assistant init** → record install; rollback via `deprovisionSpace` on any failure.

**Billing.** Lemon Squeezy primary, Stripe future (Appendix H, byte ~2261k); provider-agnostic
`BillingProvider` + `NormalizedBillingEvent`. Launchpad order trigger = Lemon Squeezy webhook.

**Two monetization models coexist (A + B), keyed on where the sale happens (mutually exclusive
per sale, so one space can run both):**
- **(B) Storefront model** — sale happens *on Naelao* → LS checkout → Naelao takes `naelaoFeeBps`.
  Reserved-capability guard applies (money-in only via the prebuilt commerce script).
- **(A) Automation-layer model** — sale already happened *on a connected platform* (Whop/Gumroad/…)
  reached via `mcp-connector` → the agent only *reads* the order and does the labor (fulfil, support,
  market) → Naelao monetizes via the subscription/seat, **not** a transaction fee. The reserved guard
  is irrelevant because money never touches Naelao. The connector tool guard still forbids using a
  connector to *collect* money (that would be model B, which must go through commerce).

---

## A1.6 Cross-reference

- Engine/manifest narrative: `docs/LAUNCHPAD_ARCHITECTURE.md`
- Custom-business path: `docs/CUSTOM_BUSINESS.md`
- Original spec section index: `docs/SPEC_HEADER_INDEX.md`

---

## A1.8 Company topology, membership & the reseller (SaaS) model

This section settles the "is it built for humans or agents?" / "what is a worker?" /
"how do two users collaborate?" / "can my customers create their own businesses?"
questions. All of it is grounded in the original spec — citations inline.

### The hierarchy (corrected notation)

A **business = a top-level Space** (Launchpad SpaceType). One user can own **many**
businesses = many top-level spaces, reached via a **space switcher**. **Sub-spaces are
departments** *within* one business — never businesses themselves (spec §72 Mini-AGI,
Enterprise data grants keyed by `sub_space`).

```
Space (= business)
├── Space Assistant          ← coordinator / interface; NOT a container of projects
├── Projects                 ← groupings of threads (the "task system")
│   └── Threads
│       └── Agents run here  (addressed space:project:thread)
└── Sub-spaces (departments) ← each is itself a Space with its own Assistant + projects
```

The assistant is a **sibling coordinator at the space level**, not a parent of projects.
Agents live *in threads*. This mirrors Polsia's proven three layers (chat-agent
strategist → task system → specialized agents); we add departments-as-sub-spaces and a
script-native agent, so we are strictly more capable than a flat model.

### The assistant is the operator, not the company

Spec §05 (byte ~116k): *"One assistant per user per Space by default. Admin can raise
this limit."* The **company state is shared** and space-level — `SpaceDO` (members,
structure, billing) + `ProjectDO` workspaces (file **locks**, **version history**,
**real-time presence**, byte ~399k/§12) + threads + KB. Each user's assistant
(`assistants/{userId}/`, byte ~411k) is a personal chief-of-staff acting **on** that
shared company — it is **not** a private fork of the company. Two members' assistants do
not build two companies because they read/write the *same* `ProjectDO`. Coordination =
file locks + presence + **project deduplication** (admin's assistant broadcasts "this
already exists"). This resolves the "two assistants = two companies" concern.

`assistantMode` (productConfig knob): `per-user` (default; best permission scoping +
personal channels) or `shared` (single space-owned assistant — Polsia-style one CEO chat;
the "admin lowers the limit" variant).

### Two distinct populations — team vs customers (the SaaS boundary)

- **Team members** = people invited into the space → `SpaceDO` members with roles
  (owner/admin/editor/member). They operate the business, each gets an assistant, appear
  in the org chart.
- **Customers (SaaS)** = people who sign up via the **external portal**
  (`authModel: "customer-auth"`) → portal customer records gated by **Lemon Squeezy**
  entitlements. They are **NOT** `SpaceDO` members, have no assistant, are not in the org
  chart. **Hard rule: never make product customers into SpaceDO members** — that collapse
  is what turns a clean business into "everyone is staff."

### "Customers create their OWN businesses" = the reseller model (spec G-AS34/G-AS35)

What the builder described — *customers join my product to create their own businesses,
Polsia-style* — is the spec's **Agency / White-Label Reseller program** (byte ~5.48M):
*"Agency account type: single login, manages multiple client workspaces, consolidated
billing"* (G-AS34); *"reseller buys Naelao platform access at wholesale, sells to their
customers at retail (margin is reseller's)"* (G-AS35).

This is expressed as **one per-product setting, `membershipModel`**, with three values
(all configured via UI, never code — see `SpaceTypeProductConfig` in
`workers/spaces/src/do/SpaceTypeRegistryDO.ts`):

| `membershipModel` | A joiner becomes | Mechanism |
|---|---|---|
| `team`   | a `SpaceDO` member of the builder's space (shared business) | default collaboration |
| `tenant` | owner of their **own new space** under the builder's account | account hierarchy (`parent_tenant_id`) + reseller billing |
| `hybrid` | a team member who may **also** create their own businesses | `team` + `userPermissions.canCreateSpace` |

**`tenant` requires** an **account hierarchy**: each customer = a **child tenant**
(`parent_tenant_id = builder`), fully isolated by the existing `{tenantId}:` namespacing;
the customer creates a space of a **Naelao-authored** SpaceType the builder exposes via
`allowedChildSpaceTypes` (CLAUDE.md #7 — no community SpaceTypes); provisioning reuses the
**10-step provisioner** with `tenant_id = childTenant`. Billing relationship is the
`billingRelationship` knob: `reseller` (wholesale→retail, builder invoices — G-AS35),
`referral` (Naelao bills, builder takes a cut), or `platform` (no resale).

### Tenancy is the data-topology contract (spec G-Y15/G-Y16)

`membershipModel` answers *what a joiner becomes*; **`tenancy`** answers *what the data
topology is* — the first-class manifest dimension the spec demands (G-Y15 CRITICAL). They
map: `team→team`, `tenant→saas`, `hybrid→saas`. `resolveTenancy()`
(`workers/spaces/src/tenancy.ts`, pure + unit-tested) derives it, preferring an explicit
`tenancy` field and falling back to the membershipModel inference so legacy configs still
resolve.

| `tenancy` | Topology | Where sub-spaces live |
|---|---|---|
| `single` | one owner, one `SpaceDO` | none |
| `team`   | one shared `SpaceDO` | **departments = rows in that DO's `spaces` registry**, isolated by `space_id` (no RLS — the DO boundary is the product boundary) |
| `saas`   | product root + **per-end-user child `SpaceDO`** (G-Y16) | each customer business is its **own** DO/SQLite/R2 under its **own** child tenant — structural isolation, never a `WHERE` clause; the wholesaler's root DB is never over-populated |

**This is the answer to the wholesale question.** When a wholesaler's customer "starts a
business," they get their **own top-level Space = own `SpaceDO` = own child tenant** (the
`POST /reseller/spaces` flow, `scenario_type='user-workspace'`, linked to the parent via
`parent_space_id` + `tenant_hierarchy`). The wholesaler keeps **admin control** over the
portfolio without holding the data: `GET /reseller/clients[/:id]`, suspend/reactivate
(cascades to the child's spaces), and **promote-to-product** (severs lineage — in our
per-tenant-DO model there is *no* data migration because the business was always isolated).
**Departments** *inside* any one business (team or a saas customer's business) are in-DO
sub-spaces created by `POST /spaces/:id/sub-spaces` — depth ≤ 2, mixed space-types only when
the parent is an `agencyShell`, end-user callers always inherit the parent type (spec §49).
Cross-department reads need an explicit **cross-space grant**
(`SpaceDO.checkCrossSpace`, fail-closed — defaults to DENIED on any error, §49).

### Build scope

- **Done:** `SpaceTypeProductConfig` schema (`membershipModel`, `assistantMode`,
  `allowedChildSpaceTypes`, `billingRelationship`, `userPermissions`) on the manifest;
  Launchpad defaults to `team` / `per-user` / `platform`.
- **Done — `tenant`/reseller subsystem backend (G-AS34/G-AS35):**
  - **Account hierarchy** — `infra/migrations/0033_reseller_accounts.sql`:
    `reseller_accounts` (per-reseller billing config), `tenant_hierarchy`
    (child→parent lineage), `reseller_ledger` (consolidated rollup). Dedicated tables
    keyed by `tenant_id` (kept off the `orgs`/`organizations` drift).
  - **Customer self-serve provisioning** — `POST /reseller/spaces` (spaces worker):
    resolves the reseller from the product space, gates on effective `productConfig`
    (`membershipModel` ∈ tenant/hybrid, `allowPublicSignup`, `allowedChildSpaceTypes`),
    mints/reuses a child tenant (`parent_tenant_id` = reseller), and runs the **same
    10-step provisioner** with `tenant_id = childTenant`. `GET /reseller/clients`
    returns the client portfolio + current-period billing rollup.
  - **Billing attribution** — `packages/billing-core/src/reseller.ts`
    (`computeResellerAttribution`): `reseller` = retail−wholesale margin, `referral`
    = clamped rev-share %, `platform` = no-op; refunds reverse. Wired into the Lemon
    Squeezy webhook (`workers/billing/src/lemon-squeezy.ts`) to write `reseller_ledger`
    rows. 10 unit tests in `tests/unit/reseller-attribution.test.ts`.
- **Done — tenancy topology & space hierarchy (G-Y15/G-Y16, §49), built generically for
  every SpaceType (not Launchpad-only):**
  - **`tenancy` dimension** on `SpaceTypeProductConfig` + `agencyShell`; `resolveTenancy()`
    in the pure `workers/spaces/src/tenancy.ts` (5 unit tests in
    `tests/unit/space-tenancy.test.ts`). Provisioner step 5b seeds the manifest tenancy +
    `agency_shell` onto the D1 `spaces` row and registers the SpaceDO root-space row.
  - **D1 hierarchy columns** — `infra/migrations/0034_space_hierarchy.sql`:
    `parent_space_id`, `depth`, `tenancy_mode`, `agency_shell`, `scenario_type` on `spaces`.
  - **SpaceDO `spaces` registry + `cross_space_grants`** — migration v10
    (`workers/spaces/src/do/SpaceDO.ts`): in-DO department hierarchy (depth ≤ 2, mixed-type
    gated by agency_shell, end-user type-forcing) + fail-closed cross-space permission check.
  - **Endpoints** (spaces worker): `POST/GET /spaces/:id/sub-spaces`,
    `PATCH /spaces/:id/sub-spaces/:subId`, cross-space grant CRUD + `/cross-space-check`,
    `POST /spaces/:id/registry` (internal); reseller admin
    `GET /reseller/clients/:id`, `POST .../status` (suspend/reactivate, cascades),
    `POST .../promote`. `POST /reseller/spaces` now stamps the saas hierarchy columns.
  - **Dashboard UI** — `apps/dashboard` clients page: drill-down drawer with the client's
    businesses, suspend/reactivate, and promote-to-product (with irreversible confirm).
- Launchpad SpaceType definition (§11): `workers/agents/src/launchpad/` manifests + templates
