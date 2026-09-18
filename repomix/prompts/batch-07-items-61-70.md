# AI Studio implementation prompt — batch 07, plan items 61–70

## Mission

Implement every requirement below end to end on the current accumulator branch. The cohesive focus
is **Task governance, provenance, model races, presence, and actor identity**. This prompt is self-contained: the feature definitions and retained implementation
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

### 61. Atomic Task Lease Protocol (`SpaceDO.tasks` CAS)

**Final behavior:** Single-writer task leases with 15-minute crash-proof TTLs. When an incident occurs, exactly one assistant claims it; siblings abort immediately.

**Production acceptance contract:**
Production entry: required SpaceDO task claim transition absent.
Persistence/deployment: required atomic task lease row/alarm absent.
Required observable verification: concurrency tests cannot substitute for task-lease expiry tests.

**Retained implementation constraints:**
- 126. **Three more live-reported bugs, all root-caused to the SAME underlying gap: the reasoner's
     "available_operations" field was a bare flat list of 60+ op names with no description or
     grouping — plus two silent trace-persistence holes that hid real repeat/parked tool calls
     from the activity table.**
     - **The real root cause of "our API doesn't support programmatic thread creation or direct
       in-thread chat messaging"** (item 125 shipped exactly that capability the same session).
       `project-coordination` WAS wired into the assistant's prebuilt list and `tools.
       availableOperations()` DID include `thread.create`/`thread.send_message` in the payload —
       but only as bare strings among dozens of others, with zero indication of what any of them
       do or what parameters they take (unlike `candidate_scripts`, which carries a real
       description/parameters/health per entry). A model asked to "communicate with an agent
       directly in a thread" had no way to recognize an opaque name like `thread.send_message` as
       the answer. New `ScriptToolSurface.availableOperationsGrouped()` groups the same ops by
       their owning prebuilt SCRIPT, reusing that script's own (already-written) description —
       `reasoner.ts` now sends this grouped structure as `available_operations` instead of the
       flat list (falls back to the flat list when a caller/test doesn't supply groups), and
       `DECISION_INSTRUCTIONS` gained one sentence telling the model to read every group's
       description before concluding a capability doesn't exist. Zero new prose was written per
       operation — the fix is structural (grouping + reuse), not a bigger prompt.
     - **The intermittent "narration with no tool-call table underneath it," and the "it's sort of
       repeating the same task many times" observation — the SAME bug, now fixed.** `loop.ts`'s
       within-run repeat-call guard (an already-attempted `name+params` combo, or an action still
       sitting in `deferred` awaiting approval) correctly served the model a cached outcome and
       `continue`d — but neither branch ever called `pushTrace`, even though the "reason" step
       immediately before it (carrying that turn's own `narration`/`doing` text, e.g. "Checking
       Instagram MCP tools") always does. Every REPEAT attempt therefore showed a real status line
       with nothing in the table beneath it — exactly the reported screenshot, and exactly why it

- Semantic Caching
 Enabled by default via cf-aig-cache-ttl: 3600 header. Caches LLM responses
 for semantically similar prompts — not just exact matches. Saves 40-80% of LLM costs for repetitive
 research/classification tasks. Cache is namespaced by spaceId so Space A's cache never pollutes Space B.
 Fallback Routing
 Configure in CF AI Gateway dashboard: Primary → Anthropic Claude Sonnet. Fallback 1 → Anthropic
 Claude Haiku. Fallback 2 → Workers AI (Llama-3.1-70B). Fallback triggers on: 429 rate limit, 503 service
 unavailable, timeout >30s. Users never see an error — they get a slightly different model. Log the fallback
 to Analytics Engine.
 Per-Space Rate Limiting
 Configure in CF AI Gateway dashboard per gateway. Set tokens-per-minute limits per billing tier.
 Free: 50k tokens/min. Maker: 200k. Pro: 1M. Enterprise: unlimited. Rate limits enforced by spaceId in the
 cf-aig-metadata header. Exceeded limit returns 429 — NaelaoAgentDO catches this and retries with exponential
 backoff.
 Cost Analytics
 AI Gateway automatically tracks: input tokens, output tokens, cache read tokens, cache write
 tokens, cost per request. Query via CF Analytics Engine API: SELECT spaceId, SUM(input_tokens)
 FROM ai_gateway_logs WHERE date > '2026-05-01' GROUP BY spaceId . This powers the per-Space billing
 breakdown in the admin dashboard.
 BYOK Configuration
 User provides API key in Space Settings → AI → API Keys. Frontend sends to naelao-credentials
 Worker which encrypts with AES-256-GCM using NAELAO_MCP_ENCRYPTION_KEY and stores in
 SpaceDO SQLite. When agent needs LLM: naelao-credentials decrypts and passes to createBYOKClient(). API key never
 appears in logs or Workers env vars.
- **Time-based scheduling (spec §05 "cron-jobs.json — the assistant's schedule of recurring
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

### 62. Sibling Assistant Spectator & Review Mode

**Final behavior:** Non-claiming assistants observe active tasks, update user notification feeds, and offer to audit incoming PR diffs without duplicating code work.

**Production acceptance contract:**
Production entry: notification and review primitives are not connected to lease loss.
Persistence/deployment: spectator status/feed link absent.
Required observable verification: no lease-loser spectator test.

**Retained implementation constraints:**
- 97. **The agent loop is no longer capped at six steps — it now runs as long as the task honestly
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
      50-step r
- Default count
 1 per user per Space. Space admin can raise this limit in Space Settings → Assistants → Max per
 user. Maximum 5 per user per Space.
 Container model
 On-demand CF Container (standard-1: ½ vCPU, 4 GiB RAM). Starts only when a task needs Linux
 execution. Default idle timeout: 30 minutes. Warm on wakeup from heartbeat: <3s.
 R2 filesystem path
 spaces/{spaceId}/assistants/{userId}/ mounted at /data/assistant when container starts. Contains: memory.json (deprecated, replaced by DO
 SQLite), skills/, cron-jobs.json, channel-configs/, dynamic-tools/
 Heartbeat frequency
 Every 5 minutes via naelao-sweeper cron trigger. Checks: cron-jobs.json, sub-agent status, pending
 channel messages, DO alarm wakeups.
 Memory storage
 Typed JSON in AssistantDO SQLite memory table. Key+category primary key. Schema-validated on
 write. Never flat Markdown. Injected into system prompt as structured XML on each turn.
 Permission manifest
 Stored in AssistantDO SQLite permissions table. NOT in R2 — prevents skill code from modifying its
 own permissions. Default: all permissions denied. Admin grants via Space Admin Dashboard.
 Self-modification scope
 Can write/update: skills in R2, cron-jobs.json, dynamic-tools (via Dynamic Worker Loader). Cannot
 modify: Worker source code, wrangler.jsonc, SpaceDO schema, other users' data, permission manifest.
- - **Entry gate** (`NaelaoAgentDO.handleScriptRun`): a project-scoped run that acts on behalf of a
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
  apply to runs entering there; both headers are now forwarded (the ro

### 63. Semantic Intent Deduplication Gate

**Final behavior:** Embeds incoming prompts and checks active tasks for >0.85 cosine similarity, preventing two users from ordering the same feature twice.

**Production acceptance contract:**
Production entry: no pre-execution active-task vector query.
Persistence/deployment: no scoped active-intent index.
Required observable verification: no semantic race test.

**Retained implementation constraints:**
- 112. **A repeatable capability benchmark — 6 test cases, trace-graded — is BUILT and validated
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
       already-parked action five co
- Required Fix: Implement PresenceDO: shared DO tracking active_sessions per Space. On WebSocket connect: SpaceDO broadcasts presence_update { online_count, typing_users: [] }. "Is typing" indicator: client sends typing_start / typing_stop WebSocket events when user is composing a message (debounce: stop event 3s after last keystroke). SpaceDO broadcasts to other sessions in same room (if multi-user room feature enabled). Online count displayed in Space header (optional, builder-configurable). High-traffic Spaces (>1000 concurrent): aggregate presence updates to max 1/second to avoid broadcast storm. Track peak_concurrent_users per Space in Analytics Engine.
- **Project deduplication** (`SpaceDO.createProject`). Exact-name idempotency already existed
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

### 64. Sponsor Alignment Gate (RFC Trigger)

**Final behavior:** Contradictory architectural directives from different human owners freeze execution and surface an RFC card in Team Room before code is touched.

**Production acceptance contract:**
Production entry: no sponsor alignment transition.
Persistence/deployment: no durable RFC freeze record.
Required observable verification: no contradictory-directive test.

**Retained implementation constraints:**
- 58. **Whop added as a second PLATFORM billing provider (AUDIT_TODO.md AI-7), replacing Lemon
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
      reaches the ledger via t
- Required Fix (suggested sequencing, not a hard requirement): G-BG09/G-BG10 (code index + real git checkout) first — nothing else in this the established specification trustworthy without them. Then G-BG01/G-BG03 (agent scaffolding + structured spec handoff) with a HUMAN standing in for the PM agent's feedback-mining step initially — prove the Dev/QA/Security loop end-to-end on human-authored specs before trusting G-BG02's automated feedback mining. Then G-BG04/G-BG05/G-BG11 (blast radius, deploy gate, SAST) together, since a deploy gate without a real regression signal or a security check is theater. G-BG02 (automated feedback mining), G-BG07/G-BG08 (Control Room), and G-BG13 (self-heal fast lane) follow once the core loop has run successfully on real specs. G-BG16 (Launchpad add-on packaging) is a thin wrapper, done last.
- **J3 — the workflow IS a stored script, not a second store.** `dynamic-workflow`'s
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

### 65. 2-Round Deliberation Horizon

**Final behavior:** Limits autonomous agent debate to 2 rounds. If consensus is not reached, transitions to `BLOCKED_AWAITING_HUMAN`, halting runaway loops.

**Production acceptance contract:**
Production entry: NaelaoAgentDO agent loop budget.
Persistence/deployment: durable agent DO run state and transitions.
Required observable verification: loop tests do not prove two-round `BLOCKED_AWAITING_HUMAN`.

**Retained implementation constraints:**
- 103. **Self-directed loop stopping (real-time progress visibility), a real project-thread/session
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
       in the the established specification / the established architecture's own step-budget work), not a replacement — an
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
       `listSessions()` had no way to exclude it, since `t
