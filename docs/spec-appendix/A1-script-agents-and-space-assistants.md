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

**The bundle is now a named, first-class profile — and a critical agentId bug is fixed (see
A1.16.7).** `DEFAULT_NAELAO_AGENT` / `SPACE_ASSISTANT_PROFILE`
(`workers/agents/src/script-engine/profiles.ts`) is that bundle: continuous-existence framing,
channel awareness, and honest-escalation instructions, installed at provisioning as the one
agent every dispatcher (billing, event triggers, channel heartbeats, scheduled jobs) wakes.

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
Layers 1 (Workspace/R2) and 2 (Sessions/FTS5) already existed; Layer 4 (Fabric) and Layer 6
(LLM Wiki) are now built too — see A1.14.

**Sub-agents — real spawn/receive/terminate.** `NaelaoAgentDO.buildOrchestrationHooks()`
implements the `OrchestrationHooks` the `sub-agent` prebuilt already called (previously always
"unavailable" — no host had wired them). `agent.spawn` accepts a **batch** of tasks
(`{ tasks: [{goal, budget_tokens?, model?}, ...] }`) and spawns them **concurrently** via
`Promise.all` against sibling `NaelaoAgentDO` instances (`idFromName(`sub:{spaceId}:{subId}`)`)
— see A1.12 for why batching is the chosen shape for parallelism here. Each child gets its own
budget (`budget_tokens` → real per-token enforcement in the loop itself as of A1.14, backstopped
by a coarse step ceiling via `budgetToMaxSteps`; never inherited from the parent — fixes
"Sub-Agent Token Budget Not Isolated From Parent"); spawning is `await`ed
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

**What this used to not do, now built in A1.14:** incremental progress streaming back to the
parent before a child finishes; a real per-token meter for `budget_tokens`; an account-level
concurrency ceiling across a tenant's *simultaneous* sub-agent trees. Still open: a full
`parentAgent()`/bidirectional-messaging channel for long-running children (today's progress
mechanism is one-directional child→parent; `agent.send` to an already-running child remains
unsupported by design — see A1.11).

## A1.13 Customer-bot projects (WhatsApp/Discord/email business bots) — BUILT

The builder's own scenario: *"I have a WhatsApp Business number my customers message — I
want a bot that answers Q&A, but I don't want it to be a full agent executing stuff for
customers without us knowing."* Settled by making a **project** (not a new DO, not a new
addressing scheme) the unit of restriction: a project can be flagged `kind = 'customer_bot'`
(SpaceDO `projects` table, migration v12), which flips its UI surface from "a workspace you
chat in" to "a surface you watch and configure" — each external customer becomes a thread the
same way any other project's threads work, no new concept for the admin to learn.

**Three structural constraints, not prompt instructions** — a compromised or over-eager
reasoner cannot talk its way past any of them:

1. **Execution ceiling** (`projects.execution_ceiling`, 1-5) — caps which execution-ladder
   tier the bound agent may use. Enforced in `ScriptToolSurface` (`code-runner.ts`'s
   sibling, not it) at `script.create`, `script.update` (including retroactively, if an
   admin lowers the ceiling after scripts already exist), *and* `script.run` — for both
   prebuilt ops and stored scripts. A ceiling of 2 means "talk and look things up, never
   touch a container or browser." `ScriptEngineEnv.maxTier` is the plumbing; it's set per
   message in the heartbeat, not once per agent, since one heartbeat sweep can touch several
   projects with different ceilings.
2. **Daily spend cap** (`projects.daily_spend_cap_credits`) — a project-scoped running total
   (`NaelaoAgentDO.project_spend`, `tokens_used` as an honest proxy for "credits," not a real
   billing conversion) that the heartbeat checks before each reasoning-loop call; once hit,
   remaining messages for that project are marked `spend_capped` (visible, not silently
   dropped) until the next UTC day.
3. **No-code rules** (`project_rules` table) — "after the customer says X, this happens,"
   admin-authored via form fields, checked **before** the reasoning loop even runs (zero
   token cost, deterministic). Three actions: `reply` (canned text), `run_script` (a named
   library script, still ceiling-checked), `human_takeover` (silences the bot for that one
   thread — `channel_sessions.human_takeover` — until an admin calls `.../resume`). Every
   template seeds STOP/UNSUBSCRIBE (WhatsApp Business Platform compliance, not optional) and
   a "talk to a human" escape hatch at the highest priority, so a customer can always reach a
   person and opt out, regardless of what the builder configures on top.

**Channel binding.** `channel_links` (D1) gained `project_id` (migration 0039) — reconnecting
a channel (`POST /channels/:channel/connect { project_id }`) moves it between projects. The
public webhook route resolves the binding and forwards `projectId` to the owning
`NaelaoAgentDO`; `channel_sessions` carries it per-thread so the heartbeat knows which
project's ceiling/rules/spend-cap apply to which pending message, batched per distinct
project per sweep (not re-fetched per message).

**WhatsApp joins the channel catalogue** (`launchpad/channels.ts`): Meta Cloud API inbound
shape (`entry[0].changes[0].value.messages[0]`; delivery-receipt `statuses` callbacks
correctly ignored), `X-Hub-Signature-256` (HMAC-SHA256 over the app secret) verification,
outbound via the existing `notifications` prebuilt's new `notify.whatsapp` op.

**No-code project templates** (`launchpad/project-templates.ts`, distinct from SpaceType
templates — a SpaceType template configures a whole *space* at provisioning; a project
template configures *one project* inside an already-existing space): `whatsapp-support-bot`,
`discord-community-bot`, `email-support-bot`. `POST /spaces/:id/projects/from-template`
creates the project, configures it (ceiling/cap/channel_config), and seeds its starter rules
in one call — the builder only ever fills in a name and (optionally) edits the canned replies.

**Observability** (`GET /spaces/:id/channels/sessions`, `.../unanswered`) and admin control
(`POST .../channels/sessions/:id/resume|takeover`) proxy straight to the owning agent DO —
this is the "all you do is see what the customers are doing" surface the builder described.

