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

**Honest scope note on `reserved-capabilities.ts`.** The guard described above — a substring host
denylist (`EXTERNAL_PAYMENT_HOSTS`) plus self-declared tags/domain on a script being authored —
is **defense in depth, not the primary revenue control**. It's bypassable: string
concatenation/encoding around the substring match, or simply reaching a payment processor that
isn't yet in the list, both slip past it; the tags/domain check only catches a script that
honestly states what it's doing. The actual guarantee is **credential possession**: only the
`commerce` prebuilt holds the Lemon Squeezy store API key (a Workers Secret on the billing
worker, itself gated by `requireInternalHmac` — F20 / A1.16.25), and no execution tier this
engine grants a script ever exposes that secret to script code. A script that fully evades this
file's checks still cannot actually charge anyone without Naelao's credentials — worst case it
fails loudly against a real processor with no key. This file exists to catch the honest/careless
case early with a clear error, not to be an airtight sandbox. It's also deliberately not trying
to block **Model A** (the connector/automation-layer platforms — Whop, Gumroad, etc., see
`connectors/catalogue.ts`): those are read-mostly, the **connected platform** processes the sale
on the builder's own account, and Naelao is paid for the labor, not a cut — that's the intended
product, not a gap in this guard. One small hardening landed alongside this note:
`isReservedPaymentHost` (used by the mcp-connector registration gate) now also rejects a bare
IP-literal host outright, since a real payment processor is always DNS-named and an IP literal
is one of the cheapest ways to dodge a hostname-substring match — still defense in depth, not a
claim of completeness.

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

---

## A1.16.15 Presence rows never deleted — unbounded DO SQLite growth — FIXED

`presence`'s primary key is `(space_id, user_id)`, so `heartbeatPresence` upserts rather than
inserts a fresh row every time — but `isPresenceFresh` only filters `GET /presence`'s "who's
active" list, it never deletes anything. A row created by a departed team member or a
one-time invitee lives in the table forever, so a space's presence table grows monotonically
with its total historical distinct-heartbeat-user count, not its current active count.

**Fix:** `heartbeatPresence` now runs an opportunistic prune after its upsert —
`DELETE FROM presence WHERE space_id = ? AND last_seen_at < ?` with a 24h cutoff
(`PRESENCE_PRUNE_CUTOFF_MS`, exported from `SpaceDO.ts`) — deliberately much longer than
`PRESENCE_FRESHNESS_WINDOW_MS` (~90s, the "who's active right now" GET filter) so it only ever
removes rows that were never going to show as active again regardless. No alarm/cron needed:
every heartbeat sweeps its own space's stale rows as a side effect, bounding growth without
adding a new scheduled job to the platform.

**Tests:** `tests/unit/space-collaboration.test.ts`'s "SpaceDO — presence" block extended (+2,
20 → 22): both tests construct the DO with direct access to the underlying `DOSqlStorage`
(not just the HTTP `call` helper) because `GET /presence` returns identical results — "not in
the response" — whether a stale row was pruned or merely filtered; distinguishing "physically
deleted" from "filtered from the active list" requires querying the raw table. A row past the
24h cutoff is confirmed gone from the table (`COUNT(*) = 0`) after a *different* user's
heartbeat triggers the prune; a row past the ~90s freshness window but still under 24h is
confirmed filtered from `GET /presence`'s response while still physically present in the
table (`COUNT(*) = 1`).

643 unit/contract/integration/isolation/simulation tests pass; 72/72 typecheck clean.

---

## A1.16.16 `enqueueAgentTicks` rosters were unbounded — enumeration ceiling at platform scale — FIXED

A1.16.14 moved the hourly sweep's DO *fetches* to a CF Queues fan-out, fixing the
1000-subrequest-per-invocation ceiling — but the **enumeration** feeding that fan-out was still
three single, unbounded `SELECT ... WHERE enabled = 1` queries (connectors via `mcp_servers`,
channel heartbeats via `channel_links`, scheduled jobs via `scheduled_jobs`), each pulling every
enabled row across every space on the platform into one Worker's memory in one D1 read. That's
fine at a few hundred Spaces; it is not a query that survives to "millions of Spaces" — D1's
result-set size and the Worker's ~128MB memory ceiling would be hit long before then, and the
failure mode (a truncated result set or an OOM) is silent from the outside — jobs simply stop
being enqueued for spaces past the ceiling.

Also corrected in passing: CLAUDE.md's Stack section claimed D1 is "sharded by tenant_id MOD
n" — no shard-routing code exists anywhere in the repo, every worker's `wrangler.toml` binds
the same single `naelao-platform` D1 database, and there is exactly one `cloudflare_d1_database`
Terraform resource. That claim was the documented "answer" to this scale ceiling, and it wasn't
built — leaving it in place would have let a future pass reason from a false premise. Reworded
to state the current reality (single instance) with sharding named as a future milestone, not
implemented here (this pass is enumeration pagination only, which is a prerequisite either way —
each shard will still need to paginate its own slice).

**Fix:** each of the three rosters in `enqueueAgentTicks` (`workers/agents/src/index.ts`) is now
keyset-paginated in `AGENT_TICKS_PAGE_SIZE` (1000) row pages instead of one unbounded query:
- **Connectors** (`mcp_servers`, has an `id TEXT PRIMARY KEY`): paginated directly on
  `m.id > ? ORDER BY m.id LIMIT ?`, alongside the existing `m.name IN (...)` pollable-connector
  filter.