- The Gap: Free-plan limits exist for storage/sessions/tokens, but an autonomous business (agents doing outreach, building sites, running scheduled jobs) can burn spend in ways those static quotas do not shape — and the free program's economics depend on a hard ceiling.
- **Config surfaces — all three backend fields already existed on `SpaceTypeProductConfig`
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

### 66. Single On-Call Alert Routing

**Final behavior:** Project failures alert only the designated project lead's assistant rather than broadcasting to all team members, eliminating bystander effects.

**Production acceptance contract:**
Production entry: notification prebuilt/worker.
Persistence/deployment: project lead and notification rows.
Required observable verification: daily-digest tests do not prove single-recipient failure alerts.

**Retained implementation constraints:**
- 112. **A repeatable capability benchmark — 6 test cases, trace-graded — is BUILT and validated
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
       already-parked action five co
- Required Fix Implement a tiered read pattern for high-read-rate data: (1) Agent definitions, Space config, and knowledge article metadata are read-only after creation (or version-stamped). Cache these in KV with a 60-second TTL: kv.put(`space:${id}:agents`, JSON.stringify(agents), {expirationTtl: 60}). All Workers read from KV cache first; only on cache miss do they fall through to SpaceDO. (2) For rapidly-changing data (conversation messages, live usage counts): continue routing through SpaceDO but add a request coalescing layer: multiple concurrent requests for the same data are deduplicated to a single DO call. (3) For analytics data: route to Analytics Engine (already done in spec) rather than SpaceDO SQL. Measure DO request queue depth via Analytics Engine; alert if queue depth > 100.
- **Backend — `requireBusinessMembership` (new `workers/spaces/src/business-auth.ts`).** The
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

