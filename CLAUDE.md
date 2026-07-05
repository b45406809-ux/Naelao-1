# Naelao Platform — Claude Code Session Guide

## What is Naelao
A Cloudflare-native AI agent platform. Builders create SpaceTypes (blueprints) and configure Templates (no coding — builders select/configure only). End-users interact via Space shell. Designed for millions of builders and millions of Spaces.

## ⭐ CURRENT DIRECTION — READ FIRST (supersedes older framing below)
This is the active plan. If anything further down conflicts, this wins.

1. **Build the ORIGINAL spec, not the niche.** The canonical spec is
   `naelao_expanded_gaps_resolved.html` (6.8 MB). The smaller
   `naelao_whop_businesses_spec.html` was written under the assumption we were only
   shipping the Whop niche — that assumption is **abandoned**. We are building the whole
   product as the original spec describes.
2. **Script-native agents + Space Assistants are our ADDITION on top of the original
   spec** — not a replacement. We keep the original spec's `NaelaoAgentDO` (the agent
   runtime as its own DO) and `SpaceDO` (owns structure), and run our script-first engine
   as the agent's *behavior* inside `NaelaoAgentDO`. These additions are documented in
   **`docs/spec-appendix/A1-script-agents-and-space-assistants.md`** (keep it updated).
3. **We start with the Launchpad SpaceType — but we build each component FULLY.** "Start
   with Launchpad" scopes *which* components we touch (the ones Launchpad needs and things
   related), NOT how completely we build them. If Launchpad needs `NaelaoAgentDO`, build
   the whole `NaelaoAgentDO` properly — never a Launchpad-only stub. Same for `SpaceDO`,
   provisioning, billing, etc. One SpaceType at a time; each part built as the spec says.
4. **Architecture ground rules (the niche pass violated these — being corrected):**
   - Agents are their **own DO** (`NaelaoAgentDO`), addressed `space:project:thread`.
   - `SpaceDO` owns threads, members, sub-spaces, **`agent_definitions`**, billing.
   - A **project is a grouping of threads within a space** — NOT a sub-space/workspace.
   - SpaceType differences live in config / agent definitions / manifests — never DB tables.
   - `BusinessDO` (a whop-niche monolith that re-implemented the agent loop + structure) is
     being **decomposed/retired**: agent loop → `NaelaoAgentDO`, structure → `SpaceDO`,
     script engine → a reusable behavior module.
5. **HOW TO READ THE SPEC — critical.** The original spec is written top-to-bottom as a
   running log: later sections contain **updates, appendixes, and fixes** that override
   earlier ones. Before building anything (e.g. `SpaceDO`), search and read the **entire**
   spec for that topic top-to-bottom — do NOT implement the first mention you find.
6. **Launchpad SpaceType (§11)** is defined as data in
   `workers/agents/src/launchpad/spacetype.ts` (5 templates + core agent_definitions).

### ⚠️ SPEC OVERRIDES — later appendixes supersede the early sections (verified top-to-bottom)
These three were read wrong in earlier passes by trusting the *top* of the spec. The **bottom
appendixes are authoritative** and override the early framing. Always confirm against these:

7. **No community SpaceTypes — Naelao authors all of them** (spec byte ~896493:
   *"Space Types are exclusively authored by Naelao. Community developers publish Apps or Space
   Templates instead."*). Model = **Naelao builds SpaceType → builder configures a product →
   users interact**. The early `createSpace` "community types from apps-registry" branch is dead.
   The authoritative provisioner is the **10-step transactional one at byte ~899k** (manifest from
   `SpaceTypeRegistryDO`, cached in KV, rollback on failure, Space Assistant init) — NOT the early
   inline version and NOT a separate provisioning queue.

8. **Agents are SCRIPT-NATIVE — the bottom appendix "Script-First General Agent Architecture"
   (byte ~6672k) is authoritative and overrides the early NaelaoAgentDO / ReAct / hardcoded-tools
   framing.** Load-bearing facts:
   - The agent's **entire tool surface is 6 ops**: `script.create / read / update / delete / find /
     run`. **Nothing else is hardcoded** — no browser/email/MCP/file tool. Every capability is a
     **script in a library** (Voyager / CodeAct). Loop: `OBSERVE → FINGERPRINT → FIND → GATE →
     EXECUTE → VERIFY → DISTILL`; the model only wakes for DIAGNOSE/REASON/DISTILL.
   - **MCP is the `mcp-connector` prebuilt script** (`mcp.register/call/list_tools`), not a hardcoded
     integration. (MCP Apps marketplace is ON HOLD — agents reach MCP through this script later.)
   - **Channels, heartbeats, notifications are scripts** (`notifications` prebuilt). Space Assistant
     = same engine + channel/heartbeat scripts. **Threads** become a default read/run-only script
     that cannot be removed (same pattern as other built-in features).
   - **An agent is defined by 4 R2 files** — `agents.md`, `system-prompt.md`, `scripts.json`,
     `skills.json` — under `spaces/{spaceId}/agents/{agentId}/`. NOT a DB row. Composed via
     **Profiles** (Default Naelao Agent, Code, Browser, Vertical Niche, Cowork Desktop, Marketplace).
   - **Skill library** in R2 (`spaces/{spaceId}/scripts/{name}/SCRIPT.md + code.ts + versions/`),
     versioned, with embeddings in **Vectorize** for `script.find`. **Execution ladder** Tier 1–5
     (R2 / V8 isolate / npm / CF Browser / Container), auto-routed per script `requires_tier`.
   - The engine lives **inside `NaelaoAgentDO`** as a behavior module (`workers/agents/src/script-engine/`).
   - `SpaceDO.agent_definitions` (added in an earlier pass) models the **early** layer; repurpose it
     as the *space-level installed-scripts registry index*, not agent behavior.

9. **Lemon Squeezy is PRIMARY billing, Stripe is "future"** (Appendix H, byte ~2261k):
   provider-agnostic `BillingProvider` interface + `NormalizedBillingEvent`. Launchpad's order
   trigger is a **Lemon Squeezy webhook**, not Stripe.
10. **Execution Ladder Tiers 2-5, the multi-channel gateway, Memory OS, and sub-agents are now
    BUILT** (`workers/agents/src/script-engine/code-runner.ts`, `memory-os.ts`,
    `sub-agent-output.ts`; `launchpad/channels.ts` signature verification + the
    `/v1/channels/:channel/inbound/:spaceId` gateway). The engine can now actually *execute*
    distilled Tier 2-5 scripts (CF Worker Loader / browser proxy / container), not just route
    to them; Space Assistants have a real signature-verified Slack/Discord/email ingress, not
    just an adapter; agents have episodic+semantic memory (Memory OS) and self-managed memory
    via the `memory` prebuilt; sub-agent fan-out is real (batched `agent.spawn`, isolated
    per-child budget, capped at 16 concurrent like Claude Code's own pattern). Full detail:
    `docs/spec-appendix/A1-script-agents-and-space-assistants.md` §A1.11-A1.12.
11. **Customer-bot projects (WhatsApp/Discord/email business bots) are now BUILT.** A
    **project** (not a new DO) can be flagged `kind='customer_bot'`: capped execution ceiling
    (script.create/update/run all fail closed above it), a daily spend cap, and no-code
    "after the customer says X, this happens" rules (`reply` / `run_script` /
    `human_takeover`) checked before the reasoning loop ever runs. WhatsApp joined the
    channel catalogue (Meta Cloud API, `X-Hub-Signature-256`). No-code project templates
    (`whatsapp-support-bot`, `discord-community-bot`, `email-support-bot`) seed STOP/opt-out
    + human-takeover by default. Full detail: appendix §A1.13.
12. **Thread hierarchy, real token accounting, Memory OS Fabric/Wiki, sub-agent progress +
    concurrency ceiling are now BUILT.** Sub-agent spawns and channel sessions mirror into
    SpaceDO's `threads` table as ordinary subthreads (`thread_kind` + `parent_thread_id`,
    hidden from the default list unless `projects.show_sub_threads` or
    `?include_sub_threads=true`) — SpaceDO's `threads` table existed since migration v8 but
    had **no CRUD at all** until this pass. `tokens_used` was hardcoded to `0` everywhere
    (`GatewayReasoner` discarded the LLM response's real `usage`) — now captured for real and
    threaded through the loop, which is what makes sub-agent token budgets (`maxTokens`,
    enforced per L3/L4 step) and `tokensToCredits()` (real per-model USD→credit conversion,
    `packages/billing-core`, `CREDITS_PER_USD=100`) actually real instead of proxies.
    `channel_user_id` now links to a stable Memory OS `user_id` so returning channel customers
    are recognized. Memory OS Layers 4 (Fabric, cross-session consolidation) and 6 (LLM Wiki,
    auto-curated concept vault) are built — the full 6-layer pipeline is now complete. A child
    sub-agent can report progress back to its parent DO mid-run (poll via
    `GET /sub-agents?parent_run_id=`, no WebSocket needed). `ConcurrencyDO` (spec §28) caps
    simultaneous sub-agent spawn trees per space, with the spec's own deadlock (TTL + alarm
    sweep) and check-then-insert-race gaps closed. Full detail: appendix §A1.14.
13. **Project-scoped workspace + a generic `lock` primitive are now BUILT.** A project is
    workspace-scoped: `workspacePrefix()` (single source of truth in `script-engine/types.ts`)
    puts every thread's agent in the SAME project under one R2 filesystem
    (`spaces/{id}/projects/{id}/workspace/`), while the Space Assistant stays space-wide
    (`spaces/{id}/workspace/`) — never inferred, a run says which it wants via
    `ScriptEngineEnv.projectId`. Concurrency (e.g. two customer threads writing a shared
    `ledger.csv`) is deliberately NOT a bespoke Naelao-shipped mechanism — the new `lock`
    prebuilt (`lock.acquire`/`release`/`status`, generalizing `ConcurrencyDO`) exposes a
    generic named-lock primitive, and the *strategy* (row-level locking, priority, whatever)
    lives entirely in scripts an assistant authors and wires into its agents' instructions.
    Lock keys are always space/project-prefixed server-side, never left to a script to
    remember. Full detail: appendix §A1.15.
14. **Assistant approval policy + YOLO mode are now BUILT.** The HITL gate in `runScriptLoop`
    has a second mode: `gate_unless_listed` (Space Assistant default) inverts the allowlist
    — every action is gated **unless** it appears in `auto_approved_actions`. `yolo` mode
    sets `gate_listed` with an empty list (nothing ever gated). Policy is stored in SpaceDO
    migration v14 (`assistant_policy` table: `approval_mode`, `auto_approved_actions`).
    `fetchAssistantPolicy()` in `NaelaoAgentDO` fails CLOSED — any error defaults to
    `always_ask` with no pre-approved actions, never silently grants yolo. Endpoints:
    `GET/PATCH /spaces/:spaceId/assistant-policy`. Full detail: appendix §A1.16.1.
15. **No-code event triggers (`@naelao/events`) are now BUILT.** Builders configure
    "project lifecycle triggers" — e.g. "when a new thread is created and the last-active
    thread has been idle 5 min, run the compact script" — as SpaceDO rows (migration v15,
    `event_triggers` table). The `@naelao/events` package (`packages/events/`) provides pure
    DO-agnostic logic: `matchesEvent`, `selectMatchingRules`, `evaluateCondition`,
    `buildFireParams`. Trigger fire bypasses the reasoning loop entirely — `handleTriggerFire`
    in `NaelaoAgentDO` calls `ScriptToolSurface.run()` directly; no LLM cost. Project
    scoping is structurally enforced: a project-scoped trigger can never fire across project
    boundaries. Fan-out is bounded at 5 rules per event. Endpoints:
    `GET/POST /spaces/:spaceId/event-triggers`, `DELETE /spaces/:spaceId/event-triggers/:id`.
    Full detail: appendix §A1.16.2.
16. **Launchpad storefront is now FUNCTIONAL end-to-end (render + CF-for-SaaS apply).** The
    portal Worker (the Cloudflare-for-SaaS fallback origin) now serves the store at the ROOT
    path a buyer lands on — `GET /` resolves the `Host` against `business_services`
    (precedence storefront → product portal), renders inline, falls through to the product
    portal proxy, else 404. The `storefront.set_custom_domain` prebuilt now posts
    `kind='custom_domain'` — the only branch that runs the CF-for-SaaS apply
    (`createCustomHostname` + TXT DCV + `getCustomHostname` status poll); it previously posted
    `kind='storefront'` and silently dropped the domain. Buy form → `/storefront/checkout` →
    billing worker reserved commerce checkout (platform fee). Full detail: appendix §A1.16.3.
17. **Member/seat billing enablement + reseller consolidated statement are now BUILT.** The
    money paths already existed (seat checkout + `recordSeatActivation`; per-event
    `reseller_ledger` attribution); this pass added the missing config/read surfaces.
    Member/seat: `GET/PATCH /spaces/:spaceId/member-billing` lets a builder enable + price
    seats, provisions the seat Lemon Squeezy variant once (like product publish), and stores
    it as a per-space `config_json.productConfig.memberBilling` override (never forks the
    manifest). Reseller: `GET /reseller/statement?period=YYYY-MM` sums the ledger into the
    consolidated wholesale invoice (totals by currency + per-client breakdown) the reseller
    settles — the G-AS34/G-AS35 wholesale-invoicing deliverable. Full detail: appendix §A1.16.4.
18. **Credential hierarchy is now BUILT** (`workers/credentials`). Three tiers, resolved per
    acting user: privileged (owner/admin) `is_override` space-level row always wins → a
    member's own `scope='user'` credential (the per-user default) → the shared `scope='space'`
    fallback. Enforced by two partial unique indexes so there's exactly one personal credential
    per (space, name, user) and one space-level row per (space, name). Also closed a
    pre-existing gap: `space_credentials` had no migration creating it at all
    (`infra/migrations/0040_space_credentials.sql` now does, hierarchy built in from the
    start) and the public CRUD routes were never proxied by `naelao-router` (added the
    `CREDENTIALS_WORKER` binding + routes). Tests run the real migration through `node:sqlite`
    rather than mocking SQL. Full detail: appendix §A1.16.5.
19. **Space collaboration (presence + project deduplication) is now BUILT.** Roles and locks
    already existed; this pass adds the other two A1.8 coordination primitives, both in
    `SpaceDO` (no new DO). Presence: migration v16 `presence` table, heartbeat-based
    (`POST/GET /spaces/:spaceId/presence`), `isPresenceFresh` (`@naelao/events`, 90s default
    window) ages out stale/crashed clients. Project dedup: `createProject` now runs a
    token-Jaccard name-similarity check (`findPossibleDuplicateProjects`, `@naelao/events`,
    deliberately not embeddings — that's `script.find`'s job) against existing active
    projects, returns `possible_duplicates` in the response, and fires the existing
    `project.possible_duplicate` event through `fireMatchingTriggers` so a builder can wire a
    no-code trigger to broadcast "this already exists" — never blocks creation. Also fixed in
    passing: `updateProject` had no `status` field at all, so a project could never actually
    be archived. Full detail: appendix §A1.16.6.
20. **Space Assistant profile + a critical agentId bug fix, and time-based scheduling, are now
    BUILT.** A top-down spec read (§05, overridden by the Script-First appendix) found the
    Space Assistant capability list functionally complete except a missing first-class profile
    and no cron-style scheduling — and surfaced a real bug: `DEFAULT_NAELAO_AGENT.agentId` was
    `"naelao-default"` while EVERY dispatcher (billing, triggers, channel heartbeats,
    sessions) hardcodes `"naelao-agent"` — a real deployment's Space Assistant would 404 on
    every wake-up. Fixed the id; rewrote the profile (`SPACE_ASSISTANT_PROFILE`, an alias of
    `DEFAULT_NAELAO_AGENT`) to state continuous existence, channel awareness, and honest
    escalation. Time-based scheduling: `scheduled_jobs` (new PLATFORM_DB table, cron-matcher
    in `@naelao/events`: `parseCronExpression`/`isCronDue`), `GET/POST/PATCH/DELETE
    /spaces/:spaceId/scheduled-jobs`, and `runScheduledJobs` wired into the existing hourly
    cron — the no-code, TIME-driven counterpart to event_triggers (spec §05 cron-jobs.json).
    Full detail: appendix §A1.16.7.
21. **Direct-worker-ingress trust hole closed (security audit, independent of the assistant
    work).** Every internal worker trusted `x-naelao-tenant-id`/`-user-id`/`-role` headers
    as-is with no verification the request came through `naelao-router` — and every worker was
    reachable at its own public `workers.dev` URL, bypassing the router entirely.
    `workers_dev = false` added everywhere except workers with their own independent public
    ingress auth (`naelao-router`, `naelao-portal-router`, `naelao-agents`' signature-verified
    channel gateway, `naelao-billing`'s webhook signatures, `naelao-ws-gateway`'s origin
    check). `proxyTo` now strips identity headers unconditionally before setting them from
    verified claims (previously only overwrote them when claims existed). New
    `requireInternalHmac` middleware + `mintInternalToken` helper (`packages/http`) gate
    credentials worker's public CRUD routes and `/internal/triggers/fire` (previously a
    forgeable static-string check) with real HMAC verification, replacing/backstopping the
    `workers_dev` fix. Full detail: appendix §A1.16.8.
22. **Layer-3 backstop follow-up (§21's deferred item) is now BUILT.** Gated the ~15
    direct-caller routes §21 deferred: `/spaces/:spaceId/projects[/:id[/rules]]`,
    `/assistant-policy`, `/registry`, `/internal/business-services[/custom-domain-status]`,
    `/internal/member-billing`, `/internal/space-types/:id[/record-install]` (spaces worker,
    several had even weaker checks than the old triggers/fire — any truthy header sufficed),
    and `/internal/semantic-cache/*` (knowledge worker — had NO auth check at all). Fixed
    every caller to mint a token: `NaelaoAgentDO` (new `internalHeaders()` helper +
    `ScriptEngineEnv.platformSecret` for prebuilt scripts), provisioner, billing (which had no
    `PLATFORM_SECRET` in its env at all — added it), agents worker. Caught a real bug in the
    process: the knowledge worker's first mount attempt used `/internal/semantic-cache*` (no
    slash) — Hono doesn't match sub-paths with that pattern, so the middleware silently never
    ran; fixed to `/internal/semantic-cache/*`. Deliberately still NOT gated (documented, not
    dropped): `/me/*` (genuinely public signed-link GDPR export, no JWT/tenant context by
    design), `/sessions*`, `/threads`, `/members*`, `/agent-definitions*`, and knowledge's
    `/spaces/:id/kb/*` — plausibly end-user/portal-reachable via paths not yet fully verified
    safe to gate. Full detail: appendix §A1.16.9.
23. **The routes §22 deferred are now gated too — investigated first, not guessed.** Grepped
    `apps/widget` + `apps/portal` for direct callers before touching anything (per spec A1.8:
    team members and portal customers are structurally different populations). Bucket A
    (`members*`, `agent-definitions*`, `threads`, knowledge's `kb/*`) — confirmed
    builder/server-only, gated immediately; fixed `lemon-squeezy.ts`'s seat-activation call
    (its `LemonSqueezyEnv` had no `PLATFORM_SECRET` either — same gap as billing's own env),
    `agents/index.ts`'s two remaining calls, and `knowledge-base.ts`'s three ops. Bucket B
    (`sessions*`, the end-user chat transport) needed real investigation: found that
    **end-user chat through the router is currently non-functional end-to-end** — the router
    requires a Bearer JWT unconditionally, but neither the widget nor the portal ever sends
    one (portal mints a magic-link `auth_token` and stores it, but never reads it back out to
    attach to a request). This is a real, separate product bug (needs a customer-auth JWT
    flow — NOT fixed here) — but it also means gating `sessions*` breaks nothing currently
    working. Gated it. Full detail: appendix §A1.16.10.
24. **A space's creator was never registered as its own `space_members` owner — now FIXED.**
    Traced while discussing the reseller ("customer creates their own business") flow.
    `INSERT INTO space_members` occurred in exactly one place platform-wide (paid-seat
    activation) — neither `POST /spaces` nor `POST /reseller/spaces` ever registered the
    creator, because `ProvisionMessage` didn't even carry a `userId`. Masked by the primary
    auth path using a global per-user JWT role, not `space_members` — but a live landmine for
    `SpaceDO.checkCrossSpace` (spec §49, denies the owner "direct member" of their own space)
    and for any team-listing UI. Fixed: `ProvisionMessage.userId`, new provisioner step 5c
    (`seedOwnerMember`) registers `role: 'owner'` via the members route, idempotent and
    non-fatal on failure. Also verified while tracing this: the reseller economics a builder
    would want (customer list, per-customer drill-down, suspend/promote, wholesale/referral
    revenue share via `reseller_ledger`) are already fully built and wired — this fix didn't
    need to add any of that. Full detail: appendix §A1.16.11.
25. **`enqueueAgentTicks`'s three rosters were unbounded — a silent enumeration ceiling at
    platform scale — now FIXED.** Each of connectors (`mcp_servers`), channel heartbeats
    (`channel_links`), and scheduled jobs (`scheduled_jobs`) was one single `SELECT ... WHERE
    enabled = 1` with no `LIMIT`, pulling every enabled row across the whole platform into one
    Worker's memory in one D1 read — fine at a few hundred Spaces, not survivable at "millions."
    Each roster is now keyset-paginated in 1000-row pages (`channel_links` has no single `id`
    column — its PK is `(space_id, channel)` — so it pages on `space_id` directly and
    deduplicates to one heartbeat per space in-memory). One Analytics data point
    (`agent-ticks.enumerated`) per sweep makes the enumeration size observable. Also corrected:
    the Stack section below claimed D1 is "sharded by tenant_id MOD n" — no such code exists
    anywhere in the repo; reworded to state the current single-instance reality with sharding as
    a named future milestone. Full detail: appendix §A1.16.16.
26. **A second audit pass found cross-tenant KB read/write (F8), per-thread spend-cap
    undercounting (F9), and a spoofable global rate limiter (F7) — all now FIXED.** F8:
    `kb/search` (and the rest of `kb/*` — list/ingest/patch/delete) never verified the caller's
    tenant owns the target space; the `requireInternalHmac` gate a prior pass added only
    authenticates the calling *worker*, not which tenant it claims to act for. A single Hono
    ownership-check middleware now gates every `kb/*` verb (404 on mismatch, before the KV
    semantic-cache lookup; the cache key also folds tenantId in). F9: the customer-bot daily
    spend cap was tallied in the agent DO's own SQLite — but agent DOs are addressed
    space:project:thread (or space:agentId for the channel-heartbeat drain), so a project with
    N concurrent threads/channels could spend up to N× its cap. Moved the authoritative tally to
    SpaceDO (one DO per space, single writer): new `project_spend` table (migration v17) +
    `GET/POST /projects/:projectId/spend`, serialized so one thread's post-run debit is
    immediately visible to the next thread's pre-run gate check. Fails CLOSED on any error,
    matching the `fetchAssistantPolicy` precedent. F7: the router funneled every authenticated
    request platform-wide through one `idFromName("global-rate-limiter")` DO and keyed buckets
    by the client-spoofable `X-Forwarded-For`. Now shards by `idFromName(bucketKey)` (one DO per
    key) and keys on `cf-connecting-ip` (edge-set, unspoofable); `RateLimitDO` reschedules a
    10-minute idle-cleanup alarm on every check instead of never pruning its `buckets` table.
    Full detail: appendix §A1.16.17.
27. **A third pass read the spec bottom-up and diffed it against the code — three of its four
    findings (F10/F11/F13: unguarded isolate fetch, wildcard CORS, hostname-literal SSRF) were
    already fixed by items 25-26 above and needed no changes; the fourth (F12, the billing
    worker's KV usage counter) was real but narrower than described — verify against current
    code before re-fixing already-fixed findings.** `incrementUsage` did an unsafe KV
    read-modify-write, but it only feeds a dashboard `GET .../quota` summary — actual
    entitlement enforcement platform-wide runs through `@naelao/entitlements`'s live `COUNT(*)`
    D1 queries, untouched by this bug. The literal spec fix (a new atomically-incremented D1
    counter table) would have introduced a second source of truth alongside the existing
    COUNT/SUM aggregate the D1 fallback already computes correctly. Fixed instead by having
    `recordUsageEvent` (renamed from `incrementUsage`) invalidate the KV cache entry rather than
    incrementing it — the next `checkQuota` call is forced back through the real D1 aggregate,
    eliminating the race instead of relocating it. Full detail: appendix §A1.16.18.
28. **Launchpad's core agents (§11) were installed as R2 configs but never actually WOKEN — now
    FIXED.** Every dispatcher hardcoded `"naelao-agent"`; nothing ever read
    `LaunchpadAgentDefinition.trigger`, so a Creator Store builder's Fulfillment/Support agents
    and the Content agent's daily cron never ran — which also made item 22's approval-gates fix
    a dead letter in production (those gates only apply when the specialist's own config
    actually loads). Schedule triggers now write a real `scheduled_jobs` row (migration 0043
    adds `agent_id`/`goal` columns and a new goal-based dispatch mode — `handleAgentTick` wakes
    the FULL reasoning loop against the named agent's own DO, not just a direct script fire).
    Webhook triggers are deliberately NOT routed through `event_triggers` (it only fires on
    structural in-space events, not `order.completed`/`message.received`) — fulfillment's
    `order.completed` is instead resolved directly by `billing/lemon-squeezy.ts`, routing to
    `launchpad-fulfillment-v1`'s own DO only when a project is actually bound to it
    (`isFulfillmentAgentBound`), never both agents for one event. Also rewrote the three
    Launchpad system prompts off "the Stripe/email/CRM tool" language onto the real script-native
    surface (`commerce`/`notifications`/`mcp-connector`/`script.find`). Full detail: appendix
    §A1.16.24.
29. **The billing worker was missing `workers_dev = false` and three money-in routes were gated
    only by a forgeable static header — now FIXED.** A1.16.8 (item 21) replaced this exact
    pattern everywhere else in the platform but missed `workers/billing`: `wrangler.toml` never
    set `workers_dev = false`, and `/internal/commerce/checkout`, `/internal/seats/checkout`,
    and `/internal/products/ls-variant` each checked a static `x-naelao-internal` string anyone
    reaching this worker directly could set. All three now use `requireInternalHmac`, matching
    `workers/spaces/src/index.ts`'s `/internal/*` convention. Callers updated to mint a real
    token: the `commerce` prebuilt's `checkout`/`seat_checkout` ops, and BOTH of
    `workers/spaces/src/index.ts`'s callers of `/internal/products/ls-variant` (product publish
    AND member/seat-billing enablement — the second call site wasn't in the original report,
    found by grepping every caller before touching the callee). `/webhooks/lemon-squeezy`
    untouched — its own Lemon Squeezy signature scheme is a different, already-correct
    mechanism. Full detail: appendix §A1.16.25.
30. **NEW DIRECTION IN PROGRESS — the "Three-Tier Platform Model" (Naelao → Builder → End User)
    is being built for real, not just the Space/SpaceType runtime we already have.**

    > **⚠ Ground-truth definition, corrected mid-build — read this before touching anything in
    > this item.** A **Product is a deployed Space, full stop.** Spec Section 48, verbatim:
    > *"NaelaoProduct is the core data model representing a Tier 1 builder's deployed product. It
    > wraps a configured Space."* The spec's own examples: **LexSpace, CodePilot, FirmAI** — a
    > legal tool, a coding tool, a law-firm tool. It is NOT a storefront, NOT a commerce concept,
    > and has nothing to do with what a Launchpad business happens to sell.
    >
    > **Journey 1B — "End User Joins a Builder's Product"** is the authoritative description of
    > what every end user sees, on every SpaceType, no exceptions: *"the product UI — threads,
    > sub-spaces, knowledge base — exactly as the builder configured it."* No commerce concept
    > appears anywhere in that journey. This is the manifest-driven Product Shell (Phase 6) —
    > the SAME rich shell serves the builder using their own product AND their signed-up end
    > users, exactly like Anthropic (the builder) ships Claude Code to its own end users who just
    > sign in with their own account.
    >
    > **Journey 2 — "Space Admin Sets Up a Launchpad Business"** is a *separate, lower-level*
    > thing: installing a Stripe app, uploading digital goods (courses/PDFs), fulfillment
    > webhooks, a storefront to sell them. This all happens *inside* one already-existing
    > Launchpad Product, as one OPTIONAL FEATURE that SpaceType happens to offer — it is never
    > what defines "product-ness," and a Product built on a different SpaceType (e.g. a coding
    > tool) has no storefront at all yet is just as much a Product.
    >
    > An earlier pass in this session's own chat (never committed to code or docs) conflated
    > these — described the storefront as competing with or separate from "the real product."
    > Corrected: every Product gets Journey 1B's shell; Launchpad Products can *additionally* run
    > Journey 2's storefront as one feature among several. Do not re-introduce this conflation.

    The original spec describes a fuller product layer the build never finished: builders get a
    real SaaS-style dashboard (launch wizard with custom domain, ongoing user/billing/analytics
    management), and every end user gets the Journey-1B product shell (threads, sub-spaces,
    knowledge base) — Launchpad end users may ALSO reach a public storefront or their own
    sub-space/business under a builder's reseller product, but those are additional features
    layered on top of the same baseline shell, not alternatives to it.
    Two load-bearing findings from re-reading the spec against the current code: (1) the backend
    for sub-spaces is ALREADY spec-correct and fully tested (`/spaces/:spaceId/sub-spaces` with
    `agency_shell`-gated mixed-type reselling, `/reseller/spaces` for fully independent
    businesses) but has **zero consuming UI anywhere**; (2) the SpaceType manifest already
    carries the exact UI contract the spec describes (`ui.operatorShell`/`ui.externalPortal`,
    typed in `SpaceTypeRegistryDO.ts` and populated for Launchpad in `launchpad-manifest.ts` —
    hidden core items, sidebar, default view, portal deployment type) but nothing renders it.
    Building: a `NaelaoProduct` field set (extending the existing `spaces` table, not a parallel
    table — avoids the split-brain anti-pattern the spec's own gap-appendix warns against),
    `BuilderAccountDO` (thin per-builder index + api-keys, reusing existing entitlements/
    reseller_ledger/RateLimitDO for usage/billing/rate-limiting rather than reimplementing them),
    `ProductUserDO` (the first persistent signed-in end-user concept — Launchpad end users are
    anonymous today), a Builder Dashboard API, the launch/domain wizard, ongoing management tabs,
    a manifest-driven Product Shell, and UI for the already-built sub-space/reseller mechanisms.
    Full phased plan + design decisions: appendix §A1.17 (filled in as each phase lands).
    **Landed so far — Phases 0-3** (of 8): Phase 0 consolidated two dead API-key UIs onto one
    typed `/builder/api-keys` shape (`dashboard/api-keys` canonical, `dashboard/settings` links
    to it); flagged `/v1/team/*` + `/v1/usage/*` as an equally-unbacked, out-of-scope gap. Phase 1
    added the NaelaoProduct foundation: migration `0044` adds ONLY `product_slug` (unique
    subdomain identity) + the conversation-access legal-audit pair as real columns — every other
    NaelaoProduct field extends `SpaceTypeProductConfig` (a `config_json` override, like member
    billing) to avoid a split-brain — plus `BuilderAccountDO` (thin per-builder product index +
    scoped `nbk_...` API keys; reuses entitlements/reseller_ledger/RateLimitDO for
    usage/billing/rate-limiting rather than reimplementing them). Phase 2 added `ProductUserDO`
    (the platform's FIRST persistent signed-in end-user — credit ledger, product-scoped session
    tokens, prefs, GDPR export; one instance per productId×endUserId). **Key resolved decision:**
    end users auth via the product's own `auth_provider` → a product-scoped `nps_...` session
    token validated against `ProductUserDO`, NEVER the platform builder JWT (which stays for
    owners/admins/Team collaborators) — this also fixes the broken end-user chat-auth gap item 23
    flagged. Credit ledger is a ledger only; token→credit conversion still settles through
    billing-core's `tokensToCredits()`, never re-derived. Incidental: fixed a real bug in the
    shared test helper `tests/unit/helpers/sqlite-do-shim.ts` (it silently dropped rows from any
    param-less `SELECT`, a pattern production code already relies on). **Phase 3 built the Builder
    Dashboard API** (`workers/spaces/src/builder-routes.ts`): `/builder/products*` CRUD (draft→
    active→paused→suspended→deleted, allow-listed), a domain wrapper around the already-existing
    CF-for-SaaS logic, a `product_end_users` roster (migration 0045, deliberately distinct from
    both SpaceDO's Team-collaborator `space_members` and the legacy Whop-era D1 one), honest
    analytics (real DAU/MAU, `credits_consumed: null` flagged rather than fabricated since it
    isn't bulk-aggregatable without Analytics Engine wiring this phase didn't add), and the
    triple-gated conversation-access endpoint (feature flag + Naelao-staff approval + end-user
    consent, ALL required, audits only successful disclosures, never message content) with its
    own dedicated 11-test file per the plan's call for security-review-grade coverage on that one
    endpoint. Auth resolves via either a router session header (how the Dashboard itself calls
    these, unchanged from every other builder route) or a Bearer `nbk_...` key routed through a
    pure-routing `builder_api_key_index` table (never a second authority — the key is always
    re-verified against its owning `BuilderAccountDO`). **Phase 4 built the Product Creation
    Wizard** (`apps/dashboard/src/app/dashboard/products/new/`, 7 steps + a Products list page).
    Found and fixed two real backend gaps before the wizard could work at all: `POST
    /builder/products` had reimplemented space creation from scratch (Phase 3's gap) instead of
    reusing the real, working `POST /spaces` logic — extracted into
    `workers/spaces/src/create-space.ts`'s `createSpaceRecord()`, now the single shared path for
    both routes; and `enforceSpaceQuota` queried a table called `organizations` that no migration
    anywhere creates (real table: `orgs`) — meaning `POST /spaces` had likely hard-500'd on every
    call in any real deployment, an undetected pre-existing bug since nothing tested that route
    before now. The wizard's Temple Gallery needed no new backend — it wraps the already-working
    `GET /templates` (real `LAUNCHPAD_TEMPLATES`) rather than fabricating entries for SpaceTypes
    that don't exist. A third instance of Phase 0's "UI calls a route no worker implements" bug
    was found (`dashboard/spacetypes/*`) and worked around, not fixed, by adding `GET
    /builder/space-types` (wraps `SpaceTypeRegistryDO`'s real registry) rather than resurrecting
    the legacy dead CRUD. UI verification (no playwright/puppeteer in this repo — used raw Chrome
    DevTools Protocol by hand) surfaced a real, separate, dashboard-WIDE bug in `auth-provider.tsx`
    (a hard reload of any nested `/dashboard/*` route bounces through `/login` back to the generic
    `/dashboard`, dropping the original path — reproduced on the pre-existing `/dashboard/clients`
    too) — flagged, not fixed, out of scope for a wizard feature. Once reached via realistic
    client-side navigation, all 7 steps render and validate correctly. **Phase 5 built the
    Product Detail management tabs** (7 tabs — Overview/Users/Analytics/Configuration/
    Feature-Flags/Billing/Danger-Zone — sharing one `ProductProvider` context so tabs don't each
    re-fetch the product) and the dashboard's first shared UI component,
    `ConfirmByTypingDialog` (type-the-exact-name-to-confirm, used for product deletion — stricter
    than `clients/page.tsx`'s existing two-click-confirm pattern). No new backend routes — every
    tab is a pure consumer of Phase 3's already-tested endpoints, so no new backend test file was
    needed. The Billing tab is explicit that per-product revenue and the account-wide wholesale
    statement are different numbers (`reseller_ledger` is tenant-scoped, not per-product — no
    fabricated per-product breakdown). The Users tab is explicit that it shows product end users
    only, not Team collaborators (still a structurally different, not-yet-listable population).
    UI verification this time mocked the backend entirely at the network layer via CDP's `Fetch`
    domain (fixing two non-obvious gotchas — CORS preflight `OPTIONS` handling and
    `Access-Control-Allow-Origin` on mocked responses — worth remembering for any future session
    using this technique), letting all 7 tabs be exercised with realistic data end-to-end,
    including the feature-flag toggle round-trip and the delete-confirmation button's
    disabled/enabled states. **Phase 6 (Manifest-driven Product Shell) is IN PROGRESS.** Scope
    correction from the user: the Product Shell mockup driving this phase is the rich agentic
    workspace (sidebar, Projects/Threads, chat, Agents panel) a builder ships to their OWN end
    users — not a simplified widget. This means `launchpad-manifest.ts`'s
    `hiddenCoreItems:["threads","projects"]` was written for a narrower framing than what's
    wanted; the manifest field itself stays real, just don't assume it applies broadly. Before
    any shell UI, found and fixed two real, independent bugs blocking it entirely: (1) the
    router required a platform JWT unconditionally with zero path for a ProductUserDO-
    authenticated end user — fixed with a narrow allowlisted hybrid-auth check (Bearer `nps_...`
    + `x-naelao-end-user-id` on `/spaces/:spaceId/sessions*` only), verified via a new
    `POST /internal/product-sessions/verify` on the spaces worker (platform-secret-gated, same
    precedent as `/internal/space-types/seed`, since the router can't know the tenant until
    after verifying); (2) even with valid auth, session/message CRUD would have 404'd — the
    router sent ALL of `/spaces/:spaceId/sessions/*` to `AGENTS_WORKER`, but that worker only
    ever implemented the `agent/run`/`approvals` sub-paths; the real session/message CRUD lives
    in `SPACES_WORKER` (→ SpaceDO). Split the route (agent-run/approvals sub-paths first, so
    they still win; bare session/message CRUD → SPACES_WORKER) and updated an existing test that
    had asserted the old (wrong) destination against a stub that could never have caught it not
    actually being implemented there. New `UserRole` value `"product_end_user"` added
    (additive; `packages/auth/src/rbac.ts` fails closed — empty permissions). Remaining for
    Phase 6: the portal's end-user login against ProductUserDO (today's `account.ts` is legacy
    Whop-niche code, and the magic-link routes are a 4th instance of "UI calls a dead route" —
    to be replaced, not fixed, since Phase 2 already decided ProductUserDO sessions supersede
    it), then the actual shell UI reusing the now-reachable SSE chat mechanism. **Mid-phase scope
    correction from the user:** a "Product" is a deployed Space, full stop — not a storefront or
    any commerce concept (spec Section 48: "NaelaoProduct... wraps a configured Space"; examples
    given are LexSpace/CodePilot/FirmAI). Journey 1B's end-user product UI (threads, sub-spaces,
    knowledge base) is universal across every SpaceType; Launchpad's storefront/commerce is a
    separate, optional FEATURE some Products run, not what defines a Product. Then closed the
    identity-verification gap `ProductUserDO` deliberately left open (it mints/verifies sessions
    but never verified WHO someone is): `workers/spaces/src/product-end-user-routes.ts` adds real
    `POST /spaces/:spaceId/end-users/{signup,login}` (email+password, PBKDF2-hashed, migration
    0046 extends the `product_end_users` roster rather than forking a table) for
    `authProvider:'naelao-native'` products, registered on the router's unauthenticated path like
    `/v1/auth/*`. Also found and fixed: the browser's native `EventSource` can't set custom
    headers, so the SSE stream endpoint had no way to carry the Bearer token the new hybrid-auth
    check requires — router now also accepts `?session_token=&end_user_id=` query params, but
    ONLY on GET (the stream endpoint's only real caller), so this doesn't quietly widen the
    allowlist. 880/880 tests pass.

    **Phase 6 continued — shell data layer, a real pre-existing routing bug found and fixed, and
    a corrected router-allowlist scope.** Building the shell's data layer (new
    `GET /spaces/:spaceId/shell/manifest` safe-projection endpoint, `GET/PATCH
    /spaces/:spaceId/product-users/me`, a new `GET /spaces/:spaceId/sessions` list route) surfaced
    that the originally-planned router-allowlist additions (`/projects`, `/threads`,
    `/agent-definitions`, `/scheduled-jobs`) would have been WRONG: each already carries an
    explicit "builder-only, confirmed never end-user-facing" comment in
    `workers/spaces/src/index.ts`, and `/threads`' own comment states end-user chat transport is
    `/sessions`, not `/threads`. Worse, `resolveProductEndUserClaims` sets an end user's
    `claims.tid` to the space's OWNING tenant (so internal-HMAC proxying works) — so a
    tenant-match-only gate (e.g. `scheduled-jobs`' `loadOwnedSpace`) would have silently started
    accepting end-user traffic the moment it was allowlisted, never having been audited with that
    caller in mind. Corrected allowlist: `shell/manifest`, `kb/documents` + `kb/search` (read),
    `product-users/me`, and the existing `sessions*` — Projects (Cycles), the structural Threads
    browse, the Agents (definitions) page, and Crons stay **builder-operator-only** in the shell
    (already reachable via JWT, no new allowlist entry). A genuinely new, narrowly-scoped
    `GET /spaces/:spaceId/sessions` (list) was added to SpaceDO/spaces-worker instead — for a
    product end user it derives `end_user_id` **only from verified claims**, never a
    client-supplied query param (tested explicitly: a caller authenticated as one end user cannot
    read another's sessions by passing `?end_user_id=`).

    While wiring this up, found and fixed a genuine **pre-existing** bug (confirmed present
    against git HEAD, before this pass touched anything): `POST /spaces/:spaceId/sessions`
    (session CREATE — the mechanism every end-user chat surface depends on, including the
    existing SSE widget) was **completely unreachable**, silently 404ing. Root-caused with a
    reduced reproduction: Hono's RegExpRouter throws `buildMatcherFromPreprocessedRoutes` (an
    internal error, silently caught by SmartRouter, which falls back to a TrieRouter that ALSO
    mismatches) once this app's route table reaches a certain scale, when a multi-segment dynamic
    route ending in a static suffix (`/internal/space-types/:id/record-install`) coexists with an
    unrelated static sibling for the same method one segment shallower
    (`/internal/space-types/seed`, POST) — a genuine Hono limitation, not application logic,
    that silently corrupted **POST routing for the whole app**. Fixed by renaming the low-traffic
    internal route to `/internal/space-types-record-install/:id` (static segment before the
    dynamic one; the provisioner's one caller updated alongside) and, as belt-and-suspenders,
    gating that route plus `/internal/space-types/:id`, `/spaces/:spaceId/sessions*`,
    `/spaces/:spaceId/members*`, and `/spaces/:spaceId/agent-definitions*` inline instead of via a
    separate `app.use(dynamicPattern, requireInternalHmac(...))` registration (the same
    combination verified to work together). The members/agent-definitions fix was not
    theoretical: their own "rejects with no internal token" tests started failing OPEN (500
    reaching the handler instead of 403) the moment the record-install rename fixed one part of
    the same corruption elsewhere, proving the fail-open risk was real. Also fixed in passing: the
    session proxy's `new Request(..., { body: c.req.raw.body })` needs `duplex: "half"` for
    spec-compliant fetch implementations (Node's undici, used by this repo's own tests) whenever a
    streaming body is attached — never hit before because the whole route was unreachable.
    **Not fixed elsewhere**: the same `app.use(dynamicPattern, requireInternalHmac(...))` pattern
    recurs at several more call sites in this file (`registry`, `assistant-policy`, `projects`,
    `internal/business-services`, `internal/member-billing`) — each may or may not actually
    collide with a same-method static sibling; auditing and fixing all of them is a separate,
    dedicated pass, not silently expanded into this one. 893/893 tests pass.

    Remaining for Phase 6: the actual shell UI (sidebar, Projects/Threads, chat) — the only piece
    left before an end user can sign up and use a Product for real. Remaining after 6: 7
    (sub-space/reseller UI), 8 (deferred product-sdk + per-product CF Pages deploy).

    **A full-vision execution plan for the shell UI + everything around it (businesses, invites,
    builder reskin, monetization) is now underway, phased A-E — see
    `docs/spec-appendix/A1-script-agents-and-space-assistants.md` §A1.17 continued for the
    per-phase detail; this line just tracks top-level status. Phase A (design
    system + shell skeleton) is BUILT:** new `packages/ui` (tokens.css + styles.css ported
    verbatim from the `apps/launchpad/src/index.html` mockup, consumed as plain global CSS by
    both the new shell and — in Phase D — the reskinned dashboard, so they never fork the same
    stylesheet twice) and new `apps/shell` (Next.js 14, `/p/[slug]` product resolution, hybrid
    `nps_...` auth ported from `apps/portal`, an `AuthProvider` built with an `isHydrated`
    tri-state from day one — the dashboard's own `AuthProvider` still has the hydration-redirect
    bug this pattern is meant to avoid, unfixed until Phase D. One new
    backend route, `GET /v1/products/by-slug/:slug` (spaces worker + router unauthenticated
    allowlist), resolves a product from its slug pre-login. 897/897 tests pass. **Phase B (chat +
    Projects + Threads) is BUILT:** new `requireBusinessMembership` gate
    (`workers/spaces/src/business-auth.ts`) is additive-only for `product_end_user` callers —
    every builder role's access is unchanged — and per-method (projects/threads allow GET+POST,
    never their admin-only rules/spend/PATCH sub-paths; agent-definitions allows GET only).
    Router allowlist grew accordingly, capped so `/projects/:id/rules` etc. still don't match.
    `product-sessions/verify` gained a parent-walk for child business spaces (unexercised until
    Phase C actually creates one, but the security model is settled now rather than later).
    `apps/shell` gained a real chat surface (`Chat.tsx`, ports `apps/portal`'s SSE client onto
    the mockup's markup), Projects/Threads views, and a real (not placeholder) sidebar. Chat
    sessions and structural threads are still separate tables with no server link — a documented,
    deliberate approximation, not a bug. Incidental fix: `forwardToSpaceDO` needed `duplex:
    "half"` for streaming bodies (same defect class already fixed once for the session proxy).
    908/908 tests pass (15 new). **Phase C (businesses, space switcher, invites, multi-template)
    is BUILT.** Found and closed a real cross-business security hole in the process: Phase B's
    `requireBusinessMembership` treated every `product_end_user` as a flat "member" — safe for the
    product root (a verified session IS scoped to it) but NOT for a business space, since
    `ProductUserDO` sessions are product-scoped, not per-business, so any end user could have
    reached any other end user's business by changing `:spaceId` in the URL. New
    `resolveEndUserBusinessRole` (`business-auth.ts`) requires an active `business_memberships`
    row (migration `0047`, an index table like `builder_api_key_index` — SpaceDO's own
    `space_members` stays authoritative) for anything that isn't the product root. New
    `business-create.ts` extracts `createBusinessForEndUser` so the new product-scoped
    `POST /spaces/:productSpaceId/businesses` and the original `POST /reseller/spaces` share one
    implementation instead of two that could drift. New `business-routes.ts`: the creation
    wrapper (dual-writes `business_memberships` + best-effort SpaceDO member mirror), `GET
    .../my-businesses` (the switcher's list), and invite create/accept with a single-use,
    7-day-expiring, hashed token — deliberately requiring the accepting identity to already hold a
    product session rather than trusting an emailed link alone (this codebase's standing
    convention). `GET/DELETE .../business-members` is a purpose-built safe projection, NOT a
    relaxation of the already-hardened generic `/spaces/:id/members*` proxy (different
    population). Multi-template: `agentsForTemplates` unions agent lists across templates deduped
    by id; `installLaunchpadAgents`'s templateId param widened to also accept an array (every
    existing single-id caller unchanged); provisioner step 9b merges bootstrap projects/
    setup_scripts across every template. `shell/manifest` gained `membership_model` +
    `allowed_child_space_types` (safe pre-auth — gates a UI affordance only, never data access).
    `apps/shell` gained a real space switcher, a Spaces view with a create-business dialog
    (template multi-select, hardcoded to match `LAUNCHPAD_TEMPLATES` since no end-user-reachable
    `/templates` route exists yet), and a business detail view with member management +
    invites. Deliberately NOT done: switching to a business does not re-scope chat/projects/
    threads to operate on it — Home/Projects/Threads still run on the product root; that's a real
    architectural question (URL structure, active-space state) left for its own pass rather than a
    rushed bolt-on. 937/937 tests pass (21 new, including a dedicated cross-business isolation
    test file). **Phase D (builder UI reskin + config) is BUILT.** Fixed a real bug, confirmed
    with a live headless-Chromium CDP session (no Playwright in this environment — driven via raw
    CDP over Node's built-in `WebSocket`): `apps/dashboard`'s `auth-provider.tsx` had the exact
    same hydration-redirect bug `apps/shell` was built to avoid from day one — `DashboardLayout`'s
    redirect effect is a CHILD of `AuthProvider` and React fires child effects before parent
    effects within one mount commit, so on every hard reload of a nested `/dashboard/*` route the
    redirect ran before `AuthProvider`'s own localStorage-hydration effect, saw the default
    `isAuthenticated: false`, and bounced to `/login` even with a valid token in storage. Added
    `isHydrated` (same pattern as `apps/shell`) and verified BOTH directions with a real browser:
    a valid stored token survives a hard reload of `/dashboard/clients`; an explicitly-cleared one
    still redirects. Reskin: retargeted `tailwind.config.ts`'s `brand` color scale onto the
    mockup's actual accent (`packages/ui/src/tokens.css`'s `#5b52f0`) so every existing
    `bg-brand-*`/`text-brand-*` utility across all ~25 pages updates instantly with zero markup
    changes; imported `@naelao/ui`'s tokens+styles globally; rebuilt `DashboardLayout`'s chrome
    with `@naelao/ui`'s `Sidebar`/`TopBar`/`Badge` (a real component swap, not just palette
    changes — `Sidebar`'s project/thread/switcher sections are optional and simply don't render
    for an admin nav). IA: nav collapsed to Dashboard/Spaces (relabeled "Products")/Clients
    (kept — a deliberate deviation from the phased plan's literal 3-item list, since dropping
    real working reseller functionality was never actually requested)/Settings. Removed
    `/dashboard/spacetypes/*` (dead on two axes: calls `GET /spacetypes`, a route no worker
    implements, AND links to a `/dashboard/spacetypes/:id` detail page that never existed —
    also conceptually obsolete per CLAUDE.md #7, Naelao authors all SpaceTypes now), `/dashboard/
    usage/*` and `/dashboard/team/*` (both call the `/v1/usage/*`/`/v1/team/*` routes Phase 0
    flagged as an unbacked, out-of-scope gap and never fixed) — fixed two dangling links this
    exposed. Config: Configuration tab gained a Product Mode picker, a Limits section, and a
    Templates Catalog — the first two round-trip through `PATCH /builder/products/:id`'s existing
    handler with ZERO backend changes (the fields already existed on `SpaceTypeProductConfig`);
    the catalog needed one new field, `productConfig.catalog.businessTemplates`, plumbed through
    `shell/manifest` so `apps/shell`'s create-business dialog can actually be narrowed by it
    (empty/unset = every template, non-breaking default). New read-only Agents tab (hardcoded
    core-agent list, same simplification precedent as the templates lists) — per-agent
    enable/disable was explicitly NOT built since it would require threading a new field into the
    provisioner's install step, flagged as a real follow-up rather than rushed in. Verified the
    Configuration/Agents tabs end-to-end via a second CDP session mocking `GET /builder/products/
    :id` and screenshotting the pre-populated, correctly-checked form. 938/938 tests pass (1 new),
    `pnpm turbo run typecheck` clean (75 tasks). **Phase E (monetization) is BUILT.** Precondition:
    fixed `@naelao/entitlements` querying `organizations`/`tenant_id` columns that don't exist
    (real: `orgs`/`org_id` — confirmed `NaelaoJwtClaims.tid` literally means org id) and found the
    same bug plus two more in `workers/admin` while there (a feature-flags route shape migration
    0023 never created, and `/admin/stats` querying a `sessions` D1 table that has never existed —
    both 500'd on every call). Also found and fixed a real migration-history bug: migration 0022's
    `CREATE TABLE IF NOT EXISTS api_keys` was a no-op against 0004's earlier, different-shaped
    table, so its own index creation has silently failed in every deployment since (new migration
    0048 fixes it forward). Main build: a business subscribes to a builder-defined plan as a whole
    (mirroring `memberBilling`'s "the whole space pays" shape, per the plan's own migration-name
    hint), while credit packs top up an individual end user's own balance —
    `productConfig.pricingConfig.plans/creditPacks`, provisioned as real Lemon Squeezy variants via
    `PATCH /builder/products/:id/pricing` (provision-once-per-item, same pattern as memberBilling).
    A business resolves the catalog by walking up to its product root (`loadPricingCatalog`, the
    same parent-walk `/internal/product-sessions/verify` established) via `GET
    /spaces/:spaceId/pricing`; new billing-worker routes
    `/internal/business-subscriptions/checkout` and `/internal/credit-packs/checkout` follow the
    existing commerce/seat checkout pattern exactly. New migration 0049 (`business_subscriptions`,
    one row per business, upserted not accumulated) plus LS webhook handling for
    `subscription.*`/credit-pack `payment.success` events. Closed a real double-grant risk the
    credit-pack path introduced: converted `ProductUserDO`'s ad-hoc `CREATE TABLE IF NOT EXISTS`
    schema init to `@naelao/db`'s versioned `applyMigrations` (matching `SpaceDO`'s convention) and
    added a real migration giving `credit_ledger` an idempotency key. Frontend: a 9th dashboard
    product tab (Pricing, with live Provisioned/Not-provisioned badges) and a Shell billing section
    on the business detail page (Subscribe / Buy Credits, redirecting to the LS checkout URL).
    973/973 tests pass (34 new + the precondition's 11), `pnpm turbo run typecheck` clean (75
    tasks). Not verified against a live multi-worker backend or a real Lemon Squeezy sandbox — the
    dev-fallback checkout path is what every automated test exercises, same stated limitation as
    every prior phase.
31. **Launchpad go-live is now IN PROGRESS (a follow-on to the Three-Tier build, phases F onward —
    full plan including the larger script-engine/execution-ladder/container roadmap is tracked in
    the active session's plan file).** Verified gaps blocking a deployable, Whop-first Launchpad
    product: the `coming_soon` template flag existed but was never set on anything; the business-
    builder Space Assistant (the actual differentiator vs. competitors like Polsia) didn't exist;
    and builder domain/name management had no post-creation UI despite a real CF-for-SaaS backend.
    **Phase F (Whop-first rollout + explicit Custom option) is BUILT.** Set `coming_soon: true` on
    the six non-Whop `LAUNCHPAD_TEMPLATES` (creator-store, newsletter-business, micro-saas,
    service-agency, coaching-community, customer-service) — `whop-seller` stays live. New
    `loadTemplateCatalog()` (`workers/spaces/src/index.ts`) is a KV-cached call to the agents
    worker's real `GET /templates` via the existing `AGENTS_WORKER` binding, projected into a new
    `template_catalog` field on `GET /spaces/:spaceId/shell/manifest` (intersected server-side with
    the builder's `businessTemplates` narrowing) — the single source of truth both
    `apps/shell`'s create-business dialog (coming-soon templates greyed with a badge, plus a new
    explicit "Custom — build from scratch with the assistant" toggle mapping to `template_ids: []`)
    and `apps/dashboard`'s Configuration Templates Catalog now render from, replacing two
    hand-maintained, drift-prone hardcoded copies. A test asserting the real agents-worker response
    shape (`{templates: [...]}`, not `{data: [...]}`) caught a real bug in the first draft before it
    shipped. 977/977 tests pass (4 new), `pnpm turbo run typecheck` clean (75 tasks), both apps
    verified via `next build`. **Phase G (business-builder Space Assistant) is BUILT.**
    `LAUNCHPAD_ASSISTANT_PROFILE` (`workers/agents/src/script-engine/profiles.ts`) gives the
    Launchpad assistant (same `agentId: "naelao-agent"` every dispatcher hardcodes) a
    "Business-Building Methodology" — discover → propose Whop-first options → scaffold on approval
    → launch checklist → recurring revenue review — leaning into honest escalation/transparency as
    the differentiator from "runs while you sleep" black-box competitors like Polsia, rather than
    defaulting to full autonomy. New `workspace-admin` prebuilt
    (`workers/agents/src/script-engine/prebuilt/workspace-admin.ts`) is what lets the assistant
    actually scaffold a business, not just describe a plan: `project.create_from_template` (mirrors
    the agents worker's own 4-step from-template sequence directly against the spaces-worker
    binding, since a DO can't call its own Worker's router), `project.list`, `project.configure`,
    `agent.list`. The autonomy toggle reuses the already-built `assistant_policy` gate — no new
    engine — but needed two real fixes to actually work: the Space Assistant's gate list comes
    exclusively from `assistant_policy` (its `AgentConfig.requiresApprovalFor` is ignored), and
    that table has no provisioning-time seed anywhere in the codebase, so a fresh space would
    default to gating even harmless reads. New `seedLaunchpadAssistantPolicy` seeds a "guided"
    default (`always_ask` + a read-only auto-approved allowlist) at install time, best-effort like
    `seedOwnerMember`. Builder-facing Guided/Autonomous toggle added to the dashboard's existing
    Agents tab, calling the already-HMAC-gated `/spaces/:spaceId/assistant-policy` route directly.
    Deliberately NOT exposed in the shell yet — that route only checks tenant-match, not per-
    business ownership, so allowlisting it for end users needs a `requireBusinessMembership`-style
    floor first, flagged as a real follow-up. A planned skill-library seed (G3) was deliberately
    NOT built as a separate step: an unembedded skill is unfindable by `script.find`'s ANN search,
    so half-building it would be worse than folding the methodology into the profile's prompt
    directly, which is what happened instead. 987/987 tests pass (10 new), `pnpm turbo run
    typecheck` clean (75 tasks), `apps/dashboard` verified via `next build`.
    **Phase H (builder domain/name post-creation UI) is BUILT — Launchpad go-live (F/G/H) is now
    COMPLETE.** New Domain tab (`apps/dashboard/.../products/[productId]/domain/page.tsx`) renders
    the already-real CF-for-SaaS backend's DNS/DCV records (CNAME + TXT) and status
    (not_configured/pending_dns/active) with a "Check status" re-poll button — closing the gap
    where the creation wizard's domain call was fire-and-forget with its DNS instructions
    discarded and no way to view or retry them after creation. Added a Product Name field to the
    Configuration tab, wired to the already-existing `updateBuilderProduct(id, {name})` (the PATCH
    handler already accepted `name`; there was just no input for it). No backend changes — both API
    functions already existed. Verified via `next build` AND a real headless-Chromium CDP session
    (the established Fetch-mock technique): screenshots confirm the Domain tab renders a real
    "Pending DNS" badge + connected domain + both DNS records from mocked data, and the
    Configuration page's Name field is pre-populated correctly.
32. **Phase I (Code-Mode multi-MCP workflow engine) is BUILT, scoped.** Goal: let ONE
    agent-authored script deterministically chain several MCP servers (get data from A, act on B)
    instead of that composition only happening across separate model-driven reasoning-loop turns.
    New `ctx.mcp.{call,list_servers,list_tools}` injected into the Tier 2-4 Worker Loader isolate
    (`workers/agents/src/script-engine/code-runner.ts`) whenever `mcpHubWorker` is wired — loops
    back to the same `naelao-mcp-hub` worker the `mcp-connector` prebuilt already uses, with the
    isolate receiving only a short-lived (60s), tenant-scoped internal token, never a credential or
    the platform secret. A real bug was caught before shipping: the Worker Loader caches isolates
    by id and won't refresh `env` on a warm hit, which would have silently staled the 60s token —
    fixed by folding a 45s time bucket into the lock id, only for scripts that use `ctx.mcp`, so
    other scripts' isolate-reuse cache rate is unaffected. Hardened mcp-hub with
    `requireInternalHmac` (its only real ingress was already direct service bindings, never the
    router, but every other internal-only worker has this backstop) and found + closed a real gap:
    the reserved-tool-name guard (money-in tool names reserved to `commerce`) existed only inside
    the `mcp-connector` prebuilt client, so the new `ctx.mcp.call` isolate path would have bypassed
    it entirely — mirrored the guard into mcp-hub itself so it's enforced for every caller, not just
    one. Wired real LLM-usage billing to the end-user sink: new `POST /internal/product-users/
    :spaceId/:endUserId/credits/deduct` wraps `ProductUserDO`'s existing fails-closed
    `/credits/deduct` (the sink already existed; nothing ever called it), debited from
    `NaelaoAgentDO.handleScriptRun` for non-project Space-Assistant runs by a signed-in product end
    user. No new "codemode" authoring mechanism was needed — the reasoning loop's existing `distill`
    action already lets a model author any Tier-2 script, so `ctx.mcp` alone makes multi-MCP
    workflow scripts possible. **Deliberately deferred (documented, not dropped):** per-user MCP
    credential resolution (needs a new "acting end-user id" field nothing currently populates), and
    the `space_credits` billing sink for builder/team-owned runs (that table has zero existing
    read/write code anywhere — a real feature to build, not a wiring job). 1003/1003 tests pass (16
    new), `pnpm turbo run typecheck` clean (75 tasks). Next: Phase J (Workflows tier), K
    (per-project R2-mounted container), N (Launchpad operator-shell UI + cleanup) — full roadmap
    including Phases L/M in the session's plan file.
33. **Phase J (Durable Workflows tier) is BUILT.** A long-running/cron script now runs as a real
    Cloudflare Workflow instead of holding a Tier 2-5 isolate or the agent DO open the whole time.
    New `ScriptMetadata.runtime: "isolate" | "workflow"` (default `"isolate"`, orthogonal to
    `requires_tier`) — `execution-ladder.ts` routes a `runtime:"workflow"` script to a new
    `WorkflowRunner` (`ScriptEngineEnv.workflowRunner`) instead of `codeRunner`, returning
    immediately with `{workflow_id, status:"started"}` rather than blocking; degrades honestly
    (`ok:false`) when unwired, same precedent as every other optional binding. The workflow IS an
    ordinary stored script tagged `runtime:"workflow"`, not a second store: `dynamic-workflow`'s
    `workflow.create/run` ops (previously always "not available" — the orchestration hooks were
    never actually wired) now delegate straight to `ScriptToolSurface.create/run`, and
    `workflow.schedule` just writes a normal `scheduled_jobs` row — the existing cron dispatcher
    (`runScheduledJobs`/`fireScriptDirectly`) needed zero changes; the routing to a durable Workflow
    instance happens transparently the moment `ScriptToolSurface.run()` resolves the script's own
    tag. New `ScriptRunWorkflow` class (`workers/agents/src/workflows/`, binding
    `AGENT_SCRIPT_WORKFLOW`, separate from `AgentTaskWorkflow`'s different payload shape) has one
    durable step that re-resolves the script BY NAME through a new HMAC-gated
    `POST /internal/scripts/run-durable` → the existing `fireScriptDirectly` →
    `agent-do/triggers/fire` path (identical shape/gate to `/internal/triggers/fire`) — so it never
    carries code through Workflow instance params, and an edit to the script between schedule and
    fire is picked up automatically. Restructured `buildOrchestrationHooks` (it previously
    `return {}`ed entirely when `NAELAO_AGENT_DO` was absent, which would have also silently
    dropped the workflow hooks even though they don't need that binding) so sub-agent and workflow
    hooks are gated independently. 1013/1013 tests pass (10 new: workflow-tier routing + the new
    route's HMAC auth boundary), `pnpm turbo run typecheck` clean (75 tasks). Next: Phase K
    (per-project R2-mounted container), N (Launchpad operator-shell UI + cleanup) — full roadmap
    including Phases L/M in the session's plan file.

> **Keep this section current.** As direction evolves, update this block and the appendix,
> and commit — future sessions rely on it.

## Critical Distinction
- **SpaceType** = blueprint / product definition (what the Space IS)
- **Template** = configurable selection a builder makes (no coding ever)
- Builders configure via UI only — never write code (security requirement)

## Stack
- CF Workers (router, auth, spaces, agents, knowledge, billing, etc.)
- CF Durable Objects + DO SQLite (`SpaceDO` = structure/agent_definitions, `NaelaoAgentDO` = agent runtime, sessions, memory)
- CF R2 (KB documents, exports, backups, artifacts)
- CF Vectorize (KB semantic search — shared multi-tenant index with spaceId filter)
- CF KV (circuit breakers, config cache, session revocation, portal routes)
- CF Queues + DLQ (async events, webhook delivery, analytics, notifications)
- CF Workflows (provisioning, erasure, ingestion, billing, dunning)
- CF Analytics Engine (events, metrics — append-only, 25M rows/day limit)
- D1 (platform metadata, billing, users — single instance today; sharding a named future milestone)
- LLM: Anthropic Claude (primary) with fallback chain
- Stripe (billing + Connect + Meters)
- Next.js on CF Pages (builder dashboard)

## DO SQLite Pattern — CRITICAL
```ts
// CORRECT — ? placeholders only
this.ctx.storage.sql.exec("SELECT * FROM t WHERE id = ?", id);
// WRONG — named params do not exist in DO SQLite
this.ctx.storage.sql.exec("SELECT * FROM t WHERE id = :id", { id });
```
WAL mode: `PRAGMA journal_mode=WAL` at DO init. 10GB limit per DO.
DO hibernation kills ALL in-memory state — always persist to SQLite.

## Key CF Invariants
- KV eventual consistency ~60s — never use for rate limiting
- Analytics Engine: append-only, 25M rows/day, ClickHouse dialect, no DELETE
- CF Workflows: 1000-step limit, 30s per step, JSON-serializable state
- Queues: at-least-once delivery, 5000 msg/sec limit, 128KB msg max, 4-day retention
- Vectorize filter: `{field: {$eq: value}}` — no nested filters
- Workers sub-request limit: 1000 per invocation
- Workers script size: 10MB compressed max

## Security Requirements
- Never hardcode secrets — CF Workers Secrets only
- All tenant data namespaced: `{tenantId}:{resourceType}:{resourceId}` in KV
- DO names: `HMAC-SHA256(tenantId, PLATFORM_SECRET):{type}:{resourceId}`
- Input moderation before every LLM call
- Output safety check after every LLM response
- KB chunks wrapped in `<kb_content>` XML tags (prompt injection protection)

## Monorepo Structure
- `packages/*` — shared libraries (@naelao/types, @naelao/auth, @naelao/db, etc.)
- `workers/*` — CF Workers (router, spaces, agents, knowledge, billing, etc.)
- `apps/*` — CF Pages frontends (dashboard, product-portal, widget, marketplace)
- `infra/` — Terraform IaC, migration scripts, dev tooling
- `tests/` — integration, e2e, contract, isolation, load tests

## Git
**Active branch: `claude/naelao-missing-gaps-pass-6kb300`** — work here; do NOT push to any
other branch without explicit permission. Commit after every working subsystem; push after
every commit. (Older branches `...-8vkakf` and `...-713ruz` are superseded.)

## Build Progress
- [x] Phase 0: Scaffold (root workspace, packages, workers structure)
- [x] Phase 1: Foundation (router worker, auth, SpaceDO, D1 migrations)
- [x] Phase 2: KB System (knowledge worker, Vectorize ingestion, hybrid retrieval)
- [x] Phase 3: LLM Gateway + Agent Runtime (llm-gateway, agent loop, tool framework)
- [x] Phase 4: Billing (Stripe webhooks, subscriptions, metering)
- [x] Phase 5: Builder Dashboard (Next.js on CF Pages, all pages)
- [x] Phase 6: Space Shell / Product Portal (SSE streaming, i18n, magic link auth, feedback)
- [x] Phase 7: Async Systems (Queues consumers, Workflows, all 28 workers)
- [x] Phase 8: Analytics + Observability (analytics-schema, tracing, logger packages)
- [x] Phase 9: Security Hardening (PBKDF2 G-B02, JWT pin G-B01, moderation, SSRF, env validation)
- [x] Phase 10: Test Suite (449 tests across 45 suites — crypto, moderation, entitlements, webhooks, analytics-schema, idempotency, auth, rag, security, llm-gateway, spacedo, auth-flow, api-schema, tenant-isolation, script-engine, sub-agents, memory, channels, billing, events, and more)

## Additional Infrastructure Built
- [x] Terraform IaC (cloudflare/cloudflare ~4.45, all KV/R2/D1/Queues/Vectorize/Pages resources)
- [x] GitHub Actions CI/CD (ci, bundle-check, pr-checks, deploy-staging, deploy-prod)
- [x] D1 migrations 0001-0028 (all tables including marketplace, threads, eval, artifacts, gdpr, etc.)
- [x] apps/widget/ (zero-dependency web component, SSE streaming, < 10KB gzip target)
- [x] apps/marketplace-web/ (SpaceType discovery, categories, listing detail, fork flow)
- [x] All 14 packages: types, auth, db, http, rag, security, llm-gateway, config, crypto, logger, tracing, idempotency, webhooks, analytics-schema, entitlements, tool-runtime, billing-core, moderation, testing, client-sdk, agent-sdk

## Spec Reference
**Canonical spec:** `/home/user/Naelao-1/naelao_expanded_gaps_resolved.html` (6.8 MB).
2260+ numbered gaps (G-A01 through G-BE50). Each gap has:
- The Gap: what is missing
- Required Fix: exact implementation to build
When implementing, cite the gap ID you are fulfilling.

**Read it top-to-bottom for any topic** — later sections add updates/appendixes/fixes that
override earlier ones (see CURRENT DIRECTION #5). It's a binary-matching file; use
`grep -a` / `python3` to extract a section, and read the whole topic before coding.

- `naelao_whop_businesses_spec.html` — the abandoned niche-only assumption. Do not build to it.
- `docs/spec-appendix/A1-script-agents-and-space-assistants.md` — our additions (script
  engine, Space Assistants, capability kernel, manifests). Keep current.
- `docs/SPEC_HEADER_INDEX.md` — section index into the canonical spec.