**What this used to not do, now built in A1.14:** mirroring a channel session into SpaceDO's
`threads` table; a real per-token→credit conversion for the spend cap; linking
`channel_user_id` to a stable Memory OS `user_id` so returning customers are recognized across
visits. **Still open:** a dashboard UI for any of this (backend + API only, consistent with
this session's engine-first pattern); rate-limiting a single customer's message *rate* (the
spend cap bounds cost, not message frequency).

## A1.14 Thread hierarchy, real credit conversion, identity linking, Fabric/Wiki, sub-agent
## progress + account-level concurrency — BUILT

Closes the honest-gap lists left open at the end of A1.12 and A1.13.

**Thread hierarchy — sub-agents and channel sessions are subthreads, not a new concept.**
SpaceDO's `threads` table (migration v8) existed but had no CRUD at all until this pass — it's
now real: `POST/GET /threads`, scoped by `space_id`/`project_id`. Migration v13 adds
`parent_thread_id`, `thread_kind` (`primary`/`sub_agent`/`channel`), and `channel`/
`channel_session_id` columns. A sub-agent spawn (`NaelaoAgentDO.spawnSubAgentBatch`) and a new
channel session (`handleChannelInbound`, first sight of a `(channel, channel_user_id)` pair
only) both call a new `mirrorThread()` helper that POSTs to SpaceDO — best-effort, the DO's own
`sub_agents`/`channel_sessions` tables remain the source of truth for actual bot logic; this is
purely so an admin can browse the tree from the ordinary thread list. **Default listing hides
`thread_kind != 'primary'`** (a 16-way sub-agent fan-out or a busy WhatsApp bot must not flood
a builder's thread list) — a project opts in via the new `projects.show_sub_threads` column
(`PATCH /projects/:id { show_sub_threads: true }`), or any caller passes
`?include_sub_threads=true` to see the full tree, nested via `parent_thread_id`, on demand.

**Real per-token accounting — the actual fix underlying both the budget and credit-conversion
gaps.** Turned out `tokens_used` was hardcoded to `0` everywhere — `GatewayReasoner.decide()`
discarded the Anthropic response's `usage` field entirely, so nothing downstream (spend caps,
sub-agent budgets) had a real number to work with despite being *described* as token-based.
Fixed at the source: `GatewayReasoner` now captures `usage.input_tokens`/`output_tokens` into a
`lastUsage` property (the `Reasoner` interface contract); `runScriptLoop` reads it after every
`reasoner.decide()` call and accumulates input/output separately into the returned
`ScriptRunResult.tokens_used`/`input_tokens`/`output_tokens`. Two real consumers followed from
having a real number:
- **Sub-agent budgets are now enforced against real tokens**, not just a step count.
  `RunLoopOptions.maxTokens` is checked before every L3/L4 reasoning step (never starts a step
  it can't afford) and `spawnSubAgentBatch` passes each child's own `budget_tokens` as its
  `max_tokens` context field. `budgetToMaxSteps`'s coarse step cap remains as a backstop for
  the rare case a reasoner doesn't report usage at all — documented as secondary, not primary.
- **Real USD→credit conversion** (`packages/billing-core`): `tokensToCredits(input, output,
  model)` composes the pre-existing (but previously unused!) `computeTokenCostMicro` per-model
  pricing table with a new platform-wide constant `CREDITS_PER_USD = 100` (1 credit = $0.01,
  the single source of truth for every USD↔credit conversion — never re-derive this rate
  locally). Always rounds up to at least 1 credit for any non-zero cost. Wired into the channel
  heartbeat's `addProjectSpend` call, replacing the "1 token ≈ 1 credit" proxy.

**Identity linking — `channel_user_id` → Memory OS `user_id`.** The scoping mechanism
(`ScriptEngineEnv.userId`) already existed; the link was missing. `handleChannelHeartbeat` now
sets `engineEnv.userId = \`channel:${channel}:${channel_user_id}\`` per message before it
touches memory or runs the reasoning loop — the same "mutate the shared engineEnv per message"
pattern already used for `maxTier`. A returning WhatsApp/Discord customer is now the same
Memory OS user across every visit, not a stranger each time.

**Memory OS Layer 4 (Fabric) + Layer 6 (LLM Wiki) — the last two of the spec's 6 layers.**
Schema matches the spec's `fabric_store`/`wiki_store` (byte ~148161), scoped by `user_id` like
every other layer here (the spec's AssistantDO is single-tenant per DO; ours shares one DO's
SQLite in shared-assistant mode). `MemoryStore` gained `recordFabric`/`recallFabric`/
`briefFabric` (Fabric — cross-session summary consolidation, `fabric_recall`/`fabric_brief`
tools per spec) and `upsertWikiConcept`/`lookupWikiConcept`/`searchWiki` (Wiki — auto-curated
concept vault). Exposed to the agent as two new self-managed prebuilts, **`fabric`** and
**`wiki`** (same Hermes pattern as `memory`), in every default agent profile. `NaelaoAgentDO`
also auto-records a Fabric entry after every successful `/script/run` — reusing the run's own
goal + output + trace notes as the "session extraction" rather than firing a second LLM call,
an honest cost-conscious approximation of the spec's "LLM-driven session extraction post-run."
Fabric relevance scoring is a term-overlap heuristic (not embedding-based — Fabric is DO SQLite
+ R2 per spec, not a Vectorize-backed layer like Layer 5), filtered at the spec's 0.70 floor.

**Incremental sub-agent progress streaming.** The parent still spawns and awaits children
synchronously (the parent-liveness guarantee from A1.11 is unchanged — flipping to async
fan-out would reintroduce the exact orphaning risk that guarantee closes). What's new: a child
can report progress back to its *specific parent DO instance* mid-run via a cross-DO callback.
`runScriptLoop` gained an `onProgress` checkpoint callback (OBSERVE, GATE, each L3/L4 step;
swallows its own errors — a progress sink going down never fails the run). A spawned child's
context now carries `parent_do_id` (`this.ctx.id.toString()`, resolved back via
`namespace.idFromString()` — works regardless of the parent's own addressing scheme) alongside
`sub_agent_id`; `handleScriptRun` wires `onProgress` to `POST /sub-agents/:id/progress` on the
parent, which updates that row's new `progress_note` column. Because Durable Objects serve
concurrent `fetch()` calls, an admin/dashboard can `GET /sub-agents?parent_run_id=` on the
parent DO **while its own spawning request is still in flight** and see live status — a
poll-based "stream" without needing a WebSocket/SSE channel, the same idiom this build already
uses for channel-session observability.

**Account-level concurrency ceiling — `ConcurrencyDO` (spec §28, byte ~551944).** A new,
general-purpose Durable Object (`workers/agents/src/do/ConcurrencyDO.ts`, bound
`CONCURRENCY_DO`) implementing the spec's acquire/release slot contract, wired specifically to
gate **simultaneous sub-agent spawn trees** per space (`MAX_SUB_AGENTS_PER_SPAWN = 16` already
bounds fan-out *within* one `agent.spawn` call; this bounds how many separate spawn trees can
run *at once*, `MAX_CONCURRENT_SUB_AGENT_TREES = 3`, spec's own `maxConcurrentRuns` default).
Two spec gaps closed in the same build rather than left as known issues:
- **Deadlock scenario** (a holder crashes/evicts before releasing → a leaked slot forever):
  every acquired slot carries its own `expires_at`; a DO Alarm sweeps expired slots every 5
  minutes, and `acquire()` also sweeps inline for its own key so staleness never outlives one
  acquire call even between alarm ticks.
- **Check-then-insert race** (two concurrent callers both observe "under the limit" and both
  succeed): `acquire()`'s `COUNT` and `INSERT` run with no `await` between them — atomic by
  construction under the DO's single-threaded execution model, no separate lock needed.
Fails open when unbound or unreachable (a down `ConcurrencyDO` must not wedge every agent run)
— same honest-degradation posture as every other optional binding in this build.

## A1.15 Project-scoped workspace + the generic `lock` primitive — BUILT

The builder's own framing: *"a project is workspace-scoped — every thread's agent in it
shares one R2 filesystem. A WhatsApp support project's assistant could add a project
instruction like 'log every complaint to ledger.csv,' write a script the agent uses to append
to it, and that script locks the row it's writing so two customer threads writing
concurrently can't clobber each other."*

**Scope split.** `ScriptEngineEnv.projectId` (optional) decides the R2 workspace prefix — the
single function `workspacePrefix(env)` in `types.ts` is the ONLY place this decision is made,
called by every workspace-touching prebuilt (`r2-workspace`, `file-manager`,
`observe_filesystem`) so the space/project boundary can't drift between them:
- **Absent** (`spaces/{spaceId}/workspace/...`) — the **Space Assistant**, operating
  space-wide. Nothing changed here from before this pass.
- **Present** (`spaces/{spaceId}/projects/{projectId}/workspace/...`) — an ordinary
  **Naelao Agent** thread. Every thread's agent in the SAME project resolves to the SAME
  prefix regardless of which `agentId`/thread spawned it — that's the mechanism behind "every
  thread's agent in a project shares one filesystem."

Wired through `NaelaoAgentDO.buildScriptEngineEnv` (new `projectId` parameter),
`handleScriptRun` (`body.projectId` / `x-naelao-project-id` header — never inferred, a caller
that wants project scoping says so explicitly), the channel heartbeat (`engineEnv.projectId`
mutated per message from `channel_sessions.project_id`, same pattern as `maxTier`/`userId` —
this is what makes the WhatsApp-project-ledger scenario work end to end), and sub-agent
spawning (a child inherits its parent's `projectId` — a spawned sub-agent is a subthread of
the same project, not a different workspace).

**The generic `lock` primitive — NOT a bespoke locking mechanism.** The row-locking strategy
in the builder's scenario is deliberately NOT something Naelao ships as a fixed op (a
`ledger.append_row` prebuilt would be exactly the kind of hardcoded tool this architecture
avoids). Instead the platform exposes acquire/release/status as a generic primitive
(`lock.acquire` / `lock.release` / `lock.status`, `workers/agents/src/script-engine/prebuilt/
lock.ts`), and the assistant composes its OWN concurrency strategy on top of it: a script that
takes a row number, calls `lock.acquire({key: "row:5", holder_id, limit: 1})`, aborts if not
granted (or retries/queues, or preempts — the script's choice), writes, then
`lock.release`s. The assistant tells its agents (via `agents.md` or a skill) to call that
script instead of the raw `write_file` op — the row-ownership rule lives in the authored
script, not in a platform-enforced schema.

Backed by the same `ConcurrencyDO` as A1.14's sub-agent-tree gating, generalized: `holder_id`
is required (no implicit identity — a script must be explicit about who's holding the lock,
the same reasoning as requiring explicit ids elsewhere in Memory OS), default `limit: 1`
(exclusive lock) is overridable for semaphore-style use, default TTL 60s (much shorter than
the sub-agent-tree default — a lock-write-release cycle should be fast; a forgotten release is
reclaimed quickly, not after 30 minutes). **Keys are always prefixed by space (+ project, when
scoped) inside `buildScriptEngineEnv`** — never left to the calling script to remember — so two
different spaces, or two different projects in the same space, can never collide on the same
literal lock name a script happens to pick. Reports `degraded: true` (not a silent grant) when
`CONCURRENCY_DO` is unbound, so a script that actually cares about correctness can detect the
degradation instead of being lied to by an always-succeeds lock.

**What this does NOT yet do (open, tracked):** the harder "halt/cancel an already-running
competing script" primitive the builder also floated — `lock.acquire` returning `granted:
false` covers "don't let a colliding write start," but actually interrupting a script already
mid-execution (true preemption) needs either cooperative check-ins inside running scripts or a
hard abort at the runner/isolate level, neither of which exists yet; project-level lifecycle
triggers (e.g. "compact a thread when it goes idle and a new thread starts in the project") —
tracked as the next piece of this same builder conversation, not yet built.

## A1.5 Open follow-ups (tracked, not yet built)

- ~~**Credential hierarchy**~~ — **BUILT** (see A1.16.5). Per-user (default) + per-space
  (shared) + per-privileged-user overrides, in `workers/credentials`. Also closed a
  pre-existing gap: `space_credentials` had no migration at all — the worker would have
  thrown at runtime against a real D1.
- **MCP as scripts**: agents never connect to MCP directly; they write/use scripts that wrap
  MCP providers (Pipedream, Composio).
- ~~**Member/seat billing**~~ — **BUILT** (see A1.16.4). Lemon Squeezy billing for a builder's
  space-members (the third payer class): `/internal/seats/checkout` + LS-webhook
  `recordSeatActivation` (member activated on paid seat) already existed; this pass added the
  builder-facing enable/price surface (`GET/PATCH /spaces/:spaceId/member-billing`) that
  provisions the seat LS variant and stores the config as a per-space `productConfig` override.
- ~~**Storefront render + CF for SaaS apply step**~~ — **BUILT** (see A1.16.3). The portal
  Worker now serves the store at the root path a buyer lands on (`GET /` resolves the Host via
  `business_services`, precedence storefront → product portal), and the zone-scoped
  `custom_hostnames` apply (`createCustomHostname` + TXT DCV + status poll) is wired end-to-end
  in the spaces worker. The `storefront.set_custom_domain` prebuilt now posts `kind='custom_domain'`
  (the branch that actually runs the CF-for-SaaS apply).
- ~~**Space collaboration**~~ — **BUILT** (see A1.16.6). Roles already existed
  (`space_members.role`); locks already existed (`LockDO`/A1.15). This pass added presence
  (heartbeat-based, in `SpaceDO`) and project deduplication (name-similarity heads-up on
  `POST /projects`, wired to the existing event-trigger mechanism so a builder can broadcast
  "this already exists" via a no-code trigger). "Task boards" is the existing
  Projects+threads model (§A1.0) — a dashboard rendering concern, not a missing backend.
- ~~**Reseller / `tenant` membership**~~ — **BUILT** (see A1.16.4). `parent_tenant_id` hierarchy
  (`tenant_hierarchy`), `reseller_accounts`, per-event `reseller_ledger` attribution
  (`recordResellerAttribution` in the LS webhook), `/reseller/spaces` + client-portfolio
  endpoints were already in place; this pass added the consolidated **wholesale statement**
  (`GET /reseller/statement?period=YYYY-MM`) that sums the ledger into the invoice the reseller
  settles + a per-client breakdown (spec G-AS34/G-AS35).

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

---

## A1.16 Addition: Assistant Approval Policy + No-Code Event Triggers (`@naelao/events`)

### A1.16.1 Assistant Approval Policy (HITL gate inversion)

**Why this exists.** The ordinary agent (`NaelaoAgentDO` with a `projectId`) treats
`requiresApprovalFor` as an **allowlist of gated actions** — only the listed actions pause
for human sign-off. A Space Assistant (no `projectId`) has the *opposite* contract: it may
act autonomously by default because it is an always-on service, but it should ask before
unusual actions.

**Two modes (`ApprovalMode` — `workers/agents/src/script-engine/loop.ts`):**

| mode | behaviour |
|---|---|
| `gate_listed` | Default for project agents. Only actions in `requiresApprovalFor` are gated. |
| `gate_unless_listed` | Space Assistant default (`always_ask`). All actions are gated **unless** explicitly listed in `auto_approved_actions`. |

**Storage — SpaceDO migration v14 (`assistant_policy` table):**

```sql
CREATE TABLE IF NOT EXISTS assistant_policy (
  space_id TEXT PRIMARY KEY,
  approval_mode TEXT NOT NULL DEFAULT 'always_ask', -- 'always_ask' | 'yolo'
  auto_approved_actions TEXT NOT NULL DEFAULT '[]'  -- JSON string[]
);
```

**`yolo` mode** — when a builder sets `approval_mode = 'yolo'`, the Space Assistant uses
`gate_listed` with an empty `requiresApprovalFor` list, which means nothing is ever gated.
This matches the builder's "skip asking entirely" expectation.

**`fetchAssistantPolicy()` fails CLOSED.** Any error (SpaceDO unreachable, row missing)
returns `null`, which the calling code treats as `always_ask` with no auto-approved actions.
Never silently grants yolo.

**Endpoints (spaces worker):**
- `GET /spaces/:spaceId/assistant-policy` — returns current policy
- `PATCH /spaces/:spaceId/assistant-policy` — update `approval_mode` and/or `auto_approved_actions`

**Tests:** 5 new approval-mode tests added to `tests/unit/script-engine.test.ts`:
- `gate_listed` only gates listed actions; `gate_unless_listed` gates everything else
- auto-approved actions in `gate_unless_listed` skip the HITL gate
- rejected approval aborts the loop
- yolo empty list never asks

### A1.16.2 No-Code Event Triggers (`@naelao/events` package)

**Why this exists.** Builders need "project lifecycle triggers" — if a new thread is created
in the current project and the last-active thread is the agent's thread, trigger the compact
script — without writing code. Triggers are data rows; the execution is deterministic
`script.run`, no LLM cost.

**`@naelao/events` (`packages/events/src/index.ts`)** — pure, DO-agnostic logic:

```typescript
// core types
type NaelaoEventType = "thread.created" | "thread.closed" | "project.created" | (string & {});
interface EventEnvelope { type, space_id, project_id?, thread_id?, occurred_at, payload? }
type TriggerCondition =
  | { type: "always" }
  | { type: "last_active_thread_idle"; idle_minutes: number };
interface TriggerRule { id, space_id, project_id?, event_type, condition, action, enabled, priority }

// pure functions
matchesEvent(rule, event): boolean          // structural match (type + space + project boundary)
selectMatchingRules(rules, event): TriggerRule[]  // filters + sorts by priority desc
evaluateCondition(condition, ctx): ConditionResult
buildFireParams(action, event, conditionResult): Record<string, unknown>
```

**Project scoping is structurally enforced:**
- A project-scoped rule (`project_id` set) can only match events in that exact project — never
  another project's threads, never a space-wide event.
- `resolveLastActiveOtherThread()` in SpaceDO queries only within the trigger's own
  project — a project-scoped trigger cannot see another project's threads.

**Storage — SpaceDO migration v15 (`event_triggers` table):**

```sql
CREATE TABLE IF NOT EXISTS event_triggers (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  project_id TEXT,                          -- null = space-wide
  event_type TEXT NOT NULL,
  condition_json TEXT NOT NULL DEFAULT '{"type":"always"}',
  action_json TEXT NOT NULL,                -- { type: "run_script", script_name, params? }
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('now','subsec') * 1000)
);
```

**Trigger fire path:**
1. SpaceDO's `createThread()` / `createProject()` fires `fireMatchingTriggers()` on NEW rows
   only (idempotent re-runs don't re-fire).
2. `fireMatchingTriggers()` calls `selectMatchingRules()` → `evaluateCondition()` → 
   `buildFireParams()` for each matching rule (max 5 per event to bound fan-out).
3. Each fired trigger POSTs to `AGENTS_WORKER /internal/triggers/fire` (internal-only, gated
   on `x-naelao-internal: spaces-trigger` header).
4. `NaelaoAgentDO.handleTriggerFire()` calls `ScriptToolSurface.run()` directly — no
   OBSERVE/FIND/GATE loop, no LLM wake, no token cost.

**Endpoints (spaces worker):**
- `GET /spaces/:spaceId/event-triggers` — list all triggers for this space
- `POST /spaces/:spaceId/event-triggers` — create a trigger
- `DELETE /spaces/:spaceId/event-triggers/:triggerId` — delete a trigger

**`fireMatchingTriggers()` is awaited** (not fire-and-forget), same reasoning as
`mirrorThread()` — un-awaited promises can be abandoned mid-flight when the DO's request
context is freed.

**Tests (`tests/unit/packages/events.test.ts`, 13 tests):**
- `matchesEvent`: disabled rule, wrong event type, cross-space (never cross-tenant), exact
  project match vs different project vs no project
- `selectMatchingRules`: priority ordering, filters disabled + wrong-type rules
- `evaluateCondition`: always, idle below threshold (no match), idle above threshold (match +
  targetThreadId), recent thread (no match)
- `buildFireParams`: targets condition-resolved thread over event's own; falls back to event
  thread when no condition target

---

## A1.16.3 Storefront render at the fallback origin + Cloudflare-for-SaaS apply — BUILT

The Launchpad **storefront** (spec §11 external portal, monetization model B) is now
functional end-to-end: a buyer can reach a store and check out. Two gaps closed this pass.

**1. Serve the store at the ROOT path (portal Worker = CF-for-SaaS fallback origin).** Storefront
hosts — the `{slug}.naelao.com` wildcard (covered by the zone cert) plus opt-in verified custom
hostnames — CNAME to the portal Worker as the Cloudflare-for-SaaS fallback origin. A buyer's
browser lands on `/`, not `/storefront`. The Worker now has `GET /` which resolves the `Host`
header against `business_services` (precedence: **storefront → product portal**) and renders the
store inline; it falls through to the product-portal proxy (`PORTAL_DOMAINS` KV → CF Pages) when
the host is a space shell, and 404s otherwise. `resolvePortal()` / `proxyToPortal()` were
extracted from the old `/proxy` handler so both `/` and `/proxy` share one code path.
`renderStorefrontForSpace()` is shared by `/` and the explicit `/storefront` route. The rendered
buy form posts to `/storefront/checkout` (same host), which routes money-in through the billing
worker's reserved commerce checkout (platform fee applied).

**2. `storefront.set_custom_domain` triggers the CF-for-SaaS apply.** The prebuilt op posted
`kind='storefront'` with a `custom_domain`, but the spaces worker only runs the apply
(`createCustomHostname` → TXT DCV → `pending_dns`, then `getCustomHostname` status poll flipping
to `active`) on the `kind='custom_domain'` branch. `kind='storefront'` silently dropped the domain
and allocated a `{slug}.naelao.com` handle. Fixed: the op now posts `kind='custom_domain'`, which
is a distinct `business_services` row (the table's `UNIQUE(space_id, kind)` allows a space to hold
both a storefront handle and a custom domain). `resolveStorefront()` already matches either
`naelao_handle` (storefront) or `custom_domain` (custom_domain), so both surfaces resolve.

The CF apply is a no-op unless `CF_API_TOKEN` + `CF_SAAS_ZONE_ID` are configured (dev path records
intent + CNAME instructions; the apply runs later when the deploy-time secrets land).

**Tests (`tests/unit/storefront-serving.test.ts`, 5 tests):**
- prebuilt: `set_custom_domain` posts `kind='custom_domain'` (regression), `provision` posts
  `kind='storefront'` with a DNS-safe slug
- portal Worker: `GET /` renders the store (name/products/price/checkout form) for a storefront
  host; renders the "opening soon" empty state with no published products; 404s when the host is
  neither a storefront nor a portal

---

## A1.16.4 Member/seat billing enablement + reseller consolidated statement — BUILT

Two billing surfaces that were "scaffolded but not usable end-to-end" are now complete. In both
cases the money movement already existed; what was missing was the config/read surface that lets a
builder turn it on or a reseller see what they owe.

**Member/seat billing — builder enablement (spaces worker).** The third payer class (a builder
charges people to join their space) already had checkout (`billing /internal/seats/checkout`),
pricing resolution (`spaces /internal/member-billing`, reading `productConfig.memberBilling`), and
member activation on the paid webhook (`recordSeatActivation`). What was missing: a builder had no
way to *enable* it without hand-editing a manifest, and nothing provisioned the seat's Lemon
Squeezy variant (products auto-create theirs on publish; seats had no equivalent). Added:
- `GET /spaces/:spaceId/member-billing` — the space's effective member-billing config.
- `PATCH /spaces/:spaceId/member-billing` — `{ enabled, seatPriceCents?, currency?, interval? }`.
  On enable it provisions the seat LS variant **once** (via `billing /internal/products/ls-variant`,
  `kind` = `subscription` | `one_time`), merges over the current effective config (unspecified
  fields keep their value; an existing `lsVariantId` is never re-provisioned), and persists the
  result as a **per-space `config_json.productConfig.memberBilling` override** — never forks the
  SpaceType manifest (`loadEffectiveProductConfig` already merges the override on top). Enabling
  with a non-positive `seatPriceCents` is a 400; ownership is gated by tenant.

**Reseller consolidated statement (spaces worker).** `recordResellerAttribution` writes one
`reseller_ledger` row per billable child event (retail / wholesale / margin, tagged with a
`YYYY-MM` period). The portfolio endpoint showed only a current-month rollup. The actual
"wholesale invoicing" deliverable (G-AS34/G-AS35) — a consolidated statement the reseller settles
with Naelao and bills their own clients from — was missing. Added:
- `GET /reseller/statement?period=YYYY-MM` (defaults to current month) — sums the ledger for the
  calling parent tenant into `totals` (grouped by currency: retail/wholesale/margin/events) plus a
  `by_client` breakdown (per child tenant × currency, ordered by wholesale desc) and a
  `client_count`. Rejects a malformed period (400) and a missing tenant (401). Routed through the
  existing `/reseller/*` proxy.

**Tests (`tests/unit/member-seat-reseller-billing.test.ts`, 9 tests):**
- member billing: disabled defaults; enable provisions the seat variant + writes the
  `productConfig.memberBilling` override; enable at price 0 → 400; enable with an existing variant
  does not re-provision and merges over current; unowned space → 404
- reseller statement: aggregates totals + per-client breakdown for a period; defaults to the
  current month; malformed period → 400; missing tenant → 401

---

## A1.16.5 Credential hierarchy (per-user / per-space / privileged override) — BUILT

Closes the "credential hierarchy" open follow-up. Also closed in passing: `space_credentials`
— the table the credentials worker has always queried — had **no migration creating it at
all**; every query would have thrown against a real D1. `infra/migrations/0040_space_credentials.sql`
creates it with the hierarchy built in from the start.

**The three tiers, resolved in this order for an acting user:**
1. `scope='space'` row with `is_override=1` — a privileged (owner/admin) override. Always wins,
   even over the acting user's own personal credential. Lets an admin force everyone onto one
   company-managed credential regardless of what individuals have connected.
2. `scope='user'` row for the acting user — the per-user **default**: a member's own personal
   credential (their own OAuth token, their own email account) for a given name.
3. `scope='space'` row with `is_override=0` — the shared space-wide fallback (e.g. a shared
   company email) used when the acting user has no personal credential of that name.

Enforced by two partial unique indexes (`idx_space_credentials_user` on `(space_id, name,
user_id) WHERE scope='user'`, `idx_space_credentials_space` on `(space_id, name) WHERE
scope='space'`) — at most one personal credential per (space, name, user), and exactly one
space-level row per (space, name) that is either the shared default or its override, never
both (the override IS the space-level row; `is_override` just changes how it resolves).

**Authorization (`workers/credentials/src/index.ts`):**
- Any member may create/update their own `scope='user'` credential (`POST` upserts in place —
  re-saving the same name rotates the value rather than erroring or duplicating).
- Creating a `scope='space'` credential, OR setting `is_override=1`, requires `owner`/`admin`
  (read from `x-naelao-role`, forwarded by the router from JWT claims — same trust boundary as
  every other worker in this codebase).
- `GET` (list) returns metadata only, never values. A non-privileged caller sees their own
  personal credentials + all space-scoped ones (so they can see what's shared, never a
  teammate's personal credential). Owner/admin sees everything, for audit/management.
- `DELETE` — a member may delete their own personal credential; deleting any `scope='space'`
  row (shared or override) requires owner/admin.

**Resolution endpoint.** `POST /v1/internal/spaces/:spaceId/credentials/:name/plaintext` (called
by mcp-hub, business-email, etc. via the short-lived HMAC credential token) now accepts an
optional `on_behalf_of_user_id` in the body. Callers that don't know/care about a specific
member (mcp-hub resolving a connector's own secret — unchanged, no body sent) get the effective
space-level credential (override, else shared). Callers acting for a specific member (future:
"send this email as me") pass their user id and get the full 3-tier resolution.

**Router wiring (a second pre-existing gap closed).** The public CRUD routes
(`POST/GET /spaces/:spaceId/credentials`, `DELETE /spaces/:spaceId/credentials/:credId`) were
never proxied by `naelao-router` at all — the dashboard's credentials page called an endpoint
that didn't exist on the public API. Added the `CREDENTIALS_WORKER` service binding + the two
proxy routes. (The internal plaintext-resolution route is intentionally NOT proxied — it's
service-binding-only, exactly like every other worker's `/internal/*` surface in this
codebase.) One byproduct: the credentials worker's public routes had a `/v1` prefix baked into
their own path definitions, inconsistent with every other proxied worker (spaces/knowledge/
agents define routes WITHOUT `/v1`, since `proxyTo` always strips it before forwarding) — fixed
by dropping the prefix on the three public routes; the internal route keeps its `/v1` prefix
since it's only ever reached by other workers constructing the full URL directly over the
service binding, never through the public router's prefix-stripping path.

**Tests (`tests/unit/credential-hierarchy.test.ts`, 20 tests), against REAL SQLite.** Rather
than regex-dispatch mocks, these run the actual migration SQL through `node:sqlite`
(`tests/stubs/d1-sqlite.ts`, a thin D1-shaped facade) — this also serves as a live check that
the migration's partial-unique-index + `ON CONFLICT ... WHERE ... DO UPDATE` upsert syntax is
valid SQLite. Covers: scoping/authorization rules (member vs owner/admin, is_override gating),
upsert-in-place, list visibility (own + shared vs everything), delete authorization, the full
3-tier resolution order including the override-always-wins case, the no-`on_behalf_of` backward
-compatible path (mcp-hub's actual call shape), 404 on no match, invalid-token rejection, and
cross-tenant isolation.

---

## A1.16.6 Space collaboration: presence + project deduplication — BUILT

Closes the "space collaboration" open follow-up (A1.5/A1.8: "two members' assistants do not
build two companies because they read/write the same shared state ... coordination = file
locks + presence + project deduplication"). Of the three coordination primitives A1.8 names,
locks already existed (`LockDO`, A1.15) and roles already existed (`space_members.role`,
`owner`/`admin`/`editor`/`member`/`viewer`). This pass builds the other two, both living in
`SpaceDO` (no new DO — presence and dedup are space-scoped, unlike locks which need arbitrary
cross-resource naming).

**Presence** (migration v16, `presence` table: one row per `(space_id, user_id)`). A
heartbeat, not a WebSocket/DO-alarm system: `POST /spaces/:spaceId/presence` upserts where a
member currently is (`project_id`/`thread_id`, or space-level if omitted); `GET
/spaces/:spaceId/presence?project_id=` lists who still counts as "active" — a caller-supplied
freshness window (`isPresenceFresh`, `@naelao/events`, default 90s) filters out stale rows so a
closed tab or crashed client ages out instead of appearing present forever.

**Project deduplication** (`SpaceDO.createProject`). Exact-name idempotency already existed
(`ON CONFLICT(space_id, name) DO NOTHING`); this adds a *semantic* heads-up: before inserting a
genuinely new project, its name is compared against every existing active project via
token-Jaccard similarity (`nameSimilarity`/`findPossibleDuplicateProjects`, `@naelao/events`;
threshold 0.5, chosen to favor recall — a false-positive heads-up costs nothing, a missed real
duplicate is the thing this exists to catch). This is deliberately **not** embeddings/Vectorize
— that's reserved for `script.find`'s retrieval, not a synchronous check on every project
creation. Matches are returned in the create response as `possible_duplicates` and, when any are
found, a `project.possible_duplicate` event fires through the *existing* event-trigger
mechanism (`fireMatchingTriggers`, same as `project.created`) — a builder wires this to a
no-code trigger (e.g. a `notifications` script) to actually broadcast "this already exists" to
the space's admin/assistant. The dedup check never blocks creation, matching A1.8's framing:
coordination, not gatekeeping.

**Adjacent bug fixed in passing:** `updateProject` had no `status` field at all, so a project
could never actually be archived via the API (`listProjects` and the new dedup candidate query
both filter on `status != 'archived'`, but nothing could set it). Added `PATCH
{ status: 'active'|'archived' }`.

**Tests (`tests/unit/space-collaboration.test.ts`, 20 tests):** pure similarity/dedup/freshness
functions (identical/unrelated/superset names, case/punctuation insensitivity, sorted-by-score
filtering, freshness at/past a window); `SpaceDO` project creation (no duplicates for an
unrelated name, a similar name flagged but still created, an idempotent exact re-create reports
no duplicates for itself, an archived project excluded from candidates, the possible-duplicate
event actually firing through a registered no-code trigger); `SpaceDO` presence (space-level
heartbeat, project-scoped listing, a second heartbeat updates rather than duplicates, a stale
heartbeat ages out under `vi.useFakeTimers`, missing `user_id` rejected, isolation across
spaces). Uses the existing `tests/unit/helpers/sqlite-do-shim.ts` pattern (real SpaceDO class
against real in-memory SQLite via `node:sqlite`), not a hand-rolled mock.

---

## A1.16.7 Space Assistant profile + a critical agentId bug fix; time-based scheduling — BUILT

A session audit ("read the spec top-down, bottom appendix overrides early sections, note
we're script-native") found the Space Assistant capability list (spec §05, reconciled through
the Script-First appendix at byte ~6733k) was functionally complete EXCEPT two things: no
first-class assistant profile, and no time-based (cron) scheduling primitive — event_triggers
(§A1.16.2) covers lifecycle events but not "every day at 9am." Both are closed here. The audit
also surfaced a bug that had nothing to do with either gap but made the Space Assistant
non-functional in any real deployment.

**Critical bug: `DEFAULT_NAELAO_AGENT.agentId` did not match what any dispatcher wakes.** The
profile that provisioning installs was `"naelao-default"`, but EVERY consumer — the Lemon
Squeezy webhook's `resolveDefaultAgent`, `naelao-triggers`' fire path, the hourly channel-
heartbeat sweep, and every `/spaces/:id/sessions`/`/script/run` call — hardcodes the literal
string `"naelao-agent"`. `loadAgentConfig` returns `null` on a path mismatch and the DO 404s
with `"agent 'naelao-agent' is not provisioned in space '...'"`. This meant a real deployment's
Space Assistant would 404 on every single wake-up: billing events, event triggers, channel
messages, everything. Fixed: `agentId` is now `"naelao-agent"`, matching every other call site
(none of which import the constant — they run in different Workers). A regression test asserts
the literal value directly so this can't silently drift back.

**Space Assistant profile (`workers/agents/src/script-engine/profiles.ts`).** The profile
content was previously a generic "capable general-purpose assistant" with no acknowledgment
that it's the one bundle §05/A1.3 describes. Rewrote `agentsMd`/`systemPrompt` to state: (1)
continuous, hibernation-backed existence — woken by a channel message, hourly heartbeat,
scheduled job, billing event, or trigger, never assuming in-memory continuity across wakes; (2)
channel awareness — Slack/Discord/email/WhatsApp each get their own (channel,
channel_user_id) session, inbound messages are data not instructions; (3) honest escalation —
say "I'm not sure, let me check with the owner" rather than guessing. Added
`SPACE_ASSISTANT_PROFILE` as a documented alias of `DEFAULT_NAELAO_AGENT` (same object,
`SPACE_ASSISTANT_PROFILE === DEFAULT_NAELAO_AGENT`) for discoverability under the spec's own
vocabulary at call sites where "the assistant" is the intent.

**Time-based scheduling (spec §05 "cron-jobs.json — the assistant's schedule of recurring
tasks").** The no-code, TIME-driven counterpart to event_triggers:
- `scheduled_jobs` (new PLATFORM_DB table, `infra/migrations/0041_scheduled_jobs.sql`) — lives
  in platform D1 rather than per-space SpaceDO SQLite, for the same reason `channel_links`
  does: the hourly dispatcher needs one cheap cross-space query to find everything due, rather
  than waking every space's DO to ask "do you have anything due."
- A dependency-free 5-field cron matcher in `@naelao/events`
  (`parseCronExpression`/`cronMatchesDate`/`isCronDue`/`validateCronExpression`) — `*`, literal
  numbers, comma lists, ranges, `/step`. The spec's own warning against re-parsing cron
  expressions on every heartbeat tick is about OpenClaw's tight 5-minute loop; our dispatcher
  runs hourly, so a bounded per-minute scan since the job's last run (`CRON_DUE_MAX_LOOKBACK_MS`
  = 8 days, at most ~11,520 trivial iterations) needs no precomputed "next run" cache.
- CRUD: `GET/POST/PATCH/DELETE /spaces/:spaceId/scheduled-jobs` (spaces worker, tenant-owned,
  same pattern as member-billing) — `validateCronExpression` rejects a malformed expression at
  creation/update time so a builder gets an immediate error, not a silently-never-firing job.
- Dispatch: `runScheduledJobs` (agents worker, wired into the existing hourly cron branch
  alongside `pollConnectors`/`runChannelHeartbeats`) — queries every enabled job joined against
  active spaces, checks `isCronDue`, and fires due jobs via a new shared `fireScriptDirectly`
  helper (factored out of `/internal/triggers/fire` — both event-triggers and scheduled jobs are
  "the system decided to run this script," never a reasoning session, so they share one
  dispatch path). Records `last_run_at` only on a successful fire; one job's failure (a bad
  cron, a fire error) never blocks another space's job in the same sweep.

**Tests:**
- `tests/unit/script-engine.test.ts` (+3): the `agentId === "naelao-agent"` regression,
  `SPACE_ASSISTANT_PROFILE` aliasing, and the profile content actually mentioning
  heartbeat/channel/escalation.
- `tests/unit/packages/events-cron.test.ts` (19): cron parsing (daily, lists, ranges, steps,
  weekday, malformed/out-of-range rejection), `isCronDue` (due/not-due/exact-boundary/missed-
  cycle/lookback-bounded), `validateCronExpression`.
- `tests/unit/scheduled-jobs.test.ts` (12): CRUD (create/validate/list/patch/delete/ownership,
  against real SQLite via the actual migration) + dispatcher (fires when due, skips when not,
  passes params/projectId through, one failure doesn't block another space).

---

## A1.16.8 Direct-worker-ingress trust hole closed — BUILT

A security audit (independent of the Space Assistant work) found that every internal worker
trusted `x-naelao-tenant-id` / `x-naelao-user-id` / `x-naelao-role` headers **as-is**, with no
verification that the request actually came through `naelao-router` — the one place that signs
those headers off verified JWT claims. Three compounding gaps made this a real, not theoretical,
hole:

1. **No worker had `workers_dev = false`.** Every worker (spaces, agents, credentials,
   knowledge, billing, provisioner, …) was reachable at its own public `*.workers.dev` URL by
   default — bypassing the router, and every header check, entirely.
2. **`proxyTo` (naelao-router) only overwrote identity headers when JWT claims were present.**
   `workers/router/src/index.ts`: on an unauthenticated route, a client's own
   `x-naelao-tenant-id`/`x-naelao-role` were forwarded to the downstream worker untouched —
   one refactor away from a real tenant-spoofing bug even through the router itself.
3. **The one "internal-only" check in the codebase (`/internal/triggers/fire`,
   `workers/agents/src/index.ts`) compared `x-naelao-internal` against a static string
   (`"spaces-trigger"`)** — anyone who could reach the worker could set that header themselves.
   Several other `/internal/*` routes had an even weaker pattern (any truthy header value).

**Fixed:**
- `workers_dev = false` added to every `workers/*/wrangler.toml` except the workers that need
  genuine public ingress with their OWN independent verification: `naelao-router` and
  `naelao-portal-router` (the public API/portal surface itself), `naelao-agents` (the
  signature-verified multi-channel gateway, `adapter.verifySignature`), `naelao-billing`
  (Stripe/Lemon Squeezy webhook signature checks), and `naelao-ws-gateway` (WebSocket upgrades
  do their own origin + tenant check, can't be relayed through a service-binding fetch).
- `proxyTo` now unconditionally `headers.delete()`s all five identity/internal headers before
  the `if (claims)` block sets them from verified JWT claims — no code path can forward a
  client-supplied identity header through the router anymore.
- New `packages/http` primitives: `mintInternalToken(secret, tenantId)` (mints the same
  `t=<ts>,v1=<hmac>` token `proxyTo` always minted, for any worker-to-worker caller that talks
  to another worker's service binding DIRECTLY, bypassing the router) and
  `requireInternalHmac(getSecret)` (a Hono middleware verifying that token against the
  request's own `x-naelao-tenant-id`, using the pre-existing but previously-unused
  `verifyInternalToken`).
- **`workers/credentials`**: the three public CRUD routes (`POST/GET/DELETE
  /spaces/:spaceId/credentials[...]`) are now gated by `requireInternalHmac`. The internal
  plaintext-resolution route (`/v1/internal/.../plaintext`) is untouched — it already has its
  own independent, narrower-scoped HMAC (`generateCredentialToken`/`verifyCredentialToken`,
  bound to one `agentId`+`spaceId`). Fixed the one non-router caller (agents worker's
  connector-connect flow) to mint the token — and, in the same edit, a **pre-existing path
  bug**: it was calling `/v1/spaces/...` against a worker whose public routes are registered
  WITHOUT the `/v1` prefix, which would have 404'd on every real connector connect.
- **`/internal/triggers/fire`** (agents worker): replaced the static-string check with
  `verifyInternalToken` + an explicit `body.tenantId === header tenantId` cross-check (a valid
  token for tenant A must not be usable to fire a script against tenant B's space, even though
  the token itself verifies). `SpaceDO.fireMatchingTriggers` — the only caller — now mints the
  token via `mintInternalToken(this.env.PLATFORM_SECRET, tenantId)`.

**Explicitly out of scope for this pass (documented, not silently dropped):** the public
`/spaces/:spaceId/...` and `/kb/...` route surfaces in `workers/spaces`/`workers/knowledge`
are called directly (service-binding, bypassing the router) from ~15 call sites across
`NaelaoAgentDO`, provisioner, billing, and several prebuilt scripts. Gating those the same way
requires updating every one of those callers to mint a token — a larger, separate pass. Today
they're protected by `workers_dev = false` (layer 1) but have no defense-in-depth HMAC check
(layer 2) the way `/internal/triggers/fire` and the credentials CRUD routes now do. Tracked as
a follow-up; not yet built.

**Tests:**
- `tests/unit/packages/http-internal-hmac.test.ts` (9): `requireInternalHmac` rejects no-token,
  wrong-secret, tenant-mismatch, and expired-token requests; accepts a properly minted one;
  `mintInternalToken`/`verifyInternalToken` round-trip.
- `tests/unit/internal-triggers-fire.test.ts` (6): explicit regression proving the OLD
  forgeable `x-naelao-internal: spaces-trigger` string is now rejected, plus the same
  no-token/wrong-secret/tenant-mismatch/body-tenant-mismatch/valid-token matrix against the
  real route.
- `tests/unit/credential-hierarchy.test.ts` updated (still 20/20) to mint a real internal
  token via the test-helper `req()`, proving the credentials worker's public routes now require
  it end-to-end (real handler, not a mock).

---

## A1.16.9 Layer-3 backstop follow-up (§A1.16.8's deferred item) — BUILT

§A1.16.8 explicitly deferred gating the public `/spaces/:spaceId/...` and `/kb/...` routes'
~15 direct (non-router) callers, since doing it required touching every one of those call
sites. This pass does that.

**Newly gated (spaces worker):** `/spaces/:spaceId/projects[/:id[/rules]]`,
`/spaces/:spaceId/assistant-policy`, `/spaces/:spaceId/registry`, `/internal/business-services`
(POST+GET), `/internal/business-services/custom-domain-status`, `/internal/member-billing`,
`/internal/space-types/:id`, `/internal/space-types/:id/record-install` — all now require
`requireInternalHmac`. Several of these had even weaker checks than `/internal/triggers/fire`
did (any truthy `x-naelao-internal` header sufficed, not even a fixed string) — closed the same
way. **Newly gated (knowledge worker):** `/internal/semantic-cache/*` (lookup, store, DELETE) —
these had **no auth check of any kind**, not even a header presence check.

**Deliberately NOT gated this pass** (documented, not silently dropped): `/spaces/:spaceId/me/*`
(GDPR export + signed-download links — genuinely public, signature-authenticated, no JWT/tenant
context by design; gating them would break real end-user flows), `/spaces/:spaceId/sessions*`,
`/spaces/:spaceId/threads`, `/spaces/:spaceId/members*`, `/spaces/:spaceId/agent-definitions*`,
and `/spaces/:spaceId/kb/*` (knowledge worker) — these are plausibly also end-user- or
portal-reachable via paths this pass didn't have budget to fully verify; gating them without
confirming no legitimate non-router caller exists risked silently breaking real traffic.
Tracked as a further follow-up.

**Callers fixed to mint `mintInternalToken`:**
- `NaelaoAgentDO.ts` — added a shared `internalHeaders(tenantId, extra?)` helper, used by
  `fetchAssistantPolicy`, `fetchProjectConfig`, `fetchProjectRules`, `mirrorThread`,
  `writeConversationToSession`, and the `search_kb` tool dispatch (`ToolServices` gained a
  `platformSecret` field). `ScriptEngineEnv` gained an optional `platformSecret` field, set in
  `buildScriptEngineEnv`, so every prebuilt script can mint its own token.
- `workers/provisioner/src/index.ts` — `loadManifest` now takes a `tenantId` param; the
  `/registry` and `/record-install` calls mint tokens.
- `workers/billing/src/index.ts` — the seat-checkout → `/internal/member-billing` call now
  resolves the space's real `tenant_id` from `PLATFORM_DB` (previously sent no tenant context
  at all) and mints a token. Added `PLATFORM_SECRET` to `BillingEnv` (was missing entirely —
  billing worker had no way to mint an internal token before this).
- `workers/agents/src/index.ts` — the 3 `projects`/`from-template` calls, the bootstrap
  `/projects` call, and both `/internal/semantic-cache/*` calls now mint tokens.
- Prebuilt scripts (`business-email.ts`, `storefront.ts`, `commerce.ts`'s unused `spaces()`
  helper) — mint via `ctx.env.platformSecret`.

**Bug found and fixed in passing:** the knowledge worker mount used
`app.use("/internal/semantic-cache*", ...)` (no slash before `*`) — Hono does not match
sub-paths with that pattern (`/foo/bar*` does not match `/foo/bar/baz`; needs `/foo/bar/*`).
The middleware silently never ran. Caught by the new test asserting a 403 on an unauthenticated
request; fixed to `/internal/semantic-cache/*`.

**Tests:** `tests/unit/layer3-backstop-routes.test.ts` (8) — a representative sample of the
newly-gated routes (not exhaustive; the middleware itself is unit-tested in isolation)
proving each: rejects the OLD weak check style (static string / any-truthy-header) with 403,
accepts a properly minted token. `tests/unit/storefront-serving.test.ts` updated to supply
`platformSecret` in its mock `ScriptEngineEnv` (would otherwise throw `DataError: Zero-length
key is not supported` from `signHmac` on an empty-string secret).

---

## A1.16.10 Bucket A/B: the last direct-caller routes, plus a real product bug found — BUILT

§A1.16.9 left six routes deliberately ungated because gating them without verifying no
legitimate non-router caller existed risked silently breaking real traffic. Investigated each
one against the actual population model (spec A1.8: team members vs. portal customers are
structurally different — "never make product customers into SpaceDO members") by grepping
`apps/widget` and `apps/portal` for direct callers, rather than guessing from route names.

**Bucket A — confirmed builder/internal-only, gated with no further investigation needed:**
`/spaces/:spaceId/members*`, `/spaces/:spaceId/agent-definitions*`, `/spaces/:spaceId/threads[/:id]`,
and knowledge worker's `/spaces/:spaceId/kb/*`. Neither the widget nor the portal ever calls
any of these — team-member management, agent-definition config, structural thread browsing,
and KB retrieval are all server-side/dashboard concerns. Callers fixed: `lemon-squeezy.ts`'s
seat-activation → `/members` call (added `PLATFORM_SECRET` to `LemonSqueezyEnv`, which didn't
have it — same gap as `BillingEnv` in §A1.16.9), `agents/index.ts`'s agent-definition lookup
and KB-search-during-agent-run calls, and `knowledge-base.ts`'s three ops (search/index/delete).

**Bucket B — `/spaces/:spaceId/sessions*` — required real investigation, not just gating.**
This is the end-user chat transport, so gating it blind was the genuine risk §A1.16.9 flagged.
Investigation found: **the router mounts this path on its JWT-gated `api` sub-app
(`api.use("*", jwtAuth(...))`, no exceptions) — a Bearer token is already mandatory to reach
it via the router.** Neither `apps/widget/src/naelao-chat.ts` nor `apps/portal/src/lib/api.ts`
ever sends an `Authorization: Bearer` header — both only send `x-naelao-end-user-id`. The
portal's magic-link flow (`apps/portal/src/app/[spaceId]/auth/page.tsx`) does mint an
`auth_token` and store it (`storeAuthToken`), but **nothing ever reads it back out to attach
to a subsequent request** — grepping the whole `apps/portal/src` tree for its use turns up
only the write.

**This means end-user chat through the router is currently non-functional end-to-end** — a
real, product-level bug, entirely separate from and larger than this security pass (it needs
a customer-auth JWT flow: the router accepting something other than a builder JWT, and the
widget/portal actually sending it). It is NOT fixed here — that's a different, larger piece of
work. What it DOES mean for this pass: gating `/sessions*` with `requireInternalHmac` cannot
break currently-working end-user traffic, because no such traffic currently reaches this route
successfully. Gated it; the one direct (non-router) caller,
`NaelaoAgentDO.writeConversationToSession`, already minted the token as of §A1.16.9.

**Tests:** extended `tests/unit/layer3-backstop-routes.test.ts` (+7) covering members,
agent-definitions, threads (reject + accept), sessions/messages (reject + accept, the exact
shape `writeConversationToSession` sends), and knowledge's `kb/search`.

**Follow-up, not part of this security pass:** the end-user auth gap found above (portal
mints a magic-link token, never sends it back) should get its own pass — design the
customer-auth JWT the router will accept, and wire `apps/widget`/`apps/portal` to actually
attach it.

---

## A1.16.11 Space creator was never registered as a member of their own space — FIXED

Traced while discussing the reseller ("customer creates their own business") flow: a space's
creator was never inserted into `space_members`. Confirmed by grepping the entire platform —
`INSERT INTO space_members` occurs in exactly one place (`SpaceDO.addMember`), and its only
caller anywhere was `billing/lemon-squeezy.ts`'s paid-seat activation. Neither `POST /spaces`
(a normal builder) nor `POST /reseller/spaces` (a customer creating their own business) ever
called it — both just enqueue `PROVISION_QUEUE` and the 10-step provisioner never touched
`space_members` either. Root cause: `ProvisionMessage` didn't even carry a `userId` field, so
the provisioner had no identity to register even if it tried.

**Why this wasn't obviously broken:** the primary authorization path doesn't read
`space_members` at all — `x-naelao-role` comes from a global per-user role on the `users`
table, set at signup and carried in the JWT, independent of any specific space. So ordinary
access checks worked fine and masked the gap.

**Where it actually bites:** `SpaceDO.checkCrossSpace` (spec §49's cross-department access
gate) grants "direct member" access by querying `space_members` for `(target_space_id,
user_id)`. Since the owner was never in that table, this check would deny the owner "direct
member" status of their own space (not yet exploited — nothing currently calls this endpoint,
but a live landmine for whenever cross-space KB/thread grants get wired up). Team-listing UI
would also show an empty roster for every space, including to its own owner.

**Fix:** `ProvisionMessage` gained an optional `userId` field, set by both `POST /spaces` and
`POST /reseller/spaces` from `getCallerIdentity(c).userId`. New provisioner step 5c
(`seedOwnerMember`, `workers/provisioner/src/index.ts`, extracted as its own testable exported
function) registers that user as `role: 'owner'` via the (now `requireInternalHmac`-gated,
§A1.16.10) `/spaces/:spaceId/members` route, minting the token itself. Idempotent (`addMember`
upserts on conflict) and non-fatal on failure (a member-seed failure must never roll back an
otherwise-successful provision — logs a warning and continues). Serves both the normal-builder
and reseller-customer paths identically, since both funnel through the same provisioner; for
the reseller path the token is minted against the CUSTOMER's own new child tenant (not the
reseller's), matching where their new space actually lives.

**Reseller economics — verified already fully wired, not new work.** While tracing this, also
confirmed the "product owner sees their customers, controls their access, earns a share"
questions are already built end-to-end, not something this fix needed to add:
- `GET /reseller/clients` — customer list + current-period rollup (retail/wholesale/margin).
- `GET /reseller/clients/:childTenantId` — one customer's businesses (drill-down).
- `GET /reseller/statement?period=` — consolidated wholesale invoice, grouped by currency,
  with a per-client breakdown (the G-AS34/G-AS35 wholesale-invoicing deliverable).
- `POST /reseller/clients/:childTenantId/status` — suspend/reactivate a customer; suspension
  cascades to all of that customer's spaces so their agents stop running.
- `POST /reseller/clients/:childTenantId/promote` — sever the reseller relationship, making
  the customer's business fully independent (one-way, explicit acknowledgement required).
- Revenue share: `reseller_accounts.billing_relationship` is either `"reseller"` (the reseller
  buys wholesale at a fixed `wholesale_cents`, keeps the retail/wholesale spread as margin) or
  `"referral"` (Naelao collects retail, pays the reseller `referral_share_pct` of it) —
  `computeResellerAttribution` (`packages/billing-core/src/reseller.ts`) computes this per
  event, and `recordResellerAttribution` (`billing/lemon-squeezy.ts`) fires on EVERY billing
  event on EVERY space, walking `tenant_hierarchy` to find the parent reseller and writing a
  `reseller_ledger` row — meaning revenue from a reseller customer's own end-customers rolls
  up automatically, no separate wiring needed per business.
- This machinery reads tenant identity from the JWT (`getCallerIdentity`), not `space_members`
  — so it was unaffected by the owner-membership gap above.

**Tests:** `tests/unit/provisioner-owner-member.test.ts` (4) — owner registered with a verified
token scoped to the right tenant, no-op (not a throw) on missing userId, no-op (not a throw)
on a failed downstream call, and the reseller child-tenant token-scoping shape specifically.

---

## A1.16.12 `removeMember` was unscoped — cross-space member deletion — FIXED

`SpaceDO.removeMember` (`workers/spaces/src/do/SpaceDO.ts`) ran `DELETE FROM space_members
WHERE user_id = ?` with no `space_id` predicate, even though `space_members` is keyed
`(space_id, user_id)` and one SpaceDO can host more than one space row (a sub-space/department
registry — see A1.16.9's threads/agent-definitions gating for the same "one DO, many spaces"
shape). Removing a member from one department silently removed them from every other space
that DO hosted, including the root space — a real correctness/authorization bug: `addMember`
always wrote a space-scoped row, but the only way to remove one un-scoped anything sharing
that `user_id` in the same DO.

**Fix:** the DELETE route (`DELETE /members/:userId`) now reads `space_id` from the query
string — the members proxy in `workers/spaces/src/index.ts` already appends `?space_id=...`
to every forwarded request (same as `GET /members?space_id=` does), so no proxy change was
needed. `removeMember(userId, spaceId)` now runs `DELETE FROM space_members WHERE space_id = ?
AND user_id = ?`, and returns 400 if `space_id` is missing rather than silently falling back
to an unscoped delete.

**Tests:** `tests/unit/space-members-scoping.test.ts` (3), against a real `SpaceDO` + real
SQLite (`sqlite-do-shim`, the same pattern as `space-collaboration.test.ts`): removing a user
from one space in a DO hosting two spaces leaves their membership in the other space intact
(the actual regression); a delete with no `space_id` is rejected (400) rather than silently
falling through to an unscoped delete; removing a user who isn't a member of the target space
is a harmless no-op.

---

## A1.16.13 Three scheduled-jobs defects: false-fire on creation, infinite retry, no visibility — FIXED

Three defects in the time-based scheduling dispatcher (`runScheduledJobs`,
`workers/agents/src/index.ts`), found in a targeted follow-up review of A1.16.7's original
implementation.

**1. A newly created job could fire immediately for a cron minute that predates it.**
`isCronDue` was floored at `row.last_run_at ?? 0` — a never-run job's scan floor was
effectively "the beginning of time" (bounded only by `isCronDue`'s 8-day lookback). A daily
`"0 9 * * *"` job created at 3pm would fire immediately, because 9am *that same day* falls
inside the 8-day lookback window even though the job didn't exist yet. Migration 0041's own
comment already promised `created_at`-based behavior that was never implemented. Fixed: the
query now selects `created_at`, parsed as UTC (`Date.parse(created_at + "Z")` — SQLite's
`datetime('now')` text has no timezone suffix), and the floor is
`row.last_run_at ?? createdAtMs`.

**2. A permanently failing job retried every hourly sweep forever.** `last_run_at` was only
written on a successful fire, so a job with a bad script name, a since-deleted script, or (via
the same code path) a malformed `cron_expression` would re-attempt the identical due minute on
every single sweep indefinitely — unbounded DO wakes and log spam with no way for a builder to
notice short of watching logs.

New migration `infra/migrations/0042_scheduled_jobs_failures.sql`: adds
`consecutive_failures INTEGER NOT NULL DEFAULT 0` and `last_error TEXT`; recreates
`idx_scheduled_jobs_dispatch` as `(enabled, space_id)` (the dispatch query filters `enabled=1`
AND joins on `space_id` — the old single-column index never matched that access pattern).

Dispatcher change (`recordScheduledJobFailure`): on a failed fire *or* a thrown error (e.g. an
unparseable cron), `last_run_at` now advances too — the due minute was "consumed" either way,
which is what actually stops the infinite retry — plus `consecutive_failures` increments and
`last_error` is stored (truncated to 2000 chars). On success, both reset to a clean state
(`consecutive_failures = 0, last_error = NULL`). At `SCHEDULED_JOB_MAX_CONSECUTIVE_FAILURES`
(5) the job auto-disables (`enabled = 0`) and fires a `scheduled_job.disabled` event so a
builder can wire a no-code notification to it — same mechanism every other structural
mutation (`thread.created`, `project.created`, `project.possible_duplicate`) already uses, not
a new one-off. Since nothing outside SpaceDO could previously fire an *arbitrary* event
through `fireMatchingTriggers` (every prior caller was SpaceDO firing its own internal
mutations), added a minimal internal route for it: `POST
/internal/spaces/:spaceId/events/fire` (spaces worker, `requireInternalHmac`-gated, forwards
to a new `SpaceDO.fireExternalEvent` handler that resolves `tenantId` from the caller's own
verified `x-naelao-tenant-id`, matching the trust model of every other internal route in this
build).

**3. The failure state was invisible to the builder.** `GET /spaces/:spaceId/scheduled-jobs`
now returns `consecutive_failures` and `last_error` alongside the existing fields.

**Tests:**
- `tests/unit/scheduled-jobs.test.ts` extended to 17 (from 12): a new job created after its
  cron's most recent due minute does not fire (the actual B5-class regression, deterministic —
  picks a cron minute guaranteed not to be "now"); a failed fire records
  `consecutive_failures=1` + `last_error` + advances `last_run_at`; the 5th consecutive failure
  disables the job and fires the `scheduled_job.disabled` event with the right payload; the
  4th failure does NOT yet fire the disable event; a successful fire after prior failures
  resets the counter and clears the error. CRUD tests now load migration 0042 too and assert
  the new fields round-trip through `GET`.
- `tests/unit/space-fire-external-event.test.ts` (5, new) — direct `SpaceDO` + real SQLite
  coverage of `POST /internal/events/fire`: fires a matching trigger, no-ops when no trigger is
  configured, rejects a missing tenant header or a malformed body, and — the isolation
  case — a trigger configured for a *different* space in the same DO does not fire.

---

## A1.16.14 Hourly sweep converted to a CF Queues fan-out — subrequest-limit fix — FIXED

The hourly `scheduled()` handler (`workers/agents/src/index.ts`) ran `pollConnectors`,
`runChannelHeartbeats`, and (as of A1.16.13) `runScheduledJobs` **serially, inside one Worker
invocation** — 1-2 awaited subrequests per space/job, all counted against that single
invocation's subrequest budget. At a few hundred active spaces this exceeds the Workers
platform's 1000-subrequest-per-invocation ceiling (a CLAUDE.md-documented invariant), silently
dropping the tail of the roster every hour with no error surfaced anywhere.

**Fix: `scheduled()` is now enumerate-and-enqueue only.** It runs the same three cheap D1
roster queries as before, plus the `isCronDue` check for scheduled jobs — all pure computation
and D1 reads, zero subrequests to any DO — then hands one message per due tick to a new
`AGENT_TICKS` queue via `sendBatch` (chunked at 100, CF Queues' per-call limit).
`enqueueAgentTicks` replaces `pollConnectors` + `runChannelHeartbeats` +
`runScheduledJobs`'s planning half.

**A new `queue()` consumer (`handleAgentTicksQueue` → `handleAgentTick`) does the actual DO
fetches — one message, one Worker invocation, its own fresh 1000-subrequest budget.** Each
`kind` ("heartbeat" | "scheduled_job" | "connector_poll") runs the exact same DO-fetch bodies
the old serial loop did, moved over near-verbatim, just dispatched per-message instead of
per-row-in-a-loop. `scheduled_job` messages carry only `jobId` and re-fetch the row fresh
inside the consumer (not the enqueue-time snapshot) — at-least-once delivery means a
redelivered message could arrive after the job was already disabled or reconfigured, and acting
on stale data would be wrong regardless of the subrequest-budget question.

**Why at-least-once delivery (CF Queues' guarantee) is safe here without extra locking:**
`last_run_at` now advances on EVERY fire attempt, success or failure (A1.16.13's
`recordScheduledJobFailure` + the success-path UPDATE) — so a redelivered `scheduled_job`
message for a due-minute that already fired is a no-op the moment it re-checks (it doesn't
re-check `isCronDue` at all; it just re-fires via the still-fresh row, since the enqueue-time
decision already happened once and CF Queues redelivery means "try this exact tick again," not
"re-evaluate whether it's still due"). The one narrow, accepted risk: a redelivery landing in
the gap between a successful `fireScriptDirectly` and the `last_run_at` UPDATE actually
committing could double-fire a script — accepted as rare and bounded rather than adding
cross-invocation locking for it (documented in code at `handleAgentTick`'s doc comment, not
just here).

**Infra:** `[[queues.producers]]`/`[[queues.consumers]]` added to
`workers/agents/wrangler.toml` for `naelao-agent-ticks` (max_batch_size 100, max_retries 3,
`naelao-agent-ticks-dlq`), mirroring the exact shape every other worker's queue config already
uses (`workers/billing`, `workers/notifications`, `workers/provisioner`, `workers/workflows`).
New `cloudflare_queue.agent_ticks` Terraform resource in `infra/terraform/main.tf` — named
literally (`naelao-agent-ticks`, not the `${local.name_prefix}-...` template the other 6
`cloudflare_queue` resources use) because that's the literal name wrangler.toml's bindings
require, matching every sibling worker's queue.producers entry (none of which use the template
either — a pre-existing Terraform/wrangler naming inconsistency this doesn't attempt to fix
platform-wide). Also matching precedent: no separate DLQ Terraform resource, since none of the
four existing `dead_letter_queue` references anywhere in the repo (billing, notifications,
provisioner, workflows) have one either.

**Tests:** `tests/unit/scheduled-jobs.test.ts`'s dispatcher section rewritten (12 tests →
24) into two new `describe` blocks in place of the old `runScheduledJobs` one (CRUD tests
untouched):
- `enqueueAgentTicks` (8) — the **planning** step: roster rows in, expected messages out.
  Heartbeat/connector_poll/scheduled_job message shapes, the isCronDue due/not-due split, the
  B5 created_at-floor regression carried into the planning phase, a malformed cron records a
  failure without enqueueing, mixed-kind sweeps combine correctly, and >100 messages chunk
  into multiple `sendBatch` calls (250 → 100+100+50).
- `handleAgentTicksQueue` / `handleAgentTick` (14) — the **consumer**: each kind's DO calls
  fire correctly (heartbeat's two calls, connector_poll's goal/context, scheduled_job's
  fresh re-fetch by id), a job deleted/disabled since enqueue acks harmlessly, a failed fire
  records the failure and still acks (never retries a script-level failure — only a
  queue/DO-dispatch-level throw does), multiple messages in one batch process independently,
  and a genuine thrown error (DO unreachable) retries rather than acks. Plus two direct
  `handleAgentTick` no-op-guard tests (missing `connectorName`/`jobId`).

641 unit/contract/integration/isolation/simulation tests pass; 72/72 typecheck clean.