### 67. Immutable Cryptographic Provenance Ledger (`provenance_ledger`)

**Final behavior:** 4-point audit trail linking Human Trigger $\rightarrow$ Assistant Actor $\rightarrow$ Project Executor $\rightarrow$ Git Commit Hash for SOC2/HIPAA compliance.

**Production acceptance contract:**
Production entry: project-coordination and Git metadata only.
Persistence/deployment: required append-only hash chain absent.
Required observable verification: no tamper-verification test.

**Retained implementation constraints:**
- 44. **A go-live security+logic audit scoped to the Launchpad launch path found and FIXED two real
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
      it, so `apps/dashboard`'s Settings page (`
- // Space type: Verticals | Execution: Supervised (human checkpoint on every action)
const legalAI: Partial<NaelaoProduct> = {
 name: 'LexSpace', authProvider: 'saml-sso',
 allowPublicSignup: false, allowedEmailDomains: ['acmefirm.com'],
 pricingConfig: { type: 'seats', pricePerSeat: 15000, trialDays: 0, currency: 'USD' },
 adminFeatures: {
 conversationLogAccess: true, // ENABLED — explicit partner consent obtained, compliance requirement
 auditLogAccess: true, userManagement: true, knowledgeBaseManagement: true,
 },
 featureFlags: { 'matter-management': true, 'immutable-audit-trail': true, 'citation-verification': true },
};
// End-user UX: Matter dashboard, document workspace, research sidebar, citation panel
// Builder-admin UX: All matters visible, per-attorney usage, full conversation audit trail
- **Credit ledger is a LEDGER, not a second conversion source.** `credit_ledger`'s balance is the
SUM of its deltas; `deduct` fails CLOSED on an over-draw (402, balance unchanged), matching the
`fetchAssistantPolicy`/`project_spend` fail-closed precedent. Crucially, `deduct` accepts
ALREADY-CONVERTED credits — the agent runtime owns `tokensToCredits()` (billing-core's single
token→credit conversion point, #12), converts there, and passes credits here. The DO never
re-derives the rate, so there's no split-brain with billing-core. (This is also why the spaces
worker did NOT need to add a `@naelao/billing-core` dependency.) `/export` is the GDPR Art. 20
data-portability dump (mirrors the SpaceDO `/me/export` pattern) and explicitly excludes
`token_hash` — credential material is never exported.