- **Channel heartbeats** (`channel_links`): this table's primary key is the `(space_id,
  channel)` pair — there's no single `id` column to page on — so the roster is paginated
  directly on `cl.space_id > ? ORDER BY cl.space_id, cl.channel LIMIT ?` (raw, non-deduplicated
  rows) and deduplicated to one heartbeat message per space in-memory via a `Set`, matching the
  original query's `SELECT DISTINCT cl.space_id` semantics. A space with multiple enabled
  channels only ever produces one heartbeat message regardless of which page its rows land on.
- **Scheduled jobs** (`scheduled_jobs`, has an `id TEXT PRIMARY KEY`): same shape as connectors,
  `sj.id > ? ORDER BY sj.id LIMIT ?`. The `isCronDue` check, the `created_at` floor, and
  `recordScheduledJobFailure` on a malformed cron are all unchanged — they still run per-row,
  just now per-row-within-a-page instead of per-row-within-one-giant-result-set.

Each roster loop terminates when a page returns 0 rows or fewer than the page size (no separate
COUNT query needed). One Analytics Engine data point (`agent-ticks.enumerated`) is written per
sweep with the total rows enumerated and the total messages produced, so the enumeration
ceiling becomes visible via a metric well before it could ever be silently hit — the specific
gap in the previous state, where the entire query result would just be pulled into memory with
no observability into how large that pull was getting as the platform grew. The queue consumer
(`handleAgentTick`) and the 100-message `sendBatch` chunking are untouched — this is purely the
planning/enumeration phase.

**Tests:** `tests/unit/scheduled-jobs.test.ts`'s `makeEnqueueEnv` mock D1 rewritten from
"return the whole fixture array on every `.all()` call" to a real `paginate()` helper that
filters by `sortKeyOf(row) > cursor`, sorts, and slices to the bound `LIMIT` — the same cursor
and limit `enqueueAgentTicks` now binds as the last two positional params on every query — so
existing small-roster tests exercise the *real* pagination path (naturally terminating after one
page returns fewer rows than the limit) rather than a mock that ignores pagination entirely.
Three new tests (+3, 24 → 27) confirm a roster spanning multiple 1000-row pages is enumerated
completely with no lost or duplicated rows: 2500 scheduled jobs (3 D1 page calls: 1000 + 1000 +
500), 1500 connectors (2 calls: 1000 + 500), and 1200 channel-heartbeat spaces (2 calls: 1000 +
200) — each asserting both the total message count and that every id/spaceId is unique (no
duplicate enqueue across a page boundary).

664 unit/contract/integration/isolation/simulation tests pass; typecheck clean
(`@naelao/agents-worker`).

---

## A1.16.17 Second audit pass — cross-tenant KB read/write (F8), per-thread spend-cap undercounting (F9), and a global spoofable rate limiter (F7) — FIXED

A second independent read of the platform surfaced three more findings, two more severe than
anything in A1.16.9-16 — F8 is an exploitable-today cross-tenant data exposure, F9 means the
flagship customer-bot money control doesn't actually bind. Fixed in dependency order (E → F →
G): tenant isolation first (active exposure), then money (real spend), then abuse-hardening on
a rate limiter that "worked" today.

### F8 — `kb/search` (and the rest of `kb/*`) never verified the caller's tenant owns the space

`GET /spaces/:spaceId/kb/search` (`workers/knowledge/src/index.ts`) extracted `tenantId` via
`requireTenant` and never used it: the Vectorize filter was `{space_id: {$eq: spaceId}}` alone,
and the semantic-cache key was `sha256Hex(query + spaceId)` — no tenant anywhere. Any caller
who merely knew or guessed another tenant's `spaceId` (UUIDs leak via URLs, logs, screenshots)
could search that tenant's KB. A prior pass (A1.16.9/10) had deliberately left `kb/*` ungated by
`requireInternalHmac` reasoning as "plausibly reachable" — that HMAC gate authenticates the
*calling worker*, not which tenant the request claims to act on behalf of, so a compromised or
malicious agent script belonging to tenant A could still pass a `spaceId` belonging to tenant B.

Worse on inspection: `POST /spaces/:spaceId/kb/documents` (ingest) had the exact same gap in the
opposite direction — it never verified spaceId ownership before writing, so tenant A could
*write* content into tenant B's KB. Since `kb/search`'s Vectorize filter is space-scoped only
(not tenant-scoped), that write would later surface in tenant B's own searches — a cross-tenant
KB-poisoning path, worse than the read leak alone.

**Fix:** one ownership gate, applied once via Hono middleware ahead of every verb —
`app.use("/spaces/:spaceId/kb/*", ...)` — checking `SELECT 1 FROM spaces WHERE id = ? AND
tenant_id = ? AND status != 'deleted'` before any handler (list, ingest, patch, delete, search)
runs, 404 on mismatch (not 403 — space existence isn't an oracle). This runs before the KV
semantic-cache lookup in the search route, and the cache key now also folds `tenantId` in
(`sha256Hex(tenantId + ":" + query + spaceId)`) as defense-in-depth against a future refactor
that might move the gate after the cache check.

**Tests:** `tests/unit/kb-tenant-isolation-all-routes.test.ts` (new) proves the gate covers
list/ingest/delete — wrong-tenant ingest never inserts, wrong-tenant delete never deletes — and
that a cache entry written under one tenant's search is never served to (or collides with) a
different tenant's identical query. `tests/unit/kb-search-tenant-isolation.test.ts` (existing,
from the first pass) continues to pass unchanged.

### F9 — customer-bot daily spend cap was tallied per-DO, not per-project

`project_spend` (`workers/agents/src/do/NaelaoAgentDO.ts`) lived in the agent DO's own SQLite,
and the cap check was `getProjectSpendToday(projectId) >= cap` against that local table. But
agent DOs are addressed `space:project:thread` (a direct `/script/run` session) or
`space:agentId` (the channel-heartbeat drain) — either way, **every thread/DO instance serving
a customer-bot project kept an independent, zero-based tally**. A project with N concurrent
customer threads (or channel traffic running alongside a direct session) could spend up to N×
its configured daily cap — the flagship customer-bot safety knob didn't actually bind.

**Fix:** moved the authoritative tally to SpaceDO — one DO per space, so every thread's agent DO
debits through the *same* instance regardless of how many concurrent threads/channels a project
has. New migration v17 adds a `project_spend (project_id, day, credits)` table to `SpaceDO`
(`workers/spaces/src/do/SpaceDO.ts`), plus `GET/POST /projects/:projectId/spend`:
- `GET` (and `POST` with `credits: 0`) is a pure read of today's tally + the project's
  `daily_spend_cap_credits` + a `capped` boolean — used as the pre-run gate.
- `POST` with `credits > 0` atomically adds to today's tally (`ON CONFLICT ... DO UPDATE SET
  credits = credits + excluded.credits`) and returns the updated total — used post-run once the
  actual token cost is known.

Both routes are serialized by the DO's single-threaded request handling, so spend recorded by
one thread's post-run debit is immediately visible to the next thread's pre-run gate check —
this is why a `credits=0` "check" and a real debit are the same endpoint, not two independent
code paths that could drift.

`NaelaoAgentDO.checkAndDebitProjectSpend(spaceId, tenantId, projectId, credits)` replaces the
local-table cap check in both `handleScriptRun` (direct `/script/run`, was gated by F14 in the
first pass but against the same flawed local tally) and `handleChannelHeartbeat` (the
channel-drain loop, which the first audit pass believed was "the one place it works as intended"
— true only if a project never receives traffic through more than one agent DO, which a
customer-bot project bound to both a channel AND directly-addressable sessions can). **Fails
CLOSED**: any error (network, non-2xx, missing `SPACES_WORKER`) is treated as `capped: true`,
matching the `fetchAssistantPolicy` precedent — a spend limiter that fails open isn't one. The
local `project_spend` table in `NaelaoAgentDO` is kept, but only as that DO's own
telemetry/cache — it is no longer read for the enforcement decision.

Note this pattern still tolerates a bounded overshoot of "one in-flight run's worth of credits"
by design: the pre-run gate can only check *already-recorded* spend (the actual cost of a run
isn't known until it finishes), so two threads that both pass the gate microseconds apart can
each complete a run before either's debit lands. This is the same tolerance the first pass's
F14 fix accepted; true zero-overshoot enforcement would need an upfront cost reservation this
architecture doesn't have (LLM cost isn't knowable before the call completes) — noted, not
treated as a gap in this pass.

**Tests:** `tests/unit/spacedo-project-spend.test.ts` (new) drives the real SpaceDO over real
in-memory SQLite (`node:sqlite`) and proves the core fix directly: two independent debit calls
against the same project (standing in for two separate agent-DO threads, each of which would
previously have started from a local zero) correctly sum to a shared total, and a third
"thread"'s gate check sees the combined spend — capped once it crosses the configured limit.
Also: a fresh/uncapped project (`cap=0`) is never capped regardless of debits; a `credits=0`
call is a pure read that never mutates the tally; and spend for one project never leaks into
another project's row. `tests/unit/handlescriptrun-spend-cap.test.ts` and
`tests/unit/naelaoagentdo-customer-bot-heartbeat.test.ts` (both pre-existing, from the F14 pass)
were rewritten to seed spend through a stateful mock of the new `/spend` endpoint instead of
calling the now-non-authoritative `addProjectSpend` directly, plus a new fail-closed test
(SpaceDO unreachable → 429, never falls through to the reasoning loop).

### F7 — rate limiter: one global DO for the whole platform + a spoofable bucket key + unbounded rows

`workers/router/src/index.ts`'s rate-limit middleware called
`RATE_LIMIT_DO.idFromName("global-rate-limiter")` — every authenticated request on the entire
platform serialized through **one** Durable Object, capping total platform throughput at a
single DO's capacity and adding a cross-region hop to every request (the same class of mistake
as A1.16.16's F1, except on the hot path of all traffic rather than an hourly cron). The bucket
key was `claims?.sub ?? c.req.header("x-forwarded-for") ?? "anonymous"` — `X-Forwarded-For` is
set by the client on the first hop, so an unauthenticated attacker could rotate it to mint
unlimited fresh buckets (bypass) or converge traffic onto a victim's IP (targeted starvation);
all no-XFF traffic also shared one literal `"anonymous"` bucket. `RateLimitDO`'s `buckets` table
was never pruned — same defect class as the presence table fixed in A1.16.15, worse here because
the spoofable key let an attacker mint rows deliberately.

**Fix:**
- Shard: the router now calls `RATE_LIMIT_DO.idFromName(bucketKey)` directly — one DO per key
  instead of one DO for the whole platform. Token-bucket state per key is a single small row,
  so per-key DOs remove the chokepoint entirely and each key's traffic stays local to its own DO.
- Key: `claims?.sub ?? c.req.header("cf-connecting-ip") ?? "anonymous"` — `cf-connecting-ip` is
  set by Cloudflare's edge and cannot be spoofed by the client, unlike XFF.
- Prune: since a sharded DO now holds at most one key's row, `RateLimitDO` reschedules a DO
  alarm (`ctx.storage.setAlarm`) on every `/check` call (`IDLE_CLEANUP_MS` = 10 minutes) instead
  of extending it only on demand — the alarm only actually fires once a DO has seen no traffic
  for the full idle window, at which point it clears its own `buckets` table. No sweeper needed.
- Preserved exactly: token-bucket math (capacity = 2× per-minute limit, refill = limit/60 per
  second), the 120/min default, fail-open on error, and the `X-RateLimit-*` response headers.

**Tests:** `tests/unit/router-rate-limit-sharding.test.ts` (new) mocks the `RATE_LIMIT_DO`
namespace to record `idFromName` calls and proves: the key is the JWT `sub` (not a global
constant), `X-Forwarded-For` is never read (even when both XFF and `cf-connecting-ip` are
present, only the JWT `sub` — or in its absence `cf-connecting-ip` — drives the key), and two
different users land on two different DO ids. `tests/unit/rate-limit-do.test.ts` (new) drives
the real `RateLimitDO` and proves the alarm is rescheduled on every `/check` call and that a
fired alarm clears the bucket (next check starts from a fresh full-capacity bucket).

681 unit/contract/integration/isolation/simulation tests pass across 70 files; 72/72
typecheck clean.

---

## A1.16.18 Third audit pass (spec-vs-code) — F10/F11/F13 were already fixed; F12 (KV usage counter) was real, fixed with a smaller diff than the spec's literal prescription

A third pass read the canonical spec bottom-up (not just the code) and diffed four
spec-mandated Required Fixes against the implementation, citing G-AF14/16/20 by byte offset.
Verifying each against the actual current code (not the pre-fix state) before touching
anything:

- **F10 (Tier-2/3 isolates get raw, unguarded `fetch`, spec G-AF20)** — **already fixed**, in
  the same pass that closed F13 for the browser worker (see A1.16 Track B/F10+F13 above,
  commit tagged `9a541e1`-equivalent). `workers/agents/src/script-engine/code-runner.ts`'s
  `SSRF_GUARD_PRELUDE` overrides `globalThis.fetch` inside the isolate module text itself
  (`__ssrfGuardedFetch`), and the injected `ctx.fetch` calls that same guarded function — not
  the bare `fetch`. Confirmed by reading the current file (not assuming from memory): lines
  ~87-114 show the guard, line ~124 shows `ctx.fetch: (...a) => __ssrfGuardedFetch(...a)`.
- **F13 (SSRF guard is hostname-literal only, no DNS resolution, spec G-AF20 second half)** —
  **already fixed** in the same pass. The isolate's `SSRF_GUARD_PRELUDE` includes
  `__resolveIps(hostname)` (Cloudflare DoH query for A + AAAA records) and
  `__ssrfGuardedFetch` blocks if ANY resolved IP matches the deny list, in addition to the
  literal-hostname check — closing exactly the DNS-rebinding bypass the spec's clause exists
  for. `@naelao/security`'s `checkSsrf`/`resolveHostnameIps` (used by the browser worker) has
  the equivalent resolution step.
- **F11 (CORS is `*` platform-wide, spec G-AF14)** — **already fixed**, in the first audit
  batch (Track D). `workers/router/src/index.ts`'s CORS middleware (~line 104) is not
  `cors(["*"])` from `packages/http/src/cors.ts` at all — it's a custom, env-driven
  (`CORS_ALLOWLIST`) allowlist middleware that never echoes `*`, reads the allowlist per-request
  (`c.env`, not baked in at module load), and returns an empty `Access-Control-Allow-Origin` for
  a non-allowlisted origin. Regression coverage already exists in
  `tests/unit/router-cors-allowlist.test.ts`.

All three were re-flagged by a spec-vs-code diff that was, in effect, diffing the spec against
a **pre-fix snapshot of the code** rather than its current state — the fixes exist, match the
spec's own Required Fix text (deny-list ranges, DNS resolution, allowlist-not-wildcard), and
have passing regression tests from the passes that introduced them. No changes made for these
three; this section exists so a future pass doesn't re-flag them a third time without checking
first.

### F12 — `incrementUsage`'s KV read-modify-write (spec G-AF16) — real, but narrower in blast radius than described

The gap is real: `workers/billing/src/quota.ts`'s `incrementUsage` did `kv.get` → `parseInt` →
`kv.put(value + delta)` with a sliding `expirationTtl` reset on every write — not atomic
(concurrent calls can lose increments), and continuous traffic could keep resetting the TTL
forward indefinitely, turning a bounded ~300s staleness window into potentially unbounded
drift under sustained load.

Two things the initial framing got wrong, checked before fixing anything (worth recording so a
future pass doesn't inherit the same overstatement):
1. **This is not the enforcement path.** `checkQuota`'s `allowed` boolean (the thing this KV
   counter feeds) is computed in `workers/billing/src/index.ts`'s quota-summary handler but
   never read to block anything — it's returned in a `GET .../quota`-style response body for a
   dashboard usage meter. The actual quota/entitlement enforcement used platform-wide (spaces
   worker, agents worker, knowledge worker's KB-document-count gate) goes through
   `@naelao/entitlements`'s `EntitlementsChecker`, which runs a live `COUNT(*)` D1 query
   directly with no KV cache and no race window. So the bug is a dashboard-accuracy issue, not
   an active quota-evasion or revenue-leak vector — billing/metering itself (the actual revenue
   path) runs through `usage_events` (idempotent `INSERT OR IGNORE` on `event_hash`) and an
   async Stripe-metering queue, both untouched by this KV counter.
2. **The literal spec fix (a new `usage_metrics` D1 table with `UPDATE ... SET value = value +
   ?`) would introduce a second source of truth**, not fix the one that exists. This codebase's
   `getCurrentUsage` D1 fallback doesn't maintain an incrementable counter column at all — it
   recomputes a live aggregate (`COUNT(*)` over `spaces`/`kb_documents`, `SUM(quantity)` over
   `usage_events`) directly from the authoritative rows every cache-miss. That aggregate is
   already correct and atomic in the way that matters (it's a read of real committed rows, not
   an accumulator that can itself drift). Standing up a parallel `usage_metrics` counter table
   that must somehow stay in sync with that aggregate would trade one race for a
   two-sources-of-truth reconciliation problem — worse, not better.

**Fix:** `incrementUsage` → `recordUsageEvent` (renamed — the new semantics are different
enough that keeping the old name would mislead). Instead of trying to maintain a second,
independently-mutated number, it just `kv.delete`s the cache key on every usage event. The next
`checkQuota` call is forced back through the real D1 aggregate instead of trusting a number
nothing can prove is still correct — this eliminates the race entirely rather than moving it,
at the cost of one extra D1 read on the next post-invalidation quota check (acceptable: this
endpoint is a dashboard summary, not a hot path). Call sites updated in
`workers/billing/src/index.ts` (the two `event_type === "api_call"` / `"kb_doc"` branches after
a `usage_events` insert).

**Tests:** `tests/unit/quota-atomic.test.ts` (new) proves: `recordUsageEvent` deletes rather
than increments the cache entry; after invalidation, `checkQuota` recomputes fresh from D1
(reflects a D1 truth change the old code would have missed); without an intervening event, the
cache still serves the fast path (no extra D1 query — the read-through behavior is preserved);
20 "concurrent" usage events interleaved with D1 truth advancing one at a time land on an exact
final count with no lost updates (impossible by construction now, since there's no shared
counter value left to race on); and `invalidateQuotaCache` still clears all three metrics.

687 unit/contract/integration/isolation/simulation tests pass across 71 files; typecheck clean.

## A1.16.19 Templates ship pre-wired projects + starter threads, bound to their agents — BUILT

Closes a follow-on gap the audit's F18/F19 pass surfaced but didn't fix: Launchpad's core
agents (`launchpad-fulfillment-v1`/`-support-v1`/`-content-v1`) were installed at provisioning
but nothing in the data model said which project's work a given agent owns — a billing event
always woke the generic Space Assistant space-wide, never scoped to a project. The fix: a
project can now carry a **default_agent_id** (SpaceDO migration v18, `projects.default_agent_id`
nullable) — a DEFAULT only, never an enforced identity, freely reassignable/clearable via
`PATCH /spaces/:id/projects/:projectId { default_agent_id }`.

**Templates declare the binding as data.** `TemplateProjectSeed` (`launchpad/spacetype.ts`) lets
a template's `bootstrap.projects` entry be either a plain string (an unbound, reference-only
project — e.g. "Products", "Members", "FAQ": nothing runs there automatically) or
`{ name, default_agent_id }`. Every template that installs a fulfillment/support/content agent
now seeds a project bound to it: creator-store (Orders→fulfillment, Support→support),
newsletter-business (Content→content, Orders→fulfillment), micro-saas (Support→support,
Orders→fulfillment), service-agency (Deliverables→content, Client Communication→support),
coaching-community (Member Questions→support, Learning Materials→content), whop-seller
(Support→support, Content→content), customer-service (Inbox→support; Escalations/FAQ stay
unbound — human-review and reference surfaces, not agent-run). `validateLaunchpadSpaceType`
fails fast if a project's `default_agent_id` isn't one of that same template's own `agents`.

**`POST /spaces/:spaceId/bootstrap/complete`** (agents worker) now creates each seed project
carrying its `default_agent_id`, and — for any project that has one — seeds a single starter
thread in it (`POST /spaces/:spaceId/threads { project_id, title }`), so a builder opens on a
pre-wired workspace (projects + a starting thread per agent) rather than an empty space. A
project with no binding gets no starter thread. Backward-compatible: an older onboarding record
whose `projects` are plain strings (pre-migration) is normalized the same way a string seed is.

**Billing scoping.** `billing/lemon-squeezy.ts`'s `resolveFulfillmentProjectId` now matches
`default_agent_id === "launchpad-fulfillment-v1"` first (survives a rename — the binding is
authoritative), falling back to a project literally named "Orders" only for spaces provisioned
before this migration. Still entirely best-effort: no project, an unreachable SPACES_WORKER, or
any lookup error all fall back to today's space-wide Space Assistant run — the Space Assistant
and the builder remain free to handle a billing event generally, reassign the binding, or
delete the project outright.

**Tests:** `tests/unit/spacedo-project-default-agent.test.ts` (6) — persistence through
create/GET/list, PATCH reassign, PATCH-to-null clears the binding, omitting the field from a
PATCH leaves it untouched. `tests/unit/bootstrap-complete-agent-projects.test.ts` (3) — bound
projects get a starter thread, unbound projects don't, and legacy string-only onboarding records
still work. `tests/unit/billing-fulfillment-project.test.ts` extended (+3) — binding match wins
over an unrelated-but-similarly-named project, binding beats a same-named-but-unbound project,
archived-and-bound is still excluded.

708 unit/contract/integration/isolation/simulation tests pass; `naelao-spaces`,
`@naelao/agents-worker`, `@naelao/billing-worker`, and `@naelao/provisioner-worker` typecheck
clean.

## A1.16.20 Project configurability round 2: max_threads, allowed_agent_ids, and a generalized
## project-template catalogue (workspace-kind templates, not just customer_bot) — BUILT

Follow-on to A1.16.19. Design discussion settled two axes explicitly so they don't get
conflated: **`kind`** stays a small, closed enum with real platform-enforced behavior
(`workspace`, `customer_bot` — unchanged, no new kind added this pass); **project templates**
are where scenario-specific specialization ("community user monitoring," "order fulfillment,"
etc.) belongs — a named, reusable bundle of the same knobs a builder could set by hand, not new
platform code per business vertical.

**`projects.max_threads` + `projects.allowed_agent_ids`** (SpaceDO migration v19, both nullable/
zero-means-unlimited):
- `max_threads` caps how many "real" conversations (primary threads + channel sessions) a
  project hosts at once — deliberately NOT sub-agent fan-out threads (already bounded by
  `MAX_SUB_AGENTS_PER_SPAWN`/`ConcurrencyDO`; counting ephemeral orchestration threads toward a
  builder-facing limit would be surprising). Enforced in `SpaceDO.createThread` at the two
  genuinely-new-row insert sites (not the idempotent update-existing paths): a project at its
  cap rejects a new primary/channel thread with `409 thread_limit_reached`. Archiving a thread
  frees a slot (the count query filters `status = 'active'`).
- `allowed_agent_ids` is the thread-level "switch agent" allowlist — the specific mechanism
  behind "if the user clicks switch agents in a thread, the list will be just those in the
  project." `null`/`[]` = unrestricted (today's behavior, every space agent available). When
  set, `default_agent_id` (existing or in the same PATCH) must be a member —
  `SpaceDO.validateAgentBinding` enforces this at both `createProject` and `updateProject`
  against the *effective* post-patch state (a caller sending only one of the two fields is
  checked against whatever's already stored for the other).

**Generalized `ProjectTemplate`** (`launchpad/project-templates.ts`) — no longer customer_bot-
only. `kind` is now explicit per template (`workspace` | `customer_bot`); `suggested_channel`
and `rules` are customer_bot-specific (validated as required/optional respectively by the new
`validateProjectTemplates()`, same fail-fast-at-import pattern as
`validateLaunchpadSpaceType`); new `max_threads`, `default_agent_id`, `allowed_agent_ids`, and
`scheduled_jobs` (cron-scheduled ops, seeded via the existing project-scoped `scheduled_jobs`
table — no new primitive needed) apply to any kind. `community-member-monitoring` is the
concrete "community business template ships a preconfigured user-monitoring project" example:
`kind: 'workspace'`, `default_agent_id`/`allowed_agent_ids` bound to the support agent, a
weekly-digest `scheduled_jobs` entry — no `suggested_channel`, no reactive `rules` (it's
schedule/observation-driven, not reactive-trigger-driven, which is exactly why it's `workspace`
and not a new kind).

**`POST /spaces/:spaceId/projects/from-template`** (agents worker) generalized to apply any
catalogue entry: creates the project with its agent binding/allowlist set from the start,
PATCHes in kind/ceiling/cap/thread-cap (+ `channel_config` only for customer_bot templates with
a `suggested_channel`), seeds `rules` (customer_bot) and `scheduled_jobs` (any kind, scoped via
`project_id`) — same one-call "no required follow-up edits" guarantee the original customer-bot-
only version had, now scenario-agnostic.

Explicitly deferred (per the design discussion): a persisted per-project skill/script
attachment that the script engine re-merges into every run scoped to that project — seeding
scripts/skills at template-application time is a bigger change to the run-time config-assembly
path (`buildScriptEngineEnv`/`loadAgentConfig`), tracked as a follow-up, not built here. Also not
built: the actual dashboard "switch agent in a thread" UI that would read `allowed_agent_ids` —
this pass is the backend primitive it needs, not the frontend surface itself.

**Tests:** `tests/unit/spacedo-project-configurability.test.ts` (renamed from
`spacedo-project-default-agent.test.ts`, +13) — `allowed_agent_ids` persistence through create/
GET/list, creation/PATCH rejected when `default_agent_id` falls outside a non-empty
`allowed_agent_ids`, PATCH-to-`[]` clears it back to unrestricted; `max_threads` validation,
enforcement at the cap (409 on the 3rd thread with `max_threads: 2`), archiving frees a slot,
sub-agent threads never count toward the cap, threads with no `project_id` are never capped.
`tests/unit/project-templates.test.ts` extended (+11) — workspace-kind template invariants, the
`community-member-monitoring` example's binding + scheduled job, and `validateProjectTemplates`
rejecting each new invariant violation (duplicate id, missing `suggested_channel` on a
`customer_bot` template, non-positive spend cap, `default_agent_id` outside
`allowed_agent_ids`, a `reply` rule missing `reply_text`). `tests/unit/projects-from-template.test.ts`
(new, 3) — a customer_bot template still seeds channel_config/rules with no scheduled jobs; a
workspace template sets the agent binding at creation, skips `channel_config`, and seeds exactly
one project-scoped scheduled job; an unknown template id 404s.

735 unit/contract/integration/isolation/simulation tests pass; `naelao-spaces`,
`@naelao/agents-worker`, `@naelao/billing-worker`, and `@naelao/provisioner-worker` typecheck
clean.

### A1.16.21 F15: router-dispatch regression — the `/spaces` catch-all was registered before
every specific `/spaces/:spaceId/...` route, so KB/credentials/sessions/bootstrap/
projects-from-template/channels requests were all silently misrouted to `SPACES_WORKER` — FIXED.

`workers/router/src/index.ts`'s protected `api` sub-app is a flat list of `api.all(pattern, ...)`
registrations proxied straight through to a downstream worker; none of the proxy handlers call
`next()`. Hono's router dispatches to the **first** pattern that matches a request, in
registration order. `api.all("/spaces/*")` and `api.all("/spaces")` were registered immediately
after the shared middleware stack — before `/spaces/:spaceId/kb/*` (knowledge worker),
`/spaces/:spaceId/credentials[/:credId]` (credentials worker), `/spaces/:spaceId/sessions[/*]`,
`/spaces/:spaceId/bootstrap/*`, `/spaces/:spaceId/projects/from-template`, and
`/spaces/:spaceId/channels/*` (all agents worker). `/spaces/*` matches every one of those paths
too, so it won every time and the more specific routes below it were dead code — every KB
search, credential read, chat session, bootstrap call, template application, and channel
connect/inbound-admin request was actually being sent to `SPACES_WORKER`, which has no matching
route for most of them and would 404 or (worse, for any path coincidentally shaped like a spaces
route) silently do the wrong thing.

Fix: moved both catch-all registrations (`api.all("/spaces/*")`, `api.all("/spaces")`) to
immediately after the last specific `/spaces/:spaceId/...` route (right before the `/reseller/*`
block), with no change to any handler body — this is purely a registration-order fix. A comment
at the new call site states the ordering invariant so a future addition of another
`/spaces/:spaceId/...` route doesn't get added below the catch-all by mistake.

**Tests:** `tests/unit/router-dispatch.test.ts` (new, 6) — imports the router's real default
export, mints a valid JWT via `@naelao/auth`'s `signJwt`, and asserts one representative request
per downstream target: KB → knowledge worker, credentials → credentials worker, sessions →
agents worker, channels/connect → agents worker, and both the exact `/spaces` and prefix
`/spaces/:spaceId` catch-all shapes → spaces worker (proving the reorder didn't break the
catch-all itself, only its priority relative to the specific routes).

741 unit/contract/integration/isolation/simulation tests pass; `naelao-router` typechecks clean.

### A1.16.22 Spec §11 `requires_approval_for` was never enforced for Launchpad project agents
— FIXED.

`launchpadAgentToProfile` (profiles.ts) wrote an Autopilot agent's approval gates (e.g.
`launchpad-fulfillment-v1`'s `["customer_email_send", "refund_issue"]`) as PROSE under a
`# Approval Gates (HITL)` heading in `agents.md` — for the model to read. But
`loop.ts`'s `parseRequiresApprovalFor` only ever matched a structurally different
`## requires_approval_for` markdown heading followed by `- ` bullets — a shape no
agent-authoring path in the codebase actually produced. So `parseRequiresApprovalFor(agentsMd)`
always returned an empty set, and `NaelaoAgentDO.handleScriptRun` ran every project-bound
Launchpad agent (fulfillment, support, etc.) under `gate_listed` mode with an empty gated-set —
i.e. nothing was ever gated, silently. An Autopilot-tier fulfillment agent could issue a refund
or send a customer email with no HITL pause at all, defeating the one guardrail spec §11
requires for that tier.

Fix: carry the gate list structurally instead of through prose. `AgentConfig` (agent-config.ts)
gained an optional `requiresApprovalFor?: string[]` field — persisted inside the existing
`scripts.json` R2 file (a `requires_approval_for` JSON key lifted/lowered by
`loadAgentConfig`/`writeAgentConfig`), not a fifth file — an agent is still defined by exactly
the four files. `launchpadAgentToProfile` now sets `config.requiresApprovalFor =
[...def.requires_approval_for]` alongside (not instead of) the human-readable prose section,
which stays for the model. `NaelaoAgentDO.handleScriptRun` and `handleChannelHeartbeat` now
read `config.requiresApprovalFor` first, falling back to
`parseRequiresApprovalFor(config.agentsMd)` only when the structural field is absent (agents
provisioned before this fix). `loop.ts`'s `isGated` is now exported so the gate/allowlist
semantics (`gate_listed` = allowlist of what's gated; `gate_unless_listed` = allowlist of what's
pre-approved) are directly testable without re-deriving them.

**Tests:** `tests/unit/approval-gates-structural.test.ts` (new, 5) — `launchpadAgentToProfile`
carries `requires_approval_for` onto `AgentConfig.requiresApprovalFor` structurally; the prose
section in `agents.md` is confirmed NOT structurally parseable (proving the original bug); the
field round-trips through `writeAgentConfig`/`loadAgentConfig` over R2 without loss; a
provisioned `launchpad-fulfillment-v1` profile gates `customer_email_send` and `refund_issue`
(`isGated(..., "gate_listed") === true`) while leaving an unlisted action (`web_search`)
ungated; and a legacy config with no persisted field falls back to parsing a
`## requires_approval_for` heading in `agents.md` rather than crashing or silently un-gating.

746 unit/contract/integration/isolation/simulation tests pass; `naelao-agents-worker` and
`naelao-provisioner-worker` typecheck clean.

### A1.16.23 F17: a SpaceDO project-config fetch error silently disabled BOTH customer-bot
structural controls (execution ceiling AND daily spend cap) — FIXED.

`NaelaoAgentDO.fetchProjectConfig` returned `null` on ANY failure — a clean 404 ("this project
has no config row, permissive is correct") and a genuine 5xx/network error ("SpaceDO could not
be reached, we have no idea what this project's restrictions are") were indistinguishable. Both
`handleScriptRun` and `handleChannelHeartbeat` treated a `null` config as "unrestricted": the
daily-spend-cap check was skipped entirely, and `engineEnv.maxTier` was left untouched (or
explicitly deleted), which for a customer-bot project means running at the platform's default,
most-PERMISSIVE tier. A1.13 states these two controls (execution ceiling, daily spend cap) must
be un-bypassable — a transient SpaceDO blip was silently bypassing both at once, for every
in-flight and subsequent request against that project until the outage cleared.

Fix: `fetchProjectConfig` now returns a `{ status: "found" | "not_found" | "error" }` union
instead of `T | null`. `not_found` (a clean 404) stays exactly as permissive as before — a
project genuinely configured with no restrictions is not the failure mode this fix targets.
`error` (5xx or a thrown network error) fails CLOSED: `engineEnv.maxTier` is clamped to `1` (the
most restrictive execution tier) and the request/message is treated exactly like a real
spend-cap hit (`error_code: "spend_capped"` / `spend_capped` counter), never run unrestricted.
Applied at all three points that previously read a possibly-null config and set/left
`engineEnv.maxTier`: `handleScriptRun`'s pre-run gate, `handleChannelHeartbeat`'s per-message
no-code-rule `run_script` branch (a rule-triggered script execution — a separate code path from
the full reasoning loop, and one the fix must cover independently since a matched rule
short-circuits before reaching the reasoning-loop gate), and `handleChannelHeartbeat`'s final
full-reasoning-loop gate (replacing the bare `else delete engineEnv.maxTier`).

**Tests:** `tests/unit/project-config-fail-closed.test.ts` (new, 6) — `handleScriptRun`: a
thrown network error and a `500` response from the project-config endpoint both reject the run
`429 spend_capped`; a clean `404` falls through past the gate exactly as before (never rejected
as `spend_capped`). `handleChannelHeartbeat`: a network error marks pending messages
`spend_capped` (not silently answered or dropped); a clean `404` leaves `spend_capped` at `0`;
and a matched no-code `run_script` rule under a project-config error is short-circuited to
`spend_capped` BEFORE the rule's script ever runs (`rule_handled: 0`), proving the fix covers
that execution path independently of the main reasoning-loop gate. Re-ran the pre-existing
`tests/unit/handlescriptrun-spend-cap.test.ts` (4) and
`tests/unit/naelaoagentdo-customer-bot-heartbeat.test.ts` (4) suites — both still pass unchanged,
confirming the clean-404/normal-config paths those suites cover were not affected.

752 unit/contract/integration/isolation/simulation tests pass; `naelao-agents-worker`
typechecks clean.

### A1.16.24 Launchpad's core agents (§11) were installed as R2 configs but never woken —
`LaunchpadAgentDefinition.trigger` was pure data nothing read; the fulfillment/support agents'
`requires_approval_for` gates fixed in A1.16.22 never actually applied to a real order — FIXED.

Every dispatcher in the platform hardcodes `"naelao-agent"`: `billing/lemon-squeezy.ts`'s
`resolveDefaultAgent`, every `handleAgentTick` case, `fireScriptDirectly`'s default. Nothing
ever read a Launchpad core agent's own `trigger` field (`launchpad-fulfillment-v1`'s
`{ type: "webhook", event: "order.completed" }`, `launchpad-support-v1`'s
`{ type: "webhook", event: "message.received" }`, `launchpad-content-v1`'s
`{ type: "schedule", cron: "0 9 * * *" }`) — so a "Creator Store" builder's Fulfillment and
Support agents never ran under their own persona, and the Content agent's daily cron never
fired at all. This made A1.16.22's approval-gates fix a dead letter in production: fulfillment's
`customer_email_send`/`refund_issue` gates only apply when `NaelaoAgentDO` loads
`launchpad-fulfillment-v1`'s own config — and nothing ever addressed that agent's DO for a real
order.

**Design decisions (both made and implemented here, not left as follow-ups):**

1. **Schedule-type triggers → a real `scheduled_jobs` row, with a new goal-based dispatch
   mode.** `scheduled_jobs` (0041/0042) only supported firing a named prebuilt script op
   DIRECTLY (`fireScriptDirectly`/`handleTriggerFire` — no reasoner, no OBSERVE/FIND/GATE loop,
   by deliberate design, identical posture to `event_triggers`). That's fine for "run this exact
   script on a timer," but "draft this week's marketing content" needs judgment, not a
   deterministic tool call — the dispatcher itself has no reasoning mode. Migration `0043`
   (`infra/migrations/0043_scheduled_jobs_agent_goal.sql`) adds two nullable columns:
   `agent_id` (which agent's own R2 config — system prompt, `requiresApprovalFor` — to wake;
   `NULL` keeps the implicit `"naelao-agent"` default) and `goal` (when set, the dispatcher wakes
   the FULL reasoning loop via `POST .../script/run` against that agent's own DO instead of
   firing `script_name` directly; `NULL` preserves the exact pre-existing direct-fire behavior
   for every job created before this fix). `script_name` stays `NOT NULL` (SQLite can't drop the
   constraint without a full table rebuild) — a goal-based row stores `''` there, an unambiguous
   sentinel the write path enforces at the API layer (`workers/spaces/src/index.ts`'s POST/PATCH
   `/scheduled-jobs` now require "`script_name` OR `goal`", not just `script_name`).
   `workers/agents/src/index.ts`'s `handleAgentTick` "scheduled_job" case branches on
   `row.goal`: set → the new `wakeAgentGoal` helper (mirrors `billing/lemon-squeezy.ts`'s
   `wakeAgent` — same `/script/run` shape, same `apiKey`/`sessionId`/`context` posture); unset →
   the pre-existing `fireScriptDirectly` path, byte-for-byte unchanged for every job that
   predates this migration.

2. **Webhook-type triggers deliberately NOT translated into `event_triggers` rows.**
   `event_triggers` (SpaceDO, `@naelao/events`) only fires on STRUCTURAL in-space events
   (`thread.created`, `project.created`, `project.possible_duplicate`, `scheduled_job.disabled`)
   — it has no `order.completed` or `message.received` event source, and nothing anywhere calls
   `fireMatchingTriggers` with either. A row for either would sit inert forever, which would be
   worse than the current bug (a builder who inspects the trigger list would believe it's wired
   when it silently never fires). Both of this SpaceType's webhook agents are instead wired
   through their own existing, more specific dispatch:

   - **`launchpad-fulfillment-v1`'s `order.completed` → resolved directly by the billing
     worker.** `billing/lemon-squeezy.ts`'s `handleLemonSqueezyWebhook` now routes a
     `payment.success` event (an actual order/product sale) to the fulfillment specialist's OWN
     agent DO instead of the Space Assistant — but ONLY when the new `isFulfillmentAgentBound`
     check confirms a project is actually bound to it via a real `default_agent_id` (not the
     looser name-only `"Orders"` fallback `resolveFulfillmentProjectId` already accepted for
     SCOPING an already-decided Space-Assistant run — routing to an agent that was never
     provisioned would just 404 and silently drop the order, worse than today's status quo). No
     binding (a space provisioned before `projects.default_agent_id` existed, a manually
     reassigned/removed project, or a raw core-agents install with no template) falls back to
     the Space Assistant exactly as before. Every OTHER billing event type (subscription
     changes, payment failures, refunds) keeps waking the Space Assistant unchanged —
     `order.completed` is the only event this SpaceType defines a specialist trigger for. Only
     one agent is ever woken per event, never both (`wakeAgent` is called exactly once, with a
     single resolved `targetAgentId`).
   - **`launchpad-support-v1`'s `message.received`** already reaches the space through
     `channel_links` → project binding (unchanged by this fix — genuinely out of scope here,
     since routing THAT path to the specialist's own DO/config would mean moving
     `channel_sessions`/`channel_messages` SQLite state to a different DO instance, a much
     larger migration than "wire the trigger," and `NaelaoAgentDO.ts`'s channel-heartbeat/inbound
     handling was deliberately left untouched).

3. **Fix B (same audit, same root cause family): the three Launchpad system prompts referenced
   tools that don't exist in the script-native surface** — `"the Stripe tool"`, `"the email
   tool"`, `"the CRM tool"` (`launchpad/spacetype.ts`, written verbatim into `system-prompt.md`
   by `launchpadAgentToProfile`). Payment is Lemon Squeezy via the reserved `commerce` prebuilt
   (Appendix H / CLAUDE.md #9), never a builder's own Stripe key. Rewrote all three
   (`launchpad-fulfillment-v1`, `launchpad-support-v1`, `launchpad-content-v1`) to reference
   `script.find`/`script.create` + distillation, the `commerce` prebuilt for money-in,
   `notifications` for customer/owner messages, `mcp-connector` for external platforms
   (Whop/CRM), and `knowledge-base`/`web-search`/`r2-workspace` where relevant — no hardcoded
   tool-name language. Also swapped the stale `"stripe-app"` literal for `"commerce"` in
   `allowed_skills` and `trigger.source` (both already mapped to the same prebuilt via
   `skillToPrebuilt`'s backward-compat case, so this is a wording fix with no behavior change).

**Provisioner wiring:** `workers/provisioner/src/index.ts`'s `installLaunchpadAgents` (step 9)
now calls a new `installAgentTrigger` per installed agent: `schedule` → POST
`/spaces/:id/scheduled-jobs` with `agent_id` + a `goal` derived from the agent's own
`description` (`"Run your scheduled work per your role: ...; use script.find ...; distill a new
one when you succeed"`); `webhook`/`manual` → no-op (see decision 2 above). Best-effort — a
failed install logs and does not fail provisioning, same posture as the other non-critical
install steps (`spacedo_init_hook`, `workflow_templates`). `rollbackSpace` now also deletes any
`scheduled_jobs` rows for the space (PLATFORM_DB, not under the R2-prefix wipe the block above
already does) so a retried `provisionSpace` after a failure doesn't accumulate duplicate cron
rows for the same agent.

**Tests:** `tests/unit/provisioner-agent-triggers.test.ts` (new, 5) — a `scheduled_jobs` row is
created for the Content agent's cron, addressed at `agent_id: "launchpad-content-v1"`, with a
`script.find`-referencing goal; no `scheduled_jobs` row is created for either webhook-type agent
(fulfillment/support); agent-definitions index entries are still registered alongside the
trigger wiring; a failed scheduled-jobs install is best-effort (does not throw, does not block
the rest of the install); installing with no `templateId` (all three core agents) still wires
exactly one scheduled job. `tests/unit/billing-fulfillment-project.test.ts` (+13: 4
`isFulfillmentAgentBound` unit tests, 4 new `handleLemonSqueezyWebhook` routing tests) — routes
to `launchpad-fulfillment-v1`'s own DO when actually bound; falls back to the Space Assistant
when only name-matched; never routes a non-order event (`subscription.updated`) to the
specialist even when bound; never wakes both agents for the same event.
`tests/unit/scheduled-jobs.test.ts` updated to load migration `0043` in its real-SQLite fixture
(the new columns are additive/nullable, so all 27 pre-existing assertions pass unchanged).
`tests/unit/launchpad-spacetype.test.ts` updated for the `"commerce"` wording fix (functionally
identical trigger source, was `"stripe-app"`).

765 unit/contract/integration/isolation/simulation tests pass; `naelao-agents-worker`,
`naelao-billing-worker`, `naelao-provisioner-worker`, and `naelao-spaces` typecheck clean (and
`npx turbo run typecheck` is clean platform-wide).

### A1.16.25 F20: the billing worker was never given `workers_dev = false`, and three money-in
routes were gated only by a forgeable static `x-naelao-internal` header — FIXED.

A1.16.8 (item 21) replaced every worker's forgeable `x-naelao-internal: <static string>` check
with `requireInternalHmac` and set `workers_dev = false` everywhere except workers with their
own independent public ingress auth — but `workers/billing/wrangler.toml` was missed entirely
(no `workers_dev = false` at all), and three of its own routes still used the exact pattern
A1.16.8 eliminated everywhere else:

- `POST /internal/commerce/checkout` — `x-naelao-internal !== "commerce-script"`
- `POST /internal/seats/checkout` — `x-naelao-internal` not in `{"commerce-script", "portal"}`
- `POST /internal/products/ls-variant` — `x-naelao-internal !== "publish"`

All three are money-in or catalogue-provisioning paths (the reserved `commerce` prebuilt's only
way to take payment, and the only way a builder's product/seat gets a real Lemon Squeezy
variant) — directly reachable with a static, guessable header if the worker were ever hit at its
own `workers.dev` URL, exactly the B1/A1.16.8 threat model.

**Fix:** `workers/billing/wrangler.toml` now sets `workers_dev = false`. All three routes are
gated with `app.use(path, requireInternalHmac((c) => c.env.PLATFORM_SECRET))`, mirroring
`workers/spaces/src/index.ts`'s `/internal/*` convention exactly (bare-path registration, not a
`/*` wildcard, matching the established pattern rather than the Hono-wildcard mismatch A1.16.9
found and fixed elsewhere). The `/internal/seats/checkout` fix also drops the
`{"commerce-script", "portal"}` caller-identity distinction entirely — `requireInternalHmac`
authenticates the token, not a claimed identity string, so a future portal "join" flow (the
`"portal"` branch was dead code; no caller anywhere in the repo ever sent that value) needs no
special-casing, just its own minted token. `/webhooks/lemon-squeezy` is untouched — its own
HMAC-signature scheme (Lemon Squeezy's signing secret) is a different, already-correct auth
mechanism, not the pattern being fixed here.

**Callers updated to mint a token instead of a static string** (ship callers and callees
together — an unwired caller would 403 against its own money-in path):
- `workers/agents/src/script-engine/prebuilt/commerce.ts`'s `billing()` helper (used by both
  `commerce.checkout` and `commerce.seat_checkout`) — already sent `x-naelao-tenant-id:
  ctx.env.tenantId` for logging purposes; now also sends `x-naelao-internal-token:
  mintInternalToken(ctx.env.platformSecret, ctx.env.tenantId)`, the same pattern its own
  `spaces()` helper already used for spaces-worker calls.
- `workers/spaces/src/index.ts`'s **two** callers of `/internal/products/ls-variant` — product
  publish (`PATCH /spaces/:spaceId/products/:id`, using `loadCommerceContext`'s `ctx.tenantId`)
  and member/seat-billing enablement (`PATCH /spaces/:spaceId/member-billing`, using
  `loadOwnedSpace`'s `owned.tenantId`) — both previously sent the static `"publish"` header; the
  member-billing call site existed but wasn't named in the original report (found by grepping
  every caller of the route before touching the callee, the same discipline A1.16.10 used).

**Tests:** `tests/unit/billing-internal-hmac.test.ts` (new, 9) — mirrors
`tests/unit/layer3-backstop-routes.test.ts`'s style against the real billing worker handler: all
three routes reject their own old static header (and, for `/internal/commerce/checkout`, a
request with no header at all) with `403`, and accept a properly minted token with a non-`403`
status (the handler body then runs and 404s/succeeds on its own minimal-fixture terms — the
point is the auth gate specifically passed); `/webhooks/lemon-squeezy` still correctly rejects
an invalid provider signature with `401`, proving that route's own scheme wasn't touched.
`tests/unit/commerce-prebuilt-hmac.test.ts` (new, 2) — the `commerce` prebuilt's
`commerce.checkout`/`commerce.seat_checkout` ops send a token that verifies against the
caller's own tenant (and fails against a different tenant), with no `x-naelao-internal` header
present at all. `tests/unit/member-seat-reseller-billing.test.ts` extended (existing "PATCH
enable provisions the seat LS variant" test) to capture and verify the minted token on the
member-billing→ls-variant call — the product-publish call site uses the identical code shape
and is covered by the platform-wide typecheck.

776 unit/contract/integration/isolation/simulation tests pass; `naelao-billing-worker`,
`naelao-agents-worker`, and `naelao-spaces` typecheck clean (and `npx turbo run typecheck` is
clean platform-wide).

## A1.17 The Three-Tier Platform Model (Naelao → Builder → End User) — IN PROGRESS

CLAUDE.md item 30 is the index entry; this section accumulates design detail as each phase
lands, per the approved plan at commit time (8 phases: API-key cleanup → NaelaoProduct schema +
`BuilderAccountDO` → `ProductUserDO` → Builder Dashboard API → launch/domain wizard → ongoing
management tabs → manifest-driven Product Shell → sub-space/reseller UI → deferred
`@naelao/product-sdk`).

**Why this exists.** Re-reading the spec's "Three-Tier Platform Model," "How Builders Use
Naelao," the Journey walkthroughs (1A/1B/2), Temples, and the Sub-Space Scenarios A/B/C sections
against the current codebase surfaced two load-bearing facts that reframe how much of this is
actually new work:
- The backend for sub-spaces is **already built and spec-correct**:
  `/spaces/:spaceId/sub-spaces` (`workers/spaces/src/index.ts` ~968-1021, `SpaceDO.ts` createSubSpace
  ~2195-2260) implements exactly the depth≤2 / `agency_shell`-gated-mixed-type / force-parent-type-
  for-end-users rules the spec's §49 describes — Scenarios A (organizational), B (agency/mixed
  type), and C (user-created workspace) all fall out of this one mechanism plus caller role.
  `/reseller/spaces` (~1634) is the separate, heavier "spin off a fully independent business"
  mechanism (new tenant, new SpaceDO). **Neither has any consuming UI** —
  `apps/dashboard/src/lib/api.ts`'s `listSubSpaces`/`createSubSpace` are unused dead code, and
  `apps/portal/src` has zero sub-space or reseller references.
- The SpaceType manifest **already carries the exact `ui` contract** the spec's Layer-3
  description specifies: `ui.operatorShell` (sidebarItems, dashboardWidgets, hiddenCoreItems,
  defaultView) and `ui.externalPortal` (enabled, deploymentType, templateId, customDomain,
  authModel), fully typed in `SpaceTypeRegistryDO.ts:61-77` and fully *populated* for Launchpad in
  `launchpad-manifest.ts:50-70` (Launchpad hides `threads`/`projects` for the operator and shows
  Revenue/Orders/Customers instead — "operators view dashboards, they don't chat," per spec).
  Nothing renders this data yet.

So most of the remaining work is genuinely new (a `NaelaoProduct` field set, `BuilderAccountDO`,
`ProductUserDO` — the first persistent signed-in end-user concept in the platform, since Launchpad
end users today are anonymous session IDs) plus UI against both new and already-existing,
already-tested backend surfaces.

**Design decisions locked in before implementation (do not re-litigate without updating this
section):**
- `NaelaoProduct` extends the existing `spaces` D1 table with new columns rather than a parallel
  `products` table — the spec's own gap appendix flags exactly this kind of split-brain (e.g.
  `space_credits` defined in two places) as the anti-pattern to avoid.
- `BuilderAccountDO` is a thin per-builder index (`products`, `api_keys` tables only) — it must
  NOT reimplement usage aggregation, invoicing, or rate limiting; those already exist
  (`@naelao/entitlements` + Analytics Engine, `reseller_ledger`/`GET /reseller/statement`,
  `workers/router/src/RateLimitDO.ts` respectively) and `BuilderAccountDO`'s methods should call
  into them.
- The builder-facing per-product feature-flags mechanism (spec: `PUT /builder/products/{id}/
  feature-flags`) must NOT reuse `workers/spaces/src/do/FeatureFlagDO.ts` — that DO is Naelao's
  own platform-wide gradual-rollout system (global flags, staff-controlled, targeting rules by
  account/plan/tenant), a different concern from a builder toggling a flag for their own
  product's end users. Needs its own simple mechanism (new `feature_flags_json` column + KV TTL
  cache), not a shared engine with a different actor model.
- Do not name anything `ProductDO` — `workers/agents/src/do/ProductDO.ts` already exists (legacy
  Whop-niche singleton being retired per items #4/#11); `BuilderAccountDO`/`ProductUserDO` avoid
  the collision but it's an easy mix-up in code review.
- End-user auth for `ProductUserDO` is a product-scoped session token (issued via the product's
  configured `auth_provider`), never the platform-wide builder JWT — Team-type collaborators
  (`space_members`) are a structurally different population from Product end users, same
  reasoning as item #23's Bucket A/B split.

**Phase 0 — DONE.** Two separate, fully dead API-key UIs (`dashboard/settings`'s embedded
section calling `/settings/api-keys`, `dashboard/api-keys` calling `/v1/api-keys` — neither route
backed by any worker) consolidated onto one typed `ApiKey` shape in `apps/dashboard/src/lib/api.ts`
(scopes + expiry + key_prefix, matching the spec's scoped `nbk_...` builder key model), pointed at
the future `/builder/api-keys` route (Phase 3 will implement it). `dashboard/api-keys` is now the
canonical UI; `dashboard/settings` links to it instead of duplicating it. `dashboard/team` and
`dashboard/usage` call equally-unbacked `/v1/team/*`/`/v1/usage/*` routes — flagged as a known,
separate, out-of-scope gap (CLAUDE.md item 30), not touched by this phase.

**Phase 1 — DONE.** Migration `0044_naelao_product.sql` adds only two genuinely new,
cross-space-queryable columns to `spaces` — `product_slug` (unique platform-subdomain identity,
partial unique index excluding NULL) and `conversation_access_approved_by`/`_at` (the spec's
legally-gated conversation-log-access approval, which Naelao staff need to query across every
space for the platform-wide approval queue). Everything else from the spec's ~20-field
NaelaoProduct list — branding, auth provider config, pricing, sub-space terminology/depth
display, admin features, per-product feature flags — extends `SpaceTypeProductConfig`
(`workers/spaces/src/do/SpaceTypeRegistryDO.ts`) instead: new optional `branding`/`authProvider`/
`pricingConfig`/`subSpaceDisplay`/`adminFeatures`/`featureFlags` fields, stored as a
`config_json.productConfig` override on the space row exactly like member billing (#17) and
assistant policy (#20) already work. A `product_domain`/`custom_domain_verified` pair was
deliberately NOT added — that would duplicate what `business_services` already tracks end-to-end
for storefront/custom-domain identity (#16); a per-product feature-flags mechanism deliberately
does NOT reuse `FeatureFlagDO` — that DO is Naelao's own platform-wide gradual-rollout system
(global flags, staff-controlled), a different actor/lifecycle from a builder toggling a flag for
their own product's end users.

New `workers/spaces/src/do/BuilderAccountDO.ts`, one per builder (`getDOName("builder", tenantId,
tenantId, PLATFORM_SECRET)` — same HMAC-named pattern as every other DO, preventing
enumeration), registered in `wrangler.toml` (`BUILDER_ACCOUNT_DO` binding, migration tag v6).
Deliberately thin: only `products` (an index of this builder's product spaceIds — source of
truth stays the `spaces` D1 row) and `api_keys` tables. Does NOT reimplement usage aggregation,
invoicing, or rate limiting — Phase 3's Builder Dashboard API will call `@naelao/entitlements` +
Analytics Engine, `reseller_ledger`/`GET /reseller/statement`, and
`workers/router/src/RateLimitDO.ts` directly for those. API keys mint a `nbk_...`-prefixed raw
key shown exactly once; only its SHA-256 hash and an 11-char display prefix persist. `POST
/api-keys/verify` is the endpoint Phase 3's `validateProductScope` middleware will call to
resolve a Bearer key to its scopes before any `/builder/*` route runs.

Consolidated the dashboard onto this from Phase 0: `apps/dashboard/src/lib/api.ts`'s
`listApiKeys`/`createApiKey`/`revokeApiKey` now point at `/builder/api-keys*` (still 404s until
Phase 3 wires the route — expected, sequencing is intentional).

**Incidental fix found while writing `BuilderAccountDO`'s tests:** the shared test helper
`tests/unit/helpers/sqlite-do-shim.ts` (used by `RateLimitDO`'s tests and now this DO's) had a
real bug — its `exec(query, ...params)` treated ANY call with zero bound params as
multi-statement DDL (routed through `db.exec()`, which discards result rows), even a legitimate
param-less `SELECT` (e.g. `SpaceTypeRegistryDO`'s `GET /types`, which hardcodes its `WHERE`
clause values with no `?` placeholders at all — a pattern real DO SqlStorage handles fine
regardless of param count). Fixed by checking for a `SELECT` prefix first, unconditionally, before
falling through to the param-count-based DDL branch. All 14 existing consumers of this shim
(`rate-limit-do.test.ts`, `concurrency-do.test.ts`, `spacedo-*.test.ts`, etc.) still pass
unchanged — the fix only changes behavior for the previously-broken param-less-SELECT case.

Tests: `tests/unit/builder-account-do.test.ts` (9 — product index, key mint/list/verify/revoke,
expiry, forged-key rejection) and `tests/unit/naelao-product-migration.test.ts` (6 — migration
applies cleanly, columns default to NULL, slug uniqueness enforced but NULL-excluded, audit
columns settable independently). 794/794 platform tests pass; `naelao-spaces` and the dashboard
typecheck clean.

**Phase 2 — DONE.** New `workers/spaces/src/do/ProductUserDO.ts` — the platform's FIRST
persistent, signed-in end-user concept. Until now a Launchpad end user was an anonymous session
id with no durable identity; a Product end user is a real record (credit balance, sessions,
preferences, notification queue, conversation index). One instance per (productId, endUserId),
HMAC-named `getDOName("produser", "${productId}:${endUserId}", tenantId, PLATFORM_SECRET)` so two
builders can't collide on the same `end_user_id` namespace and instances can't be enumerated.
Registered in `wrangler.toml` (`PRODUCT_USER_DO` binding, migration tag v7); `productUserDoStub`
helper added to `index.ts` alongside `builderAccountDoStub` (routes that use it land in Phase 3+).

**The auth design decision the plan flagged — resolved, not inferred.** End users authenticate
through the PRODUCT'S configured `auth_provider` (naelao-native / Clerk / custom-OIDC / SAML),
which yields a stable `end_user_id`; `ProductUserDO` then mints a **product-scoped session token**
(`nps_...`, opaque, stored only as a SHA-256 hash) validated against its own `session_state` — NOT
against the platform-wide builder JWT. Builder-side actors (owners/admins/Team collaborators) stay
on the existing JWT + `space_members` path — they are a structurally different population (same
reasoning as #23's Bucket A/B split). This is also the concrete fix for the currently-broken
end-user chat-auth gap #23 flagged (widget/portal attach no credential today — a product session
token is the credential they'll attach, wired in Phase 3/6). The DO is deliberately
auth-provider-agnostic: it never sees Clerk/OIDC/SAML secrets (those stay in the credentials
vault); the caller verifies the provider assertion and derives `end_user_id`, then asks the DO to
open a session. Sessions are sliding-window (30-day TTL, refreshed on each verify).

**Credit ledger is a LEDGER, not a second conversion source.** `credit_ledger`'s balance is the
SUM of its deltas; `deduct` fails CLOSED on an over-draw (402, balance unchanged), matching the
`fetchAssistantPolicy`/`project_spend` fail-closed precedent. Crucially, `deduct` accepts
ALREADY-CONVERTED credits — the agent runtime owns `tokensToCredits()` (billing-core's single
token→credit conversion point, #12), converts there, and passes credits here. The DO never
re-derives the rate, so there's no split-brain with billing-core. (This is also why the spaces
worker did NOT need to add a `@naelao/billing-core` dependency.) `/export` is the GDPR Art. 20
data-portability dump (mirrors the SpaceDO `/me/export` pattern) and explicitly excludes
`token_hash` — credential material is never exported.

Tests: `tests/unit/product-user-do.test.ts` (11 — session open/verify/revoke/revoke-all, ledger
grant/deduct/over-draw-fail-closed/validation, preferences round-trip, conversation-ref dedup,
notification queue, and a GDPR export that asserts no `token_hash` leaks). 805/805 platform tests
pass; `naelao-spaces` typechecks clean.

**Phase 3 — DONE.** The Builder Dashboard API: `workers/spaces/src/builder-routes.ts`
(`registerBuilderRoutes(app)`, called once from `index.ts` — the first split-out file that
registers routes rather than pure logic like `cf-saas.ts`; it declares its own minimal
`BuilderRoutesEnv` structural type instead of importing `index.ts`'s `Env` to avoid a circular
import, and the registration function takes `Hono<any>` because Hono's Context typing is
invariant on `Bindings`, not just structural — a narrower type can't be accepted where the
caller's wider one is expected without either the circular import or this widening).

**Auth: both paths resolve through one function, `resolveBuilderAuth`.** A router-authenticated
session (`x-naelao-tenant-id` header — the SAME mechanism every other builder-facing route in this
worker already uses, e.g. `/reseller/clients`) gets full access; this is how the Dashboard UI
itself calls these routes, and is why Phases 4/5 work today without any router change. A Bearer
`nbk_...` API key (the spec's programmatic surface) is routed to the right `BuilderAccountDO` via
`builder_api_key_index` (migration 0045 — pure routing data, key_hash→tenant_id; NOT a second
source of truth, since the actual valid/expired/revoked/scopes decision is always re-verified
against the authoritative DO — a stale index row after a revoke is harmless, it just costs one
wasted DO round-trip that correctly reports invalid). **Flagged, not built:** wiring
`naelao-router` to actually forward external `Authorization: Bearer nbk_...` calls through to this
worker (today the router only forwards already-JWT-authenticated sessions) is a separate,
tracked router-level follow-up — out of this phase's scope, and not a blocker since the Dashboard
itself uses the header path.

**Migration 0045** adds four tables, each with a specific non-duplication rationale: `builder_api_key_index`
(routing only, see above); `product_end_users` (the enumerable roster a Users tab lists from —
deliberately NOT the same table as SpaceDO's internal `space_members`, which is platform-user Team
collaborators, a structurally different population per #23's Bucket A/B split, and NOT the legacy
D1 `space_members` from migration 0021/the retired Whop-niche `BusinessDO`; `ProductUserDO`
instances hold the real per-user state but aren't bulk-enumerable, hence this roster index —
population starts in Phase 6 when end-user sessions are actually created); `conversation_access_audit`
(append-only, written only on a SUCCESSFUL disclosure — a denied attempt discloses nothing, so
there's nothing to audit, verified by 3 dedicated tests); `product_webhooks` (kept as its own small
table, not folded into `config_json`, because webhooks are operational plumbing added/removed
frequently — same reasoning as keeping `api_keys` off `config_json` in Phase 1).

**A design correction found while implementing, not just planned:** the original plan text said
feature-flag writes would need "KV TTL invalidation." Reading `loadEffectiveProductConfig`
closely showed this was based on a misreading — only the SpaceType *manifest* base config is
KV-cached (`space-type-manifest:{spaceTypeId}`, 1h TTL); a space's `config_json.productConfig`
*override* is read live from D1 on every call, never cached. So `PUT /builder/products/:id/feature-flags`
needed no cache invalidation at all — just the same read-merge-write into
`config_json.productConfig.featureFlags` that member billing (#17) already established. Also
corrected: `workers/spaces/src/do/FeatureFlagDO.ts` was NOT reused for this (as originally
worried about) — it's Naelao's own platform-wide gradual-rollout system (global flags,
staff-controlled, account/plan/tenant targeting), a different actor/lifecycle from a builder
toggling a flag for their own product's end users.

**Domain endpoint** (`POST/GET /builder/products/:id/domain`) is a genuine builder-facing wrapper
around the CF-for-SaaS logic that already existed only behind the internal HMAC-gated
`/internal/business-services` route (#16) — the create/poll logic itself (`createCustomHostname`/
`getCustomHostname` from `cf-saas.ts`, the `business_services` upsert) is inlined directly rather
than self-HTTP-calling the internal route (same worker, no HTTP hop needed), so there are now two
call sites sharing the same underlying `cf-saas.ts` functions and `business_services` table — not
two competing implementations.

**Analytics is honest, not fabricated.** `GET /builder/products/:id/analytics` computes DAU/MAU/
total_users from `product_end_users.last_seen_at` (real once Phase 6 populates it) but returns
`credits_consumed: null` — per-end-user `ProductUserDO` credit ledgers aren't bulk-aggregatable
from D1 without wiring an Analytics Engine event stream, which this phase doesn't add. That's a
flagged, real follow-up, not a fabricated number. `analytics/revenue` and `/builder/billing[/history]`
wrap the *already-existing, already-correct* `launchpad_orders` and `reseller_ledger` rollup
queries (the same ones `/spaces/:spaceId/revenue` and `/reseller/statement` use) — no new revenue
computation logic was invented.

**Conversation-access gate — the highest-liability endpoint, per its own dedicated test file**
(`tests/unit/conversation-access-gate.test.ts`, 11 tests, separate from the broader
`builder-dashboard-api.test.ts`, 19 tests). Three independent gates, checked in order and ALL
required: (1) `feature_flag` — builder's own `adminFeatures.conversationLogAccess` toggle; (2)
`staff_approval` — Naelao platform-staff manual approval, `conversation_access_approved_by/_at`
(migration 0044, legally required, never builder-settable — no route in this phase sets it,
matching the spec's Surface 1 approval-queue model; a Tier-0 staff approval console is a future
phase); (3) `user_consent` — the end user's own `product_end_users.consented_at`. Ownership
(tenant owns the product) is checked BEFORE any gate, so a non-owner always gets 404, never a
gate-specific 403 that would confirm the product exists (tested). A denied attempt writes ZERO
audit rows (tested for all three gate failures independently) — nothing was disclosed, nothing to
audit. A successful read returns ONLY `thread_id`/`space_id`/`session_id`/`title`/`created_at`
from `ProductUserDO.conversation_refs` (never message content — `ProductUserDO` itself never
stores message bodies, only refs) and writes exactly one audit row attributing the accessing
builder + an optional caller-supplied `purpose` string.

**Residual risk flagged for the security reviewer, not resolved here:** thread `title` is treated
as metadata, but this phase did not trace whether any thread-title-generation path elsewhere in
the platform (e.g. an LLM auto-summarizing a thread's first message into its title) could leak
message content into what's nominally "metadata only." Worth verifying before this endpoint is
treated as a hard content/metadata boundary in the legal/compliance sense the triple-gate implies.

Tests: 30 new across the two files (19 + 11); 835/835 platform tests pass; `naelao-spaces`
typechecks clean, full monorepo typecheck clean.

**Phase 4 — DONE.** The Product Creation Wizard: `apps/dashboard/src/app/dashboard/products/new/page.tsx`
+ 7 step components (`Identity`/`SpaceType`/`AuthConfig`/`Pricing`/`Branding`/`Domain`/`Review`)
sharing client-side-only state (`wizardTypes.ts`) — there is no server-side "draft" concept; the
wizard collects everything across its steps and calls `createBuilderProduct()` exactly once, at
"Review & Launch." A new `apps/dashboard/src/app/dashboard/products/page.tsx` list page and a
"Products" nav item round out the surface.

**Found and fixed two real backend gaps before the wizard could even work, not just planned
ones.** (1) Phase 3's `POST /builder/products` had reimplemented space creation from scratch — a
bare INSERT with no quota check, no config-schema validation, no provisioning-queue enqueue, no
`template_id` support. Extracted the REAL, working logic from `POST /spaces` into
`workers/spaces/src/create-space.ts`'s `createSpaceRecord()`; both routes now call the same
function — no more split-brain. (2) While doing that extraction, found `enforceSpaceQuota`
queried a table called `organizations`, which no migration anywhere creates (the real table is
`orgs`, `infra/migrations/0002_orgs.sql`) — meaning `POST /spaces` had likely hard-500'd on every
call in any real deployment, silently, because nothing in this repo's test suite exercised that
route before this phase. Fixed the table name; added `tests/unit/create-space-record.test.ts` (11
tests) with a dedicated regression test for this exact bug.

**Temple Gallery needed no new backend at all.** `GET /templates` (in `workers/agents/src/index.ts`,
serving the real `LAUNCHPAD_TEMPLATES` — creator-store, newsletter-business, micro-saas,
service-agency, coaching-community) and the dashboard's `getTemplates()` client function already
existed and worked. Rather than fabricating spec-style Temple entries for SpaceTypes that don't
exist yet (LexSpace/DevPilot/etc. all require SpaceTypes never seeded), `apps/dashboard/src/lib/temples.ts`
wraps these 5 real, already-tested templates as the wizard's Temple catalogue — honest scope, not
invented data. When more SpaceTypes ship with their own templates, they extend this the same way.

**Third instance of the "UI calls a route no worker implements" bug, found and worked around
(not fixed — flagged, matching the `/v1/team`/`/v1/usage` precedent from Phase 0).**
`dashboard/spacetypes/*`'s `listSpaceTypes()`/`createSpaceType()` call `GET/POST /spacetypes`,
which no worker implements — dead code. The wizard's Space-Type Selection step needed a REAL
listing source, so added `GET /builder/space-types` (thin wrapper around `SpaceTypeRegistryDO`'s
already-working `GET /types` — the actual, current, authoritative registry, today seeded with
only Launchpad). The legacy `/spacetypes` dead CRUD itself is untouched, explicitly out of scope.

**Branding step is URL inputs, not file upload — a deliberate scope line, not an oversight.** The
Builder Dashboard API (Phase 3) stores `logoUrl`/`faviconUrl` as plain strings; no R2 upload
endpoint for product branding assets exists, and building one (authenticated upload route +
bucket policy) is real, separate infrastructure this wizard step doesn't invent.

**UI verification: found and worked around a real pre-existing dashboard-wide bug, not
introduced by this phase.** No browser-automation package (playwright/puppeteer) exists anywhere
in this repo, so verification used raw Chrome DevTools Protocol (Node's built-in `WebSocket`,
`/opt/pw-browsers`'s prebuilt Chromium) driven by hand. That process surfaced a real bug in
`apps/dashboard/src/lib/auth-provider.tsx`: on a hard reload of ANY nested `/dashboard/*` route
(not just this one — reproduced identically on the pre-existing `/dashboard/clients`), a race
between `DashboardLayout`'s auth-guard effect and `AuthProvider`'s own localStorage-hydration
effect bounces the user through `/login` and back to the generic `/dashboard`, silently dropping
the originally-requested path. This is a real, separate, dashboard-wide bug — flagged here, not
fixed (out of scope for a wizard feature; a future pass should fix `AuthProvider`'s hydration
ordering). Once reached via realistic client-side `<Link>` navigation (the way an actual user
gets there — click "Products" in the sidebar, then "+ New Product"), the wizard itself works
correctly end-to-end: all 7 steps render, the step indicator advances, Identity-step validation
blocks progression on a missing name, the Temple/SpaceType step's fetch-failure path degrades to
a clean "Failed to fetch" message (correct, since no backend worker was running in this
verification session) rather than crashing, and no console errors originated from any of this
phase's own components (the only warning present — `LoginPage`'s render-time `router.push` — is
that same pre-existing bug, not new code).

Tests: `tests/unit/create-space-record.test.ts` (11), `tests/unit/product-wizard-api.test.ts` (6)
— 852/852 platform tests pass, full monorepo typecheck clean.

**Phase 5 — DONE.** The Product Detail management tabs:
`apps/dashboard/src/app/dashboard/products/[productId]/{layout,page,users,analytics,
configuration,feature-flags,billing,danger-zone}` — 7 tabs sharing one `ProductProvider` React
context (`productContext.tsx`, fetches the product once, exposes `refetch()`) so tabs don't each
independently re-fetch the same product. First shared UI component in this app:
`apps/dashboard/src/components/ConfirmByTypingDialog.tsx` (type-the-exact-name-to-confirm,
reserved for irreversible actions — stricter than `clients/page.tsx`'s existing inline
two-click-confirm pattern, used for product deletion).

**No new backend routes.** Every tab is a pure consumer of Phase 3's already-tested endpoints
(`GET .../analytics`, `.../analytics/revenue`, `.../users`, `POST .../users/:id/suspend`,
`DELETE .../users/:id`, `PUT .../feature-flags`, `GET /builder/billing[/history]`,
`PATCH /builder/products/:id`, `DELETE /builder/products/:id`) — so no new
`tests/unit/*.test.ts` file was added this phase (would only re-test what
`builder-dashboard-api.test.ts` already covers); verification was the manual UI pass below plus
the existing typecheck/backend suite staying green.

**Billing tab is honest about what's per-product vs. account-wide.** `reseller_ledger` (and
therefore `GET /builder/billing[/history]`) is tracked at the TENANT level, not per-product —
there is no per-product wholesale/margin breakdown to show. The tab shows this product's OWN
revenue (from `analytics/revenue`) prominently, and separately, clearly labeled, the builder's
overall account-wide wholesale statement — not fabricating a per-product number that doesn't
exist.

**Users tab shows product end users only, explicitly not Team collaborators.** `product_end_users`
(Phase 3) and SpaceDO's internal `space_members` (Team-type collaborators) are two different
populations (per #23's Bucket A/B split, reiterated in Phase 4's appendix entry) — no
builder-facing route exists to list `space_members` today, and adding one was out of scope for
"management tabs." The Users tab's copy says so explicitly rather than silently only showing
half the picture with no explanation.

**UI verification, mocked at the network layer.** Same CDP-driven approach as Phase 4, but this
time using CDP's `Fetch` domain to intercept and mock `/builder/*` responses (no real backend
running) — this let every tab be exercised with realistic data rather than only the "no backend"
degraded path Phase 4 settled for. Two non-obvious things had to be fixed to make browser-level
fetch mocking work at all, worth recording for any future session that reaches for this
technique: (1) `apiFetch` sets `Content-Type: application/json` on every call, which makes even a
plain GET a "non-simple" CORS request — the browser sends an `OPTIONS` preflight first, and
without an explicit preflight response (200/204 + `Access-Control-Allow-Methods/Headers`) every
mocked call fails with a generic, unhelpful "Failed to fetch"; (2) mocked responses need
`Access-Control-Allow-Origin` themselves, or the browser blocks them client-side even though the
network layer got a response. With both fixed: all 7 tabs render correctly with mocked data
(Overview stats, Users roster, Analytics DAU/MAU/revenue, Configuration form, Feature Flags
toggles, Billing's two-part breakdown, Danger Zone), the feature-flag toggle click correctly
fires `PUT .../feature-flags` and refetches, and the delete confirmation button is verified
disabled by default, disabled while the WRONG name is typed, and only enabled once the EXACT
product name is typed — all with zero console errors.

**Phase 6 — IN PROGRESS. Foundational backend fix landed first: end-user chat auth + routing,
the two real bugs blocking ANY of the rich Product Shell from being real.**

**Scope correction, from the user directly, not inferred:** the mockup driving this phase (a
full agentic workspace — sidebar with Projects/Threads, a chat/thread view, an Agents panel,
Businesses switcher) is NOT a simplified "customer support widget" view. It is the actual
**Product Shell** a builder ships to their own end users — the same rich workspace serves both
the builder managing their business AND that builder's end users using the product directly
(the user's own analogy: "the builder becomes Anthropic that owns Claude Code" — end users just
sign in and use it, exactly like Claude Code/Cursor). A storefront (a simple site Launchpad
agents build for selling) is a completely separate, much simpler surface — not this. This
directly corrects an assumption Phase 4/5 planning carried over from `launchpad-manifest.ts`'s
`ui.operatorShell.hiddenCoreItems: ["threads","projects"]`, which was written for a NARROWER
"revenue-dashboard-only" framing that turns out not to match what's wanted here — the manifest
field itself is still real and useful (some products SHOULD hide threads/projects), it just
shouldn't be assumed true for what end users see across the board.

**Investigated before writing any shell code — and found the rich UI could not have worked
regardless of how it was built, for two independent, real, pre-existing reasons:**

1. **Auth: the router required a platform JWT unconditionally, with zero path for a
   ProductUserDO-authenticated end user.** `workers/router/src/index.ts`'s `api.use("*",
   jwtAuth(...))` applies to literally every route, and `jwtAuth` only understands platform
   JWTs — a product end user (Phase 2, no tenant, no JWT, just an opaque `nps_...` session
   token) had no way through at all. This is the exact gap CLAUDE.md item 23 already flagged as
   deferred ("end-user chat through the router is currently non-functional end-to-end").
   Fixed with a **narrow, explicit allowlist**, not a blanket bypass: a new hybrid-auth check in
   the router recognizes `Authorization: Bearer nps_...` + `x-naelao-end-user-id` ONLY on
   `/spaces/:spaceId/sessions*` (extend the allowlist as more end-user surfaces ship — threads,
   once product-scoped thread access lands); every other route (kb ingestion, credentials,
   member-billing, etc.) stays JWT-only, unchanged. Verification itself can't happen locally in
   the router (it doesn't know which tenant owns the product until AFTER verifying — a genuine
   chicken-and-egg), so a new `POST /internal/product-sessions/verify` on the spaces worker
   resolves the space's owning tenant from D1, then asks the correct `ProductUserDO` instance to
   verify the raw token. Gated by a direct `x-naelao-platform-secret` header check (same
   precedent as the pre-existing `/internal/space-types/seed` route) rather than
   `requireInternalHmac`, which needs a pre-known tenantId — exactly the thing not yet known.
   On success the router mints `NaelaoJwtClaims`-shaped claims with `role: "product_end_user"`
   (a new `UserRole` value, additive — `packages/auth/src/rbac.ts`'s `ROLE_PERMISSIONS` table
   fails CLOSED for it: an empty permission array, since none of the builder-dashboard RBAC
   permissions apply to this structurally different population) and `tid` set to the PRODUCT'S
   OWNING tenant — not empty, not the end user's own identity — so every downstream
   internal-HMAC check and quota gate keeps working unchanged for the rest of the request's
   lifetime, with zero special-casing needed anywhere past the router.

2. **Routing: even with valid auth, session/message CRUD would have 404'd — the router sent it
   to the wrong worker.** `api.all("/spaces/:spaceId/sessions/*", ...)` proxied unconditionally
   to `AGENTS_WORKER`, but `workers/agents/src/index.ts` only ever implemented the `agent/run`,
   `agent/runs/*`, and `approvals/*` sub-paths there — session CREATE and message GET/POST are
   actually implemented in `workers/spaces/src/index.ts` (forwarded to `SpaceDO` — see its
   "SpaceDO session proxy" comment, itself written by a PRIOR pass this session that fixed the
   auth-adjacent problem but never checked whether the router even reaches the right callee).
   `apps/portal`'s existing `startSession()`/`getMessages()`/`sendMessage()` (already-built SSE
   chat client, reused rather than rewritten) would have 404'd on session create and message
   post specifically, even once authenticated. Fixed by splitting the route: the agent-run and
   approvals sub-paths (registered FIRST, so they win — same F15 precedent) still go to
   `AGENTS_WORKER`; bare session/message CRUD now goes to `SPACES_WORKER`, which already mints
   the correct `x-naelao-internal-token` via the existing `proxyTo()` (using `claims.tid` — the
   SAME claims the new hybrid-auth check produces for a product end user) — no new gating
   mechanism needed on the receiving end, it was already built for exactly this. An existing
   test (`tests/unit/router-dispatch.test.ts`, from the F15 pass) had asserted plain `POST
   /sessions → AGENTS_WORKER`, which was true against that test's own always-answers stub but
   never verified the REAL agents worker implements that path — updated it to the corrected
   split, and added coverage the original F15 pass's stub-based approach couldn't have caught in
   the first place (a stub that only echoes `{worker: name}` will never surface "this worker has
   no handler for this path at all").

Tests: `tests/unit/product-sessions-verify.test.ts` (5 — wrong platform secret, nonexistent
product, forged token, real token round-trip, cross-end-user isolation) and
`tests/unit/router-product-end-user-auth.test.ts` (5 — valid session resolves + forwards
`product_end_user` claims with the correct tenant, invalid session rejected, non-allowlisted
path rejected even with a valid token, missing end-user-id header rejected, ordinary platform
JWT still works unchanged). `router-dispatch.test.ts` extended with 4 more cases locking in the
corrected session/agent-run/approvals split. 866/866 platform tests pass, full monorepo
typecheck clean.

**Scope correction, mid-phase, from the user directly:** a "Product" is not a storefront or any
commerce concept — the spec is explicit: *"NaelaoProduct is the core data model representing a
Tier 1 builder's deployed product. It wraps a configured Space."* (Section 48). The spec's own
examples are LexSpace/CodePilot/FirmAI — a legal tool, a coding tool, a law-firm tool — matching
the user's own analogy exactly. Journey 1B ("End User Joins a Builder's Product") describes
precisely the rich shell this phase builds: *"the product UI — threads, sub-spaces, knowledge
base — exactly as the builder configured it."* Nothing commerce-related appears in that journey
at all. Journey 2 ("Space Admin Sets Up a Launchpad Business") is a separate, lower-level thing —
installing a Stripe app, uploading digital goods, fulfillment webhooks — that happens to run
*inside* one Launchpad Product as one of its optional features, not something that defines what a
Product is. An earlier explanation in this session's chat (not committed anywhere) had
conflated a Launchpad business's own storefront/commerce feature with "the real product,"
describing them as competing concepts — corrected: every Product gets the same Journey-1B shell;
Launchpad Products can additionally run a storefront as one feature among several.

**End-user identity verification, closing the gap `ProductUserDO` (Phase 2) deliberately left
open** (it mints and verifies SESSIONS but never verified an IDENTITY in the first place):
`workers/spaces/src/product-end-user-routes.ts` adds real, public (unauthenticated —
a visitor has no token before this) `POST /spaces/:spaceId/end-users/{signup,login}` for products
configured with `authProvider.provider === 'naelao-native'` — email + password, hashed via the
same PBKDF2 helper platform users already use (`@naelao/crypto`'s `hashPassword`/`verifyPassword`,
G-B02). Extends the existing `product_end_users` roster (migration 0045) with a `password_hash`
column (migration 0046) rather than forking a parallel credentials table — a credential is just
another fact about the same roster row. Login fails with the identical `invalid_credentials`
response whether the email doesn't exist or the password is wrong (never reveals which). Other
`authProvider` values (clerk/custom-oidc/saml-sso) verify identity externally and are rejected
with 400 here, rather than pretending to support a flow not yet built. Registered on the router's
UNAUTHENTICATED path (`/v1/spaces/:spaceId/end-users/*`, mirroring the existing `/v1/auth/*`
pattern) — a signup/login call has no session token to present yet.

**A second gap found wiring the frontend to the new router auth: the browser's native
`EventSource` API cannot set custom headers**, so the SSE stream endpoint
(`.../agent/runs/:runId/stream`) had no way to carry the Bearer token the hybrid-auth check
requires. Fixed with the standard accepted workaround: the router now also accepts
`?session_token=nps_...&end_user_id=...` as query params, but ONLY on GET requests (the stream
endpoint is the only real caller) — header form still wins when both are present, and a
non-GET request with only query-param credentials is rejected, so this doesn't quietly widen the
allowlist to accept token-bearing GETs anywhere unintended.

Tests: `tests/unit/product-end-user-auth.test.ts` (11 — signup, duplicate-email rejection, same
email independent across two products, short-password rejection, `allowedEmailDomains`
enforcement, non-native-provider rejection, 404 for a nonexistent product, login success,
constant-shape invalid-credentials response, suspended-account rejection, and a minted session
round-tripping through the internal verify endpoint), plus 2 more in
`router-product-end-user-auth.test.ts` for the SSE query-param fallback and its GET-only
restriction. 880/880 platform tests pass, full monorepo typecheck clean.

**Remaining for Phase 6:** the actual Product Shell UI (sidebar chrome, Projects/Threads lists,
the chat view reusing the now-reachable existing SSE mechanism) driven by the SpaceType
manifest's `ui.externalPortal`/`ui.operatorShell` — this is the only piece left before an end
user can sign up, log in, and actually use a Product the way Journey 1B describes.

*(Note: `shell/manifest`, `product-users/me`, and the end-user-scoped `sessions` list route
described above as "remaining" were subsequently built — see CLAUDE.md's CURRENT DIRECTION item
30 for the fuller narrative of that work and the Hono routing-table bug it surfaced. This
appendix file lagged that narrative; picking back up below with the full-vision Three-Tier build
plan's Phase A.)*

## A1.17 continued — Phase A: design system + shell skeleton — BUILT

First concrete step of the full-vision plan (Naelao → Builder → End User, end user gets the
launchpad-6-mockup agentic workspace; see CLAUDE.md item 30 for the complete phased plan A-E).
Phase A had two deliverables: a shared design system, and a running end-user shell app that can
resolve a product, sign an end user up or in, and render the manifest-driven chrome — no chat yet
(that's Phase B).

**`packages/ui`** — new workspace package, plain `tsc` build (matches every other package's
convention, no bundler). `tokens.css` ports the mockup's `:root`/`[data-theme=dark]` custom
properties verbatim (warm paper palette, `--accent #5b52f0`, DM Sans/Instrument Serif). `styles.css`
ports the mockup's ~600 lines of component classes verbatim (sidebar, nav, space-switcher,
chat/thread-panel, home view, input box, page views, cards, badges, buttons, workflows, kb items,
settings, assistant layout, modal, toast, and the full responsive/mobile layer) — kept as global
CSS classes (not CSS-in-JS or Tailwind) specifically so the exact same stylesheet can be consumed
by both the new shell AND the reskinned dashboard (Phase D) without forking styles twice. A handful
of the mockup's singleton `#id` selectors were converted to classes (`.topbar`, `.chat-area`,
`.thread-panel`, `.home-view`, `.modal-overlay`, `.toast`, etc.) since these are now reusable React
components, not one-off page elements — `#sidebar`/`#app`/`#main` stayed as ids since the
responsive media queries key off `#sidebar.icon-only` specifically. React primitives:
`Sidebar`/`NavItem`/`HistoryItem`/`SpaceSwitcher` (all data-driven — no hardcoded nav items, since
different SpaceTypes and `hidden_core_items` need different sidebars), `Card`/`Badge`/`Button`/
`Modal`/`Toast`/`Avatar`/`FormInput`/`FormSelect`/`Toggle`/`TopBar`/`PageView`, an icon registry
(`icons.tsx`, inline SVGs matching the mockup's exact paths for pixel parity), and a `useTheme`
hook (localStorage-persisted, falls back to `prefers-color-scheme`).

**`apps/shell`** — new Next.js 14 app (same tooling as `apps/dashboard`: `next-on-pages`, plain
`tsc --noEmit` typecheck, no Tailwind — consumes `@naelao/ui`'s CSS directly via
`transpilePackages`). Product resolution is path-based: `/p/[slug]`. `lib/api.ts` and
`lib/productAccount.ts` port `apps/portal`'s proven hybrid-auth pattern verbatim (Bearer `nps_...`
+ `x-naelao-end-user-id`, per-`spaceId` localStorage session keys) — a person can be signed into
several different builder products in the same browser. `lib/auth-provider.tsx`
(`ProductAuthProvider`/`useProductAuth`) is built with an **`isHydrated` tri-state from day one**:
no consumer may redirect on `isAuthenticated` until `isHydrated` is true. This directly targets a
bug already known to exist in the dashboard's own `AuthProvider` (`apps/dashboard/src/lib/auth-provider.tsx`,
still unfixed — that's Phase D's job) — it initializes `token`/`claims` to `null` and only reads
`localStorage` in a post-mount `useEffect`, so the first render of any protected route sees
`isAuthenticated=false` and can redirect to `/login` before the real session is ever read.
`/p/[slug]/layout.tsx` is a server component that resolves the product once (see backend below)
and calls Next's `notFound()` for an unknown/inactive slug; `/p/[slug]/login` and `/p/[slug]/signup`
call the existing `POST /v1/spaces/:spaceId/end-users/{login,signup}` routes (already
unauthenticated on the router, built in an earlier pass); `/p/[slug]/(shell)/layout.tsx` renders
`@naelao/ui`'s `Sidebar` + top bar driven by `GET shell/manifest` (branding, `hidden_core_items`)
and `GET product-users/me` (name, credit balance) — the nav item SET itself is a fixed default
list matching the mockup (Home/Spaces/Assistant/Projects, More→Agents/Knowledge/Workflows/Settings
— Marketplace/Analytics/Explore deliberately deferred per the decided Shell v1 scope), filtered by
`hidden_core_items`, deliberately NOT driven by the manifest's `ui.sidebar_items` — that field is
the BUILDER dashboard's own operator-shell config (Revenue/Orders/Customers/Products/Campaigns/
Agents for Launchpad), a structurally different surface from the end-user Product Shell nav
(same distinction CLAUDE.md item 30's Phase 6 scope-correction already drew out for
`hiddenCoreItems`). The space-switcher is wired to real `shell/manifest` data but only shows the
current business for now — real multi-business switching is Phase C.

**Backend — one new route, `GET /products/by-slug/:slug`:** the shell needs to resolve a product
from its subdomain-style slug before an end user has any credential at all (the login page needs
branding/`auth_provider` to render). Added to `workers/spaces/src/index.ts`, querying
`spaces WHERE product_slug = ? AND status = 'active'` and returning the same class of fully
public-safe projection `shell/manifest` already established (`space_id`, `product_name`,
`brand_color`, `logo_url`, `auth_provider` only — nothing from `productConfig` that would leak
builder-internal config). Router: `GET /v1/products/by-slug/:slug` added to the UNAUTHENTICATED
path list, stripping client-supplied identity headers first — identical precaution to
`shell/manifest`'s own unauthenticated route just above it. No schema changes (`product_slug`
already existed, migration 0044).

**A pre-existing environment gap found while verifying this phase (not a regression from this
change):** `hono` and other worker-only dependencies were missing from `node_modules` entirely in
this session's checkout, and none of the workspace packages (`@naelao/http`, etc.) had been built
to `dist/` — the test suite couldn't even resolve imports until a full `pnpm install` +
`pnpm turbo run build --filter="./packages/*"` ran. Worth remembering for any future session that
inherits a fresh checkout: a filtered `pnpm install --filter X...` only pulls in `X`'s own
dependency subgraph, not the whole workspace's.

Tests: 4 new cases in `tests/unit/product-shell-manifest.test.ts` (`by-slug` resolves an active
product's safe projection with zero credentials, 404 for an unknown slug, 404 for a
non-`active`/suspended product, never leaks internal manifest/productConfig fields). Verified
`apps/shell` end-to-end via `next build` + `next dev` + curl (no backend running, so
`/p/<slug>` correctly 404s through the `notFound()` path; `/` renders with fonts/tokens applied).
897/897 platform tests pass, full monorepo typecheck clean.

**Remaining for the Three-Tier build:** Phase B (chat + Projects + Threads — the router allowlist
expansion and `requireBusinessMembership` gate, `product-sessions/verify`'s parent-walk for child
business spaces), then Phase C (businesses/invites/multi-template), Phase D (builder UI reskin —
including the `isHydrated` fix flagged above), Phase E (monetization). Full detail in the phased
plan referenced from CLAUDE.md item 30.

## A1.17 continued — Phase B: chat + Projects + Threads — BUILT

**Backend — `requireBusinessMembership` (new `workers/spaces/src/business-auth.ts`).** The
routes the shell's Projects/Threads views need (`/spaces/:id/projects*`, `/spaces/:id/threads*`,
`/spaces/:id/agent-definitions*`, `/spaces/:id/presence`) were previously builder-only, gated
ONLY by `requireInternalHmac` — which passes for a `product_end_user` caller exactly the same as
a builder, since `proxyTo` mints the internal token off any verified claims, role included. What
was missing was a FLOOR on what a `product_end_user` may do once past that gate (nothing checked
`role` at all). `requireBusinessMembership(methodMinRole)` is **additive-only**: a
non-`product_end_user` caller always passes unchanged (every builder role keeps whatever access
it already had); for `product_end_user` it enforces a per-method minimum role, defaulting to
`"admin"` (fail closed) for any method not explicitly listed. Phase B treats every verified
`product_end_user` as `"member"` — there is no real per-business role yet, since businesses
themselves don't exist until Phase C's `business_memberships` index; `productEndUserBusinessRole()`
is a single-function seam Phase C replaces with a real lookup. Applied narrowly: projects/threads
allow GET+POST (list/create/read) but NOT their admin-only sub-paths (rules, spend, per-project
PATCH config) — those never even reach the router's allowlist, so `requireBusinessMembership`
gating them is belt-and-suspenders, not the only thing stopping them. `agent-definitions` allows
GET only (the picker) — POST/PATCH/DELETE stay off-limits for a `product_end_user` regardless.
The `/spaces/:spaceId/agent-definitions*` route is a single inline `app.all` handler (kept that
way per the Hono routing-table landmine precedent — see its own comment) so the method check is
inline there rather than a separate `app.use`.

**Backend — router allowlist.** `PRODUCT_END_USER_PATH_PATTERNS` gained
`/spaces/:id/projects(/:id)?`, `/spaces/:id/threads(/:id)?`, `/spaces/:id/agent-definitions(/...)?`,
and `/spaces/:id/presence` — each capped to a single extra path segment via `(\/[^/]+)?$` so
`/projects/:id/rules` and `/projects/:id/spend` do NOT match (verified: the regex requires the
string to end right after the optional segment). `/scheduled-jobs` stays deliberately excluded —
its own gate (`loadOwnedSpace`) is still tenant-match-only with no per-caller floor, exactly the
footgun the router's allowlist comment already warned about.

**Backend — `product-sessions/verify` parent-walk.** Extended (not yet exercised by any real
caller, since Phase C is what introduces child business spaces) to resolve the URL space first;
if it has a `parent_space_id` (spec §49 Scenario C, depth ≤ 2 — a single hop, never a chain), walk
to that PRODUCT ROOT to find the right `ProductUserDO` (end users are a product-scoped concept —
one `ProductUserDO` per `productId×endUserId`, not per-business) — but return the URL SPACE's own
`tenant_id` (not the root's), since the router uses this as `claims.tid` for
`requireInternalHmac` against the space actually being accessed. Exists now so Phase C doesn't
have to re-open this endpoint's security model under time pressure later.

**Incidental fix:** `forwardToSpaceDO`'s `new Request(..., { body })` needed `duplex: "half"` for
spec-compliant fetch implementations (Node's undici, used by this repo's own tests) whenever a
body is attached — the exact same defect class CLAUDE.md item 30 already fixed once for the
session proxy, just never applied here. Surfaced by the first test in this pass to exercise a
body-bearing PATCH through this helper (`PATCH /projects/:id`) — previously untested.

**Frontend (`apps/shell`).** Real chat: `Chat.tsx` ports `apps/portal`'s proven SSE client
(session start/resume, SSE streaming with a polling fallback, optimistic user-message rendering)
onto the mockup's markup (`msg-row`/`bubble`/`chat-area`/`thread-panel` classes from
`packages/ui`) instead of Tailwind. Chat "sessions" (the message-history transport,
`SpaceDO.sessions`) and "threads" (the structural browse table, `SpaceDO.threads`) are separate
tables with **no server-side link yet** — `sessionKey={threadId}` keeps each thread's chat
session persisted independently client-side (`chatSession.ts`, keyed per `(spaceId, key)`,
ported from `apps/portal/src/lib/session.ts`), which is an honest client-side approximation, not
a real link — flagged in code for Phase C or later to close properly if a tighter integration
turns out to be needed. Projects view: list/create/detail (read-only config — PATCH stays
builder-only per the membership floor above) with its threads. Threads view: list/create across
the whole space. Sidebar's Projects/Threads collapsible sections and "New Thread" button are now
wired to real data (previously Phase A placeholders). Agents view: read-only library reading the
now-allowlisted `GET agent-definitions` (client explicitly passes `?space_id=` — the proxy is a
raw passthrough that returns EVERY agent definition in the DO instance if that param is omitted).
Minimal "coming soon" placeholders added for Spaces/Assistant/Knowledge/Workflows/Settings so
sidebar navigation never 404s — Phase C/D build these out for real.

**Verification:** `pnpm turbo run typecheck` clean across all 75 packages/workers/apps.
`tests/unit/business-auth.test.ts` (new, 7 tests — per-method role floors for projects/threads/
agent-definitions/presence, and that builder roles are completely unaffected),
`tests/unit/product-sessions-verify.test.ts` (+3 — parent-walk resolves the right ProductUserDO
and returns the business's own tenant_id, a session opened under the wrong id doesn't verify, an
orphaned parent returns invalid), `tests/unit/router-product-end-user-auth.test.ts` (updated —
the four previously-rejected paths now accept, `/scheduled-jobs` still rejects). 908/908 tests
pass (15 new). `apps/shell` verified via `next build` (all new routes compile) + a live
`next dev` + curl smoke test (page routing/404 behavior) — **not** verified against a live
multi-worker backend (spaces+router+agents+knowledge+billing with real D1/DO/KV bindings), since
that requires Cloudflare tooling/credentials not available in this environment; stated here
explicitly rather than implied.

**Remaining for the Three-Tier build:** Phase C (businesses, space switcher, invites,
multi-template — the point at which child business spaces and the parent-walk above finally get
exercised for real), Phase D (builder UI reskin, including the `isHydrated` fix), Phase E
(monetization).

## A1.17 continued — Phase C: businesses, space switcher, invites, multi-template — BUILT

**Backend — the security-critical fix first.** Building the membership index surfaced a real hole
the phased plan flagged in advance but Phase B's `requireBusinessMembership` hadn't yet closed:
`resolveProductEndUserClaims` proves a caller holds a valid `ProductUserDO` session scoped to the
PRODUCT (one instance per `productId×endUserId`, not per-business) — so a flat "every
`product_end_user` is a member" floor would let any end user of a product reach ANY OTHER end
user's business just by changing `:spaceId` in the URL. `resolveEndUserBusinessRole`
(`business-auth.ts`) closes it: a space with no `parent_space_id` (the product root) keeps Phase
B's behavior — a verified session for that exact space implies `"member"`, which is safe because
the session literally IS scoped to it — but a space WITH `parent_space_id` set (a real business)
now requires an ACTIVE row in the new `business_memberships` table (migration `0047`), no row, no
access, full stop. Applied to `requireBusinessMembership` (all its callers, unchanged call sites)
AND the `agent-definitions` inline gate (which had the identical flat-check hole). A dedicated
test file (`business-membership-role.test.ts`) exercises exactly this: two businesses under the
same product, each owned by a different end user, and asserts neither can read the other's role.

**Backend — `business_memberships` + `business_invites`** (migration `0047`, both explicitly
documented as routing/index tables — like `builder_api_key_index` — never a second authority;
SpaceDO's own `space_members` stays authoritative for in-space authorization). New
`workers/spaces/src/business-create.ts` extracts `createBusinessForEndUser` — the exact gating +
tenant-hierarchy + provisioning logic the original `POST /reseller/spaces` handler had inline — so
the new product-scoped wrapper (`POST /spaces/:productSpaceId/businesses`, needed because the
router's allowlist has to key off a path `:spaceId` that the bare `/reseller/spaces` route never
had) reuses it instead of a second copy that could drift; `/reseller/spaces` itself became a thin
wrapper over the same function (zero behavior change, verified by the full existing suite staying
green). New `workers/spaces/src/business-routes.ts` adds: the creation wrapper (dual-writes the
owner into `business_memberships` and best-effort mirrors into the business's own SpaceDO
`space_members`, matching `seedOwnerMember`'s non-fatal precedent); `GET .../my-businesses` (the
switcher's list, reading the index rather than opening every business's SpaceDO); invite
create/accept (`POST .../invites`, `POST .../invites/:token/accept`) with a single-use,
7-day-expiring, SHA-256-hashed token (a fast digest, not PBKDF2, since an invite token is
high-entropy random, not user-chosen — same reasoning as `builder_api_key_index`); and
`GET/DELETE .../business-members` as a **purpose-built, safe projection of the membership index**
— deliberately NOT a relaxation of the existing hardened `/spaces/:id/members*` proxy, whose
"never make product customers into SpaceDO members" rule is about the shared PRODUCT ROOT, a
different population from a business's own end-user-owned member roster.

**Deliberate scope narrowing from the phased plan's original sketch:** invite accept requires the
accepting identity to already hold a valid product session (`product_end_user` claims) rather than
being a fully unauthenticated route trusting an emailed link alone — consistent with this
codebase's convention of authenticating the acting identity everywhere else. The shell's invite UI
surfaces the accept link under `/p/[slug]/spaces/[businessId]/accept-invite/[token]`, which lives
inside the `(shell)` route group and therefore requires sign-in first (redirects to login,
matching every other shell page) — a rough edge (no return-URL preservation through the login
redirect yet) flagged rather than silently accepted as finished.

**Backend — multi-template.** `agentsForTemplates(templateIds)` (`spacetype.ts`) unions multiple
templates' agent lists deduped by id. `installLaunchpadAgents`'s third parameter widened from
`string | undefined` to `string | string[] | undefined` (every existing single-id call site keeps
working unchanged — verified by the pre-existing `provisioner-agent-triggers.test.ts` staying
green with zero edits, plus a new test exercising the array form). Provisioner step 9b's bootstrap
merge (`mergeTemplatesBootstrap`) unions projects (deduped by name, later template wins on a name
collision) and setup_scripts (deduped by value) across every template a business was built from.
`ProvisionMessage` gained `templateIds?: string[]`, with `templateId` (singular) staying the
first-entry back-compat field for any already-queued message.

**Backend — `shell/manifest` gained two fields**: `membership_model` and
`allowed_child_space_types`, both safe to expose pre-authorization (they gate a UI affordance —
whether to show "Create Business" at all — never a data-access decision; the actual creation route
re-derives and re-checks both server-side regardless of what the manifest says).

**Frontend (`apps/shell`).** The sidebar's space switcher is now real: product root + every
business from `my-businesses`, "Create Business" only shown when `membership_model` is `tenant` or
`hybrid`. New Spaces view (`/p/[slug]/spaces`) lists the product root plus the caller's own
businesses and hosts the create-business dialog (name + a multi-select of Launchpad templates —
hardcoded to match `LAUNCHPAD_TEMPLATES` since there is no product-scoped, end-user-reachable
`/templates` read route yet; a deliberate simplification flagged in code, not a silent gap). New
business detail view (`/p/[slug]/spaces/[businessId]`) shows the caller's role, lists members, and
lets an owner/admin invite (email + role) or remove a non-owner member — the owner itself can
never be removed this way (ownership transfer is out of this phase's scope, so simply disallowed
rather than left as a footgun).

**Deliberately NOT done this phase** (scope boundary, not an oversight): switching to a business
does not re-scope the ENTIRE shell (chat/projects/threads) to operate against that business's own
space — Home/Projects/Threads still operate on the product root. Making an arbitrary business's
own chat/projects/threads reachable through the existing shell routes is a real, separate
architectural question (URL structure, active-space state, and re-auditing every existing shell
page's assumption that `product.space_id` is the operative space) that deserves its own pass
rather than a rushed bolt-on here. The Spaces view's business detail page is the interim surface
for what a business actually needs right now (membership management); a business's own
chat/projects/threads is the natural next increment once that architectural question is settled.

**Verification:** `pnpm turbo run typecheck` clean across all 75 packages/workers/apps. New tests:
`business-membership-role.test.ts` (5 — the cross-business security assertion),
`business-create.test.ts` (7 — every gating branch of `createBusinessForEndUser` plus child-tenant
reuse/isolation), `business-routes.test.ts` (11 — the full HTTP-level creation/switcher/invite/
members surface, including cross-business isolation for the new routes), extended
`launchpad-spacetype.test.ts` (+2) and `provisioner-agent-triggers.test.ts` (+1) for multi-template,
extended `product-shell-manifest.test.ts` (+2) for the new manifest fields, extended
`router-product-end-user-auth.test.ts` (+1) for the new allowlist entries. 937/937 tests pass (21
new). `apps/shell` verified via `next build` (all new routes compile) + a live `next dev` + curl
smoke test — not verified against a live multi-worker backend, same stated limitation as Phase B.

**Remaining for the Three-Tier build:** Phase D (builder UI reskin + config, including the
`isHydrated` fix and a real per-product `/builder/products/:id/businesses` team-mode creation
route), Phase E (monetization).

## A1.17 continued — Phase D: builder UI reskin + product configuration — BUILT

**The `isHydrated` bug, confirmed and fixed with a real browser test, not just reasoning about
it.** `apps/dashboard/src/lib/auth-provider.tsx`'s `isAuthenticated` was `token !== null && claims
!== null`, both `null` until a `useEffect` reads `localStorage` on mount. `DashboardLayout`'s own
`useEffect(() => { if (!isAuthenticated) router.replace("/login") })` is a CHILD of `AuthProvider`
— React fires effects child-first within one mount commit — so on every hard reload of any nested
`/dashboard/*` route, the layout's redirect effect ran BEFORE `AuthProvider`'s hydration effect,
saw the default `isAuthenticated: false`, and bounced to `/login` even with a valid token sitting
in storage. Added `isHydrated` (false until the mount effect completes, same pattern `apps/shell`
already shipped in Phase A) and gated both `DashboardLayout`'s and the root `HomePage`'s redirects
on it. Verified with a real headless-Chromium CDP session (no Playwright/npm package available in
this environment, so driven via raw CDP over Node's built-in `WebSocket` — same class of technique
as the Fetch-domain mocking established in Phase 5): stored a valid-shaped JWT in `localStorage`,
hard-navigated straight to `/dashboard/clients`, and confirmed it stays there (previously would
have bounced); a second run with `localStorage` explicitly cleared confirms the unauthenticated
path still correctly redirects to `/login` — both directions of the gate checked, not just one.

**Reskin approach — retarget + shell swap, not a per-page rewrite.** A full Tailwind-to-`@naelao/ui`
markup conversion across ~25 existing dashboard pages was judged disproportionate to what "reskin"
needs; instead: (1) `tailwind.config.ts`'s `brand` color scale was regenerated from the mockup's
actual accent (`packages/ui/src/tokens.css`'s `--accent #5b52f0`) — every existing
`bg-brand-*`/`text-brand-*`/`border-brand-*`/`ring-brand-*` utility across every page picks up the
new violet identity instantly, zero markup changes, zero regression risk; (2) `globals.css` imports
`@naelao/ui/tokens.css` + `@naelao/ui/styles.css` (no class-name collisions found — the dashboard
never used bare `.btn`/`.card` class names) so the DM Sans font, warm paper background, and shared
component classes are available; (3) the root layout's `<body>` now reads `var(--bg)`/`var(--text)`
directly instead of `bg-gray-50 text-gray-900` (Tailwind utility classes still win by specificity
wherever an existing page sets its own colors, so this is additive, not a repaint of every page).
The highest-visibility piece — the shell chrome — got a REAL component swap: `DashboardLayout` now
renders `@naelao/ui`'s `Sidebar`/`TopBar`/`Badge` (all three already generic enough for an admin
nav; `Sidebar`'s `projects`/`threads`/`spaceSwitcher` props are optional and simply don't render
when omitted, so it fits without dragging in end-user chat-shell concepts) instead of hand-rolled
Tailwind markup — verified visually via the same CDP screenshot technique (warm paper background,
violet accent, Instrument Serif logo wordmark all render correctly with a live dev server).

**IA restructure — real functionality preserved, not the plan's literal 3-item list.** Nav
collapsed to Dashboard / Spaces (same URL as the old "Products" nav item — `/dashboard/products`,
just relabeled, since to a builder "my products" and "my spaces" are the same thing) / Clients /
Settings. Deliberate deviation from the phased plan's literally-stated "nav = Dashboard, Spaces,
Settings": Clients (the reseller portfolio drawer — real, working, tested functionality) was KEPT
rather than dropped, since removing a working feature was never actually requested, just implied
by an enumerated list that didn't mention it. Removed for real: `/dashboard/spacetypes/*`
(confirmed dead on TWO axes — `listSpaceTypes()` calls `GET /spacetypes`, a route no worker
implements per the Phase 0 audit, AND it linked to `/dashboard/spacetypes/:id` and `.../edit`,
neither of which was ever a page, a 404 on click; also conceptually obsolete since CLAUDE.md #7
established Naelao authors all SpaceTypes, not builders), `/dashboard/usage/*` and
`/dashboard/team/*` (both call `/v1/usage/*` and `/v1/team/*`, the exact unbacked routes Phase 0
flagged as an out-of-scope gap and never fixed). Fixed two dangling links this removal exposed
(`dashboard/page.tsx`'s quick action, the legacy `dashboard/spaces/page.tsx` modal's empty-state
link) to point at the real `/dashboard/products/new` wizard instead of the now-deleted dead page.
Deliberately NOT deleted: the legacy `/dashboard/spaces` raw Space-CRUD list and its
`[spaceId]/{commerce,connectors,credentials,eval,kb,onboarding,sessions,webhooks}` sub-pages — real,
working per-space admin tools nothing else replaces yet — just no longer linked from top nav (the
Products wizard is now the canonical "create a space" path); still reachable by direct URL.

**Config surfaces — all three backend fields already existed on `SpaceTypeProductConfig`
(`membershipModel`, `allowedChildSpaceTypes`, `userPermissions`) except one new one.** The
Configuration tab gained: a Product Mode picker (team/tenant/hybrid, with `allowPublicSignup` +
`allowedChildSpaceTypes` shown only for tenant/hybrid), a Limits section (`userPermissions`:
max threads/user, max credits/month, can-create-sub-spaces, can-create-projects), and a Templates
Catalog (checkboxes over the same hardcoded `LAUNCHPAD_TEMPLATES` list `apps/shell`'s create-
business dialog already uses — same "no builder-reachable `/templates` route yet" simplification,
applied consistently in both places). The Templates Catalog needed one genuinely new backend field,
`productConfig.catalog.businessTemplates` (`SpaceTypeRegistryDO.ts`) — plumbed through
`shell/manifest`'s existing safe-projection pattern as `business_templates`, and `apps/shell`'s
create-business dialog now filters its template picker by it (empty/unset = every template, the
pre-Phase-D default, so this is non-breaking for every product that hasn't configured it yet). All
three config sections round-tripped through `PATCH /builder/products/:id`'s existing
shallow-merge-into-`productConfig` handler with ZERO backend route changes — confirmed by feeding
the full config shape through a mocked `GET /builder/products/:id` via CDP's Fetch domain and
screenshotting the rendered, pre-populated form (Product Mode correctly showed "Hybrid" selected;
Templates Catalog correctly checked exactly the two configured templates and left the other five
unchecked). New **Agents tab** (8th tab) is a deliberately READ-ONLY view of the SpaceType's 3 core
agents (name, trigger, required-approval actions) — hardcoded like the templates lists, for the
same reason. Per-agent enable/disable (which the phased plan's Agents bullet also mentioned) was
NOT built: it would require a new `productConfig.catalog.disabledCoreAgents`-style field AND
threading it into the provisioner's agent-install step (`workers/provisioner/src/index.ts`,
`installLaunchpadAgents`) — a real, separate follow-up, flagged here rather than rushed in without
adequate test coverage for a path that touches what actually gets provisioned.

**Verification:** `pnpm turbo run typecheck` clean across all 75 packages/workers/apps (unchanged
count — `@naelao/dashboard` was already in it). `pnpm exec vitest run`: 938/938 tests pass (1 new —
`business_templates` manifest coverage). `apps/dashboard` verified via `next build` (all pages
compile, removed routes 404 as expected) AND two real headless-Chromium CDP sessions: one proving
the `isHydrated` fix in both directions (valid token survives a hard reload of a nested route; no
token still redirects to login), one mocking `GET /builder/products/:id` to screenshot the
Configuration and Agents tabs end-to-end with realistic pre-populated data. Not verified against a
live multi-worker backend, same stated limitation as Phases B and C.

**Remaining for the Three-Tier build:** Phase E (monetization — subscriptions + credit packs, and
the `packages/entitlements` table-name reconciliation the phased plan calls a precondition for it).

## A1.17 continued — Phase E: monetization (subscriptions + credit packs) — BUILT

**Precondition — entitlements + admin worker schema reconciliation.** `@naelao/entitlements`
queried `organizations` (real table: `orgs`), `users.tenant_id` (real column: `users.org_id`), and
`api_keys.tenant_id` (real column: `api_keys.org_id`) — confirmed by tracing `NaelaoJwtClaims.tid`'s
own "tenantId (orgId)" comment: every builder-facing "tenantId" IS an org id, never a Launchpad
business's `spaces.tenant_id` (a genuinely different concept the `spaces` query correctly kept
using `tenant_id` for). Every `EntitlementsChecker` call would have thrown against a real D1
database — fixed all three, plus added `revoked_at IS NULL` to the api_keys usage count (a revoked
key shouldn't count toward quota, a real correctness gap the original query ignored). `workers/admin`
had the identical `organizations` bug (5 call sites) plus two more found while tracing it: its
feature-flags routes used a `key`/`value_json`/`tenant_id` shape that migration
`0023_feature_flags.sql` never created (real: `name`/`enabled`/`rollout_pct`/`overrides_json`) with
an `ON CONFLICT` target matching no UNIQUE constraint, and `/admin/stats` queried a `sessions` D1
table that has never existed (sessions live in each SpaceDO's own per-space SQLite, not D1 — no
single-query cross-space aggregate is possible) — both would 500 on every call. Fixed the
feature-flags routes to match the real schema; replaced the impossible `sessions_24h` count with an
honest `null` (same precedent as the Builder Dashboard's `credits_consumed: null`) rather than
fabricating a number. Also found and fixed a genuine migration-history bug while tracing `api_keys`:
`0022_api_key_scopes.sql`'s `CREATE TABLE IF NOT EXISTS` was a no-op against the table
`0004_billing.sql` already created with different columns, so its own `CREATE INDEX ... ON api_keys
(tenant_id, ...)` has been failing silently in every deployment since (deploy workflows swallow
migration errors with `|| true`) — new migration `0048_admin_schema_fixes.sql` recreates the
intended indexes against the columns that actually exist, and adds the `orgs.updated_at` column the
admin worker's PATCH route was writing to but no migration had ever created. Extended
`tests/stubs/d1-sqlite.ts`'s `createFakeD1` shim to support `first()/all()/run()` directly on
`prepare()` without requiring `bind()` first (matching real D1's API for parameterless queries) —
needed to test `/admin/feature-flags` GET and `/admin/stats`, which never bind anything. 949/949
tests pass (11 new across two new files).

**Design decision, confirmed against the phased plan's own migration-name hint
(`0048_business_subscriptions.sql`) and the existing `memberBilling` precedent: a BUSINESS
subscribes to a plan as a whole, not an individual end user.** Mirrors `memberBilling`'s "the whole
space pays" shape exactly, not a per-user charge — consistent with Launchpad's existing mental model
(a business's credits/limits are shared org-wide, spec `userPermissions.maxCreditsPerMonth` is
already framed per-product-user as a CEILING, not a wallet). Credit packs are the one thing that
genuinely IS per-individual (an end user tops up their OWN `ProductUserDO` balance), so the two
money paths deliberately land on different owners even though both are configured on the same
product-root catalog.

**Catalog resolution — a business never carries its own catalog.** `productConfig.pricingConfig`
gained `plans: [{id,name,priceCents,interval,creditAllowance,limits,lsVariantId}]` and
`creditPacks: [{id,name,credits,priceCents,lsVariantId}]` (`SpaceTypeRegistryDO.ts`). The builder
authors these ONCE on the product root via `PATCH /builder/products/:id/pricing`
(`workers/spaces/src/builder-routes.ts`) — provisioning a real Lemon Squeezy variant for any
plan/pack that doesn't have one yet (exactly the `memberBilling`/product-publish provision-on-save
pattern; an already-provisioned item's `lsVariantId` is left untouched even if its price changes
here, since silently repricing a live LS variant out from under active subscribers should never be
an implicit side effect). Any business (child space) resolves the SAME catalog by walking up
`parent_space_id` to the product root — new `loadPricingCatalog()` helper in
`workers/spaces/src/index.ts`, the same one-hop-max parent-walk `/internal/product-sessions/verify`
already established, reused by both `GET /spaces/:spaceId/pricing` (business-scoped display, gated
`requireBusinessMembership({GET:"member"})`) and `GET /internal/pricing-catalog` (the billing
worker's checkout-time variant lookup, `requireInternalHmac`-gated).

**Checkout — new billing worker routes follow the existing commerce/seat checkout pattern exactly,
not a new shape.** `POST /internal/business-subscriptions/checkout` and `POST
/internal/credit-packs/checkout` (`workers/billing/src/index.ts`): resolve the plan/pack via the
spaces worker's `/internal/pricing-catalog` (this worker doesn't know the business/product
hierarchy rules — that's the spaces worker's job), same dev-fallback-without-LS-creds precedent, same
`requireInternalHmac` gate. End users reach these through two new spaces-worker proxy routes,
`POST /spaces/:spaceId/business-subscription/checkout` and `POST /spaces/:spaceId/credit-packs/checkout`
(both `requireBusinessMembership({POST:"member"})`-gated, `end_user_id` always derived from the
caller's OWN verified identity, never a client-supplied field) — allowlisted on the router
(`PRODUCT_END_USER_PATH_PATTERNS`) alongside the existing `/pricing` display route, all three
carrying the same "identity, not authorization" caveat every prior allowlist entry documents.

**Webhook wiring + the state that didn't exist before this phase.** New migration
`0049_business_subscriptions.sql`: one row per business (`UNIQUE(business_space_id)` — a business
switching plans overwrites the row rather than accumulating history; `reseller_ledger` stays the
historical revenue record, unchanged). The Lemon Squeezy webhook
(`workers/billing/src/lemon-squeezy.ts`) gained `recordBusinessSubscription` (upserts by
`business_space_id` on every `subscription.*` event whose checkout metadata carries
`kind=business_subscription` — a webhook retry or a later status transition is an in-place update,
never a duplicate row) and `grantCreditPackPurchase` (on `payment.success` with
`kind=credit_pack`, calls a new `POST /internal/credit-packs/grant` on the spaces worker — the only
worker holding the `PRODUCT_USER_DO` binding). `NormalizedBillingEvent` gained `providerStatus`/
`currentPeriodEnd` (`packages/billing-core`) since the LS provider's `parseWebhookEvent` was
discarding the raw subscription status/renewal date entirely — needed to map LS's status vocabulary
onto `business_subscriptions.status`'s narrower CHECK-constrained enum.

**Idempotency — closed a real double-grant risk the credit-pack path introduced.**
`launchpad_orders` already had a `provider_event_id` unique-partial-index precedent for D1 tables,
but `ProductUserDO`'s `credit_ledger` is per-DO SQLite with no such mechanism — a webhook retry on a
credit-pack grant would have double-credited the buyer. Converted `ProductUserDO`'s schema init from
a bare `CREATE TABLE IF NOT EXISTS` (a no-op against an already-provisioned DO, the exact class of
bug the entitlements/admin-worker precondition above just found and fixed elsewhere) to
`@naelao/db`'s `applyMigrations` — matching `SpaceDO`'s existing versioned-migration convention —
and added a real migration (v2) giving `credit_ledger` an `idempotency_key` column with a partial
unique index. `POST /credits/grant` now accepts an optional `idempotency_key`; a repeat call
returns the balance as of the ORIGINAL grant (`deduplicated: true`) instead of granting twice.

**Frontend.** Dashboard gained a 9th product tab, **Pricing** — plan/pack editors with a live
"Provisioned"/"Not provisioned" badge per item (from `lsVariantId` presence), round-tripping through
`PATCH /builder/products/:id/pricing`; hidden behind an explanatory empty state for `team`-mode
products (pricing only makes sense once a product allows businesses at all). Shell's business detail
page (`spaces/[businessId]/page.tsx`, already the Members-management surface from Phase C) gained
Subscription Plans (owner/admin can Subscribe — redirects to the LS checkout URL) and Credit Packs
sections (any member can Buy, explicitly labeled as topping up the BUYER'S OWN balance, not the
business's, to avoid the natural confusion of a per-individual purchase appearing on a
business-scoped page). Both verified end-to-end: the dashboard's Pricing tab via the established CDP
Fetch-mock screenshot technique (a provisioned "Pro" plan correctly shows "Provisioned", an
unprovisioned "Basic" plan shows "Not provisioned"); the backend via 23 new tests across two files
(`pricing-catalog.test.ts` — parent-walk resolution, the cross-business isolation assertion every
`requireBusinessMembership` route gets, builder pricing PATCH provisioning idempotency, credit-pack
grant idempotency; `business-subscriptions-billing.test.ts` — checkout route construction against a
mocked Lemon Squeezy API, webhook status-mapping, the seat/product/business-subscription/credit-pack
`kind` discriminator never cross-firing).

**Verification:** `pnpm turbo run typecheck` clean across all 75 packages/workers/apps.
`pnpm exec vitest run`: 973/973 tests pass (34 new across three files, on top of the precondition's
11). `apps/dashboard` and `apps/shell` both verified via `next build` (all new routes/pages compile).
Not verified against a live multi-worker backend or a real Lemon Squeezy sandbox account, same
stated limitation as every prior phase — the dev-fallback checkout path (no LS credentials) is what
every automated test exercises.

**Remaining for the Three-Tier build:** Phase 7/8 of the original full-vision plan (sub-space/
reseller UI polish beyond what Phases C/D/E already cover, deferred product-sdk + per-product CF
Pages deploy) — see the plan's own phase list for what's left unbuilt.

## A1.17 continued — Launchpad go-live: Phase F (Whop-first rollout + explicit Custom) — BUILT

**Goal:** activate the "Whop first, everything else coming soon" framing that was already
architecturally present (`LaunchpadTemplate.coming_soon`) but never actually set on any template,
and de-drift two hand-maintained copies of the template list that had grown across the codebase.

**Backend.** Set `coming_soon: true` on the six non-Whop `LAUNCHPAD_TEMPLATES`
(`workers/agents/src/launchpad/spacetype.ts`): creator-store, newsletter-business, micro-saas,
service-agency, coaching-community, customer-service. `whop-seller` stays live. The existing
`GET /templates` route (agents worker) and `apps/dashboard/src/lib/temples.ts`'s wizard filter
already honored this flag — setting it was the only change needed on that path.

New `loadTemplateCatalog()` (`workers/spaces/src/index.ts`) is the single source of truth the
shell and dashboard both now render from: a KV-cached (1h, same pattern as `loadManifest`) call to
the agents worker's `GET /templates` via the existing `AGENTS_WORKER` service binding, projected
down to `{id, name, coming_soon}` (never the full bootstrap/agents/skills shape, which stays
builder/provisioner-internal). Wired into `GET /spaces/:spaceId/shell/manifest` as a new
`template_catalog` field, intersected server-side with the builder's existing
`productConfig.catalog.businessTemplates` narrowing (empty/unset = every template, matching
`business_templates`' existing semantics) — so the client never re-implements that intersection.
Caught a real bug before it shipped: the first draft of `loadTemplateCatalog` parsed the agents
worker's response as `{data: [...]}`, but the real `GET /templates` route returns `{templates:
[...]}` — a test asserting the actual field ("fetches the real catalog ... from GET /templates")
failed immediately and caught it.

**Frontend.** `apps/shell`'s create-business dialog (`spaces/page.tsx`) now renders from
`manifest.template_catalog` instead of a hardcoded `LAUNCHPAD_TEMPLATES` duplicate — coming-soon
templates render disabled with a "Coming soon" badge — and gained an explicit **"Custom — build
from scratch with the assistant"** toggle (mutually exclusive with real template selections; maps
to `template_ids: []`, which `business-create.ts` already supported as an implicit empty-selection
state before this pass, now a labeled choice with copy explaining the assistant will help). The
dashboard's Configuration page Templates Catalog section now fetches the same real, coming_soon-
aware list via the existing `getTemplates()` client function (already used by the wizard's Temple
Gallery) instead of its own separate hardcoded copy, with a "Coming soon" annotation per item.

**Tests:** extended `tests/unit/product-shell-manifest.test.ts` with 4 new cases — no-binding
returns empty catalog, the real catalog round-trips with correct `coming_soon` values, the
business_templates intersection narrows correctly, and the KV cache prevents a second agents-worker
call. 977/977 tests pass (4 new). `pnpm turbo run typecheck` clean (75 tasks). Both `apps/dashboard`
and `apps/shell` verified via `next build`.

**Remaining for Launchpad go-live:** Phase G (business-builder Space Assistant — the actual Polsia
differentiator), Phase H (builder domain/name post-creation UI polish). Full phased plan (including
the larger script-engine/execution-ladder/container roadmap beyond Launchpad) is tracked in the
session's plan file, not yet mirrored into this doc section by section — update as each phase lands.

## A1.17 continued — Launchpad go-live: Phase G (business-builder Space Assistant) — BUILT

**Goal:** give the Launchpad Space Assistant the actual capability the spec/user vision describes
— help an owner go from "I want to build a business" to a running one, Whop-first — rather than
the generic coordinator prompt every other SpaceType's assistant gets.

**G1 — `LAUNCHPAD_ASSISTANT_PROFILE`** (`workers/agents/src/script-engine/profiles.ts`), the SAME
`agentId: "naelao-agent"` every dispatcher already hardcodes, just a richer bundle: adds a
"Business-Building Methodology" section to `agents.md` (discover → propose 1-3 Whop-first options
→ scaffold on approval → launch checklist → recurring revenue review) and a matching system prompt,
on top of the generic assistant's existing continuous-existence/channels/honest-escalation framing.
Explicitly leans into transparency/honest-escalation as the differentiator from "runs while you
sleep" black-box competitors (Polsia) rather than chasing full autonomy by default. Adds
`commerce`, `storefront`, `mcp-connector`, and the new `workspace-admin` prebuilt to the assistant's
`scripts.prebuilt` (the generic assistant doesn't get business capabilities). The provisioner
(`installLaunchpadAgents`) writes this profile instead of `DEFAULT_NAELAO_AGENT` — safe because
that function is only ever called when `spacetype_id === "launchpad"`.

**G2 — new `workspace-admin` prebuilt**
(`workers/agents/src/script-engine/prebuilt/workspace-admin.ts`) is what makes the assistant able
to actually DO something, not just describe a plan: `project.create_from_template` (mirrors the
exact 4-step sequence — create, configure, seed rules, seed scheduled jobs — that the agents
worker's own `POST /spaces/:spaceId/projects/from-template` route already performs, replicated
directly against the spaces-worker binding rather than an HTTP self-call, since a Durable Object in
the same Worker as that route has no "call my own router" primitive), `project.list`,
`project.configure`, and `agent.list` (read-only). All HMAC-token-verified against the spaces
worker, same pattern as `commerce.ts`.

**G3 — business-building skill library was deliberately NOT built as a separate R2/Vectorize skill
seed in this pass.** A proper `script.find`-discoverable skill needs embeddings, and half-building
that pipeline (skills with no embeddings are unfindable by the ANN search that makes `script.find`
useful) would be worse than not building it — the methodology instead lives directly in G1's
`agents.md`/system prompt, which is real, honest value without the half-built risk. Flagged as a
real follow-up, not silently dropped.

**G4 — autonomy toggle reuses the ALREADY-BUILT `assistant_policy` gate (SpaceDO migration v14) —
no new gate engine.** Two things had to be gotten right that weren't obvious from the plan: (1) for
the Space Assistant specifically (no `projectId`), `AgentConfig.requiresApprovalFor` is completely
ignored by `NaelaoAgentDO.handleScriptRun` — the assistant's gate list comes exclusively from the
space's `assistant_policy` row, fetched fresh per run, so G1's profile does NOT set that field; (2)
`assistant_policy` has no provisioning-time seed anywhere in the codebase (the row is created
lazily via PATCH), so a fresh Launchpad space's assistant would default to `always_ask` with an
EMPTY `auto_approved_actions` — gating even harmless reads like listing projects. New
`seedLaunchpadAssistantPolicy` (provisioner) PATCHes a "guided" default (`always_ask` +
`LAUNCHPAD_ASSISTANT_DEFAULT_AUTO_APPROVED`: `project.list`, `agent.list`,
`commerce.list_products`, `commerce.get_order`, `mcp.list_servers`, `mcp.list_tools`,
`memory.recall`) at install time, best-effort/non-fatal like `seedOwnerMember`. The builder-facing
toggle is a new "Naelao Agent — Space Assistant" card at the top of the dashboard's existing Agents
tab (`apps/dashboard/.../products/[productId]/agents/page.tsx`) with Guided/Autonomous buttons that
PATCH `approval_mode` between `always_ask` and `yolo` via two new thin API functions
(`getAssistantPolicy`/`updateAssistantPolicy` in `apps/dashboard/src/lib/api.ts`) calling the
already-HMAC-gated `/spaces/:spaceId/assistant-policy` route directly (the product root space IS
the product, so no new builder-scoped endpoint was needed) — deliberately NOT exposed in
`apps/shell` yet, since that route only checks tenant-match, not per-business ownership, and
allowlisting it for `product_end_user` callers would need a `requireBusinessMembership`-style
owner/admin floor first (the same "identity, not authorization" gap every prior router-allowlist
addition has had to close) — a real, scoped follow-up rather than rushed in.

**Tests:** `tests/unit/workspace-admin-prebuilt.test.ts` (6 tests — verified-token calls, the full
create-from-template sequence, project_id validation, missing-binding error); extended
`tests/unit/launchpad-assistant-profile.test.ts` (4 tests — the provisioner writes the
business-builder profile under `naelao-agent` with `workspace-admin`/`commerce` in its prebuilt
list, and seeds the guided policy default via a verified token, non-fatal on failure). 987/987
tests pass (10 new). `pnpm turbo run typecheck` clean (75 tasks). `apps/dashboard` verified via
`next build`.

## A1.17 continued — Launchpad go-live: Phase H (domain/name post-creation UI) — BUILT

**Goal:** close the gap the earlier gap-analysis found — `POST/GET /builder/products/:id/domain`
(CF-for-SaaS custom hostname create + DNS/DCV + poll) was real backend with zero post-creation UI;
the product-creation wizard's domain call was fire-and-forget with its DNS instructions discarded,
and the product's display name had no edit surface despite `PATCH /builder/products/:id` already
supporting it. Pure UI wiring — no backend changes.

**New Domain tab** (`apps/dashboard/.../products/[productId]/domain/page.tsx`, added to
`layout.tsx`'s tab list) calls the existing `getBuilderProductDomain`/`configureBuilderProductDomain`
functions. Renders the connected domain, a status badge (Not configured / Pending DNS / Active), the
CNAME + TXT DCV records returned by `createCustomHostname`, and a "Check status" button that re-polls
`GET .../domain` (which itself flips the stored status to `active` once Cloudflare reports both
`status` and `ssl_status` as active). This is exactly what the wizard's fire-and-forget call was
missing a home for — the DNS instructions are now viewable and the domain retriable after creation.

**Product name edit** — a "Product Name" field added to the top of the Configuration page
(`apps/dashboard/.../products/[productId]/configuration/page.tsx`), pre-populated from
`product.name`, saved via the already-existing `updateBuilderProduct(id, { name, product_config })`
(the PATCH handler already accepted `name`; there was simply no input for it anywhere).

**Verification:** `pnpm turbo run typecheck` clean (75 tasks); `apps/dashboard` verified via
`next build` (new Domain route compiles) AND a real headless-Chromium CDP session (the established
Fetch-domain mock technique) — screenshots confirmed the Domain tab renders a "Pending DNS" badge,
the connected domain, and both DNS records correctly from mocked backend data, and the Configuration
page's new Name field is pre-populated. No backend changes → no new backend tests (both API
functions already existed; only their UI consumers were missing).

**Launchpad go-live (Phases F/G/H) is now COMPLETE.** Remaining work is the larger script-engine/
execution-ladder/container roadmap (Phases I onward) tracked in the session's plan file.

## A1.17 continued — Phase I: Code-Mode multi-MCP workflow engine — BUILT (scoped)

**Goal:** let ONE agent-authored script deterministically chain several MCP servers (get data
from A, act on B) instead of that composition only happening across separate model-driven
reasoning-loop turns, with credentials never exposed to the model, and real LLM usage billed to
the right balance. Built on substrates the agents worker already declared
(`[[worker_loaders]] LOADER`) but the isolate never actually used for this.

**I1 — `ctx.mcp` in the Tier 2-4 isolate** (`workers/agents/src/script-engine/code-runner.ts`).
When the host wires `mcpHubWorker` (`NaelaoAgentDO` → `this.env.MCP_HUB`), every isolate gets
`ctx.mcp.{call,list_servers,list_tools}`, looping back to the SAME `naelao-mcp-hub` worker the
`mcp-connector` prebuilt already uses, via the exact same request shape
(`http://mcp-hub/v1/spaces/{space}/mcp-servers/...`) so the two paths stay behaviorally identical.
The isolate never receives a credential — mcp-hub still resolves auth server-side exactly as it
does for the prebuilt path — it receives a short-lived (60s), tenant-scoped internal token minted
in real TS (`mintInternalToken`) just before isolate construction, never the platform secret
itself. **Available at every isolate tier (2-4)**, not gated to Tier 4, since fast pure-JS
multi-MCP orchestration is the core Code-Mode use case, not something that should require a
browser. A real bug was found and fixed before shipping: `loader.get(id, factory)` caches
isolates by id and does NOT re-invoke `factory` (so does not refresh `env`) while a warm isolate
exists — which would have silently gone stale on the 60s-token freshness check the moment an
isolate stayed warm past a minute. Fixed by folding a coarse 45-second time bucket into the lock
id, but ONLY when `mcpHubWorker` is configured — scripts that never touch `ctx.mcp` keep the
original stable id, so their isolate-reuse cache hit rate is unaffected.

**I2 — mcp-hub hardening.** Two real, independent gaps closed: (a) `requireInternalHmac` added to
`/v1/spaces/*` (the worker's only real ingress is direct service bindings, never the public
router, so this is the same defense-in-depth backstop every other internal-only worker already
has — `workers_dev=false` was the sole control before this). Every existing caller updated to mint
a real token: `mcp-connector.ts`'s `hubHeaders()`, and three direct `c.env.MCP_HUB.fetch(...)`
call sites in `workers/agents/src/index.ts` (`/connectors/status`, `/connectors/:platform/connect`
list + register) that had never sent one. (b) The reserved-tool-name guard
(`isReservedToolName` — money-in-shaped tool names are reserved to the prebuilt `commerce` script)
previously existed ONLY inside the `mcp-connector` prebuilt — a CLIENT of the hub's `/tools/call`
route — so the new `ctx.mcp.call` isolate loopback would have bypassed it entirely by calling the
hub directly. Mirrored the guard into `workers/mcp-hub/src/index.ts` itself (kept in sync by hand,
same precedent as the existing `isReservedPaymentHost` duplication) so it's now enforced
authoritatively for every caller, present and future, not just the one prebuilt.
**Deliberately NOT built this pass:** per-user MCP credential resolution (`on_behalf_of_user_id`
threaded into `buildAuthHeaders` so a member's own connected account, not just the space-level
fallback, resolves) — this needs a new "acting end-user id" field plumbed through
`ScriptEngineEnv`/`buildScriptEngineEnv` that nothing currently populates; flagged as a real
follow-up rather than adding an unused field.

**I3 — Naelao-LLM-in-script billing, scoped to the end-user sink.** `tokensToCredits` (already
real) is now actually debited for a **non-project** run (Space Assistant / product-shell Home
chat) by a signed-in **product end user**: new `POST /internal/product-users/:spaceId/:endUserId/
credits/deduct` on the spaces worker (HMAC-gated) wraps `ProductUserDO`'s existing, already-
tested, fails-closed `/credits/deduct` — the missing piece was purely a caller; `NaelaoAgentDO`
never had a way to reach it. New `debitEndUserCredits()` in `NaelaoAgentDO`, called from
`handleScriptRun` as the mutually-exclusive `else` branch of the existing project-spend-cap logic
(`callerRole === "product_end_user"` — read from the router-set `x-naelao-role` header, the same
trust boundary as `x-naelao-tenant-id`, never client-suppliable). Post-hoc, best-effort — matches
the existing project-spend accounting's own posture (never crashes an already-completed run's
response over a billing hiccup) but surfaces insufficient-balance/failure in the run's `notes` so
it's visible, not silently swallowed. **Deliberately NOT built this pass:** the `space_credits`
sink for builder/team-owned runs — that table has ZERO existing read/write code anywhere in the
platform (only its migration), so "wiring an existing sink" (the plan's framing) doesn't apply;
building one from scratch (daily-reset semantics implied by its `daily_spent`/`last_reset_date`
columns, fail-closed insufficient-balance handling) is a real, separate, money-adjacent feature
that deserves its own focused pass rather than being rushed alongside everything else in this one.

**I4 — no new authoring mechanism needed.** The reasoning loop's existing `distill` action already
accepts arbitrary `metadata.requires_tier` + `code` — a model authoring a Tier-2 script that calls
`ctx.mcp.call(...)` multiple times distills and re-runs through the SAME `script.find`/`script.run`
path every other capability already uses. I1 alone is what makes multi-MCP workflow scripts
possible; no "codemode script kind" or new distill affordance was required.

**Tests:** extended `tests/unit/code-runner.test.ts` (4 new — single-call token verification, a
**two-different-servers-in-one-script** chain proving the core deterministic multi-MCP ask, list
ops, graceful absence without a binding); new `tests/unit/mcp-hub-hmac.test.ts` (5 — rejects
without/with-wrong-tenant token, accepts a valid one, blocks a reserved tool name server-side even
when called directly bypassing the prebuilt, allows an ordinary tool through); new
`tests/unit/mcp-connector-hmac.test.ts` (2 — the prebuilt's own calls now carry a verified token);
new `tests/unit/end-user-credit-debit.test.ts` (5 — token-gated, debits correctly, fails closed at
402 on insufficient balance without going negative, 404 for an unknown product, rejects non-
positive amounts). All existing `code-runner.test.ts` calls updated for the new required
`tenantId` field on `TieredCodeRunner.run()` (threaded through `execution-ladder.ts` and the two
other direct callers, `browser-use.ts` and `code-exec.ts`). 1003/1003 tests pass (16 new).
`pnpm turbo run typecheck` clean (75 tasks).

**Remaining (documented, not dropped):** per-user MCP credentials (I2b), the `space_credits` sink
for builder-owned runs (part of I3), and Phases J (Workflows tier), K (per-project R2-mounted
container), N (Launchpad operator-shell UI + cleanup), L (Container Marketplace), M
(local-machine-as-container) — see the session's plan file for the full roadmap.

### Phase J — Durable Workflows tier (long-running/cron scripts survive restarts)

**Goal:** a script that must run for minutes/hours/days, survive a restart, or fire on a cron runs
as a Cloudflare Workflow (step retries, long ceiling) instead of holding a Tier 2-5 isolate or the
agent DO open the whole time. Built on the substrate the agents worker already declared
(`[[workflows]] AGENT_TASK_WORKFLOW`) but that binding's shape (one full agent reasoning turn,
`AgentTaskWorkflow`) doesn't fit "run this one named script durably" — so this phase adds a
second, narrower Workflow class rather than overloading the first.

**J1 — `metadata.runtime` on `ScriptMetadata`, orthogonal to `requires_tier`.** A stored script can
now carry `runtime: "isolate" | "workflow"` (default `"isolate"`, unchanged behavior for every
existing script). `requires_tier` still governs WHAT the eventual execution is allowed to do
(browser/container/etc.); `runtime` governs WHERE it runs — synchronously in the calling
`script.run`, or dispatched to a durable Workflow instance that the caller doesn't block on.

**J2 — `WorkflowRunner` injected into `ScriptEngineEnv`, wired the same way `codeRunner` is.**
`execution-ladder.ts`'s `runStoredScript` checks `script.metadata.runtime === "workflow"` BEFORE
falling through to `env.codeRunner` — if `env.workflowRunner` is absent it degrades honestly
(`ok:false`, same precedent as every other optional binding), never silently running the script in
an isolate instead. On success it returns immediately with `{ workflow_id, status: "started" }` —
this is deliberately fire-and-forget from the caller's perspective (the whole point of "durable" is
not waiting on it); `workflow.status` (dynamic-workflow prebuilt) is how progress gets checked
later.

**J3 — the workflow IS a stored script, not a second store.** `dynamic-workflow`'s
`workflow.create(name, code)` op (previously always "not available" — `buildOrchestrationHooks`
never set the workflow hooks at all) now just calls `ScriptToolSurface.create()` with
`metadata.runtime: "workflow"` — the SAME skill library `script.create` already writes to.
`workflow.run(name, params)` is literally `tools.run(name, params)`; because the script is tagged
`runtime:"workflow"`, `execution-ladder.ts` routes that particular `script.run` call to
`ScriptRunWorkflow` regardless of who invoked it (the dynamic-workflow prebuilt, a trigger fire, or
a scheduled job) — one routing decision, not three call sites that could drift. This is also why no
code ever needs to travel through a Workflow instance's own params: `ScriptRunWorkflow`'s one step
re-resolves the script BY NAME through `POST /internal/scripts/run-durable` → the existing
`fireScriptDirectly` → `agent-do/triggers/fire` → `ScriptToolSurface.run(name)` path (identical
shape to `/internal/triggers/fire`, same HMAC-verified-token gate, kept as its own route since a
Workflow instance is a structurally different caller population worth auditing separately later)
— so an edit to the script between schedule and fire is picked up automatically, matching the
skill library's own versioning semantics, and the Workflow's durable step gets retries (3,
exponential backoff, 10-minute step timeout) for free.

**J4 — cron reuses the EXISTING scheduler, zero new dispatch code.** `workflow.schedule(name,
cron)` just POSTs a normal row to `/spaces/:spaceId/scheduled-jobs` (`script_name: name`, no
`goal`) — the same table and the same `runScheduledJobs`/`fireScriptDirectly` dispatcher CLAUDE.md
#20/#28 already built for every other scheduled script. Nothing about the cron path changes; the
routing to a Workflow instance happens transparently one layer down, purely because of the
script's own `runtime:"workflow"` tag, at the exact moment `ScriptToolSurface.run()` resolves it.
This is the plan's "long automations no longer hold an isolate open" outcome, achieved without
touching the scheduler at all.

**J5 — new binding, new Workflow class, both narrowly scoped.** `wrangler.toml` gained a second
`[[workflows]]` entry (`ScriptRunWorkflow` / binding `AGENT_SCRIPT_WORKFLOW`), separate from
`AgentTaskWorkflow`'s `AGENT_TASK_WORKFLOW` — different payload shape (`scriptName`+`params` vs. a
full agent turn's goal/systemPrompt/tools), different purpose, so two classes rather than
overloading one. `NaelaoAgentDO.buildScriptEngineEnv` wires `env.workflowRunner` from
`this.env.AGENT_SCRIPT_WORKFLOW` when present, mirroring `codeRunner`'s wiring exactly (optional,
degrades honestly). `buildOrchestrationHooks` was restructured (it previously `return {}`ed
entirely when `NAELAO_AGENT_DO` was absent, which would have also silently dropped the workflow
hooks even though they don't need that binding) so sub-agent hooks and workflow hooks are gated
independently, and the hook set now takes the already-constructed `ScriptToolSurface` — moved one
call site later in `handleScriptRun` (from before `config`/`tools` existed to right after `tools`
is constructed; nothing in between reads `engineEnv.orchestration`, and every consumer reads it
lazily at call time inside the reasoning loop, so the reorder is behavior-preserving).

**Tests:** `tests/unit/workflow-tier-routing.test.ts` (5 — dispatches to `workflowRunner.start`
instead of `codeRunner` and returns immediately without blocking; per-tenant isolation, i.e. two
different spaces' runs pass their own space/tenant, never a shared/fixed one; honest `ok:false`
degrade with no runner wired; a runner rejection surfaces as `ok:false` rather than throwing; an
ordinary `runtime:"isolate"` script is unaffected and still reaches `codeRunner`).
`tests/unit/internal-scripts-run-durable.test.ts` (5 — the new route's HMAC auth boundary: rejects
no token, wrong secret, tenant-header/body mismatch, missing `scriptName`; accepts a valid token
and forwards to the space's agent DO). 1013/1013 tests pass (10 new). `pnpm turbo run typecheck`
clean (75 tasks).

**Deliberately NOT built this pass:** fine-grained per-statement workflow steps (a script is one
durable step, not N — decomposing a script into multiple `step.do()` calls would require a new
authoring primitive the model writes against, which nothing in this pass needed since "durable"
here means "survives restarts/retries and doesn't hold an isolate open," not "resumable mid-script");
`workflow.status`'s wiring to `AGENT_SCRIPT_WORKFLOW.get(id).status()` is implemented but not
exercised by a dedicated test (covered indirectly — the type contract is enforced by `tsc`).

### Phase K — Per-project, R2-mounted Tier-5 container (Linux persistence)

**Goal:** fix Tier 5 (spec §33b) so `python3.execute_python`/`code.execute_bash` scripts persist
files across restarts and share them across a project's threads — verified BEFORE this pass that
neither was true: `runContainer` addressed the sandbox DO per-`{space,agent}` (so two threads'
agents in the same project got DIFFERENT containers) and the harness only ever wrote/read a
`mkdtemp`+`rm` scratch dir per call (so nothing survived even a single container instance's next
request, let alone a restart).

**K1 — per-project addressing.** `code-runner.ts`'s `runContainer` now keys the sandbox DO
`sandbox:{spaceId}:{projectId ?? "_assistant"}` instead of `sandbox:{spaceId}:{agentId}` —
matching `workspacePrefix()`'s own space/project scoping exactly (`_assistant` is a fixed
per-space slot for the Space Assistant, the one case with no project). `TieredCodeRunner.run()`
gained an optional `projectId`, threaded from `execution-ladder.ts` (`env.projectId`) and from
`code-exec.ts`'s `runTier` (the `code.execute_python`/`code.execute_bash` prebuilt ops, the only
OTHER Tier-5 call site — `browser-use.ts` is Tier 4 and untouched).

**K2 — R2 sync as the "mount," since Cloudflare Containers have no native R2 filesystem mount.**
This is the honest mechanism available on this platform today: `ToolSandboxDO` now reads the
project's R2 workspace (the SAME `workspacePrefix()`-scoped bucket/prefix Tier-1 `r2-workspace`
already reads/writes) before forwarding an `/exec` call to the container harness, hands the files
over as a `workspace_files` map in the request body, and on response writes back whatever the
harness reports as `/workspace`'s final contents (`workspace_files_out`) — including deleting any
file that existed before the run but is gone afterward (the script deleted it). R2 is the
persistent source of truth: a cold-started container (post-sleep or post-restart) still sees the
same files because they're materialized fresh from R2 on every call, never relied upon to survive
in the container's own ephemeral disk. Bounded (300 files / 2MB per file / 25MB per call —
generous for a working set, not unlimited; a project that outgrows this is a Container
Marketplace-tier problem, §A1.17 Phase L, not a bigger cap here) and text-only (matches the
existing R2-workspace convention of `.text()`, not binary-safe — an honest, documented
limitation). `/build` (the legacy Whop micro-tool build/test route) is untouched — it never
touched a project workspace and still doesn't.

**K3 — the harness (`container/server.mjs`) materializes and collects `/workspace`.** New
`materializeWorkspace()`/`collectWorkspace()` write the incoming map to `/workspace/<relPath>`
before the script runs and walk it back afterward (same bounds as K2, enforced independently in
the container too so a runaway script can't OOM/hang it even if the DO's caps were somehow
bypassed) — collected on BOTH success and failure, so a multi-step script that writes files before
throwing partway through doesn't lose that work. `ctx.workspaceDir` (`/workspace`) is now passed
to `mod.run(args, ctx)` for stored Tier-5 scripts to join paths against explicitly; deliberately
NOT a global `process.chdir()` (the harness's Node process is long-lived and shared across
requests to the same warm container — a global chdir would be a real concurrency hazard for two
overlapping `/exec` calls). `code-exec.ts`'s `PYTHON_HARNESS` picked up `cwd: ctx.workspaceDir ||
"/workspace"` on its `execFileSync("python3", ...)` call to match `BASH_HARNESS`'s existing (but,
before K2, silently non-functional) `cwd: args.working_dir || "/workspace"` convention — both
prebuilt harnesses now actually land in the synced, persistent workspace they always claimed to.

**Tests:** `tests/unit/container-per-project.test.ts` (7 — new: syncs existing R2 files into the
harness request; writes `workspace_files_out` back to R2 under the project's prefix while
stripping that DO<->harness wire field from the client-facing result; deletes a file from R2 when
a script removes it; a file written by one thread's run is visible to a subsequent run in the SAME
project, proving the "shared workspace" claim; different projects' workspaces stay isolated;
falls back to the space-scoped workspace with no `projectId`; skips sync entirely with no
`SCRIPTS_R2` bound). Extended `tests/unit/code-runner.test.ts` (+3 — per-project addressing, the
`_assistant` fallback, and that `spaceId`/`projectId` are actually sent to the sandbox DO). 1023/
1023 tests pass (10 new). `pnpm turbo run typecheck` clean (75 tasks).

**Deliberately NOT built this pass:** binary file support (text-only, same limitation the
platform's Tier-1 R2 workspace already has); incremental/diff-based R2 sync (every `/exec` call
re-fetches the full bounded file set rather than caching what a warm container already has — a
real optimization opportunity, but correctness-first for a first pass); multi-container-per-project
and a container marketplace (postgres/redis/ffmpeg/etc. slots) — that's the separate, much larger
Phase L.

### Phase N — Launchpad completeness: operator-shell UI (G-4a/b), rest investigated and scoped

**Goal:** close the remaining Launchpad-specific spec gaps (G-4a through G-4e) identified when
Phase 6's manifest work first surfaced that `ui.operatorShell`/`ui.externalPortal` are fully typed
and fully populated for Launchpad but nothing renders/uses them. Investigated all five before
touching anything (per this session's standing "reuse, don't reinvent — investigate first"
practice); two were real and tractable this pass, three were investigated and are documented below
as deliberate scope decisions rather than silently dropped.

**G-4a — operator-shell UI, built as an addition to the business detail view, not a shell-hiding
takeover.** Re-confirmed the mid-Phase-6 scope correction (CLAUDE.md #30): the rich agentic shell
(chat/threads/projects) ships to every business regardless of `hiddenCoreItems`, so the
`operatorShell.sidebarItems` (Revenue/Orders/Customers/Products/Campaigns/Agents) are rendered as
an ADDITIONAL "Business Operations" section on `apps/shell`'s existing business detail page
(`.../spaces/[businessId]/page.tsx`), gated on that business's own `shell/manifest` actually
advertising a `"revenue"` sidebar item (so a future non-commerce SpaceType's business shows
nothing extra). Built Revenue (the existing month-to-date gross/fee/net rollup), Products (list +
create + publish/unpublish/archive toggle, member can view, admin+ can mutate), and Orders
(read-only list) — all wired to the ALREADY-BUILT `launchpad_products`/`launchpad_orders` commerce
backend (`loadCommerceContext`, A1.9) with zero backend logic changes beyond authorization (below).
"Customers" and "Campaigns" sidebar items have no backing data model anywhere in the platform
(commerce's schema is products+orders+business_services only) — deliberately NOT stubbed with fake
data (matches this session's own "credits_consumed: null, flagged rather than fabricated"
precedent from Phase 3); "Agents" is already covered by the shell's existing Agents view from
Phase C, so it needed no new UI. New `apps/shell/src/lib/api.ts` functions:
`listBusinessProducts/createBusinessProduct/updateBusinessProduct/listBusinessOrders/
getBusinessRevenue`.

**Authorization for the new routes** follows the Phase E pricing-route precedent exactly:
`/spaces/:spaceId/products(/:id)?`, `/orders`, `/revenue` gained `requireBusinessMembership({GET:
"member"})` on the spaces worker (mutations fall through to the default "admin" floor) and were
added to the router's `PRODUCT_END_USER_PATH_PATTERNS` allowlist — identity-only at the router,
real per-business authorization via `resolveEndUserBusinessRole` at the spaces worker, same split
every other entry in that allowlist documents. `loadCommerceContext`'s own tenant-scoped ownership
check is untouched and still what every builder-role caller relies on.

**G-4b — manifest `deploymentType` typo fixed.** `launchpad-manifest.ts`'s `externalPortal.
deploymentType` said `"dynamic-worker"`, a leftover from the framing A1.9 explicitly corrected
("Storefront = one multitenant surface, not a Worker-per-tenant... a CF Pages static shell fronted
by the portal Worker as fallback origin"). Now `"cf-pages"`, matching the settled, BUILT
architecture (CLAUDE.md #16) — this is metadata only (nothing currently branches on this field's
value), so the fix is a pure correctness cleanup, not a behavior change.

**G-4c — Autopilot CRM/analytics: verified complete, no new work needed.** The plan predicted this
would "become end-to-end once the Whop MCP is live (Phase I + F)." Both landed in this session
(Phase F: Whop live/coming-soon rollout; Phase I: `ctx.mcp` + the fulfillment agent's rewritten
system prompt onto `mcp-connector`/`ctx.mcp` language, from item 28/CLAUDE.md). Nothing left to
build — the prediction was correct and is now simply true.

**G-4d — legacy `workers/agents/src/launchpad/manifest.ts` + `whop/*` + `BusinessDO` retirement:
investigated, explicitly DEFERRED, not attempted.** Traced actual usage before deciding: `BusinessDO`
and the `whop/*` subsystem are still live, tested code paths — exported from `workers/agents/src/
index.ts`, backing ~50+ passing tests across `whop-tool-lifecycle`, `whop-catalog-access`,
`whop-onboarding-guard`, `whop-skills`, `connector-whop-shim`, `integration/whop-end-to-end`, and
more. This is NOT dead code masquerading as legacy — it is a parallel, still-exercised runtime.
Decomposing it (agent loop → `NaelaoAgentDO`, structure → `SpaceDO`, script engine → the reusable
behavior module, per CLAUDE.md's standing direction) is a genuine multi-file, cross-cutting
migration that would need to preserve or intentionally retire each of those ~50 tests one at a
time — the "cleanup" framing in the original plan undersold this as a small pass; it is not one.
Attempting it inside Phase N would have risked a rushed, partially-verified rewrite of a whole
subsystem for a phase framed as "completeness polish." Left for its own dedicated pass, exactly
like Phase L/M's own explicit "large, later" framing in this roadmap.

**G-4e — team-collaborator listing + Product Shell completeness: verified already done.**
Re-checked against the actual state after Phases A-C: `space_members` listing exists (the
credential-hierarchy and `GET/DELETE /spaces/:id/members*` work predates this roadmap), and the
end-user Product Shell (threads, sub-spaces via businesses, knowledge base) is what Phases A-C
built in full. The plan's own wording ("largely Phases A-C") already anticipated this — confirmed
here rather than re-built.

**Tests:** `tests/unit/business-commerce-membership.test.ts` (4 — new: a product_end_user can view
products/orders/revenue as a business member; can create but not publish a product (admin floor);
a builder role is unaffected; a non-member of a business is rejected entirely). Extended
`tests/unit/router-product-end-user-auth.test.ts` (+1 — the three new paths are allowlisted).
1028/1028 tests pass (5 new). `pnpm turbo run typecheck` clean (75 tasks); `apps/shell` verified
via `next build` (compiles, all routes generate including the extended business detail page).

**Deliberately NOT built this pass:** Customers/Campaigns operator-shell views (no backing data
model — see G-4a); G-4d's legacy retirement (see above, its own dedicated pass); a Customers/
Campaigns data model itself (out of scope — nothing in the spec's gap list calls for one beyond
the sidebar label, and inventing one would be scope creep beyond "render what already exists").

### Phase L — Container Marketplace: the slot-lifecycle MECHANISM is BUILT; the catalogue ships
### with zero live images (a deliberate, documented scope line, not a shortfall)

**Goal (spec §33b "Container System", gap G-1):** implement the marketplace a project can add
DEDICATED containers to, beyond the one base Tier-5 sandbox every project already gets (Phase K).
The plan's own words called this "infra-heavy; sequence incrementally: one image type end-to-end
first, then the catalogue" — this pass builds the "then the catalogue" half for real (data model,
routing, limits, honest failure) and explicitly defers "one image end-to-end" rather than rushing
a technically shaky first image just to have one.

**Why no image shipped `available:true` this pass (read before adding one).** The base Tier-5
sandbox's persistence (Phase K) is a per-`/exec`-call R2 TEXT sync — it round-trips small
script/data files, not a live server's on-disk state. The marketplace's actual differentiating use
case is a LONG-RUNNING STATEFUL SERVER (postgres, redis) that must survive container restarts —
which needs a real persistence design (e.g., snapshot-on-write + restore-on-cold-start, not a
per-call full-bucket sync) that is itself a dedicated undertaking per image, not a mechanical
extension of Phase K's approach. A one-shot CLI tool (ffmpeg, blender-cli) doesn't actually need a
SEPARATE container at all — it fits the existing base sandbox (add the apt package, call it via
the already-working `code.execute_bash` op) — so it would have been a hollow "proof" of the
marketplace mechanism specifically. Shipping a fabricated "postgres works" implementation without
solving persistence honestly would have violated this session's own standing bar (no claiming
something works when it's unverified) worse than shipping the mechanism alone and saying so.

**L1 — the catalogue (`workers/agents/src/script-engine/container-catalogue.ts`).** Naelao-authored
DATA, the same "Whop first, everything else coming_soon" precedent as `connectors/catalogue.ts` and
`LAUNCHPAD_TEMPLATES`: 7 curated images (postgres-16, redis-7, chrome-headless, ffmpeg, blender-cli,
pytorch-gpu, r-statistical), each declaring `exposed_ops`, `persisted_paths`, `network_policy`,
`billing_tier`, and `available` — every entry ships `available: false` (see above). New
`GET /container-images` on the agents worker mirrors `GET /templates` exactly.

**L2 — slot registry (`container_slots`, SpaceDO migration v20).** One row per requested slot
(`project_id`, `image_id`, `slot_name`, `status`). SpaceDO is dumb CRUD + a hard 10-slot-per-project
ceiling (defense in depth, same precedent as `reserved-capabilities.ts`); the spaces worker owns
the real business rules: `GET/POST /spaces/:spaceId/projects/:projectId/container-slots` (+
`DELETE .../:slotId`) validates `image_id` against the REAL catalogue (`loadContainerCatalogue()`,
KV-cached 1h, mirrors `loadTemplateCatalog`) — 404 for an unknown image, 409 `not_available` for a
real-but-`coming_soon` one — and enforces a new `productConfig.containerMarketplace.
maxSlotsPerProject` (default 0 — a product must opt IN once it has a reason to). Builder/
operator-only for now (`requireInternalHmac`, same floor as project rules/spend) — no router
allowlist entry, since there is nothing a business owner's day-to-day chat could usefully do with
an all-`coming_soon` catalogue; revisit end-user exposure once a real image ships.

**L3 — the routing hook, wired ahead of any image (`ScriptMetadata.container_image`).** A
`requires_tier: 5` script may now carry a `container_image` tag; `execution-ladder.ts` forwards it
to `codeRunner.run()`, and `code-runner.ts`'s `runContainer` checks a NEW `CodeRunnerOptions.
containerImages: Record<string, DurableObjectNamespace>` map — if the named image has a bound
namespace, it addresses that image's own DO (`slot:{image}:{space}:{project ?? "_assistant"}`,
same addressing convention as Phase K's base sandbox) instead of the shared `ToolSandboxDO`; if
not, it fails closed with a clear message rather than silently falling back to the base sandbox
(which would run the script against the WRONG compute — e.g. a `postgres.query` script executing
in a plain Python/Bash container with no postgres binary at all). This is the extension point
whichever image lands first will plug into: add its Dockerfile + DO class + `[[containers]]`
binding, wire the binding into `containerImages`, flip its catalogue `available` to `true` — no
other code changes needed.

**Tests:** `tests/unit/container-marketplace-slots.test.ts` (7 — catalogue endpoint shape;
slot creation rejects an unknown image (404) and a real-but-unavailable one (409 `not_available`);
create/list/delete a slot for an available image; the product's configured slot limit is
enforced; a product with no override allows zero slots; the `requireInternalHmac` floor rejects an
unauthenticated request). Extended `tests/unit/code-runner.test.ts` (+2 — `container_image`
routing fails closed with no binding wired, WITHOUT touching the base sandbox; routes to the
image's own binding, not `ToolSandboxDO`, when one IS wired). 1037/1037 tests pass (9 new).
`pnpm turbo run typecheck` clean (75 tasks).

**Deliberately NOT built this pass:** any specific image's Dockerfile/DO/persistence/wrangler
binding (see the "why" note above — the very next incremental step, not silently dropped); a
Container Manager UI (there is nothing real to click yet — an all-disabled marketplace page would
be worse UX than no page; build it alongside the first live image); per-slot billing/metering
(meaningless with zero running slots — the `billing_tier` field on each catalogue entry is the
placeholder this will read from). Phase M (local-machine-as-container + Cowork Desktop) remains
the one open item in this roadmap, and needs a native client app outside this repo before its
server-side half has anything to talk to.

### Phase M — Local-machine-as-container (spec gap G-3) is BUILT end-to-end, including a real
### reference client. Scoped to exactly "local machine as a Tier 5c target" per user direction —
### the "Cowork Desktop" cloud-container profile named alongside it in the original roadmap sketch
### was explicitly excluded ("cowork is an example of what it's like to have an agent access your
### PC", not a feature to build) and is NOT part of this pass.

**Goal:** let a builder opt their OWN machine in as a grant-checked execution target — the agent
can read/write files or run an allowlisted command on real hardware Naelao doesn't own, with every
request checked against an explicit, revocable grant BEFORE it ever reaches that machine. Unlike
Phase L (where the mechanism shipped ahead of any real image), this phase ships completely real:
the permission model, the tunnel, the prebuilt, AND a working reference client — there is no
"coming soon" flag here, someone can run this today.

**M1 — the permission model (`local_grants`, SpaceDO migration v21).** A grant is
`{ user_id, grant_type: read|write|readwrite|exec, directory?, commands? }`, optionally
`project_id`-scoped (null = space-wide, usable by the Space Assistant). No grant exists by
default. `user_id` is NEVER a client-supplied field — `POST /spaces/:spaceId/local-grants`
(spaces worker, `requireInternalHmac`, builder-only) always derives it from the verified caller's
own identity, so a builder can only grant access to their OWN machine, never name someone else's
(tested explicitly). Business-rule validation (grant shape, directory-required vs
commands-required) lives in the worker; SpaceDO is dumb CRUD plus an independent 25-grant hard
ceiling per space (defense in depth, same precedent as Phase L's slot ceiling).

**M2 — the connect token.** `POST /spaces/:spaceId/local-tunnel/connect-token` mints a
short-lived (5 minute) HMAC token scoped to exactly `(spaceId, callerUserId)`. New
`mintLocalTunnelToken`/`verifyLocalTunnelToken` (`packages/http`) use a DELIBERATELY separate HMAC
payload namespace (`"local-tunnel:"`) from `mintInternalToken`/`verifyInternalToken`'s
(`"internal:"`) — a worker-to-worker token can never be replayed as a tunnel-connect credential
and vice versa, even though both are signed with the same `PLATFORM_SECRET` (tested explicitly, in
both directions). 5 minutes (not the internal token's 60 seconds) because a human has to copy the
token into a CLI invocation rather than it being minted and consumed within the same request.

**M3 — `LocalTunnelDO` (agents worker, new `LOCAL_TUNNEL` binding, migration v7).** One instance
per `(spaceId, userId)`, using the CF Hibernation API (`ctx.acceptWebSocket`) — the exact same
pattern `workers/ws-gateway`'s `WsHubDO` already established, so the DO can sleep between requests.
`GET /local-tunnel/connect?space=&user=&token=` (agents worker, deliberately unauthenticated at the
Hono layer — the caller is a native client on someone's own machine, not a browser session with a
JWT to check; `verifyLocalTunnelToken` inside the DO is the actual gate) upgrades to a WebSocket.
`POST /exec` on the DO correlates a request to its eventual WS response via an in-memory pending
map with a 30-second timeout; a clean disconnect resolves any still-pending calls immediately with
an honest "the Local Agent disconnected" rather than making the caller wait out the full timeout.
This DO's own test coverage is bounded exactly where `WsHubDO`'s already is: the test harness stubs
`cloudflare:workers` for plain-Node vitest and explicitly does not instantiate DOs that touch
`WebSocketPair`/`ctx.acceptWebSocket` (real CF runtime primitives with no Node polyfill in this
suite) — verified by typecheck + code review, matching the codebase's own established boundary for
CF-native primitives, not a gap unique to this phase.

**M4 — the `local-machine` prebuilt (`local.read_file`/`write_file`/`exec`/`status`), the actual
safety layer.** Grant-checks BEFORE ever touching `env.localTunnel`: loads the space's active
grants (spaces worker), normalizes the requested path (collapses `.`/`..` segments server-side so
traversal can't bypass a directory check), and requires TRUE path-segment containment — not a
naive string prefix, which `/home/alice/allowed-evil` would incorrectly satisfy against a grant
for `/home/alice/allowed` (tested explicitly). `exec` requires an EXACT command match against the
grant's allowlist, not a prefix, so `npm test && rm -rf /` cannot ride in under an allowed
`npm test` (tested explicitly). The MATCHING grant's own `user_id` addresses which tunnel to use —
there is no separate "which machine" parameter for a script to get wrong or spoof. A
project-scoped grant never applies to a different project's run (tested); a space-wide grant
(`project_id` null) applies to any run including the Space Assistant's. A denied request never
reaches `LocalTunnelDO` at all (asserted in every denial test). `env.localTunnel` (new
`ScriptEngineEnv` field, `LocalTunnelGateway`) is wired in `NaelaoAgentDO.buildScriptEngineEnv`
exactly like `lockGateway`/`hitlGateway` — a thin per-call DO-stub resolver, addressed
`local-tunnel:{spaceId}:{userId}`.

**M5 — the Naelao Local Agent reference client** (`workers/agents/local-agent/
naelao-local-agent.mjs` + README) — the piece every prior phase in this platform has deferred as
"needs a native client app outside this repo." This ships one INSIDE the repo instead: a small,
dependency-free Node 22+ script (global `WebSocket`, no npm deps) that connects to
`/local-tunnel/connect`, relays `read_file`/`write_file`/`exec` requests to the real filesystem/
shell, and replies over the same socket. Optional `--allow-dir`/`--allow-command` flags are a
SECOND, independent check that runs on the machine itself — defaults to trusting the server's
already-passed grant check, but lets a cautious operator narrow what one particular client run
will do even if the space's grants are broader. On any disconnect the client exits rather than
silently retrying with what is likely a now-expired 5-minute token — it must be re-launched with a
freshly minted one, matching the "revoke takes effect on the next request" model M1 established.
Its pure logic (`normalizePath`, `isWithinAny`, `isAllowedCommand`, `handleRequest`) is unit
tested directly, including a real temp-directory read/write round trip and a real `exec` call —
this is graded as "actually works," not just "typechecks."

**Tests:** `tests/unit/local-tunnel-token.test.ts` (7 — mint/verify round trip, cross-space and
cross-user rejection, wrong secret, missing token, expiry, and the internal-token/tunnel-token
cross-family replay rejection). `tests/unit/local-grants.test.ts` (9 — grant-shape validation,
user_id always from caller identity never the request body, CRUD, the 25-grant ceiling, the
`requireInternalHmac` floor, connect-token mint + verify). `tests/unit/local-machine-prebuilt.test.ts`
(14 — every grant-type combination, path-prefix vs true-containment, `..` traversal, exact-match
exec, project-scoping both ways, fail-closed with no tunnel wired, a tunnel-reported error
surfaced honestly, status reporting). `tests/unit/local-agent-client.test.ts` (9 — the CLI-entry
guard, the pure helpers, and a real filesystem/exec round trip). 1076/1076 tests pass (39 new),
`pnpm turbo run typecheck` clean (75 tasks).

**Deliberately NOT built this pass (per explicit user direction, not a shortfall):** the "Cowork
Desktop" cloud-container profile (`cowork-desktop` `AgentConfig`/`ubuntu-desktop` image) named
alongside Phase M in the original roadmap sketch — the user clarified Cowork was only an
illustrative example of "what it's like to have an agent access your PC," not a feature request.
Also not built: a shell/dashboard UI for managing grants (today it's API-only, like several other
phases before their UI pass); the client reconnecting automatically with a refreshed token (it
exits and must be re-launched — an automatic refresh would need a way to mint a new token without
another API call the client isn't authenticated to make, a real design question left open); a
non-Node reference client (the protocol is documented in the README specifically so this is
portable). With Phase M done, every phase in the full-vision roadmap (A through N, plus L and M)
is now built.

## §A1.18 — Second full-vision pass: Phases O-V (agent identity, events, connectors, durable
## runs, workspace model, collaboration, real-time sync)

A new user-directed batch layered on top of A-N/L/M, not a correction of it. CLAUDE.md's numbered
CURRENT DIRECTION list (item 38) carries the authoritative, kept-current summary of what's built
in each phase — this section is a pointer, not a duplicate, to avoid the two drifting apart.
Read CLAUDE.md item 38 first for the phase-by-phase detail (what shipped, what bugs were found
and fixed along the way, test counts); come here only for anything CLAUDE.md's summary doesn't
have room for.

**Phases O, Q, R, S, T, U, V are all BUILT. Only P remains.** CLAUDE.md item 38 carries the
authoritative, kept-current phase-by-phase summary (what shipped, real bugs found and fixed along
the way, test counts) — this section only records what didn't fit there.

- **T2's real architectural prerequisite, resolved:** the shell's chat call path
  (`/spaces/:spaceId/sessions/:sessionId/agent/run`) had no concept of "which named agent" — it
  always addressed ONE DO instance per bare `sessionId`. Fixed at the source rather than adding a
  parallel endpoint: `/agent/run` now addresses `{sessionId}:{agentDefinitionId}` whenever an
  explicit `agent_definition_id` is given (unchanged, bare-`sessionId` addressing when it's
  absent — every existing single-agent session is unaffected). The new `/agent/mention-run`
  endpoint is a thin dispatcher on top of this, not a second reasoning path.
- **T3 scope note:** the soft/implicit lock-wrapping-every-R2-write idea from the original sketch
  (`project:{id}:file:{path}` around every Tier-1 `r2-workspace` write) was NOT built — soft
  locking stays exactly what the existing `lock` prebuilt already offers, opt-in per script.
  Wrapping ALL R2 writes automatically would be a real behavior change to a heavily-used prebuilt
  outside this pass's scope; flagged as a possible follow-up, not silently added.
- **V scope note:** agent-run-lifecycle and `approval.resolved` broadcasts were NOT wired — the
  former needs a broader pass through `NaelaoAgentDO`'s run lifecycle hooks, the latter needs
  `HITLApprovalDO` to carry `space_id` in its own rows (today it's only addressed by `spaceId`,
  never stores it). A frontend WS client (`apps/shell`/`apps/dashboard` subscribing per-space via
  a short-lived signed WS-URL param, the same browser constraint Phase 6's SSE stream already
  solved) was also not built — the backend fan-out (`broadcastSpaceEvent`, wired into project
  create/update, the exclusive-mode lock transition, presence heartbeats, and
  `approval.requested`) is real and tested; a live UI consumer is the next increment.
- **P — Composio + Pipedream connector providers — the one remaining phase.** Extend whatever
  table backs registered MCP servers in `workers/mcp-hub` with
  `connector_provider: 'direct'|'composio'|'pipedream'`; a Composio/Pipedream-backed connector
  stores only that provider's own opaque connection reference (never the underlying OAuth token)
  and routes `ctx.mcp.call`/`mcp-connector` calls through the provider's execute-action API
  server-side — the script-native "6 ops only" contract (CLAUDE.md ground rule #8) is unchanged;
  this is more connector inventory behind the same surface, never a new agent capability class.
  Needs real `COMPOSIO_API_KEY`/`PIPEDREAM_API_KEY` (or Pipedream Connect client credentials)
  supplied via CF Workers Secrets before it can run against live providers — the routing logic
  itself can be built and tested with mocked provider APIs regardless.

## A1.19 Growth Layer (spec Appendix BF) — Phase 1: platform provider keys + free-tier gating — BUILT

The canonical spec gained **Appendix BF — Growth Layer** (G-BF01..G-BF20, appended at the end of
`naelao_expanded_gaps_resolved.html` per its running-log convention; `docs/SPEC_HEADER_INDEX.md`
regenerated). It codifies the **universal-tools doctrine** (G-BF01, generalizing the web-search
fix): a universal capability is PLATFORM-KEYED — Naelao holds ONE provider key as a Workers
Secret, users never see or enter it (the Claude/ChatGPT bundled-connector model); BYO credentials
are reserved for a builder's OWN external accounts. It also specs business idea discovery
(App Store trends + Starter Story case studies as seeded skills), the free-plan simple-business
program (flagship `freelance-web-studio` with compliant multi-channel cold outreach — email-first
with opt-out + click-to-WhatsApp so the PROSPECT initiates the WhatsApp conversation, HITL-approved
batches, hard daily caps, STOP honored; never cold WhatsApp blasts, which violate Meta policy), the
Business Network (default-on anonymized sharing for free/growth, private-as-paid, PII/credentials/
exact figures NEVER shared regardless of plan), and a deferred private-playbook bidding exchange.

**Phase 1 code (this pass):**

- **G-BF02 — platform Composio/Pipedream keys in mcp-hub.** `COMPOSIO_API_KEY`/`PIPEDREAM_API_KEY`
  optional Workers Secrets; new `resolveProviderApiKey` — a BYO vault credential (`auth_secret_name`)
  still WINS when present (a builder running their own provider project keeps control + their own
  billing); otherwise the platform key is injected server-side and never leaves the worker; neither
  → honest 503 `provider_not_configured`. A BYO declaration that resolves to no key errors clearly
  (400) instead of silently falling back — fallback would mask the misconfiguration and bill
  Naelao's provider account. Applied to both provider branches (tools-list + tool-call); the
  reserved money-in tool-name guard covers platform-keyed calls identically. This closes §A1.18
  Phase P: the routing existed; the key model was the missing piece. Still needed for live use:
  `wrangler secret put COMPOSIO_API_KEY` per environment (degrades honestly until set); the
  per-user OAuth connect flow (G-BF03) and the curated universal catalogue entries (G-BF04) are
  the next increments.
- **G-BF08 — `free_tier_eligible` enforcement.** The flag existed since Phase F, was projected to
  the dashboard, and was never checked anywhere. New `workers/spaces/src/template-catalog.ts`
  (loadTemplateCatalog extracted from index.ts — preserving business-create.ts/create-space.ts's
  one-way import rule — with `free_tier_eligible` added to the projection and the KV cache key
  bumped to v2), plus `resolveOrgPlanTier` (unknown org → "free", fails CLOSED) and
  `checkFreeTierTemplateEligibility`. Gated at BOTH template entry points: `createBusinessForEndUser`
  (product businesses + reseller spaces — the plan checked is the OWNING builder org's, checked
  before any side effect) and `createSpaceRecord` (POST /spaces + /builder/products). Deliberate
  asymmetry, documented in code: the TIER lookup fails closed, but a genuinely UNAVAILABLE
  catalogue degrades OPEN — this is a monetization gate, not a security boundary, and failing
  closed would 403 every free-plan creation during an agents-worker outage (and break every
  dev/test env without the binding). `shell/manifest.template_catalog` now carries the flag for
  the create-business dialog.

29 new tests across `mcp-hub-platform-provider-keys.test.ts` and
`free-tier-template-gating.test.ts` (+1 shell-manifest assertion updated for the new field).
1646/1646 tests pass; `pnpm turbo run typecheck` clean (75 tasks).

**Deferred to later sessions (spec'd in Appendix BF, not built):** G-BF03 OAuth connect flow,
G-BF04 universal connector catalogue + assistant advertisement, BF.2 discovery skills, BF.3
flagship template/sample hosting/outreach agents (G-BF10..14), BF.4 Business Network
(G-BF15..19), G-BF20 exchange.

## A1.20 F-36 enforcement — the assistant per-user permission clamp is now actually consulted at runtime — BUILT

**The gap (audit finding, HIGH):** SpaceDO has carried the complete F-36 model since the audit
pass that introduced it — `project_members.assistant_mode` (`inherit`/`read_only`/`none`),
`resolveAssistantEffectiveRole(projectId, userId)` (never more than the user's own project role),
and `GET /spaces/:spaceId/projects/:projectId/assistant-access?user_id=U` — but a grep for any of
those names across `workers/agents` returned **zero matches**. The clamp was decorative: an
assistant acting on behalf of a `read_only`- or even `none`-clamped user ran with full
space-scoped authority. Same story for the approval policy: `fetchAssistantPolicy` is space-wide,
so an owner flipping the space to `yolo` granted un-gated autonomy to runs made on behalf of ANY
caller (a viewer, a product end user).

**What was wired (no redesign of the clamp itself — SpaceDO stays the single definition):**

- **Entry gate** (`NaelaoAgentDO.handleScriptRun`): a project-scoped run that acts on behalf of a
  user (non-empty `userId`, excluding the channel drain's synthetic `channel:...` ids, which never
  route through here anyway) resolves the clamp via a new `fetchAssistantAccess` (internal HMAC
  call to the existing spaces-worker endpoint) BEFORE any billing gate. `null` effective role
  (`assistant_mode='none'`, or a plain non-member) → 403 `assistant_access_denied`; lookup error →
  403 `assistant_access_unverified` (fail CLOSED — the fetchProjectConfig/F17 posture: an
  authorization check that fails open isn't one). No acting user (cron/trigger/webhook/bootstrap
  wakes) → no clamp, the assistant's own base grant, exactly as the clamp's SpaceDO doc always
  specified.
- **Read-only enforcement** (`ScriptEngineEnv.effectiveRole` + `ScriptToolSurface`, the `maxTier`
  structural precedent): `"viewer"` (which is also what `read_only` maps to server-side, even for
  a project owner) refuses `script.create/update/delete`, every STORED script (arbitrary
  agent-authored code is assumed mutating — fail closed), and any prebuilt op not on the explicit
  read-safe allowlist in the new `script-engine/assistant-access.ts` (`READ_SAFE_PREBUILT_OPS` —
  small and explicit like wallet.ts's credential-name list; a new prebuilt op is write-gated until
  consciously classified). `script.read`/`script.find` and read ops (read_file, knowledge.search,
  wallet.balance, project.list, ...) still work.
- **Approval-policy intersection** (`resolveAssistantApprovalPlan`, pure + unit-tested): `yolo`
  now fully applies only for system wakes (no `x-naelao-role` — the autonomous operation the owner
  configured it for) and owner/admin callers (who could self-authorize any gated action anyway);
  every other verified caller role — editor/viewer builders, `product_end_user`, `agent` API keys,
  and unrecognized roles (fail closed) — downgrades to the always_ask posture
  (`gate_unless_listed` + the policy's own `auto_approved_actions`).
- **Two escape hatches closed while wiring:** (1) `POST /agents/:agentId/script/run` (the worker's
  script-first entrypoint, whose own doc says "owner-initiated calls arrive with the usual
  JWT-derived headers") silently DROPPED `x-naelao-user-id`/`x-naelao-role` when forwarding to the
  DO — so not just the clamp but also handleScriptRun's per-caller billing branches could never
  apply to runs entering there; both headers are now forwarded (the route already requires the
  internal token, so they're router-verified). (2) sub-agent spawns carried `projectId` but not
  `userId` — a clamped parent could have laundered work through `agent.spawn` into an unclamped
  child; the parent's acting user is now threaded through `buildOrchestrationHooks` →
  `spawnSubAgentBatch` so the child re-resolves the same clamp.

**Known bounded scope (documented, not silently dropped):** a NON-project Space Assistant run can
still touch projects mid-run via prebuilt ops (`project.configure` etc.) without a per-project
clamp lookup — per-op project clamping inside prebuilts is a deeper pass; the mitigation today is
the policy intersection above (those actions are HITL-gated for any caller who couldn't
self-authorize them). The legacy ReAct path (`/run`) has no project/tool-surface concept and is
out of F-36's scope.

New `tests/unit/assistant-permission-clamp.test.ts` (14 tests): none/error/no-user/channel-id/
viewer entry-gate cases against a real `NaelaoAgentDO` instance (sqlite-shim harness), the
read-only surface (reads pass, writes refuse, stored scripts refuse, even-owner read_only case),
allowlist hygiene, and the yolo-intersection matrix. 1707/1707 tests pass; `pnpm turbo run
typecheck` clean (75 tasks).

## A1.21 S-2 — the product-root wallet was end-user "member"-readable — BUILT

**The gap (audit finding, HIGH):** every space, INCLUDING the product root, is seeded a
`kind='wallet'` project by the provisioner (`seedWallet`) — the ROOT one is the BUILDER's own
platform-cost ledger, not a business's money. `requireBusinessMembership`'s generic rule (a
verified product session for the product ROOT space implies `"member"` — correct and safe for
sessions/projects/threads, resources an end user legitimately reaches on the product root) was
also applied, unexamined, to the wallet read routes. Leak path: `GET /spaces/:spaceId/projects`
is member-readable, so an end user could enumerate the root wallet project's id, then
`GET .../wallet/balance` / `.../wallet/history` (gated only at `member`) disclosed the builder's
full ledger — reasons and amounts — to any signed-up end user of the product.

**Fix — a wallet-specific role resolver, not a change to the generic one:** the generic
`resolveEndUserBusinessRole`'s root-is-`"member"` shortcut stays untouched (sessions, projects,
threads all still need it). New `resolveWalletAccessRole` (`business-auth.ts`) instead: for a
space with no `parent_space_id` (the product root), returns `null` — no product_end_user has any
legitimate wallet access there, full stop; for a business (child) space, delegates to the same
real `business_memberships` lookup as everything else, so a business owner/admin still reads
their OWN business's wallet exactly as before. Wrapped in a new
`requireBusinessMembershipForWallet` middleware (its own 5s-TTL cache, kept separate from the
generic role cache so the two resolvers' answers for the same `(spaceId, endUserId)` key can never
cross-contaminate) — applied in place of `requireBusinessMembership` on all three end-user-reachable
wallet read routes: `GET .../projects/:projectId/wallet/{balance,history}` and the consolidated
`GET /spaces/:spaceId/wallet`. Every non-`product_end_user` caller (builder JWT roles) is
unaffected, per the file's existing additive-only convention.

New `tests/unit/wallet-root-access.test.ts` (5 tests, real `spacesWorker` + real `SpaceDO` +
fake D1, mirroring `business-auth.test.ts`'s harness): a product_end_user is refused (403) on
both the per-project wallet routes AND the consolidated `/wallet` view for the PRODUCT ROOT; the
builder still reads it (200, correct balance); a business owner still reads their OWN business's
wallet (200); a different end user with no membership on that business still gets 403. 1712/1712
tests pass (5 new); `pnpm turbo run typecheck` clean (75 tasks).

## A1.22 channel replay hardening: freshness window on email/discord/whatsapp + skip drain on dup — BUILT

**The gap:** Slack's webhook verifier (`channels.ts`) already rejects requests older than 300s
(replay defense-in-depth on top of the primary control — the `(session, direction, external_id)`
unique-index dedupe in `channel_messages`, `NaelaoAgentDO.ts` — and per-space secret scoping,
which blocks cross-business replay). Email, Discord, and WhatsApp had no freshness check at all:
a captured, validly-signed webhook for any of these three channels could be replayed indefinitely
and would still verify.

**Fix — freshness window, matching Slack's:**
- **Email** (Mailgun-style): `x-mailgun-timestamp` now rejected if more than 300s from now, same
  spot as the existing HMAC check.
- **Discord**: `x-signature-timestamp` (already read for the Ed25519 message, now also checked
  for staleness) rejected past 300s.
- **WhatsApp**: Meta's Cloud API sends no request-level timestamp header — the only timestamp is
  inside the message payload itself (`entry[0].changes[0].value.messages[0].timestamp`, epoch
  seconds). New `extractWhatsAppMessageTimestamp` pulls it from the raw body; since
  `X-Hub-Signature-256` signs the WHOLE raw body, that embedded timestamp is exactly as trustworthy
  as a header would be — an attacker can't advance it without the app secret invalidating the HMAC.
  A status-callback payload (delivery/read receipts — no `messages` array) has nothing to
  freshness-check and is deliberately left to validate on signature alone, unchanged from before.

**Fix — skip the redundant drain on a deduped delivery:** `handleChannelInbound`
(`NaelaoAgentDO.ts`) unconditionally kicked an immediate `handleChannelHeartbeat` drain
(`ctx.waitUntil`) after every inbound webhook, even when the `INSERT OR IGNORE` into
`channel_messages` hit the existing unique index and inserted nothing (a duplicate/replayed
`external_id`). `SqlStorageCursor.rowsWritten` (real DO SQLite property; the shared
`tests/unit/helpers/sqlite-do-shim.ts` now returns it too, sourced from `node:sqlite`'s own
`.run().changes`) tells us whether the row was actually new — `rowsWritten === 0` means "already
handled," so the drain kick is skipped entirely. The response now also reports
`duplicate: boolean` so a caller (or test) can observe which branch it took.

New tests: `tests/unit/launchpad-channels.test.ts` gained stale-timestamp rejection cases for
email/Discord/WhatsApp (mirroring the pre-existing Slack one) plus a WhatsApp status-callback
freshness-exemption case — and two PRE-EXISTING "valid signature" assertions in that file were
using a hardcoded year-2023 timestamp (`"1700000000"`) that this change would have turned into a
false rejection; updated to a live timestamp so they still test what they claim to (signature
validity, not incidentally-current freshness). New
`tests/unit/channel-replay-dedup-drain.test.ts` (3 tests): first delivery inserts + drains;
re-delivery of the same `external_id` is deduped AND kicks no second drain (`waitUntil` promise
count stays at 1); a genuinely different `external_id` from the same sender still gets its own
drain. 1719/1719 tests pass (7 new), `pnpm turbo run typecheck` clean (75 tasks).

## A1.23 createProject feature-kind gate: fail closed on missing created_by (defense in depth) — BUILT

**The gap:** `SpaceDO.createProject`'s role check for a feature-kind project (`kind='wallet'`,
`'storefront'`, etc. — `packages/events/src/business-feature-kinds.ts`, `minCreationRole`) was
SKIPPED entirely whenever `body.created_by` was empty, treating a missing creator as privileged
`'owner'`. Not exploitable today — the only real caller, `workers/spaces/src/index.ts`'s
`POST /spaces/:spaceId/projects`, always derives `created_by` from the verified caller identity
(`x-naelao-user-id`, set by the router only after JWT/session validation, never client-suppliable)
— but the DO itself had no opinion of its own: any FUTURE route that forwarded a client body into
`createProject` without remembering to force `created_by` would have instantly and silently
inherited owner-level privilege, an easy-to-introduce, hard-to-notice regression.

**Fix — invert the default to fail closed.** A missing `created_by` now DENIES creation of any
`BUSINESS_FEATURE_KIND` project outright (403 `forbidden`) unless the request also carries
`system_caller: true` — a new field on the `createProject` body, checked ONLY when `created_by` is
absent; once `created_by` IS present, the ordinary space-member role lookup runs exactly as before
and `system_caller` has no effect (verified by a dedicated test — it must never become a blanket
override). Structural kinds (`workspace`, `customer_bot`) are untouched; they never entered this
role-gated branch in the first place.

**Where `system_caller` comes from:** `system_caller` is never read from a client-supplied JSON
field — `index.ts`'s `POST /spaces/:spaceId/projects` handler computes it itself as
`!identity.userId` (the verified absence of an authenticated caller) and places it in the object
literal AFTER the `...body` spread, so any value a caller tried to smuggle into their own request
body is unconditionally overwritten by the server-derived one. `requireInternalHmac` already gates
this entire route (only the router, which always sets `x-naelao-user-id` for a real session, or a
genuine internal caller like the provisioner, which never does, can reach it at all), so the
combination of "passed the internal-HMAC gate" + "no verified user identity" is the same signal
already used to compute `created_by` — just made an explicit, dedicated field instead of an
implicit by-omission one. The provisioner's `seedWallet` step needed no code changes at all: it
already calls this exact route with no `x-naelao-user-id` header (by design — it has no human
caller), so `index.ts` derives `system_caller: true` for it automatically.

New tests in `tests/unit/business-feature-kinds.test.ts` (5 added), talking to a bare `SpaceDO`
instance directly (bypassing `index.ts` entirely, to prove the DO's OWN posture rather than just
the router's): `kind='wallet'` with no `created_by` and no `system_caller` → 403; the same with
`system_caller: true` → 201 (the provisioner's shape); a resolvable-but-insufficient `created_by`
(a `viewer`) is still rejected even when `system_caller: true` is also (wrongly) present, proving
it's not a blanket override; a structural `kind` (default `workspace`) needs neither field; and
`seedWallet` run end-to-end through the REAL `spacesWorker` + `SpaceDO` (not the provisioner's own
mocked-fetch unit tests) still succeeds. 1725/1725 tests pass (5 new), `pnpm turbo run typecheck`
clean (75 tasks).

## A1.24 Second full-vision batch, Phase 1: Cloudflare AutoRAG/AI Search — BUILT (scoped to KB + Wiki)

User-directed batch of five items (AutoRAG/AI Search, native web search via CF AI Gateway,
per-tenant/per-user CF infra usage tracking, a Claude-Code-style context-window usage UI with
pre-send auto-compaction, and a model switcher). This section covers Phase 1 only; later phases
get their own `## A1.25+` sections as they land.

**Scoping decision, confirmed via AskUserQuestion before writing any code:** Cloudflare AutoRAG is
a managed "point at an R2 bucket of documents, auto-chunk/embed/reindex, query later" product. It
is a good fit for the Knowledge Base pipeline and Memory OS's Layer 6 (Wiki — an "auto-curated
concept vault," stable and document-like) and a bad fit for Layer 5 (episodic→semantic memory),
which needs instant per-message embed+query; AutoRAG's R2-batch reindexing has real lag that would
make a just-remembered fact unsearchable for a while. Layer 5 keeps its existing direct Vectorize
embed+query, untouched by this phase.

### KB pipeline (`workers/knowledge/src/index.ts`)

New optional `AUTORAG_KB_INSTANCE: string` config. Ingestion (`POST .../kb/documents`) additionally
writes the sanitized whole document to a new `autorag/{spaceId}/{projectId ?? "_space"}/{docId}.md`
R2 key (distinct prefix from the existing per-chunk `kb/{spaceId}/{projectId}/{docId}/chunk_{i}.json`
records) whenever an instance is configured — best-effort, wrapped in its own try/catch, never fails
ingestion since the existing dense+BM25+RRF hybrid pipeline (unchanged, still the default) already
succeeded. `PATCH .../kb/documents/:docId` keeps the mirror in sync (overwrites); `DELETE` removes it
explicitly (it lives outside `docR2Prefix`'s existing prefix-based cleanup, so needed its own
best-effort delete call).

`GET .../kb/search` gained `retrieval_mode=autorag` (default: `legacy`, the existing pipeline) — a
**per-request** opt-in the caller decides (the knowledge-base prebuilt, or whatever's calling this
route), not a stored per-space policy row. When requested and configured, calls
`c.env.AI.autorag(instanceName).search({query, max_num_results, filters: {folder: "autorag/{spaceId}/{projectId}/"}})`
— the `folder` filter narrows to this exact space+project (defense in depth matching the legacy
path's own Vectorize metadata filter guarantee) — and maps AutoRAG's result shape into the same
`{chunk_id, doc_id, chunk_index, content, score, dense_score, sparse_score}` shape the legacy path
already returns (`<kb_content>` XML wrapping preserved for prompt-injection protection). Any
AutoRAG error, or the flag being requested without an instance configured, falls through to the
legacy pipeline rather than erroring — same honest-degradation posture as every other optional
platform integration in this codebase (`TAVILY_API_KEY`, `COMPOSIO_API_KEY`, ...). The cache key
now folds in retrieval mode too, so a legacy-mode result is never served back for an autorag-mode
request or vice versa.

**Note on the exact AutoRAG binding/response shape:** written defensively (typed via a narrow local
interface, wrapped in try/catch) since this is comparatively new Cloudflare product surface —
verify the real `.autorag(name).search()` response shape against current Cloudflare docs before a
live deployment depends on it, matching this codebase's own established precedent for newer/less-
verified third-party API assumptions (e.g. `revenue-tracker.ts`'s Whop-shape comment).

### Memory OS Layer 6 — Wiki (`workers/agents/src/script-engine/memory-os.ts`)

New optional `MemoryOSOptions.wikiBucket` (a minimal `{put(key, value)}` interface, not a hard CF
`R2Bucket` dependency — same rationale as the existing `VectorIndex`/`Embedder` minimal interfaces)
and `MemoryOSOptions.autoRag` (`{search(query, {topK}): Promise<Array<{concept, score}>>}`).
`upsertWikiConcept` mirrors each concept to R2 at
`spaces/{spaceId}/memory/wiki/{userId || "_space"}/{concept-slug}.md` (best-effort — SQLite's
`wiki_store` row is written first and is unaffected by a mirror-write failure). `searchWiki` first
runs its existing SQLite LIKE-match (unchanged); if that doesn't already fill the requested `limit`
and an `autoRag` gateway is configured, it ALSO queries AutoRAG for semantically-matched concept
names (useful for e.g. a query like "what's our refund window" finding a concept literally named
"return_policy" that no substring match would ever find) — but **always re-hydrates the actual
`WikiArticle` from SQLite** for each AutoRAG-named concept rather than trusting AutoRAG's own
(unstructured) result directly; a concept AutoRAG still has indexed but that's since been deleted
from SQLite is silently skipped, never fabricated. Wired in `NaelaoAgentDO.buildScriptEngineEnv`: a
new `AUTORAG_WIKI_INSTANCE` env config, `wikiBucket` reuses the already-bound `SCRIPTS_R2`, and the
`autoRag` gateway is a small inline adapter over the existing `AI` binding's `.autorag(name)`
accessor (same accessor the KB pipeline above uses, different instance name/config so the two
subsystems can be configured independently). Explicitly NOT done this phase: wiring AutoRAG into the
SpaceDO-backed **project-shared** Wiki path (`project-memory-client.ts`, §A1.17 Phase U) — that's a
structurally separate implementation (HTTP calls to SpaceDO's own `wiki_store`-equivalent, not this
DO's local SQLite), deliberately deferred rather than silently left half-covered.

### A real, independent bug found and fixed while in this file

The `MEMORY_VECTORIZE` binding's own `wrangler.toml` comment has always claimed Layer 5 semantic
recall is "queried by embedding + user_id filter" — the actual `recall()` code only ever filtered
Vectorize by `{spaceId: {$eq}}`, never `userId`. In shared-assistant mode (one DO/SQLite instance
serving multiple end users), this meant one user's promoted episodic memories were fully recallable
by every OTHER user sharing the same space — a real cross-user memory leak, not a documentation
typo, since the comment described intended behavior that the code never implemented. Fixed with a
two-query merge: Vectorize's flat `{field: {$eq}}` filter has no `OR`/`IN` support, so — mirroring
the exact `user_id IN (?, ?)` two-tier scoping `structured_facts`/`episodic_log` recall already use
in this same file — a scoped user's recall now issues one query filtered to their own `userId` and
one filtered to the space-level (`""`) sentinel, merged and deduped by vector id. An unscoped
(space-level) caller still issues only the single query it always did. New
`tests/unit/memory-os-layer5-user-scoping.test.ts` proves the leak is closed (one user's recall
never surfaces another's promoted memory) while space-level sharing still works, and that an
unscoped query doesn't regress to two redundant Vectorize calls.

1757/1757 tests pass (17 new: `memory-os-layer5-user-scoping.test.ts`,
`memory-os-wiki-autorag.test.ts`, `kb-autorag-retrieval.test.ts`), `pnpm turbo run typecheck` clean
(75 tasks). Next: Phase 2 (native web search via CF AI Gateway's provider tool-passthrough,
alongside the existing Tavily-backed path), Phase 3 (per-tenant/per-user CF infra usage tracking),
Phase 4 (real token-level streaming + context-window usage UI + pre-send auto-compaction), Phase 5
(model switcher).

## A1.25 Second full-vision batch, Phase 2: native web search via CF AI Gateway — BUILT

Alongside the existing Tavily-backed `web-search` prebuilt (item 42/§A1.x, unchanged — still the
only option for raw structured search results with no LLM in the loop), Phase 2 adds a second,
genuinely different mechanism: Anthropic's native, server-executed `web_search` tool, proxied
transparently by Cloudflare AI Gateway. Per Cloudflare's own docs
(https://developers.cloudflare.com/ai-gateway/usage/web-search/), this is NOT a Cloudflare-owned
search index — the gateway passes the model provider's own native tool through, applying its
standard logging/caching/guardrails, and **bills it through the same Unified Billing as the rest
of the LLM call, with no separate web-search fee**. This is the "search then summarize via a
small model, on the gateway, using the run's normal credits" mechanism the user originally asked
about, collapsed into a single call rather than two script hops.

### Type changes (`packages/llm-gateway/src/types.ts`)

`LlmTool` was a single interface (`{name, description, input_schema, require_approval?}` —
Naelao's own custom function-calling shape, the only kind this codebase's ReAct/script-engine tool
surfaces have ever used). It's now a union:
- `LlmFunctionTool` — the old shape, renamed, unchanged in every field.
- `LlmNativeWebSearchTool` — `{type: "web_search_20250305", name: "web_search", max_uses?,
  allowed_domains?, blocked_domains?, user_location?}`, matching Anthropic's native tool's wire
  shape (no `input_schema` — Anthropic executes it server-side, the caller never sees an
  `input_schema` to validate against).

`ContentBlock.type` gained `"server_tool_use"` (the model calling its own native tool — same
`input_json_delta` streaming shape as an ordinary `tool_use`, just executed by Anthropic instead
of the caller) and `"web_search_tool_result"` (the search results Anthropic's server already
executed and is handing back inline), plus a new `web_search_results?: Array<{title?, url?,
encrypted_content?, page_age?}>` field to carry them.

### `buildRequestBody` needed no change; `streamLlm` needed a real fix

`buildRequestBody` (`packages/llm-gateway/src/gateway.ts`) already does
`if (request.tools?.length) body.tools = request.tools;` unconditionally — no per-tool-shape
validation, so a native tool block passes through to Anthropic exactly as-is. `callLlm`'s
non-streaming response mapping is a bare `response.json()` cast — also needed no change, since it
never inspects block types at all.

`streamLlm`'s SSE handler DID need a real fix — and turned out to be entirely untested and
uncalled dead code before this phase (`grep -rln "streamLlm"` across the whole repo returned zero
callers anywhere outside the `llm-gateway` package itself, confirmed independently by two people
tracing this same finding). Its `content_block_stop` handler only recognized `meta.type ===
"text"` or `"tool_use"` — anything else (silently, no `else` branch) was dropped on the floor.
Fixed to also emit `server_tool_use` (parses accumulated `input_json_delta` text as `input`,
exactly like `tool_use` already did — just a different resulting block `type`) and
`web_search_tool_result` (captured in full at `content_block_start`, NOT accumulated via delta —
Anthropic delivers the whole result set the moment the block starts, unlike text/tool_use blocks
which stream in incrementally). **A real bug caught by the first test draft, not by inspection:**
a `web_search_tool_result` block identifies itself via `tool_use_id` (linking back to the
`server_tool_use` call it answers), NOT `id` like every other block type — the initial
implementation only ever read `block.id`, which is always `undefined` for this block type, so the
result would have been captured with a permanently missing `tool_use_id`. Fixed by reading
`block.id ?? block.tool_use_id` at `content_block_start`.

### New prebuilt op: `web-search.grounded_answer` (`workers/agents/src/script-engine/prebuilt/web-search.ts`)

`grounded_answer(query, model?, max_results?)`: calls a small model (default
`claude-haiku-4-5-20251001`) with the native web-search tool enabled, directly — no Tavily/
knowledge-worker round trip. Returns `{answer, citations, usage}`. Degrades honestly
(`{ok:false, reason:...}`) when the new `llmCaller` gateway isn't wired (same posture as every
other optional integration).

### The real fix that makes this billed, not a free side-channel

This is the part worth reading carefully, because it's the difference between "a feature that
looks metered" and one that actually is. A prebuilt op making its OWN internal LLM call is new —
nothing in this codebase did that before. `ScriptToolSurface.run()`'s prebuilt-success branch
(`workers/agents/src/script-engine/tool-surface.ts`) previously hardcoded `tokens_used: 0`
unconditionally for EVERY prebuilt op, with no path at all for an op to report real usage back.
Fixed generically (not just for this one op): the success branch now reads an optional
`output.usage.{tokens_used, input_tokens, output_tokens}` from whatever the op returned, and folds
it into the `ScriptRunResult` the same fields `settleRunBilling` already reads. `loop.ts`'s
pre-existing `withTokenUsage()` — which runs after every level, adding the reasoner's OWN
`decide()`-call usage onto `loopResult.result.tokens_used` — already summed rather than
overwrote (`tokens_used: loopResult.result.tokens_used + total`), so once the EXECUTE step's
result carries a real number instead of a hardcoded zero, the existing pipeline correctly adds
the reasoner's usage on top with no further changes needed. This also means any FUTURE prebuilt
op that calls an LLM internally is billed correctly for free, without needing its own bespoke
wiring — the fix is at the one chokepoint every prebuilt op's result already passes through.

New `ScriptEngineEnv.llmCaller?: LlmCallerGateway` (`{callWithNativeWebSearch({model, query,
maxUses?}): Promise<{answer, citations, tokens_used, input_tokens, output_tokens}>}`), wired in
`NaelaoAgentDO.buildScriptEngineEnv` reusing the existing `this.aiGatewayConfig()` helper and
`ANTHROPIC_API_KEY`/`NAELAO_AIG_TOKEN` resolution (the exact same credential-availability check
`canAuthenticateLlm()` uses elsewhere in this file) — degrades to absent (never a silent no-op)
when neither is configured.

1769/1769 tests pass (12 new: `llm-gateway-native-web-search.test.ts` proving both the SSE fix and
the pre-existing pass-through; `web-search-grounded-answer.test.ts` proving the op's own behavior
AND that its usage reaches `ScriptToolSurface.run()`'s billed `ScriptRunResult` fields, not just
the op's own return value), `pnpm turbo run typecheck` clean (75 tasks). Next: Phase 3 (per-tenant/
per-user CF infra usage tracking), Phase 4 (real token streaming + context-window usage UI +
pre-send auto-compaction), Phase 5 (model switcher).

## A1.26 Second full-vision batch, Phase 3: per-tenant/per-user Cloudflare infra usage tracking — BUILT

The user's ask: "track all this CF infra usage per tenant/per user per their subscription plan
limits, track everything." Reuses three already-proven metering patterns found during the earlier
exploration pass rather than inventing new ones: `tokensToCredits`'s conversion-function shape
(`packages/billing-core`), `quota.ts`'s KV-cache-invalidate-not-increment pattern (item 27), and
the existing `llm_tokens` builder-quota gate's exact scoping (item 46's P0-3).

### `infraTimeToCredits` (`packages/billing-core/src/index.ts`)

New `InfraResourceType = "isolate" | "container" | "workflow_step"` and
`infraTimeToCredits(resourceType, durationMs)` — the infra counterpart to `tokensToCredits`, same
"always round up, minimum 1 credit for any nonzero cost" invariant. A small per-resource pricing
table: isolate cheapest (proportional to CF's own CPU-ms billing), container costed materially
higher per-ms (full-VM compute), a workflow step a flat per-invocation fee (its cost is dominated
by orchestration overhead, not wall-clock, at Naelao's scale). **Explicitly documented as
approximate default rates, not authoritative Cloudflare pricing** — tune against the platform's
real CF invoice before relying on this for margin analysis; the relative ordering is what matters
for fair per-tenant metering.

### Capture points

- `NaelaoAgentDO.settleRunBilling`: a new `NaelaoAgentDO.infraResourceTypeForTier(tier)` maps
  `ExecutionTier` 2-4 → `"isolate"`, 5 → `"container"` (Tier 1, in-process R2, is excluded — not a
  distinct CF resource, and `duration_ms` is always 0 there anyway). The infra-credit computation
  and recording now happens **before** the function's pre-existing `if (!tokensUsed) return;`
  early-out, not after — a pure script execution with zero LLM tokens (e.g. a scheduled
  `workflow.run` with no reasoning step) still consumes real isolate/container time and must not
  silently go unmetered just because it made no LLM call. Recorded via the same `/billing/usage`
  POST mechanism (`event_type: "infra_credits"`) the existing `llm_tokens` recording already uses,
  for **every** run with a measurable tier+duration regardless of caller role (pure observability
  — this is deliberately broader than the enforcement gate below). Also emits a new Analytics
  Engine data point (`infra.execution.completed`, `packages/analytics-schema`'s versioned slot
  layout, `tenant_id` in `indexes[0]`, best-effort try/catch matching every existing call site).
- `ScriptRunWorkflow`'s `execute-script` step and `AgentTaskWorkflow`'s `run-agent` step (the two
  steps that dispatch real work — not the trivial DO status-update steps in either workflow,
  which aren't metered) gained real `Date.now()` wall-clock bracketing where **none existed
  before** (confirmed during the earlier exploration pass: zero `Date.now()` calls in either
  file). A new shared `reportWorkflowStepInfraUsage()` (`workers/agents/src/workflows/
  report-infra-usage.ts`) posts `resourceType: "workflow_step"` usage — Workflow classes share the
  agents worker's plain `Env` (`workers/agents/src/env.ts`), not `NaelaoAgentDO`'s own
  `internalHeaders()`/`BILLING_WORKER` wiring, so this needed a small standalone equivalent rather
  than a DO method; `Env` gained `BILLING_WORKER?: Fetcher` (the binding already exists in
  `wrangler.toml` under the `naelao-billing` service — it was just missing from this particular
  shared TypeScript interface, a real but narrow gap).

### Enforcement — extends the existing `quota.ts`/`entitlements` mechanism, doesn't build a parallel one

New `monthly_infra_credits` field on `@naelao/entitlements`'s `PlanLimits`/`PLAN_LIMITS` (all four
tiers, roughly the same 1:20:200:2000 tier ratio as `monthly_tokens`) **and** the same field
(`maxMonthlyInfraCredits`) added to `workers/billing/src/quota.ts`'s own separate `QuotaLimits`
table in the same commit — that file already maintains a second, independently-hand-synced copy
of these numbers (a pre-existing, documented duplication, not something this pass introduced or
tried to unify) and its own comment insists the two stay numerically identical. New
`QuotaMetric = "infra_credits"` case added to `getCurrentUsage`'s D1 aggregate switch (identical
shape to the existing `llm_tokens` case: `SUM(quantity) FROM usage_events WHERE event_type =
'infra_credits' AND recorded_at >= start of month`) and to `invalidateQuotaCache`'s metric list.
New `GET /internal/usage/infra-credits/check` (`workers/billing/src/index.ts`) mirrors
`/internal/usage/llm-tokens/check` exactly (same HMAC gate, same response shape).

`NaelaoAgentDO.enforceRunGates`'s existing `BUILDER_CALLER_ROLES` branch (the builder-chatting-
with-their-own-Space-Assistant scope — P0-3's exact scoping, re-used verbatim) now ALSO checks the
new infra-credits quota alongside the pre-existing llm-tokens one, same fail-open-on-transient-
error / 402-`error_code: "infra_quota_exceeded"`-on-confirmed-over-cap posture. **Deliberately NOT
extended to project-scoped or signed-in-product-end-user runs** — those already have their own
separate wallet/project-spend-cap/credit-balance gates (project_spend, ProductUserDO credits),
which are a fundamentally different metering axis (currency-like spend) from this one (a resource-
consumption ceiling); folding infra credits into those existing gates is a real, separate design
question left for its own pass, not silently done here. **Also deliberately NOT extended:**
`handleChannelHeartbeat`'s separate per-message customer-bot debit loop (still token-credits only,
unchanged).

1781/1781 tests pass (12 new: `infra-usage-metering.test.ts` proving the conversion function's
invariants and `reportWorkflowStepInfraUsage`'s real-and-degrades-honestly behavior;
`infra-usage-quota-gate.test.ts` proving the pre-run gate's fail-closed/fail-open cases and its
narrow BUILDER_CALLER_ROLES-only scoping via the same `NaelaoAgentDO` `/run` fixture pattern
`interactive-run-end-user-credit-gate.test.ts` established), `pnpm turbo run typecheck` clean (75
tasks). Next: Phase 4 (real token streaming + context-window usage UI + pre-send
auto-compaction), Phase 5 (model switcher).

## A1.27 Second full-vision batch, Phase 4: real streaming fixes + context-window usage UI — BUILT (re-scoped)

The user's ask was a Claude-Code-web-style context-window meter with pre-send auto-compaction,
plus "real" background streaming (client sees live text if open, run survives if closed). Before
writing any UI, traced how the LIVE dispatch path (`handleScriptRun`, the only path `/agent/run`
calls since item 47's A-2 cutover) actually assembles what it sends the LLM — and found the
literal "check %, compact if too full" design doesn't map onto it.

### The re-scoping finding

`GatewayReasoner.decide()` (`workers/agents/src/script-engine/reasoner.ts:63-84`) builds its
`userContent` fresh on every call from `input.snapshot` (an `ObserveSnapshot` — a small
fingerprint + a handful of domain fields, NOT a conversation transcript) and `input.candidates`
(a fixed-size list of matched scripts). This payload's size does not grow as a conversation gets
longer — there is no accumulating array to trim. The classic "compaction" mechanism (drop/summarize
old messages once a growing `messages` array gets too big) DOES exist in this codebase, but only
inside the legacy ReAct `runReActLoop`/`applyContextBudget`/`truncateMiddle`
(`NaelaoAgentDO.ts:129-199`) — dead code, unreferenced from any dispatch path since A-2. Retrofitting
that dead machinery to accept a real per-model window (instead of its hardcoded
`MODEL_CONTEXT_LIMIT_TOKENS=190_000`, tagged to Sonnet) would have been real work spent on code
nothing calls. Decision: leave it exactly as-is (not worth the churn/risk for unreferenced code),
and build a fresh, honestly-scoped mechanism for the live path instead — one that measures and acts
on something that actually grows: the session's own persisted message transcript.

### Real bug #1 — the SSE endpoint was silently dead weight

`GET .../agent/runs/:runId/stream` used named SSE events (`event: status`, `event: done`) with
payloads carrying no `type` field. A browser's native `EventSource.onmessage` only fires for
UNNAMED (default `message`) events — so it never fired for this endpoint's output at all. Read all
three known chat clients (`apps/shell/Chat.tsx`, `apps/widget/naelao-chat.ts`,
`apps/portal/.../page.tsx`) and confirmed they independently already expect an unnamed event
carrying `{type: "delta"|"done"|"error", ...}` — a systemic, shared assumption, not a typo in one
file. The only way any client ever progressed was `onerror` firing once the stream closed
(interpreted as a dropped connection), falling back to plain polling. **Fixed the server to match
what every client already expects** (one `sendEvent()` helper now emits `data: {...}\n\n` with no
`event:` line, `type` always present) rather than touching three separate client files — lower
blast radius, one source of truth. The poll loop (which re-reads `fetchRunOrTaskStatus` every
second, unchanged) now also diffs the run's `final_answer` against what it last sent and emits the
new substring as a real `type:"delta"` event — honest about its own limitation: since nothing
today writes `final_answer` incrementally mid-generation, this fires once with the whole answer in
practice, not truly token-by-token (see the deferred item below).

### Real bug #2 — Chat.tsx never reattached to its own in-flight run

`apps/shell/Chat.tsx`'s init effect only ever called `getMessages()` (history) — never checked
whether a run it had itself started was still going. A reload or a remount (navigating away and
back within the same tab) showed only history, with zero indication anything was still running,
until the next explicit send. Fixed with `getActiveRunId`/`storeActiveRunId`/`clearActiveRunId`
(`apps/shell/src/lib/chatSession.ts`, same `sessionStorage` scope as the existing chat-session-id
helpers) — `handleSubmit` stores the run id the moment a message is sent, a new effect (gated on
`chatSessionId` being resolved) checks for a stored active run id on mount and reattaches via
`pollRun`+`streamRun` if it's still `"running"`, and all three run-resolution paths
(`streamRun`'s done/error handlers, `pollUntilDone`'s terminal branches) clear it. **Scoped
honestly:** `sessionStorage` survives a reload/remount of the SAME tab, not a genuinely new
tab/browser session — that would need a broader `localStorage`-based redesign of session lifetime
semantics this pass didn't make.

### Context-window usage UI (the actually-growing thing: session message history, not reasoner payload)

New `contextWindowForModel()`/`MODEL_CONTEXT_WINDOWS` (`packages/billing-core`, alongside the
existing per-model pricing table) — replaces the single hardcoded Sonnet-tagged
`MODEL_CONTEXT_LIMIT_TOKENS` with a real per-model lookup (documented as approximate defaults,
verify against current model docs before relying on it for a hard cutoff, matching this
codebase's own precedent for this class of assumption).

New `GET /spaces/:spaceId/sessions/:sessionId/context-usage` (agents worker): fetches the
session's real message transcript from SpaceDO (same call shape `resolveRunGoal` already uses),
estimates `current_tokens` via the same chars/4 approximation used elsewhere in this codebase,
compares against `contextWindowForModel(model)` for `percent_full`, and best-effort attaches
day/week/month `llm_tokens` usage against the org's plan limit (degrades to `null` fields, never
fails the request, if the billing worker is unbound or unreachable).

New `getUsageSummary()` (`workers/billing/src/quota.ts`) — day/week/month rollups over the same
`usage_events` table the existing monthly-only `checkQuota`/`getCurrentUsage` already query,
parameterizing the date-window SQL clause (`start of day` / `-7 days` / `start of month`).
**Deliberately uncached and NOT reusing the monthly gate's KV cache** — that cache exists to avoid
a D1 read on every single run's enforcement check and intentionally tolerates ~300s staleness;
this feeds a UI number a user is actively looking at, where a stale figure is a worse tradeoff than
one extra D1 read. Exposed via `GET /internal/usage/llm-tokens/summary`, HMAC-gated identically to
the existing `/llm-tokens/check`.

New `ContextUsageMeter` component (`apps/shell/src/components/ContextUsageMeter.tsx`), rendered in
`Chat.tsx`'s thread-panel Stats tab, refetching whenever `messages.length` changes (i.e. after
every completed run).

### Pre-send auto-compaction, re-scoped to what's real

New `POST /spaces/:spaceId/sessions/:sessionId/compact`: triggers `NaelaoAgentDO`'s Memory OS
maintenance pass (`handleMemoryMaintenance` — decay/promote/prune, previously only reachable via
the hourly heartbeat cron) on demand, addressed at the space-wide assistant DO via the same
`getAgentDOForSpace` helper the cron itself uses (`sessionId` is accepted for a symmetrical
session-scoped client API but not used for scoping — the underlying action is space-wide, matching
the cron's own granularity). `ContextUsageMeter` calls this once `percent_full` crosses 85%, gated
(via a ref keyed on the last-seen `refreshKey`) to fire at most once per completed run rather than
on every poll tick. **Deliberately client-driven, not a hidden per-message server-side check** —
checking this inline on every single run would add a full extra round trip plus embedding calls to
the hot path for a condition that, per the re-scoping finding above, rarely actually matters for
the reasoner's own token spend.

### Router wiring found and fixed along the way

`context-usage`/`compact` are implemented on the agents worker, but both live under
`/spaces/:spaceId/sessions/:sessionId/...`, whose generic catch-all
(`api.all("/spaces/:spaceId/sessions/*", ...)`, `workers/router/src/index.ts`) forwards to
SPACES_WORKER, not agents — the exact trap Phase 6's own history documents having hit once already
for the `/agent/*`/`/approvals/*` sub-paths (which needed their own explicit registration BEFORE
the catch-all to win). Added the same explicit `api.all` entries for these two new routes; without
them they'd have silently 404'd against the wrong worker in production despite passing every local
test that talks to the agents worker directly. Also found (while wiring the billing-summary route
and Phase 3's Workflow infra-usage reporting): both `AgentsEnv` (`workers/agents/src/index.ts`) and
the Workflow classes' shared `Env` (`workers/agents/src/env.ts`) were missing a
`BILLING_WORKER?: Fetcher` field despite the binding already existing in `wrangler.toml` — added to
both.

### Deliberately NOT built — true token-by-token live streaming

Two real paths exist to deliver this, neither attempted this pass: (a) run the terminal-answer LLM
call with `streamLlm` (real as of Phase 2) and persist growing partial text somewhere the SSE poll
loop can diff against — needs new storage (a partial-answer field on `agent_runs`/TaskDO, updated
mid-generation) the script-native path doesn't have today; (b) broadcast real per-chunk deltas
through the already-built `WsHubDO`/`broadcastSpaceEvent` pub-sub (Phase V, §A1.18) and add a
WebSocket consumer to the frontend — the backend fan-out primitive already exists, matching Phase
V's own stated "backend built, live UI consumer is the next step" precedent. Both are real, scoped
follow-ups, not silently dropped. The durability half of the user's original ask — a run surviving
a closed tab — was already real before this phase (Phase Q's Workflow+TaskDO default) and is
unaffected by any of the above.

1799/1799 tests pass (18 new: `streaming-real-deltas.test.ts` drives the real SSE endpoint
end-to-end and parses the actual wire-format output, proving no `event:` line survives and every
frame carries `type`; `context-window-usage-endpoint.test.ts` covers both the context-size and
usage-summary halves plus every degradation path; `billing-usage-summary.test.ts` covers the new
day/week/month SQL windowing directly; 2 new `contextWindowForModel` cases), `pnpm turbo run
typecheck` clean (75 tasks), `apps/shell` verified via `next build`.

---

## A1.28 Second full-vision batch, Phase 5: model switcher — BUILT (closes the dead
`spacetypes.model_config` gap)

**The gap.** `workers/agents/src/index.ts` resolved a run's model via a `modelConfig` variable
read off `spaceTypeRow.model_config` — but grepping every migration under `infra/migrations/`
confirms no migration ever adds a `model_config` column to `spacetypes` (`0003_spaces.sql`,
the table's own creation migration, has no such column and nothing later adds it). The read
therefore always produced `{}`, and all live dispatch sites silently fell back to a hardcoded
model string — a builder had no way to actually choose a model despite the plumbing appearing
to support it.

**The fix — extend the existing config-override convention, don't resurrect the dead column.**
Per CLAUDE.md's own standing rule (avoid a split-brain between a manifest and a parallel DB
table), the fix is the same shape as `memberBilling`/`pricingConfig`/`catalog`/
`containerMarketplace` before it: a new optional field on the per-space `config_json` override,
merged over the SpaceType manifest's base config by the existing `loadEffectiveProductConfig`.

- `workers/spaces/src/do/SpaceTypeRegistryDO.ts` — `SpaceTypeProductConfig` gains
  `modelConfig?: { model?: string }`, with an explicit comment distinguishing this from the dead
  `spacetypes.model_config` D1 column so a future session doesn't conflate the two or try to
  "restore" the column.
- `workers/spaces/src/builder-routes.ts` — new `ALLOWED_MODELS` curated allowlist
  (`claude-haiku-4-5-20251001`, `claude-sonnet-4-6`, `claude-opus-4-8`) — deliberately not
  arbitrary free text, for cost predictability and to keep the platform's own AI-Gateway routing
  table meaningful. The generic `PATCH /builder/products/:id` handler already shallow-merges any
  `product_config` object into `config.productConfig` — the only change needed is a validation
  branch: if `body.product_config?.modelConfig?.model` is present and not on the allowlist, `400
  bad_request`. No new route.
- `workers/spaces/src/index.ts` — `GET /spaces/:spaceId/shell/manifest` projects
  `model: pc?.modelConfig?.model ?? null` (`pc` is the already-loaded effective product config)
  so the end-user shell can read the configured model without a second round trip.
- `workers/agents/src/index.ts` — the actual bug fix. Removed the dead `model_config: string`
  field from the `SpaceTypeRow` interface entirely (nothing ever populated it). The dispatch
  path now parses `spaceRow.config_json` — a column that already exists and is already fetched
  by the same `SELECT * FROM spaces WHERE id = ? AND tenant_id = ?` query every run already
  issues, so this costs zero new queries — for `productConfig.modelConfig.model`, falling back
  to the pre-existing hardcoded model string (`claude-sonnet-4-6`) whenever the override is
  absent OR `config_json` fails to parse (malformed JSON degrades to the same safe fallback,
  never a 500).
- `apps/dashboard` — `BuilderProductConfig` (`src/lib/api.ts`) gains the matching
  `modelConfig?: {model?: string}` field; the Configuration tab
  (`dashboard/products/[productId]/configuration/page.tsx`) gains a new "Model" card — a
  3-button picker (Haiku/Sonnet/Opus), styled identically to the existing Product Mode
  button-group, writing through the SAME generic PATCH handler above with no new endpoint.

**Deliberately NOT wired — two call sites, both investigated and left alone on purpose.**
1. `NaelaoAgentDO.handleChannelHeartbeat`'s own hardcoded model default (the per-space hourly
   channel-heartbeat sweep). `NaelaoAgentDO` has no `PLATFORM_DB` binding anywhere (confirmed by
   grep — zero matches in the file), so resolving the builder's configured model there would
   require a new cross-worker HTTP round trip to SPACES_WORKER on every hourly tick, for every
   space with an active channel link, platform-wide. Judged not worth the cost for a
   machine-triggered, already cost-conscious-by-design background path — a cheap default model
   is the right call for unattended heartbeat processing regardless of what an end user picks
   for their own interactive chat.
2. The other hardcoded-model call site inside the legacy ReAct `handleRun` path
   (`workers/agents/src/do/NaelaoAgentDO.ts`, the pre-item-47 dispatch target). Unreferenced
   since item 47's A-2 cutover moved `/agent/run` onto `handleScriptRun` exclusively — matching
   that item's own explicit decision to leave the dead ReAct code in place rather than delete it
   (its `agent_runs` SQLite table still backs `handleGetRun`/`handleCancelRun`/the stale-run
   sweep), this pass makes no further changes to it.

**Tests.** `tests/unit/model-switcher-config-resolution.test.ts` (5 tests): PATCH-route allowlist
reject/accept + persistence round-trip (reusing the real `createFakeD1` + migration fixture from
`builder-dashboard-api.test.ts`), and `/agent/run` resolving the configured model, falling back
correctly on both an absent override and malformed `config_json` (reusing the raw-D1-mock +
`mintInternalToken` fixture pattern from `agent-run-script-native-dispatch.test.ts`). A third
planned test case (`shell/manifest`'s `model` field surfacing end-to-end) was dropped after its
minimal env fixture threw on a missing `SPACE_TYPE_REGISTRY_DO` binding — building the heavier
`SpaceTypeRegistryDO`-backed fixture needed to exercise `loadManifest` was judged out of
proportion to testing one already-covered projection line, since the PATCH→GET round-trip test
above already proves the identical `loadEffectiveProductConfig` merge path this field reads from.

1804/1804 tests pass (5 new), `pnpm turbo run typecheck` clean (75 tasks), `apps/dashboard`
verified via `next build` (32 routes generated).

**With Phase 5 complete, all 5 phases of this second full-vision batch (AutoRAG/Wiki, native web
search, per-tenant infra usage metering, real streaming + context-window UI, model switcher) are
now BUILT.** No further phases are planned in this batch absent new direction.

## A1.29 Wallet Connect — builder-owned payment accounts (Stripe Connect + BYO Lemon Squeezy) — REMOVED, see A1.30

> **SUPERSEDED.** This entire subsystem (StripeProvider, `payment_connections` migration 0063,
> `wallet-connections.ts`/`wallet-checkout.ts`/`wallet-webhooks.ts`, the dashboard/shell
> Payments-account UI) has been REMOVED and replaced by the Whop autonomous sub-merchant wallet
> model — §A1.30. Every business now gets an isolated, auto-provisioned wallet by default
> (no builder opt-in, no OAuth/API-key connect flow); Stripe is no longer a rail anywhere in this
> platform. This section is kept as a historical record of what was built and why, per this
> repo's own "never rewrite past history, only append" convention — do not resurrect any of it.

User direction: product revenue should settle into a payment account the BUILDER owns — never
Naelao's account, and never the builder's *personal* money. The connect experience should feel
like "Sign in with Google" (click Connect → provider-hosted permissions/onboarding page →
redirected back). For safety the connection creates/uses an **isolated business account**, and
the platform must never be able to move the builder's money — the integration surface is
checkout creation (money-in), account-status reads, and webhook receives, nothing else.

This lands directly on the gap `infra/migrations/0053_payout_requests.sql`'s own header named:
payouts were manual-fulfillment "by design" because LS has "no Stripe-Connect-style
split-payment primitive". Stripe Connect IS that primitive; this pass adds it — as a per-space
rail only. **Item 45's decision stands untouched: Naelao's own platform billing (builder plans,
the platform LS store, seats, credit packs) is Lemon Squeezy ONLY.** Stripe enters exclusively
per `payment_connections` row, constructed from the platform integration key, never selected as
a platform provider (`selectBillingProvider("stripe")` still throws loudly).

### Custody model (the safety core)

- **stripe** — Naelao holds ONE platform integration key (`STRIPE_PLATFORM_SECRET_KEY`,
  universal-tools doctrine, same as `COMPOSIO_API_KEY`). On connect, a **fresh Express
  connected account** is created (deliberately never an OAuth link to an existing — possibly
  personal — account), and the builder is redirected to **Stripe-hosted onboarding** (Stripe
  collects KYC/bank directly; Naelao never sees them). Checkouts are **direct charges on the
  connected account** (`Stripe-Account` header) with `application_fee_amount` = Naelao's fee +
  any parent-builder share, auto-collected. Funds settle in the builder's isolated account;
  Stripe pays out to their bank. Per Stripe's own docs the onboarding return redirect proves
  NOTHING — the connection stays `pending` and only activates when a live status poll reports
  `charges_enabled` (the GET route polls; the dashboard re-fetches every 5s while pending).
- **lemon_squeezy** — LS has NO OAuth and NO create-store API (verified), so this is a guided
  BYO flow, honestly presented as such: builder pastes an API key from their own dedicated LS
  store → key verified via `GET /v1/stores` → store picker → key + a generated per-connection
  webhook signing secret stored ENCRYPTED in the credentials vault (only credential NAMES on
  the D1 row) → a webhook auto-created on THEIR store pointing at the per-connection ingress.
  Money settles 100% with their store (LS is merchant-of-record on THEIR account); Naelao's fee
  can't be auto-split, so it's recorded at webhook time as a `reseller_ledger` row
  `kind='platform_fee_receivable'` (`parent_tenant_id='platform'`, `margin_cents` = what the
  tenant owes Naelao; a refund writes a negative reversing row). Parent-builder revenue share is
  deliberately NOT attributed on this rail (Naelao collected nothing to pay it from) —
  documented limitation, not silently wrong.

### What was built

- **`packages/billing-core/src/providers/stripe.ts`** — fetch-based `StripeProvider`
  (form-encoded, no SDK): `verifyWebhook` (Stripe-Signature `t=…,v1=…` HMAC, 5-min tolerance,
  constant-time compare), `parseWebhookEvent` (checkout.session.completed → payment.success,
  subscription.*, charge.refunded → refund.issued; folds the Connect event's `account` into
  `metadata.stripe_account` and captures `payment_intent` — the ONE id shared between a
  checkout event and its later refund event), `createCheckout` (ad-hoc `price_data`, direct
  charge + application fee). Connect helpers: `createExpressAccount` / `createAccountLink` /
  `getAccountStatus`. LS provider gained `lsListStores` / `lsCreateWebhook` / `lsDeleteWebhook`.
- **Migration `0063_payment_connections`** — one live (non-disabled) connection per space
  (partial unique index, the 0040 technique); vault credential POINTERS only; indexed by
  `(provider, provider_account_id)` for webhook dispatch.
- **`workers/billing/src/wallet-connections.ts`** — HMAC-gated, owner/admin-only lifecycle
  routes (`GET/DELETE /billing/wallet/connection`, `POST /billing/wallet/connect/{stripe,
  lemon-squeezy}`), tenant/space ownership checked on every route; `role="agent"` can never
  manage payments. Disconnect keeps the row as an audit record (`disabled`), best-effort
  deletes the LS webhook, and deliberately never deletes the Stripe account (it's the
  builder's own business account — they keep it via their Express dashboard).
- **`workers/billing/src/wallet-checkout.ts`** — `/internal/commerce/checkout` (which the
  storefront also flows through) routes to the builder's provider when a connection is ACTIVE;
  no connection → the Naelao-store path byte-identical. **Fail-closed rule:** a broken rail on
  a connected space (missing platform key, unreachable vault) 503s rather than falling back —
  falling back would settle revenue into the wrong custody, the exact thing this feature
  prevents. The LS rail lazily provisions a product+variant ONCE on the builder's own store
  (cached in `details_json.product_variants`).
- **`workers/billing/src/wallet-webhooks.ts`** — two public signature-verified ingress routes
  (router-proxied like the platform LS webhook): `POST /v1/webhooks/stripe` (the platform's ONE
  Connect endpoint; connection resolved from the event's connected-account id) and
  `POST /v1/webhooks/lemon-squeezy/wallet/:connectionId` (per-connection vault secret; a
  builder controls their own store so the payload's spaceId claim is NEVER trusted — both
  handlers FORCE `event.spaceId` from the connection row). Reuses the platform webhook's
  exactly-once + release-on-transient-failure machinery (exported from `lemon-squeezy.ts`).
  **Never settles to the platform-internal wallet** — the gross already sits in the builder's
  own account; only `launchpad_orders` (Stripe keyed `pi:{payment_intent}` so refunds match),
  builder-share ledger rows (Stripe rail), and the fee receivable (LS rail) are recorded.
  Agent wake (fulfillment specialist when bound) mirrors the platform path.
- **UI** — dashboard Billing tab `PaymentsAccountCard` (Connect with Stripe → hosted
  onboarding; guided LS key→store flow; status chip; disconnect-with-confirm) and a shell
  business-detail "Payments Account" card (admin-only). Spaces-worker wrapper
  `/spaces/:spaceId/payment-connection*` uses the local-grants two-gate pattern
  (requireInternalHmac + requireBusinessMembership admin on every verb, GET included) and sets
  `role=admin` toward billing only after that per-business check passes; router allowlist entry
  follows the established identity-here/authorization-there split.

### Found while building (worth remembering)

- The two static-suffix shell routes (`/payment-connection/stripe` + `/payment-connection/
  lemon-squeezy`) re-triggered the documented Hono RegExpRouter corruption in
  `workers/spaces/src/index.ts` — 8 UNRELATED routes (members, agent-definitions, sessions)
  silently 404'd in tests. Fixed with the established pattern: one `:provider` param route
  branching internally instead of two static siblings under a dynamic segment. The full-suite
  run caught it immediately; any future route added to this file should run the full suite, not
  just its own test file.

### Deployment

`STRIPE_PLATFORM_SECRET_KEY` + `STRIPE_CONNECT_WEBHOOK_SECRET` (billing Workers Secrets) and
`PUBLIC_WEBHOOK_BASE_URL` (billing var) — all optional with honest degradation; the Stripe
Connect webhook endpoint must be registered in the Stripe dashboard as a **Connect** (not
account) endpoint at `/v1/webhooks/stripe`. Full inventory: `docs/DEPLOYMENT_SECRETS.md`.

Tests: `tests/unit/wallet-connect.test.ts` (24 tests — real HMAC signature verification both
providers, connect lifecycle against real migration SQL, checkout routing connected/not/
fail-closed, spaceId-forcing, receivable + refund reversal, exactly-once, cross-tenant
isolation, secrets-never-in-D1). 1828/1828 suite green; typecheck clean; dashboard + shell
`next build` verified.

## A1.30 Whop autonomous business wallets — the business-bank-account rail (replaces A1.29) — BUILT

User direction: a COMPLETE restructuring of the payment model. Every business created on Naelao
(Launchpad or otherwise) should get its own isolated wallet automatically — no builder enrollment,
no OAuth consent screen, no personal bank/card details entered up front. The wallet is a REAL bank
account for that business: revenue in from Whop's own storefront/checkout and any connected
third-party platform (Stripe for physical goods, Shopify, Gumroad, a freelance marketplace,
Amazon, eBay, and more), expenses out for the business's own operating costs, owner payouts on
request. The explicit product goal: an autonomous assistant can take a business from $0 to real
revenue without the owner ever putting in a cent of their own money — while Naelao still collects
its own cut, on top of Whop's own ~6-7% all-in processing fee (verified via web research before
building: 2.7%+$0.30 card processing, +3% platform fee, +1-2% payout fees).

Why Whop, not Stripe/Lemon Squeezy (researched before building, not assumed): Whop is a
registered payment facilitator that supports programmatic SUB-MERCHANT enrollment (create an
isolated company per business via API, no per-business OAuth flow) and a programmatic WITHDRAWAL
API (241+ territories, bank/crypto/Venmo/CashApp) — the same custody shape Stripe Connect's
Express accounts have (Whop, like Stripe, holds the money and runs payout compliance; Naelao's
integration surface is provisioning, balance/status reads, and withdrawal requests only), but
`createSubMerchant` doesn't require the builder to click through a hosted onboarding page first —
it can be called automatically the instant a business is created, which is what makes this
genuinely autonomous rather than "opt-in, one extra click."

### What was removed

The ENTIRE A1.29 Wallet Connect subsystem: `StripeProvider` (`packages/billing-core/src/
providers/stripe.ts`, deleted), migration 0063's application code (the migration file itself is
left in place, unused — D1 has no cheap drop-and-forget story and nothing writes to it anymore),
`workers/billing/src/{wallet-connections,wallet-checkout,wallet-webhooks}.ts` (deleted),
`/webhooks/stripe` + `/webhooks/lemon-squeezy/wallet/:connectionId`, the dashboard
`PaymentsAccountCard`'s Stripe/LS connect flow, the shell business-detail Payments Account card,
and every `BillingProvider`/`BillingProviderEnv` "stripe" type-union member (now `"lemon_squeezy"`
only — item 45's platform-billing-is-LS-only decision was always the real constraint; Stripe's
only remaining job was the removed per-space rail).

### What was built

- **`packages/billing-core/src/providers/whop.ts`** (new, NOT a `BillingProvider` — mirrors the
  precedent StripeProvider's own Connect-lifecycle helpers set: "standalone functions, not forced
  into an interface that doesn't fit"): `createSubMerchant` (Platforms enrollment API — no
  consent screen), `getCompanyStatus` (balance/status sync), `createSubMerchantCheckout` (a
  checkout that settles directly into a business's own sub-merchant balance, with Naelao's
  platform fee auto-split via Whop's payment-splits mechanism — the Whop equivalent of Stripe
  Connect's `application_fee_amount`), `createWithdrawal` (the programmatic payout call),
  `transferPlatformFee` (sweeps Naelao's own cut out of a sub-merchant balance, run on a
  schedule — never per-transaction), `verifyWhopWebhook`/`parseWhopWalletEvent` (HMAC-SHA256
  `Whop-Signature` verification + event normalization). Endpoint shapes follow Whop's documented
  Platforms API as of this build; per this repo's own established precedent
  (`connector-whop.ts`'s and `revenue-tracker.ts`'s header comments), verify field/path names
  against current Whop docs before this handles real production traffic.
- **Migration `0064_whop_sub_merchants.sql`**: `whop_sub_merchants` (one row per business, unique
  on `space_id` — provisioned exactly once, ever), `wallet_transactions` (append-only ledger:
  revenue/expense/payout/fee_debit, idempotent on `provider_event_id`), `payout_destinations`
  (bank/crypto/venmo/cashapp; only a non-secret label + a vault credential-name pointer — actual
  account details are vault-encrypted via the credentials worker, same pattern as A1.29's LS
  API keys), `payout_requests` (the approval-gated payout workflow below).
- **`workers/billing/src/whop-wallet.ts`** (new): `provisionSubMerchant` — idempotent (a space
  already provisioned, in ANY status, is left untouched), never throws to its caller (business
  creation must never fail over wallet provisioning — a failure records a `status='error'` row
  so the assistant can see and honestly report it rather than fabricating a balance). HMAC-gated
  routes: `POST /billing/whop-wallet/provision` (fire-and-forget from business creation),
  `GET .../balance` (live-syncs against Whop, falls back to the cache on a transient Whop error),
  `GET .../transactions`, `GET/POST .../destinations`, `GET/POST .../payouts`. **Payout safety
  invariant (the plan's #5, verified by dedicated tests):** the FIRST payout to a destination
  ALWAYS creates a `pending_approval` row + a single-use emailed approval link — the actual Whop
  withdrawal API is never called until the owner clicks it (`GET /webhooks/whop-wallet/payouts/
  :id/approve?token=`, the token itself is the auth, same precedent as `business_invites`/
  password-reset links). Once a destination is marked `verified` (by a successful approval),
  SUBSEQUENT payouts to it execute directly from the POST itself — still logged, still
  auditable, never silent. An insufficient-balance payout request is rejected outright (409, no
  partial payout). `POST /webhooks/whop` resolves the sub-merchant by `company_id` (never trusts
  a payload-claimed space id), records `wallet_transactions` idempotently on
  `provider_event_id`, and fires `business_wallet.revenue_received`/`.payout_completed` via
  SpaceDO's ALREADY-EXISTING generic external-event ingress (`POST /internal/spaces/:spaceId/
  events/fire` → `fireExternalEvent` — no new event-firing mechanism was needed, this primitive
  already existed for exactly this "a caller outside this DO supplies an event" case).
- **Checkout routing** (`/internal/commerce/checkout`, `workers/billing/src/index.ts`): once a
  business's Whop wallet is ACTIVE, a Naelao-store product sale settles directly into it (with
  the platform fee auto-split) instead of Naelao's own LS store — still provisioning (not yet
  active) falls through to the existing Naelao-store path byte-identically, so a brand-new
  business can sell immediately without waiting on Whop provisioning latency. Once ACTIVE, a
  broken rail fails CLOSED (503) rather than silently falling back to the wrong custody.
- **Auto-provisioning wired into BOTH space-creation paths**: `createSpaceRecord`'s callers
  (`POST /spaces` in `workers/spaces/src/index.ts`, `POST /builder/products` in
  `builder-routes.ts`) resolve the caller's real email (from `users`/`orgs.owner_id`) and call
  the new `provisionBusinessWallet` helper (`create-space.ts`) — wrapped in its own try/catch so
  ANY failure (an unusual deployment missing a table/row, a transient billing-worker error)
  never turns an otherwise-successful space creation into a 500; this was caught by the test
  suite itself (three pre-existing tests broke on the first draft because the lookup query threw
  uncaught in their minimal DB fixtures — fixed by wrapping, not by adding tables those tests
  were never meant to need). **Deliberately NOT wired** for end-user-created businesses
  (`business-create.ts`'s `createBusinessForEndUser`): that owner is a `ProductUserDO` end user,
  not a row in the platform `users` table, and resolving their email needs a cross-DO round trip
  this file doesn't have wired (kept dependency-free of `index.ts`'s own DO-stub helpers by
  design) — documented as a real, tracked gap, not silently dropped.
- **Prebuilt script**: `workers/agents/src/script-engine/prebuilt/business-wallet.ts` (new,
  distinct from the pre-existing `wallet` prebuilt — see its header for the disambiguation: the
  OLD `wallet` is a Naelao-held stored-value balance funded via LS checkout for Naelao's OWN
  metered platform costs; THIS is the business's own bank account, funded by real revenue).
  Operations: `business_wallet.balance/history/list_destinations/add_destination/
  request_payout/list_payouts`. Registered in `PREBUILT_SCRIPTS` and reserved: `api.whop.com`
  was added to `reserved-capabilities.ts`'s `EXTERNAL_PAYMENT_HOSTS` denylist (with an updated
  header note) — Whop is a SPECIAL CASE, not the "Model A" read-only connector carve-out that
  note already documents for Gumroad/etc.: it's now ALSO the reserved payment rail, so a
  user-authored script may not construct its own `fetch()` to Whop's sub-merchant/withdrawal
  endpoints, only reach it via this Naelao-authored prebuilt (the pre-existing read-only
  `connector-whop` MCP shim — memberships/payments/products reads for Autopilot — is
  unaffected, since this host check only fires against code a user script embeds itself).
- **New project kind `business_wallet`** in `packages/events/src/business-feature-kinds.ts`
  (`BUSINESS_FEATURE_KIND_REGISTRY`) — a singleton, admin-creatable "place" for the wallet,
  same pattern as `storefront`/`business_email`. Deliberately named to avoid colliding with the
  pre-existing `wallet` kind (a different concept — see above).
- **Assistant instructions** — both the generic Space Assistant (`DEFAULT_NAELAO_AGENT`, ships
  to every SpaceType) and the Launchpad business-builder assistant
  (`LAUNCHPAD_ASSISTANT_PROFILE`) gained a "Business Wallet" section in their `agents.md` +
  system prompt: what the wallet is, how revenue gets in, when it's appropriate to request a
  payout, and the hard rule that the first payout to a new destination always needs the owner's
  one-time email approval — never assume it happened before it did. `business-wallet` was added
  to both profiles' `scripts.prebuilt` list, and the read-only ops
  (`business_wallet.balance/history/list_destinations/list_payouts`) were added to
  `LAUNCHPAD_ASSISTANT_DEFAULT_AUTO_APPROVED` so the guided-mode assistant can check the wallet
  without asking permission every time (matching the existing `project.list`/`memory.recall`
  precedent), while `request_payout` stays gated behind the space's `assistant_policy` like any
  other structural/spend-adjacent action.
- **@naelao/events**: three new event types — `business_wallet.revenue_received`,
  `.payout_requested`, `.payout_completed` — fired from the billing worker via SpaceDO's generic
  external-event ingress, giving a builder/assistant a no-code trigger hook for revenue
  milestones and payout lifecycle (e.g. "notify me on every completed payout") without any new
  firing mechanism.
- **UI**: dashboard `PaymentsAccountCard` rewritten as a read-mostly Business Wallet card
  (balance, recent activity, payout destinations with an add-destination form, payout history) —
  the assistant runs the wallet day-to-day, so the builder mainly watches it. Shell business-
  detail page's old Stripe/LS "Payments Account" block replaced with the equivalent Business
  Wallet block (balance/history member-visible, destinations/payouts admin-only, same
  `requireBusinessMembership` gating precedent as every other business-scoped route).

### Deliberately NOT built this pass (documented, not silently dropped)

- **Storefront/connect_revenue prebuilt scripts and per-template bootstrap wiring** (the plan's
  WH4/WH7): the existing `storefront` prebuilt (Naelao-hosted catalog) and the `mcp-connector` +
  `revenue-tracker` prebuilts already cover "connect a 3rd-party revenue source" — no new
  connect_revenue mechanism was added on top, matching the reuse-don't-reinvent precedent this
  codebase follows elsewhere. Per-template auto-creation of a `business_wallet` PROJECT at
  bootstrap was not wired: `BUSINESS_FEATURE_KIND_REGISTRY.autoProvisionable` is (and was already,
  independent of this pass) a documented-but-unconsumed field platform-wide — nothing reads it to
  auto-create ANY feature-kind project for ANY template today (storefront/business_email
  included), so wiring it just for `business_wallet` would be inconsistent with every sibling
  kind. The WALLET DATA itself is unconditionally auto-provisioned regardless (every business
  gets a real `whop_sub_merchants` row at creation) — the project is only an optional UI "place"
  a builder can additionally create to view it, and the assistant already has direct
  `business-wallet` prebuilt access without needing one.
- **Scheduled/hourly wallet-health monitoring** (a dedicated "Wallet Manager" heartbeat distinct
  from the Space Assistant's own existing hourly heartbeat): the plan's WH6 scheduled-job idea
  is subsumed by the assistant's own continuous existence + the new
  `business_wallet.revenue_received` event a builder can already wire a no-code trigger to,
  rather than adding a second heartbeat mechanism.
- **Owner-email resolution for end-user-created businesses** (see above) — a real, scoped
  follow-up, not a silent gap.

Tests: `tests/unit/whop-wallet.test.ts` (13 tests — webhook signature verify/reject,
sub-merchant provisioning idempotency + honest error-status on missing key, cross-business
isolation on both balance-read and payout-request, webhook idempotent recording + unknown-
company skip + invalid-signature rejection, the full payout-approval state machine (pending →
emailed link → single-use execution → destination marked verified → a verified destination's
NEXT payout skips approval), insufficient-balance rejection, and a secret-hygiene check that the
master API key never lands in any D1 row). `tests/unit/reserved-capabilities.test.ts` updated to
assert Whop is now blocked as a direct-fetch host (previously asserted the opposite, before Whop
became a reserved rail). 1818/1818 suite green (13 new, 3 pre-existing owner-email-lookup
crashes fixed via try/catch wrapping), `pnpm turbo run typecheck` clean (75 tasks), dashboard +
shell both verified via `next build`.

### A1.30 addendum — the KYC/onboarding gate (item 51) — BUILT

Follow-up research (prompted by a user question about Whop's "connected accounts" terminology)
surfaced a real gap in the model above: Whop's docs distinguish ENROLLING a connected account
(the company record, instant, API-only) from that account being PAYOUT-READY (requires the
recipient to complete an emailed KYC/onboarding link if they don't already have a Whop account).
The original `pending/active/error` status model conflated these — a business could show
`active` the moment its company was created, when in fact its first payout would fail until KYC
completed. Fixed:

- **Migration `0065_whop_kyc_onboarding.sql`** rebuilds `whop_sub_merchants` (SQLite can't ALTER
  a CHECK constraint in place — same limitation migration 0052 hit for `processed_webhook_events`)
  adding `status IN ('pending','awaiting_kyc','active','error')` and a nullable `onboarding_url`
  column.
- **`createSubMerchant`** (`packages/billing-core/src/providers/whop.ts`) now returns
  `{company_id, status, onboarding_url?}`. Since the exact response field name Whop uses for the
  onboarding link is unverified (docs.whop.com blocks unauthenticated fetches — confirmed by
  direct testing during this session), it defensively checks a few plausible names
  (`onboarding_url`/`account_link`/`verification_url`) and falls back to an honest
  `awaiting_kyc` with no link (rather than fabricating one) if Whop signals
  `requires_onboarding` without supplying a URL.
- **`getCompanyStatus`** derives `awaiting_kyc` from the plain `payouts_enabled: false` boolean
  during a live sync, independent of whatever status string Whop's own API returns — a more
  reliable signal than the unverified onboarding-link field name, mirroring exactly how the
  removed Stripe Connect rail (A1.29) polled `charges_enabled`/`payouts_enabled` rather than
  trusting the return-redirect.
- **`provisionSubMerchant`** best-effort emails the owner the moment a wallet lands in
  `awaiting_kyc` (`notifyOwnerOnboardingRequired`, never blocks provisioning on send failure) —
  with the link if one was captured, or a plain "check your email from Whop" if not.
- **Payout gating** (`POST /billing/whop-wallet/payouts`) now names the verification step
  explicitly in its 409 rather than a generic "wallet not active" message.
- **UI**: dashboard `PaymentsAccountCard` and the shell business-detail page both show an amber
  "one more step" banner with a direct "Complete verification" link when Whop supplied one, or a
  "check your email" fallback when it didn't. Both wallet-carrying assistant profiles
  (`DEFAULT_NAELAO_AGENT`, `LAUNCHPAD_ASSISTANT_PROFILE`) were told explicitly: `awaiting_kyc`
  means the wallet can still receive revenue but cannot pay out yet — tell the owner plainly,
  never let a payout request fail with no explanation.

**Also clarified while researching this** (a distinct question, not a code change): Whop is a
full Merchant of Record and could in principle run Naelao's OWN platform subscription billing
directly (a normal, non-Platforms "whop" selling recurring access — self-serve, no invite
needed) — a genuinely separate integration from the Platforms/connected-accounts API this build
uses. Deliberately NOT pursued this pass: Lemon Squeezy remains the sole PLATFORM billing
provider (item 45 stands untouched — verified by diff that none of `/billing/subscription`,
`/billing/checkout`, `/billing/portal`, or the LS webhook handler were touched by any of the
Whop wallet work). Moving platform billing to Whop would be a deliberate, separate decision, not
an implicit side effect of the business-wallet feature.

Tests: 5 new in `tests/unit/whop-wallet.test.ts` — onboarding-link capture + best-effort owner
notification, an owner with an existing Whop account provisioning straight to `active` (no link
needed), `GET balance` surfacing `onboarding_url` only while `awaiting_kyc`, a payout rejection
naming verification explicitly, and a live sync deriving `awaiting_kyc` from
`payouts_enabled: false` independent of Whop's own status string. 1823/1823 suite green,
`pnpm turbo run typecheck` clean (75 tasks), dashboard + shell both verified via `next build`.
**Not done:** the exact onboarding-link field name and full connected-account response shape
remain unverified against live Whop docs — confirm once Platforms API access is actually granted
(apply via `sales@whop.com`) and narrow the defensive multi-field check accordingly.

### A1.30 addendum — BYO Whop connector + "Connect with Whop" OAuth flow (items 52-53) — BUILT

Two follow-on passes while items 50-51's invite-only Platforms API access is still pending.

**Item 52 (BYO connector):** a business owner connects their OWN normal Whop account (an API key
from their own dashboard, no invite needed — a completely different, always-available Whop
mechanism from the Platforms API) so the assistant can read it via the existing `mcp-connector`
prebuilt, with Naelao's revenue-share cut billed via the pre-existing `revenue-tracker` surcharge
mechanism (charged on the builder's next platform subscription, not auto-split at checkout — a
BYO account has no application-fee-split primitive). The dashboard's `/connectors/*` connect
route already did the store-credential + register-MCP-server work, but only checked
`requireVerifiedTenant` (proves SOME verified tenant, never that it owns the specific `space_id`
in the body) — safe for a builder (their tenant owns every space they have) but not for a
product end user, whose session tenant is the PRODUCT root spanning every business under it. New
spaces-worker wrapper routes (`GET /spaces/:spaceId/connectors/status`,
`POST /spaces/:spaceId/connectors/connect`) close that gap with `requireBusinessMembership`
before proxying to the agents worker's already-tested logic. Reproduced (and fixed, the
established way) the documented Hono router-table-scale corruption: a
`POST /spaces/:spaceId/connectors/:platform/connect` shape silently 404'd 8 unrelated tests
elsewhere in the file; fixed by moving `platform` into the request body instead of a URL param.

**Item 53 ("Connect with Whop" OAuth):** Whop also has a real, self-serve OAuth2+PKCE app model
("Sign in with Whop" — Developer Dashboard, `client_id`/`client_secret`, registered redirect
URIs), a much better UX than pasting an API key and, crucially, still no invite required (a third
distinct Whop mechanism alongside the Platforms API and the plain BYO key). Built as the new
primary connect path, with the manual-key form kept as an explicit fallback:

- `workers/agents/src/connectors/oauth.ts` — generic OAuth2+PKCE helpers (not Whop-specific code;
  any future connector with a catalogue `oauth` spec reuses these): `generatePkce`,
  `buildAuthorizeUrl`, `exchangeCodeForTokens`, `refreshTokens` (Whop rotates the refresh token on
  every use — the new one is always persisted, the old one never reused), and a KV-backed
  single-use OAuth ticket (`issueOAuthTicket`/`consumeOAuthTicket`) mirroring the codebase's own
  stream-ticket precedent: a short-lived, server-held, single-use ticket rather than putting a
  PKCE verifier or any credential in a browser-navigable URL.
- New `ConnectorDefinition.oauth` field (`catalogue.ts`): authorize/token URLs, scopes, and env-var
  NAMES for the client id/secret (never values in catalogue data). Whop's entry gained one.
- `POST /connectors/:platform/oauth/start` (authenticated `requireVerifiedTenant`, since this hop
  is a plain fetch, not a page navigation): generates the PKCE pair, stores
  `{verifier, spaceId, tenantId, userId, returnUrl, platform}` under a random ticket id
  (`AGENT_CACHE`, 10-minute TTL — long enough for a human to click through Whop's consent
  screen), and returns `{authorize_url}` with the ticket as `state`. The frontend does a REAL
  browser navigation to this URL.
- `GET /connectors/:platform/oauth/callback` — PUBLIC/unauthenticated (Whop redirects the raw
  browser here; the single-use ticket in `state` IS the auth, consumed — deleted — on first
  read, so a replayed callback URL from browser history/proxy logs can never redeem twice).
  Exchanges the code server-side (holds the client secret), vaults
  `{access_token, refresh_token, expires_at}` as JSON under the connector's own credential name
  (reusing the exact `POST /spaces/:spaceId/credentials` upsert path item 52's manual flow
  already used), upserts the `mcp_servers` row to `auth_type: "oauth2"`, and 302-redirects the
  browser to the caller's own `return_url` with `?whop_connected=1` (or `?whop_oauth_error=...`)
  — the tokens themselves never reach the browser.
- `POST /internal/connectors/oauth/refresh` (HMAC-gated, same `requireVerifiedTenant` check) is
  the ONLY place that ever holds the Whop OAuth client secret. `workers/mcp-hub/src/index.ts`'s
  `buildAuthHeaders` gained an `oauth2` branch (`resolveOAuthAccessToken`): parses the vaulted
  JSON, and when within 5 minutes of `expires_at`, calls this refresh endpoint (new
  `AGENTS_WORKER` service binding on mcp-hub) rather than duplicating the client secret onto
  mcp-hub — deliberately proactive (checked before the call) rather than reactive
  (retry-on-401), and falls back to the current (possibly stale) access token on any refresh
  failure rather than throwing, so a transient outage of the refresh endpoint doesn't turn every
  connector call into a hard failure; a genuinely expired token still surfaces a real 401 from
  the upstream connector itself.
- New spaces-worker route `POST /spaces/:spaceId/connectors/oauth-start` (admin-gated via
  `requireBusinessMembership`, `platform` in the body — same router-corruption-avoidance
  precedent as item 52's `connect` route), proxying to the agents worker's start route with the
  space's own verified owning tenant.
- Shell UI: "Connect with Whop" is now the primary button on the business detail page (does
  `window.location.href = authorize_url`), with "Use an API key instead" collapsing to the
  original manual-paste form. A mount-time effect reads `?whop_connected=1`/
  `?whop_oauth_error=` off the URL, shows a toast, strips the marker (so a reload doesn't
  re-fire it), and refreshes connector status.

Tests: `tests/unit/whop-oauth-connect.test.ts` (12 tests) — authorize-URL construction (client
id, PKCE challenge method, redirect_uri, state), honest `oauth_not_configured` degradation when
the OAuth app isn't set up, a missing/unknown state ticket rejected with a clear message, the
full happy path (code exchange → vaulted tokens never appearing in the redirect → MCP server
upserted with the right `auth_type`/`auth_secret_name`), single-use ticket replay rejection, an
`error=` query param from Whop redirecting cleanly instead of 500ing, the refresh endpoint's HMAC
gate and token-rotation persistence, and mcp-hub's `resolveOAuthAccessToken` exercised directly
(fresh token passthrough, proactive refresh + verified HMAC token to the agents worker, graceful
fallback to the stale token on a failed refresh call or a missing `AGENTS_WORKER` binding).
1835/1835 suite green, `pnpm turbo run typecheck` clean (75 tasks), shell verified via
`next build`. **Not verified against a live Whop OAuth app** (exact endpoint paths/scopes/response
shapes are per Whop's published guide, not exercised against a real registered app — confirm once
`WHOP_OAUTH_CLIENT_ID`/`WHOP_OAUTH_CLIENT_SECRET` are actually issued). **Not done:** an
equivalent OAuth button on the dashboard's own `/dashboard/spaces/[spaceId]/connectors` console
(still manual-key-only — this pass targeted the shell's per-business flow specifically).

## §A1.31 — Harness Excellence Program, Phase HX1: agent trace layer

Context: a harness-architecture comparison against Claude Code/OpenClaw/Hermes (full research in
the session's plan file) found the single highest-leverage gap was self-inflicted — the
script-native loop already computes per-phase timing/tier/token data at every OBSERVE/FIND/GATE/
reason/`script.run` boundary, but discarded all of it into an ephemeral `notes: string[]` that
never survives past the HTTP response body (at most a 5-line tail feeds Memory OS Fabric). The
fully-built `packages/tracing` (Span/Tracer/ActiveSpan → Analytics Engine) had zero consumers
anywhere in the repo. Every later phase (signals, live-agent eval, SkillOpt-style skill
evolution) needs real per-step traces as its input — this phase builds that foundation.

**`workers/agents/src/script-engine/types.ts`**: new `TraceStep` (`seq, phase, name?, tier?,
duration_ms?, tokens?, ok?, detail?, ts`) and `LoopResult.trace: TraceStep[]` (required — every
construction site updated, not left optional, so a future caller can't silently forget it).

**`workers/agents/src/script-engine/loop.ts`** (`runScriptLoop`): a closure-local `pushTrace`
records one step at OBSERVE, FIND, GATE, every `reasoner.decide()` call (L2's single call and
each L3/L4 iteration — tokens from the same `usageOf(reasoner)` the loop already reads for
billing), and every `tools.run()` call site (5 total: L1, L2's patch branch, L3/L4's run branch,
and `applyTerminalDecision`'s distill/patch branches) — tier/duration_ms/tokens/ok/error read
directly off the `ScriptRunResult` the engine already produces, no new instrumentation of
`ScriptToolSurface` itself needed. `LoopResultCore = Omit<LoopResult, "trace">` lets
`withTokenUsage`/`applyTerminalDecision` keep constructing plain result literals; a single
`finish()` closure attaches the accumulated `trace` array at every one of runScriptLoop's ~10
return sites, so no exit path (HITL rejection, exhausted steps, distill, give_up) is left
untraced.

**`workers/agents/src/do/NaelaoAgentDO.ts`**: new `run_traces` SQLite table (`ensureInit()`,
`PRIMARY KEY (run_id, seq)` — script-native runs mint their own `runId` with no `agent_runs` row
backing them, per the pre-existing gap that table only serves the legacy ReAct path, so this is
the first persisted-by-id record of a script-native run's existence). `persistRunTrace(runId,
tenantId, trace)` — unconditional SQLite insert (best-effort, swallows its own errors, same
"observability must never fail the run" posture as `logAgentActivity`), plus a best-effort
Analytics Engine mirror via `@naelao/tracing`'s `createTracer` when `env.ANALYTICS` is bound: one
root span (`script_loop.run`, run_id/tenant_id/step-count attributes) and one child span per
step (`script_loop.<phase>`, `parent_span_id` = root), `setError` on any `ok:false` step — degrades
to SQLite-only, no AE calls at all, when `ANALYTICS` is unbound (the pre-existing optional-binding
convention this file already uses twice elsewhere). Called from `handleScriptRun` right after
`runScriptLoop` resolves, before billing settlement — runs even on a failed result, since a
failed run's trace is exactly what a builder (or the later skill-evolution job) needs to
diagnose it. New `readRunTrace(runId)` reads it back ordered by `seq`.

**New DO-internal route** `GET /runs/:runId/trace` (returns `{run_id, trace}`, empty array for
an unknown id — not an error, since "no trace yet" is a normal state for a run still in
flight). **New builder-facing route** `GET /spaces/:spaceId/sessions/:sessionId/agent/runs/:runId/
trace` (agents worker, `workers/agents/src/index.ts`) — same `requireVerifiedTenant` + space-
ownership-check pattern as the existing sibling `.../runs/:runId` and `.../runs/:runId/cancel`
routes, plus an explicit `product_end_user` role check returning 403 before the DO is ever
reached (mirrors `agent-activity`'s existing "builder-only view" rationale — a trace can reveal
script names/params/token spend an end user shouldn't see). No new router allowlist entry needed
— the existing `/spaces/:spaceId/sessions/:sessionId/agent/*` wildcard proxy already covers it.

`workers/agents/package.json` gained `@naelao/tracing` as a real dependency (previously
unreferenced by any consumer in the monorepo).

Tests: `tests/unit/script-engine.test.ts` (2 new — trace phase ordering/monotonic `seq` for an
L1-shaped run, and a `reason` step per L3/L4 iteration with real token counts, including a
failed intermediate `run` step); `tests/unit/run-trace-persistence.test.ts` (5 new — SQLite
persist/read-back, the DO route including an unknown-runId empty-array response, persistence
never throwing before `run_traces` exists, AE span-count verification via a spy dataset, and
honest no-AE-calls-at-all degradation when unbound); `tests/unit/agent-run-trace-endpoint.test.ts`
(3 new — DO-response passthrough, the `product_end_user` 403 gate never reaching the DO, and 404
passthrough). 1914/1914 suite green (10 new), `pnpm turbo run typecheck` clean (76 tasks).

**Not done this phase (tracked, next in the Harness Excellence Program):** HX2 (explicit/implicit
signals + a per-session token-budget guard), HX3 (a live-agent eval harness + golden benchmark
datasets — the precondition for HX4), HX4 (SkillOpt-Lite-style validation-gated skill
self-evolution), HX5 (skill supply-chain hardening ahead of any future marketplace). HX6 (MCP
connector verification fixes) turned out to already be complete, landed earlier as item 57.

## §A1.32 — Harness Excellence Program, Phase HX2: signals + session token-budget guard

Built on HX1's trace layer per the plan's own build order (HX1 → HX2 → HX3 → HX4).

**Explicit signals — no new ingestion.** `agent_activity_log` (item 40) already carries
`event_type`/`tokens_used`/`cost_credits`/`created_at` for every run completion/failure and
approval request — exactly what error rate and avg/total cost need. New `GET /spaces/:spaceId/
agent-signals?project_id=&window_hours=` (SpaceDO's `computeAgentSignals`, builder-only, same
gate as `agent-activity`) rolls it up on read: `runs_total/completed/failed`, `error_rate`,
`avg_cost_credits`, `total_cost_credits`, `approvals_requested`. "Regenerations" (a proxy for the
user hitting retry) is computed in application code — 2+ run events on the SAME thread within 5
minutes — rather than a SQL window function, since the row counts here are always small and DO
SQLite window-function support isn't otherwise relied on anywhere in this codebase.

**Implicit signals.** New `detectImplicitSignals()` (`packages/events`) — regex/keyword-based
(no LLM call, per the plan's own "heuristics first" scoping), detecting `user_frustration`
("that's wrong", "still broken", ...) and `agent_forgot` ("I already told you", "as I said
before", ...) markers in a run's goal text. Deliberately does NOT detect repeated-goal/
regeneration patterns — that's already a real, more-precise EXPLICIT signal from actual
timestamps above; duplicating it as a text heuristic would just be a noisier proxy of a number
the platform already has exactly. Wired into `workers/agents/src/index.ts`'s `/agent/run` route
right after `agentId` resolves, alongside the existing moderation checks — fire-and-forget via
`waitUntil` to a new `agent_signal_events` table (SpaceDO migration v31), posted through
`POST /internal/spaces/:spaceId/signal-events`; read via `GET /spaces/:spaceId/signal-events`
(builder-only, same precedent).

**Session token-budget guard — the actual differentiator vs. OpenClaw's "$300-500/mo, no
warning" complaints.** New `SpaceTypeProductConfig.limits.sessionCreditCeiling` (config_json
override, same convention as `modelConfig`/`pricingConfig` — never a manifest fork), resolved
once in `index.ts` next to `modelConfig` (this DO has no `PLATFORM_DB` binding) and threaded
through all three dispatch paths that reach `handleScriptRun` (the sync `/script/run` call, the
async `AgentTaskWorkflow` params, and `/internal/tasks/:taskId/run`) so the guard applies
identically to interactive and durable runs. New `session_spend` table (SpaceDO migration v31,
same one as the signals table) holds only the running tally — the ceiling itself is never stored
there, avoiding a split-brain against the config_json copy.

`NaelaoAgentDO.enforceRunGates` gained a new `checkSessionBudget` branch, checked FIRST (ahead of
every payer-specific gate) since it's session-scoped, not payer-scoped:
- Under 80% of ceiling: run proceeds, no side effect.
- 80-100%: run proceeds; fires `agent.session_budget_warning` through SpaceDO's already-existing
  generic `/internal/events/fire` → `event_triggers` machinery (the SAME no-code mechanism every
  other structural event uses — no new trigger type), and marks `warned_80` so it fires exactly
  once per spending cycle.
- At/past 100%: refuses the run (`402 session_budget_ceiling`) and reuses the HITL approval
  mechanism (no new gate engine, per the plan's explicit direction) — a request is keyed on
  `run_id: sessionId` + `tool_name: 'session_budget_continue'`, a stable identity that lets the
  gate find an already-open or already-resolved request for THIS session without needing a new
  column anywhere. A second concurrent run over the same ceiling finds the pending request and
  returns its `approval_id` rather than opening a duplicate. Once a human approves, the gate
  resets the tally (`POST .../session-spend/:sessionId/continue`) and lets the run through — the
  NEXT time the same ceiling is crossed, a FRESH approval is required (approving once doesn't
  permanently disable the guard). Fails CLOSED when `HITL_APPROVAL_DO` isn't configured — the
  whole point of a ceiling is that it's never silently bypassed just because the approval
  mechanism isn't wired up. `settleRunBilling` gained the post-run counterpart: an increment to
  `session_spend`, but ONLY when a ceiling is actually configured, so a space that never opted in
  pays zero extra round-trip cost per run.

**Router-shape trap avoided, not hit.** The first draft of the session-spend wrapper routes used
one path per action (`/session-spend/:sessionId`, `/session-spend/:sessionId/continue`,
`/session-spend/:sessionId/mark-warned`) — exactly the dynamic-segment-then-static-suffix shape
that has repeatedly triggered the documented Hono RegExpRouter route-table-scale corruption in
this file (items 40, 52). Caught and fixed BEFORE running the suite (not after a mysterious
failure this time): collapsed to a single `GET/POST /internal/spaces/:spaceId/session-spend/
:sessionId` route, with POST's `action` field (`increment`/`continue`/`mark_warned`) carrying the
operation instead of a URL segment — the established remedy every prior instance of this bug
converged on. The DO-internal dispatcher (a plain regex if-chain, not Hono) has no such risk and
keeps its own separate per-action paths.

**Deliberately scoped out this pass:** a builder/end-user-facing session-spend read endpoint
(budget-meter UI) — `session-spend` stays entirely internal; `agent-signals`/`signal-events` are
builder-only reads, matching `agent-activity`'s own precedent (a cross-user audit view, not
something to expose to one end user reading their own business).

1946/1946 tests pass (32 new: `implicit-signals.test.ts`, `agent-signals-and-session-spend.test.ts`,
`session-budget-guard.test.ts`), `pnpm turbo run typecheck` clean (76 tasks).

**Not done this phase:** HX3 (live-agent eval harness + golden benchmark datasets — the
precondition for HX4), HX4 (SkillOpt-Lite-style validation-gated skill self-evolution), HX5
(skill supply-chain hardening).
