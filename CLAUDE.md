# Naelao Platform — Claude Code Session Guide

## What is Naelao
A Cloudflare-native AI agent platform. Builders create SpaceTypes (blueprints) and configure Templates (no coding — builders select/configure only). End-users interact via Space shell. Designed for millions of builders and millions of Spaces.

## Session working notes
- This session is using the local `main` branch as the primary working branch. If a short-lived topic branch is needed, it should be created from `main`, and any commits made there should be merged or cherry-picked back into `main` before the work is considered complete.
- Before branching off from `main`, check for any commits that may already exist on `main` from the user or from a prior session and sync them into the topic branch before continuing.
- The shell already exposes `CLOUDFLARE_API_TOKEN` for Cloudflare API calls (for example via `curl` against the deployed Workers/D1/KV/Pages APIs). Do not print or commit the secret value.
- Any substantive progress made in this session should be recorded here so the repo guidance stays current for follow-up work.

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
34. **Phase K (per-project, R2-mounted Tier-5 container) is BUILT.** Fixed the two things spec
    §33b requires that verifiably weren't true before this pass: `runContainer` addressed the
    sandbox DO per-`{space,agent}` (`sandbox:{spaceId}:{projectId ?? "_assistant"}` now, matching
    `workspacePrefix()`'s own scoping — two threads' agents in the same project now share ONE
    container), and the harness only ever used a `mkdtemp`+`rm` scratch dir (nothing survived past
    a single call). Since Cloudflare Containers have no native R2 filesystem mount, `ToolSandboxDO`
    approximates one at the request layer: before forwarding `/exec`, it reads the project's R2
    workspace (the SAME bucket/prefix Tier-1 `r2-workspace` already reads/writes) and hands the
    files to the harness as `workspace_files`; on response it writes back the harness's reported
    `/workspace` contents (`workspace_files_out`), deleting anything the script removed — R2 stays
    the persistent source of truth, so a cold-started container still sees the same files (bounded:
    300 files / 2MB per file / 25MB per call, text-only, matching the platform's existing R2-
    workspace convention). The harness (`container/server.mjs`) materializes/collects `/workspace`
    around the run (collected on both success AND failure, so a script that writes files before
    throwing doesn't lose that work) and passes `ctx.workspaceDir` to stored scripts — deliberately
    NOT a global `process.chdir()` (a real concurrency hazard for a long-lived Node process serving
    overlapping requests to the same warm container). `code-exec.ts`'s `PYTHON_HARNESS` gained
    `cwd: ctx.workspaceDir || "/workspace"` to match `BASH_HARNESS`'s existing (previously silently
    non-functional, since nothing populated `/workspace`) convention — both prebuilt harnesses now
    actually land in the synced, persistent workspace they always claimed to. 1023/1023 tests pass
    (10 new: R2 sync in/out/delete, cross-thread-same-project sharing, cross-project isolation,
    space-scoped fallback, no-R2-bound skip, plus 3 addressing tests). `pnpm turbo run typecheck`
    clean (75 tasks). Next: Phase N (Launchpad operator-shell UI + cleanup) — full roadmap
    including Phases L/M in the session's plan file.
35. **Phase N (Launchpad completeness) investigated all 5 remaining gaps (G-4a-e); 2 were real and
    got BUILT, 1 needed no work (already true), 2 were investigated and explicitly deferred — not
    silently dropped.** G-4a: `ui.operatorShell`'s sidebar (Revenue/Orders/Customers/Products/
    Campaigns/Agents) is rendered as an ADDITIONAL "Business Operations" section on `apps/shell`'s
    business detail page (not a shell-hiding takeover — the Phase 6 scope correction that the rich
    chat/threads/projects shell always ships stands) — Revenue/Products(+create/publish/archive)/
    Orders wired to the already-built `launchpad_products`/`launchpad_orders` commerce backend,
    gated on `shell/manifest` actually advertising a `"revenue"` sidebar item. Customers/Campaigns
    have no backing data model anywhere in the platform — left unbuilt rather than faked (matches
    Phase 3's `credits_consumed: null` precedent); Agents needed no new UI (already the shell's
    Phase C Agents view). New routes' authorization follows the Phase E pricing precedent exactly:
    `requireBusinessMembership({GET:"member"})` on the spaces worker + router allowlist entries,
    identity-only at the router, real per-business check via `resolveEndUserBusinessRole`. G-4b:
    `launchpad-manifest.ts`'s `externalPortal.deploymentType` said `"dynamic-worker"`, a leftover
    the A1.9 appendix already corrected in prose ("one multitenant surface... CF Pages static shell
    fronted by the portal Worker") but never in the actual manifest data — now `"cf-pages"`. G-4c
    (Autopilot CRM/analytics via Whop MCP): verified complete, no new work — Phases F+I already
    delivered exactly what this gap needed. G-4d (retire legacy `launchpad/manifest.ts`+`whop/*`+
    `BusinessDO`): investigated, explicitly DEFERRED — this is NOT dead code, it backs ~50+ passing
    tests (`whop-tool-lifecycle`, `whop-catalog-access`, `whop-onboarding-guard`, and more) as a
    still-live parallel runtime; decomposing it is a genuine cross-cutting migration deserving its
    own dedicated pass, not a "completeness polish" line item. G-4e (team-collaborator listing +
    Product Shell completeness): verified already done by Phases A-C, nothing left to build.
    1028/1028 tests pass (5 new), `pnpm turbo run typecheck` clean (75 tasks), `apps/shell`
    verified via `next build`. Remaining: Phase L (Container Marketplace, large) and M
    (local-machine-as-container + Cowork Desktop, largest) — full detail in the session's plan file.
36. **Phase L (Container Marketplace, spec §33b gap G-1): the slot-lifecycle MECHANISM is BUILT;
    the catalogue ships with zero live images — a deliberate, documented scope line, not a
    shortfall.** Why: the base Tier-5 sandbox's persistence (Phase K) is a per-call R2 TEXT sync,
    fine for small script/data files but not a real design for a long-running stateful server
    (postgres, redis) surviving container restarts — the marketplace's actual differentiating use
    case. A one-shot CLI tool (ffmpeg) doesn't need a separate container at all (add the apt
    package to the base sandbox, call it via the existing `code.execute_bash` op), so it would
    have been a hollow "proof" of this specific mechanism. Rather than fabricate a "postgres
    works" implementation without solving persistence honestly, this pass ships the REAL,
    tested infrastructure and documents the first image as the next incremental step, not
    silently dropped. Built: `container-catalogue.ts` (7 curated images — postgres-16, redis-7,
    chrome-headless, ffmpeg, blender-cli, pytorch-gpu, r-statistical — every entry `available:
    false`), `GET /container-images` (mirrors `GET /templates`); `container_slots` registry
    (SpaceDO migration v20, dumb CRUD + a 10-slot hard ceiling) with the real business rules
    (image exists + is available, product's configured `containerMarketplace.
    maxSlotsPerProject`, default 0) enforced at `GET/POST/DELETE /spaces/:id/projects/:id/
    container-slots` on the spaces worker (builder-only, `requireInternalHmac`, no router
    allowlist entry yet — nothing for an end user to usefully do with an all-`coming_soon`
    catalogue); a routing hook wired ahead of any image (`ScriptMetadata.container_image` →
    `code-runner.ts`'s new `CodeRunnerOptions.containerImages` map → addresses that image's own
    DO, `slot:{image}:{space}:{project}`, or fails CLOSED with a clear message rather than
    silently running against the base sandbox's wrong compute). 1037/1037 tests pass (9 new),
    `pnpm turbo run typecheck` clean (75 tasks). Remaining: Phase M (local-machine-as-container +
    Cowork Desktop, largest, needs a native client app outside this repo) — full detail in the
    session's plan file.
37. **Phase M (local-machine-as-container, spec gap G-3) is BUILT end-to-end, including a real
    reference client — scoped to exactly what the user asked for.** User direction: build "local
    machine as a container," NOT "Cowork Desktop" — Cowork was named alongside it in the original
    roadmap sketch only as an illustrative example of "what it's like to have an agent access your
    PC," not a feature request, so the `cowork-desktop` cloud-container profile is explicitly
    excluded from this pass. Unlike Phase L (mechanism-only, zero live images), this phase ships
    completely real — someone can run it today. Permission model: `local_grants` (SpaceDO migration
    v21) — explicit, revocable, no default access; `user_id` is ALWAYS derived from the verified
    caller's own identity server-side, never a client-supplied field, so a builder can only grant
    their OWN machine. Connect token: `mintLocalTunnelToken`/`verifyLocalTunnelToken`
    (`packages/http`) use a separate HMAC payload namespace from the existing
    `mintInternalToken`/`verifyInternalToken` pair so the two token families can never be replayed
    as each other. `LocalTunnelDO` (agents worker, new `LOCAL_TUNNEL` binding) is one instance per
    `(spaceId, userId)`, using the same CF Hibernation WebSocket pattern `workers/ws-gateway`'s
    `WsHubDO` already established. The `local-machine` prebuilt is the actual safety layer: grant
    checks happen BEFORE the tunnel is ever touched, with true path-segment containment (not a
    naive string prefix — `/home/alice/allowed-evil` correctly does NOT match a grant for
    `/home/alice/allowed`), server-side `..`-traversal collapsing, and exact (not prefix) command
    matching for exec grants. The piece every prior phase deferred as "needs a native client app
    outside this repo" — shipped anyway: `workers/agents/local-agent/naelao-local-agent.mjs`, a
    dependency-free Node 22+ reference client with its own optional second-layer
    `--allow-dir`/`--allow-command` policy check, unit-tested with a real temp-directory
    read/write round trip and a real `exec` call. 1076/1076 tests pass (39 new), `pnpm turbo run
    typecheck` clean (75 tasks). With Phase M done, every phase in the full-vision roadmap (A
    through N, plus L and M) is now built.
38. **A SECOND FULL-VISION PASS (Phases O-V) is IN PROGRESS** — a new batch of user-directed work
    layered on top of A-N/L/M, NOT a correction of it. User asks covered: agents get their own
    platform API identity; a real approval-events pipeline; broader MCP connector reach via
    Composio/Pipedream; runs that survive a closed tab; an honest container/workspace model;
    local-machine-grants UI; and project collaboration (visibility, @mention multi-agent threads,
    single-active-thread locking) plus whole-business real-time sync. Full plan + phase-by-phase
    detail: appendix §A1.18. **Phases O, Q, R, S, T, U, V are BUILT; only P remains.**
    - **O (agent API keys + HTTP approval gate + events) BUILT.** New `nak_...` agent API key
      family (SpaceDO `agent_api_keys`, mirrors `BuilderAccountDO`'s hash+prefix pattern),
      verified via a new `/internal/agent-keys/verify` chicken-and-egg endpoint and mapped to a
      new `"agent"` `UserRole`/`claims.role`. Per-agent approval policy (`agent_policy_overrides`,
      falls back to the existing space-wide `assistant_policy`, fails closed). A new HTTP-level
      approval gate in the router: an agent's mutating request is allowed under `'yolo'` or a
      pre-approved action key, otherwise it opens a `HITLApprovalDO` request (now supports a
      configurable `ttl_ms` + a single-use `/consume` endpoint, since the in-loop gate's 30s
      auto-reject is wrong for a real HTTP caller) and returns `202 pending_approval`. New
      `approval.requested`/`resolved` events (`@naelao/events`); the moment an approval opens
      (in-loop OR via the HTTP gate), `NaelaoAgentDO` best-effort notifies the space owner by
      email (`GET /internal/spaces/:spaceId/owner-contact`) — the assistant always knows an agent
      is waiting on a human, no builder-configured trigger rule required. `messages` gained
      `author_type`/`author_id` (derived from the caller's VERIFIED identity, never a
      client-trusted field) so a thread bubble can render "Agent1" vs "Agent2" vs the Space
      Assistant. 26 new tests.
    - **Q (durable-by-default agent runs) BUILT — and fixed a real, previously-undetected broken
      chat path in the process.** The Workflow+TaskDO async path (`G-AX04`, previously opt-in
      behind `Prefer: respond-async`) is now the DEFAULT for `/agent/run`; `Prefer: respond-sync`
      is the new opt-out. While wiring this, confirmed against git HEAD that BOTH `apps/shell`'s
      AND `apps/portal`'s chat send flow have never actually worked past the first message: (1)
      `sendMessage()` posts `{session_id}` with no `goal` — this endpoint required `body.goal`
      unconditionally, so the call always 400'd (fixed with `resolveRunGoal`, falling back to the
      session's own latest 'user' message; both apps now also pass `goal` explicitly); (2)
      `NaelaoAgentDO.handleGetRun` returned camelCase (`finalAnswer`/`reactSteps`) while every
      consumer (the SSE poller, both apps' clients) read snake_case — `final_answer` always came
      through `undefined` (fixed at the source). The run/stream GET endpoints now transparently
      fall back to TaskDO (`fetchRunOrTaskStatus`, translating `queued`/`processing`/`complete` to
      the `running`/`completed` vocabulary clients already use) when an id isn't one of
      `NaelaoAgentDO`'s own synchronous `agent_runs` rows. 17 new tests.
    - **R (explicit multi-workspace model) BUILT, replacing Phase K's blind R2<->container
      sync.** Phase K silently materialized/collected the FULL R2 workspace around every single
      Tier-5 `/exec` call (bounded 300 files/2MB/25MB) — a tax paid whether or not a script
      touched files, and dishonest about persistence. Replaced with an explicit model: R2 (always
      available, durable, small/text) and the container's own local disk (large/binary/
      stateful-capable, but only persists while that warm instance stays up, genuinely EMPTY on a
      cold start) are two DIFFERENT filesystems an agent moves files between on purpose via a new
      `workspace` prebuilt (`workspace.copy/move/list`). `ToolSandboxDO` is now a pure proxy to
      the harness (`/exec` + new `/workspace/{read,write,list,delete}`) with zero R2 logic left in
      the DO; `container/server.mjs`'s `/workspace` is just that warm container's own persistent-
      while-warm disk. New `ContainerWorkspaceGateway` (`script-engine/types.ts`), wired in
      `NaelaoAgentDO.buildScriptEngineEnv` with the same per-project addressing `runContainer`
      already uses. Explicitly did NOT add `@cloudflare/workspace`/isomorphic-git tooling — an
      agent that needs git just runs it via `code.execute_bash`. 17 new/updated tests.
    - **S (local-machine grants UI) BUILT on both surfaces.** Phase M shipped the full mechanism
      with zero frontend. Dashboard: a new "Local Machine" product tab — needed NO backend auth
      changes, since `requireInternalHmac` verifies the SAME token naelao-router mints for every
      proxied request (JWT or `nps_` alike), not an exclusively service-to-service gate. Shell: a
      "My Local Machine" section on the business detail page DID need real backend work — added
      `requireBusinessMembership` to `/local-grants*`/`/local-tunnel/connect-token` (POST needs
      "admin") plus a `user_id` filter on `SpaceDO.listLocalGrants` so one business member can
      never see another's grant directory paths. 7 new tests (cross-business isolation).
    - **T (project collaboration) BUILT.** T1: `projects.visibility`/`created_by` + a real
      `project_members` ACL table (owner/editor/viewer) — a `'private'` project (the new default,
      matching today's implicit behavior) is hidden from `listProjects` unless the viewer is a
      member or the space's own owner/admin; the creator is auto-added as an `'owner'` member. T2:
      a new `parseMentions()` (`@naelao/events`) resolves `@Name` tokens against a project's
      `allowed_agent_ids` roster, deduped so mentioning the same agent twice dispatches once;
      `/agent/run`'s DO addressing now switches to `{sessionId}:{agentId}` whenever an explicit
      `agent_definition_id` is given (bare-sessionId addressing is unchanged when it's absent) —
      per the confirmed decision, `@Agent1`/`@Agent2` mentioned in the SAME thread get separate
      memories/reasoning state. New `POST .../agent/mention-run` resolves the roster, dispatches to
      each matched agent (capped at 5) via a synchronous `/agent/run` call, and posts each reply
      into the thread's shared message transcript attributed to that agent (Phase O's
      `author_type`/`author_id`). T3: soft locking is unchanged (the existing `lock` prebuilt); a
      new opt-in hard "exclusive mode" (`projects.exclusive_mode`/`active_thread_id`) is acquired
      via `POST .../activate-thread` when a user opens/focuses a thread (deliberately NOT wired
      into every message send — chat sessions and structural threads are two separate tables with
      no server-side link today, a documented pre-existing gap this doesn't solve); a different
      thread activating while one is active gets `409` with who holds it, `take_over` reassigns
      explicitly so this can never deadlock. 25 new tests.
    - **U (Memory OS project-shared layers) BUILT.** T2 committed each `(thread, agentId)` pair to
      its own memory — without this, two threads in the same project (or two @mentioned agents in
      one project) would share zero knowledge. Promoted Layers 3 (facts)/4 (fabric)/6 (wiki) to
      SpaceDO (reusing the existing per-space DO, not a new class), keyed by `project_id`; Layer 5
      (episodic/semantic) deliberately stays exactly where it is — private per `(thread, agentId)`.
      New `workers/agents/src/script-engine/project-memory-client.ts`: `buildProjectMemoryStore` is
      a `MemoryStore` backed by HTTP calls to SpaceDO's new project-memory routes;
      `buildHybridMemoryStore` composes it with the existing local store — a structured fact routes
      to the project store, a free-text episodic note stays local, `recall` merges both
      (dedup-by-text, highest score wins), Fabric/Wiki always go to the project store.
      `NaelaoAgentDO.buildScriptEngineEnv` wires the hybrid store only when `projectId` is present;
      the Space Assistant's own `_assistant` slot is unaffected. 26 new tests.
    - **V (whole-business real-time sync) BUILT.** `WsHubDO` (`workers/ws-gateway`) was fully built
      but completely unwired — no other worker ever called it. New shared `broadcastSpaceEvent`
      (`packages/http/src/realtime.ts`) — best-effort, degrades to a silent no-op when `WS_GATEWAY`
      isn't bound — wired into `SpaceDO.createProject`/`updateProject` (`project.created`/
      `.updated`), `activateProjectThread` (`thread.activated`, only on an actual lock transition,
      never on a `409`), `heartbeatPresence` (`presence.heartbeat`), and
      `NaelaoAgentDO.notifyApprovalRequested` (`approval.requested`, independent of whether email
      notification is configured). New `WS_GATEWAY` service binding added to both
      `workers/spaces/wrangler.toml` and `workers/agents/wrangler.toml`. Deliberately NOT wired
      this pass: agent run started/completed and `approval.resolved` (`HITLApprovalDO` doesn't
      carry `space_id` in its own rows today), and a frontend WS client subscribing in
      `apps/shell`/`apps/dashboard` — the backend fan-out is real and tested; a live UI consumer is
      the next step. 12 new tests.
    - **Remaining: P (Composio/Pipedream connector providers — needs real API keys the user must
      supply before it can run against live providers; the routing logic itself can be built and
      tested with mocked provider APIs regardless).** Full phase detail in appendix §A1.18.
39. **A full end-to-end audit (security + logic + go-live gaps) found and fixed 5 real issues on
    the public end-user surface — the exact edge a live Launchpad product exposes on day one.**
    Traced by hand against the code, not from memory: (1) the authenticated `api` group's rate
    limiter (G-AX12/F7) only covers routes registered AFTER it in the router's middleware chain —
    every unauthenticated route (`end-users/signup`, `end-users/login`, `by-slug`,
    `shell/manifest`) runs BEFORE that group and had ZERO throttling: unlimited password-guessing
    against login, unlimited free-credit-farming against signup (each new email mints a fresh
    `ProductUserDO` with its own `FREE_TIER_DEFAULT_SIGNUP_CREDITS` grant). Fixed with a new
    `checkPreAuthRateLimit` (`workers/router/src/index.ts`) — same DO-sharding pattern as the
    authenticated limiter, keyed on `cf-connecting-ip` since there's no `claims.sub` yet, but
    fails CLOSED (unlike the authenticated limiter's fail-open) since a limiter outage on this
    surface must not hand out an unthrottled credential-guessing oracle. (2) Neither end users nor
    builders had ANY account-recovery path — confirmed zero password-reset code anywhere in the
    repo. Built `POST /spaces/:spaceId/end-users/{request-password-reset,reset-password}`
    (`product-end-user-routes.ts`, migration `0054_password_reset_tokens.sql`) — same
    hashed/single-use/expiring token shape as `business_invites`, constant response whether or not
    the email exists (mirrors the login route's own precedent). (3) While wiring the reset email,
    found that **the notifications worker has no `/internal/notify` HTTP route at all** — only a
    queue consumer — so every caller platform-wide (`NaelaoAgentDO`'s approval-request email, the
    `notifications` and `business-email` prebuilt scripts) has always POSTed to a 404 silently
    swallowed by its own best-effort `try/catch`. Agent email/Slack/Discord notifications and
    approval-request emails were therefore completely non-functional in practice. Added the route
    (`workers/notifications/src/index.ts`), extracting the queue consumer's email-send logic into
    a shared `sendEmailNow` reused by both paths; non-email channels honestly report
    `delivered:false` rather than pretending to work. While there, also fixed a second latent bug
    the same code path exposed: the `notifications` D1 audit-row INSERT used columns
    (`status`/`subject`) that don't exist on the real schema (migration `0010`: `title`/`body`,
    `user_id NOT NULL`) — every real insert would have failed silently; corrected to the real
    column names and skip the audit row when there's no platform `user_id` to attribute it to
    (most calls here are to an external end-user address, not a platform user). (4) The builder
    payout balance (`GET/POST /builder/payouts*`, item 30's Phase-E-adjacent addition) computed a
    builder's withdrawable balance with `GROUP BY currency ORDER BY cents DESC LIMIT 1` — a
    builder earning in more than one Lemon-Squeezy-buyer currency could only ever see and
    withdraw the single largest one; every other currency's earnings were invisible and
    permanently stuck. Fixed to return a balance array, one row per currency, and require an
    explicit `currency` in the request when more than one has a balance. (5) In the course of
    fixing #1, found and fixed a pre-existing `duplex: "half"` gap on the end-users proxy (same
    defect class Phase 6 already fixed once for the session proxy and `forwardToSpaceDO` — a
    spec-compliant fetch implementation throws on a streaming body without it). All fixes have
    test coverage (`router-preauth-rate-limit.test.ts`,
    `notifications-internal-notify.test.ts`, password-reset cases added to
    `product-end-user-auth.test.ts`, currency cases added to `builder-payout-requests.test.ts`).
    1338/1338 tests pass (18 new), `pnpm turbo run typecheck` clean (75 tasks).
40. **The three items item 39 deferred are now BUILT: email verification (closing the free-credit-
    farming hole for real), data-driven CORS, and a builder-facing agent activity log.** Signup's
    free-credit grant no longer fires immediately — it's deferred until a real inbox redeems a
    verification token (`POST /spaces/:spaceId/end-users/verify-email`, plus
    `resend-verification`; migration `0055_email_verification.sql`). CORS is now resolved
    dynamically in the router (`isDynamicOriginAllowed`) against `spaces.product_slug` (any
    active product's `{slug}.naelao.com`) and `business_services.custom_domain` (any active
    custom domain), KV-cached 60s, falling back to the static `CORS_ALLOWLIST` — closes the gap
    where `apps/shell`, the Product Shell every end user uses, was never actually in the
    allowlist. Builder observability: a new SpaceDO table `agent_activity_log` (migration v27)
    is the cross-thread, product-wide mirror `NaelaoAgentDO` posts to (one row per run
    completion/failure and per approval request) via `POST /internal/spaces/:spaceId/
    agent-activity`, readable by the builder via `GET /spaces/:spaceId/agent-activity`
    (deliberately builder-only, unlike `assistant-policy`'s end-user-readable GET, since this can
    surface other end users' escalation summaries) — same "mirror into SpaceDO because opening
    every agent DO doesn't scale" precedent as thread/sub-agent mirroring.
    **A costly false trail worth recording:** while adding these routes, `product-shell-manifest.
    test.ts` started failing in a way that looked exactly like the pre-documented Hono
    RegExpRouter route-table-scale bug (record-install's own comment) — reproduced repeatedly
    against route count, shape, file position, a mounted sub-app, and even a full TrieRouter
    swap (which fixed nothing and broke 9 MORE tests, immediately reverted). The real cause was
    mundane: `issueVerificationToken`'s `INSERT INTO email_verification_tokens` had no try/catch
    unlike the credit-grant code it replaced, and that test file's own D1 fixture doesn't load
    migration 0055 — so `signupEndUser`, called by unrelated PATCH/list tests as setup, threw
    and corrupted THEIR state, not the router. Fixed with one try/catch (matching the codebase's
    own "never fail an already-successful mutation over a side effect" convention everywhere
    else) and one stale test assertion updated for the new deferred-grant behavior. Lesson: when
    a failure looks exactly like a documented prior bug, verify against the actual failing
    assertion before re-deriving the same diagnosis — a five-minute read of the stack trace would
    have found this in one pass instead of many. 1364/1364 tests pass (26 new),
    `pnpm turbo run typecheck` clean (75 tasks). **Not built in this pass:** the router bug
    detour did surface one real, still-open finding worth keeping — `workers/spaces/src/index.ts`
    is 170+ routes in one file with zero test coverage of the router's own compilation at that
    scale; splitting it into mounted sub-apps (the technique tried and reverted here, which DID
    work mechanically, just wasn't the actual fix needed) remains a legitimate future
    maintainability improvement, not an active bug.

41. **A full end-to-end "can a builder launch and win against Polsia today" audit found four
    launch blockers; all four are now BUILT.** The audit (not code changes, a fresh read against
    the live code) found: the CF AI Gateway integration existed and was used by the real
    production reasoning loop but had never actually activated in any deployment; the front-door
    chat message was never content-moderated, only injection-*detected* (silently
    tracked/rate-limited, never blocked); a legitimate signed-up user had no visible way to
    complete the email verification a prior pass now requires before granting free credits; and
    builders had zero account-recovery path.
    - **Cloudflare AI Gateway activation.** `shared/ai-client.ts` (spec §15) was fully built and
      wired into `GatewayReasoner`, the actual production reasoner — but wrangler does NOT merge
      a named environment's `vars` table with the top-level `[vars]` block, it REPLACES it
      entirely, so `[env.staging]`/`[env.production]` silently dropped
      `NAELAO_ACCOUNT_ID`/`NAELAO_GATEWAY_ID` and every LLM call fell back to the direct
      Anthropic API in every real deployment. Fixed by carrying those vars forward explicitly.
      The SAME bug class (top-level vars silently dropped in staging/production) turned out to
      be systemic — found and fixed in `workers/analytics`, `billing`, `eval`, and
      `security-gateway` too (checked all ~30 workers; most only had `ENVIRONMENT` at the top
      level, so had nothing to lose). New `wrangler-vars-parity.test.ts` parses every
      `workers/*/wrangler.toml` and asserts this going forward — the wrangler.toml-shaped
      equivalent of a schema-migration test. Also added first-ever test coverage for
      `ai-client.ts`'s own URL/header resolution logic.
    - **Real content-policy blocking.** `detectPolicyViolations`/`moderateText` were imported
      into the agents worker's `/agent/run` route but never actually called — the ONLY
      input-side check on `body.goal` was prompt-injection *detection*, deliberately silent (an
      attacker must never learn their jailbreak was caught, so it tracks/rate-limits rather than
      blocking). That reasoning doesn't extend to hard policy violations (CSAM text,
      weapons/bioweapon synthesis, violence) — there's no "attacker iterating on a jailbreak"
      harm model to protect by staying silent; the harm is the content itself. Those now block
      outright (400) before any downstream D1/SPACES_WORKER call, left the injection detector's
      existing silent-tracking behavior untouched.
    - **Email-verification UX.** Deferring the signup credit grant to email verification (a
      prior pass) closed a real farming hole but broke the legitimate happy path: the
      verification email carried a raw token with no link, `GET /product-users/me` never
      reported verification status, and there was no page to redeem a token — a new signup
      landed in chat with 0 credits and no visible way out. Fixed: verification emails now
      include a clickable link when a new `PRODUCT_SHELL_URL` var is configured (falls back to
      token-only text — never a broken link — when it isn't, and the shell's new
      `/p/[slug]/verify-email` page accepts a manually pasted token either way);
      `product-users/me` now reports `email_verified`; a persistent "Verify your email" banner
      in the shell layout links to that page.
    - **Builder password reset**, and three real bugs it surfaced. `workers/auth` (login/
      register — the builder's OWN account) had zero test coverage of any kind before this pass.
      Writing real coverage against the ACTUAL migration schema (not a hand-rolled one) caught
      three genuine, previously-undetected bugs in `/register` that would fail against a real D1
      instance on every single call: the `orgs` INSERT referenced a nonexistent `updated_at`
      column and omitted the required NOT NULL `owner_id`; the `users` INSERT also referenced a
      nonexistent `updated_at`; the `org_members` INSERT referenced a nonexistent `created_at`
      (real columns: `invited_at`/`joined_at`). None of this was catchable before because the
      shared fake-D1 test stub didn't implement `.batch()` at all (which `/register` uses via
      `db.batch([...])`) — no test in the whole suite exercised batch()-based code. Extended the
      stub to run a real transaction (matching D1's own atomicity), fixed all three column-name
      bugs, then built the actual feature: same hashed/single-use/expiring token shape as the
      end-user reset flow, a dashboard "Forgot password?" link + `/reset-password` page, and
      router-level rate limiting on the new routes — which also caught that `/v1/auth/login` and
      `/register` had ZERO pre-auth throttling of any kind before this pass; folded into the
      same fix.
    - A costly false lead worth recording: `apps/dashboard`'s API client calls paths like
      `/auth/login` and `/spaces` with no `/v1` prefix, which looked like the exact same bug
      class as the wrangler.toml sweep above — until checking confirmed EVERY dashboard API call
      omits `/v1` the same way, meaning `NEXT_PUBLIC_API_URL` itself must carry the `/v1` prefix
      in a real deployment. Not a bug; verify a suspected pattern against ALL call sites before
      trusting a single alarming grep hit.
    1462/1462 tests pass (98 new across this pass, up from 1364), `pnpm turbo run typecheck` clean (75 tasks),
    `apps/dashboard` and `apps/shell` both verified via `next build`. **Not built in this
    pass (real, still-open gaps, not silently dropped):** the audit's Tier 2/3 findings —
    gating agent runs on an active `business_subscriptions` row (that table is currently
    write-only, nothing reads it to gate access), a monthly credit-refresh cron for
    `creditsIncludedPerMonth` (grants once, ever, despite the field name), a builder-facing UI
    for the `agent_activity_log` data a prior pass already built and populates, a proactive daily
    digest email, first-run/onboarding for a new product, GDPR erasure for end users (export
    exists, deletion doesn't), and a real LLM-provider failover chain beyond what CF AI Gateway's
    own dashboard-configurable retries provide (the code only calls the Anthropic-compatible
    endpoint, not the Universal multi-provider endpoint, so cross-PROVIDER failover — not just
    cross-request retry — would need a second provider integration this pass didn't add).
42. **UNIVERSAL-TOOLS PRINCIPLE encoded + web search made real: a "universal" capability is
    PLATFORM-PROVIDED (Naelao holds ONE key), never BYO — like Claude/ChatGPT bundling web
    search.** Audit finding (traced every `prebuilt/` script against where its key comes from):
    the platform already gets this right for `browser-use` (CF Browser Rendering), `code-exec`
    (CF isolate/container, no key), `knowledge-base` (CF Vectorize/AI), `commerce` (Naelao's LS
    key + fee), and LLM inference (Anthropic + `together-ai`'s `TOGETHER_API_KEY`). BYO-key is
    correctly reserved for the builder's OWN external accounts (`mcp-connector`,
    `revenue-tracker` → their Whop/Gumroad). The ONE mis-modeled/broken universal tool was
    **`web-search`**: its design comment intended platform-provided ("the API key never reaches
    the agent"), but its proxy target `/internal/web-search/*` on the knowledge worker was
    **never implemented** (dead route) and **no platform search key was wired anywhere** — so
    search was advertised in agent profiles yet completely non-functional. Fixed: implemented the
    three routes on the knowledge worker (Tavily via a new `TAVILY_API_KEY` Workers Secret,
    HMAC-gated like every other `/internal/*` route, SSRF-guarded `fetch`/`extract` via
    `@naelao/security`'s `checkSsrf`), following the `commerce`/`together-ai` platform-key
    precedent — NOT the BYO `space_credentials` model. `search`/`extract` degrade honestly
    (`configured:false`) when the platform key is unset; `fetch` is a keyless SSRF-guarded GET
    that works out of the box. The `web-search` prebuilt now mints a verifiable tenant-scoped
    internal token (the gate requires it) and the provider key never reaches the agent isolate.
    1625/1625 tests pass (4 new), `pnpm turbo run typecheck` clean (75 tasks). **Not done:** an
    operational `TAVILY_API_KEY` must be set via `wrangler secret put` per environment before
    search returns live results — the code degrades honestly until then.
43. **GROWTH LAYER spec'd as canonical-spec Appendix BF (G-BF01..20) + Phase 1 code BUILT.** The
    spec itself gained a new appended appendix (the file's own running-log convention;
    `SPEC_HEADER_INDEX.md` regenerated) covering five directions: (BF.1) the universal-tools
    doctrine extended to CONNECTORS — Composio/Pipedream-backed MCP tools are platform-keyed
    (Naelao holds ONE key; users only ever do OAuth consent, never enter provider keys), with a
    curated auto-provided catalogue for the Space Assistant; (BF.2) business idea discovery
    (App Store trend scout + Starter Story playbook scout as seeded skills — inspiration/
    validation framing, never cloning); (BF.3) the free-plan simple-business program — flagship
    `freelance-web-studio` ($50 sites) with **compliant** multi-channel cold outreach (email-first
    + click-to-WhatsApp so the prospect initiates WhatsApp = the Meta-policy opt-in; HITL batches,
    hard caps, STOP), sample-site hosting, reserved-commerce checkout, and a catalogue of ~11 other
    simple free businesses; (BF.4) the Business Network — per-business-type feed where same-template
    businesses + their assistants share distilled learnings/skills/metric BANDS, default-on for
    free/growth, `private` mode is business/enterprise-gated (fails closed to a plan check), and
    PII/credentials/exact figures are NEVER shared regardless of plan (server-side anonymization
    gate); (BF.5) a DEFERRED private-playbook bidding exchange. **Phase 1 code:** (a) mcp-hub gained
    `COMPOSIO_API_KEY`/`PIPEDREAM_API_KEY` platform secrets + `resolveProviderApiKey` — BYO vault
    credential wins, platform key otherwise, honest `provider_not_configured` when neither; a broken
    BYO declaration errors rather than silently billing Naelao's provider account; closes §A1.18
    Phase P's key-model gap (the routing already existed). (b) `free_tier_eligible` — which existed
    since Phase F but was NEVER checked anywhere — is now enforced at both template entry points
    (`createBusinessForEndUser` before any side effect; `createSpaceRecord` for POST /spaces +
    /builder/products) via new `workers/spaces/src/template-catalog.ts` (loader extracted from
    index.ts + flag added to projection, KV key bumped v2; tier lookup fails CLOSED to free, an
    UNAVAILABLE catalogue degrades OPEN — monetization gate, not a security boundary);
    `shell/manifest.template_catalog` carries the flag for the create-business dialog. 1646/1646
    tests (29 new), typecheck clean. Full detail: appendix §A1.19.

44. **A go-live security+logic audit scoped to the Launchpad launch path found and FIXED two real
    issues — one launch-blocker, one serious — and confirmed several prior fixes intact.**
    - **F1 (launch-blocker, FIXED): the `naelao-agents` worker trusted spoofable identity headers
      on ~13 routes.** This worker has no `workers_dev = false` backstop (its channel gateway
      needs public ingress), so `x-naelao-tenant-id` is only trustworthy AFTER naelao-router
      verified a JWT/session and `proxyTo` minted the matching `x-naelao-internal-token`.
      `/agent/run` (+`mention-run`, `script/run`) have verified that token since S0.2 — but a batch
      of routes added in later phases only called `getCallerIdentity` and stopped, so a direct
      caller at the `workers.dev` URL could spoof any tenant. Worst case: `POST /internal/tasks/
      :taskId/run` (Phase Q's durable-run executor) had NO auth of ANY kind and ran the full
      reasoning loop against the platform `ANTHROPIC_API_KEY` straight from body fields — a free,
      unattributed, unrate-limited LLM oracle for any spoofed tenant. Also exposed: cross-tenant
      run/task read+cancel+SSE-stream, connector/channel credential WRITES (an attacker could store
      their own signing secret for a victim's Slack/WhatsApp channel then legitimately sign forged
      inbound messages), skill promotion (proprietary-skill leak), and the assistant read panels.
      Fixed with a new `requireVerifiedTenant()` helper (the exact three-line check `/agent/run`
      already used) applied to every `getCallerIdentity`-only route; `/internal/tasks/:taskId/run`
      HMAC-gated exactly like `/internal/triggers/fire` (verified token whose tenant must match the
      body's `tenantId`), with `AgentTaskWorkflow` updated to mint that token. New
      `agents-worker-internal-token-gate.test.ts` locks in reject-without-token / reject-wrong-
      secret / pass-with-token per phase family. **Root cause of the miss:** items 21-23's thorough
      direct-ingress sweep predates Phase Q and the connectors/channels/skills routes — nobody
      re-ran the S0.2 hardening after adding them.
    - **F2 (serious, FIXED): the builder's own platform-subscription surface was a dead route.**
      The billing worker implements `GET /billing/subscription` (plan+quota), `POST /billing/
      checkout` (upgrade), and `/billing/portal` — but naelao-router never proxied `/billing/*` to
      it, so `apps/dashboard`'s Settings page (`getBillingSubscription`/`createBillingCheckout`)
      404'd on every call. A builder could neither see their plan nor upgrade off free — and free
      now gates `free_tier_eligible` templates (G-BF08, item 43), so a free builder had no in-
      product way out. Fixed by proxying the three builder-facing routes EXPLICITLY (not a blanket
      `/billing/*` — `/billing/usage` and every `/internal/*` billing route are `requireInternalHmac`
      service-only and must not become builder-reachable); the billing worker is shielded by
      `workers_dev=false` so trusting `proxyTo`'s identity headers is safe. The existing
      `router-dispatch` "frontend route-parity" guard test — which exists precisely to catch this
      class — grew `/billing/subscription`+`/billing/checkout` entries so this can't regress.
    - **Confirmed intact / stale-doc:** builder-register column bugs (item 41) verified still fixed
      against the real `orgs`/`org_members` schema; `listSpaceTypes` dead route already repointed to
      `/builder/space-types`; end-user credit deduction (`debitEndUserCredits`/`debitProjectWallet`)
      is genuinely wired into `handleScriptRun` with correct pre-run gates (fail-open-on-error,
      fail-closed-on-confirmed-empty). NOTE: `business_subscriptions` gating and the
      `creditsIncludedPerMonth` monthly refresh — item 41's "not built" list — ARE in fact built and
      HMAC-gated (a "Tier 2 metering follow-up" pass that landed after item 43 but was never logged
      here); the code is correct, item 41's changelog was stale. 1669/1669 tests (23 new),
      `pnpm turbo run typecheck` clean (75 tasks). **Not completed this pass:** the full builder- and
      end-user-journey traces were partly delegated to background agents that were killed by an
      account API session limit; the hops above are what was verified by hand. A follow-up should
      finish the wizard→domain→pricing UI trace and the signup→verify→SSE-stream frontend trace.

45. **VENDOR CUTOVER — Lemon Squeezy is the ONLY billing provider, and the LLM path runs entirely
    through the Cloudflare AI Gateway (no per-worker Anthropic key).** Two independent subsystem
    cutovers, both BUILT and fully tested, plus a grounded secrets reference (`docs/DEPLOYMENT_SECRETS.md`).
    - **Billing → Lemon Squeezy only (Stripe removed).** The builder's own platform-plan surface
      (`/billing/checkout` + `/billing/portal`) was the last Stripe-backed path; it now runs
      through the same Naelao LS store as every other money path (new
      `LEMON_SQUEEZY_GROWTH/BUSINESS_VARIANT_ID`, provision-once in the LS dashboard; dev-placeholder
      degradation matching `/internal/commerce/checkout`). `/webhooks/stripe` and `stripe.ts`
      deleted; `validateEnv` dropped the four `STRIPE_*` requirements (PLATFORM_SECRET is the real
      dependency); Terraform's `stripe_api_key` → `lemon_squeezy_api_key`. New `kind="platform_plan"`
      LS webhook branch (`recordPlatformPlanSubscription`) — an ORG-level event handled before the
      space-dispatch machinery, own exactly-once gate + retry-release. **Fixed a real pre-existing
      entitlement bug in the process:** the old Stripe webhook only wrote `subscriptions.plan_tier`,
      but `EntitlementsChecker.getTenantTier` enforces from `orgs.plan_tier` — a paid upgrade never
      actually unlocked free-tier template gates or quotas; the new handler writes both + invalidates
      the quota KV cache. **Second real gap found:** LS's `subscription_expired` event was unmapped
      in billing-core's `EVENT_MAP` (parseWebhookEvent threw → webhook 200-skipped it), so ANY
      expired subscription silently kept its paid tier forever; added `subscription.expired` through
      the event union / EVENT_MAP / mapSubscriptionStatus / GOAL_MAP. Migration 0062 adds
      `subscriptions.ls_customer_id/ls_subscription_id` (stripe_* columns stay — D1 has no cheap DROP
      COLUMN; nothing writes them). New `platform-plan-billing.test.ts` (10 tests, real migrations).
    - **LLM → Cloudflare AI Gateway with gateway-held provider key (no `ANTHROPIC_API_KEY` on any
      worker).** The gateway can hold the Anthropic key itself (Authenticated Gateway / BYOK): the
      worker authenticates with a `cf-aig-authorization` token (`NAELAO_AIG_TOKEN`) and the gateway
      injects the real key. BOTH LLM paths updated: the `GatewayReasoner`/Universal Endpoint
      (`shared/ai-client.ts` — `GatewayOpts.aigToken`, new `universalGatewayHeaders()` puts the token
      on the request header not the body, `buildProviderEntry` OMITS the per-provider auth header
      when the key is empty so the gateway's stored key isn't blanked, new `canAuthenticateLlm()` →
      honest `give_up`) AND `callLlm`/`streamLlm` in `@naelao/llm-gateway` (which were hitting
      `api.anthropic.com` DIRECTLY, bypassing the gateway — now route through the gateway's anthropic
      provider endpoint via `resolveAnthropicEndpoint`, carry the token, omit `x-api-key` when empty,
      throw `no_llm_credentials` when neither key nor token is set). `ANTHROPIC_API_KEY` is now
      optional in `AgentsEnv`/`AgentDOEnv` and dropped from `validateEnv`; NaelaoAgentDO threads
      `NAELAO_AIG_TOKEN` into both reasoner sites + the ReAct `callLlm` path via a new
      `aiGatewayConfig()` helper. New `ai-gateway-stored-keys.test.ts` (14 tests). 1693/1693 tests
      pass (24 new across both cutovers), `pnpm turbo run typecheck` clean (75 tasks). **Not done:**
      real deployment must (a) create the LS subscription variants + point the LS webhook at
      `/v1/webhooks/lemon-squeezy`, and (b) store the Anthropic key in the CF AI Gateway + set
      `NAELAO_AIG_TOKEN` — the code degrades honestly (dev placeholder / `no_llm_credentials`) until
      then. `docs/DEPLOYMENT_SECRETS.md` has the full per-worker key/secret inventory.
46. **A re-audit (`docs/AUDIT_2026-07-11_reaudit_blueprint.md`) found the interactive chat path was
    completely unmetered — TWO PARALLEL AGENT RUNTIMES in `NaelaoAgentDO`, with every billing/
    authorization gate wired onto only one of them — now FIXED (S-A1, the audit's HIGH-severity
    finding A-1).** The script-native engine (`handleScriptRun`) carried the F-36 assistant
    permission clamp, the customer-bot execution ceiling + daily spend cap, the project wallet
    gate, and the `product_end_user` pre-run credit check/post-run debit — but the legacy ReAct
    loop (`handleRun`), which is what every interactive `POST /agent/run` message from `apps/shell`
    and `apps/portal` actually reaches (on both the sync dispatch and the async-by-default
    Workflow/TaskDO path), carried NONE of them: a signed-in end user (or a business whose wallet
    was drained) could chat against Naelao's own CF AI Gateway key with zero limit. Fixed by
    extracting the shared gate logic into two new `NaelaoAgentDO` methods —
    `enforceRunGates`(pre-run: F-36 clamp, spend cap, wallet, credit check) and
    `settleRunBilling` (post-run debit) — called identically from both `handleScriptRun` and
    `handleRun`, so the two runtimes can never drift again. `runReActLoop` used to return only the
    final-answer string, discarding the token usage it already tracked internally; it now returns
    `{finalAnswer, inputTokens, outputTokens, tokensUsed}` (its one call site, so a safe signature
    change) so `handleRun` can settle billing with real numbers. `userId`/`projectId`/`callerRole`
    were previously dropped when `workers/agents/src/index.ts`'s `/agent/run` route dispatched to
    `http://agent-do/run` — threaded through at both the sync dispatch and the async path
    (`AgentTaskWorkflow`'s params → `/internal/tasks/:taskId/run`), plus into `/agent/mention-run`'s
    inner re-dispatch. Every fail-open/fail-closed posture preserved verbatim: authorization denial
    and a CONFIRMED empty balance/wallet fail CLOSED; a transient lookup error fails OPEN, matching
    `handleScriptRun` exactly. New tests
    (`interactive-run-end-user-credit-gate.test.ts`, `interactive-run-project-wallet-gate.test.ts`)
    drive the previously-uncovered interactive `/run` path directly and assert the refusal + no
    un-debited LLM call. 1733/1733 tests pass (8 new), `pnpm turbo run typecheck` clean (75 tasks).
    **Not done this pass (tracked, not urgent):** A-2, converging `/agent/run` onto the
    script-native `handleScriptRun` and retiring `handleRun`/`runReActLoop` entirely per ground
    rule #8 — S-A1 closes the exploitable gap; A-2 removes the duality that caused it, and is a
    larger behavior change to the live chat surface better done as its own pass, tracked in
    `docs/AUDIT_TODO.md`'s "Deferred, tracked follow-up (NOT for the go-live window)" section
    (explicitly scoped to NOT be implemented during the current go-live push). **A-3 (the wallet
    ledger's latent multi-currency conflation) is now FIXED:** `creditWallet` rejects any
    non-USD `currency` with a clear `400 unsupported_currency` (no real caller ever sent one;
    single-currency-reject chosen over building out real multi-currency wallets) and both
    credit/debit always write the literal `'USD'` ledger column rather than trusting the
    request body. 1735/1735 tests pass (2 new), `pnpm turbo run typecheck` clean (75 tasks).
47. **A-2 (item 46's deferred item) is now DONE — dispatch cutover only, per explicit user
    direction to implement despite the go-live-window caution.** `/agent/run` (both the async
    Workflow-dispatch branch and the sync branch, plus `/internal/tasks/:taskId/run`) now calls
    the script-native `handleScriptRun` (`.../script/run`) instead of the legacy ReAct
    `handleRun` (`.../run`). Traced the full chain first rather than swapping blindly: ReAct's
    entire hardcoded tool surface (`http_get`, a never-implemented `search_web` stub,
    `calculate`, `search_kb`) is a strict subset of what script-native's `web-search`/
    `knowledge-base`/`code-exec` prebuilts already cover (no capability loss); `agent_definition_id`
    (used by @mention dispatch) is the composite `${spaceId}:${agentId}` row id and needs the
    space prefix stripped to become script-native's bare `agentId`; the response shapes are
    genuinely different (`handleRun`: `{runId, status, finalAnswer, reactSteps}`;
    `handleScriptRun`: a `LoopResult` with the answer nested at `result.result.output`) — a new
    `normalizeScriptRunResult()` helper in `workers/agents/src/index.ts` translates the latter
    back into the former's shape so mention-run's parser, the async Workflow→TaskDO chain, and
    apps/shell/apps/portal's polling need ZERO changes. Found and fixed a **separate,
    pre-existing bug** on the exact path being touched: `AgentTaskWorkflow.ts`'s step 3 read
    `body.final_answer` (snake_case) off a response that actually carried `finalAnswer`
    (camelCase) — always `undefined` at runtime, so a TaskDO-completed async run likely stored
    an empty result in production; now reads `finalAnswer ?? final_answer` defensively.
    **Deliberately NOT done: physically deleting `handleRun`/`runReActLoop`.** Their
    `agent_runs` SQLite table is shared load-bearing infrastructure for `handleGetRun`/
    `handleCancelRun`/the DO's `alarm()`-based stale-run sweep — none of which
    `handleScriptRun` populates. Deleting the ReAct code without first redesigning what backs
    status-polling/cancellation for the `Prefer: respond-sync` fallback path would strand or
    break that machinery; that redesign is separable, deferred work, tracked (not urgent, since
    nothing dispatches to `handleRun` anymore) in `docs/AUDIT_TODO.md`'s A-2 entry. New
    end-to-end test `tests/unit/agent-run-script-native-dispatch.test.ts` (5 tests) drives the
    REAL `/agent/run` route against a stubbed DO returning a realistic `LoopResult`, not just the
    normalization function in isolation. 1740/1740 tests pass (5 new), `pnpm turbo run typecheck`
    clean (75 tasks).
48. **Phase 1 of a new 5-part build (AutoRAG/AI Search, native web search, per-tenant infra usage,
    context-window UI, model switcher) is IN PROGRESS — Phase 1 (Cloudflare AutoRAG/AI Search)
    is BUILT, scoped to exactly what a research pass confirmed fits.** AutoRAG is a "point at an
    R2 bucket of documents, auto-chunk/embed/reindex" product — a good fit for the Knowledge Base
    pipeline and Memory OS's Layer 6 (Wiki, the auto-curated concept vault), a bad fit for Layer 5
    (episodic→semantic), which needs instant per-message embed+query that AutoRAG's R2-batch
    reindex cadence can't provide. Confirmed via AskUserQuestion before building. **KB pipeline**
    (`workers/knowledge/src/index.ts`): a new optional `AUTORAG_KB_INSTANCE` config — ingestion
    additionally mirrors the sanitized whole document to a `autorag/{spaceId}/{projectId}/{docId}.md`
    R2 key (best-effort, never fails ingestion), kept in sync on PATCH and cleaned up on DELETE;
    `GET .../kb/search?retrieval_mode=autorag` calls the AutoRAG instance via the existing `AI`
    binding's `.autorag(name)` accessor instead of the hand-built dense+BM25+RRF hybrid pipeline
    (still the default — `retrieval_mode` is opt-in per request, not a stored per-space policy, and
    falls back to the legacy pipeline whenever unconfigured or on any AutoRAG error). **Memory OS
    Layer 6** (`workers/agents/src/script-engine/memory-os.ts`): `upsertWikiConcept` mirrors each
    concept to R2 (`spaces/{spaceId}/memory/wiki/{scope}/{concept-slug}.md`); `searchWiki` optionally
    queries AutoRAG for semantically-matched concept names, then **always re-hydrates the actual
    `WikiArticle` from SQLite** rather than trusting AutoRAG's own unstructured result — SQLite stays
    authoritative, so a deleted/stale mirror can never surface a phantom article. **A real,
    independent bug was found and fixed while in this file**: the `wrangler.toml` binding comment for
    `MEMORY_VECTORIZE` has always claimed Layer 5 semantic recall is "queried by embedding + user_id
    filter" — the actual code only ever filtered by `spaceId`, so in shared-assistant mode one user's
    promoted episodic memories were recallable by every OTHER user sharing the same space/DO. Fixed
    with a two-query merge (Vectorize's flat `$eq` filter has no `OR`/`IN`, so a scoped user's own
    memories and genuinely space-level ones are queried separately and merged, deduped by id) —
    mirrors the exact `user_id IN (?, ?)` two-tier scoping `structured_facts`/`episodic_log` already
    used in this same file. 1757/1757 tests pass (17 new), `pnpm turbo run typecheck` clean (75
    tasks). **Phase 2 (native web search via CF AI Gateway's provider tool-passthrough) is now
    BUILT, alongside the existing Tavily-backed path (unchanged).** `@naelao/llm-gateway`'s
    `LlmTool` is now a union (`LlmFunctionTool` — Naelao's own custom function-calling shape —
    or the new `LlmNativeWebSearchTool`, Anthropic's server-executed `web_search_20250305` tool);
    `ContentBlock.type` gained `"server_tool_use"`/`"web_search_tool_result"`. `buildRequestBody`
    already passed `tools` through to Anthropic unconditionally, so `callLlm` needed no change —
    but `streamLlm`'s SSE handler previously silently DROPPED any content-block type other than
    `text`/`tool_use` (confirmed dead code, zero callers anywhere in the repo before this phase);
    fixed to capture `server_tool_use` (accumulated via `input_json_delta` like an ordinary
    tool_use) and `web_search_tool_result` (delivered whole in `content_block_start`, not via
    delta — and identified by `tool_use_id`, not `id`, unlike every other block type, a real
    bug caught by the first test draft). New `web-search.grounded_answer(query)` prebuilt op
    calls a cheap model with the native tool enabled directly — search-and-synthesize in ONE
    gateway-billed call, no Tavily round trip. **The real fix that makes this a billed call, not
    a free side-channel:** `ScriptToolSurface.run()`'s prebuilt-success branch previously
    hardcoded `tokens_used: 0` unconditionally for every prebuilt op with no way for an op that
    makes its own internal LLM call to report real usage — now reads an optional
    `output.usage.{tokens_used,input_tokens,output_tokens}` from the op's own return value, which
    `loop.ts`'s pre-existing `withTokenUsage()` then ADDS the reasoner's own usage on top of (it
    already summed rather than overwrote, so this was a one-line gap, not a redesign). 1769/1769
    tests pass (12 new), `pnpm turbo run typecheck` clean (75 tasks). **Phase 3 (per-tenant/
    per-user CF infra usage tracking) is now BUILT.** Meters Tier 2-5 isolate/container wall-clock
    time and durable CF Workflow step overhead, converts it to the platform credit unit via a new
    `infraTimeToCredits(resourceType, durationMs)` (`packages/billing-core`, the infra counterpart
    to `tokensToCredits` — same "round up, minimum 1 credit for any nonzero cost" invariant;
    isolate cheapest, container costed higher, a workflow step a small flat per-invocation fee —
    approximate default rates, documented as needing tuning against the platform's real CF
    invoice, not authoritative Cloudflare pricing). Recorded as a new `infra_credits`
    `usage_events` metric via the SAME `/billing/usage` mechanism `llm_tokens` already uses —
    for EVERY run with a measurable tier+duration, regardless of caller role (observability);
    enforcement (a monthly ceiling, 402 `infra_quota_exceeded`) is deliberately scoped narrower,
    exactly matching the pre-existing `llm_tokens` builder-quota gate's own scoping: only a
    builder (owner/admin/editor/viewer) chatting with their own Space Assistant is checked —
    project-scoped and signed-in-product-end-user runs already have their own separate wallet/
    credit gates, not extended with an infra ceiling this pass. New `monthly_infra_credits` field
    on `@naelao/entitlements`' `PlanLimits` (and `workers/billing/src/quota.ts`'s own parallel
    `QuotaLimits` table, kept in sync in the same commit per that file's own "numbers match"
    convention) + a new `GET /internal/usage/infra-credits/check` route mirroring
    `llm-tokens/check` exactly. `NaelaoAgentDO.settleRunBilling` records infra credits BEFORE its
    existing `if (!tokensUsed) return` early-out — a pure script execution with zero LLM tokens
    still consumes real isolate/container time and must not go unrecorded. CF Workflow steps
    (`ScriptRunWorkflow`'s `execute-script`, `AgentTaskWorkflow`'s `run-agent` — the two steps
    that do real dispatched work, not the trivial DO status-update steps) gained real `Date.now()`
    wall-clock bracketing where none existed before (a confirmed gap, not a pre-existing pattern)
    via a new shared `reportWorkflowStepInfraUsage` helper, since Workflow classes share the
    agents worker's plain `Env` (which needed a new `BILLING_WORKER?: Fetcher` — already bound in
    `wrangler.toml`, just missing from this particular TypeScript interface), not
    `NaelaoAgentDO`'s own env/`internalHeaders()` machinery. New Analytics Engine data point
    (`infra.execution.completed`) alongside the isolate/container recording, tenant_id in
    `indexes[0]`, best-effort. **Deliberately NOT extended this pass:** `handleChannelHeartbeat`'s
    separate per-message customer-bot debit loop (still token-credits only). 1781/1781 tests pass
    (12 new), `pnpm turbo run typecheck` clean (75 tasks). **Phase 4 (real streaming fixes +
    context-window usage UI + pre-send auto-compaction) is now BUILT, re-scoped against a real
    architectural finding.** Investigating the "check % full, compact if needed" ask found that
    the script-native loop's own per-turn reasoner payload (`GatewayReasoner.decide()`'s
    `userContent`) does NOT grow with conversation length — it's rebuilt fresh each call from a
    small fingerprint snapshot + a fixed-size candidate list, not a growing message array (that
    growing-array design lives only in the now-dead ReAct `runReActLoop`/`applyContextBudget`,
    unreferenced since item 47's A-2 cutover). So "compaction" can't mean "trim the reasoner's own
    payload" for the live path — there's nothing there to trim. Re-scoped honestly: context
    usage is measured from the session's REAL, actually-growing artifact (its persisted message
    transcript), and "compaction" means running Memory OS maintenance early, not trimming a
    payload that was never going to overflow.
    - **Real bug fixed:** the SSE endpoint (`GET .../agent/runs/:runId/stream`) emitted NAMED SSE
      events (`event: status`/`event: done`) with no `type` field in the payload. A browser's
      native `EventSource.onmessage` never fires for a named event — and all three known chat
      clients (`apps/shell`, `apps/widget`, `apps/portal`) independently check `data.type ===
      "delta"|"done"|"error"` on unnamed events, confirmed by reading all three. `onmessage`
      therefore never fired for any of them; every client's only real path to a result was
      `onerror` firing once the stream closed, falling back to plain polling — the SSE endpoint
      was silent dead weight. Fixed the SERVER to match what every client already expects (unnamed
      `data:`-only frames, `type` field) rather than changing three client files. The poll loop
      also now emits the delta between what was last sent and the run's current `final_answer` as
      a real `type:"delta"` event (today's runs only populate `final_answer` once, at completion,
      so in practice this fires once with the whole answer — true incremental mid-generation
      writes are the deferred item below, not silently claimed as done here).
    - **Real bug fixed:** `apps/shell/Chat.tsx` never checked for an in-flight run on mount — a
      reload or remount showed only history with no sign a run was still going. New
      `getActiveRunId`/`storeActiveRunId`/`clearActiveRunId` (`chatSession.ts`, same sessionStorage
      scope as the existing chat-session-id helpers) let a remount detect and reattach to its own
      in-flight run via `pollRun` + `streamRun`. Scoped honestly: this fixes reload/remount within
      the SAME tab (sessionStorage), not resumption in a genuinely new tab/browser session, which
      would need a broader localStorage-based redesign not made here.
    - **Context-window usage UI**, real this time: new `GET .../sessions/:sessionId/context-usage`
      (agents worker) returns `current_tokens` (estimated from the session's real message
      transcript, fetched from SpaceDO — chars/4 approximation, same convention used elsewhere),
      `model_window` (new `contextWindowForModel()`/`MODEL_CONTEXT_WINDOWS`, `packages/billing-core`
      — replaces the single hardcoded `MODEL_CONTEXT_LIMIT_TOKENS=190_000` in `NaelaoAgentDO.ts`,
      which was already wrong for any model but Sonnet; that dead-ReAct-code constant itself was
      left untouched rather than retrofitted, since threading a real model param through it isn't
      worth the churn for unreferenced code), `percent_full`, and day/week/month `llm_tokens` usage
      against the org's plan limit. New `getUsageSummary()` (`workers/billing/src/quota.ts`) adds
      real day/week/month rollups (only a monthly one existed before) over the same `usage_events`
      table, uncached (a UI number, not a gate decision — the existing KV-cached monthly gate check
      is untouched), exposed via a new `GET /internal/usage/llm-tokens/summary` route mirroring the
      existing `/llm-tokens/check`'s HMAC gate. New `ContextUsageMeter` component (`apps/shell`)
      renders this in the chat thread panel's Stats tab, refetching after every completed run.
    - **Pre-send auto-compaction, re-scoped:** new client-driven `POST .../sessions/:sessionId/
      compact` triggers `NaelaoAgentDO`'s existing (previously only cron-triggered hourly) Memory
      OS maintenance pass on demand, addressed at the space-wide assistant DO via the same
      `getAgentDOForSpace` helper the heartbeat cron uses. `ContextUsageMeter` calls it once when
      `percent_full` crosses 85%, gated to fire at most once per completed run rather than on every
      poll. Deliberately client-driven, not a hidden per-message server-side check — that would add
      a full extra round trip + embedding calls to every single run's hot path for a condition that
      rarely fires.
    - New router entries: `context-usage`/`compact` are implemented on the agents worker but live
      under `/spaces/:spaceId/sessions/:sessionId/...`, whose generic catch-all
      (`api.all("/spaces/:spaceId/sessions/*", ...)`) routes to SPACES_WORKER, not agents — same
      trap the `/agent/*`/`/approvals/*` sub-paths already needed their own explicit
      before-the-catch-all registration for (Phase 6's own documented finding); added the same
      explicit entries for these two, or they'd have silently 404'd against the wrong worker.
      `AgentsEnv`/Workflow classes' shared `Env` also both needed a `BILLING_WORKER?: Fetcher`
      field added — already bound in `wrangler.toml`, just missing from these two particular
      TypeScript interfaces (found while wiring the summary route + Workflow step infra-usage
      reporting in Phase 3).
    - **Deliberately NOT built this pass — true token-by-token live streaming.** The two paths that
      could deliver it: (a) run the terminal-answer LLM call with the now-real `streamLlm`
      (Phase 2) and write growing partial text somewhere the SSE poll loop can diff against, which
      needs new persistence (a partial-answer field on `agent_runs`/TaskDO updated mid-generation)
      that today's script-native path doesn't have; or (b) broadcast real per-chunk deltas through
      the already-built `WsHubDO`/`broadcastSpaceEvent` pub-sub (Phase V) and add a WebSocket
      consumer to the frontend. Both are real, scoped follow-ups — not attempted here to avoid a
      rushed schema/pub-sub change on top of an already large phase; the durability half (a run
      surviving a closed tab, Phase Q) was already real before this phase and is unaffected.
      1799/1799 tests pass (18 new: `streaming-real-deltas.test.ts` drives the REAL SSE endpoint
      end-to-end and parses actual wire-format frames, proving no `event:` line survives and every
      frame carries the `type` field clients expect; `context-window-usage-endpoint.test.ts`;
      `billing-usage-summary.test.ts`; 2 new `contextWindowForModel` cases), `pnpm turbo run
      typecheck` clean (75 tasks), `apps/shell` verified via `next build` (compiles, all routes
      generate) — not verified via a live browser session this pass (no CDP mock session run for
      this specific component, unlike some earlier phases' UI work).
    **Phase 5 (model switcher) is now BUILT — fixes the dead-code bug this build order
    predicted: `spacetypes.model_config` is read by `workers/agents/src/index.ts` but no
    migration anywhere ever created that column on `spacetypes` (confirmed by grepping every
    migration), so `modelConfig` always parsed to `{}` and every run silently fell through to a
    hardcoded model-name fallback regardless of what a builder configured.** Fixed at the root
    rather than resurrecting the dead column: `index.ts` now parses the ALREADY-FETCHED
    `spaceRow.config_json` (`SELECT * FROM spaces ...` already runs every call) for
    `productConfig.modelConfig.model` instead — the same config-override convention
    `memberBilling`/`pricingConfig`/`catalog`/`containerMarketplace` already use, avoiding a
    split-brain against the manifest exactly as CLAUDE.md's own standing rule requires. New
    `SpaceTypeProductConfig.modelConfig?: {model?: string}` field
    (`workers/spaces/src/do/SpaceTypeRegistryDO.ts`); `PATCH /builder/products/:id` validates
    against a curated `ALLOWED_MODELS` allowlist (`claude-haiku-4-5-20251001`,
    `claude-sonnet-4-6`, `claude-opus-4-8` — not arbitrary free text, for cost predictability);
    `shell/manifest` projects the resolved `model` field for the end-user shell to read.
    Dashboard: a new Model card on the Configuration tab (3-button picker, same UI pattern as
    the existing Product Mode picker), round-tripping through the same PATCH handler with zero
    new backend surface beyond the allowlist check. **Deliberately NOT wired:**
    `handleChannelHeartbeat`'s own hardcoded model default — `NaelaoAgentDO` has no
    `PLATFORM_DB` binding (confirmed via grep, zero matches), so resolving the configured model
    there would cost an extra cross-worker round trip on every hourly per-space heartbeat tick
    platform-wide for a machine-triggered, cost-conscious-by-design background path; and the
    OTHER hardcoded-model call site inside the dead legacy `handleRun`/ReAct path (unreferenced
    since item 47's A-2 cutover) — left untouched on purpose, matching that item's own scoping.
    1804/1804 tests pass (5 new: PATCH allowlist accept/reject, `/agent/run` resolving the
    configured model vs. falling back on unset/malformed `config_json`), `pnpm turbo run
    typecheck` clean (75 tasks), `apps/dashboard` verified via `next build` (32 routes).
    **With Phase 5 done, all 5 phases of this build (AutoRAG/Wiki, native web search, infra
    usage metering, real streaming + context-window UI, model switcher) are now BUILT.** Full
    plan: `docs/spec-appendix/A1-script-agents-and-space-assistants.md` §A1.24-A1.28.
49. **Wallet Connect (builder-owned payment accounts) — SUPERSEDED by item 50.** This entire
    subsystem (StripeProvider, `payment_connections` application code, the dashboard/shell
    Payments-account UI) has been REMOVED and replaced by the Whop autonomous sub-merchant
    wallet model (item 50) — every business now gets an isolated wallet auto-provisioned by
    default, no builder connect flow. Kept below as a historical record only; do not resurrect.
    Item 45 stands untouched:
    platform billing custody is LS-only; Stripe returns EXCLUSIVELY as the per-space connected-
    account rail (`selectBillingProvider("stripe")` still throws). Custody model: Stripe connect
    creates a FRESH Express account (never an OAuth link to a possibly-personal one) with
    Stripe-HOSTED onboarding — Naelao never sees KYC/bank details, and activation happens only on
    a live `charges_enabled` poll (the return redirect proves nothing, per Stripe's own docs);
    checkouts are direct charges ON that account with `application_fee_amount` auto-collecting
    Naelao's fee + any parent-builder share. LS is a guided BYO flow (LS has no OAuth and no
    create-store API — verified): key verified via store list → store picker → key + a generated
    per-connection webhook signing secret vault-encrypted (only credential NAMES in D1) → webhook
    auto-created on THEIR store; nothing can be auto-split on this rail so Naelao's fee is a
    `reseller_ledger` `kind='platform_fee_receivable'` row written at webhook time (reversed
    negative on refund; parent-builder share deliberately not attributed — nothing was collected
    to pay it from). `/internal/commerce/checkout` (the storefront's path too) routes to the
    builder's rail when a connection is ACTIVE — no connection → the Naelao-store path
    byte-identical; a broken rail on a CONNECTED space fails CLOSED (503), never falls back into
    the wrong custody. Wallet webhooks — `/v1/webhooks/stripe` (ONE platform Connect endpoint,
    connection resolved from the event's connected-account id) and `/v1/webhooks/lemon-squeezy/
    wallet/:connectionId` (per-connection vault secret) — FORCE `event.spaceId` from the
    connection row (a builder controls their own store's custom_data) and NEVER settle to the
    platform-internal wallet (the gross already sits in the builder's own account); orders are
    recorded in `launchpad_orders` (Stripe keyed `pi:{payment_intent}` so refunds match). UI:
    dashboard Billing-tab `PaymentsAccountCard` + shell business-detail card (admin-only via the
    local-grants two-gate pattern; spaces-worker wrapper sets `role=admin` toward billing only
    AFTER its own per-business admin check). **Trap re-confirmed while building:** two
    static-suffix routes under `/spaces/:spaceId/payment-connection/...` re-triggered the
    documented Hono RegExpRouter corruption — 8 UNRELATED spaces-worker routes silently 404'd in
    tests; fixed as one `:provider` param route branching internally. Always run the FULL suite
    after adding any spaces-worker route. New billing env (all optional, honest degradation):
    `STRIPE_PLATFORM_SECRET_KEY`, `STRIPE_CONNECT_WEBHOOK_SECRET`, `PUBLIC_WEBHOOK_BASE_URL`,
    plus a `CREDENTIALS_WORKER` service binding. Full detail: appendix §A1.29. 1828/1828 tests
    (24 new in `wallet-connect.test.ts`), `pnpm turbo run typecheck` clean, dashboard + shell
    `next build` verified.
50. **Whop autonomous business wallets — the business-bank-account rail — is BUILT, replacing
    item 49 entirely.** Complete restructuring per explicit user direction: every business auto-
    provisions an isolated Whop sub-merchant wallet at creation — no builder enrollment, no OAuth
    consent, no personal bank/card details needed to start. The wallet IS the business's own bank
    account: revenue in from Whop's own storefront/checkout and any connected 3rd-party platform
    (Stripe for physical goods, Shopify, Gumroad, freelance marketplaces, Amazon, eBay, and more),
    expenses out for the business's own costs, owner payouts on request — the explicit goal being
    an assistant that can take a business from $0 to real revenue with zero owner money input.
    Researched (not assumed) before building: Whop supports programmatic sub-merchant enrollment
    (no per-business OAuth click) and a programmatic withdrawal API (241+ territories, bank/
    crypto/Venmo/CashApp) — the same custody shape item 49's Stripe Connect rail had (Whop holds
    the money and runs payout compliance; Naelao only provisions/reads/requests withdrawals), but
    autonomous rather than one-extra-click. Whop's own fee is ~6-7% all-in; Naelao's cut rides on
    top via a scheduled payment-split sweep, never per-transaction.
    **Removed:** `StripeProvider` (`packages/billing-core/src/providers/stripe.ts`), `workers/
    billing/src/{wallet-connections,wallet-checkout,wallet-webhooks}.ts`, `/webhooks/stripe`,
    the Stripe/LS dashboard+shell UI. Migration 0063 stays in place, unused (D1 has no cheap
    drop-and-forget). **Built:** `packages/billing-core/src/providers/whop.ts` (sub-merchant
    provisioning, balance/status reads, split-fee checkout, programmatic withdrawal, webhook
    verify/parse — standalone functions, not forced into `BillingProvider`, same precedent
    Stripe's own Connect helpers set); migration `0064_whop_sub_merchants.sql`
    (`whop_sub_merchants`, `wallet_transactions`, `payout_destinations`, `payout_requests`);
    `workers/billing/src/whop-wallet.ts` (idempotent provisioning that never throws to its
    caller, live-synced balance reads, HMAC-gated CRUD, and the safety-critical payout-approval
    state machine — a destination's FIRST payout always creates a `pending_approval` row + a
    single-use emailed link, the actual Whop withdrawal API is never called until the owner
    clicks it; once verified, later payouts to that destination execute directly, still logged).
    Checkout routing: an ACTIVE business wallet gets Naelao-store product sales settled directly
    into it (platform fee auto-split); still-provisioning falls through to the Naelao-store path
    byte-identically so a brand-new business can sell immediately. Auto-provisioning wired into
    both `POST /spaces` and `POST /builder/products` (owner email resolved from `users`/
    `orgs.owner_id`, wrapped in try/catch so a lookup failure in an unusual deployment never
    turns a successful space creation into a 500 — caught by 3 pre-existing tests breaking on
    the first draft). **Deliberately NOT wired** for end-user-created businesses
    (`business-create.ts`): that owner is a `ProductUserDO` end user with no `users` table row;
    resolving their email needs a cross-DO round trip this file doesn't have — a real, tracked
    gap, not silently dropped. New prebuilt `business-wallet.ts` (distinct from the pre-existing
    `wallet` prebuilt, which is a different concept — a Naelao-held cost ledger; see that file's
    header) with `business_wallet.balance/history/list_destinations/add_destination/
    request_payout/list_payouts`, reserved via a new `api.whop.com` entry in
    `reserved-capabilities.ts`'s denylist (Whop is now a special case, not the Model-A read-only
    carve-out Gumroad/etc. get — the pre-existing read-only `connector-whop` MCP shim is
    unaffected). New project kind `business_wallet` in `BUSINESS_FEATURE_KIND_REGISTRY`. Both
    the generic Space Assistant and the Launchpad business-builder assistant profiles gained a
    "Business Wallet" instructions section (what it is, how revenue arrives, the payout-approval
    rule) plus the read-only ops added to the guided-mode auto-approved allowlist. Three new
    `@naelao/events` types (`business_wallet.revenue_received/.payout_requested/
    .payout_completed`) fired through SpaceDO's ALREADY-EXISTING generic external-event ingress
    (`/internal/spaces/:spaceId/events/fire` — no new firing mechanism needed). UI: dashboard
    `PaymentsAccountCard` rewritten read-mostly (balance/activity/destinations/payout history —
    the assistant runs the wallet day-to-day); shell business-detail page's old Stripe/LS block
    replaced with the equivalent, same `requireBusinessMembership` gating precedent.
    **Deliberately NOT built:** per-template bootstrap auto-creation of a `business_wallet`
    PROJECT (the wallet DATA is unconditionally auto-provisioned regardless — the project is
    only an optional UI "place"; `autoProvisionable` is an unconsumed field for every sibling
    kind platform-wide too, not a gap specific to this pass); a dedicated wallet-health heartbeat
    (subsumed by the assistant's own continuous existence + the new revenue-received event).
    1818/1818 tests pass (13 new in `whop-wallet.test.ts` — provisioning idempotency, cross-
    business isolation, webhook idempotent recording, the full payout-approval state machine,
    insufficient-balance rejection, secret hygiene; `reserved-capabilities.test.ts` updated for
    Whop's new reserved status), `pnpm turbo run typecheck` clean (75 tasks), dashboard + shell
    both verified via `next build`. Full detail: appendix §A1.30.
51. **Whop connected-account KYC/onboarding gate — item 50's real gap, now BUILT.** Whop's docs
    (their current term is "connected accounts," not "sub-merchants" — same Platforms API,
    same invite-only access) reveal that enrolling a business creates the company record
    instantly, but a recipient with no prior Whop account must ALSO complete an emailed
    KYC/onboarding link before that account can receive transfers — item 50's original
    `pending/active/error` status model would have silently told an owner their wallet was
    ready when payouts would in fact fail. Migration `0065_whop_kyc_onboarding.sql` rebuilds
    `whop_sub_merchants` (SQLite can't ALTER a CHECK constraint in place, same limitation
    migration 0052 hit) adding a fourth status, `awaiting_kyc`, plus an `onboarding_url` column.
    `createSubMerchant` (`packages/billing-core/src/providers/whop.ts`) checks a few plausible
    response field names for the onboarding link (exact name unverified — `docs.whop.com` blocks
    unauthenticated fetches, confirm once Platforms API access is granted) and returns
    `awaiting_kyc` honestly even when no link is present; `getCompanyStatus` derives
    `awaiting_kyc` from the plain `payouts_enabled: false` boolean during a live sync — a more
    reliable signal than guessing a field name, mirroring how the removed Stripe Connect rail
    polled `charges_enabled`/`payouts_enabled`. `provisionSubMerchant` best-effort emails the
    owner the moment a wallet lands in `awaiting_kyc` (never blocks provisioning on send
    failure); the payout route's 409 message names the verification step explicitly instead of
    a generic "not active." Dashboard/shell wallet UI show an amber "verification needed" banner
    with a direct link when Whop supplied one; both Space Assistant profiles were told
    explicitly that `awaiting_kyc` means "can receive revenue, cannot pay out yet — tell the
    owner, don't let a payout silently fail." 1823/1823 tests pass (5 new: onboarding-link
    capture + owner notification, straight-to-active when no link is needed, balance surfacing
    the link only while awaiting_kyc, payout rejection naming verification explicitly, live-sync
    deriving awaiting_kyc from `payouts_enabled`), `pnpm turbo run typecheck` clean (75 tasks),
    dashboard + shell both verified via `next build`. **Not done:** the exact onboarding-link
    field name and full connected-account response shape are unverified against live Whop docs —
    real Platforms API access (invite-only, apply via `sales@whop.com`) is needed to confirm and
    narrow the defensive multi-field check to the one Whop actually returns.
52. **BYO Whop connector (a business owner's OWN Whop account) is now BUILT — the working
    revenue path while the invite-only Platforms API (items 50-51) waits on approval.** User
    direction: keep the Naelao-managed business-wallet rail exactly as built (nothing deleted —
    it activates automatically the moment Whop grants Platforms access), but until then, let a
    business owner connect their OWN normal Whop account (an API key from their own Whop
    dashboard — no invite needed) so the assistant can read it and the business can operate.
    Naelao's revenue-share cut is billed the way it was BEFORE items 49-51 — the existing
    `revenue-tracker` prebuilt reads the owner's reported gross revenue and the surcharge is
    charged on the builder's NEXT platform subscription payment, not auto-split at checkout
    (a BYO/normal Whop account has no application-fee-split primitive; only the invite-gated
    Platforms/connected-accounts model does). This mechanism (a builder's own Whop API key →
    `mcp-connector`/`revenue-tracker`) already existed and was exercised via the dashboard's
    Connectors console (`GET/POST /connectors*` on the agents worker) — but that route had NO
    per-space ownership check (`requireVerifiedTenant` only proves the caller is SOME verified
    tenant, never that they own the specific `space_id` in the request body), fine for a builder
    (their JWT's tenant owns every space they have) but unsafe to open to a product end user
    directly, whose session tenant is the PRODUCT root spanning every business under it — an end
    user in Business A could otherwise have set `space_id` to Business B's space and stored
    THEIR key as Business B's connector. Fixed with new spaces-worker wrapper routes,
    `GET /spaces/:spaceId/connectors/status` (member-level) and
    `POST /spaces/:spaceId/connectors/connect` (admin-level, `platform` in the BODY not the URL —
    see below), gated by `requireBusinessMembership` exactly like `business-wallet`/`pricing`/
    `local-grants` before it, then proxying to the agents worker's already-tested connect logic
    with the space's own verified owning tenant. **A real, reproduced instance of the documented
    Hono RegExpRouter route-table-scale corruption**: the first draft used
    `POST /spaces/:spaceId/connectors/:platform/connect` (a NEW dynamic-segment-then-static-
    suffix shape) — this silently 404'd 8 UNRELATED tests across members/agent-definitions/
    sessions routes elsewhere in this same 170+-route file, not the new route itself. Fixed the
    established way: removed the extra dynamic segment (`platform` moved into the POST body)
    rather than adding a second `app.use(dynamicPattern, ...)` registration — confirms this bug
    class is still live and any new spaces-worker route needs a full-suite run, not just its own
    test file, before being trusted. Shell UI: a new "Connect Your Whop Account" card on the
    business detail page (admin-only, paste-an-API-key form) placed ABOVE the relabeled
    "Business Wallet (Naelao-managed, pending Whop approval)" section so it's unambiguous which
    path is actually live today. 1823/1823 tests pass, `pnpm turbo run typecheck` clean (75
    tasks), shell verified via `next build`. **Not done this pass:** an equivalent card in the
    dashboard's own product Configuration/Billing tabs (the dashboard's existing generic
    `/dashboard/spaces/[spaceId]/connectors` console already covers a TOP-level product/space;
    a Launchpad end-user-created BUSINESS sub-space specifically is what this pass targeted).
53. **"Connect with Whop" OAuth2+PKCE flow is now BUILT — a real redirect connect experience,
    replacing the manual-API-key-paste form as the primary path (kept as a fallback).** Research
    (web + Whop's own OAuth docs) confirmed Whop has a genuine, self-serve OAuth2+PKCE "Sign in
    with Whop" app model (Developer Dashboard → create an app → `client_id`/`client_secret`,
    registered redirect URIs) — completely separate from the invite-gated Platforms/connected-
    accounts API items 50-51 use. New `workers/agents/src/connectors/oauth.ts`: PKCE generation,
    authorize-URL building, code-for-tokens exchange, and refresh (Whop rotates refresh tokens
    on every use — always persists the new one, never reuses the old). New `ConnectorDefinition.
    oauth` field (`catalogue.ts`) carries Whop's authorize/token URLs + scopes + env-var NAMES
    for the client id/secret (never values in code). Flow mirrors the codebase's own stream-
    ticket precedent rather than putting anything sensitive in a browser-navigable URL:
    `POST /connectors/:platform/oauth/start` (authenticated) generates a PKCE pair, stashes it
    server-side under a random single-use ticket (`AGENT_CACHE` KV, 10-minute TTL) and returns
    the real authorize URL with the ticket as `state`; the frontend does an actual browser
    navigation to it — no credential in that URL, only an opaque ticket. Whop redirects the raw
    browser to `GET /connectors/:platform/oauth/callback` (PUBLIC/unauthenticated — the
    single-use ticket IS the auth, same posture as the existing webhook ingress), which exchanges
    the code server-side (holds the client secret), vaults the resulting `{access_token,
    refresh_token, expires_at}` JSON under the connector's own credential name, upserts the MCP
    server row to `auth_type: "oauth2"`, and 302-redirects the browser back to the caller's own
    `return_url` — the tokens themselves never reach the browser. New
    `POST /internal/connectors/oauth/refresh` (HMAC-gated) is the ONLY place that holds the
    Whop OAuth client secret; mcp-hub's `buildAuthHeaders` gained an `oauth2` branch
    (`resolveOAuthAccessToken`) that proactively refreshes a near-expiry token by calling this
    endpoint (5-minute buffer) rather than duplicating the secret onto mcp-hub, and falls back to
    the stale token (never throws) on a transient refresh failure — the real upstream call
    surfaces an honest 401 if the token had actually expired. New spaces-worker wrapper
    `POST /spaces/:spaceId/connectors/oauth-start` (admin-gated via `requireBusinessMembership`,
    same precedent as `connect`/`status`), proxying to the agents worker's start route with the
    space's own verified owning tenant. Shell UI: "Connect with Whop" is now the primary button
    (a real redirect), with "Use an API key instead" collapsing to the original manual form; a
    mount-time effect reads `?whop_connected=1`/`?whop_oauth_error=` off the return URL, shows a
    toast, strips the marker from the URL (so a reload doesn't re-fire it), and refreshes.
    1835/1835 tests pass (12 new in `whop-oauth-connect.test.ts` — authorize-URL construction,
    honest `oauth_not_configured` degradation, single-use ticket rejection/replay-prevention,
    token exchange never leaking into the redirect, MCP server upsert, the refresh endpoint's
    HMAC gate + token rotation, and mcp-hub's proactive-refresh/stale-fallback logic directly),
    `pnpm turbo run typecheck` clean (75 tasks), shell verified via `next build`. **Not verified
    against a live Whop OAuth app** — exact endpoint paths/scopes are per Whop's published guide,
    not exercised against a real registered app in this pass; confirm when `WHOP_OAUTH_CLIENT_ID`
    is actually issued. **Not done:** an equivalent OAuth button on the dashboard's own
    `/dashboard/spaces/[spaceId]/connectors` console (still manual-key-only) — the shell's
    per-business flow was this pass's target.
54. **Same-Whop-account-across-multiple-businesses is now detected and flagged — a follow-up to
    item 53's BYO connector, prompted by a direct architectural question: does connecting Whop via
    OAuth give each business its own isolated wallet, or can one real Whop account get silently
    shared across businesses?** Answer: the invite-gated Platforms/connected-accounts wallet rail
    (items 50-51, `business-wallet.ts`) DOES give every business a truly isolated Whop sub-merchant
    — that's unaffected. But the BYO "Connect with Whop" OAuth path (item 53, the one actually live
    today) has no such isolation: it's just an API credential onto the builder's own existing Whop
    account, so nothing stopped the same account being connected to two "different" businesses
    under one tenant, commingling their revenue/data with zero signal to the builder. Of the three
    options discussed (silently detect+warn, hard-block, or build a full attribution layer), went
    with detect+warn — a hard block would incorrectly forbid a legitimate case (a builder
    intentionally sharing one Whop account across related businesses), and a full attribution layer
    is real scope creep for what is fundamentally a soft UX signal, not a security boundary (unlike
    the sub-merchant rail, there IS no platform-enforced isolation to defend here).
    Added `openid` to the Whop OAuth scopes + a new `userinfo_url` field on `ConnectorOAuthSpec`
    (`catalogue.ts`) so the callback can resolve the connecting account's stable OIDC `sub` via
    `fetchOAuthIdentity()` (`connectors/oauth.ts`) — best-effort, never blocks the connection on a
    lookup failure. New `linkOAuthAccountAndCheckDuplicate()` maintains a KV-backed
    `{tenantId, platform, subject} → [spaceId...]` registry (`AGENT_CACHE`, no TTL — a UX signal,
    not a security boundary, so KV's ~60s eventual consistency is a non-issue here) and reports any
    OTHER space under the tenant already linked to the same account. The OAuth callback threads this
    into the success redirect as `?{platform}_oauth_warning=account_already_connected&
    {platform}_oauth_warning_space={otherSpaceId}` — the connection still completes either way.
    Shell surfaces it as a heads-up toast, not an error banner, on the business detail page.
    1839/1839 tests pass (5 new in `whop-oauth-connect.test.ts` — no warning on first connect, a
    warning that doesn't block the second business's connection, no warning reconnecting the same
    account to the same business, and the identity-lookup-itself-failing case never blocking the
    connection), `pnpm turbo run typecheck` clean (75 tasks), shell verified via `next build`.

55. **A full audit of the business-wallet subsystem (items 50-54) found and FIXED eight real bugs
    — three made connectors/channels non-functional against the real credentials worker, five
    were in the Whop payout/webhook path.** Traced every code path end-to-end (not from memory)
    rather than trusting the prior passes' own "1839/1839 tests pass" claim — the credentials-
    worker stubs those tests used accepted any POST unconditionally, so none of them could have
    caught a wrong path or a missing header.
    - **Connector/channel credential vaulting was silently broken on all three write paths**
      (manual `/connectors/:platform/connect`, the OAuth callback, the OAuth refresh route): all
      three omitted `scope` when storing a credential, which the credentials worker defaults to
      `scope='user'` — but mcp-hub's `buildAuthHeaders` (and the webhook-secret lookup) resolve
      credentials with NO acting-user context at all, and `resolveCredential()` skips the
      user-scope tier entirely when `actingUserId` is null. A `scope='user'` row can therefore
      never be read back by the code meant to use it — every "successful" connect silently left
      the connector unusable. The manual connect route also omitted `x-naelao-user-id` (the real
      credentials worker 400s without one — masked because the test stub didn't check). Fixed
      with one shared `storeConnectorCredential()` helper (`workers/agents/src/index.ts`) used by
      all three call sites, always `scope='space'` + `x-naelao-role: admin` — matches the pattern
      `whop-wallet.ts`'s own `storeVaultCredential` already got right. The OAuth refresh route
      also silently discarded its persist-response `ok` check; since Whop rotates the refresh
      token on every use, a lost persist would have permanently bricked the connection — now
      surfaces `credential_store_failed` instead.
    - **`POST /channels/:channel/connect` posted to `/v1/spaces/:spaceId/credentials`** — a path
      that doesn't exist (only the credentials worker's internal plaintext-resolution route
      carries a `/v1` prefix; the CRUD route doesn't) — plus the same missing-user-id/missing-
      scope bugs above. Every channel (Slack/Discord/email/WhatsApp) connect 502'd against a real
      deployment. Fixed via the same shared helper.
    - **Payout approval executed real money movement from a bare GET** — a documented risk class
      (Outlook SafeLinks/Mimecast prefetch GET links) that could trigger a payout before a human
      ever saw the email, and a read-then-write race let two concurrent hits (a scanner + the
      real click) both execute the same withdrawal twice. Split into `renderPayoutApprovalPage`
      (GET, side-effect-free, renders a confirm page naming the amount AND destination) and
      `confirmPayoutApproval` (POST-only, reached exclusively by a real form submit), gated by an
      atomic `UPDATE ... WHERE status='pending_approval'` — `meta.changes !== 1` means someone
      else already claimed it, so a race can only ever execute once.
    - **The approval link never expired.** Added `payout_requests.expires_at` (migration 0066,
      7-day TTL matching `business_invites`/password-reset-token precedent) — a leaked or
      forwarded email no longer works forever.
    - **`provisionSubMerchant`'s idempotency check treated ANY existing row — including
      `status='error'`— as done**, contradicting this file's own header/migration 0064's comment
      promising a retry. A transient Whop outage (or provisioning attempted before
      `WHOP_PLATFORM_API_KEY` was configured) permanently stranded a business walletless. Now
      retries (updates in place) when `existing.status === 'error'`, no-ops otherwise.
    - **The Whop webhook fired `business_wallet.revenue_received` unconditionally**, even when
      `INSERT OR IGNORE` deduped a redelivered event to a no-op — Whop delivers at-least-once, so
      a redelivery would double-fire any no-code trigger wired to it (duplicate thank-you emails,
      duplicate assistant reactions). Now checked against `meta.changes`.
    - **`withdrawal.completed`/`withdrawal.failed` events were recorded blind, double-counting
      every completed payout** (once at execution time, once again from the webhook) **and
      recording a failed withdrawal as a NEGATIVE 'expense' transaction** (backwards — a failed
      payout returns funds, it doesn't spend them). `WhopWalletEvent` gained `externalId` (Whop's
      own withdrawal id, `data.id`) so the webhook handler reconciles against the
      `payout_requests` row already created at execution time instead of blindly appending a
      second ledger row; `withdrawal.failed` now flips that row to `'failed'` and inserts a
      correctly-signed positive reversal, idempotent via the request's own status.
    - **A destination flipped to `'verified'` the moment Whop ACCEPTED a withdrawal, before
      knowing whether it actually succeeded** — if it later failed, the destination stayed
      verified despite a 0% success rate, so the NEXT payout would skip approval entirely. The
      `withdrawal.failed` handler above now reverts the destination to `'pending'` when no OTHER
      payout to it has ever completed.
    - One prior-audit claim (a router route allegedly missing a `/` before `:platform`) was
      checked against the actual code and found to be already correct — not fixed because it
      wasn't broken; flagging findings without re-verifying against current source is exactly the
      mistake this pass was trying to avoid repeating.
    Also fixed a stale-build trap while testing: `packages/billing-core` resolves via its
    compiled `dist/` (not the TS source) for every consumer — `WhopWalletEvent`'s new field was
    invisible to `workers/billing` until `dist/` was rebuilt (`npx tsc` in that package); anyone
    editing `packages/*` and seeing "impossible" test failures should suspect this first.
    New dedicated test file `connector-channel-vault-write.test.ts` (a credentials-worker stub
    that actually mirrors the real worker's path/header/scope contract, unlike the pre-existing
    permissive stubs) plus 20 new/hardened cases across `whop-wallet.test.ts` and
    `whop-oauth-connect.test.ts`. 1852/1852 tests pass (24 new), `pnpm turbo run typecheck` clean
    (75 tasks).
56. **Growth-layer "click Install" connectors (AUDIT_TODO.md G-1/G-3) are now BUILT — the core
    Composio hosted-connect mechanism plus real social + image/video-gen connectors, not just
    catalogue placeholders.** Direction: most of what a business needs beyond the wallet/email is
    a real third-party app reached over MCP, installed the way Claude/ChatGPT bundle connectors —
    click Connect, authenticate on the real app's own page, done. Researched Composio's current
    API before building (its `initiate()` flow is deprecated as of 2026-07-03 in favor of hosted
    "Connect Link"): new `workers/agents/src/connectors/composio.ts` (`startComposioLink`/
    `getComposioConnectionStatus`, defensive multi-field response parsing since the exact v3 REST
    shape isn't verified against a live key in this pass — same "confirm once real access exists"
    precedent as Whop's KYC field-name handling, item 51) plus new
    `POST /connectors/:platform/provider-connect/start` and
    `GET /connectors/:platform/provider-connect/callback` routes on the agents worker, mirroring
    the existing Whop OAuth2+PKCE flow's ticket-based security model (opaque single-use ticket in
    the callback URL, never a credential) but simpler since Composio hosts the entire OAuth dance
    itself — the callback POLLS Composio's real connection status before registering the MCP
    server (never trusts the redirect alone), so a bailed-out consent flow never gets silently
    marked connected. New `ConnectorDefinition.composio` field (`catalogue.ts`) plus 5 new
    `available` connectors: **Higgsfield** (image/video gen — a `direct` bearer-auth connector
    like Whop/Gumroad, since Higgsfield ships its OWN hosted MCP server, no Composio needed) and
    **X/Twitter, LinkedIn, Instagram, TikTok** (Composio-routed social posting/scheduling/
    analytics) — plus `coming_soon` Composio placeholders for HubSpot (CRM), Google Ads, Meta Ads,
    and AgentMail (an advanced agent-dedicated inbox, distinct from the built-in `business-email`
    default). Growth skills (`workers/agents/src/launchpad/growth-skills.ts`, same seeded-
    stored-script pattern as `scaling-skills.ts`): `social-post`, `content-generate-image`,
    `content-generate-video` — thin wrappers over `mcp.call`, seeded into every Launchpad space at
    provision time. **Onboarding + runtime "prompt to install" (the actual UX ask, not just the
    plumbing):** `LaunchpadTemplate.connectors` (already existed, only `whop-seller` used it)
    projects through `shell/manifest.template_catalog` end-to-end; three templates
    (`creator-store`, `newsletter-business`, `whop-seller`) now recommend real connectors. A new
    "Connect Apps" panel on the shell's business detail page renders every available connector
    with a real Connect button (branches on Composio-hosted / bespoke-OAuth / manual-key) and a
    client-only "Skip for now" (explicitly allowed per the ask; not a server-side gate).
    `mcp-connector.ts`'s `resolveServerId` now returns a `needs_connector`-flagged error (mirrors
    the existing `reserved` flag pattern) naming the EXACT catalogued app to connect instead of a
    bare "not found" when an agent calls an unregistered-but-known connector — threaded through as
    real `ScriptRunResult` fields (`needs_connector`/`connector_id`/`connector_name`), not just
    buried in message text, so both the model's own answer and a future UI can act on it. Both
    Space Assistant profiles (`profiles.ts`) gained instructions telling the assistant to name the
    exact app and point the owner at the Connect Apps panel rather than silently giving up.
    Router: new unauthenticated `/v1/connectors/:platform/provider-connect/callback` (same posture
    as the OAuth callback — the ticket IS the auth) + a new end-user allowlist entry for
    `/spaces/:id/connectors/provider-connect-start` (admin-gated via `requireBusinessMembership`
    on the spaces worker, same precedent as `connect`/`oauth-start`). 1866/1866 tests pass (34
    new), `pnpm turbo run typecheck` clean (75 tasks), `apps/shell` verified via `next build`.
    **Not done this pass (tracked in `docs/AUDIT_TODO.md`, not silently dropped):** Pipedream's
    own hosted-connect flow (mcp-hub already tool-call-proxies to a Pipedream connection once one
    exists, but nothing initiates one — Composio alone already covers every app named in this
    pass); the remaining G-2/G-5/G-7/G-8/G-9/G-10 gaps (paid ads spend management, voice calling,
    site monitoring, a CRM data primitive, domain registration, a skill marketplace); and an
    actual live `COMPOSIO_API_KEY` + per-app Auth Configs, without which every provider-connect
    flow degrades honestly to `provider_not_configured`.
57. **MCP connect fixes: Composio's REVOKED status + connected_account_id preference, and
    Pipedream Connect built as the second hosted provider (item 56's own deferred item) — closing
    the "mcp-hub already proxies Pipedream tool calls but the auth model was never verified"
    gap.** Verified against Pipedream's own docs (not assumed): its REST API, including Connect,
    is OAuth `client_credentials`-ONLY — there is no static-API-key path the way Composio has one.
    The prior `PIPEDREAM_API_KEY` (both in mcp-hub's `resolveProviderApiKey` and in the
    then-nonexistent connect flow) was therefore never going to work against a real Pipedream
    project. Fixed at the root: `PIPEDREAM_CLIENT_ID`/`PIPEDREAM_CLIENT_SECRET` (workspace OAuth
    client) exchanged for a short-lived access token — mcp-hub does this itself for the tool-call
    proxy (`getPipedreamAccessToken`, module-scoped cache, mirrors the same pattern in
    `workers/agents/src/connectors/pipedream.ts`), and the agents worker does it to start/poll a
    connection. New `ConnectorPipedreamSpec` (`catalogue.ts`) — unlike Composio, Pipedream's
    managed auth needs no pre-created per-app "Auth Config," just an app slug — and a real
    available connector, **Notion**, proves the mechanism end-to-end (new `productivity`
    category). `/connectors/:platform/provider-connect/{start,callback}` now branch on
    `connector.composio` vs `connector.pipedream`, sharing one extracted MCP-server-upsert helper
    so the two providers can't drift. Pipedream's `success_redirect_uri` param (confirmed via its
    docs) plays the same role Composio's `callback_url` does — the hosted Connect Link redirects
    the browser back to OUR callback, which polls `GET .../accounts?external_user_id=&app=` for a
    REAL healthy connected account (fails closed on an unrecognized/unhealthy row) before
    registering — same "never trust the redirect alone" rule as Composio/Stripe Connect. Also
    fixed, independent of Pipedream: Composio's connection-status poll now maps `REVOKED` (a real,
    distinct status — the end user disconnected the app after it was once active) to its own
    `connection_revoked` reason instead of falling into the generic `UNKNOWN` bucket, and
    `startComposioLink`'s field-parsing now prefers `connected_account_id` (confirmed top-level
    snake_case per Composio's own SDK source) ahead of the other defensive fallback names.
    1880/1880 tests pass (30 new: Composio REVOKED + field-preference cases, a full
    `pipedream-connector-connect.test.ts` mirroring the Composio suite, mcp-hub's OAuth-exchange
    auth model, a catalogue snapshot update), `pnpm turbo run typecheck` clean (75 tasks).
    **Not done:** an actual live Pipedream OAuth client + project — the code degrades honestly
    (`provider_not_configured`) until `PIPEDREAM_CLIENT_ID`/`PIPEDREAM_CLIENT_SECRET`/
    `PIPEDREAM_PROJECT_ID` are set (see `docs/DEPLOYMENT_SECRETS.md`); the exact JSON field names
    of Pipedream's `/accounts` listing response are unverified against a live project (same
    "confirm once real access exists" precedent as Composio's own header) — the status check
    defensively tries a small set of plausible field/status names and fails closed on anything it
    doesn't recognize.

58. **Whop added as a second PLATFORM billing provider (AUDIT_TODO.md AI-7), replacing Lemon
    Squeezy as the FIRST-TRIED provider for builder platform plans and end-user subscriptions/
    credit-packs — LS stays as the fallback, item 45 is not reverted.** Trigger: the operator
    couldn't activate a Lemon Squeezy store because LS's own onboarding requires a Stripe-linked
    payout path unavailable in their country. Two genuinely different Whop relationships were
    built, neither the same as the invite-gated Platforms API (items 50-51, business-wallet
    sub-merchants) or the read-only "Connect with Whop" OAuth connector (item 53):
    - **Platform-plan checkout** (`packages/billing-core/src/providers/whop-platform-plan.ts`):
      Naelao's OWN normal Whop seller/company account (`WHOP_API_KEY` — no invite needed, the
      same relationship any Whop creator has) sells the builder Growth/Business plans directly.
      `/billing/checkout` tries Whop first, falls back to LS, then the dev placeholder;
      `/billing/portal` returns Whop's fixed self-serve orders page (`whop.com/orders/` — Whop
      has no API-mintable per-customer portal session the way Stripe/LS do) when the org's
      subscription is Whop-backed. New `POST /webhooks/whop-platform-plan` (Naelao's OWN
      company's webhook, a DIFFERENT secret than the sub-merchant wallet's `WHOP_WEBHOOK_SECRET`)
      parses `membership.went_valid`/`went_invalid`/`payment.succeeded` into the SAME
      `NormalizedBillingEvent` shape LS already produces — `NormalizedBillingEvent.provider`
      widened to `"lemon_squeezy" | "whop"` and `recordPlatformPlanSubscription` (unchanged
      logic) now branches only on which id-columns to write (migration 0067 adds
      `subscriptions.whop_customer_id`/`whop_subscription_id`, `ls_*` columns untouched — same
      "no cheap DROP COLUMN" precedent 0062 set for Stripe→LS).
    - **End-user OAuth-delegated checkout** (`whop-oauth-checkout.ts` + `workers/billing/src/
      whop-oauth-billing.ts`): `/internal/business-subscriptions/checkout` and `/internal/
      credit-packs/checkout` now try the BUSINESS's own connected Whop company first (via the
      existing "Connect with Whop" OAuth token, vaulted under `WHOP_OAUTH_TOKENS`) before falling
      back to LS. Settles 100% into that business's own Whop balance — there's no payment-split
      primitive on a normal OAuth token, so Naelao's cut is NOT auto-split at checkout; it
      reaches the ledger via the EXISTING revenue-tracker prebuilt's periodic `list_payments`
      poll of that same account (a checkout created here is indistinguishable from any other
      sale on the business's Whop company), needing no new fee-tracking mechanism. Required
      widening the OAuth app's scopes (`checkout_configuration:create`, `plan:create`,
      `access_pass:create`/`update`, `checkout_configuration:basic:read` — Whop's real
      per-endpoint scope requirements, confirmed via Whop's own docs) — an already-connected
      business must reconnect once, since OAuth doesn't retroactively grant new scopes to an
      existing token. Credential resolution + proactive refresh in the billing worker mirrors
      mcp-hub's `resolveOAuthAccessToken` exactly (same short-lived HMAC credential-token scheme,
      same "refresh via agents worker, fall back to the stale token on a transient failure"
      posture) — duplicated rather than shared, matching this codebase's own mcp-hub/credentials
      precedent of each holding its own copy of `generateCredentialToken`. Mints a fresh Whop
      access_pass+plan+checkout_configuration per checkout call (documented v1 simplification,
      not a caching gap — a business's Whop account absorbs the minor tidiness cost, not a real
      one, exactly like revenue-tracker's own documented pagination cap).
    - **Also resolved in the same pass:** the operator's own admin org needs no billing code at
      all — `EntitlementsChecker.getTenantTier()` already reads `orgs.plan_tier` directly and the
      dashboard's Settings page already hides the entire upgrade/checkout prompt at
      `plan_tier === 'enterprise'` (`{planTier !== "enterprise" && (...)}`), so a single
      `UPDATE orgs SET plan_tier = 'enterprise' WHERE id = ?` is the complete fix — no new
      "billing_exempt" flag needed for a one-org exemption when the tier system already covers it.
    - **Composio SDK migration** (user preference, logged not yet built): AUDIT_TODO.md AI-6 —
      swap `connectors/composio.ts`'s hand-rolled `fetch()` calls for the official `@composio/
      core`/`@composio/slim` SDK, contingent on confirming CF-Workers-bundle compatibility first
      (the hand-rolled version was a deliberate choice to avoid that unverified risk, not
      laziness).
    - **Pipedream-as-Tier-2-5-replacement — investigated, NOT adopted** (AUDIT_TODO.md AI-8):
      Pipedream's per-user connected-account isolation (`external_user_id`) is real and already
      correctly used by the Notion connector, but its custom-code steps are pre-authored
      pipelines, not an on-demand `run(code, tier)` API — using it as a general code-execution
      backend would mean evaluating arbitrary, multi-tenant agent-generated code inside an
      execution model Pipedream doesn't document or market as a safe untrusted-code sandbox the
      way CF's V8 isolates/gVisor containers are. Its free tier (100 credits/month ≈ 50 minutes of
      compute platform-wide, 3 workflows, 3 connected accounts) also can't carry real load. Kept
      as a connector only; the CF Workers Paid plan's flat $5/month remains the real Tier 2-5
      unlock once the first bootstrap business has revenue.
    1904/1904 tests pass (22 new: `whop-oauth-checkout.test.ts`,
    `whop-platform-plan-billing.test.ts`, `whop-oauth-business-billing.test.ts`),
    `pnpm turbo run typecheck` clean (75 tasks). **Not done:** an actual live Whop OAuth
    app/company + real Growth/Business plans provisioned — the code degrades honestly
    (falls through to LS, then the dev placeholder) until `WHOP_API_KEY`/
    `WHOP_GROWTH_PLAN_ID`/`WHOP_BUSINESS_PLAN_ID`/`WHOP_PLATFORM_PLAN_WEBHOOK_SECRET` are set (see
    `docs/DEPLOYMENT_SECRETS.md`); exact Whop plan/checkout-configuration field names are Whop's
    documented REST conventions, not confirmed against a live company in this pass (same
    "confirm once real access exists" precedent every other Whop integration point in this repo
    already carries).

59. **Harness Excellence Program (a comparison against Claude Code/OpenClaw/Hermes-Nous +
    SkillOpt-Lite research, phased HX1-HX6) is now IN PROGRESS — Phase HX1 (agent trace layer)
    is BUILT.** Research verdict on SkillOpt-Lite (an offline Python skill-optimization toolkit,
    arXiv:2607.03451): not a runtime dependency (wrong shape/language), but its three principles
    — trajectory exploration, consensus failure-attribute mining, independent validation gating —
    map directly onto our own skill library (versioned scripts, `stability_score`, rollback,
    DISTILL already exist; what's missing is a real eval-gate and an automated improvement loop,
    tracked as HX3→HX4). The harness comparison's single highest-leverage finding: the
    script-native loop already computes per-phase timing/tier/token data at every boundary but
    discarded it into an ephemeral `notes: string[]`, and the fully-built `packages/tracing`
    (Span/Tracer/ActiveSpan → Analytics Engine) had zero consumers anywhere in the repo — every
    later phase (signals, live-agent eval, skill self-evolution) needs real per-step traces as
    input, so this had to land first. New `TraceStep`/`LoopResult.trace` (`script-engine/
    types.ts`); `runScriptLoop` (`loop.ts`) records a step at OBSERVE/FIND/GATE, every
    `reasoner.decide()` call, and every `tools.run()` call site (5 total), attached at all ~10
    return sites via one `finish()` closure so no exit path is left untraced. `NaelaoAgentDO`
    gained a `run_traces` SQLite table (script-native runs mint their own `runId` with no
    `agent_runs` row backing them — this is the first persisted-by-id record of one) plus a
    best-effort Analytics Engine mirror (one root span + one child span per step) when
    `ANALYTICS` is bound, degrading to SQLite-only otherwise. New builder-facing
    `GET /spaces/:spaceId/sessions/:sessionId/agent/runs/:runId/trace` (builder-only — a
    `product_end_user` caller is refused before the DO is ever reached, same rationale as
    `agent-activity`'s own gate). MCP connect verification (the plan's HX6) turned out to already
    be fully built (item 57 — Composio REVOKED mapping + `connected_account_id` preference,
    Pipedream Connect as the second hosted provider) — no new work needed there. 1914/1914 tests
    pass (10 new), `pnpm turbo run typecheck` clean (76 tasks). Full detail: appendix §A1.31.
    **Not done this pass:** HX2 (explicit/implicit signals + a per-session token-budget guard —
    the actual fix for OpenClaw-style "$300-500/mo, no warning" complaints), HX3 (a live-agent
    eval harness + golden benchmark datasets, the precondition for HX4), HX4 (SkillOpt-style
    validation-gated skill self-evolution), HX5 (skill supply-chain hardening ahead of any future
    marketplace, motivated by ClawHub's 341 malicious skills).
60. **Harness Excellence Phase HX2 (signals + session token-budget guard) is now BUILT.**
    Explicit signals need no new ingestion: `agent_activity_log` (item 40's cross-DO
    observability mirror) already carries everything error rate / avg-total cost need — new
    `GET /spaces/:spaceId/agent-signals?project_id=&window_hours=` (SpaceDO, builder-only, same
    gate as `agent-activity`) rolls it up on read, plus a "regenerations" proxy (2+ run events on
    the SAME thread within 5 minutes) computed in application code rather than a SQL window
    function. Implicit signals: new `detectImplicitSignals()` (`packages/events`) — regex/
    keyword-based `user_frustration`/`agent_forgot` detection (deliberately NOT a repeated-goal
    check, which the explicit regeneration signal already covers more precisely from real
    timestamps) — wired into `/agent/run` right after `agentId` resolves, fire-and-forget to a
    new `agent_signal_events` table (SpaceDO migration v31). The session token-budget guard is
    the real fix for OpenClaw-style "$300-500/mo, no warning" complaints: new
    `SpaceTypeProductConfig.limits.sessionCreditCeiling` (config_json override, resolved once in
    `index.ts` next to `modelConfig` since `NaelaoAgentDO` has no `PLATFORM_DB` binding, threaded
    through all three dispatch paths — sync, async Workflow, and `/internal/tasks/:taskId/run` —
    so interactive and durable runs are gated identically) plus a new `session_spend` tally table
    (same migration). `enforceRunGates` gained a `checkSessionBudget` branch, checked FIRST
    (session-scoped, ahead of every payer-specific gate): under 80% no-ops; 80-100% fires
    `agent.session_budget_warning` through the ALREADY-EXISTING `/internal/events/fire` →
    `event_triggers` machinery (no new trigger type) and marks a one-shot `warned_80` flag; at
    100% refuses the run (`402 session_budget_ceiling`) and reuses the HITL approval mechanism —
    no new gate engine, per the plan's explicit direction — keyed on `run_id: sessionId` +
    `tool_name: 'session_budget_continue'` so a second concurrent run finds the SAME pending
    request instead of opening a duplicate, and an approval resets the tally for a fresh spending
    cycle rather than permanently disabling the guard. Fails CLOSED when `HITL_APPROVAL_DO` isn't
    configured. `settleRunBilling` gained the matching post-run tally increment, but ONLY when a
    ceiling is actually configured (zero added round-trip cost for spaces that never opt in). A
    real router-shape trap was caught and avoided BEFORE it broke anything this time: the first
    draft's session-spend wrapper routes used one path per action
    (`/session-spend/:sessionId/continue` etc.) — exactly the dynamic-segment-then-static-suffix
    shape that has repeatedly triggered the documented Hono RegExpRouter route-table-scale
    corruption (items 40, 52) — collapsed to a single `GET/POST .../session-spend/:sessionId`
    route with POST's `action` field carrying the operation instead. **Deliberately scoped out:**
    a builder/end-user-facing session-spend read endpoint (budget-meter UI) — the new endpoints
    stay internal-only or builder-only this pass, same precedent as `agent-activity`. 1946/1946
    tests pass (32 new), `pnpm turbo run typecheck` clean (76 tasks). Full detail: appendix
    §A1.32. **Not done this pass:** HX3 (live-agent eval harness + golden benchmark datasets, the
    precondition for HX4), HX4 (SkillOpt-style validation-gated skill self-evolution), HX5
    (skill supply-chain hardening).
61. **Harness Excellence Phase HX3 (live-agent eval harness) is now BUILT.** `workers/eval`
    (G-Q03) had two real, previously-undetected gaps confirmed by reading the deployed code: it
    only ever judged a case's raw `input` text as if it WERE the agent's answer — never actually
    invoking an agent, so it could never catch a real reasoning-loop/tool/skill regression — and
    its judge called `api.anthropic.com` directly with a hardcoded model, bypassing the CF AI
    Gateway vendor cutover (item 45) every other LLM call site already went through; this worker
    was the one spot that pass missed. New `mode: "agent"` on `POST /v1/evals/:id/run` (default
    stays `"text"`, byte-identical to prior behavior) dispatches a REAL
    `POST /spaces/:space_id/sessions/:session_id/agent/run` per case — `mintInternalToken` +
    `x-naelao-tenant-id` + `Prefer: respond-sync` (the same escape hatch Phase Q's async-by-
    default dispatch documents) — then judges the agent's actual final answer, never the raw case
    text. A failed agent run is recorded as `score: 0` with `agent_error` and never reaches the
    judge. The judge itself now routes through `@naelao/llm-gateway`'s `callLlm` (new
    `NAELAO_ACCOUNT_ID`/`NAELAO_GATEWAY_ID`/`NAELAO_AIG_TOKEN` wrangler.toml vars/secret, repeated
    in `[env.staging]`/`[env.production]` per the documented vars-replacement gotcha), falling
    back to a direct Anthropic call via the now-optional `EVAL_LLM_KEY` only when the gateway
    isn't configured. Per the plan's own research finding (~20% of "solved" SWE-bench entries are
    reward-hacked), the judge now scores `correctness` and `semantic_validity` as separate
    subscores and takes their MIN as the overall score — a keyword-stuffed non-answer that scores
    high on correctness but doesn't actually address the task can't average out to a pass. Three
    golden datasets (`tests/eval-datasets/*.jsonl`, 17 cases total, `EvalCase[]`-shaped so they
    load straight into `POST /v1/evals`): `tool-use-policy.jsonl` (verify-before-acting, refusal,
    real search grounding), `multi-step-web-file.jsonl` (multi-source synthesis, KB/file
    grounding), `commerce-business-ops.jsonl` (the platform's own domain, where no public
    benchmark exists — payout-approval, `awaiting_kyc`, `free_tier_eligible` gating, STOP/opt-out,
    session-budget non-bypass, cross-business Whop-account detection). New
    `infra/scripts/run-eval-suite.mjs` (dependency-free Node, manual dispatch only — costs real
    tokens, not wired into CI) finds-or-creates a suite via the real `/evals` API, runs it in
    `mode=agent`, and exits non-zero on a regression beyond `--threshold` versus the suite's own
    last stored result — the regression gate the plan called for, not yet pointed at a live
    deployment (none exists yet — see the live-access discussion earlier in this session).
    1953/1953 tests pass (7 new: `eval-worker-agent-mode.test.ts` drives the real Hono app
    end-to-end — suite creation, unchanged text-mode behavior, agent-mode's exact request shape
    to `AGENTS_WORKER`, a failed run never reaching the judge, `agent_definition_id` passthrough,
    the MIN-of-subscores scoring, and the judge's CF AI Gateway URL/header routing), `pnpm turbo
    run typecheck` clean (76 tasks). Full detail: appendix §A1.33. **Not done this pass:** HX4
    (SkillOpt-Lite-style validation-gated skill self-evolution), HX5 (skill supply-chain
    hardening).
62. **First real end-to-end signup on the live deployment found and fixed two genuine,
    platform-wide, previously-undetected production bugs — neither caught by ~1900 passing unit
    tests because the test suite's fakes don't enforce the same restrictions as the real
    Cloudflare runtime.** Diagnosed live via `wrangler tail` against the actual deployed
    `naelao-router`/`naelao-auth` workers (the user supplied a real CF API token for this
    purpose), not from memory or static reading.
    - **Every Durable Object's init routine ran a PRAGMA Cloudflare's real SQLite-backed DO
      storage rejects outright.** `ensureInit()`/migration-`up` blocks across ~12 DO classes
      (`RateLimitDO`, `RateLimiterDO`, `NaelaoAgentDO`, `TaskDO`, `HITLApprovalDO`, `SpaceDO`,
      `BuilderAccountDO`, `SpaceTypeRegistryDO`, `FeatureFlagDO`, `ProductUserDO`,
      `TransactionCoordinatorDO`, `LockDO`) ran `PRAGMA journal_mode=WAL` (plus `synchronous`/
      `cache_size` in a couple of spots) — this codebase's own established "DO SQLite Pattern"
      convention. A live tail session against the deployed router caught the real exception:
      `Error: not authorized: SQLITE_AUTH` thrown inside `RateLimitDO.ensureInit`, which the
      pre-auth rate limiter's fail-closed design (item 39) correctly turned into an immediate
      429 on literally the first request ever — meaning every DO on the entire platform would
      throw this same error on first use in production. The Node-based `node:sqlite` test shim
      doesn't enforce Cloudflare's restricted PRAGMA authorizer, so 1953 passing tests never
      caught it. Fixed by removing every PRAGMA statement from DO init across all 12 files —
      Cloudflare's own SQLite storage manages journal/sync/cache behavior itself; the codebase's
      CLAUDE.md instruction to set WAL mode was simply wrong for the real runtime and is
      corrected above.
    - **PBKDF2 password hashing used 600,000 iterations — 6x Cloudflare Workers' WebCrypto
      ceiling of 100,000.** After the DO fix cleared the 429, `/v1/auth/register` still 500'd;
      a second live tail session on `naelao-auth` caught the real cause:
      `NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not supported
      (requested 600000)`. Two independent implementations shared this bug — `@naelao/crypto`'s
      `hashPassword` (used by product end-user auth) and `workers/auth`'s own duplicated
      `hashPassword` (the builder's own account, G-B02) — both hardcoded `600_000`. Node's
      `crypto.subtle` has no such cap, so this was invisible to every unit test that hashes a
      password. Fixed both to `100_000` (the platform's real ceiling, not a deliberate security
      tradeoff); `verifyPassword` reads the iteration count from the stored hash in both
      implementations, so this is backward-compatible with any hash stored under a different
      count (moot here — no password had ever been successfully hashed and stored before this
      fix, since register always 500'd).
    - Both fixes were deployed live (`naelao-router`, `naelao-agents`, `naelao-spaces`,
      `naelao-security-gateway`, `naelao-auth`) and verified against the real infrastructure:
      `POST /v1/auth/register` → `201` with a real JWT; `POST /v1/auth/login` → `200`; the new
      user row confirmed present in the live D1 database via a direct query. This is the
      platform's first-ever confirmed real signup. Also rebuilt+redeployed `apps/dashboard` to
      CF Pages production (`--branch=main`) with `NEXT_PUBLIC_API_URL` actually set (it had never
      been set on any prior manual deploy, silently falling back to `http://localhost:8787` per
      `apps/dashboard/src/lib/api.ts`'s own fallback default — the literal cause of the
      originally-reported "fetch failed") — `naelao-dashboard.pages.dev` now resolves for the
      first time (every prior deploy had only ever landed as a preview, never promoted to
      production, since no deploy before this one used a branch matching the Pages project's
      configured production branch).
    1953/1953 tests pass (1 assertion updated for the new iteration count), `pnpm turbo run
    typecheck` clean (76 tasks). **Not done this pass:** an equivalent redeploy of the other ~28
    workers with these same two fixes baked in (only the 5 on the direct signup path were
    redeployed) — every other DO-backed worker (billing, knowledge, notifications, etc.) still
    runs the pre-fix code in production and will throw the identical `SQLITE_AUTH` error the
    moment any of ITS Durable Objects are first used; redeploying the full platform is the
    natural next step, not done here to keep this diagnostic pass scoped to the reported bug.
63. **Two real, previously-undetected bugs on the live Product Creation Wizard — reported by the
    user against the deployed dashboard — found and FIXED: a wrong D1 column name that broke
    EVERY wizard launch carrying `product_config` (step 6, "An unexpected error occurred"), and a
    SpaceType registry that had silently never been seeded in production (step 2 showed only the
    "Whop Seller" Temple card with no SpaceType section, reading as if Whop Seller were the
    product type instead of a Temple within Launchpad).**
    - **Wizard launch 500 (root cause):** `createSpaceRecord` (`workers/spaces/src/create-space.ts`)
      queried `SELECT config_schema FROM spacetypes` — the real migration
      (`infra/migrations/0003_spaces.sql`) names this column `schema_json`, never `config_schema`.
      Since the wizard's `launch()` (`apps/dashboard/.../products/new/page.tsx`) always sends
      `product_config` (hence `configOverrides` is always set), this D1 "no such column" error
      threw on literally every wizard launch, uncaught, surfacing through the generic
      `errorResponse` handler as exactly the reported "An unexpected error occurred" 500. Two test
      files' hand-rolled fake `spacetypes` schema used the SAME wrong column name as the buggy
      application code (`config_schema`), which is why ~1953 passing tests never caught it — the
      same "test double diverges from the real migration" failure mode CLAUDE.md already
      documents for the earlier `organizations`/`orgs` bug. Fixed: query `schema_json` (matching
      the real migration); wrapped the whole lookup in the existing try/catch (defense in depth —
      a missing/malformed schema must never block creation); fixed the fake schema in all 6 test
      files that declared it (`create-space-record`, `product-wizard-api`,
      `conversation-access-gate`, `model-switcher-config-resolution`,
      `free-tier-template-gating`, `builder-dashboard-api`); the pre-existing "merges productConfig
      overrides" test in `create-space-record.test.ts` already exercised exactly this path with no
      `spacetypes` row present and now serves as a real regression test against the correct schema.
    - **Step 2 showing Whop Seller as if it were a SpaceType (root cause):** the wizard's
      SpaceType step correctly renders two separate sections — Temples (`GET /templates`, wraps
      `LAUNCHPAD_TEMPLATES`) and real SpaceTypes (`GET /builder/space-types`, wraps
      `SpaceTypeRegistryDO`'s `GET /types`) — and nothing in the code ever registered `whop-seller`
      as a SpaceType; only `LAUNCHPAD_MANIFEST` (id `"launchpad"`) is ever seeded. But seeding was a
      manual, easy-to-forget `POST /internal/space-types/seed` call with no automated invocation
      anywhere (no CI step, no deploy hook) — confirmed live: `GET /v1/builder/space-types` against
      production returned `{"types":[]}` before this fix. Since `GET /types` returns `200` even
      with zero rows (not an error), and the wizard's "Or start blank" SpaceType section is gated
      on `spaceTypes.length > 0`, an unseeded registry made that whole section silently vanish,
      leaving only the single live Temple card ("Whop Seller") on the page — exactly the reported
      symptom, with no error to signal anything was wrong. Fixed at the root so this can't silently
      regress again: `SpaceTypeRegistryDO.ensureInit()` now self-heals — if `space_types` is empty
      on any DO wake-up, it seeds the built-in Naelao manifests (`LAUNCHPAD_MANIFEST`) inline before
      serving any request, covering `GET /types`, `GET /type/:id` (also used by provisioning), and
      every other route this DO serves. Refactored the `/register` handler's INSERT logic into a
      shared `registerManifest()` private method reused by both the manual endpoint and the
      self-heal path so they can't drift. New regression test in `product-wizard-api.test.ts`
      drives a brand-new, never-`/register`-ed `SpaceTypeRegistryDO` instance through the real
      `GET /builder/space-types` route and asserts it now contains `launchpad` with no seed call —
      reproducing the exact fresh-deploy/reset-instance scenario that shipped broken.
    - **Verified against live production**, not just tests: deployed the fixed `naelao-spaces`
      worker, then reproduced the wizard's exact flow end-to-end via `curl` against
      `naelao-router` — registered a disposable test builder account, confirmed
      `GET /v1/builder/space-types` now returns `{"types":[{"id":"launchpad","name":"Launchpad",...}]}`
      (the registry self-healed on its very next live request, no manual seed action needed), and
      confirmed `POST /v1/builder/products` with the wizard's exact `product_config` payload no
      longer 500s — a blank-SpaceType launch (no template) returned a real `201`-equivalent
      `{"status":"provisioning"}`, and a `whop-seller`-templated launch correctly reached the
      intentional `free_tier_eligible: false` gate (`402 plan_upgrade_required`, a real, separate,
      working business rule — not a bug) instead of dying earlier on the column-name 500. The
      successful test product was soft-deleted after verification; the disposable test builder org
      was left in place (harmless, same precedent as item 62's own real signup verification).
    1954/1954 tests pass (1 new regression test), `pnpm turbo run typecheck` clean (76 tasks),
    fix live-verified against production via direct API calls (no browser session available in
    this environment).
64. **Follow-up to item 63: the user reported a successfully-created product was unreachable —
    traced to TWO further real, previously-undetected production bugs in space provisioning
    itself (not the wizard), both now FIXED and live-verified end-to-end, plus the Product Shell
    (`apps/shell`) promoted to production for the first time.**
    - **Root cause: `applyMigrations` (`packages/db/src/migrate.ts`), shared by `SpaceDO` and
      `ProductUserDO`, wrapped every migration in raw SQL `BEGIN EXCLUSIVE`/`COMMIT`/`ROLLBACK`.**
      Item 62 fixed the PRAGMA/SQLITE_AUTH class of bug but missed this one: confirmed live via
      `wrangler tail` that Cloudflare's real SQLite-backed DO storage rejects raw SQL transaction
      control outright ("please use state.storage.transaction() or transactionSync() instead"),
      throwing on `SpaceDO`/`ProductUserDO`'s very first call in production — meaning EVERY
      provisioning attempt (agent-definitions registration, root-space registry seed) has always
      failed, landing every new product in `status='error'` forever. The `node:sqlite` test shim
      doesn't enforce this restriction (raw BEGIN/COMMIT works fine against it), so ~1954 passing
      tests never caught it — same failure mode as item 62's PRAGMA bug. Fixed: `applyMigrations`
      now takes the DO's `ctx.storage` (not just `.sql`) and wraps the whole migration block in
      `storage.transactionSync(() => {...})`, the real API Cloudflare's own error message names.
    - **A second, previously-masked bug surfaced the moment the first was fixed:** with the
      transaction wrapper no longer throwing immediately, execution reached each migration's `up`
      SQL for the first time ever in production — and a multi-statement `sql.exec(m.up)` call
      (several `;`-separated CREATE TABLE/ALTER statements in one string, which Cloudflare's own
      docs show working fine OUTSIDE a transaction) throws `"SQL code did not contain a
      statement"` when that same call happens INSIDE a `transactionSync()` closure. Fixed by
      splitting each migration's `up` into individual statements (a new `splitStatements()`,
      comment- and string-literal-aware) and calling `sql.exec()` once per statement. That
      splitter itself had a real bug on its first pass, caught by the FULL test suite (not live
      traffic) before it ever redeployed: a SQL line comment containing a semicolon
      (`-- JSON string[]; NULL = unrestricted`, from `SpaceDO`'s migration v19) was mistaken for a
      statement boundary, producing a bogus standalone `"NULL = unrestricted"` fragment that threw
      a real syntax error — fixed by making the splitter comment-aware (`--`/`/* */`), and by
      dropping any resulting fragment that's comment-only (no real SQL content) rather than
      handing `sql.exec()` an empty statement, which reproduces the exact same "did not contain a
      statement" error for a different reason.
    - **Test-suite fallout, fixed correctly rather than papered over:** `applyMigrations`'s new
      signature needs `ctx.storage.transactionSync`, which the test DO-storage shim
      (`tests/unit/helpers/sqlite-do-shim.ts`) didn't provide. Rather than stub it as a no-op
      (weaker than production — real `transactionSync` rolls back atomically on a thrown
      exception), the shim's `createDOStorage()` wraps a REAL `node:sqlite` transaction
      (`BEGIN`/`COMMIT`/`ROLLBACK` against the in-memory test engine only, not passed through to
      DO code) so a test double failure still rolls back exactly like production. `createDOSqlStorage()`
      stays as a thinner back-compat export for callers that only ever needed `.sql`.
      `fake-do-namespace.ts` (used by ~22 test files via `makeStatefulDoNamespace(SpaceDO)`/
      `(ProductUserDO)`) and 15 more test files that hand-roll a `SpaceDO`/`ProductUserDO` `ctx`
      directly were updated to `createDOStorage()`.
    - **`apps/shell` (the Product Shell) had the exact same "preview-only, never promoted to
      production" gap item 62 found and fixed for `apps/dashboard`** — confirmed via the Pages API
      that both of its only two deployments were `environment: "preview"` from a topic branch, so
      the bare `naelao-shell.pages.dev` domain 404'd. Rebuilt with `@cloudflare/next-on-pages` and
      deployed to the `main` branch (`wrangler pages deploy --branch=main`) — this now resolves
      for the first time. Hit the identical `NEXT_PUBLIC_API_URL` pitfall item 62 already
      documented, with a new specific trap: exporting the env var in one shell command then
      running `next-on-pages` in a SEPARATE command silently loses it, because `next-on-pages`
      internally re-runs its own full `vercel build` (a second, independent Next.js build) that
      doesn't inherit env vars from a prior, already-finished shell invocation — the fix must set
      `NEXT_PUBLIC_API_URL` in the SAME command as the `next-on-pages` invocation itself, not a
      preceding `next build`. Verified by grepping the compiled bundle for the literal baked-in
      API origin before deploying, not just assuming the export worked.
    - **Verified fully live, not just via curl:** created a real product through the wizard's
      exact API shape, confirmed `status` reaches `active` (previously stuck at `error`/
      `provisioning` forever), confirmed `GET /v1/products/by-slug/:slug` resolves it, and
      confirmed the REAL production Product Shell URL
      (`https://naelao-shell.pages.dev/p/{slug}`) renders the actual sign-in page for that
      product — the first time any product has ever been reachable end-to-end on this platform.
      Test product soft-deleted after verification.
    - **CORRECTION (verified live 2026-07-25, two sessions later): the user's actual "Launchpad"
      product is NOT stuck.** This paragraph originally claimed `product_slug` `launchpad` was
      permanently stuck in `status='error'` with no retry path. A direct D1 query against the
      live `naelao-platform` database (`SELECT status FROM spaces WHERE product_slug =
      'launchpad'`) now shows `status: 'active'`, `created_at`/`updated_at` both `2026-07-23`
      (the same day this item was written) — meaning provisioning actually succeeded shortly
      after creation, and the "permanently stuck" claim was wrong at the time (a stale read, or
      written before an async provisioning step finished), not a real bug that later got fixed
      silently. Items 65 and 66 in this file already relied on this same space being active
      (they tested real session/business creation against it) without flagging the
      contradiction — a reminder to verify a documented "known bug" against live state before
      repeating it, the same discipline item 41's costly false-lead paragraph already argued
      for. The `product_slug`-not-freed-by-soft-delete observation two sentences below may still
      be real (unverified either way) but is independent of this correction.
    - **Not fixed this pass, flagged as a separate, real, lower-severity bug:** the dashboard
      displays a product's domain as `{product_slug}.naelao.app`
      (`apps/dashboard/.../products/new/steps/{Review,Domain}Step.tsx`,
      `.../products/[productId]/{layout,domain/page}.tsx`) — a hardcoded client-side string
      template with zero backing infrastructure. Confirmed via the Cloudflare API: **zero DNS
      zones exist on this account at all** (`naelao.app`, `naelao.com`, or anything else), so this
      domain can never resolve regardless of any other fix. It's also internally inconsistent with
      the rest of the codebase, which assumes a single shared shell domain
      (`app.naelao.com`/`naelao-shell.pages.dev` + `/p/{slug}` path routing, per
      `PRODUCT_SHELL_URL` and the router's CORS allowlist) rather than a per-product subdomain —
      and `workers/portal-router` (the one Worker that DOES do Host-header-based subdomain
      resolution) targets `apps/portal`, not `apps/shell`, and its `PORTAL_DOMAINS` KV mapping is
      never populated by product creation regardless. The real, reachable URL for now is
      `https://naelao-shell.pages.dev/p/{product_slug}`; the dashboard's domain display should be
      corrected to either show that, or a real custom domain once actual DNS/CF-for-SaaS wiring
      for the Product Shell is built (a materially bigger, separate piece of work — the Domain tab
      that exists today is the Launchpad STOREFRONT's custom-domain flow, item 16, a different,
      optional, already-real feature).
    1954/1954 tests pass, `pnpm turbo run typecheck` clean (76 tasks), fix live-verified end-to-end
    against production (real product creation → active status → shell page render).
65. **Follow-up to item 64, on the user's own real product (`launchpad`): three more reported
    end-user-facing bugs, two real and now FIXED, one a live infra config gap now RESOLVED.**
    - **Shell home page "An unexpected error occurred" on every load — FIXED.** Root cause:
      `POST /spaces/:spaceId/sessions` (the generic session-CRUD proxy in
      `workers/spaces/src/index.ts`) forwarded the client's request body verbatim to `SpaceDO`.
      `SpaceDO.createSession()` reads `space_id`/`tenant_id` FROM that body — but the real caller
      (`apps/shell`'s `startSession()`) always POSTs an EMPTY body, relying on the URL for
      identity. Every real session-create therefore bound `NULL` into a `NOT NULL` column and
      500'd — confirmed live via `wrangler tail` (`NOT NULL constraint failed: sessions.space_id`).
      Fixed by injecting `space_id`/`tenant_id` into the body server-side before forwarding,
      mirroring the identical pattern the `/threads` POST route already used for the same reason.
      New regression test drives the exact empty-body request the real client sends. Deployed,
      live-verified (fresh signup → session create → `201`), committed `1ba2cfc`.
    - **"Verify email" not arriving — was a live config gap, not code: RESOLVED.** Traced via
      `wrangler tail` on `naelao-notifications`: the verification email correctly attempts to
      send via Resend, but `RESEND_API_KEY` had never been set as a Worker secret, so every send
      502'd (silently, since `sendEmail()` in `product-end-user-routes.ts` is deliberately
      best-effort and never blocks the caller's own response). Not a bug — this repo's Resend
      integration (`workers/notifications`) was simply never provisioned with a real key. User
      supplied one; set via `wrangler secret put RESEND_API_KEY --name naelao-notifications`.
      Re-verified live: the same `/internal/notify` call that previously 502'd now returns `Ok`.
      **Operational note for future sessions:** this key is a real, live secret now — do not
      re-prompt for it or treat notification delivery as unconfigured going forward.
    - **"Create Business" dialog stuck on "Creating…", nothing happens — investigated, root cause
      was UX not a hang, now FIXED.** Reproduced live end-to-end (disposable test end user,
      `POST .../businesses` with `template_ids:["whop-seller"]`): the backend responds in well
      under a second with a clean `403 plan_upgrade_required` — `whop-seller` is deliberately
      `free_tier_eligible: false` (G-BF08) and this account's org is on the free plan, so the
      rejection is CORRECT platform behavior, not a bug. The actual defect: the dialog gave zero
      warning a template requires a paid plan (no visual difference from a free one), then on
      rejection showed the reason only as a 2.8s auto-dismissing toast — indistinguishable from a
      silent hang once the button reverts to "Create". Fixed in `apps/shell`:
      `ShellManifest.template_catalog`'s TS type was missing `free_tier_eligible` even though the
      backend always sent it (`workers/spaces/src/template-catalog.ts`) — added it, and the
      Create Business dialog now shows a "Requires plan upgrade" badge on any such template
      up front, plus keeps the rejection message visible inline in the dialog (not just the
      toast) until the user retries or closes it.
    - Also fixed in passing: this session's `.cf-credentials.local` (session-local CF API token)
      had been lost across a container boundary earlier in the session — re-supplied by the user
      and re-written to that gitignored path; confirms the file really is only as durable as the
      current container, exactly as documented above.
    1955/1955 tests pass (1 new), `pnpm turbo run typecheck` clean (76 tasks), `apps/shell`
    rebuilt and redeployed to `naelao-shell.pages.dev` production, fix live-verified by grepping
    the actual deployed JS chunk for the new badge/error-handling code.
66. **Follow-up to item 65's own fix: a real bug it introduced ("Session not found" on Home/new
    thread), plus a real UX/architecture direction from the user — the shell is now business-first
    and sessions are created lazily. Both BUILT and live-verified.**
    - **Root cause of "Session not found":** item 65's session-create fix injected `space_id`/
      `tenant_id` into the empty body every real client sends, but NOT `end_user_id` — so every
      end-user-created session landed with `end_user_id` NULL. `SpaceDO.getSession`/`getMessages`
      both reject any read whose caller-derived `end_user_id` doesn't match the session's own
      (S0.1 ownership check) — NULL never matches a real id, so the creator's own very next read
      of their own brand-new session 404'd with "Session not found". Fixed in
      `workers/spaces/src/index.ts`'s `/spaces/:spaceId/sessions*` proxy: `end_user_id` is now
      derived from verified caller identity for a `product_end_user` role (never client-supplied,
      same rule as every other identity field in this route). Live-verified: signup → create
      session (empty body) → read it back → `200`, `end_user_id` populated correctly (previously
      would have 404'd).
    - **A second, independent bug found in the same investigation:** `apps/shell`'s `apiFetch`
      threw a plain `Error` carrying only the backend's human-readable message ("Session not
      found") — `Chat.tsx`'s own self-healing retry-on-404 logic checked
      `msg.includes("404") || msg.includes("not_found")`, which could never match real prose and
      meant a 404 (for ANY reason) always surfaced as a raw uncaught error instead of
      self-healing. `apps/portal` has the identical bug (this code was "ported from" there) —
      confirmed present, deliberately NOT fixed this pass (out of scope; flagged, not dropped).
      Fixed in `apps/shell` with a real `ApiError extends Error` carrying `status`/`errorCode`;
      `Chat.tsx` now checks `err instanceof ApiError && err.status === 404`.
    - **Business-first shell (user-directed architecture change, not a bug fix):** hybrid/tenant
      products (Launchpad) are now business-first — Home/Projects/Threads/Assistant/Agents/
      Knowledge are meaningless at the product root, since every session/project/thread should
      belong to a business. `ShellLayoutInner` (`layout.tsx`) redirects a user with zero
      businesses to `/spaces?onboarding=1` (exempt: `spaces`/`settings`/`verify-email` — account-
      level pages, not workspace pages) and auto-selects the user's first business as the active
      space the moment one exists, both gated on a new `ActiveSpaceProvider.isHydrated` flag
      (`active-space-context.tsx`) — without it, a child-before-parent effect race (the same
      class of bug Phase D's dashboard fix documented) could fire before the persisted
      active-space choice loads from sessionStorage and clobber it with a computed default. The
      sidebar's "new thread"/"new project" buttons are hidden while parked on `/spaces` with zero
      businesses (`canUseWorkspace`), and the space switcher's product-root ("Launchpad") entry
      now routes to the business hub instead of activating the product root as a workspace — its
      meta label changes to "Switch businesses" to make the intent explicit. "team" mode products
      (the universal non-Launchpad Journey-1B shell, no businesses concept) are completely
      unaffected — the product root stays the one and only workspace there, exactly as before.
    - **Lazy session creation (user-directed, matches Claude's own "/new" behavior):** `Chat.tsx`
      no longer creates a session just from mounting Home or a fresh thread — it only loads an
      existing cached session's history if one exists; a session is minted for the first time
      inside `handleSubmit`, on the actual first send. The composer stays enabled with no session
      yet (previously gated on `!chatSessionId`). This also means opening Home/a new thread never
      writes a session row purely from being viewed, consistent with the business-first "nothing
      gets created until the user actually does something" rule above.
    - New regression test drives the exact create-then-read sequence a real client does
      (`product-shell-manifest.test.ts`) and asserts the read succeeds with the correct
      `end_user_id`, not a 404.
    1956/1956 tests pass (1 new), `pnpm turbo run typecheck` clean (76 tasks). Backend
    (`naelao-spaces`) and `apps/shell` both deployed to production; live-verified via direct API
    calls (signup → session create → session read, and the fresh manifest/my-businesses calls a
    real zero-business account gets) and by confirming the deployed JS bundle contains the new
    gating code. **Not verified via a live browser session this pass** — Playwright is available
    in this environment but its bundled Chromium couldn't complete a TLS handshake through the
    session's MITM proxy (`net::ERR_CONNECTION_RESET` on every navigation, independent of the
    proxy itself working fine for plain `curl` requests) — not investigated further since the
    API-level + bundle-content verification already gives high confidence; a future session with
    working browser access should do a full click-through pass.
67. **Three new canonical-spec appendixes added (BG, BH, BI) — pure specification, ZERO code
    built this pass — recording the long-term direction the user wants Launchpad to grow into.**
    Prompted by user-supplied research on (a) an "Autonomous SaaS Operator" multi-agent pattern,
    (b) an "Autonomous Venture Studio" portfolio model plus Apple/Foxconn-style physical-goods
    businesses, and (c) a WeChat/Siri-like personal super-app assistant. Each idea was filtered
    against what's already built rather than transcribed as-is — the appendixes cite and reuse
    existing primitives (script-native `NaelaoAgentDO`, sub-agent spawn, the Workflows tier,
    HITL/`assistant_policy`, Container Marketplace, the universal-connector doctrine, the
    business wallet, `BUSINESS_FEATURE_KIND_REGISTRY`) rather than inventing parallel systems,
    per this file's own standing anti-split-brain rule.
    - **Appendix BG — Autonomous SaaS Operator SpaceType** (`naelao_expanded_gaps_resolved.html`,
      G-BG01–18): a new, standalone SpaceType (also installable as a Launchpad business project
      kind, `saas_operator`) that runs a builder's OWN software product's feedback→spec→code→
      QA→security→deploy loop via four compartmentalized `agent_definitions` (PM, SRE/QA, Dev,
      Security) instead of one monolithic agent. Load-bearing pieces beyond the four-role split:
      a structured `operator_specs` handoff (never free-text between agents) with a `risk_level`
      that hard-gates data-model/security-sensitive changes through HITL regardless of autonomy
      policy; a real dependency graph (`operator_dependency_graph`) so QA can compute blast
      radius instead of blindly re-running the whole suite; a NEW `operator_decision_log` —
      distinct from the already-built technical traces (`run_traces`/HX1, `agent_activity_log`)
      — that answers "why was this the right call," closing the loop with a post-ship outcome
      check; a dedicated code index (`code.find`, Vectorize-backed, incrementally updated per
      commit) since Memory OS/KB indexing is document-shaped, not repo-shaped; a real git
      checkout inside the Tier-5 container (the platform's first non-`coming_soon` Container
      Marketplace image, `dev-sandbox`); and — the single gap confirmed to be real and present
      platform-wide, not just for this SpaceType — NO SAST or adversarial exploit-testing exists
      anywhere in the codebase today, so the Security agent role (`security.static_scan`,
      `security.exploit_attempt`) is flagged HIGH priority independent of whether this SpaceType
      itself gets built. A self-heal fast lane (error → auto-repro in sandbox → fix → verify →
      redeploy) is scoped as its own item, always still owner-approved.
    - **Appendix BH — Autonomous Venture Studio** (G-BH01–10): generalizes the existing
      multi-business shell (Phase C) from "a user who runs a few businesses" into "a user who
      holds a PORTFOLIO of largely autonomous businesses" — a portfolio aggregate view with an
      explainable (never opaque-model-scored) attention heuristic; an opt-in capital-allocation
      LEDGER between an owner's own business wallets that settles through each wallet's real
      payout/deposit primitives rather than inventing pooled custody; an owner-authored
      `business_charter` (mission + hard constraints) the assistant re-checks each recurring
      revenue review, surfacing drift toward a constraint before it's crossed; and a portfolio-
      wide "pause all" circuit breaker. Physical-goods businesses (`physical_goods` business
      kind) get the explicit Apple/Foxconn split as a HARD constraint in the agent profile — the
      agent does design/spec/sourcing/negotiation, never physical execution — reaching real
      manufacturing/fulfillment platforms (Printful/Printify first, since it needs zero
      manufacturer-relationship risk; Alibaba-style RFQ messaging later, purchase orders always
      HITL-gated regardless of autonomy policy, the same hard-carve-out pattern as BG's
      data-model gate). Explicitly out of scope and flagged DEFERRED: third-party/outside
      investor capital — a securities-law-adjacent surface this pass correctly declined to
      improvise into existence.
    - **Appendix BI — The Personal Super-App Assistant** (G-BI01–06, North-Star/Deferred): the
      WeChat/Siri-like personal assistant that manages a user's whole life and can spin up
      Appendix-BH business assistants on their behalf, self-funding via an opt-in extension of
      BH's own capital-allocation ledger, with a mini-app layer that's explicitly reframed as
      "the existing connector doctrine, called by a personal rather than business agent" instead
      of a new app runtime. Every item is marked DEFERRED with an explicit build-order statement:
      this is recorded now so BG/BH's design choices (the charter concept, HITL-consent shape)
      point toward this destination, not an instruction to start building it — it structurally
      depends on BG and BH shipping and being proven with real usage first. First-party
      user-to-user social (as opposed to the mini-app/connector layer) is flagged as needing its
      own dedicated trust/safety pass before any spec, let alone code.
    - `docs/SPEC_HEADER_INDEX.md` regenerated via `infra/gen-spec-index.py` (2738 headers, up
      from 2720) — the existing generator picked up all three appendixes automatically, no
      hand-editing needed.
    **Not done this pass, by design:** no code, no migrations, no new routes — this was scoped
    as pure specification per the user's explicit "don't write any code" instruction earlier in
    the session, carried forward since no code request followed it. The user's own separate,
    concrete question — "how much do I need for a first working autonomous business" — was
    answered directly in chat (not written to the spec, since it's a status/config question
    about the EXISTING built platform, not a new capability): live secrets
    (CF AI Gateway/Anthropic key, a Whop account for the BYO connector, `RESEND_API_KEY` already
    set), the org's own `plan_tier` for `free_tier_eligible:false` templates, fixing the
    known-stuck `launchpad` product_slug (item 64's documented gap), and a manual click-through
    QA pass — no new build items required to reach a first real transaction.

68. **Whop-seller template populated + the template bootstrap made to actually RUN + native tool
    calling — and three stacked production-blocking bugs found in the process that meant the agent
    had NEVER successfully run in production.** Live-reproduced first: a real whop-seller business
    reached `status='active'` carrying only the auto-provisioned "Wallet" project (Members/Support/
    Content never existed) with onboarding stuck at `"pending"` forever, because the provisioner
    only RECORDED the bootstrap and the sole executor was the builder dashboard's onboarding page
    — a surface an end user creating a business through `apps/shell` never touches. Fixed by
    splitting the bootstrap: the STRUCTURAL half (projects + starter threads, needs no credentials)
    now runs at provision time for every path via a new shared `workers/agents/src/launchpad/
    bootstrap.ts` (`seedTemplateProjects`/`normalizeProjectSeeds`) that the provisioner and
    `bootstrap/complete` both call so they can't drift; the SETUP half (setup scripts, project-
    template presets, first contact) stays behind onboarding since it genuinely needs the connected
    account. `whop-seller` itself went from a stub to a real template: OAuth-first `whop_connection`
    (required) with the pasted-key prompt demoted to an explicitly optional fallback, an
    `owner_channel` picker, an `autonomy` choice, `project_templates: ["discord-community-bot"]`,
    and a `first_contact.goal` instructing the assistant to actually READ the connected Whop account
    via mcp-connector before proposing anything, respecting the owner's autonomy setting.
    `OnboardingPrompt` gained `help` (plain-language, non-technical) and `type: "connection"|
    "channel"|"boolean"`; `validateLaunchpadSpaceType` now enforces that connect/credential prompts
    name a real connector and that choice/channel prompts offer options.
    **Native tool calling:** the reasoner's five actions (`run`/`distill`/`patch`/`answer`/
    `give_up`) are now declared as real provider tools (`DECISION_TOOLS`, `tool_choice:"required"`)
    and read back via `decisionFromToolCall`, with the prose-JSON parse kept ONLY as a fallback so
    this is strictly additive — published figures put prompted-JSON action success at ~70-85% vs
    ~95-99% for native tool calling, and the gap is widest on exactly the small/cheap models a
    free-tier business runs on.
    **The three production-blocking bugs, each hiding the next:** (1) `naelao-agents` held a
    different `PLATFORM_SECRET` than the router, so EVERY agents-worker route 401'd while
    spaces-worker routes worked fine — rotated across all 28 workers with the user's approval
    (destructive: `getDOName` derives every DO name from this secret, so rotation orphans DO
    state; the product root's SpaceDO was empty so nothing meaningful was lost). (2) `workers/
    agents` declares `PLATFORM_DB: D1Database` and uses it in 31 places but its `wrangler.toml`
    had NO `[[d1_databases]]` block at all — TypeScript cannot catch this, so a new
    `wrangler-binding-parity.test.ts` parses every worker's `wrangler.toml` against its `Env`
    interface (verified to fail when the fix is reverted). (3) A vestigial `SELECT * FROM
    spacetypes` gate in `/agent/run` that could only ever 404, since `SpaceTypeRegistryDO` is
    authoritative and that D1 table is empty — removed.
    **Cloudflare migrated AI Gateway to a new REST API on 2026-05-21** and the old Universal
    Endpoint is dead (confirmed live: 401 / "Invalid provider" code 2008). `shared/ai-client.ts`
    rewritten for `POST https://api.cloudflare.com/client/v4/accounts/{id}/ai/v1/chat/completions`
    — flat OpenAI-shaped body, CF API token auth, `cf-aig-gateway-id` routing, model string alone
    selecting the provider — which also deleted all the per-provider translation code
    (`buildProviderEntry`/`inferProvider`/`toolsForProvider`). **No Claude models are available on
    this account's gateway** (`?search=claude` → 0 results), so Workers AI is not the cheap option,
    it's the only one: `@cf/meta/llama-3.3-70b-instruct-fp8-fast` added to `ALLOWED_MODELS` with a
    REAL 24k context window (from `/ai/models/search`, not Llama's nominal 128k) and pricing
    derived from three measured calls (solved `neurons = 0.026668*input + 0.204805*output`,
    reproduces a held-out measurement exactly). **First successful agent run this platform has ever
    had**, verified live end to end. Also: `infra/scripts/shell-screenshot.mjs` (real authenticated
    E2E screenshots via CF Browser Rendering, since Playwright's bundled Chromium can't complete a
    TLS handshake through this sandbox's MITM proxy — and disabling TLS verification is forbidden).
    2006/2006 tests pass. **Operational note:** `CF_API_TOKEN` is now set as a Worker secret on
    `naelao-agents` because the new API requires it — worth replacing with a scoped token (AI
    Gateway permission only) when the pasted one is rotated.
69. **End-user business onboarding (the gap item 68 left open) + the shell reorganised around
    sessions.** Item 68 made the structural bootstrap run everywhere, but the SETUP half was still
    reachable only from the builder dashboard — so an end-user-created business never got its
    project-template presets and never got the assistant's proactive first contact.
    **Backend:** `GET /spaces/:id/bootstrap` (the template's real prompts + what's answered + a
    per-prompt `satisfied`), `POST .../bootstrap/save` (partial answers), and `bootstrap/complete`
    extended to accept answers inline. Two rules make this honest rather than decorative: a
    `connection`/`credential` prompt is satisfied by a REALLY-registered connector (checked against
    mcp-hub), never by a stored answer string — so a key that failed to vault can't look like
    success; and completion REFUSES (`400 onboarding_incomplete`, naming the missing ids) while a
    required prompt is unmet, since an assistant introducing itself with no account to read is
    worse than no message at all. That validation is skipped for an ALREADY-complete space, so a
    template that later gains a prompt can never strand a business that finished setup under the
    old definition. Credential answers are never echoed back to the client.
    **Spaces worker:** ONE `GET/POST /spaces/:spaceId/onboarding` wrapper with POST's `action`
    carrying save-vs-complete — deliberately not the natural `/onboarding/save` + `/onboarding/
    complete` pair, which is the dynamic-segment-then-static-suffix shape that has repeatedly
    triggered this file's documented Hono RegExpRouter corruption (items 40, 52) — gated by
    `requireBusinessMembership({GET:"member", POST:"admin"})`: reading the checklist and connecting
    the business's payment account are different privileges. Router allowlists the path for
    identity only, same split as every sibling business route. `proxyConnectorsToAgents` renamed
    `proxyToAgentsWorker` now that it serves a non-connector purpose.
    **Shell wizard:** one question per screen (the audience has never configured software), saving
    every answer server-side as it goes — load-bearing, not a nicety, because connecting an app is
    a real browser navigation away from the page; it resumes at the first gap on return, folds the
    "paste a key instead" fallback INTO the connect step rather than showing it as a confusing
    extra question, and polls while `space_status !== 'active'` rather than claiming there's
    nothing to configure (a business is created before provisioning finishes — hence the new
    `space_status` field, so the UI can tell "still building" from "nothing to do"). Creating a
    business now lands there; unfinished setup is surfaced on both the business page and Home.
    **Shell reorganisation (step 3):** Home is a start-here page (compose → Enter → land in a new
    session, claude.com/new-style) instead of a chat window bolted to the product root; sessions
    are titled from their opening line (SpaceDO has no title column — it rides in `metadata`) so
    recent lists are readable without an N+1 fetch. The sidebar's recent list is assistant SESSIONS,
    not structural threads, backed by new `/sessions` + `/sessions/[sessionId]` routes; `Chat`
    gained an explicit `sessionId` (bypassing the sessionStorage cache so opening a conversation by
    URL can't resurrect a different one) and an `initialMessage` (ref-guarded against React 18
    StrictMode's double-invoke, which would otherwise bill two real agent runs). Project threads
    moved under `/projects/:id/threads/:id` and creating one now opens it. Spaces became
    **Discover**: your businesses, the templates you could start next, and — via two new
    browse-only manifest catalogues (`project_template_catalog`, `agent_catalog`, fed by a new
    `GET /catalog/shell` that projects id/name/description and never an agent's `system_prompt`) —
    what those templates actually give you.
    **Verified live end to end on production**, not just in tests: business created → provisioning
    polled → checklist returned the real 6 prompts → answers saved → completion correctly REFUSED
    with `missing:["whop_connection"]` → connector connected → completion returned
    `project_templates_applied:["discord-community-bot"]` and `first_contact_sent:true` → re-run
    returned `first_contact_sent:false` → the business really contains Wallet/Members/Support/
    Content/Discord Community Bot → a different end user of the same product got 403 on both verbs.
    Screenshots confirm the new Home, Discover, and both wizard steps render correctly signed in.
    **Two brittle test doubles fixed in passing** (one hardcoded a query's exact column list and
    started 404ing when the real query selected one more column; one answered every agents-worker
    path with the same payload) — the same "test double diverges from the real contract" class
    CLAUDE.md already documents for `config_schema`/`schema_json`. **A real flaw in
    `shell-screenshot.mjs` fixed too**: it `reload()`ed after injecting the session, but the
    unauthenticated first load has already bounced to `/login` by then, so it silently
    screenshotted the wrong page — it now navigates to the requested URL explicitly.
    **Deployment gotcha worth remembering (cost a broken deploy):** `apps/shell`'s API client
    already includes `/v1` in every path, so `NEXT_PUBLIC_API_URL` must be the BARE router origin.
    `apps/dashboard` is the opposite (item 41) — its client omits `/v1`, so its env var must carry
    it. Getting this backwards produces `/v1/v1/...` → 401 → `notFound()` → every shell route 404s
    with a valid-looking build. 2030/2030 tests pass, `npx turbo run typecheck` clean (76 tasks).

70. **The LLM eval matrix is now REAL — and running it found six production bugs, the largest of
    which meant multi-step agent work had never once worked.** The harness (`workers/eval` in
    `mode:"agent"`, driven by `infra/scripts/run-eval-suite.mjs --models`) dispatches a REAL
    `/agent/run` per case through the live reasoning loop and judges the agent's actual answer.
    Findings and the full ranked table live in **`docs/MODEL_EVAL_2026-07-25.md`** — read that
    rather than duplicating numbers here, so they can't drift.
    - **The loop returned on the FIRST successful tool call** (`script-engine/loop.ts`). At L3/L4
      a successful `run` ended the run immediately, so the model never observed its own tool
      output. Multi-step work was structurally impossible and users got a blank `finalAnswer`.
      Live before the fix: "what is 2+2" worked, every tool-requiring request returned
      `status: completed` with an empty answer. Now the observation is appended to `priorSteps`
      (with a `stableStringify` repeat-call guard) and the loop continues; on exhaustion it fails
      honestly naming the steps it ran rather than returning nothing. **Three script-engine tests
      had been passing BECAUSE of this bug** — their fake reasoners only ever returned `run` and
      never answered; made realistic.
    - **The reasoner never saw prior steps.** `steps_so_far` (with a 2000-char observation cap)
      added to the payload, plus instructions to read them and finish with `answer`.
    - **A transient assistant-policy fetch failure turned the assistant off.** Failing closed is
      right, but the closed state is `gate_unless_listed` with an EMPTY allowlist — gate
      everything, no approver reachable — so under concurrent load every run died with what reads
      as a refusal to work. Now cached 30s, distinguishing 5xx/network (transient → serve the
      last verified policy) from 4xx (definitive → still fail closed), plus one retry for cold
      reads. A revoked policy still takes effect once the window passes.
    - **Quota split-brain.** `/internal/usage/{llm-tokens,infra-credits}/check` read
      `subscriptions.plan_tier` while `EntitlementsChecker` reads `orgs.plan_tier` — an org set to
      enterprise the way the docs instruct still hit the free tier's 100k wall (hit live at
      111,510/100,000). New shared `resolvePlanTier()`.
    - **The eval worker wrote columns that have never existed** (`eval_results (eval_suite_id,
      results_json, avg_score, ...)`) so every run 500'd against real D1, and its routes were
      registered under `/v1` (which `proxyTo` strips) with no router entry at all — it could never
      have reached a real deployment. Its test used a fake DB that accepted anything; replaced
      with `createFakeD1` over the REAL migrations. Same failure class as `config_schema`/
      `schema_json`.
    - **One slow model discarded an entire run.** The per-case dispatch carried an
      `AbortSignal.timeout` nothing caught, so a slow model threw out of the case loop: opaque
      HTTP 500, every already-scored case lost. A dispatch failure is now that case's result
      (timeouts named as such); ceiling raised to 150s.
    - **Judge hardening**, since a broken judge must never read as "every model failed": routed
      through the AI REST API (it was Anthropic-only, unusable on this account — see item 68),
      `max_tokens` 250→600 (it was truncating its own JSON), fenced-reply extraction, and judge
      failures flagged and EXCLUDED from the average rather than scored 0.
    - **Two matrix runs were discarded, not reported** — the first quota-blocked, the second
      pre-fix. Both would have produced a plausible ranking that measured infrastructure.
    - **A real product limitation the eval surfaced:** `worker_loaders` is commented out in
      `workers/agents/wrangler.toml` (it needs the CF Workers PAID plan), so execution Tiers 2-4
      are genuinely unavailable in production. Any case needing the agent to write and run code
      is unwinnable — and it penalizes the models that correctly try to. Re-enable on upgrade.
    - **Not done:** the top models have only been scored on `tool-use-policy.jsonl`;
      `commerce-business-ops` and `multi-step-web-file` exist and the harness runs them in one
      command, but a model choice should not be made off a single 6-case dataset.

71. **Project Journal, conversation memory + compaction, and the assistant/shell UI split are
    BUILT — and building them surfaced that the agent had NO conversation memory at all.**
    - **Project Journal** (`script-engine/project-journal.ts` + `prebuilt/project-journal.ts`).
      One `PROJECT.md` per project (`spaces/{id}/projects/{id}/PROJECT.md`, a SIBLING of
      `workspace/` so an ordinary file write can't spoof it): goal, standing instructions, status,
      todos, and a bounded log of what every agent did. Memory OS already shared L3/L4/L6 across a
      project and kept L5 private, but project STATE ("invoice.csv exists", "the payout task is
      done") was homeless, so two threads would each redo the other's work. Read ON DEMAND via
      `project_journal.read` — never injected per call, which is what lets it hold real detail.
      Bounded by entry count AND rendered bytes; overflow folds into a dense archive
      (Mastra Observational Memory's shape) rather than truncating. Summarisation is optional:
      LLM when wired, deterministic rollup when not — losing a completed action to a summariser
      outage would defeat the point. Scoping is structural (project comes from the run, never an
      argument). Both assistant profiles instruct: read before working, log after acting.
    - **The agent had no conversation memory.** Confirmed by reading `GatewayReasoner.decide()`:
      the payload carried goal + snapshot + candidates + this run's own steps, and NOTHING else.
      No history at all — so it could not resolve "do that again", could not answer "what did we
      decide", and re-asked what the user had just said. The context-usage meter (§A1.27) was
      measuring a transcript the model never received. New
      `script-engine/conversation-context.ts` carries recent history bounded by tokens and message
      count, walking backwards so the newest message can never be the one evicted; a single huge
      message is truncated (and says so) rather than evicting everything else.
    - **Compaction is explicit, never silent.** Claude Code's own has the documented failure mode
      the user described: after a compact the assistant treats anything absent from the summary as
      never having happened. So the payload itself carries a `notice` (not just the system prompt)
      saying the history is compacted, how many messages are missing, and to run
      `conversation.search` rather than guess. `DECISION_INSTRUCTIONS` says the same.
      New `prebuilt/conversation.ts` searches the FULL uncompacted transcript; an empty result
      says plainly "not discussed here", which is what stops a model inventing a memory.
      **Deliberately keyword-scored, not AI Search**: messages live in SpaceDO, not R2, so
      AutoRAG cannot see them, and a just-sent message must be findable immediately — a reindex
      delay would break the exact case this exists for. Summaries cache in a new agent-DO
      `conversation_summaries` table keyed by how many messages they already cover.
    - **Channels answer the user's "is Telegram even in the CF ecosystem" question: YES.** An
      inbound WhatsApp/Slack/Discord/email message flows through the signature-verified webhook
      into this DO's own `channel_sessions`/`channel_messages`, and `channel_user_id` already maps
      to a stable Memory OS `user_id`. But the drain loop passed ONLY the current message as the
      goal — so a customer replying "yes, the blue one" got an answer with no idea what had been
      offered. New `loadChannelConversation()` reads that table (a DIFFERENT table from SpaceDO
      sessions, which is why the web-chat loader could not cover it). No per-drain summarisation:
      that path is cost-sensitive and would run on every inbound message. **Telegram is NOT a
      supported channel** — `ChannelType` is email/slack/discord/whatsapp.
    - **A real Memory OS defect, found by writing the end-to-end test**: `recall` required the
      WHOLE query string to appear inside a SINGLE column, so "refund window" could never match
      the fact (entity=refund, relation=window, attribute=30 days). Agents recall in natural
      language, so the structured layer was near-useless in practice. Facts AND episodic notes now
      match on tokens (OR, not AND — a near-miss is far cheaper than a silent miss). Fixing this
      broke a cross-user isolation test in `memory-os.test.ts`: its hand-rolled fake destructured
      a fixed `[like1, like2, like3, limit]` and read `limit` at a fixed index, so a variadic
      query made it slice with a string. The fake was wrong, not the isolation — same "test double
      diverges from the real contract" class this file already documents.
    - **`memory-os-end-to-end.test.ts`** pins what seven per-layer test files never asserted: the
      project/thread boundary. L3/L4/L6 shared so thread B doesn't redo thread A's work; L5
      private so one thread's half-formed reasoning ("maybe try 39") never surfaces in another as
      established fact. Writing it also caught that `Embedder.embed` takes a STRING, not an array
      — getting that wrong makes promotion silently no-op (the throw is caught).
    - **UI**: `/new` (claude.com's split) with Home dropped from the sidebar and the root
      redirecting; `/assistant` is now a DASHBOARD (config, built-in scripts, learned skills,
      recent conversations, memory, crons, channels, agents, files) with the chat moved to
      `/assistant/chat`, backed by a new read-only `/assistant/capabilities` route (metadata only
      — never script source; authoring stays a builder operation). Discover's
      "doesn't support customer-created businesses" string replaced — that was the platform
      describing itself to itself.
    2129 tests pass (61 new), `npx turbo run typecheck` clean (76 tasks), `apps/shell` builds.
    **BLOCKED, and more important than any of the above: the account's Workers AI free allocation
    (10,000 neurons/day) is exhausted.** At ~155 neurons/run that is ~65 agent runs per DAY
    platform-wide — confirmed live as `4006` errors, which is what invalidated matrix v4 from
    model 4 onward. `worker_loaders` is also still commented out (Tiers 2-4 unavailable). Both
    unblock with the same CF Workers Paid plan. **Not done:** the model matrix could not be
    completed (kimi-k2.6, kimi-k2.7-code, glm-5.2 exist and are queued; kimi k2.5, kimi k3 and
    glm 5.1 do NOT exist on this account), and no live end-to-end verification of this pass's
    work was possible for the same reason.

72. **Durable approvals, and four bugs that made a product unreachable — found by tracing a
    reported Discover bug to live data rather than to the page it was reported on.**
    - **HITL was a 28-second window, not a human one — now FIXED.** `NaelaoAgentDO`'s
      `requestApproval` polled `HITLApprovalDO` inline for 28s (which auto-rejected at 30s) and
      the loop read the timeout as `approved: false` — i.e. a refusal. An owner asleep, at work,
      or on another screen could never approve anything, and their absence was reported to the
      user as a rejection. For an agent whose differentiator is asking before it spends money,
      that is the feature not existing. `HITLGateway` now returns a third state (`pending`);
      `hitlGate` is tri-valued (`proceed`/`denied`/`pending`); a pending gate SUSPENDS the run
      (new `LoopResult.pending_approval`, never an error result) and writes a `suspended_runs`
      checkpoint; approving resumes it. **What makes re-entering the loop safe rather than a
      replay hazard is where it stops** — at the gate, before the gated action ran — so the
      checkpoint's `steps_completed` (the ungated work already done) is handed back as
      `resumeSteps`/`priorSteps` instead of being repeated, and `preApprovedActions` lets the
      approved action through exactly once (otherwise every resume would open a fresh request for
      the very thing just approved). Resume routes by a new `approvals.resume_do_id` recorded at
      request time — agent DOs are addressed per space:project:thread, so resuming "the space's
      assistant DO" would silently find no checkpoint for any project-scoped run. Deliberately
      NOT an in-memory continuation: DO hibernation destroys that, which is the exact wait this
      feature exists to allow. TTL 24h, inline courtesy poll 20s.
    - **A product could be created with no working address — FIXED.** The wizard called the
      platform subdomain optional and said "pick this later"; there is no later (nothing anywhere
      sets `product_slug` after creation) and the Product Shell builds every end-user URL as
      `/p/{product_slug}`. A blank field produced a product that provisioned cleanly, reported
      `active`, and could not be opened by its owner or any customer. `createSpaceRecord` now
      derives a slug from the name (`deriveAvailableSlug`, suffix-on-collision rather than 409 on
      a field the builder never filled in, reserved-list shared with the explicit-slug validator,
      degrades to slugless only when nothing usable can be derived).
    - **Soft-deleting a product burned its name permanently — FIXED** (item 64 flagged this as
      "may still be real, unverified"; it is real). The unique index on `product_slug` doesn't
      exclude deleted rows, so deleting "Launchpad" and rebuilding it could never reuse the name —
      and, combined with the bug above, the replacement then had NO address at all. The two
      compounded into a product that silently could not exist. DELETE now nulls the column,
      preserving the old value as `config_json.deleted_product_slug` for audit.
    - **The address shown everywhere pointed nowhere — FIXED.** `{slug}.naelao.app` was hardcoded
      in six dashboard files; no DNS zone for that domain has ever existed on this account
      (item 64). New `apps/dashboard/src/lib/product-url.ts` derives it from the real shell origin
      (`NEXT_PUBLIC_SHELL_URL`, default `naelao-shell.pages.dev`), and the product header now
      links it.
    - **The model picker offered only models this account cannot serve — FIXED.** The
      Configuration tab's three hardcoded Claude ids are all unreachable on a gateway without
      Anthropic wired (item 68), so every product created here was born pointing at a model its
      own agents could never call — surfacing only at the first message. Now renders from the
      shared `ALLOWED_MODELS` (new `@naelao/billing-core` dep on `apps/dashboard`) defaulting to
      `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.
    - **Discover:** `Promise.all` meant either the manifest or the business list failing threw
      both away, and the resulting empty state was written for a user who genuinely has none — so
      a load failure told someone their businesses did not exist. Now `allSettled` with a distinct
      failure state and a retry. `my-businesses` also carries `onboarding_status`/`template_id`
      (`json_extract` on a JOIN it already does, not an extra round trip per business) so an
      unfinished business says so and links to its checklist.
    - **Investigation note worth keeping:** the reported Discover symptom was NOT reproducible in
      code — a live authenticated screenshot showed the page working correctly. Querying D1
      directly found the real cause: the user had deleted and recreated their product mid-session,
      and the recreated one had no slug (the bugs above), so `/products/by-slug/launchpad` 404'd
      platform-wide. Repaired live (freed the deleted row's slug, assigned it to the live product
      `f17b859b-aaf7-436e-a381-87cd6820429a`). Verify a reported UI bug against live DATA before
      assuming the page is at fault.
    2142/2142 tests pass (13 new), `npx turbo run typecheck` clean (76 tasks), `naelao-spaces` +
    `naelao-agents` + both Pages apps deployed and verified live end-to-end (signup → create
    business → Discover renders it).
    **Still open vs. Palantir Orchestrator (verified in code this pass, not fixed):**
    `AgentTaskWorkflow` wraps an entire agent run in ONE `step.do`, so the durable checkpoint
    granularity is the whole run — a retry re-executes every tool call already made. And
    `@naelao/idempotency` has ZERO consumers anywhere in the repo, so there is no exactly-once
    guarantee on tool execution. Those two together are the remaining "no duplicate work" gap.

73. **"Long-running background agent" was capped at 29 seconds — now genuinely unbounded — plus a
    replay-safety ledger, an honest `awaiting_approval` status, and an unauthenticated approvals
    surface closed. Driven by reading CF's own docs rather than this file's stale invariant.**
    - **The 29s cap.** `AgentTaskWorkflow` set `timeout: 29_000` on `run-agent`, the step that does
      all the work. **A CF Workflow step has NO wall-time limit** — only a CPU-time limit, which
      excludes time spent waiting on an LLM/tool/any I/O (`/workflows/reference/limits/`, verified
      2026-07). The ceiling was self-imposed and traceable to this file's own Key CF Invariants line
      claiming "30s per step" — now corrected there too, along with the real step counts (1,024
      Free / 10,000 default Paid / 25,000 configurable; `step.sleep` up to 365 days, not counted)
      and a pointer to `step.waitForEvent`/`instance.sendEvent`. Any real multi-step task blew
      through 29s and was reported as a failure. Dispatch was already durable-by-default (item 38
      Phase Q); this is what made it not actually long-running.
    - **Retries removed from that step + a ledger check added.** `retries: {limit: 3}` on a
      NON-idempotent step meant a slow run re-executed every tool call already made — the same
      email sent up to three times. New `recordedResult()` reads the TaskDO row (already written,
      so no second store — the Orchestrator ledger pattern) and short-circuits when the task
      already reached a terminal state, making a Workflow REPLAY safe. Best-effort on purpose: a
      failed ledger read must not strand a task that genuinely never ran.
    - **`awaiting_approval` is now a real status end-to-end.** Item 72's suspend path landed with a
      hole: a run stopped at a gate has no `result` and no `error`, which `normalizeScriptRunResult`
      read as ok-with-empty-output → `status: "completed"` with a blank answer. Worse,
      `apps/shell`'s `Chat.tsx` matches on status, so an unrecognised one hit no branch and the
      reply silently vanished — the exact case the feature exists for looked like the agent gave up.
      Threaded through the normalizer, `TaskDO`'s `TaskStatus` (explicitly non-terminal, so the
      completion callback doesn't fire), `TASK_STATUS_TO_RUN_STATUS`, `AgentRun` in the shell
      client, and Chat's poll loop.
    - **The four approvals routes had NO auth of any kind — FIXED.** `GET/PUT
      /spaces/:spaceId/sessions/:sessionId/approvals*` never called `requireVerifiedTenant` or any
      ownership check, and `naelao-agents` keeps a public `workers.dev` URL (its channel gateway
      needs one): anyone could list what any space's agent was about to do *with its parameters*
      and approve it. Item 44's F1 sweep missed these. Already wrong at a 30s auto-reject window;
      much worse now that item 72 made approvals stay open 24h. New `requireOwnedSpace()` (verified
      tenant + `spaces.tenant_id` match, the same convention the run endpoints beside them already
      used). Confirmed a plain tenant match is correct for a business sub-space too: an end user's
      `claims.tid` is the tenant of the space in their URL, not the product root's
      (`/internal/stream-tickets/issue` sets `tenantId = urlSpace.tenant_id`). Live-verified BOTH
      directions against production — a real end user reading their own space's approvals gets 200,
      a spoofed-tenant call direct at the worker gets 401.
    - **CF research worth keeping** (docs read this pass, `/agents/concepts/agentic-patterns/
      long-running-agents/` + `/agents/runtime/execution/durable-execution/`): the Agents SDK's
      long-running primitives are `keepAlive`/`keepAliveWhile` (30s heartbeat alarm, minute-scale),
      `runFiber`/`startFiber` + `ctx.stash()` (checkpoint to SQLite, `onFiberRecovered` to resume,
      idempotency keys on `startFiber`), `subAgent`, and a persisted `Plan` object
      (goal/steps/currentStep) doing triple duty as recovery point, user-visible progress, and
      cheap context reconstruction. Also: since 2026-06, an **active outbound connection keeps a DO
      alive for up to 15 minutes**, so an in-flight LLM call no longer risks mid-stream eviction.
      NOTE: `NaelaoAgentDO` has a `fibers` table that is READ in two places and **never written** —
      dead scaffolding for exactly this pattern, same as `@naelao/idempotency`'s zero consumers.
    - **Palantir Orchestrator, from its own DevCon 6 launch** (transcript via Palantir's post; the
      YouTube page itself is bot-blocked from here): `orchestrator.run(...)` wraps a step so the
      operation "is executed once and then recorded into the Orchestrator Services Ledger"; on
      reinvocation "every finished orchestrator.run call short circuits — it returns the recorded
      result stored in the Ledger"; an "execution attempt plus an idempotency key" in the ledger is
      what gives "exactly once execution"; and `orchestrator.signal` "allows the agent to suspend"
      with process teardown at zero cost, making "waiting essentially free" for "thousands of
      agents suspended for basically an unbounded amount of time." Their framing: *"The bottleneck
      for an agent's usefulness today is not intelligence. It's trust."* **Every one of those maps
      onto a CF primitive we already pay for**: `step.do` memoization IS the ledger short-circuit,
      `step.waitForEvent`/`sendEvent` IS `orchestrator.signal` (and a waiting instance holds no
      concurrency slot), and Workflow instance state is the durable journal. We are behind on
      GRANULARITY, not capability.
    2154/2154 tests pass (12 new in `long-running-agent-runs.test.ts`), `npx turbo run typecheck`
    clean (76 tasks), `naelao-agents` + `apps/shell` deployed and the auth fix verified live.
    **Still open (deliberately not attempted in the same pass):** the checkpoint granularity is
    still the whole run — one `step.do` wrapping everything — so per-tool-call exactly-once needs
    either `@naelao/idempotency` finally wired into `ScriptToolSurface.run()` or the loop decomposed
    into one `step.do` per action. And item 72's hand-rolled `suspended_runs` + poll should
    eventually become `step.waitForEvent`, which is the same thing natively and free while waiting;
    rewriting it twice in one session was the wrong trade.

74. **The four items item 73 left open are now BUILT — plus a real bug found while closing them:
    the script-native path never persisted the assistant's answer.** The client writes the USER
    message before dispatching, but nothing wrote the reply, so a reload showed questions with no
    answers, the agent's own conversation memory (item 71 — which reads that same SpaceDO
    transcript) only ever saw the user's half, and a resumed run had nowhere to put its result.
    `handleScriptRun` now writes the answer back via a new `writeAgentAnswerToSession` —
    deliberately NOT the legacy `writeConversationToSession` goal+answer pair, which would
    duplicate every question — attributed with `agent_id` so a bubble can say which agent spoke.
    - **Granularity / exactly-once (the Palantir Orchestrator gap item 73 named) is CLOSED at
      action level.** New `ActionLedger` (`script-engine/types.ts`, optional on `ScriptEngineEnv`
      like `hitlGateway`): an action is recorded when it runs, and the same action with the same
      arguments under the same key returns the recorded result instead of executing. Implemented
      in `NaelaoAgentDO`'s own SQLite (`action_ledger`, PK `(ledger_key, action_name,
      params_hash)`, `INSERT OR IGNORE` so the FIRST execution is the truth a later attempt can't
      overwrite). The key is what ties an original run to its own resumes: `handleResumeRun` mints
      a fresh `runId` (so the trace stays separately readable) but passes the ORIGINAL run's id as
      `ledgerKey` — without that, every already-executed action would look brand new to the ledger
      on a resume. A genuinely different run is never short-circuited. Only SUCCESSES are recorded
      (a failure must stay retryable). All FOUR execution sites go through it, including the two
      inside `applyTerminalDecision` (distill/patch author a script and then run it — that run has
      real side effects too), which needed the runner threaded in as a parameter. Degrades to the
      prior behaviour (model judgment + the within-run repeat guard) when unwired OR when the
      ledger throws — never to a blocked run. 6 new tests.
    - **The approvals inbox — durable approvals were unreachable from the product.** There was NO
      way for an end user to answer a request anywhere in the UI, so every parked action sat until
      it expired: the feature was real end to end except the one step that needs a person. New
      `apps/shell` `/approvals` page listing what's waiting WITH the actual arguments (approving
      `commerce.payout` without seeing the amount and destination is not an informed decision),
      Approve/Decline, a time-left badge, and a load-failure state distinct from "nothing pending"
      (telling someone there's nothing to approve when the list merely failed is how a payout
      quietly never happens). Sidebar entry appears ONLY when something is genuinely waiting — a
      permanently-visible empty inbox trains people to ignore it. No new backend: the routes
      existed (item 73 gated them) and `/spaces/:id/sessions/*` is already router-allowlisted.
    - **Thread authorship.** `messages.author_type`/`author_id` existed since Phase O but nothing
      rendered them. `Chat.tsx` now labels a bubble when a NAMED project agent produced it —
      deliberately silent for the Space Assistant and the person typing, since labelling every
      bubble in an ordinary two-party chat is clutter; a multi-agent thread is the case where "who
      said this" is real information.
    - **Live-verified end to end on production**, not just in tests: minted a real internal token,
      created a genuine `commerce.payout` approval against a real business, and screenshotted the
      deployed shell showing **Approvals · 1** in the sidebar with the request, its amount and
      destination, and a 23h window — then approved it through the product and confirmed the
      pending count returned to 0. Also confirmed the business-first redirect correctly bounces
      `/approvals` to `/spaces` for an account with zero businesses (that was the first
      screenshot's "wrong page" — correct behaviour, not a bug).
    2165/2165 tests pass (10 new), `npx turbo run typecheck` clean (76 tasks), `naelao-agents` +
    `apps/shell` deployed. **Still open:** item 73's other half — replacing the hand-rolled
    `suspended_runs` + poll with `step.waitForEvent`, which is the same thing natively and free
    while waiting. The ledger closes the duplicate-work half of the Orchestrator gap; the
    zero-cost-waiting half is still ours rather than the platform's.

75. **OPEN DECISION (not built — awaiting the user's call): how a project thread models the
    person, the project agent, and the Space Assistant.** Raised by the user as a design question,
    deliberately answered with analysis rather than code. Recorded here so the reasoning isn't
    re-derived next session.
    **Ground truth checked against the code, not assumed:**
    - There is NO three-party thread today. A run writes its answer attributed to whichever
      `agentId` produced it, so a thread carries the person plus ONE agent. The only multi-agent
      transcript is `/agent/mention-run`, which posts each mentioned agent's reply into the same
      session with `agent_id` attribution — unambiguous precisely because the USER did the
      addressing by typing `@Agent1`.
    - `sessions` (chat, owns `messages`) and `threads` (structural, project-scoped) are still
      separate tables with no server link — the documented pre-existing approximation.
    - The assistant has `project.list` / `agent.list` (`workspace-admin` prebuilt) and
      `project_journal.read`, but **no way to list or read a project's threads at all**.
    **The user's sketch:** a project thread is user + project agent + assistant; hide the
    assistant↔agent lane in the UI but let the user expand it; both agents read both lanes "so
    context is not lost."
    **Recommendation given (agreed part):** hide-but-viewable is right and already has a
    precedent — `thread_kind='sub_agent'` + `parent_thread_id`, hidden unless
    `projects.show_sub_threads` (migration v?/§A1.14). Reuse that shape.
    **Recommendation given (pushback), three reasons:**
    1. A flat transcript cannot express ADDRESSING. If the assistant posts into a project thread,
       nothing says whether it is talking to the person or to the agent — you end up needing a
       per-message recipient label, which is the complexity the user was already sensing.
    2. Hiding a lane that CHANGES the visible lane is worse than not hiding it. Sub-agent traces
       hide well because nothing depends on reading them; if the agent's visible reply says what
       it says *because* of a hidden assistant instruction, the collapsed transcript is a
       non-sequitur the user is forced to expand — not really hidden.
    3. Cost: every project-thread turn potentially waking the assistant too, on an account whose
       Workers AI free tier is ~65 agent runs/day platform-wide.
    **The requirement underneath is already solved — by the user's own earlier design.** "Context
    is not lost" is what the Project Journal (`PROJECT.md`, item 71) plus Memory OS L3/L4/L6
    project-shared (Phase U) exist for. The user's own words when we built it: *"the assistant
    won't even need to read all threads it just accesses the file."* Sharing transcripts would be
    a second, unbounded, undistilled mechanism for the same requirement.
    **Proposed model (what I'd build if approved):**
    - A thread is the person + whichever agent is working. Two visible parties, no addressing
      problem. `@mention` multi-agent stays exactly as-is (user-addressed = unambiguous).
    - The assistant speaks in a thread ONLY when it has something for the PERSON — a handoff, an
      escalation, a summary. Rare enough to be signal, visible, no hiding needed.
    - Agent↔agent coordination is STATE, not chat: the journal + the HX1 run trace. Both already
      built and durable.
    - Delegation that spawns real work becomes a subthread, hidden by default, expandable — the
      existing `thread_kind='sub_agent'` pattern, applied to delegation rather than to a synthetic
      conversation.
    - The one genuinely missing capability: a NARROW escape hatch letting the assistant list and
      read a named project thread on demand ("what happened in that conversation"), with the
      journal staying the default path — otherwise we rebuild the thing the journal replaced.
    **Scope if approved:** one new `workspace-admin`-style op (list/read a project's threads) +
    subthread collapse in the shell UI. Transcript itself stays two-party. NOT started.

76. **The thread model from item 75 was approved and is now BUILT, refined from the original
    proposal — the user's own framing (two SEPARATE conversations: user↔agent and
    assistant↔agent, the second hidden-but-expandable) is stronger than item 75's "state only, no
    second chat" recommendation, because it resolves the exact addressing-ambiguity objection that
    recommendation was raised to avoid. Connectors also gained a real space-vs-user scope model,
    closing a gap items 32/55 had already flagged and left open.**
    - **Thread model.** `threads.session_id` (SpaceDO migration v32) links a structural thread to
      a real chat session — a general-purpose column, not consult-specific, closing the "two
      tables with no server-side link" approximation items 66/71 documented, for threads created
      through this new path (every pre-existing thread/session pairing is untouched).
      `listThreads` gained a `parent_thread_id` filter, always answered in full regardless of a
      project's `show_sub_threads` default — the caller named exactly which subthreads it wants.
      New `OrchestrationHooks.consultAgent` (mirrors `spawnSubAgent`'s DO-to-DO dispatch pattern
      exactly, but addresses an EXISTING named agent definition via `{sessionId}:{agentId}` —
      Phase T2's own addressing — instead of a throwaway child): mints a fresh session + a
      `thread_kind='sub_agent'` subthread (or reuses one via `thread_id`), writes the assistant's
      own turn (nothing else does — `handleScriptRun` only ever writes back the answer, per its
      own comment), dispatches to the target agent's own DO directly via
      `agentDO.get(agentDO.idFromName(...))`, and returns the reply — or an honest
      "needs approval" when the consulted agent itself hits a HITL gate. New prebuilt
      `project-coordination` (`agent.consult`, `thread.list`, `thread.read` — deliberately a
      SEPARATE script from `workspace-admin`, which stays Launchpad-business-scaffolding-specific
      per its own header) is wired into BOTH assistant profiles, not just Launchpad's. `thread.
      list`/`thread.read` are read-only and added to the Launchpad guided-mode auto-approved
      allowlist (same precedent as `project.list`/`agent.list`); `agent.consult` stays gated by
      default (a real dispatched run has real cost, same posture as project scaffolding).
      Shell: `Chat.tsx` gained a `threadId` prop (only project threads pass one — Home/assistant
      sessions have no second party to consult, matching the user's own "this is fine in
      assistant sessions" carve-out) and a new "Assistant" panel tab, rendering
      `SubthreadPanel.tsx` — lists consult subthreads for the current thread, collapsed by
      default, each one expandable to its real messages via the existing `getMessages` call.
      Nothing here touches the visible user↔agent transcript itself, which stays exactly
      two-party — the exact non-ambiguity property item 75 was trying to preserve.
    - **Connectors: space-vs-user scope model.** `ConnectorDefinition.scope_model?: "space" |
      "user"` (default absent = `"space"`, byte-identical behavior for every existing catalogue
      entry — none are genuinely personal today; Whop/Gumroad/Higgsfield/the social connectors/
      Notion are all real business accounts, honestly documented in the field's own header rather
      than inventing a fake personal connector to demo it). The credential HIERARCHY already
      existed (item 18's `resolveCredential`: privileged override → user tier for an acting user →
      space-shared fallback) — the actual gap, exactly as items 32 and 55 both flagged and left
      open, was that nothing ever THREADED an acting user id far enough to reach it.
      `storeConnectorCredential` now accepts an explicit `scope`, used by the manual-key connect
      route when `connector.scope_model === "user"` (stores under the CONNECTING member's own id,
      no admin role required — "always allowed for the caller" per the credentials worker's own
      contract); the OAuth/channel paths stay `scope: "space"` always, since per-user OAuth token
      refresh (knowing WHICH member's token to rotate under one shared name) is real, separate,
      explicitly NOT built here. mcp-hub's `buildAuthHeaders` gained an `actingUserId` parameter,
      passed as `on_behalf_of_user_id` to the credentials worker's plaintext-resolution route
      (which already implemented the hierarchy, just never received this) — both `tools/list` and
      `tools/call` now forward `x-naelao-user-id`. The `mcp-connector` prebuilt's `hubHeaders` used
      to send the AGENT's id as `x-naelao-user-id` (harmless before, since nothing read it) — now
      sends the REAL acting end user (`ctx.env.userId`), keeping `x-naelao-agent-id` (the vault
      audit trail) separate, which is what actually makes a `scope='user'` credential reachable at
      call time for the first time. `GET /connectors/status` now resolves "connected" correctly
      per scope model: a space-scoped connector's status still comes from the shared MCP-server
      registration, but a user-scoped one reports whether THIS caller has their own credential row
      (querying the credentials worker's list route, itself unchanged) — reporting a shared
      registration as "connected" for every member the moment the FIRST one connects their own
      account would have been exactly backwards. The connect route's admin gate is now genuinely
      scope-aware end to end: the spaces-worker wrapper relaxed its floor to "member" (a personal
      connector needs no admin), and the agents worker's own connect handler makes the real
      admin-vs-member call per connector, using a NEWLY resolved `x-naelao-business-role` header
      the spaces-worker wrapper forwards ONLY for a `product_end_user` caller (a builder's own JWT
      caller never sends it, so every existing caller is unaffected — verified by a test asserting
      the pre-existing no-header case still succeeds). This is a handler-logic change, not a new
      route shape, so it doesn't carry the Hono route-table-corruption risk items 40/52/60
      documented for genuinely new dynamic-segment routes. Shell: business detail page gained a
      "My Connections" section — any member, not admin-gated — reusing the existing Connect Apps
      handlers; it simply doesn't render today since nothing in the catalogue is `scope_model:
      "user"` yet, honestly, same precedent as the Customers/Campaigns tabs with no backing data.
    - **Not done, deliberately, not silently:** per-user OAuth token refresh; the `ctx.mcp` Tier
      2-4 isolate loopback (`code-runner.ts`) still sends the agent id as the acting user (would
      need `userId` threaded through `CodeRunnerOptions`/`params`, real plumbing across several
      files, for a path currently non-functional in production anyway since `worker_loaders` is
      disabled — see Live Deployment Facts).
    2190/2190 tests pass (25 new: `spacedo-threads.test.ts` extended for `session_id`/
    `parent_thread_id`; `project-coordination-prebuilt.test.ts`; `consult-agent-orchestration-
    hook.test.ts` drives the real DO-to-DO dispatch, not a hand-rolled substitute;
    `mcp-hub-connector-scope.test.ts` proves `on_behalf_of_user_id` threading both at the
    `buildAuthHeaders` unit level and through the real `tools/call` route;
    `connector-channel-vault-write.test.ts` extended for the new business-role gate), `npx turbo
    run typecheck` clean (76 tasks), `apps/shell` verified via `next build`.

77. **Shell nav: "Assistant" merged into a "Dashboard" tab (business + assistant overview in one
    place), moved above Discover, and rebuilt on the real design system.** User-directed UI
    change, not a bug fix. Route folder moved `assistant/` → `dashboard/` (both `dashboard/
    page.tsx` and the chat surface at `dashboard/chat/page.tsx`); sidebar nav key/label/order
    updated in `layout.tsx` (`DEFAULT_PRIMARY_NAV` is now Dashboard → Discover → Projects). The
    page itself now reads BOTH what the old Assistant dashboard showed (config/autonomy,
    built-in scripts, learned skills, memory, crons, channels, agents, recent conversations,
    workspace files) AND, whenever the active space is a real business (`isBusinessSpace` from
    `active-space-context`), a "Business" section (wallet balance + recent transactions, revenue/
    orders when the manifest advertises a `revenue` sidebar item, connected apps, members) plus a
    KPI tile row up top (credits, wallet balance, revenue, members, connected apps, pending
    approvals). Deep management (invites, payout destinations, connecting apps, product CRUD)
    deliberately stays on the business's own `/spaces/:id` page — this is an overview with a
    "Manage business →" link there, not a re-implementation of it. Rebuilt using the REAL design
    system (`Card`/`CardLabel`/`CardValue` from `@naelao/ui`, `.page-view`/`.page-header`/
    `.page-title`, `.section-label`, `.settings-block`/`.settings-row`) instead of the prior
    page's one-off inline-styled grid — visually consistent with the rest of the shell
    (business detail, settings) for the first time. No backend changes — every panel is a
    read-only consumer of already-built endpoints (`getMe`, `listMyBusinesses`,
    `getBusinessWalletBalance/Transactions`, `getBusinessRevenue`, `listBusinessOrders`,
    `getConnectorStatus`, `listBusinessMembers`, `listApprovals`, plus the pre-existing assistant-
    capability endpoints), each settled independently so one unavailable endpoint can't blank the
    page. `npx turbo run typecheck` clean (76 tasks — caught and fixed two real
    `exactOptionalPropertyTypes` violations and one nested-promise return-type mismatch before
    they shipped), `apps/shell` verified via `next build` (stale `.next/types` cache from the
    old `assistant/` route had to be cleared first, or `tsc` fails on a dangling type reference to
    a path that no longer exists — worth remembering for any future route rename). Deployed and
    live-verified end to end: signed up a disposable test end user on the real `launchpad`
    product, created a real test business, and screenshotted the live page twice — confirmed the
    sidebar order (Dashboard above Discover), the merged Business+Assistant sections with real
    data (26 built-in scripts, 10 learned skills actually populated for a `whop-seller` business),
    the KPI tiles, and the "active" status badge all render correctly. One real bug caught and
    fixed from the live screenshot before calling it done: the wallet KPI tile showed "…" forever
    for a genuinely-loaded-but-`not_provisioned` wallet (`{wallet: null, status:
    "not_provisioned"}` has no `balance_cents` field) instead of "$0.00" with a status badge —
    fixed to fall back to 0 whenever the wallet object itself has loaded, redeployed, and
    reverified the fix is live by matching the deployed JS chunk hashes against the local build
    output. **Not cleaned up:** the disposable test business left under the live `launchpad`
    product (`d128c552-8e95-4d11-ab93-8ecabb6dff4b`, "Dashboard Test Co") — deleting a business is
    a builder-only operation with no end-user-reachable route, and no builder JWT was available in
    this pass to remove it the way prior sessions' test PRODUCTS were cleaned up; harmless
    leftover test data, same accepted precedent as items 62-64's own verification runs.

78. **Assistant/user capability parity — the assistant could not create a project or a thread, and
    anything it DID create was invisible to the person who asked. Both now FIXED.** Prompted by a
    direct question ("can the assistant create new threads, new projects — everything a user can?").
    Traced the real surface rather than answering from memory: `workspace-admin` had
    `project.create_from_template` / `project.list` / `project.configure` / `agent.list`, and item
    76's `project-coordination` had `thread.list` / `thread.read` / `agent.consult`. So the gaps
    were exactly the two named: **no ad-hoc project** (only from the template catalogue — "make me
    a project for Q3 marketing" was impossible, since no template matches) and **no thread creation
    at all** (the only thread it could produce was the hidden consult subthread, as a side effect of
    `agent.consult`). Also missing: the Phase T1 project-member ACL. Everything else was already
    covered — `project.configure` is a PATCH passthrough so rename/archive/visibility/caps/agent-
    bindings all work, KB via `knowledge-base`, schedules via `dynamic-workflow.workflow.schedule`.
    - **The real bug found while building this:** neither prebuilt's `spacesCall` ever sent
      `x-naelao-user-id`, so `POST /spaces/:id/projects` computed `created_by: undefined,
      system_caller: true`. `SpaceDO.createProject`'s "the creator is always an implicit
      `project_members` owner" insert is guarded by `if (!alreadyExisted && row && body.created_by)`
      — so it was skipped — and a project defaults to `visibility: 'private'`, which `listProjects`
      shows only to a project member or a space owner/admin. Net effect: **every project the
      assistant scaffolded was invisible to the person who asked for it** (and to every non-owner
      business member) — pre-existing since Phase G, not introduced here. Fixed by forwarding the
      acting user (`ctx.env.userId`) on every spaces-worker call from both prebuilts. That also
      correctly CLAMPS the assistant to what that person could do unaided — a plain member asking
      for a project-member change now gets the same 403 they'd get themselves — which is the same
      principle F-36's `resolveAssistantEffectiveRole` already established. A system run (cron tick,
      channel drain, provision-time scaffolding) has no acting user, so the header is omitted and
      behavior is byte-identical to before.
    - **New ops.** `workspace-admin`: `project.create` (plain named project — what "New project" in
      the shell does), `project.list_members` / `project.add_member` / `project.remove_member`.
      `project-coordination`: `thread.create`. Archiving is deliberately NOT its own op —
      `project.configure({status:'archived'})` already does it through the single PATCH passthrough.
      `thread.create` forces `thread_kind: 'primary'` and drops any caller-supplied kind: `sub_agent`
      is the orchestration hook's private consult/fan-out lane and `channel` is minted by the channel
      gateway from a verified inbound webhook, so letting an agent forge either would give a message
      a provenance it never had (tested explicitly).
    - Gating follows the existing convention with no new engine: guided mode (`always_ask` + a
      read-only allowlist) gates every new mutating op automatically; only `project.list_members` was
      added to `LAUNCHPAD_ASSISTANT_DEFAULT_AUTO_APPROVED`. Both assistant profiles gained a
      "Shaping the Workspace" section — including the two rules that matter operationally: don't
      scaffold to look productive (one well-named project beats five thin ones), and since you act
      AS the owner, a refusal is the real answer for them too, so report it rather than routing
      around it.
    - A test caught a real contract violation before it shipped: the new validating ops were written
      as non-`async` arrows that throw synchronously, but `PrebuiltOp` is declared
      `=> Promise<unknown>` and every sibling validating op (`agent.consult`, `thread.read`,
      `project.configure`) is `async` — so the error path never returned a promise. Fixed at the
      source rather than by relaxing the test.
    2204/2204 tests pass (14 new), `npx turbo run typecheck` clean (76 tasks), `naelao-agents`
    deployed. **Still not reachable by the assistant** (documented, not silently dropped): creating
    a business, inviting/removing BUSINESS members, and connecting a connector — all three are
    deliberately owner-only account actions, not workspace structure, and connecting an app is a
    real browser OAuth consent the assistant structurally cannot perform on someone's behalf.
79. **Fixed the live "Model not found: claude-sonnet-4-6" chat bug (root cause + a real stale-data
    repair), gave a business owner real control over yolo mode and model choice, added inline
    consult cards, and made assistant chat bubbles transparent (Claude-style).**
    - **Root cause, FIXED:** two live dispatch fallbacks in `workers/agents/src/index.ts`
      (`rawBody.model ?? modelConfig.model ?? "claude-sonnet-4-6"`) used a bare Claude id as the
      last resort — on an account with no Anthropic provider on its AI Gateway (Workers AI only,
      item 68) that string always 404s. New `DEFAULT_WORKING_MODEL` (`@naelao/billing-core`, same
      Llama id the dashboard's own picker already defaults to) replaces it at both dispatch sites
      plus the context-usage estimate's own separate fallback (`claude-haiku-4-5-20251001`,
      cosmetic but same bug class).
    - **The live blocker was actually a step further: this fallback isn't what the user's product
      was hitting.** `f17b859b-...`'s `config_json.productConfig.modelConfig.model` was explicitly
      set to `"claude-sonnet-4-6"` (a real value, not "unset") — confirmed via a direct D1 query,
      and reproduced live: `POST /agent/run` returned the exact reported 404 even after the code
      fix deployed, since an explicit override always wins over the new default. No end-user- or
      builder-reachable control existed to CHANGE it (the dashboard's model picker only PATCHes
      `/builder/products/:id`, JWT-builder-only). Repaired the live row directly (D1 UPDATE,
      `modelConfig.model` → the working Llama id) and re-verified: `POST /agent/run` against the
      same product now returns `status:"completed"`, `finalAnswer:"2+2 is 4."` — the first real
      confirmed working chat reply on this specific product.
    - **The actual control surface, BUILT so this can't recur invisibly.** New
      `PATCH /spaces/:spaceId/model-config` (business-scoped, same `config_json.productConfig`
      override pattern as `member-billing`) and `assistant-policy` PATCH's product_end_user block
      relaxed to `requireBusinessMembership({PATCH:"admin"})` — a business-admin end user who
      genuinely owns their own Launchpad business can now toggle guided/yolo and pick the model
      themselves, not just a platform builder via the dashboard. Router allowlist grew accordingly
      (identity-only, real authorization on the spaces worker as always). Surfaced in
      `apps/shell`'s Dashboard tab (item 77) as an editable Guided/Autonomous toggle + model
      `<select>`, read-only for a non-admin viewer, reusing `ALLOWED_MODELS`/`DEFAULT_WORKING_MODEL`
      from `@naelao/billing-core` (new shell dependency).
    - **Inline consult cards (the subthread UX question).** Item 76 rendered a consult
      (assistant→project-agent delegation) only in a separate "Assistant" tab, with no link back
      to which chat turn caused it. New `messages.metadata` column (SpaceDO migration v33, same
      free-form-JSON-override pattern `sessions.metadata` already used) lets the assistant's own
      reply carry `{consulted_threads:[{thread_id, agent_id, title, session_id}]}` — populated by
      a `consultLog` collector threaded through `buildOrchestrationHooks` that records every
      `agent.consult` call (success OR the consulted agent needing its own approval — the thread
      exists either way) and is attached when `writeAgentAnswerToSession` persists the answer.
      `apps/shell`'s `Chat.tsx` renders one expandable `SubthreadEntry` (exported from
      `SubthreadPanel.tsx`, so both surfaces share one expand/fetch-messages implementation)
      directly under the assistant bubble that produced it — collapsed by default, same "a real,
      separate exchange, never appended to the visible transcript itself" rule item 76 established.
      The separate "Assistant" tab is unchanged and still useful (it lists every subthread for a
      project thread, including ones not tied to any rendered message).
    - **Transparent chat bubbles.** `packages/ui/src/styles.css`'s `.bubble` no longer carries
      background/padding/radius — only `.bubble.user` does. An assistant/agent reply now renders
      as plain text on the page background, matching claude.ai's own thread, not a colored box.
    - Live-verified end to end: the corrected chat run above; grepped the deployed
      `naelao-shell.pages.dev` production bundle for the new Autonomy/Model control strings and
      the transparent-bubble CSS rule, both present. `naelao-agents`, `naelao-spaces`,
      `naelao-router`, and `apps/shell` all deployed. 2219/2219 tests pass (24 new),
      `npx turbo run typecheck` clean (76 tasks).
    - **Not done:** a live browser click-through of the new Autonomy/Model controls (same
      Playwright-can't-TLS-handshake limitation as every prior UI pass — verified via bundle
      content + a direct spaces-worker test suite instead); per-message streaming deltas for a
      consult's own reply (the outer assistant reply already streams normally).
80. **Credential hierarchy expanded to a real Naelao -> Product -> Business -> Personal model
    (user's own design, this session) + three launchpad-mockup page ports, scoped per the user's
    own answers to a design-tradeoff review before building.** Design tradeoffs resolved via
    `AskUserQuestion` before writing code: naelao-platform-key fallback usage auto-bills the
    builder's org (not an opt-in toggle); multiple named credentials per connector use a
    `connector::slot` naming convention on the EXISTING `space_credentials` schema (not a new
    table); per-project connector-tier overrides are explicitly deferred (hierarchy defaults
    only this pass).
    - **Credential hierarchy** (`workers/credentials/src/index.ts`, migration
      `0069_credential_sharing_and_product_tier.sql`): `resolveCredential` gained a 4th tier — a
      business (child) space with no local match now falls through ONCE to its PRODUCT ROOT's own
      `scope='space'` row (walked via the existing `spaces.parent_space_id`, best-effort/never a
      hard dependency of resolution). New `shared_with_user_ids` column lets an admin narrow a
      business-shared credential to specific members instead of only "everyone" — checked in
      `sharedRowAppliesToUser`, settable at creation or via a new sharing-only
      `PATCH /spaces/:spaceId/credentials/:credId` (never touches the encrypted value). Multi-slot
      naming (`gmail::work` vs `gmail::personal`) is just a widened name-validation regex — zero
      schema change. `/plaintext` now returns `resolved_tier` (`user`/`business_shared`/
      `business_override`/`product`) and, when a specific acting user didn't land on their OWN
      credential, fires `credential.fallback_used` through SpaceDO's existing generic event-fire
      endpoint (fire-and-forget, mirrors `whop-wallet.ts`'s `fireWalletEvent`) — the "notify the
      assistant when a fallback happened" ask, reusing infra rather than inventing a second
      notification path. **A real bug caught by the new product-tier test**: decryption used the
      REQUESTED space's id to re-derive the per-space HKDF key, which is wrong the moment a row
      resolves from a DIFFERENT space than the one asked about (exactly the product-root case) —
      fixed to key off `row.space_id`, the credential's own space, not the caller's.
    - **Naelao-wide fallback billing**: `mcp-hub`'s `resolveProviderApiKey` (Composio/Pipedream
      routing, item 56/57) is the real "falls back to Naelao's own platform key" moment — new
      `recordPlatformKeyUsage` meters it via the ALREADY-EXISTING generic `POST /billing/usage`
      sink (`event_type: "platform_connector_key"`, same route `llm_tokens`/`infra_credits`
      already use), fired only when `keyRes.source === "platform"` at actual tool-CALL time (not
      the cheaper, high-frequency `tools/list`). New `BILLING_WORKER` service binding.
    - **Dashboard credentials page was silently broken — found and fixed while extending it.**
      `apps/dashboard/.../spaces/[spaceId]/credentials/page.tsx` posted
      `{name, credential_type, secret_value, label}` and read `data.data` — the real worker wants
      `{name, value, scope, is_override, shared_with_user_ids}` and returns
      `{credentials: [...]}`, so every create 400'd ("value is required") and the list silently
      rendered empty. The exact "UI diverges from the real contract" bug class this file has
      documented repeatedly (`config_schema`/`schema_json`, etc.) — nobody had exercised this page
      against the real backend before. Rewritten against the real contract, extended with a
      scope picker (Personal/Shared — creating a Shared credential on a product's OWN root space
      IS the product-wide default, no separate "product" UI needed) and the sharing control
      (everyone / selected member ids).
    - **Three UI ports from `apps/launchpad/src/index.html`'s mockup, honest about what carried
      over and what didn't.** Discover (`/spaces`) gained a left quick-nav tree of the user's real
      businesses (name + status dot), alongside the existing card grid — a shortcut, not a
      replacement. The mockup's own "Space Types" grid on this same page was deliberately dropped
      per the user's explicit instruction (also matches CLAUDE.md item 7: Naelao authors
      SpaceTypes, an end user never picks one per-space). Home (`/new`) gained the mockup's
      icon quick-chip row (Run agent / Web search / Help me write / Analyze data) — these PREFILL
      the input rather than send immediately, a real, distinct affordance from the existing
      full-sentence STARTERS buttons, not a redundant second row. The mockup's fake weather widget
      was deliberately NOT ported — decorative, not backed by any real capability, and porting it
      would be fabricating a feature. Projects (`/projects/[projectId]`) gained a real stats row
      (Threads / Agents / Last activity, all from data already fetched — no fabricated "credits
      used"/"runs" numbers, matching this file's own `credits_consumed: null` precedent) and an
      "Agents in this project" grid marking the project's default agent.
    2230/2230 tests pass (11 new: product-root tier, selective sharing, PATCH sharing, multi-slot
    naming), `npx turbo run typecheck` clean (76 tasks), both apps verified via a real build +
    deploy (not just `next build`). Migration 0069 applied directly to the live D1
    (`naelao-platform`); `naelao-credentials` and `naelao-mcp-hub` redeployed to production;
    `apps/shell`/`apps/dashboard` rebuilt and redeployed, both confirmed live (200) at
    `naelao-shell.pages.dev/p/launchpad/spaces` and
    `naelao-dashboard.pages.dev/dashboard/spaces/.../credentials`.
    **Not done, deliberately (per the resolved design-tradeoff answers):** per-project connector-
    tier override UI/table (hierarchy-default-only this pass); an end-user-facing "promote my
    personal connector credential to shared" control in the shell (today sharing is set from the
    admin-only raw credentials CRUD page in the builder dashboard, not from a business's own
    Connect Apps panel — a natural, separate follow-up).
81. **The Projects page port (item 80) was corrected — the first pass only bolted a stats row
    onto the OLD layout without touching structure, which the user caught immediately.** Rebuilt
    `apps/shell/.../projects/[projectId]/page.tsx` against `apps/launchpad/src/index.html`'s
    `#projects-view` for real, using the SAME global classes `packages/ui` already ports from
    that mockup (`grid-4`, `workflow-item`, `badge-green`/`badge-amber`, `search-bar`,
    `card-icon`, `btn-ghost`/`btn-primary`) rather than a re-theme: a breadcrumb, an icon-button
    header (Settings scroll-to + New Thread), a 4-tile stats row, a client-side-searchable thread
    list with status-colored badges, and an agents-in-project grid ending in a real "view all
    agents" link (`/agents`) instead of the mockup's fake "Add Agent" affordance. No fabricated
    data anywhere (no credits/run-count tiles). 2230/2230 tests pass, typecheck clean, deployed
    and confirmed live by grepping the deployed bundle for the new markup.
    **Lesson for future UI-port asks in this codebase: match STRUCTURE, not just add data.**
82. **Polsia gap analysis (asked directly) surfaced a real inaccuracy in how the prior session
    summarized this platform's own proactive/heartbeat design — corrected by reading the actual
    code, not the changelog prose — and the one real, narrow gap that analysis found is now
    BUILT: every business previously got ZERO proactive activity unless a builder happened to
    wire a channel, connector, or cron by hand.**
    - **The correction:** `enqueueAgentTicks` (`workers/agents/src/index.ts`) runs on an
      **hourly** cron (`0 * * * *`, `workers/agents/wrangler.toml [triggers]`), not nightly like
      Polsia's once-a-day CEO-agent batch — and inbound channel messages trigger a heartbeat
      immediately, with the hourly sweep as a backstop, so the real cadence is closer to
      near-real-time than either "nightly" or "hourly" alone suggests. A `case "daily_digest"`
      handler already existed and correctly emails the owner a real last-24h activity summary
      (runs/failures/approvals/tokens/credits pulled from `agent_activity_log`) — a prior
      session's own claim that this was "not built" was stale/wrong, corrected here after
      actually reading the code.
    - **The real gap, found by reading `enqueueAgentTicks` end to end:** every roster it sweeps
      (channel heartbeats, connector polls, scheduled jobs, the digest itself) only fires for a
      space that ALREADY has something configured — a connected channel, a pollable connector, an
      explicit `scheduled_jobs` row, or (for the digest) an explicit
      `productConfig.notificationsConfig.dailyDigestEnabled: true` opt-in. Nothing auto-creates
      any of these at provision time, so the assistant profile's own "REVENUE REVIEW — on your
      recurring wake-ups" instruction (`workers/agents/src/script-engine/profiles.ts`) sat unused
      for any business that hadn't been manually wired up — a materially narrower gap than "no
      proactive system," but a real one.
    - **Fixed both defaults.** `seedDefaultRevenueReviewCron` (new, `workers/provisioner/src/
      index.ts`, exported and unit-tested standalone like its `seedLaunchpadAssistantPolicy`/
      `seedWallet`/`seedOwnerMember` siblings) seeds one daily `scheduled_jobs` row per templated
      Launchpad business at provision time (Step 9b, alongside `seedTemplateProjects`),
      addressed at the Space Assistant with a goal that mirrors the profile's own instruction:
      read the project journal, check `business_wallet`/commerce orders, log findings to the
      journal, and only message the owner when something genuinely needs attention — never a
      routine "all good" ping. Deliberately DAILY (`0 13 * * *`), not hourly: the platform-wide
      tick infrastructure is already more continuous than Polsia's cadence, so this only needs to
      cover businesses with no channel/connector activity at all, without adding load on top of
      an already-constrained Workers AI quota (see Live Deployment Facts). `createSpaceRecord`
      (`workers/spaces/src/create-space.ts`) now defaults
      `productConfig.notificationsConfig.dailyDigestEnabled` to `true` for every new product
      unless the caller already set it explicitly (respects an explicit opt-out; preserves every
      other `productConfig` field via a shallow merge). Both best-effort/non-fatal, matching this
      file's own standing precedent for provisioning-time seeds — a failure degrades to "no
      proactive review until configured by hand," never blocks or breaks provisioning.
    2236/2236 tests pass (6 new: `provisioner-default-revenue-review.test.ts` plus 3 new cases in
    `create-space-record.test.ts`), `npx turbo run typecheck` clean (76 tasks), `naelao-
    provisioner` and `naelao-spaces` deployed to production. **Not done:** live end-to-end
    verification (create a real business, confirm the cron row lands) was deliberately skipped
    this pass — the exact `POST /spaces/:spaceId/scheduled-jobs` call this reuses is
    already proven live-working from prior sessions, and the new logic is fully covered by unit
    tests against the real request shape; skipped creating another disposable test business to
    avoid clutter for a low-risk, best-effort, unit-proven change. **Also noted in passing, out
    of scope, not touched:** `workers/spaces/wrangler.toml`'s `PRODUCT_SHELL_URL` var is blank
    (`""`) in every environment including production — a separate, pre-existing, already-known
    gap in the same family as the router's own documented `PRODUCT_SHELL_URL` issue.

83. **Chat UI parity pass: fixed a real duplicate-reply bug, and built a live "currently doing X"
    activity feed + a Claude-Code-style model/reasoning-effort switcher for the chat input bar.**
    User-reported: sending a message in `apps/shell`'s chat sometimes echoed the same reply 2-3
    times.
    - **Root cause, FIXED:** `Chat.tsx`'s `send()` mints a session for a fresh thread and calls
      `streamRun` for the run it just started; separately, a "reattach to an in-flight run on
      mount" effect (item §A1.27) depends on `chatSessionId` and ALSO calls `streamRun` for
      whatever `getActiveRunId` returns. Since `send()` calls `storeActiveRunId` synchronously
      before `setChatSessionId` re-renders, the reattach effect fired on that SAME re-render and
      saw the run `send()` had just started as "already in flight" — opening a SECOND independent
      EventSource for it. Each one independently appended its own completed-answer bubble on
      "done" (and a THIRD copy if one connection's `onerror` fell back to `pollUntilDone`),
      producing the reported 2-3x duplication on every first message of a new session/thread.
      Fixed with a single `attachedRunIdRef` gate shared by both call sites — whichever reaches a
      given `runId` first wins; every other attempt for that id is a no-op.
    - **Live activity feed (script-engine/loop.ts + NaelaoAgentDO + the SSE stream).** The loop's
      `onProgress` checkpoint was previously fired only at 3 spots (observe/gate/L3-L4-step) with a
      narrow `{phase, detail}` shape — widened to the full `TraceStep` shape and now fires from
      `pushTrace` itself (so EVERY persisted trace event also live-reports, for free) plus new
      "begin" pings before each slow op (observe/find/reason/run) so a chat UI can show "Thinking…"
      /"Running script.find…" WHILE it's happening, not just after. `NaelaoAgentDO` gained an
      in-memory `liveRuns` map (bounded, cleared in a `finally` once the run resolves) fed by a
      newly-general `onProgress` wiring (previously built ONLY for sub-agent-parent progress
      reporting, via a new `composeProgressReporters` combinator so both uses coexist).
      `handleGetRun` now synthesizes a `{status:"running", live_steps:[...]}` response from that
      map BEFORE falling through to its `agent_runs` SQL lookup — closing a real gap: a
      script-native run (the default dispatch since item 47) writes no `agent_runs` row at all, so
      this route always 404'd for the run every real chat message actually uses, and
      `fetchRunOrTaskStatus` silently fell through to TaskDO on every poll with zero mid-run
      visibility. The SSE `/stream` endpoint's existing 1s poll loop now also diffs `live_steps`
      against the highest `seq` already sent and forwards new ones as a `type:"activity"` event;
      the plain poll route (`pollRun`) gets the same data as a full list each tick (no delta
      tracking needed there). Shell: new `ActivityFeed.tsx` (`LiveActivityLine` — the live
      single-line "currently doing X" indicator; `ActivitySummary` — a Claude-Code-style
      collapsed-by-default "Thought and used 2 tools" bar under a completed reply, expandable to
      the ordered step list, each step individually expandable to inspect tokens/duration/tier).
      Renders nothing for a trivial answer-only turn — a bar under every single message would be
      noise, not signal.
    - **Model + reasoning-effort switcher, researched per-model rather than assumed.** New
      `packages/billing-core` export `MODEL_CAPABILITIES`/`capabilityForModel`/
      `isValidReasoningLevel`: which of `ALLOWED_MODELS` support a configurable reasoning/thinking
      mode, and the exact wire shape — confirmed via Cloudflare's own Workers AI docs pages
      (gpt-oss-120b/20b: `reasoning_effort` low/medium/high; glm-5.2: `reasoning_effort` with
      exactly two modes, "high"/"max") and its Kimi K2.6 changelog post (a DIFFERENT shape,
      `chat_template_kwargs.thinking` boolean, returning chain-of-thought in a `reasoning` field
      rather than the more common `reasoning_content` name) — everything else (including the
      account's actual working default, Llama 3.3) honestly reports no reasoning capability rather
      than guessing. `ai-client.ts`'s `buildUniversalBody` gained a `reasoning?: {param, level}`
      option that injects the right field per shape; `normalizeUniversalResponse` gained a
      `thinking` extraction — a REAL captured live payload already in this repo's own tests (a
      gpt-oss-120b response) showed a model can send BOTH `reasoning` (fuller) and
      `reasoning_content` (shorter) at once, so `reasoning` is preferred first. `GatewayReasoner`
      gained `lastThinking` (mirrors the existing `lastUsage` per-call contract);
      `NaelaoAgentDO.resolveReasoningRequest` validates a client-requested level against the
      model's own capability before ever constructing the reasoner. `/agent/run` accepts
      `reasoning_effort`, validated against whichever model the run actually resolves to (not just
      the raw request field) — rejecting e.g. `glm-5.2`'s `"max"` level for a `gpt-oss-120b` run —
      and threads it through both the sync dispatch and the async Workflow→
      `/internal/tasks/:taskId/run` path identically. Shell: new `ModelSelector.tsx` (a
      capability-aware dropdown — a model with no reasoning capability simply shows no such
      control, never a disabled dead one) + `modelPreference.ts` (localStorage, per-space model +
      per-(space,model) reasoning level — a client-side override distinct from
      `updateModelConfig`'s business-wide stored default, same relationship Claude Code's own
      per-session model picker has to an org default).
    - **Not built this pass (scoped, documented, not silently dropped):** true token-by-token
      streaming of the final answer text itself — still the same documented §A1.27 gap (the
      script-native loop's terminal LLM call doesn't progressively persist); the activity feed
      gives real live STEP-level granularity ("currently doing X") but not sub-step token
      streaming. Also not built: a live DO-instance-level integration test beyond the one
      concurrency-gated test added (`live-activity-feed.test.ts`) — deeper scenarios (multiple
      concurrent runs on one DO, a run that hits an approval gate mid-stream) are unexercised.
    - **A deploy-tooling trap worth recording:** `workers/agents/wrangler.toml` has NO `name`
      override under `[env.production]`/`[env.staging]`, so `wrangler deploy --env production`
      targets a DIFFERENT worker (`naelao-agents-production`, auto-created, MISSING its D1/DO/KV/
      Vectorize/Queues/R2/AI bindings per wrangler's own "not inherited by environments" warnings)
      than the actual long-standing live worker (`naelao-agents`, confirmed via the CF API's
      services list by `modified_on` timestamp). The real production deploy command for this
      worker is the BARE `wrangler deploy` (no `--env` flag) — it uses the top-level `[vars]`/
      bindings, which already carry everything needed (this is presumably also why item 45's "carry
      NAELAO_ACCOUNT_ID/NAELAO_GATEWAY_ID forward into env.staging/production" fix has never
      actually been exercised by a real production deploy — those blocks aren't what's live). The
      accidentally-created `naelao-agents-production` duplicate was deleted via the CF API
      immediately after being found. **Do not use `--env production` for this worker's deploys —
      use bare `wrangler deploy`.**
    2258/2258 tests pass (22 new: `live-activity-feed.test.ts`'s concurrency-gated DO test proving
    `live_steps` is really visible mid-run and cleared after; new cases in
    `reasoner-tool-calling.test.ts`, `packages/billing-core.test.ts`, and
    `model-switcher-config-resolution.test.ts`), `npx turbo run typecheck` clean (76 tasks),
    `naelao-agents` (the REAL one, verified via bare `wrangler deploy`) and `apps/shell` both
    deployed and live-verified by fetching the deployed JS chunks directly and grepping for the
    new `reasoning_effort`/`live_steps`/`ModelSelector` strings (present, byte-identical to the
    local build).

84. **Projects sidebar (mockup port), in-chat approval + connector cards, a Connectors browser
    (Composio default / Pipedream filter), and input-bar Connectors/Upload buttons — a large,
    user-directed batch, explicitly scoped down in two places (documented below, not silently
    dropped).**
    - **Projects page sidebar.** `apps/launchpad/src/index.html`'s `#projects-view` has a 220px
      left rail (project tree + "Agents in Space" shortcuts) the shell's `/projects/[projectId]`
      page never ported (item 81 only matched the RIGHT pane). Added, reusing the Discover page's
      existing `.spaces-layout`/`.spaces-sidebar`/`.spaces-content` classes rather than inventing
      new ones (packages/ui/styles.css already has this exact two-pane shape). Thread counts are
      shown only for the currently-open project (already fetched) — every OTHER project's count
      would be an N+1 fetch for a cosmetic number, so it's left off rather than faked.
    - **In-chat approval cards.** A run stopping at a HITL gate had a real, previously-undetected
      gap: the DEFAULT async (Workflow/TaskDO) dispatch path stored only the friendly placeholder
      text in TaskDO, never the `approval_id`/`action_name`/`params` `normalizeScriptRunResult`
      already computes — so a polling client could see `status:"awaiting_approval"` but nothing
      to act on. Fixed end-to-end: `AgentTaskWorkflow`'s run-agent step captures
      `pending_approval` (pre-JSON-stringified to satisfy CF Workflow's `Serializable<T>` step
      -return constraint, which chokes on a bare `Record<string,unknown>` — re-parsed only inside
      the plain, non-step `update-result` callback where that constraint doesn't apply) and
      stores it in TaskDO's `result`; `fetchRunOrTaskStatus` (shared by the plain GET-run route
      AND the SSE `/stream` poller) now surfaces it. **A second real gap found in the same
      code path:** the SSE stream's poll loop never treated `awaiting_approval` as
      stream-terminal — it just kept polling silently for up to 2 minutes (the client's
      `onmessage` only ever acted on `"done"`), so a chat message hitting an approval gate via the
      SSE path (the common case) showed a stuck typing indicator with zero feedback until
      timeout. Fixed by sending `type:"done"` (carrying `pending_approval`) for
      `awaiting_approval` too, same as completed/failed/cancelled. `apps/shell`'s new
      `InlineApprovalCard.tsx` renders Approve/Decline at the exact turn that asked, reusing the
      same `/approvals` endpoints the separate inbox page already uses — resuming happens
      server-side automatically once answered.
    - **Inline "Connect this app" card.** `script-engine/tool-surface.ts`'s `needs_connector`/
      `connector_id`/`connector_name` (item 56) reached only `ScriptRunResult`, never the
      persisted message — `NaelaoAgentDO.writeAgentAnswerToSession`'s call site now folds them
      into the SAME `metadata` object `consulted_threads` already rides in, so
      `InlineConnectorCard.tsx` can render a real Connect button under the exact reply that asked
      for the app, instead of the connector name only ever appearing in prose.
    - **Sidebar → More → Connectors, with a real Composio/Pipedream filter.** New
      `apps/shell/.../connectors/page.tsx`: search bar + a provider filter chip row (Composio
      default per the ask, Pipedream, All) over `getConnectorStatus`'s existing catalogue
      response — no new backend route, this promotes the business-detail page's existing inline
      "Connect Apps" panel logic into its own browsable page. New
      `apps/shell/src/lib/connectorActions.ts` factors the composio/oauth/manual-key connect
      branching into shared functions (used by the new page, the input bar's Connectors popover,
      and the inline connector card) — the business-detail page's own long-standing inline copy
      of this same logic was deliberately left untouched rather than refactored under this pass,
      to avoid risking a regression in already-working, deployed code for a UI consistency win.
    - **Input bar: tools/connectors + uploads, not just the model selector.** New
      `InputBarExtras.tsx`: `ConnectorsButton` (a popover listing this space's connectors with
      inline connect, a shortcut to the full page) and `UploadButton` (attaches a TEXT file
      directly into the space/project's knowledge base via the existing `createKbDocument`
      pipeline — real, working ingestion; deliberately scoped to text-readable files, rejecting
      binaries client-side rather than silently ingesting garbage, since real PDF/image parsing
      is a separate, larger KB-pipeline feature this pass doesn't add).
    - **Deliberately NOT built this pass (documented, not silently dropped, both genuinely large):**
      (1) project-level and assistant-level credential SCOPING TIERS — the ask ("stored project
      wise... for assistants stored assistant wise") is a real extension of the existing
      Naelao→Product→Business→Personal hierarchy (items 18/80), needing new scope enum values in
      the credentials worker, a resolution-order change, and picker UI; the EXISTING architecture
      already satisfies the "AI never sees the raw key" half of the ask (agents call scripts,
      scripts resolve credentials server-side via mcp-hub, the LLM itself never receives
      plaintext) — only the NEW scoping granularity is the open item. (2) a cross-provider MCP
      TOOL SEARCH capability so the assistant/project agents can discover tools across Composio's
      AND Pipedream's full catalogs (today they can only use what's in the curated, Naelao-added
      `CONNECTOR_CATALOGUE` — there's no `script.find`-equivalent semantic/keyword search across
      either provider's own tool listings). Both are real, scoped, separately-sized follow-ups.
    - **Duplicate-reply bug (item 83) — confirmed by the user as fixed on reload even before this
      session's redeploy; re-confirmed still fixed after this pass's changes** (the
      `attachedRunIdRef` gate is untouched by this batch).
    2261/2261 tests pass (26 new: `run-status-pending-approval.test.ts` proves
    `fetchRunOrTaskStatus` surfaces `pending_approval` through the REAL TaskDO wire contract — a
    first draft of this test used the wrong shape (a JSON *string* for `result`, matching how
    TaskDO STORES it) and failed; TaskDO's own GET handler actually JSON.parses `result` before
    responding, so the real contract is an already-parsed object — fixed the test to match, not
    the code), `npx turbo run typecheck` clean (76 tasks), `naelao-agents` (bare `wrangler
    deploy`, per item 83's own documented trap) and `apps/shell` both deployed and live-verified
    by fetching the exact deployed chunks and confirming byte-identical size to the local build.

85. **Fixed a real live bug where the agent's own reply was a raw internal parse-error string, and
    built a bounded slice of a large user-directed batch (business-wide connector accounts,
    notifications, safer inbound-channel handling) — with two genuinely large pieces explicitly
    scoped down and documented, not silently dropped.**
    - **Root-caused and fixed the reported bug.** "search the web for polsia ai" returned
      `unparseable reasoner output: no JSON object in reasoner output` as the AI's own reply.
      Reproduced live against the real AI Gateway endpoint (both a first-turn tool-call and a
      second-turn post-search-result turn worked fine in isolation), which pointed at the real
      cause: `tool_choice:"required"` (item 68) isn't always honored by Workers AI models — a
      model can still answer in plain prose with no tool call and no `{...}` JSON at all.
      `GatewayReasoner.decide()`'s fallback used to `give_up` with that raw parser-error string
      whenever neither a tool call nor parseable JSON was present; it now treats any non-empty
      prose as the intended answer (only giving up when the model truly returned nothing), fixing
      this whole class of failure rather than one query. 2 new tests
      (`reasoner-tool-calling.test.ts`) pin both the fixed prose-becomes-answer case and the
      still-correct empty-response give_up case.
    - **Notifications — a durable, business-member-visible inbox** (new SpaceDO `notifications`
      table, migration v34): what the assistant/its agents want a human to see (an approval
      opened, a run failed, an inbound message got blocked) — distinct from `agent_activity_log`
      (builder-only audit trail) and from Approvals (which needs a decision; a notification just
      needs to be seen). `GET/POST /spaces/:spaceId/notifications` (business-member-gated,
      POST restricted to `{action:"mark_read"}` only at that layer — a real notification can only
      ever be created via the internal HMAC-gated route). `notifyApprovalRequested` now also
      writes a notification and — new — checks `isAnyoneCurrentlyPresent` (the existing presence
      table) before sending the immediate owner email: someone actively in the space sees it via
      the in-app notification / inline approval card already built (item 84); an immediate email
      on top is noise. A genuine run failure (`result.result.ok === false`) now raises one too.
      **Heartbeat escalation for whoever's away**: since there's no cheap D1-indexed way to know
      platform-wide which spaces have an undelivered notification without opening every SpaceDO
      (the enumeration anti-pattern this file already warns against), `sweepUndeliveredNotifications`
      piggybacks on whichever roster already reaches a given space (`heartbeat` — spaces with a
      connected channel; `scheduled_job` — every templated Launchpad business via item 82's daily
      revenue-review cron), delivering anything still unread+undelivered past a 15-minute grace
      window via email and marking it delivered. A space reached by neither roster gets no sweep
      at all — a real, documented gap, not a silent one; the immediate at-creation-time email is
      what actually covers the time-sensitive case. Shell: new `/notifications` page (sidebar →
      More), reusing the Approvals page's own loading/failure-state discipline (a load failure
      must never read as "nothing to see"). 10 new tests (`spacedo-notifications.test.ts`).
    - **Connector default-vs-personal account switch — the actual mechanism, not just a UI
      toggle.** The existing credential hierarchy (items 18/80) resolves a member's OWN personal
      credential ahead of the shared business one whenever one is connected — the opposite of
      what "business is autonomous, humans stay relaxed" wants as a default. New `prefer_scope`
      param on the credentials worker's `resolveCredential` (additive — absent behaves
      byte-identically to before): `"business"` skips the personal tier even when one exists;
      `"personal"` REQUIRES it, returning a distinct `personal_credential_required` 404 rather
      than silently substituting the shared account (exactly the "forgot to switch" case the UI
      needs to surface). The privileged override tier always wins regardless of either mode.
      Threaded end to end: `mcp-hub`'s `buildAuthHeaders` forwards it; the `mcp-connector`
      prebuilt's `hubHeaders` reads a new `ScriptEngineEnv.connectorAccountMode` map (per-connector
      `"business"|"personal"`) and sends it as `x-naelao-connector-scope`; `NaelaoAgentDO` reads a
      session's stored mode ONCE per run (new SpaceDO `connector_account_mode` table + a
      `GET/PATCH /spaces/:spaceId/sessions/:sessionId/connector-mode` route on the agents worker,
      same explicit-before-the-router's-generic-sessions-catch-all registration item 48's
      context-usage/compact routes needed) — best-effort, defaults to business on any failure.
      Shell: the input bar's Connectors popover shows a per-connector "Using: business/personal —
      switch" toggle for anything already connected. Both assistant profiles were told the rule:
      a `personal_credential_required` error means the chat is still on the business account (or
      has no personal one connected) — say so plainly, never silently retry against the business
      account as a stand-in for what was actually asked. 5 new tests
      (`credential-hierarchy.test.ts`).
    - **Inbound-channel safety — a real, previously-silent gap closed.** Traced
      `handleChannelHeartbeat` (the drain loop behind EVERY customer-bot/channel project, which is
      also what a future business-email channel would run through) and found the existing
      prompt-injection/jailbreak moderation check on inbound messages (`moderateInput`) already
      blocked a flagged message from ever reaching the reasoning prompt — but then just
      incremented an `escalated` counter and silently dropped it. Nobody was ever told. Now sets
      `human_takeover` on the session (same contract as an explicit no-code rule) AND raises a
      `critical` notification through the new inbox above — directly the "the moment it tries
      something bad, the assistant is notified" behavior asked for, built on infrastructure that
      already existed rather than a new per-project "lower-tier agent" mechanism. 1 new test
      (`naelaoagentdo-customer-bot-heartbeat.test.ts`) drives a real jailbreak-pattern inbound
      message through the actual heartbeat and confirms the session is held for a human.
    - **`business_email` project kind fixed to actually declare its own script** — the registry
      entry (`packages/events/src/business-feature-kinds.ts`) has existed since a much earlier
      pass with `autoProvisionable: true` and a real `business-email` prebuilt (Naelao-managed
      outbound sending address) already built, but the registry's own `prebuiltScripts` field was
      simply never set — a one-line, correct fix, not new functionality.
    - **Deliberately scoped down, documented not dropped (two genuinely large asks):**
      (1) a real AgentMail-style (or similar) auto-provisioned, INBOUND-capable business mailbox
      with zero human setup — investigated rather than guessed at: this account owns **zero DNS
      zones** (confirmed via the CF API, same blocker CLAUDE.md's Live Deployment Facts already
      records for the dashboard's product-domain display), so a Naelao-issued receiving address
      can't resolve regardless of any code written this pass, and fabricating a client against an
      unverified AgentMail API shape under time pressure would violate this codebase's own
      "confirm once real access exists" discipline rather than honor it. The already-built `email`
      CHANNEL type (Mailgun-style inbound-parse, real and tested) remains the working path for a
      business that brings its own domain/provider today. (2) A business having its assistant sign
      itself up for arbitrary third-party services autonomously via CF Browser + a shared identity
      — a real, substantial capability (browser automation, credential capture, per-service consent
      modeling) that deserves its own dedicated pass, not a rushed corner of this one. Both are
      real, named follow-ups, not silently abandoned.
    2279/2279 tests pass (25 new across this pass), `npx turbo run typecheck` clean (76 tasks).

86. **Live-reported bug ("no approval UI shown at all") root-caused via a real reproduction
    against production, not guessed — found a real data-loss bug in item 84's own approval
    plumbing, plus a stale sidebar badge, plus fixed web search being gated at all.** Reproduced
    directly: minted a real internal token, dispatched `/agent/run` (`Prefer: respond-sync`)
    against the user's own live business with the exact reported goal, and got back
    `{"status":"failed","error":"unparseable reasoner output: ...","deferred_approvals":[{...
    "action_name":"search"}]}` — a REAL, still-open approval (confirmed by `wrangler tail`
    showing genuine `GET http://hitl/requests/...` polling) that the frontend had never once
    rendered.
    - **Root cause: `deferred_approvals` (item 73/84's "parked and carried on around" approvals —
      the run does NOT suspend, it keeps working and just remembers what it's still waiting on)
      was handled at the loop/DO level but never threaded through the REST of the pipeline.**
      `AgentTaskWorkflow` (the DEFAULT async dispatch path — this is not an edge case, it's what
      every real chat message goes through) only ever read `pending_approval` off the internal
      run response, so `deferred_approvals` was silently dropped before it even reached TaskDO.
      Worse: `update-result`'s `result: hasError ? null : JSON.stringify(...)` discarded
      `deferred_approvals` a SECOND time whenever the run also hit an unrelated failure — exactly
      the reproduced case, where the model successfully parked a `web-search.search` approval and
      then failed on its NEXT reasoning turn. `fetchRunOrTaskStatus`, the SSE stream's "done"
      event, and `apps/shell`'s own `Message`/`AgentRun` types never carried the field at all.
      Fixed end to end: `AgentTaskWorkflow` now reads and persists `deferred_approvals`
      unconditionally (never dropped by `hasError`), `fetchRunOrTaskStatus` and the SSE endpoint
      forward it, and `Chat.tsx` renders one `InlineApprovalCard` per entry — including a new
      branch for the specific reproduced shape (a run that FAILED but still carries a real,
      separate, still-open approval): a short note plus the card, rather than losing it behind an
      error banner. 3 new tests (`run-status-pending-approval.test.ts`) pin the exact reproduced
      wire shape, including "survives even when the task itself is recorded as failed."
    - **A second, independent bug in the same investigation: the sidebar's Approvals badge only
      ever loaded once per business switch.** `apps/shell`'s layout effect that populates
      `pendingApprovals` had no polling — a new approval opened mid-conversation never made the
      badge (or the nav item itself, which only renders `pendingApprovals > 0`) appear until the
      user happened to navigate away and back. Added a 30s interval poll (cleared on unmount/space
      switch), independent of the inline-card fix above — this is also what makes an approval
      opened by a background/scheduled run (not the conversation currently open) visible at all.
    - **Design fix, the user's other point ("shouldn't such tools already be approved"): web
      search is now in the default guided-mode auto-approved allowlist**
      (`LAUNCHPAD_ASSISTANT_DEFAULT_AUTO_APPROVED` — `web-search.search`/`fetch_page`/
      `extract_content`/`grounded_answer`). It's read-only, platform-keyed (no BYO credential,
      no external side effect, can't move money or post anywhere) — the same "safe by
      construction" class as `mcp.list_tools`/`memory.recall`, which were already on the list;
      web search being absent was a real oversight, not a deliberate security boundary. This is
      the DEFAULT for newly-provisioned businesses only — `seedLaunchpadAssistantPolicy` snapshots
      the list once at provision time into each business's own stored `assistant_policy` row, so
      an already-existing business (like the one this bug was reproduced against) needs its owner
      to either flip the business to Autonomous mode (Dashboard tab, item 79) or re-approve web
      search once from the inline/Approvals UI (now that both actually work) — there is no safe
      way to bulk-migrate a live SpaceDO's stored row from outside a real builder/business-admin
      session, and none was attempted.
    2282/2282 tests pass (3 new), `npx turbo run typecheck` clean (76 tasks).
87. **Auto-provisioned, INBOUND-capable business email is now BUILT via AgentMail — the exact
    feature the prior pass (item 85) deferred because this account owns zero DNS zones. AgentMail
    HOSTS the receiving domain itself, so a business gets a real send+receive address with no
    Naelao-owned zone — the blocker doesn't apply.** Built against AgentMail's real OpenAPI
    (`https://api.agentmail.to`, Bearer auth, `/v0/*`), not a guess — pulled and read the actual
    `openapi.json` for every shape used.
    - **`workers/agents/src/channels/agentmail.ts`** — a dependency-free REST client (`createInbox`
      → `{email, inbox_id}`, `createInboundWebhook` → `{webhook_id, secret}`, `sendFromInbox` →
      `{message_id, thread_id}`) + Svix inbound-signature verification (`svix-id`/`-timestamp`/
      `-signature`, `whsec_`-decoded HMAC-SHA256 over `${id}.${ts}.${body}`, 5-min replay window,
      multi-signature rotation support) + a `message.received` payload parser that returns null for
      spam/blocked variants (never auto-drives the agent) and for non-message events (ack-ignore so
      Svix doesn't retry forever). Every function degrades honestly (`configured:false`) when
      `AGENTMAIL_API_KEY` is unset — same "confirm once real access exists" precedent as Whop/
      Composio/Pipedream. 17 tests including a REAL Svix HMAC round-trip (sign → verify), tamper/
      stale/rotation cases.
    - **The API key lives ONLY on the agents worker** (`AGENTMAIL_API_KEY` secret) — the agent
      isolate never sees it. Three routes: `POST /internal/business-email/provision` (HMAC-gated;
      idempotent — reuses an existing inbox; creates inbox + registers the inbound webhook at our
      own public ingress + vaults the Svix secret under a dedicated `AGENTMAIL_WEBHOOK_SECRET`
      credential name distinct from the Mailgun `EMAIL_SIGNING_SECRET` + persists the address/
      inbox id in `business_services` — inbox id in `config_json`, no schema change), `POST
      /internal/business-email/send` (looks up the inbox, sends; returns `configured:false` so the
      caller can fall back), and `POST /channels/email/agentmail-inbound/:spaceId` (PUBLIC, Svix-
      verified against the vaulted secret, forwards into the SAME `NaelaoAgentDO` channel inbox +
      heartbeat pipeline every other channel uses, so a `business_email` project's AI-triaged inbox
      is fed identically to Slack/Discord/WhatsApp). The webhook URL carries `:spaceId`, so no
      reverse inbox→space map is needed. 7 route tests (HMAC gate, honest degradation, inbound
      fail-closed on bad signature / missing secret).
    - **The `business-email` prebuilt now routes through AgentMail when configured, else falls back
      to Resend outbound-only** — `email.provision` reports `inbound: true/false` honestly;
      `email.send` prefers the real reply-able AgentMail address and degrades to the notifications-
      worker/Resend path otherwise. Reached via a new `agentsWorker` self-binding threaded into the
      isolate env (the agents worker already binds `AGENTS_WORKER` to itself). Added `business-email`
      to the Launchpad assistant's prebuilt list (it was told about email but couldn't call it) and
      `email.status` (read-only) to the guided-mode auto-approved allowlist; `email.send`/
      `email.provision` stay gated (outside-world reach / billable resource), same posture as
      `business_wallet.balance` vs a payout.
    - **Auto-provisioned at creation like the wallet:** `seedBusinessEmail` (provisioner, new
      `AGENTS_WORKER` service binding) best-effort provisions a real mailbox for every templated
      Launchpad business at provision time — no-op when AgentMail is unconfigured (email then
      provisions on demand the first time the assistant calls `email.provision`). Never throws — a
      mail-seed failure can't fail a space creation, same posture as `seedWallet`/`seedOwnerMember`.
    - Both assistant profiles gained a "Business Email" section (it has its own mailbox, can send
      AND receive when AgentMail-backed, say so honestly when it's send-only).
    2310/2310 tests pass (28 new), `npx turbo run typecheck` clean (76 tasks).
    **`AGENTMAIL_API_KEY` is now SET and LIVE-VERIFIED (2026-07-30) — do not re-prompt the user for
    it.** Provisioning the platform's own `launchpad` business against the real key immediately
    surfaced a real, previously-undetected bug: AgentMail's `username` is unique across its ENTIRE
    customer base, not scoped to our account, so the naive slug-derived username ("launchpad")
    403'd with `resource_taken` — some other AgentMail customer already owns that exact username.
    Fixed with new `uniqueInboxUsername(slug, spaceId)` (`toInboxUsername` itself untouched — still
    a pure, tested slug transform), appending a short spaceId-derived suffix so a provisioned
    address is virtually guaranteed unique while staying readable. Live-verified end to end after
    the fix + a real redeploy: created a real inbox (`launchpad-f17b85@agentmail.to`) for the live
    `launchpad` product, confirmed idempotent re-provisioning returns the same address without
    creating a duplicate, registered the inbound webhook (`inbound_wired: true`), and sent a real
    test email through it (`ok: true` with a real AgentMail/SES message id). 4 new tests,
    2324/2324 pass.
88. **Live-reported chat bugs found and FIXED: duplicated replies/approval cards, no self-serve
    "always allow," resumed approvals invisible with no activity trail, and no way to actually
    configure per-tool approvals or a project agent's own policy.**
    - **Root cause of "the same AI message renders 2-4 times, even the approval dialog":**
      `pollUntilDone`'s `setInterval` callback is `async`, but `setInterval` does not wait for one
      firing to finish before scheduling the next — a single slow `pollRun` round-trip let two or
      more overlapping callbacks each independently observe the SAME terminal status and each
      independently append their own completed-message row (and, since every duplicate carries the
      same `pendingApproval`/`deferredApprovals`, the same approval card too) — exactly why a
      reload "fixed" it (reload re-fetches the single canonical persisted transcript). Fixed with a
      `settled` guard so only the first tick to see a terminal status finalizes; mirrored as
      `doneHandled` on `streamRun`'s SSE path (EventSource auto-reconnect can redeliver a queued
      "done").
    - **"Always allow" self-serve fix.** `InlineApprovalCard` gained a second button —
      approve, then read-modify-write the space's `assistant_policy.auto_approved_actions` to
      include this exact action name (business-admin only; a non-admin's approve still succeeds,
      the allowlist write just silently doesn't take, surfaced as an inline note) — the self-serve
      answer to "why does search still ask" for a business whose stored policy predates a newer
      default (item 86 already fixed this for NEW businesses; existing ones needed this).
    - **Resumed approvals now get a real activity trail and fold into the SAME message bubble,
      instead of only ever surfacing on the next reload with no sign of what happened.**
      `handleResumeRun` mints a fresh run id for its continuation pass but never surfaced it
      anywhere pollable — fixed by recording `resumed_run_id` on `suspended_runs` the moment it's
      minted (a new `GET /script/resume-status` DO route), merged into the agents-worker's
      existing single-approval GET response (deliberately NOT a new `:approvalId/resumed-run`
      sibling route — that dynamic-segment-then-static-suffix shape is exactly what has repeatedly
      triggered Hono's documented RegExpRouter corruption elsewhere in this codebase). The chat
      client polls for it after approving and attaches via the SAME `pollRun`/`streamRun`
      machinery an ordinary run uses (`watchForResume`/`finalizeAnswer`), so the continuation gets
      a real "currently doing X" trail and its answer is appended into the ORIGINAL bubble instead
      of a new row — closer to how Claude keeps one long message going across a mid-turn
      permission prompt.
    - **Per-tool approval config + per-project agent config, previously nowhere reachable.** The
      Dashboard's "Pre-approved actions" list was read-only with no way to add/remove an entry
      short of an approval card happening to appear — new `ApprovedActionsEditor` (shared
      component) makes it a real add/remove control. A project agent's OWN approval-policy
      override (`GET/PATCH /spaces/:spaceId/agents/:agentId/policy`, `agent_policy_overrides` —
      falls back to the space-wide row when absent) existed on the SpaceDO side since Phase O but
      was **builder-JWT-only with no `requireBusinessMembership` floor at all** — the exact gap
      `assistant-policy` itself had before item 79's fix. Same fix applied here (`GET`: member,
      `PATCH`: admin) + a router allowlist entry. New `AgentPolicyPanel` (expandable "Configure"
      control: autonomy toggle + the same `ApprovedActionsEditor`) is wired into both the
      Dashboard's "Agents in this space" panel and the Projects page's "Agents in this project"
      grid — the two places a user asked to be able to "change configs... on each tool" and
      "change about agents" and genuinely couldn't before.
    18 new tests (2320/2320 pass), `npx turbo run typecheck` clean (76 tasks), `naelao-agents`
    (bare `wrangler deploy`), `naelao-spaces`, `naelao-router`, and `apps/shell` all deployed;
    live-verified by fetching the exact deployed JS chunks and confirming the new "Always allow"/
    "Configure" strings are present, and by exercising the deployed agents-worker approval route
    directly with a minted internal token. **Not done this pass:** a full live click-through of
    the new per-agent/per-tool editors and the resume-continuation merge behavior with a real
    business-admin browser session (same Playwright/TLS-handshake limitation as prior UI passes —
    verified via unit tests against the real request contracts plus deployed-bundle content
    instead).
89. **Root-caused and fixed a real repeat-call-guard bug (the actual source of "the project
    creation request is still waiting for human approval, no further action can be taken" reported
    stuck) — plus confirmed two other suspected bugs from the same report were testing-harness
    artifacts, not product defects, and confirmed redeploys never reset builder/business/product
    data (deploys only replace worker CODE, never touch D1/DO storage).**
    - **The real bug, in `script-engine/loop.ts`'s within-run repeat-call guard.** `attemptedCalls`
      used to be a bare `Set<string>` marked BEFORE a call's outcome was known, and the guard's
      cached response for a repeat call hardcoded a generic success placeholder regardless of
      whether the original attempt actually succeeded, failed, or was itself still gated/parked.
      A model that retried a call already recorded as "attempted" (including one that had FAILED,
      or one still sitting in `deferred_approvals` waiting on a human) could be told it had already
      SUCCEEDED — a false-success report the model could act on as if the action had gone through.
      Fixed: `attemptedCalls` is now `Map<string, {ok, output?, error?}>`, populated only AFTER
      `runOnce()` resolves with the REAL outcome; the repeat-guard's synthesized `priorSteps` entry
      now correctly reports `ok: attempted.ok` and either the real cached `output` or the real
      cached `error` — never a fabricated success. The separate, pre-existing "still waiting on a
      human for this one" message for a call still sitting in `deferred_approvals` (checked BEFORE
      the repeat guard) is unaffected and remains correct — that message is what a user sees when
      an approval genuinely hasn't been resolved yet, which is expected behavior, not a bug.
    - **Two other suspected bugs from the same report, investigated to completion and found to be
      testing-harness artifacts of MY OWN manual reproduction, not real product defects** —
      confirmed by re-running the identical flow correctly and observing success both times:
      (1) a project created via a hand-rolled `/agent/run` curl call was invisible in project
      listings — because I passed `user_id` in the JSON body instead of as the
      `x-naelao-user-id` HEADER `getCallerIdentity()` actually reads, so `created_by` landed
      `null` and `SpaceDO.createProject`'s implicit-owner-membership insert
      (`if (!alreadyExisted && row && body.created_by)`) never fired — the real client (via
      `naelao-router`'s `proxyTo`) always sets this header correctly. (2) A resumed run's answer
      appeared lost — because my manual test never called the real `POST
      /spaces/:spaceId/sessions` (which mints its own server-side session id) before dispatching
      `/agent/run` against a self-chosen session id, so `writeAgentAnswerToSession`'s persist call
      404'd silently (caught by its own best-effort try/catch) — `apps/shell`'s real client
      always creates a session first (item 66), so this path is not reachable in production.
    - **Noted, NOT fixed this pass (real, minor, out of scope):** `SpaceDO.createProject` always
      returns HTTP 201 even when its `ON CONFLICT(space_id, name) DO NOTHING` silently no-ops on a
      name collision — a caller can't distinguish "created" from "already existed" from the
      response alone. Relatedly, the `alreadyExisted` check has no status filter, so an ARCHIVED
      project with the same name permanently blocks reuse of that name by a new project.
    - **Confirmed for the user: a worker redeploy (`wrangler deploy`) only replaces that worker's
      CODE — it never touches D1 or Durable Object storage.** Builder accounts, products,
      businesses, projects, threads, and all previously-built config UI (Dashboard tab, per-agent
      Configure panels from items 79/88) remain exactly where they were; there is no need to
      recreate a product or business after a deploy. The "not showing in approvals page" symptom
      specifically could not be reproduced from the backend in this session — every approval
      opened via direct API testing appeared and resolved correctly; if it recurs, the business
      and approximate time are needed to investigate further.
    Verified via the real unit test suite (rewrote
    `loop-multi-step-observation.test.ts`'s repeat-call case to assert against a real R2 `put()`
    call counter and the real cached output object, not placeholder text) — 2324/2324 tests pass,
    `npx turbo run typecheck` clean (76 tasks). `naelao-agents` deployed (bare `wrangler deploy`)
    and the fix live-verified via temporary forced-throw diagnostics in a prebuilt op (added,
    used to confirm root cause against production, then fully reverted before the final deploy —
    confirmed via `git diff --stat` showing no net change to that file).

90. **"Can't change assistant configs" root-caused to a one-word role check — and verifying the fix
    against production surfaced THREE more real bugs, including an infinite refetch loop that had
    been silently blanking the Dashboard. Plus the QClay-style composer dock and two real settings
    pages.**
    - **The reported bug.** `apps/shell`'s Dashboard gated every config control on
      `business?.role === "admin"` — an EXACT match. Whoever creates a business is inserted as
      `'owner'` (`workers/spaces/src/business-routes.ts`), and the backend ranks
      `owner(3) >= admin(2)` (`business-auth.ts`'s `ROLE_RANK`), so the server would have accepted
      every write the UI never offered: the creator of a business could not change their own
      assistant's autonomy, model, or approved actions. `spaces/[businessId]/page.tsx` had the
      same check written correctly (`=== "owner" || === "admin"`), which is how the two drifted.
      Fixed by extracting the ranked comparison into `apps/shell/src/lib/roles.ts`
      (`roleAtLeast`/`canManageSpaceSettings`, mirroring `ROLE_RANK`) and using it everywhere;
      `tests/unit/shell-role-gate.test.ts` asserts the UI predicate agrees with the REAL backend
      `resolveEndUserBusinessRole` for a business creator's actual stored row — verified to fail
      (3 of 7 cases) when the exact-match bug is reintroduced.
    - **Infinite refetch loop (found while verifying, pre-existing, worse than the reported bug).**
      Pages wrote `const creds = session ? {sessionToken, endUserId} : null` in the render body and
      listed `creds` in a data-loading effect's dependency array. That literal is a NEW object every
      render, so: the effect fires a batch of fetches → the first resolves and calls setState → the
      re-render mints a new `creds` → deps "changed" → React runs the cleanup, flipping the batch's
      `cancelled` flag and DISCARDING every result still in flight → a fresh batch starts. Forever.
      Visible damage: the Dashboard hammering the API in a loop, panels rendering "Couldn't read the
      capability list" / 0 members / 0 connectors even though those requests returned 200, and a
      "Loading…" that never cleared. Fixed with a memoised `useSessionCredentials()` hook
      (`auth-provider.tsx`), keyed on the primitive token/id.
      **Diagnostic technique worth keeping:** curl from the sandbox showed every endpoint 200 and
      fast, which looked like the server was fine and the client was lying. The decisive evidence
      came from running the SAME fetches *inside the real browser* via CF Browser Rendering's
      `/content` + `addScriptTag`, printing status+body into the DOM — that proved the requests
      succeeded in-browser and the STATE was being thrown away, which is what pointed at the deps
      array. Also note `waitUntil:"domcontentloaded"` + `addScriptTag` lets an injected script set
      localStorage *before* React hydrates and then click something afterwards, which
      `shell-screenshot.mjs`'s navigate-after-inject flow cannot do (navigation destroys the script
      context) — that's how the dock panels were screenshotted open.
    - **`getMe` was called with the active BUSINESS space.** `ProductUserDO` is one instance per
      (productId × endUserId), so `GET /spaces/:businessId/product-users/me` 404s
      (`{"error_code":"not_found"}`, confirmed live) — the credit balance read 0 forever inside any
      business, in both the Dashboard KPI and the sidebar footer. Now always the product root; the
      person is not per-business.
    - **`RevenueSummary` was typed with `orders`; the server sends `order_count`** — the Dashboard
      rendered a literal "undefined orders". Fixed the client type and both consumers (the business
      detail page had it too).
    - **New surfaces.** `/dashboard/assistant` — all FOUR real approval modes (`always_ask`,
      `gate_unless_listed`, `gate_listed`, `yolo`) described in terms of what actually happens; the
      dashboard tile only ever exposed two of them as unlabelled buttons. Plus the pre-approved
      action editor, model picker, channels, recurring work, capability counts. `/agents` was
      rebuilt (it listed `product.space_id` — the product ROOT, not the active business, a real bug
      — and claimed configuring an agent was "a builder capability", untrue since the per-agent
      policy routes gained a `requireBusinessMembership` floor) and now links to a new
      `/agents/[agentId]` page with that agent's own autonomy + allowlist, stating plainly when it's
      inheriting the space-wide policy rather than showing an empty form.
    - **Composer dock** (`components/ComposerDock.tsx` + `.dock-*` in `packages/ui`): the QClay
      reference layout — labelled model pill on the left, icon row, divider, member avatar stack on
      the right — with panels that expand ABOVE the input (model / connected apps / knowledge /
      tips / members) instead of cramped popovers, in Naelao's own tokens rather than the mockup's
      lime. It wraps the input as `children` so an open panel pushes the composer down as one unit,
      matching the reference. Replaces `ModelSelector`+`InputBarExtras` in `Chat.tsx` and adds a
      model picker to Home (`/new`), which had none. **Deliberately not built:** per-member
      online/last-active dots from the reference's collaborators panel — `business-members` carries
      role/status/joined_at and there is no end-user-reachable presence route, so those would be
      invented (same precedent as `credits_consumed: null`).
    2331/2331 tests pass (7 new), `npx turbo run typecheck` clean (76 tasks), `apps/shell` deployed
    to production and verified with real authenticated screenshots against a real `owner`-role
    business: config controls enabled, every previously-blank panel populated (26 scripts, 10
    skills, 8 connectors, 1 member), "Loading…" gone, and the model + tips dock panels rendering.
    **Test data left behind:** business "Dock UI Test"
    (`b3c12ae4-82c7-4803-b4a4-7f1a71d234f9`) under the live `launchpad` product, plus its disposable
    end user — harmless, same precedent as items 62-64/77, and deleting a business has no
    end-user-reachable route.

91. **"Ran 6 step(s) without reaching an answer (completed: project.create, project.create)" —
    reported live in autonomous mode, with a Try again button, on a run whose project HAD actually
    been created. Two real causes, both fixed; plus a second pass on the composer dock.**
    - **The model was never told it was on its final turn.** `runScriptLoop`'s step loop simply ran
      out: a model that keeps choosing `run` falls off the end and hits the exhaustion branch. New
      `Reasoner.decide({finalStep})` (payload field `final_step`, only present when true so an
      ordinary step's payload is byte-identical) + a `DECISION_INSTRUCTIONS` paragraph telling it to
      finish with `answer` and to report completed work. A `run` chosen ON that turn is **not
      executed** — there is no step left to report its result in, so running it would spend real
      side effects (money, an email, a created project) on an outcome nobody would ever be told
      about. This is the direct cause of the duplicate `project.create`: the loop burned its steps,
      surfaced an error, the user retried, and a second project was created.
    - **Exhaustion failed outright even when work had succeeded.** The prior code deliberately
      refused to return a raw tool payload as "the answer" — correct, since a receipt
      (`{written:true}`) and a real result (`{content:"..."}`) are not distinguishable — but it took
      that to mean the whole run must FAIL. Successful work reported as a failure is worse than no
      report, and it is what made the user retry. The third option it missed: ask the model once,
      restricted to a terminal decision (`finalStep:true`), for the summary it failed to write —
      same model, same observations, asked only to say what happened. Not guessing at a payload. If
      it still returns `run`, the honest exhaustion error stands; if the summary CALL ITSELF throws,
      that is caught and never becomes the error the user sees.
    - **Deliberately NOT changed:** `maxSteps ?? 6`. The deadline fix is the correctness fix; the
      step budget is a cost/capability tuning question on an account whose Workers AI free tier is
      ~65 agent runs/day, and raising it silently would increase per-message cost without being
      asked for.
    - **A pre-existing test asserted the reasoner is called at most `maxSteps` times.** The
      closing-summary call is a real, deliberate extra call, bounded at exactly one — assertion
      updated to `maxSteps + 1` with the reason stated, not loosened silently.
    - **Composer dock, second pass against the reference images.** The first pass rendered the panel
      as a separate floating card above a separate pill bar. In the reference the panel, the input
      and the toolbar are ONE continuous card — so opening a panel pushes the composer down as a
      single object rather than overlaying it. Restructured accordingly (`.composer-dock` is now the
      card and neutralises the nested `.input-container`'s own chrome); row chips, pill weight/
      casing, the joined 3-across tips strip, and the accent-ringed member stack with its corner
      overflow badge all follow the reference. Verified with live authenticated screenshots of both
      the model and tips panels on production.
    2336/2336 tests pass (5 new in `loop-multi-step-observation.test.ts`: the deadline flag is set
    only on the last step, a tool chosen on the deadline is not executed (proved with a real R2 put
    counter, not a substring guess), a model that summarises on the deadline yields a real answer
    instead of the error, a model that refuses still fails honestly, and a throwing summary attempt
    never becomes the reported error), `npx turbo run typecheck` clean (76 tasks), `naelao-agents`
    (bare `wrangler deploy`) and `apps/shell` both deployed.

92. **Four things shipped in one session: a durable "Continue" offer replacing retry-from-scratch,
    the ultra-cheap webdev-agency Whop template, the knowledge-base upload path (which had never
    once worked), and cross-project handoff. Then the assistant was given real situational
    awareness — it previously woke with no idea what had happened while it wasn't looking.**
    - **Retry created duplicate work — FIXED, and the first design was replaced on user
      direction.** A failed run offered "Try again", which mints a fresh run id and therefore a
      fresh action-ledger key, so every already-completed action ran a second time (the reported
      symptom: two identical projects). The first fix keyed the ledger on `(sessionId, goal)` with
      a 30-minute reuse window; the user interrupted the deploy and asked for something explicit
      instead — a retry dialog that stays in the chat, survives a refresh, and disappears only
      when answered. Reverted the heuristic and built that: a new `interrupted_runs` table
      (`NaelaoAgentDO`), `GET/POST /spaces/:id/sessions/:id/agent/interrupted`, and
      `InterruptedRunCard` in the shell. Continue re-enters under the **original** run id, so the
      ledger short-circuits what already succeeded. `LoopResult.steps_completed` was added and is
      attached at every exit path via one `finish()` closure so no exit is left uncheckpointed.
      **A real bug found live, not in tests:** the claim check used `rowsWritten !== 1`, but that
      counter measures rows touched for BILLING including index entries — the index contains
      `status`, so a single-row UPDATE reported 2, and Continue consumed the offer while reporting
      it had done nothing. Now `UPDATE ... RETURNING`. `handleResumeRun` had the same pattern and
      only worked by accident (no index there contains `status`); fixed too. **Never trust
      `rowsWritten` as a changed-row count.**
    - **Knowledge-base upload had never worked** (reported as a `Symbol.iterator` error).
      `packages/rag/src/embed.ts` declared Cloudflare's embedding response as
      `Array<{embedding: number[]}>`; the real shape is `{data: number[][], shape, pooling,
      usage}` — a flat array of arrays. Verified against the live API, not assumed. `embed.ts` had
      **zero test coverage**, which is why this survived. Two more layers were broken behind it:
      an empty search result was cached for an hour (so a fresh upload stayed invisible, and
      `cached: true` with 0 results reads as "ingestion is broken"), and the account had **zero
      Vectorize metadata indexes** — v2 requires one per filtered property or no filter ever
      matches. Created `space_id`/`project_id` on `naelao-kb-vectors` + `naelao-kb-prod`,
      `spaceId`/`userId` on `naelao-agent-memory`, `spaceId` on `naelao-agent-scripts`.
      **Metadata indexes only apply to vectors written after they exist** — anything ingested
      before must be re-uploaded. Verified live end to end: upload → indexed → search returns the
      real chunk (dense score 0.66).
    - **Webdev agency template** (`whop-webdev-agency`, `free_tier_eligible: true`).
      `WEBDEV_TIERS` is one const read by both storefront provisioning and quoting so prices can't
      drift: basic $10 / standard $20-100 / premium $120-150 / enterprise $250-550. Five seeded
      skills (`webdev-skills.ts`) — `quote-job` is deterministic keyword scoring that takes the
      HIGHEST matching tier and refuses a brief too thin to price; `outreach-draft` produces
      DRAFTS only, always with an opt-out, and a click-to-WhatsApp link the **prospect** opens
      (that is the Meta-policy opt-in — the agent never initiates). Two new agents
      (`launchpad-leadgen-v1` on a weekday cron with outreach gated,
      `launchpad-webdev-v1` on `brief.accepted`), four bootstrap projects, and a `first_contact`
      goal that tells the assistant to read the connected Whop account before proposing anything.
      Per the user's answers: email-first outreach in HITL batches, hard caps, STOP honoured.
    - **Cross-project handoff** (built now, fires once the $5 Workers Paid plan enables tiers
      2-4). `r2-workspace`'s write/delete call a new `ScriptEngineEnv.onWorkspaceChange`, which
      fires a `workspace.file_changed` event through the **existing** `event_triggers` machinery —
      no new trigger type. So a lead written in Lead Generation wakes the Development project's
      own agent. Wired **only when `projectId` is present**, so the Space Assistant's space-wide
      workspace doesn't fire on every file it touches. **A real contract bug caught live:** the
      first seeding attempt posted a nested `{action: {script_name, params}}` rule and was
      rejected — the create route wants those FLAT. The test had captured the body without
      asserting the contract, so it passed; it now asserts the real shape.
    - **Situational awareness (the session's last and largest piece).** The assistant is woken by
      a heartbeat, a cron, a channel message — and each arrived knowing only its goal. A project
      could stall for a week and it would report everything was fine, because nothing told it
      otherwise. New `classifyFailure` (`packages/events/src/failure-classification.ts`) splits
      failures into kinds that demand genuinely different responses: `quota_exhausted` (clears by
      itself — do NOT rebuild or retry in a loop, that burns the next window too),
      `budget_ceiling` (the owner's own setting — don't route around it), `context_overflow` and
      `step_exhaustion` (the agent's own to fix — narrower goals, lean on the journal),
      `rate_limited`, `model_unavailable`, `tool_error`, `unknown`. `agent_activity_log` gained
      `failure_kind`/`session_id`/`run_id`/`trigger_source` (SpaceDO migration v36 — plain
      `ALTER ADD COLUMN`, deliberately NOT a table rebuild: a failed wake-up IS a `run_failed`,
      so the `event_type` CHECK constraint is untouched). New `GET /agent-diagnostics` rolls it
      into one bounded summary (counts, why runs failed, per-project shape, resumable stalls with
      the ids to continue them, unread notifications) capped at 8 projects / 6 stalls. New
      `business-diagnostics` prebuilt gives the assistant that summary plus `failures` /
      `stalled_work` / `limits` drill-downs it calls only where the summary showed something
      wrong — summary-first is the whole design, since a brief that grows with the business stops
      being a brief. All four ops are read-only and in the guided-mode auto-approved list (gating
      them would mean asking permission before being allowed to discover anything is wrong).
      **Two background failures were invisible to everyone:** a heartbeat's response was discarded
      and its drain runs inside the DO, so a dead background loop left no trace anywhere; a
      scheduled job's `consecutive_failures` lives in D1 and is read only by the sweep itself.
      Both now record through `recordWakeFailure`, **awaited** — a promise left dangling after a
      Worker handler returns may never run, and dropping the only record of a dead loop is exactly
      what this exists to prevent. Scheduled and polled wake-ups carry a short brief when there is
      something to say and **nothing at all when there isn't** (a brief on every hourly tick would
      spend real tokens saying "everything is fine" on a ~65-run/day budget). Both assistant
      profiles gained "Knowing What Happened While You Weren't Looking" and "When You Run Out Of
      Room". **Two real bugs caught by writing the tests and by live verification:**
      `classifyFailure` returned `unknown` for its own kind names — which is exactly how the
      rollup re-reads a stored classification, so every piece of guidance derived from it was
      wrong; and `"no terminal action"` (the loop's own wording when a model spends its turns
      without choosing a terminal action) was landing in `unknown` rather than `step_exhaustion`,
      found by running a real agent against production and reading what it recorded.
    - **Live-verified against production**, not just tests: registered a disposable builder,
      created a real product, confirmed migration v36 applies cleanly on a real DO, ran a real
      agent run and confirmed `session_id`/`run_id`/`trigger_source` carry real values with
      `run_id` matching the API's own response, then drove a real failure and confirmed the
      rollup groups it with a real 0.5 error rate and the Continue card carries the classification
      and explanation. The assistant discovered and called `diagnostics.overview` on its own.
      Verification product deleted afterwards. **Note on small-model behaviour observed live:**
      llama-3.3-70b sometimes picks a neighbouring tool (it reached for `business_wallet.history`
      when asked about run counts) — it reported honestly that it couldn't get the answer rather
      than fabricating one, which is the right failure, but tool selection on this model is not
      reliable enough to assume a named script will be the one called.
    - **Still open, not silently dropped:** the WhatsApp channel setup the user asked for
      (channel machinery exists; needs number/credential wiring + setup UI); Whop store
      auto-provisioning on OAuth connect (the template instructs it, never executed against a real
      connected account); and behavioural proof of the template — no agent has run a full
      find→quote→build→deliver cycle, which needs a real Whop OAuth click and more than the
      ~65 runs/day budget allows. `/agent-diagnostics` is deliberately builder-only (it spans
      every thread in a business including other members'); a business owner reaches the same
      information by asking their assistant, which now actually works.
    2420/2420 tests pass (41 new across `failure-classification`, `agent-diagnostics-rollup`
    — driven through the REAL SpaceDO migrations — `business-diagnostics-prebuilt`,
    `wake-up-brief`, `interrupted-run-continue`, `webdev-agency-template`, `rag-embed-shape`,
    `cross-project-handoff`), `npx turbo run typecheck` clean (76 tasks). Deployed:
    `naelao-agents`, `naelao-spaces`, `naelao-provisioner`, `naelao-knowledge`, `apps/shell`.
    **Test businesses left under the live `launchpad` product** (harmless, no end-user-reachable
    delete route): "Dock UI Test", "Dashboard Test Co", "Dock Panels", "Pixel Studio",
    "Handoff Studio", "Handoff Verify", "Handoff Verify 2".
    **Security note carried forward:** the user pasted a Whop owner API key, client id and client
    secret in plaintext in chat. They were never used. Both should be treated as compromised and
    rotated in the Whop dashboard. The value labelled "client secret" is in `apik_...` format (an
    API-key shape, not an OAuth client secret), and a working `WHOP_OAUTH_CLIENT_SECRET` is
    already configured — do not overwrite a working credential without confirmation.

93. **Channels made real (they could not reply at all), Telegram added, the webdev store made
    deterministic, and a live end-to-end run that found two more bugs — plus an OpenClaw/Hermes
    gap analysis in `docs/COMPETITIVE_2026-08-05_openclaw_hermes.md`.**
    - **Reported bug: the Channels panel could not connect anything.** It listed connected channels
      and offered no way to add one — the only connect route was `POST /channels/:channel/connect`,
      builder-only and left out of the router's end-user allowlist. New `POST /spaces/:spaceId/
      assistant/channels` (same path as the existing GET, `action` in the body — a dynamic segment
      followed by a static suffix is the shape that has repeatedly corrupted this codebase's Hono
      route tables), gated by `requireEndUserBusinessMembership` at a NEW admin floor: changing how
      a business is reached from outside is not a plain member action. Owner outranks admin (the
      item 90 bug, avoided here rather than repeated). Returns the webhook URL, since connecting on
      our side is only half of it. New `ChannelConnect` component in the shell.
    - **Unreported and worse: NO channel could reply.** `/internal/notify` handled email and
      returned `delivered:false` for everything else, so a customer could message a business on
      Slack/Discord/WhatsApp, the agent would run and produce a real answer, and the reply never
      left the building. Slack, Discord, WhatsApp and Telegram now send for real, resolving the
      space's own bot token from the vault at send time (`CHANNEL_SEND_CREDENTIAL` — a DIFFERENT
      secret from the inbound-verification one). Slack's 200-with-`ok:false` is treated as the
      failure it is. New `CREDENTIALS_WORKER` binding on the notifications worker.
    - **Telegram** (`ChannelType` gained a 5th member): free, no business verification, no
      per-message billing, no 24-hour reply window — the opposite of WhatsApp on every axis that
      matters to a $0-budget business, and the top gap the OpenClaw/Hermes analysis identified.
      Auth is unlike every other adapter: Telegram does not sign payloads, it echoes back a secret
      token the owner chose at `setWebhook` time, so this is a shared bearer secret compared in
      constant time, not a signature. Keys on the CHAT id (a group reply must go to the
      conversation, not the sender) and dedupes on `chat:message_id` since message_id is only
      unique per chat. Signal/iMessage deliberately still absent — both need a phone number bound
      to a long-running local process, the single-operator assumption a multi-tenant platform
      cannot make.
    - **Whop store auto-provisioning** is now a deterministic `store-provision` skill rather than an
      instruction to improvise MCP calls. Observed live: a small model told to "create the four
      packages" reaches for a neighbouring tool, or creates two of four and reports success. The
      skill lists what exists first (so a retry finishes rather than duplicates), prices each tier
      at its FLOOR (a range cannot be one product price), and reports `store_ready:false` naming
      exactly which tier failed rather than calling a half-built store ready.
    - **Behavioural proof: run live on production, and the answer is honest — the skills cannot
      execute on the current plan.** Real signup → business → provisioning → agent runs. The
      structure is real (all four projects with correct agent bindings, the 7-prompt onboarding
      checklist, 15 skills seeded). But every seeded skill is a stored script needing a Tier-2 V8
      isolate, and `worker_loaders` is commented out in `workers/agents/wrangler.toml`. The live
      error is exact: *"Unable to execute quote-job due to unavailability of Tier 2: no
      worker_loaders binding configured in this environment."* **The find→quote→build→deliver
      cycle is blocked on the $5/mo CF Workers Paid plan, not on anything in the code.**
      Everything AROUND the skills verified working live: the approval gate, the failure
      classification (`step_exhaustion`, via the exact `"no terminal action"` mapping fixed the
      same day), the durable checkpoint (5 steps completed), Continue re-entering under the
      original run id, and the repeat-guard correctly reporting a cached FAILURE rather than a
      fabricated success.
    - **A real bug the live run found: `yolo` was downgraded for EVERY `product_end_user`,
      including a business's own owner.** `resolveAssistantApprovalPlan`'s
      `YOLO_SELF_AUTHORIZING_ROLES` is `{owner, admin}` — builder space roles — so a business owner
      who flipped their own business to autonomous still had every action gated, with nobody but
      themself to approve it. Correct when `product_end_user` meant "a customer of the business";
      wrong since Phase C made them its owner. Same class as items 79/90, one layer deeper. Fixed
      by resolving the caller's business role server-side (`resolveCallerBusinessRole`, one
      `/internal/business-role` lookup, only for end-user callers) and threading it as
      `x-naelao-business-role` through BOTH dispatch paths into the plan. A plain member is still
      downgraded; an unresolvable role fails soft to always_ask; a `viewer` is never promoted by a
      business role.
    - **Test businesses removed** — the seven from prior verification runs, plus this pass's own.
      "Test 1" and "Webdev" left alone (not mine to delete).
    2451/2451 tests pass (35 new: `channel-connect-business-gate`, `channel-outbound-delivery`,
    store-provision behaviour, the yolo/business-owner cases), `npx turbo run typecheck` clean (76
    tasks). Deployed: `naelao-agents`, `naelao-notifications`, `naelao-provisioner`,
    `naelao-spaces`, `apps/shell`.
    **Three stale test assertions fixed, all mine, none regressions:** telegram used as the
    "invalid channel" example in two places, and a notifications test asserting slack was
    unwired.

94. **Skill self-improvement (the last open gap from the OpenClaw/Hermes analysis) and a real
    connector directory are now BUILT.** Two independent pieces, both live-verified.
    - **The skill gap as previously written was slightly wrong, and the correction matters.**
      Outcomes WERE recorded and `script.find` WAS sorted by them. The real problem: `stability_score`
      is a LIFETIME ratio, which cannot express recency — 20 successes and 4 failures scores 0.83
      whether those failures are spread over a year or are the last four runs in a row. A skill that
      broke yesterday kept being offered as proven, kept being picked, and kept failing. New
      `script-engine/skill-health.ts` adds the recency layer: `ScriptMetadata.recent_outcomes`, a
      bounded (10) window carrying the ERROR of each failure, and `assessSkillHealth` →
      `unproven | proven | degrading | broken`. Three consumers: `script.find` demotes a failing
      skill (never hides it — an agent cannot repair what it can't see); the GATE refuses to
      auto-run one at L1 and routes it to L2/L3 repair carrying its own `last_error` as the
      `repairTarget.failureReason`; and the reasoner's candidate projection now includes the health
      record, with a `DECISION_INSTRUCTIONS` paragraph telling it to patch rather than re-run.
      **A real design bug caught by writing the test:** demoting a broken skill pushed it under
      `FIND_CONFIDENCE_FLOOR`, so the loop read "nothing relevant found" and went to L4 (write a
      NEW skill) instead of repairing the one it had. Fixed by splitting the score into
      `FindCandidate.relevance` (stability × similarity — what the GATE's floor tests, "is there a
      skill about this at all") and `confidence` (relevance × health — the sort key, "and can I
      trust it as it stands"). Health must never affect relevance.
    - **New `skill-manager` prebuilt** gives the agent agency over its own library, since the
      automatic half can't decide to fix a skill nobody is currently reaching for:
      `skill.health` (assessment naming what's broken/degrading/promotable), `skill.inspect`
      (real errors + patch history), `skill.rollback`, `skill.retire` (deletes the Vectorize
      embedding too — otherwise it stays findable-but-unresolvable), `skill.promote` (delegates to
      the already-existing `/skills/promote` route, which owns the template lookup + threshold —
      one gate, not two that drift). Reads auto-approved in guided mode; gating them would mean
      asking permission before being allowed to discover something is wrong. Both assistant profiles
      gained a "Your Own Skills" section.
    - **Connector directory (`connectors/directory.ts`): every app the platform can reach, not just
      the curated dozen.** `CONNECTOR_CATALOGUE` is ~12 hand-written rows; Composio + Pipedream
      broker ~3,500 apps between them and a user could reach none of them without someone editing a
      TypeScript file. **The thing that made this a real boundary rather than a missing screen was
      Composio's per-app Auth Config**, registered by hand in their dashboard
      (`auth_config_id_env`). Their `use_composio_managed_auth` (verified against their live API
      docs, `POST /api/v3.1/auth_configs`) lets Composio run the OAuth dance with ITS OWN app
      credentials and the config can be created over the API on first connect — so that env var is
      now an OVERRIDE for connectors where we want our own OAuth app, not a precondition.
      Pipedream never needed one; only the listing was missing. New `GET /connectors/directory`
      (KV-cached 1h, per-provider cursors merged into one opaque token, a provider that is down or
      unconfigured reported as such rather than silently contributing nothing), spaces-worker
      wrapper at member level, router allowlist entry, and a "Browse all apps" section in the
      shell's Connectors page. Directory ids are namespaced `{provider}:{slug}`; a curated
      connector always wins over a directory entry, **but only when it is actually `available`** —
      otherwise a `coming_soon` row would swallow a genuinely connectable app and turn it into a
      refusal (the same rule applied in both `resolveConnectTarget` and `curatedIdFor`).
    - **Live verification found three things reading the file would not have:** `hubspot` and
      `googleads` connect fine through managed auth (both flipped from `coming_soon` to
      `available`, each verified to produce a real Connect Link); `meta-ads` had the WRONG toolkit
      slug — `facebook_ads`, which Composio rejects as nonexistent, real one is `metaads`; and
      `agentmail` stays `coming_soon` for a real reason — Composio reports no managed credentials
      for that toolkit, so one-click connect genuinely cannot work until we register our own OAuth
      app. The catalogue's own `validateConnectorCatalogue` caught the flip (an available connector
      must declare operations) — a good validator doing its job. Full end-to-end proof on
      production: a real signed-up end user created a business, browsed the directory through the
      router (both providers live), and got real Connect Links for BOTH an app never in our
      catalogue (Asana) and one that had been permanently coming_soon (HubSpot). Test business
      soft-deleted afterwards. 2496/2496 tests pass (45 new), `npx turbo run typecheck` clean (76
      tasks), `naelao-agents`/`naelao-spaces`/`naelao-router`/`apps/shell` all deployed.
    - **Not done:** an actual OAuth click-through by a human (the Connect Links were generated and
      verified, not followed to consent); Pipedream's `/apps` response field names are still parsed
      defensively rather than confirmed against their published schema, same "confirm once real
      access exists" precedent as the rest of this file.

95. **Channel setup is now scan-to-connect: one Naelao app per channel + a pairing QR, replacing
    BYO-app-per-space.** Prompted by the OpenClaw comparison — their Web Gateway shows a QR you
    scan and you're done in 60 seconds, while ours asked a non-technical owner to open a developer
    console, create an app, find a signing secret, paste it, then copy a webhook URL back into the
    provider. Every step is somewhere they stop, and none of it was work they should ever have
    done: it existed only because the platform had no app of its own.
    - **`launchpad/channel-pairing.ts`**: a short-lived (15 min) single-use `cp_`+32-hex token
      (sized to fit Telegram's 64-char `start` payload, the tightest constraint any channel
      imposes) + per-channel URL builders. Telegram is a deep link whose start payload IS the
      token; Slack/Discord are ordinary OAuth install flows with the token as `state`; WhatsApp
      prefills a message the OWNER sends — that direction is load-bearing, since a person starting
      the conversation is what Meta's policy treats as opt-in, so it needs no application. Email
      is explicitly not pairable (AgentMail provisions it automatically) and says so rather than
      failing obscurely. Every channel degrades honestly to "isn't set up on this platform yet"
      and points at the BYO path.
    - **New `channel_pairings` table** (migration 0070). `channel_links` answers "does this space
      have Slack?", keyed by space; platform-app pairing needs the reverse — a message arrives at
      Naelao's OWN bot carrying only a Telegram chat id or Slack team id, with no space in the URL
      to look it up with. New `POST /channels/platform-inbound/:channel` (one per channel for the
      whole platform, not one per business) verifies against the PLATFORM secret, recognises a
      pairing message BEFORE treating it as conversation (otherwise the assistant would answer a
      raw token as though it were a customer's question), and resolves the business from the
      binding. `GET /channels/pair-callback/:channel` handles the Slack/Discord return, recording
      nothing unless the code exchange actually confirms a workspace/guild — Slack answers 200
      with `ok:false` on failure, so trusting the status alone would record an install that never
      happened. Both public at the router, same posture as the connector callback (the single-use
      token IS the auth).
    - **Outbound needed a matching fix**: a paired channel has no per-space token, so
      `sendChatMessage` now falls back to the platform one. Without it inbound would work and
      every reply would silently go nowhere — the exact bug class item 93 already fixed once.
    - **The QR encoder (`packages/ui/src/qr.ts`) is hand-written** (byte mode, ECC M, versions
      1-10, ~213 chars max; throws rather than truncating, since a QR encoding half a URL looks
      like it worked). **Two bugs in it are worth recording because both produced grids that
      looked perfect and decoded as nothing:** the format-info placement was bit-REVERSED (low
      bits belong at the TOP of column 8 and the RIGHT of row 8 — reversing it yields a valid
      format string for a DIFFERENT mask), and `rsGenerator` built the polynomial with its `x` and
      `α^i` terms swapped, producing the REVERSED generator. The second is the instructive one: a
      "the generator divides the result exactly" property test passed happily, because division by
      a reversed polynomial is still division. Only a real reference value catches it — the test
      now pins the published degree-10 and degree-7 generator coefficients. Correctness is proven
      by round-tripping through `jsqr` (the algorithm a phone runs) plus a codeword-level
      differential against `qrcode-generator`; both are devDependencies only. **A third trap
      worth remembering: at 1 pixel per module jsqr returns null on a perfectly valid code** —
      a detector measures finder-pattern run lengths and there is nothing to measure. That harness
      bug looks exactly like an encoder bug.
    - Shell UI: `ChannelConnect` now leads with the QR + plain-language steps (checked in tests to
      contain no mention of webhooks, signing secrets or API keys), with the old paste-a-secret
      flow collapsed under "Set up your own app instead".
    - **Live-verified end to end on production** by temporarily configuring a platform bot:
      pair → `/start <token>` bound a real `channel_pairings` row with the right space and
      `paired_by`; the next message from that chat routed to the business; the same token replayed
      from a different chat was refused; an unpaired stranger was refused; a wrong signature got
      401. Test rows and the temporary secrets were removed afterwards, so the platform is back to
      degrading honestly. 2532/2532 tests pass (36 new), `npx turbo run typecheck` clean (76
      tasks), `naelao-agents`/`naelao-router`/`naelao-notifications`/`apps/shell` deployed,
      migration 0070 applied to live D1.
    - **Not done — needs the operator, not code:** no platform app exists yet on any channel.
      Telegram is one BotFather conversation (`TELEGRAM_BOT_USERNAME` + `TELEGRAM_BOT_TOKEN` +
      a `TELEGRAM_WEBHOOK_SECRET` of your choosing, then one `setWebhook` call pointing at
      `/v1/channels/platform-inbound/telegram`) and is by far the highest-value one to do first.
      Slack and Discord each need an app registered with `/v1/channels/pair-callback/{channel}` as
      a redirect URI. WhatsApp needs a Meta Business number. Until each is configured the pair
      button reports honestly and the BYO path still works.

96. **Two reported gaps closed: the app directory stopped at one page, and WhatsApp had no QR.
    Also, a corrected read of how OpenClaw actually connects each channel.**
    - **Directory pagination was a UI gap, not a backend one.** `GET /connectors/directory` was
      already paging correctly (100 per provider per page, per-provider cursors merged into one
      opaque token, verified live across two pages). `apps/shell` fetched ONE page at `limit: 60`
      and stopped, which reads as "that's all there is" rather than "there are thousands". Added
      load-more with cursor carry-through, dedupe across pages (both providers can offer the same
      app, and a later page can repeat one the merge already emitted), and a shown-count so the
      number stops looking like a total.
    - **WhatsApp now runs on Twilio as well as Meta.** The "isn't set up on this platform yet"
      message was correct — no platform WhatsApp number existed — but unlike Telegram there is no
      two-minute fix: Meta's Cloud API needs a verified Business account. Twilio's sandbox needs
      neither, is free and instant, and is joined by scanning a QR with a prefilled message, which
      is the SAME shape `buildPairing` already produces. So `whatsapp` is now one channel with two
      transports, selected by which platform credentials exist (`TWILIO_ACCOUNT_SID` +
      `TWILIO_AUTH_TOKEN` + `TWILIO_WHATSAPP_NUMBER`, plus `TWILIO_WHATSAPP_JOIN_CODE` for the
      shared sandbox — a production sender needs no join code and leaves it unset). Twilio is
      preferred when both are configured.
      **Two mechanical differences, both load-bearing:** Twilio posts FORM-ENCODED, not JSON; and
      its signature (HMAC-SHA1, base64) covers the URL together with the sorted POST params — which
      cannot be read off the request in the worker, because naelao-router rewrites the path before
      forwarding. `SignatureInput` gained an optional `url`, reconstructed from `PUBLIC_AGENTS_URL`,
      and verification fails CLOSED when it's absent rather than skipping the check.
      **A real gap the Twilio path exposed in outbound:** `sendChatMessage`'s credential gate
      returned early for lacking `WHATSAPP_ACCESS_TOKEN`, so the Twilio branch could never have
      been reached — Twilio authenticates with an account SID + auth token, not one credential.
    - **OpenClaw's per-channel model, checked against their own docs — the comparison is not what
      it looks like.** Their WhatsApp is **Baileys**: a reverse-engineered WhatsApp Web client, QR
      scanned via Linked Devices, running as the operator's PERSONAL account with credentials in
      `~/.openclaw/auth/whatsapp/creds.json`. That is genuinely 60 seconds, and it is only possible
      because it assumes a single operator on their own machine — it needs a long-lived process
      (a DO holds an outbound connection ~15 min max), caps at WhatsApp's 4 linked devices, drops
      when the phone loses internet, and puts a real account at ban risk. For a multi-tenant
      platform holding customers' accounts that is a bad trade, which is why this went to Twilio
      instead. **For every OTHER channel our model is already the easier one**: OpenClaw asks the
      user for a BotFather token (Telegram), a developer-portal bot token plus Message Content
      Intent (Discord), and TWO tokens with Socket Mode and event subscriptions (Slack). We ask for
      none of those — platform app plus a deep link or an OAuth install.
    - **Live-verified on production** by temporarily configuring a Twilio sandbox: WhatsApp pairing
      returned a real `wa.me/...?text=join%20<code>%20cp_...` link, a correctly-signed form-encoded
      inbound paired the chat, and a bogus signature got 401. Test rows and temporary secrets
      removed afterwards. **Worth remembering: CF Worker secrets propagate across isolates
      unevenly for a minute or two** — during that window the same request alternates between the
      new behaviour and `channel_not_configured`, which looks exactly like a signature-verification
      hole and is not. 2538/2538 tests pass (6 new), `npx turbo run typecheck` clean (76 tasks),
      `naelao-agents`/`naelao-notifications`/`apps/shell` deployed.
    - **Still operator work, not code:** no platform app exists on any channel. Telegram remains
      the cheapest first move (one BotFather conversation). For WhatsApp, a Twilio account +
      sandbox is now the fast path; `TWILIO_WHATSAPP_JOIN_CODE` is the sandbox's own code and the
      webhook must point at `${PUBLIC_AGENTS_URL}/channels/platform-inbound/whatsapp` — NOT the
      router, since the router rewrites the path and the signature covers the URL.

97. **The agent loop is no longer capped at six steps — it now runs as long as the task honestly
    needs, bounded by real resources instead of an arbitrary count. Researched against OpenClaw
    first, then built both halves, because raising the cap alone would have made things worse.**
    - **The finding.** OpenClaw (deepwiki + its docs) has NO step cap: its loop runs until the model
      stops requesting tools, with *preflight compaction* against the model's token budget before
      every turn and automatic compaction-on-overflow as recovery. Ours was
      `for (step = 0; step < (opts.maxSteps ?? 6); step++)` and the interactive chat path never
      overrode that six — so every message a user sent got six turns, whatever they asked for.
    - **Why raising the number alone would have been worse.** `steps_so_far` grew unbounded in the
      reasoner payload at ~500 tokens per observation, and this platform's default model is served
      with a REAL 24k window (`@cf/meta/llama-3.3-70b-instruct-fp8-fast` — the account's own model
      API, against a nominal 128k). A bare cap raise moves the failure from "gave up at six" to
      "overflowed the context around step twenty-five and every call failed", which is strictly
      worse for being opaque.
    - **New `script-engine/step-context.ts`** folds the older half of a run's own history into one
      line per step — what ran, with what arguments, how it went — sized from the resolved model's
      real window. Deliberately DETERMINISTIC, not model-written (OpenClaw asks a model to
      summarise): an extra LLM round-trip on every long run costs real money on a ~65-run/day free
      allowance, and a summariser outage would silently lose the record of work that happened. What
      a model needs from an old step is structural and can be rendered exactly, for free, with no
      way for a hallucinated summary to claim a failed action succeeded. Arguments are kept, not
      just names — "project.create ran" doesn't stop a repeat, "it created *that* project" does.
      Truncation happens in a COPY: the original array backs resume checkpoints and deferred
      approvals, which need the real values.
    - **New `script-engine/loop-budget.ts`** replaces the step count with what is actually scarce:
      a real token ceiling (from the provider's own usage counts), a wall clock (a person is
      waiting), stall detection (a model failing the same way six times will fail a seventh), and a
      50-step runaway ceiling that should never be what fires. The load-bearing part is `final`:
      one turn before any budget runs out the model is TOLD, and answers with what it has —
      without that, hitting a budget is indistinguishable from failing, which is exactly how a run
      that had genuinely created a project came to be reported as an error (item 91).
      The deadline margin is sized from the slowest step observed, not a fixed guess.
    - **Context-overflow recovery**: a provider overflow error is now distinguished from every
      other failure (`isContextOverflowError`, matched on message text since no shared error code
      exists across Anthropic/OpenAI-compatible/Workers AI), halves the history budget and retries,
      up to twice. It used to be a dead-end `give_up`.
    - **Sub-agents un-throttled too**: `budgetToMaxSteps` capped at 10, so a child on the default
      20k token budget hit a step ceiling long before spending its allowance — a sub-agent strictly
      less capable than its parent, for no reason anyone chose. Now 3-40, with tokens binding.
    - **Two further real bugs, both found by a LIVE run rather than by review** (trace fetched from
      production, not reasoned about):
      (1) An agent whose only tool was gated parked one approval, spent its stall budget re-picking
      the same blocked action, and — because no tool had ever *succeeded* — skipped the closing
      summary entirely and returned "no terminal action". The user saw a dead end when the truth
      was "I need you to approve list_files". The summary path is now gated on "did anything happen
      at all", not "did a tool succeed", and the error message leads with what is waiting.
      (2) `list_files`/`read_file` — pure reads of the business's OWN storage — were not in the
      guided-mode auto-approved defaults, so the assistant could not take a single step without a
      human. Added, same "safe by construction" rationale as item 86's web-search fix.
      NOTE: that list is snapshotted into each space's stored `assistant_policy` at provision time,
      so this only helps NEWLY created businesses; an existing one needs its owner to approve once
      or flip to Autonomous.
    - **Live-verified on production, not just in tests.** A read-only audit goal ran **11 reasoning
      turns in one run** (old cap: 6 total), executed 5 tool calls, self-corrected a wrong op name
      (`mcp.list_servers` → `list_servers`), parked 4 approvals and carried on around each, and
      composed an accurate final answer. Full trace read back from the live `run_traces` endpoint.
      The blocked-on-approval fix was separately confirmed live: the same goal that previously
      dead-ended now answers *"the list_files operation is still waiting for human approval."*
      Test approvals were rejected afterwards so the owner's inbox was left clean.
    - **Where we now beat OpenClaw**, beyond parity: durable approvals that suspend a run and
      resume it 24h later; an action ledger that short-circuits already-completed work on a retry;
      stall detection and a deadline (they document neither); and an honest exhaustion message that
      names *why* it stopped rather than only that it did.
    2608/2608 tests pass (30 new in `agent-loop-unbounded.test.ts`), `npx turbo run typecheck` clean
    (76 tasks), `naelao-agents` deployed via bare `wrangler deploy` (item 83's documented trap).

98. **The assistant had never once been told who it was, `/new` silently dropped the user's first
    message, and a completed run 404'd on its own status poll. All three reported by the user, all
    three root-caused against live behaviour rather than guessed at.**
    - **The agent's own system prompt reached the model in no run, ever.** `loadAgentConfig` read
      `system-prompt.md` from R2 on every call and used it only to parse approval gates;
      `GatewayReasoner` hardcoded `system: DECISION_INSTRUCTIONS`. Every word of
      `LAUNCHPAD_ASSISTANT_PROFILE` — the business-building methodology, the wallet rules, "read the
      project journal first" — written, stored, never delivered. Asked what business it ran, the
      assistant said "that information is not provided in the given context", which was true.
      New `ReasonerDeps.agentPrompt` + `composeSystemPrompt` (identity, protocol, then a one-line
      identity anchor — recency wins on small models), wired at both reasoner sites.
      **That alone was not enough, and the reason is worth keeping.** A direct gateway call proved
      llama-3.3 follows a plain system prompt correctly, yet the SAME identity inside the real
      request still produced "I am an AI assistant, and I am not running a business for you" — the
      real request also carries a 4.3k-char protocol and five tool schemas, and `tool_choice:
      "required"` pulls attention onto the machinery. Fixed by ALSO carrying a bounded
      `who_you_are` digest in the payload the model is answering about. Verified live: it now
      answers "I am the Naelao Agent, a business-builder Space Assistant for your Launchpad
      Space…". Diagnostic worth reusing: when a prompt "should" work, test the model in isolation
      first — it separates delivery from attention in one call.
    - **`/new` created a session and nothing happened.** Home passes the opening line as `?q=`; the
      session page stripped `q` from the URL on mount, Next syncs that `replaceState` back into
      `useSearchParams`, and Chat cannot send until its history has loaded a beat later — so the
      message was retracted before the surface was ready for it. Reproduced exactly in a real
      browser: `POST /sessions` 201, then **no `POST /agent/run` at all**, 0 messages. Fixed by
      latching `q` on first render (`useState` initialiser) plus a second latch inside Chat, so
      whoever hands the message over, the first non-empty value wins and cannot be withdrawn.
    - **"API error 404 when I click Continue."** `handleContinueInterruptedRun` runs the
      continuation synchronously to completion and returns the answer — but the client then polls
      `GET /runs/:runId`, and a script-native run writes no `agent_runs` row while a run dispatched
      straight into the DO has no TaskDO task, so the entry was deleted the instant it finished and
      the run existed nowhere. A run that had SUCCEEDED was reported as not existing. `liveRuns`
      entries now carry a terminal state and linger 10 minutes (TTL + a 50-entry cap, unresolved
      runs never pruned); suspended runs are retained too, so polling one says "awaiting approval"
      instead of 404. A pre-existing test asserted the 404 — it was pinning the bug, and now
      asserts the answer.
    - **Malformed decisions silently burned a turn.** Workers AI models emit
      `{"type":"function","name":"run","parameters":{…}}` — valid JSON with no `action` field.
      `extractJson` parsed it happily, the loop matched no branch, and simply took another step:
      no error, no signal to the model, and enough of them in a row ends as "without reaching an
      answer (completed: none)". New `coerceDecision` accepts the real shape and the near-misses
      these models actually produce, treats unrecognised prose as an answer, and the loop now
      reports an unusable decision back to the model and counts it against the stall budget.
    - **Edit and re-ask** on the last message you sent (scoped to the last one deliberately —
      editing further back would have to discard every exchange after it).
    - **New `infra/scripts/shell-interact.mjs`**: drives the real shell in a real browser, typing
      through React's own native value setter and dispatching real key events, with an injected
      fetch probe that reports every API call and status back through the rendered DOM. That probe
      is what found the `/new` bug — the symptom was "nothing happens", and only the absent
      `POST /agent/run` identified it. Playwright is genuinely unusable here: Chromium cannot
      complete TLS through the sandbox proxy with `--proxy-server`, Playwright's own `proxy`
      option, or `--disable-http2` (all tried); CF Browser Rendering runs Chrome inside
      Cloudflare's network instead. Its cap is ~60s total, and it caches — bust with a query param.
    2619/2619 tests pass (11 new), `npx turbo run typecheck` clean (76 tasks), `naelao-agents` and
    `apps/shell` deployed and verified live end to end in a browser.

99. **Naelao Agent Templates switcher (item 68's own feature) was hidden in the single most common
    case — FIXED.** Reported live: "I'm in a project thread, I don't see the switcher." Root
    cause: `Chat.tsx` only populated `agentOptions` — and the dock only rendered its button at
    all — when a project already had 2+ agents explicitly bound
    (`project.allowed_agent_ids.length >= 2`). Every ordinary project (the default "General"
    project every business gets, or any project nobody has visited the Agents page for yet) has
    ZERO agents explicitly bound and is implicitly answered by the Space Assistant — so the
    switcher this feature exists to provide was invisible for the overwhelming majority of real
    project threads, including the one the report came from. Confirmed live (curled the deployed
    `naelao-agents` worker's real `/agent-templates` route — the backend was never in question).
    Fixed by removing the precondition rather than lowering it: the dock button now shows in
    EVERY project thread (gated on `projectId` alone, matching "not in an assistant session"
    exactly as before); when nothing is explicitly bound, `agentOptions` carries one synthetic
    `"Space Assistant (default)"` entry (id `""`, both `ComposerDock`'s active-check and
    `Chat.tsx`'s `onAgentChange` treat it as "clear the override") so the panel always shows
    something rather than nothing; and the FULL template catalogue is now offered inline in the
    same panel with an "Add & use" button per template (`instantiateAgentTemplate(..., {project_id})`
    then an immediate `refreshAgentBindings()` + auto-select) — closing the actual gap, which
    wasn't just visibility but that reaching a template previously needed a separate trip to the
    Agents page and then the Projects page before a thread's own switcher had anything to switch
    to. No backend change — `GET /spaces/:id/agent-templates` and `POST
    /spaces/:id/agent-templates` (instantiate) already existed and were already correct; this was
    entirely a frontend gating bug in `Chat.tsx`/`ComposerDock.tsx`. 2619/2619 tests pass (no
    regressions — this path had no prior unit coverage, frontend-only), `npx turbo run typecheck`
    clean (76 tasks), `apps/shell` rebuilt and deployed to production, verified by grepping the
    exact deployed bundle for the new "Add a template to this project" string before and after
    upload.

100. **Model Benchmarks + Effort — the "picked a cheap model, then it silently called an
    expensive one to get help" problem is now closed, with real cost-tier/eval data on the
    Discover page.** Two new `packages/billing-core` modules:
    - `model-benchmarks.ts`: a `ModelBenchmark` per `ALLOWED_MODELS` entry — `costTier`
      (economy/standard/premium), honestly labeled `costBasis` ("measured" only for the 3 Claude
      ids + llama-3.3-70b, which have real per-token/derived-neuron pricing; "estimated" for
      everything else, sourced from published parameter counts, never a fabricated $ figure), and
      real `eval` numbers for the 7 models actually run through `docs/MODEL_EVAL_2026-07-25.md`'s
      own harness — deliberately NOT a generic external leaderboard (LMSYS/Artificial Analysis
      considered and rejected: neither scores against THIS platform's own agent-loop tool-calling
      contract, which is the axis that actually matters here, per that eval doc's own "score and
      reliability are not the same axis" finding). Rendered on the shell's Discover page as a new
      "Model benchmarks" section (6 shown, "show all 16" expands), each card showing cost tier,
      the model's own eval note when we have one, honest `bestFor` prose otherwise.
    - `effort.ts`: `EffortLevel = "low"|"medium"|"high"|"ultra"`. Every model gets at least
      low/medium (the escalation-budget distinction is real even for a model with no native
      reasoning mode); higher tiers appear only as deep as the model's own `reasoningLevels`
      ladder goes (0 native → 2 effort levels, 2 native → 3, 3+ native → 4) — "based on the
      model," per the ask, not a fixed set. `nativeReasoningForEffort` derives the model's own
      wire-level reasoning param from the chosen Effort (saturating at the model's own max once
      Effort outpaces it), so Effort supersedes — not duplicates — the old standalone reasoning-
      level control. `escalationCeiling(currentModel, effort)`: low pins delegation to the single
      cheapest curated model regardless of the current model's own cost; medium allows one tier
      up; high near-top; ultra removes the ceiling. `resolveEscalationModel(currentModel, effort,
      {preferModel?})` is the actual enforcement primitive — with no preference, picks the best
      affordable model (tiebreaking toward `DEFAULT_WORKING_MODEL` among same-rank candidates,
      not raw `ALLOWED_MODELS` array order, since that array lists Claude ids first and Claude
      isn't reachable on every deployment — a real bug caught by the escalation test itself); with
      a preference that exceeds the ceiling, clamps to the best affordable model and returns an
      honest `{downgraded: true, reason}` — never silently runs the expensive model, never a hard
      refusal either, exactly the "get an error message and move down to cheaper" behavior asked
      for.
    - **Enforcement point**: `NaelaoAgentDO.spawnSubAgentBatch` (the real `agent.spawn` dispatch
      path) now resolves EVERY child task's model through `resolveEscalationModel` before ever
      constructing the child's request — a task's own `model` field is no longer passed through
      verbatim. The resolution happens ONCE per batch (every task in one `agent.spawn` call shares
      the parent's Effort setting) and a downgrade is reported back on that task's own result
      (`model_used`, `effort_downgraded`, `effort_downgrade_reason`) rather than swallowed.
    - **Wire path**: `/agent/run` accepts a new `effort` field (parallel to the existing
      `reasoning_effort`), validated the same way (rejected outright if the resolved model doesn't
      offer it), defaulting to the business's own stored `productConfig.modelConfig.effort` and
      finally to `"low"` — threaded through all three dispatch paths (sync, async Workflow,
      `/internal/tasks/:taskId/run`) into `NaelaoAgentDO.handleScriptRun`'s `body.effort`, then
      into `buildOrchestrationHooks`'s new `currentModel`/`effort` params.
    - **Settings**: `PATCH /spaces/:spaceId/model-config` (and the builder dashboard's
      `PATCH /builder/products/:id`) now accept `effort` alongside `model`, validated identically,
      stored in the same `productConfig.modelConfig` config_json override (no new table). Added an
      Effort picker to all three existing model-config UIs (`dashboard/assistant`,
      `dashboard/page.tsx`'s compact overview panel, and `settings/page.tsx`'s AI & Models
      section) — each mirroring that surface's own existing Model-picker pattern rather than a
      new one-off. `shell/manifest` projects the business's stored `effort` for the shell to read
      (not yet consumed by the shell's own initial-state resolution, which already defaults to the
      same "low" value — a real, deliberately deferred refinement, noted inline).
    - **ComposerDock UI**: an "Effort" dock button sits next to the "Model" button, showing the
      current level's own name as its label (e.g. "Low") rather than the word "Effort," per the
      ask. Clicking it opens a `"[Model Name] Effort"` panel — a horizontal segmented picker
      (Claude-Code-slider style) with each option's description shown below, and a back-arrow that
      returns to the Models panel (also reachable via a new "Effort →" row inside the Models panel
      itself, so drilling in from either direction lands in the same place). Selecting a level
      commits, navigates back to the Models panel, and the dock's Effort button immediately shows
      the new level. The old per-model "Reasoning effort" pill row (item 83's standalone control)
      was removed from the Models panel — Effort now owns that, deriving the native param
      automatically.
    - **A real deploy-time bug, not caught by the test suite, found and fixed while shipping
      this**: `effort.ts` computed `MAX_COST_RANK = Math.max(...ALLOWED_MODELS.map(...))` at
      module top level, importing `ALLOWED_MODELS` back from `index.ts` — which itself re-exports
      `effort.ts`, a genuine circular module dependency. The local `tsc`-compiled `dist/` +
      vitest run resolved the cycle fine (live ESM bindings), but a REAL `wrangler deploy` failed
      outright: `Cannot read properties of undefined (reading 'map')` — esbuild's bundling
      resolved the same cycle differently, leaving `ALLOWED_MODELS` undefined at the moment
      `effort.ts`'s top-level code ran. Fixed at the root, not by reordering exports again (the
      first attempted fix): extracted `ALLOWED_MODELS`/`MODEL_CAPABILITIES`/`capabilityForModel`/
      etc. into a new dependency-free leaf module, `models.ts` — `model-benchmarks.ts` and
      `effort.ts` now import directly from `models.ts`, never from `index.ts`, so there is no
      cycle for a bundler to resolve differently in the first place. A worthwhile general lesson
      for this codebase: a passing local test suite does NOT prove a module graph is safe to
      deploy when re-exports create a cycle — the only way this was actually caught was running a
      real `wrangler deploy`.
    2651/2651 tests pass (32 new: `model-benchmarks-and-effort.test.ts`'s 21 pure-function cases,
    `sub-agent-effort-escalation.test.ts`'s 4 end-to-end DO-level cases proving the escalation
    ceiling is enforced BEFORE a child is dispatched — not after — plus 9 new `/agent/run` and
    `PATCH .../model-config` cases in `model-switcher-config-resolution.test.ts`), `npx turbo run
    typecheck` clean (76 tasks). `naelao-agents` (bare `wrangler deploy`, item 83's documented
    trap) and `naelao-spaces` both redeployed; `apps/shell` rebuilt and redeployed to production.
    Live-verified against the real deployed `naelao-agents` worker with a minted internal token
    against the live `launchpad` product: `effort: "ultra"` against a business still on
    llama-3.3-70b (which only offers low/medium) returned a real
    `400 {"message":"effort 'ultra' is not offered by model '@cf/meta/llama-3.3-70b-instruct-fp8-fast'"}`
    — the validation chain is genuinely live, not just passing in tests. **Not done this pass:**
    a live browser click-through of the new dock Effort panel (same Playwright/TLS-handshake
    limitation as every prior UI pass — verified via the deployed bundle's content instead); the
    shell reading a business's stored `effort` default into its own initial state (documented
    inline as deferred); per-project/per-agent effort overrides (only the business-wide default
    and the client-side per-(space,model) chat preference exist — a project-level or per-agent-
    template effort setting would be a real, separate follow-up).

101. **Dashboard: the mockup's Analytics page (`apps/launchpad/src/index.html`'s `#analytics-view`
     — KPI cards, a 7/30/90-day credit-usage bar chart, per-agent usage table) is now EMBEDDED
     into `apps/shell`'s `/dashboard` overview, not just linked to from it.** The real dedicated
     `/analytics` page (item 73) already existed and already reads the real
     `GET /business-analytics` rollup — this pass reuses that SAME endpoint and adds a compact
     "Analytics" section directly on the Dashboard: 4 KPI cards (credits used w/ vs-prior-period
     delta, agent runs, success rate, tokens used), a mini 7/30/90-day credit bar chart, a
     "Background activity" panel (heartbeat wake-ups that did real work vs failed, Projects/
     Threads counts), and a top-5 per-agent usage table — fetched on its own effect (keyed on the
     window toggle) so switching 7d/30d/90d doesn't re-trigger the whole page's other panels or
     their loading flag. A "Full page →" link stays for the complete `/analytics` view (structure
     breakdown, full per-agent table). Also, small dashboard polish in the same pass: the KPI
     `Stat` tiles for "Waiting on you" (when non-zero), "Members", and "Connected apps" are now
     real links to `/approvals`, the business management page, and `/connectors` respectively —
     previously plain non-interactive numbers with nowhere to go. No backend changes — pure
     frontend reuse of an already-tested, already-gated endpoint. 2651/2651 tests pass (frontend-
     only change, no new backend surface), `npx turbo run typecheck` clean, `apps/shell` rebuilt
     and deployed to `naelao-shell.pages.dev` production, live-verified by fetching the exact
     deployed `/dashboard` page chunk and confirming it byte-matches the local build's new
     strings ("Background activity", "Wake-ups that did real work", "Full page", "Waiting on
     you").

102. **Dashboard heartbeat detail + a portfolio leaderboard/summary on Discover + template-grid
     icon polish — user-directed UI batch, no backend changes.** Dashboard's embedded Analytics
     section (item 101) buried heartbeat pass/fail and structure counts inside a small
     settings-block text row; pulled them into real stat tiles (Projects, Threads, Heartbeats —
     did work, Heartbeats — failed, with a computed failure %) plus a new "Failures by trigger"
     breakdown table (`heartbeats.by_trigger`, already returned by `GET /business-analytics` but
     never rendered — only shown when at least one trigger has actually failed, never an all-green
     row of noise). Discover page: a new "Top businesses" leaderboard ranks the SIGNED-IN USER'S
     OWN businesses only (never cross-tenant — that would be a real privacy violation, unlike the
     pre-existing anonymized "what other businesses are doing" showcase) by this-month revenue
     (`GET /revenue`) then 30-day credits as a tiebreak (`GET /business-analytics`), each business
     fetched independently via `Promise.allSettled` so one endpoint erroring never blanks the
     whole list; only renders as a ranked list at 2+ active businesses (a "leaderboard" of one is
     nothing to compare against), but the same fetch also powers a new portfolio KPI row
     (businesses / needs-setup / this month's total revenue / 30-day agent runs) shown for any
     nonzero business count. Both the "Start a business" cards and the create-business/new-project/
     add-agent-from-template grid dialogs (all pre-existing `.app-grid`/`.app-card` UI from earlier
     passes — items 65/67/80 already built these as grids, not new this pass) gained the same
     colored initial-letter icon header (`app-card-header`/`app-card-initial`) the connectors page
     already established, for visual consistency across every template picker in the shell.
     `apps/shell` rebuilt via `next-on-pages` (`NEXT_PUBLIC_API_URL` set in the same command per
     the documented gotcha) and deployed to `naelao-shell.pages.dev` production (`--branch=main`);
     verified by grepping the exact compiled edge-function files for each touched route
     (`spaces.func.js`, `dashboard.func.js`, `projects/all.func.js`) for the new strings/classes
     before and confirming all three live routes return 200. `npx turbo run typecheck` clean (76
     tasks). No backend/worker changes this pass — every number rendered was already served by
     existing, previously-tested endpoints (`GET /business-analytics`, `GET /revenue`).

103. **Self-directed loop stopping (real-time progress visibility), a real project-thread/session
     conflation bug fixed, and automatic request-retry-with-visible-feedback — three
     user-reported items, all BUILT.**
     - **The loop previously told the model it was almost out of budget only via `final_step`, on
       the very last possible turn — it had NO visibility into its own progress before that.** A
       model that kept failing had no way to notice and stop itself; the only way a run ever ended
       early was being cut off externally with a generic, unhelpful message. New
       `Reasoner.decide()` `progress` field (`script-engine/loop.ts`) — step / max_steps (the
       runaway ceiling, explicitly NOT a target), successful_actions, failed_actions, stall_steps /
       max_stall_steps, tokens_used / max_tokens — computed fresh and passed on EVERY L3/L4 turn,
       not just the final one. `DECISION_INSTRUCTIONS` (`reasoner.ts`) now tells the model
       explicitly: use this to judge whether you're converging; if failed actions are climbing or
       the stall streak is closing in on its limit with nothing to show, `give_up` on your OWN
       initiative, right now, with a SPECIFIC explanation of what you tried and why it didn't work
       — don't wait to be cut off. This is additive to the existing `final_step` mechanism (item 91
       in the appendix numbering / CLAUDE.md's own step-budget work), not a replacement — an
       externally-forced stop still happens if the model doesn't act on the signal itself. 2 new
       tests in `agent-loop-unbounded.test.ts`: progress is reported correctly turn-by-turn (not
       just once), and a model that sees 2 failed attempts stops itself after 3 turns total with a
       real reason — nowhere near the 50-step ceiling, proving the stop was self-directed, not
       externally forced.
     - **Reported live: a thread created and chatted in inside a project also appeared in the flat
       Sessions sidebar, as if it were a separate, unrelated conversation — and the thread then
       seemed to "disappear" from the project.** Root cause, confirmed by reading the code rather
       than guessed: `Chat.tsx`'s lazy session creation (`ensureSessionId`) called `startSession()`
       with NO link back to the thread it belonged to, so the resulting session was
       indistinguishable from an ordinary Home/assistant conversation — and SpaceDO's
       `listSessions()` had no way to exclude it, since `threads.session_id` (added in an earlier
       pass, §A1.18 thread model) was only ever populated by the assistant's own consult-subthread
       flow, never by the ordinary "open a project thread and chat" path any real user actually
       takes. Fixed end to end: `POST /sessions` now accepts an optional `thread_id`
       (`SpaceDO.createSession`), linking `threads.session_id` at creation time (`AND session_id IS
       NULL` guard — never clobbers an existing link, never fails session creation if the thread
       lookup fails); `listSessions` now excludes `id IN (SELECT session_id FROM threads WHERE
       session_id IS NOT NULL)` on both the space-wide and end-user-scoped branches.
       `apps/shell`'s `startSession()`/`Chat.tsx`'s `ensureSessionId` thread the prop through.
       `ProjectThreadPage` now waits for the thread to load before mounting `Chat` (previously
       rendered immediately with no `session_id` known yet, which meant a thread with an ALREADY-
       linked session — reopened later, or from a different tab — got a second, unlinked session
       minted every time instead of reusing the real one) and passes `sessionId={thread.session_id}`
       when one already exists, bypassing Chat's client-side cache in favor of the real server link.
       Also added a defensive `window.addEventListener("focus", refresh)` to both the project page's
       thread list and the Sessions page (regaining focus/tab-switch re-fetches, so neither list can
       read as stale after time away) — a safety net for the "disappeared" half of the report, since
       no concrete backend bug was found there beyond the conflation itself. 5 new tests in
       `spacedo-threads.test.ts`: link-on-create, exclusion from both list variants, "never
       clobbers an existing link", "a nonexistent thread_id doesn't fail session creation".
     - **Automatic retry with visible feedback on a transient request failure**
       (`apps/shell/src/lib/api.ts`'s `apiFetch`), mirroring Claude Code CLI's own "retrying…
       (attempt x/10)" convention rather than the prior behavior of surfacing an immediate,
       possibly spurious error on any network blip or momentary 5xx. Retries ONLY a network-level
       throw (offline, DNS, connection reset — the request almost certainly never reached the
       server) or a 5xx/429 response, up to 10 attempts with a capped linear backoff
       (400ms→3000ms); a 4xx is never retried, since a bad request/expired session/insufficient-
       credit refusal will fail exactly the same way every time and retrying it ten times only
       delays a real error the user needs to see now. `onRetry(attempt, max)` threaded through
       `sendMessage` and `pollRun` (the two calls in the hot path of sending a message and watching
       for a reply) into a new `Chat.tsx` `retryStatus` state, rendered as "Request failed,
       retrying (x/10)…" in place of the ordinary typing/activity indicator while it's happening.
       The polling loop also gained an `inFlight` guard (a retry sequence inside one tick's
       `pollRun` call can genuinely outlast `POLL_INTERVAL_MS`, and without this a struggling
       backend would get a NEW, independently-retrying poll layered on every 1.5s on top of ones
       still winding down — a self-inflicted thundering herd against the very thing already having
       trouble). No dedicated vitest coverage for this file — consistent with this codebase's
       standing convention that `apps/shell` is verified via typecheck + `next build` + deployed-
       bundle content grep, not a frontend unit-test suite (no existing test file imports this
       module either).
     2658/2658 tests pass (7 new), `npx turbo run typecheck` clean (76 tasks), `apps/shell`
     verified via a clean `next build`. Deployed: `naelao-agents` (bare `wrangler deploy`, item
     83's documented `--env production` trap), `naelao-spaces`, `apps/shell` (rebuilt +
     `--branch=main`) — all confirmed live (200s on the shell's `/p/launchpad/spaces` and the
     router's `by-slug/launchpad`, and the agents worker's own 401-not-500 on an auth-gated route
     confirming a healthy deploy). **Not done this pass:** a full live end-to-end click-through of
     the session/thread fix specifically (create a real business, open a project thread, confirm
     it never appears in Sessions) — `naelao-spaces` has `workers_dev = false` (item 21's
     hardening) so it can't be curled directly, and a full signup→business→chat round trip through
     the router wasn't run for a fix already covered by 5 unit tests driving the real `SpaceDO`
     class through its real fetch dispatcher (the same code path production uses, verified via
     `node:sqlite` against real migrations, per this file's own standing precedent for what that
     harness catches and doesn't).

104. **A "Timed out" hang on EVERY message (reproduced live) traced to a real Workflow bug and
     fixed; a second real bug (2 starter threads per prebuilt project) found and fixed one layer
     deeper than item 103's own already-fixed instance; the ComposerDock "Message" button removed;
     and a broad direct-API self-test pass (bounded by the account's exhausted Workers AI quota)
     found no further backend defects.**
     - **Root cause of the hang, reproduced against production before touching code:** dispatched a
       real async `/agent/run` and polled it — it stayed `"running"` forever; the underlying failure
       (`4006: daily neuron allocation exhausted`, this account's Workers AI free tier — an infra
       limit, not a bug) never reached TaskDO. In `AgentTaskWorkflow.ts`, the `run-agent` step
       deliberately has ZERO retries (an agent run is not idempotent — see the step's own comment),
       so when it threw, that exception propagated straight out of `run()` uncaught, and step 3
       ("update-result", the ONLY place that ever writes a terminal status) never ran. A client
       polls for `MAX_POLL_DURATION_MS`, times out, and a page refresh just reattaches to the same
       forever-`"processing"` task and hangs identically — exactly the reported "every message, even
       hello, and it reruns on refresh." Fixed: the `run-agent` step call is now wrapped so ANY
       failure — a non-ok HTTP response OR a thrown network error — becomes a normal `runResult`
       with `.error` set, so step 3 always runs; a second outer try/catch around the whole
       step-1-through-3 sequence is a last-resort direct (non-step) TaskDO write for the rarer case
       where step 1 or step 3 ITSELF exhausts its own retries. **A related, second real bug fixed in
       the same code path:** the non-ok branch used to throw immediately without reading the
       response body, discarding any `deferred_approvals` the run had genuinely parked before
       hitting the failure — now parses the body defensively and preserves them, matching the
       existing (200-with-error-status) precedent for the exact same class of loss. 5 new tests in
       `agent-task-workflow-failure-handling.test.ts`, driving the REAL `AgentTaskWorkflow` class
       through a fake `WorkflowStep` mirroring CF's own retry/rethrow contract — not a
       reimplementation of its logic. Live-verified after deploy: the same reproduction now resolves
       to `status:"failed"` with the real `4006` message on the very first poll, instead of hanging.
       **The underlying neuron-quota exhaustion itself is NOT fixed by this** (see Live Deployment
       Facts) — this closes the "hangs forever and gives no signal" failure mode; the account still
       needs its daily allocation to reset (or the $5/mo Workers Paid plan) before chat actually
       answers.
     - **"Why does a new business come with 2 threads for each prebuilt project" — root-caused to
       the EXACT same underlying defect item 89 had already documented as a real, unfixed gap, one
       layer removed from where item 103 fixed its own instance.** `SpaceDO.createProject` has
       always used `ON CONFLICT(space_id, name) DO NOTHING` and returned 201 EITHER way, with no
       field distinguishing a genuine insert from a silent no-op. `seedTemplateProjects`
       (`launchpad/bootstrap.ts`) runs BOTH at provision time (the provisioner) AND again when an
       end user finishes the onboarding wizard (`bootstrap/complete`, reached via the spaces
       worker's `/onboarding` wrapper — its own header comment claiming the end-user shell "never
       reaches this endpoint" was simply wrong, contradicted by the very wrapper item 69 built) — so
       the second pass's `if (!res.ok) continue` skip-on-duplicate check never actually fired, and a
       starter thread was created a second time for every already-existing project. Fixed at the
       root: `createProject`'s response now carries a real `created: boolean`
       (`!alreadyExisted`, a value the handler already computed internally and simply never
       returned) — closing item 89's own documented gap for real, not just for this symptom.
       `seedTemplateProjects` now skips the starter-thread create when `project.created === false`
       (`=== false`, not `!created`, so an older deployed worker missing the field during a rolling
       deploy degrades to the prior, non-regressive behavior rather than wrongly skipping a NEW
       thread). Found and fixed the identical bug ONE MORE layer removed while investigating: this
       file's `applyProjectTemplate` (used by both `bootstrap/complete`'s project-template presets
       AND the end-user-reachable `/projects/from-template` route) had the SAME assumption baked
       into its own header comment ("the create step... returns an error rather than duplicating" —
       never true), so a re-run would re-seed RULES and SCHEDULED JOBS unconditionally — both plain
       inserts with no dedup of their own. Fixed the same way: config PATCH still re-applies on a
       re-run (idempotent, a harmless overwrite) but rule/job seeding is now skipped when
       `created === false`. **A real, previously-passing test was itself hiding the production bug**
       — `template-bootstrap-execution.test.ts`'s fake `postToSpaces` modeled a duplicate-name
       create as a `409`, which is NOT what the real `SpaceDO` does (confirmed by reading the real
       handler) — exactly the "test double diverges from the real contract" class this file already
       documents repeatedly (`config_schema`/`schema_json`, the credentials-worker stub, etc.).
       Fixed the fake to match reality (201 + `created` either way) and the "idempotent" test that
       had been silently passing against the wrong contract failed immediately, confirming the fix
       was real and necessary, not cosmetic. New tests: `space-collaboration.test.ts` drives the
       REAL `SpaceDO` (not a fake) for `created:true`-then-`false`-with-the-same-id;
       `projects-from-template.test.ts` gained two cases (a re-run skips rules/jobs but still
       reconfigures; a genuinely new project still seeds normally). Live-verified directly against
       the deployed `naelao-spaces`: creating the same project name twice now returns `created:true`
       then `created:false` with the identical id.
     - **ComposerDock's "Message" pill (button + icon) removed** — reported as unnecessary since
       compose is already the dock's default panel. Confirmed safe to remove outright rather than
       shrink: every OTHER panel's own toggle button already returns to compose when clicked a
       second time (`toggle()`'s own fallback), plus `Escape` and clicking outside the dock both
       already revert to compose — so the dedicated button's only job was reaching a state every
       other interaction already reaches. Removed the button and its now-dead `.dock-primary` CSS
       (including a `max-width` override in the mobile media query). **A real process gap this
       caught**: the source edit had been made and typechecked earlier but never actually
       rebuilt/deployed — caught by grepping the LIVE deployed bundle for the removed markup (found
       it still present), which is why "typecheck passed" is not the same claim as "shipped" and
       both must be verified independently before calling a frontend change done.
     - **Broad direct-API self-test pass** (signup → business creation → provisioning →
       projects/threads/onboarding/connectors/notifications/model-config/business-wallet/revenue/
       KB/business-members, ~20 real endpoints exercised against the live `launchpad` product with a
       disposable end user) found no further backend defects — three apparent findings during the
       pass turned out to be mistakes in the ad-hoc test calls themselves, not product bugs (a wrong
       field name reading the connector-directory response's `apps` key as `connectors`/`data`; a
       plural `notification_ids` sent where the real contract is a singular `notification_id`;
       calling `PATCH /model-config` with only `effort` and no `model`, which every REAL caller in
       `apps/shell` already always sends together — confirmed by checking all 4 real call sites, not
       assumed) — worth recording as a reminder that an ad-hoc probe script diverging from the real
       contract produces the exact same false-confidence risk as a test file's fake doing the same,
       just faster to mis-read.
     - **OpenClaw comparison**: `docs/COMPETITIVE_2026-08-05_openclaw_hermes.md` (item 96, two days
       old) already covers this thoroughly — Telegram and skill self-improvement (the two real gaps
       it found) are both already closed; re-read rather than re-derived. Fresh research this pass
       (GitHub issues, security advisories) surfaced OpenClaw's disclosed CVE-2026-25253 (an
       unauthenticated `gatewayUrl` query param auto-connects a WebSocket and exfiltrates the
       operator's own auth token, then disables approval prompts via `exec.approvals.set` before
       executing arbitrary commands) — checked our own OAuth `return_url` handling for the same
       *class* of risk (an attacker-crafted link a victim's authenticated browser acts on) and found
       it structurally different: `return_url` is set server-side by an ALREADY-authenticated caller
       for their OWN redirect (never read from an unauthenticated query param on page load), and no
       credential ever reaches the browser in that flow (item 53's own design) — not the same
       vulnerability shape, no fix needed. Also confirms our own architecture (a business's assistant
       policy can only be changed via `PATCH /assistant-policy`, gated by verified business-admin
       role, never a client-supplied redirect target) has no analogous "attacker flips the approval
       gate remotely" path.
     - **CF Browser Rendering (the actual screenshot/HTML-fetch self-test method, already built as
       `infra/scripts/shell-interact.mjs`) was rate-limited (429, `retry-after: 10`) for this
       account for the entire pass despite multiple retries spaced by real intervening work** — not
       used successfully this pass; direct API-level testing (arguably more rigorous for backend
       correctness, though it can't catch pure visual/CSS regressions) filled the gap instead, which
       is how the un-deployed frontend build above was actually caught.
     2671/2671 tests pass (5 new), `npx turbo run typecheck` clean (76 tasks). Deployed:
     `naelao-agents` (bare `wrangler deploy`, item 83's documented trap), `naelao-spaces`,
     `apps/shell` (rebuilt with the actual fix confirmed present in the build output before
     deploying, then reconfirmed as the newest production Pages deployment via the CF API — the
     static-chunk-grep verification method itself proved unreliable for Next.js's dynamically
     code-split chunks and was abandoned in favor of the Pages deployments API). **Not done this
     pass:** a live browser screenshot of the fix (CF Browser Rendering rate-limited throughout);
     the Workers AI daily quota is still exhausted, so no real chat message could be end-to-end
     verified to actually ANSWER, only to fail fast and honestly instead of hanging.

105. **The Space Assistant did not know which business it was running — found by driving a real
     business end-to-end on production, and it is the single biggest thing that was wrong with it
     as an autonomous business runner. Now FIXED, along with two follow-on defects the fix itself
     exposed.** Signed up a fresh end user on the live `launchpad` product, created a real
     `whop-webdev-agency` business ("Pixel Forge Studio"), and asked what its owner would ask
     first: *"What is this business and what should I do first to get my first paying customer?"*
     The answer: *"This business is a digital business built using the Launchpad Space… scaffold
     the real projects and connections using the workspace-admin, mcp-connector, commerce, and
     storefront prebuilts."* Two failures with one cause — it did not know the business sold
     websites, so its advice fit any business at all; and having nothing specific to say, it
     described its own machinery by name to a non-technical owner.
     - **Root cause.** The reasoner payload carried `who_you_are` (a digest of the agent's static
       profile), the goal, the conversation, a technical state fingerprint and candidate scripts —
       and nothing whatsoever about the business. The profile is the SAME text for every Launchpad
       business on the platform, so it can establish what kind of agent this is and can never
       establish which business this is. Item 79 fixed "the agent never sees its own prompt"; this
       is the other half of the same hole.
     - **The fix costs zero extra queries.** `SELECT * FROM spaces` already runs on every
       `/agent/run` (for the model override) and `spaceRow.name` + `config_json`
       (`template_id`, `onboarding.status`) already carry everything needed — all of it was being
       discarded. New `workers/agents/src/launchpad/business-context.ts` resolves name / what it
       sells (from the template's own published description, never a second hand-written copy) /
       setup status, threaded through BOTH dispatch paths (sync and the default async
       Workflow→TaskDO chain) so a durable run is no less informed than a blocking one, plus the
       channel heartbeat (one indexed read per space per tick, via `loadBusinessContext`) — that
       path answers a real CUSTOMER on WhatsApp/Slack, where not knowing what the business sells
       is worse, not better.
     - **The first attempt did not work, and why is the durable lesson.** Adding `business_context`
       to the payload, deploying, and re-asking the SAME question on the SAME business produced a
       word-for-word identical generic answer — the business name was sitting in the request and
       the model never looked at it. One field among a dozen, behind a 4kB action protocol and five
       tool schemas, is not somewhere a 70B model reliably reads. Fixed by ALSO stating it as prose
       in the system message beside the identity anchor that exists for exactly the same reason
       (see `composeSystemPrompt`'s own comment about "who are you?" being answered from the
       machinery). **On small open-weight models, placement is a correctness property, not a
       formatting preference** — and neither version would have been caught by any test, only by
       asking a real business a real question and reading the answer.
     - **Two follow-on defects, each found by re-running live rather than assuming the fix
       landed.** (1) The internal template slug leaked: the answer read "Pixel Forge Studio, a
       Whop-webdev-agency". Removing `kind` from the system prompt was NOT enough — the very next
       live answer said the same thing, because the model was reading it out of the payload
       instead. `kind` stays on the type (code uses it to resolve the offering and price list) but
       is now stripped from what the model sees, in BOTH places (`projectBusinessForModel`).
       (2) The first `setup_note` wording said finishing setup was "their first step, ahead of any
       other advice", and the model read that as permission to stop: asked what to charge, it
       replied only that setup was unfinished and answered nothing — worse than the generic advice
       it replaced, because the question had a real answer. Rewritten: answer what was asked, in
       full, THEN note that setup is unfinished. Unfinished setup is a fact to mention, never a
       reason to refuse.
     - **The business now knows its own price list.** Asked "I want to charge more than $10, what
       should my prices be?", it gave generic advice about costs and competition — while running a
       template that ships an explicit four-tier price list (`WEBDEV_TIERS`). `pricing` now carries
       it, rendering a per-job tier as a RANGE rather than collapsing to a midpoint (the template's
       own rule is to quote within the range and say what is still unsure). Final live answer:
       *"Basic ($10), Standard ($20-100), Premium ($120-150), Enterprise B2B ($250-550)… note that
       setup for Pixel Forge Studio is still unfinished."*
     - **Proactivity: the wake-up now advances the business instead of only reviewing it.** The
       competitive gap versus Polsia was never the mechanism — hooks/cron/heartbeat all exist here,
       are per-business, and were verified seeded on the live business (`0 13 * * *` revenue
       review + `0 8 * * 1-5` leadgen). It was what the wake-up DID: the seeded goal and the
       profile both describe a reviewer ("tell the owner what you'd try next"), and
       `buildWakeUpBrief` returned null entirely when nothing was broken — precisely the state
       where there is no failure to react to and the assistant most needed telling to go and do
       something. New `ADVANCE_DIRECTIVE` rides on EVERY proactive wake: decide the single most
       valuable next thing and actually do it; take it if the approval policy allows, else open ONE
       approval with a concrete proposal (what exactly, and what it costs) rather than a vague
       suggestion. Deliberately placed in the RUNTIME wake path, not the agent profile — profiles
       are written to R2 at provision time and would only ever have reached NEW businesses.
       Unfinished setup is unshifted to the front of the brief, since no other work can run until
       the owner clears it. Fixed a real bug in the same change: a non-ok diagnostics response
       returned early and silently dropped the directive, so a diagnostics outage would also have
       turned off the assistant's reason for waking up.
     - **Deliberately NOT done: removing the approval gate to match Polsia's autonomy.** An
       autonomous runner that silently spends an owner's money is not more advanced than one that
       asks, it is less accountable. The differentiator is being better at ASKING — a specific
       proposal the owner can answer in one tap — which is also what our durable 24h suspend/resume
       approvals and action ledger already support and no competitor documents an equivalent of.
     - Full four-way comparison (OpenClaw / Claude Code / Hermes / Polsia), including where we are
       genuinely behind: `docs/COMPETITIVE_2026-08-08_autonomy_matrix.md`. Its honest headline:
       "beats Polsia at proactivity" is now a design claim, not a measured one — nobody has yet
       watched an unattended wake-up find work, do it, and log it, because daily crons fire daily.
     - **Three earlier session findings were my own test-script errors, not product bugs** —
       recorded because the pattern keeps recurring: `UID` is a readonly bash variable (so the
       end-user-id header was silently wrong); `my-businesses` returns `space_status`, not
       `status`; and onboarding prompts carry `question`, not `label`. Verify a suspected product
       bug against the real contract before reporting it. Two REAL prior fixes were confirmed live
       in passing: exactly one starter thread per prebuilt project (item 104's fix), and
       onboarding completion correctly REFUSING with `missing:["whop_connection"]`.
     2691/2691 tests pass (29 new: `business-context.test.ts` covering resolution, the
     never-invent-an-offering rules, the D1 loader's fail-soft posture, system-prompt placement and
     slug-stripping; plus 2 new wake-brief cases and 3 updated ones that had pinned the old
     stay-silent-when-healthy behaviour). `npx turbo run typecheck` clean (76 tasks).
     `naelao-agents` deployed 6 times across the session (bare `wrangler deploy`, item 83's
     documented `--env production` trap), each fix verified by re-asking the same question on the
     same live business rather than assuming the deploy landed.

106. **Live end-user testing found a second severe bug — a brand-new business was refused its own
     agents — plus a measured proof that the remaining answer-quality problem is the MODEL, not the
     prompt.** Continuation of item 105's session, same method: drive a real business on
     production and read what a real owner would see.
     - **A freshly created business blocked every project-agent run with `402 insufficient_credits`
       — "this business's wallet is empty — top up to keep this agent running" — before its owner
       had done anything.** Every business auto-provisions an empty wallet project at creation
       (`seedWallet`), and `checkProjectWallet` blocked on `balance_cents <= 0`, so a NEVER-FUNDED
       wallet and a DEPLETED one were the same state. The first thing a new owner heard from their
       own agent was a demand for money — and it directly contradicts the platform's own stated
       goal (item 50) of taking a business from $0 to real revenue with zero owner money in.
       Nondeterministic in practice, which is worse: of two businesses created minutes apart from
       the same template, one was blocked and one was not, on a difference the owner cannot see or
       control. Fixed by making `getWalletBalance` also report `credited_cents` (SUM of positive
       ledger deltas — money that has EVER gone in), and gating on `balance_cents <= 0 && everFunded`.
       A missing field (an older spaces worker mid-rolling-deploy) falls back to the previous
       balance-only behaviour rather than silently opening the gate for everyone. Live-verified: the
       previously-blocked business now runs. **Deploy note:** the fix needed ~45s to take effect
       because a warm SpaceDO instance keeps running old code after a deploy — a first retry
       looked like the fix had failed.
     - **Test-authoring note worth keeping:** creating a `kind:'wallet'` project is gated three
       ways, and the first two attempts failed on the wrong one. It is not a header role — the
       role is looked up from `space_members` via `created_by` — and a missing `created_by` fails
       CLOSED unless the explicit server-derived `system_caller: true` marker is set, which is
       exactly how the provisioner's own `seedWallet` calls it. Mirror the provisioner, not a
       plausible-looking client call.
     - **The remaining answer-quality problem is the model, and that is now measured rather than
       assumed.** Item 105 stopped agents naming internal components in owner-facing answers for
       the Space Assistant, but a project specialist still said "I would use the `web-search`
       prebuilt … then the `outreach-draft` skill". A third instruction was added (a shared
       `OWNER_FACING_LANGUAGE_RULE` appended to EVERY Launchpad agent profile in
       `launchpadAgentToProfile`, so no future agent can miss it) and it still leaked. Rather than
       writing a fourth, ran the SAME prompt on the SAME business on `@cf/openai/gpt-oss-120b`:
       clean, plain-language, names the business, zero tool names. So the instructions are correct
       and a capable model follows them; `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (the current
       default) mirrors the register of the prompt it just read, which necessarily names those
       operations so it can pick the right one. **Flagged, NOT changed unilaterally** — raising the
       default model is a cost decision against a ~10,000 neuron/day allowance, not an engineering
       one. Full side-by-side evidence in `docs/COMPETITIVE_2026-08-08_autonomy_matrix.md`.
     - **Also confirmed live in passing:** exactly one starter thread per prebuilt project (item
       104's fix, verified on two fresh businesses); onboarding completion correctly refusing with
       `missing:["whop_connection"]`; both proactive crons seeded per business (`0 13 * * *`
       revenue review, `0 8 * * 1-5` leadgen); and provisioning latency varying from ~15s to ~50s
       between two businesses created minutes apart — not a bug, but worth knowing before treating
       a slow provision as a failure.
     - **A syntax error I introduced and caught only at deploy:** backticks inside
       `DECISION_INSTRUCTIONS` (a template literal) opened a nested template expression. `tsc`
       passed against the incremental build; `wrangler deploy` failed with a real esbuild parse
       error. Same lesson as item 100's circular-import bug — a passing local typecheck does not
       prove a bundle builds.
     2698/2698 tests pass (7 new: `new-business-wallet-gate.test.ts` driving the REAL SpaceDO
     through the real migration chain, plus 4 gate cases in
     `interactive-run-project-wallet-gate.test.ts` covering never-funded / genuinely-depleted /
     overdrawn / missing-field-rolling-deploy). `npx turbo run typecheck` clean (76 tasks).
     `naelao-spaces`, `naelao-agents` and `naelao-provisioner` deployed and live-verified.

107. **Pushed past "documented as unproven" on both blockers: autonomous mode was BROKEN on the
     only path that runs in production (now fixed and proven), and Tier 2 turned out to be
     plan-gated in a way that lies to you.**
     - **Autonomy never worked through the real UI.** `/agent/run` resolves the caller's role in
       their own business (`business_memberships`) so the F-36 clamp does not downgrade a business
       OWNER, and it passed that into the async Workflow's params — but `AgentTaskParams` never
       declared `businessRole` and the run-agent step never forwarded it. The async path is the
       DEFAULT for every real chat message. So an owner who set their business to Autonomous still
       had **every action gated with nobody but themself to approve it**. Item 93 fixed this exact
       bug on the SYNCHRONOUS dispatch and missed the one that actually runs — the second time this
       "fixed on one path, missed the other" mistake has happened, which is why the new regression
       test asserts the whole identity set (`businessRole`/`callerRole`/`userId`/`projectId`/
       `businessContext`) rather than the single field that broke. Reproduced live (real owner-role
       end user, policy `yolo`, still told "Waiting on your approval for: quote-job"), fixed, and
       re-verified. **Proven working end to end on production**, one prompt, no human in the loop:
       "Create a new project called Q3 Marketing Push… then confirm it exists by listing the
       projects" → it created the project, re-read the list to verify, reported the real id, and
       volunteered the unfinished-setup caveat unprompted. That is a multi-step autonomous action
       with verification — the shape Polsia's whole pitch rests on.
     - **`[[worker_loaders]]` deploys "successfully" and is silently dropped — a real trap, now
       written into the wrangler.toml itself.** Uncommenting it and running `wrangler deploy`
       prints a normal deployment with a new Version ID and no warning; the bindings API
       (`GET /accounts/{id}/workers/services/naelao-agents/environments/production/bindings`) then
       shows **no LOADER**, and a real Tier-2 script still fails with "Tier 2 is unavailable: no
       worker_loaders binding configured in this environment". Verified both directions this
       session. **A successful deploy is NOT evidence a binding exists.** So Tier 2-5 is genuinely
       gated on the CF Workers Paid plan and cannot be engineered around; every seeded skill
       (`quote-job`, `outreach-draft`, `store-provision`, …) needs it. What is NOT blocked by it:
       the prebuilts (web search, notifications, commerce, business email, MCP connectors,
       workspace/project admin, journal) run natively — which is exactly why the autonomous
       project-creation proof above works today.
     - **Test-authoring note:** `AGENTS_WORKER.fetch(url, init)` is called two-arg, not
       `fetch(Request)`. A Request-shaped mock captures nothing and every assertion reads
       `undefined` — the same shape-mismatch that cost time in item 106's TaskDO fake. The new
       test was verified to genuinely catch the bug (reverting the one-line fix fails it).
     - **A probe that looked like a bug and was not:** `GET /spaces/:spaceId/approvals` returns
       `401 Malformed JWT` for a product end user — but the shell never calls that path. The real
       one is `/spaces/:spaceId/sessions/inbox/approvals`, which works correctly and returned the
       live pending approvals. Checked before reporting, per this file's own repeated lesson.
     - Full four-way comparison, including the measured llama-3.3-70b vs gpt-oss-120b evidence and
       what is genuinely still blocked: `docs/COMPETITIVE_2026-08-08_autonomy_matrix.md`.
     2700/2700 tests pass (2 new), `npx turbo run typecheck` clean (76 tasks), `naelao-agents`
     deployed and live-verified.

108. **An autonomous business action that FABRICATED success — the worst failure this platform can
     have — found live, root-caused to a missing capability, fixed, and now proven real.**
     Asked to create a sellable product, the assistant replied: *"I've created the Standard Website
     Package… Price: $20… The product is now live on your storefront at shop-457302.naelao.com."*
     None of it existed — `launchpad_products` was empty platform-wide. An owner acting on that
     believes they are selling something they are not, which is strictly worse than a visible
     failure.
     - **Root cause was a capability gap, not only a model one.** The `commerce` prebuilt had
       exactly four operations — `checkout`, `seat_checkout`, `list_products`, `get_order`. There
       was **no way to create a product at all**, so "run a business" stopped at reading. The
       storefront UI has always had `POST /spaces/:id/products` and `PATCH .../products/:id`; the
       agent was simply never given them. Added `commerce.create_product` / `commerce.update_product`
       against those same already-tested routes, with publishing deliberately its OWN step rather
       than a flag on create (a product going on sale is the moment customers can pay for it —
       a decision, not a side effect of drafting), and errors carrying the upstream response body,
       because an agent told only "failed: 403" cannot report anything useful to its owner.
     - **PROVEN REAL, not taken on the model's word.** After the fix, the same request produced a
       product the agent reported as id `c210c785-43c0-42d4-ad7e-3391eabfbb97` — and an independent
       `GET /spaces/:id/products` returned that exact id, name and `price_cents: 2000`, status
       `draft`. $20 is the bottom of the Standard tier from item 105's pricing context, so the
       business's own published price list is now driving a real commercial decision. Always verify
       an agent's success claim against the datastore; this session it was false once and true once,
       and the answers read almost identically.
     - **A second failure the same run exposed: a tool call naming an OPERATION instead of an
       action was fatal.** The model emitted `knowledge.search` — not one of the five decision
       actions — and the run died with "unusable tool call … and no parseable text". Models trained
       to emit direct tool calls reach for the operation name constantly and the intent is
       unambiguous, so a dotted `namespace.op` name is now read as `{"action":"run","name":…}`
       (`coerceOperationToolCall`). An undotted, unrecognised name still fails visibly rather than
       being guessed at — `answer` must never be coerced into a `run`.
     - **Anti-fabrication instruction added** ("never report an action as done unless
       `steps_so_far` shows it ran and returned ok"), but note honestly: it did NOT stop the
       fabrication on its own — the run after adding it still claimed success while correctly
       reporting the product list was empty. What actually fixed the behaviour was giving the agent
       a real capability. Same lesson as items 105-107: on this model tier, a prompt rule is a
       nudge, not a guarantee; structure is what holds.
     - **The protocol tripped its own size bound** (`reasoner-agent-prompt.test.ts`) after this
       session's additions — 20,614 chars against a 20,000 limit. That is a real cost on a model
       whose true window is 24k tokens, not a stale assertion, so the three paragraphs added today
       were tightened rather than the bound relaxed.
     2708/2708 tests pass (8 new: the two new commerce writes against the real route contract +
     HMAC, upstream-error surfacing, and five `coerceOperationToolCall` cases), `npx turbo run
     typecheck` clean (76 tasks), `naelao-agents` deployed and live-verified.

109. **THE proactivity bug: every newly-seeded scheduled job on the platform has never fired, and
     the failure was silent and self-sealing. Found by waiting for a real cron on a real business
     and watching it not happen.**
     - `enqueueAgentTicks` anchored a never-run job with ``Date.parse(`${row.created_at}Z`)``. D1
       returns that column as a full ISO string that ALREADY ends in Z (verified on the live row:
       `"2026-08-08T11:20:40.671Z"`), so this produced `"…671ZZ"` → **NaN**. `isCronDue` then did
       `Math.max(NaN, earliest)` → NaN → `startMinute` NaN → the scan loop `for (m = NaN; m <=
       end; m++)` never executed → `false`. Demonstrated against the real row: **0 minutes
       scanned, versus 160 after the fix.**
     - **Self-sealing**: the job could not fire, so `last_run_at` stayed null, so the anchor stayed
       NaN, so it could never become due. And from the outside it was indistinguishable from "not
       due yet" — no error, no log, nothing to notice. This is why item 22's default revenue-review
       cron, and item 82's whole proactive-cycle work, never actually produced a wake-up for any
       new business: the rows were correct, enabled, and dead.
     - **Fixed in two layers, because either alone leaves the trap open.** New `parseTimestampMs`
       (agents worker) handles both shapes D1 returns — ISO-with-zone parsed as-is, bare
       `"YYYY-MM-DD HH:MM:SS"` treated as UTC (without a marker it would read as local time, a
       silent hours-sized error) — and returns `undefined` rather than NaN, so a caller must decide
       what a missing timestamp means instead of inheriting a value that poisons every comparison.
       And `isCronDue` (`@naelao/events`) now treats a non-finite last-run as unknown and falls
       back to the lookback window: a bad timestamp should cost one extra evaluation, never the
       entire schedule. De-duplication of a genuinely-just-run job is unchanged.
     - **Only live testing could have found this.** Every unit test passed before and after,
       because they all pass a real number for `lastRunAtMs`; nothing exercised the
       never-run-job path with the actual D1 string. The tests added here pin the real column
       value verbatim.
     - **A stale-`dist/` trap cost time again**: `@naelao/events` resolves through its compiled
       output, so the hardened `isCronDue` was invisible to the test suite until
       `npx tsc` was run in that package. CLAUDE.md already documents this for
       `packages/billing-core`; it applies to every `packages/*` consumer.
     2718/2718 tests pass (9 new: `scheduled-job-timestamp.test.ts` covering both D1 shapes, the
     offset form, numeric passthrough, undefined-never-NaN, and the exact double-Z string that
     caused this; plus three `isCronDue` non-finite cases), `npx turbo run typecheck` clean (76
     tasks), `naelao-agents` deployed.

110. **The unattended cron fired for real — and immediately exposed the NEXT blocker, which is
     exactly why waiting for it mattered.** At 14:01:15 UTC the hourly sweep fired this business's
     `0 13 * * *` revenue review unattended (`last_run_at 1786197675189`, `consecutive_failures 0`),
     and the `0 8 * * 1-5` leadgen job correctly did NOT fire — so the matcher selects rather than
     firing blindly. The wake brief reached it too, verbatim in the resulting notification:
     *"Since your last wake-up: - Setup for Pixel Forge Studio is still unfinished…"*, confirming
     item 109's `ADVANCE_DIRECTIVE` and the setup-priority line are live on the proactive path.
     - **And the run died instantly**: `reasoner gateway error 404: {"message":"Model not found:
       claude-haiku-4-5-20251001"}`. `wakeAgentGoal` sent no `model`, so `NaelaoAgentDO` fell back
       to a hardcoded Claude id — which on a gateway with no Anthropic provider (this account, see
       item 68) is a guaranteed 404. **The proactive layer would have stayed broken even after the
       scheduling fix**: cron fires, run dies, nothing happens, and the only trace is a warning
       notification nobody is watching for. Six copies of that hardcoded id in the DO replaced with
       `DEFAULT_WORKING_MODEL`, which was already imported and already used a few lines away —
       item 79 fixed this class in `index.ts`'s dispatch sites and missed the DO's own fallbacks,
       which is precisely what a cron-dispatched run lands on.
     - `wakeAgentGoal` also sent no `businessContext`, so the recurring run — the one most in need
       of knowing which business it is reviewing — was the only run still flying blind after item
       105 threaded it everywhere else. New `resolveWakeContext` does ONE indexed read and supplies
       both, preferring the business's own configured model and **re-validating it against the
       allowlist** rather than trusting it (a stored model that has since left the allowlist would
       otherwise reintroduce exactly the 404 this exists to prevent). Never throws.
     - **The general lesson, and it is the one worth keeping from this whole session:** items 105-109
       were each found by running the real thing and reading what came back, never by reading code.
       Every one of them passed ~2,700 unit tests before being found. A scheduling bug that returns
       `false`, a model fallback that 404s, an agent that fabricates a product — all three are
       invisible to a test suite that supplies its own inputs, and all three are obvious within
       seconds of watching a real business try to operate.
     2718/2718 tests pass, `npx turbo run typecheck` clean (76 tasks), `naelao-agents` +
     `naelao-spaces` deployed. `last_run_at` was reset so the next sweep re-runs the same job with
     the model fix in place.

111. **The re-fire confirmed item 110's model fix AND exposed the next layer: a model mistyping a
     script name killed the entire run.** The 15:00 sweep ran the job at 15:02:24 UTC with no
     `Model not found` — the 404 is genuinely gone. It failed for a completely different reason:
     `{"error":"Invalid script name: \"notifications prebuilt\""}`, `consecutive_failures: 1`. The
     model chose to run the `notifications` prebuilt by its **descriptive phrase** instead of one
     of its real operation names, and `SkillLibrary.read()`/`exists()` asserted the name was a safe
     path segment and **threw**. That throw escaped `ScriptToolSurface.run()`'s per-step error
     handling entirely and killed the whole run — so a model typo was fatal rather than a step it
     could observe and correct. Worst precisely on the unattended proactive path, where nobody is
     watching to retry: the job records a failure and goes quiet.
     - **Fixed by splitting lookups from writes.** The two LOOKUPS (`read`, `exists`) now report
       "no such script" for an unusable name; all six WRITE paths (`create`/`update`/`patch`/
       `rollback`/`delete`/`import`) still call `assertName` and still throw, since there a bad name
       is a bug or an attack, not a typo. Path safety is unchanged either way — an unusable name
       never reaches the bucket, asserted directly by a test that counts bucket touches.
     - **The resulting failure now teaches the model** rather than leaving it to re-guess until the
       stall budget runs out: `Unknown script or operation: X` gained a "Did you mean…" naming the
       closest real operations. **That match considers the owning prebuilt's NAME as well as the op
       name**, which turned out to be load-bearing — `notifications` owns ops prefixed `notify.`
       (`notify.email`, `notify.slack`, …), so matching op names alone would have suggested
       *nothing* for this exact failure. The prebuilt name is what the model sees listed in its own
       profile, and that prefix mismatch is very likely why it reached for the wrong name at all.
       Prebuilt ops only — they're already in memory, so a miss costs nothing, whereas listing the
       R2 skill library would turn every mistyped name into a bucket listing.
     - **The new test was verified to catch the bug**, not merely to pass: reverting the one-line
       `read()` change fails 3 of its 5 cases, including the exact live-failure string.
     - **The actual root cause was my own seeded text, found by asking why an hour of waiting was
       needed rather than five minutes.** Pulling the real `scheduled_jobs.goal` to run it directly
       showed the goal itself says *"Only message the owner (via the notifications prebuilt)"* —
       written by `seedDefaultRevenueReviewCron` (item 82). The model reproduced that phrase
       verbatim as a script name. So this was never only a model failure: **a model uses the
       wording it is handed**, and a goal that names an internal component by description hands it
       an unusable name. Fixed at the source in both places that feed a model a tool by phrase —
       the seeded cron goal and `buildWakeUpBrief`'s setup note — which now name the real op
       (`notify.email`); plus one short clause in the `run` action's own protocol line
       ("`name` is an EXACT operation name from candidates, never a description"). A new
       provisioner test asserts a seeded goal names a runnable op and contains no "prebuilt", so
       the phrasing cannot come back. **12 live jobs platform-wide carried the bad phrase** (not
       just the business under test) and were repaired in D1.
     - Live-verified after deploy, in ~2 minutes rather than an hour: dispatching the EXACT stored
       goal now completes with a grounded answer — it read the real wallet history, refused to
       invent a balance it could not verify, and correctly withheld a routine "all good" ping.
     - **Waiting for the hourly sweep was the wrong instinct** and a user question caught it. The
       sweep's own selection logic was already proven live twice (14:01:15 and 15:02:24, correctly
       firing one job and not the other); the only unproven half was the run itself, which can be
       dispatched directly. Prefer running the real stored input over waiting for the real trigger
       when the trigger is independently verified — and pulling that stored input is also what
       exposed the root cause.
     - **Third mock-shape mistake of the session**: the new guard test hand-rolled a
       `fetch(url, init)` double while the file already had a `makeEnv()` helper handling both
       call shapes, so `calls` came back empty. Use the existing helper in a file before writing
       another double.
     - **The pattern worth keeping from items 105-111:** every one of these seven bugs was found by
       running the real thing and reading what came back, and every one passed the full unit suite
       beforehand. Each fix exposed the next layer — a 404 hid a fatal-throw bug, which hid a
       prefix-mismatch confusion. Fixing a blocker is not finishing; it is earning the right to see
       what was behind it.
     2724/2724 tests pass (6 new), `npx turbo run typecheck`
     clean (76 tasks), `naelao-agents` + `naelao-provisioner` deployed.

112. **A repeatable capability benchmark — 6 test cases, trace-graded — is BUILT and validated
     against production; the model matrix itself is blocked on a Cloudflare quota window, not on
     code.** Grounded in published work rather than invented: `Claw-SWE-Bench` (arXiv 2606.12344)
     holds the model fixed and swings Pass@1 from **19.1% to 73.4% on adapter design alone**, and
     reports harness choice worth 27.4pp against model choice's 29.4pp; `WildClawBench` runs the
     same 60 tasks under OpenClaw / Claude Code / Codex CLI / Hermes and sees the same effect
     (GPT-5.4: 56.8% on Codex, 50.3% on OpenClaw). So a generic leaderboard measures the wrong
     quantity — what decides whether OUR assistant runs a business is THIS loop, which is what the
     matrix scores.
     - **`workers/eval/src/trace-checks.ts` grades from the HX1 run trace, not the prose.** The LLM
       judge reads what the agent WROTE — right for answer quality, wrong for "did it do this",
       since a model can describe work it never performed and score well because the paragraph is
       genuinely good (item 108 exactly). Ten check types (`called_tool`, `verified_after_write`,
       `no_fabricated_success`, `no_identical_retry`, `escalated`, `no_secret_leak`, …). `claweval`
       scores its own tool-calling category the same way ("deterministic — tool name + params
       match"). Composition with the judge is **MIN, not average** — the same rule `judgeAnswer`
       already applies between correctness and semantic_validity: a run the trace proves fabricated
       must not be rescued by writing well about it.
     - **New dataset `tests/eval-datasets/agent-capability-matrix.jsonl`** — 6 cases over 6 axes
       (agency, safety/credentials, fabrication, recovery, proactive escalation, multi-source
       synthesis). Each maps to a published benchmark category AND a real production failure of
       ours, so no axis exists just to be passed. `trace_only` on the runner skips the judge
       entirely — a real cost lever, since the configured judge is a premium model and judging 4
       cases costs several times the 6 runs being measured.
     - **Validated against production, and it immediately caught a real model weakness.** The trace
       endpoint returned 13 real steps; asked to create a project and read it back, llama-3.3-70b
       hit the approval gate on `project.create`, correctly ran `project.list`, then **re-chose the
       already-parked action five consecutive times** (seq 7-11) until stall detection ended the
       run. The harness was correct throughout (it said "still waiting on a human for this one",
       incremented the stall counter, asked for a closing summary); the model ignored all three.
     - **Caught a flaw in my own test design before it corrupted five models' numbers:** on a fresh
       business `project.create` is GATED, so the `agency` case would have measured the approval
       policy rather than the model and every candidate would have failed it identically. The eval
       space is now `yolo`; approval behaviour is measured by the `proactivity` case, where it
       belongs.
     - **THE QUOTA INSTRUMENT LIES — the most important operational finding here.** The Workers AI
       free allocation is **not a calendar-day cap**: 2026-08-07 used **13,540** neurons and 08-08
       used **11,068**, both above the nominal 10,000, which a per-day counter cannot explain. It
       behaves as a **rolling 24-hour window** (budget frees as the prior day's spend ages out, NOT
       at midnight). And the obvious check is wrong in the dangerous direction: **a request rejected
       by the limiter consumes no neurons**, so on a capped day the GraphQL aggregate reports
       *0 used / 10,000 remaining* while every real call fails. Trusting it recorded
       `avg_score=0.00` for two models that never ran — a quota wall rendered as "these models are
       bad", the instrument-failure-as-result mistake the trace grader exists to prevent, arriving
       from a direction nobody was watching. **Always probe with one minimal inference; never trust
       `aiInferenceAdaptiveGroups` for remaining budget.** `infra/scripts/run-model-matrix.sh` now
       probes and REFUSES to start (exit 3), re-checking between models, and gives each model its
       own fresh session (sharing one `--session-id` let model B read model A's conversation
       history — measuring its ability to read another model's homework). The 3 polluted baseline
       runs were purged so the first real pass sets the baseline.
     - Measured cost: **~330 neurons per multi-step agent run** on llama-3.3-70b (n=2) ⇒ ~2,000 per
       6-case model pass ⇒ ~5 models per allocation. Recorded as `neuronsPerRun` (only where truly
       measured); `MODEL_BENCHMARKS` gained `axes`/`CapabilityAxis` and `validateModelBenchmarks`
       now rejects incoherent data (7/5 passed, zero-check axes). Discover renders both.
     2770/2770 tests pass (46 new), `npx turbo run typecheck` clean (76 tasks), `naelao-eval`
     deployed, `apps/shell` deployed. **Not done: the matrix run itself** — blocked on the rolling
     quota window, unblocks with the CF Workers Paid plan ($5/mo) or as the window ages out.
     Eval space kept for it: product `df1969c5-c1da-4095-8a29-f34125b5aa1d` (slug
     `eval-matrix-space`, disposable builder org, set to `yolo`, `membershipModel: hybrid`).
     **To run it once budget exists** (needs a builder JWT for that product's org — re-mint via
     `POST /v1/auth/register` + `POST /v1/builder/products` if the old one expired):
     `./infra/scripts/run-model-matrix.sh <space-id> <token-file>
     tests/eval-datasets/agent-capability-matrix.jsonl <model> [<model> ...]` — it refuses to start
     when capped, gives each model its own session, and reports real neuron spend per model. Then
     `node infra/scripts/matrix-results-to-benchmarks.mjs` emits the exact `axes` TypeScript to
     paste into `MODEL_BENCHMARKS`; Discover already renders it. Recommended first five, cheapest-
     first so a partial run still yields a ranking: llama-3.3-70b (the default), granite-4.0-h-micro,
     qwen3-30b-a3b, mistral-small-3.1-24b, gemma-4-26b.
     - **A full end-user journey audit on production also ran this session
       (`docs/E2E_2026-08-09_end_user_journey.md`) — 13 steps as a real signed-up end user, all
       passing.** Live-confirmed two prior fixes still hold: the starter-thread dedup (item 104 —
       0 duplicates across 6 auto-created projects) and onboarding refusing completion while naming
       the exact unmet prompts. **One real defect found and FIXED:** creating a business returned
       `signup_closed` / "Public signup is disabled for this product" moments after a customer had
       visibly signed up fine — `allowPublicSignup` is read in exactly ONE place platform-wide (the
       business-creation gate) and end-user signup never consults it, so a builder would hunt for a
       signup setting that does not control signup. The dashboard already labelled it correctly;
       the field's doc comment was stale and the message inherited that framing. Now
       `business_creation_disabled` naming the real control (Configuration → Product Mode);
       live-verified in production. **Recorded, not changed:** the creation wizard doesn't offer
       Product Mode (so a new product defaults to `team` + signup off, and a builder wanting the
       reseller model must know to visit Configuration), and a gated action still reports
       `status:"failed"` when the truth is "waiting on you" (the approval card does render).
       **Three "bugs" were my own probe errors** — `EUID` is a readonly bash variable (like `UID`);
       `POST /spaces/:id/businesses` requires `spacetype_id` (the shell sends it correctly);
       `/projects` returns a bare array. Verify against the real contract AND what the real client
       sends before reporting.

113. **`/dashboard/chat` removed in favor of `/new`; its rich side panel (status/config, memory,
     crons, channels, sub-agents, files) is now the SHARED panel on every conversation surface —
     including project threads, which only ever showed "Coming soon" — plus Skills and
     Notifications tabs that didn't exist anywhere before; and Kitesurf (Cloudflare's new
     agent-first browser, researched and grounded against the real published API before writing
     any code) is wired into the execution ladder as Tier 4's default, cheaper first attempt.**
    - **Kitesurf, grounded not guessed.** Fetched Cloudflare's own 2026-08-06 blog post directly
      (the first WebFetch attempt returned nothing — a real page-fetch failure, not a lack of
      information — so re-confirmed via WebSearch + a second WebFetch): a lightweight, agent-first
      browser (3-7x less CPU/memory than Chromium, ~1.7x slower wall time) that can't yet do video
      playback, WebGL, bot-challenge/TLS-fingerprint handshakes, persistent authenticated
      sessions, or pixel-perfect rendering — still beta, no GA date. Confirmed the actual API
      contract by pulling the REAL published `@cloudflare/puppeteer@1.3.0` package (the repo was
      pinned at a stale `^0.0.9`) and reading its `.d.ts` directly rather than trusting the blog's
      prose: `WorkersLaunchOptions.browser?: 'kitesurf'`, passed as `puppeteer.launch(binding,
      {browser: 'kitesurf'})`.
    - **That investigation surfaced a real, previously-broken call in `naelao-browser`
      (`workers/browser/src/index.ts`) — Tier 4 has likely never actually worked in production.**
      The existing code cast the raw `BROWSER` binding itself to a fake `{launch(browser)}` shape
      and called `.launch()` ON the binding, passing the SAME binding back to itself as an
      argument (`@cloudflare/puppeteer` was never even imported). A `browser_rendering` binding
      only ever implements `fetch()` — it has no `.launch` method of its own; the real contract is
      `puppeteer.launch(endpoint, options)` where `puppeteer` is the imported package's own
      default export and `endpoint` is data passed IN, never the receiver. Fixed by actually
      importing `@cloudflare/puppeteer` (bumped to `^1.3.0` — both the worker's own devDependency
      and a new root-level one, needed for Vitest's mock resolution to find the SAME module the
      source file resolves via its own pnpm-workspace `node_modules` symlink; without the root
      dependency, `vi.mock("@cloudflare/puppeteer", ...)` registered against an unresolvable
      specifier and silently never applied — a real, non-obvious pnpm+Vitest workspace-boundary
      gotcha, not a flaky test) and rewriting the launch/navigate/screenshot path against the REAL
      `Browser`/`Page` types instead of hand-rolled stub interfaces. Also fixed in passing, caught
      by having the real types in hand: `screenshot_base64` was built via `String.fromCharCode(
      ...bytes)`, which risks "Maximum call stack size exceeded" on a large screenshot buffer —
      now `Buffer.from(bytes).toString("base64")`.
    - **Engine selection: `"auto"` (the new default) tries Kitesurf first, falls back to Chromium
      on ANY failure, and reports which one actually ran** (`engine_used`, plus
      `kitesurf_fallback`/`kitesurf_fallback_reason` when a fallback happened) — worth taking by
      default since this worker's usage (launch → act → extract → close, once, never a session
      persisted across calls) is exactly Kitesurf's sweet spot and structurally avoids most of its
      documented gaps. An EXPLICIT `engine: "chromium"|"kitesurf"` is honored strictly with no
      silent substitution — a caller that already knows a target needs Chromium-only capability
      shouldn't be silently routed through a doomed Kitesurf attempt first, and a caller that
      explicitly asked for Kitesurf and got a real failure should see that failure, not a quiet
      swap. Threaded end-to-end: `browser-use` prebuilt (`workers/agents/.../browser-use.ts`)
      forwards an optional `engine` on every op (`browser.navigate/click/type/extract/screenshot`)
      only when the agent actually specified one, so the worker's own default is what applies
      otherwise. 7 new tests (`browser-worker-kitesurf.test.ts`) — including one that pins the
      exact `launch(endpoint, options)` argument order/shape, which is what would have caught the
      pre-existing broken call had this test existed before.
    - **`/dashboard/chat` removed — `/new` (Home) is now the only assistant-chat entry point.**
      Deleted the route; the one real navigation link to it (`dashboard/page.tsx`'s "Talk to the
      assistant" button) now points at `/new`. Its rich side panel — Status/Config, Memory, Crons,
      Channels, Sub-agents, Files — did not exist anywhere else, and neither did the two the user
      asked to add, Skills and Notifications; all of it is now `AssistantSidePanels.tsx`, a shared
      component used by `Chat.tsx` (the ONE chat surface both the assistant/Home session and every
      project thread render through) rather than duplicated per-page. **Project threads previously
      showed a bare "Coming soon" for every panel tab beyond Stats and the consult-subthread
      Assistant tab — now functional there too**, with two things genuinely scoped differently
      rather than copy-pasted: Config edits the SPECIFIC project agent's own policy override when
      the Naelao Agent Templates switcher has one explicitly selected (via the pre-existing
      `AgentPolicyPanel`'s sibling logic — `getAgentPolicy`/`updateAgentPolicy`, 2-mode
      always_ask/yolo), falling back to the space-wide 4-mode `assistant_policy`
      (`gate_unless_listed`/`gate_listed` included) when nothing is explicitly bound — same
      fallback SpaceDO's own `resolveAgentPolicy` already implements server-side, mirrored here
      client-side only for which endpoint to call. And Files reads the PROJECT's own R2 workspace
      (`listWorkspaceFiles`, item 13's per-project filesystem — a pre-existing endpoint with no UI
      consumer before this) rather than the space-wide assistant workspace. Memory/Crons/Channels/
      Sub-agents/Skills/Notifications stay space-wide in both contexts on purpose — there is no
      per-project memory/cron/channel/notification concept, and the skill library (R2 scripts) is
      shared platform-wide within a space, never siloed per project. The panel header used to say
      "Thread" unconditionally, even in the assistant/Home session where there is no thread at all
      — the literal bug the user reported; now "Session" vs "Thread" based on whether `threadId`
      is actually set. Skills tab reads `getAssistantCapabilities` (already built, item 71's own
      "What it can do" section, previously only ever rendered as two bare counts — this is the
      first place the individual skill NAMES and prebuilt descriptions are shown). Notifications
      tab reads/marks-read through the already-built `listNotifications`/`markNotificationRead`
      (item 26) — previously only reachable via the separate `/notifications` page, now also
      inline at the exact conversation where something went wrong.
    - Deliberately NOT rebuilt as a duplicate: Artifacts stays a real, honest "Coming soon" — no
      generated-deliverables backend exists yet, unlike everything else on the user's list, and
      claiming otherwise would be exactly the fabrication class this file's own conventions (item
      108, `no_fabricated_success`) warn against.
    2777/2777 tests pass (7 new), `npx turbo run typecheck` clean (76 tasks), `apps/shell`
    verified via a real `next build` (confirmed `/dashboard/chat` gone from the route list, every
    other route present). **A deploy-tooling trap found and avoided, not just for `naelao-agents`
    (item 83) but for `naelao-browser` too**: `workers/browser/wrangler.toml` has the identical
    no-`name`-override `[env.production]` shape that produced the accidental
    `naelao-agents-production` duplicate — checked the live CF API first (only one `naelao-browser`
    service exists, no `-production` variant) and used the bare `wrangler deploy` deliberately,
    the same rule item 83 already established. `naelao-browser`, `naelao-agents` (bare
    `wrangler deploy` both), and `apps/shell` (rebuilt + `--branch=main`) all deployed; live-verified
    `dashboard/chat` now 404s while `dashboard` and `new` still 200, and confirmed the new panel's
    strings ("Assistant Autonomy", "Pre-approved actions") are present in the deployed bundle.
    **Not done this pass:** a live click-through of the new Config/Skills/Notifications tabs with a
    real business-admin browser session (same Playwright/TLS-handshake limitation as every prior
    UI pass — verified via typecheck + a real `next build` + deployed-bundle content instead); an
    actual Kitesurf navigation has not been exercised against a live target site (the worker-level
    logic is unit-tested against a mocked `puppeteer.launch`, not run against Cloudflare's real
    Kitesurf beta endpoint, which needs a live agent run through a business whose Tier 4 is
    reachable — not attempted this pass to conserve the account's constrained inference budget,
    see Live Deployment Facts).

114. **The capability matrix (item 112) produced its first REAL result — genuinely partial, and
     recorded as such rather than either discarded or presented as complete.** The account's
     rolling-window quota opened after a 140-minute wait (12:00Z), but the window itself was
     small: `llama-3.3-70b-instruct-fp8-fast` completed real, trace-graded dispatched-agent runs
     on 3 of 6 cases (agency 2/5, safety 4/4, fabrication 2/2) before the SAME run hit the quota
     wall again mid-pass (cases recovery/proactivity/synthesis never got a fair attempt) — 998
     real neurons spent, and every OTHER candidate model's own probe-check then reported capped
     before it could even start.
    - **A real bug in the converter, found by this exact partial run.** `matrix-results-to-
      benchmarks.mjs`'s dispatch-failure detection only matched the DISPATCH-layer error shape
      (`"agent/run HTTP ... 500"`), missing the REASONER-layer shape a mid-run 429 produces
      (`"reasoner gateway error 429 ... code":4006 ..."`) — undercounting real infrastructure
      failures and letting at least one of them silently score as a 0/N task failure instead of
      being excluded as "never got a fair attempt." Fixed: `isInfraFailure()` now matches
      Cloudflare's quota-error text regardless of which layer it surfaced at, and a matched case
      is EXCLUDED from that axis's passed/total entirely (never scored 0) — the exact
      instrument-failure-as-result mistake this whole harness exists to prevent, caught one layer
      deeper than the original whole-model gate reached.
    - **Recorded honestly, not discarded and not oversold.** `MODEL_BENCHMARKS["@cf/meta/
      llama-3.3-70b-instruct-fp8-fast"].axes` now carries the 3 real cases, with an inline comment
      stating plainly that this is PARTIAL (3/6) and not the model's final classification —
      Discover's own UI already renders whatever `axes` data exists per model, so this shows up
      as real signal (not a placeholder) without claiming completeness it doesn't have. The one
      qualitative finding worth noting: on `agency` (multi-step create-then-verify), the model
      read the project list correctly but never actually called `project.create` — it verified
      nothing rather than creating anything, a partial-credit failure mode distinct from either a
      clean pass or a fabricated-success failure (which `fabrication` separately confirmed it did
      NOT do, 2/2).
    - **Re-armed for the remaining 4 candidate models** (granite-4.0-h-micro, qwen3-30b-a3b,
      mistral-small-3.1-24b, gemma-4-26b), deliberately reordered to breadth-first — every
      still-untested model goes before deepening llama-3.3-70b's own remaining 3 cases, since
      "classify each model" is better served by covering more models partially than one model
      fully while four stay at zero. Same `run-in-background`-tracked watcher pattern as before
      (not a bare `nohup`, which is what silently died once already this session — see item 112's
      own note); this time the harness-tracked background task DID survive and notify correctly
      on completion, which is how this partial result was caught at all instead of being missed.
    2777/2777 tests pass, `npx turbo run typecheck` clean (76 tasks), `packages/billing-core`
    rebuilt (`npx tsc` — required, consumers resolve via `dist/`), `apps/shell` redeployed and
    live-verified (200 on the Discover route; the new axes strings confirmed present in the
    deployed bundle before deploying, same "verify content, not just that the command succeeded"
    discipline this file has documented needing before). **Still not done:** 4 of 5 candidate
    models have zero real data yet, and even the one model that ran has only half its dataset
    scored — the account's demonstrated per-window budget (~1000 usable neurons before recapping)
    means this will take several more opportunistic windows to complete, not one. Do not present
    the current `MODEL_BENCHMARKS` axes data as a finished classification in any future summary —
    it is real, honestly partial, and improving incrementally as quota allows.
115. **A batch of shell UX/backend fixes from live user testing: correct scoping for the shared
     side-panel tabs (item 113), a self-healing continue loop, reload-safe activity trace,
     autonomous-by-default assistant, and a real (not assumed) verification that project agents
     already can't reach space-wide tools.** Model matrix work (item 121/122) was explicitly
     paused on request ("shut the watcher, will do this later") — the background task was stopped
     mid-window, no matrix data changed this pass.
    - **Side-panel tabs are now correctly scoped, not uniformly space-wide.** The data model
      already supported this — `scheduled_jobs.project_id` and `channel_links.project_id` (NULL =
      space-wide) and `notifications.project_id` all predate this pass — the bug was that the
      READ routes never filtered by it and the shared panel (item 113) always called them
      unscoped. Fixed with a `?project_id=X` / `?scope=assistant` convention on
      `GET /scheduled-jobs` (spaces worker) and `GET /assistant/channels` (agents worker): the
      assistant/Home view now sees only its OWN (space-wide) crons/channels, a project thread
      sees only that project's; neither param omitted keeps the prior unfiltered behavior for the
      Dashboard overview and dedicated Assistant page, which want "everything" and predate this
      scoping. Notifications got a `?project_id=` filter too, but the DEFAULT (assistant view)
      stays unfiltered — "all notifications" was the explicit ask, not "just space-wide ones" —
      while a project thread passes `project_id` to scope down. New **Heartbeats** tab
      (assistant-view only, hidden in a project thread — a project agent doesn't run its own
      heartbeat cycle) reuses the already-built `GET /business-analytics` rollup, no new backend.
    - **Project agents already cannot reach `workspace-admin`/`project.create` — verified, not
      assumed, before deciding whether to build a restriction.** Read `launchpadAgentToProfile`
      (Launchpad's core specialist agents) and `agentTemplateToConfig` (the 7 built-in Naelao
      Agent Templates, item 68) end to end: neither ever includes `workspace-admin` or
      `project-coordination` in the prebuilt list a project agent's `ScriptToolSurface` is
      constructed with (`new ScriptToolSurface(env, cfg.scripts.prebuilt)` builds its `ops` map
      ONLY from that list — a real enforcement boundary, not a prompt suggestion; an op not in the
      map is structurally uncallable). Only `DEFAULT_NAELAO_AGENT`/`LAUNCHPAD_ASSISTANT_PROFILE`
      (the Space Assistant) carry those two scripts. No code change was needed here — the
      architecture already matches "project agents can only act within their own project," which
      is worth stating plainly rather than building a redundant guard on top of one that already
      exists.
    - **The Space Assistant is now autonomous (`yolo`) by default for newly-provisioned
      businesses**, not the prior "guided" (`always_ask` + read-only allowlist) default —
      `seedLaunchpadAssistantPolicy` (provisioner) now PATCHes `approval_mode: "yolo"` at
      provision time. The read-only allowlist is still stored (harmless under yolo, and a
      sensible landing point if the owner later dials back to `gate_unless_listed`). Existing
      businesses are unaffected (this only changes the seed, not a live migration) — an owner
      changes their own business's mode via the Dashboard tab or the shell's new Config side-panel
      (below).
    - **Self-healing continue loop, Claude-Code-`/goal`-style.** A failed run used to ALWAYS
      surface the manual `InterruptedRunCard`, even for failures the model can plausibly fix
      itself on a second attempt. `Chat.tsx`'s `refreshInterrupted` now reads the server's own
      `classifyFailure` verdict (already returned as `failure_kind`/`clears_on_its_own` by the
      existing `GET .../agent/interrupted` route — item 92's own classifier, previously only
      driving the wake-up-brief text) and branches three ways: `budget_ceiling` /
      `model_unavailable` / `approval_pending` still show the manual card immediately (these
      genuinely need a human — a spend cap or an unreachable model isn't something to silently
      retry around); a `clears_on_its_own` failure (`quota_exhausted`, `rate_limited`) gets up to
      4 backed-off auto-retries (5s/15s/30s/60s) with a "Waiting for available capacity, then
      retrying automatically (attempt x/4)…" status line, falling back to the manual card once
      exhausted; everything else (`context_overflow`, `step_exhaustion`, `tool_error`, `unknown`)
      gets up to 3 immediate auto-continues ("That didn't work — trying a different approach
      (attempt x/3)…") before falling back — re-entering under the SAME run id each time, so the
      existing action-ledger short-circuit (item 49) still prevents redoing already-completed
      work. A real mutual-dependency ordering problem surfaced building this: the new
      `continueInterruptedRun` needs `attachToRun` (defined later in the component, itself needing
      `streamRun`, which calls `refreshInterrupted`) — broken with an `attachToRunRef` ref
      indirection rather than reordering the whole file. A manual Continue/Dismiss resets the
      auto-heal attempt counters, so a person's own intervention gets a fresh budget rather than
      inheriting an exhausted one. **Not built this pass** (documented, not silently dropped): the
      assistant resolving a STUCK PROJECT AGENT's run on the business's own behalf, proactively,
      during its wake-up cycle — this project thread's own Chat.tsx already gets the SAME
      self-healing (it's one shared component), so a person opening that thread sees it self-heal
      too; what's not built is the assistant reaching into a DIFFERENT thread's stuck run
      unprompted, which needs a new cross-DO op and is a real, separably-sized follow-up.
    - **Activity trace now survives a reload — genuinely durable, not just longer-lived client
      state.** `m.activity` (the "Thought and used 2 tools" collapsible under a completed reply)
      was explicitly documented as CLIENT-ONLY, lost on reload. Fixed at the root: every persisted
      assistant answer (`handleScriptRun`'s `writeAgentAnswerToSession` call) now carries its own
      `run_id` in `messages.metadata` (cheap — the id was already resolved for billing/checkpoint
      purposes at that call site). The trace ENDPOINT itself
      (`GET .../agent/runs/:runId/trace`, §A1 HX1) was builder-only; relaxed to also allow a
      business-member `product_end_user` (the shell's real caller), matching the same
      `requireEndUserBusinessMembership` floor the Sub-agents/Memory/Files panels already use — a
      trace for a run a person's OWN conversation produced is materially different exposure than
      `agent-activity`'s cross-thread audit rollup. New `PersistedActivitySummary` component:
      click-to-load (not auto-fetch-on-mount for every old message, which would burst-request a
      long history for something collapsed-by-default even when live) — renders a "Show activity"
      link that fetches the real trace and hands it to the same `ActivitySummary` component the
      live path uses. The Sub-agents panel's `lastRunId` (previously `lastRun?.id`, which resets
      on reload) now falls back to the last assistant message's own persisted `run_id`, so
      "No run yet in this conversation" no longer wrongly shows right after a refresh when a
      sub-agent genuinely ran in the prior message.
    - **Investigated the reported "asked the assistant to run a sub-agent, saw nothing in the
      Sub-agents section" bug — could not read that specific session's actual content, and that
      is correct platform behavior, not a limitation to work around.** The platform's own
      conversation-access model (item 40/Phase 3's triple-gated endpoint: feature flag + staff
      approval + end-user consent) deliberately returns METADATA ONLY, never message content, and
      there's no builder/JWT credential on file for the reported product's owning tenant to read
      it through the ordinary business-member path either. Rather than build a backdoor around
      that (which would contradict the platform's own stated privacy design), investigated the
      STRUCTURAL side instead: `SubAgentsPanel` was correctly wired but scoped to `lastRun?.id`,
      which is EXACTLY the kind of thing that goes empty after a reload or when reopening a panel
      later — the reload-survival fix above directly addresses the most likely mechanical cause.
      If the symptom recurs, the fastest path is the reporter checking Sub-agents right after
      sending the message (before any reload) — or, if they want it actually decoded here, sharing
      the goal text and outcome from their own DevTools network tab or asking the assistant itself
      whether `agent.spawn` was actually called (traceable now via the reload-safe trace above).
    - **Left sidebar project ordering — a real, confirmed bug, now fixed.** `SpaceDO.listProjects`
      queried `ORDER BY created_at` with no direction — oldest-first, the opposite of the Sessions
      list's own `ORDER BY updated_at DESC`, and never actually using the
      `idx_projects_space(space_id, created_at DESC)` index that was already built expecting DESC.
      A newly-created/relevant project could get pushed behind the sidebar's "show more" collapse
      (item 66) instead of surfacing at the top — exactly the reported "lost in recents order."
      Fixed to `ORDER BY created_at DESC`. `projects` has no last-ACTIVITY column (no writes on
      thread/session use), so this is recency-by-creation, not true last-active; a real
      activity-tracked ordering would need a new column + write path and is a separate, larger
      follow-up if creation-recency isn't good enough in practice.
    2786/2786 tests pass (9 new: crons/channels/notifications scoping in
    `scheduled-jobs.test.ts`/`space-assistant-surface.test.ts`/`spacedo-notifications.test.ts`,
    the trace endpoint's business-member case in `agent-run-trace-endpoint.test.ts`, the project
    ordering fix in `spacedo-project-configurability.test.ts`, plus the autonomous-default change
    in `launchpad-assistant-profile.test.ts`), `npx turbo run typecheck` clean (76 tasks).
    Deployed: `naelao-spaces`, `naelao-agents` (bare `wrangler deploy`, item 83's documented
    trap), `naelao-provisioner`, `apps/shell` (rebuilt with `next-on-pages` + `NEXT_PUBLIC_API_URL`
    in the same command per the documented gotcha, deployed `--branch=main`) — all confirmed live
    (200s on `/p/launchpad/spaces` and `/p/launchpad/new`; the new "Show activity" self-heal
    strings confirmed present in the deployed bundle before calling this done).

116. **Google AI Studio (Gemini) is now a second, genuinely independent LLM provider — a real
     escape hatch when the account's shared Workers AI neuron allowance is exhausted — plus a
     real production bug found and fixed along the way: `script.find`'s embedding call had no
     failure handling and could kill an ENTIRE run regardless of which chat model was selected.**
     - **Routing is a separate path, confirmed live, not assumed.** The account's normal LLM path
       (`shared/ai-client.ts`'s `universalGatewayUrl`, `api.cloudflare.com/.../ai/v1/chat/
       completions`) only accepts third-party (non-`@cf/...`) models under paid Unified Billing —
       this account has none. A real Google AI Studio key is BYOK instead, which needs the OLDER
       `gateway.ai.cloudflare.com/v1/{account}/{gateway}/compat/chat/completions` endpoint, with
       the real Google key riding in the plain `Authorization: Bearer` header (confirmed via
       Cloudflare's own BYOK docs) and `cf-aig-authorization` separately authenticating the
       gateway itself (this account's gateway requires it — confirmed live via a 401 without it).
       New `isGoogleAiStudioModel`/`googleAiStudioGatewayUrl`/`googleAiStudioGatewayHeaders`
       (`ai-client.ts`), and `canAuthenticateLlm` gained an optional `model` param so a Gemini
       model is checked against `googleAiStudioApiKey` specifically rather than the CF token/aig
       token that authenticate every other model — `reasoner.ts`'s `decide()` branches on
       `isGoogleAiStudioModel(query.model)` to pick the right URL/headers pair, with
       `buildUniversalBody`'s own JSON body needing zero changes (it was already provider-agnostic
       — model/messages/tools/reasoning only). New `GOOGLE_AI_STUDIO_API_KEY` secret on
       `naelao-agents`, threaded into `NaelaoAgentDO`'s two `GatewayReasoner` construction sites.
     - **The exact model ids chosen were a live, tested finding, not a style choice.** The
       obvious pick — pinned `gemini-2.5-flash`/`gemini-2.5-flash-lite`/`gemini-2.5-pro` ids —
       failed live: Google had already cut off the ENTIRE 2.5 generation from new-user access by
       the time this was wired (`404 "This model ... is no longer available to new users"`),
       confirmed against the real key for both flash variants; only `gemini-2.5-pro` still
       resolved (a real `429` rate-limit, not a 404 — i.e. genuinely valid, just free-tier-tight).
       Enumerated the account's REAL available models (`GET /v1beta/models`) and confirmed live
       (200 OK) that Google's own `-latest` aliases — `gemini-flash-lite-latest`/
       `gemini-flash-latest`/`gemini-pro-latest` — resolve correctly, alongside several pinned
       3.x-generation ids (`gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.6-flash`), which
       is the generation these aliases currently point to. Switched `ALLOWED_MODELS` to the
       aliases specifically: Google's aggressive generation churn (confirmed within this single
       session) makes a pinned id fragile in exactly the way the aliases are Google's own designed
       answer to, which matters more here than this codebase's usual pinned-id-for-cost-
       predictability convention. Pricing (`computeTokenCostMicro`, `model-benchmarks.ts`) uses
       Google's own published rates for the generation each alias currently resolves to
       (flash-lite $0.30/$2.50, flash $1.50/$7.50, pro $2.00/$12.00 per 1M tokens), honestly noted
       as tracking whatever the alias points to rather than a fixed price forever.
     - **The real bug: `script.find`'s embedding call had NO exception handling and could kill an
       entire run before the reasoner was ever reached, regardless of chosen model.** Reproduced
       live: dispatching a real `/agent/run` (even with `model: google-ai-studio/...` explicitly
       set) 500'd with a raw Workers AI error (`"4006: you have used up your daily free
       allocation of 10,000 neurons..."`) and never reached the reasoner at all — because FIND
       runs algorithmically ahead of any model choice (per the script-native OBSERVE → FINGERPRINT
       → FIND → GATE → EXECUTE → VERIFY → DISTILL doctrine) and used the SAME Workers AI embedder
       either way. `script-find.ts`'s doc comment already promised graceful degradation "when no
       Vectorize index/embedder is wired" but that branch only covered the ABSENT case — when both
       were wired but the underlying `embed()`/`query()` call itself threw at runtime (quota
       exhaustion, a transient outage), nothing caught it. Fixed by extracting the existing
       tag/substring fallback into `degradedScan()` and wrapping the vector-search branch in
       try/catch, falling back to it on ANY failure — this is precisely what makes "switch to
       Gemini and keep working" actually true rather than just true for the reasoning call alone.
       Found and fixed the same gap one layer over: `ScriptToolSurface.create`'s own embed call was
       already guarded, but the `indexScriptEmbedding()` call it makes right after (used by
       `distill`/`patch` too) was not — a script.create succeeding is now never blocked by its
       search-index entry failing to write (a pure index-maintenance step, not the core R2 write);
       `removeScriptEmbedding()` got the same treatment for parity on delete. `memory-os.ts`'s own
       two embed call sites were ALREADY correctly guarded (checked, not assumed) — this was
       specifically a `script-find.ts` gap.
     - **The ComposerDock Effort panel navigation bug is fixed.** Selecting an effort level used
       to call `setPanel("model")` right after committing the choice, bouncing the user back to
       the Models panel; removed, so choosing an effort level now stays on the Effort panel until
       the person manually changes tabs or clicks outside (which the dock already handled).
     - **Live-verified end to end through the real deployed pipeline, not just structurally.**
       Before the `script-find.ts` fix: every model (Gemini AND the default Llama) 500'd identically
       with the raw neuron-quota error, confirming this was a genuine platform-wide bug, not
       specific to Gemini. After the fix: `google-ai-studio/gemini-flash-lite-latest` and
       `google-ai-studio/gemini-flash-latest` both completed real runs end to end
       (`"status":"completed","final_answer":"gemini works"`) through the actual deployed
       `naelao-agents` worker against the live `launchpad` product.
     2811/2811 tests pass (25 new: `gemini-provider-routing.test.ts`'s 22 cases covering routing,
     auth, and full catalog wiring — context window/reasoning capability/cost tier/effort
     ladder/pricing — plus 3 new `script-find.ts` degradation cases and 1 new
     `ScriptToolSurface.create` resilience case in `script-engine.test.ts`), `npx turbo run
     typecheck` clean (76 tasks). Deployed: `naelao-agents` (bare `wrangler deploy`, item 83's
     documented `--env production` trap, twice — once for the routing wiring, once more after the
     model-id correction + script-find fix), `apps/shell` and `apps/dashboard` (both rebuilt with
     `next-on-pages` + their respective `NEXT_PUBLIC_API_URL` conventions in the same command per
     the documented gotcha — shell's bare, dashboard's with `/v1` — deployed `--branch=main`,
     confirmed `environment: "production"` via the Pages API for the shell deploy). **Operational
     note: `GOOGLE_AI_STUDIO_API_KEY` is now SET and LIVE-VERIFIED on `naelao-agents` — do not
     re-prompt the user for it.** Per the user's own note, this is a rotatable dev key ("we renew
     when with development like other keys") — if Gemini calls start 401ing, suspect a rotated key
     before suspecting the code. **Not done:** the model matrix work (items 121/122 in the
     session's own task list) remains explicitly paused per prior user instruction and was not
     touched or resumed this pass; Gemini models are NOT yet run through the capability-matrix
     eval, so they carry no `eval`/`axes` entries on the Discover page, same "don't fabricate a
     score" precedent as every other un-run model.

117. **The chat activity feed is now a real Claude-Code-style sequence — thinking, mid-run
     replies, and tool calls rendered in the ORDER they actually happened, live and after the
     fact, instead of "final reply on top, a collapsed tool list underneath." A real, previously-
     discarded piece of model output (narration alongside a tool call) is now captured and shown,
     and a client-side reveal effect gives arriving text a stream-in feel.**
     - **The real bug: the trace data already recorded true temporal order; only the UI ignored
       it.** `TraceStep`/`run_traces` (§A1 HX1) already persist observe/find/gate/reason/run/answer
       in the exact sequence the loop executed them, each "reason" step already carrying the
       model's own `thinking` when reported (item 83). The client never used that order: a
       completed turn showed the final answer bubble FIRST, then a collapsed "Thought and used N
       tools" summary BELOW it; a live turn showed only the SINGLE most recent step, replacing the
       previous line rather than accumulating a visible history. Neither ever showed a distinct
       "the agent replies, but it's not done yet" moment.
     - **New shared `ActivitySequence` component** (`ActivityFeed.tsx`) replaces both
       `LiveActivityLine` (single line) and `ActivitySummary` (collapsed-after-the-fact) with one
       renderer used both live and persisted, so what you watch happen and what you see on
       reload/re-fetch are the same shape. `mergeSteps()` collapses each phase's "starting" +
       "completed" checkpoint pair (loop.ts's `onProgress` fires both — see its own doc) into ONE
       row, marking whichever step hasn't completed yet as `active` (a pulsing "…" indicator) —
       without this, a live feed would show two lines per step ("Running X…" then "Ran X") instead
       of one row that updates in place. Rendered ABOVE the final answer bubble in `Chat.tsx` now
       (previously below it), matching the real order: thinking → tool → reply → tool → … → final
       answer. A live run always shows at least the current step (even a bare "Observed current
       state" in the first instant, since the person is actively waiting); a persisted/reloaded
       run still hides entirely for a trivial answer-only turn, unchanged from before — a row under
       every simple Q&A would be noise.
     - **The real fix for "no mid-run replies": narration was already being generated by the model
       and discarded, not missing.** With `tool_choice:"required"` (item 68), a model can still
       attach a real text block alongside its `tool_use` — e.g. "I'll check the order list first"
       right before calling `run` — and `normalizeUniversalResponse` already parsed it out as
       `text`, but `reasoner.ts` threw it away the moment the tool call itself resolved into a
       decision. New `GatewayReasoner.lastNarration` (mirrors `lastThinking`'s "read immediately
       after each awaited `decide()`" contract) captures it at all three tool-call resolution sites
       (the `run`/`distill`/`patch`/`give_up` action shapes, the coerced-operation near-miss path)
       — deliberately NOT captured alongside a terminal `answer`/`give_up` decision, since the
       answer text (or give_up reason) already covers that turn and a second narration line there
       would just duplicate it. Threaded through `loop.ts`'s two `pushTrace({phase:"reason", ...})`
       call sites as a new `TraceStep.narration` field (distinct from `thinking`: narration is
       prose written to be read, rendered as an always-visible reply line at the point it happened;
       thinking stays collapsed, exactly like Claude Code's own distinction between a reply and a
       collapsible thinking block). Flows through the SAME live-progress/trace plumbing every other
       `TraceStep` field already used — `NaelaoAgentDO.recordLiveProgress`/the SSE `"activity"`
       relay both spread checkpoint objects wholesale, so no new plumbing was needed beyond adding
       the field to the type. A real, independent, pre-existing gap fixed in passing: the agents
       worker's own local `LiveRunStep` interface (`index.ts`) was missing `thinking` entirely —
       harmless at runtime (TS types are erased, the field already passed through untyped) but
       incomplete; fixed alongside adding `narration`.
     - **A client-side reveal effect for the "not all at once" ask, honestly scoped.** New
       `RevealText` component progressively reveals arriving text (narration, and the live
       streaming/final answer bubble) via a capped-duration `setInterval` — explicitly documented
       in its own code comment as a CLIENT-SIDE typing effect, NOT real token-by-token generation
       streaming (which would need the backend to relay deltas as the model actually generates
       them — a separate, larger, still-deferred architecture change; see item 100's own note on
       this, unchanged). Gated by a new `Message.justArrived` flag (client-only, set exactly once
       when `finalizeAnswer` creates a message from a live run THIS session) so a reload/history
       load never re-animates a message that already happened — `RevealText`'s own internal
       "already shown" state also means a re-render of the SAME component instance never restarts
       an animation it already finished.
     - **Live-verified end to end through the real deployed pipeline** (not just structurally): a
       real dispatched `/agent/run` against the live `launchpad` business (via the new Gemini
       provider, item 116, to route around the account's Workers AI quota) produced a real 7-step
       trace — observe → find → gate → reason(`project.list`) → run(`project.list`) →
       reason(`answer`) → answer — fetched back through the real trace endpoint and confirmed to
       carry the exact field shape the new UI code expects (no crash, no missing-field errors);
       this particular model didn't happen to write narration/thinking text on this run (both are
       genuinely opportunistic — present only when a model writes them, never fabricated), which
       is itself the correct, honest behavior the merge/render logic is built to handle.
     2816/2816 tests pass (5 new: `reasoner-tool-calling.test.ts` gained a
     `lastNarration capture` describe block — captures alongside a non-terminal tool call, captures
     on the coerced-operation near-miss path, does NOT capture alongside a terminal `answer` or
     `give_up`, and resets to `undefined` at the start of a `decide()` call that reports none),
     `npx turbo run typecheck` clean (76 tasks), `apps/shell` verified via a real `next-on-pages`
     build (not just typecheck). Deployed `naelao-agents` (bare `wrangler deploy`, item 83's
     documented `--env production` trap) and `apps/shell` (rebuilt + `--branch=main`, confirmed
     `environment: "production"` via the Pages API); the new component code (`activity-ellipsis`,
     `justArrived`, `Composed a final answer`) confirmed present in both the deployed CSS and JS
     bundles before calling this done. **Not done this pass, same scope line as item 100's own
     note:** true backend token-by-token streaming of the model's own generation — the reveal
     effect built here is a real, honest improvement to how EXISTING text is presented, not a
     replacement for that larger, still-open architecture change.

118. **Real streaming, and the agent now TALKS between tool calls — item 117's two stated
     limitations are both closed.** The user's correction was structural, not cosmetic: Claude Code
     has no hardcoded "tools then one final answer" shape; the model streams as it generates,
     speaks to the user as many times as it decides to, and stops when it judges the job done. Two
     of those three were genuinely missing here.
     - **The reasoning call is now streamed** (`stream: true` + `stream_options.include_usage`,
       new `parseUniversalStream` in `shared/ai-client.ts`). The hard part is that a tool call
       arrives as JSON *fragments* — `{"say":"Let me ch` — so `JSON.parse` is unusable until the
       final chunk, which would defeat the point. New `partialJsonString(buffer, key)` walks the
       buffer by hand and returns whatever of a value has arrived, unescaped, whether or not the
       closing quote has been seen (stopping at a half-arrived `\` or `\uXXXX` rather than emitting
       a character the next chunk replaces). Streaming is **opt-in per call** via a new
       `Reasoner.decide({onDelta})`: an interactive chat passes it, a cron wake / channel drain /
       sub-agent does not, so those keep the cheaper non-streamed path and cannot regress.
     - **Mid-run replies are a first-class tool parameter, not incidental prose.** Item 117
       captured text a model *happened* to attach beside its tool call — but under
       `tool_choice:"required"` many providers suppress free text entirely, so that source is
       unreliable exactly where reliability matters most (the small open-weight models a free-tier
       business runs on). `run`/`distill`/`patch` now each declare a **required `say`**, so it
       comes back through the provider's own constrained decoding every time, and it streams — the
       user reads the sentence before the tool it describes has started. `DECISION_INSTRUCTIONS`
       gained a paragraph telling the model to write it as speech reflecting what it just learned,
       never a stock phrase; the existing "not on a short leash" paragraph absorbed the
       conversation framing (keep going as long as the goal needs, `answer` when YOU judge it met).
     - **Growing text needed a new checkpoint kind.** New `LiveCheckpoint = TraceStep + {partial,
       answer_preview}` (`script-engine/types.ts`) — deliberately NOT on `TraceStep` itself, which
       is the durable record. `NaelaoAgentDO.recordLiveProgress` updates the in-flight step **in
       place** for a partial (or one reasoning turn becomes a dozen rows) and puts a growing answer
       on the RUN as `partialAnswer`, surfaced as `partial_answer` — kept apart from `narration`
       because they land in different places on screen (activity line vs. the reply bubble), and
       merging them would print the answer twice. The SSE endpoint's `lastActivitySeq` filter was
       **wrong** once a step's own text could grow (same seq, more characters — it would send the
       first fragment and silently drop the rest of the sentence); now compares the serialized
       step. Poll cadence 1000ms → 350ms. Client: new `mergeActivitySteps` merges by seq instead of
       appending.
     - **A real robustness hole, found by an existing test rather than by review.** Asking for a
       stream is a request, not a guarantee: a provider or gateway may answer `stream:true` with an
       ordinary JSON body, and reading that as SSE finds no frames — an empty reply, reported as a
       failed turn. That would have broken every interactive run against such a provider.
       `parseUniversalStream` now checks content-type and falls back to whole-body JSON, plus
       salvages a body mislabelled as a stream. `live-activity-feed.test.ts` and
       `sub-agent-effort-escalation.test.ts` both failed on exactly this and passed again the
       moment it was fixed — worth recording that they were pinning real production behaviour, not
       stale assertions.
     - Two more fixes came out of writing the tests: the tail-frame flush moved into `finally` (a
       stream that dies can leave a complete `data:` line that never got its blank line —
       discarding it costs a real answer; verified by reverting and watching the test fail), and my
       own first test was wrong because **`controller.error()` DISCARDS anything still queued**, so
       enqueue-then-error in one tick means the chunk never reaches the reader at all. Use a
       pull-based stream that errors on the second pull.
     - The protocol tripped its own 20,000-char bound again (item 108's precedent). Tightened the
       new paragraphs and trimmed real duplication out of the `progress` paragraph rather than
       relaxing the bound — it is a genuine cost on a 24k-token window.
     - **Live-verified end to end on production, not just in tests.** A real dispatched run against
       the live `launchpad` business returned a 12-step live trace containing `partial: true` steps
       (proving `onDelta` genuinely fired mid-generation) and a real streamed mid-run reply —
       *"Let me check your product listings to see what Lau…"* — recorded at the reasoning step and
       carried onto its completed step. The sequence now reads: observe → find → gate → think →
       **reply** → run `commerce.list_products` → think → answer. Note the first post-deploy run
       showed no narration: CF worker versions propagate across isolates over ~a minute (item 96's
       own documented gotcha), so give a deploy a moment before concluding a change didn't land.
     2839/2839 tests pass (23 new: `reasoner-streaming.test.ts` covering partial-JSON extraction,
     stream parsing, both degradation paths and per-call opt-in; `live-partial-progress.test.ts`
     covering in-place DO merging and the client's `mergeActivitySteps`), `npx turbo run typecheck`
     clean (76 tasks). `naelao-agents` (bare `wrangler deploy`, item 83's documented trap) and
     `apps/shell` (rebuilt + `--branch=main`, `environment: "production"` confirmed via the Pages
     API) both deployed. **Still not done, honestly:** the client reads deltas by polling at 350ms
     rather than holding an open pipe from the DO, so text arrives in ~third-of-a-second chunks
     (smoothed by `RevealText`) rather than token by token. Closing that last gap means either the
     DO exposing its own SSE stream for the worker to pipe, or per-chunk fan-out through the
     already-built `WsHubDO` — a real, scoped follow-up, not claimed here.

119. **Close the tab, come back, and the run is still there with what you missed already loaded —
     plus a real corrupted-answer bug found by testing it.** Item 118 shipped streaming that only
     lived in memory; the user's follow-up named the actual gap: durability and resumption, "not
     something broken."
     - **Why it genuinely did not survive a closed tab.** Live progress and the growing answer sat
       in `NaelaoAgentDO.liveRuns`, an in-memory map that dies with hibernation or eviction; and
       the client's record of "a run is in flight" was in **sessionStorage, per-tab by
       construction**. So the two states a returning person could reach were "nothing appears to
       be happening" and "it finished" — everything in between was lost while the run itself kept
       going. `apps/shell`'s own `chatSession.ts` comment had said exactly this since §A1.27.
     - **The mechanism, which is the same one any resumable stream uses**: persist the output as
       it is produced, let clients read it from a cursor, and make "what is in flight" a
       server-side question. New `run_state` + `run_stream` tables in the agent DO. Deliberately
       NOT an event row per delta — a growing answer is ONE fact that keeps changing, so it is an
       UPSERT on a single row (throttled ~400ms), while a step is a row keyed by its own seq that
       a partial rewrites in place. Writes track real progress, not token count. `run_traces` was
       not reused: it is the finished audit record, written once at the end, and by definition
       holds nothing while the run is the thing you want to watch.
     - `handleGetRun` falls back to storage when memory is empty; new `GET .../agent/active-run`
       answers "is anything running in this conversation?" from the session id alone — the only
       thing a new tab knows — and returns the steps and partial answer **with** the id, so the
       client paints what it missed and then continues, rather than starting blank. A run whose DO
       died mid-flight (nothing ever reports terminal) is aged out after 5 minutes so it is not
       offered as live forever. Delta events gained an `offset` so a reconnect splices rather than
       appends — additive, older clients unaffected.
     - **Three real bugs found while building it, two of them mine:**
       (1) `getDOName(tenantId, secret, "agent", sessionId)` — wrong argument order, so the new
       route addressed a different DO and reported "nothing running" for a run that was very much
       running. Now uses the existing `getAgentDO` helper. Caught by live testing, not review.
       (2) The durable-write throttle clock was shared between partial and step-boundary writes, so
       every step reset it and **the first partial after any step was always dropped** — on a short
       answer, the growing reply was never written through at all. Caught by a test, fixed by
       giving partials their own clock.
       (3) **A live-reported corrupted answer: the chat replied with the literal text `{"`.**
       Root-caused with real captured wire data (temporary `console.log` + `wrangler tail`, then
       reverted): Gemini through the compat endpoint sends a `tool_calls` entry carrying only
       `extra_content.google.thought_signature` and then streams the decision itself as ordinary
       **content**, one token per frame — a shape this parser mishandles, leaving only the first
       token. Rather than guess at each provider's streaming dialect, `decide()` now retries the
       same turn **without streaming** whenever the streamed result is a text beginning with `{`
       (a decision the model was midway through writing is never prose, so this can never
       misfire on a real answer). Terminates by construction — dropping `onDelta` is what makes
       the retry non-streamed. Live-verified: the same prompt that returned `{"` now returns a
       full 2,189-character four-paragraph plan.
     - **Live-verified end to end on production**, from a separate request that knew only the
       session id: at 5s and 10s into a real run it reported `active: true` with 6 recovered steps,
       and `active: false` once the run completed — the close-the-tab case working for real.
     - **Honest limitation worth keeping:** with the corruption guard in place, a Gemini run whose
       stream is unusable falls back to non-streamed, so on THAT provider the activity feed streams
       live but the answer arrives whole at the end. Providers whose streaming parses correctly
       stream the answer too. And deltas still reach the browser by polling (350ms) rather than an
       open pipe from the DO — smoothed by `RevealText`, but not token-by-token. Both remain real,
       scoped follow-ups rather than claimed work.
     2849/2849 tests pass (10 new: `durable-run-stream.test.ts` drives TWO separately-constructed
     DO instances over one shared storage — a second instance is exactly what a hibernated-and-woken
     DO is, so anything that only lived in the first one's memory is genuinely gone; plus 4 new
     unusable-stream-retry cases), `npx turbo run typecheck` clean (76 tasks). `naelao-agents`
     (bare `wrangler deploy`) and `apps/shell` (`--branch=main`, production confirmed via the Pages
     API) deployed.
     - **FOLLOW-UP, same session — the `{"` corruption was root-caused for real, and it was worse
       than a parsing bug: a provider error arriving mid-stream was silently swallowed and the
       truncated output returned as though the call had succeeded.** Proven by replaying the
       VERBATIM captured Gemini wire shapes through the real parser in a test: a `tool_calls` entry
       carrying only `extra_content.google.thought_signature` followed by content tokens parses
       perfectly, so the parser was never the fault. What was: `handleEvent` looked only for
       `choices[0].delta` and ignored an `error` frame entirely. Gemini emitted one token, hit its
       free-tier limit (20 requests/day), sent an error frame, and the fragment `{"` was delivered
       to a person as the agent's reply. `parseUniversalStream` now returns `error`; the reasoner
       retries non-streamed and, failing that, reports the provider's own words. Same treatment for
       an EMPTY stream (a provider closing with no content and no error frame — also observed
       live), which used to surface as "unparseable reasoner output", a message about our parser
       describing nothing anyone can act on. Live-verified: three real long-answer runs now return
       either a full 2,714-character answer or the genuine `429 ... Quota exceeded for metric:
       generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20`.
     - **Correction to this entry's own framing of the transport:** the browser↔Worker leg was
       ALREADY a real open SSE pipe (a `TransformStream` held open in the agents worker) — it is
       the internal Worker→DO leg that polls at 350ms, which is where the chunking comes from.
       Making that leg a stream too is achievable (a DO can return a `ReadableStream` fed by the
       running loop) but is NOT the current bottleneck: step events are seconds apart, and the
       answer does not stream token-by-token on the only provider working on this account, so a
       pipe would carry almost nothing extra today. The upstream parsing/provider behaviour is the
       real constraint; the pipe is the right end-state after it, not before.

120. **Stop button, message queueing, and a second free provider — plus a cancel path that had
     never worked.** `POST .../runs/:runId/cancel` existed end to end, and `handleCancelRun` read
     `agent_runs` — a table only the retired ReAct path ever wrote to. Every real chat message
     since the dispatch cutover is script-native and writes no such row, so **cancel 404'd for
     exactly the runs anyone would want to stop**; nothing in the loop checked a cancel flag
     either, so even a successful status write would have stopped nothing. Cancellation is now
     cooperative and checked once per step: a run finishes the action it is INSIDE (tearing down
     mid-tool-call leaves a side effect nobody can report on) and stops at the next boundary,
     returning what it genuinely completed rather than an error. The flag is durable
     (`run_state.status='cancelling'`), so a cancel landing on a woken instance rather than the
     executing one is still honoured. Only the interactive path passes `shouldCancel` — a cron
     wake or channel drain has nobody watching, and pays nothing.
     **Queueing:** the composer was disabled mid-run, so a thought you had while waiting was
     simply lost. It now stays live; Enter queues, and a drain effect sends queued messages one at
     a time in order once the agent is idle (sending them together would collapse separate
     thoughts into one goal). Stop replaces Send while a run is in flight and the box is empty.
     **Second provider (the real unblock):** Gemini's free tier is 20 requests/day, which is not
     enough to test anything. Researched rather than assumed — **Groq is 14,400 requests/day**
     (30 RPM, no card); Cerebras gives 1M tokens/day but caps context at 8,192, which this
     platform's own ~4-5k-token system prompt plus payload would overflow constantly, so it is
     disqualified for this use; OpenRouter free is 50/day without a prior purchase. The gateway's
     `compat/chat/completions` route turned out to be GENERIC BYOK — it infers the provider from
     the model-id prefix — so the Gemini path was generalized into a `BYOK_COMPAT_PROVIDERS` map
     (prefix → which `GatewayOpts` field holds that provider's key) rather than duplicated.
     Adding a provider is now a map entry plus a secret. `GROQ_API_KEY` is wired through the DO
     env at both reasoner construction sites. **Not done: no Groq model ids added to
     `ALLOWED_MODELS` yet** — item 116's lesson was that pinned ids go stale silently (Google had
     already killed the whole Gemini 2.5 generation), so the catalogue entries wait until a real
     key exists and `GET https://api.groq.com/openai/v1/models` can be enumerated live.
     2859/2859 tests pass (5 new in `run-cancellation.test.ts` — a relentless reasoner that would
     never stop on its own, proving the stop is what ends it; a cancel accepted for a run with no
     `agent_runs` row; and a cancel honoured by a SECOND DO instance, which is what proves the
     flag is durable rather than in-memory), `npx turbo run typecheck` clean (76 tasks).
     `naelao-agents` and `apps/shell` deployed. **Not live-verified end to end:** Gemini's daily
     quota was exhausted by this session's own debugging, so the Stop button has not been pressed
     against a real long-running production run — the cancellation logic is proven at unit level
     against the real DO and the real loop, not in a browser.

121. **Groq added as a fourth, curated LLM provider — and the Stop button, root-caused for real
     this time, is now genuinely functional on the path every real chat message actually takes.**
     Two independent asks in one session, both closed with live proof, not just passing tests.
     - **Groq.** Enumerated the account's real model list (`GET api.groq.com/openai/v1/models`)
       rather than guessing, and confirmed each candidate against Groq's own docs before adding
       it: `openai/gpt-oss-120b`/`-20b` (`reasoning_effort` low/medium/high — the SAME field
       gpt-oss already uses on Workers AI, confirmed independently for the Groq-hosted copy, not
       assumed from the shared model name) and `qwen/qwen3.6-27b` (`reasoning_effort`, but a
       genuinely different 2-level shape: `none`/`default`). Routing needed zero new code — the
       prior session's `BYOK_COMPAT_PROVIDERS` map (built for Gemini) is already generic over
       provider prefix, and `groq/` is Cloudflare's own literal provider slug for the compat
       endpoint (confirmed via Cloudflare's AI Gateway docs, not assumed). `groq/openai/gpt-oss-120b`
       was dispatched live TWICE through the real deployed reasoning loop and failed both times
       with `"attempted to call tool 'json' which was not in request.tools"` — independent of
       reasoning effort (tried low and high) and not a rate-limit (a separate, distinct 429 was
       also observed) — the SAME model family that already fails the tool contract on Workers AI
       (see item 112's own eval finding for `@cf/openai/gpt-oss-120b`), a second independent
       hosting provider reproducing the identical failure. Excluded it rather than ship a known-
       broken catalogue entry; the other four (`groq/openai/gpt-oss-20b`,
       `groq/llama-3.3-70b-versatile`, `groq/llama-3.1-8b-instant`, `groq/qwen/qwen3.6-27b`) each
       completed a real `/agent/run` end to end. Real per-1M-token pricing pulled straight from
       Groq's own `pricing.prompt`/`pricing.completion` fields, wired into `computeTokenCostMicro`
       and `MODEL_BENCHMARKS` (`costBasis: "measured"`, not estimated). Also discovered and
       recorded: Groq enforces a much tighter PER-MODEL tokens-per-minute cap alongside the
       headline 14,400/day figure (observed live: 8000 TPM on gpt-oss-120b, 6000 TPM on
       llama-3.1-8b-instant) — a burst of testing can 429 well before the daily count is anywhere
       near exhausted; noted directly on the gpt-oss-20b benchmark entry so a future session
       doesn't waste time re-diagnosing it as a routing bug. `GROQ_API_KEY` is now SET and
       LIVE-VERIFIED on `naelao-agents` — do not re-prompt the user for it. Effort-ladder/
       escalation-ceiling wiring (`effort.ts`) needed zero changes — it derives everything
       generically from `MODEL_CAPABILITIES`/`costTier`, so the four new Groq models integrate
       into the existing Effort dock button automatically.
     - **Stop button — the REAL root cause, found by tracing the actual dispatch path rather than
       trusting the prior session's own "5 new tests pass" claim.** `handleStop`/cooperative
       cancellation (built the prior session) was correct in every particular EXCEPT one: it was
       never reachable. `/internal/tasks/:taskId/run` — the route `AgentTaskWorkflow` calls for
       EVERY ordinary chat message, since `apps/shell` never sends `Prefer: respond-sync` (Phase
       Q's durable-by-default async dispatch is the only path a real user's message takes) —
       forwarded a body to the agent DO's `/script/run` handler WITHOUT `runId`. That handler
       resolves `const runId = body.runId ?? crypto.randomUUID()`, so every single async-
       dispatched run got a fresh, random, INTERNAL-ONLY id — completely disconnected from
       `taskId`, which is the id the client actually receives as `run_id`/`id` and sends back to
       `POST .../agent/runs/:runId/cancel`. The cancel request landed on the correct DO instance
       (addressing was never the problem) but for an id nothing inside that DO was tracking, so
       `isCancelRequested` could never return true and the loop never saw it — a complete,
       silent no-op for the ONE dispatch path that matters. The synchronous (`Prefer: respond-
       sync`) path a few lines above had already threaded `runId: scriptRunId` correctly; only
       the async path was missing it. One-line fix: `runId: body.taskId` in the forwarded body.
     - **The Continue-dialog ask, closed with a new failure kind, not a UI-only patch.** The
       loop's cancellation exit (built the prior session) returned `ok: true` — a stop was
       therefore indistinguishable from an ordinary completed answer, so `NaelaoAgentDO`'s
       `if (result.result.ok === false) persistInterruptedRun(...)` never fired and no offer to
       Continue was ever created. Changed to `ok: false` with a new, exact, stable marker string
       (`error: "Stopped by you before finishing."`) — `output` still carries the human-readable
       "Stopped. I had already finished: X" summary, still written into the transcript exactly
       like any other answer (`NaelaoAgentDO` checks for a non-empty `output`, not `ok`), so
       stopping now produces BOTH a real message in the thread AND a durable Continue offer.
       New `FailureKind = "user_cancelled"` in `@naelao/events`' `classifyFailure`
       (`clears_on_its_own: false`, `agent_actionable: false` — a stop is not something waiting
       or a smarter retry can fix; only the person decides whether to continue), matched on the
       exact marker string, placed FIRST in the rule list so a run stopped mid-tool-call can't
       have its incidental half-finished-call text wrongly match a different, unrelated rule.
       Added to Chat.tsx's `MANUAL_ONLY_FAILURE_KINDS` — the exact mechanism that answers "when I
       refresh it doesn't retry since I stopped it": that set is what the self-heal loop already
       checks BEFORE ever attempting an auto-retry, so a stopped run is now structurally
       incapable of being auto-continued, on refresh or otherwise. Two small, deliberate UI
       refinements riding on the same classification: the generic red error banner is suppressed
       specifically for this marker (the InterruptedRunCard already says the same thing, with a
       Continue button — showing both was pure duplication), and the card's own header reads
       "Stopped" instead of "This didn't finish" for this one kind (a stop is not a failure).
       Also suppressed the "run couldn't finish" push notification specifically for
       `user_cancelled` (the person doing the stopping is right there, watching — the audit-trail
       `logAgentActivity` row is untouched, only the noisy notification is skipped).
     - **Root cause proven, not assumed — a new regression test that reverting the fix was
       confirmed to fail** (`internal-task-run-forwards-runid.test.ts`, drives the REAL Hono app,
       captures the exact body the agent-DO stub receives, asserts `runId === taskId`).
       **Then proven live on production, twice, end to end**, since the account's Workers AI
       quota was capped for ordinary testing (a real dispatched run against the default model
       hit `4006` almost instantly, before there was any window to cancel): dispatched a real
       async run on `groq/llama-3.1-8b-instant` (Groq's separate quota sidesteps the Workers AI
       cap), cancelled it via the exact route the client uses, and polled the real, deployed
       worker — `status:"failed"`, `error:"Stopped by you before finishing."`, the live trace
       showing the precise `give_up`/"stopped by the user" checkpoint, and
       `GET .../agent/interrupted` returning `failure_kind:"user_cancelled"`,
       `clears_on_its_own:false`, and the exact explanation text — proving the fix,
       classification, and Continue-offer chain all actually work together against the real
       deployed system, not just in isolation.
     2861/2861 tests pass (2 new: the runId-forwarding regression above, plus a new
     `classifyFailure` case pinning the literal marker string), `npx turbo run typecheck` clean
     (76 tasks), `apps/shell` verified via a real `next build`. `naelao-agents` (bare `wrangler
     deploy`, item 83's documented `--env production` trap) and `apps/shell` (rebuilt +
     `--branch=main`, confirmed `environment:"production"` via the Pages API, and the deployed
     chunk confirmed byte-identical via md5sum to the local build containing the fix) both
     deployed. **Not done this pass:** the model matrix work (items 121/122 in the session's own
     task list — a separately-tracked, still-paused effort predating this work) was not touched;
     Groq models carry no `eval`/`axes` entries yet, same "don't fabricate a score" precedent as
     every other un-run model.
122. **A large batch of live-reported chat UX bugs and gaps: tool-call rendering grouped and
     enriched (Claude-Code-style), self-heal retry made reload-safe, Stop functional during a
     retry wait, heartbeat sessions made durable and browsable, project "recent" ordering fixed
     for consult activity, subthread sidebar polish, and the anti-fabrication instruction
     hardened.** Per explicit instruction, this pass deliberately dispatched NO live `/agent/run`
     calls to verify any of it — verification is tests/typecheck/build/deploy-health only; the
     user tests the live behavior themselves.
     - **Activity sequence rewrite** (`apps/shell/src/components/ActivityFeed.tsx`). Previously a
       flat per-step row list with no grouping — every narration line stacked, no distinction
       between "still working on the same tool-call run" and "the model actually replied." New
       `groupSteps()` splits the merged step list into SEGMENTS, breaking only at a real
       `answer`/`give_up` step (that reply is rendered by the message bubble itself, not a row
       here): within a segment, the LATEST narration overrides any earlier one as the always-
       visible italic headline (never stacked), and every tool call/thought in that segment
       collapses into ONE running summary ("1 tool running…" → "N tools · Y thoughts") whose body
       is a one-column table of tool calls — Claude Code's own pattern. Each row expands to show
       the real command (`params`) and result (`output`/error), not just duration/tokens. Per-
       phase emoji icons (`phaseIcon`) removed outright, per explicit ask.
     - **Tool params/output threaded end to end** (`script-engine/loop.ts`, `types.ts`, agents
       `index.ts`, `apps/shell/src/lib/api.ts`): `pushTrace`'s two "run"-phase call sites (L1 fast
       path + the main L3/L4 loop) now carry `params` (the real arguments) and a size-capped
       (`formatToolOutput`, 4000-char cap) stringified `output` on success — previously only
       `detail`/`duration_ms`/`tokens`/`ok` reached the client, so expanding a tool call showed
       none of "the command and the result" the user compared to Claude Code's cmd-tool view.
       `distill`/`patch`'s own two "run" pushes were deliberately left unenriched (scoped down —
       `applyTerminalDecision` doesn't share `runScriptLoop`'s closure, and those are the rarer
       write paths, not the everyday tool-call one).
     - **`run_traces` persistence gap closed** (`NaelaoAgentDO.ts`): the table only ever had
       `run_id, seq, phase, name, tier, duration_ms, tokens, ok, detail, ts` — `narration`/
       `thinking` were silently DROPPED at persistence despite `TraceStep` always carrying them,
       which is why a reload could never show what the model said mid-run or its chain-of-
       thought, only bare tool-call metadata. New nullable columns `narration, thinking, params,
       output` (the established `try { ALTER TABLE ... ADD COLUMN } catch {}` idempotent-migration
       pattern this DO already uses elsewhere), wired through both `persistRunTrace` and
       `readRunTrace`. `run_stream`'s own durable-live-view table needed no change — it stores a
       whole `step_json` blob per checkpoint, so the new fields flow through automatically.
     - **Self-heal retry: reload-safe, and Stop actually stops it.** `refreshInterrupted` was ONE
       function used both on every mount (unconditional) AND from a live poll/stream failure, with
       its retry-budget refs reset on every `chatSessionId` change — so a page reload could re-arm
       a full fresh round of auto-heal/quota-retry attempts against an already-exhausted or
       already-stopped interruption, exactly the reported "it auto-retries x/4 on refresh even
       though I already stopped it." Split into `checkInterruptedRun` (mount-safe, passive — shows
       the durable dialog if one exists, NEVER starts a retry timer) and `handleLiveFailure` (the
       full chain, called only from the two live failure branches). New `stopPendingRetry`: the
       Stop button's visibility condition widened to also show during `selfHealStatus.mode ===
       "waiting"` (previously invisible exactly when a retry was pending, since `isLoading` is
       false throughout that window), and clicking it during a wait clears the pending timer,
       exhausts both retry budgets so nothing can re-arm, and shows the interrupted-run dialog
       immediately with `failure_kind: "user_cancelled"` and reason "Retry stopped by you." —
       reusing `InterruptedRunCard`'s existing "Stopped" header for that kind rather than a new UI.
     - **Heartbeat/cron-wake sessions made real and durable.** `wakeAgentGoal` minted a synthetic
       `` `scheduled-job-${Date.now()}` `` id that was NEVER registered via `POST /spaces/:id/
       sessions` — every subsequent `writeAgentAnswerToSession` write 404'd against SpaceDO's
       `appendMessage` (which requires the session to already exist) and was silently swallowed,
       so nothing a heartbeat wake ever said was durably recorded anywhere. New
       `createHeartbeatSession` (agents `index.ts`) mints a REAL session with
       `metadata: {session_kind: "heartbeat", title}` before dispatching, falling back to the old
       synthetic id on any failure (never blocks the wake). `SpaceDO.listSessions` gained a `kind`
       query param (`json_extract(metadata,'$.session_kind')`): default excludes heartbeat
       sessions from the ordinary recents list; `?kind=heartbeat` returns only them — the ONLY two
       places they're meant to surface (the Sessions page's new filter tab, and a new session list
       on the Heartbeats sidebar tab, both calling this explicitly). **A real bug found and fixed
       in the same pass**: the spaces worker's `GET /sessions` proxy (`workers/spaces/src/
       index.ts`) rebuilds its own query string from scratch for the list route (only forwarding
       `end_user_id`/`limit`) — a new `?kind=` param would have been silently dropped at this
       layer even with the DO-side filter correct; added explicit `kind` forwarding (allowlisted
       to `"heartbeat"` only, matching the existing `limit` pattern). Sessions page
       (`apps/shell/.../sessions/page.tsx`) gained a Sessions/Heartbeat-sessions tab toggle and an
       instant client-side title search (a real backend content-search-by-keyword-in-messages
       route was explicitly scoped OUT this pass — documented, not silently dropped). New
       `promoteSessionIfHeartbeat` (api.ts): the first message sent into a session opened by
       explicit id (the `sessionId` prop, never a fresh Home/thread session) clears
       `metadata.session_kind` if it was `"heartbeat"` — reading current metadata first since
       `updateSession`'s PATCH replaces the whole object, not a merge — so it starts appearing in
       the ordinary Sessions list like any other conversation, guarded to fire at most once per
       mount.
     - **Project "recent" ordering — migration v37.** `listProjects` already ordered
       `created_at DESC` (item 115's own fix) but had no real activity tracking, so an assistant↔
       agent consult (or any thread activity) never bumped a project back to the top — the
       reported bug. New `projects.last_activity_at` (nullable), touched from ONE choke point,
       `SpaceDO.appendMessage` (every message write — ordinary project chat AND consult subthread
       messages alike already land here), by resolving the project via `threads.project_id` for
       the session and forward-looking `UPDATE projects SET last_activity_at = ?`. `listProjects`
       now orders `COALESCE(last_activity_at, created_at) DESC`. No `NaelaoAgentDO`-side change
       needed — the fix is entirely inside the one shared write path.
     - **Consult subthread sidebar polish.** `SubthreadPanel`'s list is now scrollable
       (`max-height` + `overflow-y`) for a project with many consults. New `consultAnchorId`/
       `scrollToConsultCard`: the sidebar's "Assistant" tab entries gained a jump (↗) button that
       scrolls to and briefly CSS-highlights (`.consult-highlight`, `packages/ui/src/styles.css`)
       the matching INLINE card already rendered in the main thread transcript (item 79's own
       mechanism, already correct — investigation confirmed inline consult cards already render at
       the right timestamp with the right per-interruption separation; only the sidebar's link
       back to that exact spot was missing).
     - **Fabrication hardening, scoped honestly.** Investigated a reported case where the
       assistant claimed "the thread is fully active" when no thread actually existed. Root cause:
       `agent.consult`/`thread.create` genuinely work and only log a `consulted_threads` entry
       when a real `thread_id` comes back — the gap is that NOTHING stops the model from answering
       `{"action":"answer",...}` on its very first turn with zero prior `run` calls, and
       `applyTerminalDecision` trusts that text verbatim. Unlike item 108's `commerce.
       create_product` case (a missing CAPABILITY), this is pure model-compliance — the capability
       already exists. Tightened `DECISION_INSTRUCTIONS`' anti-fabrication paragraph with one
       short added clause naming "I've connected/set up/activated X" explicitly (kept within the
       documented ~20,000-char protocol budget — a first draft tripped the bound at 20,121 chars,
       trimmed to fit). **Deliberately NOT built**: a structural zero-run-answer gate for "action-
       shaped" goals — that needs goal-language pattern-matching and live-model tuning to avoid
       false positives on genuinely answer-only goals, which the "no AI credits" constraint rules
       out verifying this pass; flagged as a real, larger follow-up, not silently dropped.
     2861/2861 tests pass, `npx turbo run typecheck` clean (76 tasks), `apps/shell` verified via a
     real `next build`. Deployed: `naelao-agents` (bare `wrangler deploy`), `naelao-spaces` (bare
     `wrangler deploy`), `apps/shell` (`next-on-pages` + `wrangler pages deploy --branch=main`,
     confirmed `environment:"production"` via the Pages API). Post-deploy verification deliberately
     limited to non-LLM liveness checks (200s on the shell's `/spaces`/`/new` routes, a 401-not-500
     from the agents worker's cancel route, 200 from the router's by-slug lookup) — no `/agent/run`
     dispatched, per the explicit "use my own credits to test" instruction. **Not done this pass:**
     a real backend content-search-by-keyword route for the Sessions page search bar (client-side
     title filter only); the structural fabrication-prevention gate; a live browser click-through
     of the new grouped activity UI (same standing Playwright/TLS-handshake limitation as every
     prior UI pass in this session).

123. **Two real gaps in item 122's own activity feed, both found by the user comparing it directly
     against Claude Code's own UI: reload still hid the sequence behind a click, and every
     narration message but the LAST one in a tool-call chain was silently discarded rather than
     shown as a progress trail.**
     - **Reload no longer hides the trace behind "Show activity".** `PersistedActivitySequence`
       required a manual click before fetching a completed run's trace — so a reload visibly
       regressed a message from "the full sequence, right there" to "click to maybe see it again,"
       backwards from how a message read while it was actually streaming. Now auto-fetches on
       mount and renders in the exact same grouped shape (narration trail + collapsed tool table)
       the live view used. Cost accepted deliberately: a long conversation now fires one trace
       request per past assistant message on mount, not hidden as a tradeoff.
     - **The real bug behind "it's just tool call after tool call, not enough":** `groupSteps` kept
       only the MOST RECENT `say` per segment (`current.narration = step.narration` — later wins,
       earlier silently dropped), even though the reasoning loop can attach a real `say` to every
       single reasoning turn in a multi-tool-call chain (`loop.ts`'s two `pushTrace({phase:
       "reason", narration: ...})` sites, one per turn). So on any chain longer than one tool call,
       every message the model wrote along the way except the last was thrown away before it ever
       reached the screen — reading exactly as "tool call after tool call" with nothing telling you
       what was found in between, even though the model HAD been talking the whole time. Fixed by
       keeping the full ordered list (`NarrationEntry[]`, not a single overwritten field): every
       prior narration renders as a small dimmed trail line, the current one keeps the original
       prominent italic style and is what animates live. `DECISION_INSTRUCTIONS`' own ~20,000-char
       protocol budget (items 108/118) had zero headroom left for new prose in the main paragraph
       — confirmed empirically (a small addition there pushed `composed.length` to 20,402 against
       the hard 20,000 cap) — so the "report what you learn, not just what runs next" instruction
       was moved to `SAY_PARAM`'s own per-call description instead, which is NOT counted by that
       budget test (it's a tool-schema field, not part of the composed system-prompt string) and is
       arguably the more directly-consulted text anyway, since it's what the model reads at the
       exact moment it's filling in that specific field.
     2861/2861 tests pass (no regressions — this was a rendering-layer + prompt-text change with
     no new backend surface), `npx turbo run typecheck` clean (76 tasks), `apps/shell` verified via
     a real `next build`. `naelao-agents` (bare `wrangler deploy`) and `apps/shell` (rebuilt +
     `--branch=main`, confirmed `environment: "production"` via the Pages API) both deployed and
     verified via non-LLM liveness checks only — no `/agent/run` dispatched, per the user's own
     "don't use my AI credits, I want to test it myself" instruction carried forward from the
     previous pass.

124. **Item 123 got the fix backwards and a screenshot proved it: keeping every narration produced
     a wall of fifteen near-identical italic lines above one collapsible. The real problem was
     that ONE field was doing two jobs — now split into `doing` (a per-action status) and `say`
     (a real message), which is what the Claude Code shape the user compared against actually
     requires.** The original ask was override-within-a-group; item 123 read the symptom
     ("tool call after tool call, not enough") as "show more" and stacked them instead. Both
     framings were wrong, because a per-tool-call line can only ever be a status — a message
     before every action is noise whether you stack it or overwrite it.
     - **`doing`** (`DOING_PARAM`, REQUIRED on `run`/`distill`/`patch`): a few words naming what
       THAT action does. Replaced by the next action's own — nobody scrolls back to read a status.
       Renders as one dim italic line above the segment's collapsible.
     - **`say`** (`SAY_PARAM`, now OPTIONAL): a real message that stays in the conversation and
       renders at full weight in normal prose, exactly like the final answer. It BREAKS the tool
       group, so a run reads message → tool calls → message → tool calls → answer. The instruction
       is explicit about when: before the first action, and again when what was just learned
       changes what happens next — never one per action, since each now describes itself.
     - Wired end to end: `Reasoner.lastMessage` alongside `lastNarration` (both reset per turn —
       without the reset every later step re-renders the same message, which a test now pins);
       `TraceStep.message`; a `message` column on `run_traces` so it survives reload; both fields
       streamed via `partialJsonString` so they arrive as written; `groupSteps` reverted to
       latest-wins narration plus a new `message` grouped item.
     - The ~20,000-char protocol budget (items 108/118/123) bit twice more — the new paragraph
       had to be trimmed to fit rather than the bound relaxed, and the `say` guidance that
       wouldn't fit lives in `SAY_PARAM`'s own description, which isn't counted by that test.
     - 6 new tests across `reasoner-tool-calling.test.ts` (routing, status-only turns, `doing`
       preferred over incidental prose, no message carried across turns) and
       `reasoner-streaming.test.ts` (both fields streaming separately). **The cross-turn one was
       verified to genuinely catch a regression** — temporarily removing the `lastMessage` reset
       fails it, exactly as intended.
     2866/2866 tests pass (6 new), `npx turbo run typecheck` clean (76 tasks), `apps/shell`
     verified via a real `next build`. `naelao-agents` (bare `wrangler deploy`) and `apps/shell`
     (`--branch=main`, production confirmed via the Pages API) both deployed. Verified via non-LLM
     liveness checks only — no `/agent/run` dispatched, per the user's standing "don't use my AI
     credits, I want to test it myself" instruction.

125. **Project-thread workspace scoping was silently broken (a one-line frontend gap that defeated
     R2/KB/Memory-OS/journal scoping all at once), the intermittent missing tool-call table is
     root-caused and fixed, Composio tool calls were hitting a dead v2 API, and the assistant
     gained real thread CRUD/chat parity with what a human user can do.**
     - **Workspace scoping.** `workspacePrefix()` (script-engine/types.ts) has always correctly
       resolved a project-scoped vs. space-wide R2 path from `ScriptEngineEnv.projectId` — and
       every project-scoped primitive keys off the SAME field (Memory OS's `buildScriptEngineEnv`
       wiring, the Project Journal's `requireProject`). The backend has ALSO always correctly
       forwarded `project_id` on both dispatch paths (`/agent/run`'s sync + async Workflow
       branches) since it was introduced. The single, real bug: `apps/shell`'s `sendMessage()`
       (the function every chat send in the product goes through) never included `project_id` in
       its request body at all — confirmed by reading the function, not assumed — so EVERY tool
       call a project-thread's agent made (file read/write, KB search, memory recall, journal
       read/write) silently fell back to the Space Assistant's space-wide scope. Uploads
       themselves were never affected (`uploadChatFiles`/`ComposerDock` already threaded
       `projectId` correctly) — the bug meant the AI's OWN tool calls, including reading a file
       the person had just correctly uploaded, ran in the wrong place. Fixed with one field
       (`RunModelOptions.projectId`) threaded from `Chat.tsx`'s existing `projectId` prop (already
       passed down from the project-thread page — confirmed via `ProjectThreadPage`) through
       `sendMessage` into the `/agent/run` body. No backend change needed — the whole chain was
       already correct once the client actually sent the field.
     - **Intermittent missing tool-call table, root-caused.** Reported as "shows the description
       ('Reading the cf-naelao.md.txt file.') but no table underneath, sometimes." Traced to
       `loop.ts`: whenever an action is parked pending approval
       (`pushTrace({phase:"gate", name, detail:"deferred_pending_approval"})`) or skipped because
       the run hit its final step, the "gate" trace step has NO corresponding "run" entry — and
       `ActivityFeed.tsx`'s `groupSteps` treated ANY `phase:"gate"` step (both this per-action kind
       and the once-per-run "Chose approach: L3" kind) as a segment-closer, discarding the pending
       segment's tool rows and leaving the narration ("Reading the X file") orphaned with nothing
       in the table. Fixed on both ends: `loop.ts` now (a) attaches `params` to the
       `awaiting_approval`/`deferred_pending_approval` gate pushes (previously bare), and (b) adds
       a NEW `skipped_final_step` gate push for the "chose a tool on the deadline, not run"
       case (previously silent — the closing-summary reasoner call that follows never pushes its
       own trace step, so nothing else could have caught this). `groupSteps` now only treats an
       UNNAMED gate step (the once-per-run kind, no `name` field) as a segment-closer; a NAMED
       one (a specific parked/skipped action) becomes an in-segment row instead, rendered by
       `ToolRowView` with a distinct amber "waiting for approval"/"skipped — ran out of time"
       badge (never the red "failed" a genuinely-attempted-and-errored call gets) and its own
       `segmentHeader` count (e.g. "2 tools · 1 waiting").
     - **Composio tool calls were dead — hitting a v2 API Composio has moved off.**
       `mcp-hub/src/index.ts`'s `composioToolCall`/`composioListTools` still posted to
       `backend.composio.dev/api/v2/actions/...` (`connectedAccountId`/`input` body shape) while
       `connectors/composio.ts`'s own CONNECT flow was already correctly updated to v3 for the
       OAuth handshake — so a connection could succeed and every actual tool call/list against it
       would still fail. Confirmed against Composio's real, LIVE OpenAPI spec (`GET
       https://backend.composio.dev/api/v3/openapi.json`, fetched directly — not assumed): the
       real endpoint is `POST /api/v3/tools/execute/{tool_slug}` with body
       `{connected_account_id, arguments}` (not `connectedAccountId`/`input`), returning
       `{data, error, successful}` — a 200 with `successful:false` is still a failure and is now
       treated as one. Listing moved from "list by connection" (no longer exists in v3) to "list
       by toolkit" (`GET /api/v3/tools?toolkit_slug=`) — `composioListTools` now resolves the
       connected account's own toolkit slug via `GET /api/v3/connected_accounts/{id}` first (one
       extra call, degrades to an empty list rather than crashing if either call fails).
     - **Assistant thread parity — everything a human can do with a thread, not just read one.**
       `project-coordination.ts` gained `thread.rename`/`thread.delete` (there is no hard delete —
       matches `project.configure({status:'archived'})`'s own convention; a new SpaceDO
       `PATCH /threads/:id` route was needed, since none existed at all before this — `threads`
       already had a `status` column with no CRUD ever built for it) and `thread.search` (a real,
       honest TITLE-only match — the same level of "search" the shell's own Sessions page has;
       full message-content search stays a documented, not-yet-built gap, matching that page's own
       precedent, rather than silently overclaiming). The bigger gap: `agent.consult` only ever
       posts into a NEW, hidden `thread_kind='sub_agent'` subthread — there was no way for the
       assistant to just chat inside an EXISTING, visible thread the way a person does. New
       `thread.send_message` (+ a new `OrchestrationHooks.sendToThread` hook and
       `NaelaoAgentDO.sendToThreadImpl`, mirroring `consultAgentImpl`'s DO-to-DO dispatch pattern
       but writing into the GIVEN thread's own session instead of minting a subthread) posts the
       assistant's message into a real thread and — unless `respond:false` — dispatches the named
       agent to reply there, visibly, exactly as `@mention` dispatch already does when a human
       types it. `agent_id` is required to get a reply (no attempt to guess "the project's default
       agent" — same contract `agent.consult` already has). Both assistant profiles updated to
       explain when to use which (visible chat vs. private coordination). PATCH's business-role
       gate defaults to admin for a `product_end_user` caller (same convention `/projects/:id`'s
       own PATCH already established, verified directly against the real gate).
     2898/2898 tests pass (32 new: PATCH-thread coverage at both the raw SpaceDO level and the full
     HTTP/business-auth level; `composio-tool-execution.test.ts` pins the exact v3 request/response
     shape against a mocked fetch layer; new `project-coordination-prebuilt.test.ts` cases for all
     four new ops; a new `send-to-thread-orchestration-hook.test.ts` drives the REAL
     `sendToThreadImpl` via `buildOrchestrationHooks`, not a hand-rolled substitute — caught a real
     bug before it shipped: `thread.rename`/`thread.delete` were non-`async` arrows that threw
     synchronously, the same `PrebuiltOp` contract violation item 78 already documented once),
     `npx turbo run typecheck` clean (76 tasks), `apps/shell` verified via a real `next build`.
     `naelao-agents` (bare `wrangler deploy`), `naelao-spaces`, `naelao-mcp-hub`, and `apps/shell`
     (`--branch=main`, production confirmed via the Pages API) all deployed and verified via
     non-LLM liveness checks (dry-run bundle check before deploying, health-check curls after) —
     no `/agent/run` dispatched, per the user's standing "don't use my AI credits" instruction.
     **Not done this pass:** a live click-through of the fixed activity-table rendering or a real
     Composio connect+call round trip against a live account (both would need either a real agent
     dispatch or a builder JWT session this pass didn't have on hand) — verified instead via the
     unit tests above, which drive the real request/response contracts directly.

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
- LLM: Cloudflare AI Gateway is the LLM path — the gateway HOLDS the Anthropic provider key
  (Authenticated Gateway / BYOK via `NAELAO_AIG_TOKEN`), so no `ANTHROPIC_API_KEY` lives on any
  worker (item 45). Claude is primary with a gateway-driven fallback chain.
- PLATFORM billing (Stripe removed — item 45): Naelao's own normal Whop seller account is tried
  FIRST for builder platform plans (item 58), Lemon Squeezy is the fallback. End-user
  subscriptions/credit-packs try the business's own connected Whop company (OAuth-delegated,
  item 58) first, then LS, then a dev placeholder.
- Whop is the business-bank-account rail (item 50, replacing item 49's Stripe/LS Wallet Connect):
  every business auto-provisions an isolated Whop sub-merchant wallet at creation — no builder
  action. This is BUSINESS revenue custody, a different thing from Naelao's own platform billing
  above.
- Next.js on CF Pages (builder dashboard)

## DO SQLite Pattern — CRITICAL
```ts
// CORRECT — ? placeholders only
this.ctx.storage.sql.exec("SELECT * FROM t WHERE id = ?", id);
// WRONG — named params do not exist in DO SQLite
this.ctx.storage.sql.exec("SELECT * FROM t WHERE id = :id", { id });
```
**Never run PRAGMA statements at DO init** (`journal_mode`, `synchronous`, `cache_size`, etc.) —
Cloudflare's real SQLite-backed DO storage rejects them with `not authorized: SQLITE_AUTH`,
throwing on the DO's very first call in production (confirmed live via `wrangler tail` — item 62
below). The test suite's SQLite shim does not enforce this restriction, so this was baked into
every one of the platform's ~12 DO classes and never caught by ~1900 passing unit tests. This
line used to say the opposite ("WAL mode: `PRAGMA journal_mode=WAL` at DO init") — that guidance
was wrong; do not reintroduce it. 10GB limit per DO.
DO hibernation kills ALL in-memory state — always persist to SQLite.

## Key CF Invariants
- KV eventual consistency ~60s — never use for rate limiting
- Analytics Engine: append-only, 25M rows/day, ClickHouse dialect, no DELETE
- CF Workflows: **a step has NO wall-time limit** — only a CPU-time limit, which excludes time
  spent waiting on an LLM, a tool, or any I/O. The "30s per step" this line used to claim was
  wrong, and it is what produced `AgentTaskWorkflow`'s self-imposed 29s cap on an agent run (see
  item 73). Steps per instance: 1,024 on Free, 10,000 default on Paid, configurable to 25,000;
  `step.sleep` (up to 365 days) does not count toward that. State must be JSON-serializable,
  ≤100MB per instance on Free / 1GB on Paid. `step.waitForEvent(name, {type, timeout})` +
  `instance.sendEvent({type, payload})` is the native human-in-the-loop primitive — a waiting
  instance costs nothing and doesn't hold a concurrency slot.
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

## Live Deployment Facts (current as of 2026-07-26 — verified, not remembered)
Re-verify before relying on any of these, but they are the real values as of this session:
- **Router / API base:** `https://naelao-router.crzzphillip.workers.dev` — append `/v1`.
- **Product Shell:** `https://naelao-shell.pages.dev/p/{product_slug}` (Pages project
  `naelao-shell`). **Builder Dashboard:** `naelao-dashboard.pages.dev` (project
  `naelao-dashboard`). Both MUST be deployed with `--branch=main` or they land as previews and
  the bare domain 404s (item 62/64).
- **`NEXT_PUBLIC_API_URL` asymmetry — getting this backwards produces `/v1/v1/...` → 401 → every
  route 404s with a valid-looking build:** `apps/shell`'s client already includes `/v1`, so its
  env var must be the BARE router origin. `apps/dashboard`'s client omits `/v1`, so its env var
  must CARRY the `/v1`. `apps/dashboard` also needs `NEXT_PUBLIC_SHELL_URL`. Set them in the SAME
  command as `next-on-pages` — it re-runs its own build and does not inherit from a prior shell
  invocation. Verify by grepping the built bundle before deploying.
- **D1 `naelao-platform`:** `f29714eb-28bd-4c76-895d-eb186e92a88f`.
- **The user's live product:** space `f17b859b-aaf7-436e-a381-87cd6820429a`, slug `launchpad`,
  tenant `bf24280c-e1f1-43dc-8ebf-09fa64bfd12a` (org `plan_tier = 'enterprise'`).
  NOTE: this REPLACED the older `457a2b3a-...` product, which the user deleted on 2026-07-26 —
  any reference to that id is stale. Its `config_json.productConfig.modelConfig.model` was found
  set to `"claude-sonnet-4-6"` (item 79's live-blocking bug) and corrected to
  `@cf/meta/llama-3.3-70b-instruct-fp8-fast` on 2026-07-27 — a real chat run against it now
  completes. If chat on this product ever 404s "Model not found" again, check this field first
  (now editable from `apps/shell`'s Dashboard tab by a business admin, or `PATCH
  /builder/products/:id` from the dashboard) before assuming it's the code-level default again.
- **AI Gateway** id `naelao-gateway`. **No Claude models are available on this account** — Workers
  AI only (item 68). Default working model: `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.
- **Workers AI free tier is ~10,000 neurons/day ≈ 65 agent runs/day platform-wide**, and
  `worker_loaders` is commented out in `workers/agents/wrangler.toml` (execution Tiers 2-4
  unavailable). Both unblock with the CF Workers Paid plan ($5/mo).
- **The neuron allowance is a ROLLING 24-HOUR WINDOW, not a calendar-day reset** (measured
  2026-08-07: 13,540 and 08-08: 11,068 — both above the nominal 10,000/day, which a per-day counter
  cannot explain). Capacity returns as the previous day's heaviest hours age out, so "retry after
  midnight" is wrong; query `aiInferenceAdaptiveGroups` by `datetimeHour` to find when the big hour
  drops out. **NEVER use the GraphQL aggregate to decide whether budget remains** — a request
  rejected by the limiter consumes NO neurons, so on a capped day it reports `0 used / 10,000
  remaining` while every real call fails. Probe the real thing instead: one `max_tokens:1` call to
  `/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast`; `"code":4006` means capped.
  `infra/scripts/run-model-matrix.sh` does this and refuses to start rather than record zeros that
  read as model failures.
- **CORRECTION to the "no Claude models" line below: Claude IS reachable through the AI Gateway's
  provider path, it just has no budget.** A direct call to
  `gateway.ai.cloudflare.com/v1/{acct}/naelao-gateway/anthropic/v1/messages` returns
  `402 code 2021 "Insufficient wholesale credits"` — NOT "model not found". So there are TWO
  independent paid unlocks, for different things: the **Workers Paid plan** (Workers AI neurons +
  execution Tiers 2-5) and **AI Gateway wholesale credits** (Anthropic/OpenAI/etc via the gateway).
  Item 68's `?search=claude → 0 results` was querying the Workers AI model catalogue, which by
  definition never lists third-party provider models.
- **`WHOP_OAUTH_CLIENT_ID`/`WHOP_OAUTH_CLIENT_SECRET` (on `naelao-agents`) and `TAVILY_API_KEY`
  (on `naelao-knowledge`) are now SET and LIVE-VERIFIED (2026-07-26).** One-click "Connect with
  Whop" is real end to end: minted a real internal token for the live product's tenant
  (`bf24280c-...`) and hit `POST /connectors/whop/oauth/start` directly — returned a genuine
  `https://api.whop.com/oauth/authorize?...&client_id=app_kbsTERQICLC11F&...` URL with the
  correct redirect_uri, scopes, and PKCE challenge. Confirmed `WHOP_OAUTH_CLIENT_ID`/
  `WHOP_OAUTH_CLIENT_SECRET`/`TAVILY_API_KEY` are all present via `wrangler secret list`.
  `naelao-knowledge` has `workers_dev=false` (item 21's hardening) so its `/internal/web-search/*`
  route can't be curl'd directly at its `workers.dev` URL (404, correct behavior) — verify that
  one through a real business's assistant instead if it's ever in question. Do not re-prompt the
  user for any of these three secrets.
- **Whop OAuth app registration — findings from the user's 2026-07-26 attempt, so this isn't
  re-derived:**
  - **App type: B2B / business (dashboard), NOT customer-facing.** Customer-facing means embedded
    in a creator's whop and shown to THEIR members (Whop iframes it, hence its Base URL field).
    Our flow is the opposite: a business owner authenticates their OWN Whop account so their
    Naelao assistant can read products/payments/members. No Whop-hosted surface is ever shown to
    anyone's members.
  - **The Permissions tab needs `oauth:token_exchange`** — an App API key permission, NOT an OAuth
    scope (per Whop's own setup guide). Our flow exchanges the code server-side, so without it the
    redirect succeeds and the exchange still fails. Easy to miss.
  - **RESOLVED — root cause found and fixed via the real Whop CLI/API, not the dashboard.** The
    user supplied a temporary `apik_...` API key. Installed `@whop/cli` (`npm install -g
    @whop/cli`, binary `whop`, auth via `WHOP_API_KEY` env var) and traced the actual bug by
    reading the installed CLI's bundled source
    (`$(npm root -g)/@whop/cli/dist/index.js`): `redirect_uris` is typed `array | null` (a
    ZodUnion), but the CLI's `isArrayOption()` only recognizes a BARE `ZodArray` — `unwrap2()`
    stops at the union and never drills into it — so `setOption()` never accumulates repeated
    `--redirect_uris` flags into an array, and `coerceUnion()` only JSON-parses union members that
    are `ZodObject`/`ZodRecord`, never `ZodArray`. The value therefore ALWAYS reaches Whop's
    server as a bare string, which the API correctly rejects as `"expected array, received
    string"` — reproduced this exact error through the CLI before working around it. The
    dashboard form almost certainly shares the same generated validation, which is what produced
    "please enter a valid url" — a genuine Whop-side bug, not anything wrong with our URL, a paste
    artifact, or the earlier `workers.dev` public-suffix theory (also now considered LESS likely).
    **Fixed by calling the REST API directly**, bypassing the CLI's broken option parser:
    `PATCH https://api.whop.com/api/v1/apps/app_kbsTERQICLC11F` with
    `{"redirect_uris": ["https://naelao-agents.crzzphillip.workers.dev/connectors/whop/oauth/callback"]}`
    — verified persisted via a follow-up GET.
  - **The user's app (`app_kbsTERQICLC11F`, "Naelao", company `biz_m4K8Ox1wlMJC1J`) already had
    everything else correct** from an earlier session: `app_type: "b2b_app"` (confirms the earlier
    B2B recommendation — nobody's members ever see a Whop-hosted surface in our flow),
    `oauth_client_type: "confidential"` (correct for our server-side token exchange), and the
    `oauth:token_exchange` permission already requested. `status: "hidden"` was confirmed (via
    Whop's own docs) to control ONLY marketplace discoverability, never OAuth function — `hidden`
    is actually correct here since this app should never be publicly listed.
  - **RESOLVED — the client_secret is now set.** It genuinely cannot be retrieved via API/CLI
    (confirmed by grepping the entire installed CLI bundle for `client_secret` — zero hits; per
    Whop's own docs it's shown once, at creation or via dashboard "Regenerate", correct secret
    hygiene not a gap). The user retrieved it from the Developer Dashboard and supplied both it
    and the client_id (`app_kbsTERQICLC11F`) on 2026-07-26. Both are now live as
    `WHOP_OAUTH_CLIENT_ID`/`WHOP_OAUTH_CLIENT_SECRET` on `naelao-agents`, live-verified via a
    direct call to `POST /connectors/whop/oauth/start` (see the Live Deployment Facts line
    above for the full verification). No further action needed on this.
  - **This account has ZERO DNS zones** (verified via the CF API 2026-07-26) — no custom domain is
    available today. Registering one would fix BOTH this and item 72's product-address problem
    (the dashboard used to show `{slug}.naelao.app`, a domain with no zone anywhere).
  - **The redirect URI is config-driven**: `${PUBLIC_AGENTS_URL}/connectors/{platform}/oauth/
    callback` (`workers/agents/src/index.ts`). Whatever host ends up registered, the change is a
    single `wrangler secret put PUBLIC_AGENTS_URL` — no code edit, no logic redeploy. Note the
    PATH is fixed; only the host is configurable.
  - **`invalid_scope` — RESOLVED (2026-07-27, second pass).** The first pass's fix
    (`scopes: ["read_user"]`) was ITSELF wrong — `read_user` still 302'd to
    `error=invalid_scope` live even after that deploy. Root cause: `PATCH /apps/:id`'s
    `required_scopes` field (what the first pass tested against) is a DIFFERENT, embedded-app-only
    concept — the scope auto-granted when a member opens a Whop-hosted iframe app — and has
    nothing to do with what the real standalone `/oauth/authorize` endpoint (our actual flow)
    validates. Found the real answer by fetching Whop's own OAuth guide
    (`docs.whop.com/developer/guides/oauth`) directly instead of trusting the `required_scopes`
    validator's error message: standalone "Sign in with Whop" apps use the standard OIDC scope
    triad — **`openid`, `profile`, `email`** — set via the dashboard's "View available scopes"
    button, requested per-flow via the `scope` URL param. Confirmed live end-to-end, incrementally:
    `scope=openid` alone returned a DIFFERENT, informative error
    (`"nonce is required for openid scope"` — i.e. the scope itself was ACCEPTED, just missing a
    param) and `scope=openid+profile+email` + a real `nonce` param redirected cleanly to
    `whop.com/oauth/authorize?...` — Whop's actual login/consent page, no error. Fixed:
    `catalogue.ts`'s Whop `oauth.scopes` is now `["openid", "profile", "email"]`;
    `oauth.ts`/`buildAuthorizeUrl` gained a `nonce` param (required whenever `openid` is
    requested — new `generateNonce()`, wired through `/connectors/:platform/oauth/start`); not
    yet validated against an `id_token` (this flow resolves identity via the userinfo endpoint,
    not by parsing an id_token — a real, scoped gap, flagged not silently dropped). Live-verified
    THROUGH OUR OWN CODE PATH, not just raw curl against Whop: called the real, deployed
    `POST /connectors/whop/oauth/start` with a minted internal token against the live tenant,
    took the `authorize_url` it returned, and followed it — 302'd straight to Whop's real
    consent page. **The Whop connect flow is now genuinely live and functional end to end**,
    modulo a real click-through by an actual Whop-account holder (not done here — no browser
    session available in this environment).
    **`requested_permissions` (the `oauth:token_exchange` entry) remains a SEPARATE system** from
    OAuth scopes — its own OpenAPI description says it's "a permission that the app requests from
    the admin of a company during the oauth flow," managed only via a dedicated
    `PATCH /apps/:id/permissions` endpoint that requires an App-level API key this app has never
    generated (blocked on `developer:manage_api_key`, which the owner's personal key doesn't
    carry). This was a real, separate dead end investigated in the first pass — not revisited,
    since it turned out to be irrelevant to `invalid_scope` (a real OAuth scope, `read_user`, was
    never the issue; the whole `required_scopes`/`requested_permissions` API surface was a red
    herring for THIS bug, confirmed by the fix landing without touching either).
    **Follow-up (2026-07-27, third pass) — the owner pulled Whop's REAL, full ~190-scope catalog
    directly from the Developer Dashboard, which reverses part of the second pass's conclusion.**
    `checkout_configuration:create`/`plan:create`/`access_pass:create`/`access_pass:update` (item
    58's dependency, previously declared "not real scopes") ARE genuinely real scope names —
    confirmed present verbatim in the dashboard's own list, which `docs.whop.com`'s scopes
    reference page couldn't confirm from this environment (404s unauthenticated). Rebuilt
    `catalogue.ts`'s Whop `oauth.scopes` on least-privilege from that real catalog: the OIDC
    triad (`openid`/`profile`/`email`, still required for the standalone-app flow + `nonce`,
    unchanged from the second pass) plus exactly the resource scopes this connector's own
    `operations` need (`company:basic:read`, `member:basic:read`/`member:email:read`,
    `access_pass:basic:read`, `plan:basic:read`, `payment:basic:read`, `dms:read`/
    `dms:message:manage`, `forum:read`/`forum:post:create`) plus the five item 58 needs
    (`checkout_configuration:basic:read`/`:create`, `plan:create`, `access_pass:create`/`:update`,
    `company:manage_checkout`) — 19 scopes total, none of the company-admin-destructive
    (`company:delete`, `developer:*`) or payout/wallet scopes (those stay on the separate
    invite-gated Platforms API rail, items 50-51, never this BYO connector). Live-verified twice:
    once as a raw probe of the full combined scope string against `api.whop.com/oauth/authorize`
    directly, and once through our own deployed `POST /connectors/whop/oauth/start` route,
    following the exact `authorize_url` it generated — both landed cleanly on Whop's real
    consent page with all 19 scopes intact, no `invalid_scope`. **Item 58's own scope assumption
    is no longer wrong** — whether the connecting user's OWN role in their Whop company actually
    GRANTS those scopes at consent time (vs. Whop silently dropping ones their role doesn't cover)
    remains the one genuinely unverified step, since no real human has clicked through consent
    against this app yet.
  ALREADY SET: `RESEND_API_KEY` on `naelao-notifications` (do not re-prompt), `PUBLIC_AGENTS_URL`,
  `CF_API_TOKEN`, `NAELAO_AIG_TOKEN`, `COMPOSIO_API_KEY`, `PIPEDREAM_*`, `AGENTMAIL_API_KEY`
  (live-verified 2026-07-30 — real inbox created/sent, see item 88) on `naelao-agents`.
- **`GOOGLE_AI_STUDIO_API_KEY` is now SET and LIVE-VERIFIED on `naelao-agents` (item 116) — do not
  re-prompt for it.** Google AI Studio (Gemini) is a real, working second LLM provider, reached via
  a separate routing path (the older `gateway.ai.cloudflare.com/.../compat/chat/completions`
  endpoint, BYOK) from every other model. The account's key is a rotatable dev key per the user's
  own note ("we renew when with development like other keys") — if Gemini calls start 401ing,
  suspect a rotated key first. **Google had already cut off the entire Gemini 2.5 generation from
  new-user access by the time this was tested live** — `ALLOWED_MODELS` uses Google's own
  `-latest` aliases (`google-ai-studio/gemini-flash-lite-latest` / `-flash-latest` / `-pro-latest`)
  specifically because pinned 2.5-generation ids failed live with a real 404; re-verify against a
  live `GET https://generativelanguage.googleapis.com/v1beta/models?key=...` before assuming any
  specific Gemini id still resolves — Google's generation churn is aggressive.
- **Router var `PRODUCT_SHELL_URL` is still `http://localhost:3100`** — breaks the clickable link
  in verification emails. Known, not fixed (the user's call to change a production var).
- **Correct test command:** `npx vitest run --config tests/vitest.config.ts` (plain `npx vitest
  run` fails). Typecheck: `npx turbo run typecheck` (76 tasks).
- **Minting an internal token by hand** (for live testing against a worker directly):
  `t={ms},v1={HMAC-SHA256("internal:{tenantId}:{ms}", PLATFORM_SECRET)}` — see
  `packages/http/src/middleware.ts`. `NAELAO_PLATFORM_SECRET` is in `.cf-credentials.local`.
- **Live UI verification:** Playwright's bundled Chromium cannot complete a TLS handshake through
  this sandbox's proxy. Use `infra/scripts/shell-screenshot.mjs` (CF Browser Rendering REST API),
  which injects a real `nps_` session into localStorage. A shell page will REDIRECT to `/spaces`
  if the account has zero businesses (business-first gate) — create one first or you screenshot
  the wrong page.

## Live Cloudflare Access (session-local, may or may not be present)
A real Cloudflare API token + R2 S3 credentials for the account this platform is actually
deployed to (account id `12e352dbea64627949c5e808c1ea92c3`) may be available at
**`.cf-credentials.local`** (repo root, gitignored — never committed, never pasted into any
file that gets committed). It is **session-local**: this environment's container is re-cloned
from git each session, so the file only survives within one continuous session/container, not
across a fresh one. If it's present, `source .cf-credentials.local` and use `$CF_API_TOKEN`/
`$CF_ACCOUNT_ID` directly with `curl` against `https://api.cloudflare.com/client/v4/...` (Workers
list/get/code, D1 query, KV, R2 bucket list, Pages projects, `workers/subdomain`, etc.) or export
`CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` for `wrangler` CLI commands (`wrangler deploy`,
`wrangler tail`, `wrangler pages deploy`) — this is how item 62's platform-wide `SQLITE_AUTH` and
PBKDF2-iteration bugs were actually found and fixed: by deploying real code and tailing real
worker logs against production, not by reading source alone. If the file is absent (a fresh
session, or the user has since rotated/deleted it), do not ask for it unprompted — mention its
absence only if the user asks about live testing, and let them decide whether to supply a new
token. Never print its contents in a response, commit message, or PR body. The user owns
rotation/revocation of these credentials in the Cloudflare dashboard directly.

## Git
**Active branch: `main`** — this is the primary working branch for this session. Keep feature
branches short-lived and merge or cherry-pick their commits back into `main` when the work is
ready. Before creating a new branch, check `main` for any commits that may already exist there
from the user or a prior session and sync them into the branch before continuing. Do not push to
any other branch without explicit permission. Commit after every working subsystem; push after
every commit. (Older branches `...-eu1uic`, `...-8vkakf`, `...-713ruz`, `...-6kb300` are
superseded.)

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