### 68. Multi-Branch Parallel Model Benchmarking Races

**Final behavior:** Forks 3 branches for 3 models in parallel, evaluates test assertions, and automatically merges the winning benchmarked code.

**Production acceptance contract:**
Production entry: model benchmark helper; RepositoryDO forks.
Persistence/deployment: branch refs and billing metrics.
Required observable verification: model benchmark tests do not prove winner-only merge.

**Retained implementation constraints:**
- 118. **Real streaming, and the agent now TALKS between tool calls — item 117's two stated
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
       is the durable record. `NaelaoAgentDO.recordLiveProgress` u
- This agent can: read and write files, search the web, execute code, author workflows that run on a schedule, spawn sub-agents for parallel work, and send notifications. The R2 workspace is the primary persistent environment. The execution ladder routes each script to the appropriate tier automatically.
- - `workers/spaces/src/do/SpaceTypeRegistryDO.ts` — `SpaceTypeProductConfig` gains
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
- ### C. Automated Multi-Branch Race (Parallel Model Competition)
For high-difficulty, ambiguous coding tasks:
1. When a user runs `/goal Implement complex WebGPU physics shader`, the system creates **3 instant zero-copy Artifact forks in parallel**:
   * **Fork A:** Assigned to `Claude 3.7 Sonnet`
   * **Fork B:** Assigned to `Llama 3.3 70B`
   * **Fork C:** Assigned to `DeepSeek R1`
2. All 3 agents execute on their isolated branches and run `npm test`.
3. The platform scores the 3 branches:
   * Fork A passed 10/10 tests in 4 turns.
   * Fork B failed 2 tests.
4. The system presents Fork A's pull request to the user with full benchmark proof!
- ### D. Automated 3-Way AST Conflict Resolver Agent
If a PR submitted from a private scratchpad has conflicting edits with `main`:
1. The platform does not throw a dumb raw text conflict marker (`<<<<<<< HEAD`).
2. A specialized **Resolver Subagent** receives the 3-way AST diff:
   * Base commit ($O$)
   * Upstream changes on Main ($A$)
   * Scratchpad changes ($B$)
3. The agent inspects both intents, merges the non-overlapping AST nodes in Tier 2 CodeMode, runs the test suite, and presents a **verified, conflict-resolved merge commit**.
- ### Summary of What This Adds to the Platform
| Feature | How It Works with Cloudflare Artifacts |
| :--- | :--- |
| **Upstream Staleness Tracking** | Real-time `commitsBehind` badges across all scratchpads and task threads. |
| **Smart Agent Rebase** | Agents inspect upstream diffs before pulling, auto-rebasing non-overlapping files. |
| **Turn-by-Turn Time Machine** | 1-click rollback to any historical agent turn via instant Git commit resets. |
| **Reasoning-Aware `git-blame`** | Agents read historical commit reasoning to understand why past code was written. |
| **Multi-Model Branch Races** | Fork 3 branches for 3 models in parallel; merge the winning benchmarked code. |
| **AST-Aware Merge Resolver** | AI resolves Git merge conflicts automatically by understanding code syntax. |

### 69. Real-Time Multiplayer Presence via `WsHubDO`

**Final behavior:** WebSockets broadcast active file editing presence, cursor positions, and AST mutations to all connected clients in real time.

**Production acceptance contract:**
Production entry: ws-gateway WsHubDO and SpaceDO `/presence`.
Persistence/deployment: hibernating sockets plus presence rows.
Required observable verification: WebSocket tests cover transport; reconnect/crash journey remains.

**Retained implementation constraints:**
- 94. **Skill self-improvement (the last open gap from the OpenClaw/Hermes analysis) and a real
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
      one gate, not two that drift). Reads auto-approved in guided
- Required Fix
 Persist the presence map to DO SQLite on every change (debounced 500ms): INSERT OR REPLACE INTO presence (user_id, file_path, cursor_line, cursor_col, last_seen) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP). On DO startup (webSocketMessage handler first call after hibernation), reload presence from SQLite and broadcast a presence-sync event to all connected clients. Evict stale presence entries where last_seen < NOW() - 60 seconds. Client sends a presence heartbeat every 30 seconds to keep the entry alive.
- Spec §05 (byte ~116k): *"One assistant per user per Space by default. Admin can raise
this limit."* The **company state is shared** and space-level — `SpaceDO` (members,
structure, billing) + `ProjectDO` workspaces (file **locks**, **version history**,
**real-time presence**, byte ~399k/§12) + threads + KB. Each user's assistant
(`assistants/{userId}/`, byte ~411k) is a personal chief-of-staff acting **on** that
shared company — it is **not** a private fork of the company. Two members' assistants do
not build two companies because they read/write the *same* `ProjectDO`. Coordination =
file locks + presence + **project deduplication** (admin's assistant broadcasts "this
already exists"). This resolves the "two assistants = two companies" concern.
- #### Layer 1: Optimistic Concurrency Control (OCC / Hash Checkpoint)
Every file in your authoritative SQLite `workspace_files` table carries a **SHA-256 content hash**.
When an agent calls `Edit(filePath, oldString, newString)`, the DO SQLite write enforces a **Conditional Checkpoint**:
```sql
-- Atomic OCC Update in DO SQLite
UPDATE workspace_files
SET content = ?, hash = ?, size_bytes = ?, updated_at = datetime('now')
WHERE path = ? AND hash = ?; -- Verified against hash at start of turn!
```
* **If another user/agent edited the file mid-turn:** `changes === 0`. The DO throws an instant conflict exception:
  > `✖ Conflict Error: 'src/Header.astro' was modified by another thread 1.2s ago. Re-read lines before applying patch.`
* The agent reads the fresh lines with `Read` and self-heals its patch cleanly.
- ### 3. Real-Time Multiplayer Awareness (WebSockets over `WsHubDO`)
When Alice's agent edits a component, your **WebSocket Gateway (`WsHubDO`)** broadcasts a live presence event to all connected teammates:
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 👥 LIVE MULTIPLAYER WORKSPACE CANVAS                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│ 📁 src/components/                                                          │
│   ├── 📄 Header.astro  [ 👩‍💻 Alice's Agent Editing... (Locked) ]              │
│   ├── 📄 Footer.astro  [ 👨‍💻 Bob's Agent Editing... (Locked) ]                │
│   └── 📄 Button.astro  [ Available ]                                        │
└─────────────────────────────────────────────────────────────────────────────┘
```
* **Live AST Diff Updates:** While Alice watches her agent write code, Bob's file tree and visual canvas update in real-time with zero latency.
* **No Lost Work:** The authoritative SQLite virtual filesystem inside the Durable Object guarantees serial consistency across all active threads.
- ### Summary Checklist
1. **Sub-Spaces as Departments:** Parent spaces provide **top-down executive oversight, corporate billing, and global brand policies**, while department sub-spaces provide **isolated templates, custom toolsets, and local spend caps**.
2. **Clean Scoping:** Sub-space members cannot see parent or sibling data by default; cross-department collaboration is explicitly authorized via `cross_space_grants`.
3. **Multi-User Projects Without Chaos:**
   * Tame thread sprawl with **1 Team Room + Dedicated Task Threads**.
   * Prevent code corruption with **Optimistic Hash-Checked SQLite Writes (`OCC`)** and **File Mutex Locks**.
   * Broadcast real-time awareness over **`WsHubDO` WebSockets**.
- ### Axis 6: Multi-Agent Concurrency & Conflict-Free Code Editing
```
                                  ┌─────────────────────────────────────────────────────────────┐
                                  │      PROJECT WORKSPACE: "Core WebApp"                       │
                                  │   (Shared Authoritative SQLite Virtual Filesystem)          │
                                  └──────────────────────┬──────────────────────────────────────┘
                                                         │
                         ┌───────────────────────────────┴───────────────────────────────┐
                         ▼                                                               ▼
┌─────────────────────────────────────────────────────────────┐   ┌─────────────────────────────────────────────────────────────┐
│ 👩‍💻 THREAD 1: (Feature: "Add Dark Mode")                      │   │ 👨‍💻 THREAD 2: (Feature: "Fix Stripe Webhook")                 │
│ Agent: Dev Agent 1                                          │   │ Agent: Dev Agent 2                                          │
├─────────────────────────────────────────────────────────────┤   ├─────────────────────────────────────────────────────────────┤
│ 1. Agent 1 reads: `Header.astro` (hash: `h_v1`)             │   │ 1. Agent 2 reads: `Header.astro` (hash: `h_v1`)             │
│                                                             │   │                                                             │
│ 2. Agent 1 acquires mutex: `lock.acquire("src/Header.astro")│   │ 2. Agent 2 attempts mutex: `lock.acquire("src/Header.astro")│
│    Status: ✅ GRANTED                                        │   │    Status: ❌ DENIED (Held by Thread 1)                     │
│                                                             │   │                                                             │
│ 3. Agent 1 applies AST Patch: `patch_file`                  │   │ 3. Agent 2 yields: Operates on `src/api/stripe.ts` instead. │
│    SQLite OCC Write: Verified `hash == h_v1` ──► `h_v2`     │   │                                                             │
│                                                             │   │                                                             │
│ 4. Releases Lock. Broadcasts change via WsHubDO WebSockets. │   │ 4. Acquires Lock on `Header.astro` (sees `h_v2`), patches.  │
└─────────────────────────────────────────────────────────────┘   └─────────────────────────────────────────────────────────────┘
```
- #### Failure Modes & Anti-Patterns
* **Silent Write-Clobbering (Last-Write-Wins):** Blindly overwriting files without hash-checkpoint verification causes concurrent agents to overwrite sibling changes, resulting in broken builds and missing dependencies.
* **Deadlock Cascades:** Multiple agents acquiring locks on intersecting sets of files in arbitrary order create classic distributed deadlocks. All lock acquisitions must enforce lexicographical key ordering and strict TTL bounds.
* **Ghost Workspace Mutations:** Allowing private 1-on-1 user scratchpads (Tier 4) to write directly to shared repository files causes untracked side effects that disrupt active team sprints.
- #### Direct Implementation Recommendation for Cloudflare Edge Runtime
Implement the project virtual filesystem inside a single **Cloudflare Durable Object** (`SpaceDO`) to ensure all file writes are serialized through a single-threaded SQLite event loop [1.3.17]. Utilize **Cloudflare WebSocket Hibernation (`WsHubDO`)** to broadcast file mutation events (`presence.file_editing`, `workspace.file_changed`) across all connected clients in real time [1.3.17]. Lock acquisition is managed via `ConcurrencyDO` with automatic 30-second TTL expirations [1.3.17].

### 70. Invoker-Attested Split-Actor Model

**Final behavior:** Private scratchpads spawn personal actor instances with private memory; public channels spawn canonical actors with shared memory.

**Production acceptance contract:**
Production entry: assistant access and NaelaoAgentDO addressing.
Persistence/deployment: separate actor DO state.
Required observable verification: scratchpad helper tests are not actor-chain isolation tests.

**Retained implementation constraints:**
- 141. **The six items item 140 explicitly left open are now BUILT — Phase 1 of the 62-item batch is
     complete.** `thread.create` (the assistant's own `project-coordination` prebuilt) minted a
     `threads` row with no `session_id` — the exact bug behind "Session not found" on any
     assistant-created thread. It now also mints and links a real session (generating the thread's
     own id client-side so the link can point at it, then `POST /sessions {thread_id}`), matching
     the shape a human's own "New thread" already produces; degrades to returning the bare thread
     (still real, still usable via a later open) rather than throwing if the session-link call
     itself fails. The SAME gap existed on the flat `/threads` browse page's own "New Session"
     button and its `/threads/:id` chat route — fixed identically, and that route now waits for the
     thread to load (mirroring the project-scoped page) instead of always taking Chat's client-only
     fallback.
     - **Memory was never written automatically — confirmed, and closed.** Layer 4 (Fabric,
       project-shared consolidation) already had a post-run write; Layer 5 (episodic, the layer
       `memory.recall` actually searches) did not — nothing besides the model's own occasional
       `memory.remember` tool call ever populated it, which is the real root cause of "the AI isn't
       recording anything." `NaelaoAgentDO.handleScriptRun` now also writes a low-importance (0.3,
       below the auto-promotion threshold — a background trail to recall on demand, not something
       that forces itself into every future prompt) episodic note alongside the existing Fabric
       write, same best-effort posture. `memory.remember` added to
       `LAUNCHPAD_ASSISTANT_DEFAULT_AUTO_APPROVED` (`memory.recall` was already there) — it's a
       write, but a purely internal one (lands only in the agent's own private recall store,
       invisible to anyone unless recalled again), unlike `write_file` or a commerce write, which
       stay gated.
     - **Context meter now reflects the real selected model.** `ContextUsageMeter` hardcoded
       `claude-haiku-4-5-20251001`; `Chat.tsx` had `selectedModel` in scope the whole time and
       simply never passed it to the Stats-tab instance — fixed. Also gained a manual **Compact**
       button (next to the percentage, calling the existing `/compact` route on demand rather than
       only auto-firing at 85%) and a `compact` single-line rendering mode mounte
- The Gap
 AssistantDO Channel Messages — No Per-Channel Access Control; Metadata Leakage Across Channels The AssistantDO stores channel messages in a unified `messages` table with a `channel_meta` JSON field containing `{ channelId, authorId, authorName }`. There is no per-channel access control on message retrieval. If a human handler calls `getMessages(sessionId, limit: 100)`, the method returns all messages in that session across all channels without checking whether the requesting user has access to all those channels. For a Space Assistant connected to both Slack (public) and Discord (private) channels, a user querying the assistant's memory could technically see messages from channels they…
- The canonical spec gained **the established specification — Growth Layer** (G-BF01..G-BF20, appended at the end of
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
